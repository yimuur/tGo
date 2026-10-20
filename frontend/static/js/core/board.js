/**
 * tGo · 双层 Canvas 围棋棋盘 GameBoard（T5.5；2026/09/17 性能修订）
 *
 * 依据 TASK.md T5.5 / UI_UX §5.2.2 / §6.3 / §6.7 / §6.8 / PROPS C4：
 *   - **双层 Canvas（2026/09/17 修订，替代原三层）**：静态层（网格/星位/坐标，仅
 *     规格/主题变化重绘）、状态层（云子/当前手标记/点评色环/死子 ✕ + 全部叠加标记：
 *     领地热力/TOP5/变化图/hover 预览/键盘光标/非法 ✕）。原「动态层 rAF 每帧
 *     clearRect 重绘」的常量开销已消除——所有叠加标记均为状态派生，一律脏标记按需重绘。
 *   - **rAF 按需调度**：仅当存在脏标记或动画（落子/提子/色环/热力插值/TOP5 淡入/
 *     非法 ✕ 到期清除）进行中才申请下一帧；空闲零绘制、零唤醒。
 *   - **GC 友好**：黑/白云子预渲染为离屏 sprite（阴影/高光一次性烘焙），rAF
 *     内只用 drawImage，不在循环里 new 大对象。
 *   - **坐标语义**：与 backend/app/engine/coords.py 完全一致——(x,y) 0-based 左上
 *     原点（x=列 y=行），GTP 字母 A..T 跳过 I、行号自下而上；纯函数可无头测试。
 *   - **13/19/9 自适应**：几何全部以 layoutForSize 的 cell 为单位相对推导。
 *   - **动效**（UI_UX §6.3 时长表）：落子＝人手斜放模型（drop-anim，≈630ms 帧率无关；
 *     管理页可关闭，reduced-motion 即时）、提子 150ms 残影、TOP5 150ms fade-in、
 *     领地热力连续模式 ≥240ms 平滑过渡（显示淡入 / 清除淡出 / 新旧交叉淡变）；
 *     reduced-motion 全部即时。
 *   - **交互**：点击落子（最近交叉点命中）、hover 预览、键盘方向键 + Space/Enter
 *     落子（UI_UX §6.8 最小集）、内部 aria-live 播报。
 *
 * 组件与视图解耦：GameBoard 只接收 Props（C4），不感知状态树/通信层；
 * Phase 6 视图负责把 store 切片映射为 props（AGENTS §4：WS 回调只 dispatch）。
 *
 * 本文件不引用任何 DOM 全局量（document/window 仅在类方法内使用），
 * 纯函数层可被 node --test 无头导入。
 */

import { paintStone, paintStoneBody, paintStoneShadow, resolveStoneColors } from './stone-style.js';
import { stoneMotionEnabled } from './settings.js';
import { DROP_MS, dropRatio, dropSquash, dropYOffR, isDropLanded } from './drop-anim.js';
import { paintWoodGrain, woodGrainPlan } from './wood-grain.js';

/* ============================================================
 * 常量
 * ============================================================ */

/** GTP 列字母序（跳过 I，与 backend coords.py COLS 一致，仅取前 n 个）。 */
export const GTP_ALPHABET = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
/** 支持的路数。 */
export const BOARD_SIZES = [9, 13, 19];

/** 点评五色（LEVEL.md 分级，与 app.css --c-* Token 对齐）。 */
export const GRADE_ORDER = ['brilliant', 'good', 'slow', 'mistake', 'blunder'];

/**
 * 最外圈刻线加粗倍率兜底值（2026/09/22 人工要求：可用参数开关设置是否加粗）。
 * 开关入口＝app.css `--grid-outer-scale`（≤1 或缺失降至 1 = 不加粗）；本常量仅作 token 缺失兜底。
 */
export const GRID_OUTER_SCALE_FALLBACK = 1.55;

/** 颜色兜底（app.css Token 缺失时使用；主题深/浅网格线不同）。 */
const FALLBACK = {
  grid: { light: 'rgba(74,58,38,.65)', dark: 'rgba(233,198,128,.62)' },
  coord: { light: 'rgba(74,58,38,.55)', dark: 'rgba(233,198,128,.45)' },
  // 木纹（token 缺失兜底；alpha 即基准强度，与 app.css 同值）
  grain: { light: 'rgba(120,84,50,.07)', dark: 'rgba(20,8,4,.14)' },
  grainBand: { light: 'rgba(120,84,50,.055)', dark: 'rgba(255,205,150,.06)' },
  // 最外圈刻线加粗倍率（≤1 = 关闭；与 app.css --grid-outer-scale 同值）
  gridOuterScale: String(GRID_OUTER_SCALE_FALLBACK),
  accent: '#1F4E5F',
  accentContrast: '#FFFFFF',
  grade: {
    brilliant: '#3B82F6',
    good: '#22A06B',
    slow: '#D9A400',
    mistake: '#F2711C',
    blunder: '#D64545',
  },
};

/** 从 CSS 自定义属性读取的 token 名（存在 :root / html[data-theme=*]）。 */
const CSS_TOKENS = {
  grid: '--grid',
  coord: '--coord',
  grain: '--wood-grain',
  grainBand: '--wood-grain-band',
  gridOuterScale: '--grid-outer-scale',
  accent: '--accent',
  accentContrast: '--accent-contrast',
  brilliant: '--c-brilliant',
  good: '--c-good',
  slow: '--c-slow',
  mistake: '--c-mistake',
  blunder: '--c-blunder',
  fontUi: '--font-ui',
};

/** 默认 UI 字体栈（与 app.css --font-ui 对齐，仅作兜底）。 */
const FONT_STACK =
  'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';

/* 动效时长（UI_UX §6.3 表）——常量供组件引用，禁止散落魔数。 */
export const ANIM_MS = {
  // 落子：人手斜放模型时长由 core/drop-anim.js 给出（帧率无关恒时长）
  drop: DROP_MS,
  capture: 150, // 提子：消失 + 残影
  recommend: 150, // TOP5 徽章 fade-in
  heat: 240, // 领地热力连续模式平滑过渡下限
  illegal: 400, // 非法落子 ✕ 闪现时长
  ring: 200, // 点评色环淡入/淡出（2026/09/05 人工反馈：避免生硬叠加）
};

/* 动效参数（§6.3） */
const CAPTURE_GHOST = 0.6; // 提子残影起始不透明度

/* ============================================================
 * 棋盘缩放（仅放大棋盘与棋子，不放大页面其它元素；对弈/复盘共用内核）
 *   - 桌面：Ctrl/⌘ + 滚轮；移动端：双指捏合；
 *   - 放大后画布以更高分辨率重栅格（棋子/网格不虚），视口拖拽平移查看；
 *   - 缩放 >1 时轻点仍可落子，按住拖拽为平移（阈值 panThreshold）。
 * ============================================================ */
export const BOARD_ZOOM = Object.freeze({
  min: 1,
  max: 2, // 最大放大倍数（可调）
  wheelStep: 1.18, // Ctrl/⌘+滚轮每格倍率
  panThreshold: 6, // 拖拽判定阈值（CSS px）——小于该位移视为“轻点落子”
  pinchEps: 6, // 双指最小间距（防除零）
});

/** 钳制缩放倍数至 [min, max]。 */
export function clampZoom(z) {
  return Math.min(BOARD_ZOOM.max, Math.max(BOARD_ZOOM.min, Number(z) || 1));
}

/**
 * 画布视口平移钳制（CSS px）：画布（边长 surf）相对容器（vw×vh）的左上角坐标；
 * 画布不大于容器方向则居中，超出部分允许在 [vw-surf, 0]（或 [vh-surf, 0]）内拖拽。
 * @param {number} left  期望 left
 * @param {number} top   期望 top
 * @param {number} surf  画布边长（= 视口短边 × zoom）
 * @param {number} vw    容器宽
 * @param {number} vh    容器高
 * @returns {{left:number, top:number}}
 */
export function clampBoardView(left, top, surf, vw, vh) {
  const L = surf <= vw ? (vw - surf) / 2 : Math.min(0, Math.max(vw - surf, left));
  const T = surf <= vh ? (vh - surf) / 2 : Math.min(0, Math.max(vh - surf, top));
  return { left: L, top: T };
}

/**
 * 重栅格指纹判定（纯函数，BUG-096）：上次实际栅格化的布局指纹与本次候选完全一致时
 * 无需重栅格/重绘。指纹含 `dpr`（跨屏拖动）与 `bw`（设备像素边长）——避免仅比较 CSS
 * 尺寸而漏掉 dpr/取整变化；含 `size`（路数）——否则同尺寸改路数会被误判为无变化。
 *
 * 2026/09/22（方案 B）：静态层不再是正方形，而是**木料面**（容器整幅 × zoom），
 * 故指纹一并包含木料面的尺寸/位置（sw/sh/sl/st）——否则容器变宽而棋盘不变时
 * （surf/left/top 可能不变）会漏掉重栅格。
 * @param {{surf:number,left:number,top:number,dpr:number,bw:number,bh:number,size:number,
 *   sw:number,sh:number,sl:number,st:number}|null} prev
 * @param {{surf:number,left:number,top:number,dpr:number,bw:number,bh:number,size:number,
 *   sw:number,sh:number,sl:number,st:number}} next
 * @returns {boolean} true = 需要重栅格（prev 为空 = 尚未栅格化）
 */
export function layoutRasterChanged(prev, next) {
  if (!prev) return true;
  return prev.surf !== next.surf
    || prev.left !== next.left
    || prev.top !== next.top
    || prev.dpr !== next.dpr
    || prev.bw !== next.bw
    || prev.bh !== next.bh
    || prev.size !== next.size
    || prev.sw !== next.sw
    || prev.sh !== next.sh
    || prev.sl !== next.sl
    || prev.st !== next.st;
}

/**
 * 木料面几何（纯函数；方案 B，2026/09/22 人工决策）。
 *
 * 木料＝**棋盘容器整幅**（矩形），棋盘（网格/棋子）只占其中央的正方形；木料面随棋盘
 * 一同缩放与平移（人工要求「木纹随动」）：
 *   - 尺寸 = 容器尺寸 × zoom；
 *   - 位置 = 棋盘画布位置 向外各扩「留白 × zoom」。
 * 故 zoom=1 时木料面恰等于容器（left=top=0、w=vw、h=vh），与改动前的“容器整幅木料”一致。
 *
 * `dpr` 传入时，留白 `padX/padY` 也吸附到设备像素网格（≤0.5 设备像素位移）：木料面层的
 * 合成偏移 = `面.left + padX` 与层内棋盘的局部平移 `padX` 必须同时为整数设备像素，
 * 否则要么整层被重采样、要么层内刻线跨像素（＝发虚，BUG-007 同类；2026/09/22）。
 *
 * @param {{vw:number, vh:number, zoom:number, boardLeft:number, boardTop:number, dpr?:number}} [opts]
 * @returns {{w:number, h:number, left:number, top:number, padX:number, padY:number}}
 */
export function woodSurfaceLayout({ vw, vh, zoom, boardLeft, boardTop, dpr } = {}) {
  const z = clampZoom(zoom);
  const w = Math.max(0, Number(vw) || 0);
  const h = Math.max(0, Number(vh) || 0);
  const base = Math.min(w, h);              // 棋盘画布的基础边长（zoom=1 时的 surf）
  const d = Number(dpr);
  const snap = Number.isFinite(d) && d > 0;
  const padXRaw = Math.max(0, (w - base) / 2) * z;
  const padYRaw = Math.max(0, (h - base) / 2) * z;
  const padX = snap ? snapDevice(padXRaw, d) : padXRaw;
  const padY = snap ? snapDevice(padYRaw, d) : padYRaw;
  return {
    w: w * z,
    h: h * z,
    left: (Number(boardLeft) || 0) - padX,
    top: (Number(boardTop) || 0) - padY,
    padX,
    padY,
  };
}

/**
 * 刻线设备像素线宽（纯函数）：网格线统一整数设备线宽（BUG-007：逐线取整会粗细不一），
 * 最外圈（外框）按倍率加粗——倍率 ≤1 即不加粗（开关关闭，与内线同宽）。
 * @param {{lineW?:number, dpr?:number, outerScale?:number}} [opts]
 * @returns {{inner:number, outer:number}} 整数设备像素线宽
 */
export function gridLineWidths({ lineW, dpr, outerScale = GRID_OUTER_SCALE_FALLBACK } = {}) {
  const d = Math.max(1, Number(dpr) || 1);
  const inner = Math.max(1, Math.round(Math.max(1, Number(lineW) || 0) * d));
  const s = Number(outerScale);
  const scale = Number.isFinite(s) ? s : GRID_OUTER_SCALE_FALLBACK;
  const outer = scale > 1 ? Math.max(inner + 1, Math.round(inner * scale)) : inner;
  return { inner, outer };
}

/**
 * 画布位置吸附到「设备像素网格」（纯函数；2026/09/22）。
 *
 * 背景：BUG-007（2026/09/08）把**层内**几何全部吸附到设备像素（线心/线宽/圆心/sprite
 * 尺寸），但**层自身的位置**（canvas 的 `translate(left, top)`）仍可能是小数——缩放后
 * 画布边长 = 容器短边×zoom，居中/拖拽得到的位置通常不是设备像素整数倍（如 zoom 1.5 →
 * left=−191.5 CSS → −239.375 设备像素），合成时整层被重采样：线/棋子边缘重新被抗锯齿
 * 摊开（实测 zoom=2 同内容仅移 0.37px：合成截图最大/99 分位梯度 145/80 → 87/43）——即
 * BUG-007 在缩放后回归。故画布位置也按设备像素吸附。
 *
 * 约束：
 *   - 画布小于容器（居中）：吸附后仍居中（偏差 ≤ 0.5 设备像素，肉眼不可辨）；
 *   - 画布大于容器（缩放/平移）：吸附值必须仍落在合法区间内（否则容器边缘露出底色）——
 *     区间端点向内取整到设备网格（`ceil`/`floor`），保证“吸附 + 不露边”同时成立。
 *
 * @param {number} left 期望 left（CSS px，已经过 clampBoardView）
 * @param {number} top  期望 top
 * @param {{surf?:number, vw?:number, vh?:number, dpr?:number}} [ctx]
 * @returns {{left:number, top:number}}
 */
export function snapBoardPos(left, top, { surf, vw, vh, dpr } = {}) {
  const d = Math.max(1, Number(dpr) || 1);
  const size = Number(surf) || 0;
  const axis = (value, view) => {
    const v = Number(view) || 0;
    if (!(size > 0) || !(v > 0)) return Number(value) || 0;
    if (size <= v) return Math.round(((v - size) / 2) * d) / d;   // 居中：仅吸附
    const lo = Math.ceil((v - size) * d) / d;                      // 下界向内取整（不露边）
    const hi = 0;                                                  // 上界恒为 0（已对齐）
    return Math.min(hi, Math.max(lo, Math.round((Number(value) || 0) * d) / d));
  };
  return { left: axis(left, vw), top: axis(top, vh) };
}

/**
 * 触摸“双击落子”：两次轻点同一空交叉点的最大间隔（ms）。
 */
export const TOUCH_DBL_MS = 320;

/**
 * 触摸待定轻点的**交付兜底**（ms；BUG-105）：历史教训——iOS Safari 在极端时序下
 * 可能丢失触摸的 pointerup/click（2026/09/08「iOS26 全无反应」记录）。待定提交改由
 * pointerup/click 交付后，用计时器兼底：超时且未被捏合/平移/取消废弃时仍然提交，
 * 保证「轻点已占点选择 / 双击落子」不因事件缺失而失效（正常时序下 up 先到，计时器不参与）。
 */
export const TOUCH_TAP_FALLBACK_MS = 350;

/**
 * 触摸双击判定（纯函数，可无头测试）：同一交叉点且间隔 ≤ TOUCH_DBL_MS。
 * @param {{x:number,y:number,at:number}|null} prev 上一次轻点记录
 * @param {{x:number,y:number}} cur 当前轻点交叉点
 * @param {number} nowMs 当前时间（ms）
 */
export function isTouchDoubleTap(prev, cur, nowMs) {
  return Boolean(
    prev && prev.x === cur.x && prev.y === cur.y && nowMs - prev.at <= TOUCH_DBL_MS,
  );
}

/**
 * 触摸轻点待定提交判定（纯函数，可无头测试；BUG-105）。
 *
 * 触摸的**有副作用提交**（已占点选择＝结算死子标记/点评气泡、双击落子）一律推迟到
 * pointerup 判定——首指落下时，第二指（捏合）、平移、手势取消都可能接踵而至；旧实现
 * 在 pointerdown 即时提交，导致结算页双指缩放（及平移）的**首指落下**误标记死子。
 * @param {{id:number,kind:'select'|'place',x:number,y:number}|null} pending 待定轻点
 * @param {{pointerId:number,cancelled?:boolean,moved?:boolean}} ctx 手势终态
 * @returns {'select'|'place'|null} 应提交的动作（null=丢弃）
 */
export function touchTapCommitAction(pending, { pointerId, cancelled = false, moved = false } = {}) {
  if (!pending || cancelled || moved) return null;
  if (pending.id !== pointerId) return null;
  if (pending.kind !== 'select' && pending.kind !== 'place') return null;
  return pending.kind;
}

/** 当前手标记（dot）反色圆点半径 = 石径 × 0.2（直径 40%，2026/09/05 放大）。 */
const LAST_DOT_R = 0.2;
/** 当前手标记（ring）反色内圆环半径（介于点评色环 0.9R 与圆点 0.2R 之间）。 */
const LAST_RING_R = 0.52;
/** TOP5 徽章 rank 热度（基线 UI：.95/.75/.55/.35/.2）。 */
const TOP5_HEAT = [0.95, 0.75, 0.55, 0.35, 0.2];
/** 变化图预览：真实云子透明度（部分透出棋盘）。 */
const VARIATION_ALPHA = 0.75;

/* ============================================================
 * 纯函数层 —— 坐标换算 / 几何 / 布局 / 量化 / 状态推导
 * （全部可无头测试，语义与 backend coords.py 对齐）
 * ============================================================ */

/** 非法路数归一（默认 19）。 */
export function normalizeSize(n) {
  return BOARD_SIZES.includes(n) ? n : 19;
}

/** n 路棋盘列字母数组（A..，跳过 I，共 n 个）。 */
export function colLetters(n) {
  const size = normalizeSize(n);
  return GTP_ALPHABET.slice(0, size).split('');
}

/**
 * (x, y)（0-based，左上原点）→ GTP（如 "D4" / "A19"）。
 * 越界返回 null（UI 侧安全；backend 该场景抛 ValueError）。
 */
export function gtpOf(x, y, size) {
  const n = normalizeSize(size);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= n || y < 0 || y >= n) {
    return null;
  }
  return `${GTP_ALPHABET[x]}${n - y}`;
}

/** GTP / 小写 / KataGo "(x,y)" 形式 → {x,y}；非法或 pass 返回 null。 */
export function xyOfGtp(loc, size) {
  const n = normalizeSize(size);
  if (typeof loc !== 'string') return null;
  const s = loc.trim();
  if (!s) return null;
  // KataGo 显式 "(x,y)"
  const paren = /^\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
  if (paren) {
    const x = Number(paren[1]);
    const y = Number(paren[2]);
    return x >= 0 && x < n && y >= 0 && y < n ? { x, y } : null;
  }
  const m = /^([A-Za-z])(\d+)$/.exec(s);
  if (!m) return null;
  const col = m[1].toUpperCase();
  const xi = GTP_ALPHABET.indexOf(col);
  if (xi < 0 || xi >= n) return null; // 含 I / 超路数列
  const row = Number(m[2]);
  const y = n - row;
  if (row < 1 || row > n || y < 0 || y >= n) return null;
  return { x: xi, y };
}

/** 是否 pass（大小写不敏感）。 */
export function isPassLoc(loc) {
  return typeof loc === 'string' && loc.trim().toLowerCase() === 'pass';
}

/**
 * 落子播报文本（aria-live / §6.8 "第 42 手，黑方落子 D4"）。
 * move: { color:'black'|'white', x, y }，x/y 为 null 表示 pass。
 */
export function describeMove(move, size) {
  const n = normalizeSize(size);
  const color = move && move.color === 'white' ? '白方' : '黑方';
  if (!move || move.x == null || move.y == null) return `${color} pass`;
  const gtp = gtpOf(Number(move.x), Number(move.y), n);
  return gtp ? `${color}落子 ${gtp}` : `${color}落子`;
}

/**
 * 落子播报文本（含手数，aria-live）：`第 42 手，黑方落子 D4`（UI_UX §6.8）。
 * moveNo 缺失/非正整数 → 退化为 describeMove（`黑方落子 D4`）。
 */
export function moveAnnouncementText(move, size) {
  const base = describeMove(move, size);
  const no = Number(move && move.moveNo);
  return Number.isInteger(no) && no > 0 ? `第 ${no} 手，${base}` : base;
}

/** 边沿标签采样步长：19 步 3（7 标签），≤13 步 2。 */
export function labelStride(n) {
  return n > 13 ? 3 : 2;
}

/** 边沿坐标标签的下标序列（含 0，向右侧/下侧延伸，≤ n-1）。 */
export function edgeLabelIndices(n) {
  const s = labelStride(n);
  const out = [];
  for (let i = 0; i < n; i += s) out.push(i);
  return out;
}

/** 星位下标（围棋惯例：边星 + 天元；d=3 适用于 13/19，9 路 d=2）。 */
export function hoshiIndices(n) {
  const mid = (n - 1) / 2;
  if (n <= 9) return n === 9 ? [2, 4, 6] : [mid];
  return [3, mid, n - 4];
}

/** 全部星位点 [{x,y},...]（含角落三档全组合）。 */
export function hoshiPoints(n) {
  const idx = hoshiIndices(n);
  const pts = [];
  for (const x of idx) for (const y of idx) pts.push({ x, y });
  return pts;
}

/**
 * 棋子半径 / 格距。**唯一石径事实源**：直径 = 2·本值，石间净隙 = cell − 2·stoneR；
 * 色环 / TOP5 徽章 / 命中半径 / 角标等一切标记均按 stoneR 派生，改此值即整体同步。
 *
 * 2026/09/24 人工反馈「云子直径增大一点、间隙缩小一点」：0.45 → 0.48
 * （19 路 @660px：直径 30.0 → 32.0px，净隙 3.33 → 1.33px；真实棋具 ≈ 0.49）。
 */
const STONE_R_RATIO = 0.48;

/**
 * 木纹边距 / 格距。取 0.9 的依据（2026/09/24 修订：原注释「margin = 2·stoneR」在
 * 石径放大后不再成立）：石缘到画布缘净空 = (0.9 − 0.48)·cell = 0.42·cell = 0.88·stoneR，
 * 大于烘焙投影外扩 0.5R（offsetY 0.2R + blur 0.3R）→ 边角棋子连同投影完整落在
 * 木纹区内，不被画布/圆角裁剪。
 */
const EDGE_MARGIN_RATIO = 0.9;

/**
 * 布局量（逻辑 CSS px）。除石径外几何锚定自 WEBUI 静态稿的 660 空间：
 *   viewBox 660，边距 30（= EDGE_MARGIN_RATIO·cell），格距 33.333（600/18）。
 *   全部相对 cell 推导 → 任意路数/尺寸自适应。
 *
 * 关键（2026/09/05 人工反馈）：**木纹边距必须随 cell 缩放（margin = 0.9·cell）**，
 * 否则小棋盘（9/13 路）cell 变大而边距仍按整板比例固定 → 边角棋子超出画布被
 * 裁剪、且大字号坐标标签在角部与顶缘字母重叠。19 路下本式与静态稿完全一致
 * （cell = side/19.8 → span 600 / margin 30 @660），其余路数同构缩放；
 * 仅石径自 2026/09/24 起按人工反馈放大（STONE_R_RATIO），不再等于静态稿的 15。
 */
export function layoutForSize(n, sidePx) {
  const size = normalizeSize(n);
  const side = Math.max(1, Number(sidePx) || 1);
  // side = span + 2·margin = cell·(n−1) + 2·EDGE_MARGIN_RATIO·cell = cell·(n + 0.8)
  const cell = side / (size + 0.8);
  const margin = cell * EDGE_MARGIN_RATIO;
  const span = cell * (size - 1);
  return {
    n: size,
    side,
    span,
    margin,
    cell,
    stoneR: cell * STONE_R_RATIO, // 0.48·cell；直径 0.96·cell，净隙 0.04·cell
    hoshiR: cell * 0.12, // 4 / 33.333
    lineW: Math.max(1, cell * 0.036), // 1.2 / 33.333，最小 1px 保证可见
    coordFont: cell * 0.33, // 11 / 33.333
    letterY: margin * 0.76, // 顶部列字母基线（22.8 @30 边距）
    rowX: margin * 0.47, // 左侧行号锚点 x（~14 @30）
    rowBaselineOff: cell * 0.1, // 行号基线相对格线偏移（+3.3 @33）
    hitR: cell * 0.62, // 点击/键盘命中半径（< 对角中点 0.707cell）
    pad: cell * 0.12, // 网格外留白（供阴影/动画溢出）
  };
}

/** 交叉点中心像素（布局坐标系内）。 */
export function xyToPx(layout, x, y) {
  return { px: layout.margin + x * layout.cell, py: layout.margin + y * layout.cell };
}

/**
 * 「棋盘左上角提示」与**方形棋盘区域**是否重叠（2026/09/24 人工口径：判定简化为
 * 「提示矩形 ∩ 棋盘正方形 ≠ ∅」即降级半透明——不再逐交叉点/逐棋子推导）。
 *
 * 棋盘正方形＝棋盘画布本身（边长 = 容器短边 × zoom；位置 = 容器内平移 view.left/top），
 * 故矩形/居中的木料面下也不得假定“贴容器左上角”（2026/09/22 起由
 * `GameBoard.noteOverlaps` 传入真实几何；宿主页不得自行按容器宽/无偏移推导）。
 *
 * @param {{left:number,top:number,right:number,bottom:number}} rect 提示矩形
 *        （相对棋盘容器，CSS px——即 offsetLeft/offsetTop/offsetWidth/offsetHeight）
 * @param {{left:number,top:number,size:number}} board 棋盘正方形（容器内左上角 + 边长，CSS px）
 * @returns {boolean} true = 提示落在棋盘盘面内（需降级为半透明）
 */
export function noteOverlapsBoard(rect, board) {
  if (!rect || !board) return false;
  const size = Number(board.size) || 0;
  if (!(size > 0)) return false;
  const left = Number(board.left) || 0;
  const top = Number(board.top) || 0;
  return rect.left < left + size
    && rect.right > left
    && rect.top < top + size
    && rect.bottom > top;
}

/**
 * CSS 坐标吸附到「设备像素网格」（返回 CSS 单位）。
 * 几何纯函数（layoutForSize/xyToPx）保留小数语义供命中/换算，渲染层统一经此取整——
 * stroke/圆心若落在设备像素之间，会被抗锯齿拆到相邻两列（30–50% 透明）呈“发虚/偏淡”。
 * @param {number} v   CSS px
 * @param {number} dpr 设备像素比（≥1）
 */
export function snapDevice(v, dpr) {
  return Math.round(v * dpr) / dpr;
}

/**
 * 网格线中心对齐（CSS 单位）：同一整数设备线宽下按奇偶偏移（0.5px 规则）。
 *   - 偶数设备线宽：中心取整到设备像素（stroke 覆盖 [c−w/2, c+w/2] 恰整像素铺满）；
 *   - 奇数设备线宽：中心再 +0.5 设备像素（1px 线必须落在线中像素）。
 * 所有线共用同一 lwDev 与同一规则 → 线宽均匀、无逐线粗细不一。
 * @param {number} v    CSS 坐标
 * @param {number} dpr  设备像素比
 * @param {number} lwDev 整数设备线宽（≥1）
 */
export function snapLineCenter(v, dpr, lwDev) {
  const c = Math.round(v * dpr);
  return (c + (lwDev % 2 === 1 ? 0.5 : 0)) / dpr;
}

/**
 * 棋子 sprite 几何（纯函数）：把「内容设备宽取偶数整数、石心落 sprite 正中整像素」的契约固化。
 * 内容宽 = halfDev*2（偶数）⇒ 石心恒在 sprite 正中整数设备像素（halfDev 为整数），
 * 且 cssW*dpr === w ⇒ _drawStoneImage(scale===1) 可源/目标同尺寸 1:1 blit（零重采样）。
 * 缩放（zoom）只改变入参 R，规则不随 R 变（每级 zoom 由 _resetSprites 重新烘焙一次）。
 * @param {{radius?: number, padRatio?: number, dpr?: number}} [opts]
 * @returns {{pad:number, halfDev:number, w:number, cssW:number, centerCss:number}}
 */
export function spriteGeometry({ radius = 0, padRatio = 0.8, dpr = 1 } = {}) {
  const r = Math.max(0, Number(radius) || 0);
  const d = Math.max(1, Number(dpr) || 1);
  const pad = r * padRatio; // 物理投影（blur .3R + offsetX .1R / offsetY .2R）外扩空间
  const halfDev = Math.ceil((r + pad) * d);
  const w = halfDev * 2;
  return { pad, halfDev, w, cssW: w / d, centerCss: halfDev / d };
}

/**
 * 像素 → 最近交叉点 {x,y}；超出命中半径（棋盘外/格中对角空隙）返回 null。
 * px/py 为相对棋盘左上角（CSS px）。
 */
export function pxToXY(layout, px, py) {
  const n = layout.n;
  const x = Math.round((px - layout.margin) / layout.cell);
  const y = Math.round((py - layout.margin) / layout.cell);
  if (x < 0 || x >= n || y < 0 || y >= n) return null;
  const c = xyToPx(layout, x, y);
  if (Math.hypot(px - c.px, py - c.py) > layout.hitR) return null;
  return { x, y };
}

/**
 * 本次 pointerdown 是否发生在棋盘外（⇒ 触摸轻点预览/双击记录失效）：
 * 板内事件（棋盘画布及其子节点）返回 false——交给板内手势逻辑（预览移动/双击落子）。
 * @param {EventTarget|null|undefined} target
 * @param {{contains: (t: Node) => boolean}|null} boardEl
 * @returns {boolean}
 */
export function isOutsideBoard(target, boardEl) {
  if (!target || target.nodeType !== 1) return true; // 无目标/非元素（裸文本等）视为板外
  return !(boardEl && typeof boardEl.contains === 'function' && boardEl.contains(target));
}

/** 方向键向量表。 */
export const KEY_DIRS = Object.freeze({
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
});

/** 键盘方向点序：按方向移动并夹在 [0, n-1]（无环绕）。 */
export function navigatePoint(cur, dir, n) {
  const v = KEY_DIRS[dir] || { dx: 0, dy: 0 };
  const size = normalizeSize(n);
  const x = Math.min(size - 1, Math.max(0, (cur ? cur.x : Math.floor(size / 2)) + v.dx));
  const y = Math.min(size - 1, Math.max(0, (cur ? cur.y : Math.floor(size / 2)) + v.dy));
  return { x, y };
}

/**
 * 落子动画方向符号（2026/09/13 人工口径）：**+1＝自棋盘下方落入（向上落平）**，
 * **−1＝自棋盘上方落入（向下落平）**。`upColor` 为由下到上的一方（人机＝人类方 /
 * 人人＝黑方，由视图经 `dropUpSide` 派生后传入 board 的 `dropUpColor` prop）。
 */
export function dropDirSign(color, upColor = 'black') {
  return color === (upColor === 'white' ? 'white' : 'black') ? 1 : -1;
}

/**
 * 领地原始矩阵判定：普通数组或 **TypedArray**（行主序数值序列）。
 *
 * 2026/09/21：复盘批量快照以 `Float32Array` 承载整局领地（19 路整局 295 局面 ≈106k 数值，
 * 避免普通数组的内存开销）。历史上仅 `Array.isArray` 判定 → TypedArray 落入“结构化对象”
 * 分支（无 `.alphas`）→ 热力被当作空值清除（点击 [领地] “无数据”，BUG-124）。
 * 单一口径：`quantizeOwnership` 与 `GameBoard._setOwnership` 共用本判定。
 * @param {*} value
 * @returns {boolean}
 */
export function isOwnershipVector(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

/**
 * 领地热力量化（纯函数）：values 为长度 n*n 的 [-1,1] 数组（行主序、左上原点，
 * 黑正白负，KataGo ownership 语义）→ { alphas, signs, n }。
 *   alphas: Uint8Array 0..255 强度；signs: Int8Array +1=黑领地 / -1=白领地。
 * 长度不足按 0 补齐、越界值钳制——保证上层渲染绝不越界读。
 * values 可为普通数组或 TypedArray（见 `isOwnershipVector`）。
 */
export function quantizeOwnership(values, n) {
  const size = normalizeSize(n);
  const N = size * size;
  const alphas = new Uint8Array(N);
  const signs = new Int8Array(N);
  const len = Math.min(isOwnershipVector(values) ? values.length : 0, N);
  for (let i = 0; i < len; i += 1) {
    const raw = Number(values[i]);
    const v = Number.isFinite(raw) ? Math.min(1, Math.max(-1, raw)) : 0;
    const a = Math.abs(v);
    alphas[i] = a >= 1 ? 255 : Math.round(a * 255);
    signs[i] = v >= 0 ? 1 : -1;
  }
  return { alphas, signs, n: size };
}

/** 棋盘点唯一键（占用检测 / diff）。 */
export function stoneKey(x, y) {
  return `${x},${y}`;
}

/**
 * 热力清除动作（纯函数）：有热力且允许动效 → `fade`（240ms 淡出）；
 * 无热力 / reduced-motion → `reset`（即时清除，动画全部关闭口径）。
 */
export function heatClearAction(opts = {}) {
  return opts.hasHeat && opts.motion ? 'fade' : 'reset';
}

/**
 * 前后石子集 diff（纯函数，供状态层增量动画判定）。
 * 返回 { added:[{x,y,color}], removed:[{x,y,color}] }（按出现顺序）。
 */
export function diffStones(prevStones, nextStones) {
  const prev = new Map();
  for (const s of prevStones || []) prev.set(stoneKey(s.x, s.y), s.color);
  const next = new Map();
  for (const s of nextStones || []) next.set(stoneKey(s.x, s.y), s.color);
  const added = [];
  const removed = [];
  for (const [k, color] of next) if (!prev.has(k)) {
    const [x, y] = k.split(',').map(Number);
    added.push({ x, y, color });
  }
  for (const [k, color] of prev) if (!next.has(k)) {
    const [x, y] = k.split(',').map(Number);
    removed.push({ x, y, color });
  }
  return { added, removed };
}

/**
 * 状态层失效判定（纯函数；2026/09/17 双层重构）：状态层现承载棋子 + 全部叠加标记
 * （热力/TOP5/变化图/hover 预览/键盘光标/非法 ✕）——任一相关 Prop 变更即需重绘。
 * reduceMotion/stoneMotion 变化会即时改变既有动画（清 drop）→ 同样需要一次重绘。
 */
export function stateLayerAffected(prev = {}, next = {}) {
  return (
    next.size !== prev.size
    || next.stones !== prev.stones
    || next.toMove !== prev.toMove
    || next.comments !== prev.comments
    || next.commentRing !== prev.commentRing
    || next.deadStones !== prev.deadStones
    || next.lastMarker !== prev.lastMarker
    || next.ownership !== prev.ownership
    || next.top5 !== prev.top5
    || next.variations !== prev.variations
    || next.heatVisible !== prev.heatVisible
    || next.interactive !== prev.interactive
    || next.hoverGhost !== prev.hoverGhost
    || next.reduceMotion !== prev.reduceMotion
    || next.stoneMotion !== prev.stoneMotion
  );
}

/** 静态层失效判定（纯函数）：路数 / 边沿坐标开关。 */
export function staticLayerAffected(prev = {}, next = {}) {
  return next.size !== prev.size || next.showCoordinates !== prev.showCoordinates;
}

/**
 * 指针按下处置计划（纯函数；L-9）：
 * - `press`：触摸（手势链：轻点预览/双击/平移判定，登记按压态）；
 * - `pan`：鼠标/笔且 zoom>1（登记按压态并捕获指针——移出画布释放仍回投 pointerup）；
 * - `tap`：100% 鼠标/笔（pointerdown 即时提交，**不登记按压态**——旧实现在此也登记
 *   `_drag`，指针移出画布释放后残留，后续 `if (this._drag) return` 吞掉下一次点击）。
 * @param {string} pointerType
 * @param {number} zoom
 * @returns {'press'|'pan'|'tap'}
 */
export function pointerDownPlan(pointerType, zoom) {
  if (pointerType === 'touch') return 'press';
  return Number(zoom) > 1 ? 'pan' : 'tap';
}

/** 热力是否仍在过渡（插值进行中或淡出中）——决定状态层是否继续动画帧。 */
export function heatAnimating(heat) {
  return Boolean(heat && (heat.dirty || heat.fading));
}

/**
 * TOP5 淡入是否仍在进行（纯函数）：任一徽章首次出现不足 fade 时长则为 true。
 * 尚未登记过的键按“本帧刚出现”处理（start 缺失 → busy）。
 */
export function top5FadeBusy(seen, keys, nowMs, { motion = false, fade = ANIM_MS.recommend } = {}) {
  if (motion) return false;
  for (const key of keys) {
    const start = seen.get(key);
    if (start == null || nowMs - start < fade) return true;
  }
  return false;
}

/* ============================================================
 * 工具（类内部共用，纯函数）
 * ============================================================ */

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function easeOutCubic(t) {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/* ============================================================
 * GameBoard 组件
 * ============================================================ */

/**
 * 双层 Canvas 棋盘（静态层 + 状态层；全部叠加标记并入状态层按需重绘）。
 *
 * @param {HTMLElement} containerEl 棋盘容器（需为正方形、含木纹背景——
 *   生产环境即 `.board-wrap`，由 CSS var(--board-bg) 提供榧木/檀木底）。
 * @param {object} [props]
 * @param {number} [props.size=19]                路数 9|13|19
 * @param {"black"|"white"} [props.toMove="black"] 当前执色（ghost/播报用）
 * @param {Array<{x:number,y:number,color:"black"|"white",moveNo?:number,isLast?:boolean}>} [props.stones=[]] 状态层棋子
 * @param {Array<{x:number,y:number,grade:string,comment?:string,deltaW?:number,deltaS?:number}>} [props.comments=[]] 点评色环
 * @param {Array<{x:number,y:number,rank:number}>} [props.top5=[]] 叠加标记：推荐徽章（rank 1..5）
 * @param {Array<{x:number,y:number}>} [props.deadStones=[]]     死子 ✕
 * @param {Array<{x:number,y:number}>} [props.variations=[]]     变化图序列
 * @param {number[]|Float32Array|{alphas:Uint8Array,signs:Int8Array,n:number}|null} [props.ownership=null] 领地热力（原始 [-1,1] 或已量化）
 * @param {boolean} [props.showCoordinates=true]  边沿坐标标签
 * @param {"dot"|"ring"|"none"} [props.lastMarker="dot"] 当前手标记：反色圆点(dot)/反色中心圆环(ring)/无
 * @param {boolean} [props.interactive=false]     允许点击落子/hover/键盘
 * @param {boolean} [props.hoverGhost=true]       hover 幽灵子（结算死子标记模式置 false，避免空点预览误导）
 * @param {"black"|"white"} [props.dropUpColor="black"] 落子动画方向：“由下到上”的一方（人机＝人类方 / 人人＝黑方，视图经 `dropUpSide` 派生；2026/09/13）
 * @param {boolean} [props.readonly=false]        readonly=true ⇒ interactive=false
 * @param {boolean} [props.engineDead=false]      引擎 DEAD：容器加 .board-dead（降饱和）
 * @param {boolean} [props.heatVisible=true]      领地热力可见（含平滑入场）
 * @param {boolean} [props.announceMoves=true]    落子/非法/选点是否 aria-live 播报
 * @param {string} [props.ariaLabel]              读屏标签（缺省 `${n} 路棋盘`）
 * @param {boolean} [props.reduceMotion]          reduced-motion（缺省读 matchMedia）
 * @param {boolean} [props.stoneMotion]           落子动画开关（缺省读设置/管理页偏好；默认开）
 * @param {boolean} [props.observeTheme=true]     监听 html data-theme/data-accent 变化整体重绘（两层）
 * @param {(x:number,y:number)=>void} [props.onIntersection] 点击/Enter 落子（坐标化）
 * @param {({x,y,color})|null=>void} [props.onHover] hover 交叉点变化
 * @param {({x,y})=>void} [props.onSelectStone]   点击已占用点（如点评气泡；触摸经 pointerup 纯轻点判定后触发，BUG-105）
 * @param {()=>void} [props.onBlankTap]           轻点空白（空交叉点首次轻点 / 网格外留白）——
 *   触摸下首点不落子、也不会进 onIntersection，宿主需此回调收起瞬态 UI（如点评气泡；2026/09/15）
 * @param {(view:{left:number,top:number,size:number,zoom:number})=>void} [props.onViewChange] 视角变化
 *   （缩放 / 平移 / 容器尺寸，rAF 合并）——宿主据此重算依赖棋盘方形几何的覆盖层
 *   （如左上角提示的半透明降级，2026/09/24）
 * @param {({x,y})=>void} [props.onCursor]        键盘光标变化
 */
export class GameBoard {
  constructor(containerEl, props = {}) {
    if (!containerEl || typeof containerEl.appendChild !== 'function') {
      throw new Error('GameBoard: 需要传入 DOM 容器元素');
    }
    this.el = containerEl;
    this._raf = 0;
    this._destroyed = false;

    // —— 双层 Canvas（静态层 + 状态层；原动态层已并入状态层，2026/09/17）——
    this._layers = {};
    for (const name of ['static', 'state']) {
      const canvas = document.createElement('canvas');
      canvas.className = `tgo-layer tgo-${name}`;
      canvas.setAttribute('aria-hidden', 'true');
      this.el.appendChild(canvas);
      this._layers[name] = { canvas, ctx: canvas.getContext('2d') };
    }

    // —— 键盘焦点面（读屏替代）——
    this._focusEl = document.createElement('div');
    this._focusEl.className = 'tgo-board-focus';
    this._focusEl.tabIndex = 0;
    this._focusEl.setAttribute('role', 'img');
    this.el.appendChild(this._focusEl);

    // —— aria-live 播报区（视觉隐藏，读屏可用）——
    this._liveEl = document.createElement('div');
    this._liveEl.className = 'sr-only';
    this._liveEl.setAttribute('role', 'status');
    this._liveEl.setAttribute('aria-live', 'polite');
    this.el.appendChild(this._liveEl);

    // —— 模型状态 ——
    this._props = {};
    this._colors = null;
    this._geom = null;
    this._dpr = 1;
    this._surface = null; // 木料面几何（容器整幅 × zoom；方案 B，2026/09/22）
    this._grainPlan = null; // 木纹 plan 缓存（键＝面尺寸 + cell）
    this._grainKey = '';
    this._dirty = { static: true, state: true };
    this._ghost = null; // {x,y,ok}
    this._cursor = null; // {x,y}
    this._illegal = null; // {x,y}（400ms 后由 _illegalTimer 清除，2026/09/17）
    this._illegalTimer = 0;
    this._anims = { drops: [], captures: [] };
    this._flyingKeys = null; // 本帧飞行落子键集合（抑制空中子的当前手标记）
    this._heat = null; // { alphas, signs, target:Float32Array, cur:Float32Array, dirty:bool }
    this._top5Seen = new Map(); // key → 首次渲染时刻（fade-in）
    this._ringFx = new Map(); // 点评色环淡入/淡出：key → {type:'in'|'out',start,data}
    this._motion = false; // reduced-motion 偏好（构造即解析一次）
    this._dropMotion = true; // 落子动画允许位（reduced-motion / 管理页开关关闭时为 false）
    this._resolveMotionPref();

    // —— 棋盘缩放（仅放大棋盘/棋子，不放大页面其它元素）——
    this._zoom = 1; // 当前缩放（BOARD_ZOOM.min..max）
    this._view = { surf: 0, left: 0, top: 0 }; // 画布边长 & 相对容器 left/top（CSS px）
    this._touches = new Map(); // pointerId → {x,y}（双指捏合用）
    this._drag = null; // 单指手势 {id,x0,y0,left0,top0,moved,zoom}
    this._pinch = null; // 双指捏合 {ids:Set,dist,zoom0}
    this._dbl = null; // 触摸轻点记录 {x,y,at}（同一空点 320ms 内二次轻点＝落子）
    this._pendingTap = null; // 触摸待定提交 {id,kind:'select'|'place',x,y}（pointerup 手势判定后提交，BUG-105）
    this._tapFallbackTimer = 0; // 待定提交的交付兜底计时器（iOS 缺失 up/click 时仍可提交）
    this._layoutPending = false; // rAF 合并布局重栅格
    this._layoutTimer = null; // rAF 停摆时的兜底定时器
    this._raster = null; // 上次实际栅格化的布局指纹（BUG-096：幂等判定基准）
    this._viewRaf = 0; // 视角变化通知的 rAF 句柄（缩放/平移合并，见 _emitViewChange）

    // —— 事件绑定 ——
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onPointerLeave = this._handlePointerLeave.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onClick = this._handleClick.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onFocus = () => {
      if (this._props.interactive && !this._cursor) {
        this._cursor = this._props.stones && this._props.stones.length
          ? null
          : { x: Math.floor(this._props.size / 2), y: Math.floor(this._props.size / 2) };
        if (this._cursor) {
          this._emitCursor();
          this._invalidate('state');
        }
      }
    };

    // 交互面＝最上层画布（原动态层已并入状态层）；指针/滚轮/捏合事件由该面接管
    this._pointerTarget = this._layers.state.canvas;
    this._pointerTarget.addEventListener('pointerdown', this._onPointerDown);
    this._pointerTarget.addEventListener('pointermove', this._onPointerMove);
    this._pointerTarget.addEventListener('pointerup', this._onPointerUp);
    this._pointerTarget.addEventListener('pointercancel', this._onPointerUp);
    this._pointerTarget.addEventListener('pointerleave', this._onPointerLeave);
    this._pointerTarget.addEventListener('wheel', this._onWheel, { passive: false });
    // click 兜底（BUG-105 恢复接线）：iOS Safari 偶发在触摸 pointerdown 后不派发
    // pointerup——待定轻点（已占点选择/双击落子）由 click 补提交（见 _handleClick）。
    this._pointerTarget.addEventListener('click', this._onClick);
    this._focusEl.addEventListener('keydown', this._onKeyDown);
    this._focusEl.addEventListener('focus', this._onFocus);

    // 触摸轻点预览（幽灵子）失效清理（2026/09/13 人工反馈）：移动端轻点空点＝预览，
    // 仅同一空点快速二次轻点才落子；若下一个动作不是“继续落子”（按钮/滑轨/菜单/弹层
    // 等板外交互，例：点 [下一手]），预览幻影与双击判定必须立即失效——统一在
    // 文档捕获阶段监听 pointerdown，板内事件交给板内手势逻辑。
    this._onDocPointerDown = (evt) => {
      if (!this._ghost && !this._dbl) return;
      if (!isOutsideBoard(evt && evt.target, this.el)) return;
      this._resetTouchMarkers();
    };
    document.addEventListener('pointerdown', this._onDocPointerDown, true);

    // —— 尺寸 / 主题观察 ——
    this._ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this._scheduleLayout()) : null;
    if (this._ro) this._ro.observe(this.el);
    this._mo = null;

    this._loop = this._loop.bind(this);
    this.setProps(props);
    this._scheduleLayout();
    this._ensureFrame(); // 首帧（_scheduleLayout 已标脏；此处兜底尺寸未就绪场景）
    // 构造完成门闩：构造阶段不立即重绘（此时 props.stones 往往尚未注入，主线程
    // 同帧提交会短暂呈现空盘）；构造后（RO/缩放/路数变化）重栅格一律同帧重绘
    // （BUG-096：消除 ResizeObserver 空窗帧）。
    this._ready = true;
  }

  /* ---------------- 公共 API ---------------- */

  /** 合并 Props 并做层失效：聚合判定静态/状态层脏标记（叠加标记随状态层），按需申请帧。 */
  setProps(patch = {}) {
    const prev = this._props;
    const next = { ...this._props, ...patch };

    // 归一关键字段
    next.size = normalizeSize(next.size ?? 19);
    next.toMove = next.toMove === 'white' ? 'white' : 'black';
    next.stones = Array.isArray(next.stones) ? next.stones : [];
    next.comments = Array.isArray(next.comments) ? next.comments : [];
    next.commentRing = next.commentRing !== false;
    next.top5 = Array.isArray(next.top5) ? next.top5 : [];
    next.deadStones = Array.isArray(next.deadStones) ? next.deadStones : [];
    next.variations = Array.isArray(next.variations) ? next.variations : [];
    next.readonly = Boolean(next.readonly);
    next.interactive = Boolean(next.interactive) && !next.readonly;
    next.hoverGhost = next.hoverGhost !== false;
    // 落子动画方向：“由下到上”的一方（人机＝人类方 / 人人＝黑方；2026/09/13 人工口径）
    next.dropUpColor = next.dropUpColor === 'white' ? 'white' : 'black';
    next.showCoordinates = next.showCoordinates !== false;
    next.lastMarker = ['dot', 'ring', 'none'].includes(next.lastMarker) ? next.lastMarker : 'dot';
    next.heatVisible = next.heatVisible !== false;
    next.announceMoves = next.announceMoves !== false;
    if (next.reduceMotion !== prev.reduceMotion || next.stoneMotion !== prev.stoneMotion) {
      // 传 next：setProps 内 this._props 尚未提交，若读 this._props 会滞后一次提交（2026/09/17 修正）
      this._resolveMotionPref(next);
      if (!this._dropMotion) this._anims.drops = []; // 关闭/降级 → 即时落定
    }

    // 尺寸变化 → 热力/瞬态标记失效；几何须立即重算（容器未变，ResizeObserver
    // 不会触发，否则网格仍按旧路数绘制）；层失效统一由下方聚合判定负责
    const sizeChanged = prev.size !== undefined && next.size !== prev.size;
    if (sizeChanged) {
      this._resetHeat();
      this._cursor = null;
      this._ghost = null;
    }
    // 棋子变化 → 状态层；增量动画仅限「小步变更」（≤2 子且非整盘装载），
    // 避免 restore/game.state 整盘重建时数百子同时 drop 造成视觉噪音
    if (next.stones !== prev.stones) {
      const diff = diffStones(prev.stones, next.stones);
      const hadPrev = Array.isArray(prev.stones) && prev.stones.length > 0;
      const smallAdd = diff.added.length > 0 && diff.added.length <= 2
        && (hadPrev || diff.added.length === 1);
      // 方向取 next（本次 patch 后的值）——否则同一次 setProps 内改 dropUpColor 会用旧值
      if (smallAdd) {
        this._queueDrops(diff.added, next.dropUpColor);
        // 落子播报（aria-live，UI_UX §6.8）：仅真实增量（整盘装载/restore 不播报）；
        // 手数取自 stones（core/game-model.replayStones 已写入 moveNo）；与动效无关。
        if (next.announceMoves) {
          const prevKeys = new Set((prev.stones || []).map((s) => stoneKey(s.x, s.y)));
          const addedFull = next.stones.filter((s) => !prevKeys.has(stoneKey(s.x, s.y)));
          const newest = addedFull[addedFull.length - 1];
          if (newest) this.announce(moveAnnouncementText(newest, next.size));
        }
      }
    }
    if (next.comments !== prev.comments) {
      this._queueCommentFx(prev.comments, next.comments);
    }
    if (next.ownership !== prev.ownership) {
      this._setOwnership(next.ownership, next.size);
    }
    if (next.engineDead !== prev.engineDead) {
      this.el.classList.toggle('board-dead', Boolean(next.engineDead));
    }
    if (next.interactive !== prev.interactive) {
      this._cursor = null;
      this._ghost = null;
    }
    if (next.hoverGhost !== prev.hoverGhost && !next.hoverGhost) {
      this._ghost = null;
    }

    // 主题观察（一次性）
    if (next.observeTheme !== false && !this._mo && typeof MutationObserver !== 'undefined') {
      // 主题/主题色切换 → refresh()：色板（`_colors`）由 CSS token 驱动，**静态层与状态层都要
      // 重绘**——叠加标记（TOP5 徽章＝`--accent` 圆底 + `--accent-contrast` 序号、键盘光标圈）
      // 与静态层共用同一份色板，只失效静态层会让状态层像素停在旧主题色，直到下一次无关的
      // 状态失效（鼠标移动 → hover 幽灵）才被动更新（2026/09/24 人工反馈：支招/TOP N 配色
      // 「要把鼠标移到棋盘上才更新」）。
      this._mo = new MutationObserver(() => this.refresh());
      this._mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-accent'],
      });
    }

    // —— 层失效（聚合判定；防“每帧重绘”撤销后出现遗漏，2026/09/17）——
    if (staticLayerAffected(prev, next)) this._dirty.static = true;
    if (stateLayerAffected(prev, next)) this._dirty.state = true;

    this._props = next;
    this._updateAria();
    if (sizeChanged) this._scheduleLayout();
    if (this._dirty.static || this._dirty.state) this._ensureFrame();
    // 推导当前手键：优先 isLast 标记，否则取 moveNo 最大的一子（视图常用 moveNo 表达）
    this._lastKey = null;
    let bestNo = -1;
    for (const s of next.stones) {
      if (s.isLast) {
        this._lastKey = stoneKey(s.x, s.y);
        break;
      }
      if (s.moveNo != null && s.moveNo > bestNo) {
        bestNo = s.moveNo;
        this._lastKey = stoneKey(s.x, s.y);
      }
    }
    return this;
  }

  /** 便利：整盘替换棋子（restore/悔棋/回放跳转，无逐子动画）。 */
  setStones(stones) {
    return this.setProps({ stones });
  }

  /**
   * 交点 → 相对棋盘容器（``this.el``）的 CSS 像素坐标（点评气泡等 DOM 覆盖层定位用）。
   * 含缩放/平移（``_view``）；几何未就绪 → null。
   */
  pointOffset(x, y) {
    const m = this._geom;
    if (!m) return null;
    const p = this._point(x, y);
    return {
      left: this._view.left + p.px,
      top: this._view.top + p.py,
      surface: this._view.surf,
      cell: m.cell,
      stoneR: m.stoneR,
    };
  }

  /**
   * 便利：落一手（追加棋子 + drop 动画，供视图 move.applied 调用）。
   * move: {x,y,color,isPass?}; pass 仅更新（无棋子）。
   */
  applyMove(move) {
    if (!move || move.isPass || move.x == null || move.y == null) return this;
    // 清除旧 isLast（避免多子同时带标记导致当前手误判），再落新子并标 isLast
    const stones = this._props.stones
      .filter((s) => !(s.x === move.x && s.y === move.y))
      .map((s) => (s.isLast ? { ...s, isLast: false } : s));
    stones.push({
      x: Number(move.x),
      y: Number(move.y),
      color: move.color === 'white' ? 'white' : 'black',
      moveNo: move.moveNo,
      isLast: true,
    });
    return this.setProps({ stones });
  }

  /** 便利：动画式移除一子（提子/悔棋残影），capture=true 播放 150ms 残影。 */
  removeStone(x, y, { capture = false } = {}) {
    const found = this._props.stones.find((s) => s.x === x && s.y === y);
    const stones = this._props.stones.filter((s) => !(s.x === x && s.y === y));
    const r = this.setProps({ stones });
    if (capture && found) {
      // setProps 对移除不做残影（restore/悔棋不应播放提子动画），此处显式触发
      this._queueCaptures([{ x, y, color: found.color }]);
    }
    return r;
  }

  /** 设置当前执色。 */
  setToMove(color) {
    return this.setProps({ toMove: color });
  }

  /** 设置热力数据（原始或已量化），可传 null 清除。 */
  setOwnership(raw) {
    return this.setProps({ ownership: raw });
  }

  /** 切换热力显示（含平滑淡入）。 */
  setHeatVisible(visible) {
    return this.setProps({ heatVisible: Boolean(visible) });
  }

  /** 非法落子红色 ✕ 闪现（400ms，UI_UX §6.3；到期由定时器清除并重绘，2026/09/17）。 */
  flashIllegal(x, y) {
    if (this._props.reduceMotion == null) this._resolveMotionPref();
    if (this._illegalTimer) {
      clearTimeout(this._illegalTimer);
      this._illegalTimer = 0;
    }
    if (this._motion) {
      // reduced-motion：✕ 即时（不可见），与原「dur=0」语义一致；清掉可能残留的旧 ✕
      if (this._illegal) {
        this._illegal = null;
        this._invalidate('state');
      }
    } else {
      this._illegal = { x, y };
      this._invalidate('state');
      this._illegalTimer = setTimeout(() => {
        this._illegalTimer = 0;
        if (this._destroyed) return;
        this._illegal = null;
        this._invalidate('state');
      }, ANIM_MS.illegal);
    }
    if (this._props.announceMoves) {
      const gtp = gtpOf(x, y, this._props.size);
      this.announce(`禁止落子 ${gtp}`);
    }
  }

  /** 读屏播报（内部 live 区）。 */
  announce(text) {
    if (!text || this._destroyed) return;
    this._liveEl.textContent = '';
    // 先清空再写入，保证相同文本重复播报（读屏技巧）
    requestAnimationFrame(() => {
      if (!this._destroyed) this._liveEl.textContent = text;
    });
  }

  /** 整体重绘（尺寸/主题已变时调用；通常由观察器自动处理）。 */
  refresh() {
    this._colors = null;
    this._dirty.static = true;
    this._dirty.state = true;
    this._scheduleLayout();
    this._ensureFrame();
    return this;
  }

  /** 让键盘焦点落于棋盘（供视图 Esc/落子后回焦）。 */
  focus() {
    this._focusEl.focus({ preventScroll: true });
  }

  /** 销毁：停 rAF、断观察器、清监听与 DOM。 */
  destroy() {
    this._destroyed = true;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (this._illegalTimer) {
      clearTimeout(this._illegalTimer);
      this._illegalTimer = 0;
    }
    if (this._layoutTimer) {
      clearTimeout(this._layoutTimer);
      this._layoutTimer = null;
    }
    if (this._viewRaf) {
      cancelAnimationFrame(this._viewRaf);
      this._viewRaf = 0;
    }
    this._dbl = null;
    this._pendingTap = null;
    this._clearTapFallback();
    if (this._ro) this._ro.disconnect();
    if (this._mo) this._mo.disconnect();
    this._pointerTarget.removeEventListener('pointerdown', this._onPointerDown);
    this._pointerTarget.removeEventListener('pointermove', this._onPointerMove);
    this._pointerTarget.removeEventListener('pointerup', this._onPointerUp);
    this._pointerTarget.removeEventListener('pointercancel', this._onPointerUp);
    this._pointerTarget.removeEventListener('pointerleave', this._onPointerLeave);
    this._pointerTarget.removeEventListener('wheel', this._onWheel);
    this._pointerTarget.removeEventListener('click', this._onClick);
    this._focusEl.removeEventListener('keydown', this._onKeyDown);
    this._focusEl.removeEventListener('focus', this._onFocus);
    if (this._onDocPointerDown) {
      document.removeEventListener('pointerdown', this._onDocPointerDown, true);
      this._onDocPointerDown = null;
    }
    for (const { canvas } of Object.values(this._layers)) {
      if (canvas.parentNode === this.el) this.el.removeChild(canvas);
    }
    if (this._focusEl.parentNode === this.el) this.el.removeChild(this._focusEl);
    if (this._liveEl.parentNode === this.el) this.el.removeChild(this._liveEl);
    this.el.classList.remove('board-dead');
    this._layers = {};
    this._sprite = null;
    this._props = {};
  }

  /* ---------------- 内部：输入 ---------------- */

  _metrics() {
    const vw = this.el.clientWidth || 0;
    const vh = this.el.clientHeight || 0;
    const dpr = Math.max(1, ((typeof window !== 'undefined' && window.devicePixelRatio) || 1) || 1);
    return { vw, vh, dpr };
  }

  _wrapRect() {
    const r = this.el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: this.el.clientWidth || 0, h: this.el.clientHeight || 0 };
  }

  /** 缩放/尺寸变化的重栅格合并：同一帧内多次调用只布局一次（双指连续捏合尤其需要）。
   *  集成浏览器/后台标签 rAF 可能停摆 → 附 60ms 定时器兜底，保证任何环境最终执行。 */
  _requestLayout() {
    if (this._layoutPending) return;
    this._layoutPending = true;
    const run = () => {
      if (!this._layoutPending) return;
      this._layoutPending = false;
      if (this._layoutTimer) {
        clearTimeout(this._layoutTimer);
        this._layoutTimer = null;
      }
      this._scheduleLayout();
    };
    if (typeof requestAnimationFrame === 'function') {
      const raf = requestAnimationFrame(run);
      this._layoutTimer = setTimeout(() => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        run();
      }, 60);
    } else {
      run();
    }
  }

  /** 布局：按 zoom 计算画布边长/平移并重栅格（棋子/网格随缩放以更高分辨率重绘，不发虚）。
   *
   *  2026/09/22（方案 B）：**静态层＝木料面**（容器整幅 × zoom，矩形），棋盘（网格/坐标）
   *  画在面中央的正方形区域内；状态层（棋子/叠加标记）仍为正方形并照旧居中/平移。
   *  两层的映射一致（屏幕 = 层位置 + zoom × 基础坐标）→ 木纹与棋盘严格贴合同一张面。
   *
   *  指纹未变（重复 observe、同尺寸 RO 回调）→ 直接返回，不重栅格不重绘；
   *  变化时重栅格完成后**同一任务内立即重绘**（BUG-096）：ResizeObserver 回调处于
   *  渲染帧绘制之前，若把重绘推迟到下一 rAF，会提交一帧“画布已清空”的空棋盘；
   *  移动端进入复盘后布局多次收敛（URL 栏/字体度量/换行）→ 棋面多次闪烁。 */
  _scheduleLayout() {
    const { vw, vh, dpr } = this._metrics();
    if (!vw || !vh) return;
    const v = Math.min(vw, vh);
    const surf = Math.max(1, v * this._zoom);
    const clamped = clampBoardView(this._view.left, this._view.top, surf, vw, vh);
    // 画布位置吸附到设备像素（BUG-007 在缩放后回归的修复，2026/09/22）
    const { left, top } = snapBoardPos(clamped.left, clamped.top, { surf, vw, vh, dpr });
    const surface = woodSurfaceLayout({
      vw, vh, zoom: this._zoom, boardLeft: left, boardTop: top, dpr,
    });
    const bw = Math.max(1, Math.round(surf * dpr));
    const bh = Math.max(1, Math.round(surface.w * dpr));
    const bhh = Math.max(1, Math.round(surface.h * dpr));
    const candidate = {
      surf, left, top, dpr, bw, bh, size: this._props.size,
      sw: surface.w, sh: surface.h, sl: surface.left, st: surface.top,
    };
    if (!layoutRasterChanged(this._raster, candidate)) return;
    this._dpr = dpr;
    this._view.surf = surf;
    this._view.left = left;
    this._view.top = top;
    this._surface = surface;
    this._geom = layoutForSize(this._props.size, surf);

    /**
     * 单层栅格化与定位（内联样式覆盖 .tgo-layer 的 margin:auto 居中/max-width 上限）。
     * 显示尺寸取「设备尺寸 ÷ dpr」而非几何边长——否则显示尺寸与背衬不是 1:dpr 关系，
     * 合成时整层被缩放重采样（同样发虚；2026/09/22）。几何仍用 `surf`（差值 ≤ 0.5 设备像素）。
     */
    const place = (name, devW, devH, l, t) => {
      const { canvas } = this._layers[name];
      if (canvas.width !== devW || canvas.height !== devH) {
        canvas.width = devW;
        canvas.height = devH;
      }
      const s = canvas.style;
      s.width = `${devW / dpr}px`;
      s.height = `${devH / dpr}px`;
      s.maxWidth = 'none';
      s.maxHeight = 'none';
      s.left = '0px';
      s.top = '0px';
      s.right = 'auto';
      s.bottom = 'auto';
      s.margin = '0px';
      s.transform = `translate(${l}px, ${t}px)`;
    };
    // 状态层：正方形（棋子/标记）；静态层：木料面（整幅）
    place('state', bw, bw, left, top);
    place('static', bh, bhh, surface.left, surface.top);
    this._raster = candidate;
    this._dirty.static = true;
    this._dirty.state = true;
    this._resetSprites();
    this._drawNow(); // 重栅格与重绘同一任务提交（BUG-096：消除空窗帧）
    this._emitViewChange(); // 缩放/容器尺寸变化 → 通知宿主重算棋盘几何相关覆盖层
  }

  /**
   * 立即绘制脏层并与重栅格同帧提交（BUG-096）：重栅格（`canvas.width=` 会清空画布）
   * 后同步重绘，浏览器本帧合成即为完整棋面——不再存在“已清空未重绘”的中间帧。
   * 构造阶段（`_ready` 未置位）不绘制：此时 stones 常未注入，同帧提交会短暂呈现空盘；
   * 绘制后若仍有动画脏标记（下落/残影/热力/TOP5 等）则保留已排帧，否则取消空转帧。
   */
  _drawNow() {
    if (this._destroyed || !this._geom || !this._ready) return;
    if (this._dirty.static) this._drawStatic();
    if (this._dirty.state) this._drawState();
    if (this._raf && !this._dirty.static && !this._dirty.state) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  /** 仅平移（不重栅格）：更新各画布 transform（木料面随棋盘同向平移、外扩留白×zoom）。
   *  位置同样吸附到设备像素（见 snapBoardPos；拖拽期间逐帧调用，不得让层偏移落到小数）。 */
  _panTo(left, top) {
    const { vw, vh, dpr } = this._metrics();
    const surf = this._view.surf;
    const clamped = clampBoardView(left, top, surf, vw, vh);
    const { left: L, top: T } = snapBoardPos(clamped.left, clamped.top, { surf, vw, vh, dpr });
    this._view.left = L;
    this._view.top = T;
    const surface = woodSurfaceLayout({
      vw, vh, zoom: this._zoom, boardLeft: L, boardTop: T, dpr,
    });
    this._surface = surface;
    this._layers.state.canvas.style.transform = `translate(${L}px, ${T}px)`;
    this._layers.static.canvas.style.transform =
      `translate(${surface.left}px, ${surface.top}px)`;
    this._emitViewChange(); // 拖拽平移 → 棋盘方形位置变化，通知宿主重算
  }

  /** 以“相对容器”锚点 (ax,ay) 为不动点缩放至 z（rAF 合并重栅格；锚点处局面保持不漂移）。 */
  _applyZoomAt(z, ax, ay) {
    const { vw, vh } = this._metrics();
    const zz = clampZoom(z);
    const surf = Math.max(1, Math.min(vw, vh) * zz);
    const old = this._view;
    const ratioX = old.surf > 0 ? (ax - old.left) / old.surf : 0;
    const ratioY = old.surf > 0 ? (ay - old.top) / old.surf : 0;
    this._zoom = zz;
    const { left, top } = clampBoardView(ax - ratioX * surf, ay - ratioY * surf, surf, vw, vh);
    this._view.surf = surf;
    this._view.left = left;
    this._view.top = top;
    this._requestLayout();
  }

  /** 公开：缩放至 z（自动钳制）；ax/ay 为相对容器锚点，缺省=容器中心。 */
  setZoom(z, ax, ay) {
    const { vw, vh } = this._metrics();
    this._applyZoomAt(z, ax == null ? (vw || 0) / 2 : ax, ay == null ? (vh || 0) / 2 : ay);
  }

  /**
   * 「棋盘左上角提示」是否落在棋盘盘面内（宿主页调用；2026/09/22 修复，2026/09/24 简化）。
   *
   * 用**棋盘自身**的几何判定：正方形＝当前 zoom 后的画布（边长 `view.surf`、位置
   * `view.left/top`）——矩形容器下棋盘居中于木料面、缩放/拖拽后位置还会变，宿主页
   * 不得按“贴容器左上角 + 边长＝容器宽”推导。判定口径＝矩形与棋盘方形相交即降级。
   * 视角变化（缩放/平移/容器尺寸）经 `onViewChange` 通知宿主重算，见 `_emitViewChange`。
   * @param {{left:number,top:number,right:number,bottom:number}} rect 提示矩形（相对容器，CSS px）
   * @returns {boolean}
   */
  noteOverlaps(rect) {
    if (!rect || !this._geom) return false;
    return noteOverlapsBoard(rect, {
      left: this._view.left,
      top: this._view.top,
      size: this._view.surf,
    });
  }

  /**
   * 视角变化通知（缩放/平移/容器尺寸后棋盘方形的位置或边长改变）——宿主据此重算依赖
   * 棋盘几何的覆盖层（如左上角提示的半透明降级）；rAF 合并：连续捏合/拖拽一帧最多通知
   * 一次，且回调内只做纯几何比较（提示矩形由宿主缓存），不引入强制重排。
   */
  _emitViewChange() {
    if (typeof this._props.onViewChange !== 'function') return;
    if (this._viewRaf) return;
    if (typeof requestAnimationFrame !== 'function') {
      this._notifyViewChange();
      return;
    }
    this._viewRaf = requestAnimationFrame(() => {
      this._viewRaf = 0;
      if (!this._destroyed) this._notifyViewChange();
    });
  }

  _notifyViewChange() {
    const cb = this._props.onViewChange;
    if (typeof cb !== 'function' || this._destroyed) return;
    cb({
      left: this._view.left,
      top: this._view.top,
      size: this._view.surf,
      zoom: this._zoom,
    });
  }

  /** 当前缩放倍数。 */
  getZoom() {
    return this._zoom;
  }

  /** 复位到 100% 并居中。 */
  resetView() {
    this._zoom = 1;
    this._requestLayout();
  }

  _now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** rAF 按需调度（2026/09/17）：仅当存在待绘制脏层/进行中动画时申请下一帧；空闲零唤醒。 */
  _ensureFrame() {
    if (this._destroyed || this._raf) return;
    this._raf = requestAnimationFrame(this._loop);
  }

  /** 标脏并申请帧（layer: "static" | "state"）。 */
  _invalidate(layer = 'state') {
    this._dirty[layer] = true;
    this._ensureFrame();
  }

  _resolveMotionPref(pref = this._props) {
    const p = pref || {};
    this._motion =
      p.reduceMotion !== undefined && p.reduceMotion !== null
        ? Boolean(p.reduceMotion)
        : typeof window !== 'undefined'
          && window.matchMedia
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 落子动画：reduced-motion 或管理页关闭 → 直接落定；prop 优先，缺省读设置
    this._dropMotion =
      !this._motion
      && (p.stoneMotion === undefined || p.stoneMotion === null
        ? stoneMotionEnabled()
        : Boolean(p.stoneMotion));
  }

  _emitCursor() {
    if (typeof this._props.onCursor === 'function' && this._cursor) {
      this._props.onCursor({ x: this._cursor.x, y: this._cursor.y });
    }
  }

  /** 交互悬停光标：可落子空交点 → pointer（手形）；棋子/盘外 → 默认箭头。 */
  _syncCursor(pt) {
    if (!this._pointerTarget) return;
    let cur = '';
    if (this._props.interactive && pt) {
      const occupied = this._props.stones.some((s) => s.x === pt.x && s.y === pt.y);
      if (!occupied) cur = 'pointer';
    }
    if (this._pointerTarget.style.cursor !== cur) this._pointerTarget.style.cursor = cur;
  }

  /** 指针事件相对棋盘画布（CSS px）坐标（画布可能已平移/放大——rect 已含 transform）。 */
  _eventXY(evt) {
    const rect = this._pointerTarget.getBoundingClientRect();
    return { px: evt.clientX - rect.left, py: evt.clientY - rect.top };
  }

  _pointerClient(evt) {
    return { x: evt.clientX, y: evt.clientY };
  }

  _isOccupied(pt) {
    return this._props.stones.some((s) => s.x === pt.x && s.y === pt.y);
  }

  /** 在空交叉点提交落子（鼠标单击 / 触摸双击共用）。 */
  _placeAt(pt) {
    const hadCursor = Boolean(this._cursor); // 键盘选点圈可能可见需清除
    this._cursor = pt;
    this._emitCursor();
    if (typeof this._props.onIntersection === 'function') this._props.onIntersection(pt.x, pt.y);
    // 落子提交后清除选点圈（避免残留在刚落的子上）；方向键可再次建立
    this._cursor = null;
    if (hadCursor) this._invalidate('state');
  }

  /** 清触摸轻点状态：双击记录 / 幽灵预览 / 待定提交（转捏合/平移、板外轻点、手势取消等）。 */
  _resetTouchMarkers() {
    this._dbl = null;
    this._pendingTap = null; // 待定提交一并不作数（BUG-105：捏合/平移首指不得已提交）
    this._clearTapFallback();
    if (this._ghost) {
      this._ghost = null;
      this._invalidate('state');
    }
  }

  /** 捕获指针（仅拖拽/捏合真正开始时调用；不提前捕获以免影响 iOS 触摸的 tap/click）。 */
  _capturePointer(evt) {
    try {
      const el = this._pointerTarget;
      if (el.setPointerCapture && !el.hasPointerCapture(evt.pointerId)) {
        el.setPointerCapture(evt.pointerId);
      }
    } catch {
      /* 部分环境不支持捕获，忽略 */
    }
  }

  /**
   * 落子/选点提交（鼠标语义，原 pointerdown 行为）：
   * 已占点 → 单击 onSelectStone；空点 → _placeAt（鼠标单击 / 100% 零延迟）。
   */
  _commitTap(evt) {
    if (!this._props.interactive) return;
    const g = this._geom;
    if (!g) return;
    const { px, py } = this._eventXY(evt);
    const pt = pxToXY(g, px, py);
    if (!pt) return;
    if (this._isOccupied(pt)) {
      if (typeof this._props.onSelectStone === 'function') this._props.onSelectStone(pt);
      return;
    }
    this._placeAt(pt);
  }

  /**
   * click 兜底（BUG-105 恢复接线）：iOS Safari 偶发在 touch pointerdown 后不派发
   * pointerup（tap 会派生 click）。待定轻点（已占点选择/双击落子）改由 pointerup 手势
   * 判定提交后，本兜底是其可靠性保险：click 到达且待定未清 → 补提交并同步清理
   * touches/drag 簿记（防残留把下一次轻点误判为「双指」）；正常时序（up 先到）空操作。
   */
  _handleClick() {
    const pending = this._takePendingTap();
    if (!pending) return;
    this._touches.clear();
    this._drag = null;
    this._commitPendingTap(pending);
  }

  /** 取出并清除待定轻点（连同交付兜底计时器；多处提交/废弃路径共用）。 */
  _takePendingTap() {
    const pending = this._pendingTap;
    this._pendingTap = null;
    this._clearTapFallback();
    return pending;
  }

  /**
   * 待定轻点交付兜底（iOS 缺失 up/click 时的最后防线，BUG-105）：
   * 窗口内未被提交/废弃（捏合、平移、取消、板外交互等都会经 `_resetTouchMarkers`
   * 或 `_takePendingTap` 清计时器）→ 按纯轻点提交。正常时序下 up 先到，本计时器不参与。
   */
  _armTapFallback(pointerId) {
    this._clearTapFallback();
    this._tapFallbackTimer = setTimeout(() => {
      this._tapFallbackTimer = 0;
      const pending = this._takePendingTap();
      if (pending && pending.id === pointerId) this._commitPendingTap(pending);
    }, TOUCH_TAP_FALLBACK_MS);
  }

  _clearTapFallback() {
    if (this._tapFallbackTimer) {
      clearTimeout(this._tapFallbackTimer);
      this._tapFallbackTimer = 0;
    }
  }

  /** 提交触摸待定轻点（手势已判定为纯轻点；BUG-105）：select=已占点选择，place=双击落子。 */
  _commitPendingTap(pending) {
    this._resetTouchMarkers(); // 轻点完成：清幽灵预览与双击记录
    if (!this._props.interactive) return;
    if (pending.kind === 'place') {
      this._placeAt({ x: pending.x, y: pending.y });
      return;
    }
    if (typeof this._props.onSelectStone === 'function') {
      this._props.onSelectStone({ x: pending.x, y: pending.y });
    }
  }

  /**
   * 触摸轻点（触摸“双击落子”）——**无副作用部分即时、有副作用提交延迟**（BUG-105）：
   *  - 已占点：登记待定 `select`（死子标记/点评选择在 pointerup 判定纯轻点后提交）；
   *  - 空点第一次轻点：仅显示落点幽灵预览（不落子，即时）；
   *  - 同一空交叉点在 TOUCH_DBL_MS 内再次轻点：登记待定 `place`（同上延迟提交）；
   *  - 点落在网格外（边框/留白）：视为不继续落子，移除幽灵预览与双击记录。
   * 延迟原因：首指按下时第二指（捏合）/平移/取消都可能接踵而至——即时提交会令
   * 结算页双指缩放误标记死子、平移首指误落子；判定见 `touchTapCommitAction`。
   */
  /** 轻点空白（空交叉点/网格外留白）→ 通知宿主收起瞬态 UI（如点评气泡）；与 interactive 无关。 */
  _emitBlankTap() {
    if (typeof this._props.onBlankTap === 'function') this._props.onBlankTap();
  }

  _handleTouchTap(evt) {
    const g = this._geom;
    if (!g) return;
    const { px, py } = this._eventXY(evt);
    const pt = pxToXY(g, px, py);
    if (!pt) {
      this._resetTouchMarkers();
      this._emitBlankTap(); // 网格外留白：同样是“轻点棋盘空白”
      return;
    }
    if (!this._props.interactive) {
      if (!this._isOccupied(pt)) this._emitBlankTap(); // 非交互期：仅通知“空白轻点”
      return;
    }
    if (this._isOccupied(pt)) {
      // 已占点选择（结算死子标记/点评气泡）：不即时提交——首指可能只是捏合/平移的起点
      this._resetTouchMarkers();
      this._pendingTap = { id: evt.pointerId, kind: 'select', x: pt.x, y: pt.y };
      this._armTapFallback(evt.pointerId);
      return;
    }
    this._emitBlankTap(); // 空点首次轻点（不落子）：通知宿主收起瞬态 UI
    const now = this._now();
    if (isTouchDoubleTap(this._dbl, pt, now)) {
      // 双击落子同样延迟到 pointerup 提交（捏合/平移首指误落子防护同源）
      this._pendingTap = { id: evt.pointerId, kind: 'place', x: pt.x, y: pt.y };
      this._armTapFallback(evt.pointerId);
      return;
    }
    // 第一次轻点：预览该空点（幽灵子），记录供双击判定
    this._dbl = { x: pt.x, y: pt.y, at: now };
    if (this._props.hoverGhost !== false) {
      this._ghost = { x: pt.x, y: pt.y, ok: true };
      this._invalidate('state');
    }
  }

  _handlePointerDown(evt) {
    this._touches.set(evt.pointerId, this._pointerClient(evt));
    // 待定轻点属「另一指针」（其 up/click 均未到达的残留）→ 新指针落下即作废（BUG-105 保险）
    if (this._pendingTap && this._pendingTap.id !== evt.pointerId) this._takePendingTap();
    // —— 双指 → 捏合缩放（捕获两指保证出界连续；同时结束轻点态）——
    if (this._touches.size >= 2) {
      this._drag = null;
      this._resetTouchMarkers(); // 含待定轻点作废：捏合首指落下不得已提交（BUG-105）
      for (const id of this._touches.keys()) this._capturePointer({ pointerId: id });
      const [a, b] = [...this._touches.values()];
      this._pinch = {
        ids: new Set(this._touches.keys()),
        dist: Math.max(BOARD_ZOOM.pinchEps, Math.hypot(a.x - b.x, a.y - b.y)),
        zoom0: this._zoom,
      };
      return;
    }
    if (this._drag) return;
    // L-9：鼠标/笔 100% 下不再登记 `_drag`（旧实现残留吞点击）；zoom>1 平移意图
    // 在按下即捕获指针，移出画布释放仍有 pointerup 回投
    const plan = pointerDownPlan(evt.pointerType, this._zoom);
    if (plan !== 'tap') {
      this._drag = {
        id: evt.pointerId,
        x0: evt.clientX,
        y0: evt.clientY,
        left0: this._view.left,
        top0: this._view.top,
        moved: false,
        zoom: this._zoom,
      };
      if (plan === 'pan') this._capturePointer(evt);
    }
    // 触摸轻点：无副作用部分（幽灵预览/留白收起）在 pointerdown 即时反馈；
    // 有副作用提交（已占点选择/双击落子）登记待定、由 pointerup 手势判定提交（BUG-105）
    if (plan === 'press') {
      this._handleTouchTap(evt); // 触摸：预览（首点）/ 双击（同一空点）/ 已占点登记待定选择
    } else if (plan === 'tap') {
      this._commitTap(evt); // 100% 鼠标/触控笔：pointerdown 即落子（零延迟）
    }
  }

  _handlePointerMove(evt) {
    // 1) 双指捏合
    if (this._pinch && this._pinch.ids.has(evt.pointerId)) {
      this._touches.set(evt.pointerId, this._pointerClient(evt));
      this._updatePinch();
      return;
    }
    // 2) 单指拖拽平移（zoom>1 且位移超阈值）
    const d = this._drag;
    if (d && d.id === evt.pointerId && d.zoom > 1) {
      const dx = evt.clientX - d.x0;
      const dy = evt.clientY - d.y0;
      if (!d.moved && (Math.abs(dx) > BOARD_ZOOM.panThreshold || Math.abs(dy) > BOARD_ZOOM.panThreshold)) {
        d.moved = true;
        this._resetTouchMarkers(); // 转为平移 → 清触摸预览/双击记录
        this._capturePointer(evt); // 平移开始后捕获，保证出界连续
      }
      if (d.moved) {
        this._panTo(d.left0 + dx, d.top0 + dy);
        return;
      }
    }
    // 触摸无 hover：轻点预览/双击由 _handleTouchTap 驱动，避免触点抖动拖动幽灵子
    if (evt.pointerType === 'touch') return;
    // 3) hover（100% 原行为；>100% 未成拖拽的轻移亦更新悬停/幽灵子）
    const g = this._geom;
    if (!g) return;
    const { px, py } = this._eventXY(evt);
    const pt = pxToXY(g, px, py);
    const next = this._props.interactive && this._props.hoverGhost !== false ? pt : null;
    this._syncCursor(next);
    const key = next ? `${next.x},${next.y}` : '';
    const prevKey = this._ghost ? `${this._ghost.x},${this._ghost.y}` : '';
    if (key === prevKey && !!next === !!this._ghost) return;
    this._ghost = next;
    if (typeof this._props.onHover === 'function') {
      this._props.onHover(next ? { x: next.x, y: next.y } : null);
    }
    this._invalidate('state');
  }

  _handlePointerUp(evt) {
    const cancelled = evt.type === 'pointercancel';
    this._touches.delete(evt.pointerId);
    if (this._pinch && this._pinch.ids.has(evt.pointerId)) {
      this._pinch.ids.delete(evt.pointerId);
      if (this._pinch.ids.size < 2) this._pinch = null;
      if (this._pendingTap && this._pendingTap.id === evt.pointerId) this._takePendingTap(); // 捏合参与指：作废
      return;
    }
    const d = this._drag;
    if (d && d.id === evt.pointerId) {
      this._drag = null;
      if (evt.pointerType === 'touch') {
        // 触摸轻点提交（BUG-105）：经手势判定——捏合（待定已于第二指落下时清）/ 平移 / 取消一律不提交；
        // 空点预览/双击记录为即时路径，仅 select（已占点选择）/ place（双击落子）在此提交。
        const pending = this._pendingTap;
        const action = touchTapCommitAction(pending, {
          pointerId: evt.pointerId,
          cancelled,
          moved: d.moved,
        });
        this._takePendingTap();
        if (action && pending) this._commitPendingTap(pending);
        else if (d.moved || cancelled) this._resetTouchMarkers(); // 平移越阈值 / 手势取消：中止轻点序列
        return;
      }
      if (d.moved) {
        this._resetTouchMarkers();
        return; // 已作为平移拖拽，不触发轻点
      }
      // 仅 鼠标/触控笔 在 >100% 缩放态时于 pointerup 提交（避免拖拽误触）
      if (d.zoom > 1) this._commitTap(evt);
    }
  }

  _updatePinch() {
    const pts = [...this._touches.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const dist = Math.max(BOARD_ZOOM.pinchEps, Math.hypot(a.x - b.x, a.y - b.y));
    const rect = this._wrapRect();
    const ax = (a.x + b.x) / 2 - rect.left;
    const ay = (a.y + b.y) / 2 - rect.top;
    this._applyZoomAt(this._pinch.zoom0 * (dist / this._pinch.dist), ax, ay);
  }

  _handleWheel(evt) {
    // 仅 Ctrl/⌘+滚轮 缩放棋盘（阻止浏览器页面级缩放）；普通滚轮不拦截
    if (!evt.ctrlKey && !evt.metaKey) return;
    evt.preventDefault();
    const rect = this._wrapRect();
    const ax = evt.clientX - rect.left;
    const ay = evt.clientY - rect.top;
    const factor = evt.deltaY < 0 ? BOARD_ZOOM.wheelStep : 1 / BOARD_ZOOM.wheelStep;
    this._applyZoomAt(this._zoom * factor, ax, ay);
  }

  _handlePointerLeave(evt) {
    // 拖拽/捏合期间不因指针出界清 ghost（指针已捕获）
    if (this._drag || this._pinch) return;
    // iOS Safari 触摸结束（touchend）后可能补发 pointerleave——不得清掉“轻点预览/双击
    // 记录”，否则松手预览消失、第二次轻点被当成新首点而无法双击落子（2026/09/08 真机）
    if (evt && evt.pointerType === 'touch') return;
    this._dbl = null; // 触摸双击记录随离开重置（仅鼠标等）
    this._syncCursor(null);
    if (this._ghost) {
      this._ghost = null;
      if (typeof this._props.onHover === 'function') this._props.onHover(null);
      this._invalidate('state');
    }
  }

  _handleKeyDown(evt) {
    if (!this._props.interactive) return;
    const n = this._props.size;
    const dir = KEY_DIRS[evt.key];
    if (dir) {
      evt.preventDefault();
      const from = this._cursor || { x: Math.floor(n / 2), y: Math.floor(n / 2) };
      this._cursor = navigatePoint(from, evt.key, n);
      this._emitCursor();
      this._invalidate('state');
      return;
    }
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      const hadCursor = Boolean(this._cursor); // 原选点圈可见时，清除需重绘
      if (!this._cursor) {
        this._cursor = { x: Math.floor(n / 2), y: Math.floor(n / 2) };
      }
      const { x, y } = this._cursor;
      const occupied = this._props.stones.some((s) => s.x === x && s.y === y);
      if (occupied) {
        // 已占用点：若宿主注册了 onSelectStone（如结算死子标记切换）则触发，否则忽略
        if (typeof this._props.onSelectStone === 'function') this._props.onSelectStone({ x, y });
        return;
      }
      if (typeof this._props.onIntersection === 'function') this._props.onIntersection(x, y);
      // 提交后清除选点圈
      this._cursor = null;
      if (hadCursor) this._invalidate('state');
    }
  }

  _updateAria() {
    const n = this._props.size;
    this._focusEl.setAttribute(
      'aria-label',
      this._props.ariaLabel || `${n} 路棋盘`,
    );
  }

  /* ---------------- 内部：数据准备 ---------------- */

  _resetHeat() {
    this._heat = null;
  }

  /**
   * 热力淡出（240ms，与 `_drawHeat` 同一收敛因子）：目标清零、当前值保留 → 收敛帧释放
   * `_heat`；reduced-motion → 即时清除。淡出中若新数据到达，`_setOwnership` 复用当前
   * （半透明）`cur` 作起点 → 反向平滑衔接，不跳变（人工口径 2026/09/12）。
   */
  _fadeHeatOut() {
    // 传「允许动效」= !reduced（纯函数契约见 FE-BOARD-37：hasHeat && motion → 'fade'）；
    // 2026/09/17 修正：调用处曾误传 this._motion（reduced 标志）→ 正常模式被取反为即时清除
    if (heatClearAction({ hasHeat: Boolean(this._heat), motion: !this._motion }) === 'reset') {
      if (this._heat) {
        this._resetHeat();
        this._invalidate('state'); // 已绘热力需清除（叠加层并入状态层后不再自动重画）
      }
      return;
    }
    const h = this._heat;
    h.target = new Float32Array(h.n * h.n);
    h.fading = true;
    h.dirty = true;
    // 时间基准重置（2026/09/17）：按需调度下距上帧的 dt 可能长达数秒，旧逐帧渲染
    // 隐含 dt≈16ms；不重置会导致收敛因子≈1 → 淡出/交叉淡变瞬完（动画丢失）
    this._lastHeatTs = 0;
    this._invalidate('state');
  }

  _setOwnership(ownership, size) {
    const n = normalizeSize(size);
    if (ownership == null) {
      this._fadeHeatOut();
      return;
    }
    const q = isOwnershipVector(ownership)
      ? quantizeOwnership(ownership, n)
      : ownership && ownership.alphas
        ? { alphas: ownership.alphas, signs: ownership.signs || new Int8Array(n * n), n }
        : null;
    if (!q) {
      this._fadeHeatOut();
      return;
    }
    const N = n * n;
    const target = new Float32Array(N);
    for (let i = 0; i < N; i += 1) {
      target[i] = Math.min(1, (q.alphas[i] || 0) / 255);
    }
    const prev = this._heat;
    const cur = prev && prev.cur && prev.cur.length === N ? prev.cur : new Float32Array(N);
    this._heat = { alphas: q.alphas, signs: q.signs, n, target, cur, dirty: true, fading: false };
    // 时间基准重置（2026/09/17）：新目标/交叉淡变起点的首帧 dt=0，后续按帧 ~16ms
    // 插值——与旧「每帧重绘」隐含的时间基准一致（否则空闲后首帧系数≈1 → 瞬变）
    this._lastHeatTs = 0;
    this._invalidate('state'); // 启动/衔接插值动画帧
  }

  _queueDrops(added, upColor = this._props.dropUpColor) {
    if (!added || added.length === 0) return;
    this._resolveMotionPref();
    if (!this._dropMotion) return; // reduced-motion / 管理页关闭落子动画：直接落定
    const now = this._now();
    for (const s of added) {
      // dir：+1 自下方落入（向上）/ −1 自上方落入（向下）——按 dropUpColor 分方向
      this._anims.drops.push({ x: s.x, y: s.y, color: s.color, start: now, dir: dropDirSign(s.color, upColor) });
    }
    if (this._anims.drops.length > 64) this._anims.drops.splice(0, this._anims.drops.length - 64);
    this._invalidate('state');
  }

  _queueCaptures(removed) {
    if (!removed || removed.length === 0) return;
    this._resolveMotionPref();
    if (this._motion) return;
    const now = this._now();
    for (const s of removed) {
      this._anims.captures.push({ x: s.x, y: s.y, color: s.color, start: now });
    }
    if (this._anims.captures.length > 64) this._anims.captures.splice(0, this._anims.captures.length - 64);
    this._invalidate('state');
  }

  /**
   * 点评色环淡入/淡出登记：比对前后 comments 集合，新出现 → 'in'（渐显），
   * 被移除 → 'out'（保留快照渐隐为残影），避免复盘跳手时色环生硬叠加/消失。
   */
  _queueCommentFx(prevComments, nextComments) {
    this._resolveMotionPref();
    if (this._motion) return; // reduced-motion：直接呈现，无过渡
    const prev = new Map();
    for (const c of prevComments || []) prev.set(stoneKey(c.x, c.y), c);
    const next = new Map();
    for (const c of nextComments || []) next.set(stoneKey(c.x, c.y), c);
    const now = this._now();
    for (const [k, c] of next) {
      if (!prev.has(k) && !this._ringFx.has(k)) {
        this._ringFx.set(k, { type: 'in', start: now, data: c });
      }
    }
    for (const [k, c] of prev) {
      if (!next.has(k)) {
        this._ringFx.set(k, { type: 'out', start: now, data: c });
      }
    }
    this._invalidate('state');
  }

  _resolveColors() {
    if (this._colors) return this._colors;
    const dark = (() => {
      try {
        return document.documentElement.dataset.theme === 'dark';
      } catch {
        return false;
      }
    })();
    const read = (token) => {
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
        return v || null;
      } catch {
        return null;
      }
    };
    const c = {};
    c.grid = read(CSS_TOKENS.grid) || FALLBACK.grid[dark ? 'dark' : 'light'];
    c.coord = read(CSS_TOKENS.coord) || FALLBACK.coord[dark ? 'dark' : 'light'];
    c.grain = read(CSS_TOKENS.grain) || FALLBACK.grain[dark ? 'dark' : 'light'];
    c.grainBand = read(CSS_TOKENS.grainBand) || FALLBACK.grainBand[dark ? 'dark' : 'light'];
    const outerRaw = parseFloat(read(CSS_TOKENS.gridOuterScale));
    c.gridOuterScale = Number.isFinite(outerRaw)
      ? outerRaw
      : parseFloat(FALLBACK.gridOuterScale);
    c.accent = read(CSS_TOKENS.accent) || FALLBACK.accent;
    c.accentContrast = read(CSS_TOKENS.accentContrast) || FALLBACK.accentContrast;
    c.grade = {};
    for (const g of GRADE_ORDER) c.grade[g] = read(CSS_TOKENS[g]) || FALLBACK.grade[g];
    c.font = read(CSS_TOKENS.fontUi) || FONT_STACK;
    this._colors = c;
    return c;
  }

  /* ---------------- 内部：sprite 预渲染 ---------------- */

  /** 交叉点渲染像素：吸附设备像素网格（几何小数 → 渲染整数，防发虚）。
   *  网格线（静态层）与棋子/标记（状态层，含叠加标记）都派生自同一 snapped 值，保证子与线对齐。 */
  _point(x, y) {
    const p = xyToPx(this._geom, x, y);
    const dpr = this._dpr;
    return { px: snapDevice(p.px, dpr), py: snapDevice(p.py, dpr) };
  }

  _resetSprites() {
    this._sprite = null;
  }

  /** 按当前棋子半径预渲染黑/白云子离屏 sprite（yunzi token：三档渐变+物理投影+边缘微透，一次烘焙）。
   *
   *  **影子层 / 石体层 / 合体 三种各一对**（2026/10/07，BUG-140）：
   *   - `shadow`＝仅石外物理投影、`body`＝石体 + 内缘微透——静态子据此**两趟**绘制（先全部影子、
   *     再全部石体，见 _drawState）：否则后画棋子的烘焙投影会压在相邻棋子石面上（石径 0.48·cell
   *     后净隙仅 0.04·cell ≈ 1.3px，远小于投影外扩 ≈ 0.39R ≈ 6.8px）；
   *   - `combined`＝单张合体（外投影随石体一次 fill 烘焙）——单子绘制场景（残影/幽灵/变化图/飞行）
   *     经 `_drawStoneImage` 默认层使用：半透明虚子的石体区域为不透明体色，其下层不透出自身投影，
   *     与 2026/09/08 起的单张 sprite 逐像素一致（不改这些场景的观感）。
   *
   *  几何由 spriteGeometry 统一给出（FE-BOARD-52 守卫）：内容设备尺寸取「偶数整数」halfDev*2，石心精确落于 sprite 正中
   *  整像素 → _drawStoneImage 以整数圆心 1:1 blit（源/目标设备尺寸一致），消除重采样发虚。 */
  _sprites() {
    if (this._sprite) return this._sprite;
    const m = this._geom;
    const R = m.stoneR;
    const dpr = this._dpr;
    const doc = (this.el && this.el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    const pal = resolveStoneColors(doc);
    const geo = spriteGeometry({ radius: R, dpr });
    const make = (black, kind) => {
      const cv = document.createElement('canvas');
      cv.width = geo.w;
      cv.height = geo.w;
      const ctx = cv.getContext('2d');
      ctx.scale(dpr, dpr);
      const stone = { x: geo.centerCss, y: geo.centerCss, r: R, color: black ? 'black' : 'white' };
      if (kind === 'shadow') paintStoneShadow(ctx, stone, pal);
      else if (kind === 'body') paintStoneBody(ctx, stone, pal);
      else paintStone(ctx, stone, pal);
      return { canvas: cv, pad: geo.pad, cssW: geo.cssW };
    };
    const set = (black) => ({
      shadow: make(black, 'shadow'),
      body: make(black, 'body'),
      combined: make(black, 'combined'),
    });
    this._sprite = { black: set(true), white: set(false) };
    return this._sprite;
  }

  /** 绘制云子 sprite。
   *  layer='all'（默认）＝合体 sprite（影子在石体之下）——单子绘制：残影/幽灵/变化图/飞行；
   *  layer='shadow'｜'body'＝仅该层（静态棋子两趟绘制用，见 _drawState）。
   *
   *  scale===1（常态）：圆心吸附设备像素（round(x·dpr)），sprite 按源尺寸
   *  1:1 blit（目标设备起点=整数、尺寸=源整数）→ 像素级清晰无重采样；
   *  scale≠1：通用缩放绘制路径（瞬时可重采样，观感可接受）。 */
  _drawStoneImage(ctx, x, y, R, color, alpha = 1, scale = 1, layer = 'all') {
    const spr = this._sprites()[color === 'white' ? 'white' : 'black'];
    if (!spr) return;
    if (layer === 'all') this._blitStone(ctx, spr.combined, x, y, R, alpha, scale);
    else if (layer === 'shadow') this._blitStone(ctx, spr.shadow, x, y, R, alpha, scale);
    else this._blitStone(ctx, spr.body, x, y, R, alpha, scale);
  }

  /** 单层 sprite blit（几何与 _drawStoneImage 历史实现一致）。 */
  _blitStone(ctx, spr, x, y, R, alpha, scale) {
    const dpr = this._dpr;
    if (scale === 1) {
      const cx = Math.round(x * dpr);
      const cy = Math.round(y * dpr);
      const halfCss = spr.cssW / 2; // 设备半宽=整数，故 css 半宽恒定
      const dx = cx / dpr - halfCss;
      const dy = cy / dpr - halfCss;
      if (alpha >= 1) {
        ctx.drawImage(spr.canvas, dx, dy, spr.cssW, spr.cssW);
      } else {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.drawImage(spr.canvas, dx, dy, spr.cssW, spr.cssW);
        ctx.restore();
      }
      return;
    }
    const r = R * scale;
    const cssW = 2 * (r + spr.pad);
    const dx = x - (r + spr.pad);
    const dy = y - (r + spr.pad);
    if (alpha >= 1) {
      ctx.drawImage(spr.canvas, dx, dy, cssW, cssW);
    } else {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(spr.canvas, dx, dy, cssW, cssW);
      ctx.restore();
    }
  }

  /**
   * 飞行落子绘制（人手斜放；drop-anim 模型）：动态地面投影 + 垂直压缩云子 + 相对落点
   * 下移。落点圆心与落地静态同用 _point（设备像素）；落地帧由行循环静态路径接管 →
   * “空中斜放 → 平贴静态”零闪烁衔接。
   */
  _drawFalling(ctx, R, d, nowMs) {
    const elapsed = Math.max(0, nowMs - d.start);
    if (isDropLanded(elapsed)) return; // 已落地：由行循环静态绘制（无缝）
    const ratio = dropRatio(elapsed);
    const dir = d.dir === -1 ? -1 : 1;
    const p = this._point(d.x, d.y);
    this._drawFallingShadow(ctx, p.px, p.py, R, d.color, ratio, dir);
    const spr = this._sprites()[d.color === 'white' ? 'white' : 'black'];
    if (!spr) return;
    const squash = dropSquash(ratio);
    // dir=+1 起点在落点下方（向上落平）；dir=−1 起点在落点上方（向下落平）
    const yOff = dropYOffR(ratio) * R * dir;
    const cssW = spr.combined.cssW;
    const cssH = cssW * squash;
    // 合体 sprite（投影随石体一次烘焙）：与落地后的静态形态同材质，且观感同历史单张 sprite
    ctx.drawImage(spr.combined.canvas, p.px - cssW / 2, p.py + yOff - cssH / 2, cssW, cssH);
  }

  /**
   * 飞行期动态地面投影（高度幻觉）：随 ratio 增强/减弱，落地前归零——静止后完全由
   * sprite 自烘焙外投影接管，避免双重投影或跳变。投影中心随落子方向偏移
   * （dir=+1 自下方落入 → 下偏；dir=−1 自上方落入 → 上偏，与飞行位置同侧）。
   */
  _drawFallingShadow(ctx, cx, cy, R, color, ratio, dir = 1) {
    if (ratio <= 0.02) return;
    const baseA = color === 'white' ? 0.4 : 0.6;
    const alpha = baseA * ratio * ratio;
    if (alpha < 0.02) return;
    const ox = R * 0.1;
    const oy = R * (0.2 + ratio * 1.2) * dir;
    const rad = R * (1 + ratio * 1.1);
    const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, rad);
    g.addColorStop(0, `rgba(0,0,0,${alpha.toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---------------- 内部：状态层绘制 ---------------- */

  _drawState(now) {
    const { ctx } = this._layers.state;
    const m = this._geom;
    if (!ctx || !m) return;
    const c = this._resolveColors();
    const dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, m.side, m.side);

    const R = m.stoneR;
    const occupied = new Map();
    for (const s of this._props.stones) occupied.set(stoneKey(s.x, s.y), s);

    // —— 完成/过期动画 ——
    const nowMs = now || this._now();
    // 落子（drop-anim 人手斜放模型）：落地即从队列移除——移除的当帧下面以静态路径
    // 绘制该子（行循环不再命中 flying），保证“空中形态 → 平贴静态”零闪烁衔接。
    const drops = [];
    for (const d of this._anims.drops) {
      if (isDropLanded(nowMs - d.start)) continue;
      drops.push(d);
    }
    this._anims.drops = drops;
    const caps = [];
    for (const cp of this._anims.captures) {
      const t = clamp01((nowMs - cp.start) / ANIM_MS.capture);
      if (t >= 1) continue;
      caps.push({ ...cp, t });
    }
    this._anims.captures = caps;

    // —— 残影（先画，处于下层）——
    for (const cp of caps) {
      const p = xyToPx(m, cp.x, cp.y);
      const alpha = CAPTURE_GHOST * (1 - cp.t);
      this._drawStoneImage(ctx, p.px, p.py, R, cp.color, alpha, 1);
    }

    // 本帧仍在空中的落子（顶层斜放绘制；其静态形态在行循环内跳过）
    const flying = new Map(drops.map((d) => [stoneKey(d.x, d.y), d]));
    this._flyingKeys = flying;

    // —— 棋子（两趟：先全部影子、再全部石体）——
    //    「阴影不能遮挡云子本身」（2026/10/07 人工口径，BUG-140）：石径 0.48·cell 后邻子
    //    净隙仅 0.04·cell（≈1.3px @19 路），远小于烘焙投影外扩（≈0.39R）——若逐子单趟绘制，
    //    后画棋子的投影必然压在前画棋子石面上。故静态子按 sprite 分层两趟：影子只落在木纹
    //    与己方影子上，全部石体随后覆盖。绘制序仍按 y 降序（下方先画、上方后画）——影子之间
    //    与石体之间的重叠顺序语义与单趟一致。
    const rows = [...occupied.values()].sort((a, b) => b.y - a.y || a.x - b.x);
    const visible = [];
    for (const s of rows) {
      if (flying.has(stoneKey(s.x, s.y))) continue; // 空中子稍后顶层绘制
      const p = xyToPx(m, s.x, s.y);
      visible.push({ s, p });
    }
    for (const { s, p } of visible) this._drawStoneImage(ctx, p.px, p.py, R, s.color, 1, 1, 'shadow');
    for (const { s, p } of visible) this._drawStoneImage(ctx, p.px, p.py, R, s.color, 1, 1, 'body');

    // —— 当前手标记（须在最上层；空中落子不标，落地后显现）——
    this._drawLastMarker(ctx, m, c, R, occupied);
    // —— 点评色环 / 死子 ——
    const commentsBusy = this._drawComments(ctx, m, c, R);
    this._drawDeadStones(ctx, m, c, R);

    // —— 飞行落子（人手“斜放”形态）置于最顶层：动态投影 + 垂直压缩 + 相对落点下移 ——
    for (const d of flying.values()) this._drawFalling(ctx, R, d, nowMs);
    this._flyingKeys = null;

    // —— 叠加标记（原动态层并入；z 序与原三层叠放一致）——
    const fx = this._drawOverlays(ctx, m, c, R, nowMs);

    // 动画未结束 → 下一帧继续重绘（rAF 按需调度；全部收敛后即停 → 空闲零绘制）
    const hot = this._anims.drops.length || this._anims.captures.length
      || commentsBusy || fx.heat || fx.top5;
    this._dirty.state = Boolean(hot);
  }

  /**
   * 当前手标记：
   *   dot  = 反色实心圆点（直径 40% 石径，2026/09/05 放大）；
   *   ring = 反色圆环画在棋子**中心附近**（半径介于点评外环 0.9R 与圆点 0.2R 之间，
   *          无手数编号），深色子用白环、白子用深环，与点评色环区分语义。
   */
  _drawLastMarker(ctx, m, c, R, occupied) {
    const mode = this._props.lastMarker;
    if (mode === 'none') return;
    const last = this._props.stones.find((s) => s.isLast) || (this._lastKey ? occupied.get(this._lastKey) : null);
    if (!last) return;
    const lastKey = stoneKey(last.x, last.y);
    if (this._flyingKeys && this._flyingKeys.has(lastKey)) return; // 空中落子：落地后再标
    const p = this._point(last.x, last.y); // 与 _drawStoneImage 同一设备像素圆心
    const black = last.color === 'black';
    if (mode === 'dot') {
      const r = Math.max(2, R * LAST_DOT_R);
      ctx.beginPath();
      ctx.arc(p.px, p.py, r, 0, Math.PI * 2);
      ctx.fillStyle = black ? '#FFFFFF' : '#0A0F09';
      ctx.fill();
    } else if (mode === 'ring') {
      ctx.beginPath();
      ctx.arc(p.px, p.py, R * LAST_RING_R, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, R * 0.16);
      ctx.strokeStyle = black ? '#F6F2E8' : '#14161A';
      ctx.stroke();
    }
  }

  /**
   * 点评标记：贴边内向色带（`commentRing !== false` 时绘制）+ 角标小圆点（UI_UX §5.2.2 /
   * 静态稿，**无中心圆点**——2026/09/05 人工反馈）；色环随复盘跳手以 ANIM_MS.ring
   * 淡入/淡出（避免生硬叠加）。**对弈页仅角标小圆点**（`commentRing: false`，2026/09/10
   * 人工口径：点击棋子再显点评文案气泡）。返回是否仍有过渡进行中（true → 保持状态层脏标记）。
   */
  _drawComments(ctx, m, c, R) {
    const ringR = R * 0.9;
    const lw = Math.max(1.5, R * 0.2);
    const withRing = this._props.commentRing !== false;
    const fade = ANIM_MS.ring;
    const now = this._now();
    let busy = false;

    // 归一当前集合的透明度：'in' 过渡 → easeOutCubic 渐显
    const items = [];
    const current = new Set();
    for (const cm of this._props.comments) {
      const k = stoneKey(cm.x, cm.y);
      current.add(k);
      const fx = this._ringFx.get(k);
      let alpha = 1;
      if (fx && fx.type === 'in') {
        const t = clamp01((now - fx.start) / fade);
        if (t >= 1) {
          this._ringFx.delete(k);
        } else {
          alpha = easeOutCubic(t);
          busy = true;
        }
      }
      items.push({ cm, alpha });
    }
    // 已被移除的点评 → 'out' 残影渐隐
    for (const [k, fx] of this._ringFx) {
      if (fx.type !== 'out') continue;
      const t = clamp01((now - fx.start) / fade);
      if (t >= 1) {
        this._ringFx.delete(k);
        continue;
      }
      if (!current.has(k)) {
        busy = true;
        items.push({ cm: fx.data, alpha: 1 - easeOutCubic(t) });
      }
    }

    for (const { cm, alpha } of items) {
      const grade = GRADE_ORDER.includes(cm.grade) ? cm.grade : 'mistake';
      const color = c.grade[grade];
      const p = this._point(cm.x, cm.y);
      ctx.save();
      ctx.globalAlpha = alpha;
      if (withRing) {
        ctx.beginPath();
        ctx.arc(p.px, p.py, ringR, 0, Math.PI * 2);
        ctx.lineWidth = lw;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      // 角标点：中心距 = stoneR*1.007（紧贴石缘向外 2px 视觉），r=0.23R
      const off = R * 1.007;
      const dotR = Math.max(2, R * 0.23);
      ctx.beginPath();
      ctx.arc(p.px + off, p.py + off, dotR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }
    return busy;
  }

  /** 死子 ✕（红色交叉，结算阶段）。 */
  _drawDeadStones(ctx, m, c, R) {
    if (!this._props.deadStones || this._props.deadStones.length === 0) return;
    const len = Math.max(2, R * 0.55);
    ctx.lineWidth = Math.max(2, R * 0.13);
    ctx.lineCap = 'round';
    ctx.strokeStyle = FALLBACK.grade.blunder;
    for (const d of this._props.deadStones) {
      const p = this._point(d.x, d.y);
      ctx.beginPath();
      ctx.moveTo(p.px - len, p.py - len);
      ctx.lineTo(p.px + len, p.py + len);
      ctx.moveTo(p.px + len, p.py - len);
      ctx.lineTo(p.px - len, p.py + len);
      ctx.stroke();
    }
  }

  /* ---------------- 内部：静态层绘制 ---------------- */

  /**
   * 木纹（垂直；静态层纹理，2026/09/21；2026/09/22 方案 B 改为铺满整块木料面）。
   *
   * plan 按 `{面宽, 面高, cell}` 指纹缓存：主题切换 / 坐标开关引发的静态层重复重绘不再
   * 重新生成几何；容器尺寸或缩放（重栅格）变化才重建。颜色与基准强度全部来自 CSS token
   * （`--wood-grain` 细木纹 / `--wood-grain-band` 年轮条带），改配色无需动 JS。
   *
   * 随动（人工要求）：面的尺寸与 cell 都是 **zoom 后**的值（face = 容器×zoom，cell 取自
   * layoutForSize(size, surf) 也是 zoom 后），故木纹与棋盘（网格/棋子）严格同尺度、
   * 同平移——放大棋盘时木纹一同放大。
   */
  _drawWoodGrain(ctx, face, cell, c) {
    const key = `${face.w}|${face.h}|${cell}`;
    if (!this._grainPlan || this._grainKey !== key) {
      this._grainPlan = woodGrainPlan({ width: face.w, height: face.h, cell });
      this._grainKey = key;
    }
    paintWoodGrain(ctx, this._grainPlan, { lineStyle: c.grain, bandStyle: c.grainBand });
  }

  _drawStatic() {
    const { ctx } = this._layers.static;
    const m = this._geom;
    const face = this._surface;
    if (!ctx || !m || !face) return;
    const c = this._resolveColors();
    const dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 清整幅：画布设备尺寸可能比 CSS 尺寸多出亚像素，按设备尺寸换算才能清干净
    ctx.clearRect(0, 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);

    // 木纹（垂直；2026/09/21）：年轮条带 → 细木纹，**画在网格线之下**，铺满整块木料面
    // （方案 B，2026/09/22：木料＝棋盘容器整幅，棋盘只占其中央正方形）。
    this._drawWoodGrain(ctx, face, m.cell, c);

    // 以下棋盘（网格/星位/坐标）以木料面中央的正方形为局部坐标原点
    ctx.translate(face.padX, face.padY);

    const p0 = m.margin;
    const p1 = m.margin + m.span;
    // 网格线：统一 stroke（各线同线宽、粗细均匀），但按「设备像素网格 + 线宽奇偶」对齐。
    //   线宽先取整为同一整数设备线宽 lwDev；线心经 snapLineCenter 吸附——偶数宽取整到
    //   设备像素、奇数宽再 +0.5 设备像素。消除原小数线心/小数线宽被抗锯齿拆到 2–3 个
    //   物理像素（30–50% 透明）所致的“发虚/偏淡”，且不会出现逐线取整的粗细不一
    //   （2026/09/08 人工复核修订，替代 09/08 保留基线的处置）。
    // 2026/09/22 人工要求：**最外圈刻线可加粗**（开关＝app.css `--grid-outer-scale`，≤1 即关闭）。
    const { inner: lwInnerDev, outer: lwOuterDev } = gridLineWidths({
      lineW: m.lineW,
      dpr,
      outerScale: c.gridOuterScale,
    });
    const emphasized = lwOuterDev > lwInnerDev;
    ctx.strokeStyle = c.grid;
    ctx.lineCap = 'butt';
    // 外圈线心用外框线宽的奇偶吸附（与内线可能差半个设备像素；与标签/外框保持一致）
    const outerW = emphasized ? lwOuterDev : lwInnerDev;
    const centers = new Array(m.n);
    for (let i = 0; i < m.n; i += 1) {
      const edge = i === 0 || i === m.n - 1;
      centers[i] = snapLineCenter(m.margin + i * m.cell, dpr, edge ? outerW : lwInnerDev);
    }
    if (emphasized) {
      // 先画外框（单次 stroke、闭合路径 → 四角对角、均匀无叠色）
      const a0 = centers[0];
      const a1 = centers[m.n - 1];
      ctx.lineWidth = lwOuterDev / dpr;
      ctx.beginPath();
      ctx.moveTo(a0, a0);
      ctx.lineTo(a1, a0);
      ctx.lineTo(a1, a1);
      ctx.lineTo(a0, a1);
      ctx.closePath();
      ctx.stroke();
      // 再画内线：端点缩到外框**内缘**（不重叠 → 交叉处不变深，也不留缝）
      const half = lwOuterDev / 2 / dpr;
      ctx.lineWidth = lwInnerDev / dpr;
      ctx.beginPath();
      for (let i = 1; i < m.n - 1; i += 1) {
        const a = centers[i];
        ctx.moveTo(a, a0 + half);
        ctx.lineTo(a, a1 - half);
        ctx.moveTo(a0 + half, a);
        ctx.lineTo(a1 - half, a);
      }
      ctx.stroke();
    } else {
      ctx.lineWidth = lwInnerDev / dpr;
      ctx.beginPath();
      for (let i = 0; i < m.n; i += 1) {
        const a = centers[i];
        ctx.moveTo(a, p0);
        ctx.lineTo(a, p1);
        ctx.moveTo(p0, a);
        ctx.lineTo(p1, a);
      }
      ctx.stroke();
    }

    // 星位（圆心取整，与网格线同一设备网格）
    ctx.fillStyle = c.grid;
    const starR = Math.max(0.5, snapDevice(m.hoshiR, dpr));
    for (const pt of hoshiPoints(m.n)) {
      const q = this._point(pt.x, pt.y);
      ctx.beginPath();
      ctx.arc(q.px, q.py, starR, 0, Math.PI * 2);
      ctx.fill();
    }

    // 边沿坐标标签（小棋板/小字体自动隐藏）
    if (this._props.showCoordinates && m.coordFont >= 7) {
      ctx.fillStyle = c.coord;
      ctx.font = `400 ${m.coordFont}px ${c.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const letters = colLetters(m.n);
      const idx = edgeLabelIndices(m.n);
      for (const i of idx) {
        ctx.fillText(letters[i], centers[i], m.letterY);
      }
      ctx.textAlign = 'left';
      for (const i of idx) {
        // 行号 = GTP（自下而上：顶行 = n，底行 = 1），与产品内坐标文本一致
        ctx.fillText(String(m.n - i), m.rowX, centers[i] + m.rowBaselineOff);
      }
    }
    this._dirty.static = false;
  }

  /* ---------------- 内部：叠加标记绘制（原动态层并入状态层，按需重绘） ---------------- */

  /**
   * 叠加标记（原「动态层」内容，2026/09/17 并入状态层同一次重绘）：热力 → 键盘
   * 光标 → hover 幽灵 → TOP5 → 变化图 → 非法 ✕（z 序与原三层叠放一致）。
   * @returns {{heat:boolean, top5:boolean}} 仍处于过渡的动画标志（true → 保持状态层脏标记）
   */
  _drawOverlays(ctx, m, c, R, nowMs) {
    // 1) 领地热力（平滑过渡 ≥240ms；黑=深 tint / 白=亮 tint）
    //    收敛后 h.dirty=false → 不再标记动画帧；热力像素保留在状态层（2026/09/17）
    let heatBusy = false;
    if (this._heat && this._props.heatVisible !== false) {
      this._drawHeat(ctx, m, nowMs);
      heatBusy = heatAnimating(this._heat);
    }

    // 2) 键盘光标圈（只读/非交互不显示）
    if (this._props.interactive && this._cursor) {
      const p = this._point(this._cursor.x, this._cursor.y);
      ctx.beginPath();
      ctx.arc(p.px, p.py, R * 1.12, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, m.cell * 0.06);
      ctx.strokeStyle = c.accent;
      ctx.stroke();
    }

    // 3) hover 幽灵子（当前执色半透明）
    if (this._props.interactive && this._props.hoverGhost !== false && this._ghost) {
      const occ = this._props.stones.some(
        (s) => s.x === this._ghost.x && s.y === this._ghost.y,
      );
      if (!occ) {
        const p = this._point(this._ghost.x, this._ghost.y);
        this._drawStoneImage(ctx, p.px, p.py, R, this._props.toMove, 0.45);
      }
    }

    // 4) TOP5 徽章：accent 圆徽整体透明度按 rank 热度 .95/.75/.55/.35/.2
    //    （基线 UI，透明度直接作用于徽章本身，非叠加深色遮罩）；
    //    出现时 150ms fade-in（reduced-motion 即时）；淡入完成后 busy=false
    let top5Busy = false;
    if (this._props.top5 && this._props.top5.length) {
      const badgeR = Math.max(6, R * 0.87); // 13 @R15
      const order = [...this._props.top5].sort((a, b) => (a.rank || 0) - (b.rank || 0));
      const seen = this._top5Seen;
      for (const t of order) {
        if (!seen.has(stoneKey(t.x, t.y))) seen.set(stoneKey(t.x, t.y), nowMs);
      }
      if (seen.size > 32) {
        for (const k of seen.keys()) if (!order.some((t) => stoneKey(t.x, t.y) === k)) seen.delete(k);
      }
      top5Busy = top5FadeBusy(seen, order.map((t) => stoneKey(t.x, t.y)), nowMs, { motion: this._motion });
      for (const t of order) {
        const p = this._point(t.x, t.y);
        const start = seen.get(stoneKey(t.x, t.y)) ?? nowMs;
        const fade = this._motion ? 1 : clamp01((nowMs - start) / ANIM_MS.recommend);
        const heat = TOP5_HEAT[t.rank - 1] ?? TOP5_HEAT[TOP5_HEAT.length - 1];
        // 基线（WEBUI）：透明度作用于 accent 圆徽（rank 热度递减），序号文字保持实色
        ctx.globalAlpha = fade * heat;
        ctx.beginPath();
        ctx.arc(p.px, p.py, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = c.accent;
        ctx.fill();
        ctx.globalAlpha = fade;
        ctx.fillStyle = c.accentContrast;
        ctx.font = `700 ${Math.max(7, badgeR * 0.92)}px ${c.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(t.rank), p.px, p.py + 0.5);
        ctx.globalAlpha = 1;
      }
    }

    // 5) 变化图预览：真实云子（自 toMove 黑/白交替）加透明度；序号文字按
    //    棋子颜色**反色** + 描边光晕保证可读（黑子白字/白子黑字）
    if (this._props.variations && this._props.variations.length > 0) {
      const turn = this._props.toMove;
      this._props.variations.forEach((v, i) => {
        const p = this._point(v.x, v.y);
        const color = i % 2 === 0 ? turn : (turn === 'black' ? 'white' : 'black');
        this._drawStoneImage(ctx, p.px, p.py, R, color, VARIATION_ALPHA);
        const isBlack = color === 'black';
        ctx.font = `700 ${Math.max(7, R * 0.8)}px ${c.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, R * 0.2);
        ctx.strokeStyle = isBlack ? 'rgba(10,15,9,0.85)' : 'rgba(255,255,255,0.9)';
        ctx.strokeText(String(i + 1), p.px, p.py + 0.5);
        ctx.fillStyle = isBlack ? '#FFFFFF' : '#1A1A1A';
        ctx.fillText(String(i + 1), p.px, p.py + 0.5);
      });
    }

    // 6) 非法 ✕ 闪现（显示 400ms；到期由 flashIllegal 的定时器清除并重绘，2026/09/17）
    if (this._illegal) {
      const p = this._point(this._illegal.x, this._illegal.y);
      const len = R * 0.85;
      ctx.lineWidth = Math.max(2, R * 0.18);
      ctx.lineCap = 'round';
      ctx.strokeStyle = FALLBACK.grade.blunder;
      ctx.beginPath();
      ctx.moveTo(p.px - len, p.py - len);
      ctx.lineTo(p.px + len, p.py + len);
      ctx.moveTo(p.px + len, p.py - len);
      ctx.lineTo(p.px - len, p.py + len);
      ctx.stroke();
    }

    return { heat: heatBusy, top5: top5Busy };
  }

  /** 热力：per-vertex 方块，当前 alpha 向目标平滑（τ≈240ms 连续模式无闪烁）。 */
  _drawHeat(ctx, m, nowMs) {
    const h = this._heat;
    const N = h.n * h.n;
    // 收敛因子（时间无关，避免 dt 抖动）：1 - exp(-dt/240)
    const prevNow = this._lastHeatTs || nowMs;
    const dt = Math.max(0, nowMs - prevNow);
    this._lastHeatTs = nowMs;
    const factor = this._motion ? 1 : 1 - Math.exp(-dt / ANIM_MS.heat);
    const converged = !h.dirty; // 上帧已收敛 → 直接按目标绘制，省插值计算

    // 仅限网格内（剪裁矩形），避免方块溢出木边
    ctx.save();
    const p0 = m.margin;
    const p1 = m.margin + m.span;
    ctx.beginPath();
    ctx.rect(p0, p0, p1 - p0, p1 - p0);
    ctx.clip();

    // 行/列方块边界统一吸附设备像素（相邻方块共享同一 round 值 → 无缝、无 1px 缝隙/重叠）。
    const dpr = this._dpr;
    const bx = new Array(h.n + 1);
    const by = new Array(h.n + 1);
    for (let k = 0; k <= h.n; k += 1) {
      const b = Math.round((m.margin + (k - 0.5) * m.cell) * dpr);
      bx[k] = b;
      by[k] = b;
    }
    let dirty = false;
    for (let i = 0; i < N; i += 1) {
      const t = h.target[i];
      let alpha;
      if (this._motion || converged) {
        alpha = t;
      } else {
        const cur = h.cur[i];
        if (cur === t) {
          alpha = t;
        } else {
          const next = cur + (t - cur) * factor;
          h.cur[i] = next;
          if (Math.abs(next - t) > 1 / 255) dirty = true;
          alpha = next;
        }
      }
      if (alpha < 0.02) continue;
      const col = i % h.n;
      const row = Math.floor(i / h.n);
      const x0 = bx[col] / dpr;
      const y0 = by[row] / dpr;
      const a = alpha * 0.55;
      ctx.fillStyle = h.signs[i] >= 0
        ? `rgba(25,22,18,${a.toFixed(3)})`
        : `rgba(250,244,232,${a.toFixed(3)})`;
      ctx.fillRect(x0, y0, (bx[col + 1] - bx[col]) / dpr, (by[row + 1] - by[row]) / dpr);
    }
    ctx.restore();
    if (this._motion) {
      for (let i = 0; i < N; i += 1) h.cur[i] = h.target[i];
      dirty = false;
    }
    h.dirty = dirty;
    // 淡出收敛（目标全 0 且不再变化）→ 释放热力状态（下一帧起不再绘制）
    if (h.fading && !dirty) this._heat = null;
  }

  /* ---------------- 内部：主循环 ---------------- */

  _loop(now) {
    this._raf = 0;
    if (this._destroyed) return;
    if (this._geom) {
      // 静态层：仅规格/主题/坐标开关变化
      if (this._dirty.static) this._drawStatic();
      // 状态层（含全部叠加标记）：数据变化或动画进行中
      if (this._dirty.state) this._drawState(now);
    }
    // rAF 按需调度：仍有待绘制脏层才申请下一帧（空闲零绘制零唤醒；2026/09/17）
    if (this._geom && (this._dirty.static || this._dirty.state)) this._ensureFrame();
  }
}

export default GameBoard;
