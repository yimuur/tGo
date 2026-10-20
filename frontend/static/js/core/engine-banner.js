/**
 * tGo · 引擎降级横幅与恢复提示（T6.2，UI_UX §6.1/§6.2）
 *
 * 壳全局层：任何视图下按状态树 engine 切片呈现「引擎降级横幅」——
 *   - INIT + benchmark 进度：顶部横幅「首次调优中（N%）…不影响落子与复盘」；
 *   - DEAD：警示条 + [去管理页]（**不提供启动/重启按钮**：退避链自愈中，点击只会
 *     被快速失败并产生「已受理」假象——2026/09/20 人工决策，ISSUE-069）；
 *   - FATAL：警示条 + [去管理页]（手动重启入口收敛到管理页，2026/09/20 人工决策）；
 *   - **FATAL + 装配/启动归因**（BUG-097，`reason` 可选字段）：
 *     `standard_model_missing` →「引擎不可用（标准模型缺失）」；
 *     `engine_executable_missing` →「引擎不可用（katago 可执行文件缺失）」；
 *     `startup_failed` →「引擎启动失败（detail）」——均**不得呈现为「连续崩溃」**；
 *     文件就位后 [手动重启] 会重建装配并拉起引擎（服务无需重启）；
 *   - 恢复（DEAD/FATAL/调优 → IDLE/ANALYZING）：Toast「引擎已恢复」。
 *
 * 纯逻辑层（engineBannerKey/engineBannerSpec）独立导出供 node --test；
 * `attachEngineBanner` 为 DOM 驱动（showBanner/dismiss/toast 经参数注入）。
 */

import { ENGINE_REASON, shortenDetail } from './state.js';

/**
 * 降级横幅唯一动作：去管理页（2026/09/20 人工决策）。
 *
 * 动机：DEAD 期间点击启动/重试会被后端快速失败（`ENGINE_DEAD`），而 `admin.task`
 * 失败回执只有管理页视图消费 → 用户看到「已受理」却无任何反馈（ISSUE-069 G2）。
 * 引擎的启动/停止/重启入口统一收敛到管理页。
 */
const ADMIN_ACTION = Object.freeze({ label: '去管理页', key: 'admin' });

/**
 * 当前引擎态 → 横幅指纹（无横幅返回 null；用于跳过重复渲染）。
 * `reason`/`detail` 参与指纹——同态不同归因文案不得被去重吞掉（BUG-097）。
 */
export function engineBannerKey(state, progress, reason = null, detail = null) {
  if (state === 'INIT') {
    return progress !== undefined && progress !== null ? `tune:${progress}` : null;
  }
  if (state === 'DEAD') {
    return reason === ENGINE_REASON.startupFailed ? `dead:startup:${detail || ''}` : 'dead';
  }
  if (state === 'FATAL') {
    // 装配归因/启动失败与「连续崩溃」同处 FATAL 但文案/操作完全不同 → 指纹必须区分
    if (reason === ENGINE_REASON.standardModelMissing) return 'fatal:no-model';
    if (reason === ENGINE_REASON.engineExecutableMissing) return 'fatal:no-exec';
    if (reason === ENGINE_REASON.startupFailed) return `fatal:startup:${detail || ''}`;
    return 'fatal';
  }
  return null;
}

/**
 * 横幅规格派生。
 * @param {string} state
 * @param {number|null|undefined} progress
 * @param {string|null} [reason] 引擎不可用原因（API §3.3 可选字段）
 * @param {string|null} [detail] 原因说明（人类可读；BUG-097）
 * @returns {null|{tone:'warn'|'error', text:string, actions?:Array}}
 */
export function engineBannerSpec(state, progress, reason = null, detail = null) {
  const key = engineBannerKey(state, progress, reason, detail);
  if (!key) return null;
  if (key.startsWith('tune:')) {
    return {
      tone: 'warn',
      text: `首次调优中（${progress}%）…不影响落子与复盘`,
    };
  }
  if (key.startsWith('dead')) {
    const suffix =
      key.startsWith('dead:startup') && detail ? `（${shortenDetail(detail, 120)}）` : '';
    return {
      tone: 'error',
      text: `引擎异常，自动重启中${suffix}`,
      actions: [ADMIN_ACTION],
    };
  }
  // FATAL + 装配/启动归因（BUG-097）：需人工干预——重启入口**只在管理页**
  // （2026/09/20 人工决策：横幅不再提供启动/重启按钮，避免退避/终态下点击产生假受理）。
  if (key === 'fatal:no-model') {
    return {
      tone: 'error',
      text: '引擎不可用（标准模型缺失）· 放入模型文件后到管理页 [手动重启] 恢复',
      actions: [ADMIN_ACTION],
    };
  }
  if (key === 'fatal:no-exec') {
    return {
      tone: 'error',
      text: '引擎不可用（katago 可执行文件缺失）· 就位后到管理页 [手动重启] 恢复',
      actions: [ADMIN_ACTION],
    };
  }
  if (key.startsWith('fatal:startup')) {
    const suffix = detail ? `：${shortenDetail(detail, 120)}` : '';
    return {
      tone: 'error',
      text: `引擎启动失败${suffix} · 请到管理页 [手动重启]`,
      actions: [ADMIN_ACTION],
    };
  }
  // FATAL（连续崩溃已停止）
  return {
    tone: 'error',
    text: '引擎连续崩溃已停止，请到管理页 [手动重启]',
    actions: [ADMIN_ACTION],
  };
}

/** 判断是否为“问题态”（需要横幅的引擎状态）。 */
function isProblemState(state) {
  return state === 'DEAD' || state === 'FATAL';
}

/**
 * 绑定额外：恢复 Toast（从问题态/调优态 → 就绪/分析中的过渡）。
 * @param {string} prev 上一引擎状态
 * @param {string} next 当前引擎状态
 * @param {boolean} prevTuning 上一状态是否处于调优
 * @returns {null|{level:string,text:string,key:string}}
 */
export function recoveryToast(prev, next, prevTuning) {
  const recovered = next === 'IDLE' || next === 'ANALYZING';
  if (!recovered) return null;
  if (isProblemState(prev)) {
    return { level: 'info', text: '引擎已恢复', key: 'engine-recovered' };
  }
  if (prevTuning) {
    return { level: 'success', text: '引擎调优完成，已就绪', key: 'engine-ready' };
  }
  return null;
}

/**
 * 引擎降级横幅驱动（壳级绑定）。
 * @param {object} opts
 * @param {Function} opts.getState    () => store.getState()
 * @param {Function} opts.subscribe   (fn) => unsub
 * @param {Function} opts.showBanner  (spec) => dismiss        （banner.js showBanner）
 * @param {Function} opts.showToast   ({level,text,key})        （toast.js showToast）
 * @param {Function} [opts.onAction]  (actionKey:'retry'|'restart'|'admin') => void
 * @param {object} [opts.doc]
 * @returns {() => void} detach
 */
export function attachEngineBanner(opts) {
  const { getState, subscribe, showBanner, showToast, onAction = () => {} } = opts;
  let lastKey = null;
  let dismiss = null;
  let prevState = null;
  let prevTuning = false;

  function clear() {
    if (dismiss) {
      dismiss();
      dismiss = null;
    }
  }

  function render() {
    const state = getState();
    const eng = (state && state.engine) || {};
    const curState = eng.state || null;
    const curProgress = eng.progress;
    const curReason = eng.reason || null;
    const curDetail = eng.detail || null;
    const key = engineBannerKey(curState, curProgress, curReason, curDetail);

    // 恢复 Toast（问题态/调优 → 就绪）
    if (prevState && prevState !== curState) {
      const toastSpec = recoveryToast(prevState, curState, prevTuning);
      if (toastSpec && showToast) showToast(toastSpec);
    }
    prevState = curState;
    prevTuning = curState === 'INIT' && curProgress !== undefined && curProgress !== null;

    if (key === lastKey) return; // 无变化：保持现有横幅
    clear();
    lastKey = key;
    if (!key) return;

    const spec = engineBannerSpec(curState, curProgress, curReason, curDetail);
    if (!spec || !showBanner) return;
    const actions = Array.isArray(spec.actions)
      ? spec.actions.map((a) => ({
          label: a.label,
          primary: a.primary,
          onClick: () => onAction(a.key),
        }))
      : undefined;
    dismiss = showBanner({ tone: spec.tone, text: spec.text, actions });
  }

  const unsub = subscribe(render);
  render();
  return () => {
    unsub();
    clear();
  };
}
