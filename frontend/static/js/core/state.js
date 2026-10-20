/**
 * tGo · 前端状态树（T5.2）
 *
 * 单一事实源 Store，遵循 AGENTS §4 / UI_UX §8：
 *   - WS 回调**只允许 dispatch 消息**（{ type, data }），禁止在回调内直接重绘；
 *   - 绘制由 rAF/视图订阅完成（Phase 5.5 / Phase 6 接入）。
 *
 * 模块分两层：
 *   1. **纯函数层**（本文件可无头测试）：`createInitialState()` / `reduce(state, message)`
 *      以及 position key 工具（`mainKey` / `trialKey`）；
 *   2. **Store 壳**：`createStore()` 基于 reduce 维护状态、广播变更（引用相等则不通知）。
 *
 * 状态形状对齐 backend WS 载荷（API.md §4.3/§4.4 实测）：
 *   game.state   { game_id, status, game:{games 行}, moves:[...], next_color, turn,
 *                  analysis_complete, coverage:{done,total} } —— 权威重建
 *   move.applied { move_no, color, x, y, is_pass, black_captures?, white_captures? }
 *   move.undone  { move_no: 被撤末手, new_last_move_no, steps }
 *   game.finished{ result, black_score, white_score }
 *   analysis.curve { move_no, winrate, score_lead }（黑方视角百分比）
 *   analysis.comment { move_no, color, x, y, grade, delta_winrate, score_delta }
 *     —— 对弈点评（每手标准分析派送；落子方视角，引擎相关实时数据）；
 *     前端保留**最近 2 手**（`comments` 切片，2026/09/11 人工确认）
 *   coaching.top5 { side, base_winrate, moves:[…] }（**当前执色方视角**，2026/09/11）
 *   review.recommend { side, moves, root, comment, … }（同视角约定）
 *   scoring.prediction { game_id, move_no, engine, finished, dead_points, result, … }
 *     —— 结算预判（GTP final_score 等价结果 + 预判死子）
 *   position.ownership { position_key, move_no, ownership? }
 *   deep_analysis.result { position_key, result }
 *   analysis.progress { kind:'global', done, total } / global_analysis.done {done,total}
 *   engine.status { state, progress? } · system.status · admin.task
 *
 * 另含客户端本地动作（非服务端消息，前缀避冲突）：trial.*（含替换镜像
 * `trial.truncate`）、coaching.pending/coaching.reset、deep.pending/deep.reset、
 * global.pending、curve.set。
 */

import { aiSideDisplay } from './game-model.js';
import { parseTrialKey } from './trial-store.js';

/* ============================================================
 * 常量与工具
 * ============================================================ */

/** 主谱局面键：main:{moveNo}（0 = 初始局面）。 */
export function mainKey(moveNo) {
  return `main:${moveNo}`;
}

/** 试下分支局面键：trial:{trialId}:{相对手数}（0 = 试下进入局面）。 */
export function trialKey(trialId, relMoveNo) {
  return `trial:${trialId}:${relMoveNo}`;
}

/** 从主谱键解析手数，非主谱键返回 null。 */
export function parseMainKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^main:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** 对弈点评保留手数（最近 2 手圆点，2026/09/11 人工确认）。 */
export const RECENT_COMMENTS_MAX = 2;

/* ============================================================
 * 初始状态
 * ============================================================ */

/** 生成全新初始状态（幂等、无共享引用）。 */
export function createInitialState() {
  return {
    /** 当前对局会话（未连接/未恢复为 null）。 */
    game: null,
    /** 试下分支（会话内；非 null 表示正处于试下模式）。 */
    trial: null,
    /** 主谱每手曲线点（**黑方视角**；服务端 200ms 节流推送 + 复盘 REST 批量）。 */
    curve: { points: [] },
    /** 局面分析缓存：position_key → { ownership?, result?, … }（仅内存）。 */
    positions: {},
    /** AI 支招请求态与 TOP5（值均为**当前执色方视角**，2026/09/11）。 */
    coaching: { loading: false, topMoves: [], atMoveNo: null, side: null, baseWinrate: null },
    /** 对弈点评（每手标准分析派送；落子方视角，引擎相关实时数据）——保留最近 2 手。 */
    comments: [],
    /** 结算预判（scoring.prediction：预判死子 + GTP 语义 final_score 等价结果）。 */
    prediction: null,
    /** 复盘 AI 推荐（T6.8）：当前局面 TOP5/变化图/当前手点评（读持久化，引擎无关）。 */
    review: { loading: false, key: null, moves: [], variations: [], comment: null, root: null, hasData: false },
    /** 引擎全局状态（单实例，跨对局保留）。 */
    engine: { state: null, progress: null },
    /** 系统状态（管理通道推送，可选）。 */
    system: null,
    /** 最近一次管理异步任务回执（202 → admin.task）。 */
    adminTask: null,
    /** 深度分析进行态（互斥）。 */
    deepAnalysis: { running: false, positionKey: null },
    /** 全局分析进度（逐手补分析）。 */
    globalAnalysis: { running: false, done: 0, total: 0 },
  };
}

/* ============================================================
 * 纯函数小工具（不可变更新）
 * ============================================================ */

function update(obj, patch) {
  return { ...obj, ...patch };
}

/** 归一服务端 move 行/载荷 → 视图 move。 */
function normalizeMove(m) {
  return {
    moveNo: Number(m.move_no),
    color: m.color,
    x: m.x === undefined || m.x === null ? null : Number(m.x),
    y: m.y === undefined || m.y === null ? null : Number(m.y),
    isPass: Boolean(m.is_pass),
  };
}

/** 裁剪主谱缓存（曲线点/positions 中 main:* 且 moveNo > limit 的条目）。 */
function pruneMainCache(state, limitMoveNo) {
  const curve = { points: state.curve.points.filter((p) => Number(p.moveNo) <= limitMoveNo) };
  const positions = {};
  for (const [key, val] of Object.entries(state.positions)) {
    const mv = parseMainKey(key);
    if (mv === null || mv <= limitMoveNo) positions[key] = val;
  }
  return update(state, { curve, positions });
}

/** positions 中 main:* 且 moveNo > limit 移除（含 trial:* 不动）。 */
function pruneMainPositions(state, limitMoveNo) {
  const positions = {};
  for (const [key, val] of Object.entries(state.positions)) {
    const mv = parseMainKey(key);
    if (mv === null || mv <= limitMoveNo) positions[key] = val;
  }
  return update(state, { positions });
}

/* ============================================================
 * game.state —— 服务端权威重建
 * ============================================================ */

function gameFromSnapshot(data) {
  const g = data.game || {};
  const blackRank = g.black_rank || null;
  const whiteRank = g.white_rank || null;
  const moves = Array.isArray(data.moves)
    ? data.moves.map(normalizeMove).sort((a, b) => a.moveNo - b.moveNo)
    : [];
  const lastMoveNo =
    g.last_move_no !== undefined ? Number(g.last_move_no) : (moves.length ? moves[moves.length - 1].moveNo : 0);
  // 人机 AI 侧显示覆盖：名称 `AI` + 难度段位短标 + 风格标签（标准/拟人/匹配）——
  // 服务端黑白 name/rank 快照对 AI 侧无意义（旧数据落「真人」），展示以对局参数派生
  const players = {
    black: { name: g.black_name != null ? g.black_name : '真人', rank: blackRank },
    white: { name: g.white_name != null ? g.white_name : '真人', rank: whiteRank },
  };
  for (const side of ['black', 'white']) {
    const ai = aiSideDisplay(g, side);
    if (ai) players[side] = { ...players[side], name: ai.name, rank: ai.rank, tag: ai.tag };
  }
  return {
    gameId: Number(data.game_id),
    status: data.status || g.status || null,
    params: {
      mode: g.mode || null,
      boardSize: g.board_size !== undefined ? Number(g.board_size) : null,
      rules: g.rules || null,
      komi: g.komi !== undefined ? Number(g.komi) : null,
      handicap: g.handicap !== undefined ? Number(g.handicap) : 0,
      humanColor: g.human_color || null,
      aiStyle: g.ai_style || null,
      aiLevel: g.ai_level !== undefined ? Number(g.ai_level) : null,
      adaptiveEnabled: Boolean(g.adaptive_enabled),
      coachingEnabled: Boolean(g.coaching_enabled),
      favorite: Boolean(g.favorite),
    },
    players,
    turn: data.turn || null,
    nextColor: data.next_color || null,
    // AI 应手挂起原因（可选字段，R2）：{code, message} | null
    aiPending: data.ai_pending || null,
    captures: {
      black: g.black_captures !== undefined ? Number(g.black_captures) : 0,
      white: g.white_captures !== undefined ? Number(g.white_captures) : 0,
    },
    undoCount: g.undo_count !== undefined ? Number(g.undo_count) : 0,
    moves,
    lastMoveNo,
    // REST 详情扩展字段（复盘视图合成 game.state 时可选携带：T6.8 信息卡分析覆盖）
    movesCount:
      data.moves_count !== undefined
        ? Number(data.moves_count)
        : (moves.length ? moves[moves.length - 1].moveNo : 0),
    // WS 快照不含 analyses_count，但携带权威 coverage（连接即推送 game.state 会覆盖
    // REST 合成值）→ 回退 coverage.done（BUG-027：复盘信息卡曾显示 0/N、[补分析] 计数失真）
    analysesCount:
      data.analyses_count !== undefined
        ? Number(data.analyses_count)
        : (data.coverage && data.coverage.done !== undefined ? Number(data.coverage.done) : 0),
    analysisComplete: Boolean(data.analysis_complete),
    coverage: data.coverage || null,
    result: g.result || null,
    blackScore: null,
    whiteScore: null,
  };
}

function applyGameState(state, data) {
  const game = gameFromSnapshot(data);
  const prevGame = state.game;
  const sameGame = Boolean(prevGame && Number(prevGame.gameId) === Number(game.gameId));
  const limit = game.lastMoveNo;

  // —— 分析缓存策略（T6.5 修订） ——
  // 服务端对弈中**每手**广播 game.state（权威重建：落子/悔棋/他端操作）。若每次
  // 都清空曲线/领地缓存，实时曲线会随每手重置为单点（历史全丢）。故仅当仍处于
  // **同一对局会话**时保留已收到分析缓存并按权威 last_move_no 收敛（> 上限裁剪）；
  // 跨对局 / 首次连接（prevGame 为空）仍整清（等待 REST 回填 / 实时补齐）。
  let curve = { points: [] };
  let positions = {};
  if (sameGame) {
    curve = {
      points: (state.curve.points || []).filter((p) => Number(p.moveNo) <= limit),
    };
    for (const [key, val] of Object.entries(state.positions)) {
      const mv = parseMainKey(key);
      if (mv === null || mv <= limit) positions[key] = val;
    }
  }

  return update(state, {
    game,
    trial: null, // 服务端局面为唯一事实源：试下/分析缓存重置（等待复盘视图按需重取）
    curve,
    positions,
    coaching: { loading: false, topMoves: [], atMoveNo: null, side: null, baseWinrate: null },
    // 对弈点评/结算预判：跨对局重置（同对局内保留；点评按末手收敛且仅保留最近 2 手）
    comments: sameGame
      ? state.comments
        .filter((c) => Number(c.moveNo) <= limit)
        .slice(-RECENT_COMMENTS_MAX)
      : [],
    prediction: sameGame && state.prediction && Number(state.prediction.moveNo) <= limit
      ? state.prediction
      : null,
    review: { loading: false, key: null, moves: [], variations: [], comment: null, root: null, hasData: false },
    deepAnalysis: { running: false, positionKey: null },
    globalAnalysis: { running: false, done: 0, total: 0 },
  });
}

/* ============================================================
 * 对弈消息
 * ============================================================ */

function applyMoveApplied(state, data) {
  // 试下模式中收到服务端主谱落子：本步属临时同步，主谱事实以紧随其后的
  // game.state 权威重建为准，这里忽略以避免把他人落子并入试下分支。
  if (state.trial) return state;

  // 局面推进 → 支招结果过期（T6.5：防旧局面 TOP5 残留棋盘徽章/卡片）
  state = clearCoaching(state);

  const mv = normalizeMove(data);
  const moves = [...state.game.moves];
  const idx = moves.findIndex((m) => m.moveNo === mv.moveNo);
  if (idx >= 0) moves[idx] = mv;
  else moves.push(mv);
  moves.sort((a, b) => a.moveNo - b.moveNo);

  const lastMoveNo = Math.max(state.game.lastMoveNo, mv.moveNo);
  let next = pruneMainPositions(
    update(state, {
      game: update(state.game, { moves, lastMoveNo }),
    }),
    lastMoveNo,
  );

  // 提子累计（可选字段，ISSUE-047：向后兼容）
  if (data.black_captures !== undefined || data.white_captures !== undefined) {
    next = update(next, {
      game: update(next.game, {
        captures: {
          black: data.black_captures !== undefined ? Number(data.black_captures) : next.game.captures.black,
          white: data.white_captures !== undefined ? Number(data.white_captures) : next.game.captures.white,
        },
      }),
    });
  }
  return next;
}

function applyMoveUndone(state, data) {
  if (state.trial) return state; // 同 move.applied：忽略，等待 game.state 权威重建

  // 悔棋回退 → 支招结果过期（同上）
  state = clearCoaching(state);

  const newLast =
    data.new_last_move_no !== undefined
      ? Number(data.new_last_move_no)
      : Math.max(0, Number(data.move_no ?? state.game.lastMoveNo) - (Number(data.steps) || 1));

  const moves = state.game.moves.filter((m) => m.moveNo <= newLast);
  const game = update(state.game, { moves, lastMoveNo: newLast });
  // 点评随末手收敛（被撤手的点评移除；保留最近 2 手）
  const comments = state.comments.filter((c) => Number(c.moveNo) <= newLast);
  return pruneMainCache(update(state, { game, comments }), newLast);
}

function applyGameFinished(state, data) {
  const game = update(state.game, {
    status: 'finished',
    result: data.result ?? state.game.result ?? null,
    blackScore: data.black_score !== undefined ? data.black_score : null,
    whiteScore: data.white_score !== undefined ? data.white_score : null,
  });
  return update(state, { game, trial: null });
}

/* ============================================================
 * 曲线 / 领地 / 支招 / 深算
 * ============================================================ */

/** 合并 curve 点：按 moveNo upsert 且保持升序。 */
function upsertCurvePoints(points, data) {
  const moveNo = Number(data.move_no);
  const point = { moveNo, winrate: data.winrate ?? null, scoreLead: data.score_lead ?? null };
  const next = points.filter((p) => Number(p.moveNo) !== moveNo);
  next.push(point);
  next.sort((a, b) => a.moveNo - b.moveNo);
  return next;
}

function applyCurve(state, data) {
  // 曲线点必须落在权威局面范围内（main:{n}，n ≤ 当前 lastMoveNo）：悔棋截断后，
  // 在途分析（自适应判定前置链分析 / 合并对弈查询）的结果仍可能经 200ms 节流
  // 推送迟到，照单全收会让被撤手数的旧点重新生长在曲线上（人工反馈 2026/09/13
  // 「悔棋时胜率曲线旧数据未及时清除」）。游戏未装载时（state.game=null）不设限。
  const last = state.game ? Number(state.game.lastMoveNo) : NaN;
  const moveNo = Number(data && data.move_no);
  if (Number.isFinite(last) && Number.isFinite(moveNo) && moveNo > last) return state;
  return update(state, { curve: { points: upsertCurvePoints(state.curve.points, data) } });
}

function applyCurveSet(state, data) {
  const raw = Array.isArray(data) ? data : data && data.points;
  const points = Array.isArray(raw)
    ? raw
        .map((p) => {
          // REST /curve 为后端 snake_case（move_no/winrate/score_lead）批量载荷
          const moveNo = p.move_no !== undefined ? p.move_no : p.moveNo;
          return {
            moveNo: Number(moveNo),
            winrate: p.winrate ?? null,
            scoreLead: p.score_lead ?? p.scoreLead ?? null,
          };
        })
        .filter((p) => Number.isFinite(p.moveNo) && p.moveNo >= 0)
        .sort((a, b) => a.moveNo - b.moveNo)
    : [];
  return update(state, { curve: { points } });
}

function applyOwnership(state, data) {
  const key = data.position_key;
  if (!key) return state;
  const prev = state.positions[key] || {};
  // ownership 缺省 = 无数据占位 null（不残留旧值）
  return update(state, { positions: { ...state.positions, [key]: { ...prev, ownership: data.ownership ?? null } } });
}

/** 支招请求过期重置（局面推进/悔棋时调用）。 */
function clearCoaching(state) {
  return update(state, {
    coaching: { loading: false, topMoves: [], atMoveNo: null, side: null, baseWinrate: null },
  });
}

function applyTop5(state, data) {
  const topMoves = Array.isArray(data && data.moves) ? data.moves : [];
  const atMoveNo = data.move_no !== undefined ? Number(data.move_no) : state.coaching.atMoveNo;
  const side = data.side === 'B' || data.side === 'W' ? data.side : state.coaching.side;
  const base = data.base_winrate;
  const baseWinrate = base == null || !Number.isFinite(Number(base)) ? null : Number(base);
  return update(state, { coaching: { loading: false, topMoves, atMoveNo, side, baseWinrate } });
}

/** 对弈点评载荷 → 状态切片（每手标准分析派送；保留最近 2 手、按手数升序）。 */
function applyComment(state, data) {
  if (!data || data.move_no == null) return state;
  // 点评点必须落在权威局面范围内（H-6）：悔棋截断后，后端 GameCommentPusher 的
  // 前序重试（~3.2s 窗口）仍可能推送被撤手数的点评——照单全收会让已撤销手的
  // 圆点/气泡“复活”直到下一次 game.state。与 applyCurve 同源守卫。
  const last = state.game ? Number(state.game.lastMoveNo) : NaN;
  const moveNo = Number(data.move_no);
  if (Number.isFinite(last) && Number.isFinite(moveNo) && moveNo > last) return state;
  const next = {
    moveNo: Number(data.move_no),
    color: data.color === 'W' || data.color === 'B' ? data.color : null,
    x: data.x == null ? null : Number(data.x),
    y: data.y == null ? null : Number(data.y),
    grade: data.grade || null,
    deltaWinrate: data.delta_winrate == null ? null : Number(data.delta_winrate),
    scoreDelta: data.score_delta == null ? null : Number(data.score_delta),
  };
  const list = state.comments
    .filter((c) => Number(c.moveNo) !== next.moveNo)
    .concat(next)
    .sort((a, b) => Number(a.moveNo) - Number(b.moveNo));
  return update(state, { comments: list.slice(-RECENT_COMMENTS_MAX) });
}

/** 结算预判载荷 → 状态切片（预判死子集合 + GTP 语义 final_score 等价结果）。 */
function applyPrediction(state, data) {
  if (!data || data.game_id == null) return state;
  const points = Array.isArray(data.dead_points) ? data.dead_points : [];
  return update(state, {
    prediction: {
      gameId: Number(data.game_id),
      moveNo: Number(data.move_no ?? 0),
      engine: Boolean(data.engine),
      reason: data.reason || null,
      finished: Boolean(data.finished),
      deadPoints: points
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => ({ x: Number(p[0]), y: Number(p[1]) })),
      result: data.result || null,
      blackScore: data.black_score == null ? null : Number(data.black_score),
      whiteScore: data.white_score == null ? null : Number(data.white_score),
      lead: data.lead == null ? null : Number(data.lead),
    },
  });
}

/**
 * 复盘推荐请求中（T6.8）：记录目标局面键供过期判定。
 *
 * 同 key（深算完成/原位重拉）→ 保留旧载荷，卡片不闪空态；
 * **key 变化（落子/步进到新局面）→ 必须清空 moves/root/comment/side**：旧 root 属于
 * 上一局面，保留会被曲线点派生（buildTrialPtsAbs）当作新局面的有效值 → 新点先按错值
 * 播一次生长动画，真数据到达再播一次修订动画（人工复核“一次落子两次更新”根因）；
 * 且旧 side 丢失时 blackSideValue 直接透传 → 黑方视角值错（如 99.9 → 99.9）。
 */
function applyReviewPending(state, data) {
  const key = data && data.key ? String(data.key) : state.review.key;
  if (key != null && key === state.review.key) {
    return update(state, { review: { ...state.review, loading: true, hasData: false } });
  }
  return update(state, {
    review: {
      loading: true,
      key,
      moves: [],
      variations: [],
      comment: null,
      root: null,
      side: null,
      hasData: false,
    },
  });
}

/** review.recommend 结果（T6.8）：key 不匹配（步进已过/过期）时丢弃保持旧值。 */
function applyReviewRecommend(state, data) {
  const key = data && data.position_key;
  if (!key) return update(state, { review: { ...state.review, loading: false } });
  return update(state, {
    review: {
      loading: false,
      key,
      moves: Array.isArray(data.moves) ? data.moves : [],
      variations: Array.isArray(data.variations) ? data.variations : [],
      comment: data.comment || null,
      root: data.root || null,
      // BUG-027：视角（当前执色方）必须入切片——旧实现丢失 → 推荐卡白方脚注永不可达
      side: data.side === 'B' || data.side === 'W' ? data.side : null,
      hasData: Boolean(data.has_data),
    },
  });
}

function applyDeepResult(state, data) {
  const key = data.position_key;
  if (!key) return update(state, { deepAnalysis: { running: false, positionKey: null } });
  const prev = state.positions[key] || {};
  return update(state, {
    positions: { ...state.positions, [key]: { ...prev, result: data.result } },
    deepAnalysis: { running: false, positionKey: null },
  });
}

/**
 * 深算请求终止复位（**本地动作**，无完成语义；BUG-091）。
 *
 * 旧实现以 `deep_analysis.result` + 空载荷冒充复位——视图订阅把「收到
 * deep_analysis.result」等同于「深算完成」→ 引擎不可用 / 深算已在跑时
 * 误弹「深度分析完成」（试下每手都弹）。复位与完成必须是两种消息。
 */
function applyDeepReset(state) {
  return update(state, { deepAnalysis: { running: false, positionKey: null } });
}

/**
 * 全局分析请求终止复位（**本地动作**，无完成语义；M-14）。
 *
 * 旧实现仅 `global_analysis.done` 置 running=false——全局分析因引擎故障/任务被
 * 丢弃（on_drop → error 信封）时客户端只收到错误，进行态（按钮呼吸/进度）永久
 * 滞留。与 deep.reset 同口径：复位与完成是两种消息。
 */
function applyGlobalReset(state) {
  return update(state, {
    globalAnalysis: {
      running: false,
      done: state.globalAnalysis.done,
      total: state.globalAnalysis.total,
    },
  });
}

/* ============================================================
 * 全局/引擎/管理消息
 * ============================================================ */

function applyGlobalProgress(state, data) {
  if (data.kind !== undefined && data.kind !== 'global') return state; // 预留其它 kind
  return update(state, {
    globalAnalysis: {
      running: true,
      done: data.done !== undefined ? Number(data.done) : state.globalAnalysis.done,
      total: data.total !== undefined ? Number(data.total) : state.globalAnalysis.total,
    },
  });
}

function applyGlobalDone(state, data) {
  return update(state, {
    globalAnalysis: {
      running: false,
      done: data.done !== undefined ? Number(data.done) : state.globalAnalysis.done,
      total: data.total !== undefined ? Number(data.total) : state.globalAnalysis.total,
    },
  });
}

/** 引擎不可用原因（API §3.3 `reason` 可选字段；与 `core/engine-banner.js` 同值）。 */
export const ENGINE_REASON = Object.freeze({
  /** 标准模型缺失（无管理器时 FATAL 为合成态；文件就位后 [启动]/[手动重启] 重建装配，BUG-097）。 */
  standardModelMissing: 'standard_model_missing',
  /** katago 可执行文件缺失（engine.executable_dir 下未找到；就位后可重建装配，BUG-097）。 */
  engineExecutableMissing: 'engine_executable_missing',
  /** 引擎进程启动失败（驱动异常等；快照 `detail` 携带 stderr 摘要，BUG-097）。 */
  startupFailed: 'startup_failed',
});

/** 原因码是否属于「引擎不可用」归因集合（FATAL 文案分叉依据；BUG-097）。 */
export function isEngineUnavailableReason(reason) {
  return (
    reason === ENGINE_REASON.standardModelMissing ||
    reason === ENGINE_REASON.engineExecutableMissing ||
    reason === ENGINE_REASON.startupFailed
  );
}

/**
 * 引擎状态集合与分类器（定义在 `core/engine-state.js`，权威定义在后端
 * `backend/app/core/fsm.py`；此处在状态模块内转发，便于 `ENGINE_REASON` 同点引用）。
 */
export {
  ENGINE_LAUNCHABLE_STATES,
  ENGINE_QUERY_STATES,
  ENGINE_RUNNING_STATES,
  engineStateClass,
} from './engine-state.js';

/**
 * 原因说明（`detail`）单行截断：横幅/卡片/胶囊共用（超长补省略号；空值 → ''）。
 * @param {string|null|undefined} detail
 * @param {number} [maxLength=120]
 * @returns {string}
 */
export function shortenDetail(detail, maxLength = 120) {
  const text = detail === undefined || detail === null ? '' : String(detail).trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function applyEngineStatus(state, data) {
  const progress =
    data && data.progress !== undefined && data.progress !== null
      ? Number(data.progress)
      : null; // null = 无 benchmark 进度（加载中/就绪），禁止 Number(null)→0 误判
  const nextState =
    data && data.state !== undefined && data.state !== null
      ? String(data.state)
      : (data && data.state === null ? null : state.engine.state);
  const engine = {
    state: nextState,
    progress,
  };
  // 人类模型可用性（API §4.4 可选字段）：未携带时保留既有值（状态广播多为增量化）
  if (data && typeof data.humanModelAvailable === 'boolean') {
    engine.humanModelAvailable = data.humanModelAvailable;
  } else if (typeof state.engine.humanModelAvailable === 'boolean') {
    engine.humanModelAvailable = state.engine.humanModelAvailable;
  }
  // 引擎不可用原因（API §3.3 可选字段）：显式 null 视为「无原因」（清旧值，REST 快照恒携带）；
  // 字段缺失时保留既有值（增量化广播，同 humanModelAvailable 口径）
  if (data && data.reason !== undefined) {
    engine.reason = data.reason === null ? null : String(data.reason);
  } else if (state.engine.reason !== undefined) {
    engine.reason = state.engine.reason;
  }
  // 原因说明（人类可读，BUG-097；同为显式 null 清旧值）：stderr 摘要等
  if (data && data.detail !== undefined) {
    engine.detail = data.detail === null ? null : String(data.detail);
  } else if (state.engine.detail !== undefined) {
    engine.detail = state.engine.detail;
  }
  return update(state, { engine });
}

/* ============================================================
 * 试下分支（客户端本地动作；与主谱严格隔离）
 * ============================================================ */

function applyTrialEnter(state, data) {
  if (!state.game) return state;
  const fromMoveNo =
    data.fromMoveNo !== undefined
      ? Number(data.fromMoveNo)
      : state.game.lastMoveNo;
  return update(state, {
    trial: { id: String(data.id ?? 'trial'), fromMoveNo, moves: [] },
  });
}

function applyTrialPlay(state, data) {
  const trial = state.trial;
  if (!trial) return state;
  return update(state, {
    trial: update(trial, {
      moves: [...trial.moves, { x: data.x ?? null, y: data.y ?? null, isPass: Boolean(data.isPass) }],
    }),
  });
}

function applyTrialUndo(state) {
  if (!state.trial) return state;
  return update(state, { trial: update(state.trial, { moves: state.trial.moves.slice(0, -1) }) });
}

function applyTrialExit(state) {
  return update(state, { trial: null });
}

/**
 * 试下替换（撤销截断）镜像：清除该分支 `rel > data.rel` 的局面缓存（positions）。
 * 服务端 `trial_undo` 已截断会话缓存；客户端替换落子（先撤销后落子）若不镜像，
 * 领地/深算等按 position_key 缓存的条目会命中旧分支数据（与 trial-store 截断对称）。
 *
 * 同并失效 **review 切片**：若其 key 仍停在被截断的手数上（同 rel 会被新着法复用），
 * 该 payload 的 root 会被曲线点派生（reviewFor）当作有效值 → 状态阶段先按**陈旧值**
 * 播一次生长动画，新数据到达后再播一次修订动画（人工复核“一次落子两次更新”根因）。
 * 置空后曲线点在拿到新数据前不落图（等待期间无动画）。
 */
function applyTrialTruncate(state, data) {
  const trialId = String(data && data.trialId);
  const rel = Math.max(0, Number(data && data.rel) || 0);
  const positions = {};
  for (const [key, val] of Object.entries(state.positions)) {
    const t = parseTrialKey(key);
    if (t && String(t.trialId) === trialId && t.rel > rel) continue;
    positions[key] = val;
  }
  const reviewKey = parseTrialKey(state.review && state.review.key);
  const reviewStale = Boolean(
    reviewKey && String(reviewKey.trialId) === trialId && reviewKey.rel > rel,
  );
  if (!reviewStale) return update(state, { positions });
  return update(state, {
    positions,
    review: {
      loading: false,
      key: state.review.key,
      moves: [],
      variations: [],
      comment: null,
      root: null,
      side: null,
      hasData: false,
    },
  });
}

/** 服务端试下分支状态归一（T6.8 trial.state：enter/play/pass/undo/back 回执）。 */
function normalizeTrialMove(m) {
  return {
    moveNo: m.move_no !== undefined ? Number(m.move_no) : null,
    color: m.color || null,
    x: m.x === undefined || m.x === null ? null : Number(m.x),
    y: m.y === undefined || m.y === null ? null : Number(m.y),
    isPass: Boolean(m.is_pass),
  };
}

function applyTrialState(state, data) {
  if (!state.game) return state;
  const moves = Array.isArray(data.moves)
    ? data.moves.map(normalizeTrialMove)
    : [];
  const relativeLast =
    data.relative_last !== undefined ? Number(data.relative_last) : moves.length;
  return update(state, {
    trial: {
      id: data.trial_id !== undefined ? data.trial_id : null,
      fromMoveNo: data.enter_move_no !== undefined ? Number(data.enter_move_no) : 0,
      moves,
      relativeLast,
    },
  });
}

/* ============================================================
 * 主 reducer
 * ============================================================ */

/**
 * 纯 reducer：由消息（{type, data}）计算下一状态。
 * 未识别的 type 返回**原引用**（Store 借此跳过通知）；相同逻辑下减少 GC。
 */
export function reduce(state, message) {
  const data = message && message.data;
  switch (message.type) {
    // ---- 服务端权威/对弈 ----
    case 'game.state':
      return applyGameState(state, data);
    case 'move.applied':
      return state.game && !state.trial ? applyMoveApplied(state, data) : state;
    case 'move.undone':
      return state.game && !state.trial ? applyMoveUndone(state, data) : state;
    case 'game.finished':
      return state.game ? applyGameFinished(state, data) : state;

    // ---- 分析结果 / 领地 / 支招 / 深算 ----
    case 'analysis.curve':
      return applyCurve(state, data);
    case 'curve.set':
      return applyCurveSet(state, data);
    case 'position.ownership':
      return applyOwnership(state, data);
    case 'coaching.pending':
      // 客户端发起支招请求：记录目标手数（atMoveNo）供结果过期判定（T6.5）
      return update(state, {
        coaching: {
          loading: true,
          topMoves: [],
          atMoveNo: data && data.move_no !== undefined ? Number(data.move_no) : state.coaching.atMoveNo,
          side: null,
          baseWinrate: null,
        },
      });
    case 'coaching.top5':
      return applyTop5(state, data);
    case 'coaching.reset':
      // 支招请求失败终止（引擎类错误/超时；2026/09/13 人工确认）：复位进行态——
      // 停止按钮呼吸，卡片回退可重试/降级提示
      // （与复盘页 [深度分析] 的 ENGINE_* 错误复位口径一致）
      return clearCoaching(state);
    case 'analysis.comment':
      return applyComment(state, data);
    case 'scoring.prediction':
      return applyPrediction(state, data);
    case 'review.pending':
      return applyReviewPending(state, data);
    case 'review.recommend':
      return applyReviewRecommend(state, data);
    case 'deep.pending':
      return update(state, {
        deepAnalysis: {
          running: true,
          positionKey: data && data.positionKey ? String(data.positionKey) : null,
        },
      });
    case 'deep_analysis.result':
      return applyDeepResult(state, data);
    case 'deep.reset':
      // 深算请求终止（引擎类错误/已在运行等；本地动作，不携带结果；BUG-091）
      return applyDeepReset(state);

    // ---- 全局分析 ----
    case 'global.pending':
      return update(state, { globalAnalysis: { running: true, done: 0, total: 0 } });
    case 'analysis.progress':
      return applyGlobalProgress(state, data);
    case 'global_analysis.done':
      return applyGlobalDone(state, data);
    case 'global.reset':
      // 全局分析请求终止（引擎类错误/任务丢弃；本地动作，无完成语义；M-14）
      return applyGlobalReset(state);

    // ---- 引擎 / 系统 / 管理（全局切片，跨 game.state 保留）----
    case 'engine.status':
      return applyEngineStatus(state, data);
    case 'system.status':
      return update(state, { system: data ? { ...data } : null });
    case 'admin.task':
      return update(state, { adminTask: data ? { ...data } : null });

    // ---- 试下分支（本地动作 / T6.8 服务端 trial.state 权威） ----
    case 'trial.enter':
      return applyTrialEnter(state, data);
    case 'trial.play':
      return applyTrialPlay(state, data);
    case 'trial.undo':
      return applyTrialUndo(state);
    case 'trial.exit':
      return applyTrialExit(state);
    case 'trial.truncate':
      return applyTrialTruncate(state, data);
    case 'trial.state':
      return applyTrialState(state, data);

    default:
      return state;
  }
}

/* ============================================================
 * Store 壳（DOM 无关，可在无头环境运行）
 * ============================================================ */

/**
 * 创建 Store：dispatch 内部走纯 reduce，仅当状态引用变化时通知订阅者。
 * @param {Function} [reducer=reduce]
 * @returns {{ getState():object, dispatch(message):object, subscribe(fn):()=>void }}
 */
export function createStore(reducer = reduce) {
  let state = createInitialState();
  const listeners = new Set();

  return {
    getState() {
      return state;
    },
    dispatch(message) {
      const next = reducer(state, message);
      if (next !== state) {
        state = next;
        for (const listener of [...listeners]) {
          try {
            listener(state, message);
          } catch (err) {
            // 订阅方异常不得中断其它订阅者（精确捕获见 AGENTS §5）
            console.error('[state] listener 异常：', err);
          }
        }
      }
      return next;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** 全局单例 Store（壳 / 视图 / WS Hub 共用；无头测试请用 `createStore()` 建独立实例）。 */
export const store = createStore();
