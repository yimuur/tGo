/**
 * tGo · view-loader.js 无头单测（BUG-082）
 * 用例 ID: FE-VL-*
 * 覆盖：动态 import 失败后的一次自动重试（移动端网络切换瞬时失败自愈）与
 *       不重试/两次均失败的终态（由 app.js 呈现错误面板出口）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  importWithRetry,
  viewModuleName,
  VIEW_MODULES,
  VIEW_IMPORT_RETRY_MS,
} from '../static/js/core/view-loader.js';

test('FE-VL-01 importWithRetry：首次失败 → 重试成功（恰好两次调用）', async () => {
  let calls = 0;
  const result = await importWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error('瞬时失败（网络切换）');
    return { default: () => 'view' };
  }, 1);
  assert.equal(calls, 2, '应恰好重试一次');
  assert.ok(result && typeof result.default === 'function');
});

test('FE-VL-02 两次均失败 → 上抛最后一次错误（调用方渲染错误面板）', async () => {
  let calls = 0;
  const importer = async () => {
    calls += 1;
    throw new Error(`e${calls}`);
  };
  await assert.rejects(importWithRetry(importer, 1), /e2/);
  assert.equal(calls, 2);
});

test('FE-VL-03 retryMs<=0 不重试（立即上抛首个错误）', async () => {
  let calls = 0;
  const importer = async () => {
    calls += 1;
    throw new Error(`e${calls}`);
  };
  await assert.rejects(importWithRetry(importer, 0), /e1/);
  assert.equal(calls, 1);
});

test('FE-VL-04 路由→模块映射与重试延迟常量', () => {
  assert.equal(viewModuleName('game'), VIEW_MODULES.game);
  assert.equal(viewModuleName('onboarding'), VIEW_MODULES.onboarding);
  assert.equal(viewModuleName('__nope__'), VIEW_MODULES.game, '未知路由回落 game-view');
  assert.ok(VIEW_IMPORT_RETRY_MS > 0 && VIEW_IMPORT_RETRY_MS <= 2000, VIEW_IMPORT_RETRY_MS);
});
