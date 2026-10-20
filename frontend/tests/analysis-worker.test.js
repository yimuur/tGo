/**
 * tGo · analysis.worker.js 纯逻辑层无头单测（T5.6，node --test）
 * 用例 ID: FE-ANAW-*
 * 覆盖（TASK.md T5.6 验收）：ownership 量化、变化图/PV 过滤、LRU 淘汰 + 消息分发。
 * 本文件只 import 纯函数/类（不触发 Worker 注册分支）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { xyOfGtp } from '../static/js/core/board.js';
import {
  LruCache,
  parseOwnership,
  pvToStones,
  filterVariations,
  handleMessage,
  workerLru,
} from '../static/js/workers/analysis.worker.js';

test('FE-ANAW-01 | parseOwnership 量化', () => {
  const r = parseOwnership([0.5, -1, 2, 0], 19);
  assert.equal(r.n, 19);
  assert.equal(r.alphas.length, 361);
  assert.equal(r.alphas[0], 128);
  assert.equal(r.signs[0], 1);
  assert.equal(r.alphas[1], 255);
  assert.equal(r.signs[1], -1);
  assert.equal(r.alphas[2], 255, '越界钳制');
  assert.equal(r.alphas[3], 0);
});

test('FE-ANAW-02 | pvToStones GTP 串 → 带色序列', () => {
  const r = pvToStones(['D4', 'E5', 'D5'], { n: 19, firstColor: 'black' });
  const d4 = xyOfGtp('D4', 19);
  const e5 = xyOfGtp('E5', 19);
  const d5 = xyOfGtp('D5', 19);
  assert.deepEqual(r.points, [
    { x: d4.x, y: d4.y, color: 'black' },
    { x: e5.x, y: e5.y, color: 'white' },
    { x: d5.x, y: d5.y, color: 'black' },
  ]);
  assert.equal(r.passCount, 0);
  assert.equal(r.truncated, false);
  assert.equal(r.invalid, 0);
});

test('FE-ANAW-03 | pv 截断与步数上限', () => {
  const r = pvToStones(['A19', 'B19', 'C19', 'D19'], { n: 19, firstColor: 'black', maxSteps: 2 });
  assert.equal(r.points.length, 2);
  assert.equal(r.truncated, true);
  assert.equal(r.total, 4);
});

test('FE-ANAW-04 | pv 非法坐标中止', () => {
  const r = pvToStones(['D4', 'I99', 'E5'], { n: 19, firstColor: 'black' });
  assert.equal(r.points.length, 1, '非法点后中止');
  assert.equal(r.invalid, 1);
});

test('FE-ANAW-05 | pv pass 与首色', () => {
  const r = pvToStones(['pass', 'D4'], { n: 19, firstColor: 'white' });
  assert.equal(r.passCount, 1);
  assert.equal(r.points.length, 1);
  const d4 = xyOfGtp('D4', 19);
  assert.equal(r.points[0].color, 'black', 'pass 后续色轮到黑');
  assert.equal(r.points[0].x, d4.x);
});

test('FE-ANAW-06 | pv 带色对象直通 + 非法色中止', () => {
  const r = pvToStones(
    [{ color: 'B', x: 3, y: 15 }, { color: 'white', x: 9, y: 9, is_pass: false }, { color: 'X', x: 1, y: 1 }],
    { n: 19 },
  );
  assert.equal(r.points.length, 2);
  assert.equal(r.points[0].color, 'black');
  assert.equal(r.points[1].color, 'white');
  assert.equal(r.invalid, 1);
});

test('FE-ANAW-07 | pv 越界对象中止', () => {
  const r = pvToStones([{ color: 'B', x: 3, y: 3 }, { color: 'W', x: 19, y: 3 }], { n: 19 });
  assert.equal(r.points.length, 1);
  assert.equal(r.invalid, 1);
});

test('FE-ANAW-08 | filterVariations 树过滤', () => {
  const vs = filterVariations(
    [
      { pv: ['D4', 'E5', 'D5', 'E4'] },
      { pv: ['Q16', 'R16', 'Q15'] },
    ],
    { n: 19, firstColor: 'black', maxSteps: 2, maxVariations: 1 },
  );
  assert.equal(vs.length, 1, 'maxVariations 截断');
  assert.equal(vs[0].points.length, 2, 'maxSteps 截断');
  assert.equal(vs[0].truncated, true);
});

test('FE-ANAW-09 | LruCache 淘汰与 recency', () => {
  const c = new LruCache({ max: 2 });
  assert.equal(c.set('a', 1), null);
  assert.equal(c.set('b', 2), null);
  assert.equal(c.set('c', 3), 'a', '超限淘汰最久未用 a');
  assert.equal(c.has('a'), false);
  assert.equal(c.size, 2);
  assert.equal(c.get('b'), 2, '访问 b 刷新 recency');
  assert.equal(c.set('d', 4), 'c', '再写淘汰 c（非刚访问的 b）');
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('d'), 4);
  assert.equal(c.delete('b'), true);
  assert.equal(c.delete('b'), false);
  assert.equal(c.size, 1);
  c.clear();
  assert.equal(c.size, 0);
});

test('FE-ANAW-10 | LruCache 键序 & 覆盖写不增容量', () => {
  const c = new LruCache({ max: 3 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 9);
  assert.equal(c.size, 2, '覆盖同键');
  assert.equal(c.get('a'), 9);
  assert.deepEqual([...c.keys()], ['b', 'a'], '最新在尾');
});

test('FE-ANAW-11 | handleMessage 消息分发', () => {
  const o = handleMessage({ type: 'ownership', data: { values: [0.5], n: 9 } });
  assert.equal(o.ok, true);
  assert.equal(o.result.alphas.length, 81);

  const p = handleMessage({ type: 'pv', data: { pv: ['D4'], n: 19, firstColor: 'black' } });
  assert.equal(p.ok, true);
  assert.equal(p.result.points.length, 1);

  assert.equal(handleMessage({ type: 'ping' }).result, 'pong');
  const bad = handleMessage({ type: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'UNKNOWN_JOB');
  const boom = handleMessage({ type: 'pv', data: null });
  assert.equal(boom.ok, true, '缺数据安全返回空序列');
});

test('FE-ANAW-12 | worker LRU 消息读写', () => {
  workerLru.clear();
  const s = handleMessage({ type: 'lru_set', data: { key: 'main:3', value: { winrate: 0.5 } } });
  assert.equal(s.ok, true);
  assert.equal(s.result.size, 1);
  const g = handleMessage({ type: 'lru_get', data: { key: 'main:3' } });
  assert.equal(g.ok, true);
  assert.equal(g.result.winrate, 0.5);
  const miss = handleMessage({ type: 'lru_get', data: { key: 'main:9' } });
  assert.equal(miss.result, null);
});
