/**
 * tGo · game-sidebar.js 对弈侧栏纯函数层无头单测（T6.5，node --test）
 * 用例 ID: FE-SB-*
 * 覆盖（TASK.md T6.5 验收·纯逻辑）：curPoint 局面点查找；C5 信息卡派生；
 * C6 曲线卡三态/降级派生；C16 胜率条派生；coach 门控（引擎/回合/终局/pending）；
 * 支招卡派生（loading/ready delta/空态/stale 过期）；领地门控；行/卡 HTML 片段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  curPoint,
  deriveInfoCard,
  deriveCurveCard,
  deriveWinrateCard,
  wrBarAction,
  deriveCoachCard,
  coachDisabledReason,
  territoryReason,
  analysisButtons,
  coachRowHTML,
  coachPreviewPoints,
  signedLead,
  playersLineHTML,
  infoCardHTML,
  infoCardBodyHTML,
} from '../static/js/views/game-sidebar.js';

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
    players: { black: { name: '张三', rank: 'rank_1d' }, white: { name: 'AI', rank: null } },
    nextColor: 'B',
    moves: [],
    lastMoveNo: 0,
    result: null,
    ...overrides,
  };
  if (overrides.params) g.params = { ...makeGame().params, ...overrides.params };
  if (overrides.players) g.players = { ...makeGame().players, ...overrides.players };
  return g;
}

const baseParams = (mode = 'human_ai', humanColor = 'B') => ({
  mode, boardSize: 19, rules: 'chinese', komi: 7.5, handicap: 0,
  humanColor: mode === 'human_ai' ? humanColor : null, aiStyle: 'standard',
  aiLevel: 5, adaptiveEnabled: false,
});

const pt = (moveNo, winrate, scoreLead = null) => ({ moveNo, winrate, scoreLead });
const moveRow = (moveNo, color, x, y) => ({ moveNo, color, x, y, isPass: false });

/* ============================================================
 * curPoint
 * ============================================================ */

test('FE-SB-01 | curPoint：取 ≤moveNo 最新点；超界忽略；无点 null', () => {
  const pts = [pt(1, 50), pt(3, 60), pt(5, null)];
  assert.equal(curPoint(pts, 0), null);
  assert.deepEqual(curPoint(pts, 2), { moveNo: 1, winrate: 50, scoreLead: null });
  assert.equal(curPoint(pts, 3).moveNo, 3);
  assert.equal(curPoint([], 5), null);
  // 分析滞后：局面在第 6 手，曲线仅到第 5 手
  assert.equal(curPoint(pts, 6).moveNo, 5);
});

/* ============================================================
 * deriveInfoCard（C5）
 * ============================================================ */

test('FE-SB-02 | C5 信息卡：玩家行段位归一 + 当前胜率/目差 + degraded', () => {
  const game = makeGame({ lastMoveNo: 4 });
  const info = deriveInfoCard(game, {
    points: [pt(4, 54.2, 3.1), pt(2, 60, 5)],
    degraded: false,
  });
  assert.equal(info.moveNo, 4);
  assert.equal(info.winrate, 54.2);
  assert.equal(info.scoreLead, 3.1);
  assert.equal(info.pointMoveNo, 4);
  assert.equal(info.degraded, false);
  assert.deepEqual(info.players.black, { name: '张三', rank: '1D', tag: '' });
  assert.deepEqual(info.players.white, { name: 'AI', rank: '', tag: '' });
});

test('FE-SB-03 | C5 无分析点 / 引擎降级：null 值 + degraded 置位', () => {
  const game = makeGame({ lastMoveNo: 10, moves: [moveRow(1, 'B', 3, 3)] });
  const info = deriveInfoCard(game, { points: [], degraded: true });
  assert.equal(info.winrate, null);
  assert.equal(info.scoreLead, null);
  assert.equal(info.pointMoveNo, null);
  assert.equal(info.degraded, true);
});

/* ============================================================
 * deriveCurveCard（C6）
 * ============================================================ */

test('FE-SB-04 | C6 曲线三态：有数据 ready / 分析中 loading / 空盘 empty', () => {
  const g1 = makeGame({ lastMoveNo: 4, moves: [moveRow(1, 'B', 3, 3)] });
  const ready = deriveCurveCard(g1, { points: [pt(4, 54.2, 3.1)], disabled: false });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.total, 4);
  assert.equal(ready.current, 4);

  const loading = deriveCurveCard(g1, { points: [], disabled: false });
  assert.equal(loading.state, 'loading');

  const empty = deriveCurveCard(makeGame({ lastMoveNo: 0 }), { points: [], disabled: false });
  assert.equal(empty.state, 'empty');
});

test('FE-SB-05 | C6 引擎降级：保留历史曲线 disabled；无历史则提示态', () => {
  const g = makeGame({ lastMoveNo: 6, moves: [moveRow(1, 'B', 3, 3)] });
  const withPts = deriveCurveCard(g, { points: [pt(6, 60, 4)], disabled: true });
  assert.equal(withPts.state, 'disabled');
  assert.equal(withPts.pts.length, 1);

  const noPts = deriveCurveCard(g, { points: [], disabled: true });
  assert.equal(noPts.state, 'disabled');
  assert.equal(noPts.pts.length, 0);
});

/* ============================================================
 * deriveWinrateCard（C16）
 * ============================================================ */

test('FE-SB-06 | C16 胜率条：黑率整数/白=100−黑/摆幅 delta/单点无 delta', () => {
  const game = makeGame({ lastMoveNo: 5 });
  const wr = deriveWinrateCard(game, { points: [pt(4, 48.2), pt(5, 43.4)], disabled: false });
  assert.equal(wr.hasRate, true);
  assert.equal(wr.black, 43);
  assert.equal(wr.white, 57);
  assert.equal(wr.delta, -5); // 43 − 48
  assert.equal(wr.disabled, false);

  const single = deriveWinrateCard(game, { points: [pt(5, 43.4)], disabled: false });
  assert.equal(single.hasRate, true);
  assert.equal(single.black, 43);
  assert.equal(single.delta, null);
});

test('FE-SB-07 | C16 无数据/降级：hasRate=false；disabled 透传', () => {
  const game = makeGame({ lastMoveNo: 2 });
  const none = deriveWinrateCard(game, { points: [], disabled: false });
  assert.equal(none.hasRate, false);
  assert.equal(none.black, null);
  const down = deriveWinrateCard(game, { points: [pt(2, 50)], disabled: true });
  assert.equal(down.disabled, true);
  assert.equal(down.black, 50);
});

/* ============================================================
 * coach 门控 / analysisButtons
 * ============================================================ */

test('FE-SB-08 | coachDisabledReason：引擎 STOPPED/INIT/DEAD/FATAL 与终局禁用', () => {
  const g = makeGame({ lastMoveNo: 2, moves: [moveRow(1, 'B', 3, 3)] });
  assert.equal(coachDisabledReason({ game: g, engineState: 'STOPPED' }), '引擎未启动');
  assert.equal(coachDisabledReason({ game: g, engineState: 'INIT' }), '引擎调优中（首次调优后可用）');
  assert.equal(coachDisabledReason({ game: g, engineState: 'DEAD' }), '引擎不可用');
  assert.equal(coachDisabledReason({ game: g, engineState: 'FATAL' }), '引擎不可用');
  assert.equal(coachDisabledReason({ game: g, engineState: 'ANALYZING' }), null);
  assert.equal(coachDisabledReason({ game: makeGame({ status: 'scoring' }), engineState: 'IDLE' }), '对局已进入结算');
  assert.equal(coachDisabledReason({ game: makeGame({ status: 'finished' }), engineState: 'IDLE' }), '对局已结束');
});

test('FE-SB-09 | coachDisabledReason：回合/等待门控（人机 AI 回合禁、人人恒可）', () => {
  // 人机：轮到 AI（lastMoveNo=1 → W）
  const aiTurn = makeGame({ nextColor: 'W', lastMoveNo: 1, moves: [moveRow(1, 'B', 3, 3)] });
  assert.equal(coachDisabledReason({ game: aiTurn, engineState: 'IDLE' }), '轮到 AI 落子，支招不可用');
  // 陈旧快照（move.applied 已推进手数，next_color 未更新）→ 仍按真实回合禁（BUG-094）
  const staleTurn = makeGame({ nextColor: 'B', lastMoveNo: 1, moves: [moveRow(1, 'B', 3, 3)] });
  assert.equal(coachDisabledReason({ game: staleTurn, engineState: 'IDLE' }), '轮到 AI 落子，支招不可用');
  // 人机：轮到人类（lastMoveNo=2 → B）
  const humanTurn = makeGame({ nextColor: 'B', lastMoveNo: 2, moves: [moveRow(1, 'B', 3, 3)] });
  assert.equal(coachDisabledReason({ game: humanTurn, engineState: 'IDLE' }), null);
  // 人人（执白也可是任一人类方）：任意回合可用
  const hh = makeGame({ params: baseParams('human_human'), nextColor: 'W', lastMoveNo: 1, moves: [moveRow(1, 'B', 3, 3)] });
  assert.equal(coachDisabledReason({ game: hh, engineState: 'IDLE' }), null);
  assert.equal(coachDisabledReason({ game: humanTurn, engineState: 'IDLE', pending: true }), '等待对局响应中…');
});

test('FE-SB-10 | analysisButtons：reason ↔ enabled/loading 映射', () => {
  const g = makeGame({ nextColor: 'B' });
  const ok = analysisButtons({ game: g, engineState: 'IDLE' });
  assert.deepEqual(ok.coach, { enabled: true, reason: null, loading: false, lit: false });
  assert.deepEqual(ok.territory, { enabled: true, reason: null });
  const down = analysisButtons({ game: g, engineState: 'DEAD' });
  assert.equal(down.coach.enabled, false);
  assert.equal(down.coach.reason, '引擎不可用');
  assert.equal(down.territory.enabled, false);
});

/* ============================================================
 * deriveCoachCard（C7）
 * ============================================================ */

test('FE-SB-11 | C7 loading / empty：请求中 loading；未请求空态', () => {
  const game = makeGame({ nextColor: 'B', lastMoveNo: 2, moves: [moveRow(1, 'B', 3, 3)] });
  const loading = deriveCoachCard(game, {
    points: [pt(3, 54, 2)],
    engineState: 'IDLE',
    coaching: { loading: true, topMoves: [], atMoveNo: 3 },
  });
  assert.equal(loading.loading, true);
  assert.equal(loading.empty, false);

  const idle = deriveCoachCard(game, {
    points: [],
    engineState: 'IDLE',
    coaching: { loading: false, topMoves: [], atMoveNo: null },
  });
  assert.equal(idle.empty, true);
  assert.equal(idle.entries.length, 0);
});

test('FE-SB-12 | C7 ready：delta vs 当前局面 base；无 base 回退绝对值', () => {
  const game = makeGame({ nextColor: 'B', lastMoveNo: 4, moves: [moveRow(1, 'B', 3, 3)] });
  const moves = [
    { x: 3, y: 3, winrate: 58.4, score_lead: 3.1, visits: 512, pv: ['D4', 'Q6'] },
    { x: 15, y: 15, winrate: 56.8, score_lead: 2.4, visits: 388, pv: [] },
  ];
  const coach = deriveCoachCard(game, {
    points: [pt(4, 54.2, 0)],
    engineState: 'IDLE',
    coaching: { loading: false, topMoves: moves, atMoveNo: 4 },
  });
  assert.equal(coach.stale, false);
  assert.equal(coach.entries.length, 2);
  assert.equal(coach.baseWinrate, 54.2);
  const e0 = coach.entries[0];
  assert.equal(e0.rank, 1);
  assert.equal(e0.coord, 'D16'); // x=3,y=3 → GTP（底行=3 → 数字，列 D）
  assert.equal(e0.deltaWinrate, 4.2); // 58.4 − 54.2
  assert.equal(e0.deltaScore, 3.1);
  assert.equal(e0.visits, 512);

  // 无 base（未回填分析）→ delta null，保留绝对值
  const noBase = deriveCoachCard(game, {
    points: [],
    engineState: 'IDLE',
    coaching: { loading: false, topMoves: moves, atMoveNo: 4 },
  });
  assert.equal(noBase.entries[0].deltaWinrate, null);
  assert.equal(noBase.entries[0].winrate, 58.4);
});

test('FE-SB-13 | C7 stale：结果针对旧手数（atMoveNo ≠ lastMoveNo）不展示', () => {
  const game = makeGame({ nextColor: 'B', lastMoveNo: 4, moves: [moveRow(1, 'B', 3, 3)] });
  const moves = [{ x: 9, y: 9, winrate: 60, score_lead: 2, visits: 400, pv: [] }];
  const coach = deriveCoachCard(game, {
    points: [pt(4, 60, 2)],
    engineState: 'IDLE',
    coaching: { loading: false, topMoves: moves, atMoveNo: 3 }, // 旧手 3 的结果
  });
  assert.equal(coach.stale, true);
  assert.equal(coach.entries.length, 0);
  assert.equal(coach.empty, false);
});

test('FE-SB-14 | C7 视角跟随当前执色方：载荷 side/base 直用（白方视角标注）', () => {
  // 人机对弈但轮到 AI（白）→ 支招禁用；改用人人对弈（任一回合均可支招）
  const game = makeGame({
    nextColor: 'W', lastMoveNo: 4, moves: [moveRow(1, 'B', 3, 3)], params: baseParams('human_human'),
  });
  const moves = [
    { x: 3, y: 3, winrate: 45.0, score_lead: 2.0, visits: 512, pv: [] },
    { x: 15, y: 15, winrate: 40.5, score_lead: 1.0, visits: 388, pv: [] },
  ];
  const coach = deriveCoachCard(game, {
    // 曲线为黑方视角（60 → 白方视角 40），载荷自带 base_winrate 优先
    points: [pt(4, 60, 2.0)],
    engineState: 'IDLE',
    coaching: { loading: false, topMoves: moves, atMoveNo: 4, side: 'W', baseWinrate: 41.5 },
  });
  assert.equal(coach.disabled, false);
  assert.equal(coach.side, 'W');
  assert.equal(coach.baseWinrate, 41.5);
  assert.equal(coach.entries[0].deltaWinrate, 3.5); // 45.0 − 41.5
  assert.equal(coach.entries[1].deltaWinrate, -1.0);
});

test('FE-SB-15 | C7 无载荷 base 时按 side 从曲线（黑方视角）换算基准', () => {
  const game = makeGame({
    nextColor: 'W', lastMoveNo: 4, moves: [moveRow(1, 'B', 3, 3)], params: baseParams('human_human'),
  });
  const moves = [{ x: 3, y: 3, winrate: 45.0, score_lead: 2.0, visits: 512, pv: [] }];
  const coach = deriveCoachCard(game, {
    points: [pt(4, 60, -2.0)], // 黑方视角 60/−2 → 白方 40/+2
    engineState: 'IDLE',
    coaching: { loading: false, topMoves: moves, atMoveNo: 4, side: 'W' },
  });
  assert.equal(coach.baseWinrate, 40);
  assert.equal(coach.entries[0].deltaWinrate, 5); // 45.0 − 40
  assert.equal(coach.entries[0].deltaScore, 0); // 白方视角基准 +2.0 → 2.0 − 2.0
});

test('FE-SB-16 | C7 引擎降级：disabled + reason（不渲染列表）', () => {
  const game = makeGame({ nextColor: 'B', lastMoveNo: 1, moves: [moveRow(1, 'B', 3, 3)] });
  const coach = deriveCoachCard(game, {
    points: [],
    engineState: 'DEAD',
    coaching: { loading: false, topMoves: [], atMoveNo: 1 },
  });
  assert.equal(coach.disabled, true);
  assert.equal(coach.reason, '引擎不可用');
  assert.equal(coach.entries.length, 0);
});

/* ============================================================
 * territoryReason / 文案 / HTML 片段
 * ============================================================ */

test('FE-SB-17 | territoryReason：引擎与终局门控', () => {
  const g = makeGame({ lastMoveNo: 0 });
  assert.equal(territoryReason({ game: g, engineState: 'IDLE' }), null);
  assert.equal(territoryReason({ game: g, engineState: 'STOPPED' }), '引擎未启动');
  assert.equal(territoryReason({ game: g, engineState: 'INIT' }), '引擎调优中');
  assert.equal(territoryReason({ game: g, engineState: 'DEAD' }), '引擎不可用');
  assert.equal(territoryReason({ game: makeGame({ status: 'finished' }), engineState: 'IDLE' }), '对局已结束');
});

test('FE-SB-18 | signedLead / coachRowHTML / playersLineHTML 格式', () => {
  assert.equal(signedLead(3.1), '+3.1');
  assert.equal(signedLead(-0.4), '−0.4');
  assert.equal(signedLead(3.0), '+3');
  assert.equal(signedLead(null), '');

  const html = coachRowHTML({
    rank: 1, coord: 'D16', deltaWinrate: 4.2, deltaScore: 3.1, winrate: 58.4,
    scoreLead: 3.1, visits: 512,
  });
  assert.match(html, /rank-badge rank-1/);
  // 2026/09/06 修订：胜率/目差标签与数值拆分（ck=标签、cv=数值），跨行纵向对齐
  assert.match(html, /<span class="ck">胜率<\/span><span class="cv">\+4\.2%<\/span>/);
  assert.match(html, /<span class="ck">目差<\/span><span class="cv">\+3\.1<\/span>/);
  assert.match(html, />512 Visit</);
  assert.match(html, /data-i="0"/);
  assert.match(html, /aria-label="第 1 推荐：D16，胜率\+4\.2%，目差\+3\.1，512 Visit"/);

  const pl = playersLineHTML({ black: { name: '张三', rank: '1D' }, white: { name: 'AI', rank: '' } });
  assert.match(pl, /黑 张三<span class="rank-sup">1D<\/span>/);
  assert.match(pl, /白 AI/);
  assert.doesNotMatch(pl, /白 AI<span class="rank-sup">/);
});

test('FE-SB-19 | wrBarAction 胜率条保留式渲染（2026/09/13 防闪烁）', () => {
  // 有数据 → 正常渲染
  assert.equal(wrBarAction({ hasRate: true, shown: false, pending: false }), 'render');
  assert.equal(wrBarAction({ hasRate: true, shown: true, pending: true }), 'render');
  // 在途（当前手分析未回）且已渲染过 → 保留上一次（不闪回空态）
  assert.equal(wrBarAction({ hasRate: false, shown: true, pending: true }), 'keep');
  // 新局/重开（从未有数据，或局面已清空）→ 稳定高度空态
  assert.equal(wrBarAction({ hasRate: false, shown: true, pending: false }), 'empty');
  assert.equal(wrBarAction({ hasRate: false, shown: false, pending: true }), 'empty');
  assert.equal(wrBarAction(), 'empty');
});

test('FE-SB-20 | analysisButtons 支招进行态：请求中 loading；降级/禁用不呼吸（2026/09/13）', () => {
  const g = makeGame({ nextColor: 'B', lastMoveNo: 2, moves: [moveRow(1, 'B', 3, 3)] });
  // 请求进行中（引擎正常）→ loading=true（[支招] 仅呼吸；文案/禁点不改变，2026/09/14）
  const loading = analysisButtons({ game: g, engineState: 'IDLE', coaching: { loading: true } });
  assert.equal(loading.coach.loading, true);
  assert.equal(loading.coach.enabled, true);
  // 引擎降级（请求中途不可用）→ 按降级展示、不呼吸（与 C7 卡 loading 忽略 disabled 口径一致）
  const dead = analysisButtons({ game: g, engineState: 'DEAD', coaching: { loading: true } });
  assert.equal(dead.coach.loading, false);
  assert.equal(dead.coach.reason, '引擎不可用');
  // 人机 AI 回合（禁用）+ loading 残留 → 不呼吸
  const aiTurn = analysisButtons({
    game: makeGame({ nextColor: 'W', lastMoveNo: 1, moves: [moveRow(1, 'B', 3, 3)] }),
    engineState: 'IDLE',
    coaching: { loading: true },
  });
  assert.equal(aiTurn.coach.loading, false);
  // 无请求 / 无载荷 → false
  assert.equal(analysisButtons({ game: g, engineState: 'IDLE' }).coach.loading, false);
  assert.equal(analysisButtons({ game: g, engineState: 'IDLE', coaching: null }).coach.loading, false);
});

test('FE-SB-22 | analysisButtons [支招] 图标点亮：TOP5 到达且对应当前局面才亮（2026/09/17）', () => {
  // 口径：点亮 = 有 TOP5 数据 + atMoveNo === 当前手数（与 C7 卡 stale 同源 coachTop5Freshness）
  const g = makeGame({ nextColor: 'B', lastMoveNo: 2, moves: [moveRow(1, 'B', 3, 3), moveRow(2, 'W', 15, 15)] });
  const fresh = analysisButtons({
    game: g,
    engineState: 'IDLE',
    coaching: { loading: false, atMoveNo: 2, topMoves: [{ x: 3, y: 15 }] },
  });
  assert.equal(fresh.coach.lit, true);
  // 局面推进（结果过期）→ 熄灭
  const stale = analysisButtons({
    game: makeGame({ nextColor: 'W', lastMoveNo: 3, moves: [moveRow(1, 'B', 3, 3)] }),
    engineState: 'IDLE',
    coaching: { loading: false, atMoveNo: 2, topMoves: [{ x: 3, y: 15 }] },
  });
  assert.equal(stale.coach.lit, false);
  // 重新请求（coaching.pending 清空 topMoves）→ 熄灭
  const requesting = analysisButtons({ game: g, engineState: 'IDLE', coaching: { loading: true, atMoveNo: 2, topMoves: [] } });
  assert.equal(requesting.coach.lit, false);
  // 降级（引擎不可用）→ 不点亮
  const down = analysisButtons({
    game: g,
    engineState: 'DEAD',
    coaching: { loading: false, atMoveNo: 2, topMoves: [{ x: 3, y: 15 }] },
  });
  assert.equal(down.coach.lit, false);
  // 无数据 → 不点亮
  assert.equal(analysisButtons({ game: g, engineState: 'IDLE', coaching: null }).coach.lit, false);
});

test('FE-SB-21 | infoCardHTML/infoCardBodyHTML：刷新 body 不含 .card 层（防嵌套卡，2026/09/14）', () => {
  // 根因（BUG-074）：刷新把整卡 HTML setHtml 到既有 .card 元素内 → “毛玻璃层中的卡片层”
  // （双 padding/边框/backdrop-filter）；口径同复盘页 reviewInfoBodyHTML：卡刷新仅 body。
  const info = deriveInfoCard(makeGame(), { points: [pt(0, 0.55, 1.5)], degraded: false });
  const body = infoCardBodyHTML(info);
  assert.doesNotMatch(body, /class="card"/, 'body 不得含 .card 层');
  assert.match(body, /对局信息/);
  assert.match(body, /当前胜率（黑）/);
  // 完整卡（仅初始模板用）：恰好一层 .card
  const full = infoCardHTML(info);
  assert.equal((full.match(/class="card"/g) || []).length, 1);
  // 降级态 body 仍无 .card，且带提示行
  const degradedBody = infoCardBodyHTML(deriveInfoCard(makeGame(), { points: [], degraded: true }));
  assert.doesNotMatch(degradedBody, /class="card"/);
  assert.match(degradedBody, /引擎不可用/);
});

/* ============================================================
 * coachPreviewPoints（对弈页变化图预览，2026/09/18）
 * ============================================================ */

test('FE-SB-23 | coachPreviewPoints：GTP 串 → 坐标点列（PASS 剔除、超步截断）', () => {
  // 19 路：D4 → x=3,y=15；Q16 → x=15,y=3；D16 → x=3,y=3（GTP 行号自底向上、列跳 I）
  const entry = { pv: ['D4', 'PASS', 'Q16', 'D16', 'Q4'] };
  assert.deepEqual(
    coachPreviewPoints(entry, { boardSize: 19, side: 'B', maxSteps: 3 }),
    [{ x: 3, y: 15 }, { x: 15, y: 3 }, { x: 3, y: 3 }],
    'PASS 不占预览步数（同复盘 filter→slice 口径），超步截断',
  );
  // 默认 maxSteps=10（本地偏好缺失兜底）：全部非 PASS 点
  assert.deepEqual(
    coachPreviewPoints(entry, { boardSize: 19 }).map((p) => p.x),
    [3, 15, 3, 15],
  );
});

test('FE-SB-24 | coachPreviewPoints：路数换算/越界中止/空载荷', () => {
  // 9 路：D4 → y=5；执色 side 不影响坐标序列（颜色由棋盘按 toMove 派生）
  assert.deepEqual(
    coachPreviewPoints({ pv: ['D4'] }, { boardSize: 9, side: 'W' }),
    [{ x: 3, y: 5 }],
  );
  // 越界（19 路 T20 行超出）→ 该点起中止（与后端 gtp_to_xy 同语义）
  assert.deepEqual(
    coachPreviewPoints({ pv: ['D4', 'T20', 'Q16'] }, { boardSize: 19 }),
    [{ x: 3, y: 15 }],
  );
  // 非法列 I（GTP 跳过 I）→ 中止
  assert.deepEqual(coachPreviewPoints({ pv: ['I9', 'D4'] }, { boardSize: 19 }), []);
  // 空/非法载荷
  assert.deepEqual(coachPreviewPoints(null), []);
  assert.deepEqual(coachPreviewPoints({ pv: [] }), []);
  assert.deepEqual(coachPreviewPoints({}), []);
});
