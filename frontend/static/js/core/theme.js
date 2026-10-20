/**
 * tGo · 主题与主题色管理（T5.4）
 *
 * 遵循 UI_UX §6.6/W-19：
 *   - 明暗＝浅/深/跟随系统（`prefers-color-scheme`），持久化 localStorage `tgo.theme`；
 *   - 主题色＝黛蓝（dai）/朱砂（zhu），持久化 `tgo.accent`；
 *   - 挂载方式：`documentElement.dataset.theme / data-accent`（颜色由 css/app.css
 *     Token 驱动，含 250ms crossfade 与 accent 联动，见 §4/§6.6）；
 *   - 纯决策函数可无头测试；DOM 副作用集中在 `createThemeManager`。
 */
import { LS_KEYS, createLocalStore } from './localstore.js';

export const THEME_MODES = Object.freeze(['light', 'dark', 'system']);
export const ACCENTS = Object.freeze(['dai', 'zhu']);

/** 规范化明暗偏好：非法值回落 light。 */
export function normalizeThemeMode(mode) {
  return THEME_MODES.includes(mode) ? mode : 'light';
}

/** 规范化主题色：非法值回落 dai（黛蓝默认，W-19）。 */
export function normalizeAccent(accent) {
  return ACCENTS.includes(accent) ? accent : 'dai';
}

/**
 * 解析实际明暗：system 依据系统深浅判定。
 * @param {string} mode 'light'|'dark'|'system'
 * @param {boolean} systemDark
 * @returns {'light'|'dark'}
 */
export function resolveThemeMode(mode, systemDark) {
  const m = normalizeThemeMode(mode);
  if (m === 'system') return systemDark ? 'dark' : 'light';
  return m;
}

/** 获取系统深浅（无 matchMedia 环境回落 false=浅色）。 */
export function defaultMedia() {
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    return {
      systemDark: mq.matches,
      onChange(fn) {
        const handler = (e) => fn(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
      },
    };
  }
  return { systemDark: false, onChange: () => () => {} };
}

/**
 * 主题管理器（DOM 层）。
 * @param {object} [opts]
 * @param {object} [opts.storage]   createLocalStore 实例
 * @param {object} [opts.media]     系统深浅媒体（注入以便测试）
 * @param {HTMLElement} [opts.doc]
 * @param {Function} [opts.onChange] 解析结果变化回调（mode/accent/resolved）
 */
export function createThemeManager(opts = {}) {
  const storage = opts.storage || createLocalStore();
  const media = opts.media || defaultMedia();
  const doc = (opts.doc || (typeof document !== 'undefined' ? document : null));

  let mode = normalizeThemeMode(storage.get(LS_KEYS.theme, 'light'));
  let accent = normalizeAccent(storage.get(LS_KEYS.accent, 'dai'));
  let cachedSystemDark = Boolean(media.systemDark);
  let unsubscribeMedia = null;

  function currentSystemDark() {
    return cachedSystemDark;
  }

  function resolvedTheme() {
    return resolveThemeMode(mode, currentSystemDark());
  }

  function apply() {
    if (!doc) return;
    doc.documentElement.dataset.theme = resolvedTheme();
    doc.documentElement.dataset.accent = accent;
  }

  function syncMediaListener() {
    if (unsubscribeMedia) unsubscribeMedia();
    unsubscribeMedia = null;
    if (mode === 'system') {
      unsubscribeMedia = media.onChange((dark) => {
        // change 事件携带最新 matches（无参数事件则保持原缓存）
        if (typeof dark === 'boolean') cachedSystemDark = dark;
        apply();
        if (opts.onChange) opts.onChange(snapshot());
      });
    }
  }

  function setMode(next) {
    const normalized = normalizeThemeMode(next);
    if (normalized === mode) return snapshot();
    mode = normalized;
    storage.set(LS_KEYS.theme, normalized);
    apply();
    syncMediaListener();
    if (opts.onChange) opts.onChange(snapshot());
    return snapshot();
  }

  /** 顶栏主题按钮轮转：light → dark → system → light。 */
  function cycleMode() {
    const order = ['light', 'dark', 'system'];
    const idx = order.indexOf(mode);
    return setMode(order[(idx + 1) % order.length]);
  }

  function setAccent(next) {
    const normalized = normalizeAccent(next);
    if (normalized === accent) return snapshot();
    accent = normalized;
    storage.set(LS_KEYS.accent, normalized);
    apply();
    if (opts.onChange) opts.onChange(snapshot());
    return snapshot();
  }

  function snapshot() {
    return { mode, accent, resolved: resolvedTheme(), systemDark: currentSystemDark() };
  }

  apply();
  syncMediaListener();

  return {
    getMode: () => mode,
    getAccent: () => accent,
    getResolved: () => resolvedTheme(),
    setMode,
    cycleMode,
    setAccent,
    snapshot,
  };
}
