/**
 * tGo · 复盘侧栏数据卡（T6.8：AI 推荐（回放）/ 当前手点评 / 曲线 / 对局信息）
 *
 * 职责（TASK.md T6.8 / UI_UX §5.5.2 / WEBUI pages/review.html 基线）：
 *   - **对局信息卡**：玩家行 + 结果 / 分析覆盖（REST 详情派生，引擎无关）；
 *   - **胜率/目差曲线卡**：主谱读 ``store.curve.points``（REST ``/curve`` 回填）；
 *     试下分支只画**主谱前缀（0..进入手）+ 试下分支点**（进入手之后的主谱未来
 *     不上图——试下数据与原谱不混线，2026/09/12 人工确认）；曲线按显示手绘制
 *     当前竖线（试下=绝对手数），hover 明细 + 最近点高亮，点击定位（主谱/分支）；
 *   - **AI 推荐（回放）**：消费 ``review.recommend``（主谱读持久化/试下读会话，
 *     引擎无关）；缺数据空态 + [全局分析补全] CTA（引擎不可用灰置）；行点击 →
 *     ``onPickVariation``（变化图预览，默认 10 步，交互归 review-view）；
 *   - **当前手点评**：当前显示手（主谱/试下）的 grade 五色 + ΔW/ΔS 文字三重标识；
 *   - **断点 relocator（≤767 底部抽屉 dock）**：与对弈分析抽屉一致（grip 收起/展开、
 *     绝不关闭；卡片最大宽 384px、可并列）。样式在 app.css（基线见 Part Ⅰ）。
 *
 * 分层：纯函数层（无 DOM 可无头测试，FE-RV-*）+ ``createReviewSidebarModule``。
 * 模块订阅 store 与 ``getPos()``（控制器本地当前显示局面），经派生函数更新卡 DOM。
 */

import { rankText, round, pct, signedPct, scoreLead, gradeText, gradeAlt } from '../core/fmt.js';
import { gtpOf } from '../core/board.js';
import { renderCurve, updateCurve, morphCurve, pointAtClientX, attachCurveHover, playCurveEnter, CURVE_W, CURVE_H, CURVE_MORPH_MS } from '../core/curve.js';
import { fmtScore } from './scoring-panel.js';

/* ============================================================
 * 纯函数层（无 DOM；可无头测试）
 * ============================================================ */

/** 桌面断点（与对弈分析抽屉一致：≥768 桌面侧栏；≤767 底部抽屉 dock）。 */
export const DESKTOP_MIN_WIDTH = 768;

/** 数值可用性：非 null 且有限。 */
function num(v) {
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * 复盘对局信息卡派生（REST 详情：players/result/分析覆盖/状态）。
 * @param {object|null} game 归一 game（state.game 或 REST 详情归一）
 * @returns {{players:{black:{name,rank},white:{name,rank}}, result:string|null, status:string,
 *            analysisDone:number, analysisTotal:number, analysisComplete:boolean}}
 */
export function deriveReviewInfo(game = null) {
  const p = (game && game.players) || {};
  const movesCount = game && game.movesCount != null ? Number(game.movesCount) : (game && game.moves ? game.moves.length : 0);
  const analysesCount = game && game.analysesCount != null ? Number(game.analysesCount) : 0;
  const complete = Boolean(game && game.analysisComplete);
  return {
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
    result: (game && game.result) || null,
    // 状态（2026/09/19）：与 result 联合区分「未结算终局」（导入棋谱）与「未结束」
    status: (game && game.status) || '',
    // 分析覆盖：已分析局面数 / 应有局面数（0..last 共 movesCount+1 局）
    analysisDone: Math.min(analysesCount, movesCount + 1),
    analysisTotal: movesCount + 1,
    analysisComplete: complete,
  };
}

/**
 * 复盘曲线卡派生。
 * @param {object} opts
 * @param {Array} [opts.mainPoints]   主谱曲线点（store.curve.points，黑方视角 %）
 * @param {Array} [opts.trialPts]     试下分支点（已换算为**绝对手数** enter+rel 的
 *                                    {moveNo,winrate,scoreLead}；空=不在试下/未产出）
 * @param {number} [opts.enterMoveNo] 试下进入手数
 * @param {boolean} [opts.inTrial]    是否试下分支模式
 * @param {number} [opts.current]     当前显示绝对手数
 * @param {boolean} [opts.disabled]   引擎不可用（仅空态文案差异；曲线仍显示）
 * @returns {{state:'ready'|'empty'|'loading', pts:Array, total:number, current:number,
 *            inTrial:boolean, tailClipped:boolean}}
 */
export function deriveReviewCurve(opts = {}) {
  const main = Array.isArray(opts.mainPoints) ? opts.mainPoints : [];
  const inTrial = Boolean(opts.inTrial);
  const enter = Number(opts.enterMoveNo) || 0;
  const current = Number(opts.current) || 0;
  const trialRaw = inTrial && Array.isArray(opts.trialPts) ? opts.trialPts : [];
  const abs = Number(opts.totalMoveNo) || 0;

  const norm = (p) => ({
    moveNo: Number(p.moveNo),
    winrate: p.winrate == null ? null : Number(p.winrate),
    scoreLead: p.scoreLead == null ? null : Number(p.scoreLead),
  });
  let pts = main.map(norm).sort((a, b) => a.moveNo - b.moveNo);
  let tailClipped = false;
  if (inTrial) {
    // 2026/09/12 人工确认：试下时**只画主谱前缀（0..进入手）+ 试下分支点**——
    // 进入手之后的主谱未来不上图，避免试下数据与原谱混成一条线“重叠”；
    // 撤销/回退时分支尾自然回退（无会话点时仅剩前缀）。
    const prefix = pts.filter((p) => p.moveNo <= enter);
    const trialAbs = trialRaw.map(norm).sort((a, b) => a.moveNo - b.moveNo);
    const byNo = new Map(prefix.map((p) => [p.moveNo, p]));
    for (const p of trialAbs) byNo.set(p.moveNo, p);
    pts = [...byNo.values()].sort((a, b) => a.moveNo - b.moveNo);
    tailClipped = trialAbs.length > 0;
  }

  const lastMain = main.length ? Math.max(...main.map((p) => Number(p.moveNo))) : 0;
  const total = Math.max(abs, lastMain, current);
  const state = pts.length ? 'ready' : 'empty';
  return { state, pts, total, current, inTrial, tailClipped };
}

/**
 * 曲线点击 → seek 目标（纯函数，2026/09/12；供控制器执行）。
 * - 主谱：`{mode:'main', moveNo}`；
 * - 试下分支点（> 进入手）：`{mode:'trial', rel: 绝对手数 − 进入手}`；
 * - 试下主谱前缀（≤ 进入手）：`{mode:'trial', rel: 0}`＝回实战（与滑轨 0 一致）。
 * @returns {{mode:'main', moveNo:number}|{mode:'trial', rel:number}|null}
 */
export function resolveCurveSeek(opts = {}) {
  if (opts.moveNo == null) return null;
  const abs = Number(opts.moveNo);
  if (!Number.isFinite(abs)) return null;
  if (!opts.inTrial) return { mode: 'main', moveNo: Math.max(0, Math.round(abs)) };
  const enter = Number(opts.enterMoveNo) || 0;
  if (abs <= enter) return { mode: 'trial', rel: 0 };
  return { mode: 'trial', rel: Math.max(0, Math.round(abs - enter)) };
}

/**
 * AI 推荐卡派生（主谱=读持久化/试下=实时会话）。
 * @param {object} opts
 * @param {object|null} opts.review   store.review（loading/key/moves/comment/root/hasData）
 * @param {string|null} opts.atKey    当前显示局面键（main:N / trial:T:R）
 * @param {number} opts.boardSize
 * @param {string} opts.engineState   引擎状态（试下实时语义 + 空态 offline 判定）
 * @param {boolean} [opts.inTrial]    是否试下分支（实时卡语义）
 * @returns {{state:'loading'|'empty'|'offline'|'ready'|'disabled', reason:string|null,
 *            stale:boolean, empty:boolean, offline:boolean, inTrial:boolean, side:'B'|'W'|null,
 *            entries:Array}}
 */
export function deriveRecommendCard(opts = {}) {
  const review = opts.review || {};
  const engineState = String(opts.engineState || '').toUpperCase();
  const engineDown = engineState === 'DEAD' || engineState === 'FATAL';
  const inTrial = Boolean(opts.inTrial);
  const atKey = opts.atKey == null ? null : String(opts.atKey);
  const key = review.key ? String(review.key) : null;
  const loading = Boolean(review.loading);
  const raw = Array.isArray(review.moves) ? review.moves : [];
  // 结果针对的局面 ≠ 当前显示局面 → 过期不展示
  const stale = !loading && raw.length > 0 && key !== atKey;

  let state;
  if (loading) state = 'loading';
  else if (stale) state = 'disabled';
  else if (!raw.length) state = engineDown ? 'offline' : 'empty';
  else state = 'ready';

  const entries = state === 'ready'
    ? raw.slice(0, 5).map((m, i) => ({
      rank: i + 1,
      x: m.x == null ? null : Number(m.x),
      y: m.y == null ? null : Number(m.y),
      coord: m.x == null || m.y == null ? 'PASS' : gtpOf(Number(m.x), Number(m.y), Number(opts.boardSize) || 19),
      winrate: num(m.winrate),
      scoreLead: num(m.score_lead),
      visits: m.visits == null ? null : Number(m.visits),
      pv: Array.isArray(m.pv) ? m.pv : [],
    }))
    : [];
  return {
    state,
    reason: engineDown && state !== 'ready' ? '引擎不可用' : null,
    loading,
    stale,
    empty: state === 'empty',
    offline: state === 'offline',
    inTrial,
    // 视角（当前执色方，服务端载荷原样透传）：渲染层据此加白方脚注（BUG-027）
    side: review.side === 'B' || review.side === 'W' ? review.side : null,
    entries,
  };
}

/**
 * AI 推荐卡文案（主谱读持久化 vs 试下实时；空态无 CTA，仅提示棋盘下 [补分析]）。
 * @param {object} d {state, inTrial, engineDown}
 * @returns {{title:string, loading:string, body:string, foot:string}}
 */
export function recommendCardCopy(d = {}) {
  const { state = '', inTrial = false, engineDown = false } = d;
  const title = inTrial ? 'AI 推荐（实时）' : 'AI 推荐（回放）';
  if (state === 'loading') {
    return {
      title,
      loading: inTrial ? '实时推荐计算中…' : '读取局面推荐中…',
      body: '',
      foot: inTrial ? '试下分支实时分析 · 自动触发' : '读持久化分析（复盘可用）',
    };
  }
  if (state === 'disabled') {
    return { title, loading: '', body: '局面已变化，旧推荐已失效', foot: '' };
  }
  if (state === 'offline') {
    return {
      title,
      loading: '',
      body: inTrial ? '引擎不可用 · 实时推荐暂停' : '引擎不可用 · 暂无推荐数据',
      foot: inTrial ? '引擎就绪后将自动生成' : '引擎就绪后可用棋盘下方 [补分析] 补齐',
    };
  }
  if (state === 'empty') {
    return {
      title,
      loading: '',
      body: inTrial ? '实时推荐尚未生成 · 稍候自动出现' : '该手暂无分析数据',
      foot: inTrial ? '试下分支实时分析 · 自动触发' : '点击棋盘下方 [补分析] 逐手补齐后自动显示',
    };
  }
  // ready
  const sideNote = d.side === 'W' ? '白方视角 · ' : '黑方视角 · ';
  return {
    title,
    loading: '',
    body: '',
    foot: `${sideNote}点击推荐行 → 变化图预览`,
  };
}

/** 当前手点评空态文案（点评可实时生成：引擎相关）。 */
export function commentEmptyCopy(d = {}) {
  const { loading = false, inTrial = false, engineDown = false } = d;
  if (loading) return '点评生成中…';
  if (engineDown) return '引擎不可用 · 点评暂停';
  if (inTrial) return '实时点评尚未生成';
  return '该手暂无点评数据';
}

/**
 * 保留式加载判定（复盘卡片防塌陷，2026/09/13）：步进等待新数据期间**不得**把已有
 * 内容换成矮占位再回弹（实测推荐卡 276→120→324px 抖动、点评卡 132→113→132px）。
 * 已有非占位内容 → 原地保留（调用方叠 `.is-busy` 忙碌态）；首次加载/占位态 → 照常替换。
 * @param {{waiting?:boolean, hasContent?:boolean, placeholder?:boolean}} d
 * @returns {'keep'|'replace'}
 */
export function retainCardAction(d = {}) {
  const { waiting = false, hasContent = false, placeholder = false } = d;
  return waiting && hasContent && !placeholder ? 'keep' : 'replace';
}

/**
 * 复盘曲线卡文案（试下分支 = 引擎会话实时曲线，与引擎状态相关）。
 * @param {object} d {ready, inTrial, engineDown, tailClipped}
 * @returns {{foot:string, empty:string}} empty 用于无数据态 note；foot 用于卡尾注
 */
export function reviewCurveCopy(d = {}) {
  const { ready = false, inTrial = false, engineDown = false, tailClipped = false } = d;
  if (!inTrial) {
    return {
      foot: ready ? '实线=胜率 · 虚线=目差 · 点击曲线定位 · 悬停明细' : '',
      empty: ready ? '' : '暂无曲线数据 · 可点棋盘下方 [补分析] 补齐',
    };
  }
  if (ready && tailClipped) {
    return { foot: '试下实时曲线（引擎会话分析 · 自动更新）', empty: '' };
  }
  if (ready) {
    return {
      foot: engineDown ? '引擎不可用 · 试下实时曲线暂停（主谱前缀）' : '试下实时曲线生成中…（引擎分析，自动更新）',
      empty: '',
    };
  }
  return {
    foot: '',
    empty: engineDown ? '引擎不可用 · 试下实时曲线暂停' : '试下实时曲线生成中…（引擎分析，自动更新）',
  };
}

/**
 * 当前手点评卡派生。
 *
 * 视角（2026/09/11 人工确认）：ΔW/ΔS 为**落子方视角**（好手正、恶手负），
 * 文案标注落子方（黑/白）；与“当前执色方视角”的推荐卡区分。
 * ΔS=`score_delta`（目数变化，恶手为负，与 ΔW 同向）。
 * @param {object} opts
 * @param {object|null} opts.comment  review.comment（{color,x,y,grade,delta_winrate,score_delta}）
 * @param {object|null} opts.moveDesc 当前手描述（moveNo/inTrial/enter/abs，由控制器给）
 * @returns {{has:boolean, grade:string|null, label:string, alt:string,
 *            deltaText:string, lossText:string, head:string, sub:string}}
 */
export function deriveCommentCard(opts = {}) {
  const c = opts.comment || {};
  const desc = opts.moveDesc || {};
  const grade = c.grade || null;
  const has = Boolean(c && c.grade);
  const side = c.color === 'W' ? '白' : c.color === 'B' ? '黑' : '';
  const head = has
    ? `${side ? `${side} · ` : ''}${desc.labelText || '当前手'} · ${gradeText(grade)}（${gradeAlt(grade)}）`
    : '当前手点评';
  const delta = c.delta_winrate == null ? null : round(Number(c.delta_winrate), 1);
  const loss = c.score_delta == null ? null : round(Number(c.score_delta), 1);
  const bits = [];
  if (delta !== null) bits.push(`ΔW ${signedPct(delta, 1)}`);
  if (loss !== null) bits.push(`ΔS ${scoreLead(loss)} 目`);
  return {
    has,
    grade,
    label: has ? gradeText(grade) : '',
    alt: has ? gradeAlt(grade) : '',
    deltaText: bits.join(' · '),
    lossText: '',
    head,
    sub: bits.join(' · '),
  };
}

/* ============================================================
 * 卡片 HTML（与 WEBUI review.html 基线同构；模块渲染 body）
 * ============================================================ */

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 复盘对局信息卡 body（根 .card 外框在模板中固定，动态刷新仅替换 body）。
 * @param {object} info  deriveReviewInfo 结果
 * @param {string|null} [hint] 追加一行提示（PASS/试下分支详情，来自控制器）
 */
export function reviewInfoBodyHTML(info, hint = null) {
  const black = info.players.black;
  const white = info.players.white;
  const rankSup = (r) => (r ? `<span class="rank-sup">${esc(r)}</span>` : '');
  const tag = (t) => (t ? `<span class="ai-tag">· ${esc(t)}</span>` : '');
  // 结果文案（2026/09/19 人工反馈）：已结束且无终局结果（导入棋谱）＝「未结算」；
  // 其余无结果（进行中等）＝「未结束」
  const result = info.result
    ? esc(String(info.result))
    : (info.status === 'finished' ? '未结算' : '未结束');
  const cov = `${info.analysisDone}/${info.analysisTotal}`;
  return `
      <h3><svg class="icon" aria-hidden="true"><use href="#i-info"/></svg>对局信息</h3>
      <div class="player-line">
        <span class="p-side l"><span class="stone-mini" aria-hidden="true"></span>黑 ${esc(black.name)}${rankSup(black.rank)}${tag(black.tag)}</span>
        <span class="vs-badge" aria-hidden="true"><svg><use href="#i-vs"/></svg></span>
        <span class="p-side r"><span class="stone-mini w" aria-hidden="true"></span>白 ${esc(white.name)}${rankSup(white.rank)}${tag(white.tag)}</span>
      </div>
      <div class="kv">
        <div class="item"><div class="label">结果</div><div class="value">${result}</div></div>
        <div class="item"><div class="label">分析覆盖</div><div class="value num">${cov}</div></div>
      </div>
      ${hint ? `<div class="info-hint" role="status">${esc(hint)}</div>` : ''}`;
}

/** 复盘对局信息卡（完整卡：初始模板用）。 */
export function reviewInfoCardHTML(info) {
  return `
    <div class="card" data-card="reviewInfo" data-ref="reviewInfo">${reviewInfoBodyHTML(info)}</div>`;
}

/**
 * 对局信息卡 hover 提示：终局结算（双 PASS 结算局）的确认黑/白目数。
 *
 * - 数据源：`scorings` 行（仅双 PASS 确认结算后有值，与结算面板 `game.finished`
 *   回显同源；认输/未结算 → null，卡上不挂提示）；
 * - 数值格式与结算面板一致（`fmtScore`：整数原样、一位小数去尾 0）。
 * @param {{blackScore?:number|null, whiteScore?:number|null}|null} scores
 * @returns {string|null} 提示文案；无结算数据 → null
 */
export function reviewSettleTip(scores) {
  const ok = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const bn = scores && scores.blackScore;
  const wn = scores && scores.whiteScore;
  if (!ok(bn) || !ok(wn)) return null;
  return `终局结算 · 黑目 ${fmtScore(bn)} · 白目 ${fmtScore(wn)}`;
}

/** 复盘曲线卡（svg/note/skeleton/尾注由模块驱动）。 */
export function reviewCurveCardHTML() {
  return `
    <div class="card" data-card="reviewCurve">
      <h3><svg class="icon" aria-hidden="true"><use href="#i-curve"/></svg>胜率 / 目差曲线（黑）</h3>
      <div class="chart">
        <svg data-ref="rvCurveSvg" viewBox="0 0 ${CURVE_W} ${CURVE_H}" preserveAspectRatio="none"
             role="img" aria-label="胜率/目差曲线"></svg>
        <div class="chart-note u-hide" data-ref="rvCurveNote"></div>
        <div class="chart-skeleton u-hide" data-ref="rvCurveSkeleton" aria-hidden="true"></div>
      </div>
      <div class="coach-foot" data-ref="rvCurveFoot">实线=胜率 · 虚线=目差 · 点击曲线定位 · 悬停明细</div>
    </div>`;
}

/** 复盘 AI 推荐卡（标题按主谱/试下由模块切换；body/foot 由模块切换）。 */
export function reviewRecommendCardHTML() {
  return `
    <div class="card" data-card="reviewRec">
      <div class="coach-title" data-ref="reviewRecTitle"><svg class="icon" aria-hidden="true"><use href="#i-coach"/></svg>AI 推荐（回放）</div>
      <div data-ref="rvRecBody"></div>
      <div class="coach-foot" data-ref="rvRecFoot"></div>
    </div>`;
}

/** 复盘当前手点评卡（body 由模块切换）。 */
export function reviewCommentCardHTML() {
  return `
    <div class="card" data-card="reviewComment">
      <h3><svg class="icon" aria-hidden="true"><use href="#i-comment"/></svg>当前手点评</h3>
      <div data-ref="rvCommentBody"></div>
    </div>`;
}

/** AI 推荐单行（同 coachRowHTML 列宽语义：序号/坐标/胜率/目差/Visit）。 */
export function recommendRowHTML(entry) {
  const wrVal = entry.winrate != null ? pct(entry.winrate, 1) : '—';
  const slVal = entry.scoreLead != null ? scoreLead(entry.scoreLead) : '—';
  const vt = entry.visits == null ? '' : visitsText(entry.visits);
  const aria = `第 ${entry.rank} 推荐：${entry.coord}，胜率${wrVal}，目差${slVal}${vt ? `，${vt}` : ''}`;
  return `
    <div class="coach-item" data-i="${entry.rank - 1}" role="button" tabindex="0" aria-label="${esc(aria)}">
      <span class="rank-badge rank-${entry.rank}">${entry.rank}</span>
      <span class="coach-coord">${esc(entry.coord)}</span>
      <span class="coach-wr"><span class="ck">胜率</span><span class="cv">${esc(wrVal)}</span></span>
      <span class="coach-sl"><span class="ck">目差</span><span class="cv">${esc(slVal)}</span></span>
      <span class="coach-visits">${esc(vt)}</span>
    </div>`;
}

function visitsText(v) {
  if (v == null) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const t = abs >= 1000 ? `${round(abs / 1000, 1)}k` : String(Math.round(abs));
  return `${t} Visit`;
}

/* ============================================================
 * 复盘侧栏模块（DOM 组件；由 review-view 挂载）
 * ============================================================ */

/**
 * @param {object} opts
 * @param {object} opts.store
 * @param {object} opts.hosts  {desktop, drawerRoot, drawerMask, gameDrawer, drawerGrip, drawerBody}
 * @param {Function} opts.getPos      控制器本地显示局面：() => { key, current, inTrial,
 *                                     totalMoveNo, enterMoveNo, trialPts:[], moveDesc }
 * @param {Function} [opts.onSeek]    (target) 曲线点击定位；target 由 ``resolveCurveSeek``
 *                                    派生（主谱 {mode:'main',moveNo} / 试下 {mode:'trial',rel}）
 * @param {Function} [opts.onPickVariation] (entry) 推荐行点击 → 变化图预览
 * @param {Function} [opts.toast]
 */
export function createReviewSidebarModule(opts) {
  const store = opts.store;
  const hosts = opts.hosts || {};
  const getPos = opts.getPos || (() => ({}));
  const getSettleScores = opts.getSettleScores || (() => null);
  const onSeek = opts.onSeek || (() => {});
  const onPickVariation = opts.onPickVariation || (() => {});
  const toast = opts.toast || (() => {});
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const mqDesktop = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`)
    : null;

  let wrapper = null;
  let destroyed = false;
  let unsub = null;
  let mqHandler = null;
  let selectedIdx = -1;
  let lastRecSig = '';
  let curveMorphCancel = null;
  let curveHoverUnbind = null;
  let curveShown = false; // 曲线可见态（空态→有数据 = 首次出现 → 淡入）

  function q(ref) {
    return wrapper ? wrapper.querySelector(`[data-ref="${ref}"]`) : null;
  }
  function setHtml(el, html) {
    if (el && el.innerHTML !== html) el.innerHTML = html;
  }
  function isDesktop() {
    if (mqDesktop) return mqDesktop.matches;
    return (typeof window !== 'undefined' && window.innerWidth) >= DESKTOP_MIN_WIDTH;
  }

  /* ---------------- 卡片渲染 ---------------- */

  function renderState() {
    if (!wrapper || destroyed) return;
    const s = store.getState();
    const pos = getPos() || {};
    const g = s.game;
    const engineState = s.engine && s.engine.state;

    const infoEl = q('reviewInfo');
    if (infoEl && g) {
      setHtml(infoEl, reviewInfoBodyHTML(deriveReviewInfo(g), pos.noteText || null));
      // hover 提示：双 PASS 结算目数（仅桌面；移动端无 hover 概念）
      const tip = isDesktop() ? reviewSettleTip(getSettleScores()) : null;
      if (tip) infoEl.setAttribute('data-tip', tip);
      else infoEl.removeAttribute('data-tip');
    }

    // —— 曲线卡 ——
    const curveEl = q('rvCurveSvg');
    const noteEl = q('rvCurveNote');
    const skelEl = q('rvCurveSkeleton');
    const footEl = q('rvCurveFoot');
    if (curveEl && noteEl && skelEl && footEl) {
      const curve = deriveReviewCurve({
        mainPoints: (s.curve && s.curve.points) || [],
        trialPts: pos.trialPts || [],
        enterMoveNo: pos.enterMoveNo,
        inTrial: Boolean(pos.inTrial),
        current: pos.current,
        totalMoveNo: pos.totalMoveNo,
      });
      const curveEngineState = String(engineState || '').toUpperCase();
      const curveEngineDown = curveEngineState === 'DEAD' || curveEngineState === 'FATAL';
      const data = { pts: curve.pts, current: curve.current, total: curve.total };
      const aria = curve.pts.length ? `胜率/目差曲线（第 ${curve.current} 手）` : '胜率/目差曲线';
      curveEl.setAttribute('aria-label', aria);
      const curveCopy = reviewCurveCopy({
        ready: curve.state === 'ready',
        inTrial: Boolean(curve.inTrial),
        engineDown: curveEngineDown,
        tailClipped: Boolean(curve.tailClipped),
      });
      if (curve.state === 'ready') {
        const entering = !curveShown; // 首次出现/空态→有数据：淡入 + 全量重绘
        curveShown = true;
        curveEl.classList.remove('u-hide');
        noteEl.classList.add('u-hide');
        skelEl.classList.add('u-hide');
        if (entering) {
          renderCurve(curveEl, data);
          playCurveEnter(curveEl);
        } else if (!curveEl.querySelector('.cr-w')) {
          renderCurve(curveEl, data);
        } else {
          applyCurve(curveEl, data);
        }
        setHtml(footEl, curveCopy.foot);
      } else {
        curveShown = false;
        curveEl.classList.add('u-hide');
        skelEl.classList.add('u-hide');
        noteEl.classList.remove('u-hide');
        noteEl.textContent = curveCopy.empty;
        setHtml(footEl, '');
      }
    }

    // —— AI 推荐卡 ——
    const recCard = q('reviewRec') ? wrapper.querySelector('[data-card="reviewRec"]') : null;
    const inTrial = Boolean(pos.inTrial);
    const rec = deriveRecommendCard({
      review: s.review,
      atKey: pos.key,
      boardSize: g && g.params ? g.params.boardSize : 19,
      engineState,
      inTrial,
    });
    const recTitleEl = q('reviewRecTitle');
    if (recTitleEl) recTitleEl.textContent = recommendCardCopy({ state: rec.state, inTrial }).title;
    const sig = `${rec.state}|${rec.reason}|${rec.entries.length}|${selectedIdx}|${s.review && s.review.hasData}|${s.review && s.review.loading}|${inTrial}|${rec.side}`;
    if (sig !== lastRecSig) {
      lastRecSig = sig;
      if (recCard) recCard.classList.toggle('is-disabled', rec.state === 'disabled');
      renderRecCard(rec);
    }

    // —— 当前手点评卡 ——
    renderCommentCard(s, pos);
  }

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

  function renderRecCard(rec) {
    const body = q('rvRecBody');
    const foot = q('rvRecFoot');
    if (!body || !foot) return;
    const engineDown = Boolean(rec.reason);
    const copy = recommendCardCopy({ state: rec.state, inTrial: rec.inTrial, engineDown, side: rec.side });
    // 保留式加载（防塌陷，2026/09/13）：loading / 结果过期等待期已有内容 → 原地保留 + 忙碌态
    if (rec.state === 'loading' || rec.state === 'disabled') {
      const action = retainCardAction({
        waiting: true,
        hasContent: Boolean(body.firstElementChild),
        placeholder: Boolean(body.querySelector('.coach-empty, .coach-pending')),
      });
      if (action === 'keep') {
        body.classList.add('is-busy');
        body.setAttribute('aria-busy', 'true');
        return;
      }
    }
    body.classList.remove('is-busy');
    body.removeAttribute('aria-busy');
    if (rec.state === 'loading') {
      setHtml(body, `
        <div class="coach-pending" role="status" aria-live="polite">
          <span class="coach-spin" aria-hidden="true"></span>${copy.loading}
        </div>`);
      setHtml(foot, copy.foot);
      return;
    }
    if (rec.state === 'disabled') {
      setHtml(body, `<div class="coach-empty muted">${copy.body}</div>`);
      setHtml(foot, '');
      return;
    }
    if (rec.state === 'empty' || rec.state === 'offline') {
      // 无 CTA 按钮：仅提示（主谱 → 棋盘下 [补分析]；试下 → 实时自动生成）
      setHtml(body, `<div class="coach-empty"><div class="muted">${copy.body}</div></div>`);
      setHtml(foot, copy.foot);
      return;
    }
    setHtml(body, `<div class="coach-list">${rec.entries.map((e) => recommendRowHTML(e)).join('')}</div>`);
    setHtml(foot, copy.foot);
    bindRecRows(body);
  }

  function bindRecRows(body) {
    body.querySelectorAll('.coach-item').forEach((row) => {
      const idx = Number(row.dataset.i) || 0;
      row.classList.toggle('sel', idx === selectedIdx);
      const onPick = () => {
        selectedIdx = selectedIdx === idx ? -1 : idx;
        body.querySelectorAll('.coach-item').forEach((r) => {
          r.classList.toggle('sel', Number(r.dataset.i) === selectedIdx);
        });
        if (selectedIdx >= 0) onPickVariation(selectedIdx);
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

  function renderCommentCard(s, pos) {
    const body = q('rvCommentBody');
    if (!body) return;
    const desc = pos.moveDesc || {};
    const engineState = String((s.engine && s.engine.state) || '').toUpperCase();
    const engineDown = engineState === 'DEAD' || engineState === 'FATAL';
    const inTrial = Boolean(pos.inTrial);
    const loading = Boolean(s.review && s.review.loading);
    const cc = deriveCommentCard({ comment: s.review && s.review.comment, moveDesc: desc });
    if (!cc.has) {
      // 保留式加载（防塌陷，2026/09/13）：等待期已有点评块 → 原地保留 + 忙碌态（不换「点评生成中…」矮占位）
      const action = retainCardAction({
        waiting: loading,
        hasContent: Boolean(body.firstElementChild),
        placeholder: Boolean(body.querySelector('.coach-empty, .coach-pending')),
      });
      if (action === 'keep') {
        body.classList.add('is-busy');
        body.setAttribute('aria-busy', 'true');
        return;
      }
      body.classList.remove('is-busy');
      body.removeAttribute('aria-busy');
      const emptyText = commentEmptyCopy({ loading, inTrial, engineDown });
      const spin = loading
        ? '<div class="coach-pending"><span class="coach-spin" aria-hidden="true"></span></div>'
        : '';
      setHtml(body, `<div>${spin}<div class="coach-empty muted">${emptyText}</div></div>`);
      return;
    }
    body.classList.remove('is-busy');
    body.removeAttribute('aria-busy');
    const dot = `<span style="width:12px;height:12px;border-radius:50%;background:var(--c-${cc.grade});flex:none" aria-hidden="true"></span>`;
    const sub = cc.sub
      ? `<div class="muted" style="font-size:12px">${cc.sub}</div>`
      : '';
    setHtml(body, `
      <div style="display:flex;align-items:center;gap:10px">
        ${dot}
        <div>
          <div style="font-size:13px;font-weight:600">${esc(cc.head)}</div>
          ${sub}
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-3);margin-top:8px">点击棋盘该手棋子显示点评气泡</div>`);
  }

  /* ---------------- 断点 relocator / 抽屉 dock（≤767，同对弈分析抽屉） ---------------- */

  let hostHidden = false;

  function place() {
    if (!wrapper) return;
    const desktop = isDesktop();
    const target = desktop ? hosts.desktop : hosts.drawerBody;
    if (target && wrapper.parentNode !== target) target.appendChild(wrapper);
    if (desktop) {
      setDockVisible(false);
      return;
    }
    if (!hostHidden) {
      setDockVisible(true);
      collapse();
    }
  }

  function setDockVisible(visible) {
    if (!hosts.drawerRoot) return;
    hosts.drawerRoot.classList.toggle('u-hide', !visible);
  }

  function hide() {
    hostHidden = true;
    setDockVisible(false);
  }

  function show() {
    hostHidden = false;
    if (isDesktop()) return;
    setDockVisible(true);
    collapse();
  }

  function syncDrawerAria(expanded) {
    const grip = hosts.drawerGrip;
    if (!grip) return;
    grip.setAttribute('aria-expanded', String(expanded));
    grip.setAttribute('aria-label', expanded ? '收起复盘分析（露出棋盘）' : '展开复盘分析');
    grip.title = expanded ? '轻点收起；按住下滑收起、上滑展开（不关闭）' : '轻点展开；按住上滑展开、下滑收起（不关闭）';
  }

  function expand(card) {
    if (isDesktop()) {
      if (card && wrapper) {
        const el = wrapper.querySelector(`[data-card="${card}"]`);
        // reduced-motion：平滑滚动降级为瞬时（WIG 减动效口径）
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
      }
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
  }

  function collapse() {
    if (isDesktop()) return;
    if (!hosts.drawerRoot) return;
    hosts.drawerRoot.classList.add('collapsed');
    syncDrawerAria(false);
  }

  function isDrawerOpen() {
    if (!hosts.drawerRoot) return false;
    return !hosts.drawerRoot.classList.contains('collapsed') && !hosts.drawerRoot.classList.contains('u-hide');
  }

  function toggle() {
    if (isDesktop()) return;
    if (isDrawerOpen()) collapse();
    else expand();
  }

  /* ---------------- 生命周期 ---------------- */

  function build() {
    if (!hosts.desktop || wrapper) return;
    wrapper = document.createElement('div');
    wrapper.className = 'sidebar-cards review-sidebar-cards';
    wrapper.innerHTML =
      reviewInfoCardHTML(deriveReviewInfo(null)) +
      reviewCurveCardHTML() +
      reviewRecommendCardHTML() +
      reviewCommentCardHTML();
    hosts.desktop.appendChild(wrapper);
    bindDrawer();
    bindCurveInteractions();
    place();
  }

  /** 曲线交互：hover 明细（气泡 + 最近点高亮）+ 点击定位（viewBox 反解，2026/09/12）。 */
  function bindCurveInteractions() {
    const svg = q('rvCurveSvg');
    if (!svg) return;
    curveHoverUnbind = attachCurveHover(svg);
    svg.addEventListener('click', (e) => {
      const hit = pointAtClientX(svg, e.clientX);
      if (!hit) return;
      const pos = getPos() || {};
      const target = resolveCurveSeek({
        moveNo: hit.moveNo,
        inTrial: Boolean(pos.inTrial),
        enterMoveNo: pos.enterMoveNo,
      });
      if (target) onSeek(target);
    });
  }

  function bindDrawer() {
    if (!hosts.drawerRoot) return;
    const root = hosts.drawerRoot;
    const mask = hosts.drawerMask;
    const panel = hosts.gameDrawer;
    const grip = hosts.drawerGrip;

    if (mask) mask.addEventListener('click', () => collapse());
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      if (isDesktop() || hostHidden || !isDrawerOpen()) return;
      if (document.querySelector('.dialog-mask')) return;
      collapse();
    };
    document.addEventListener('keydown', onEsc);

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
        if (collapsed) ty = Math.min(0, dy);
        else ty = Math.max(0, dy);
        panel.style.transform = ty ? `translateY(${ty}px)` : '';
      };
      const onUp = (e) => {
        if (!drag) return;
        const dy = e.clientY - drag.y;
        const moved = drag.moved;
        drag = null;
        if (panel) { panel.classList.remove('dragging'); panel.style.transform = ''; }
        try { grip.releasePointerCapture(e.pointerId); } catch { /* 无捕获 */ }
        if (!moved) return;
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
        if (!destroyed) {
          place();
          renderState(); // 断点切换后重渲染（信息卡 hover 提示方向/可用性随宿主同步）
        }
      };
      mqDesktop.addEventListener('change', mqHandler);
    }
    renderState();
  }

  function refresh() {
    renderState();
  }

  /** 断点变化后的整体重排（宿主调用：actions 等依赖视口的元素随后刷新）。 */
  function relayout() {
    place();
    renderState();
  }

  function destroy() {
    destroyed = true;
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
    if (curveMorphCancel) {
      curveMorphCancel();
      curveMorphCancel = null;
    }
    if (curveHoverUnbind) {
      curveHoverUnbind();
      curveHoverUnbind = null;
    }
    wrapper = null;
  }

  return {
    render,
    refresh,
    relayout,
    expand,
    collapse,
    toggle,
    hide,
    show,
    isDrawerOpen,
    destroy,
  };
}

export default createReviewSidebarModule;
