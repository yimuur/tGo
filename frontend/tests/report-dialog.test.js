/**
 * tGo · 对局报告弹层 纯函数层 无头单测（T6.9，node --test）
 * 用例 ID: FE-RPT-*
 * 覆盖（TASK T6.9 验收）：视角载荷（默认人类视角/AI 方识别/参数归一）、
 * 加载与不完整态派生、等级文案映射（五档 label↔key）、落子质量行、
 * 均损脚注口径（视角方手数×视角方均损）、吻合环/标尺游标、胜负手视图模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRADE_ORDER,
  QLABEL_TO_KEY,
  LOSS_SCALE,
  parsePerspective,
  defaultPerspective,
  aiSideOf,
  isAiSide,
  playerSideText,
  playerColorText,
  headSegments,
  dialogPhase,
  qualityRows,
  meanLossView,
  fmtNum,
  ringView,
  meanMarkerPct,
  tpViewModel,
  settlePopModel,
  resolveActTarget,
  esc,
} from '../static/js/views/report-dialog.js';

/** 人机对弈（人类执黑、AI 执白）GameInfo（REST snake_case）。 */
const HUMAN_AI_B = {
  id: 58,
  mode: 'human_ai',
  human_color: 'B',
  black_name: '老陈',
  black_rank: 'rank_3d',
  white_name: 'AI',
  white_rank: 'rank_5k',
  board_size: 19,
  rules: 'chinese',
  komi: 7.5,
  last_move_no: 120,
};

const HUMAN_HUMAN = {
  id: 7,
  mode: 'human_human',
  human_color: null,
  black_name: '张三',
  black_rank: 'rank_1k',
  white_name: '李四',
  white_rank: 'rank_5k',
  board_size: 13,
  rules: 'japanese',
  komi: 6.5,
  last_move_no: 66,
};

/** 与后端 `GET /games/{id}/report` 载荷同构（含 T6.9 新增 grade）。 */
const REPORT_B = {
  game_id: 58,
  perspective: 'B',
  player_name: '老陈',
  player_rank: 'rank_3d',
  total_moves: 120,
  player_move_count: 60,
  top_n: 3,
  match_rate: 0.5833,
  top_n_hits: 35,
  mean_score_loss: 0.42,
  move_quality: { 妙着: 17, 正着: 31, 缓着: 8, 失误: 3, 败着: 1 },
  rating: { label: '业余 4段-5段', description: '大局观良好，但在复杂战斗中偶尔会下出缓着' },
  turning_points: [
    // 2026/09/11：`turning_points[].delta_winrate` 为**百分比**（后端输出边界已 ×100，round 2）；
    // `score_delta` 为 ΔS 目数变化（恶手为负，与 ΔW 同向）
    { move_no: 88, delta_winrate: -21.4, score_delta: -2.4, grade: 'blunder' },
    { move_no: 62, delta_winrate: -9.7, score_delta: -1.2, grade: 'mistake' },
    { move_no: 41, delta_winrate: 12.8, score_delta: 0.1, grade: 'brilliant' },
  ],
};

test('FE-RPT-01 视角载荷：p 参数归一 + 默认人类视角', () => {
  assert.equal(parsePerspective('W'), 'W');
  assert.equal(parsePerspective('B'), 'B');
  assert.equal(parsePerspective('w'), 'W');
  assert.equal(parsePerspective('b'), 'B');
  assert.equal(parsePerspective(undefined), null);
  assert.equal(parsePerspective(null), null);
  assert.equal(parsePerspective('X'), null);
  // 默认视角＝人类视角（人机取人类执色侧；人人＝黑方）
  assert.equal(defaultPerspective({ ...HUMAN_AI_B, human_color: 'B' }), 'B');
  assert.equal(defaultPerspective({ ...HUMAN_AI_B, human_color: 'W' }), 'W');
  assert.equal(defaultPerspective(HUMAN_HUMAN), 'B');
  assert.equal(defaultPerspective(null), 'B');
  assert.equal(defaultPerspective({}), 'B');
});

test('FE-RPT-02 AI 方识别（人机对弈视角）', () => {
  assert.equal(aiSideOf(HUMAN_AI_B), 'W'); // 人类执黑 → AI 执白
  assert.equal(aiSideOf({ ...HUMAN_AI_B, human_color: 'W' }), 'B');
  assert.equal(aiSideOf(HUMAN_HUMAN), null);
  assert.equal(aiSideOf(null), null);
  assert.equal(isAiSide(HUMAN_AI_B, 'W'), true);
  assert.equal(isAiSide(HUMAN_AI_B, 'B'), false);
  assert.equal(isAiSide(HUMAN_HUMAN, 'W'), false);
  assert.equal(playerSideText('B'), '黑方');
  assert.equal(playerSideText('W'), '白方');
  assert.equal(playerColorText('B'), '黑');
  assert.equal(playerColorText('W'), '白');
});

test('FE-RPT-03 对局摘要分段（头部 meta）', () => {
  assert.deepEqual(headSegments(HUMAN_AI_B), ['19路', '中国', '贴 7.5', '120 手']);
  assert.deepEqual(headSegments(HUMAN_HUMAN), ['13路', '日本', '贴 6.5', '66 手']);
  assert.deepEqual(headSegments(HUMAN_HUMAN, 88), ['13路', '日本', '贴 6.5', '88 手']);
  assert.deepEqual(headSegments({ mode: 'human_ai', board_size: 9, last_move_no: 5 }), ['9路', '5 手']);
  assert.deepEqual(headSegments(null), []);
});

test('FE-RPT-04 阶段派生：loading/ready/不完整/未找到/错误', () => {
  assert.equal(dialogPhase({}).kind, 'loading');
  assert.equal(dialogPhase({ ready: true, report: null }).kind, 'loading');
  const ready = dialogPhase({ ready: true, report: REPORT_B });
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.report, REPORT_B);
  assert.equal(dialogPhase({ ready: false, error: { code: 'ANALYSIS_INCOMPLETE' } }).kind, 'incomplete');
  assert.equal(dialogPhase({ ready: false, error: { code: 'GAME_NOT_FOUND' } }).kind, 'notfound');
  assert.equal(dialogPhase({ ready: false, error: { status: 404 } }).kind, 'notfound');
  assert.equal(dialogPhase({ ready: false, error: { code: 'NETWORK_ERROR' } }).kind, 'error');
  assert.equal(dialogPhase({ ready: false, error: { code: 'INTERNAL_ERROR' } }).kind, 'error');
});

test('FE-RPT-05 等级文案映射：中文 label → 五档英文 key', () => {
  assert.deepEqual(QLABEL_TO_KEY, {
    妙着: 'brilliant', 正着: 'good', 缓着: 'slow', 失误: 'mistake', 败着: 'blunder',
  });
  assert.deepEqual(GRADE_ORDER, ['brilliant', 'good', 'slow', 'mistake', 'blunder']);
  // 未知中文 label 映射不到五档
  const keys = Object.values(QLABEL_TO_KEY);
  assert.ok(!keys.includes('maybe_good'));
});

test('FE-RPT-06 落子质量行：顺序/数量/占比/未知键忽略', () => {
  const rows = qualityRows(REPORT_B.move_quality, 60);
  assert.deepEqual(rows.map((r) => r.key), GRADE_ORDER);
  assert.equal(rows[0].label, '妙着');
  assert.equal(rows[0].count, 17);
  assert.equal(rows[4].key, 'blunder');
  assert.equal(rows[4].count, 1);
  assert.ok(Math.abs(rows[0].pct - (17 / 60) * 100) < 1e-9);
  assert.ok(Math.abs(rows[1].pct - (31 / 60) * 100) < 1e-9);
  // 未知键（非五档中文 label）忽略；缺失计 0；playerMoveCount 0/负 分母兜底 1
  const extra = { 妙着: 5, some_custom: 9 };
  const r2 = qualityRows(extra, 0);
  assert.deepEqual(r2.map((r) => r.count), [5, 0, 0, 0, 0]);
  assert.ok(r2.every((r) => r.pct >= 0 && r.pct <= 100));
  // 空载荷 → 五行全 0
  const empty = qualityRows(null, 60);
  assert.equal(empty.length, 5);
  assert.ok(empty.every((r) => r.count === 0 && r.pct === 0));
});

test('FE-RPT-07 均损脚注口径：视角方手数 × 视角方均损', () => {
  const v = meanLossView(REPORT_B);
  assert.equal(v.mean, 0.42);
  assert.equal(v.count, 60); // 视角方手数（非全盘 120）
  assert.ok(Math.abs(v.total - 25.2) < 1e-9);
  // mean 缺失 / count 缺失
  assert.deepEqual(meanLossView({ mean_score_loss: null, player_move_count: 60 }), { mean: null, count: 60, total: null });
  assert.equal(meanLossView({ mean_score_loss: 0.5 }).count, 0);
  assert.equal(meanLossView(null).count, 0);
  // fmtNum 定点：去尾零 / 缺失 '—'
  assert.equal(fmtNum(0.42, 2), '0.42');
  assert.equal(fmtNum(2, 2), '2');
  assert.equal(fmtNum(50.4, 1), '50.4');
  assert.equal(fmtNum(0.5, 2), '0.5');
  assert.equal(fmtNum(null), '—');
  assert.equal(fmtNum('abc'), '—');
});

test('FE-RPT-08 吻合环与均损标尺游标', () => {
  const ring = ringView(0.5833);
  assert.equal(ring.pctText, '58%');
  assert.ok(ring.dash > 0 && ring.dash < 352);
  assert.equal(ringView(0).dash, 0);
  assert.equal(ringView(1.2).pct, 100);
  assert.equal(ringView(-0.1).pct, 0);
  // 标尺：0.15(职业)↔1.5(初学者) 线性钳制
  assert.ok(Math.abs(meanMarkerPct(0.15) - 0) < 1e-9);
  assert.ok(Math.abs(meanMarkerPct(1.5) - 100) < 1e-9);
  const mid = meanMarkerPct(LOSS_SCALE.pro + (LOSS_SCALE.beginner - LOSS_SCALE.pro) / 2);
  assert.ok(Math.abs(mid - 50) < 1e-9);
  assert.equal(meanMarkerPct(0.05), 0);
  assert.equal(meanMarkerPct(5), 100);
  assert.equal(meanMarkerPct(null), null);
  assert.equal(meanMarkerPct('x'), null);
});

test('FE-RPT-09 胜负手视图模型（等级文案映射 + ΔW/ΔS 文案 + AI 标注）', () => {
  const tps = tpViewModel(REPORT_B, 'B', false);
  assert.equal(tps.length, 3);
  assert.deepEqual(tps[0], {
    moveNo: 88,
    sideText: '黑',
    gradeKey: 'blunder',
    gradeLabel: '败着',
    deltaText: '−21.4%', // U+2212 负号；**百分比载荷直用**
    scoreText: '−2.4 目', // ΔS=目数变化（恶手为负，与 ΔW 同向；2026/09/12 起随 ΔW 展示）
  });
  assert.equal(tps[1].gradeLabel, '失误');
  assert.equal(tps[1].scoreText, '−1.2 目');
  assert.equal(tps[2].gradeKey, 'brilliant');
  assert.equal(tps[2].gradeLabel, '妙着');
  assert.equal(tps[2].deltaText, '+12.8%');
  assert.equal(tps[2].scoreText, '+0.1 目');
  // 人工反馈用例（对局 #80 第 13 手：ΔW −0.5% 但 ΔS 触发败着数值带 → ΔS 必须可见）
  const move13 = tpViewModel(
    { turning_points: [{ move_no: 13, delta_winrate: -0.5, score_delta: -5.433, grade: 'blunder' }] },
    'B',
  );
  assert.equal(move13[0].deltaText, '−0.5%');
  assert.equal(move13[0].scoreText, '−5.4 目'); // 1 位小数（round），与点评卡 ΔS 同格式
  assert.equal(move13[0].gradeLabel, '败着');
  // 回归（曾 ×100 二次换算显示 −2140%/−690%）：百分比载荷必须原样展示
  const again = tpViewModel({ turning_points: [{ move_no: 3, delta_winrate: -6.9 }] }, 'B');
  assert.equal(again[0].deltaText, '−6.9%');
  // AI 方视角：sideText 带（AI）
  const aiTps = tpViewModel(REPORT_B, 'W', true);
  assert.equal(aiTps[0].sideText, '白（AI）');
  // 缺 grade/delta/score_delta 容错；无 move_no 条目剔除
  const sparse = tpViewModel(
    { turning_points: [
      { move_no: 3, delta_winrate: null, grade: null },
      { move_no: 5, delta_winrate: -5 },
      { move_no: null, delta_winrate: 0.1, grade: 'good' },
      {},
    ] },
    'B',
  );
  assert.deepEqual(sparse.map((t) => [t.moveNo, t.deltaText, t.scoreText, t.gradeLabel]), [
    [3, '', '', ''],
    [5, '−5%', '', ''],
  ]);
  assert.equal(tpViewModel({}, 'B').length, 0);
  assert.equal(tpViewModel(null, 'B').length, 0);
});

test('FE-RPT-11 终局信息气泡模型（图标显隐/三行/认输仅结果行）', () => {
  // 双 PASS 确认结算局：三行（终局结果 verbose 含 GTP 串）+ 黑/白目（整数/小数格式）
  const settled = settlePopModel({ result: 'B+77', black_score: 77, white_score: 0 });
  assert.equal(settled.visible, true);
  assert.deepEqual(settled.rows, [
    { label: '终局结果', value: '黑胜 77 目 (B+77)' },
    { label: '黑目', value: '77' },
    { label: '白目', value: '0' },
  ]);
  const small = settlePopModel({ result: 'W+8.5', black_score: 24, white_score: 32.5 });
  assert.deepEqual(small.rows.slice(1), [
    { label: '黑目', value: '24' },
    { label: '白目', value: '32.5' },
  ]);
  // 认输局（无结算目数）：仅「终局结果」一行（与结算面板隐藏目数网格口径一致）
  const resign = settlePopModel({ result: 'W+Resign', black_score: null, white_score: null });
  assert.equal(resign.visible, true);
  assert.deepEqual(resign.rows, [{ label: '终局结果', value: '白中盘胜 (W+Resign)' }]);
  // 未终局/未加载：图标不显示
  assert.deepEqual(settlePopModel({ result: null }), { visible: false, rows: [] });
  assert.deepEqual(settlePopModel(null), { visible: false, rows: [] });
  assert.deepEqual(settlePopModel({ result: '' }), { visible: false, rows: [] });
});

test('FE-RPT-12 动作宿主解析：图标目标须经 closest 向上解析（BUG-050 点击失效根因）', () => {
  const host = { tag: 'button', getAttribute: () => 'settle' };
  // 目标＝按钮内 SVG 图标（<svg>/<use>）：自身无 data-act，须返回最近宿主
  const iconTarget = { tagName: 'use', closest: (sel) => (sel === '[data-act], [data-close]' ? host : null) };
  assert.equal(resolveActTarget(iconTarget), host);
  // 目标＝宿主自身（纯文本按钮的文本节点由浏览器重定向到按钮元素）
  const btnTarget = { tagName: 'button', closest: (sel) => (sel === '[data-act], [data-close]' ? btnTarget : null) };
  assert.equal(resolveActTarget(btnTarget), btnTarget);
  // 非元素目标/无宿主：返回 null 且不抛错
  assert.equal(resolveActTarget(null), null);
  assert.equal(resolveActTarget(undefined), null);
  assert.equal(resolveActTarget({}), null);
  assert.equal(resolveActTarget({ closest: () => null }), null);
});

test('FE-RPT-10 HTML 转义', () => {
  assert.equal(esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc('老陈 3D'), '老陈 3D');
});
