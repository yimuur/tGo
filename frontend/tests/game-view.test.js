/**
 * tGo · game-view.js 对弈视图纯函数层无头单测（T6.4，node --test）
 * 用例 ID: FE-GAME-*
 * 覆盖（TASK.md T6.4 验收·纯逻辑）：恢复候选解析 deriveEntry；视图派生
 * deriveUi（人人/人机、TURN_AI、busy/undoWaiting 防堆积、引擎降级、终局桥、
 * 悔棋语义（人机上限 / 人人无限+单步确认）、autoStart）；emptyCopy；
 * captureThemeKey 主题键纯函数（实现在 core/capture-counter.js，FE-GAME-11）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveEntry,
  deriveUi,
  emptyCopy,
  goneCloseAction,
  autoStartAction,
  undoDeclinedOutcome,
  resignConfirmText,
  moveAppliedUnlocksBusy,
  engineAbnormalWarnText,
} from '../static/js/views/game-view.js';
import { captureThemeKey } from '../static/js/core/capture-counter.js';

function makeGame(overrides = {}) {
  const g = {
    gameId: 7,
    status: 'active',
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
    },
    players: { black: { name: '张三' }, white: { name: 'AI' } },
    turn: null,
    nextColor: 'B',
    captures: { black: 2, white: 0 },
    undoCount: 0,
    moves: [],
    lastMoveNo: 0,
    result: null,
    ...overrides,
  };
  if (overrides.params) g.params = { ...makeGame().params, ...overrides.params };
  if (overrides.moves) g.moves = overrides.moves;
  if (overrides.undoCount !== undefined) g.undoCount = overrides.undoCount;
  return g;
}

const mv = (no, color, x, y, isPass = false) => ({ moveNo: no, color, x, y, isPass });
const baseParams = (mode = 'human_ai', humanColor = 'B') => ({
  mode, boardSize: 19, rules: 'chinese', komi: 7.5, handicap: 0,
  humanColor: mode === 'human_ai' ? humanColor : null, aiStyle: 'standard',
  aiLevel: 5, adaptiveEnabled: false,
});

/* ============================================================
 * deriveEntry（恢复候选）
 * ============================================================ */

test('FE-GAME-27 | 引擎异常警示条文案：DEAD/FATAL 分叉，且不再提供 [重试] 入口', () => {
  // 2026/09/20 人工决策（ISSUE-069）：启动/重启入口收敛到管理页
  assert.match(engineAbnormalWarnText('DEAD'), /自动重启中/);
  assert.match(engineAbnormalWarnText('FATAL'), /请到管理页 \[手动重启\]/);
  assert.match(engineAbnormalWarnText(null), /自动重启中/, '未知态按自愈中呈现');
  assert.equal(/重试/.test(engineAbnormalWarnText('DEAD')), false);
});

test('FE-GAME-01 | deriveEntry：recent 优先 → active-latest → none', () => {
  assert.deepEqual(deriveEntry({ gameId: 12 }, null), { gameId: 12, source: 'recent' });
  assert.deepEqual(deriveEntry({ gameId: 12 }, { id: 9 }), { gameId: 12, source: 'recent' });
  assert.deepEqual(deriveEntry(null, { id: 9 }), { gameId: 9, source: 'active' });
  assert.deepEqual(deriveEntry({ gameId: 0 }, null), { gameId: null, source: 'none' });
  assert.deepEqual(deriveEntry(null, null), { gameId: null, source: 'none' });
  assert.deepEqual(deriveEntry({}, { id: 'x' }), { gameId: null, source: 'none' });
});

/* ============================================================
 * deriveUi · 基础
 * ============================================================ */

test('FE-GAME-02 | 人机人类回合：可交互、无 AI 胶囊、操作可用、meta 完整', () => {
  // 人类执白：黑（AI）已落第 1 手 → 轮到人类（白）
  const game = makeGame({ params: baseParams('human_ai', 'W'), nextColor: 'W', moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1 });
  const ui = deriveUi({ game, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(ui.humanAi, true);
  assert.equal(ui.interactive, true);
  assert.equal(ui.aiWait, null);
  assert.equal(ui.warn, false);
  assert.equal(ui.autoStart, false);
  assert.equal(ui.undo.label, '悔棋（5）');
  assert.equal(ui.actions.undo, true);
  assert.equal(ui.actions.pass, true);
  assert.equal(ui.actions.resign, true);
  assert.equal(ui.actions.restart, true);
  assert.equal(ui.terminal, null);
  assert.deepEqual(ui.meta.map((s) => s.text).slice(0, 2), ['第 1 手', '19路']);
  assert.equal(ui.note.text, '第 1 手 · 黑 D16');
});

test('FE-GAME-20 | 自动点评徽章段：开启点评的对局透传开关态（人工口径 2026/09/10）', () => {
  const on = makeGame({
    params: { ...baseParams('human_ai', 'B'), coachingEnabled: true },
    moves: [mv(1, 'B', 3, 3)],
    lastMoveNo: 1,
  });
  const uiOn = deriveUi({ game: on, engineState: 'IDLE', flags: {}, maxUndo: 5, coach: { enabled: true } });
  assert.deepEqual(uiOn.meta.at(-1), { text: '自动点评', coach: true, on: true });
  const uiOff = deriveUi({ game: on, engineState: 'IDLE', flags: {}, maxUndo: 5, coach: { enabled: false } });
  assert.deepEqual(uiOff.meta.at(-1), { text: '自动点评', coach: true, on: false });
  // 未开启点评 / 未传 coach → 无徽章段
  const plain = makeGame({ params: baseParams('human_ai', 'B'), moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1 });
  assert.equal(deriveUi({ game: plain, engineState: 'IDLE', flags: {}, maxUndo: 5 }).meta.some((s) => s.coach), false);
  assert.equal(
    deriveUi({ game: on, engineState: 'IDLE', flags: {}, maxUndo: 5 }).meta.some((s) => s.coach),
    false,
  );
});

test('FE-GAME-03 | 人机 AI 回合（TURN_AI）：禁输入 + 思考胶囊；busy 时同', () => {
  const aiTurn = makeGame({ params: baseParams('human_ai', 'B'), nextColor: 'W', moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1 });
  const ui = deriveUi({ game: aiTurn, engineState: 'ANALYZING', flags: {}, maxUndo: 5 });
  assert.equal(ui.interactive, false);
  assert.equal(ui.actions.pass, false);
  assert.ok(ui.aiWait && ui.aiWait.label === '思考中');
  // busy（本地 pending，人类刚落子 AI 执行中）→ 禁输入 + 胶囊
  const uiBusy = deriveUi({ game: aiTurn, engineState: 'IDLE', flags: { busy: true }, maxUndo: 5 });
  assert.equal(uiBusy.interactive, false);
  assert.ok(uiBusy.aiWait);
});

test('FE-GAME-04 | busy 防指令堆积：除人机悔棋（思考期可撤回本手）外全部禁发', () => {
  const game = makeGame({ params: baseParams('human_ai', 'B'), nextColor: 'B', moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1 });
  const ui = deriveUi({ game, engineState: 'IDLE', flags: { busy: true }, maxUndo: 5 });
  assert.equal(ui.actions.pass, false);
  assert.equal(ui.actions.resign, false);
  assert.equal(ui.actions.restart, false);
  // 人机 busy（AI 思考中）→ 悔棋可用（服务端终止在途查询，撤 1 步；2026/09/13）
  assert.equal(ui.actions.undo, true);
  // 悔棋已发出（undoPending）→ 视觉不变（防重复在行为层：sendUndo 忽略重复点击；
  // 曾参与禁用判定导致“被拒时闪烁”，2026/09/13 修复）
  const uiPend = deriveUi({ game, engineState: 'IDLE', flags: { busy: true, undoPending: true }, maxUndo: 5 });
  assert.equal(uiPend.actions.undo, true);
  const uiPendIdle = deriveUi({ game, engineState: 'IDLE', flags: { undoPending: true }, maxUndo: 5 });
  assert.equal(uiPendIdle.actions.undo, true);
  // 人人对弈 busy → 悔棋维持禁用（确认流语义不变）
  const hh = makeGame({ params: baseParams('human_human'), moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1 });
  const uiHh = deriveUi({ game: hh, engineState: 'IDLE', flags: { busy: true }, maxUndo: 0 });
  assert.equal(uiHh.actions.undo, false);
  // 刚落首手、game.state 未回（status 尚为 created）→ AI 思考期仍可悔棋
  const created = makeGame({ status: 'created', params: baseParams('human_ai', 'B'), moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1 });
  const uiCreated = deriveUi({ game: created, engineState: 'IDLE', flags: { busy: true }, maxUndo: 5 });
  assert.equal(uiCreated.actions.undo, true);
});

test('FE-GAME-05 | 人人对弈：引擎 DEAD 不阻断（可交互、无警示、无 AI 胶囊）', () => {
  const hh = makeGame({ params: baseParams('human_human'), nextColor: 'B' });
  const ui = deriveUi({ game: hh, engineState: 'DEAD', flags: {}, maxUndo: 3 });
  assert.equal(ui.humanAi, false);
  assert.equal(ui.interactive, true);
  assert.equal(ui.engineDead, false);
  assert.equal(ui.warn, false);
  assert.equal(ui.aiWait, null);
});

test('FE-GAME-06 | 人机引擎 DEAD/FATAL：棋盘灰化 + 警示条；人类回合仍可落子', () => {
  const humanTurn = makeGame({ params: baseParams('human_ai', 'B'), nextColor: 'B' });
  const ui = deriveUi({ game: humanTurn, engineState: 'DEAD', flags: {}, maxUndo: 5 });
  assert.equal(ui.warn, true);
  assert.equal(ui.engineDead, true);
  assert.equal(ui.interactive, true); // 人类仍可落（AI 恢复由 start 续行）
  assert.equal(ui.aiWait, null);
  const uiFatal = deriveUi({ game: humanTurn, engineState: 'FATAL', flags: {}, maxUndo: 5 });
  assert.equal(uiFatal.warn, true);
});

test('FE-GAME-07 | AI 先行（created/人类执白）：禁输入 + 胶囊 + autoStart（引擎非 DEAD/FATAL）', () => {
  const created = makeGame({ params: baseParams('human_ai', 'W'), status: 'created', nextColor: 'B' });
  const ui = deriveUi({ game: created, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(ui.interactive, false);
  assert.ok(ui.aiWait);
  assert.equal(ui.autoStart, true);
  // 引擎 INIT（按需加载）同样允许自动 start；DEAD 不触发
  const uiInit = deriveUi({ game: created, engineState: 'INIT', flags: {}, maxUndo: 5 });
  assert.equal(uiInit.autoStart, true);
  const uiStopped = deriveUi({ game: created, engineState: 'STOPPED', flags: {}, maxUndo: 5 });
  assert.equal(uiStopped.autoStart, true); // 未启动：按需加载拉起
  const uiDead = deriveUi({ game: created, engineState: 'DEAD', flags: {}, maxUndo: 5 });
  assert.equal(uiDead.autoStart, false);
});

test('FE-GAME-08 | 人机悔棋剩余与按钮态（上限 − undo_count；无手数禁悔棋）', () => {
  const noMove = makeGame({ params: baseParams('human_ai', 'B'), nextColor: 'B' });
  const ui = deriveUi({ game: noMove, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(ui.actions.undo, false); // 无子可悔
  const withMove = makeGame({
    params: baseParams('human_ai', 'B'), nextColor: 'W',
    moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1, undoCount: 3,
  });
  const ui2 = deriveUi({ game: withMove, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(ui2.undo.remaining, 2);
  assert.equal(ui2.undo.label, '悔棋（2）');
  assert.equal(ui2.actions.undo, true);
  const atCap = deriveUi({ game: { ...withMove, undoCount: 5 }, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(atCap.actions.undo, false);
  const atCapZero = deriveUi({ game: { ...withMove, undoCount: 5 }, engineState: 'IDLE', flags: {}, maxUndo: 0 });
  assert.equal(atCapZero.actions.undo, false); // 上限 0 = 禁悔棋
});

test('FE-GAME-08b | 人人对弈悔棋：不限制次数、无需剩余文案（T6.4 人工确认）', () => {
  const noMove = makeGame({ params: baseParams('human_human'), nextColor: 'B' });
  const ui0 = deriveUi({ game: noMove, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(ui0.humanAi, false);
  assert.equal(ui0.undo.label, '悔棋');
  assert.equal(ui0.actions.undo, false); // 无子可悔
  const withMove = makeGame({
    params: baseParams('human_human'), nextColor: 'W',
    moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1, undoCount: 9,
  });
  // undoCount 远超 maxUndo 仍可悔（人人无上限）
  const ui = deriveUi({ game: withMove, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(ui.undo.label, '悔棋');
  assert.equal(ui.actions.undo, true);
});

test('FE-GAME-08c | 人人等待确认中（undoWaiting）：锁定落子等操作但保留“取消悔棋申请”入口', () => {
  const withMove = makeGame({
    params: baseParams('human_human'), nextColor: 'W',
    moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1,
  });
  const ui = deriveUi({
    game: withMove, engineState: 'IDLE',
    flags: { undoWaiting: true }, maxUndo: 5,
  });
  assert.equal(ui.undoWaiting, true);
  assert.equal(ui.undo.label, '取消悔棋申请');
  assert.equal(ui.actions.undo, true); // 保留取消（=再次发送 undo 撤回）
  assert.equal(ui.actions.pass, false);
  assert.equal(ui.actions.resign, false);
  assert.equal(ui.actions.restart, false);
  assert.equal(ui.interactive, false);
});

test('FE-GAME-09 | 终局桥：scoring（可继续对弈）/ finished（结果文案）', () => {
  const scoring = makeGame({ params: baseParams('human_human'), status: 'scoring', moves: [mv(1, 'B', null, null, true), mv(2, 'W', null, null, true)], lastMoveNo: 2 });
  const uiS = deriveUi({ game: scoring, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(uiS.terminal.kind, 'scoring');
  assert.equal(uiS.terminal.canCancel, true);
  assert.equal(uiS.actions.pass, false);
  const finished = makeGame({ params: baseParams('human_human'), status: 'finished', result: 'B+2.5', lastMoveNo: 2 });
  const uiF = deriveUi({ game: finished, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(uiF.terminal.kind, 'finished');
  assert.equal(uiF.terminal.result, 'B+2.5');
  assert.equal(uiF.interactive, false);
});

test('FE-GAME-10 | deriveUi null game：安全空值（无 meta/无动作）', () => {
  const ui = deriveUi({ game: null, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(ui.status, null);
  assert.equal(ui.interactive, false);
  assert.equal(ui.aiWait, null);
  assert.equal(ui.terminal, null);
  assert.deepEqual(ui.meta, []);
  assert.equal(ui.actions.pass, false);
});

/* ============================================================
 * captureThemeKey（core/capture-counter.js 主题键）/ emptyCopy
 * ============================================================ */

test('FE-GAME-11 | captureThemeKey：提子组件主题键（dark → dark，其余 → light）', () => {
  assert.equal(captureThemeKey('dark'), 'dark');
  assert.equal(captureThemeKey('light'), 'light');
  assert.equal(captureThemeKey(''), 'light');
  assert.equal(captureThemeKey('system'), 'light'); // 系统跟随已解析为 light/dark，兜底浅色
  assert.equal(captureThemeKey(undefined), 'light');
});

test('FE-GAME-12 | emptyCopy 两类文案', () => {
  const none = emptyCopy('none');
  assert.match(none.title, /还没有进行中的对局/);
  const fail = emptyCopy('restore-fail');
  assert.match(fail.title, /不存在或已结束/);
});

test('FE-GAME-13 | 人机 AI 思考期：计数控件当前方=AI（next_color 未推进时的本地兜底）', () => {
  // 人类黑刚落子、AI 待行（busy 本地 pending）：store.next_color 仍为人类 B
  const pending = makeGame({
    params: baseParams('human_ai', 'B'), nextColor: 'B',
    moves: [mv(1, 'B', 3, 3), mv(2, 'W', 15, 15)], lastMoveNo: 2,
    captures: { black: 0, white: 0 },
  });
  const ui = deriveUi({ game: pending, engineState: 'IDLE', flags: { busy: true }, maxUndo: 5 });
  assert.ok(ui.aiWait, 'AI 思考胶囊可见');
  assert.equal(ui.captures.toMove, 'white'); // 大子=AI（修正：不再停留人类执色）
  assert.equal(ui.captures.black, 0);
  assert.equal(ui.captures.white, 0);
  // AI 落子回包后（busy 复位，next_color=人类 B）→ 当前方回到人类
  const settled = deriveUi({ game: pending, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(settled.aiWait, null);
  assert.equal(settled.captures.toMove, 'black');
  // 人类执白（AI 先行）同规则：AI 待行时当前方=黑（AI）
  const aiFirst = makeGame({
    params: baseParams('human_ai', 'W'), nextColor: 'W',
    moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1,
  });
  const ui2 = deriveUi({ game: aiFirst, engineState: 'IDLE', flags: { busy: true }, maxUndo: 5 });
  assert.equal(ui2.captures.toMove, 'black');
  // **defer 窗口 + busy 兜底失效**（BUG-094）：人类刚落子（lastMoveNo 已推进）而 store 的
  // nextColor 仍是人类（`move.applied` 不更新），20s busy 兜底清锁后不得翻回人类
  const staleWindow = makeGame({
    params: baseParams('human_ai', 'B'), nextColor: 'B',
    moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1,
  });
  const uiStale = deriveUi({ game: staleWindow, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.ok(uiStale.aiWait, 'AI 待行胶囊保持可见（旧实现兜底后消失）');
  assert.equal(uiStale.captures.toMove, 'white', '计数器当前方保持 AI（旧实现翻回人类）');
  assert.equal(uiStale.interactive, false, '棋盘保持禁输入（旧实现误可点 → 被服务端拒）');
  // 对照：AI 已落子（快照与推导一致=人类回合）→ 当前方回到人类
  const settled2 = deriveUi({
    game: makeGame({
      params: baseParams('human_ai', 'B'), nextColor: 'B',
      moves: [mv(1, 'B', 3, 3), mv(2, 'W', 15, 15)], lastMoveNo: 2,
    }),
    engineState: 'IDLE', flags: {}, maxUndo: 5,
  });
  assert.equal(settled2.aiWait, null);
  assert.equal(settled2.captures.toMove, 'black');
});

test('FE-GAME-14 | B2 人类模型不可用：人类风格/自适应 AI 阻断提示（胶囊/警示条/不自动续行）', () => {
  // 人类风格 L3 + 人类模型缺失（engine.humanModelAvailable=false）
  const humanStyle = makeGame({
    params: { ...baseParams('human_ai', 'B'), aiStyle: 'human' },
    nextColor: 'W', // AI 白待行
    moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1,
  });
  const ui = deriveUi({
    game: humanStyle, engineState: 'IDLE', flags: {}, maxUndo: 5, humanModelAvailable: false,
  });
  assert.equal(ui.humanModelBlocked, true);
  assert.equal(ui.warn, true); // 警示条（引擎本身 IDLE，非 DEAD/FATAL）
  assert.ok(ui.aiWait, 'AI 胶囊可见（文案提示人类模型不可用）');
  assert.equal(ui.aiWait.label, '人类模型不可用');
  assert.equal(ui.autoStart, false); // 不发无意义 start（恢复人类模型后引擎态变更再续行）
  // 自适应同属人类模型依赖
  const adaptive = makeGame({
    params: { ...baseParams('human_ai', 'B'), aiStyle: 'human', adaptiveEnabled: true },
    nextColor: 'W', moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1,
  });
  assert.equal(
    deriveUi({ game: adaptive, engineState: 'IDLE', flags: {}, humanModelAvailable: false }).humanModelBlocked,
    true,
  );
  // 标准风格不阻断（仅人类风格/自适应依赖人类模型）
  const standard = makeGame({
    params: baseParams('human_ai', 'B'), nextColor: 'W', moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1,
  });
  const uiStd = deriveUi({
    game: standard, engineState: 'IDLE', flags: {}, maxUndo: 5, humanModelAvailable: false,
  });
  assert.equal(uiStd.humanModelBlocked, false);
  assert.equal(uiStd.warn, false);
  assert.equal(uiStd.aiWait.label, '思考中');
  // 可用性未知（未收到 engine.status）→ 不阻断（服务端仍为最终事实源）
  const uiUnknown = deriveUi({ game: humanStyle, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.equal(uiUnknown.humanModelBlocked, false);
  assert.equal(uiUnknown.warn, false);
  // 人人对弈不显示
  const hh = makeGame({ params: { mode: 'human_human', humanColor: null, aiStyle: null } });
  assert.equal(
    deriveUi({ game: hh, engineState: 'IDLE', flags: {}, humanModelAvailable: false }).humanModelBlocked,
    false,
  );
});

/* ============================================================
 * 终态关闭（对局不存在/已删除，BUG-092）
 * ============================================================ */

test('FE-GAME-21 | goneCloseAction：终态关闭（4404）立即判恢复失败，其它关闭/其它通道不受影响', () => {
  // 终态关闭（ws-client 标记 terminal）→ 立即 fail-restore（不再等 8s REST 探测）
  assert.equal(
    goneCloseAction({ type: 'closed', channel: 'game', terminal: true, code: 4404 }, 'restoring'),
    'fail-restore',
  );
  // 游戏中局（对局被删除后重连发现）同样收敛到空态
  assert.equal(
    goneCloseAction({ type: 'closed', channel: 'game', terminal: true, code: 4404 }, 'game'),
    'fail-restore',
  );
  // 已空态：不重复处理（不重复弹提示）
  assert.equal(goneCloseAction({ type: 'closed', channel: 'game', terminal: true }, 'empty'), 'none');
  // 普通断线（无 terminal）/主动关闭 / admin 通道 / 其它事件类型 → 不动作
  assert.equal(goneCloseAction({ type: 'closed', channel: 'game', manual: false }, 'restoring'), 'none');
  assert.equal(goneCloseAction({ type: 'closed', channel: 'game', manual: true, code: 1000 }, 'game'), 'none');
  assert.equal(goneCloseAction({ type: 'closed', channel: 'admin', terminal: true }, 'game'), 'none');
  assert.equal(goneCloseAction({ type: 'open', channel: 'game' }, 'game'), 'none');
  assert.equal(goneCloseAction(null, 'game'), 'none');
});

/* ============================================================
 * 自动 start 单回合单发（BUG-093）
 * ============================================================ */

test('FE-GAME-22 | autoStartAction：同一回合只发一次 start（瞬态锁/末手数窗口不得重发，BUG-093）', () => {
  const g = (o = {}) => ({
    gameId: 7, lastMoveNo: 0, nextColor: 'B', status: 'created',
    params: { mode: 'human_ai', humanColor: 'W' }, ...o,
  });
  // 首帧：AI 待行 + ready → send（key＝“轮到谁”：gameId:nextColor）
  assert.deepEqual(
    autoStartAction({ game: g(), targetId: 7, busy: false, startKey: null, ready: true }),
    { action: 'send', key: '7:B' },
  );
  // 同回合抖动：created→active / 引擎态变化不参与令牌 → skip（旧实现令牌含 status+engineState → 重复 start
  // → 迟到者落 AI 已落子之后被 ILLEGAL_ACTION 拒绝 → 误弹「当前状态不允许该操作」）
  assert.deepEqual(
    autoStartAction({ game: g({ status: 'active' }), targetId: 7, busy: false, startKey: '7:B', ready: true }),
    { action: 'skip', key: '7:B' },
  );
  // **末手数窗口**（#183 实测复现点）：`move.applied` 先推进 lastMoveNo 而 nextColor 未更新
  // （AI 已落子、客户端尚未收到 game.state）→ 不得误判为新回合重发
  assert.deepEqual(
    autoStartAction({ game: g({ lastMoveNo: 1, status: 'active' }), targetId: 7, busy: false, startKey: '7:B', ready: true }),
    { action: 'skip', key: '7:B' },
  );
  // 瞬态锁（busy 在途 / 引擎不可用 / ready=false）→ **skip 且保留标记**——旧实现在 busy 下
  // `autoStart=false` → 清标记 → 解锁后再发一次（重复 start 的直接推手）
  assert.deepEqual(
    autoStartAction({ game: g(), targetId: 7, busy: true, startKey: '7:B', ready: false }),
    { action: 'skip', key: '7:B' },
  );
  assert.deepEqual(
    autoStartAction({ game: g(), targetId: 7, busy: false, startKey: '7:B', ready: false }),
    { action: 'skip', key: '7:B' },
  );
  assert.deepEqual(
    autoStartAction({ game: g(), targetId: 7, busy: true, startKey: null, ready: false }),
    { action: 'skip', key: null },
  );
  // 未连接目标 / 陈旧切片（store 仍是上一局）→ skip（不得对新局发 start）
  assert.deepEqual(
    autoStartAction({ game: g(), targetId: null, busy: false, startKey: null, ready: true }),
    { action: 'skip', key: null },
  );
  assert.deepEqual(
    autoStartAction({ game: g({ gameId: 6 }), targetId: 7, busy: false, startKey: null, ready: true }),
    { action: 'skip', key: null },
  );
  // 回合离开 AI（AI 已落子，game.state 将 nextColor 推进为人类）/ 非人机 / 终局 → reset（清标记）
  assert.deepEqual(
    autoStartAction({ game: g({ lastMoveNo: 1, nextColor: 'W', status: 'active' }), targetId: 7, busy: false, startKey: '7:B', ready: false }),
    { action: 'reset', key: null },
  );
  assert.deepEqual(
    autoStartAction({ game: g({ params: { mode: 'human_human' } }), targetId: 7, busy: false, startKey: '7:B', ready: true }),
    { action: 'reset', key: null },
  );
  assert.deepEqual(
    autoStartAction({ game: g({ status: 'finished' }), targetId: 7, busy: false, startKey: '7:B', ready: true }),
    { action: 'reset', key: null },
  );
  // 新回合（人类落子后电脑再次待行；标记已由离开 AI 的帧复位）→ send
  assert.deepEqual(
    autoStartAction({ game: g({ lastMoveNo: 2, nextColor: 'B', status: 'active' }), targetId: 7, busy: false, startKey: null, ready: true }),
    { action: 'send', key: '7:B' },
  );
  // 缺省入参安全（无对局 → reset）
  assert.deepEqual(autoStartAction({}), { action: 'reset', key: null });
  assert.deepEqual(autoStartAction(), { action: 'reset', key: null });
});

test('FE-GAME-23 | AI 应手失败（ai_pending）：胶囊文案与原因透传（R2）', () => {
  const pending = makeGame({
    params: baseParams('human_ai', 'B'),
    nextColor: 'W', moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1,
    aiPending: { code: 'ENGINE_BUSY', message: 'AI 落子引擎查询失败: 查询超时' },
  });
  const ui = deriveUi({ game: pending, engineState: 'IDLE', flags: {}, maxUndo: 5 });
  assert.ok(ui.aiWait);
  assert.equal(ui.aiWait.label, 'AI 应手失败');
  assert.equal(ui.aiWait.code, 'ENGINE_BUSY');
  assert.match(ui.aiWait.title, /引擎查询失败/);
  // 无挂起原因 → 常规「思考中」，原因字段为空
  const plain = deriveUi({
    game: makeGame({ params: baseParams('human_ai', 'B'), nextColor: 'W', moves: [mv(1, 'B', 3, 3)], lastMoveNo: 1 }),
    engineState: 'IDLE', flags: {}, maxUndo: 5,
  });
  assert.equal(plain.aiWait.label, '思考中');
  assert.equal(plain.aiWait.code, null);
  assert.equal(plain.aiWait.title, '');
});

test('FE-GAME-24 | undoDeclinedOutcome：拒绝/撤回不误报、执行失败双方均收敛（R3）', () => {
  assert.deepEqual(undoDeclinedOutcome({ reason: 'declined' }, true), {
    clearWaiting: true,
    toast: { level: 'info', text: '对方拒绝了悔棋申请', key: 'undo-declined' },
  });
  assert.deepEqual(undoDeclinedOutcome({ reason: 'withdrawn' }, true), {
    clearWaiting: true,
    toast: { level: 'info', text: '已取消悔棋申请', key: 'undo-withdrawn' },
  });
  // 对端（未等待）：仅关弹窗，不提示
  assert.deepEqual(undoDeclinedOutcome({ reason: 'declined' }, false), {
    clearWaiting: false, toast: null,
  });
  // 执行失败（R3）：申请已清除且无其它终态事件 → 双方都须收敛并得到解释
  const failed = undoDeclinedOutcome(
    { reason: 'failed', message: '当前状态(CREATED)不允许 悔棋' },
    false,
  );
  assert.equal(failed.clearWaiting, true);
  assert.equal(failed.toast.level, 'error');
  assert.match(failed.toast.text, /悔棋未完成/);
  assert.match(failed.toast.text, /不允许 悔棋/);
  assert.equal(failed.toast.key, 'undo-failed');
  // 缺 message → 兜底文案；未知 reason → 按撤回处理（向后兼容）
  assert.match(undoDeclinedOutcome({ reason: 'failed' }).toast.text, /局面已变化/);
  assert.deepEqual(undoDeclinedOutcome({ reason: 'weird' }, true).toast.key, 'undo-withdrawn');
});

test('FE-GAME-25 | resignConfirmText：人机=人类方认输；人人=按当前回合判定（O4）', () => {
  assert.equal(
    resignConfirmText(makeGame({ params: baseParams('human_ai', 'B') })),
    '确认认输？本手后对局立即结束。',
  );
  assert.match(
    resignConfirmText(makeGame({ params: baseParams('human_human') })),
    /认输方按当前回合判定/,
  );
});

/* ============================================================
 * 人人对弈落子零闪烁（2026/09/18 人工反馈）
 * ============================================================ */

test('FE-GAME-26 | moveAppliedUnlocksBusy：人人对弈提交回执即解锁 busy；人机不得解锁（AI 应手仍在进行，BUG-094）', () => {
  // 人人：无 AI 应手等待——move.applied（提交回调即时广播）即本轮提交窗口结束 →
  // 同帧解锁，避免紧随的 syncAll 以「等待中」渲染禁用按钮、game.state 再解禁的闪烁
  assert.equal(moveAppliedUnlocksBusy(makeGame({ params: baseParams('human_human') })), true);
  // 人机（标准/自适应/人类）：AI 应手可能仍在进行——不得在 move.applied 解锁
  assert.equal(moveAppliedUnlocksBusy(makeGame({ params: baseParams('human_ai', 'B') })), false);
  assert.equal(moveAppliedUnlocksBusy(makeGame({ params: baseParams('human_ai', 'W') })), false);
  assert.equal(
    moveAppliedUnlocksBusy(makeGame({
      params: { ...baseParams('human_ai', 'B'), aiStyle: 'human', adaptiveEnabled: true },
    })),
    false,
  );
  // 缺省/空切片安全：不得解锁
  assert.equal(moveAppliedUnlocksBusy(null), false);
  assert.equal(moveAppliedUnlocksBusy(undefined), false);
});
