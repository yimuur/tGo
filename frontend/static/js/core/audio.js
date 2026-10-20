/**
 * tGo · 音效管理器（T5.4，UI_UX §6.3）
 *
 * 音效集：落子 / 提子 / 成功 / 警告。本项目无自带音频资产，统一走
 * **Web Audio 合成**回退（UI_UX §6.3 合成方案），参数见表头 SOUND_SPECS。
 * 约束：
 *   - 首次用户交互后解锁音频（浏览器策略）；
 *   - 音量/静音由 settings 持久化（默认 70）；
 *   - 纯策略 `shouldPlay` / 参数 `soundSpec` 可无头测试；AudioContext 不可用时静默跳过。
 */
import { DEFAULT_VOLUME } from './settings.js';

/** 合成音效规格（类型/起止频率/时长/增益/包络）。
 *  单段音：直接写振荡器参数（`freq` 固定频 / `freqStart`→`freqEnd` 滑音）。
 *  多段音：写 `parts` 数组（各段可带 `delayMs` 依次合成）——用于需复合听感的音效。 */
export const SOUND_SPECS = Object.freeze({
  stone: { type: 'sine', freq: 1800, durMs: 50, gain: 0.5, kind: 'tap' }, // 短促“嗒”：带通感高音 + 快衰减
  // 提子（2026/09/15 人工反馈）：**不得＝落子“嗒”重复两次**，须与落子听觉可辨。
  // 复合听感：收子轻触（1200Hz 冷嗒）＋ 下滑“咣”（三角波 660→200Hz）＝“把子收走”的落定感；
  // 与落子的区别：音型（下滑 vs 平音）、音高（中低 vs 高）、时长（170ms vs 50ms）三重可辨。
  capture: {
    kind: 'parts',
    parts: [
      { type: 'sine', freq: 1200, durMs: 40, gain: 0.45, kind: 'tap' },
      { type: 'triangle', freqStart: 660, freqEnd: 200, durMs: 130, gain: 0.5, kind: 'sweep', delayMs: 45 },
    ],
  },
  success: { type: 'triangle', freqStart: 660, freqEnd: 880, durMs: 120, gain: 0.4, kind: 'sweep' },
  warning: { type: 'square', freq: 220, durMs: 160, gain: 0.25, kind: 'tap' }, // 低频短音
});

/** 播放许可策略：解锁 且 未静音。 */
export function shouldPlay({ unlocked, muted }) {
  return Boolean(unlocked) && !Boolean(muted);
}

/** 音量 → 增益（0..100 → 0..0.9，指数映射接近听觉线性）。 */
export function volumeToGain(volume) {
  const v = Number.isFinite(Number(volume)) ? Math.min(100, Math.max(0, Number(volume))) : DEFAULT_VOLUME;
  return 0.9 * Math.pow(v / 100, 1.6);
}

/**
 * 音效管理器。
 * @param {object} opts
 * @param {() => boolean} opts.isMuted
 * @param {() => number} opts.getVolume
 * @param {typeof AudioContext} [opts.AudioContextCtor]
 * @param {Function} [opts.ctxFactory]  创建 AudioContext（测试注入 fake）
 * @param {EventTarget} [opts.listenTarget] 解锁监听目标（默认 window）
 */
export function createAudioManager(opts) {
  const { isMuted = () => false, getVolume = () => DEFAULT_VOLUME } = opts;
  const listenTarget = opts.listenTarget || (typeof window !== 'undefined' ? window : null);
  const makeCtx = opts.ctxFactory || (() => {
    const Ctor = opts.AudioContextCtor || (typeof AudioContext !== 'undefined' ? AudioContext : null)
      || (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
    return Ctor ? new Ctor() : null;
  });

  let ctx = null;
  let unlocked = false;
  let armed = false;

  function ensureCtx() {
    if (!ctx) ctx = makeCtx();
    return ctx;
  }

  /** 播放单个包络（sweep 频率滑音 / tap 固定频）。 */
  function synth(ac, spec, gain) {
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = spec.type;
    if (spec.freqStart !== undefined) {
      osc.frequency.setValueAtTime(spec.freqStart, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.freqEnd || spec.freqStart), t0 + spec.durMs / 1000);
    } else {
      osc.frequency.setValueAtTime(spec.freq, t0);
    }
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.durMs / 1000);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + spec.durMs / 1000 + 0.02);
  }

  function scheduleParts(ac, spec, volume) {
    // 多段音（`parts`，如提子＝轻触＋下滑）：各段独立 osc，按各自 delayMs 依次合成；
    // 单段音视为 parts=[spec]（delay 0，同步触发——确定性、利于无头测试）
    for (const part of spec.parts || [spec]) {
      setTimeoutSafe(ac, () => synth(ac, part, volume * (part.gain || 0.5)), part.delayMs || 0);
    }
  }

  function play(name) {
    const spec = SOUND_SPECS[name];
    if (!spec || !shouldPlay({ unlocked, muted: isMuted() })) return;
    const ac = ensureCtx();
    if (!ac) return;
    const volume = volumeToGain(getVolume());
    // L-11：移动端后台挂起后 AudioContext 可能为 suspended——恢复完成后再合成
    // （旧实现直接合成无声；resume 失败静默，后续 play 仍会重试恢复）
    if (ac.state === 'suspended' && typeof ac.resume === 'function') {
      Promise.resolve(ac.resume())
        .then(() => scheduleParts(ac, spec, volume))
        .catch(() => {});
      return;
    }
    scheduleParts(ac, spec, volume);
  }

  function setTimeoutSafe(ac, fn, ms) {
    if (!(ms > 0)) {
      fn(); // 首段（或 0 延迟）同步触发：确定性、利于无头测试
      return;
    }
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
      window.setTimeout(fn, ms);
    } else if (typeof setTimeout === 'function') {
      setTimeout(fn, ms);
    } else {
      fn();
    }
  }

  function unlock() {
    if (unlocked) return;
    const ac = ensureCtx();
    if (ac && ac.state === 'suspended' && typeof ac.resume === 'function') {
      ac.resume().catch(() => {});
    }
    unlocked = true;
    disarm();
  }

  function arm() {
    if (armed || !listenTarget) return;
    armed = true;
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const onFirst = () => unlock();
    for (const ev of events) listenTarget.addEventListener(ev, onFirst, { once: true, passive: true });
  }

  function disarm() {
    armed = false;
    if (!listenTarget) return;
    // once 监听器已自动移除；此处仅保证不再重复 arm
  }

  return {
    play,
    unlock,
    arm,
    isUnlocked: () => unlocked,
  };
}
