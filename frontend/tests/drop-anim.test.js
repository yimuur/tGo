/**
 * tGo · drop-anim 落子动效模型 无头单测（node --test）
 * 用例 ID: FE-DROP-*
 * 覆盖：R 归一几何 / 帧率无关指数衰减 / 落地判定 / 压缩与下移边界 / 输入容错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DROP_ANIM,
  DROP_MS,
  dropZR,
  dropRatio,
  dropSquash,
  dropYOffR,
  isDropLanded,
} from '../static/js/core/drop-anim.js';

test('FE-DROP-01 常量与时长合理', () => {
  assert.ok(DROP_ANIM.z0R > 0, '起始高度为正');
  assert.ok(DROP_ANIM.squashMax > 0 && DROP_ANIM.squashMax < 1);
  assert.ok(DROP_ANIM.yMaxR > 0);
  // 时长与参数同式（参考稿逐帧 0.85 因子→解析式 ×1200ms 换算，2026/09/09 人工重调）
  const expect = Math.round(
    (Math.log(DROP_ANIM.z0R / DROP_ANIM.landEpsR) / DROP_ANIM.decayPerSec) * 1200,
  );
  assert.equal(DROP_MS, expect, 'DROP_MS 与参数推导一致');
  assert.ok(DROP_MS > 700 && DROP_MS < 1300, `总时长 ${DROP_MS}ms 落在 700–1300ms 可感知区间`);
});

test('FE-DROP-02 高度指数衰减：单调递减、0ms=z0R、长时间归零', () => {
  assert.equal(dropZR(0), DROP_ANIM.z0R);
  const a = dropZR(80);
  const b = dropZR(160);
  assert.ok(b < a && a < DROP_ANIM.z0R, '随时间递减');
  assert.equal(dropZR(10 ** 6), 0, '足够长时间 → 落地(0)');
  assert.equal(dropZR(-50), DROP_ANIM.z0R, '负 elapsed 视为起点');
});

test('FE-DROP-03 落地判定与 dropRatio 边界', () => {
  assert.equal(isDropLanded(0), false);
  assert.equal(isDropLanded(DROP_MS), true, '达到总时长即判定落地');
  const r0 = dropRatio(0);
  const rMid = dropRatio(DROP_MS / 2);
  assert.ok(r0 <= 1 && r0 > rMid && rMid > 0);
  assert.equal(dropRatio(DROP_MS), 0);
  assert.ok(Number.isFinite(dropRatio(1e9)));
});

test('FE-DROP-04 压缩与下移：区间边界与单调', () => {
  assert.equal(dropSquash(0), 1, '落地正圆');
  assert.equal(dropSquash(1), 1 - DROP_ANIM.squashMax, '最高最扁');
  assert.equal(dropSquash(-1), 1, '负值钳制');
  assert.equal(dropSquash(5), 1 - DROP_ANIM.squashMax, '超界钳制');
  assert.equal(dropYOffR(0), 0);
  assert.ok(dropYOffR(0.5) < dropYOffR(1));
  assert.equal(dropYOffR(1), DROP_ANIM.yMaxR);
  // 高度下降 → 压缩恢复 + 下移回落（回落到平贴位）
  assert.ok(dropSquash(dropRatio(100)) > dropSquash(dropRatio(0)));
  assert.ok(dropYOffR(dropRatio(100)) < dropYOffR(dropRatio(0)));
});

test('FE-DROP-05 输入容错：NaN/undefined 不抛错', () => {
  assert.equal(Number.isNaN(dropZR(NaN)), false);
  assert.equal(Number.isNaN(dropRatio(undefined)), false);
  assert.equal(dropSquash(NaN), 1);
  assert.equal(dropYOffR(NaN), 0);
  assert.equal(isDropLanded(NaN), false); // NaN→按起点处理（未落地），不抛错
});
