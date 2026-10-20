/**
 * tGo · Toast 通知（T5.4，C15 / UI_UX §6.4）
 *
 * 规则：
 *   - 时长：error 6s，其余 4s；
 *   - 合并：3s 内同 key（默认取 code）只更新不新增；
 *   - 堆叠 ≤ max（默认 3），超出逐出最旧；
 *   - 统一 `{code,message}` → 文案/级别映射（ERROR_TEXT 复用 UI_UX §6.4）；
 *   - 位置：棋盘页（对弈/复盘）堆叠「棋盘正上方」——底边贴棋盘上缘、水平对齐棋盘中心
 *     （新条最贴棋盘、向上生长）；无棋盘页回退顶栏下方居中（CSS）；棋盘异步渲染时
 *     经 DOM 结构观察自动跟随（见 `toastAnchor`）；
 *   - 语义标识：级别 → 语义色 SVG 图标 + 文案（图标 symbol 复用 icons.js，颜色在 app.css
 *     按级别取语义 token）；
 *   - 动效：下滑进入（CSS 关键帧）+ 退场淡出（`TOAST_EXIT_MS` 后移除 DOM）。
 *
 * 纯逻辑 `ToastQueue`（注入 now/timers）与锚点换算 `toastAnchor` 可无头测试；
 * DOM 渲染由 `attachToast`/`showToast` 提供（浏览器）。role：error → alert，
 * 其余 → status（读屏播报）。
 */
import { errorText } from './rest-client.js';

export const TOAST_DURATION_MS = Object.freeze({ error: 6_000, warning: 4_000, success: 4_000, info: 4_000 });

/** 退场淡出时长（需与 app.css `.toast` 的 opacity 过渡时长一致）：到时从 DOM 移除。 */
export const TOAST_EXIT_MS = 200;
/** 棋盘模式常量：堆叠底边距棋盘上缘间距 / 堆叠距视口左右最小留白。 */
const BOARD_GAP_PX = 8;
const BOARD_EDGE_PX = 8;

/** 视为“错误”级别的服务端码（UI_UX §6.4 表）。 */
export const ERROR_CODES = new Set([
  'ILLEGAL_MOVE', 'UNDO_LIMIT_REACHED', 'ENGINE_BUSY', 'ENGINE_DEAD', 'ENGINE_FATAL',
  'HUMAN_MODEL_UNAVAILABLE',
  'ANALYSIS_INCOMPLETE', 'SGF_INVALID', 'SGF_TOO_LARGE', 'REPLAY_CONFLICT',
  'DEEP_ANALYSIS_RUNNING',
  'GAME_NOT_FOUND', 'GAME_FINISHED', 'ILLEGAL_ACTION', 'INVALID_PAYLOAD',
  'PLAYER_INVALID_RANK', 'NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_ERROR',
]);

/**
 * code/message → {level, text}。
 * 已知错误码：error 级 + UI_UX §6.4 文案；其余有 message 用 message，否则回退码。
 */
export function resolveToast(code, message, explicitLevel) {
  const c = String(code || '');
  if (explicitLevel) return { level: explicitLevel, text: message || errorText(c) || '操作完成' };
  if (ERROR_CODES.has(c)) return { level: 'error', text: errorText(c) || message || c };
  if (message) return { level: 'info', text: String(message) };
  return { level: 'info', text: c || '操作完成' };
}

/** 级别 → 语义图标 symbol id（icons.js）；形状区分级别，颜色由 app.css 按级别取语义 token。 */
export const TOAST_ICON_ID = Object.freeze({
  success: 'i-success',
  info: 'i-info',
  warning: 'i-warn',
  error: 'i-error',
});

let toastSeq = 0;

/**
 * Toast 队列（纯逻辑）。
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {{setTimeout,clearTimeout}} [opts.timers]
 * @param {number} [opts.max=3]
 * @param {number} [opts.mergeMs=3000]
 * @param {object} [opts.durations=TOAST_DURATION_MS]
 */
export class ToastQueue {
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.timers = opts.timers || globalThis;
    this.max = opts.max ?? 3;
    this.mergeMs = opts.mergeMs ?? 3_000;
    this.durations = opts.durations || TOAST_DURATION_MS;
    this._items = [];
    this._listeners = new Set();
  }

  getItems() {
    return this._items;
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of [...this._listeners]) fn(this._items);
  }

  _durationOf(level) {
    return this.durations[level] || this.durations.info;
  }

  _schedule(item) {
    if (item._timer) this.timers.clearTimeout(item._timer);
    const ms = item.expiresAt - this.now();
    item._timer = this.timers.setTimeout(() => this.dismiss(item.id), Math.max(0, ms));
  }

  /**
   * 入队。
   * @returns {{result:'added'|'merged', item}}
   */
  push(text, { level = 'info', key } = {}) {
    const now = this.now();
    const normalizedKey = key === undefined ? null : String(key);
    // 3s 窗口内同 key 合并
    if (normalizedKey !== null) {
      const same = this._items.find((it) => it.key === normalizedKey && now - it.addedAt <= this.mergeMs);
      if (same) {
        same.text = text;
        same.level = level;
        same.expiresAt = now + this._durationOf(level);
        this._schedule(same);
        this._notify();
        return { result: 'merged', item: same };
      }
    }
    // 堆叠上限：逐出最旧
    while (this._items.length >= this.max) this.dismiss(this._items[0].id);

    const item = {
      id: `t${++toastSeq}`,
      key: normalizedKey,
      text,
      level,
      addedAt: now,
      expiresAt: now + this._durationOf(level),
      _timer: null,
    };
    this._items.push(item);
    this._schedule(item);
    this._notify();
    return { result: 'added', item };
  }

  dismiss(id) {
    const idx = this._items.findIndex((it) => it.id === id);
    if (idx === -1) return false;
    const [removed] = this._items.splice(idx, 1);
    if (removed._timer) this.timers.clearTimeout(removed._timer);
    this._notify();
    return true;
  }

  clear() {
    for (const it of [...this._items]) this.dismiss(it.id);
  }
}

/* ---------------- DOM 层（浏览器） ---------------- */

/**
 * 计算 Toast 堆叠锚点（纯函数，可无头测试）。
 *  - 棋盘有效：{ mode:'board', left, bottom }——left＝堆叠中心 X（对齐棋盘中心，
 *    钳制在视口内），bottom＝堆叠底边距视口底距离（＝棋盘上缘再上移 gap）；
 *    传入 rootHeight（栈高）时附「完整可见兜底」：上方空间不足则整体下移，
 *    宁可多压棋盘上缘也不裁切到视口外；
 *  - 无棋盘/尺寸为零：{ mode:'top' }，由 CSS 默认值承载（顶栏下方居中）。
 * @param {DOMRect|{left:number,top:number,width:number,height:number}} boardRect 棋盘视口矩形
 * @param {{rootWidth:number, rootHeight?:number, viewportW:number, viewportH:number, gap?:number, edge?:number}} opts
 */
export function toastAnchor(
  boardRect,
  { rootWidth, rootHeight = 0, viewportW, viewportH, gap = BOARD_GAP_PX, edge = BOARD_EDGE_PX } = {},
) {
  if (!boardRect || !boardRect.width || !boardRect.height) return { mode: 'top' };
  const half = rootWidth / 2;
  const centerX = boardRect.left + boardRect.width / 2;
  const maxLeft = Math.max(half + edge, viewportW - half - edge);
  let bottom = viewportH - boardRect.top + gap;
  if (rootHeight && viewportH - bottom - rootHeight < edge) bottom = viewportH - edge - rootHeight;
  return {
    mode: 'board',
    left: Math.min(Math.max(centerX, half + edge), maxLeft),
    bottom,
  };
}

/**
 * 将堆叠定位到棋盘正上方；无棋盘时清除内联样式回退顶部居中。
 * 样式写入幂等（值未变不重写，避免 DOM 观察/高频事件下的无谓样式重算）。
 * @returns {Element|null} 当前棋盘（.board-wrap）元素，供尺寸观察
 */
export function syncToastPlacement(root = document.getElementById('toast-root'), win = window, doc = document) {
  if (!root) return null;
  const boardEl = doc.querySelector('section.board-zone .board-wrap');
  const anchor = toastAnchor(boardEl && boardEl.getBoundingClientRect(), {
    rootWidth: root.offsetWidth,
    rootHeight: root.offsetHeight,
    viewportW: win.innerWidth,
    viewportH: win.innerHeight,
  });
  const style = root.style;
  if (anchor.mode === 'board') {
    const left = `${Math.round(anchor.left)}px`;
    const bottom = `${Math.round(anchor.bottom)}px`;
    if (style.left !== left) style.left = left;
    if (style.bottom !== bottom) style.bottom = bottom;
    if (style.top !== 'auto') style.top = 'auto';
  } else {
    if (style.left) style.left = '';
    if (style.bottom) style.bottom = '';
    if (style.top) style.top = '';
  }
  return boardEl;
}

let placementWired = false;
let boardObserver = null;
let observedBoardEl = null;
let mainObserver = null;

/** 单例根一次接线：窗口缩放/滚动/路由/DOM 结构变化/棋盘尺寸变化/每条 Toast 显示前重算锚点（幂等）。 */
function bindToastPlacement(root, queue) {
  if (placementWired || !root) return;
  placementWired = true;
  let rafId = 0;
  function schedule() {
    if (rafId) return;
    rafId = window.requestAnimationFrame(tick);
  }
  function tick() {
    rafId = 0;
    const boardEl = syncToastPlacement(root);
    if (boardEl === observedBoardEl) return;
    observedBoardEl = boardEl;
    if (boardObserver) { boardObserver.disconnect(); boardObserver = null; }
    if (boardEl && typeof ResizeObserver === 'function') {
      boardObserver = new ResizeObserver(schedule);
      boardObserver.observe(boardEl);
    }
  }
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('tgo:route', schedule);   // 路由装载：棋盘可能随后重建/出现
  queue.subscribe(() => { tick(); schedule(); });   // 每条 Toast 显示：同步就位（首帧不掉位）+ 兜底一帧
  // 棋盘为异步渲染（骨架屏 → 数据加载 → .board-zone 出现）：
  // 若只在路由事件/队列变化时同步，「创建对局」等跨页 Toast 会停在顶部回退位。
  if (typeof MutationObserver === 'function') {
    const host = document.getElementById('main') || document.body;
    if (host) {
      mainObserver = new MutationObserver(schedule);
      mainObserver.observe(host, { childList: true, subtree: true });
    }
  }
  tick();
}

/** 确保 toast 容器（#toast-root）存在并返回。 */
export function ensureToastRoot(doc = document) {
  let root = doc.getElementById('toast-root');
  if (!root) {
    root = doc.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast-root';
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-atomic', 'false');
    doc.body.appendChild(root);
  }
  return root;
}

/**
 * 将队列绑定到 DOM 容器；返回 detach。
 * 视觉：`[语义色 SVG 图标] + 文案`（图标按级别切换）；退场：条目从队列消失后先加
 * `.toast-out`（CSS 淡出），`TOAST_EXIT_MS` 后移除 DOM——避免旧实现直接删除导致的生硬消失。
 */
export function attachToast(containerEl, queue) {
  const map = new Map();       // id → { el, iconEl, textEl, level }
  const leaving = new Map();   // id → 退场定时器（DOM 已标记 .toast-out，待移除）
  /** 级别兜底：未知级别按 info 渲染（图标与配色同源，不出现无图标条目）。 */
  const normalizeLevel = (level) => (TOAST_ICON_ID[level] ? level : 'info');
  const render = () => {
    const seen = new Set();
    for (const item of queue.getItems()) {
      seen.add(item.id);
      const pending = leaving.get(item.id);
      if (pending) {           // 退场窗口内同 id 重新激活（合并更新/复现）
        clearTimeout(pending);
        leaving.delete(item.id);
      }
      let rec = map.get(item.id);
      if (!rec) {
        const el = document.createElement('div');
        el.innerHTML = '<span class="toast-icon"></span><span class="toast-text"></span>';
        el.addEventListener('click', () => queue.dismiss(item.id));
        containerEl.appendChild(el);
        rec = { el, iconEl: el.firstElementChild, textEl: el.lastElementChild, level: null };
        map.set(item.id, rec);
      }
      const level = normalizeLevel(item.level);
      if (rec.level !== level) {   // 新建条目 / 合并窗口内级别变化（同 id 复用同一元素）
        rec.level = level;
        rec.el.className = `toast toast-${level}`;
        rec.el.setAttribute('role', level === 'error' ? 'alert' : 'status');
        rec.iconEl.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${TOAST_ICON_ID[level]}"/></svg>`;
      }
      rec.el.classList.remove('toast-out');
      rec.textEl.textContent = item.text;
    }
    for (const [id, rec] of [...map.entries()]) {
      if (seen.has(id) || leaving.has(id)) continue;
      rec.el.classList.add('toast-out');
      const timer = setTimeout(() => {
        leaving.delete(id);
        rec.el.remove();
        map.delete(id);
      }, TOAST_EXIT_MS);
      leaving.set(id, timer);
    }
  };
  const unsub = queue.subscribe(render);
  render();
  return () => {
    unsub();
    for (const timer of leaving.values()) clearTimeout(timer);
    leaving.clear();
    for (const rec of map.values()) rec.el.remove();
    map.clear();
  };
}

/** 全局默认队列（惰性建根挂载），供壳/视图直接调用。 */
let defaultQueue = null;
let defaultAttach = null;

export function getDefaultToast() {
  if (!defaultQueue) {
    defaultQueue = new ToastQueue();
    if (typeof document !== 'undefined') {
      const root = ensureToastRoot();
      defaultAttach = attachToast(root, defaultQueue);
      bindToastPlacement(root, defaultQueue);   // 棋盘页定位跟随（无棋盘回退 CSS 顶部居中）
    }
  }
  return defaultQueue;
}

/**
 * 便捷显示（code/message 自动解析级别与文案）。
 * @param {object} [opts] {code?, message?, level?, key?, text?}
 */
export function showToast(opts = {}) {
  const { code, message, level, key, text } = opts;
  const resolved = text
    ? { level: level || 'info', text }
    : resolveToast(code, message, level);
  getDefaultToast().push(resolved.text, { level: resolved.level, key: key || code || null });
}
