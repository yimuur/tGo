/**
 * tGo · 胜率/目差双轴曲线（T5.6，C6 提炼自 js/curve-demo.js）
 *
 * 依据 UI_UX §5.2.6 / §6.3：
 *   - 左轴＝胜率 0–100%（0 底 / 50 中线 / 100 顶），accent 主轴 + accent-soft 面积；
 *   - 右轴＝目差轴：0 为中线「起点」，按实际数据动态缩放（×1.15 余量，向上取 0.5
 *     整数倍量程，峰值贴近量程 ≈86%）；
 *   - 目差灰蓝虚线（固定色 #7A8B99，设计定、**不随主题**），围绕 0 中线；
 *   - **颜色语义（2026/09/05 人工确认）**：胜率曲线 `--accent` / 面积 `--accent-soft`
 *     / 中线与文本等均为 CSS var（**随主题色变化**）；仅目差虚线用固定色；
 *   - 当前手竖线 + 圆点；底部手数刻度；
 *   - 更新动效 240ms path morph（DOM 层提供 rAF 插值，仅改 path `d` 属性，不重建 DOM）：
 *     **新增末段从上一数据点前值外推平滑“生长”**（分析数据延迟到达不弹出）、数值修订
 *     平滑过渡、被删点保持至结束帧后由精确目标剔除；x 域量程 total 同步插值；
 *   - hover 明细（气泡 `第 N 手 · 胜率 54.2% · 目差 +3.1` + 最近数据点高亮，2026/09/12）；
 *     点击/ hover 的 x→手数反解必须走 **viewBox + 绘图区 padding** 映射
 *     （`pointAtClientX`；严禁按元素整宽比例近似——曾致点击定位错位）。
 *
 * 纯函数层（几何/量程/刻度/路径/markup/插值/反解）可无头测试；DOM 渲染器在浏览器内使用。
 * 数据契约：series = [{moveNo, winrate(百分比 0-100 或 null), scoreLead(目, 可 null)}]，
 * 按 moveNo 排序、同 moveNo 去重（后写覆盖）；winrateUnit='fraction' 时先 ×100。
 * （后端 0..1 小数 + 视角统一已由 ISSUE-050 答复：T6.1 服务端换算百分并配置
 * KataGo reportAnalysisWinratesAs=BLACK；此处消费侧仍显式传 unit。）
 */

import { winrateToPercent, pct, scoreLead } from './fmt.js';

/** 视口（与静态稿一致：340×160，被 .chart CSS 拉伸铺满）。 */
export const CURVE_W = 340;
export const CURVE_H = 160;
export const CURVE_PAD = Object.freeze({ top: 14, bottom: 16, left: 44, right: 40 });
/** 目差虚线固定色（设计定，不随主题；区别于随主题的 --accent 胜率线）。 */
export const SCORE_STROKE = '#7A8B99';
/** 目差虚线线宽（2026/09/05 人工反馈：原 1.6 过粗 → 1.0 细虚线，弱于胜率主轴 2）。 */
export const SCORE_STROKE_W = 1;

/** 动效：路径 morph 时长（UI_UX §6.3 曲线点更新 240ms）。 */
export const CURVE_MORPH_MS = 240;

/* ============================================================
 * 纯函数：几何
 * ============================================================ */

/** 绘图区几何（CSS 逻辑 px）。 */
export function curveGeometry(width = CURVE_W, height = CURVE_H, pad = CURVE_PAD) {
  const x0 = pad.left;
  const x1 = width - pad.right;
  const top = pad.top;
  const bottom = height - pad.bottom;
  const mid = (top + bottom) / 2;
  return {
    width,
    height,
    pad: { ...pad },
    x0,
    x1,
    top,
    bottom,
    mid,
    plotW: x1 - x0,
    plotH: bottom - top,
  };
}

/** 由最大 |目差| 计算量程：×1.15 余量后向上取 0.5 整数倍（演示稿语义）。 */
export function scaleFor(maxAbs) {
  return Math.ceil((Math.abs(maxAbs) || 1) * 1.15 * 2) / 2;
}

/** 1 位小数显示（去尾 0，负号按 JS 原生 String，供轴刻度——正负号另行按 U+2212 处理）。 */
export function fmt1(v) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  return String(Math.round(Number(v) * 10) / 10);
}

/** 胜率（0–100）→ y。 */
export function winrateY(g, v) {
  return g.bottom - (v / 100) * g.plotH;
}

/** 目差（相对 0 中线）→ y；scale 为右轴量程。 */
export function scoreY(g, v, scale) {
  return g.mid - (v / scale) * (g.mid - g.top);
}

/** 手数 moveNo → x（domain 0..total 铺满绘图区；total<=0 时贴左缘）。 */
export function xOfMove(g, moveNo, total) {
  const t = Number(total);
  if (!(t > 0)) return g.x0;
  const k = Math.min(Math.max(Number(moveNo) || 0, 0), t);
  return g.x0 + (k / t) * g.plotW;
}

/* ============================================================
 * 纯函数：刻度
 * ============================================================ */

/** ≤ raw 的最大「nice」步长（{1,2,5}×10^n）。 */
function niceFloor(raw) {
  if (!(raw > 0)) return 0;
  const pow = 10 ** Math.floor(Math.log10(raw));
  let best = 0;
  for (const m of [1, 2, 5, 10]) {
    const c = m * pow;
    if (c <= raw) best = c;
  }
  return best;
}

/** 底部手数刻度步长（目标 ≈ total/4，取 nice 下限）。 */
export function niceTickStep(total) {
  const t = Number(total);
  if (!(t > 1)) return 0;
  return niceFloor(t / 4);
}

/** 底部手数刻度数组（< total 的步长整数倍；total<=1 → []）。 */
export function moveTicks(total) {
  const step = niceTickStep(total);
  if (!step) return [];
  const out = [];
  for (let v = step; v < total; v += step) out.push(v);
  return out;
}

/* ============================================================
 * 纯函数：数据归一 / 路径
 * ============================================================ */

/**
 * 归一 series pts：winrateUnit 控制小数↔百分（后端 0..1 → 'fraction'）；
 * 排序 + 同 moveNo 去重（后者覆盖），非法值剔除。
 */
export function toSeries(points, opts = {}) {
  const unit = opts.winrateUnit === 'fraction' ? 'fraction' : 'percent';
  const map = new Map();
  for (const p of points || []) {
    const moveNo = Number(p && p.moveNo);
    if (!Number.isFinite(moveNo) || moveNo < 0) continue;
    map.set(moveNo, {
      moveNo,
      winrate: winrateToPercent(p.winrate, unit),
      scoreLead: p.scoreLead == null || !Number.isFinite(Number(p.scoreLead)) ? null : Number(p.scoreLead),
    });
  }
  const pts = [...map.values()].sort((a, b) => a.moveNo - b.moveNo);
  const total = pts.length ? pts[pts.length - 1].moveNo : 0;
  return { pts, total };
}

/** 单一序列 polyline `d`（pts 中 key 有效值逐点连接；空 → ''）。 */
export function linePath(pts, key, geom, mapperY) {
  const coords = [];
  for (const p of pts) {
    const v = p[key];
    if (v == null || !Number.isFinite(Number(v))) continue;
    coords.push(`${round1(xOfMove(geom, p.moveNo, geom.__total ?? p.moveNo))} ${round1(mapperY(Number(v)))}`);
  }
  return coords.length ? `M${coords.join(' L')}` : '';
}

/** 胜率面积（曲线 + 底边闭合）`d`；无有效点 → ''。 */
export function areaPath(pts, geom) {
  const valid = pts.filter((p) => p.winrate != null && Number.isFinite(Number(p.winrate)));
  if (!valid.length) return '';
  const total = geom.__total != null ? geom.__total : pts.length ? pts[pts.length - 1].moveNo : 0;
  const x0 = round1(xOfMove(geom, valid[0].moveNo, total));
  const x1 = round1(xOfMove(geom, valid[valid.length - 1].moveNo, total));
  const line = valid
    .map((p) => `${round1(xOfMove(geom, p.moveNo, total))} ${round1(winrateY(geom, Number(p.winrate)))}`)
    .join(' L');
  return `M${x0} ${round1(geom.bottom)} L${line} L${x1} ${round1(geom.bottom)} Z`;
}

/* ============================================================
 * 纯函数：markup
 * ============================================================ */

/**
 * 生成曲线 innerHTML（不含 <svg> 外壳）。data:
 *   { pts:[{moveNo,winrate,scoreLead}], total?, current?, xTicks?, winrateUnit? }
 * 动态节点带 class（cr-area/cr-w/cr-d/cr-cur/cr-dot/cr-labels/cr-mid），供 updateCurve
 * 增量改 d（不重建 DOM）。
 */
export function buildCurveMarkup(data, opts = {}) {
  const series = toSeries(data.pts || [], data);
  const total = data.total != null && Number(data.total) > 0 ? Number(data.total) : series.total;
  const current = curveCurrent(data);
  const g = curveGeometry();
  g.__total = total;

  // 量程（目差轴动态缩放）
  let maxAbs = 0;
  for (const p of series.pts) if (p.scoreLead != null) maxAbs = Math.max(maxAbs, Math.abs(p.scoreLead));
  const scale = scaleFor(maxAbs);

  const out = [];
  out.push(`<line class="cr-mid" x1="${g.x0}" y1="${g.mid}" x2="${g.x1}" y2="${g.mid}" ` +
    'stroke="var(--border-strong)" stroke-dasharray="3 4" opacity=".6"/>');

  // 胜率面积 + 主轴
  const dW = linePath(series.pts, 'winrate', g, (v) => winrateY(g, v));
  out.push(`<path class="cr-area" d="${areaPath(series.pts, g)}" fill="var(--accent-soft)"/>`);
  out.push(`<path class="cr-w" d="${dW}" fill="none" stroke="var(--accent)" stroke-width="2" ` +
    'stroke-linecap="round" stroke-linejoin="round"/>');
  // 目差虚线副轴
  const dD = linePath(series.pts, 'scoreLead', g, (v) => scoreY(g, v, scale));
  out.push(`<path class="cr-d" d="${dD}" fill="none" stroke="${SCORE_STROKE}" stroke-width="${SCORE_STROKE_W}" ` +
    'stroke-linecap="round" stroke-dasharray="4 3"/>');

  // 当前手竖线 + 圆点（取当前手最近的 winrate 有效点 y；无则落中线）
  const xCur = xOfMove(g, current, total);
  out.push(`<line class="cr-cur" x1="${round1(xCur)}" y1="${g.top}" x2="${round1(xCur)}" y2="${g.bottom}" ` +
    'stroke="var(--accent)" stroke-dasharray="2 3" opacity=".7"/>');
  let dotY = g.mid;
  for (let i = series.pts.length - 1; i >= 0; i -= 1) {
    if (series.pts[i].moveNo <= current && series.pts[i].winrate != null) {
      dotY = winrateY(g, Number(series.pts[i].winrate));
      break;
    }
  }
  out.push(`<circle class="cr-dot" cx="${round1(xCur)}" cy="${round1(dotY)}" r="3.5" fill="var(--accent)"/>`);

  // hover 明细联动层（最近点高亮；位置/显隐由 attachCurveHover 驱动，初始隐藏）
  out.push('<g class="cr-hover u-hide" aria-hidden="true">' +
    `<line class="cr-hx" x1="${g.x0}" y1="${g.top}" x2="${g.x0}" y2="${g.bottom}" ` +
    'stroke="var(--accent)" stroke-dasharray="2 3" opacity=".45"/>' +
    `<circle class="cr-hd" cx="${g.x0}" cy="${g.mid}" r="3.5" fill="var(--accent)" ` +
    'stroke="var(--bg-glass-strong)" stroke-width="1.5"/></g>');

  out.push(`<g class="cr-labels" font-size="9" fill="var(--text-3)" font-family="var(--font-ui)">` +
    buildLabelsMarkup(g, scale, total, data.xTicks || moveTicks(total)) + '</g>');
  return out.join('');
}

/** 轴标签 + 底部手数刻度（供初建与增量刷新共用）。 */
export function buildLabelsMarkup(g, scale, total, ticks) {
  let s = '';
  const left = (y, text) => `<text x="${g.x0 - 6}" y="${y}" text-anchor="end">${text}</text>`;
  const right = (y, text) => `<text x="${g.x1 + 6}" y="${y}">${text}</text>`;
  // 2026/09/06 人工反馈：目差右轴仅保留满量程与 0，中间 ±half 半刻度不显示
  s += left(g.top + 3, '100%');
  s += left(g.mid + 3, '50%');
  s += left(g.bottom + 3, '0%');
  s += right(g.top + 3, `+${fmt1(scale)}`);
  s += right(g.mid + 3, '0');
  s += right(g.bottom + 3, `−${fmt1(scale)}`);
  for (const tk of ticks || []) {
    s += `<text x="${round1(xOfMove(g, tk, total))}" y="${CURVE_H - 4}" text-anchor="middle">${tk}</text>`;
  }
  return s;
}

function round1(v) {
  return Math.round(Number(v) * 100) / 100;
}

/* ============================================================
 * 纯函数：交互反解（hover / 点击定位）
 * ============================================================ */

/** clientX → viewBox X（preserveAspectRatio="none" 下整宽线性映射）。rect 需 {left,width}。 */
export function clientXToViewBoxX(clientX, rect) {
  const w = rect && Number(rect.width);
  if (!(w > 0)) return 0;
  return ((Number(clientX) - Number(rect.left)) * CURVE_W) / w;
}

/** 绘图区 viewBox X → 手数（0..total 域线性；绘图区外推钳制到端头）。 */
export function moveNoAtViewBoxX(vbX, total, geom = curveGeometry()) {
  const t = Number(total);
  if (!(t > 0)) return 0;
  const ratio = (Number(vbX) - geom.x0) / geom.plotW;
  return Math.min(Math.max(ratio, 0), 1) * t;
}

/** 最近数据点（按手数距离；空 → null）。 */
export function nearestPoint(pts, moveNo) {
  let best = null;
  let bestD = Infinity;
  const target = Number(moveNo);
  for (const p of pts || []) {
    const d = Math.abs(Number(p.moveNo) - target);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** hover 明细文案：`第 N 手 · 胜率 54.2% · 目差 +3.1`（缺项省略；负号 U+2212）。 */
export function hoverDetailText(pt) {
  if (!pt) return '';
  const bits = [`第 ${Number(pt.moveNo)} 手`];
  const w = pt.winrate == null ? null : Number(pt.winrate);
  if (w != null && Number.isFinite(w)) bits.push(`胜率 ${pct(w, 1)}`);
  const s = pt.scoreLead == null ? null : Number(pt.scoreLead);
  if (s != null && Number.isFinite(s)) bits.push(`目差 ${scoreLead(s)}`);
  return bits.join(' · ');
}

/* ============================================================
 * DOM 渲染（浏览器内；无头测试不调用）
 * ============================================================ */

/**
 * 全量渲染（首次）；重复调用等价全量重绘。返回 { scale, total }。
 * 记录 _tgoCurvePrev（含有效量程，供 morphCurve 以本帧为起点）与 _tgoCurveData
 * （当前显示数据，供 hover / 点击反解）。
 */
export function renderCurve(svg, data, opts = {}) {
  if (!svg || typeof svg.innerHTML !== 'string') return null;
  svg.innerHTML = buildCurveMarkup(data, opts);
  const series = toSeries(data.pts || [], data);
  const total = curveTotal(data);
  svg._tgoCurvePrev = { pts: series.pts, total };
  svg._tgoCurveData = { pts: series.pts, total, current: curveCurrent(data) };
  return { scale: curveScale(data), total };
}

/** 增量刷新：仅更新 path `d`、当前手竖线/圆点与标签组，不重建 DOM（§7）。 */
export function updateCurve(svg, data, opts = {}) {
  if (!svg) return null;
  const q = (sel) => svg.querySelector(sel);
  const has = q('.cr-w');
  if (!has) return renderCurve(svg, data, opts);

  const series = toSeries(data.pts || [], data);
  const total = data.total != null && Number(data.total) > 0 ? Number(data.total) : series.total;
  const current = curveCurrent(data);
  const g = curveGeometry();
  g.__total = total;
  const scale = curveScale(data);

  const setD = (sel, d) => q(sel) && q(sel).setAttribute('d', d);
  setD('.cr-w', linePath(series.pts, 'winrate', g, (v) => winrateY(g, v)));
  setD('.cr-area', areaPath(series.pts, g));
  setD('.cr-d', linePath(series.pts, 'scoreLead', g, (v) => scoreY(g, v, scale)));

  const xCur = xOfMove(g, current, total);
  const curLine = q('.cr-cur');
  if (curLine) {
    curLine.setAttribute('x1', round1(xCur));
    curLine.setAttribute('x2', round1(xCur));
  }
  let dotY = g.mid;
  for (let i = series.pts.length - 1; i >= 0; i -= 1) {
    if (series.pts[i].moveNo <= current && series.pts[i].winrate != null) {
      dotY = winrateY(g, Number(series.pts[i].winrate));
      break;
    }
  }
  const dot = q('.cr-dot');
  if (dot) {
    dot.setAttribute('cx', round1(xCur));
    dot.setAttribute('cy', round1(dotY));
  }
  const labels = q('.cr-labels');
  if (labels) {
    labels.innerHTML = buildLabelsMarkup(g, scale, total, data.xTicks || moveTicks(total));
  }
  // 记录最新数据为 morph 基准 + hover/点击反解基准（含 morph 中段：每帧把插值结果回写，取消后仍衔接）
  svg._tgoCurvePrev = { pts: series.pts, total };
  svg._tgoCurveData = { pts: series.pts, total, current };
  return { scale, total };
}

/**
 * 两序列间插值（t∈[0,1]）：并集手数骨架逐点线性插值（morphCurve 与单测共用）。
 * - 仅 next 有的新增点：起点 = prev 中不大于该手数的最近点（前值外推）——
 *   末段自上一数据点平滑“生长”，而不是弹出；起点缺失（早于 prev 首点）则直出目标值；
 * - 仅 prev 有的被删点：保持原值直至结束帧（t≥1 由精确目标帧剔除，不残留）。
 */
export function morphPts(prevPts, nextPts, t) {
  const prev = Array.isArray(prevPts) ? prevPts : [];
  const next = Array.isArray(nextPts) ? nextPts : [];
  const nos = new Set();
  for (const p of prev) nos.add(p.moveNo);
  for (const p of next) nos.add(p.moveNo);
  const keys = [...nos].sort((a, b) => a - b);
  const prevMap = new Map(prev.map((p) => [p.moveNo, p]));
  const nextMap = new Map(next.map((p) => [p.moveNo, p]));
  const lerp = (x, y) => (x == null ? y : y == null ? x : x + (y - x) * t);
  const out = [];
  let pi = -1; // prev 中 moveNo < 当前 key 的最近点（两序列已排序 → 线性推进）
  for (const moveNo of keys) {
    while (pi + 1 < prev.length && prev[pi + 1].moveNo < moveNo) pi += 1;
    const a = prevMap.get(moveNo) || null;
    const b = nextMap.get(moveNo) || null;
    const carry = pi >= 0 ? prev[pi] : null;
    const startW = a && a.winrate != null ? a.winrate : carry && carry.winrate != null ? carry.winrate : null;
    const startS = a && a.scoreLead != null ? a.scoreLead : carry && carry.scoreLead != null ? carry.scoreLead : null;
    const endW = b ? b.winrate : startW;
    const endS = b ? b.scoreLead : startS;
    out.push({ moveNo, winrate: lerp(startW, endW), scoreLead: lerp(startS, endS) });
  }
  return out;
}

/**
 * 240ms 路径 morph：在 prev→next 间逐帧插值并 updateCurve（仅改 d）。
 * - 新增末段前值外推生长（见 morphPts）；被删点结束帧剔除；
 * - x 域量程 total 同步插值（末手推进时整段平移不突跳）；
 * - **无点值变化（仅当前手/量程）→ 直出**（竖线移动不播填充/滑动动画，2026/09/12）。
 * prev 缺省取 svg._tgoCurvePrev（首次即直出）。返回取消函数。
 */
export function morphCurve(svg, data, opts = {}) {
  if (!svg || typeof requestAnimationFrame === 'undefined') return () => {};
  const duration = opts.duration || CURVE_MORPH_MS;
  const next = toSeries(data.pts || [], data);
  const nextTotal = curveTotal(data);
  const prev = (svg._tgoCurvePrev && Array.isArray(svg._tgoCurvePrev.pts) ? svg._tgoCurvePrev : null);
  if (!prev || !svg.querySelector('.cr-w') || duration <= 0 || pointsEqual(prev.pts, next.pts)) {
    // 首次绘制 / 无数据变化（仅当前手/量程移动）→ 直出，不播动画
    updateCurve(svg, data, opts);
    return () => {};
  }
  const prevTotal = prev.total != null && Number(prev.total) > 0 ? Number(prev.total) : nextTotal;
  const start = performance.now();
  let raf = 0;
  const canceled = { v: false };
  const frame = (now) => {
    if (canceled.v) return;
    const t = Math.min(1, (now - start) / duration);
    if (t >= 1) {
      updateCurve(svg, data, opts); // 精确目标（含被删点剔除）
      return;
    }
    const pts = morphPts(prev.pts, next.pts, t);
    const total = prevTotal + (nextTotal - prevTotal) * t;
    updateCurve(svg, { ...data, pts, total }, opts);
    // 每帧推进基准：中途取消/新 morph 叠加时以当前插值结果为起点，避免跳变
    svg._tgoCurvePrev = { pts, total };
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    canceled.v = true;
    cancelAnimationFrame(raf);
  };
}

/**
 * DOM：由 clientX 反解最近显示数据点（hover / 点击定位共用）。
 * 显示数据取 svg._tgoCurveData（renderCurve/updateCurve 每次刷新写入，含 morph 帧）。
 * @returns {{pt:object, moveNo:number, x:number, y:number}|null}
 */
export function pointAtClientX(svg, clientX) {
  const data = svg && svg._tgoCurveData;
  if (!data || !data.pts || !data.pts.length) return null;
  if (typeof svg.getBoundingClientRect !== 'function') return null;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return null;
  const vbX = clientXToViewBoxX(clientX, rect);
  const moveNo = moveNoAtViewBoxX(vbX, data.total);
  const pt = nearestPoint(data.pts, moveNo);
  if (!pt) return null;
  const g = curveGeometry();
  g.__total = data.total;
  return {
    pt,
    moveNo: pt.moveNo,
    x: round1(xOfMove(g, pt.moveNo, data.total)),
    y: round1(pointY(pt, data.pts, g)),
  };
}

/**
 * 两序列点值是否等价（moveNo + winrate + scoreLead 逐点相等，数值容差 1e-9 吸收
 * 浮点尾差）。**仅当前手/量程变化（无数据变化）时不播 morph**：竖线/量程瞬时到位，
 * 只有数据（新增/修订）才播放 240ms 生长动画（2026/09/12 人工确认）。
 */
export function pointsEqual(a, b) {
  const pa = Array.isArray(a) ? a : [];
  const pb = Array.isArray(b) ? b : [];
  if (pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i += 1) {
    const x = pa[i] || {};
    const y = pb[i] || {};
    if (Number(x.moveNo) !== Number(y.moveNo)) return false;
    if (!valueEq(x.winrate, y.winrate)) return false;
    if (!valueEq(x.scoreLead, y.scoreLead)) return false;
  }
  return true;
}

function valueEq(x, y) {
  const a = x == null || x === '' ? null : Number(x);
  const b = y == null || y === '' ? null : Number(y);
  if (a == null || b == null) return a == null && b == null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) < 1e-9;
}

/** 数据点 y：优先胜率线，回退目差虚线（同动态量程），都缺 → 中线。 */
function pointY(pt, pts, g) {
  const w = pt && pt.winrate;
  if (w != null && Number.isFinite(Number(w))) return winrateY(g, Number(w));
  const s = pt && pt.scoreLead;
  if (s != null && Number.isFinite(Number(s))) {
    let maxAbs = 0;
    for (const p of pts || []) if (p.scoreLead != null) maxAbs = Math.max(maxAbs, Math.abs(Number(p.scoreLead)));
    return scoreY(g, Number(s), scaleFor(maxAbs));
  }
  return g.mid;
}

/**
 * hover 明细：最近数据点高亮（`.cr-hover`）+ 浮动气泡（`.chart-tip`，挂 svg 父容器）。
 * 返回解绑函数（模块 destroy 时调用）。
 */
export function attachCurveHover(svg) {
  if (!svg || typeof svg.addEventListener !== 'function') return () => {};
  const host = svg.parentElement;
  let tip = null;
  if (host && typeof document !== 'undefined') {
    tip = host.querySelector('.chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip u-hide';
      tip.setAttribute('aria-hidden', 'true'); // 纯视觉补充（悬停不可达键盘/读屏），避免 live 播报噪音
      host.appendChild(tip);
    }
  }
  const hide = () => {
    if (tip) tip.classList.add('u-hide');
    const group = svg.querySelector('.cr-hover');
    if (group) group.classList.add('u-hide');
  };
  const onMove = (e) => {
    const hit = pointAtClientX(svg, e.clientX);
    if (!hit) {
      hide();
      return;
    }
    const group = svg.querySelector('.cr-hover');
    if (group) {
      const line = group.querySelector('.cr-hx');
      const dot = group.querySelector('.cr-hd');
      if (line) {
        line.setAttribute('x1', hit.x);
        line.setAttribute('x2', hit.x);
      }
      if (dot) {
        dot.setAttribute('cx', hit.x);
        dot.setAttribute('cy', hit.y);
      }
      group.classList.remove('u-hide');
    }
    if (!tip || !host) return;
    tip.textContent = hoverDetailText(hit.pt);
    tip.classList.remove('u-hide');
    // 跟随指针（相对 .chart），左右钳制；上方空间不足时改点下方
    const hostRect = host.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - hostRect.left, hostRect.width));
    const y = Math.max(0, Math.min(e.clientY - hostRect.top, hostRect.height));
    const half = tip.offsetWidth / 2;
    const left = Math.max(half + 4, Math.min(x, Math.max(half + 4, hostRect.width - half - 4)));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(y)}px`;
    tip.style.transform = y - tip.offsetHeight - 12 >= 0
      ? 'translate(-50%, calc(-100% - 10px))'
      : 'translate(-50%, 10px)';
  };
  const onLeave = () => hide();
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerleave', onLeave);
  svg.addEventListener('pointercancel', onLeave);
  return () => {
    svg.removeEventListener('pointermove', onMove);
    svg.removeEventListener('pointerleave', onLeave);
    svg.removeEventListener('pointercancel', onLeave);
    hide();
  };
}

/** 首次出现淡入（240ms，CSS `cr-enter`；reduced-motion 由 CSS 关闭）。 */
export function playCurveEnter(svg) {
  if (!svg || !svg.classList || typeof svg.getBoundingClientRect !== 'function') return;
  svg.classList.remove('cr-enter');
  void svg.getBoundingClientRect(); // 强制回流：连续出现时重启动画
  svg.classList.add('cr-enter');
}

/* ---- 内部小工具（纯） ---- */

function curveScale(data) {
  const series = toSeries(data.pts || [], data);
  let maxAbs = 0;
  for (const p of series.pts) if (p.scoreLead != null) maxAbs = Math.max(maxAbs, Math.abs(p.scoreLead));
  return scaleFor(maxAbs);
}

function curveTotal(data) {
  const series = toSeries(data.pts || [], data);
  return data.total != null && Number(data.total) > 0 ? Number(data.total) : series.total;
}

/** 当前手（data.current 缺省=序列末手；钳制到 max(序列末手, 有效量程)）。 */
function curveCurrent(data) {
  const series = toSeries(data.pts || [], data);
  const total = curveTotal(data);
  const raw = data.current == null
    ? (series.pts.length ? series.pts[series.pts.length - 1].moveNo : 0)
    : Number(data.current);
  return Math.min(raw, Math.max(series.total, total));
}

