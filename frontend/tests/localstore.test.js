/**
 * tGo · localstore.js 无头单测（T5.2，node --test）
 * 用例 ID: FE-LS-*
 * 覆盖（TASK.md T5.2 验收）：损坏 JSON 静默清理并回退默认值；set 失败（配额/禁用）
 * 返回 false 且保留旧值；remove 幂等；无 storage 环境（Node）回退内存存储。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LS_KEYS, createLocalStore, memoryStorage } from '../static/js/core/localstore.js';

/** 模拟 Web Storage：记录抛错开关以测试配额/禁用场景。 */
function fakeStorage() {
  const map = new Map();
  let failSet = false;
  return {
    failNextSet() {
      failSet = true;
    },
    _get: () => map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (failSet) {
        failSet = false;
        throw new Error('QuotaExceededError');
      }
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test('FE-LS-01 键清单完整', () => {
  assert.equal(LS_KEYS.theme, 'tgo.theme');
  assert.equal(LS_KEYS.accent, 'tgo.accent');
  assert.equal(LS_KEYS.volume, 'tgo.volume');
  assert.equal(LS_KEYS.recent, 'tgo.recent');
  assert.equal(LS_KEYS.createPrefill, 'tgo.create-prefill');
  assert.equal(LS_KEYS.reviewSelect, 'tgo.review-select');
  assert.equal(LS_KEYS.reviewPos, 'tgo.review-pos');
  assert.equal(LS_KEYS.stoneMotion, 'tgo.stone-motion');
  assert.ok(LS_KEYS.onboarded);
});

test('FE-LS-02 set/get 往返（对象/数组/标量）', () => {
  const ls = createLocalStore(fakeStorage());
  assert.equal(ls.set(LS_KEYS.recent, { gameId: 7, ts: 123 }), true);
  assert.deepEqual(ls.get(LS_KEYS.recent), { gameId: 7, ts: 123 });

  assert.equal(ls.set(LS_KEYS.volume, 70), true);
  assert.equal(ls.get(LS_KEYS.volume, 100), 70);
  assert.deepEqual(ls.get(LS_KEYS.volume), 70);
});

test('FE-LS-03 缺失键返回默认值且不写入', () => {
  const ls = createLocalStore(fakeStorage());
  assert.deepEqual(ls.get(LS_KEYS.recent, { gameId: 0 }), { gameId: 0 });
  assert.equal(ls.get(LS_KEYS.theme, 'light'), 'light');
  // 未产生副作用
  const store = ls.storage;
  assert.equal(store.getItem(LS_KEYS.theme), null);
});

test('FE-LS-04 损坏 JSON：静默清理并回退默认值', () => {
  const store = fakeStorage();
  store.setItem(LS_KEYS.theme, '{bad json!!');
  store.setItem(LS_KEYS.recent, 'not-json');
  const ls = createLocalStore(store);
  assert.equal(ls.get(LS_KEYS.theme, 'light'), 'light');
  assert.deepEqual(ls.get(LS_KEYS.recent, null), null);
  // 损坏键已被移除（下次可正常写入，不留脏数据）
  assert.equal(store.getItem(LS_KEYS.theme), null);
});

test('FE-LS-05 set 抛错（配额/禁用）返回 false 且旧值保留', () => {
  const store = fakeStorage();
  const ls = createLocalStore(store);
  assert.equal(ls.set(LS_KEYS.volume, 70), true);
  store.failNextSet();
  assert.equal(ls.set(LS_KEYS.volume, 30), false);
  assert.equal(ls.get(LS_KEYS.volume), 70); // 旧值未被破坏
});

test('FE-LS-06 remove 幂等', () => {
  const ls = createLocalStore(fakeStorage());
  ls.set(LS_KEYS.recent, { gameId: 1 });
  ls.remove(LS_KEYS.recent);
  assert.equal(ls.get(LS_KEYS.recent, null), null);
  ls.remove(LS_KEYS.recent); // 不存在再删不抛
});

test('FE-LS-07 无 storage（Node/隐私）回退内存存储仍可用', () => {
  const ls = createLocalStore(); // 参数缺省 → 取不到 localStorage 时用内存回退
  assert.equal(ls.set(LS_KEYS.theme, 'dark'), true);
  assert.equal(ls.get(LS_KEYS.theme, 'light'), 'dark');
});

test('FE-LS-08 memoryStorage 隔离', () => {
  const a = memoryStorage();
  const b = memoryStorage();
  a.setItem('k', '1');
  assert.equal(b.getItem('k'), null);
  assert.equal(a.getItem('k'), '1');
});

test('FE-LS-09 L-11：缺省 storage 解析结果缓存（探测/回退实例跨调用复用）', () => {
  const a = createLocalStore();
  const b = createLocalStore();
  a.set(LS_KEYS.theme, 'cached');
  assert.equal(
    b.get(LS_KEYS.theme, 'light'),
    'cached',
    '两次缺省创建应共享同一 storage（旧实现内存回退每次新实例 → 不可持续）',
  );
});
