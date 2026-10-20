/**
 * tGo · 回放工作台（T6.8，ReviewView）
 *
 * 职责（TASK.md T6.8 / UI_UX §5.5.2–5.5.3 / WEBUI pages/review.html 基线）：
 *   - **数据组装**：REST ``GET /api/games/{id}``（游戏 + 落子序列 + 分析覆盖）合成
 *     ``game.state`` 入状态树 + REST ``/curve`` 回填曲线；复盘读**持久化**
 *     ``position_analyses``（引擎 DEAD 仍可用，UI_UX §6.2）→ ``recommend.request``
 *     派生 AI 推荐/当前手点评（服务端引擎无关）；
 *   - **控制轨道 C11**：首/上一/下一/末 + N/M + 手数滑杆（0..N）+ 自动播放（点手数
 *     区域开/任意交互停，不循环）+ 键盘 ←/→；
 *   - **自动点评/推荐**：进入回放即启用；当前手五色色环 + 侧栏「AI 推荐（回放）」
 *     「当前手点评」卡 + 点击棋盘该手棋子显示点评气泡；
 *   - **曲线 C6 与领地**：REST 曲线（黑方视角）；[领地] 单/双击当前显示局面（含试下
 *     ``trial_id`` 会话缓存，缺失触发 P1 后回投，API §4.3）；
 *   - **试下分支**：任意落子自动进入（后端试下 WS：``trial.enter/play/undo/
 *     back_to_real``，规则校验 + 会话缓存，仅会话不落盘）；试下落子**先经本地围棋
 *     规则预校验**（``core/go-rules.js``，与后端同语义）——非法即时红 ✕ +
 *     原因 Toast（**不发送**服务器）；[◀] 至进入局面=回实战
 *     （标识消失）；[复弈]（确认弹窗 → REST ``POST /games/{id}/refight`` → 写
 *     tgo.recent + 跳对弈页续弈）；试下分析仅会话缓存（客户端 ``trial-store.js`` LRU）；
 *   - **深度/全局分析**：[深度分析]（当前局面 P2）→ [全局分析] 原地演化
 *     （缺失数据 → 进度呼吸 → 停止/复位；``global_analysis.done`` 后重查覆盖与
 *     报告入口，W-08 重连语义由 restore.request 附带 progress 恢复）；
 *   - **变化图预览**：点击推荐行 → 真棋半透明逐步动画（步数读本地偏好 5–15，固定
 *     700ms/步；播放到末手**停在末手静止显示、不自动关闭**；**点击棋盘任意位置＝
 *     暂停/继续（已播完则从头再次播放）**；[关闭预览]/ESC/定位操作关闭预览；预览
 *     期间隐藏棋盘 TOP5 选点标记，2026/09/13 人工决策）；
 *     [导出棋谱]；[报告] 入口（``analysis_complete`` 判定）。
 *
 * 分层：纯函数层（无 DOM，可无头测试 FE-RV-*）+ ``createView`` 控制器（驱动
 * 状态树/通信层/GameBoard；WS 回调仅经 store 派生，AGENTS §4）。
 */

import { GameBoard } from '../core/board.js';
import { CaptureCounter } from '../core/capture-counter.js';
import { createLocalStore, LS_KEYS } from '../core/localstore.js';
import { getPreviewSteps } from '../core/settings.js';
import { blackSideScore, blackSideValue, commentBubbleModel, dropUpSide, replayStones, shortMoveText } from '../core/game-model.js';
import { boardBubblePlacement, commentBubbleHTML } from '../core/comment-bubble.js';
import { checkMove, illegalMoveText, lastMoveCaptures, replayRulesPosition } from '../core/go-rules.js';
import { mainKey, parseMainKey } from '../core/state.js';
import { createTrialStore, isTrialKey, parseTrialKey } from '../core/trial-store.js';
import { createReplayBundle, purgeEmptyEntries } from '../core/replay-bundle.js';
import {
  createTerritoryTimeout,
  territoryButtonClasses,
  territoryButtonClassString,
  territoryButtonView,
  territoryClickIntent,
  territoryEnginePlan,
  territoryHeatPlan,
  territoryRequestAction,
  territoryWatchdogAction,
} from '../core/territory.js';
import { createReviewSidebarModule } from './review-sidebar.js';
import { createReviewSettleModule } from './review-settle.js';
import { parseContentDispositionFilename } from './review-list-view.js';
import { createInfoPop, groupMetaSegments, metaPopText } from '../core/info-row.js';
import { applyIconLit, iconLitPlan } from '../core/btn-lit.js';
import { wrBarAction } from './game-sidebar.js';
import {
  fractionToPercent,
  rankText,
} from '../core/fmt.js';

/* ============================================================
 * 纯函数层（无 DOM；可无头测试）
 * ============================================================ */

/** 主谱落子：取 moveNo ≤ n 的子集（含 0 边界）。 */
export function upToMainMoves(moves, n) {
  const list = Array.isArray(moves) ? moves : [];
  const limit = Number(n) || 0;
  return list
    .filter((m) => Number(m.moveNo) <= limit)
    .sort((a, b) => Number(a.moveNo) - Number(b.moveNo));
}

/**
 * 试下分支显示落子 = 主谱前缀（≤ 进入手数）+ 分支落子（相对 → 绝对 moveNo）。
 * @returns {Array<{moveNo,color,x,y,isPass}>}
 */
export function branchAbsMoves(moves, fromMoveNo, trialMoves = [], rel = Infinity) {
  const prefix = upToMainMoves(moves, fromMoveNo);
  const limit = rel === Infinity || rel === undefined ? Infinity : Number(rel);
  const branch = (Array.isArray(trialMoves) ? trialMoves : [])
    .filter((m) => Number(m.moveNo) <= limit)
    .map((m) => ({
      moveNo: Number(fromMoveNo) + Number(m.moveNo),
      color: m.color,
      x: m.x == null ? null : Number(m.x),
      y: m.y == null ? null : Number(m.y),
      isPass: Boolean(m.isPass),
    }));
  return [...prefix, ...branch];
}

/** 落子序列 → 双方累计提子（仅靠棋盘剩余反推）。 */
export function captureCounts({ size = 19, handicap = 0, moves = [] } = {}) {
  const stones = replayStones({ size, handicap, moves });
  const blackOnBoard = stones.filter((s) => s.color === 'black').length;
  const whiteOnBoard = stones.filter((s) => s.color === 'white').length;
  let blackPlayed = Number(handicap) || 0;
  let whitePlayed = 0;
  for (const m of moves) {
    if (m.isPass) continue;
    if (m.color === 'white' || m.color === 'W') whitePlayed += 1;
    else blackPlayed += 1;
  }
  // 提子 = 被提走（不再在盘）的对方子数
  return {
    black: Math.max(0, whitePlayed - whiteOnBoard), // 黑提（白子被提）
    white: Math.max(0, blackPlayed - blackOnBoard), // 白提（黑子被提）
  };
}

/** 当前应落子方（复盘只读展示；让子局首手为白）。 */
export function nextColorAbs(absMoveCount, handicap = 0) {
  const count = Math.max(0, Number(absMoveCount) || 0);
  const h = Number(handicap) || 0;
  const isWhite = h > 0 ? count % 2 === 0 : count % 2 === 1;
  return isWhite ? 'white' : 'black';
}

/**
 * 复盘棋面过渡判定（纯函数；2026/09/17）：复盘默认整盘替换（不播动画），
 * 仅当过渡恰为「正向单步且本手提子」（新增 1 子 = 该手棋、被提 ≥1 子）时，
 * 与对弈页同口径播放提子残影 + 落子动画（removeStone(capture) + applyMove）。
 * 方向判定：新增子的 moveNo 须大于过渡前的最大 moveNo——回退/跳转/整盘重建
 * 一律不满足（维持整盘替换；勿在 restore 路径扩散动画）。
 * @param {Array<{x:number,y:number,color:string,moveNo?:number}>} prev 当前显示棋子（self.displayedStones）
 * @param {Array<{x:number,y:number,color:string,moveNo?:number}>} next 目标棋子（replayStones 结果）
 * @returns {{added:Array,removed:Array,captureStep:boolean}}
 */
export function boardTransition(prev, next) {
  const prevList = Array.isArray(prev) ? prev : [];
  const nextList = Array.isArray(next) ? next : [];
  const same = (a, b) => a.x === b.x && a.y === b.y && a.color === b.color;
  const added = nextList.filter((n) => !prevList.some((q) => same(q, n)));
  const removed = prevList.filter((q) => !nextList.some((n) => same(n, q)));
  let prevMaxNo = -1;
  for (const q of prevList) {
    if (q.moveNo != null && q.moveNo > prevMaxNo) prevMaxNo = q.moveNo;
  }
  const captureStep = added.length === 1
    && removed.length > 0
    && prevList.length > 0
    && added[0].moveNo != null
    && added[0].moveNo > prevMaxNo;
  return { added, removed, captureStep };
}

/**
 * 复盘进入定位（纯函数，2026/09/14）：`?at=` 显式定位 > 本机记录的该局上次显示手数 > 末手。
 * 恢复口径与对弈页「任意入口恢复最近对局」同机制（`tgo.review-pos` 仅保留最近一条；
 * 试下分支不参与，落回进入前主谱手数）；越界一律回夹 [0, maxMove]（localStorage
 * 为信任边界，需防脏数据）。
 * @param {object} o
 * @param {string|number|null} [o.at]  route.query.at（仅合法非负整数参与；空/非法视为缺省）
 * @param {object|null} [o.saved]      localStorage `tgo.review-pos`（{gameId, moveNo}）
 * @param {number} o.gameId            当前对局 id（记录 id 不匹配 → 忽略）
 * @param {number} o.maxMove           当前末手
 * @returns {{moveNo:number, from:'at'|'saved'|'end'}}
 */
export function resolveReviewTarget({ at, saved, gameId, maxMove } = {}) {
  const max = Math.max(0, Math.trunc(Number(maxMove) || 0));
  const clamp = (n) => Math.max(0, Math.min(max, Math.trunc(Number(n))));
  const atRaw = at === null || at === undefined ? '' : String(at).trim();
  const atNum = Number(atRaw);
  if (atRaw !== '' && Number.isInteger(atNum) && atNum >= 0) {
    return { moveNo: clamp(atNum), from: 'at' };
  }
  const savedId = saved ? Number(saved.gameId) : NaN;
  const savedNo = saved ? Number(saved.moveNo) : NaN;
  if (savedId === Number(gameId) && Number.isInteger(savedNo) && savedNo >= 0) {
    return { moveNo: clamp(savedNo), from: 'saved' };
  }
  return { moveNo: max, from: 'end' };
}

/**
 * 试下 `trial.state` 回投后的显示相对手定位（纯函数，2026/09/12）。
 *
 * 规则：**替换语义**（分支中部落子 = 先撤销截断再落子）会连续回投多个收缩态 +
 * 一个增长态——`follow`（跟随分支尾）必须保持到分支**增长**（落子落地）才清除，
 * 否则后续更深的收缩态与最终落子态不再回夹 → 滑轨手数越界（`pos.rel > max`，
 * 曲线上标/推荐/点评的 `posKey` 落到已截断的旧分支键 → 数据不同步）；非跟随态
 * 一律回夹到分支长度（缩短时不越界）。
 * `transient` = 替换流程中的中间收缩态（瞬态）：调用方不应为其拉取推荐/点评。
 * @param {object} o {curRel, prevLen, nextLen, follow}
 * @returns {{rel:number, follow:boolean, transient:boolean}}
 */
export function trialRelAfterState(o = {}) {
  const nextLen = Math.max(0, Number(o.nextLen) || 0);
  const prevLen = Math.max(0, Number(o.prevLen) || 0);
  if (o.follow) {
    const transient = nextLen <= prevLen; // 仍在收缩 → 继续跟随（瞬态）
    return { rel: nextLen, follow: transient, transient };
  }
  const cur = Math.max(0, Number(o.curRel) || 0);
  return { rel: Math.min(cur, nextLen), follow: false, transient: false };
}

/**
 * [报告]/[结算] 槽位派生（2026/09/19 人工决策，PROMPTS L977–979）。
 *
 * - **终局未结算**（``finished`` 且 ``result`` 为空，即导入棋谱）→ ``'settle'``：
 *   [结算] 恒占原 [报告] 位置（未结算期间即使分析完整也不显示 [报告]）；
 * - 其余 → ``'report'``，仅分析数据完整（``analysis_complete``）时显示
 *   （既有口径：分析不完整隐藏报告入口，UI_UX §5.5.2）。
 * @param {{status?:string, result?:string|null, analysisComplete?:boolean}} opts
 * @returns {'settle'|'report'|'none'}
 */
export function reportSlotView(opts = {}) {
  const status = String(opts.status || '');
  if (status === 'finished' && opts.result == null) return 'settle';
  return opts.analysisComplete ? 'report' : 'none';
}

/**
 * 复盘信息行段（WEBUI 基线：第 N 手 / M · 19路 · 中国 · 贴7.5 · 分先 · 模式）。
 *  2026/09/10：追加自动点评开关徽章段（`{coach:true,on}`；复盘点评默认开启、
 *  可点击自由开/关，人工口径）。
 */
export function reviewMeta(opts = {}) {
  const {
    inTrial = false,
    current = 0,
    total = 0,
    boardSize = 19,
    rules = 'chinese',
    komi = 7.5,
    handicap = 0,
    mode = null,
    aiText = null,
    result = null,
    coachOn = null,
  } = opts;
  const segs = [];
  const num = `${current} / ${total}`;
  segs.push({ text: inTrial ? `试下 · 第 ${current} 手 / ${total}` : `第 ${num} 手`, trial: inTrial });
  const ruleMap = { chinese: '中国', japanese: '日本', aga: 'AGA' };
  segs.push({ text: `${boardSize}路` });
  segs.push({ text: ruleMap[rules] || String(rules || '') });
  if (handicap > 0) segs.push({ text: `让${handicap}子` });
  else segs.push({ text: `贴 ${komi}` });
  if (result) segs.push({ text: result, result: true });
  else if (mode === 'human_human') segs.push({ text: '人人' });
  else segs.push({ text: aiText || 'AI' });
  if (coachOn !== null) segs.push({ text: '自动点评', coach: true, on: coachOn !== false });
  return segs;
}

/**
 * 「待补 N 手」计数文案**单一来源**：`deriveAnalyzeButton` 的 `label` 与
 * `renderAnalyzeBtnHTML` 的定宽计数盒共用（禁两处字面量各自演化）。
 */
const ANALYZE_REMAIN_PREFIX = '补分析 · 待补 ';
const ANALYZE_REMAIN_SUFFIX = ' 手';

/** 计数文案（`remaining` 为剩余待补手数）。 */
function analyzeRemainLabel(remaining) {
  return `${ANALYZE_REMAIN_PREFIX}${remaining}${ANALYZE_REMAIN_SUFFIX}`;
}

/**
 * 底部分析按钮三态演化（T6.8；UI_UX §5.5.2：全局分析由深度分析按钮原地演化）。
 *
 * 进度呈现（2026/09/17 决策：「不设进度条」，仅文案计数；2026/09/19 人工反馈
 * 二次修订）：**运行中与空闲态统一同形 `补分析 · 待补 N 手`（只示剩余待补手数）**
 * ——旧 `已补 x/y · 点击停止`/`停止分析` 随分母与长尾数字变形会让按钮宽度跳动；
 * 呼吸不变；点击＝**单击即中断**（同日修订：旧「先布防再确认」两步与单击预期
 * 不符，实际感受为无法中断；见 `onAnalyzeClick`）。
 * `total` 未如（服务端 progress 尚未回投）时剩余数用本地缺失数兜底（`missing`），
 * 不得编造分母/余量。
 * @returns {{kind:'none'|'deep'|'global'|'progress', label:string,
 *            remaining:number|null, breathe:boolean, disabled:boolean,
 *            reason:string|null, sub:string}} `remaining` 仅供计数盒定宽渲染用。
 */
export function deriveAnalyzeButton(opts = {}) {
  const st = String(opts.engineState || '').toUpperCase();
  const dead = st === 'DEAD' || st === 'FATAL';
  const init = st === 'INIT';
  const stopped = st === 'STOPPED';
  const reason = dead
    ? '引擎不可用'
    : init
      ? '引擎加载中，分析延后可用'
      : stopped
        ? '引擎未启动'
        : null;
  const disabled = Boolean(dead || init || stopped);
  if (opts.inTrial) {
    return { kind: 'none', label: '', remaining: null, breathe: false, disabled: true, reason: '试下模式', sub: '' };
  }
  const missing = Math.max(0, Number(opts.missing) || 0);
  const deepRunning = Boolean(opts.deepRunning);
  const globalRunning = Boolean(opts.globalRunning);
  const done = Number(opts.globalDone) || 0;
  const totalG = Number(opts.globalTotal) || 0;
  if (globalRunning) {
    // 统一文案（2026/09/19 人工反馈）：运行中只显示**剩余待补**，与空闲态同形——
    // 去除 `已补 x/y · 点击停止`/`停止分析` 等形变文案（按钮跳动来源）；
    // 单击即中断（stop 请求已下发时忽略重复点击，见 onAnalyzeClick）。
    const remaining = totalG > 0 ? Math.max(0, totalG - done) : missing;
    return {
      kind: 'progress',
      label: analyzeRemainLabel(remaining),
      remaining,
      // 呼吸与禁用互斥（引擎降级时不呼吸，避免动画覆盖 [disabled] 半透明；2026/09/14）
      breathe: !disabled,
      disabled,
      reason,
      sub: '点击中断（已完成手保留，可续跑）',
    };
  }
  if (deepRunning) {
    // 进行中（2026/09/14 人工调整）：仅呼吸——文案保持 [深度分析]、不设禁点
    // （重复点击由 onAnalyzeClick 忽略）；引擎降级时不呼吸（同上）。
    return {
      kind: 'deep',
      label: '深度分析',
      remaining: null,
      breathe: !disabled,
      disabled,
      reason,
      sub: '',
    };
  }
  if (missing > 0) {
    return {
      kind: 'global',
      label: analyzeRemainLabel(missing),
      remaining: missing,
      breathe: false,
      disabled,
      reason,
      sub: '点击逐手补标准分析（可中断续跑）',
    };
  }
  return {
    kind: 'deep',
    label: '深度分析',
    remaining: null,
    breathe: false,
    disabled,
    reason,
    sub: '对当前局面一次性深算',
  };
}

/**
 * [深度分析] 按钮图标点亮口径（2026/09/17 人工决策）。
 *
 * 点亮 = 深算结果已到达且**仍对应当前显示局面**（`resultKey === currentKey`）；
 * 「再次深算」（`running`）与「切换到其它局面」（键不相等）即熄灭——点亮是数据
 * 有效性状态，不是动画残留。到达瞬间的一次性闪光由视图依上一帧值派生。
 * @param {{resultKey?:string|null, currentKey?:string, running?:boolean}} opts
 * @returns {boolean}
 */
export function deepAnalyzeLit({ resultKey = null, currentKey = '', running = false } = {}) {
  if (running) return false;
  return Boolean(resultKey) && resultKey === currentKey;
}

/** 空态文案。 */
export function reviewEmptyCopy(kind) {
  return kind === 'load-fail'
    ? { title: '对局不存在或已删除', text: '返回棋谱列表查看其它对局' }
    : { title: '回放数据加载失败', text: '请稍后重试，或返回棋谱列表' };
}

/**
 * WS 错误信封的复盘处置口径（BUG-091 人工反馈：试下逐手弹「引擎不可用」）。
 *
 * 试下**逐手**推荐/领地补算都是后台按需请求，引擎不可用时服务端逐条回投
 * `ENGINE_DEAD`/`ENGINE_FATAL` 信封——照单弹报会变成每手一个 Toast。引擎不可用的
 * 降级已由全局引擎态（横幅/胶囊/卡片灰置）与各入口守卫表达，故此类信封**静默**；
 * `ENGINE_BUSY` 属用户可见的临时态（非全局降级），保留弹报。
 * @returns {{resetDeep:boolean, clearRecommend:boolean, resetGlobal:boolean, silence:boolean}}
 *   resetDeep=复位深算进行态（停呼吸）；clearRecommend=解除试下推荐 loading；
 *   resetGlobal=复位全局分析进行态（M-14）；silence=不弹报。
 */
export function reviewErrorOutcome(code) {
  const c = String(code || '').toUpperCase();
  const dead = c === 'ENGINE_DEAD' || c === 'ENGINE_FATAL';
  const busy = c === 'ENGINE_BUSY';
  return {
    resetDeep: dead || busy || c === 'DEEP_ANALYSIS_RUNNING',
    clearRecommend: dead || busy,
    // M-14：全局分析遇引擎类错误/任务丢弃（on_drop）只有 error 信封——同步复位
    // 全局分析进行态，否则按钮呼吸/进度条永久滞留（旧实现仅完成消息复位）
    resetGlobal: dead || busy,
    silence: dead,
  };
}

/**
 * ``trial.state`` 处置决策（M-13）：区分「新分支进入（用户已发起 enter）」、
 * 「当前分支更新」与「已退出/非预期分支的陈旧回投（忽略）」。
 *
 * 旧实现以 ``!self.trial || self.trial.id !== trialId`` 无条件接纳任何 id：
 * 回实战（goMain）后旧分支的迟到回投会把用户重新拉回试下分支（视图与 store
 * 双双回到已退出的分支）。
 * @param {{activeId?:number|null, pendingEnter?:boolean, incomingId?:number|null,
 *          exitedId?:number|null}} opts
 * @returns {'adopt'|'update'|'ignore'}
 */
export function trialStateDisposition(opts = {}) {
  const incomingId = opts.incomingId == null ? null : Number(opts.incomingId);
  if (incomingId == null || !Number.isFinite(incomingId)) return 'ignore';
  const activeId = opts.activeId == null ? null : Number(opts.activeId);
  if (activeId != null && incomingId === activeId) return 'update';
  const exitedId = opts.exitedId == null ? null : Number(opts.exitedId);
  if (incomingId === exitedId) return 'ignore';
  if (opts.pendingEnter) return 'adopt';
  return 'ignore';
}

/**
 * 推荐拉取决策（BUG-091 + 2026/09/21 批量快照）：实时缓存命中 → 直接应用；
 * **批量快照命中**（``GET /replay``，未被失效）→ 本地应用（零请求）；试下推荐由**引擎
 * 会话现算**，引擎不可用时本地降级（不发无效请求、不进 loading，直接空态文案）；
 * 其余回落 WS ``recommend.request``（主谱读**持久化** ``position_analyses``，引擎无关）。
 * @param {{hasCache?:boolean, hasBundle?:boolean, trialKey?:boolean, engineDown?:boolean}} opts
 * @returns {'cache'|'bundle'|'local-fallback'|'request'}
 */
export function recommendFetchAction(opts = {}) {
  if (opts.hasCache) return 'cache';
  if (opts.hasBundle) return 'bundle';
  if (opts.trialKey && opts.engineDown) return 'local-fallback';
  return 'request';
}

/* ============================================================
 * ReviewView 控制器
 * ============================================================ */

/** 推荐请求无回执兜底（解除 loading 允许重试）。 */
const RECOMMEND_TIMEOUT_MS = 15000;
/** 变化图每步时长 ms。预览步数读本地偏好 `tgo.preview-steps`（5–15，管理页 T6.10）。 */
const PREVIEW_STEP_MS = 700;
/** 自动播放固定步进间隔 ms（无长按/双击调速；改此处即可调整速度）。 */
const AUTOPLAY_STEP_MS = 1200;
/** 全局分析开始后忽略「停止」点击的防误触窗口 ms（吸收开始双击的第二击；2026/09/19）。 */
const GLOBAL_STOP_GUARD_MS = 500;

export function createView(rootEl, props) {
  const { route } = props;
  const store = props.store;
  const api = props.api;
  const hub = props.hub;
  const ls = props.ls || createLocalStore();
  const toast = props.toast || (() => {});
  const confirmDialog = props.confirm || (() => Promise.resolve(false));
  const nav = props.nav || ((h) => {
    location.hash = h;
  });
  const audio = props.audio || null;

  /** 控制器状态（视图生命周期内单例）。 */
  const self = {
    phase: 'init', // init | loading | ready | error
    gameId: null,
    meta: null, // REST 详情（含覆盖信息）
    pos: { mode: 'main', moveNo: 0 }, // 当前显示位置
    trial: null, // { id, fromMoveNo, moves:[abs 归一] }
    cache: createTrialStore({ max: 256 }), // 客户端推荐/点评会话缓存（LRU）
    // 复盘批量快照（``GET /replay``：曲线 + 每手推荐/点评；领地懒加载）——2026/09/21
    // 性能优化：逐手步进不再每次往返（命中快照即本地应用）；失效后回落 WS
    bundle: createReplayBundle(),
    bundleOwnershipLoading: false,
    recToken: 0,
    recTimer: null,
    recLoading: false,
    territory: {
      active: false, // 热力显示中
      auto: false, // 每步自动连续模式（双击开启）
      pending: false, // 已向服务端请求当前局面
      reqKey: null, // 在途请求的局面键
      atKey: null, // 领地作用局面（单击瞬态/连续跟随的推进判定基准）
      shown: null, // 当前显示的热力值（连续模式无数据时保留）
      dblTimer: null, // 双击判定
      timeout: null, // 请求超时闸（core/territory.createTerritoryTimeout）
    },
    globalStopping: false, // 停止请求已下发、等待 global_analysis.done 收尾
    globalStartedAt: 0, // 全局分析开始时刻（防误触窗口基准，见 GLOBAL_STOP_GUARD_MS）
    settling: false, // 结算模式（死子确认，锁定回放/试下交互）
    settle: null, // 复盘结算模块（createReviewSettleModule，惰建）
    // 图标点亮（2026/09/17；仅 [深度分析]——领地为主题色填充，不用图标点亮）
    deepLitKey: null, // [深度分析] 已点亮结果所属局面键（=当前局面才点亮；换局/重算即熄）
    deepLit: false, // [深度分析] 上一帧点亮态（判定到达闪光）
    preview: null, // 变化图预览 {pts, step, playing, timer}
    autoplay: null, // {timer, step}
    board: null,
    counter: null,
    sidebar: null,
    renderedKey: null,
    // 自动点评开关（人工口径 2026/09/10：复盘默认开启，徽章可点击自由开/关）
    coach: { enabled: true },
    metaText: '', // 信息行全文（移动端行首图标弹层内容）
    infoPop: createInfoPop(), // 「全部对局信息」顶层弹层（2026/09/13 移动端）
    displayedStones: [], // 当前显示盘面棋子
    wrShown: false, // 胜率条已渲染过（保留式加载：防“空态↔条”闪烁）
    _resizeNote: null,
    _noteRect: null, // 棋盘左上角提示矩形缓存（相对棋盘容器；缩放/平移期间零 DOM 读取）
    unsub: null,
    onError: null,
    _escKey: null,
    _docClick: null,
    _lastTrialPlay: null, // 试下最近一次落子尝试（服务端兜底拒绝时 flashIllegal 定位）
    _exitedTrialId: null, // M-13：已退出试下分支 id（拒绝其迟到回投；新分支采纳时清空）
  };

  let destroyed = false;
  let syncRaf = null; // L-10：rAF 合并渲染帧（高频消息同帧只整帧重建一次）
  const mqLayout = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
    ? window.matchMedia('(min-width: 768px)')
    : null;
  let mqLayoutHandler = null;

  /* ---------------- 工具 ---------------- */

  function qRef(sel, scope) {
    return (scope || rootEl).querySelector(sel);
  }

  function playSound(name) {
    if (audio && typeof audio.play === 'function') audio.play(name);
  }

  function storeGame() {
    return store.getState().game;
  }
  function engineState() {
    const s = store.getState();
    return (s.engine && s.engine.state) || '';
  }
  function isEngineDown() {
    const st = String(engineState()).toUpperCase();
    return st === 'DEAD' || st === 'FATAL';
  }

  /** 当前显示局面键（main:N / trial:T:R）。 */
  function posKey() {
    if (self.pos.mode === 'trial' && self.trial && self.trial.id != null) {
      return `trial:${self.trial.id}:${self.pos.rel}`;
    }
    return mainKey(self.pos.moveNo);
  }

  /** 当前显示落子（绝对 moveNo 语义）列表。 */
  function displayMoves() {
    const g = storeGame();
    if (!g) return [];
    const main = g.moves || [];
    if (self.pos.mode === 'trial' && self.trial) {
      return branchAbsMoves(main, self.trial.fromMoveNo, self.trial.moves, self.pos.rel);
    }
    return upToMainMoves(main, self.pos.moveNo);
  }

  /** 从 store.review / 实时缓存 / 批量快照取当前局面推荐。 */
  function reviewFor(key) {
    const s = store.getState();
    if (s.review && s.review.key === key) return s.review;
    const hit = self.cache.get(key);
    if (hit) return hit;
    return self.bundle.get(key);
  }

  /* ---------------- 生命周期 ---------------- */
  function render() {
    rootEl.className = 'layout game';
    rootEl.innerHTML = '';
    subscribe();
    bindWindow();
    beginLoad();
  }

  function destroy() {
    destroyed = true;
    if (self.unsub) {
      self.unsub();
      self.unsub = null;
    }
    if (self.onError) {
      window.removeEventListener('tgo:error', self.onError);
      self.onError = null;
    }
    if (self._escKey) {
      document.removeEventListener('keydown', self._escKey, true);
      self._escKey = null;
    }
    if (self._docClick) {
      document.removeEventListener('pointerdown', self._docClick, true);
      self._docClick = null;
    }
    if (self._resizeNote) {
      window.removeEventListener('resize', self._resizeNote);
      self._resizeNote = null;
    }
    if (mqLayoutHandler && mqLayout) {
      mqLayout.removeEventListener('change', mqLayoutHandler);
      mqLayoutHandler = null;
    }
    stopAutoplay();
    stopPreview();
    // L-10：取消滑轨 rAF 与合并渲染帧（旧实现 destroy 后仍可回调 seek/render）
    if (syncRaf != null) {
      cancelAnimationFrame(syncRaf);
      syncRaf = null;
    }
    if (sliderRaf != null) {
      cancelAnimationFrame(sliderRaf);
      sliderRaf = null;
    }
    sliderPending = null;
    if (self.recTimer) {
      clearTimeout(self.recTimer);
      self.recTimer = null;
    }
    if (self.territory.dblTimer) {
      clearTimeout(self.territory.dblTimer);
      self.territory.dblTimer = null;
    }
    if (self.territory.timeout) {
      self.territory.timeout.cancel();
      self.territory.timeout = null;
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
    if (self.settle) {
      self.settle.destroy();
      self.settle = null;
    }
    // 「全部对局信息」弹层（2026/09/13 移动端信息行）
    if (self.infoPop) {
      self.infoPop.destroy();
      self.infoPop = null;
    }
    if (hub && typeof hub.closeGame === 'function') hub.closeGame();
    rootEl.innerHTML = '';
  }

  /* ---------------- 加载与数据 ---------------- */

  async function beginLoad() {
    const gid = Number(route.params && route.params.id);
    if (!Number.isInteger(gid) || gid <= 0) {
      showError('load-fail');
      return;
    }
    self.gameId = gid;
    // 「复盘来源对局」登记（2026/09/14）：任何进入复盘的入口（列表 [回放]、结算 [复盘]、
    // 报告 [回放该手]、直达 URL）都在此登记；列表下次装载时据此定位到本局并选中
    ls.set(LS_KEYS.reviewSelect, { gameId: gid, ts: Date.now() });
    self.phase = 'loading';
    setPanel('loading', '正在加载棋谱…');
    try {
      // 批量快照与详情**并行**（互补：详情=对局/落子，快照=曲线 + 每手推荐/点评）
      const [res] = await Promise.all([api.get(`/games/${gid}`), loadBundle(gid)]);
      if (destroyed) return;
      const detail = res && res.data;
      if (!detail) throw Object.assign(new Error('对局数据为空'), { code: 'GAME_NOT_FOUND' });
      self.meta = detail;
      store.dispatch({ type: 'game.state', data: synthGameState(detail) });
      // 曲线：快照内联（与 /curve 同源）→ 命中即零请求；未命中回落 REST /curve
      const snapCurve = self.bundle.curve();
      if (snapCurve) {
        store.dispatch({ type: 'curve.set', data: snapCurve });
      } else {
        try {
          const cv = await api.get(`/games/${gid}/curve`);
          if (!destroyed && Array.isArray(cv && cv.data)) {
            store.dispatch({ type: 'curve.set', data: cv.data });
          }
        } catch {
          /* 曲线可缺省（无分析），复盘仍可用 */
        }
      }
      if (destroyed) return;
      self.phase = 'ready';
      setPanel('game');
      buildShell();
      // 打开 WS（recommend/deep/global/ownership/analysis 推送）
      if (hub && typeof hub.connectGame === 'function') hub.connectGame(gid);
      // 定位（2026/09/14）：`?at=N`（T6.9 报告 [回放该手] 直达）> 本机记录的该局
      // 上次显示手数（同对弈页「任意入口恢复最近对局」机制）> 末手；越界回夹
      const maxMove = lastMoveNoOf(detail);
      const entryTarget = resolveReviewTarget({
        at: route.query && route.query.at,
        saved: ls.get(LS_KEYS.reviewPos, null),
        gameId: gid,
        maxMove,
      });
      seekTo(entryTarget.moveNo);
    } catch (err) {
      if (destroyed) return;
      const code = (err && err.code) || '';
      if (code === 'GAME_NOT_FOUND' || err.status === 404) {
        showError('load-fail');
      } else {
        showError('generic');
      }
    }
  }

  /**
   * 拉取批量快照（``GET /replay``，与详情并行）。失败**静默**：逐手 WS 与 REST
   * ``/curve`` 路径照常工作（快照是纯加速，不是正确性依赖）。
   */
  async function loadBundle(gid) {
    try {
      const res = await api.get(`/games/${gid}/replay`);
      if (destroyed || !res || !res.data) return;
      self.bundle.set(res.data);
    } catch {
      /* 快照可缺省（引擎/网络异常不影响回放：回落逐手 WS） */
    }
  }

  /**
   * 补分析/结算后刷新快照（数据已变：新快照替换旧的）。
   *
   * 先清掉 LRU 中的**空条目**（``has_data:false``）——它优先级高于快照，会把补分析
   * 后新填充的局面遮成空态；再重发当前局面推荐（命中新快照 → 新卡片，不发请求）。
   */
  async function refreshBundle() {
    if (!self.gameId || destroyed) return;
    try {
      const res = await api.get(`/games/${self.gameId}/replay`);
      if (destroyed || !res || !res.data) return;
      purgeEmptyEntries(self.cache);
      self.bundle.set(res.data);
      const snapCurve = self.bundle.curve();
      if (Array.isArray(snapCurve)) {
        store.dispatch({ type: 'curve.set', data: snapCurve });
      }
    } catch {
      /* 刷新失败不阻断（逐手 WS 仍可补齐） */
    }
    if (!destroyed && self.pos.mode === 'main') requestRecommendFor(posKey());
  }

  /** REST 详情 → game.state 合成（字段与 API §3.1.2 一致）。 */
  function synthGameState(detail) {
    const d = detail || {};
    const game = {
      id: Number(d.id),
      mode: d.mode,
      board_size: d.board_size,
      rules: d.rules,
      komi: d.komi,
      handicap: d.handicap,
      human_color: d.human_color,
      status: d.status,
      result: d.result,
      black_name: d.black_name,
      black_rank: d.black_rank,
      white_name: d.white_name,
      white_rank: d.white_rank,
      ai_style: d.ai_style,
      ai_level: d.ai_level,
      adaptive_enabled: d.adaptive_enabled,
      coaching_enabled: d.coaching_enabled,
      favorite: d.favorite,
      last_move_no: d.last_move_no,
      black_captures: d.black_captures,
      white_captures: d.white_captures,
      undo_count: d.undo_count,
    };
    return {
      game_id: Number(d.id),
      status: d.status,
      game,
      moves: (d.moves || []).map((m) => ({
        move_no: m.move_no,
        color: m.color,
        x: m.x,
        y: m.y,
        is_pass: m.is_pass,
      })),
      moves_count: d.moves_count,
      analyses_count: d.analyses_count,
      analysis_complete: Boolean(d.analysis_complete),
      next_color: d.next_color || null,
      turn: d.turn || null,
    };
  }

  function lastMoveNoOf(detail) {
    const n = Number(detail && detail.last_move_no);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  function showError(kind) {
    self.phase = 'error';
    const copy = reviewEmptyCopy(kind);
    rootEl.innerHTML = `
      <div class="center-panel" data-panel="error">
        <div class="empty-state">
          <svg class="art" aria-hidden="true"><use href="#i-empty-go"/></svg>
          <div class="t">${copy.title}</div>
          <div class="s">${copy.text}</div>
          <div class="empty-actions" style="margin-top:16px">
            <a class="btn btn-primary" href="#/review">返回棋谱列表</a>
          </div>
        </div>
      </div>`;
  }

  function setPanel(name, text) {
    if (destroyed) return;
    if (name === 'game') {
      rootEl.innerHTML = reviewShellHTML();
      return;
    }
    rootEl.innerHTML = `
      <div class="center-panel" data-panel="${name}">
        <div class="spin" aria-hidden="true"></div>
        <p class="panel-text">${text || ''}</p>
      </div>`;
  }

  /* ---------------- 壳 DOM（WEBUI review.html 基线结构） ---------------- */

  function reviewShellHTML() {
    return `
    <section class="board-zone">
      <div class="info-row">
        <button class="trial-pill num u-hide" type="button" data-act="backToReal"
                data-ref="rvTrialPill" aria-label="试下分支位置（点击返回实战）"></button>
        <button class="btn btn-ghost info-icon" type="button" data-act="infoPop"
                title="对局信息" aria-label="对局信息（点击看全部）">
          <svg class="icon" aria-hidden="true"><use href="#i-info"/></svg>
        </button>
        <div class="info-meta num" data-ref="rvMeta"></div>
        <div class="info-actions">
          <button class="btn btn-ghost" type="button" data-act="back" title="返回棋谱列表">
            <svg class="icon" aria-hidden="true"><use href="#i-back"/></svg>返回
          </button>
          <button class="btn btn-ghost" type="button" data-act="export" title="导出棋谱">
            <svg class="icon" aria-hidden="true"><use href="#i-download"/></svg>导出
          </button>
          <button class="btn btn-ghost u-hide" type="button" data-act="report" title="对局报告">报告</button>
          <button class="btn btn-ghost u-hide" type="button" data-act="settle" title="对局未结算：标记死子并结算">结算</button>
        </div>
        <button class="btn btn-ghost menu-more" type="button" data-act="more" title="更多"
                aria-label="更多操作" aria-expanded="false">
          <svg class="icon" aria-hidden="true" style="width:17px;height:17px"><use href="#i-more"/></svg>
        </button>
      </div>

      <div class="board-wrap" data-ref="boardWrap">
        <div class="board-note u-hide" data-ref="rvNote"></div>
        <div class="board-bubble u-hide" data-ref="rvBubble" role="dialog" aria-label="当前手点评"></div>
      </div>

      <div class="track" data-ref="track">
        <button class="track-btn" type="button" data-act="prev" title="上一手 ◀" aria-label="上一手">
          <svg class="icon" aria-hidden="true" style="width:15px;height:15px"><use href="#i-back"/></svg>
        </button>
        <span class="move-label num" data-ref="rvTrackLabel" role="button" tabindex="0"
              title="点击开启/暂停自动播放" aria-label="回放手数">0 / 0</span>
        <div class="rv-slider" data-ref="rvSlider" role="slider" tabindex="0"
             aria-label="回放手数" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"
             aria-valuetext="0 / 0">
          <div class="rv-slider-fill" aria-hidden="true"></div>
          <div class="rv-slider-thumb" aria-hidden="true"></div>
          <div class="rv-slider-tip u-hide" data-ref="rvSliderTip" role="status" aria-live="polite"></div>
        </div>
        <button class="track-btn" type="button" data-act="next" title="下一手 ▶" aria-label="下一手">
          <svg class="icon" aria-hidden="true" style="width:15px;height:15px;transform:scaleX(-1)"><use href="#i-back"/></svg>
        </button>
        <span class="track-autop" data-ref="rvAutoTip">点击手数区域开启自动播放</span>
      </div>

      <div class="bottom-row">
        <div class="wr-bar" data-ref="rvWrBar" role="img" aria-label="黑白胜率"></div>
        <div class="captures" data-ref="rvCaptures"></div>
        <div class="bottom-actions" data-ref="rvActions"></div>
      </div>
      <div class="preview-chip u-hide" data-ref="rvPreviewChip" role="status">
        <span class="pv-text" data-ref="rvPreviewText"><span class="pv-label" data-ref="rvPreviewLabel">变化图预览</span> <span class="pv-count num" data-ref="rvPreviewCount">0/0</span></span>
        <button class="btn btn-ghost btn-sm" type="button" data-act="closePreview">关闭预览</button>
      </div>
      <!-- 普通展开（非 menu 语义，2026/09/19 人工决策：去 role=menu/menuitem/aria-haspopup） -->
      <div class="info-menu u-hide" data-ref="rvMoreMenu">
        <button class="btn btn-ghost" type="button" data-act="back">返回</button>
        <button class="btn btn-ghost" type="button" data-act="export">导出</button>
        <button class="btn btn-ghost u-hide" type="button" data-act="report">报告</button>
        <button class="btn btn-ghost u-hide" type="button" data-act="settle">结算</button>
      </div>
    </section>
    <div class="settle-drawer-root u-hide" data-ref="rvSettleMobile" role="region" aria-label="终局结算"></div>
    <aside class="sidebar" aria-label="复盘分析侧栏">
      <div data-ref="rvSidebarBody"></div>
      <div class="u-hide" data-ref="rvSettleDesktop" role="region" aria-label="终局结算"></div>
    </aside>
    <div class="drawer-root collapsed u-hide" data-ref="rvDrawerRoot">
      <div class="drawer-mask" data-ref="rvDrawerMask"></div>
      <div class="game-drawer" data-ref="rvGameDrawer" role="region" aria-label="复盘分析">
        <button type="button" class="drawer-grip" data-ref="rvDrawerGrip"
                aria-expanded="false" aria-label="展开复盘分析" title="轻点收起/展开"></button>
        <div class="drawer-head">
          <span class="drawer-title">复盘分析</span>
          <button class="btn btn-ghost btn-sm drawer-close" type="button" data-ref="rvDrawerClose"
                  aria-label="收起复盘分析">
            <svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>
          </button>
        </div>
        <div class="drawer-body" data-ref="rvDrawerBody"></div>
      </div>
    </div>`;
  }

  function buildShell() {
    bindActions();
    const wrap = qRef('[data-ref="boardWrap"]');
    const g = storeGame() || {};
    const size = (g.params && g.params.boardSize) || 19;
    self.board = new GameBoard(wrap, {
      size,
      toMove: 'black',
      stones: [],
      interactive: true, // 复盘需点击棋子（点评气泡）/空点（试下）
      hoverGhost: true, // 触摸首点预览/双击进试下（仅变化图播放时关闭，见 syncAll）
      engineDead: false,
      lastMarker: 'ring',
      announceMoves: false,
      onIntersection: (x, y) => onBoardPoint(x, y),
      onSelectStone: (pt) => onBoardStone(pt),
      // 触摸屏：单次轻点棋盘空白（空点/网格外）→ 收起点评气泡（鼠标空点已有 onBoardPoint 同口径）
      onBlankTap: () => clearBubble(),
      // 视角变化（缩放/平移/容器尺寸）→ 重算左上角提示的半透明降级（2026/09/24）
      onViewChange: () => applyNoteOverlap(),
    });
    self.displayedStones = []; // 新棋盘从空盘开始（过渡动画判定基准与棋盘保持一致）
    mountCounter();
    mountSidebar();
  }

  function mountCounter() {
    const host = qRef('[data-ref="rvCaptures"]');
    if (!host || self.counter) return;
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    self.counter = new CaptureCounter(canvas, {
      current: 'black',
      blackCaptures: 0,
      whiteCaptures: 0,
    });
  }

  function mountSidebar() {
    const body = qRef('[data-ref="rvSidebarBody"]');
    if (!body || self.sidebar) return;
    self.sidebar = createReviewSidebarModule({
      store,
      hosts: {
        desktop: body,
        drawerRoot: qRef('[data-ref="rvDrawerRoot"]'),
        drawerMask: qRef('[data-ref="rvDrawerMask"]'),
        gameDrawer: qRef('[data-ref="rvGameDrawer"]'),
        drawerGrip: qRef('[data-ref="rvDrawerGrip"]'),
        drawerBody: qRef('[data-ref="rvDrawerBody"]'),
      },
      getPos: () => getPosDesc(),
      getSettleScores: () => {
        // 终局结算目数（REST 详情字段；仅双 PASS 确认结算局非空，供信息卡 hover）
        const d = self.meta || {};
        return { blackScore: d.black_score, whiteScore: d.white_score };
      },
      onSeek: (target) => seekCurveTarget(target),
      onPickVariation: (idx) => startVariationPreview(idx),
      toast,
    });
    self.sidebar.render();
  }

  /** 供侧栏模块读取控制器本地显示局面。 */
  function getPosDesc() {
    const inTrial = self.pos.mode === 'trial';
    const rel = inTrial ? Number(self.pos.rel) || 0 : Number(self.pos.moveNo) || 0;
    // 曲线按**绝对手数**绘制与交互（试下 = 进入手 + 相对手）：当前竖线/点击反解同域；
    // 文案仍按模式区分（试下显示分支相对手）。
    const abs = inTrial && self.trial ? Number(self.trial.fromMoveNo) + rel : rel;
    const g = storeGame();
    return {
      key: posKey(),
      current: abs,
      inTrial,
      totalMoveNo: g ? g.lastMoveNo : 0,
      enterMoveNo: self.trial ? self.trial.fromMoveNo : 0,
      trialPts: inTrial ? buildTrialPtsAbs() : [],
      noteText: currentNoteText(),
      moveDesc: {
        inTrial,
        labelText: inTrial
          ? `试下分支 · 第 ${rel} 手`
          : `第 ${rel} 手${rel > 0 ? '（主谱）' : '（初始）'}`,
      },
    };
  }

  /** 棋盘提示信息（试下分支详情）→ 侧栏对局信息卡底部一行（PASS 改在信息行手数后显示）。 */
  function currentNoteText() {
    const g = storeGame();
    if (!g) return null;
    const inTrial = self.pos.mode === 'trial';
    const cur = inTrial ? Number(self.pos.rel) || 0 : Number(self.pos.moveNo) || 0;
    if (inTrial && cur > 0 && self.trial) {
      return `试下分支 · 第 ${cur} 手（自第 ${self.trial.fromMoveNo} 手进入）`;
    }
    return null;
  }

  /** 试下分支曲线点（会话 root → 绝对手数 enter+rel）。 */
  function buildTrialPtsAbs() {
    if (!self.trial) return [];
    const out = [];
    for (const m of self.trial.moves) {
      const rel = Number(m.moveNo);
      const key = `trial:${self.trial.id}:${rel}`;
      const rec = reviewFor(key);
      const w = recBlackWinrate(rec);
      const s = recBlackScore(rec);
      if (w != null) {
        out.push({ moveNo: self.trial.fromMoveNo + rel, winrate: w, scoreLead: s });
      }
    }
    return out;
  }

  /**
   * 复盘推荐载荷 → 黑方视角胜率/目差（C16 胜率条 / 曲线等**固定黑方**展示用）。
   *
   * 视角（2026/09/11 人工确认）：``review.recommend`` 载荷为**当前执色方视角**
   * （AI 推荐卡片跟随行棋方）；对局信息卡与胜率目差曲线（黑）保持固定黑方，
   * 统一经 ``game-model.blackSideValue/blackSideScore`` 换算（单一口径）。
   */
  function recBlackWinrate(rec) {
    if (!rec || !rec.root) return null;
    return blackSideValue(rec.root.winrate, rec.side);
  }

  /** 复盘推荐载荷 → 黑方视角目差（同上）。 */
  function recBlackScore(rec) {
    if (!rec || !rec.root) return null;
    return blackSideScore(rec.root.score_lead, rec.side);
  }

  /* ---------------- store 订阅 ---------------- */

  function subscribe() {
    if (self.unsub) return;
    self.unsub = store.subscribe((state, message) => {
      if (!destroyed) onStoreChange(state, message || {});
    });
  }

  function onStoreChange(state, message) {
    if (self.phase !== 'ready') return;
    const type = message.type || '';

    // —— 一次性副作用（全局完成等） ——
    if (type === 'game.state') {
      // 服务端权威快照会**复位** review 切片（core/state.js `applyGameState`；WS 连接即推送）。
      // 旧实现依赖「派发 review.pending → WS 异步回投」在该复位之后补齐，故切片不会被清空；
      // 批量快照（2026/09/21）为**同步本地命中**，先于复位派发 → 复位后须按当前局面重派，
      // 否则 AI 推荐/点评卡停在空态直到用户手动步进。命中缓存/快照时零请求，其余回落 WS。
      if (!self.settling) requestRecommendFor(posKey());
      syncButtons();
      refreshSidebar();
      return;
    }
    if (type === 'game.finished') {
      // 结算完成：本页结算由结算模块 onDone 驱动（此处让位，避免重复收尾）；非结算
      // 模式下的终局（他端结算/认输）→ 轻量刷新详情（目数/分析覆盖）与按钮槽位
      if (!self.settling) {
        refreshDetail();
        refreshBundle();
        syncButtons();
      }
      return;
    }
    if (type === 'global_analysis.done') {
      // 被中断（interrupted）时不报「完成」——停止点击已即时 Toast「已停止分析」，
      // 此处再报“完成”与事实不符；仅清停止态并刷新覆盖率（还原为 [补分析]）。
      const interrupted = Boolean(message.data && message.data.interrupted);
      self.globalStopping = false;
      refreshAfterGlobal();
      if (!interrupted) toast({ level: 'success', text: '全局分析完成', key: 'rv-global-done' });
    }
    if (type === 'deep_analysis.result') {
      const key = message.data && message.data.position_key;
      if (key) {
        self.deepLitKey = key;   // [深度分析] 点亮归属局面（切到其它局面即自动熄灭）
        // 深算结果仅会话生效（快照里没有）→ **先失效快照该键**（含领地），再清实时缓存
        // 并重拉：否则本地命中会把旧快照当新数据展示（2026/09/21）。
        self.bundle.invalidate(key);
        self.cache.delete(key);
        if (key === posKey()) requestRecommendFor(key);
      }
      syncAll();
      toast({ level: 'success', text: '深度分析完成', key: 'rv-deep-done' });
    }

    // —— 数据类消息 ——
    if (type === 'review.recommend') {
      const payload = message.data;
      const key = payload && payload.position_key;
      if (key) {
        // 批量快照条目**不入 LRU**（对象同一性判定）：快照必须保持「可失效」语义
        // （深算/补分析后经 invalidate 回落 WS），而 LRU 是实时结果层（优先级更高）。
        if (self.bundle.get(key) !== payload) self.cache.set(key, payload);
        self.recLoading = false;
        if (key === posKey()) {
          syncBoard();
          updateWrBar();
          refreshSidebar();
        }
      }
      return;
    }
    if (type === 'trial.state') {
      onTrialState(message.data);
      return;
    }
    if (type === 'position.ownership') {
      onOwnership(message.data);
      return;
    }
    // 其余（engine/deep/global/curve）：轻量刷新
    syncButtons();
    refreshSidebar();
  }

  function refreshSidebar() {
    if (self.sidebar && typeof self.sidebar.refresh === 'function') self.sidebar.refresh();
  }

  /** 全面同步（局部动作后的统一入口）。 */
  function syncAll() {
    updateMeta();
    updateTrack();
    syncBoard();
    syncBoardNote();
    updateCounter();
    updateWrBar();
    renderActions();
    syncButtons();
    refreshSidebar();
  }

  /** rAF 合并渲染（L-10）：试下替换逐手回投等高频消息在同一帧内只整帧重建一次。 */
  function scheduleSync() {
    if (syncRaf != null) return;
    syncRaf = requestAnimationFrame(() => {
      syncRaf = null;
      if (!destroyed) syncAll();
    });
  }

  /* ---------------- 位置（seek / 轨道） ---------------- */

  function maxMain() {
    const g = storeGame();
    return g ? Number(g.lastMoveNo) || 0 : 0;
  }
  function maxTrialRel() {
    return self.trial ? self.trial.moves.length : 0;
  }

  function seekTo(n) {
    self.pos = { mode: 'main', moveNo: Math.max(0, Math.min(maxMain(), Number(n) || 0)) };
    afterSeek();
  }

  /** 主谱定位原始实现（不停止自动播放；供自动播放内部步进，T6.8 修复连续播放）。 */
  function goMain(n) {
    const max = maxMain();
    const next = Math.max(0, Math.min(max, Number(n) || 0));
    if (self.pos.mode === 'trial') {
      self.pos = { mode: 'main', moveNo: next };
      if (self.trial) self._exitedTrialId = self.trial.id; // M-13：记录退出分支
      self.trial = null;
      self.cache.clear();
      store.dispatch({ type: 'trial.exit' });
    } else {
      self.pos = { mode: 'main', moveNo: next };
    }
    afterSeek();
  }

  /** 主谱 seek（离开试下分支 = 回实战；用户交互会停止自动播放）。结算模式锁定。 */
  function seekMain(n) {
    if (self.settling) return;
    stopAutoplay();
    goMain(n);
  }

  /** 轨道绝对 seek（含试下时在分支内）。结算模式锁定（死子标记期间局面固定）。 */
  function seekAbs(n) {
    if (self.settling) return;
    if (self.pos.mode === 'trial') {
      seekTrialRel(Math.max(0, Math.min(maxTrialRel(), Number(n) || 0)));
    } else {
      seekMain(n);
    }
  }

  /** 曲线点击目标执行（sidebar resolveCurveSeek 派生：主谱绝对手数 / 试下相对手数）。 */
  function seekCurveTarget(target) {
    if (self.settling || !target) return;
    if (target.mode === 'trial') seekTrialRel(target.rel); // rel=0 → 回实战
    else seekMain(target.moveNo);
  }

  /** 试下分支相对手定位原始实现（不停止自动播放；rel=0 = 回实战）。 */
  function goTrialRel(rel) {
    const max = maxTrialRel();
    const next = Math.max(0, Math.min(max, Number(rel) || 0));
    self._follow = false; // 用户主动定位优先于待回投的落子跟随
    if (next === 0) {
      if (self.trial) goMain(self.trial.fromMoveNo);
      else goMain(self.pos.moveNo);
      return;
    }
    self.pos.mode = 'trial';
    self.pos.rel = next;
    afterSeek();
  }

  /** 试下分支内相对手 seek；rel=0 = 回实战（用户交互会停止自动播放）。结算模式锁定。 */
  function seekTrialRel(rel) {
    if (self.settling) return;
    stopAutoplay();
    goTrialRel(rel);
  }

  function stepDir(dir) {
    if (self.settling) return;
    if (self.pos.mode === 'trial') {
      seekTrialRel((Number(self.pos.rel) || 0) + (dir === -1 ? -1 : 1));
    } else {
      seekMain((Number(self.pos.moveNo) || 0) + (dir === -1 ? -1 : 1));
    }
  }

  /**
   * seek 后统一：清预览/气泡、按位置渲染棋盘并拉取推荐。
   * 单击（非连续）领地 = 瞬态查看：局面类命令即清除并熄灭按钮（人工口径 2026/09/12）；
   * 连续模式的跟随请求由 syncBoard → territoryOwnership 的 plan 处理。
   */
  function afterSeek() {
    // 主谱位置记忆（2026/09/14）：每次定位写入 `tgo.review-pos`（仅最近一条）；
    // 试下分支不参与（会话性质）——刷新/重进落回进入试下前的主谱手数
    if (self.gameId && self.pos.mode === 'main') {
      ls.set(LS_KEYS.reviewPos, {
        gameId: Number(self.gameId),
        moveNo: Number(self.pos.moveNo) || 0,
        ts: Date.now(),
      });
    }
    clearBubble();
    stopPreview();
    exitTransientTerritory();
    // 先置“在途”再渲染：胜率条（保留式）与卡片才能拿到本局面的 pending 标志，
    // 否则 syncAll 先以“无数据”渲染一次 → 短暂闪烁（2026/09/13 试下闪烁根因）
    requestRecommendFor(posKey());
    syncAll();
  }

  /** 自动播放（点击手数标签开/关；任意 seek 停止）。步进走原始定位，修复“只能播下一手”。 */
  function toggleAutoplay() {
    if (self.settling) return; // 结算模式：局面固定，不启自动播放
    if (self.autoplay) {
      stopAutoplay();
      return;
    }
    const max = self.pos.mode === 'trial' ? maxTrialRel() : maxMain();
    const cur = self.pos.mode === 'trial' ? self.pos.rel : self.pos.moveNo;
    if (cur >= max) {
      toast({ level: 'info', text: '已在末手，无可连续播放', key: 'rv-auto-end' });
      return;
    }
    exitTransientTerritory(); // 自动播放 = 局面类命令：单击瞬态领地即清除
    const step = () => {
      const m = self.pos.mode === 'trial' ? maxTrialRel() : maxMain();
      const c = self.pos.mode === 'trial' ? self.pos.rel : self.pos.moveNo;
      if (c >= m) {
        stopAutoplay();
        return;
      }
      if (self.pos.mode === 'trial') goTrialRel(c + 1);
      else goMain(c + 1);
    };
    self.autoplay = { timer: setInterval(step, AUTOPLAY_STEP_MS) };
    toast({ level: 'info', text: '自动播放已开启（任意操作暂停）', key: 'rv-auto' });
  }

  function stopAutoplay() {
    if (self.autoplay) {
      clearInterval(self.autoplay.timer);
      self.autoplay = null;
    }
  }

  /* ---------------- 棋盘同步 ---------------- */

  function syncBoard() {
    if (!self.board) return;
    const g = storeGame();
    if (!g) return;
    // 落子动画方向（2026/09/13 人工口径）：人机＝人类方由下到上 / 人人＝黑方由下到上
    const dropUp = dropUpSide(g);
    if (self._dropUpSide !== dropUp) {
      self._dropUpSide = dropUp;
      self.board.setProps({ dropUpColor: dropUp });
    }
    const p = g.params || {};
    const size = p.boardSize || 19;
    const handicap = p.handicap || 0;
    const moves = displayMoves();
    const stones = replayStones({ size, handicap, moves });
    // 当前手标记（末手）
    let last = null;
    for (const s of stones) {
      if (s.moveNo != null && (last == null || s.moveNo > last.moveNo)) last = s;
    }
    const withLast = last
      ? stones.map((s) => (s.x === last.x && s.y === last.y ? { ...s, isLast: true } : s))
      : stones;
    // 吃子残影（2026/09/17：复盘/试下与对弈页同口径）：正向单步且本手提子时，
    // 先 removeStone(capture)（残影）+ applyMove（落子动画）；其余走整盘替换。
    // 判定为纯函数 boardTransition（回退/跳转/重建不触发；勿在 restore 路径扩散动画）。
    const transition = boardTransition(self.displayedStones, stones);
    if (transition.captureStep) {
      for (const r of transition.removed) self.board.removeStone(r.x, r.y, { capture: true });
      self.board.applyMove(transition.added[0]);
    }
    const toMove = nextColorAbs(moves.length, handicap);
    const key = posKey();    const rec = reviewFor(key);
    // 自动点评开关关闭 → 不显示棋盘点评标记（人工口径 2026/09/10）
    const comments = [];
    if (self.coach.enabled
      && rec && rec.comment && rec.comment.grade && rec.comment.x != null && rec.comment.y != null) {
      comments.push({ x: Number(rec.comment.x), y: Number(rec.comment.y), grade: rec.comment.grade });
    }
    const top5 = (rec && Array.isArray(rec.moves) ? rec.moves : [])
      .slice(0, 5)
      .filter((m) => m.x != null && m.y != null)
      .map((m, i) => ({ x: Number(m.x), y: Number(m.y), rank: i + 1 }));
    // 领地热力：显示/保留/清除由 territoryHeatPlan 统一决定（连续模式保留旧热力不闪回背景）
    const ownership = territoryOwnership(key);
    // 结算模式（2026/09/19）：局面锁定于末手；棋盘只呈现死子 ✕ 标记（隐藏点评/TOP5/
    // 变化图/悬停幽灵——标记为唯一交互）
    const settling = Boolean(self.settling);
    self.board.setProps({
      size,
      toMove: boardColorFor(nextColorAbs(moves.length, handicap)),
      stones: withLast,
      comments: settling ? [] : comments,
      // 变化图预览期间隐藏棋盘 TOP5 选点标记（与预览棋子重叠；2026/09/13 人工决策）
      top5: settling || self.preview ? [] : top5,
      variations: self.preview ? self.preview.pts.slice(0, self.preview.step) : [],
      ownership,
      deadStones: settling && self.settle ? self.settle.deadList() : [],
      interactive: true,
      // 触摸“双击落子”：主谱首点也预览（同点二点=进试下并落首子）；变化图播放/结算中不预览
      hoverGhost: settling ? false : !self.preview,
      engineDead: false,
      lastMarker: 'ring',
      onBlankTap: () => clearBubble(),
    });
    self.renderedKey = key;
    self.displayedStones = stones;
  }

  /**
   * 棋盘左上角提示（人工口径 2026/09/13）：文案＝当前显示步简洁形式（`白 J3` /
   * `白 PASS`，试下分支同口径）；空盘（0 手）隐藏；**与方形棋盘区域重叠**时降级
   * 半透明（`.is-overlap`；判定口径 2026/09/24 简化为「矩形 ∩ 棋盘方形」）。
   * 取代原提子控件右侧 `PASS` 提示（已删除）。
   */
  function syncBoardNote() {
    const noteEl = qRef('[data-ref="rvNote"]');
    if (!noteEl) return;
    const g = storeGame();
    if (!g) return;
    const moves = displayMoves();
    const last = moves.length ? moves[moves.length - 1] : null;
    const text = shortMoveText(last, (g.params && g.params.boardSize) || 19);
    noteEl.classList.toggle('u-hide', !text);
    if (text) noteEl.textContent = text;
    measureNoteRect(noteEl);
    applyNoteOverlap();
  }

  /**
   * 量取提示矩形（相对棋盘容器）并缓存：文案/窗口尺寸变化时调用。降级判定在缩放/平移
   * 期间会被反复执行（`onViewChange`），若每次都读 offset* 会强制同步重排 → 拖拽/捏合
   * 逐帧卡顿；故矩形只在此处量取，判定本身为零 DOM 读取的纯几何比较。
   */
  function measureNoteRect(noteEl) {
    self._noteRect = noteEl.classList.contains('u-hide')
      ? null
      : {
        left: noteEl.offsetLeft,
        top: noteEl.offsetTop,
        right: noteEl.offsetLeft + noteEl.offsetWidth,
        bottom: noteEl.offsetTop + noteEl.offsetHeight,
      };
  }

  /** 应用半透明降级：提示矩形 ∩ 棋盘方形（棋盘几何含缩放/平移，由棋盘自身给出）。 */
  function applyNoteOverlap() {
    const noteEl = qRef('[data-ref="rvNote"]');
    if (!noteEl) return;
    noteEl.classList.toggle(
      'is-overlap',
      Boolean(self._noteRect) && self.board.noteOverlaps(self._noteRect),
    );
  }

  function boardColorFor(side) {
    return side === 'white' ? 'white' : 'black';
  }

  function updateCounter() {
    if (!self.counter) return;
    const g = storeGame();
    if (!g) return;
    const p = g.params || {};
    const moves = displayMoves();
    const caps = captureCounts({ size: p.boardSize, handicap: p.handicap, moves });
    const toMove = nextColorAbs(moves.length, p.handicap);
    self.counter.setCurrent(boardColorFor(toMove), true);
    self.counter.setCaptures({ black: caps.black, white: caps.white });
  }

  /** 当前显示局面绝对手数（主谱手数 或 试下 进入手数+相对）。 */
  function mainAbsOfPos() {
    if (self.pos.mode === 'trial' && self.trial) {
      return self.trial.fromMoveNo + (Number(self.pos.rel) || 0);
    }
    return Number(self.pos.moveNo) || 0;
  }

  /**
   * C16 黑白胜率条（≤767 棋盘下方居中；**固定黑方视角**百分比，2026/09/11 人工确认）。
   * 2026/09/13 人工反馈（试下两次更新闪烁）：当前局面数据在途时**保留上一次渲染**
   * （wrBarAction）；无数据且非在途 → 稳定高度空态（不置空归零）。
   */
  function updateWrBar() {
    const bar = qRef('[data-ref="rvWrBar"]');
    if (!bar) return;
    const g = storeGame();
    if (!g) return;
    const key = posKey();
    const rec = reviewFor(key);
    let w = recBlackWinrate(rec);
    if (w == null) {
      const absNo = mainAbsOfPos();
      const pts = (store.getState().curve.points) || [];
      const hit = pts.find((p) => Number(p.moveNo) === absNo);
      if (hit && hit.winrate != null) w = Number(hit.winrate);
    }
    const rvs = store.getState().review || {};
    const pending = Boolean(rvs.loading && rvs.key === key);
    const action = wrBarAction({ hasRate: w != null, shown: self.wrShown, pending });
    if (action === 'keep') return;
    if (action === 'empty') {
      const empty = '<span class="wr-empty muted">暂无胜率数据</span>';
      if (bar.innerHTML !== empty) bar.innerHTML = empty;
      bar.setAttribute('aria-label', '黑白胜率：暂无数据');
      return;
    }
    self.wrShown = true;
    const black = Math.max(0, Math.min(100, Math.round(w)));
    const white = 100 - black;
    bar.setAttribute('aria-label', `黑白胜率：黑 ${black}%，白 ${white}%`);
    const segEl = bar.querySelector('.wr-track .b');
    if (!segEl) {
      // 首建：结构一次性写入（新元素无过渡 → 入场即时）
      bar.innerHTML = `
      <div class="wr-label num">黑 ${black}%</div>
      <div class="wr-track"><div class="b" style="width:${black}%"></div><div class="w" style="flex:1"></div></div>
      <div class="wr-label num">白 ${white}%</div>`;
      return;
    }
    // 更新：只改数值与黑段宽度（CSS width 过渡 → 平滑动画；重写 innerHTML 会丢过渡）
    const labels = bar.querySelectorAll('.wr-label');
    labels[0].textContent = `黑 ${black}%`;
    labels[1].textContent = `白 ${white}%`;
    segEl.style.width = `${black}%`;
  }

  /** 自动点评开关（信息行徽章点击）：重绘棋盘标记并收起气泡。 */
  function toggleCoach() {
    self.coach.enabled = !self.coach.enabled;
    if (!self.coach.enabled) clearBubble();
    updateMeta();
    syncBoard();
  }

  /** 信息行试下胶囊点击 = 回实战（退出分支显示主谱进入局面）。 */
  function backToReal() {
    if (self.pos.mode !== 'trial' || !self.trial) return;
    seekMain(self.trial.fromMoveNo);
  }

  function updateMeta() {
    const meta = qRef('[data-ref="rvMeta"]');
    if (!meta) return;
    const g = storeGame();
    const p = (g && g.params) || {};
    const inTrial = self.pos.mode === 'trial';
    const cur = inTrial ? self.pos.rel : self.pos.moveNo;
    const total = inTrial ? maxTrialRel() : maxMain();
    const trialActive = inTrial && cur > 0;
    const aiText = p.aiStyle
      ? `${p.aiStyle === 'human' ? '人类' : '标准'} · ${rankText(p.aiLevel)}`
      : 'AI';
    const segs = reviewMeta({
      inTrial: trialActive,
      current: cur,
      total,
      boardSize: p.boardSize,
      rules: p.rules,
      komi: p.komi,
      handicap: p.handicap || 0,
      mode: p.mode,
      aiText,
      result: g && g.result && !inTrial ? g.result : null,
      coachOn: self.coach.enabled,
    });
    // 分段渲染（2026/09/13 移动端单行省略）：试下胶囊固定完整；文本段归 .meta-clip
    //（移动端单行 `…`）；自动点评开关固定完整。PASS 提示移至底部提子控件右侧。
    const fromNo = self.trial ? self.trial.fromMoveNo : 0;
    const grp = groupMetaSegments(segs, { pillIndex: trialActive ? 0 : -1 });
    // 试下胶囊＝信息行**行首**固定槽位（2026/09/13 人工反馈：移动端置于「对局信息」
    // 图标之前；桌面图标隐藏、胶囊仍居首）——文本/徽章仍走 meta 分段渲染。
    const pillEl = qRef('[data-ref="rvTrialPill"]');
    if (pillEl) {
      const showPill = Boolean(trialActive && grp.pill);
      pillEl.classList.toggle('u-hide', !showPill);
      if (showPill) {
        pillEl.textContent = grp.pill.text;
        pillEl.title = `点击返回实战（回到第 ${fromNo} 手主谱，退出试下）`;
      }
    }
    const clipHTML = grp.clip
      .map((s, i) => `${i ? '<span class="sep">·</span>' : ''}<span class="${s.trial ? 'accent' : ''}">${s.text}</span>`)
      .join('');
    const fixedHTML = grp.fixed
      .map((s) => '<span class="sep">·</span>' + (s.coach
        ? `<button type="button" class="badge toggle${s.on ? ' on' : ''}" data-act="coachToggle"`
          + ` aria-pressed="${s.on}" title="自动点评开关（点击开/关）">${s.text}</button>`
        : `<span class="badge accent">${s.text}</span>`))
      .join('');
    meta.innerHTML = `<span class="meta-clip">${clipHTML}</span>${fixedHTML}`;
    // 行首图标弹层全文（对局信息段，· 连接；不含徽章/开关——人工口径 2026/09/13）
    self.metaText = metaPopText(segs);
  }

  function updateTrack() {
    const inTrial = self.pos.mode === 'trial';
    const cur = inTrial ? self.pos.rel : self.pos.moveNo;
    const max = inTrial ? maxTrialRel() : maxMain();
    const label = qRef('[data-ref="rvTrackLabel"]');
    if (label) label.textContent = `${cur} / ${max}`;
    paintSlider(inTrial && cur > 0, cur, max);
  }

  /* ---------------- 回放滑轨（自定义：主谱 accent / 试下绿、平滑切换、hover 手数） ---------------- */

  /** 当前滑轨 max（main=主谱末手 / trial=分支相对长度）。 */
  function sliderMax() {
    return self.pos.mode === 'trial' ? maxTrialRel() : maxMain();
  }

  /** 填充/aria/主题色（trial 绿）同步。 */
  function paintSlider(trialActive, cur, max) {
    const slider = qRef('[data-ref="rvSlider"]');
    if (!slider) return;
    const m = Math.max(0, Number(max) || 0);
    const c = Math.max(0, Math.min(m, Number(cur) || 0));
    slider.classList.toggle('trial', Boolean(trialActive));
    slider.setAttribute('aria-valuemax', String(m));
    slider.setAttribute('aria-valuenow', String(c));
    slider.setAttribute('aria-valuetext', `${c} / ${m}`);
    const pct = m > 0 ? Math.round(fractionToPercent(c / m)) : 0;
    slider.style.setProperty('--fill', `${pct}%`);
    slider.title = trialActive
      ? `试下分支（第 ${c} 手 / ${m}）· 点击/拖动定位；[◀] 到 0 = 回实战`
      : `回放手数（第 ${c} 手 / ${m}）· 点击/拖动定位`;
  }

  function sliderTip(show, text) {
    const tip = qRef('[data-ref="rvSliderTip"]');
    if (!tip) return;
    if (show && text != null) tip.textContent = text;
    tip.classList.toggle('u-hide', !show);
  }

  /** 指针 x → 滑轨比例/目标手数（拖拽或 hover 定位用）。 */
  function sliderHitFromClientX(clientX) {
    const slider = qRef('[data-ref="rvSlider"]');
    if (!slider) return null;
    const rect = slider.getBoundingClientRect();
    if (!rect.width) return null;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return { ratio, target: Math.round(ratio * sliderMax()) };
  }

  let sliderDrag = null; // 拖动指针 id
  let sliderPending = null; // rAF 节流：待定位手数
  let sliderRaf = null;

  function sliderScheduleSeek(target) {
    sliderPending = Number(target);
    if (sliderRaf) return;
    sliderRaf = requestAnimationFrame(() => {
      sliderRaf = null;
      if (sliderPending == null) return;
      const t = sliderPending;
      sliderPending = null;
      seekAbs(t); // seekAbs 内含 stopAutoplay
    });
  }

  function bindSlider() {
    const slider = qRef('[data-ref="rvSlider"]');
    if (!slider) return;
    // 滑轨视觉参数（--rv-track/--rv-thumb-w/--rv-thumb-h）在 app.css .rv-slider 配置，
    // 为唯一配置源，脚本不再内联覆盖（调整只改 app.css）。
    const placeTip = (clientX) => {
      const hit = sliderHitFromClientX(clientX);
      if (!hit) return;
      const m = sliderMax();
      const tip = qRef('[data-ref="rvSliderTip"]');
      if (tip) tip.style.left = `${Math.round(fractionToPercent(hit.ratio))}%`;
      sliderTip(true, `${hit.target} / ${m}`);
    };
    slider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sliderDrag = { id: e.pointerId };
      slider.classList.add('dragging');
      try { slider.setPointerCapture(e.pointerId); } catch { /* 无捕获环境 */ }
      const hit = sliderHitFromClientX(e.clientX);
      if (hit) {
        placeTip(e.clientX);
        seekAbs(hit.target);
      }
    });
    slider.addEventListener('pointermove', (e) => {
      if (sliderDrag && sliderDrag.id === e.pointerId) {
        const hit = sliderHitFromClientX(e.clientX);
        if (hit) {
          placeTip(e.clientX);
          sliderScheduleSeek(hit.target);
        }
      } else if (!sliderDrag) {
        placeTip(e.clientX); // hover：显示指针处手数
      }
    });
    const endDrag = (e) => {
      if (!sliderDrag) return;
      sliderDrag = null;
      slider.classList.remove('dragging');
      try { slider.releasePointerCapture(e.pointerId); } catch { /* 无捕获 */ }
    };
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);
    slider.addEventListener('pointerleave', () => {
      if (!sliderDrag) sliderTip(false);
    });
    slider.addEventListener('keydown', (e) => {
      if (e.key === 'Home') {
        e.preventDefault();
        stopAutoplay();
        seekAbs(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        stopAutoplay();
        seekAbs(sliderMax());
      }
      // ←/→ 交由全局键处理（含自动播放停止与步进）
    });
  }

  /** 底部操作按钮（主谱 vs 试下）。 */
  function renderActions() {
    const host = qRef('[data-ref="rvActions"]');
    if (!host) return;
    const g = storeGame();
    if (!g) return;
    const inTrial = self.pos.mode === 'trial' && (Number(self.pos.rel) || 0) > 0;
    const btns = [];
    if (self.settling) {
      // 结算模式（2026/09/19）：局面锁定、死子标记为唯一操作——分析/续弈/复弈一律隐藏，
      // 仅保留 [领地]（终局热力辅助判断死子，同对弈页结算期口径）
    } else if (!inTrial) {
      // 返回列表：移动端收入 [···] 菜单（2026/09/13 人工反馈），桌面在信息行 [返回]
      if (g.status === 'active' || g.status === 'created') {
        btns.push({ act: 'resume', cls: 'btn-secondary', label: '续弈', title: '续弈：继续该对局' });
      }
      btns.push({ act: 'analyze', cls: 'btn-primary', label: '深度分析', title: '', ref: 'rvAnalyzeBtn' });
    } else {
      btns.push({
        act: 'refight',
        cls: 'btn-primary',
        label: '复弈',
        icon: 'i-refight',
        title: '复弈：将创建新对局（继承前 N 手与分析），原棋谱保留',
      });
    }
    // 领地（任意显示局面可用；含试下会话缓存）——单击=瞬态查看，双击=每步自动连续
    // 开启态（整按钮高亮 is-on）与连续模式左上角小圆点由 territoryButtonView(state) 派生：
    // 本函数会全量重建按钮 DOM，任何重建（下一手/断点重排/WS 消息）都必须重放该状态
    // （BUG-045 同类缺陷）；`updateTerritoryButton()` 负责即时切换与 title。
    const terrView = territoryButtonView({ active: self.territory.active, auto: self.territory.auto });
    const terrCls = territoryButtonClassString({ active: self.territory.active, auto: self.territory.auto });
    btns.push({
      act: 'territory',
      cls: `btn-secondary${terrCls ? ` ${terrCls}` : ''}`,
      label: '领地',
      icon: 'i-territory',
      title: terrView.title,
      dot: true,
      dotHidden: !terrView.dot,
    });
    host.innerHTML = btns
      .map((b) => `<button class="btn ${b.cls}" type="button" data-act="${b.act}" ${b.ref ? `data-ref="${b.ref}"` : ''} ${b.title ? `title="${b.title}"` : ''}>${b.icon ? `<svg class="icon" aria-hidden="true"><use href="#${b.icon}"/></svg>` : ''}${b.label}${b.dot ? `<span class="dot${b.dotHidden ? ' u-hide' : ''}" data-ref="rvTerrDot" aria-hidden="true"></span>` : ''}</button>`)
      .join('');
    bindActionNodes(host);
    updateTerritoryButton();
    syncButtons();
  }

  /** 返回棋谱列表（试下分支已有落子时二次确认；T6.8 反馈）。 */
  async function goBack() {
    const trialLen = self.trial && Array.isArray(self.trial.moves) ? self.trial.moves.length : 0;
    if (trialLen > 0) {
      const ok = await confirmDialog({
        title: '返回确认',
        message: `试下分支已有 ${trialLen} 手落子，返回将丢弃该分支。确定返回棋谱列表？`,
        okText: '返回',
      });
      if (!ok || destroyed) return;
    }
    exitSettleMode(); // 结算模式中返回：先退出结算（死子标记为本地会话，不落盘）
    nav('#/review');
  }

  /* ============================================================
   * 未结算终局补结算（2026/09/19 人工决策方案 A）
   *   [结算]（原 [报告] 位置；移动端 [···] 菜单）→ 确认（不在末手时）→ 跳末手
   *   → 进入结算模式：scoring.prepare 预判 → 点棋盘标记死子 → scoring.confirm
   *   （后端同一 Python 数子口径原地结算）→ [报告] 按门控恢复。
   * ============================================================ */

  /** 报告/结算槽位输入（meta 优先、store 兜底：meta 可能滞后于 WS 快照）。 */
  function slotContext() {
    const g = storeGame() || {};
    return {
      status: (self.meta && self.meta.status) || g.status || '',
      result: self.meta && self.meta.result != null
        ? self.meta.result
        : (g.result != null ? g.result : null),
      analysisComplete: Boolean((self.meta && self.meta.analysis_complete) || g.analysisComplete),
    };
  }

  /** 当前对局是否「终局未结算」（导入棋谱语义：finished 且 result 为空）。 */
  function isUnsettledGame() {
    return reportSlotView(slotContext()) === 'settle';
  }

  /** 惰性建结算模块（宿主在壳 DOM 内，须 buildShell 后调用）。 */
  function ensureSettleModule() {
    if (self.settle) return self.settle;
    const desktop = qRef('[data-ref="rvSettleDesktop"]');
    const mobile = qRef('[data-ref="rvSettleMobile"]');
    if (!desktop && !mobile) return null;
    self.settle = createReviewSettleModule({
      store,
      hub,
      hosts: { desktop, mobile },
      isDesktop: () => (typeof window !== 'undefined' ? window.innerWidth >= 768 : true),
      context: () => ({ gameId: Number(self.gameId) || 0, moveNo: maxMain() }),
      onDead: (list) => {
        // 死子集合回写棋盘（✕ 标记）；重绘由棋盘 setProps 脏标记驱动
        if (self.board) self.board.setProps({ deadStones: list });
      },
      onExit: () => exitSettleMode(),
      onDone: (payload) => onSettleDone(payload),
    });
    return self.settle;
  }

  /** [结算] 点击：确认（不在末手）→ 跳末手 → 进入结算模式。 */
  async function onSettleClick() {
    if (self.settling || destroyed) return;
    if (!isUnsettledGame()) return;
    const maxMove = maxMain();
    const inTrial = self.pos.mode === 'trial';
    const atEnd = !inTrial && Number(self.pos.moveNo) === maxMove;
    if (!atEnd) {
      // 人工口径（2026/09/19）：结算在末手局面进行——先确认再跳转（已在末手则免弹窗）
      const ok = await confirmDialog({
        title: '进入结算',
        message: inTrial
          ? `试下分支将被丢弃；结算在终局局面（第 ${maxMove} 手）标记死子并进行。`
          : `结算在终局局面（第 ${maxMove} 手）标记死子并进行。`,
        okText: '进入结算',
      });
      if (!ok || destroyed) return;
    }
    stopAutoplay();
    stopPreview();
    seekMain(maxMove); // 定位末手（主谱）；已在末手时幂等
    enterSettleMode();
  }

  /** 进入结算模式：锁回放交互、收起复盘侧栏、挂结算卡、触发死子预判。 */
  function enterSettleMode() {
    const inst = ensureSettleModule();
    if (!inst) return;
    self.settling = true;
    exitTransientTerritory();
    clearBubble();
    if (self.sidebar && typeof self.sidebar.hide === 'function') self.sidebar.hide();
    const body = qRef('[data-ref="rvSidebarBody"]');
    if (body) body.classList.add('u-hide');
    inst.activate();
    playSound('success'); // 结算音效（对弈页 enterSettle 同口径：进入结算一次性；2026/09/19）
    if (hub && typeof hub.sendGame === 'function') hub.sendGame('scoring.prepare');
    syncAll(); // 棋盘 props（deadStones/hoverGhost）/按钮禁用态
  }

  /** 退出结算模式（[取消]/[✕]/ESC/返回/结算完成）：恢复复盘壳与交互。 */
  function exitSettleMode() {
    if (!self.settling) return;
    self.settling = false;
    if (self.settle) self.settle.deactivate();
    const body = qRef('[data-ref="rvSidebarBody"]');
    if (body) body.classList.remove('u-hide');
    if (self.sidebar && typeof self.sidebar.show === 'function') self.sidebar.show();
    syncAll();
  }

  /**
   * 结算完成（game.finished 到达）：刷新详情（目数/分析覆盖）+ 批量快照（预判终局行
   * 落入链槽 → 末手点评/推荐已变）——结算卡转入**第二步「数子结果」**（大字 + 黑目/白目/
   * 贴目/手数，同对弈页口径）原地展示；用户经 [完成]/[✕]/ESC 退出结算模式后恢复复盘壳
   * （[报告] 按分析门控恢复）。
   */
  async function onSettleDone() {
    await refreshDetail();
    await refreshBundle();
    if (destroyed) return;
    syncAll();
  }

  /** REST 详情刷新（结算后目数/分析覆盖；不重派 game.state——防复盘切片复位）。 */
  async function refreshDetail() {
    if (!self.gameId || destroyed) return;
    try {
      const res = await api.get(`/games/${self.gameId}`);
      if (destroyed || !res || !res.data) return;
      self.meta = res.data;
      refreshSidebar();
      syncButtons();
    } catch {
      /* 刷新失败不阻断（WS game.state 快照已更新结果/状态） */
    }
  }

  function bindActionNodes(scope) {
    scope.querySelectorAll('[data-act]').forEach((btn) => {
      if (btn._rvBound) return;
      btn._rvBound = true;
      const act = btn.dataset.act;
      const fn = {
        back: () => goBack(),
        resume: () => doResume(),
        analyze: () => onAnalyzeClick(),
        refight: () => doRefight(),
        export: () => exportSgf(),
        report: () => goReport(),
        settle: () => onSettleClick(),
        more: () => toggleMore(),
        prev: () => stepDir(-1),
        next: () => stepDir(1),
        territory: () => onTerritoryButton(),
        closePreview: () => stopPreview(),
        // 移动端行首「对局信息」图标：顶层弹层展示全部对局信息（2026/09/13）
        infoPop: () => self.infoPop.toggle(btn, self.metaText),
      }[act];
      if (fn) btn.addEventListener('click', fn);
    });
  }

  function toggleMore() {
    const menu = qRef('[data-ref="rvMoreMenu"]');
    if (menu) menu.classList.toggle('u-hide');
  }

  function syncButtons() {
    const host = qRef('[data-ref="rvActions"]');
    const analyzeBtn = qRef('[data-ref="rvAnalyzeBtn"]', host || rootEl);
    if (analyzeBtn) {
      const s = store.getState();
      const deepRunning = Boolean(s.deepAnalysis && s.deepAnalysis.running);
      const bt = deriveAnalyzeButton({
        inTrial: false,
        missing: missingCount(),
        deepRunning,
        globalRunning: Boolean(s.globalAnalysis && s.globalAnalysis.running),
        globalDone: s.globalAnalysis && s.globalAnalysis.done,
        globalTotal: s.globalAnalysis && s.globalAnalysis.total,
        engineState: s.engine && s.engine.state,
      });
      analyzeBtn.disabled = bt.disabled;
      analyzeBtn.title = bt.reason || bt.sub || '';
      analyzeBtn.classList.toggle('breathe', bt.breathe);
      // innerHTML 仅在形态/文案实际变化时重建（同串跳过）：逐次重建会把点亮载体与
      // 进行中的「熄灭淡出 / 到达动效」一并抹成新节点（生硬熄灭与点亮卡顿的来源，
      // 2026/09/18 人工反馈）；内容（label）变化时重建语义不变
      const btnHtml = renderAnalyzeBtnHTML(bt);
      if (analyzeBtn.dataset.renderSig !== btnHtml) {
        analyzeBtn.dataset.renderSig = btnHtml;
        analyzeBtn.innerHTML = btnHtml;
      }
      // 图标点亮（2026/09/17 人工决策）：深算结果到达且仍对应当前局面 → [深度分析] 图标点亮
      // （到达瞬间另加一次性由暗到亮动效）；再次深算 / 切换局面 / 按钮演化为其它形态 → 熄灭
      const lit = bt.kind === 'deep'
        && deepAnalyzeLit({ resultKey: self.deepLitKey, currentKey: posKey(), running: deepRunning });
      applyIconLit(analyzeBtn, iconLitPlan({ lit }, self.deepLit));
      self.deepLit = lit;
    }
    // [报告]/[结算] 槽位（2026/09/19 人工决策）：未结算终局恒占 [结算]；其余按
    // analysis_complete 门控 [报告]。桌面信息行 + 移动 [···] 菜单**两处入口同步**
    // （旧实现只同步第一个节点且以 `hidden` 属性隐藏——被 `.btn{display:inline-flex}`
    // 覆盖而失效；统一改 `u-hide` 机制，回归 BUG-106）。
    const slot = reportSlotView(slotContext());
    const settling = Boolean(self.settling);
    rootEl.querySelectorAll('[data-act="report"]').forEach((el) => {
      el.classList.toggle('u-hide', slot !== 'report');
    });
    rootEl.querySelectorAll('[data-act="settle"]').forEach((el) => {
      el.classList.toggle('u-hide', slot !== 'settle');
      el.disabled = settling;
    });
  }

  function renderAnalyzeBtnHTML(bt) {
    // 运行中与「待补」空闲态同形：图标 + 文案（进度条已删除；运行中只示剩余手数，2026/09/19）
    if (bt.kind === 'progress' || bt.kind === 'global') {
      // 计数**定宽盒**（2026/09/20 人工反馈「按钮随手数文本变化而抖动」）：`待补 N`
      // 的位数随分析推进逐手变化（3 位→2 位→1 位）会改变按钮宽度，而 `.bottom-actions`
      // 靠右对齐 → 按钮左缘随之横跳。中文恒 1em、数字经 `.num` 等宽 → 只需锁数字盒
      // 宽度（`.an-count`，人工口径按三位数字定宽，见 app.css）。
      return `<svg class="icon" aria-hidden="true"><use href="#i-global"/></svg>
        <span class="an-text">${ANALYZE_REMAIN_PREFIX}<span class="an-count num">${bt.remaining}</span>${ANALYZE_REMAIN_SUFFIX}</span>`;
    }
    return `<svg class="icon" aria-hidden="true"><use href="#i-deep"/></svg>${bt.label}`;
  }

  /** 缺失分析手数（0..last 未覆盖；覆盖来自 REST / 状态树）。 */
  function missingCount() {
    const g = storeGame();
    if (!g) return 0;
    const total = (Number(g.lastMoveNo) || 0) + 1;
    if (g.analysisComplete) return 0;
    const analyses = Number(g.analysesCount) || 0;
    return Math.max(0, total - Math.max(0, Math.min(analyses, total)));
  }

  /* ---------------- 推荐拉取 ---------------- */

  function requestRecommendFor(key) {
    const cached = self.cache.get(key);
    const snap = cached ? null : self.bundle.get(key);
    const action = recommendFetchAction({
      hasCache: Boolean(cached),
      hasBundle: Boolean(snap),
      trialKey: isTrialKey(key),
      engineDown: isEngineDown(),
    });
    if (action === 'cache') {
      store.dispatch({ type: 'review.recommend', data: cached });
      return;
    }
    // 批量快照命中（主谱持久化数据）→ 本地应用：无在途请求、无 loading 占位、无超时河
    if (action === 'bundle') {
      store.dispatch({ type: 'review.recommend', data: snap });
      return;
    }
    // 试下推荐依赖引擎会话现算：引擎已知不可用 → 不发无效请求，直接进降级空态
    // （服务端同判并会回投终态；此处省一次往返，且避免逐手错误信封；BUG-091）
    if (action === 'local-fallback') {
      store.dispatch({
        type: 'review.recommend',
        data: { position_key: key, moves: [], variations: [], comment: null, root: null, has_data: false },
      });
      return;
    }
    self.recLoading = true;
    store.dispatch({ type: 'review.pending', data: { key } });
    const token = ++self.recToken;
    const data = isTrialKey(key)
      ? { position_key: key }
      : { move_no: parseMainKey(key) };
    if (hub && typeof hub.sendGame === 'function') hub.sendGame('recommend.request', data);
    if (self.recTimer) clearTimeout(self.recTimer);
    self.recTimer = setTimeout(() => {
      self.recTimer = null;
      if (token === self.recToken && self.recLoading) {
        self.recLoading = false;
        store.dispatch({
          type: 'review.recommend',
          data: { position_key: key, moves: [], variations: [], comment: null, root: null, has_data: false },
        });
      }
    }, RECOMMEND_TIMEOUT_MS);
  }

  /* ---------------- 领地 ---------------- */

  /**
   * 领地按钮即时反馈（开启＝整按钮高亮 `is-on`；连续模式＝高亮 + 左上角小圆点；title）。
   * 口径单一事实源 = core/territory.js `territoryButtonView` / `territoryButtonClasses`
   * （2026/09/17 回退口径：图标恒空心、不填充、不呼吸）。
   */
  function updateTerritoryButton() {
    const btn = qRef('[data-act="territory"]');
    if (!btn) return;
    const view = territoryButtonView({ active: self.territory.active, auto: self.territory.auto });
    for (const [cls, on] of Object.entries(territoryButtonClasses({ active: self.territory.active, auto: self.territory.auto }))) {
      btn.classList.toggle(cls, on);
    }
    const dot = qRef('[data-ref="rvTerrDot"]');
    if (dot) dot.classList.toggle('u-hide', !view.dot);
    btn.title = view.title;
  }

  /**
   * 领地请求看门狗（懒建）：**只重新发起、绝不自动退出**（2026/09/12 三次修订）。
   *
   * 根因：旧实现把“12s 无回执”当作失败，自动淡出并熄灭（含连续模式）——但引擎忙
   * 于 AI 走子/P1 排队时响应本就可能晚于 12s，正常等待被误判。现在超时仅重新领表
   * （走 requestOwnershipNow：本地已有数据则直接应用；服务端任务被丢弃时由此收敛），
   * 显示只由用户操作/引擎 DEAD·FATAL/对局结束终结。
   */
  function terrTimeout() {
    if (!self.territory.timeout) {
      self.territory.timeout = createTerritoryTimeout({
        onTimeout: () => {
          if (territoryWatchdogAction({
            destroyed,
            pending: self.territory.pending,
            active: self.territory.active,
          }) !== 'retry') return;
          self.territory.pending = false;
          self.territory.reqKey = null;
          requestOwnershipNow();
          syncBoard(); // 缓存命中路径直接上屏（未命中则保持现状等待回执）
        },
      });
    }
    return self.territory.timeout;
  }

  /** 单击（非连续）领地 = 瞬态查看：局面类命令（步进/滑轨/点曲线/点棋盘/回实战）即清除退出。 */
  function exitTransientTerritory() {
    if (!self.territory.active || self.territory.auto) return;
    self.territory.active = false;
    self.territory.pending = false;
    self.territory.reqKey = null;
    self.territory.atKey = null;
    self.territory.shown = null;
    terrTimeout().cancel();
  }

  /**
   * 领地热力取值（syncBoard 调用）——口径见 core/territory.js `territoryHeatPlan`：
   * 显示=应用新数据（与当前热力交叉淡变）；保留=连续模式等待新数据（旧热力不退场）；
   * 清除=结束显示（board 240ms 淡出）。连续模式无数据时拉起请求；
   * 单击瞬态遇局面推进则停止（熄灭按钮）。
   */
  function territoryOwnership(key) {
    const ownEntry = store.getState().positions[key];
    const snap = bundleOwnershipOf(key);
    const hasData = Boolean(ownEntry && ownEntry.ownership !== undefined) || snap.covered;
    const plan = territoryHeatPlan({
      active: Boolean(self.territory.active),
      auto: Boolean(self.territory.auto),
      hasData,
      positionChanged: key !== self.territory.atKey,
    });
    if (plan.display === 'show') {
      self.territory.atKey = key;
      self.territory.shown = snap.covered ? snap.values : ownEntry.ownership;
      // 终态“无数据”（ownership=null）：瞬态显示熄灭（看门狗不再兜底退出，
      // 否则按钮会永久空亮）；连续模式保畱（下一手可能仍有数据）
      if (!snap.covered && ownEntry.ownership == null && !self.territory.auto) {
        self.territory.active = false;
        self.territory.pending = false;
        self.territory.reqKey = null;
        terrTimeout().cancel();
        updateTerritoryButton();
      }
      return self.territory.shown;
    }
    if (plan.display === 'keep') {
      if (plan.request) requestOwnershipNow();
      return self.territory.shown;
    }
    self.territory.shown = null;
    if (plan.stop) {
      self.territory.active = false;
      self.territory.auto = false;
      self.territory.pending = false;
      self.territory.reqKey = null;
      self.territory.atKey = null;
      terrTimeout().cancel();
      updateTerritoryButton();
    }
    return null;
  }

  /** 批量快照领地取值（仅主谱；试下分支为会话现算，无快照）。 */
  function bundleOwnershipOf(key) {
    const moveNo = isTrialKey(key) ? null : parseMainKey(key);
    if (moveNo === null) return { covered: false, values: null };
    return self.bundle.ownership(moveNo);
  }

  /**
   * 懒加载整局领地快照（**用户首次开启 [领地] 时一次**，人工决策 2026/09/21）。
   * 命中后连续模式逐手零请求；未命中（无分析/无 ownership）的局面仍走既有
   * ``ownership.request``（服务端缺数据时会触发补分析，不得被快照空值降级）。
   */
  async function loadBundleOwnership() {
    if (!self.gameId || self.bundle.hasOwnership() || self.bundleOwnershipLoading) return;
    self.bundleOwnershipLoading = true;
    try {
      const res = await api.get(`/games/${self.gameId}/replay/ownership`);
      if (destroyed || !res || !res.data) return;
      self.bundle.setOwnership(res.data);
      if (!destroyed && self.territory.active) syncBoard(); // 快照命中 → 立即上屏
    } catch {
      /* 领地快照可缺省（回落逐手 ownership.request） */
    } finally {
      self.bundleOwnershipLoading = false;
    }
  }

  /** [领地] 单击/双击仲裁：单击延迟 300ms 执行；窗口内二击 → 立即开启连续模式。 */
  function onTerritoryButton() {
    if (!self.board) return;
    const intent = territoryClickIntent({ armed: Boolean(self.territory.dblTimer) });
    if (intent.kind === 'auto') {
      clearTimeout(self.territory.dblTimer);
      self.territory.dblTimer = null;
      enableAutoTerritory();
      return;
    }
    self.territory.dblTimer = setTimeout(() => {
      self.territory.dblTimer = null;
      singleTerritoryClick();
    }, intent.delayMs);
  }

  function singleTerritoryClick() {
    if (!self.board) return;
    if (self.territory.auto) {
      // 连续模式单击 = 取消（含热力关闭）
      setTerritoryActive(false);
      return;
    }
    setTerritoryActive(!self.territory.active);
  }

  function enableAutoTerritory() {
    if (!self.board) return;
    if (territoryEngineBlocked()) return;
    self.territory.auto = true;
    self.territory.active = true;
    self.territory.pending = false;
    self.territory.reqKey = null;
    loadBundleOwnership(); // 首次开启：懒加载整局领地（命中后逐手零请求）
    requestOwnershipNow();
    updateTerritoryButton();
    syncBoard();
    toast({ level: 'info', text: '已开启「每步自动」领地（再次单击取消）', key: 'terr-auto' });
  }

  function setTerritoryActive(active) {
    if (!self.board) return;
    if (!active) {
      self.territory.active = false;
      self.territory.auto = false;
      self.territory.pending = false;
      self.territory.reqKey = null;
      self.territory.atKey = null;
      self.territory.shown = null;
      terrTimeout().cancel();
    } else {
      if (territoryEngineBlocked()) return;
      self.territory.active = true;
      self.territory.auto = false;
      loadBundleOwnership(); // 首次开启：懒加载整局领地（命中后逐手零请求）
      requestOwnershipNow();
    }
    updateTerritoryButton();
    syncBoard();
  }

  /**
   * 试下局面 + 引擎不可用 + **无本地领地数据** → 领地察看不可用（提示一次并拒绝开启）。
   * 主谱读持久化 `ownership`（引擎无关，UI_UX §6.2）、试下已有会话数据时同样照常。
   */
  function territoryEngineBlocked() {
    const key = posKey();
    const entry = store.getState().positions[key];
    const plan = territoryEnginePlan({
      engineDown: isEngineDown(),
      hasLocalData: Boolean(entry && entry.ownership !== undefined),
      trialPosition: isTrialKey(key),
    });
    if (plan !== 'engine-blocked') return false;
    toast({ level: 'info', text: '引擎不可用：暂无领地数据', key: 'rv-terr-dead' });
    return true;
  }

  /** 请求当前显示局面领地（ownership.request；缺分析时服务端触发 P1，完成后推送）。 */
  function requestOwnershipNow() {
    const key = posKey();
    // 防重仅限**同局面**：步进/试下切换后旧请求在途也不得阻挡新场面请求
    if (territoryRequestAction({ pending: self.territory.pending, pendingAt: self.territory.reqKey, at: key }) === 'skip') return;
    const s = store.getState();
    const entry = s.positions[key];
    self.territory.atKey = key; // 领地作用局面（后续步进的推进判定基准）
    if (entry && entry.ownership !== undefined) {
      self.territory.shown = entry.ownership; // 数据已就绪：由本次 syncBoard 直接应用
      return;
    }
    // 批量快照命中（主谱持久化领地，懒加载后可得）→ 零请求直接上屏
    const snap = bundleOwnershipOf(key);
    if (snap.covered) {
      self.territory.shown = snap.values;
      return;
    }
    // 试下局面无本地数据 → 须引擎现算：引擎已知不可用就不发无效请求（终态回执会立即
    // 空载回投，连续模式还会逐手重入）——结束显示（BUG-044 口径：引擎 DEAD·FATAL 终结
    // 显示）并提示一次（keyed，不逐手弹报；BUG-091）。主谱领地读持久化分析（引擎无关）照常请求。
    if (territoryEngineBlocked()) {
      self.territory.active = false;
      self.territory.auto = false;
      self.territory.pending = false;
      self.territory.reqKey = null;
      self.territory.atKey = null;
      self.territory.shown = null;
      terrTimeout().cancel();
      updateTerritoryButton();
      syncBoard();
      return;
    }
    self.territory.pending = true;
    self.territory.reqKey = key;
    const parsed = isTrialKey(key) ? parseTrialKey(key) : null;
    const data = parsed
      ? { trial_id: parsed.trialId, move_no: parsed.rel }
      : { move_no: parseMainKey(key) };
    if (hub && typeof hub.sendGame === 'function') hub.sendGame('ownership.request', data);
    terrTimeout().arm();
  }

  /**
   * `position.ownership` 视图副作用。**禁止在此再 dispatch**：WS 消息已由壳
   * （`app.js` hub dispatch）写入状态树，订阅回调里二次 dispatch 同类型消息会
   * 无限递归（`[state] listener 异常：Maximum call stack size exceeded`，
   * 热力永不落画布——本批次回归时所查实的既有缺陷）。
   */
  function onOwnership(payload) {
    const key = payload && payload.position_key;
    if (!key) return;
    if (self.territory.pending && self.territory.reqKey === key) {
      self.territory.pending = false;
      self.territory.reqKey = null;
      terrTimeout().cancel();
    }
    if (key === posKey()) syncBoard();
  }

  /* ---------------- 深度 / 全局分析 ---------------- */

  function onAnalyzeClick() {
    const s = store.getState();
    const g = s.game;
    if (!g) return;
    if (self.pos.mode === 'trial') return;
    // 全局分析进行中：**单次点击即中断**（2026/09/19 人工反馈——旧「先布防再确认」
    // 两步与 `点击停止` 文案不符，实际感受为无法中断）。停止请求仅下发一次（等
    // `global_analysis.done` 回投后按钮还原）；开始后 GLOBAL_STOP_GUARD_MS 内忽略
    // 停止点击，吸收「开始」双击的第二击误停。
    if (s.globalAnalysis && s.globalAnalysis.running) {
      if (self.globalStopping) return;
      if (Date.now() - self.globalStartedAt < GLOBAL_STOP_GUARD_MS) return;
      self.globalStopping = true;
      if (hub && typeof hub.sendGame === 'function') hub.sendGame('global_analysis.cancel');
      toast({ level: 'info', text: '已停止分析（已完成手保留，可续跑）', key: 'rv-global-stop' });
      syncButtons();
      return;
    }
    const st = String((s.engine && s.engine.state) || '').toUpperCase();
    if (st === 'DEAD' || st === 'FATAL' || st === 'INIT' || st === 'STOPPED') {
      const text = st === 'INIT'
        ? '引擎加载中，分析延后可用'
        : st === 'STOPPED'
          ? '引擎未启动'
          : '引擎不可用';
      toast({ level: 'info', text, key: 'rv-analyze' });
      return;
    }
    if (missingCount() > 0) {
      startGlobalAnalysis();
      return;
    }
    startDeepAnalysis();
  }

  function startDeepAnalysis() {
    const s = store.getState();
    if (s.deepAnalysis && s.deepAnalysis.running) return;
    if (s.globalAnalysis && s.globalAnalysis.running) return;
    const key = posKey();
    self.deepLitKey = null;   // 重新深算：熄灭上一轮点亮（新结果到达时重新点亮）
    store.dispatch({ type: 'deep.pending', data: { positionKey: key } });
    const data = isTrialKey(key) ? { position_key: key } : { move_no: parseMainKey(key) };
    if (hub && typeof hub.sendGame === 'function') hub.sendGame('deep_analysis.request', data);
    // toast({ level: 'info', text: '深度分析已提交', key: 'rv-deep' });
    syncButtons();
  }

  function startGlobalAnalysis() {
    const s = store.getState();
    if (s.globalAnalysis && s.globalAnalysis.running) return;
    if (s.deepAnalysis && s.deepAnalysis.running) return;
    self.globalStopping = false;
    self.globalStartedAt = Date.now(); // 防误触窗口基准（见 onAnalyzeClick）
    store.dispatch({ type: 'global.pending' });
    if (hub && typeof hub.sendGame === 'function') hub.sendGame('global_analysis.request', {});
    toast({ level: 'info', text: '全局分析已提交', key: 'rv-global' });
    syncButtons();
  }

  /** 全局分析完成/中断：重查覆盖 + 刷新报告入口/曲线/批量快照（试下中不打断分支）。 */
  async function refreshAfterGlobal() {
    if (self.pos.mode === 'trial') {
      return;
    }
    try {
      const res = await api.get(`/games/${self.gameId}`);
      if (destroyed || !res || !res.data) return;
      const detail = res.data;
      self.meta = detail;
      store.dispatch({ type: 'game.state', data: synthGameState(detail) });
    } catch {
      /* 重查失败不阻断 */
    }
    // 补分析可能填充了此前缺数据的局面 → 刷新快照（旧的空条目被清除后走新快照）
    await refreshBundle();
    if (!destroyed) syncAll();
  }

  /* ---------------- 试下分支 ---------------- */

  function onTrialState(data) {
    if (!data) return;
    const g = storeGame();
    if (!g) return;
    const trialId = data.trial_id;
    // M-13：只处理「当前分支更新」与「用户已发起 enter 的新分支」；已退出分支或
    // 无入口意图的陌生 id（迟到/错序回投）一律忽略——旧实现无条件接纳首个回投，
    // 会把已回实战的用户重新拉回试下分支。
    const disposition = trialStateDisposition({
      activeId: self.trial ? self.trial.id : null,
      pendingEnter: Boolean(self._pendingTrial),
      incomingId: trialId,
      exitedId: self._exitedTrialId,
    });
    if (disposition === 'ignore') return;
    const prevLen = self.trial && self.trial.moves ? self.trial.moves.length : 0;
    let transientShrink = false; // 替换流程的中间收缩态（瞬态：不拉推荐/点评）
    const moves = (data.moves || []).map((m) => ({
      moveNo: Number(m.move_no),
      color: m.color,
      x: m.x == null ? null : Number(m.x),
      y: m.y == null ? null : Number(m.y),
      isPass: Boolean(m.is_pass),
    }));
    if (disposition === 'adopt') {
      self._exitedTrialId = null; // 新分支生效：旧退出标记失效
      self.trial = { id: trialId, fromMoveNo: Number(data.enter_move_no) || 0, moves };
      self.pos.mode = 'trial';
      self.pos.rel = Math.max(0, moves.length);
      self.cache.clearTrial(trialId);
      // 若 pending 落子：试下首手（进入状态回投后紧随发送）
      if (self._pendingTrial) {
        const p = self._pendingTrial;
        self._pendingTrial = null;
        self._follow = true;
        hub.sendGame('trial.play', { trial_id: trialId, x: p.x, y: p.y });
      } else if (moves.length === 0) {
        self.pos.rel = 0; // 等待首手回投
      }
      store.dispatch({ type: 'trial.enter', data: { id: trialId, fromMoveNo: self.trial.fromMoveNo } });
    } else {
      self.trial.moves = moves;
      // 替换语义会先回投多个收缩态、末态才是落子（增长）：`_follow` 保持到分支增长
      // 才清除（trialRelAfterState），否则滑轨手数/posKey 越界 → 曲线/推荐/点评不同步。
      if (self.pos.mode === 'trial') {
        const st = trialRelAfterState({
          curRel: self.pos.rel,
          prevLen,
          nextLen: moves.length,
          follow: Boolean(self._follow),
        });
        self.pos.rel = st.rel;
        self._follow = st.follow;
        transientShrink = st.transient;
      } else {
        self._follow = false;
      }
    }
    // 分支落子新增 → 落子声（T6.8 反馈：试下无落子声）；本手提子（2026/09/15）→ 吃子音效优先
    if (moves.length > prevLen) {
      const g = storeGame();
      const captured = lastMoveCaptures({
        size: (g && g.params && g.params.boardSize) || 19,
        handicap: (g && g.params && g.params.handicap) || 0,
        moves: branchAbsMoves(g && g.moves, self.trial ? self.trial.fromMoveNo : 0, moves),
      });
      playSound(captured > 0 ? 'capture' : 'stone');
    }
    // 落子已落地（分支增长）→ 清除“最近一次尝试”标记（不再用于错误定位）
    if (moves.length > prevLen) self._lastTrialPlay = null;
    if (self.pos.mode === 'trial' && (Number(self.pos.rel) || 0) > 0) {
      // 先置“在途”再渲染（同 afterSeek：胜率条/卡片保留上一局面内容，不闪空态）
      if (!transientShrink) requestRecommendFor(posKey());
      scheduleSync();
    } else {
      scheduleSync();
    }
  }

  /** 棋盘空点点击：变化图预览中＝暂停/继续/再次播放；主谱=进入试下并落子；试下=继续分支。交互即停止自动播放。 */
  function onBoardPoint(x, y) {
    // 结算模式：局面固定，空点不响应（死子标记仅针对棋子，经 onBoardStone）
    if (self.settling) return;
    // 点击棋盘空白（空交叉点）= “其它操作”：先收起点评气泡（2026/09/15 人工反馈）
    clearBubble();
    stopAutoplay();
    // 预览期间点击棋盘任意位置＝暂停/继续/再次播放（2026/09/13 人工调整；关闭＝按钮/ESC/定位）
    if (self.preview) {
      togglePreviewPlayback();
      return;
    }
    if (self.pos.mode === 'main') {
      enterTrialFrom(self.pos.moveNo, x, y);
      return;
    }
    if (self.trial) {
      playTrial(x, y);
    }
  }

  /** 试下落子本地预校验（2026/09/12）：非法 → 红 ✕ + 原因 Toast，返回 false（不发送）。
   *
   * 棋盘 = 主谱前缀（≤ ``fromMoveNo``）+ 分支已落子（≤ ``rel``；替换语义截断）；
   * 应落子方按绝对手数奇偶（让子局白先）推导——与后端 ``_trial_next_color``
   * （``nextColorAbs``）一致。
   */
  function trialMoveAllowed(fromMoveNo, rel, x, y) {
    const g = storeGame();
    const handicap = (g && g.params && g.params.handicap) || 0;
    const prefix = upToMainMoves(g && g.moves, fromMoveNo);
    const branch = (self.trial && Array.isArray(self.trial.moves) ? self.trial.moves : [])
      .filter((m) => Number(m.moveNo) <= Number(rel))
      .map((m) => ({ moveNo: Number(m.moveNo), color: m.color, x: m.x, y: m.y, isPass: Boolean(m.isPass) }));
    const state = replayRulesPosition({
      size: (g && g.params && g.params.boardSize) || 19,
      handicap,
      moves: [...prefix, ...branch],
    });
    const color = nextColorAbs(Number(fromMoveNo) + Number(rel), handicap);
    const verdict = checkMove(state, x, y, color);
    if (verdict.legal) return true;
    if (self.board) self.board.flashIllegal(x, y);
    toast({ level: 'error', text: illegalMoveText(verdict.reason), key: 'rv-illegal-move' });
    return false;
  }

  /** 试下落子：显示相对手 < 分支长度 → 先撤销至该手（替换语义），再落子。 */
  function playTrial(x, y) {
    if (!hub || typeof hub.sendGame !== 'function') return;
    if (!self.trial || self.trial.id == null) return;
    exitTransientTerritory(); // 试下落子 = 局面变化：单击瞬态领地即清除
    const id = self.trial.id;
    const cur = Number(self.pos.rel) || 0;
    const len = self.trial.moves.length;
    // 本地规则预校验（2026/09/12 人工口径）：非法即时红 ✕ + 原因 Toast，不发送
    if (!trialMoveAllowed(self.trial.fromMoveNo, cur, x, y)) return;
    self._lastTrialPlay = { x, y };
    // 在分支中途显示后继续落子 = 替换其后手数（服务端撤销截断缓存）
    if (cur < len) {
      // 客户端镜像截断：rel > cur 的会话缓存作废（同 rel 已是新着法，否则回投命中
      // 旧分支数据 → 曲线/推荐/点评不同步）；positions 同镜像（领地/深算缓存）。
      self.cache.truncateTrial(id, cur);
      store.dispatch({ type: 'trial.truncate', data: { trialId: id, rel: cur } });
    }
    for (let i = cur; i < len; i += 1) {
      hub.sendGame('trial.undo', { trial_id: id });
    }
    self._follow = true;
    hub.sendGame('trial.play', { trial_id: id, x, y });
  }

  function enterTrialFrom(fromMoveNo, x, y) {
    if (!hub || typeof hub.sendGame !== 'function') return;
    // 本地规则预校验（试下首手；非法则不进入试下）
    if (!trialMoveAllowed(fromMoveNo, 0, x, y)) return;
    exitTransientTerritory(); // 进入试下 = 局面变化：单击瞬态领地即清除
    self._lastTrialPlay = { x, y };
    toast({ level: 'info', text: '已进入试下模式（会话分支，不落盘）', key: 'rv-trial-enter' });
    self.pos.mode = 'trial';
    self.pos.rel = 0;
    self.trial = null;
    self._pendingTrial = { x, y };
    self.cache.clear();
    hub.sendGame('trial.enter', { move_no: fromMoveNo });
    syncAll();
  }

  /** 棋盘棋子点击：变化图预览中＝暂停/继续/再次播放；结算模式＝切换死子标记；否则显示当前手点评气泡。 */
  function onBoardStone(pt) {
    if (self.settling) {
      if (self.settle) self.settle.toggleDead(pt);
      return;
    }
    stopAutoplay();
    if (self.preview) {
      togglePreviewPlayback();
      return;
    }
    const rec = reviewFor(posKey());
    if (rec && rec.comment && rec.comment.grade
      && Number(rec.comment.x) === pt.x && Number(rec.comment.y) === pt.y) {
      toggleBubble(rec.comment);
    } else {
      clearBubble();
    }
  }

  /** 点评气泡（对弈页同款：棋子附近气泡式，锚定在被点评棋子附近；点击棋子开/关）。 */
  function toggleBubble(comment) {
    const el = qRef('[data-ref="rvBubble"]');
    if (!el || !self.board) return;
    if (!el.classList.contains('u-hide')) {
      clearBubble();
      return;
    }
    // 文案与对弈页同源（commentBubbleModel：落子方标注 + ΔW/ΔS；手数=当前显示手）
    const model = commentBubbleModel(comment, displayMoveNoText());
    if (!model) return;
    el.innerHTML = commentBubbleHTML(model);
    el.classList.remove('u-hide');
    if (!positionBubble(el, comment)) el.classList.add('u-hide');
  }

  /** 气泡定位（与对弈页共用几何；几何未就绪 → 隐藏）。 */
  function positionBubble(el, comment) {
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

  function displayMoveNoText() {
    const inTrial = self.pos.mode === 'trial';
    return inTrial ? self.pos.rel : self.pos.moveNo;
  }

  function clearBubble() {
    const el = qRef('[data-ref="rvBubble"]');
    if (el) el.classList.add('u-hide');
  }

  /* ---------------- 变化图预览 ---------------- */

  /**
   * 预览期间的棋盘点击守卫（**捕获阶段**，挂 boardWrap）：点击棋盘任意位置＝暂停/
   * 继续/再次播放预览（2026/09/13 人工调整；关闭预览＝[关闭预览]/ESC/定位操作）。
   * 捕获阶段拦截保证鼠标与触摸一致——触摸轻点空点默认第一次仅记双击待定、不触发
   * 任何回调；同时吞掉本次点击，防止继续触发试下落子/点评气泡。
   */
  function previewBoardGuard(evt) {
    if (!self.preview) return;
    evt.stopPropagation();
    evt.preventDefault();
    togglePreviewPlayback();
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

  function bindPreviewGuard(on) {
    const wrap = qRef('[data-ref="boardWrap"]');
    if (!wrap) return;
    if (on) wrap.addEventListener('pointerdown', previewBoardGuard, true);
    else wrap.removeEventListener('pointerdown', previewBoardGuard, true);
  }

  function startVariationPreview(idx) {
    if (!self.board) return;
    stopAutoplay();
    const s = store.getState();
    const rec = s.review;
    if (!rec || !Array.isArray(rec.variations)) return;
    const v = rec.variations[idx];
    if (!v || !Array.isArray(v.pv)) return;
    const pts = v.pv
      .filter((pp) => pp && !pp.is_pass && pp.x != null && pp.y != null)
      .map((pp) => ({ x: Number(pp.x), y: Number(pp.y) }))
      .slice(0, getPreviewSteps());
    if (!pts.length) {
      toast({ level: 'info', text: '该候选无可用变化图', key: 'rv-pv-empty' });
      return;
    }
    stopPreview();
    self.preview = { pts, step: 0, playing: true, timer: null };
    bindPreviewGuard(true);
    const chip = qRef('[data-ref="rvPreviewChip"]');
    if (chip) chip.classList.remove('u-hide');
    // 立即重同步：预览期间隐藏棋盘 TOP5 选点标记（与预览棋子重叠；2026/09/13 人工决策）
    syncBoard();
    previewStepTo(1);
  }

  /** 预览步进：固定 700ms/步；**播放到末手停在末手静止显示、不自动关闭**（2026/09/13
   *  人工决策——由用户点击棋盘任意位置或 [关闭预览] 关闭）。 */
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

  function updatePreviewChip() {
    const chip = qRef('[data-ref="rvPreviewChip"]');
    if (!chip || !self.preview) return;
    const label = chip.querySelector('[data-ref="rvPreviewLabel"]');
    const count = chip.querySelector('[data-ref="rvPreviewCount"]');
    // 播放中/已播完→「变化图 N/N」；棋盘点击暂停→「已暂停 N/N」（2026/09/13）。
    // 标签/计数分写两个**定宽盒**（.pv-label/.pv-count，2026/09/19 人工反馈）：
    // 步进与暂停切换的文本长度变化不再改变胶囊宽度（防抖动）。
    if (label && count) {
      const p = self.preview;
      const atEnd = p.step >= p.pts.length;
      label.textContent = p.playing || atEnd ? '变化图' : '已暂停';
      count.textContent = `${p.step}/${p.pts.length}`;
    }
  }

  function stopPreview() {
    if (self.preview) {
      clearTimeout(self.preview.timer);
      self.preview = null;
      bindPreviewGuard(false);
      // 完整重同步：清除预览棋子 + 恢复棋盘 TOP5 选点标记（预览期间隐藏）
      syncBoard();
    } else if (self.board) {
      self.board.setProps({ variations: [] });
    }
    const chip = qRef('[data-ref="rvPreviewChip"]');
    if (chip) chip.classList.add('u-hide');
  }

  /* ---------------- 复弈 / 导出 / 续弈 / 报告 ---------------- */

  async function doRefight() {
    if (!self.trial) return;
    const from = self.trial.fromMoveNo;
    const rel = self.trial.moves.length;
    const ok = await confirmDialog({
      title: '复弈确认',
      message: `将创建新对局（继承前 ${from} 手与试下 ${rel} 手分析），原棋谱保留。`,
      okText: '复弈',
      okIcon: 'i-refight',
    });
    if (!ok || destroyed) return;
    try {
      const res = await api.post(`/games/${self.gameId}/refight`, { trial_id: self.trial.id });
      const gid = res && res.data && res.data.game_id;
      if (!gid) throw Object.assign(new Error('复弈无返回 game_id'), { code: 'INTERNAL_ERROR' });
      ls.set(LS_KEYS.recent, { gameId: Number(gid), ts: Date.now() });
      toast({ level: 'success', text: `复弈成功：将进入新对局续弈`, key: 'rv-refight' });
      if (hub && typeof hub.closeGame === 'function') hub.closeGame();
      nav('#/');
    } catch (err) {
      toast({ code: (err && err.code) || 'INTERNAL_ERROR', message: (err && err.message) || '复弈失败' });
    }
  }

  function doResume() {
    const g = storeGame();
    if (!g) return;
    ls.set(LS_KEYS.recent, { gameId: Number(g.gameId), ts: Date.now() });
    if (hub && typeof hub.closeGame === 'function') hub.closeGame();
    nav('#/');
  }

  async function exportSgf() {
    try {
      // SGF 为文本响应：原生 fetch + blob（rest-client 按 JSON 解析会丢正文）
      const res = await fetch(`/api/games/${self.gameId}/sgf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const filename = parseContentDispositionFilename(cd, `game_${self.gameId}.sgf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast({ level: 'success', text: '棋谱已导出', key: 'rv-export' });
    } catch (err) {
      toast({ code: (err && err.code) || 'INTERNAL_ERROR', message: (err && err.message) || '导出失败' });
    }
  }

  function goReport() {
    // T6.9：报告＝全站弹层（analysis_complete 门控由调用方判定）；无 openReport 时回退旧直达
    if (typeof props.openReport === 'function') {
      props.openReport(self.gameId);
      return;
    }
    nav(`#/report/${self.gameId}?p=B`);
  }

  /* ---------------- 窗口绑定 / 动作 ---------------- */

  function bindActions() {
    bindActionNodes(rootEl);
    const label = qRef('[data-ref="rvTrackLabel"]');
    if (label) {
      const onLabel = (e) => {
        e.preventDefault();
        toggleAutoplay();
      };
      label.addEventListener('click', onLabel);
      label.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') onLabel(e);
      });
    }
    bindSlider();
    // 信息行试下胶囊（行首静态节点，点击 = 回实战）/ 自动点评开关（updateMeta 重建
    // HTML）：统一用事件委托挂在 .info-row（2026/09/13 胶囊移至行首后，原挂
    // .info-meta 的委托不再覆盖胶囊）
    const infoRow = qRef('.info-row');
    if (infoRow) {
      infoRow.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="backToReal"]')) backToReal();
        else if (e.target.closest('[data-act="coachToggle"]')) toggleCoach();
      });
    }
    const drawerClose = qRef('[data-ref="rvDrawerClose"]');
    if (drawerClose) {
      drawerClose.addEventListener('click', () => self.sidebar && self.sidebar.collapse());
    }
    // [···] 菜单「返回列表」：先收起菜单（试下分支时 goBack 会弹二次确认）；
    // [结算] 同样先收起菜单（随即进入结算确认/结算模式）
    const moreMenu = qRef('[data-ref="rvMoreMenu"]');
    if (moreMenu) {
      moreMenu.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="back"], [data-act="settle"]')) moreMenu.classList.add('u-hide');
      });
    }
  }

  function bindWindow() {
    if (!self._escKey) {
      self._escKey = (e) => {
        if (destroyed) return;
        if (self.settling) return; // 结算模式：ESC 由结算模块处理（退出结算模式）
        const tag = e.target && e.target.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
        if (e.key === 'Escape') {
          if (self.preview) {
            e.preventDefault();
            stopPreview();
            return;
          }
          clearBubble();
        }
        if (!typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          stopAutoplay();
          stepDir(e.key === 'ArrowLeft' ? -1 : 1);
        }
      };
      document.addEventListener('keydown', self._escKey, true);
    }
    // 断点（≥768 侧栏 vs ≤767 底部抽屉 dock）变化：重建底部按钮（返回位置）+ 侧栏重排
    if (mqLayout && !mqLayoutHandler) {
      mqLayoutHandler = () => {
        if (destroyed) return;
        renderActions();
        updateWrBar();
        if (self.sidebar && typeof self.sidebar.relayout === 'function') self.sidebar.relayout();
        // 结算模式：结算宿主随断点重排（桌面侧栏卡 ⇄ 移动底部抽屉）
        if (self.settle && typeof self.settle.place === 'function') self.settle.place();
      };
      mqLayout.addEventListener('change', mqLayoutHandler);
    }
    if (!self._docClick) {
      self._docClick = (e) => {
        const menu = qRef('[data-ref="rvMoreMenu"]');
        if (menu && !menu.classList.contains('u-hide')
          && !e.target.closest('[data-ref="rvMoreMenu"], [data-act="more"]')) {
          menu.classList.add('u-hide');
        }
      };
      document.addEventListener('pointerdown', self._docClick, true);
    }
    // 棋盘尺寸变化（窗口/断点）后重算提示重叠（几何随边长变化）
    if (!self._resizeNote) {
      self._resizeNote = () => { if (!destroyed) syncBoardNote(); };
      window.addEventListener('resize', self._resizeNote);
    }
    if (!self.onError) {
      self.onError = (e) => {
        const ev = e && e.detail; // CustomEvent 载荷在 detail（tgo:error）
        if (destroyed || !ev || ev.channel !== 'game') return;
        onGameError(ev);
      };
      window.addEventListener('tgo:error', self.onError);
    }
  }

  function onGameError(e) {
    const code = (e && e.code) || '';
    const outcome = reviewErrorOutcome(code);
    // 服务端兜底拒绝试下落子（本地预校验漏网/状态不同步）→ 棋盘红 ✕ 定位
    if (code === 'ILLEGAL_MOVE' && self._lastTrialPlay && self.board) {
      self.board.flashIllegal(self._lastTrialPlay.x, self._lastTrialPlay.y);
    }
    self._lastTrialPlay = null;
    if (outcome.resetDeep) store.dispatch({ type: 'deep.reset' });
    // M-14：全局分析遇引擎类错误必须复位进行态（否则按钮/进度永久滞留）
    if (outcome.resetGlobal) store.dispatch({ type: 'global.reset' });
    if (outcome.clearRecommend) {
      // 引擎不可用/繁忙：解除领地 pending（回读/实时均不可用，允许恢复后重试）
      self.territory.pending = false;
      self.territory.reqKey = null;
      // 解除当前局面推荐 loading（试下实时推荐依赖引擎）→ 立即进 offline 空态文案
      if (self.recLoading) {
        self.recLoading = false;
        const key = posKey();
        store.dispatch({
          type: 'review.recommend',
          data: { position_key: key, moves: [], variations: [], comment: null, root: null, has_data: false },
        });
      }
    }
    // 引擎不可用：后台按需请求（逐手试下推荐、领地补算）的信封必须静默——降级已由
    // 全局引擎态与入口守卫表达，逐条弹报会变成“每手一个 Toast”（BUG-091；与对弈页
    // onGameError 的无弹报口径一致）。
    if (outcome.silence) return;
    toast({ code, message: (e && e.message) || '操作失败' });
  }

  return { render, destroy };
}

export default createView;

