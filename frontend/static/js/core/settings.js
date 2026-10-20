/**
 * tGo · 用户偏好设置（T5.4）
 *
 * 基于 localstore（LS_KEYS 集中）：音量（默认 70）、静音、主题明暗偏好、
 * 主题色。另提供 `prefers-reduced-motion` 判定（UI_UX §6.8：关闭位移动画）。
 * 无 DOM 依赖（media 注入），可无头测试。
 */
import { LS_KEYS, createLocalStore } from './localstore.js';

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;
export const DEFAULT_VOLUME = 70;

/** 落子动画开关默认值（=开）。 */
export const STONE_MOTION_DEFAULT = true;

/** 变化图预览步数默认值 / 上下限（UI_UX D-变更：5–15）。 */
export const PREVIEW_STEPS_DEFAULT = 10;
export const PREVIEW_STEPS_MIN = 5;
export const PREVIEW_STEPS_MAX = 15;

/** 显示当前 AI 匹配档位默认值（=开；关时对弈信息行显示 `AI 自适应`）。 */
export const SHOW_AI_MATCH_DEFAULT = true;

/** 页面背景装饰纹理（background.svg）默认值（=关，产品默认无纹理）。 */
export const DECOR_DEFAULT = false;

/** 读取落子动画开关（存储损坏/缺失 → 默认开；无 DOM 环境安全）。 */
export function stoneMotionEnabled() {
  try {
    return createLocalStore().get(LS_KEYS.stoneMotion, STONE_MOTION_DEFAULT) !== false;
  } catch {
    return STONE_MOTION_DEFAULT;
  }
}

/** 写落子动画开关。 */
export function setStoneMotion(enabled) {
  try {
    createLocalStore().set(LS_KEYS.stoneMotion, Boolean(enabled));
  } catch {
    /* 存储不可用时静默忽略（回退默认开） */
  }
}

/** 钳制变化图预览步数到 [5,15] 整数。 */
export function clampPreviewSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return PREVIEW_STEPS_DEFAULT;
  return Math.max(PREVIEW_STEPS_MIN, Math.min(PREVIEW_STEPS_MAX, Math.round(n)));
}

/** 读取变化图预览步数（损坏/缺失 → 默认 10）。 */
export function getPreviewSteps() {
  try {
    return clampPreviewSteps(createLocalStore().get(LS_KEYS.previewSteps, PREVIEW_STEPS_DEFAULT));
  } catch {
    return PREVIEW_STEPS_DEFAULT;
  }
}

/** 写变化图预览步数（钳制 [5,15]）。 */
export function setPreviewSteps(steps) {
  try {
    createLocalStore().set(LS_KEYS.previewSteps, clampPreviewSteps(steps));
  } catch {
    /* 存储不可用时静默忽略 */
  }
}

/** 读取“显示当前 AI 匹配档位”偏好（损坏/缺失 → 默认开）。 */
export function showAiMatchEnabled() {
  try {
    return createLocalStore().get(LS_KEYS.showAiMatch, SHOW_AI_MATCH_DEFAULT) !== false;
  } catch {
    return SHOW_AI_MATCH_DEFAULT;
  }
}

/** 写“显示当前 AI 匹配档位”偏好。 */
export function setShowAiMatch(enabled) {
  try {
    createLocalStore().set(LS_KEYS.showAiMatch, Boolean(enabled));
  } catch {
    /* 存储不可用时静默忽略 */
  }
}

/** 读取页面背景装饰纹理偏好（损坏/缺失 → 默认关）。 */
export function decorEnabled() {
  try {
    return createLocalStore().get(LS_KEYS.decor, DECOR_DEFAULT) === true;
  } catch {
    return DECOR_DEFAULT;
  }
}

/** 写页面背景装饰纹理偏好。 */
export function setDecor(enabled) {
  try {
    createLocalStore().set(LS_KEYS.decor, Boolean(enabled));
  } catch {
    /* 存储不可用时静默忽略 */
  }
}

/** 注入式 reduced-motion 媒体；无 matchMedia 环境回落 false。 */
export function defaultReducedMotion() {
  if (typeof matchMedia === 'function') {
    return { matches: matchMedia('(prefers-reduced-motion: reduce)').matches };
  }
  return { matches: false };
}

/**
 * 创建设置访问器。
 * @param {object} [opts]
 * @param {object} [opts.storage]  createLocalStore 实例（默认 localStorage→内存回退）
 * @param {{matches:boolean}} [opts.reducedMotion]
 */
export function createSettings(opts = {}) {
  const storage = opts.storage || createLocalStore();
  const reduced = opts.reducedMotion || defaultReducedMotion();

  function clampVolume(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_VOLUME;
    return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, n));
  }

  return {
    getVolume() {
      return clampVolume(storage.get(LS_KEYS.volume, DEFAULT_VOLUME));
    },
    setVolume(value) {
      storage.set(LS_KEYS.volume, clampVolume(value));
    },
    isMuted() {
      return Boolean(storage.get(LS_KEYS.muted, false));
    },
    setMuted(muted) {
      storage.set(LS_KEYS.muted, Boolean(muted));
    },
    reducedMotion() {
      return Boolean(reduced.matches);
    },
    /** 落子动画开关（管理页 UI 设置可关；默认开）。 */
    stoneMotion() {
      return storage.get(LS_KEYS.stoneMotion, STONE_MOTION_DEFAULT) !== false;
    },
    setStoneMotion(enabled) {
      storage.set(LS_KEYS.stoneMotion, Boolean(enabled));
    },
    /** 显示当前 AI 匹配档位（默认开；关时信息行显示 `AI 自适应`）。 */
    showAiMatch() {
      return storage.get(LS_KEYS.showAiMatch, SHOW_AI_MATCH_DEFAULT) !== false;
    },
    setShowAiMatch(enabled) {
      storage.set(LS_KEYS.showAiMatch, Boolean(enabled));
    },
    /** 变化图预览步数（钳制 [5,15]）。 */
    previewSteps() {
      return clampPreviewSteps(storage.get(LS_KEYS.previewSteps, PREVIEW_STEPS_DEFAULT));
    },
    setPreviewSteps(steps) {
      storage.set(LS_KEYS.previewSteps, clampPreviewSteps(steps));
    },
    /** 页面背景装饰纹理（background.svg）。 */
    decor() {
      return storage.get(LS_KEYS.decor, DECOR_DEFAULT) === true;
    },
    setDecor(enabled) {
      storage.set(LS_KEYS.decor, Boolean(enabled));
    },
  };
}
