/**
 * tGo · 对局报告弹层（T6.9，ReportDialog / C13）
 *
 * 依据 WEBUI/js/report-dialog.js 静态基线（人工反馈：报告＝全站弹层，不单独路由）
 * 落地产品版。分层（同各视图约定）：
 *   - **纯函数层**（顶层无 DOM 副作用，可 node --test 无头导入，FE-RPT-*）：
 *     视角载荷（默认人类视角/白方参数归一）、AI 方识别、加载/不完整态派生、
 *     等级文案映射（五档中文 label ↔ 英文 key）、落子质量行、均损脚注口径
 *     （视角方手数 × 视角方均损）、吻合环、标尺游标、胜负手条目视图模型；
 *   - **createReportDialog(deps)**（DOM 呈现，人工验收轮覆盖）：
 *     挂载 #modal-root，按需拉取 `GET /games/{id}` + `GET /games/{id}/report?perspective=`
 *     （loading 骨架 → 内容卡 / ANALYSIS_INCOMPLETE 空态 [去全局分析] / 错误态）；
 *     视角 segctl 切换即时重取；关闭＝[✕]/Esc/遮罩；焦点管理。
 *
 * 视角约定（2026/09/09 人工确认）：
 *   - 入口默认视角＝人类视角（human_ai 取人类执色侧，human_human 黑方）；直达
 *     `#/report/:id?p=B|W` 带 p 参数以 URL 为准，缺省同默认规则；
 *   - 人机对弈 AI 方＝human_color 的另一侧；AI 侧棋力卡副标简化为「白方（AI）·（仅供学习）」
 *     （2026/09/15 人工口径：删除棋手名旁「AI（仅供学习）」徽章，副标去冗名）；
 *   - 平均目数损失只统计视角方落子：脚注「总手数 / 目数损失」= 视角方手数 × 视角方均损；
 *   - 胜负手 [回放该手] → `#/review/{id}?at=N`（复盘视图按 at 定位，2026/09/09 人工确认）。
 */

import { GRADE_TEXT, rankText, signedPct, fractionToPercent, scoreLeadUnit, resultText, visits } from '../core/fmt.js';
import { aiSideDisplay } from '../core/game-model.js';
import { fmtScore } from './scoring-panel.js';

/* ============================================================
 * 纯函数层（无 DOM；可无头测试）
 * ============================================================ */

/** 规则集显示文案（对局摘要段；与 game-model RULE_LABELS 同源，避免引入视图依赖）。 */
export const RULE_LABELS = Object.freeze({ chinese: '中国', japanese: '日本', aga: 'AGA' });

/** 落子质量五档展示序（最佳 → 最差；与 board GRADE_ORDER / css .q-* 一致）。 */
export const GRADE_ORDER = Object.freeze(['brilliant', 'good', 'slow', 'mistake', 'blunder']);

/** 点评中文 label（report.move_quality 键，config quality_bands label）→ 五档英文 key。 */
export const QLABEL_TO_KEY = Object.freeze({
  妙着: 'brilliant', 正着: 'good', 缓着: 'slow', 失误: 'mistake', 败着: 'blunder',
});

/** 职业/初学者标尺游标锚点（UI_UX §5.5.4 平均目数损失卡文案）。 */
export const LOSS_SCALE = Object.freeze({ pro: 0.15, beginner: 1.5 });

/** 数值 → 非负整数（容错）。 */
function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 视角参数归一：'W'→W，'B'→B，其它（缺省/未知）→ null（由调用方决定自动）。 */
export function parsePerspective(p) {
  if (p === 'W' || p === 'w') return 'W';
  if (p === 'B' || p === 'b') return 'B';
  return null;
}

/** 报告默认视角＝人类视角（2026/09/09 人工确认：human_ai 取人类执色侧，human_human 黑方）。 */
export function defaultPerspective(game) {
  if (game && game.mode === 'human_ai') {
    return game.human_color === 'W' ? 'W' : 'B';
  }
  return 'B';
}

/** AI 执色 side（人机）；人人/未知 → null。 */
export function aiSideOf(game) {
  if (!game || game.mode !== 'human_ai') return null;
  return game.human_color === 'W' ? 'B' : 'W';
}

/** 指定视角是否 AI 方（人机且视角＝AI 侧）。 */
export function isAiSide(game, perspective) {
  const ai = aiSideOf(game);
  return ai != null && perspective === ai;
}

/** 视角 → 名称文案：'B'→黑方 / 'W'→白方；未知→黑方。 */
export function playerSideText(p) {
  return p === 'W' ? '白方' : '黑方';
}

/** 视角 → 单字：'B'→黑 / 'W'→白；未知→黑。 */
export function playerColorText(p) {
  return p === 'W' ? '白' : '黑';
}

/**
 * 对局摘要分段（头部 info-meta：`19路 · 中国 · 贴 7.5 · 120 手`）。
 * @param {object} game REST GameInfo（snake_case）
 * @param {number} [totalMoves] 总手数（缺省取 game.last_move_no）
 * @returns {string[]}
 */
export function headSegments(game, totalMoves) {
  if (!game || typeof game !== 'object') return [];
  const g = game;
  const segs = [];
  if (g.board_size) segs.push(`${Number(g.board_size)}路`);
  if (g.rules) segs.push(RULE_LABELS[g.rules] || String(g.rules));
  if (g.komi != null && g.komi !== '') segs.push(`贴 ${Number(g.komi)}`);
  const n = Number(totalMoves != null ? totalMoves : g.last_move_no) || 0;
  segs.push(`${n} 手`);
  return segs;
}

/**
 * 终局信息气泡模型（对局报告标题右侧终点旗图标，点击展开；2026/09/13）。
 *
 * - 仅终局（`game.result` 非空）返回 `visible:true`（图标随显隐；未终局/未加载不显示）；
 * - 双 PASS 确认结算局（`black_score`/`white_score` 非空）：三行「终局结果/黑目/白目」；
 * - 认输等无结算目数：仅「终局结果」一行（与结算面板「认输局隐藏目数网格」口径一致）。
 * @param {object|null} game REST GameInfo（snake_case；详情含 black_score/white_score）
 * @returns {{visible:boolean, rows:Array<{label:string,value:string}>}}
 */
export function settlePopModel(game) {
  const g = game || {};
  const raw = g.result == null ? '' : String(g.result).trim();
  if (!raw) return { visible: false, rows: [] };
  const rows = [{ label: '终局结果', value: resultText(raw) }];
  const ok = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  if (ok(g.black_score) && ok(g.white_score)) {
    rows.push({ label: '黑目', value: fmtScore(g.black_score) });
    rows.push({ label: '白目', value: fmtScore(g.white_score) });
  }
  return { visible: true, rows };
}

/**
 * 弹层阶段派生（loading / ready / incomplete / notfound / error）。
 * @param {object} state { ready:boolean, report:object|null, error:object|null }
 * @returns {{kind:string, report?:object}}
 */
export function dialogPhase(state) {
  const s = state || {};
  if (s.error) {
    const err = s.error || {};
    const code = String(err.code || err.codeString || '');
    if (code === 'ANALYSIS_INCOMPLETE') return { kind: 'incomplete' };
    if (code === 'GAME_NOT_FOUND' || err.status === 404 || err.statusCode === 404) {
      return { kind: 'notfound' };
    }
    return { kind: 'error' };
  }
  if (!s.ready || !s.report) return { kind: 'loading' };
  return { kind: 'ready', report: s.report };
}

/**
 * 落子质量行（含数量/占比）。payload 键＝config 中文 label；仅映射五档，未知 label 忽略。
 * @param {object} moveQuality report.move_quality
 * @param {number} playerMoveCount 视角方手数（占比分母）
 * @returns {Array<{key:string,label:string,count:number,pct:number}>}
 */
export function qualityRows(moveQuality, playerMoveCount) {
  const mq = moveQuality || {};
  const total = Math.max(1, Number(playerMoveCount) || 0);
  return GRADE_ORDER.map((key) => {
    const label = GRADE_TEXT[key] || key;
    const count = toCount(mq[label] != null ? mq[label] : mq[key]);
    return { key, label, count, pct: Math.min(100, fractionToPercent(count / total)) };
  });
}

/** 平均目数损失脚注口径（2026/09/09 人工确认：视角方手数 × 视角方均损）。 */
export function meanLossView(report) {
  const rep = report || {};
  const mean = rep.mean_score_loss != null && Number.isFinite(Number(rep.mean_score_loss))
    ? Number(rep.mean_score_loss)
    : null;
  const count = rep.player_move_count != null && Number.isFinite(Number(rep.player_move_count))
    ? Math.max(0, Math.floor(Number(rep.player_move_count)))
    : 0;
  const total = mean != null && count > 0 ? mean * count : null;
  return { mean, count, total };
}

/** 定点文本（最多 d 位小数、去尾零）；null/非法 → '—'。 */
export function fmtNum(v, d = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const s = Number(v).toFixed(Math.max(0, Math.trunc(Number(d)) || 0));
  return s.replace(/\.?0+$/, '');
}

/** 吻合环（matchRate 0..1 → 环文本/描边长度；r=56 与 css .ring-val 一致）。 */
export function ringView(matchRate, r = 56) {
  const pct = fractionToPercent(clamp01(matchRate));
  const c = 2 * Math.PI * r;
  return { pct, pctText: `${Math.round(pct)}%`, dash: (pct / 100) * c };
}

/** 平均目数损失标尺游标 left%（职业 0.15 ↔ 初学者 1.5 线性钳制）；null → null。 */
export function meanMarkerPct(mean) {
  if (mean == null || !Number.isFinite(Number(mean))) return null;
  const span = LOSS_SCALE.beginner - LOSS_SCALE.pro;
  return fractionToPercent(clamp01((Number(mean) - LOSS_SCALE.pro) / span));
}

/**
 * 胜负手条目视图模型（等级文案映射）。
 *
 * 换算口径（2026/09/11）：`turning_points[].delta_winrate` 由后端**已换算为百分比**
 * （round 2，与 `analysis.comment`/点评卡一致）——前端**只展示、不再 ×100**
 * （胜率换算唯一位置＝后端输出边界 `api/public.py`）；`score_delta` 为 ΔS=目数变化
 * （恶手为负，与 ΔW 同向；2026/09/12 起随 ΔW 一并展示，败着/失误的 ΔS 数值带依据可见）。
 * @param {object} report 报告载荷
 * @param {'B'|'W'} perspective 当前视角（TP 均为视角方落子）
 * @param {boolean} [ai] 视角方是否为 AI（决定 `白（AI）` 标注）
 * @returns {Array<{moveNo:number,sideText:string,gradeKey:string|null,gradeLabel:string,deltaText:string,scoreText:string}>}
 */
export function tpViewModel(report, perspective, ai = false) {
  const list = Array.isArray(report && report.turning_points) ? report.turning_points : [];
  const side = playerColorText(perspective);
  const out = [];
  for (const tp of list) {
    if (!tp || tp.move_no == null) continue;
    const gradeKey = GRADE_ORDER.includes(tp.grade) ? tp.grade : null;
    const label = gradeKey ? GRADE_TEXT[gradeKey] || gradeKey : '';
    const d = tp.delta_winrate != null ? Number(tp.delta_winrate) : null;
    const deltaText = d != null && Number.isFinite(d) ? signedPct(d, 1) : '';
    const s = tp.score_delta != null ? Number(tp.score_delta) : null;
    const scoreText = s != null && Number.isFinite(s) ? scoreLeadUnit(s) : '';
    out.push({
      moveNo: Math.trunc(Number(tp.move_no)),
      sideText: ai ? `${side}（AI）` : side,
      gradeKey,
      gradeLabel: label,
      deltaText,
      scoreText,
    });
  }
  return out;
}

/** 五行 HTML 转义（DOM 组装用）。 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 动作宿主解析（报告弹层事件委托）：点击目标常是按钮内嵌的 SVG 图标
 * （`<svg>`/`<use>`，如 ✕/终点旗——图标占据按钮中央大部分可点区域），
 * 必须向上解析最近的 `[data-act]`/`[data-close]` 宿主；直接读目标自身
 * 属性会让整片图标区域点击失效（BUG-050 根因：点图标无反应，仅按钮边缘可点）。
 * @param {EventTarget|null} target
 * @returns {Element|null}
 */
export function resolveActTarget(target) {
  return target && target.closest ? target.closest('[data-act], [data-close]') : null;
}

/* ============================================================
 * DOM 层（createReportDialog；人工验收轮覆盖）
 * ============================================================ */

function ensureModalRoot(doc) {
  let root = doc.getElementById('modal-root');
  if (!root) {
    root = doc.createElement('div');
    root.id = 'modal-root';
    doc.body.appendChild(root);
  }
  return root;
}

const CARD_ICONS = {
  rating: 'i-model',
  match: 'i-coach',
  loss: 'i-curve',
  quality: 'i-comment',
  turning: 'i-warn',
};

function cardHTML(icon, title, body, { full = false, center = false } = {}) {
  const cls = ['card', full ? 'full' : '', center ? 'report-center' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}"><h3><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg>${esc(title)}</h3>${body}</div>`;
}

/**
 * 创建对局报告弹层单例。
 * @param {object} deps
 * @param {object} deps.api        REST 客户端（get）
 * @param {Function} deps.nav      (hash)=>void（[回放该手]/[去全局分析] 跳转）
 * @param {Document} [deps.doc]
 * @returns {{open:Function, close:Function, isOpen:Function, destroy:Function}}
 */
export function createReportDialog(deps = {}) {
  const api = deps.api;
  const nav = deps.nav || ((h) => { location.hash = h; });
  const doc = deps.doc || (typeof document !== 'undefined' ? document : null);

  const self = {
    gameId: null,
    game: null,          // REST GameInfo（snake_case）
    perspective: null,   // 'B' | 'W'
    report: null,
    chainVisits: null,   // 本局链精度（报告载荷；同局视角切换时保留，防头部徽章闪烁）
    phase: 'idle',       // idle | loading | ready
    error: null,
    reqSeq: 0,
    destroyed: false,
  };

  let mask = null;
  let prevFocus = null;
  let opened = false;

  if (!doc) {
    // 无 DOM 环境（node）：工厂仅提供空操作，纯函数层在上方可直接无头测试。
    return {
      open() {}, close() {}, isOpen: () => false, destroy() {},
    };
  }

  function buildMask() {
    mask = doc.createElement('div');
    mask.className = 'dialog-mask report-modal';
    mask.setAttribute('aria-hidden', 'true');
    mask.innerHTML = '<div class="dialog report-dialog" role="dialog" aria-modal="true" aria-label="对局报告" tabindex="-1"></div>';
    ensureModalRoot(doc).appendChild(mask);

    // 事件委托（遮罩/关闭/视角/动作；内层内容重建不重绑）
    mask.addEventListener('click', (e) => {
      const target = e.target;
      if (!target || !target.closest) return;
      if (target === mask) { close(); return; } // 点遮罩空白关闭
      // 终局信息气泡：点击图标/气泡区域以外先收起（不阻断后续动作）
      const inSettle = Boolean(target.closest('.ttl-group'));
      if (isSettleOpen() && !inSettle) setSettleOpen(false);
      // 动作宿主：点击目标常为按钮内 SVG 图标（<svg>/<use>），须向上解析宿主（BUG-050）
      const actEl = resolveActTarget(target);
      if (!actEl) return;
      const act = actEl.getAttribute('data-act') || (actEl.hasAttribute('data-close') ? 'close' : '');
      if (!act) return;
      if (act === 'settle') { toggleSettleOpen(); return; }
      if (act === 'close') { close(); return; }
      if (act === 'persp') {
        const p = parsePerspective(actEl.getAttribute('data-p'));
        if (p && p !== self.perspective) switchPerspective(p);
        return;
      }
      if (act === 'replay') {
        const mn = actEl.getAttribute('data-move');
        const n = Number(mn);
        close();
        if (Number.isInteger(n) && n >= 0 && self.gameId) {
          nav(`#/review/${self.gameId}?at=${n}`);
        }
        return;
      }
      if (act === 'go-analysis') {
        const gid = self.gameId;
        close();
        if (gid) nav(`#/review/${gid}`);
        return;
      }
      if (act === 'retry') { reload(); return; }
    });
  }

  function setOpen(flag) {
    opened = flag;
    if (!mask) return;
    mask.classList.toggle('open', flag);
    mask.setAttribute('aria-hidden', flag ? 'false' : 'true');
  }

  /* ---------------- 终局信息气泡（标题右侧图标，点击切换） ---------------- */

  function setSettleOpen(flag) {
    if (!mask) return;
    const btn = mask.querySelector('[data-act="settle"]');
    const pop = mask.querySelector('.settle-pop');
    if (!btn || !pop) return;
    pop.hidden = !flag;
    btn.setAttribute('aria-expanded', flag ? 'true' : 'false');
  }

  function isSettleOpen() {
    const pop = mask && mask.querySelector('.settle-pop');
    return Boolean(pop && !pop.hidden);
  }

  function toggleSettleOpen() {
    setSettleOpen(!isSettleOpen());
  }

  /** Esc 关闭（capture 捕获阶段，避免被下层视图同键抢走）。
   *  气泡打开时 Esc 优先收气泡（不关闭弹层）。 */
  function onKeydown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.stopPropagation();
      if (isSettleOpen()) {
        setSettleOpen(false);
        return;
      }
      close();
    }
  }

  function onHashChange() {
    // 外部导航（返回键等）→ 关闭弹层，避免悬浮到其它页面之上
    close();
  }

  /* ---------------- 数据 ---------------- */

  /** 按需重载（首次打开 / [重试]）：详情缺失先取详情，再取报告。 */
  async function reload() {
    if (!self.gameId) return;
    const seq = ++self.reqSeq;
    self.phase = 'loading';
    self.error = null;
    paint();
    try {
      const gid = self.gameId;
      let game = self.game && self.game.id === gid ? self.game : null;
      if (!game) {
        const d = await api.get(`/games/${gid}`);
        if (self.destroyed || seq !== self.reqSeq || gid !== self.gameId) return;
        game = d && d.data;
        if (!game || Number(game.id) !== gid) {
          self.phase = 'idle';
          self.error = { code: 'GAME_NOT_FOUND', status: 404 };
          paint();
          return;
        }
      }
      self.game = game;
      if (!self.perspective) self.perspective = defaultPerspective(game);
      await fetchReport(seq);
    } catch (err) {
      if (self.destroyed || seq !== self.reqSeq) return;
      self.phase = 'idle';
      self.error = normalizeError(err);
      paint();
    }
  }

  /** 按当前视角取报告（loading 骨架 → ready / 错误 / 不完整）。 */
  async function fetchReport(seq) {
    const gid = self.gameId;
    const p = self.perspective;
    self.phase = 'loading';
    self.error = null;
    paint();
    try {
      const res = await api.get(`/games/${gid}/report?perspective=${p}`);
      if (self.destroyed || seq !== self.reqSeq || gid !== self.gameId || p !== self.perspective) return;
      const rep = res && res.data;
      if (!rep) throw { code: 'INTERNAL_ERROR' };
      self.report = rep;
      // 链精度（2026/09/15）：随报告一次下发，头部徽章展示；无效值不展示
      const cv = Number(rep.chain_visits);
      self.chainVisits = Number.isFinite(cv) && cv > 0 ? cv : null;
      self.phase = 'ready';
      paint();
    } catch (err) {
      if (self.destroyed || seq !== self.reqSeq || gid !== self.gameId || p !== self.perspective) return;
      self.phase = 'idle';
      self.error = normalizeError(err);
      paint();
    }
  }

  /** 视角切换（segctl）：直接重取报告。 */
  function switchPerspective(p) {
    if (!p || p === self.perspective) return;
    self.perspective = p;
    self.report = null;
    self.error = null;
    const seq = ++self.reqSeq;
    fetchReport(seq);
  }

  function normalizeError(err) {
    if (!err) return { code: 'INTERNAL_ERROR' };
    if (err.response && err.response.data) {
      const d = err.response.data;
      return { code: d.code || '', message: d.message || '', status: err.response.status };
    }
    const code = err.code || err.errorCode || '';
    if (code) return { code: String(code), message: err.message || '', status: err.status };
    return { code: 'NETWORK_ERROR', message: String((err && err.message) || '') };
  }

  /* ---------------- 呈现 ---------------- */

  function headHTML() {
    const g = self.game;
    const p = self.perspective;

    const sideTag = (side) => {
      if (!g) return '';
      const key = side === 'B' ? 'black' : 'white';
      // 人机 AI 侧：名称 `AI` + 难度段位短标 + 风格标签（人工口径 2026/09/10）
      const ai = aiSideDisplay(g, key);
      const rawName = side === 'B' ? g.black_name : g.white_name;
      const rawRank = side === 'B' ? g.black_rank : g.white_rank;
      const nm = ai
        ? ai.name
        : (rawName != null && String(rawName).trim()) || '真人';
      const t = ai ? ai.rank : (rawRank ? rankText(rawRank) : '');
      const sup = t ? `<span class="rank-sup">${esc(t)}</span>` : '';
      const tag = ai ? `<span class="ai-tag">· ${esc(ai.tag)}</span>` : '';
      // 执色＝黑/白 文字（2026/09/15 人工反馈：不用真实棋子；与列表/信息卡「黑 王先生」同构）
      return `${side === 'B' ? '黑' : '白'} ${esc(nm)}${sup}${tag}`;
    };

    const segs = headSegments(g).map((s) => `<span>${esc(s)}</span>`);
    const segHTML = segs.length
      ? `<span class="sep">·</span>${segs.join('<span class="sep">·</span>')}`
      : '';

    const segCls = (side) => (p === side ? 'on' : '');
    const disabled = !g ? ' disabled' : '';

    // 终局信息：标题右侧终点旗图标 + 点击气泡（仅终局显示；双 PASS 含黑/白目）。
    // 气泡锚定旗帜自身（.settle-anchor）——不可锚 ttl-group 右缘（加链精度徽章后锚点右移错位）
    const settle = settlePopModel(g);
    const settleHTML = settle.visible
      ? '<span class="settle-anchor">'
        + `<button type="button" class="icon-btn settle-btn" data-act="settle" aria-expanded="false" aria-label="终局信息">`
        + '<svg class="icon" aria-hidden="true"><use href="#i-finish"/></svg></button>'
        + `<div class="settle-pop" role="tooltip" hidden>${settle.rows
          .map((r) => `<div class="sp-row"><span class="sp-label">${esc(r.label)}</span><span class="sp-value num">${esc(r.value)}</span></div>`)
          .join('')}</div>`
        + '</span>'
      : '';

    // 链精度徽章（2026/09/15 人工反馈：旗帜 SVG 之后，主题色徽章）
    const chainHTML = self.chainVisits != null
      ? `<span class="badge accent num" title="本局分析链精度（创建时冻结的 maxVisits）">${esc(visits(self.chainVisits))}</span>`
      : '';

    return `
      <div class="report-head">
        <span class="ttl-group">
          <span class="ttl">对局报告</span>
          ${settleHTML}
          ${chainHTML}
        </span>
        <div class="info-meta num">
          <span class="report-players">${sideTag('B')}<span class="vs-badge inline" aria-hidden="true"><svg><use href="#i-vs"/></svg></span>${sideTag('W')}</span>${segHTML}
        </div>
        <div class="report-head-ops">
          <span class="muted report-ops-label">视角</span>
          <div class="segctl" role="group" aria-label="报告视角">
            <button type="button" class="${segCls('B')}" data-act="persp" data-p="B" aria-pressed="${p === 'B'}"${disabled}>黑方</button>
            <button type="button" class="${segCls('W')}" data-act="persp" data-p="W" aria-pressed="${p === 'W'}"${disabled}>白方</button>
          </div>
        </div>
        <button type="button" class="icon-btn report-close" data-act="close" aria-label="关闭对局报告" title="关闭（Esc）"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
      </div>`;
  }

  function skeletonHTML() {
    return `
      <div class="report-grid report-skeleton" aria-hidden="true">
        <div class="card"><div class="skeleton"></div><div class="skeleton" style="height:20px;margin-top:10px"></div></div>
        <div class="card"><div class="skeleton"></div></div>
        <div class="card"><div class="skeleton"></div></div>
        <div class="card"><div class="skeleton"></div></div>
        <div class="card full"><div class="skeleton"></div></div>
      </div>`;
  }

  function emptyHTML(kind) {
    const gid = self.gameId;
    if (kind === 'incomplete') {
      return `
        <div class="report-empty">
          <svg class="icon" aria-hidden="true"><use href="#i-warn"/></svg>
          <div class="report-empty-title">分析数据不完整</div>
          <div class="report-empty-msg">本局尚缺部分局面分析，无法生成报告。<br>可先在复盘页执行「全局分析」补全后重试。</div>
          <div class="dialog-actions report-empty-actions">
            ${gid ? '<button type="button" class="btn btn-primary" data-act="go-analysis">去全局分析</button>' : ''}
          </div>
        </div>`;
    }
    if (kind === 'notfound') {
      return `
        <div class="report-empty">
          <svg class="icon" aria-hidden="true"><use href="#i-warn"/></svg>
          <div class="report-empty-title">对局不存在</div>
          <div class="report-empty-msg">该对局已被删除或不存在，无法生成报告。</div>
          <div class="dialog-actions report-empty-actions">
            <button type="button" class="btn btn-secondary" data-act="close">关闭</button>
          </div>
        </div>`;
    }
    return `
      <div class="report-empty">
        <svg class="icon" aria-hidden="true"><use href="#i-warn"/></svg>
        <div class="report-empty-title">加载失败</div>
        <div class="report-empty-msg">报告数据拉取失败，请重试或稍后再试。</div>
        <div class="dialog-actions report-empty-actions">
          <button type="button" class="btn btn-secondary" data-act="retry">重试</button>
          <button type="button" class="btn btn-secondary" data-act="close">关闭</button>
        </div>
      </div>`;
  }

  /** 棋力评估毛笔墨刷徽章（SVG 与静态基线同构；gradient id 实例唯一防冲突）。 */
  function ratingBadgeHTML(rep, p, ai) {
    const brushId = `tgoBrushGrad_${self.gameId || 0}`;
    const nameRaw = rep.player_name != null && String(rep.player_name).trim()
      ? String(rep.player_name)
      : '';
    // AI 侧不显示服务端 name 快照（旧数据为「真人」）；无快照时回退 真人/AI
    const subName = ai ? 'AI' : esc(nameRaw || '真人');
    // AI 侧副标（2026/09/15 人工口径）：`白方（AI）·（仅供学习）`——去冗名与徽章元素；
    // 人类侧维持 `黑方 · 姓名`
    const sub = ai
      ? `${playerSideText(p)}（AI）·（仅供学习）`
      : `${playerSideText(p)} · ${subName}`;
    const rating = (rep.rating && rep.rating.label) || '—';
    const desc = (rep.rating && rep.rating.description) || '';
    const mean = fmtNum(rep.mean_score_loss, 2);
    const topN = Number(rep.top_n) || 3;
    const pct = Math.round(fractionToPercent(clamp01(rep.match_rate)));
    const basis = `均损 <b>${esc(mean)} 目</b> · Top${topN} 吻合 <b>${pct}%</b>`;
    return `
      <div class="level-badge" role="img" aria-label="棋力评估 ${esc(rating)}">
        <svg class="brush" viewBox="0 0 320 120" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="${brushId}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="var(--brush-a)"/><stop offset="55%" stop-color="var(--brush-b)"/><stop offset="100%" stop-color="var(--brush-c)"/>
          </linearGradient></defs>
          <path d="M22 62 C26 40 52 26 88 22 C132 16 192 14 240 20 C274 24 300 33 309 45 C314 52 311 61 300 66 C272 78 216 84 160 84 C104 84 52 80 30 74 C23 72 19 68 22 62 Z" fill="url(#${brushId})"/>
          <path d="M40 46 C64 34 104 28 160 28 C210 28 258 36 288 48" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="3" stroke-linecap="round"/>
        </svg>
        <span class="lv">${esc(rating)}</span>
        <span class="sub">${sub}</span>
      </div>
      <div class="muted report-basis" style="font-size:12px;line-height:1.7">
        ${desc ? `特征：${esc(desc)}<br>` : ''}依据：${basis}
      </div>`;
  }

  function cardsHTML(rep, game, p) {
    const ai = isAiSide(game, p);
    const sideName = playerSideText(p);

    // 1. 棋力评估
    const ratingCard = cardHTML(CARD_ICONS.rating, '棋力评估', ratingBadgeHTML(rep, p, ai), { center: true });

    // 2. AI 吻合度（SVG 环形）
    const ring = ringView(rep.match_rate);
    const topN = Number(rep.top_n) || 3;
    const matchCard = cardHTML(CARD_ICONS.match, 'AI 吻合度', `
      <div class="ring">
        <svg viewBox="0 0 120 120" role="img" aria-label="AI 吻合度 ${ring.pctText}">
          <circle class="ring-track" cx="60" cy="60" r="56"/>
          <circle class="ring-val" cx="60" cy="60" r="56" style="stroke-dasharray:${fmtNum(ring.dash, 1)} 352"/>
        </svg>
      </div>
      <div class="ring-num num">${ring.pctText}</div>
      <div class="muted" style="font-size:12px">Top-${topN} Match Rate（${sideName}）${ai ? ' · AI（仅供学习）' : ''}</div>
    `, { center: true });

    // 3. 平均目数损失（等高卡；脚注＝视角方手数 × 视角方均损）
    const loss = meanLossView(rep);
    const marker = meanMarkerPct(loss.mean);
    const meanText = fmtNum(loss.mean, 2);
    const scaleBar = marker == null
      ? '<div class="scale-line"><div class="lbl"><span>职业 ≤0.15</span><span>初学者 &gt;1.50</span></div><div class="bar"></div></div>'
      : `<div class="scale-line"><div class="lbl"><span>职业 ≤0.15</span><span>初学者 &gt;1.50</span></div><div class="bar"><i style="left:${fmtNum(marker, 1)}%"></i></div></div>`;
    const lossCard = cardHTML(CARD_ICONS.loss, '平均目数损失', `
      <div style="display:flex;align-items:baseline;gap:10px">
        <span class="num" style="font-size:32px;font-weight:700">${meanText}</span>
        <span class="muted">目 / 手（${sideName}${ai ? '，AI' : ''}）</span>
      </div>
      ${scaleBar}
      <div class="avg-loss-foot">
        <div class="item num"><span class="label">总手数</span><span class="val">${loss.count}</span></div>
        <div class="item num"><span class="label">目数损失</span><span class="val">${fmtNum(loss.total, 1)} 目</span></div>
      </div>
    `);

    // 4. 落子质量分布
    const rows = qualityRows(rep.move_quality, rep.player_move_count);
    const qRows = rows.map((r) => `
      <div class="qrow"><span class="qname">${r.label} <b class="num">${r.count}</b></span>
        <div class="qbar"><i class="q-${r.key}" style="width:${Math.round(r.pct)}%"></i></div>
        <span class="qnum num">${Math.round(r.pct)}%</span></div>`).join('');
    const qLegend = GRADE_ORDER.map((k) => `<span><i class="q-${k}"></i>${GRADE_TEXT[k] || k}</span>`).join('');
    const qualityCard = cardHTML(CARD_ICONS.quality, '落子质量', `
      <div class="quality-bar">${qRows}</div>
      <div class="legend">${qLegend}</div>
    `);

    // 5. 胜负手
    const tps = tpViewModel(rep, p, ai);
    let tpBody;
    if (!tps.length) {
      tpBody = `<div class="muted" style="font-size:13px;line-height:1.8">${sideName}本局无显著胜负手。</div>`;
    } else {
      tpBody = `<div class="turn-points">${tps.map((tp) => {
        const tagColor = tp.gradeKey ? `var(--c-${tp.gradeKey})` : 'var(--border)';
        // 定宽列（手数/行棋方/ΔW/ΔS/点评语）：空值保留占位单元格，保证上下条目按标签对齐
        return `
          <div class="tp-item">
            <span class="tp-tag" style="background:${tagColor}" aria-hidden="true"></span>
            <div class="tp-main">
              <span class="tp-c tp-move num">第 ${tp.moveNo} 手</span>
              <span class="tp-c tp-side">${tp.sideText}</span>
              <span class="tp-c tp-dw muted">${tp.deltaText ? `<span class="k">ΔW</span><span class="v num">${tp.deltaText}</span>` : ''}</span>
              <span class="tp-c tp-ds muted">${tp.scoreText ? `<span class="k">ΔS</span><span class="v num">${tp.scoreText}</span>` : ''}</span>
              <span class="tp-c tp-grade muted">${tp.gradeLabel}</span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-act="replay" data-move="${tp.moveNo}">回放该手</button>
          </div>`;
      }).join('')}</div>`;
    }
    const turningCard = cardHTML(CARD_ICONS.turning, '胜负手', tpBody, { full: true });

    return `<div class="report-grid">${ratingCard}${matchCard}${lossCard}${qualityCard}${turningCard}</div>`;
  }

  function paint() {
    if (!mask || self.destroyed) return;
    const dlg = mask.querySelector('.report-dialog');
    if (!dlg) return;
    const phase = dialogPhase({
      ready: self.phase === 'ready' && !!self.report,
      report: self.report,
      error: self.error,
    });
    // 保留式加载（视角切换/重取）：既有卡片网格原地保留 + 忙碌遮罩——若用骨架整体替换，
    // 网格高度会塌缩再回弹（实测 864→491→864px），即人工反馈的“视图坍塌闪烁”
    // （BUG-051，处置同 BUG-006：已有内容 loading 期不换矮占位）。仅首次加载用骨架。
    if (phase.kind === 'loading' && dlg.querySelector('.report-grid:not(.report-skeleton)')) {
      const head = dlg.querySelector('.report-head');
      if (head) head.outerHTML = headHTML(); // 仅头部刷新（视角段控件即时反馈）
      dlg.classList.add('report-soft-loading');
      dlg.setAttribute('aria-busy', 'true');
      return;
    }
    dlg.classList.remove('report-soft-loading');
    dlg.removeAttribute('aria-busy');
    let body;
    if (phase.kind === 'ready') {
      body = cardsHTML(phase.report, self.game, self.perspective);
    } else if (phase.kind === 'loading') {
      body = skeletonHTML();
    } else {
      body = emptyHTML(phase.kind);
    }
    dlg.innerHTML = `${headHTML()}${body}`;
  }

  /* ---------------- 生命周期 ---------------- */

  function open(gameId, opts = {}) {
    if (self.destroyed || !doc) return;
    const id = Number(gameId);
    if (!Number.isInteger(id) || id <= 0) return;
    if (!mask) buildMask();

    const sameGame = self.gameId === id;
    self.gameId = id;
    self.game = sameGame ? self.game : null; // 换局则重取详情
    self.chainVisits = sameGame ? self.chainVisits : null; // 链精度随局重置（防串局）
    self.perspective = parsePerspective(opts.perspective) || null; // null=载入后取默认视角
    self.report = null;
    self.error = null;
    self.phase = 'loading';

    prevFocus = doc.activeElement;
    setOpen(true);
    paint();

    // 焦点进入弹层（可 Tab/滚动）；ESC 关闭；外部 hash 导航自动关闭
    const dlg = mask.querySelector('.report-dialog');
    if (dlg && dlg.focus) dlg.focus();
    doc.addEventListener('keydown', onKeydown, true);
    window.addEventListener('hashchange', onHashChange);

    reload();
  }

  function close() {
    if (self.destroyed || !opened) return;
    opened = false;
    setSettleOpen(false); // 终局信息气泡随关闭复位
    setOpen(false);
    doc.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('hashchange', onHashChange);
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch { /* 焦点源已销毁 */ }
    }
    prevFocus = null;
  }

  function destroy() {
    self.destroyed = true;
    if (mask && mask.parentNode) {
      doc.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('hashchange', onHashChange);
      mask.parentNode.removeChild(mask);
    }
    mask = null;
    opened = false;
  }

  return {
    open,
    close,
    isOpen: () => opened,
    destroy,
  };
}

export default createReportDialog;
