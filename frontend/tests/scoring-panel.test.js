/**
 * tGo · scoring-panel.js 终局结算纯函数层无头单测（T6.6，node --test）
 * 用例 ID: FE-SC-*
 * 覆盖（TASK.md T6.6 验收·纯逻辑）：死子点集（normalize/toggle/tuples）、
 * 分数格式化、数子结果网格派生、结算文案（subtitle/boardNote/mode/analysis）、
 * 再来一局载荷（人机/自适应/人人）。
 *
 * 死子/结果预判（2026/09/11 人工确认）：由**后端**终局深算推导并经
 * ``scoring.prediction`` 下发（ownership 链级启发式 + GTP final_score 等价），
 * 前端不再自带 ownership 预判（后端用例见 backend/tests/test_final_score.py、
 * test_ws_pushes.py）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pointKey,
  normalizePoints,
  toggleDeadPoint,
  deadToTuples,
  fmtScore,
  deriveScoreGrid,
  settleSubtitle,
  settleBoardNote,
  settleModeText,
  analysisText,
  analysisItemView,
  deadConfirmHint,
  predictionResultParts,
  rematchPayload,
  isResigned,
  resultHeroParts,
  createConfirmGuard,
  SCORING_CONFIRM_TIMEOUT_MS,
} from '../static/js/views/scoring-panel.js';

test('FE-SC-22 | createConfirmGuard：确认等待超时触发一次；done/重臂取消旧计时（M-9）', () => {
  assert.ok(SCORING_CONFIRM_TIMEOUT_MS > 0 && SCORING_CONFIRM_TIMEOUT_MS <= 60000);
  let fires = 0;
  const jobs = new Map();
  const cleared = [];
  let idc = 0;
  const guard = createConfirmGuard(() => { fires += 1; }, {
    setTimeoutImpl: (fn, ms) => {
      const id = ++idc;
      jobs.set(id, {
        fn: () => {
          jobs.delete(id);
          fn();
        },
        ms,
      });
      return id;
    },
    clearTimeoutImpl: (id) => {
      cleared.push(id);
      jobs.delete(id);
    },
    delayMs: 500,
  });
  guard.arm();
  assert.equal(guard.pending, true);
  assert.equal([...jobs.values()][0].ms, 500);
  [...jobs.values()][0].fn(); // 模拟计时到达
  assert.equal(fires, 1);
  assert.equal(guard.pending, false, '超时后守卫自行失效（不重复触发）');
  assert.equal(jobs.size, 0);
  // done：清除未到期的计时
  guard.arm();
  guard.done();
  assert.equal(guard.pending, false);
  assert.equal(jobs.size, 0);
  assert.equal(cleared.length, 1);
  // 重臂：旧计时被清、只保留一条（防多次提交叠加多份超时）
  guard.arm();
  guard.arm();
  assert.equal(cleared.length, 2);
  assert.equal(jobs.size, 1);
  assert.equal(guard.pending, true);
  // 默认延迟回退常量
  const defaultGuard = createConfirmGuard(() => {});
  defaultGuard.arm();
  defaultGuard.done();
});

function makeGame(overrides = {}) {
  const g = {
    gameId: 7,
    status: 'scoring',
    params: {
      mode: 'human_ai',
      boardSize: 19,
      rules: 'chinese',
      komi: 7.5,
      handicap: 0,
      humanColor: 'B',
      aiStyle: 'standard',
      aiLevel: 5,
      adaptiveEnabled: false,
      coachingEnabled: true,
    },
    players: {
      black: { name: '张三', rank: 'rank_1d' },
      white: { name: 'AI', rank: null },
    },
    captures: { black: 2, white: 0 },
    undoCount: 0,
    moves: [],
    lastMoveNo: 0,
    result: null,
    ...overrides,
  };
  if (overrides.params) g.params = { ...makeGame().params, ...overrides.params };
  if (overrides.players) g.players = { ...makeGame().players, ...overrides.players };
  return g;
}

/* ============================================================
 * 死子点集工具
 * ============================================================ */

test('FE-SC-01 | pointKey 坐标点键', () => {
  assert.equal(pointKey(3, 15), '3,15');
});

test('FE-SC-02 | normalizePoints 去重并过滤非法', () => {
  const pts = normalizePoints([
    { x: 1, y: 2 }, { x: '3', y: 4 }, { x: 1, y: 2 },
    { x: -1, y: 2 }, { x: NaN, y: 2 }, null, undefined,
  ]);
  assert.deepEqual(pts, [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.deepEqual(normalizePoints(undefined), []);
});

test('FE-SC-03 | toggleDeadPoint 增/删切换', () => {
  let list = [];
  list = toggleDeadPoint(list, 3, 3);
  list = toggleDeadPoint(list, 4, 4);
  assert.deepEqual(list, [{ x: 3, y: 3 }, { x: 4, y: 4 }]);
  list = toggleDeadPoint(list, 3, 3); // 移除
  assert.deepEqual(list, [{ x: 4, y: 4 }]);
  list = toggleDeadPoint(list, -5, 1); // 非法忽略
  assert.deepEqual(list, [{ x: 4, y: 4 }]);
});

test('FE-SC-04 | deadToTuples → 服务端坐标对数组', () => {
  assert.deepEqual(deadToTuples([{ x: 1, y: 2 }, { x: '3', y: '4' }, { x: 1, y: 2 }]), [
    [1, 2],
    [3, 4],
  ]);
});

/* ============================================================
 * 结果 / 网格 / 文案
 * ============================================================ */

test('FE-SC-05 | fmtScore 整数原样 / 一位小数去尾 / 空值 —', () => {
  assert.equal(fmtScore(185), '185');
  assert.equal(fmtScore(182.5), '182.5');
  assert.equal(fmtScore(7), '7');
  assert.equal(fmtScore(7.0), '7');
  assert.equal(fmtScore(null), '—');
  assert.equal(fmtScore('abc'), '—');
});

test('FE-SC-06 | deriveScoreGrid 数子局：黑/白/贴/手 4 项', () => {
  const game = makeGame({ lastMoveNo: 108 });
  const grid = deriveScoreGrid(game, { blackScore: 185, whiteScore: 182.5 });
  assert.equal(grid.hasNumbers, true);
  assert.deepEqual(
    grid.items.map((i) => [i.label, i.value]),
    [['黑目', '185'], ['白目', '182.5'], ['贴目', '7.5'], ['手数', '108']],
  );
});

test('FE-SC-07 | deriveScoreGrid 认输局（无分数）→ items=[] hasNumbers=false', () => {
  const game = makeGame({ status: 'finished', result: 'W+Resign', lastMoveNo: 96 });
  const grid = deriveScoreGrid(game, { blackScore: null, whiteScore: null });
  assert.equal(grid.hasNumbers, false);
  assert.deepEqual(grid.items, []);
});

test('FE-SC-08 | settleSubtitle 认输 / 数子终局 / 未定型终局（AI 预判）', () => {
  assert.equal(settleSubtitle(makeGame({ status: 'finished', result: 'W+Resign' })), '认输终局 · 本局已保存');
  assert.equal(settleSubtitle(makeGame({ status: 'finished', result: 'B+2.5' })), '终局结算完成');
  assert.equal(settleSubtitle(makeGame({ status: 'scoring' })), '');
  // 未定型终局（结果取自 AI 预判，2026/10/10 人工口径）→ 副行如实说明来源
  assert.equal(
    settleSubtitle(makeGame({ status: 'finished', result: 'W+2' }), { aiPredicted: true }),
    '终局局面未定型 · 结果为 AI 预判',
  );
  // 认输优先（认输局不做死子确认，不属未定型口径）
  assert.equal(
    settleSubtitle(makeGame({ status: 'finished', result: 'W+Resign' }), { aiPredicted: true }),
    '认输终局 · 本局已保存',
  );
  // 载荷缺失 / 显式 false → 保持原数子终局文案
  assert.equal(settleSubtitle(makeGame({ status: 'finished', result: 'B+2.5' }), null), '终局结算完成');
  assert.equal(settleSubtitle(makeGame({ status: 'finished', result: 'B+2.5' }), { aiPredicted: false }), '终局结算完成');
});

test('FE-SC-09 | settleBoardNote 结算/终局文案', () => {
  const s = settleBoardNote(makeGame({ status: 'scoring' }));
  assert.match(s, /死子确认/);
  const f = settleBoardNote(makeGame({ status: 'finished', result: 'B+2.5' }));
  assert.match(f, /终局/);
  assert.match(f, /黑胜 2.5 目/);
});

test('FE-SC-10 | settleModeText 模式文本', () => {
  assert.equal(settleModeText(makeGame()), '人机 · 标准');
  assert.equal(settleModeText(makeGame({ params: { mode: 'human_ai', aiStyle: 'human', adaptiveEnabled: false } })), '人机 · 人类');
  assert.equal(settleModeText(makeGame({ params: { mode: 'human_ai', adaptiveEnabled: true } })), '人机 · 自适应');
  assert.equal(settleModeText(makeGame({ params: { mode: 'human_human' } })), '人人');
});

test('FE-SC-11 | analysisText 完整性文案', () => {
  assert.deepEqual(analysisText(true), { text: '完整', ok: true });
  assert.deepEqual(analysisText(false), { text: '不完整', ok: false });
});

test('FE-SC-17 | analysisItemView：完整＝保持现状（图标+完整）；不完整＝分析覆盖 X/Y（2026/09/18 人工口径）', () => {
  // 完整：现有提示不变
  assert.deepEqual(
    analysisItemView(true, null),
    { ok: true, label: '分析数据', value: '完整', icon: 'i-success', color: 'var(--eng-idle)' },
  );
  // 不完整：显示「分析覆盖」+ X/Y（复用 game.state 快照 / REST 刷新计数）
  assert.deepEqual(
    analysisItemView(false, { done: 3, total: 12 }),
    { ok: false, label: '分析覆盖', value: '3/12', icon: null, color: null },
  );
  // 计数缺失/非法 → —（不猜数）；Y 越界非法（负）同样回退
  assert.equal(analysisItemView(false, null).value, '—');
  assert.equal(analysisItemView(false, {}).value, '—');
  assert.equal(analysisItemView(false, { done: 'x', total: 12 }).value, '—');
  assert.equal(analysisItemView(false, { done: 3, total: -1 }).value, '—');
  // X 越界钳制到 [0, Y]
  assert.equal(analysisItemView(false, { done: 99, total: 12 }).value, '12/12');
  assert.equal(analysisItemView(false, { done: -5, total: 12 }).value, '0/12');
});

/* ============================================================
 * 再来一局载荷
 * ============================================================ */

test('FE-SC-12 | rematchPayload 人机标准：继承参数/快照/难度', () => {
  const game = makeGame({ lastMoveNo: 108 });
  const p = rematchPayload(game);
  assert.deepEqual(p, {
    mode: 'human_ai',
    board_size: 19,
    rules: 'chinese',
    komi: 7.5,
    handicap: 0,
    color: 'B',
    black: { name: '张三', rank: 'rank_1d' },
    // AI 侧留空（服务端自落 `AI`）——见 FE-SC-23/BUG-136
    white: { name: null, rank: null },
    coaching: true,
    ai: { style: 'standard', adaptive: false, level: 5 },
  });
});

test('FE-SC-13 | rematchPayload 人机自适应 + 让子：komi 强制 0 / ai adaptive', () => {
  const game = makeGame({
    params: {
      mode: 'human_ai', boardSize: 9, rules: 'japanese', komi: 0,
      handicap: 2, humanColor: 'B', aiStyle: 'human', aiLevel: 9,
      adaptiveEnabled: true, coachingEnabled: false,
    },
    players: { black: { name: '老陈', rank: 'rank_3d' }, white: { name: 'AI', rank: null } },
  });
  const p = rematchPayload(game);
  assert.equal(p.mode, 'human_ai');
  assert.equal(p.board_size, 9);
  assert.equal(p.komi, 0);
  assert.equal(p.handicap, 2);
  assert.deepEqual(p.ai, { style: 'human', adaptive: true });
  assert.equal(p.coaching, false);
});

test('FE-SC-14 | rematchPayload 人人：无 color/ai', () => {
  const game = makeGame({
    params: {
      mode: 'human_human', boardSize: 19, rules: 'chinese', komi: 6.5,
      handicap: 0, humanColor: null, aiStyle: null, aiLevel: null,
      adaptiveEnabled: false, coachingEnabled: false,
    },
    players: { black: { name: '张三', rank: null }, white: { name: '李四', rank: 'rank_1k' } },
  });
  const p = rematchPayload(game);
  assert.equal(p.mode, 'human_human');
  assert.equal(p.color, undefined);
  assert.equal(p.ai, undefined);
  assert.equal(p.komi, 6.5);
  assert.deepEqual(p.black, { name: '张三', rank: null });
  assert.deepEqual(p.white, { name: '李四', rank: 'rank_1k' });
});

test('FE-SC-23 | rematchPayload 人机：AI 侧展示派生快照不外发（BUG-136「再来一局」422）', () => {
  // 状态树 players[AI 侧] 被 state.js::aiSideDisplay 覆写为**展示值**（名称 `AI` +
  // 显示段位 `5K`）；原样回传会被创建接口的段位校验拒绝（`5K` 非 `rank_*` 机读码）
  // → 422 INVALID_PAYLOAD「请求参数不合法」，「再来一局」恒失败。AI 侧留空，
  // 由服务端自落名称 `AI` 并按 `ai.level` 推难度（与创建向导载荷同口径）。
  const game = makeGame({
    players: {
      black: { name: '张三', rank: 'rank_1d' },
      white: { name: 'AI', rank: '5K', tag: '标准' },
    },
  });
  const p = rematchPayload(game);
  assert.deepEqual(p.white, { name: null, rank: null });
  assert.deepEqual(p.black, { name: '张三', rank: 'rank_1d' });
});

test('FE-SC-24 | rematchPayload 人机（人类执白）：AI 执黑侧不外发、人类侧快照保留', () => {
  const game = makeGame({
    params: {
      mode: 'human_ai', boardSize: 13, rules: 'japanese', komi: 6.5,
      handicap: 0, humanColor: 'W', aiStyle: 'human', aiLevel: 4,
      adaptiveEnabled: false, coachingEnabled: false,
    },
    players: {
      black: { name: 'AI', rank: '3K', tag: '拟人' },
      white: { name: '李四', rank: 'rank_3k' },
    },
  });
  const p = rematchPayload(game);
  assert.equal(p.color, 'W');
  assert.deepEqual(p.black, { name: null, rank: null });
  assert.deepEqual(p.white, { name: '李四', rank: 'rank_3k' });
});

test('FE-SC-15 | isResigned 判定', () => {
  assert.equal(isResigned(makeGame({ result: 'W+Resign' })), true);
  assert.equal(isResigned(makeGame({ result: 'B+2.5' })), false);
  assert.equal(isResigned(makeGame({ result: null })), false);
});

test('FE-SC-16 | resultHeroParts 大字与括号附注拆分（附注走 <small> 基线字号）', () => {
  assert.deepEqual(resultHeroParts('W+6.5'), { body: '白胜 6.5 目', note: '(W+6.5)' });
  assert.deepEqual(resultHeroParts('B+Resign'), { body: '黑中盘胜', note: '(B+Resign)' });
  assert.equal(resultHeroParts('Draw').note, '');
  assert.deepEqual(resultHeroParts(null), { body: '', note: '' });
});

/* ---------- 2026/09/19：复盘补结算共用纯函数（自模块内抽取，单一口径） ---------- */

test('FE-SC-20 | deadConfirmHint：引擎不可用 > 等待 > 无数据 > 预判/手动计数的提示优先级', () => {
  // 引擎不可用（DEAD/FATAL）优先于一切（前端转人工标记）
  assert.equal(
    deadConfirmHint({ engineState: 'DEAD', predState: 'waiting', deadCount: 3 }),
    '引擎不可用：请手动点击棋子标记死子（✕）',
  );
  assert.equal(
    deadConfirmHint({ engineState: 'fatal', predState: 'seeded', deadCount: 3 }),
    '引擎不可用：请手动点击棋子标记死子（✕）',
  );
  // 等待预判 / 预判无数据（引擎类降级）
  assert.equal(
    deadConfirmHint({ engineState: 'IDLE', predState: 'waiting', deadCount: 0 }),
    'AI 正在分析终局局面以预判死子…（可先手动标记）',
  );
  assert.equal(
    deadConfirmHint({ engineState: 'IDLE', predState: 'no-data', deadCount: 0 }),
    '未能获取 AI 预判：请手动标记死子（✕）',
  );
  // 预判预标 / 手动标记 / 空标记
  assert.equal(
    deadConfirmHint({ engineState: 'IDLE', predState: 'seeded', deadCount: 4 }),
    'AI 预判 4 颗死子（✕ 标记）· 点击棋子切换死/活',
  );
  assert.equal(
    deadConfirmHint({ engineState: 'IDLE', predState: 'seeded', deadCount: 0 }),
    '未标记死子 · 点击棋子标记死子（✕），确认后按此结算',
  );
  assert.equal(
    deadConfirmHint({ engineState: 'IDLE', predState: 'none', deadCount: 2 }),
    '已标记 2 颗死子（✕ 标记）· 点击棋子切换死/活',
  );
  // 容错：缺省/非法计数（防御脏输入）
  assert.equal(deadConfirmHint(), '未标记死子 · 点击棋子标记死子（✕），确认后按此结算');
  assert.equal(
    deadConfirmHint({ deadCount: NaN }),
    '未标记死子 · 点击棋子标记死子（✕），确认后按此结算',
  );
});

test('FE-SC-21 | predictionResultParts：仅 engine 且有 result 时给 {body,note}（正文粗体+主题色前置），否则 null', () => {
  assert.deepEqual(
    predictionResultParts({ engine: true, result: 'B+3.5' }),
    { body: '黑胜 3.5 目', note: '(B+3.5)' },
  );
  assert.deepEqual(
    predictionResultParts({ engine: true, result: 'W+1.5' }),
    { body: '白胜 1.5 目', note: '(W+1.5)' },
  );
  // 认输类（无目数）同样拆分（正文 = 白/黑中盘胜）
  assert.deepEqual(
    predictionResultParts({ engine: true, result: 'B+Resign' }),
    { body: '黑中盘胜', note: '(B+Resign)' },
  );
  assert.equal(predictionResultParts({ engine: true, result: null }), null);
  assert.equal(predictionResultParts({ engine: false, result: 'B+3.5' }), null);
  assert.equal(predictionResultParts(null), null);
  assert.equal(predictionResultParts(undefined), null);
});
