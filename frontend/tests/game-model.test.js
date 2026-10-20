/**
 * tGo · game-model.js 对弈纯函数模型无头单测（T6.4，node --test）
 * 用例 ID: FE-GM-*
 * 覆盖（TASK.md T6.4 验收·纯逻辑）：
 *   - 让子点位 / 吃子回放（replayStones：吃子移除、让子被提、自杀兜底、PASS、upto）；
 *   - 回合与降级派生（boardInteractive / aiWait / aiShouldAutoStart / engineDown）；
 *   - 悔棋剩余、信息行 meta、BoardNote、提子数/当前方、等级文本。
 * 并交叉校验 LEVEL_RANK_CODES 与 create-wizard RANKS 顺序一致（防漂移）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVEL_RANK_CODES,
  boardColor,
  sideColor,
  otherColor,
  aiLevelText,
  aiSideDisplay,
  blackSideValue,
  blackSideScore,
  handicapPoints,
  handicapLimit,
  replayStones,
  stonesForGame,
  isHumanAi,
  aiColorOf,
  nextColorOf,
  dropUpSide,
  isInPlay,
  boardInteractive,
  engineDown,
  boardEngineDead,
  aiWaitVisible,
  aiWaitLabel,
  aiRetryPlan,
  AI_RETRY_DELAYS_MS,
  aiShouldAutoStart,
  needsHumanModel,
  undoRemaining,
  undoLabel,
  metaSegments,
  commentBubbleModel,
  lastMoveDesc,
  shortMoveText,
  capturesState,
} from '../static/js/core/game-model.js';
import { RANKS } from '../static/js/views/create-wizard.js';

/* ---------- fixture 构建 ---------- */

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
      aiStyle: 'human',
      aiLevel: 5,
      adaptiveEnabled: false,
      coachingEnabled: false,
      favorite: false,
    },
    players: {
      black: { name: '张三', rank: 'rank_1d' },
      white: { name: 'AI', rank: null },
    },
    turn: null,
    nextColor: 'B',
    captures: { black: 2, white: 0 },
    undoCount: 1,
    moves: [],
    lastMoveNo: 0,
    analysisComplete: false,
    coverage: null,
    result: null,
    ...overrides,
  };
  if (overrides.params) g.params = { ...makeGame().params, ...overrides.params };
  if (overrides.moves) g.moves = overrides.moves;
  if (overrides.undoCount !== undefined) g.undoCount = overrides.undoCount;
  return g;
}

function mv(no, color, x, y, isPass = false) {
  return { moveNo: no, color, x, y, isPass };
}

const keys = (stones) => stones.map((s) => `${s.color}@${s.x},${s.y}`).sort();

/* ============================================================
 * 颜色 / 等级
 * ============================================================ */

test('FE-GM-01 | 颜色双向换算与取反', () => {
  assert.equal(boardColor('B'), 'black');
  assert.equal(boardColor('W'), 'white');
  assert.equal(boardColor('black'), 'black');
  assert.equal(sideColor('black'), 'B');
  assert.equal(sideColor('white'), 'W');
  assert.equal(otherColor('B'), 'W');
  assert.equal(otherColor('W'), 'B');
  assert.equal(otherColor('black'), 'white');
  assert.equal(otherColor('white'), 'black');
});

test('FE-GM-02 | LEVEL_RANK_CODES 与 create-wizard RANKS 顺序一致（防漂移）', () => {
  assert.deepEqual(LEVEL_RANK_CODES, RANKS);
});

test('FE-GM-23 | aiSideDisplay：人机 AI 侧显示派生（名称/段位/风格，2026/09/10）', () => {
  // 状态树 params 形态（人类执黑 → AI 执白）
  const g = makeGame({ params: { humanColor: 'B', aiStyle: 'standard', aiLevel: 5, adaptiveEnabled: false } });
  assert.deepEqual(aiSideDisplay(g, 'white'), { name: 'AI', rank: '5K', tag: '标准' });
  assert.equal(aiSideDisplay(g, 'black'), null); // 非 AI 侧沿用快照显示
  // 风格标签：拟人 / 匹配（自适应优先级高于 ai_style）
  assert.equal(aiSideDisplay(makeGame({ params: { aiStyle: 'human' } }), 'white').tag, '拟人');
  assert.equal(
    aiSideDisplay(makeGame({ params: { aiStyle: 'human', adaptiveEnabled: true } }), 'white').tag,
    '匹配',
  );
  // API GameInfo 形态（snake_case；人类执白 → AI 执黑）
  const row = { mode: 'human_ai', human_color: 'W', ai_style: 'human', ai_level: 9, adaptive_enabled: false };
  assert.deepEqual(aiSideDisplay(row, 'black'), { name: 'AI', rank: '3D', tag: '拟人' });
  assert.equal(aiSideDisplay(row, 'white'), null);
  // 人人对局 / 空输入 → null
  assert.equal(aiSideDisplay({ mode: 'human_human' }, 'black'), null);
  assert.equal(aiSideDisplay(null, 'black'), null);
  assert.equal(aiSideDisplay(undefined, 'white'), null);
});

test('FE-GM-03 | aiLevelText 12 档映射与越界钳制', () => {
  assert.equal(aiLevelText(1), '20K');
  assert.equal(aiLevelText(4), '8K');
  assert.equal(aiLevelText(5), '5K');
  assert.equal(aiLevelText(7), '1K');
  assert.equal(aiLevelText(8), '1D');
  assert.equal(aiLevelText(12), '9D');
  assert.equal(aiLevelText(0), '20K'); // 越界钳制
  assert.equal(aiLevelText(99), '9D');
  assert.equal(aiLevelText(null), '5K'); // 缺省 5K
});

/* ============================================================
 * 让子点位 / 吃子回放
 * ============================================================ */

test('FE-GM-04 | 让子点位（国际经典序）与尺寸上限', () => {
  assert.deepEqual(handicapPoints(19, 0), []);
  // 四角放置序：右上→左下→右下→左上
  assert.deepEqual(handicapPoints(19, 2).map((s) => [s.x, s.y]), [[15, 3], [3, 15]]);
  assert.deepEqual(handicapPoints(19, 4).map((s) => [s.x, s.y]), [
    [15, 3], [3, 15], [15, 15], [3, 3],
  ]);
  // 5/7 子天元入座；6/8 子不着天元
  assert.deepEqual(handicapPoints(19, 5).map((s) => [s.x, s.y]), [
    [15, 3], [3, 15], [15, 15], [3, 3], [9, 9],
  ]);
  assert.deepEqual(handicapPoints(19, 6).map((s) => [s.x, s.y]), [
    [15, 3], [3, 15], [15, 15], [3, 3], [3, 9], [15, 9],
  ]);
  assert.equal(handicapPoints(19, 7).at(-1).y, 9);
  assert.ok(!handicapPoints(19, 8).some((s) => s.x === 9 && s.y === 9));
  assert.equal(handicapPoints(19, 9).length, 9);
  assert.deepEqual(handicapPoints(9, 2).map((s) => [s.x, s.y]), [[6, 2], [2, 6]]);
  assert.ok(handicapPoints(19, 2).every((s) => s.color === 'black'));
  assert.deepEqual(handicapPoints(9, 99), handicapPoints(9, 9)); // 超量 → 全集
  // 尺寸上限（镜像后端 HANDICAP_LIMITS：9/13/19 → 4/6/9）
  assert.equal(handicapLimit(9), 4);
  assert.equal(handicapLimit(13), 6);
  assert.equal(handicapLimit(19), 9);
  assert.equal(handicapLimit(17), 0);
});

test('FE-GM-05 | 空盘回放 = 仅让子黑子', () => {
  const s = replayStones({ size: 19, handicap: 4, moves: [] });
  assert.equal(s.length, 4);
  assert.ok(s.every((x) => x.color === 'black'));
  assert.equal(s.filter((x) => x.moveNo !== undefined).length, 0); // 让子无 moveNo
});

test('FE-GM-06 | 普通落子序列回放（含 moveNo 供当前手标记）', () => {
  const stones = replayStones({
    size: 9,
    moves: [mv(1, 'B', 2, 2), mv(2, 'W', 6, 6), mv(3, 'B', 4, 4)],
  });
  assert.deepEqual(keys(stones), [
    'black@2,2', 'black@4,4', 'white@6,6',
  ]);
  const last = stones.find((s) => s.moveNo === 3);
  assert.ok(last && last.x === 4 && last.y === 4);
  // 被吃子不应带 moveNo（仅落子点）
  assert.equal(stones.filter((s) => s.moveNo !== undefined).length, 3);
});

test('FE-GM-07 | 吃子移除：白子被四邻围死后提出', () => {
  // 白@4,4 被黑 3,4 / 5,4 / 4,3 / 4,5 提掉
  const moves = [
    mv(1, 'B', 3, 4), mv(2, 'W', 4, 4), mv(3, 'B', 5, 4),
    mv(4, 'B', 4, 3), mv(5, 'W', 0, 0), mv(6, 'B', 4, 5),
  ];
  const stones = replayStones({ size: 9, moves });
  const k = keys(stones);
  assert.ok(!k.includes('white@4,4'), '白@4,4 应被提');
  assert.deepEqual(k, [
    'black@3,4', 'black@4,3', 'black@4,5', 'black@5,4', 'white@0,0',
  ]);
  // 提子点 4,4 无棋子（moveNo=2 的石子已消失）
  assert.equal(stones.some((s) => s.x === 4 && s.y === 4), false);
});

test('FE-GM-08 | 让子黑子可被吃（先手落白围提）', () => {
  // 9 路 4 子让子含 (2,2)（左上角）；白 (1,2)(3,2)(2,1)(2,3) 围提该让子黑
  const moves = [
    mv(1, 'W', 1, 2), mv(2, 'B', 0, 0), mv(3, 'W', 3, 2),
    mv(4, 'B', 8, 8), mv(5, 'W', 2, 1), mv(6, 'B', 0, 8),
    mv(7, 'W', 2, 3),
  ];
  const stones = replayStones({ size: 9, handicap: 4, moves });
  assert.ok(!keys(stones).includes('black@2,2'), '让子黑@2,2 应被提');
});

test('FE-GM-09 | PASS 与乱序 moves 处理', () => {
  const stones = replayStones({
    size: 9,
    moves: [mv(1, 'B', 2, 2, true), mv(2, 'W', 2, 2), mv(3, 'B', 5, 5, true), mv(4, 'W', 6, 6)],
  });
  // PASS 不落子；乱序已按 moveNo 重排（末手 W@6,6 有 moveNo=4）
  assert.deepEqual(keys(stones), ['white@2,2', 'white@6,6']);
  assert.equal(stones.find((s) => s.x === 6 && s.y === 6).moveNo, 4);
});

test('FE-GM-10 | upto 截断回放（悔棋/复盘按手数取局面）', () => {
  const moves = [
    mv(1, 'B', 3, 4), mv(2, 'W', 4, 4), mv(3, 'B', 5, 4),
    mv(4, 'B', 4, 3), mv(5, 'W', 0, 0), mv(6, 'B', 4, 5), // 第 6 手提 W@4,4
  ];
  const before = replayStones({ size: 9, moves, upto: 4 });
  assert.ok(keys(before).includes('white@4,4'), 'upto=4 时白子仍在');
  const after = replayStones({ size: 9, moves, upto: 6 });
  assert.ok(!keys(after).includes('white@4,4'));
});

test('FE-GM-11 | 自杀回放兜底（无气且未提子 → 移除）', () => {
  // 白 (3,4)(5,4)(4,3)(4,5) 各自仍有气；黑再落 (4,4)：被四邻围死且不提子 → 兜底回滚
  const moves = [
    mv(1, 'W', 3, 4), mv(2, 'B', 0, 0), mv(3, 'W', 5, 4), mv(4, 'B', 0, 8),
    mv(5, 'W', 4, 3), mv(6, 'B', 8, 0), mv(7, 'W', 4, 5), mv(8, 'B', 8, 8),
    mv(9, 'B', 4, 4),
  ];
  const stones = replayStones({ size: 9, moves });
  assert.ok(!keys(stones).includes('black@4,4'), '黑@4,4 自杀应被回滚');
  assert.deepEqual(keys(stones), [
    'black@0,0', 'black@0,8', 'black@8,0', 'black@8,8',
    'white@3,4', 'white@4,3', 'white@4,5', 'white@5,4',
  ]);
});

test('FE-GM-12 | stonesForGame 便捷封装', () => {
  const g = makeGame({
    params: { handicap: 2 },
    moves: [mv(1, 'W', 2, 2), mv(2, 'B', 5, 5)],
    lastMoveNo: 2,
  });
  const stones = stonesForGame(g);
  assert.ok(keys(stones).includes('black@15,3'));
  assert.ok(keys(stones).includes('black@3,15'));
  assert.ok(keys(stones).includes('white@2,2'));
});

/* ============================================================
 * 回合 / 引擎降级派生
 * ============================================================ */

test('FE-GM-13 | 人人：PLAYING/created 开放，scoring/finished 锁定', () => {
  const base = { mode: 'human_human', boardSize: 19, rules: 'chinese', komi: 7.5, handicap: 0, humanColor: null };
  const g = makeGame({ params: base, nextColor: 'B', status: 'active' });
  assert.equal(isHumanAi(g), false);
  assert.equal(boardInteractive(g), true);
  assert.equal(boardInteractive({ ...g, status: 'created' }), true);
  assert.equal(boardInteractive({ ...g, status: 'scoring' }), false);
  assert.equal(boardInteractive({ ...g, status: 'finished' }), false);
  assert.equal(boardInteractive(g, true), false); // pending 禁输入
});

test('FE-GM-14 | 人机：仅人类执色轮到可交互；AI 先行/TURN_AI 禁输入', () => {
  // 人类执黑，AI 白；轮到黑（人类）
  const g = makeGame({ params: { humanColor: 'B' }, nextColor: 'B' });
  assert.equal(isHumanAi(g), true);
  assert.equal(aiColorOf(g), 'W');
  assert.equal(boardInteractive(g), true);
  // 轮到 AI（lastMoveNo=1 → 推导 W=AI）
  assert.equal(boardInteractive({ ...g, lastMoveNo: 1, nextColor: 'W' }), false);
  // created AI 先行（人类执白）→ 禁输入（等 AI 首手）
  const g2 = makeGame({ params: { humanColor: 'W' }, nextColor: 'B', status: 'created' });
  assert.equal(boardInteractive(g2), false);
  assert.equal(boardInteractive({ ...g2, status: 'active' }), false);
  // 人人 pending
  assert.equal(boardInteractive(g, true), false);
});

test('FE-GM-15 | 引擎降级：人机灰化/警示；人人不阻断', () => {
  assert.equal(engineDown('DEAD'), true);
  assert.equal(engineDown('FATAL'), true);
  assert.equal(engineDown('IDLE'), false);
  assert.equal(engineDown('INIT'), false);
  assert.equal(engineDown('STOPPED'), false, '未启动不属降级：按需拉起始即可用');
  const humanAi = makeGame({ params: { humanColor: 'B' } });
  const humanHuman = makeGame({ params: { mode: 'human_human', humanColor: null } });
  assert.equal(boardEngineDead(humanAi, 'DEAD'), true);
  assert.equal(boardEngineDead(humanHuman, 'DEAD'), false);
  assert.equal(boardEngineDead(humanAi, 'INIT'), false);
  assert.equal(boardEngineDead(humanAi, 'STOPPED'), false);
});

test('FE-GM-16 | AI 思考/等待胶囊可见性与文案', () => {
  const g = makeGame({ params: { humanColor: 'B' }, lastMoveNo: 1, nextColor: 'W' }); // AI 白轮到
  assert.equal(aiWaitVisible(g), true);
  assert.equal(aiWaitVisible({ ...g, lastMoveNo: 0, nextColor: 'B' }), false); // 人类轮到
  assert.equal(aiWaitVisible(g, true), true); // pending
  assert.equal(aiWaitVisible({ ...g, status: 'scoring' }), false);
  assert.equal(aiWaitLabel('IDLE'), '思考中');
  assert.equal(aiWaitLabel('ANALYZING'), '思考中');
  assert.equal(aiWaitLabel('STOPPED'), '思考中'); // 未启动：自动 start 会按需拉起，仍属思考窗口
  assert.equal(aiWaitLabel('DEAD'), '等待引擎恢复');
  assert.equal(aiWaitLabel('FATAL'), '等待引擎恢复');
  // B2（2026/09/10 人工决策）：人类模型未挂载（人类风格/自适应）→ 胶囊文案改为提示
  // （引擎 DEAD/FATAL 优先——瞬时故障可重试）
  assert.equal(aiWaitLabel('IDLE', { humanModelUnavailable: true }), '人类模型不可用');
  assert.equal(aiWaitLabel('DEAD', { humanModelUnavailable: true }), '等待引擎恢复');
  // 人人永不显示 AI 胶囊
  const hh = makeGame({ params: { mode: 'human_human', humanColor: null }, nextColor: 'B' });
  assert.equal(aiWaitVisible(hh), false);
});

test('FE-GM-17 | 自动 start 触发判定（AI 先行 / TURN_AI 恢复）', () => {
  // created + AI 先行（人类执白）→ 引擎 IDLE / INIT（按需加载）均触发
  const g = makeGame({ params: { humanColor: 'W' }, status: 'created', nextColor: 'B' });
  assert.equal(aiShouldAutoStart(g, 'IDLE'), true);
  assert.equal(aiShouldAutoStart(g, 'INIT'), true); // 引擎未就绪：按需加载拉起
  assert.equal(aiShouldAutoStart(g, 'STOPPED'), true); // 未启动：按需加载拉起
  assert.equal(aiShouldAutoStart(g, ''), true); // 引擎态未知：不阻塞 AI 开局
  assert.equal(aiShouldAutoStart(g, 'DEAD'), false); // DEAD/FATAL 由人工恢复
  assert.equal(aiShouldAutoStart(g, 'FATAL'), false);
  assert.equal(aiShouldAutoStart(g, 'IDLE', true), false); // pending 防重
  // active TURN_AI 挂起恢复
  const g2 = makeGame({ params: { humanColor: 'B' }, status: 'active', nextColor: 'W' });
  assert.equal(aiShouldAutoStart(g2, 'IDLE'), true);
  // 人类轮到 → 不触发
  const g3 = makeGame({ params: { humanColor: 'B' }, status: 'active', nextColor: 'B' });
  assert.equal(aiShouldAutoStart(g3, 'IDLE'), false);
  // 人人不触发
  const hh = makeGame({ params: { mode: 'human_human', humanColor: null }, status: 'active', nextColor: 'B' });
  assert.equal(aiShouldAutoStart(hh, 'IDLE'), false);
  // B2：人类模型不可用 → 不自动续行（提示由胶囊/横幅呈现，恢复后引擎态变更再触发）
  assert.equal(aiShouldAutoStart(g2, 'IDLE', false, { humanModelUnavailable: true }), false);
});

test('FE-GM-22 | needsHumanModel：人类风格/自适应需人类模型；标准风格与人人不需要', () => {
  assert.equal(needsHumanModel(makeGame({ params: { aiStyle: 'human', adaptiveEnabled: false } })), true);
  assert.equal(needsHumanModel(makeGame({ params: { aiStyle: 'human', adaptiveEnabled: true } })), true);
  assert.equal(needsHumanModel(makeGame({ params: { aiStyle: 'standard', adaptiveEnabled: false } })), false);
  assert.equal(
    needsHumanModel(makeGame({ params: { mode: 'human_human', humanColor: null, aiStyle: null } })),
    false,
  );
  assert.equal(needsHumanModel(null), false);
});

/* ============================================================
 * 悔棋 / 信息行 / BoardNote / 提子数
 * ============================================================ */

test('FE-GM-18 | 悔棋剩余 = 上限 − undo_count（含禁用与上限）', () => {
  const g = makeGame({ undoCount: 1 });
  assert.equal(undoRemaining(g, 5), 4);
  assert.equal(undoRemaining(g, 3), 2);
  assert.equal(undoRemaining({ ...g, undoCount: 5 }, 5), 0);
  assert.equal(undoRemaining(g, 0), 0);
  assert.equal(undoRemaining(g, -1), 0);
  assert.equal(undoRemaining(null, 5), 5);
  assert.equal(undoLabel(4), '悔棋（4）');
  assert.equal(undoLabel(0), '悔棋（0）');
});

test('FE-GM-19 | 信息行 metaSegments 分段（分先/让子 × 标准/人类/自适应）', () => {
  const g = makeGame({
    params: { mode: 'human_ai', aiStyle: 'standard', aiLevel: 5, adaptiveEnabled: false },
    lastMoveNo: 42,
  });
  const texts = metaSegments(g).map((s) => s.text);
  assert.deepEqual(texts, ['第 42 手', '19路', '中国', '贴 7.5', '分先', '标准 · 5K']);
  const adaptive = metaSegments(makeGame({ params: { adaptiveEnabled: true, aiLevel: 7 } }));
  assert.equal(adaptive[adaptive.length - 1].text, 'AI 匹配 · 1K');
  assert.equal(adaptive[adaptive.length - 1].badge, 'accent');
  // T6.10：显示当前 AI 匹配档位（关 = `AI 自适应`，默认开）
  // 2026/09/14：`AI 自适应` 同 `AI 匹配 · X` 一并归入徽章段（信息行同组渲染、固定完整显示）
  const adaptiveHide = metaSegments(makeGame({ params: { adaptiveEnabled: true, aiLevel: 7 } }), { showMatchRank: false });
  assert.equal(adaptiveHide[adaptiveHide.length - 1].text, 'AI 自适应');
  assert.equal(adaptiveHide[adaptiveHide.length - 1].badge, 'accent');
  assert.equal(metaSegments(makeGame({ params: { adaptiveEnabled: true, aiLevel: 7 } })).at(-1).badge, 'accent');
  const human = metaSegments(makeGame({ params: { aiStyle: 'human' } }));
  assert.equal(human[human.length - 1].text, '人类 · 5K');
  const handicap = metaSegments(makeGame({ params: { handicap: 2, komi: 0, aiLevel: 5 } }));
  assert.deepEqual(handicap.slice(3, 5).map((s) => s.text), ['贴 0', '让 2 子']);
  const hh = metaSegments(makeGame({ params: { mode: 'human_human', humanColor: null } }));
  // 2026/09/06 人工反馈：人人对弈信息行须显示对弈模式 → 末尾「人人」段
  assert.deepEqual(
    hh.map((s) => s.text),
    ['第 0 手', '19路', '中国', '贴 7.5', '分先', '人人'],
  );
  assert.equal(hh.some((s) => s.text.includes('·')), false);
});

test('FE-GM-24 | metaSegments 自动点评徽章段（仅开启点评的对局 + 开关态透传）', () => {
  // 未开启点评 / 未传 coach → 无徽章段
  const off = metaSegments(makeGame({ params: { coachingEnabled: false } }), { coach: { enabled: true } });
  assert.equal(off.some((s) => s.coach), false);
  const noCoach = metaSegments(makeGame({ params: { coachingEnabled: true } }));
  assert.equal(noCoach.some((s) => s.coach), false);
  // 开启点评 → 末尾徽章段（on 态随入参）
  const on = metaSegments(makeGame({ params: { coachingEnabled: true } }), { coach: { enabled: true } });
  assert.deepEqual(on.at(-1), { text: '自动点评', coach: true, on: true });
  const muted = metaSegments(makeGame({ params: { coachingEnabled: true } }), { coach: { enabled: false } });
  assert.deepEqual(muted.at(-1), { text: '自动点评', coach: true, on: false });
});

test('FE-GM-25 | commentBubbleModel 点评气泡文案（含 ΔW/ΔS 缺省剔除 + 落子方标注）', () => {
  assert.equal(commentBubbleModel(null, 42), null);
  assert.equal(commentBubbleModel({ delta_winrate: -9.2 }, 42), null); // 无 grade → null
  const m = commentBubbleModel(
    { color: 'W', grade: 'mistake', delta_winrate: -9.2, score_delta: -2.8 }, 42
  );
  assert.equal(m.line1, '白 第 42 手 · 失误（恶手）');
  assert.equal(m.line2, 'ΔW −9.2% · ΔS −2.8 目'); // ΔS=目数变化（恶手为负，同 ΔW 口径）
  const good = commentBubbleModel(
    { color: 'B', grade: 'brilliant', delta_winrate: 5.0, score_delta: 0.3 }, 8
  );
  assert.equal(good.line2, 'ΔW +5% · ΔS +0.3 目'); // 尾零去除（signed 口径）
  const onlyW = commentBubbleModel({ color: 'B', grade: 'good', delta_winrate: 1.5 }, 7);
  assert.equal(onlyW.line1, '黑 第 7 手 · 正着（好棋）');
  assert.equal(onlyW.line2, 'ΔW +1.5%');
  // 缺 color（兼容旧载荷）→ 不标注落子方
  assert.equal(commentBubbleModel({ grade: 'good' }, 7).line1, '第 7 手 · 正着（好棋）');
});

test('FE-GM-26 | blackSideValue/blackSideScore：当前执色方视角 → 固定黑方展示换算', () => {
  // 黑方 → 原值；白方 → 胜率取补、目差取负；null/非法 → null
  assert.equal(blackSideValue(62.5, 'B'), 62.5);
  assert.equal(blackSideValue(37.5, 'W'), 62.5);
  assert.equal(blackSideScore(3.5, 'B'), 3.5);
  assert.equal(blackSideScore(3.5, 'W'), -3.5);
  assert.equal(blackSideValue(null, 'W'), null);
  assert.equal(blackSideScore('x', 'B'), null);
});

test('FE-GM-20 | BoardNote 末手描述（含 PASS；short＝棋盘提示无手数）', () => {
  assert.equal(lastMoveDesc([], 19), null);
  const d = lastMoveDesc([mv(1, 'B', 3, 3), mv(2, 'W', 15, 15)], 19);
  assert.equal(d.text, '第 2 手 · 白 Q4'); // GTP：x=15→Q、y=15→row 4
  assert.equal(d.short, '白 Q4'); // 棋盘左上角提示（2026/09/13：无手数）
  const p = lastMoveDesc([mv(3, 'B', 3, 3), mv(4, 'W', null, null, true)], 19);
  assert.equal(p.text, '第 4 手 · 白 PASS');
  assert.equal(p.short, '白 PASS');
});

test('FE-GM-27 | shortMoveText 简洁着法（棋盘提示：颜色 + 坐标 / PASS）', () => {
  assert.equal(shortMoveText(null, 19), null);
  assert.equal(shortMoveText(mv(1, 'B', 3, 3), 19), '黑 D16');
  assert.equal(shortMoveText(mv(2, 'W', 15, 15), 19), '白 Q4');
  assert.equal(shortMoveText(mv(3, 'B', 2, 2), 9), '黑 C7'); // 9 路换算（行 9－y）
  assert.equal(shortMoveText(mv(4, 'W', null, null, true), 19), '白 PASS');
  assert.equal(shortMoveText(mv(5, 'B', null, null, true), 13), '黑 PASS');
});

test('FE-GM-21 | 提子数/当前方（capturesState）', () => {
  assert.deepEqual(capturesState(null), { black: 0, white: 0, toMove: null });
  const g = makeGame({ nextColor: 'B' });
  assert.deepEqual(capturesState(g), { black: 2, white: 0, toMove: 'black' });
  const g2 = makeGame({ nextColor: 'W', status: 'finished' });
  assert.deepEqual(capturesState(g2), { black: 2, white: 0, toMove: null }); // 终局无当前方
});

test('FE-GM-29 | 回合派生同源口径：nextColorOf 本地推导（抗 defer 窗口 nextColor 陈旧，BUG-094）', () => {
  // 分先：moveNo = lastMoveNo + 1 奇偶（与服务器 game_service._next_color 同源）
  assert.equal(nextColorOf(makeGame({ lastMoveNo: 0 })), 'B');
  assert.equal(nextColorOf(makeGame({ lastMoveNo: 1 })), 'W');
  assert.equal(nextColorOf(makeGame({ lastMoveNo: 2 })), 'B');
  // 让子棋白先（handicap>0，DATABASE §3.3）
  assert.equal(nextColorOf(makeGame({ params: { handicap: 2 }, lastMoveNo: 0 })), 'W');
  assert.equal(nextColorOf(makeGame({ params: { handicap: 2 }, lastMoveNo: 1 })), 'B');
  // 数据不足 → null（调用方退化用快照值）
  assert.equal(nextColorOf(null), null);
  assert.equal(nextColorOf({}), null);
  assert.equal(nextColorOf({ lastMoveNo: null }), null);
  // **defer 窗口**：人类刚落子（lastMoveNo 已推进、`move.applied` 不更新 nextColor）→ 快照仍是人类，
  // 本地推导必须胜出（否则 20s busy 兜底清锁后：计数器翻回人类 / 胶囊消失 / 棋盘误可点）
  const stale = makeGame({ params: { humanColor: 'B' }, lastMoveNo: 1, nextColor: 'B' });
  assert.equal(aiWaitVisible(stale), true, 'AI 待行（不再依赖陈旧快照）');
  assert.equal(capturesState(stale).toMove, 'white', '提子计数器当前方=AI');
  assert.equal(boardInteractive(stale), false, '棋盘禁输入（防误点→服务端 ILLEGAL_ACTION）');
  // 让子局首手（人类执黑、AI 白先）：同理本地推导=AI 待行
  const hc = makeGame({ params: { handicap: 2, humanColor: 'B' }, lastMoveNo: 0, nextColor: 'B' });
  assert.equal(aiWaitVisible(hc), true);
});

test('FE-GM-28 | dropUpSide：落子动画“由下到上”侧（人机＝人类方 / 人人＝黑方，2026/09/13）', () => {
  // 人机：人类方由下到上（与执色无关）；AI 方由上到下
  assert.equal(dropUpSide({ params: { mode: 'human_ai', humanColor: 'B' } }), 'black');
  assert.equal(dropUpSide({ params: { mode: 'human_ai', humanColor: 'W' } }), 'white');
  assert.equal(dropUpSide({ params: { mode: 'human_ai', humanColor: null } }), 'black'); // 缺省＝人类执黑
  // 人人：黑由下到上、白由上到下
  assert.equal(dropUpSide({ params: { mode: 'human_human', humanColor: null } }), 'black');
  // API 行（snake_case）同口径；空值兑底
  assert.equal(dropUpSide({ mode: 'human_ai', human_color: 'W' }), 'white');
  assert.equal(dropUpSide({ mode: 'human_ai', human_color: 'B' }), 'black');
  assert.equal(dropUpSide(null), 'black');
});

test('FE-GM-30 | AI 应手失败胶囊文案：aiPending 先于「思考中」，引擎/模型原因优先（R2）', () => {
  assert.equal(aiWaitLabel('IDLE'), '思考中');
  assert.equal(aiWaitLabel('IDLE', { aiPending: { code: 'ENGINE_BUSY', message: '查询超时' } }), 'AI 应手失败');
  // 优先级：引擎 DEAD/FATAL（等待恢复） > 人类模型缺失 > aiPending > 思考中
  assert.equal(aiWaitLabel('DEAD', { aiPending: { code: 'ENGINE_BUSY' } }), '等待引擎恢复');
  assert.equal(aiWaitLabel('FATAL', { aiPending: { code: 'ENGINE_BUSY' } }), '等待引擎恢复');
  assert.equal(
    aiWaitLabel('IDLE', { humanModelUnavailable: true, aiPending: { code: 'ENGINE_BUSY' } }),
    '人类模型不可用',
  );
  assert.equal(aiWaitLabel('', { aiPending: null }), '思考中');
  // 胶囊可见性认服务端挂起事实（R2）：本地奇偶推导不一致时仍展示（显式挂起为准）
  const stale = {
    params: { mode: 'human_ai', humanColor: 'B' },
    status: 'active',
    lastMoveNo: 2, // 偶 → 本地说轮到人类（与 aiPending 矛盾）
    aiPending: { code: 'ENGINE_BUSY', message: '失败' },
  };
  assert.equal(aiWaitVisible(stale), true);
  assert.equal(aiWaitVisible({ ...stale, lastMoveNo: 1, aiPending: null }), true); // 奇偶=AI 回合
  assert.equal(aiWaitVisible({ ...stale, aiPending: null }), false); // 奇偶=人类回合且无挂起
});

test('FE-GM-31 | AI 应手失败重试决策：有界（5s/15s 两次）且引擎不可用不重试（R2）', () => {
  assert.deepEqual(AI_RETRY_DELAYS_MS, [5000, 15000]);
  assert.deepEqual(aiRetryPlan(), { action: 'none', delayMs: null });
  assert.deepEqual(
    aiRetryPlan({ pending: true }),
    { action: 'schedule', delayMs: AI_RETRY_DELAYS_MS[0] },
  );
  assert.deepEqual(
    aiRetryPlan({ pending: true, attempts: 1 }),
    { action: 'schedule', delayMs: AI_RETRY_DELAYS_MS[1] },
  );
  assert.deepEqual(aiRetryPlan({ pending: true, attempts: 2 }), { action: 'none', delayMs: null }); // 用尽
  assert.deepEqual(aiRetryPlan({ pending: true, scheduled: true }), { action: 'none', delayMs: null });
  assert.deepEqual(aiRetryPlan({ pending: true, engineState: 'DEAD' }), { action: 'none', delayMs: null });
  assert.deepEqual(aiRetryPlan({ pending: true, engineState: 'FATAL' }), { action: 'none', delayMs: null });
  assert.deepEqual(aiRetryPlan({ pending: true, humanModelUnavailable: true }), { action: 'none', delayMs: null });
});
