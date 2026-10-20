/**
 * tGo · 对弈侧栏与实时分析数据（T6.5）
 *
 * 职责（TASK.md T6.5 / UI_UX §5.2.6 / §8 / PROPS C5/C6/C7/C16）：
 *   - **GameInfoCard C5**：玩家行「黑 名·段 vs 白 名·段」+ 当前胜率/目差一行式；
 *   - **WinrateCurve C6**（对弈实时）：消费状态树 ``curve.points``（analysis.curve
 *     每手追加；断点恢复经 REST ``GET /games/{id}/curve`` 回填后 ``curve.set``），
 *     曲线刷新仅改 path d（240ms 动效归 core/curve，此处避免重入/多 rAF 冲突）；
 *   - **CoachTop5 C7**：``coaching.request``（store ``coaching.pending`` 防抖）→
 *     ``coaching.top5``；请求中态、空数组空态、过期/位置错位结果不展示（stale）；
 *     行点击视觉选中（.sel）＋ 变化图预览（``opts.onPickVariation(entry)`` 回调，
 *     2026/09/18；预览状态机归 game-view，GTP 串解析纯函数 ``coachPreviewPoints`` 在此）；
 *   - **领地**：数值量化与棋盘热力由 game-view 负责（Worker），本模块提供降级/空态
 *     文案；**C16 胜率条**派生在此（DOM 在棋盘底部行，由 game-view 呈现）；
 *   - **实时分析底部抽屉 dock（≤767px，常驻；grip 收起/展开、绝不关闭）**：断点
 *     relocator 在本模块（PROMPTS L517：≥768 桌面侧栏双列；基线见 app.css Part Ⅰ：
 *     ≤1199 隐藏 .sidebar，产品层 ≥768 恢复侧栏、抽屉仅 ≤767；样式在 app.css）。
 *
 * 分层：纯函数层（无 DOM，可无头测试） + ``createSidebarModule``（订阅 store 更新
 * 卡片 DOM；不直写棋盘/棋子——AGENTS §4，WS 回调仅更新状态树）。
 */

import { gtpOf } from '../core/board.js';
import { pvToStones } from '../workers/analysis.worker.js';
import { isHumanAi, aiColorOf, nextColorToMove } from '../core/game-model.js';
import { rankText, round, pct, signedPct, scoreLead, visits } from '../core/fmt.js';
import { renderCurve, updateCurve, morphCurve, attachCurveHover, playCurveEnter, CURVE_W, CURVE_H, CURVE_MORPH_MS } from '../core/curve.js';

/* ============================================================
 * 纯函数层（无 DOM）
 * ============================================================ */

/** 桌面断点（PROMPTS L517：≥768px 双列侧栏；≤767 实时分析底部抽屉 dock）。 */
export const DESKTOP_MIN_WIDTH = 768;

/** 数值可用性：非 null 且有限。 */
function num(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

/** 局面点查找：取 moveNo ≤ target 的最大手数点（分析可能滞后于当前手）。 */
export function curPoint(points, moveNo) {
  const list = Array.isArray(points) ? points : [];
  const target = Number(moveNo) || 0;
  let best = -1;
  let hit = null;
  for (const p of list) {
    const n = Number(p && p.moveNo);
    if (!Number.isFinite(n)) continue;
    if (n <= target && n > best) {
      best = n;
      hit = p;
    }
  }
  return hit;
}

/**
 * C5 · 对局信息卡派生。
 * @param {object|null} game 状态树 game
 * @param {object} [opts]
 * @param {Array} [opts.points] 曲线点（黑方视角百分比）
 * @param {boolean} [opts.degraded] 引擎不可用（DEAD/FATAL）→ 胜率/目差灰置
 */
export function deriveInfoCard(game, opts = {}) {
  const points = Array.isArray(opts.points) ? opts.points : [];
  const degraded = Boolean(opts.degraded);
  const moveNo = (game && Number(game.lastMoveNo)) || 0;
  const pt = curPoint(points, moveNo);
  const p = (game && game.players) || {};
  return {
    moveNo,
    winrate: pt ? num(pt.winrate) : null,
    scoreLead: pt ? num(pt.scoreLead) : null,
    pointMoveNo: pt ? Number(pt.moveNo) : null,
    degraded,
    players: {
      black: {
        name: (p.black && p.black.name) || '真人',
        rank: rankText(p.black && p.black.rank),
        tag: (p.black && p.black.tag) || '',
      },
      white: {
        name: (p.white && p.white.name) || '真人',
        rank: rankText(p.white && p.white.rank),
        tag: (p.white && p.white.tag) || '',
      },
    },
  };
}

/**
 * C6 · 胜率/目差曲线卡派生。
 * @returns {{state:'ready'|'loading'|'empty'|'disabled', pts:Array, total:number, current:number}}
 */
export function deriveCurveCard(game, opts = {}) {
  const points = Array.isArray(opts.points) ? opts.points : [];
  const disabled = Boolean(opts.disabled);
  const current = (game && Number(game.lastMoveNo)) || 0;
  const hasMoves = Boolean(game && game.moves && game.moves.length);
  const inPlay = Boolean(game && (game.status === 'active' || game.status === 'created'));
  const pts = points
    .map((p) => ({
      moveNo: Number(p.moveNo),
      winrate: p.winrate == null ? null : Number(p.winrate),
      scoreLead: p.scoreLead == null ? null : Number(p.scoreLead),
    }))
    .sort((a, b) => a.moveNo - b.moveNo);
  const lastPt = pts.length ? pts[pts.length - 1].moveNo : 0;
  const total = Math.max(current, lastPt);

  let state;
  if (disabled) state = 'disabled';
  else if (pts.length) state = 'ready';
  else if (inPlay && (current > 0 || hasMoves)) state = 'loading';
  else state = 'empty';
  return { state, pts, total, current };
}

/**
 * 胜率条渲染动作（保留式加载，2026/09/13 人工反馈：胜率条闪烁 = “空态↔条”反复切换）。
 *   - `render`：当前局面已有数据 → 正常渲染；
 *   - `keep`：当前局面数据在途（上一版仍有效）且已渲染过 → **保留上一次渲染**（不闪）；
 *   - `empty`：本局从未有数据 / 局面已清空（新局、重开） → 稳定高度空态。
 *
 * @param {{hasRate:boolean, shown:boolean, pending:boolean}} o
 * @returns {'render'|'keep'|'empty'}
 */
export function wrBarAction({ hasRate, shown, pending } = {}) {
  if (hasRate) return 'render';
  return shown && pending ? 'keep' : 'empty';
}

/**
 * C16 · 黑白胜率条派生（黑整百分比 + 相邻两点摆幅 delta，黑方视角）。
 * @returns {{disabled:boolean, hasRate:boolean, black:number|null, white:number|null, delta:number|null}}
 */
export function deriveWinrateCard(game, opts = {}) {
  const points = Array.isArray(opts.points) ? opts.points : [];
  const disabled = Boolean(opts.disabled);
  const moveNo = (game && Number(game.lastMoveNo)) || 0;
  const cur = curPoint(points, moveNo);
  const blackW = cur ? num(cur.winrate) : null;
  if (blackW == null) {
    return { disabled, hasRate: false, black: null, white: null, delta: null };
  }
  let delta = null;
  if (cur) {
    const idx = points.findIndex((p) => Number(p.moveNo) === Number(cur.moveNo));
    for (let i = idx - 1; i >= 0; i -= 1) {
      const w = num(points[i].winrate);
      if (w != null) {
        delta = round(blackW - w, 0);
        break;
      }
    }
  }
  const black = round(blackW, 0);
  return { disabled, hasRate: true, black, white: 100 - black, delta };
}

/**
 * 支招可用性：返回禁用原因文案（null = 可用）。
 * 依据 UI_UX §5.2.4：PLAYING + 待落子方为人类/人人；引擎 STOPPED/INIT/DEAD/FATAL 降级。
 */
export function coachDisabledReason({ game, engineState = '', pending = false } = {}) {
  if (!game) return '对局未加载';
  const status = game.status;
  if (status === 'scoring') return '对局已进入结算';
  if (status === 'finished') return '对局已结束';
  if (status !== 'active' && status !== 'created') return '对局未在进行';
  const st = String(engineState || '').toUpperCase();
  if (st === 'DEAD' || st === 'FATAL') return '引擎不可用';
  if (st === 'STOPPED') return '引擎未启动';
  if (st === 'INIT') return '引擎调优中（首次调优后可用）';
  if (pending) return '等待对局响应中…';
  if (isHumanAi(game) && nextColorToMove(game) === aiColorOf(game)) return '轮到 AI 落子，支招不可用';
  return null;
}

/** 领地按钮可用性（同降级语义；PLAYING 任意局面可请求，U-17）。 */
export function territoryReason({ game, engineState = '' } = {}) {
  if (!game) return '对局未加载';
  const status = game.status;
  if (status === 'scoring') return '对局已进入结算';
  if (status === 'finished') return '对局已结束';
  if (status !== 'active' && status !== 'created') return '对局未在进行';
  const st = String(engineState || '').toUpperCase();
  if (st === 'DEAD' || st === 'FATAL') return '引擎不可用';
  if (st === 'STOPPED') return '引擎未启动';
  if (st === 'INIT') return '引擎调优中';
  return null;
}

/**
 * 支招结果与当前局面的对应关系（**单一事实源**）：C7 卡 `stale` 与 [支招] 按钮图标
 * 点亮（`analysisButtons().coach.lit`）共用，避免两处口径漂移。
 * @param {{game?:object, coaching?:object}} opts
 * @returns {{hasData:boolean, fresh:boolean}} hasData=有 TOP5 候选；fresh=结果针对当前局面
 */
export function coachTop5Freshness({ game, coaching } = {}) {
  const raw = Array.isArray(coaching && coaching.topMoves) ? coaching.topMoves : [];
  const atMoveNo = coaching && coaching.atMoveNo != null ? Number(coaching.atMoveNo) : null;
  const cur = (game && Number(game.lastMoveNo)) || 0;
  return { hasData: raw.length > 0, fresh: atMoveNo === cur };
}

/**
 * 底部分析按钮可用态（支招/领地共用，供 game-view 按钮 disabled + Tooltip + 支招进行态）。
 *
 * `loading`（2026/09/14 人工口径）：支招请求进行中（`coaching.loading`）→ [支招] 按钮
 * **仅呼吸动画**（文案/禁点均不改变，重复点击由行为层忽略）；禁用降级（引擎不可用/终局/等待对局响应）
 * 时按降级展示、不呼吸（与 C7 卡 loading 忽略 disabled 的逻辑一致）。
 *
 * `lit`（2026/09/17 人工口径）：TOP5 已到达且仍对应当前局面 → 按钮内图标点亮
 * （`is-lit`；到达瞬间另加一次性动效，由 game-view 依上一帧值派生）；重新请求
 * （`coaching.pending` 清空 topMoves）/ 局面推进（`atMoveNo` 落后）/ 降级 → 熄灭。
 */
export function analysisButtons({ game, engineState = '', flags = {}, coaching = null } = {}) {
  const pending = Boolean(flags && flags.busy);
  const cReason = coachDisabledReason({ game, engineState, pending });
  const tReason = territoryReason({ game, engineState });
  const loading = Boolean(coaching && coaching.loading) && !cReason;
  const { hasData, fresh } = coachTop5Freshness({ game, coaching });
  return {
    coach: { enabled: !cReason, reason: cReason, loading, lit: !cReason && !loading && hasData && fresh },
    territory: { enabled: !tReason, reason: tReason },
  };
}

/**
 * C7 · AI 支招卡派生。
 *
 * 视角（2026/09/11 人工确认）：候选与基准胜率/目差均为**当前执色方视角**
 * （服务端 ``coaching.top5`` 载荷已换算并附 ``side``）——对局信息卡 / 曲线仍固定黑方。
 * @returns {{disabled:boolean, reason:string|null, loading:boolean, stale:boolean,
 *            empty:boolean, entries:Array, atMoveNo:number|null, baseWinrate:number|null,
 *            side:'B'|'W'|null}}
 */
export function deriveCoachCard(game, opts = {}) {
  const points = Array.isArray(opts.points) ? opts.points : [];
  const coaching = opts.coaching || {};
  const engineState = opts.engineState || '';
  const pending = Boolean(opts.pending);
  const reason = coachDisabledReason({ game, engineState, pending });
  const disabled = Boolean(reason);
  const cur = (game && Number(game.lastMoveNo)) || 0;
  const size = (game && game.params && game.params.boardSize) || 19;

  const raw = Array.isArray(coaching.topMoves) ? coaching.topMoves : [];
  const atMoveNo = coaching.atMoveNo == null ? null : Number(coaching.atMoveNo);
  const side = coaching.side === 'B' || coaching.side === 'W'
    ? coaching.side
    : (game && (game.nextColor === 'B' || game.nextColor === 'W') ? game.nextColor : null);
  // 过期/位置错位：结果针对的 moveNo ≠ 当前局面（移动/悔棋后残留）→ 不展示
  const { hasData, fresh } = coachTop5Freshness({ game, coaching });
  const stale = !disabled && hasData && !fresh;

  // 基准：优先载荷自带（同视角）；否则回退曲线点（黑方视角）按 side 换算
  const base = curPoint(points, cur);
  const baseBlack = base ? num(base.winrate) : null;
  const baseWinrate = coaching.baseWinrate != null && Number.isFinite(Number(coaching.baseWinrate))
    ? Number(coaching.baseWinrate)
    : baseBlack == null
      ? null
      : side === 'W' ? round(100 - baseBlack, 1) : baseBlack;
  const baseScoreBlack = base ? num(base.scoreLead) : null;
  const baseScore = baseScoreBlack == null ? null : side === 'W' ? -baseScoreBlack : baseScoreBlack;

  const entries = disabled || stale
    ? []
    : raw.slice(0, 5).map((m, i) => {
      const w = num(m.winrate);
      const s = num(m.score_lead);
      return {
        rank: i + 1,
        x: m.x == null ? null : Number(m.x),
        y: m.y == null ? null : Number(m.y),
        coord: m.x == null || m.y == null ? 'PASS' : gtpOf(Number(m.x), Number(m.y), size),
        winrate: w,
        scoreLead: s,
        // delta = 候选 − 当前局面基准（同为当前执色方视角）；base 缺失 → null（展示回退绝对值）
        deltaWinrate: w != null && baseWinrate != null ? round(w - baseWinrate, 1) : null,
        deltaScore: s != null && baseScore != null ? round(s - baseScore, 1) : null,
        visits: m.visits == null ? null : Number(m.visits),
        pv: Array.isArray(m.pv) ? m.pv : [],
      };
    });

  return {
    disabled,
    reason,
    loading: Boolean(coaching.loading) && !disabled,
    stale,
    empty: !disabled && !stale && !coaching.loading && entries.length === 0,
    entries,
    atMoveNo,
    baseWinrate,
    side,
  };
}

/**
 * 支招候选 → 变化图预览点列（对弈页，2026/09/18 人工确认）。
 *
 * 载荷口径：``coaching.top5.moves[].pv`` 为**原始 GTP 串**（API §4.3），复用 Worker
 * 同款纯函数 ``pvToStones`` 解析（越界/非法坐标即中止，与后端 ``gtp_to_xy`` 同语义；
 * PASS 不落点）。与复盘页 ``variations[].pv`` 预览对齐：只取落点序列，黑/白颜色由
 * 棋盘按 ``toMove`` 起交替派生；超 ``maxSteps``（本地偏好 5–15，默认 10）截断，
 * PASS 不占预览步数（同复盘 filter→slice 口径）。
 *
 * @param {{pv?: Array<string>}} entry 支招单元（deriveCoachCard entries/原始 topMoves 单元）
 * @param {{boardSize?:number, side?:'B'|'W'|null, maxSteps?:number}} [opts]
 * @returns {Array<{x:number,y:number}>} 预览点列（可能为空数组）
 */
export function coachPreviewPoints(entry, opts = {}) {
  const pv = entry && Array.isArray(entry.pv) ? entry.pv : [];
  if (!pv.length) return [];
  const maxSteps = Number.isFinite(Number(opts.maxSteps)) && Number(opts.maxSteps) > 0
    ? Math.floor(Number(opts.maxSteps))
    : 10;
  const parsed = pvToStones(pv, {
    n: Number(opts.boardSize) || 19,
    firstColor: opts.side === 'W' ? 'white' : 'black',
    // 截断交给下方 slice：PASS 不占预览步数
    maxSteps: pv.length,
  });
  return parsed.points.slice(0, maxSteps).map((p) => ({ x: p.x, y: p.y }));
}

/** 领地热力无数据（ownership=null）说明。 */
export const TERRITORY_NO_DATA_TEXT = '当前局面暂无领地数据，标准分析完成后自动显示';

/* ============================================================
 * 文案 / 转义工具
 * ============================================================ */

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 带符号目差（U+2212，1 位小数去尾 0）；null/非法 → ''。 */
export function signedLead(v) {
  if (v == null) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const r = round(n, 1);
  const neg = r < 0;
  const abs = Math.abs(r).toFixed(1).replace(/\.0+$/, '');
  return `${neg ? '−' : '+'}${abs}`;
}

/** 玩家行 HTML（C5：黑名左 / VS 徽章中 / 白名右；段位右上角标 + AI 风格标签）。 */
export function playersLineHTML(players) {
  const black = (players && players.black) || { name: '真人', rank: '' };
  const white = (players && players.white) || { name: '真人', rank: '' };
  const rankSup = (r) => (r ? `<span class="rank-sup">${esc(r)}</span>` : '');
  const tag = (t) => (t ? `<span class="ai-tag">· ${esc(t)}</span>` : '');
  return `
    <div class="player-line">
      <span class="p-side l"><span class="stone-mini" aria-hidden="true"></span>黑 ${esc(black.name)}${rankSup(black.rank)}${tag(black.tag)}</span>
      <span class="vs-badge" aria-hidden="true"><svg><use href="#i-vs"/></svg></span>
      <span class="p-side r"><span class="stone-mini w" aria-hidden="true"></span>白 ${esc(white.name)}${rankSup(white.rank)}${tag(white.tag)}</span>
    </div>`;
}

/** 数值单元卡值（null → '—'）。 */
function kvValue(value, unit, d = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const body = String(round(n, d)).replace(/\.0+$/, '');
  return `${body}<small>${unit}</small>`;
}

/* ============================================================
 * 卡片 HTML（导出供模块与潜在复用）
 * ============================================================ */

/** C5 对局信息卡 body（根 .card 外框在模板中固定，动态刷新**仅替换 body**——防嵌套卡
 *  「毛玻璃层中的卡片层」；与复盘页 `reviewInfoBodyHTML` 同口径，2026/09/14）。 */
export function infoCardBodyHTML(info) {
  const kvClass = info.degraded ? 'kv is-grey' : 'kv';
  const score = info.scoreLead == null
    ? '—'
    : `${signedLead(info.scoreLead)}<small>目</small>`;
  return `
      <h3><svg class="icon" aria-hidden="true"><use href="#i-info"/></svg>对局信息</h3>
      ${playersLineHTML(info.players)}
      <div class="${kvClass}">
        <div class="item">
          <div class="label">当前胜率（黑）</div>
          <div class="value num">${kvValue(info.winrate, '%', 1)}</div>
        </div>
        <div class="item">
          <div class="label">当前目差（黑）</div>
          <div class="value num">${score}</div>
        </div>
      </div>
      ${info.degraded ? '<div class="info-note muted">引擎不可用 · 数值为最近一次分析</div>' : ''}`;
}

/** C5 对局信息卡（完整卡：初始模板用；刷新走 `infoCardBodyHTML`）。 */
export function infoCardHTML(info) {
  return `
    <div class="card" data-card="info" data-ref="infoCard">${infoCardBodyHTML(info)}</div>`;
}

/** C6 曲线卡（svg 由模块驱动，note/skeleton 区动态切换）。 */
export function curveCardHTML() {
  return `
    <div class="card" data-card="curve">
      <h3><svg class="icon" aria-hidden="true"><use href="#i-curve"/></svg>胜率 / 目差曲线（黑）</h3>
      <div class="chart">
        <svg data-ref="curveSvg" viewBox="0 0 ${CURVE_W} ${CURVE_H}" preserveAspectRatio="none"
             role="img" aria-label="胜率/目差曲线"></svg>
        <div class="chart-note u-hide" data-ref="curveNote"></div>
        <div class="chart-skeleton u-hide" data-ref="curveSkeleton" aria-hidden="true"></div>
      </div>
      <div class="coach-foot" data-ref="curveFoot">实线=胜率 · 虚线=目差 · 悬停显示明细</div>
    </div>`;
}

/** C7 支招卡（body 区动态切换状态）。 */
export function coachCardHTML() {
  return `
    <div class="card" data-card="coach">
      <div class="coach-title"><svg class="icon" aria-hidden="true"><use href="#i-coach"/></svg>AI 支招</div>
      <div data-ref="coachBody"></div>
      <div class="coach-foot" data-ref="coachFoot"></div>
    </div>`;
}

/**
 * 支招单行 HTML（列宽固定：26 序号/44 坐标/76 胜率/84 目差/1fr Visits）。
 * 2026/09/06 人工反馈：胜率/目差**标签与数值拆分**（ck=标签、cv=数值），使各行
 * 「胜率/目差」标签处于同一纵向列（数值长度不同时不再导致标签错位）。
 */
export function coachRowHTML(entry) {
  const wrVal = entry.deltaWinrate != null
    ? signedPct(entry.deltaWinrate, 1)
    : entry.winrate != null
      ? pct(entry.winrate, 1)
      : '—';
  const slVal = entry.deltaScore != null
    ? scoreLead(entry.deltaScore)
    : entry.scoreLead != null
      ? scoreLead(entry.scoreLead)
      : '—';
  const vt = entry.visits == null ? '' : visits(entry.visits);
  const wrA = `胜率${wrVal}`;
  const slA = `目差${slVal}`;
  const aria = `第 ${entry.rank} 推荐：${entry.coord}，${wrA}，${slA}${vt ? `，${vt}` : ''}`;
  return `
    <div class="coach-item" data-i="${entry.rank - 1}" role="button" tabindex="0" aria-label="${esc(aria)}">
      <span class="rank-badge rank-${entry.rank}">${entry.rank}</span>
      <span class="coach-coord">${esc(entry.coord)}</span>
      <span class="coach-wr"><span class="ck">胜率</span><span class="cv">${esc(wrVal)}</span></span>
      <span class="coach-sl"><span class="ck">目差</span><span class="cv">${esc(slVal)}</span></span>
      <span class="coach-visits">${esc(vt)}</span>
    </div>`;
}

/* ============================================================
 * 侧栏模块（DOM 组件；由 game-view 挂载）
 * ============================================================ */

/**
 * 创建对弈侧栏模块。
 * @param {object} opts
 * @param {object} opts.store 状态树 store（subscribe/getState/dispatch）
 * @param {object} opts.hub   ws hub（sendGame('coaching.request')）
 * @param {object} opts.hosts
 * @param {HTMLElement} opts.hosts.desktop     桌面侧栏容器（aside 内）
 * @param {HTMLElement} opts.hosts.drawerRoot  抽屉根（含 mask + game-drawer）
 * @param {HTMLElement} opts.hosts.drawerMask  抽屉遮罩
 * @param {HTMLElement} opts.hosts.gameDrawer  抽屉面板
 * @param {HTMLElement} opts.hosts.drawerGrip  抽屉拖拽把手
 * @param {HTMLElement} opts.hosts.drawerBody  抽屉内容容器
 * @param {Function} [opts.onDrawerChange]     开合回调
 * @param {Function} [opts.onPickVariation]    支招行点击（选中）→ 变化图预览（传 entry）
 * @param {Function} [opts.toast]              Toast
 */
export function createSidebarModule(opts) {
  const store = opts.store;
  const hub = opts.hub;
  const hosts = opts.hosts || {};
  const onDrawerChange = opts.onDrawerChange || (() => {});
  const onPickVariation = opts.onPickVariation || (() => {});
  const toast = opts.toast || (() => {});

  const mqDesktop = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`)
    : null;

  let wrapper = null; // .sidebar-cards（唯一内容节点，随断点在 desktop/drawer 间迁移）
  let destroyed = false;
  let unsub = null;
  let mqHandler = null;
  let selectedIdx = -1; // 支招行视觉选中
  let lastCoachSig = '';
  let swipe = null;
  let curveMorphCancel = null; // 曲线 240ms morph 取消函数（防叠加/销毁泄漏）
  let curveHoverUnbind = null; // 曲线 悬停明细解绑（销毁时调）
  let curveShown = false; // 曲线可见态（空态→有数据 = 首次出现 → 淡入）
  const reducedMotion = (typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ---------------- 工具 ---------------- */

  function q(ref) {
    return wrapper ? wrapper.querySelector(`[data-ref="${ref}"]`) : null;
  }

  function setHtml(el, html) {
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }

  function isEngineDown(engineState) {
    const st = String(engineState || '').toUpperCase();
    return st === 'DEAD' || st === 'FATAL';
  }

  /* ---------------- 卡片刷新（store 订阅入口） ---------------- */

  function renderState() {
    if (!wrapper || destroyed) return;
    const s = store.getState();
    const g = s.game;
    const engineState = s.engine && s.engine.state;
    const points = (s.curve && s.curve.points) || [];
    const down = isEngineDown(engineState);

    // —— C5 对局信息卡（刷新仅 body：完整卡在初始模板固定——防嵌套卡“毛玻璃层中的卡片层”，2026/09/14） ——
    const infoEl = q('infoCard');
    if (infoEl) {
      setHtml(infoEl, infoCardBodyHTML(deriveInfoCard(g, { points, degraded: down })));
    }

    // —— C6 曲线卡 ——
    const curve = deriveCurveCard(g, { points, disabled: down });
    renderCurveState(curve);

    // —— C7 支招卡 ——
    const coach = deriveCoachCard(g, {
      points,
      engineState,
      coaching: s.coaching,
      pending: false, // busy/等待由底部按钮门控（game-view）；卡片反映引擎/回合态
    });
    const sig = `${coach.disabled}|${coach.reason}|${coach.loading}|${coach.stale}|${coach.empty}|${coach.entries.length}|${coach.atMoveNo}|${selectedIdx}`;
    if (sig !== lastCoachSig) {
      lastCoachSig = sig;
      renderCoachCard(coach);
    }
  }

  /* ---------------- C6 曲线渲染 ---------------- */

  /**
   * 曲线增量更新（2026/09/06 人工反馈：数据更新需带 240ms 动画）。
   * 已有曲线 → morphCurve 逐帧插值（仅改 path d）；reduced-motion 或首绘 → 直出。
   * 新数据到达时取消上一次 morph，避免多段动画叠加冲突。
   */
  function applyCurve(svgEl, data) {
    if (curveMorphCancel) {
      curveMorphCancel();
      curveMorphCancel = null;
    }
    if (reducedMotion) {
      updateCurve(svgEl, data);
      return;
    }
    curveMorphCancel = morphCurve(svgEl, data, { duration: CURVE_MORPH_MS });
  }

  function renderCurveState(curve) {
    const svgEl = q('curveSvg');
    const noteEl = q('curveNote');
    const skelEl = q('curveSkeleton');
    if (!svgEl || !noteEl || !skelEl) return;
    const foot = q('curveFoot');
    const aria = curve.pts.length
      ? `胜率/目差曲线（第 ${curve.pts[curve.pts.length - 1].moveNo} 手）`
      : '胜率/目差曲线';
    svgEl.setAttribute('aria-label', aria);
    const data = { pts: curve.pts, current: curve.current, total: curve.total };

    if (curve.state === 'ready') {
      const entering = !curveShown; // 首次出现/空态→有数据：淡入 + 全量重绘
      curveShown = true;
      svgEl.classList.remove('u-hide', 'is-grey');
      noteEl.classList.add('u-hide');
      skelEl.classList.add('u-hide');
      if (entering) {
        renderCurve(svgEl, data);
        playCurveEnter(svgEl);
      } else if (!svgEl.querySelector('.cr-w')) {
        renderCurve(svgEl, data);
      } else {
        applyCurve(svgEl, data);
      }
      if (foot) setHtml(foot, '实线=胜率 · 虚线=目差 · 悬停显示明细');
      return;
    }
    if (curve.state === 'disabled') {
      skelEl.classList.add('u-hide');
      if (curve.pts.length) {
        // 保留历史曲线并灰置（仍更新至最新）
        const entering = !curveShown;
        curveShown = true;
        svgEl.classList.remove('u-hide');
        svgEl.classList.add('is-grey');
        noteEl.classList.add('u-hide');
        if (entering) {
          renderCurve(svgEl, data);
          playCurveEnter(svgEl);
        } else if (!svgEl.querySelector('.cr-w')) {
          renderCurve(svgEl, data);
        } else {
          applyCurve(svgEl, data);
        }
        if (foot) setHtml(foot, '引擎不可用 · 曲线保留历史数据');
      } else {
        curveShown = false;
        svgEl.classList.add('u-hide');
        noteEl.textContent = '引擎不可用，暂无曲线数据';
        noteEl.classList.remove('u-hide');
        if (foot) setHtml(foot, '');
      }
      return;
    }
    // loading / empty：隐藏曲线，显示骨架或说明
    curveShown = false;
    svgEl.classList.add('u-hide');
    svgEl.classList.remove('is-grey');
    skelEl.classList.toggle('u-hide', curve.state !== 'loading');
    noteEl.classList.toggle('u-hide', curve.state !== 'empty');
    if (curve.state === 'empty') noteEl.textContent = '暂无曲线数据 · 落子后实时生成';
    if (foot) setHtml(foot, curve.state === 'loading' ? '分析生成中…' : '');
  }

  /* ---------------- C7 支招渲染 ---------------- */

  function renderCoachCard(coach) {
    const body = q('coachBody');
    const foot = q('coachFoot');
    if (!body || !foot) return;
    const card = body.closest('.card');
    if (card) card.classList.toggle('is-disabled', coach.disabled);

    if (coach.disabled) {
      setHtml(body, `<div class="coach-empty muted">${esc(coach.reason || 'AI 支招暂不可用')}</div>`);
      setHtml(foot, '引擎就绪后自动恢复');
      return;
    }
    if (coach.loading) {
      setHtml(body, `
        <div class="coach-pending" role="status" aria-live="polite">
          <span class="coach-spin" aria-hidden="true"></span>AI 分析中…
        </div>`);
      setHtml(foot, '深度分析（高精度）计算中，完成后自动展示');
      return;
    }
    if (coach.stale) {
      setHtml(body, '<div class="coach-empty muted">对局已推进，旧推荐已失效 · 可重新点击 [支招]</div>');
      setHtml(foot, '');
      return;
    }
    if (coach.empty) {
      setHtml(body, `
        <div class="coach-empty">
          <div class="muted">暂无推荐 · 点击 [支招] 获取实时 TOP5</div>
          <button class="btn btn-secondary btn-sm" type="button" data-act="coach-cta">请求实时支招</button>
        </div>`);
      setHtml(foot, '推荐基于当前局面深度分析');
      const cta = body.querySelector('[data-act="coach-cta"]');
      if (cta) cta.addEventListener('click', () => requestCoach());
      return;
    }
    // ready：TOP5 列表
    setHtml(
      body,
      `<div class="coach-list">${coach.entries.map((e) => coachRowHTML(e)).join('')}</div>`,
    );
    setHtml(foot, coach.baseWinrate != null
      ? `对比当前局面胜率 ${pct(coach.baseWinrate, 1)}（${sideTextOf(coach.side)}视角）`
      : '点击推荐行预览变化图');
    bindCoachRows(body, coach.entries);
  }

  /** 视角文案：'W'→白方 / 'B'/未知→黑方。 */
  function sideTextOf(side) {
    return side === 'W' ? '白方' : '黑方';
  }

  function bindCoachRows(body, entries) {
    const list = Array.isArray(entries) ? entries : [];
    body.querySelectorAll('.coach-item').forEach((row) => {
      const idx = Number(row.dataset.i) || 0;
      row.classList.toggle('sel', idx === selectedIdx);
      const onPick = () => {
        selectedIdx = selectedIdx === idx ? -1 : idx;
        body.querySelectorAll('.coach-item').forEach((r) => {
          r.classList.toggle('sel', Number(r.dataset.i) === selectedIdx);
        });
        // 选中行 → 变化图预览（复点取消选中不触发；同复盘页 review-sidebar 口径）
        if (selectedIdx >= 0 && list[selectedIdx]) onPickVariation(list[selectedIdx]);
      };
      row.addEventListener('click', onPick);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      });
    });
  }

  /* ---------------- 请求支招（防抖 + 门控） ---------------- */

  function requestCoach() {
    const s = store.getState();
    const g = s.game;
    if (!g) return false;
    const reason = coachDisabledReason({
      game: g,
      engineState: s.engine && s.engine.state,
      pending: false,
    });
    if (reason) {
      toast({ code: 'ILLEGAL_ACTION', message: reason });
      return false;
    }
    if (s.coaching && s.coaching.loading) return false; // 防抖：进行中
    const moveNo = Number(g.lastMoveNo) || 0;
    store.dispatch({ type: 'coaching.pending', data: { move_no: moveNo } });
    hub.sendGame('coaching.request');
    // 2026/09/06 人工反馈：点击 [支招] 不自动弹出抽屉/侧栏（结果就绪后由用户自行展开查看）
    return true;
  }

  /* ---------------- 断点 relocator / 抽屉（≤767 常驻 dock；≥768 桌面侧栏） ---------------- */

  function isDesktop() {
    if (mqDesktop) return mqDesktop.matches;
    return (typeof window !== 'undefined' && window.innerWidth) >= DESKTOP_MIN_WIDTH;
  }

  let hostHidden = false; // 宿主强制整 dock 隐藏（结算/终局等）

  /** 内容节点在 桌面侧栏 / ≤767 抽屉 dock 之间迁移。 */
  function place() {
    if (!wrapper) return;
    const desktop = isDesktop();
    const target = desktop ? hosts.desktop : hosts.drawerBody;
    if (target && wrapper.parentNode !== target) target.appendChild(wrapper);
    if (desktop) {
      setDockVisible(false); // 桌面不出现底部 dock
      return;
    }
    // ≤767：常驻 dock，默认收起；宿主强制隐藏（结算/终局）时保持隐藏
    if (!hostHidden) {
      setDockVisible(true);
      collapse();
    }
  }

  /** dock 整体显示/隐藏（u-hide；仅宿主 hide()/show() 使用，用户只收起/展开）。 */
  function setDockVisible(visible) {
    if (!hosts.drawerRoot) return;
    hosts.drawerRoot.classList.toggle('u-hide', !visible);
  }

  /** 宿主强制隐藏（进入结算/终局时移出视觉层，避免与分析/结算底部叠层）。 */
  function hide() {
    hostHidden = true;
    setDockVisible(false);
    onDrawerChange(false);
  }

  /** 宿主恢复（退出结算回对弈时重挂 dock，默认收起）。 */
  function show() {
    hostHidden = false;
    if (isDesktop()) return;
    setDockVisible(true);
    collapse();
  }

  /** grip aria/title 与展开态同步。 */
  function syncDrawerAria(expanded) {
    const grip = hosts.drawerGrip;
    if (!grip) return;
    grip.setAttribute('aria-expanded', String(expanded));
    grip.setAttribute('aria-label', expanded ? '收起实时分析（露出棋盘）' : '展开实时分析');
    grip.title = expanded ? '轻点收起；按住下滑收起、上滑展开（不关闭）' : '轻点展开；按住上滑展开、下滑收起（不关闭）';
  }

  /** 展开：≤767 显示 dock 内容 + 遮罩（点遮罩/✕/ESC/下滑/grip 收起，不关闭）。 */
  function expand(card) {
    if (isDesktop()) {
      if (card && wrapper) {
        const el = wrapper.querySelector(`[data-card="${card}"]`);
        // reduced-motion：平滑滚动降级为瞬时（WIG 减动效口径）
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
      }
      onDrawerChange(false);
      return;
    }
    if (!hosts.drawerRoot || !hosts.gameDrawer) return;
    hosts.drawerRoot.classList.remove('u-hide');
    hosts.drawerRoot.classList.remove('collapsed');
    syncDrawerAria(true);
    if (card && hosts.drawerBody) {
      const el = hosts.drawerBody.querySelector(`[data-card="${card}"]`);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
    onDrawerChange(true);
  }

  /** 收起：仅剩 grip 条（露出棋盘）；不关闭、不 u-hide。 */
  function collapse() {
    if (isDesktop()) return;
    if (!hosts.drawerRoot) return;
    hosts.drawerRoot.classList.add('collapsed');
    syncDrawerAria(false);
    onDrawerChange(false);
  }

  function toggle() {
    if (isDesktop()) return;
    if (isDrawerOpen()) collapse();
    else expand();
  }

  function isDrawerOpen() {
    if (!hosts.drawerRoot) return false;
    return !hosts.drawerRoot.classList.contains('collapsed')
      && !hosts.drawerRoot.classList.contains('u-hide');
  }

  /* ---------------- 生命周期 ---------------- */

  function build() {
    if (!hosts.desktop || wrapper) return;
    wrapper = document.createElement('div');
    wrapper.className = 'sidebar-cards';
    wrapper.innerHTML =
      infoCardHTML(deriveInfoCard(null, {})) +
      curveCardHTML() +
      coachCardHTML();
    hosts.desktop.appendChild(wrapper);
    bindDrawer();
    curveHoverUnbind = attachCurveHover(q('curveSvg'));
    place();
  }

  function bindDrawer() {
    if (!hosts.drawerRoot) return;
    const root = hosts.drawerRoot;
    const mask = hosts.drawerMask;
    const panel = hosts.gameDrawer;
    const grip = hosts.drawerGrip;

    // 遮罩点击 = 收起（非关闭）
    if (mask) mask.addEventListener('click', () => collapse());

    // ESC：展开态收起（桌面/宿主隐藏/已有确认弹层让位）
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      if (isDesktop() || hostHidden || !isDrawerOpen()) return;
      if (document.querySelector('.dialog-mask')) return; // 确认弹层让位
      collapse();
    };
    document.addEventListener('keydown', onEsc);

    // grip＝顶部小横条（可点/可拖）：轻点=收起/展开切换；按住下滑(展开态)=收起、上滑(收起态)=展开
    let drag = null;
    let suppressClickUntil = 0;
    if (grip && panel) {
      const onDown = (e) => {
        if (isDesktop() || hostHidden) return;
        drag = { y: e.clientY, moved: false };
        panel.classList.add('dragging');
        try { grip.setPointerCapture(e.pointerId); } catch { /* 无捕获环境 */ }
      };
      const onMove = (e) => {
        if (!drag) return;
        const dy = e.clientY - drag.y;
        if (Math.abs(dy) > 6) drag.moved = true;
        const collapsed = root.classList.contains('collapsed');
        let ty = 0;
        if (collapsed) ty = Math.min(0, dy);      // 收起态可上拉展开
        else ty = Math.max(0, dy);                // 展开态可下拉收起
        panel.style.transform = ty ? `translateY(${ty}px)` : '';
      };
      const onUp = (e) => {
        if (!drag) return;
        const dy = e.clientY - drag.y;
        const moved = drag.moved;
        drag = null;
        if (panel) { panel.classList.remove('dragging'); panel.style.transform = ''; }
        try { grip.releasePointerCapture(e.pointerId); } catch { /* 无捕获 */ }
        if (!moved) return; // 轻点交给 click 切换
        suppressClickUntil = Date.now() + 350;
        if (dy > 40 && !root.classList.contains('collapsed')) collapse();
        else if (dy < -40 && root.classList.contains('collapsed')) expand();
      };
      const onClick = () => {
        if (Date.now() < suppressClickUntil) return;
        if (isDesktop() || hostHidden) return;
        if (root.classList.contains('collapsed')) expand();
        else collapse();
      };
      grip.addEventListener('pointerdown', onDown);
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onUp);
      grip.addEventListener('click', onClick);
      swipe = { grip, onDown, onMove, onUp, onClick };
    }
    opts.__esc = onEsc;
  }

  function render() {
    build();
    if (destroyed || !wrapper) return;
    if (!unsub) {
      unsub = store.subscribe(() => {
        if (!destroyed) renderState();
      });
    }
    if (mqDesktop && !mqHandler) {
      mqHandler = () => {
        if (!destroyed) place();
      };
      mqDesktop.addEventListener('change', mqHandler);
    }
    renderState();
  }

  function destroy() {
    destroyed = true;
    if (curveMorphCancel) {
      curveMorphCancel();
      curveMorphCancel = null;
    }
    if (curveHoverUnbind) {
      curveHoverUnbind();
      curveHoverUnbind = null;
    }
    if (unsub) {
      unsub();
      unsub = null;
    }
    if (mqHandler && mqDesktop) {
      mqDesktop.removeEventListener('change', mqHandler);
      mqHandler = null;
    }
    if (opts.__esc) {
      document.removeEventListener('keydown', opts.__esc);
      opts.__esc = null;
    }
    if (swipe) {
      swipe.grip.removeEventListener('pointerdown', swipe.onDown);
      swipe.grip.removeEventListener('pointermove', swipe.onMove);
      swipe.grip.removeEventListener('pointerup', swipe.onUp);
      swipe.grip.removeEventListener('pointercancel', swipe.onUp);
      swipe.grip.removeEventListener('click', swipe.onClick);
      swipe = null;
    }
    if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    wrapper = null;
  }

  return {
    render,
    expand,
    collapse,
    hide,
    show,
    toggle,
    requestCoach,
    isDrawerOpen,
    destroy,
    refresh: renderState,
  };
}

export default createSidebarModule;
