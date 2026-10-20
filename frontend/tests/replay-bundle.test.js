/**
 * FE-RB（replay-bundle 纯函数/快照层）· 复盘批量快照（2026/09/21 性能优化）
 *
 * 契约要点：
 *   - 快照按 ``position_key`` 索引，命中即本地应用（零请求）；
 *   - **失效优先**：被 ``invalidate`` 的键（深算结果/补分析/结算/棋谱变更）绝不返回陈旧快照；
 *   - 重新 ``set()`` 快照清空失效标记（新快照即新事实源）；
 *   - 领地懒加载：未加载/未覆盖 → ``covered:false``（回落 WS 补分析路径），
 *     值以 ``Float32Array`` 承载（大数组不入状态树）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecommendIndex,
  buildOwnershipIndex,
  snapshotServes,
  purgeEmptyEntries,
  createReplayBundle,
} from '../static/js/core/replay-bundle.js';

/** 快照条目快捷构造（与后端 ``/replay`` 条目同字段）。 */
function entry(moveNo, { hasData = true } = {}) {
  return {
    position_key: `main:${moveNo}`,
    move_no: moveNo,
    side: 'B',
    has_data: hasData,
    moves: hasData ? [{ x: 3, y: 3, winrate: 55, score_lead: 1.5, visits: 100, pv: ['D4'] }] : [],
    variations: hasData ? [{ pv: [{ color: 'B', x: 3, y: 3, is_pass: false }] }] : [],
    root: hasData ? { winrate: 55, score_lead: 1.5 } : null,
    comment: null,
  };
}

function snapshot(recommends, extra = {}) {
  return { game_id: 7, last_move_no: recommends.length - 1, curve: [], recommends, ...extra };
}

test('FE-RB-01 | buildRecommendIndex：按 position_key 建索引，跳过无效项', () => {
  const index = buildRecommendIndex([entry(0), entry(1), null, { move_no: 2 }, { position_key: '' }]);
  assert.equal(index.size, 2);
  assert.equal(index.get('main:1').move_no, 1);
});

test('FE-RB-02 | snapshotServes：被失效的键不再服务（即使快照命中）', () => {
  const index = buildRecommendIndex([entry(1)]);
  assert.equal(snapshotServes({ index, blocked: new Set(), key: 'main:1' }), true);
  assert.equal(snapshotServes({ index, blocked: new Set(['main:1']), key: 'main:1' }), false);
  assert.equal(snapshotServes({ index, blocked: new Set(), key: 'main:2' }), false);
  assert.equal(snapshotServes({ index, blocked: new Set(), key: null }), false);
});

test('FE-RB-03 | 快照命中/未覆盖/失效回落三态', () => {
  const bundle = createReplayBundle();
  bundle.set(snapshot([entry(0), entry(1, { hasData: false }), entry(2)]));
  assert.equal(bundle.get('main:0').has_data, true);
  // 缺分析的局面也在快照内（显式空条目）→ 本地渲染空态，不再发请求
  assert.equal(bundle.get('main:1').has_data, false);
  // 快照外（别端续下的新手）/ 试下分支 → 未命中 → 回落 WS
  assert.equal(bundle.get('main:9'), null);
  assert.equal(bundle.get('trial:1:1'), null);
  // 失效（深算结果到达等）→ 该键一律回落 WS
  bundle.invalidate('main:2');
  assert.equal(bundle.get('main:2'), null);
  assert.equal(bundle.get('main:0').has_data, true);
});

test('FE-RB-04 | set() 重载快照清空失效标记（新快照即新事实源）', () => {
  const bundle = createReplayBundle();
  bundle.set(snapshot([entry(1)]));
  bundle.invalidate('main:1');
  assert.equal(bundle.get('main:1'), null);
  bundle.set(snapshot([entry(1)]));
  assert.equal(bundle.get('main:1').has_data, true);
});

test('FE-RB-05 | 曲线：未载入返回 null（调用方回落 REST /curve），载入后原样透传', () => {
  const bundle = createReplayBundle();
  assert.equal(bundle.curve(), null);
  bundle.set(snapshot([entry(0)], { curve: [{ move_no: 0, winrate: 55, score_lead: 1.5 }] }));
  assert.deepEqual(bundle.curve(), [{ move_no: 0, winrate: 55, score_lead: 1.5 }]);
});

test('FE-RB-06 | 领地懒加载：未加载/未覆盖/被失效 → covered:false（回落 WS）', () => {
  const bundle = createReplayBundle();
  assert.deepEqual(bundle.ownership(1), { covered: false, values: null });
  assert.equal(bundle.hasOwnership(), false);
  bundle.setOwnership({
    game_id: 7,
    last_move_no: 3,
    positions: [{ move_no: 1, ownership: [0.5, -0.5, 0] }, { move_no: 3, ownership: [0.25] }],
  });
  assert.equal(bundle.hasOwnership(), true);
  const hit = bundle.ownership(1);
  assert.equal(hit.covered, true);
  assert.ok(hit.values instanceof Float32Array);
  assert.deepEqual([...hit.values], [0.5, -0.5, 0]); // 大数组按 Float32 承载（不入状态树）
  // 快照内缺数据的局面（服务端未下发）→ 不再请求就地“终态无数据”，而是回落 WS（可触发补分析）
  assert.deepEqual(bundle.ownership(2), { covered: false, values: null });
  // 深算结果到达后该局面失效 → 回落 WS（避免旧快照遮住深算领地）
  bundle.invalidate('main:1');
  assert.deepEqual(bundle.ownership(1), { covered: false, values: null });
});

test('FE-RB-07 | buildOwnershipIndex：仅收有效数值数组', () => {
  const index = buildOwnershipIndex({
    positions: [
      { move_no: 0, ownership: [1, 0] },
      { move_no: 1, ownership: null },
      { move_no: 2 },
      { move_no: 3, ownership: [] },
      { move_no: '4', ownership: [0.5] },
    ],
  });
  assert.deepEqual([...index.keys()], [0, 4]);
  assert.ok(index.get(0) instanceof Float32Array);
});

test('FE-RB-08 | purgeEmptyEntries：只清主谱空条目（保留深算/实时与试下缓存）', () => {
  const store = new Map([
    ['main:1', { has_data: false }],
    ['main:2', { has_data: true }],
    ['trial:5:1', { has_data: false }],
  ]);
  const cache = {
    keys: () => [...store.keys()],
    get: (k) => store.get(k),
    delete: (k) => store.delete(k),
  };
  assert.equal(purgeEmptyEntries(cache), 1);
  assert.deepEqual([...store.keys()], ['main:2', 'trial:5:1']);
  assert.equal(purgeEmptyEntries(null), 0);
});
