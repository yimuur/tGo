/**
 * tGo · 按钮内 SVG 图标「点亮」口径（2026/09/17 人工决策；对弈/复盘共用）
 *
 * 决策口径：
 *   - 点亮 = 图标取**金色系**（`--lit-ink`；accent 实底按钮取 `--lit-ink-on-accent`——与主题 accent
 *     解耦，点亮须一眼区别于主题色）＋ 图标后方**径向渐变晕影**（中心最亮、外圈渐隐）；
 *     只在图标上表达，不再使用标签旁小圆点（旧 `.dot`）；
 *   - 数据到达（未点亮 → 点亮）时补一次**晕影淡入**动效（CSS `.is-lit-in::before`，时长
 *     `ICON_LIT_IN_MS`）；点亮本身是**状态**（由数据派生），不是定时器；
 *     **图标本体（svg）零动效/零滤镜**——iOS WebKit 对 svg 图层动画/滤镜会重栅格化位移（2026/09/18）；
 *   - 连续/进行中的**呼吸**不是本模块职责：领地连续模式呼吸＝按钮级 `.breathe`
 *     （`core/territory.js::territoryButtonClasses`）；[支招]/[深度分析] 分析中呼吸同为 `.breathe`。
 *
 * 晕影需 `::before`，而 SVG 元素不支持伪元素 → 把 `svg.icon` **常驻**幂等包进 `.icon-lit`
 * 载体（`ensureIconLitWrap`，每次 `applyIconLit` 重放——**含未点亮帧**；按钮 innerHTML
 * 重建后恢复）。载体提前就位 → 点亮瞬间无 DOM 结构变更（防 iOS 重排/重栅格化引起的轻微位移）。
 *
 * 本模块只做纯派生 + 幂等类名/DOM 应用（元素类型经鸭子类型判定，可在无头测试中以假元素验证）。
 */

/** 到达动效时长（须与 app.css `tgoLitHaloIn` 一致）：到时移除 `.is-lit-in`。 */
export const ICON_LIT_IN_MS = 480;

/** 每个按钮的一次性动效计时器（WeakMap：元素回收即释放，不残留全局键）。 */
const litTimers = new WeakMap();

/**
 * 点亮计划（纯函数）。
 * @param {{lit?:boolean}} next 目标态
 * @param {boolean} prevLit 上一帧是否已点亮（用于判定「数据到达」）
 * @returns {{lit:boolean, animate:boolean}} animate=本次由熄到亮
 */
export function iconLitPlan(next = {}, prevLit = false) {
  const lit = Boolean(next.lit);
  return { lit, animate: lit && !prevLit };
}

function clearLitTimer(btn, timers) {
  const pending = litTimers.get(btn);
  if (pending == null) return;
  if (timers && typeof timers.clearTimeout === 'function') timers.clearTimeout(pending);
  litTimers.delete(btn);
}

/**
 * 点亮载体（`.icon-lit`）**幂等包裹**：晕影是 `::before` 径向渐变，而 **SVG 元素不支持伪元素**，
 * 故必须把 `svg.icon` 包进一层 span 作为伪元素落点。
 *
 * 视图会整体重建按钮 innerHTML（复盘 `renderAnalyzeBtnHTML`、底部动作行重建等）→ **每次
 * 同步（含未点亮帧）都要重放包裹**（载体常驻：点亮瞬间零 DOM 变更 → 防 iOS 重排/重栅格化）；
 * 已包裹时原样返回（不产生 DOM churn）。
 * @param {Element|null} btn
 * @param {Document} [doc]
 * @returns {Element|null} 包裹层（无图标/无 DOM 环境 → null）
 */
export function ensureIconLitWrap(btn, doc = globalThis.document) {
  if (!btn || typeof btn.querySelector !== 'function') return null;
  if (!doc || typeof doc.createElement !== 'function') return null;
  const icon = btn.querySelector('svg.icon');
  if (!icon) return null;
  const parent = icon.parentNode;
  if (parent && parent.classList && parent.classList.contains('icon-lit')) return parent;
  const wrap = doc.createElement('span');
  wrap.className = 'icon-lit';
  wrap.setAttribute('aria-hidden', 'true');
  if (parent) parent.insertBefore(wrap, icon);
  wrap.appendChild(icon);
  return wrap;
}

/**
 * 应用到按钮（幂等）：**每次调用都重放晕影载体**（常驻）；切换 `.is-lit`；`animate` 时重放一次性动效。
 *
 * 重放需先移除类并强制回流，否则浏览器不会重新触发同一动画（连续两次数据到达）；
 * `animate=false` 且仍点亮时**不动作**——否则紧随其后的任意重渲染会把进行中的
 * 到达动效掐断（状态变更频率高于动画时长，如对弈每手多次 store 更新）。
 * @param {Element|null} btn
 * @param {{lit:boolean, animate:boolean}} plan
 * @param {{setTimeout:Function, clearTimeout:Function}} [timers]
 * @param {Document} [doc] 仅测试注入（默认 globalThis.document）
 */
export function applyIconLit(btn, plan, timers = globalThis, doc = globalThis.document) {
  if (!btn || !btn.classList) return;
  // 载体**常驻**：每次同步幂等重放（innerHTML 重建后恢复）——点亮瞬间无节点插入/搬移，
  // 防 iOS WebKit 在结构变更时的重排/重栅格化（2026/09/18 人工反馈：图标仍有轻微位移）
  ensureIconLitWrap(btn, doc);
  btn.classList.toggle('is-lit', plan.lit);
  if (!plan.lit) {
    clearLitTimer(btn, timers);
    btn.classList.remove('is-lit-in');
    return;
  }
  if (!plan.animate) return;
  clearLitTimer(btn, timers);
  btn.classList.remove('is-lit-in');
  void btn.offsetWidth;   // 强制回流：让 `.is-lit-in` 动画可重复触发
  btn.classList.add('is-lit-in');
  litTimers.set(btn, timers.setTimeout(() => {
    litTimers.delete(btn);
    btn.classList.remove('is-lit-in');
  }, ICON_LIT_IN_MS));
}
