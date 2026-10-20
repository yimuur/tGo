/**
 * tGo · 对弈工作台 · 基础流（T6.4，GameView 核心）
 *
 * 职责（TASK.md T6.4 / UI_UX §5.2 / §6.2 / §10）：
 *   - **控制器**：驱动状态树 / 通信层 / GameBoard，不直写 canvas（AGENTS §4）；
 *   - 断点恢复：localStorage 最近对局 → WS ``/ws/games/{id}``（open 后自动
 *     ``restore.request`` 全量对齐）；无记录 → ``GET /games/active-latest``；
 *     恢复失败（不存在/已结束）→ 清理 localStorage + Toast + 空态；
 *   - 落子闭环：``play {x,y}`` → 等待 ``game.state``；落子**先经本地围棋规则预校验**
 *     （``core/go-rules.js``，与后端同语义：越界/占点/打劫/禁入点）——非法即时
 *     棋盘红 ✕ + 原因 Toast（**不发送**服务器）；服务端仍为唯一裁决者，
 *     ``ILLEGAL_MOVE`` 兜底同样红 ✕ + Toast；PASS / 悔棋（剩余次数）/ 认输 / 重开；
 *     人机 ``TURN_AI``：本地 pending「思考中」胶囊 + 指令防堆积（busy 禁输入）；
 *     引擎恢复后 / AI 先行（人类执白·让子局）经 WS ``start`` 自动触发 AI 落子
 *     （T6.4 后端新增协议）；
 *   - 引擎降级矩阵联动：DEAD/FATAL → 人机棋盘灰化 + 警示条 [重试]/[去管理页]；
 *     STOPPED 未启动 / INIT 加载中 → 分析类灰置（T6.5）不影响落子；
 *   - 双 PASS / 认输 / 无子可下 → 终局结算（T6.6）：``scoring``/``finished`` 时侧栏
 *     替换为 ScoringPanel（scoring-panel.js）：死子确认（ownership 预判 + 点击切换 ✕）
 *     → 数子结果 + 领地 + [再来一局/复盘/对局报告/结束]；``scoring.cancel`` 回对弈；
 *     结算取消/再来一局/结束 均经本控制器（WS/API/棋盘权限）；
 *   - 侧栏/抽屉（T6.5）接入：对弈侧栏（C5 信息卡/C6 曲线/C7 支招）+ 底部 [领地]/
 *     [支招] 按钮 + 移动端 C16 胜率条/分析抽屉（模块见 game-sidebar.js）。
 *   - 支招行点击 → 变化图预览（2026/09/18；行为/UI 同复盘页，见下方预览节）。
 *
 * T6.4 人工验收修订（2026/09/06）：
 *   - **提子数**：接入自绘 ``CaptureCounter``（内核版，自 C1 ``GoCaptureCounter``
 *     提取动画逻辑，见 core/capture-counter.js；石径随承载宽度动态适配并限幅
 *     [min,max]、主题经 rAF 即时同步，不再直接 import component 审核稿）；
 *     提子增减即时更新、执色大小切换过渡 + 当前方呼吸；
 *   - **人人对弈悔棋**：**仅单步（撤 1 手）**、不限次数、需对方确认——申请经
 *     ``undo.request`` 广播对端弹窗，``undo.respond`` 同意/拒绝，申请方可再次点
 *     「取消悔棋申请」撤回；人机对弈维持 ISSUE-039 上限直通（无确认，1/2 步语义）。
 *
 * 纯函数层（deriveUi / deriveEntry / emptyCopy 等）与 DOM 组件同文件拆分（主题/尺寸
 * 纯函数归 core/capture-counter.js），顶层无 DOM 副作用 → 无头可测（FE-GAME-*）。
 */

import { GameBoard } from '../core/board.js';
import { CaptureCounter } from '../core/capture-counter.js';
import { createLocalStore, LS_KEYS } from '../core/localstore.js';
import { pctCompact, signedPct } from '../core/fmt.js';
import { getPreviewSteps } from '../core/settings.js';
import { mainKey } from '../core/state.js';
import { checkMoveOnGame, illegalMoveText, lastMoveCaptures } from '../core/go-rules.js';
import { createInfoPop, groupMetaSegments, metaPopText } from '../core/info-row.js';
import { applyIconLit, iconLitPlan } from '../core/btn-lit.js';
import {
  createTerritoryTimeout,
  territoryButtonClasses,
  territoryButtonView,
  territoryClickIntent,
  territoryHeatPlan,
  territoryRequestAction,
  territoryWatchdogAction,
} from '../core/territory.js';
import {
  createSidebarModule,
  coachPreviewPoints,
  deriveWinrateCard,
  analysisButtons,
  wrBarAction,
  TERRITORY_NO_DATA_TEXT,
} from './game-sidebar.js';
import {
  createScoringPanelModule,
  settleBoardNote,
} from './scoring-panel.js';
import {
  isHumanAi,
  isInPlay,
  boardInteractive,
  boardEngineDead,
  engineDown,
  aiWaitVisible,
  aiWaitLabel,
  aiRetryPlan,
  aiShouldAutoStart,
  needsHumanModel,
  undoRemaining,
  undoLabel,
  metaSegments,
  lastMoveDesc,
  capturesState,
  aiColorOf,
  boardColor,
  stonesForGame,
  dropUpSide,
  commentBubbleModel,
} from '../core/game-model.js';
import { boardBubblePlacement, commentBubbleHTML } from '../core/comment-bubble.js';

/* ============================================================
 * 纯函数层（无 DOM；可无头测试）
 * ============================================================ */

/** 恢复候选解析：localStorage 最近对局优先，其次 active-latest。 */
export function deriveEntry(recent, activeLatest) {
  const recentId = recent && Number(recent.gameId);
  if (Number.isInteger(recentId) && recentId > 0) return { gameId: recentId, source: 'recent' };
  const activeId = activeLatest && Number(activeLatest.id);
  if (Number.isInteger(activeId) && activeId > 0) return { gameId: activeId, source: 'active' };
  return { gameId: null, source: 'none' };
}

/**
 * 状态树 + 本地标志 → 视图派生（一次性计算，DOM 只做呈现）。
 * @param {object} p
 * @param {object|null} p.game        store.game
 * @param {string} [p.engineState=''] 引擎状态（STOPPED/IDLE/INIT/ANALYZING/DEAD/FATAL）
 * @param {object} [p.flags]          { busy:boolean, undoWaiting:boolean }
 *                                    undoWaiting=人人对弈悔棋申请待对手确认（取消入口）
 * @param {number} [p.maxUndo=0]      config.play.max_undo（悔棋上限，仅人机适用）
 * @param {boolean} [p.showMatchRank=true] 显示当前 AI 匹配档位（自适应时关=「AI 自适应」）
 * @param {boolean} [p.humanModelAvailable=true] 人类模型可用性（未知=true 不阻断；
 *                                    B2：人类风格/自适应对局在缺失时 AI 阻断并由 UI 提示）
 * @param {object|null} [p.coach=null] 自动点评开关态（`{enabled}`；开启点评的对局
 *                                    信息行追加可点击徽章段，人工口径 2026/09/10）
 */
export function deriveUi({
  game = null,
  engineState = '',
  flags = {},
  maxUndo = 0,
  showMatchRank = true,
  humanModelAvailable = true,
  coach = null,
} = {}) {
  const busy = Boolean(flags.busy);
  const waitUndo = Boolean(flags.undoWaiting);
  const locked = busy || waitUndo; // 等待（AI/悔棋确认）期间锁定落子等操作
  const status = game ? game.status : null;
  const inPlay = status === 'active' || status === 'created';
  const humanAi = isHumanAi(game);
  const unlimited = !humanAi; // 人人对弈悔棋不限制次数（T6.4 人工确认 2026/09/06）
  const interactive = boardInteractive(game, locked);
  const aiWait = aiWaitVisible(game, locked);
  const engineDownNow = engineDown(engineState);
  const canAct = inPlay && !locked;
  const hasMoves = Boolean(game && game.moves && game.moves.length);
  const remaining = undoRemaining(game, maxUndo);
  const note = game ? lastMoveDesc(game.moves, game.params && game.params.boardSize) : null;
  // 人类模型阻断（B2，2026/09/10 人工决策）：人类风格/自适应对局 + 引擎未挂载人类模型
  const humanModelBlocked = needsHumanModel(game) && humanModelAvailable === false;

  let terminal = null;
  if (status === 'scoring') {
    terminal = { kind: 'scoring', title: '对局已进入结算', canCancel: true };
  } else if (status === 'finished') {
    terminal = { kind: 'finished', title: '对局已结束', result: game.result || null };
  }

  // 悔棋可用性：
  // - 人机：未达上限 + 有子——空闲（canAct）或 AI 思考期（busy）均可直通；
  //   AI 思考期点击＝服务端终止在途 AI 应手查询后撤 1 步（2026/09/13 人工决策）；
  // - 人人：无上限；空闲可申请、等待确认期间保持可用以「取消悔棋申请」
  let undoEnabled = false;
  if (unlimited) {
    undoEnabled = status === 'active' && hasMoves && !busy;
  } else {
    // 人机：AI 思考期（busy）同样可悔棋——服务端终止在途 AI 应手查询（撤 1 步，
    // 2026/09/13 人工决策）；undoPending 仅行为防抖（sendUndo 忽略重复点击），
    // **不参与视觉**——曾因发送瞬间置灰/整行重绘，被服务端快速拒绝（如剩 1 次
    // 需撤 2 步）时闪烁（2026/09/13 修复）；
    // 用 inPlay 而非 active：刚落首手、game.state 未回时 status 尚为 created
    // （defer 模式下 AI 思考期不广播 game.state），该窗口悔棋必须可用
    const undoWindow = canAct || (busy && !waitUndo);
    undoEnabled = undoWindow && inPlay && remaining > 0 && hasMoves;
  }
  const undoLabelTxt = unlimited
    ? waitUndo ? '取消悔棋申请' : '悔棋'
    : undoLabel(remaining);

  // —— 计数控件“当前方”（大子=当前手）——
  // capturesState.toMove 取 store.next_color；人机 AI 思考/待行期（aiWait 可见，
  // 人类刚落子或 TURN_AI 挂起）服务端在 AI 执行完成前不会推进 next_color →
  // 本地兜底：当前方 = AI 执色，使计数控件随当前手变化。
  const capsState = capturesState(game);
  let capsToMove = capsState.toMove;
  if (humanAi && aiWait && game && game.params && game.params.humanColor) {
    capsToMove = boardColor(aiColorOf(game));
  }
  const captures = { black: capsState.black, white: capsState.white, toMove: capsToMove };

  return {
    status,
    humanAi,
    inPlay,
    meta: metaSegments(game, { showMatchRank, coach }),
    note,
    captures,
    interactive,
    engineDown: engineDownNow,
    engineDead: boardEngineDead(game, engineState),
    aiWait: aiWait
      ? {
        label: aiWaitLabel(engineState, {
          humanModelUnavailable: humanModelBlocked,
          aiPending: game && game.aiPending,
        }),
        // 服务端挂起原因（R2）：胶囊 title 展示（如「AI 落子引擎查询失败: …」）
        code: (game && game.aiPending && game.aiPending.code) || null,
        title: (game && game.aiPending && game.aiPending.message) || '',
      }
      : null,
    humanModelBlocked,
    warn: Boolean(humanAi && (engineDownNow || humanModelBlocked)),
    autoStart: aiShouldAutoStart(game, engineState, locked, {
      humanModelUnavailable: humanModelBlocked,
    }),
    undo: { remaining, label: undoLabelTxt },
    undoWaiting: waitUndo,
    actions: {
      pass: canAct && interactive,
      undo: undoEnabled,
      resign: canAct && status === 'active',
      restart: canAct && status === 'active',
    },
    terminal,
  };
}

/** 空态文案（§5.2.8）：区分「无进行中对局」与「恢复失败」。 */
export function emptyCopy(kind) {
  return kind === 'restore-fail'
    ? { title: '对局不存在或已结束', text: '最近对局记录已清理，可创建新对局继续体验' }
    : { title: '还没有进行中的对局', text: '创建一局 或 前往复盘页查看已结束对局' };
}

/**
 * 自动 start（开局/续行）的**单回合单发**决策（BUG-093）。
 *
 * 根因：旧实现的重发令牌含 `status` 与 `engineState`——进入 AI 先行新局时它们会
 * 连续抖动（`created→active`、引擎 `INIT/ANALYZING/IDLE`，且 admin 与 game 两路
 * socket 到达次序不保证）→ 同一回合被重复发 `start`；迟到的那条落在 AI 已落子之后，
 * 服务端以 `ILLEGAL_ACTION`（当前无需开局或 AI 落子）拒绝 → 壳层弹
 * 「当前状态不允许该操作」（对局 #167 创建时即中）。
 *
 * 现口径：重发令牌＝**“轮到谁”**（`gameId:nextColor`）——仅当回合真正交回 AI（中间必先观察到离开 AI 的帧）才允许重发；
 * **瞬态锁（`busy`/引擎不可用/人类模型缺失）只 skip、不得清标记**（旧实现在 `busy` 下
 * `autoStart=false` → 清标记 → 解锁后再发一次，正是重复 start 的直接推手）；失败后的
 * 重试由错误路径**清空**标记（引擎恢复等下一次 store 变更自然重试）。
 * 另加三条防护：① `busy` 在途不重发；② `game` 切片必须属于**当前连接的对局**；
 * ③ **令牌不得含 `lastMoveNo`**——`move.applied` 先推进末手数而 `nextColor` 要到随后的
 * `game.state` 才更新，该窗口内“新键”会误判新回合（#183 实测复现：AI 首手落定后 24ms
 * 重发 start → `ILLEGAL_ACTION` 拒绝 → 误弹「当前状态不允许该操作」）。
 * @param {{game?:object, targetId?:number|null, busy?:boolean, startKey?:string|null,
 *          ready?:boolean}} opts ready＝当前允许发起（`ui.autoStart`：引擎可用/人类模型可用等）
 * @returns {{action:'send'|'skip'|'reset', key:string|null}}
 */
export function autoStartAction(opts = {}) {
  const game = opts.game;
  const startKey = opts.startKey === undefined ? null : opts.startKey;
  // 回合已离开 AI（非人机 / 已终局 / 轮到人类）→ 复位标记（允许新回合再次触发）
  if (
    !game
    || !isHumanAi(game)
    || !isInPlay(game)
    || game.nextColor !== aiColorOf(game)
  ) {
    return { action: 'reset', key: null };
  }
  const targetId = opts.targetId == null ? null : Number(opts.targetId);
  const gameId = Number(game.gameId);
  if (opts.busy || targetId === null || gameId !== targetId || !opts.ready) {
    return { action: 'skip', key: startKey };
  }
  const key = `${gameId}:${game.nextColor}`;
  return key === startKey ? { action: 'skip', key } : { action: 'send', key };
}

/**
 * WS **终态关闭**（服务端 4404 对局不存在/已删除，`ws-client` 标记 `terminal`）的处置（BUG-092）。
 *
 * 终态关闭是领域事实（非网络异常）：不必再等 `RESTORE_TIMEOUT_MS` 的 REST 兜底探测，
 * 立即判恢复失败（清最近对局记录 + 关通道 + 领域提示 + 空态面板）；
 * 空态下不重复处置（防重复提示）。
 * @param {{type?:string, channel?:string, terminal?:boolean}} ev 通道生命周期事件
 * @param {string} phase 当前阶段（`restoring`/`game`/`empty`…）
 * @returns {'fail-restore'|'none'}
 */
export function goneCloseAction(ev, phase) {
  if (!ev || ev.channel !== 'game' || ev.type !== 'closed' || !ev.terminal) return 'none';
  return phase === 'empty' ? 'none' : 'fail-restore';
}

/**
 * ``move.applied`` 到达时是否**立即解除在途提交锁（busy）**（2026/09/18 人工反馈）。
 *
 * 人人对弈无 AI 应手等待：提交回调即时广播的 ``move.applied`` 就是本轮提交窗口的
 * 结束回执 → 必须同帧解锁，否则紧随的 `syncAll` 会以「等待中」把全部操作按钮置灰，
 * 待其后的 `game.state` 又立即解禁 —— 每次落子按钮闪烁一下（实测 disabled 窗口
 * 约 20ms，跨越 1–2 帧）。
 *
 * 人机（含自适应）**不得**在 ``move.applied`` 解锁：AI 应手仍在进行（BUG-094——
 * 解锁会令回合派生回落陈旧快照：计数器翻转、棋盘误可点），一律等 `game.state`。
 * @param {object|null} game 归约后的 `state.game`
 * @returns {boolean}
 */
export function moveAppliedUnlocksBusy(game) {
  return Boolean(game) && !isHumanAi(game);
}

/** 人类模型不可用警示文案（B2，2026/09/10 人工决策）。 */
export const HUMAN_MODEL_WARN_TEXT = '人类模型不可用：无法继续人类风格对局，请恢复人类模型后重试';

/**
 * 引擎异常警示条文案（DEAD/FATAL 分叉）。
 *
 * 2026/09/20 人工决策（ISSUE-069）：启动/重启入口收敛到管理页——对弈页不再提供
 * [重试] 按钮（DEAD 期间点击会被后端快速失败，且失败回执不可见 → 假受理），只给
 * 状态说明与去向指引（警示条已带 [去管理页] 链接）。
 * @param {string|null|undefined} state 引擎状态
 * @returns {string}
 */
export function engineAbnormalWarnText(state) {
  return String(state || '').toUpperCase() === 'FATAL'
    ? '引擎已停止，AI 功能暂停（请到管理页 [手动重启]）'
    : '引擎异常，AI 功能暂停（自动重启中）';
}

/**
 * 悔棋申请终态（``undo.declined``）的处置派生（纯函数，R3）。
 *
 * reason：``declined``（对方拒绝）/ ``withdrawn``（撤回）/ **``failed``（服务端执行
 * 失败，R3 新增）**——失败时申请已清除且无其它终态事件，申请方与响应方都须
 * 收敛等待态并得到解释（否则申请方 ``undoWaiting`` 残留）。
 * @returns {{clearWaiting:boolean, toast:null|{level:string,text:string,key:string}}}
 */
export function undoDeclinedOutcome(data = {}, waiting = false) {
  const reason = data.reason === 'declined'
    ? 'declined'
    : (data.reason === 'failed' ? 'failed' : 'withdrawn');
  if (reason === 'failed') {
    return {
      clearWaiting: true,
      toast: {
        level: 'error',
        text: `悔棋未完成：${data.message || '局面已变化'}`,
        key: 'undo-failed',
      },
    };
  }
  if (!waiting) return { clearWaiting: false, toast: null }; // 对端：仅关弹窗，不提示
  return {
    clearWaiting: true,
    toast: {
      level: 'info',
      text: reason === 'withdrawn' ? '已取消悔棋申请' : '对方拒绝了悔棋申请',
      key: `undo-${reason}`,
    },
  };
}

/**
 * 认输确认文案（纯函数，O4）：人机对局认输方恒为**人类方**（服务端按人类执色
 * 归属）；人人对弈无账号身份，按**当前回合方**判定（2026/09/16 评审确认：保持现状）。
 */
export function resignConfirmText(g) {
  return isHumanAi(g)
    ? '确认认输？本手后对局立即结束。'
    : '确认认输？本手后对局立即结束（认输方按当前回合判定）。';
}

/* ============================================================
 * GameView 控制器
 * ============================================================ */

/** 恢复候选连接后未见 game.state 的兜底探测窗口（UI_UX §10）。 */
const RESTORE_TIMEOUT_MS = 8000;
/** busy 兜底超时（防服务端静默丢失导致永久禁输入）。 */
const BUSY_TIMEOUT_MS = 20000;
/** Worker 应答超时（L-10）：无应答则回收挂起条目并回退主线程量化值。 */
const WORKER_REPLY_TIMEOUT_MS = 1500;
/** 变化图预览每步时长 ms（固定速度，与复盘页一致；预览步数读本地偏好 5–15）。 */
const PREVIEW_STEP_MS = 700;

export function createView(rootEl, props) {
  const { route } = props;
  const store = props.store;
  const api = props.api;
  const hub = props.hub;
  const ls = props.ls || createLocalStore();
  const toast = props.toast || (() => {});
  const confirmDialog = props.confirm || (() => Promise.resolve(false));
  // T6.4：可撤销确认框（悔棋申请被对方处理/撤回时自动关闭对端弹窗）
  const confirmAbortable = props.confirmAbortable || null;
  const nav = props.nav || ((h) => {
    location.hash = h;
  });
  const audio = props.audio || null;
  const immersive = props.immersive || null;

  /** 控制器状态（视图生命周期内单例）。 */
  const self = {
    phase: 'init', // init | restoring | game | empty
    emptyKind: 'none',
    targetId: null,
    lastGameId: null,
    flags: { busy: false, undoWaiting: false, undoPending: false },
    busyTimer: null,
    restoreTimer: null,
    //: 自动 start 的回合身份（`gameId:末手数:轮次`；单回合单发，见 autoStartAction/BUG-093）
    startKey: null,
    //: AI 应手失败（ai_pending）有界自动重试（R2）：{key, attempts, scheduled, timer}
    aiRetry: { key: null, attempts: 0, scheduled: false, timer: null },
    lastPlay: null,
    maxUndo: 5,
    board: null,
    counter: null, // CaptureCounter（core/capture-counter.js）实例
    sidebar: null, // 对弈侧栏模块（game-sidebar.js，T6.5）
    // T6.6 终局结算（scoring-panel.js）：模块实例 / 状态沿 / 死子集合 / 再来一局防重
    settlePanel: null,
    lastStatus: null,
    inSettle: false,
    settleDead: [],
    rematching: false,
    worker: null, // 领地量化 Worker（惰性创建）
    workerSeq: 0,
    workerPending: new Map(), // id → resolve（Worker 量化请求应答回调）
    workerTimers: new Map(), // id → setTimeout（L-10：无应答回收）
    terr: {
      active: false, // 领地热力显示中
      auto: false, // 每步自动连续模式（U-17 双击）
      pending: false, // 已向服务端请求当前局面
      reqMove: null, // 已请求/已应用热力所针对的手数
      explicit: false, // 本次请求来自用户显式点击（决定空态是否 Toast）
      _notifiedKey: null, // 无数据提示去重（每局面一次）
      doubleTimer: null, // 双击判定
      timeout: null, // 请求超时闸（core/territory.createTerritoryTimeout）
    },
    // 图标点亮（2026/09/17）：[支招] 图标；存上一帧值以判定「数据到达」触发闪光
    coachLit: false,
    curveBackfilled: null, // 已 REST 回填曲线的 gameId
    // 自动点评（人工口径 2026/09/11）：仅创建时开启点评的对局可用；默认开启；
    // 点评由**每手标准分析派送**（`analysis.comment`，引擎相关实时数据，落子方视角）；
    // 保留**最近 2 手**圆点（方便查看自己上一手评价），点击点评手棋子显示文案气泡。
    coach: { enabled: true, bubbleMoveNo: null },
    // 变化图预览（支招候选→棋盘逐步动画，2026/09/18）：{pts, step, playing, timer, gameKey}
    preview: null,
    _undoPrompt: null, // { requestId, dismiss } 本机待确认弹窗句柄
    _undoSentAt: 0, // 悔棋申请双击防抖时间戳
    renderedStones: [],
    _boardSize: null,
    menuOpen: false,
    metaText: '', // 信息行全文（移动端行首图标弹层内容）
    infoPop: createInfoPop(), // 「全部对局信息」顶层弹层（2026/09/13 移动端）
    wrShown: false, // 胜率条已渲染过（保留式加载：防“空态↔条”闪烁）
    unsub: null,
    onError: null,
    onCreated: null,
    onControl: null,
    _docClick: null,
    _escKey: null,
    _resizeNote: null,
    _noteRect: null, // 棋盘左上角提示矩形缓存（相对棋盘容器；缩放/平移期间零 DOM 读取）
    _noteSettle: false, // 提示当前为结算文案（不降级，保持胶囊可读）
  };

  let destroyed = false;

  /* ---------------- 工具 ---------------- */

  function q(sel) {
    return rootEl.querySelector(sel);
  }

  function playSound(name) {
    if (audio && typeof audio.play === 'function') audio.play(name);
  }

  function armBusyTimer() {
    clearBusyTimer();
    self.busyTimer = setTimeout(() => {
      self.busyTimer = null;
      clearBusy();
    }, BUSY_TIMEOUT_MS);
  }

  function clearBusyTimer() {
    if (self.busyTimer) {
      clearTimeout(self.busyTimer);
      self.busyTimer = null;
    }
  }

  function clearBusy() {
    self.flags.busy = false;
    self.flags.undoPending = false;
    clearBusyTimer();
  }

  /** AI 应手失败重试计时器清理（换局/销毁/挂起消失）。 */
  function clearAiRetryTimer() {
    if (self.aiRetry.timer) {
      clearTimeout(self.aiRetry.timer);
      self.aiRetry.timer = null;
    }
    self.aiRetry.scheduled = false;
  }

  /** 解除「人人悔棋申请待确认」等待态（服务端已解决：同意/拒绝/撤回/终局）。 */
  function clearUndoWait() {
    self.flags.undoWaiting = false;
  }

  /** 订阅 store 变更 → 统一同步（WS 回调不直写 DOM；AGENTS §4）。 */
  function subscribe() {
    if (self.unsub) return;
    self.unsub = store.subscribe((state, message) => {
      if (!destroyed) onStoreChange(state, message || {});
    });
  }

  /** 订阅 tgo:game-msg（人人悔棋确认控制消息，经 ws-client CONTROL_TYPES 分流）。 */
  function bindControl() {
    if (self.onControl) return;
    self.onControl = (e) => {
      if (destroyed) return;
      const ev = e && e.detail;
      if (!ev || !ev.type) return;
      if (ev.type === 'undo.request') {
        askUndoConfirm(ev);
      } else if (ev.type === 'undo.declined') {
        onUndoDeclined(ev);
      }
    };
    window.addEventListener('tgo:game-msg', self.onControl);
  }

  /**
   * 订阅通道生命周期：对局不存在/已删除（终态关闭 4404）→ 立即判恢复失败
   * （不再等 8s REST 兜底探测；BUG-092）。
   */
  function bindStatus() {
    if (self.unsubStatus || typeof hub.subscribeStatus !== 'function') return;
    self.unsubStatus = hub.subscribeStatus((ev) => {
      if (destroyed) return;
      if (goneCloseAction(ev, self.phase) === 'fail-restore') failRestore('GAME_NOT_FOUND');
    });
  }

  /** 当前派生态（同步与动作共用）。 */
  function currentUi() {
    const s = store.getState();
    return deriveUi({
      game: s.game,
      engineState: s.engine && s.engine.state,
      humanModelAvailable: s.engine && s.engine.humanModelAvailable,
      flags: self.flags,
      maxUndo: self.maxUndo,
      showMatchRank: self.showMatchRank,
      coach: { enabled: self.coach.enabled },
    });
  }

  /* ---------------- 对外生命周期 ---------------- */

  function render() {
    rootEl.className = 'layout game';
    rootEl.innerHTML = '';
    // 本地偏好（T6.10）：显示当前 AI 匹配档位（关时自适应信息行显示 `AI 自适应`）
    self.showMatchRank = ls.get(LS_KEYS.showAiMatch, true) !== false;
    subscribe();
    bindControl();
    bindStatus();
    beginRecovery();
  }

  function destroy() {
    destroyed = true;
    if (self.unsub) {
      self.unsub();
      self.unsub = null;
    }
    if (self.unsubStatus) {
      self.unsubStatus();
      self.unsubStatus = null;
    }
    if (self.onError) {
      window.removeEventListener('tgo:error', self.onError);
      self.onError = null;
    }
    if (self.onCreated) {
      window.removeEventListener('tgo:game-created', self.onCreated);
      self.onCreated = null;
    }
    if (self.onControl) {
      window.removeEventListener('tgo:game-msg', self.onControl);
      self.onControl = null;
    }
    if (self._undoPrompt) {
      // 视图销毁时关闭待确认弹窗（等同取消，不发送响应）
      self._undoPrompt.dismiss();
      self._undoPrompt = null;
    }
    if (self._docClick) {
      document.removeEventListener('pointerdown', self._docClick, true);
      self._docClick = null;
    }
    if (self._escKey) {
      document.removeEventListener('keydown', self._escKey, true);
      self._escKey = null;
    }
    if (self._resizeNote) {
      window.removeEventListener('resize', self._resizeNote);
      self._resizeNote = null;
    }
    clearBusyTimer();
    clearAiRetryTimer();
    if (self.restoreTimer) {
      clearTimeout(self.restoreTimer);
      self.restoreTimer = null;
    }
    closePreviewState(); // 变化图预览：清计时器 + 解除棋盘守卫（2026/09/18）
    if (self.board) {
      self.board.destroy();
      self.board = null;
    }
    if (self.counter) {
      self.counter.destroy();
      self.counter = null;
    }
    // T6.5：侧栏模块（含抽屉事件）与领地 Worker
    if (self.sidebar) {
      self.sidebar.destroy();
      self.sidebar = null;
    }
    // T6.6：结算面板（store 订阅 / 断点监听 / 预判超时）
    if (self.settlePanel) {
      self.settlePanel.destroy();
      self.settlePanel = null;
    }
    // 「全部对局信息」弹层（2026/09/13 移动端信息行）
    if (self.infoPop) {
      self.infoPop.destroy();
      self.infoPop = null;
    }
    self.inSettle = false;
    self.lastStatus = null;
    if (self.terr.doubleTimer) {
      clearTimeout(self.terr.doubleTimer);
      self.terr.doubleTimer = null;
    }
    if (self.terr.timeout) {
      self.terr.timeout.cancel();
      self.terr.timeout = null;
    }
    self.terr.active = false;
    self.terr.auto = false;
    self.terr.pending = false;
    if (self.worker) {
      self.workerTimers.forEach((timer) => clearTimeout(timer));
      self.workerTimers.clear();
      self.workerTimers.forEach((timer) => clearTimeout(timer));
      self.workerTimers.clear();
      self.workerPending.clear();
      try {
        self.worker.terminate();
      } catch {
        /* 已终止 */
      }
      self.worker = null;
    }
    if (immersive && immersive.isActive()) immersive.exit();
    if (hub && typeof hub.closeGame === 'function') hub.closeGame();
    self.phase = 'init';
    rootEl.innerHTML = '';
  }

  /* ---------------- 恢复流（§5.2.8） ---------------- */

  function writeRecent(gameId) {
    ls.set(LS_KEYS.recent, { gameId, ts: Date.now() });
  }

  function clearRecent() {
    ls.remove(LS_KEYS.recent);
  }

  async function beginRecovery() {
    // 悔棋上限来自 config.play.max_undo（UI_UX W-03：剩余 = 上限 − undo_count）
    try {
      const cfg = await api.get('/admin/config');
      const v = cfg && cfg.data && cfg.data.play && cfg.data.play.max_undo;
      if (Number.isFinite(Number(v))) self.maxUndo = Number(v);
    } catch {
      /* 默认 5（config.yaml 默认值）；获取失败不阻断对弈 */
    }
    if (!self.onCreated) {
      self.onCreated = (e) => {
        const gid = e && e.detail && e.detail.gameId;
        if (destroyed || !gid) return;
        if (self.phase === 'empty' || self.phase === 'init') connectTo(gid);
      };
      window.addEventListener('tgo:game-created', self.onCreated);
    }
    if (!self.onError) {
      self.onError = (e) => {
        const ev = e && e.detail; // CustomEvent 载荷在 detail（tgo:error）
        if (destroyed || !ev || ev.channel !== 'game') return;
        onGameError(ev);
      };
      window.addEventListener('tgo:error', self.onError);
    }

    // 1) localStorage 最近对局
    const recent = ls.get(LS_KEYS.recent, null);
    const entry = deriveEntry(recent, null);
    if (entry.source === 'recent') {
      connectTo(entry.gameId, true);
      return;
    }
    // 2) active-latest 兜底
    setPanel('loading', '正在查找进行中的对局…');
    let active = null;
    try {
      const res = await api.get('/games/active-latest');
      active = res && res.data;
    } catch {
      setPanel('loading', '正在恢复对局…');
    }
    if (destroyed) return;
    const entry2 = deriveEntry(null, active);
    if (entry2.source === 'active') {
      writeRecent(entry2.gameId);
      connectTo(entry2.gameId, false);
    } else {
      showEmpty('none');
    }
  }

  function connectTo(gameId, fromRecent) {
    self.targetId = Number(gameId);
    self.lastGameId = null;
    self.phase = 'restoring';
    clearStartKey(); // 换局：回合身份基准重置（新局 gameId 已换，防旧标记干扰）
    setPanel('loading', fromRecent ? '正在恢复对局…' : '正在连接对局…');
    hub.connectGame(self.targetId);
    // 兜底探测：连接后长时间未见 game.state → REST 校验存在性
    self.restoreTimer = setTimeout(() => {
      self.restoreTimer = null;
      if (!destroyed && self.phase === 'restoring') probeRestore();
    }, RESTORE_TIMEOUT_MS);
  }

  async function probeRestore() {
    if (!self.targetId || destroyed) return;
    try {
      await api.get(`/games/${self.targetId}`);
      if (!destroyed) setPanel('loading', '正在恢复对局…');
    } catch (err) {
      if (destroyed) return;
      const code = (err && err.code) || '';
      if (code === 'GAME_NOT_FOUND' || code === 'GAME_FINISHED' || err.status === 404) {
        failRestore(code);
      } else {
        setPanel('loading', '正在恢复对局…');
      }
    }
  }

  function failRestore(code) {
    clearRecent();
    if (hub && typeof hub.closeGame === 'function') hub.closeGame();
    // M-10（2026/09/19 修复）：先销毁对局壳（棋盘/提子控件/侧栏的 rAF 循环与
    // store 订阅、后台计时器）再切空态 DOM——旧实现只换面板：恢复失败后旧壳
    // 对象继续后台绘制/订阅（内存与 CPU 泄漏，直到下次建壳才被覆盖）。
    teardownShell();
    if (code === 'GAME_FINISHED') {
      toast({ level: 'info', text: '该对局已在其他设备结束' });
    } else {
      toast({ code: code || 'GAME_NOT_FOUND', message: '对局不存在' });
    }
    showEmpty('restore-fail');
  }

  function showEmpty(kind) {
    self.phase = 'empty';
    self.emptyKind = kind;
    renderEmpty();
  }

  /* ---------------- DOM 面板 ---------------- */

  function gameShellHTML() {
    return `
    <section class="board-zone">
      <div class="warn-banner u-hide" data-ref="warnBanner" role="alert">
        <svg class="icon" style="color:var(--c-blunder)" aria-hidden="true"><use href="#i-error"/></svg>
        <span data-ref="warnText">引擎异常，AI 功能暂停</span>
        <a class="btn btn-ghost btn-sm" href="#/admin">去管理页</a>
      </div>
      <div class="info-row">
        <button class="btn btn-ghost info-icon" type="button" data-act="infoPop"
                title="对局信息" aria-label="对局信息（点击看全部）">
          <svg class="icon" aria-hidden="true"><use href="#i-info"/></svg>
        </button>
        <div class="info-meta num" data-ref="infoMeta"></div>
        <div class="info-actions">
          <button class="btn btn-ghost" type="button" data-act="resign">认输</button>
          <button class="btn btn-ghost" type="button" data-act="restart">重开</button>
          <button class="btn btn-ghost" type="button" data-act="immersive"
                  title="沉浸模式" aria-label="沉浸模式">
            <svg class="icon" aria-hidden="true"><use href="#i-immersive"/></svg>
          </button>
        </div>
        <button class="btn btn-ghost menu-more" type="button" data-act="more"
                title="更多" aria-label="更多操作" aria-expanded="false">
          <svg class="icon" aria-hidden="true" style="width:17px;height:17px"><use href="#i-more"/></svg>
        </button>
      </div>
      <div class="board-wrap" data-ref="boardWrap">
        <div class="board-note u-hide" data-ref="boardNote"></div>
        <div class="think-capsule u-hide" data-ref="thinkCapsule" role="status" aria-live="polite">
          <span class="t-dot" aria-hidden="true"></span><span data-ref="thinkText">思考中</span>
        </div>
      </div>
      <div class="bottom-row">
        <!-- C16 黑白胜率条（≤767 显示于棋盘下方居中；≥768 侧栏可见时不重复显示，UI_UX §5.2.5）
             role=img + 动态 aria-label：画布/色块数值读屏不可得，标签随渲染同步 -->
        <div class="wr-bar" data-ref="wrBar" role="img" aria-label="黑白胜率"></div>
        <div class="captures" data-ref="captures"></div>
        <div class="bottom-actions">
          <button class="btn btn-secondary" type="button" data-act="pass" title="当前方 pass">PASS</button>
          <button class="btn btn-secondary" type="button" data-act="undo" title="悔棋：剩余次数">悔棋</button>
          <!-- 2026/09/17 人工调整：[支招] 与 [领地] 互换位置（支招在左、领地在右） -->
          <button class="btn btn-primary" type="button" data-act="coach" title="实时支招 TOP5">
            <svg class="icon" aria-hidden="true"><use href="#i-coach"/></svg>支招
          </button>
          <button class="btn btn-secondary" type="button" data-act="territory" title="显示/隐藏热力；双击开启“每步自动”连续模式">
            <svg class="icon" aria-hidden="true"><use href="#i-territory"/></svg>领地
            <span class="dot u-hide" data-ref="terrDot" aria-hidden="true"></span>
          </button>
        </div>
      </div>
      <div class="preview-chip u-hide" data-ref="gvPreviewChip" role="status">
        <span class="pv-text" data-ref="gvPreviewText"><span class="pv-label" data-ref="gvPreviewLabel">变化图预览</span> <span class="pv-count num" data-ref="gvPreviewCount">0/0</span></span>
        <button class="btn btn-ghost btn-sm" type="button" data-act="closePreview">关闭预览</button>
      </div>
      <div class="game-terminal u-hide" data-ref="terminal" role="alert"></div>
      <!-- 普通展开（非 menu 语义，2026/09/19 人工决策：去 role=menu/menuitem/aria-haspopup） -->
      <div class="info-menu u-hide" data-ref="moreMenu">
        <button class="btn btn-ghost" type="button" data-act="resign">认输</button>
        <button class="btn btn-ghost" type="button" data-act="restart">重开</button>
        <button class="btn btn-ghost" type="button" data-act="immersive">沉浸</button>
      </div>
      <!-- T6.6 结算面板·移动宿主（≤767 底部抽屉；壳由 scoring-panel 模块自建）。
           显隐＝u-hide（display:none 已对读屏隐藏），**不得**硬编码 aria-hidden
           ——展开后仍被 aria-hidden 遮蔽（2026/09/19 WIG 合规轮） -->
      <div class="settle-drawer-root u-hide" data-ref="settleMobile" role="region" aria-label="终局结算"></div>
    </section>
    <!-- 桌面侧栏（≥768 常驻双列；≤767 内容迁移至底部分析抽屉/dock） -->
    <aside class="sidebar" aria-label="实时分析侧栏">
      <div data-ref="sidebarBody"></div>
      <!-- T6.6 结算面板·桌面挂载点（替换侧栏内容，UI_UX §5.4） -->
      <div class="u-hide" data-ref="settleDesktop" role="region" aria-label="终局结算"></div>
    </aside>
    <!-- 实时分析底部抽屉（≤767 常驻 dock：grip 收起/展开、绝不关闭；≥768 桌面侧栏、此抽屉隐藏） -->
    <div class="drawer-root collapsed u-hide" data-ref="drawerRoot">
      <div class="drawer-mask" data-ref="drawerMask"></div>
      <div class="game-drawer" data-ref="gameDrawer" role="region" aria-label="实时分析">
        <button type="button" class="drawer-grip" data-ref="drawerGrip"
                aria-expanded="false" aria-label="展开实时分析"
                title="轻点收起/展开；按住下滑收起、上滑展开（不关闭）"></button>
        <div class="drawer-head">
          <span class="drawer-title">实时分析</span>
          <button class="btn btn-ghost btn-sm drawer-close" type="button" data-ref="drawerClose"
                  aria-label="收起实时分析">
            <svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>
          </button>
        </div>
        <div class="drawer-body" data-ref="drawerBody"></div>
      </div>
    </div>`;
  }

  function setPanel(name, text) {
    if (destroyed) return;
    if (name === 'game') {
      rootEl.innerHTML = gameShellHTML();
      buildGameShell();
      return;
    }
    if (name === 'empty') {
      const copy = emptyCopy(self.emptyKind);
      rootEl.innerHTML = `
        <div class="center-panel" data-panel="empty">
          <div class="empty-state">
            <svg class="art" aria-hidden="true"><use href="#i-empty-go"/></svg>
            <div class="t">${copy.title}</div>
            <div class="s">${copy.text}</div>
            <div class="empty-actions" style="margin-top:16px">
              <button class="btn btn-primary" type="button" data-act="new">创建对局</button>
              <a class="btn btn-ghost" href="#/review">去复盘页</a>
            </div>
          </div>
        </div>`;
      const btn = q('[data-act="new"]');
      if (btn) btn.addEventListener('click', () => nav('#/create'));
      return;
    }
    rootEl.innerHTML = `
      <div class="center-panel" data-panel="${name}">
        <div class="spin" aria-hidden="true"></div>
        <p class="panel-text">${text || ''}</p>
      </div>`;
  }

  function renderEmpty() {
    if (!destroyed) setPanel('empty');
  }

  function buildGameShell() {
    const wrap = q('[data-ref="boardWrap"]');
    if (!wrap) return;
    bindActions();
    self.board = new GameBoard(wrap, {
      size: 19,
      toMove: 'black',
      stones: [],
      interactive: false,
      engineDead: false,
      lastMarker: 'dot',
      announceMoves: true,
      onIntersection: (x, y) => tryPlay(x, y),
      // 触摸屏：空点首次轻点不落子（双击才落）→ 单次轻点棋盘空白同样收起点评气泡
      onBlankTap: () => clearCoachBubble(),
      // 视角变化（缩放/平移/容器尺寸）→ 重算左上角提示的半透明降级（2026/09/24）
      onViewChange: () => applyBoardNoteOverlap(),
    });
    mountCounter();
    mountSidebar();
    const s = store.getState();
    if (s.game) {
      syncAll(s, {});
    }
  }

  /** 挂载对弈侧栏模块（信息卡/曲线/支招；断点 relocator 与抽屉由模块自理）。 */
  function mountSidebar() {
    const bodyHost = q('[data-ref="sidebarBody"]');
    if (!bodyHost || self.sidebar) return;
    self.sidebar = createSidebarModule({
      store,
      hub,
      hosts: {
        desktop: bodyHost,
        drawerRoot: q('[data-ref="drawerRoot"]'),
        drawerMask: q('[data-ref="drawerMask"]'),
        gameDrawer: q('[data-ref="gameDrawer"]'),
        drawerGrip: q('[data-ref="drawerGrip"]'),
        drawerBody: q('[data-ref="drawerBody"]'),
      },
      // 支招行点击（选中）→ 变化图预览（2026/09/18）
      onPickVariation: (entry) => startVariationPreview(entry),
      toast,
    });
    self.sidebar.render();
  }

  /* ---------------- 动作 ---------------- */

  function bindActions() {
    rootEl.querySelectorAll('[data-act]').forEach((btn) => {
      const act = btn.dataset.act;
      const handler = {
        pass: () => sendPass(),
        undo: () => sendUndo(),
        resign: () => confirmResign(),
        restart: () => confirmRestart(),
        // 沉浸入口：桌面在信息行 info-actions，移动端收进 [···] 菜单（2026/09/13）
        immersive: () => {
          setMoreMenu(false);
          if (immersive) immersive.toggle();
        },
        more: () => setMoreMenu(!self.menuOpen),        coach: () => onCoachClick(),
        territory: () => onTerritoryClick(),
        closePreview: () => stopPreview(),
        // 移动端行首「对局信息」图标：顶层弹层展示全部对局信息
        infoPop: () => self.infoPop.toggle(q('[data-act="infoPop"]'), self.metaText),
      }[act];
      if (handler) btn.addEventListener('click', handler);
    });
    // 信息行动态渲染的自动点评开关徽章（事件委托，壳重建不丢）
    const metaRow = q('[data-ref="infoMeta"]');
    if (metaRow) {
      metaRow.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="coachToggle"]')) toggleCoach();
      });
    }
    const drawerClose = q('[data-ref="drawerClose"]');
    if (drawerClose) {
      drawerClose.addEventListener('click', () => self.sidebar && self.sidebar.collapse());
    }
    if (!self._docClick) {
      self._docClick = (e) => {
        if (self.menuOpen && !e.target.closest('[data-ref="moreMenu"], [data-act="more"]')) {
          setMoreMenu(false);
        }
      };
      document.addEventListener('pointerdown', self._docClick, true);
    }
    if (!self._escKey) {
      self._escKey = (e) => {
        if (e.key !== 'Escape') return;
        // ESC 收起当前手点评气泡（与复盘页同口径；人工反馈 2026/09/15）
        clearCoachBubble();
        // 变化图预览优先关闭（同复盘页口径，2026/09/18）：先关预览，其次菜单
        if (self.preview) {
          e.preventDefault();
          stopPreview();
          return;
        }
        if (self.menuOpen) setMoreMenu(false);
      };
      document.addEventListener('keydown', self._escKey, true);
    }
    // 棋盘尺寸变化（窗口/断点）后重测量提示矩形并重算降级（几何随边长变化）
    if (!self._resizeNote) {
      self._resizeNote = () => {
        const g = store.getState().game;
        const noteEl = q('[data-ref="boardNote"]');
        if (!g || !noteEl) return;
        measureBoardNote(noteEl);
        applyBoardNoteOverlap();
      };
      window.addEventListener('resize', self._resizeNote);
    }
  }

  function setMoreMenu(open) {
    self.menuOpen = open;
    const menu = q('[data-ref="moreMenu"]');
    const btn = q('[data-act="more"]');
    if (menu) menu.classList.toggle('u-hide', !open);
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }

  /* ============================================================
   * T6.6 · 终局结算（ScoringPanel 进出 / 棋盘权限 / 再来一局 / 结束）
   * ============================================================ */

  /** 释放对局壳内全部游戏对象（换对局/结束前调用，随后 DOM 重建或清空）。 */
  function teardownShell() {
    if (self.infoPop) self.infoPop.hide(); // 壳重建前收起信息弹层（锚点将失效）
    closePreviewState(); // 变化图预览（计时器/棋盘守卫）随壳销毁（2026/09/18）
    self.wrShown = false; // 换对局：胜率条保留态复位（新局从未有数据）
    if (self.restoreTimer) {
      clearTimeout(self.restoreTimer);
      self.restoreTimer = null;
    }
    if (self.board) {
      self.board.destroy();
      self.board = null;
    }
    if (self.counter) {
      self.counter.destroy();
      self.counter = null;
    }
    if (self.sidebar) {
      self.sidebar.destroy();
      self.sidebar = null;
    }
    if (self.settlePanel) {
      self.settlePanel.destroy();
      self.settlePanel = null;
    }
    if (self.worker) {
      self.workerPending.clear();
      try {
        self.worker.terminate();
      } catch {
        /* 已终止 */
      }
      self.worker = null;
    }
    if (self.terr.doubleTimer) {
      clearTimeout(self.terr.doubleTimer);
      self.terr.doubleTimer = null;
    }
    if (self.terr.timeout) {
      self.terr.timeout.cancel();
      self.terr.timeout = null;
    }
    clearBusyTimer();
    clearAiRetryTimer();
    self.terr.active = false;
    self.terr.auto = false;
    self.terr.pending = false;
    self.coach.bubbleMoveNo = null;
    self.coach.enabled = true;
    self.renderedStones = [];
    self._boardSize = null;
    self.menuOpen = false;
    self.inSettle = false;
    self.settleDead = [];
    self.lastStatus = null;
    if (immersive && immersive.isActive()) immersive.exit();
  }

  /** 惰性建结算面板模块（宿主在壳 DOM 内，须 shell 已 build 后调用）。 */
  function ensureSettlePanel() {
    if (self.settlePanel) return self.settlePanel;
    const desk = q('[data-ref="settleDesktop"]');
    const mob = q('[data-ref="settleMobile"]');
    if (!desk && !mob) return null;
    self.settlePanel = createScoringPanelModule({
      store,
      hub,
      api,
      ls,
      toast,
      hosts: { desktop: desk, mobile: mob },
      isDesktop: () => (typeof window !== 'undefined' ? window.innerWidth >= 768 : true),
      boardRef: () => self.board,
      onDead: (list) => onSettleDead(list),
      onTerritoryToggle: () => settleTerritoryToggle(),
      onRematch: (payload) => doRematch(payload),
      onOpenReport: (gameId) => {
        if (typeof props.openReport === 'function') props.openReport(gameId);
      },
      onEnd: () => endSettle(),
      confirm: confirmDialog,
      nav,
    });
    return self.settlePanel;
  }

  /** 棋盘死子标记集合回写（结算模块 → 棋盘 deadStones）。 */
  function onSettleDead(list) {
    self.settleDead = Array.isArray(list) ? list : [];
    if (self.board) self.board.setProps({ deadStones: self.settleDead });
  }

  /** game.status 沿检测（syncAll 顶部）：进入/退出结算一次性副作用。 */
  function watchSettleTransition(state) {
    const g = state && state.game;
    if (!g) return;
    const status = g.status;
    if (status === self.lastStatus) return;
    const wasSettle = self.lastStatus === 'scoring' || self.lastStatus === 'finished';
    self.lastStatus = status;
    const isSettle = status === 'scoring' || status === 'finished';
    if (isSettle && !wasSettle) enterSettle(status);
    else if (!isSettle && wasSettle) exitSettle();
  }

  /** 进入结算/终局：收起抽屉/菜单/沉浸、清热力、挂结算面板、结算音效一次。 */
  function enterSettle(status) {
    if (self.menuOpen) setMoreMenu(false);
    if (immersive && immersive.isActive()) immersive.exit();
    if (self.sidebar && typeof self.sidebar.hide === 'function') self.sidebar.hide();
    if (self.terr.active) setTerritoryActive(false);
    self.inSettle = true;
    if (self.board) self.board.setProps({ top5: [], comments: [], variations: [] });
    const panel = ensureSettlePanel();
    if (panel) panel.activate(status);
    playSound('success');
  }

  /** 退出结算（scoring.cancel → PLAYING / 新对局接管前清理）。 */
  function exitSettle() {
    self.inSettle = false;
    self.settleDead = [];
    self.terr.active = false;
    self.terr.auto = false;
    self.terr.pending = false;
    if (self.board) self.board.setProps({ deadStones: [], ownership: null });
    if (self.settlePanel) self.settlePanel.deactivate();
    // 回到普通对局：恢复 ≤767 实时分析 dock（默认收起状态）
    if (self.sidebar && typeof self.sidebar.show === 'function') self.sidebar.show();
  }

  /** 结算面板「显示领地」：复用对弈领地链路（终局局面 ownership 请求 + 热力）。 */
  function settleTerritoryToggle() {
    const s = store.getState();
    const st = String((s.engine && s.engine.state) || '').toUpperCase();
    if (st === 'DEAD' || st === 'FATAL') {
      toast({ level: 'info', text: '引擎不可用：暂无领地数据', key: 'terr-dead' });
      return self.terr.active;
    }
    if (!self.board) return self.terr.active;
    if (!self.terr.active) {
      self.terr.active = true;
      self.terr.pending = false;
      self.terr.reqMove = null;
      self.terr.explicit = true;
      self.board.setOwnership(null);
      requestTerritoryNow(true);
      updateTerrButton();
      return true;
    }
    self.terr.active = false;
    self.terr.auto = false;
    self.terr.pending = false;
    self.board.setOwnership(null);
    updateTerrButton();
    return false;
  }

  /** 再来一局（同参数新对局，直接创建并进入；2026/09/06 人工确认）。 */
  async function doRematch(payload) {
    if (self.rematching) return;
    self.rematching = true;
    try {
      const res = await api.post('/games', payload);
      const gid = res && res.data && res.data.game_id;
      if (!gid) throw Object.assign(new Error('创建对局无返回 game_id'), { code: 'INTERNAL_ERROR' });
      writeRecent(gid);
      if (hub && typeof hub.closeGame === 'function') hub.closeGame();
      teardownShell();
      self.targetId = Number(gid);
      self.lastGameId = null;
      self.phase = 'restoring';
      setPanel('loading', '正在创建同参数新对局…');
      hub.connectGame(self.targetId);
      self.restoreTimer = setTimeout(() => {
        self.restoreTimer = null;
        if (!destroyed && self.phase === 'restoring') probeRestore();
      }, RESTORE_TIMEOUT_MS);
      toast({ level: 'info', text: '已创建同参数新对局，准备开始', key: 'rematch' });
    } catch (err) {
      toast({
        code: (err && err.code) || 'INTERNAL_ERROR',
        message: (err && err.message) || '创建新对局失败',
      });
    } finally {
      self.rematching = false;
    }
  }

  /** 「结束」：离开本（已结束）对局 → 清理最近记录并回空态。 */
  function endSettle() {
    clearRecent();
    if (hub && typeof hub.closeGame === 'function') hub.closeGame();
    teardownShell();
    showEmpty('none');
  }

  /* ============================================================
   * T6.5 · 支招 / 领地 / 胜率条 / 曲线回填
   * ============================================================ */

  function currentState() {
    return store.getState();
  }

  function inPlayNow(g) {
    return Boolean(g && (g.status === 'active' || g.status === 'created'));
  }

  /** 领地可用对局：进行中 或 结算/终局（T6.6：终局「显示领地」复用同一请求链路）。 */
  function territoryAllowed(g) {
    if (inPlayNow(g)) return true;
    return Boolean(self.inSettle && g && (g.status === 'scoring' || g.status === 'finished'));
  }

  /** 分析类按钮可用态（引擎/回合/终局门控 + 支招进行态；DOM 由 syncAll 刷新）。 */
  function analysisEnabled() {
    const s = currentState();
    return analysisButtons({
      game: s.game,
      engineState: s.engine && s.engine.state,
      flags: self.flags,
      coaching: s.coaching,
    });
  }

  /** 底部 [支招]：可用时经侧栏模块发起请求（2026/09/06：不再自动展开抽屉/侧栏）。 */
  function onCoachClick() {
    if (!self.sidebar) return;
    const acts = analysisEnabled();
    if (!acts.coach.enabled) return; // disabled 按钮吞点击；原因见 Tooltip
    if (acts.coach.loading) return; // 请求进行中（仅呼吸提示）：重复点击忽略
    self.sidebar.requestCoach();
  }

  /**
   * 领地请求看门狗（懒建）：**只重新发起、绝不自动退出**（2026/09/12 三次修订）。
   *
   * 根因：旧实现把“12s 无回执”当作失败，自动淡出并熄灭（含连续模式）——但引擎忙于
   * AI 走子/P1 排队时响应本就可能晚于 12s，正常等待被误判（人工反馈「维持十多秒后
   * 自动退出」）。现在超时仅走 `requestTerritoryNow` 重新领表（本地已有数据则直接
   * 应用；服务端任务被丢弃时由此收敛），显示只由用户操作/引擎 DEAD·FATAL/对局结束终结。
   */
  function terrTimeout() {
    if (!self.terr.timeout) {
      self.terr.timeout = createTerritoryTimeout({
        onTimeout: () => {
          if (territoryWatchdogAction({
            destroyed,
            pending: self.terr.pending,
            active: self.terr.active,
          }) !== 'retry') return;
          self.terr.pending = false;
          self.terr.reqMove = null;
          requestTerritoryNow(self.terr.explicit); // 重新领表（含本地缓存命中直应用）
        },
      });
    }
    return self.terr.timeout;
  }

  /** 底部 [领地]：单击切换；双击（≤300ms 内第二次点击）开启每步自动连续模式（U-17）。 */
  function onTerritoryClick() {
    const acts = analysisEnabled();
    if (!acts.territory.enabled) return;
    const intent = territoryClickIntent({ armed: Boolean(self.terr.doubleTimer) });
    if (intent.kind === 'auto') {
      clearTimeout(self.terr.doubleTimer);
      self.terr.doubleTimer = null;
      enableAutoTerritory();
      return;
    }
    self.terr.doubleTimer = setTimeout(() => {
      self.terr.doubleTimer = null;
      singleTerritoryClick();
    }, intent.delayMs);
  }

  function singleTerritoryClick() {
    // auto 开启时单击 = 取消连续模式（含热力关闭）
    if (self.terr.auto) {
      self.terr.auto = false;
      setTerritoryActive(false);
      return;
    }
    setTerritoryActive(!self.terr.active);
  }

  function enableAutoTerritory() {
    if (!self.board) return;
    self.terr.auto = true;
    self.terr.active = true;
    self.terr.pending = false;
    self.terr.reqMove = null;
    // 不清热力：新数据到达时与当前显示平滑交叉淡变（连续模式无背景空档，2026/09/12）
    requestTerritoryNow(false);
    updateTerrButton();
    toast({ level: 'info', text: '已开启「每步自动」领地（再次单击取消）', key: 'terr-auto' });
  }

  function setTerritoryActive(active) {
    if (!self.board) return;
    self.terr.active = Boolean(active);
    if (!active) self.terr.auto = false;
    self.terr.pending = false;
    self.terr.reqMove = null;
    terrTimeout().cancel();
    self.board.setOwnership(null); // 240ms 淡出（board 内）
    if (active) requestTerritoryNow(true);
    updateTerrButton();
  }

  /** 请求当前局面领地（ownership.request；缺分析时服务端触发 P1，完成后推送）。 */
  function requestTerritoryNow(explicit) {
    const s = currentState();
    const g = s.game;
    if (!g || !territoryAllowed(g)) return;
    const cur = Number(g.lastMoveNo) || 0;
    // 防重仅限**同局面**：连手时旧请求在途也不得阻挡新场面请求（否则热力不刷新）
    if (territoryRequestAction({ pending: self.terr.pending, pendingAt: self.terr.reqMove, at: cur }) === 'skip') return;
    self.terr.explicit = Boolean(explicit);
    // 已有当前局面结果（会话缓存）→ 直接应用，不再发请求
    const entry = s.positions && s.positions[mainKey(cur)];
    if (entry && entry.ownership !== undefined) {
      self.terr.pending = false;
      self.terr.reqMove = cur;
      terrTimeout().cancel();
      applyTerritoryEntry(entry, cur, g);
      updateTerrButton();
      return;
    }
    self.terr.pending = true;
    self.terr.reqMove = cur;
    hub.sendGame('ownership.request', { move_no: cur });
    terrTimeout().arm();
    updateTerrButton();
  }

  /**
   * 领地结果应用：raw 数组 → Worker 量化（失败回退 board 主线程量化）→ 棋盘热力（状态层叠加）。
   * 仅当结果仍对应当前局面时写入（过期结果丢弃）。
   */
  function applyTerritoryEntry(entry, cur, g) {
    const board = self.board;
    if (!board || destroyed) return;
    if ((currentState().game && Number(currentState().game.lastMoveNo)) !== cur) return;
    terrTimeout().cancel();
    self.terr.pending = false;
    self.terr.reqMove = cur;
    const raw = entry && entry.ownership;
    if (raw == null) {
      board.setOwnership(null);
      // 终态“无数据”：瞬态显示熄灭（看门狗不再兜底退出，否则按钮会永久空亮）；
      // 连续模式保畱（下一手可能仍有数据）
      if (!self.terr.auto) self.terr.active = false;
      // 无数据空态说明（仅显式点击且每局面一次）
      if (self.terr.explicit && !self.terr.auto) {
        const key = mainKey(cur);
        if (self.terr._notifiedKey !== key) {
          self.terr._notifiedKey = key;
          toast({ level: 'info', text: TERRITORY_NO_DATA_TEXT, key: `terr-nodata-${cur}` });
        }
      }
      updateTerrButton();
      return;
    }
    const size = (g && g.params && g.params.boardSize) || 19;
    if (Array.isArray(raw)) {
      quantizeThenSet(raw, size, cur);
    } else {
      board.setOwnership(raw); // 已量化对象
    }
    updateTerrButton();
  }

  /** Worker 量化（惰性建 worker；不可用/失败回退 board 主线程量化）。 */
  function quantizeThenSet(raw, n, cur) {
    const board = self.board;
    if (!board || destroyed) return;
    const stillCurrent = () => {
      const g = currentState().game;
      return g && Number(g.lastMoveNo) === cur;
    };
    if (!ensureWorker()) {
      if (stillCurrent()) board.setOwnership(raw);
      return;
    }
    self.workerSeq += 1;
    const id = self.workerSeq;
    self.workerPending.set(id, (q) => {
      if (stillCurrent()) board.setOwnership(q || raw);
    });
    // L-10：应答超时回收——旧实现 Worker 静默丢消息时条目/闭包永久滞留
    self.workerTimers.set(
      id,
      setTimeout(() => {
        const resolve = self.workerPending.get(id);
        if (!resolve) return;
        self.workerPending.delete(id);
        self.workerTimers.delete(id);
        resolve(null);
      }, WORKER_REPLY_TIMEOUT_MS),
    );
    self.worker.postMessage({ type: 'ownership', id, data: { values: raw, n } });
  }

  function ensureWorker() {
    if (self.worker) return true;
    try {
      if (typeof Worker === 'undefined') return false;
      self.worker = new Worker(new URL('../workers/analysis.worker.js', import.meta.url), {
        type: 'module',
      });
      self.worker.onmessage = (ev) => {
        const d = (ev && ev.data) || {};
        const resolve = self.workerPending.get(d.id);
        if (resolve) {
          self.workerPending.delete(d.id);
          const timer = self.workerTimers.get(d.id);
          if (timer != null) {
            clearTimeout(timer);
            self.workerTimers.delete(d.id);
          }
          resolve(d && d.ok ? d.result : null);
        }
      };
      self.worker.onerror = () => {
        // Worker 崩溃：清空挂起并回退主线程量化（含 L-10 应答计时器）
        self.workerTimers.forEach((timer) => clearTimeout(timer));
        self.workerTimers.clear();
        self.workerPending.forEach((res) => res(null));
        self.workerPending.clear();
        try {
          self.worker.terminate();
        } catch {
          /* 已终止 */
        }
        self.worker = null;
      };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 领地按钮状态（开启＝整按钮高亮 `is-on`；连续模式＝高亮 + **按钮左上角**小圆点；title）。
   * 点击后即时生效，不等下一次整页刷新；口径单一事实源 = core/territory.js
   * `territoryButtonView` / `territoryButtonClasses`（2026/09/17 回退口径：图标恒空心、不填充、不呼吸）。
   */
  function updateTerrButton() {
    const btn = q('[data-act="territory"]');
    const view = territoryButtonView({ active: self.terr.active, auto: self.terr.auto });
    if (!btn) return;
    for (const [cls, on] of Object.entries(territoryButtonClasses({ active: self.terr.active, auto: self.terr.auto }))) {
      btn.classList.toggle(cls, on);
    }
    const dot = q('[data-ref="terrDot"]');
    if (dot) dot.classList.toggle('u-hide', !view.dot);
    btn.title = view.title;
  }

  /**
   * 领地热力随局面同步（在 syncAll 中调用）——口径见 core/territory.js `territoryHeatPlan`：
   *   - 未开启 / 单击瞬态遇局面推进 → 清除（board 240ms 淡出）；
   *   - 连续模式局面推进但数据未到 → **保留上一手热力**并拉起请求（不闪回棋盘背景，
   *     新数据到达后与保留的热力交叉淡变）；
   *   - 当前局面数据到达 → 应用；同局面等待中 → 保留（不重复请求）。
   */
  function syncTerritoryHeat(state) {
    const board = self.board;
    if (!board || destroyed) return;
    const g = state.game;
    const cur = g ? Number(g.lastMoveNo) || 0 : 0;
    const entry = g && state.positions && state.positions[mainKey(cur)];
    const plan = territoryHeatPlan({
      active: Boolean(self.terr.active) && territoryAllowed(g),
      auto: Boolean(self.terr.auto),
      hasData: Boolean(entry && entry.ownership !== undefined),
      positionChanged: cur !== self.terr.reqMove,
    });
    if (plan.display === 'clear') board.setOwnership(null);
    if (plan.stop) {
      self.terr.active = false;
      self.terr.auto = false;
      self.terr.pending = false;
      terrTimeout().cancel();
      updateTerrButton();
    }
    if (plan.display === 'show') {
      if (self.terr.pending || cur !== self.terr.reqMove) {
        self.terr.pending = false;
        self.terr.reqMove = cur;
        applyTerritoryEntry(entry, cur, g);
      }
      return;
    }
    if (plan.request) requestTerritoryNow(false);
  }

  /** 棋盘 TOP5 徽章（C7）：coaching 结果须与当前局面一致且引擎就绪才展示
   *  （STOPPED 未启动 / INIT 加载中 / DEAD·FATAL 不可用均不展示）。 */
  function syncCoachBadges(state) {
    const board = self.board;
    if (!board) return;
    const g = state.game;
    const coaching = state.coaching || {};
    const st = String((state.engine && state.engine.state) || '').toUpperCase();
    const engineOk = st !== 'DEAD' && st !== 'FATAL' && st !== 'INIT' && st !== 'STOPPED';
    let top5 = [];
    if (
      inPlayNow(g)
      && engineOk
      && !self.preview
      && coaching.atMoveNo === (g && Number(g.lastMoveNo))
      && Array.isArray(coaching.topMoves)
    ) {
      top5 = coaching.topMoves
        .filter((m) => m.x != null && m.y != null)
        .map((m, i) => ({ x: Number(m.x), y: Number(m.y), rank: i + 1 }));
    }
    board.setProps({ top5 });
  }

  /**
   * C16 黑白胜率条（≤767 显示于棋盘下方，DOM 位于棋盘底部行）。
   * 2026/09/13 人工反馈（首落子闪烁）：当前手分析在途时**保留上一次渲染**（wrBarAction），
   * 不闪回「暂无胜率数据」；空态与加载态盒高一致（CSS .wr-empty）。
   */
  function renderWrBar(state) {
    const el = q('[data-ref="wrBar"]');
    if (!el) return;
    const g = state.game;
    const down = String((state.engine && state.engine.state) || '').toUpperCase() === 'DEAD'
      || String((state.engine && state.engine.state) || '').toUpperCase() === 'FATAL';
    const wr = deriveWinrateCard(g, { points: state.curve.points || [], disabled: down });
    el.classList.toggle('is-grey', wr.disabled);
    // “在途”判定：已有更早的分析点 ⇒ 当前手分析大概率在飞（新局/重开后无点 → 回退空态）
    const cur = Number(g && g.lastMoveNo) || 0;
    const pending = (state.curve.points || []).some((p) => Number(p.moveNo) < cur);
    const action = wrBarAction({ hasRate: wr.hasRate, shown: self.wrShown, pending });
    if (action === 'keep') return;
    if (action === 'empty') {
      const empty = '<span class="wr-empty muted">暂无胜率数据</span>';
      if (el.innerHTML !== empty) el.innerHTML = empty;
      el.setAttribute('aria-label', '黑白胜率：暂无数据');
      return;
    }
    self.wrShown = true;
    const bNote = wr.delta != null ? `<small>${signedPct(wr.delta, 0)}</small>` : '';
    const bw = Math.min(100, Math.max(0, wr.black || 0));
    const blackText = `黑 ${pctCompact(wr.black)} ${bNote}`;
    const whiteText = `白 ${pctCompact(wr.white)}`;
    // 读屏文本：与可见标签同源（黑/白百分比 + 黑方变动附注）
    const deltaText = wr.delta != null ? ` ${signedPct(wr.delta, 0)}` : '';
    el.setAttribute('aria-label', `黑白胜率：黑 ${pctCompact(wr.black)}${deltaText}，白 ${pctCompact(wr.white)}`);
    const segEl = el.querySelector('.wr-track .b');
    if (!segEl) {
      // 首建：结构一次性写入（新元素无过渡 → 入场即时）
      el.innerHTML = `
      <div class="wr-label num">${blackText}</div>
      <div class="wr-track"><div class="b" style="width:${bw}%"></div><div class="w"></div></div>
      <div class="wr-label num">${whiteText}</div>`;
      return;
    }
    // 更新：只改数值与黑段宽度（CSS width 过渡 → 平滑动画；重写 innerHTML 会丢过渡）
    const labels = el.querySelectorAll('.wr-label');
    labels[0].innerHTML = blackText;
    labels[1].textContent = whiteText;
    segEl.style.width = `${bw}%`;
  }

  /** 断点恢复后的曲线历史回填（GET /games/{id}/curve → curve.set；每 gameId 一次）。 */
  async function backfillCurve() {
    if (!self.targetId || self.curveBackfilled === self.targetId || destroyed) return;
    self.curveBackfilled = self.targetId;
    try {
      const res = await api.get(`/games/${self.targetId}/curve`);
      const points = res && res.data;
      if (Array.isArray(points)) {
        store.dispatch({ type: 'curve.set', data: { points } });
      }
    } catch {
      /* 无历史曲线（新局/失败）：由 analysis.curve 实时补齐，不阻断 */
    }
  }

  function sendMove(x, y) {
    self.flags.busy = true;
    armBusyTimer();
    clearStartKey();
    // 人机：人类刚落子 → 本地立即呈现「AI 思考」（胶囊 + 计数当前方=AI），
    // 不等服务端回包（AI 执行期间服务端不推进 next_color）。
    // **人人对弈：发送零视觉副作用**（2026/09/18 人工反馈）——曾在人人模式同样立即
    // 重绘，busy 令全部操作按钮置灰、待 game.state 又立即解禁 → 每次落子按钮闪烁；
    // 无 AI 等待时本步呈现一律由服务端提交回调的即时 move.applied 驱动。
    if (self.board && isHumanAi(store.getState().game)) syncAll(store.getState(), {});
    hub.sendGame('play', { x, y });
  }

  function sendPass() {
    // 在途提交（busy）/非对局中：忽略（人人发送不再即时置灰按钮，需行为层自守；2026/09/18）
    if (!currentUi().actions.pass) return;
    self.flags.busy = true;
    armBusyTimer();
    clearStartKey();
    hub.sendGame('pass');
  }

  function sendUndo() {
    const ui = currentUi();
    if (!ui.actions.undo) return;
    const s = store.getState();
    const g = s.game;
    if (isHumanAi(g)) {
      // 人机对弈：直通（ISSUE-039 上限在服务端按人机作用域判定）。
      // AI 思考期同样可悔棋（2026/09/13）：服务端终止在途 AI 应手查询、撤 1 步；
      // **发送不做任何视觉副作用**（不置 busy、不重绘）——曾因 busy 假置位触发
      // 「思考中」胶囊/提子当前方切换/按钮置灰，被服务端快速拒绝（如剩 1 次需
      // 撤 2 步）时整行与控件闪烁（2026/09/13 修复）。undoPending 仅防重复提交，
      // 随结果到达/出错复位（clearBusy）；结果帧缺席时由重连 restore 复位
      if (self.flags.undoPending) return; // 悔棋在途：忽略重复点击（视觉零变化）
      self.flags.undoPending = true;
      hub.sendGame('undo');
      return;
    }
    // 人人对弈：悔棋不限制次数但需对方确认（2026/09/06 人工确认）
    // 首次发 undo = 创建申请；等待中再次发 undo = 撤回（服务端 undo.declined withdrawn）
    const now = Date.now();
    if (self.flags.undoWaiting && now - self._undoSentAt < 600) return; // 双击防抖
    if (!self.flags.undoWaiting) {
      self.flags.undoWaiting = true;
      toast({ level: 'info', text: '已向对方发送悔棋申请，等待确认…', key: 'undo-request' });
      // 申请不经 store（多设备时服务端不回投本机）→ 需主动重同步锁定/按钮态
      if (self.board) syncAll(store.getState(), {});
    }
    self._undoSentAt = now;
    clearStartKey();
    hub.sendGame('undo');
  }

  /** 自动 start 的回合标记复位（本地已发起变更指令：回合身份可能重复，如重开回 0 手/悔棋撤 AI 应手）。 */
  function clearStartKey() {
    self.startKey = null;
  }

  function sendStart() {
    self.flags.busy = true;
    armBusyTimer();
    hub.sendGame('start');
  }

  async function confirmResign() {
    const ui = currentUi();
    if (!ui.actions.resign) return;
    const ok = await confirmDialog({
      title: '确认认输？',
      message: resignConfirmText(store.getState().game),
      okText: '认输',
      danger: true,
      okIcon: 'i-error',
    });
    if (!ok || destroyed) return;
    self.flags.busy = true;
    armBusyTimer();
    hub.sendGame('resign');
  }

  async function confirmRestart() {
    const ui = currentUi();
    if (!ui.actions.restart) return;
    const ok = await confirmDialog({
      title: '重开当前对局？',
      message: '将清空全部落子与分析（同参数重新开始），当前对局进度不可恢复。',
      okText: '重开',
      danger: true,
    });
    if (!ok || destroyed) return;
    // 重开＝清空全部落子与分析（确认框口径）：本地立即清曲线缓存——
    // 否则被重开局的 main:0 首点会幸存（`curPoint(≤0)` 命中）→ 胜率条残留旧数据
    // （2026/09/13 人工反馈；后续 game.state(0 手) 会按空点集收敛，不会复活）
    store.dispatch({ type: 'curve.set', data: { points: [] } });
    self.wrShown = false;
    self.flags.busy = true;
    armBusyTimer();
    clearStartKey(); // 重开回 0 手：AI 先行局须能重新触发 start
    hub.sendGame('restart');
  }

  /* ---------------- 消息驱动 ---------------- */

  function onStoreChange(state, message) {
    const type = message.type;
    const data = message.data || {};
    const msgGameId = data.game_id !== undefined ? Number(data.game_id) : null;

    // busy/undoPending 复位：权威同步类消息（服务端已确认本步完成）
    // undoPending 必须一并覆盖——悔棋发送不再置 busy（零视觉副作用，2026/09/13），
    // 若仅以 busy 为守卫，成功撤销后防抖标记残留 → 后续悔棋被 sendUndo 静默吞掉。
    // 人人对弈另以 **move.applied（提交回调即时回执）**同帧解锁（无 AI 等待；
    // 否则紧随的 syncAll 以「等待中」渲染禁用按钮 → 每次落子闪烁；2026/09/18）。
    const commitUnlocksBusy = type === 'move.applied' && moveAppliedUnlocksBusy(state.game);
    if (
      (self.flags.busy || self.flags.undoPending)
      && (type === 'game.state' || type === 'game.finished' || type === 'move.undone' || commitUnlocksBusy)
      && (type !== 'game.state' || msgGameId === null || msgGameId === self.targetId)
    ) {
      clearBusy();
    }

    // 悔棋申请解决：同意（move.undone）/ 对局结束 → 解除等待态
    // （拒绝/撤回经 undo.declined 控制消息处理，不经过 store）
    if (self.flags.undoWaiting && (type === 'move.undone' || type === 'game.finished')) {
      clearUndoWait();
    }

    // 他端结束对局 → 清理 localStorage（UI_UX §10：FINISHED 清理）
    if (type === 'game.finished' && state.game && state.game.gameId === self.targetId) {
      clearRecent();
    }

    // 首个 game.state（恢复完成）
    if (self.phase === 'restoring' && type === 'game.state' && state.game && msgGameId === self.targetId) {
      self.phase = 'game';
      self.lastGameId = msgGameId;
      if (self.restoreTimer) {
        clearTimeout(self.restoreTimer);
        self.restoreTimer = null;
      }
      // 进行中写最近记录；已结束清理记录（UI_UX §10）
      if (state.game.status !== 'finished') writeRecent(msgGameId);
      else clearRecent();
      if (!self.board) {
        setPanel('game');
      }
      self._boardSize = null; // 强制首次重建
      syncAll(state, message);
      return;
    }

    // 对局切换 / 未装载棋盘时
    if (!self.board) {
      if (type === 'game.state' && state.game && msgGameId === self.targetId) {
        self.phase = 'game';
        self.lastGameId = msgGameId;
        setPanel('game');
        syncAll(state, message);
      }
      return;
    }

    // 音效（有效落子）仅当对局已装载；本手提子（2026/09/15）→ 吃子音效优先于落子音
    if (type === 'move.applied' && state.game) {
      const captured = lastMoveCaptures({
        size: state.game.params.boardSize || 19,
        handicap: state.game.params.handicap || 0,
        moves: state.game.moves,
      });
      playSound(captured > 0 ? 'capture' : 'stone');
    }

    syncAll(state, message);
  }

  function onGameError(e) {
    const wasBusy = self.flags.busy;
    // undoPending（悔棋在途被服务端拒绝，如 UNDO_LIMIT_REACHED）同样需要复位——
    // 纯行为防抖标记，不涉视觉（2026/09/13）
    if (wasBusy || self.flags.undoPending) clearBusy();
    const code = e.code || '';
    if (code === 'ILLEGAL_MOVE' && self.lastPlay && self.board) {
      self.board.flashIllegal(self.lastPlay.x, self.lastPlay.y);
    }
    self.lastPlay = null;
    // 对局已被删除（服务端领域错误）：与终态关闭（4404）同一处置 —— 收敛到空态
    // 并给领域提示，不留任在被删对局上（BUG-092）
    if (code === 'GAME_NOT_FOUND') {
      failRestore('GAME_NOT_FOUND');
      return;
    }
    // start（开局/续行）失败：清回合标记 → 引擎恢复等下一次 store 变更自然重试
    // （AI 侧挂起为 TURN_AI 既有语义；BUG-093）
    if (
      code === 'ENGINE_BUSY'
      || code === 'ENGINE_DEAD'
      || code === 'ENGINE_FATAL'
      || code === 'HUMAN_MODEL_UNAVAILABLE'
    ) {
      self.startKey = null;
    }
    // 领地请求相关错误：忙 → 仅解除 pending（可重试）；引擎不可用 → 平滑淡出并结束显示
    if (self.terr.pending && (code === 'ENGINE_BUSY' || code === 'ENGINE_DEAD' || code === 'ENGINE_FATAL')) {
      self.terr.pending = false;
      terrTimeout().cancel();
    }
    // 支招请求进行态复位（2026/09/13 人工确认）：引擎类错误（不可用/超时）后请求不会再有
    // 结果 → 复位 `coaching.loading`（停止呼吸，卡片回退可重试/降级提示）；
    // 口径与复盘页 [深度分析] 的 ENGINE_* 错误复位一致
    if (code === 'ENGINE_DEAD' || code === 'ENGINE_FATAL' || code === 'ENGINE_BUSY') {
      if (store.getState().coaching.loading) store.dispatch({ type: 'coaching.reset' });
    }
    if (code === 'ENGINE_DEAD' || code === 'ENGINE_FATAL') {
      self.terr.reqMove = null;
      if (self.terr.active) {
        self.terr.active = false;
        self.terr.auto = false;
        if (self.board) self.board.setOwnership(null);
        updateTerrButton();
      }
    }
    // start 失败：token 已含引擎态 → 引擎状态变化（如 INIT→IDLE）后自动重试，
    // 不在此即时复位（避免引擎 INIT 期间的重试风暴）。
    // 错误信封来自 WS（不经 store）→ 清除 busy 后需主动重同步按钮/胶囊态
    if (!destroyed && wasBusy && self.board) {
      syncAll(store.getState(), {});
    }
  }

  /* ---------------- 人人悔棋确认流（undo.request / undo.respond / undo.declined） ---------------- */

  /** 收到 undo.request：弹「对方申请悔棋」确认（可被撤回/已处理事件撤销）。 */
  async function askUndoConfirm(ev) {
    const data = ev.data || {};
    const s = store.getState();
    const g = s.game;
    const gid = g && Number(g.gameId);
    if (self.phase !== 'game' || !self.board || gid !== self.targetId) return;
    const requestId = Number(data.request_id);
    if (!Number.isInteger(requestId) || requestId <= 0) return;
    const steps = Number(data.steps) || 1;
    const sideText = data.color === 'W' ? '白方' : '黑方';
    if (!confirmAbortable) {
      // 缺注入（异常宿主）：默认拒绝，避免申请方永久等待
      hub.sendGame('undo.respond', { request_id: requestId, accept: false });
      return;
    }
    const prompt = confirmAbortable({
      title: '对方申请悔棋',
      message: `${sideText} 申请悔棋（撤 ${steps} 步），是否同意？`,
      okText: '同意',
      cancelText: '拒绝',
    });
    self._undoPrompt = { requestId, dismiss: prompt.dismiss };
    const ok = await prompt.promise;
    if (destroyed) return;
    // 已被撤销/新请求接管（onUndoDeclined 已 dismiss 并置空）→ 不发送过期响应
    if (!self._undoPrompt || self._undoPrompt.requestId !== requestId) return;
    self._undoPrompt = null;
    hub.sendGame('undo.respond', { request_id: requestId, accept: Boolean(ok) });
  }

  /** 收到 undo.declined：拒绝/撤回/执行失败。申请方解除等待并 Toast；对端关闭待确认弹窗。 */
  function onUndoDeclined(ev) {
    const data = ev.data || {};
    const requestId = Number(data.request_id);
    // 对端视角：本机正弹确认窗且申请已被对方处理/撤回 → 关闭弹窗
    if (self._undoPrompt && self._undoPrompt.requestId === requestId) {
      const prompt = self._undoPrompt;
      self._undoPrompt = null;
      prompt.dismiss(); // resolve(false) → askUndoConfirm 不再发送响应
    }
    // 终态处置（R3：failed 时申请方与响应方均须收敛 + 解释）
    const outcome = undoDeclinedOutcome(data, Boolean(self.flags.undoWaiting));
    if (outcome.clearWaiting && self.flags.undoWaiting) clearUndoWait();
    if (outcome.toast) toast(outcome.toast);
    if (self.board) syncAll(store.getState(), {});
  }

  function tryPlay(x, y) {
    // 点击棋盘空白（空交叉点）= “其它操作”：先收起点评气泡（2026/09/15 人工反馈）。
    // 位置在 early-return 之前——发送中/非交互期点击同样收起（纯 UI 收起，不发指令）。
    clearCoachBubble();
    // 变化图预览中：棋盘点击＝暂停/继续/再次播放（棋盘只读，同复盘页；兜底拦截）
    if (self.preview) {
      togglePreviewPlayback();
      return;
    }
    const ui = currentUi();
    if (!ui.interactive || self.flags.busy) return;
    // 落子前置本地规则预校验（2026/09/12 人工口径）：非法即时红 ✕ + 原因 Toast，
    // **不发送**服务器（省往返、零延迟）；服务端仍为唯一裁决者（兜底见 onGameError）。
    const g = store.getState().game;
    const verdict = checkMoveOnGame(g, x, y, g && g.nextColor);
    if (!verdict.legal) {
      if (self.board) self.board.flashIllegal(x, y);
      toast({ level: 'error', text: illegalMoveText(verdict.reason), key: 'illegal-move' });
      return;
    }
    self.lastPlay = { x, y };
    sendMove(x, y);
  }

  /* ---------------- 全量同步（游戏壳内各元素） ---------------- */

  function syncAll(state, message) {
    if (!self.board) return;
    const s = state || store.getState();
    const ui = currentUi();
    const type = message && message.type;
    const g = s.game;

    if (!g) return;

    // —— 变化图预览失效（2026/09/18）：局面推进/悔棋/重开/gameId 更换/终局结算——
    //    gameKey（gameId:末手数:状态）变化 → 自动关闭（预览属于旧局面，同复盘定位口径）
    if (self.preview && self.preview.gameKey !== previewGameKey(g)) closePreviewState();

    // —— T6.6：scoring/finished 进出结算（一次性副作用：面板挂载/音效/棋盘权限） ——
    watchSettleTransition(s);
    const inSettle = Boolean(ui.terminal);

    // —— 信息行 meta ——（移动端单行省略：文本段归 .meta-clip，徽章/开关固定完整）
    const metaEl = q('[data-ref="infoMeta"]');
    if (metaEl) {
      const grp = groupMetaSegments(ui.meta);
      const clip = grp.clip
        .map((seg, i) => `${i ? '<span class="sep">·</span>' : ''}<span>${seg.text}</span>`)
        .join('');
      const fixed = grp.fixed
        .map((seg) => '<span class="sep">·</span>' + (seg.coach
          ? `<button type="button" class="badge toggle${seg.on ? ' on' : ''}" data-act="coachToggle"`
            + ` aria-pressed="${seg.on}" title="自动点评开关（点击开/关）">${seg.text}</button>`
          : `<span class="badge accent">${seg.text}</span>`))
        .join('');
      metaEl.innerHTML = `<span class="meta-clip">${clip}</span>${fixed}`;
      // 行首图标弹层全文（对局信息段，· 连接；不含 `自动点评` 开关——人工口径 2026/09/13）
      self.metaText = metaPopText(ui.meta);
    }

    // —— 提子数/当前方（CaptureCounter 自绘：提子增减即时更新 / 执色大小过渡 + 呼吸；
    //    尺寸随窗口自适应、主题经 rAF 每帧同步 —— 见 core/capture-counter.js） ——
    if (self.counter) {
      const caps = ui.captures;
      if (caps.toMove) self.counter.setCurrent(caps.toMove, true);
      self.counter.setCaptures({ black: caps.black, white: caps.white });
    }

    // —— 按钮 ——
    const undoBtn = q('[data-act="undo"]');
    if (undoBtn) {
      undoBtn.textContent = ui.undo.label;
      undoBtn.disabled = !ui.actions.undo;
      if (ui.undoWaiting) {
        undoBtn.title = '取消悔棋申请（等待对方确认）';
      } else if (ui.humanAi) {
        const thinking = self.flags.busy && !self.flags.undoPending;
        if (ui.undo.remaining <= 0) {
          undoBtn.title = '悔棋次数已达上限';
        } else if (thinking) {
          undoBtn.title = '悔棋（撤 1 步，将中止 AI 应手）';
        } else {
          undoBtn.title = `悔棋：剩余 ${ui.undo.remaining} 次`;
        }
      } else {
        undoBtn.title = '悔棋（人人对弈不限制次数，需对方确认）';
      }
    }
    const passBtn = q('[data-act="pass"]');
    if (passBtn) passBtn.disabled = !ui.actions.pass;
    const resignBtn = q('[data-act="resign"]');
    if (resignBtn) resignBtn.disabled = !ui.actions.resign;
    const restartBtn = q('[data-act="restart"]');
    if (restartBtn) restartBtn.disabled = !ui.actions.restart;

    // —— T6.5 分析按钮（支招/领地）：可用性 + 禁用原因 Tooltip ——
    // 支招请求进行中（acts.coach.loading）：**仅呼吸**——文案/禁点均不改变
    // （2026/09/14 人工调整；重复点击由 onCoachClick/requestCoach 忽略）
    const acts = analysisEnabled();
    const coachBtn = q('[data-act="coach"]');
    if (coachBtn) {
      coachBtn.disabled = !acts.coach.enabled;
      coachBtn.classList.toggle('breathe', acts.coach.loading);
      coachBtn.title = acts.coach.reason || '实时支招 TOP5（当前局面深度分析）';
      // 图标点亮（2026/09/17 人工决策）：TOP5 到达且仍对应当前局面 → 点亮（到达时另加一次
      // 由暗到亮动效）；局面推进 / 重新请求（coaching 清空）→ 自然熄灭
      const plan = iconLitPlan({ lit: acts.coach.lit }, self.coachLit);
      applyIconLit(coachBtn, plan);
      self.coachLit = acts.coach.lit;
    }
    const terrBtn = q('[data-act="territory"]');
    if (terrBtn) {
      terrBtn.disabled = !acts.territory.enabled;
      terrBtn.title = acts.territory.reason
        || territoryButtonView({ active: self.terr.active, auto: self.terr.auto }).title;
    }

    // —— 思考胶囊 ——
    const thinkEl = q('[data-ref="thinkCapsule"]');
    if (thinkEl) {
      thinkEl.classList.toggle('u-hide', !ui.aiWait);
      // R2：AI 应手失败时在胶囊上展示服务端挂起原因（hover 可读）
      thinkEl.title = (ui.aiWait && ui.aiWait.title) || '';
      if (ui.aiWait) {
        const txt = q('[data-ref="thinkText"]');
        if (txt) txt.textContent = ui.aiWait.label;
      }
    }

    // —— 人机警示条：引擎 DEAD/FATAL 或人类模型不可用（B2）——
    // （结算期间不显示：结算面板内已有引擎说明；二者同时成立时优先引擎瞬时故障提示）
    const warnEl = q('[data-ref="warnBanner"]');
    if (warnEl) {
      warnEl.classList.toggle('u-hide', !ui.warn || inSettle);
      const showEngineWarn = ui.engineDown;
      const showHumanModelWarn = !showEngineWarn && Boolean(ui.humanModelBlocked);
      const warnText = q('[data-ref="warnText"]');
      if (warnText) {
        // 引擎异常文案按状态分叉（2026/09/20 人工决策：启动/重启入口只在管理页，
        // 本处只给状态说明 + 「去管理页」指引，不再提供 [重试] 按钮）
        warnText.textContent = showHumanModelWarn
          ? HUMAN_MODEL_WARN_TEXT
          : engineAbnormalWarnText(s.engine && s.engine.state);
      }
    }

    // —— 终局/结算提示桥（T6.6 替换） ——
    renderTerminal(ui);

    // —— 自动点评（最近 2 手圆点/气泡数据源：`analysis.comment` 推送切片） ——
    if (!coachCommentAt(g, self.coach.bubbleMoveNo)) clearCoachBubble();

    // —— 棋盘 ——
    syncBoard(g, ui);
    // 棋盘左上角提示（末手 `白 J3` / `白 PASS`；结算期显示结算文案）
    syncBoardNote(g, ui, inSettle);

    // —— T6.5 实时分析：胜率条 / 领地热力 / 支招棋盘徽章 ——
    renderWrBar(s);
    syncTerritoryHeat(s);
    syncCoachBadges(s);

    // —— 断点恢复后曲线历史回填（幂等：每 gameId 一次） ——
    backfillCurve();

    // —— 自动 start（AI 先行 / TURN_AI 恢复） ——
    if (type !== 'error') maybeAutoStart(ui);
    // —— AI 应手失败（ai_pending）：胶囊原因 + 有界自动重试（R2） ——
    if (type !== 'error') syncAiRetry(g, ui);
  }

  /**
   * AI 应手失败（``game.aiPending``）的**有界自动重试**（R2）：服务端后台失败
   * （如单次查询超时）时前端仅收到「轮到 AI」的状态帧——旧实现只依赖下一次
   * store 变更重试（可能永远不再发生）→ 永远停在「思考中」。
   *
   * 现口径：仅当服务端**明确回投挂起原因**时，按 `aiRetryPlan` 延时重试（最多 2 次，
   * 5s/15s）；重试沿用 ``start``（服务端会中断在途查询并重新发起，R1）。
   * 换回合/挂起消失/引擎状态变化 → 计数与计时器复位。
   */
  function syncAiRetry(g, ui) {
    if (destroyed || !g) return;
    const st = store.getState();
    const engineState = (st.engine && st.engine.state) || '';
    const pending = Boolean(g.aiPending);
    const key = pending
      ? `${g.gameId}:${g.lastMoveNo}:${g.nextColor}:${String(engineState).toUpperCase()}`
      : null;
    if (!pending || self.aiRetry.key !== key) {
      clearAiRetryTimer();
      self.aiRetry.key = key;
      self.aiRetry.attempts = 0;
      if (!pending) return;
    }
    const plan = aiRetryPlan({
      pending: true,
      engineState,
      humanModelUnavailable: Boolean(ui && ui.humanModelBlocked),
      scheduled: self.aiRetry.scheduled === true,
      attempts: self.aiRetry.attempts,
    });
    if (plan.action !== 'schedule') return;
    self.aiRetry.scheduled = true;
    self.aiRetry.timer = setTimeout(() => {
      self.aiRetry.timer = null;
      self.aiRetry.scheduled = false;
      if (destroyed) return;
      const s2 = store.getState();
      if (!s2.game || !s2.game.aiPending) return;
      self.aiRetry.attempts += 1;
      self.startKey = `${s2.game.gameId}:${s2.game.nextColor}`; // 同回合单发（BUG-093 令牌）
      sendStart();
      syncAll(s2, {});
    }, plan.delayMs);
  }

  /**
   * 棋盘左上角提示（人工口径 2026/09/13）：默认不遮盘 → 胶囊样式；文案＝末手简洁形式
   * （`白 J3` / `白 PASS`，无手数）；结算/终局时改显结算文案（settleBoardNote，恒保持
   * 胶囊可读、不降级）。**与方形棋盘区域重叠**时降级为半透明样式（`.is-overlap`；
   * 判定口径 2026/09/24 简化为「矩形 ∩ 棋盘方形」）——CSS 同时全局
   * `pointer-events:none` 不拦截落子。
   */
  function syncBoardNote(g, ui, inSettle) {
    const noteEl = q('[data-ref="boardNote"]');
    if (!noteEl) return;
    const settleText = inSettle ? settleBoardNote(g) : null;
    const noteText = settleText || (ui.note ? ui.note.short : null);
    noteEl.classList.toggle('u-hide', !noteText);
    if (noteText) noteEl.textContent = noteText;
    self._noteSettle = Boolean(settleText);
    measureBoardNote(noteEl);
    applyBoardNoteOverlap();
  }

  /**
   * 量取提示矩形（相对棋盘容器）并缓存：文案/窗口尺寸变化时调用。降级判定在缩放/平移
   * 期间会被反复执行（`onViewChange`），若每次都读 offset* 会强制同步重排 → 拖拽/捏合
   * 逐帧卡顿；故矩形只在此处量取，判定本身为零 DOM 读取的纯几何比较。
   */
  function measureBoardNote(noteEl) {
    self._noteRect = noteEl.classList.contains('u-hide')
      ? null
      : {
        left: noteEl.offsetLeft,
        top: noteEl.offsetTop,
        right: noteEl.offsetLeft + noteEl.offsetWidth,
        bottom: noteEl.offsetTop + noteEl.offsetHeight,
      };
  }

  /** 应用半透明降级：提示矩形 ∩ 棋盘方形（棋盘几何含缩放/平移）；结算文案不降级。 */
  function applyBoardNoteOverlap() {
    const noteEl = q('[data-ref="boardNote"]');
    if (!noteEl) return;
    const overlap = !self._noteSettle
      && Boolean(self._noteRect)
      && self.board.noteOverlaps(self._noteRect);
    noteEl.classList.toggle('is-overlap', overlap);
  }

  function syncBoard(g, ui) {
    const size = (g.params && g.params.boardSize) || 19;
    if (self._boardSize !== size) {
      self._boardSize = size;
      self.renderedStones = [];
      self.board.setProps({ size });
    }
    // 落子动画方向（2026/09/13 人工口径）：人机＝人类方由下到上 / 人人＝黑方由下到上。
    // 必须先于下面的 applyMove/setStones（后者在本方法内立即入 drop 队列）。
    const dropUp = dropUpSide(g);
    if (self._dropUpSide !== dropUp) {
      self._dropUpSide = dropUp;
      self.board.setProps({ dropUpColor: dropUp });
    }
    const next = stonesForGame(g);
    const prev = self.renderedStones;
    const added = next.filter(
      (n) => !prev.some((p) => p.x === n.x && p.y === n.y && p.color === n.color),
    );
    const removed = prev.filter(
      (p) => !next.some((n) => n.x === p.x && n.y === p.y && n.color === p.color),
    );
    const smallAdd = added.length === 1 && removed.length === 0 && prev.length > 0;
    const captureAdd = added.length === 1 && removed.length > 0 && prev.length > 0;
    if (smallAdd) {
      self.board.applyMove({ ...added[0], isLast: true });
    } else if (captureAdd) {
      for (const r of removed) self.board.removeStone(r.x, r.y, { capture: true });
      self.board.applyMove({ ...added[0], isLast: true });
    } else {
      self.board.setStones(next);
    }
    self.renderedStones = next;

    // —— 交互权限：对弈落子 vs 结算死子标记（T6.6） ——
    //   SCORING：点击棋子=切换死/活（交互给棋盘，onIntersection 空、onSelectStone 进结算面板）；
    //   FINISHED：只读复盘（含已确认死子 ✕ 与可选领地热力）；
    //   对弈：正常落子（onIntersection=tryPlay）+ 点评手棋子点击（显示点评气泡）。
    const deadMode = self.inSettle && g.status === 'scoring';
    const playMode = !self.inSettle;
    // 自动点评：最近 2 手角标小圆点（不显示色环，人工口径 2026/09/11）
    const comments = coachComments(g).map((c) => ({ x: c.x, y: c.y, grade: c.grade }));
    self.board.setProps({
      toMove: ui.captures.toMove || 'black',
      interactive: deadMode || (playMode && ui.interactive),
      readonly: !(deadMode || (playMode && ui.interactive)),
      // 变化图预览期间隐藏 hover 幽灵（与复盘页同口径；TOP5 隐藏见 syncCoachBadges）
      hoverGhost: !deadMode && !self.preview,
      engineDead: self.inSettle ? false : ui.engineDead,
      comments,
      commentRing: false,
      // 变化图预览点列（预览期间生效；其余时刻空数组）
      variations: self.preview ? self.preview.pts.slice(0, self.preview.step) : [],
      onIntersection: deadMode ? (() => {}) : ((x, y) => tryPlay(x, y)),
      onSelectStone: deadMode
        ? (pt) => { if (self.settlePanel) self.settlePanel.toggleDead(pt); }
        : (pt) => onCoachStone(pt),
      // 触摸屏：单次轻点棋盘空白（空点/网格外）→ 收起点评气泡（与鼠标空点点击同口径）
      onBlankTap: () => clearCoachBubble(),
      ariaLabel: describeAria(g),
    });
  }

  /* ============================================================
   * 自动点评（人工口径 2026/09/11）
   *
   * - 仅创建对局时开启点评（`coaching_enabled`）的局显示可点击徽章（默认开启）；
   * - 点评由**每手标准分析派送**（`analysis.comment`，引擎相关实时数据；
   *   派生=落子前后两个局面 root 之差，落子方视角，ΔS=目数变化）——不再经 `recommend.request`；
   * - 保留**最近 2 手**点评圆点（方便查看自己上一手的评价）；棋盘仅角标小圆点（无色环），
   *   点击点评手棋子开关文案气泡。
   * ============================================================ */

  /** 点评开关：对局开启点评 && 用户开关打开。 */
  function coachOnNow(g) {
    return Boolean(g && g.params && g.params.coachingEnabled && self.coach.enabled);
  }

  /** 最近 2 手点评（带可定位坐标；按手数升序）。 */
  function coachComments(g) {
    if (!coachOnNow(g)) return [];
    return (store.getState().comments || [])
      .filter((c) => c && c.grade && c.x != null && c.y != null)
      .map((c) => ({
        moveNo: c.moveNo,
        color: c.color,
        x: Number(c.x),
        y: Number(c.y),
        grade: c.grade,
        delta_winrate: c.deltaWinrate,
        score_delta: c.scoreDelta,
      }));
  }

  /** 指定手数的点评（气泡数据源/存在性检查）；不在最近 2 手内 → null。 */
  function coachCommentAt(g, moveNo) {
    if (moveNo == null) return null;
    return coachComments(g).find((c) => Number(c.moveNo) === Number(moveNo)) || null;
  }

  /** 徽章点击：点评开关（仅开启点评的对局可用；关闭时清圆点/气泡）。 */
  function toggleCoach() {
    const g = store.getState().game;
    if (!g || !g.params || !g.params.coachingEnabled) return;
    self.coach.enabled = !self.coach.enabled;
    self.coach.loading = false;
    if (!self.coach.enabled) clearCoachBubble();
    syncAll(store.getState(), {});
  }

  /** 棋子点击：点评手 → 开/关文案气泡；其它子 → 收起气泡。 */
  function onCoachStone(pt) {
    if (self.preview) {
      togglePreviewPlayback();
      return;
    }
    const hit = coachComments(store.getState().game)
      .find((c) => Number(c.x) === Number(pt.x) && Number(c.y) === Number(pt.y));
    if (!hit) {
      clearCoachBubble();
      return;
    }
    const el = q('[data-ref="coachBubble"]');
    if (el && !el.classList.contains('u-hide')
      && Number(self.coach.bubbleMoveNo) === Number(hit.moveNo)) {
      clearCoachBubble();
    } else {
      showCoachBubble(hit);
    }
  }

  /** 点评气泡（锚定于点评棋子附近；结构与定位与复盘页共用 core/comment-bubble.js）。 */
  function showCoachBubble(comment) {
    const wrap = q('[data-ref="boardWrap"]');
    if (!wrap || !self.board) return;
    const model = commentBubbleModel(comment, comment.moveNo);
    if (!model) return;
    let el = q('[data-ref="coachBubble"]');
    if (!el) {
      el = document.createElement('div');
      el.className = 'board-bubble';
      el.setAttribute('data-ref', 'coachBubble');
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', '当前手点评');
      wrap.appendChild(el);
    }
    el.innerHTML = commentBubbleHTML(model);
    el.classList.remove('u-hide');
    self.coach.bubbleMoveNo = Number(comment.moveNo);
    if (!positionCoachBubble(el, comment)) el.classList.add('u-hide');
  }

  /** 气泡定位（共用几何：优先棋子右上、空间不足改左下、四周钳制在棋盘内）。
   *  @returns {boolean} 是否成功定位（几何未就绪 → false，调用方隐藏气泡） */
  function positionCoachBubble(el, comment) {
    const pos = self.board.pointOffset(comment.x, comment.y);
    if (!pos) return false;
    const wrap = el.parentElement;
    const place = boardBubblePlacement(
      pos,
      { w: wrap.clientWidth, h: wrap.clientHeight },
      { w: el.offsetWidth, h: el.offsetHeight },
    );
    if (!place) return false;
    el.style.left = `${place.left}px`;
    el.style.top = `${place.top}px`;
    return true;
  }

  function clearCoachBubble() {
    self.coach.bubbleMoveNo = null;
    const el = q('[data-ref="coachBubble"]');
    if (el) el.classList.add('u-hide');
  }

  /* ============================================================
   * 变化图预览（支招候选 → 棋盘逐步动画；2026/09/18 人工确认）
   *
   * 行为与复盘页完全一致（人工口径）：
   *   - 点击支招行（选中）→ 真棋半透明逐步动画（700ms/步固定速度，步数读本地偏好 5–15）；
   *   - 播放完停在末手、**不自动关闭**；[关闭预览]/ESC 关闭；
   *   - 预览期间棋盘点击（任意位置）＝暂停/继续/再次播放，棋盘只读不可落子；
   *   - 预览期间隐藏 TOP5 标点/幽灵；局面推进（落子/悔棋/重开/终局结算）→ 自动关闭。
   * ============================================================ */

  /** 预览失效判定键：gameId + 末手数 + 对局状态（任一变化＝局面/会话推进）。 */
  function previewGameKey(g) {
    return `${g.gameId}:${Number(g.lastMoveNo) || 0}:${g.status}`;
  }

  /** 启动候选变化图预览（支招行点击；entry=deriveCoachCard entries 单元）。 */
  function startVariationPreview(entry) {
    if (!self.board || !entry) return;
    const s = store.getState();
    const g = s.game;
    if (!g) return;
    const pts = coachPreviewPoints(entry, {
      boardSize: (g.params && g.params.boardSize) || 19,
      side: (s.coaching && s.coaching.side) || g.nextColor,
      maxSteps: getPreviewSteps(),
    });
    if (!pts.length) {
      toast({ level: 'info', text: '该候选无可用变化图', key: 'gv-pv-empty' });
      return;
    }
    stopPreview();
    self.preview = { pts, step: 0, playing: true, timer: null, gameKey: previewGameKey(g) };
    bindPreviewGuard(true);
    const chip = q('[data-ref="gvPreviewChip"]');
    if (chip) chip.classList.remove('u-hide');
    // 立即重同步：隐藏棋盘 TOP5 标点/幽灵（与预览棋子重叠，同复盘页）
    syncAll(store.getState(), {});
    previewStepTo(1);
  }

  /** 预览步进：固定 PREVIEW_STEP_MS/步；播放到末手停住（人工口径：不自动关闭）。 */
  function previewStepTo(step) {
    if (!self.preview) return;
    const max = self.preview.pts.length;
    self.preview.step = Math.max(0, Math.min(max, step));
    if (self.board) self.board.setProps({ variations: self.preview.pts.slice(0, self.preview.step) });
    if (self.preview.step >= max) self.preview.playing = false;
    updatePreviewChip();
    if (!self.preview.playing) return;
    clearTimeout(self.preview.timer);
    self.preview.timer = setTimeout(() => {
      if (!self.preview || destroyed) return;
      previewStepTo(self.preview.step + 1);
    }, PREVIEW_STEP_MS);
  }

  /** 棋盘点击播放开关：播放中→暂停；暂停中→继续；已播完→从头再次播放。 */
  function togglePreviewPlayback() {
    const p = self.preview;
    if (!p) return;
    if (p.playing) {
      clearTimeout(p.timer);
      p.playing = false;
      updatePreviewChip();
      return;
    }
    p.playing = true;
    if (p.step >= p.pts.length) {
      previewStepTo(1); // 已播完：从头再次播放
    } else {
      previewStepTo(p.step + 1); // 暂停中：从当前继续
    }
  }

  /**
   * 预览期间的棋盘点击守卫（**捕获阶段**，挂 boardWrap）：点击棋盘任意位置＝暂停/
   * 继续/再次播放；同时吞掉本次点击，防止继续触发落子/点评气泡（与复盘页同实现）。
   */
  function previewBoardGuard(evt) {
    if (!self.preview) return;
    evt.stopPropagation();
    evt.preventDefault();
    togglePreviewPlayback();
  }

  function bindPreviewGuard(on) {
    const wrap = q('[data-ref="boardWrap"]');
    if (!wrap) return;
    if (on) wrap.addEventListener('pointerdown', previewBoardGuard, true);
    else wrap.removeEventListener('pointerdown', previewBoardGuard, true);
  }

  function updatePreviewChip() {
    const chip = q('[data-ref="gvPreviewChip"]');
    if (!chip || !self.preview) return;
    const label = chip.querySelector('[data-ref="gvPreviewLabel"]');
    const count = chip.querySelector('[data-ref="gvPreviewCount"]');
    // 播放中/已播完→「变化图 N/N」；棋盘点击暂停→「已暂停 N/N」（同复盘页）。
    // 标签/计数分写两个**定宽盒**（.pv-label/.pv-count，2026/09/19 人工反馈）：
    // 步进与暂停切换的文本长度变化不再改变胶囊宽度（防抖动）。
    if (label && count) {
      const p = self.preview;
      const atEnd = p.step >= p.pts.length;
      label.textContent = p.playing || atEnd ? '变化图' : '已暂停';
      count.textContent = `${p.step}/${p.pts.length}`;
    }
  }

  /** 预览状态清理（不触发重渲染；供 syncAll 失效路径/teardown 使用）。 */
  function closePreviewState() {
    if (!self.preview) return;
    clearTimeout(self.preview.timer);
    self.preview = null;
    bindPreviewGuard(false);
    const chip = q('[data-ref="gvPreviewChip"]');
    if (chip) chip.classList.add('u-hide');
  }

  /** 用户显式关闭（[关闭预览]/ESC）：状态清理 + 完整重同步（恢复 TOP5 标点/幽灵）。 */
  function stopPreview() {
    const had = Boolean(self.preview);
    closePreviewState();
    if (had) syncAll(store.getState(), {});
    else if (self.board) self.board.setProps({ variations: [] });
  }

  /** 挂载自绘 CaptureCounter（固定显示：棋子/文字尺寸取脚本开头常量，不再随视窗缩放
   *  ——PROMPTS L524；主题经内部 rAF 每帧同步，无需视图驱动）。 */
  function mountCounter() {
    const capEl = q('[data-ref="captures"]');
    if (!capEl || self.counter) return;
    const canvas = document.createElement('canvas');
    capEl.appendChild(canvas);
    self.counter = new CaptureCounter(canvas, {
      current: 'black',
      blackCaptures: 0,
      whiteCaptures: 0,
    });
  }

  function describeAria(g) {
    const p = g.params || {};
    const players = g.players || {};
    const black = p.mode === 'human_ai' && p.humanColor === 'B'
      ? `${players.black && players.black.name || '人类'}（你）`
      : (players.black && players.black.name) || '黑方';
    const white = p.mode === 'human_ai' && p.humanColor === 'W'
      ? `${players.white && players.white.name || '人类'}（你）`
      : (players.white && players.white.name) || '白方';
    const note = lastMoveDesc(g.moves, p.boardSize || 19);
    return `${p.boardSize || 19} 路棋盘：黑 ${black} vs 白 ${white}，${note ? note.text : '开局'}`;
  }

  /**
   * 终局/结算呈现（T6.6 替换旧提示桥）：scoring/finished 时隐藏底部操作行与对弈侧栏，
   * 结算面板（scoring-panel.js 模块）接管侧栏（≥768）/底部结算抽屉（≤767）内容；棋盘与
   * BoardNote 由 syncAll/syncBoard 同步（死子确认标记 / 终局结果）。非结算回对弈态恢复。
   */
  function renderTerminal(ui) {
    const box = q('[data-ref="terminal"]');
    if (box) {
      box.classList.add('u-hide');
      box.innerHTML = '';
    }
    const settle = Boolean(ui && ui.terminal);
    const bottom = q('.bottom-row');
    if (bottom) bottom.classList.toggle('u-hide', settle);
    const sidebarBody = q('[data-ref="sidebarBody"]');
    if (sidebarBody) sidebarBody.classList.toggle('u-hide', settle);
    // 结算/终局时 认输/重开 无意义：隐藏避免误触（信息行与移动 ··· 菜单同）
    const resignBtn = q('[data-act="resign"]');
    if (resignBtn) resignBtn.classList.toggle('u-hide', settle);
    const restartBtn = q('[data-act="restart"]');
    if (restartBtn) restartBtn.classList.toggle('u-hide', settle);
    const moreBtn = q('[data-act="more"]');
    if (moreBtn) moreBtn.classList.toggle('u-hide', settle);
    const desk = q('[data-ref="settleDesktop"]');
    const mob = q('[data-ref="settleMobile"]');
    if (!settle) {
      if (desk) desk.classList.add('u-hide');
      if (mob) mob.classList.add('u-hide');
      return;
    }
    // 结算/终局：结算面板 host 位置由模块 place()（桌面↔移动断点迁移）
    if (self.settlePanel && self.settlePanel.isActive()) self.settlePanel.place();
  }

  /**
   * 自动 start（AI 先行 / TURN_AI 恢复）：**同一回合只发一次**（BUG-093，
   * 决策见 `autoStartAction`；旧实现令牌含 status/engineState → 重复 start →
   * 迟到者被 `ILLEGAL_ACTION` 拒绝 → 误弹「当前状态不允许该操作」）。
   */
  function maybeAutoStart(ui) {
    const s = store.getState();
    const plan = autoStartAction({
      game: s.game,
      targetId: self.targetId,
      busy: Boolean(self.flags.busy),
      startKey: self.startKey,
      ready: Boolean(ui.autoStart),
    });
    if (plan.action === 'reset') {
      // 已脱离 AI 待行局面 → 允许新位置再次触发
      self.startKey = null;
      return;
    }
    if (plan.action !== 'send') return;
    self.startKey = plan.key;
    sendStart();
  }

  /* ---------------- 导出实例 ---------------- */

  return { render, destroy };
}

export default createView;

