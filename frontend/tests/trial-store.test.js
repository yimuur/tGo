/**
 * FE-TS（trial-store）· 试下会话缓存与 LRU（T6.8）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LruCache,
  createTrialStore,
  isTrialKey,
  parseTrialKey,
  parseMainKey,
  trialKey,
  mainKey,
} from '../static/js/core/trial-store.js';

test('FE-TS-01 | LruCache 访问即最新、超限淘汰最久未用', () => {
  const l = new LruCache({ max: 3 });
  l.set('a', 1);
  l.set('b', 2);
  l.set('c', 3);
  assert.equal(l.get('a'), 1); // a 置最新
  l.set('d', 4); // 淘汰 b（最久未用）
  assert.equal(l.has('a'), true);
  assert.equal(l.has('b'), false);
  assert.equal(l.size, 3);
});

test('FE-TS-02 | createTrialStore 基础读写 + size', () => {
  const s = createTrialStore({ max: 5 });
  s.set('main:0', { a: 1 });
  s.set('trial:7:1', { b: 2 });
  assert.deepEqual(s.get('main:0'), { a: 1 });
  assert.equal(s.has('trial:7:1'), true);
  assert.equal(s.size, 2);
  s.delete('main:0');
  assert.equal(s.size, 1);
  s.clear();
  assert.equal(s.size, 0);
});

test('FE-TS-03 | parseMainKey/parseTrialKey/isTrialKey/trialKey 工具', () => {
  assert.equal(parseMainKey('main:3'), 3);
  assert.equal(parseMainKey('trial:1:2'), null);
  assert.deepEqual(parseTrialKey('trial:7:2'), { trialId: 7, rel: 2 });
  assert.deepEqual(parseTrialKey('main:0'), null);
  assert.deepEqual(parseTrialKey('trial:1:2:3'), null); // 段数不符
  assert.equal(isTrialKey('trial:1:2'), true);
  assert.equal(isTrialKey('main:2'), false);
  assert.equal(trialKey(7, 2), 'trial:7:2');
  assert.equal(mainKey(7), 'main:7');
});

test('FE-TS-04 | truncateTrial 撤销截断（仅该分支 > rel 移除）', () => {
  const s = createTrialStore({ max: 20 });
  for (let r = 0; r <= 4; r += 1) s.set(`trial:1:${r}`, { r });
  for (let r = 0; r <= 2; r += 1) s.set(`trial:2:${r}`, { r });
  assert.equal(s.truncateTrial(1, 2), 2); // rel 3/4 移除
  assert.equal(s.has('trial:1:2'), true);
  assert.equal(s.has('trial:1:3'), false);
  assert.equal(s.has('trial:2:2'), true); // 其它分支不动
});

test('FE-TS-05 | clearTrial / pruneMain 范围清理', () => {
  const s = createTrialStore({ max: 20 });
  s.set('main:0', 0);
  s.set('main:5', 5);
  s.set('main:9', 9);
  s.set('trial:1:0', 'a');
  assert.equal(s.pruneMain(5), 1); // main:9 移除
  assert.equal(s.has('main:5'), true);
  assert.equal(s.has('main:9'), false);
  assert.equal(s.clearTrial(1), 1);
  assert.equal(s.has('trial:1:0'), false);
});
