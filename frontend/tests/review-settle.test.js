/**
 * tGo · review-settle.js 复盘补结算纯函数层无头单测（2026/09/19，node --test）
 * 用例 ID: FE-SET-*
 * 覆盖：抽屉标题（含死子计数/已结算态）；第二步「数子结果」派生（同对弈页口径）；
 * 重导出共用提示函数口径一致（deadConfirmHint / predictionResultParts 来源须为
 * scoring-panel.js 单一口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { settleDrawerTitle, settleResultModel } from '../static/js/views/review-settle.js';

test('FE-SET-01 | settleDrawerTitle：无标记 → 死子确认；有标记 → 死子已标 N 颗；已结算 → 已结算', () => {
  assert.equal(settleDrawerTitle(0), '终局结算 · 死子确认');
  assert.equal(settleDrawerTitle(3), '终局结算 · 死子已标 3 颗');
  // 第二步（数子结果）态
  assert.equal(settleDrawerTitle(3, true), '终局结算 · 已结算');
  assert.equal(settleDrawerTitle(0, true), '终局结算 · 已结算');
  // 容错：非法计数视为 0（防御脏输入）
  assert.equal(settleDrawerTitle(-1), '终局结算 · 死子确认');
  assert.equal(settleDrawerTitle(NaN), '终局结算 · 死子确认');
  assert.equal(settleDrawerTitle(), '终局结算 · 死子确认');
});

test('FE-SET-02 | settleResultModel：第二步数子结果同口径（大字 + 黑目/白目/贴目/手数）', () => {
  const game = {
    status: 'finished',
    result: 'W+1.5',
    lastMoveNo: 74,
    params: { komi: 6.5, boardSize: 9, handicap: 0 },
  };
  // 双 PASS 确认结算局：大字 + 四格（黑目/白目/贴目/手数，同对弈页 resultPhaseHTML）
  const model = settleResultModel(game, { result: 'W+1.5', blackScore: 43, whiteScore: 44.5 });
  assert.deepEqual(model.hero, { body: '白胜 1.5 目', note: '(W+1.5)' });
  assert.equal(model.subtitle, '终局结算完成');
  assert.equal(model.grid.hasNumbers, true);
  assert.deepEqual(model.grid.items.map((it) => [it.label, it.value]), [
    ['黑目', '43'], ['白目', '44.5'], ['贴目', '6.5'], ['手数', '74'],
  ]);
  // 认输类无目数 → 仅大字（grid.hasNumbers=false）
  const resign = settleResultModel({ ...game, result: 'W+Resign' }, { result: 'W+Resign', blackScore: null, whiteScore: null });
  assert.equal(resign.hero.body, '白中盘胜');
  assert.equal(resign.grid.hasNumbers, false);
  assert.equal(resign.subtitle, '认输终局 · 本局已保存');
  // 未定型终局（导入棋谱补结算取 AI 预判，2026/10/10 人工口径）：无精确目数 → 仅大字，
  // 副行如实说明来源（而非「终局结算完成」）
  const unsettled = settleResultModel(
    { ...game, result: 'W+2' },
    { result: 'W+2', blackScore: null, whiteScore: null, aiPredicted: true },
  );
  assert.equal(unsettled.hero.note, '(W+2)');
  // 文案与产品源（scoring-panel.js settleSubtitle）及同轮用例 FE-SC-08 对齐：
  // 中文与拉丁文之间保留空格（`结果为 AI 预判`）。旧值 `结果为AI 预判` 系同轮漏改的陈旧断言
  // （2026/10/10 修）：彼时 FE-SC-08 已按带空格对齐并通过，仅本用例未同步 → 常态化红灯。
  assert.equal(unsettled.subtitle, '终局局面未定型 · 结果为 AI 预判');
  assert.equal(unsettled.grid.hasNumbers, false);
  // 载荷缺 result → 回退 store 对局 result（脏输入容错）
  const fallback = settleResultModel(game, { blackScore: 43, whiteScore: 44.5 });
  assert.equal(fallback.hero.note, '(W+1.5)');
  // 空入参不抛错
  const empty = settleResultModel(null, null);
  assert.equal(empty.grid.hasNumbers, false);
});
