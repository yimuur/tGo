/**
 * tGo · 点评气泡共用内核（对弈/复盘，2026/09/13 人工反馈：两页统一为**棋子附近气泡式**）
 *
 * 背景：复盘页原为棋盘顶部横幅胶囊（带 ✕ 关闭钮）；人工定调与对弈页统一为
 * `.board-bubble`（色点 + 两行文案，锚定在被点评棋子附近）——右侧不再留关闭钮
 * 占位（减少右边空白），圆角随样式表统一增大。
 *
 * 本模块收敛两页共用的两件事（无 DOM 依赖的可测部分）：
 *   - `commentBubbleHTML(model)`：气泡内联结构（文案转义）；
 *   - `boardBubblePlacement(point, wrap, bubble)`：锚定几何——优先棋子右上，
 *     上方空间不足改左下；与容器四边保持最小留白（纯函数，无头测试 FE-CBUB-*）。
 *
 * 样式（`.board-bubble`）见 `css/app.css`；实例化/显隐/销毁由两视图各自负责。
 */

const EDGE = 4;  // 距棋盘容器边缘最小留白（px）
const GAP_X = 6; // 气泡左缘相对锚点（石心）的水平内缩（px）
const GAP_Y = 6; // 气泡与棋子的垂直间距（px）

/** HTML 转义（与 game-view 同语义：& < > "）。 */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 允许的点评等级（与后端 ``GRADE_KEYS`` / app.css `--c-*` 对应；L-9：白名单
 * 防任意值注入内联样式——旧实现直接内插 `grade`，异常载荷可拼接 CSS 片段）。
 */
export const BUBBLE_GRADES = Object.freeze(['blunder', 'mistake', 'slow', 'good', 'brilliant']);

/**
 * 气泡内联 HTML（`.board-bubble` 内容）：色点 + 两行文案（line2 可缺省）。
 * @param {{grade:string, line1:string, line2?:string}|null} model
 *   `commentBubbleModel()` 输出（core/game-model.js）
 * @returns {string}
 */
export function commentBubbleHTML(model) {
  const m = model || {};
  const line2 = m.line2 ? `<span class="b-line2">${esc(m.line2)}</span>` : '';
  const rawGrade = String(m.grade ?? '');
  const grade = BUBBLE_GRADES.includes(rawGrade) ? rawGrade : 'good';
  return `<span class="b-dot" style="background:var(--c-${grade})" aria-hidden="true"></span>`
    + `<span class="b-text"><span class="b-line1">${esc(m.line1)}</span>${line2}</span>`;
}

/**
 * 气泡锚定几何（相对棋盘容器左上角）：优先棋子右上（气泡左缘对石心左移 GAP_X、
 * 底边在棋子上方 GAP_Y）；上方放不下改棋子下方；四周钳制在容器内。
 * @param {{left:number, top:number, stoneR:number}} point 棋盘 `pointOffset()` 输出
 * @param {{w:number, h:number}} wrap   棋盘容器尺寸（px）
 * @param {{w:number, h:number}} bubble 气泡尺寸（px）
 * @returns {{left:number, top:number}|null} 取整后的定位；几何未就绪 → null
 */
export function boardBubblePlacement(point, wrap, bubble) {
  if (!point || !wrap || !bubble) return null;
  const w = Number(wrap.w) || 0;
  const h = Number(wrap.h) || 0;
  const bw = Number(bubble.w) || 0;
  const bh = Number(bubble.h) || 0;
  if (!(w > 0) || !(h > 0)) return null;
  const stoneR = Number(point.stoneR) || 0;
  let left = point.left - GAP_X;
  let top = point.top - stoneR - bh - GAP_Y;
  if (top < EDGE) top = point.top + stoneR + GAP_Y; // 上方不足（含棋子在顶部）→ 改左下
  left = Math.max(EDGE, Math.min(left, Math.max(EDGE, w - bw - EDGE)));
  top = Math.max(EDGE, Math.min(top, Math.max(EDGE, h - bh - EDGE)));
  return { left: Math.round(left), top: Math.round(top) };
}
