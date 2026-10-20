/**
 * tGo · 引擎状态胶囊（T5.4，C3 / UI_UX §6.1）
 *
 * 数据源：状态树 `engine` 切片（由 /ws/admin 与 /ws/games engine.status 经
 * T5.3 dispatch 驱动）与 `system` 切片。点击展开详情浮层（主机/系统/后端/内存/
 * 调优进度）。纯映射 `engineStateMeta` 可无头测试。
 */

import { ENGINE_REASON, isEngineUnavailableReason, shortenDetail } from './state.js';

/** 引擎状态 → 胶囊外观（dot 类 + 文案）。
 *
 * STOPPED（未启动）与 INIT（加载中）严格分界（2026/09/18，PROMPTS [语义混用]）：
 * STOPPED＝进程未运行（从未启动/干净停止/空闲释放），INIT＝启动中（拉起/加载/调优）。
 */
export const ENGINE_STATE_META = Object.freeze({
  STOPPED: { dot: 's-off', label: '未启动', tone: 'off' },
  INIT: { dot: 's-init', label: '加载中', tone: 'init' },
  IDLE: { dot: 's-idle', label: '空闲中', tone: 'idle' },
  ANALYZING: { dot: 's-busy', label: '分析中', tone: 'busy' },
  DEAD: { dot: 's-dead', label: '引擎异常', tone: 'dead' },
  FATAL: { dot: 's-fatal', label: '引擎致命', tone: 'fatal' },
});

/**
 * 调优子态外观（INIT + progress 非 null）。后端 `progress` 语义＝benchmark 调优进度
 * （开始置 0、逐配置更新、结束清 null；manager._on_benchmark_*），故可据其把
 * 「调优中」与「加载中」分叉显示（2026/09/17 人工决策：前端派生，后端零改动）。
 */
export const ENGINE_TUNE_META = Object.freeze({ dot: 's-tune', label: '调优中', tone: 'init' });

/**
 * 调优中判定：INIT 且 progress 非 null（progress=0 属调优起点，禁止 `||`/`??` 误并）。
 * @param {string|null} state
 * @param {number|null|undefined} progress
 * @returns {boolean}
 */
export function isEngineTuning(state, progress) {
  return state === 'INIT' && progress !== null && progress !== undefined;
}

/** 状态（+调优进度）→ 元数据；未知/null → 连接中（骨架）。 */
export function engineStateMeta(state, progress = null) {
  if (isEngineTuning(state, progress)) return ENGINE_TUNE_META;
  return ENGINE_STATE_META[state] || { dot: 's-init', label: '连接中', tone: 'init' };
}

/**
 * 状态文案（胶囊标签/详情共用）：引擎不可用归因的 FATAL → 「引擎不可用」
 * （≠「引擎致命」：后者指连续崩溃，须区分真实原因，2026/09/16 事实对齐；
 * 归因集合含标准模型缺失/可执行文件缺失/启动失败，BUG-097）。
 * @param {string|null} state
 * @param {string|null} [reason] API §3.3 `reason` 可选字段
 * @param {number|null} [progress] 调优进度（非 null ⇒ INIT 显示「调优中」）
 * @returns {string}
 */
export function engineStateLabel(state, reason = null, progress = null) {
  if (state === 'FATAL' && isEngineUnavailableReason(reason)) {
    return '引擎不可用';
  }
  return engineStateMeta(state, progress).label;
}

/** 内存利用率数值（API 载荷为 {percent,...} 对象，兼容旧数字）。 */
export function memoryUsagePercent(memoryUsage) {
  if (!memoryUsage) return null;
  if (typeof memoryUsage === 'number') return memoryUsage;
  const pct = memoryUsage.percent;
  return pct === undefined || pct === null ? null : Number(pct);
}

/** 字节 → GB（1 位小数；无效/非正值返回 null）。 */
function formatGib(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n / 2 ** 30).toFixed(1);
}

/**
 * 内存利用率文案：`63%（9.9 / 15.9 GB）`。
 * 旧载荷仅含数字时退化为 `63%`；缺少 used/total 时不拼用量。
 */
export function memoryUsageText(memoryUsage) {
  if (!memoryUsage) return null;
  if (typeof memoryUsage === 'number') {
    return Number.isFinite(memoryUsage) ? `${Math.round(memoryUsage)}%` : null;
  }
  const percent = memoryUsagePercent(memoryUsage);
  if (percent === null || !Number.isFinite(percent)) return null;
  const used = formatGib(memoryUsage.used);
  const total = formatGib(memoryUsage.total);
  if (used === null || total === null) return `${Math.round(percent)}%`;
  return `${Math.round(percent)}%（${used} / ${total} GB）`;
}

/**
 * 胶囊文案：调优中与加载中分叉（UI_UX §6.1；2026/09/17 人工决策——胶囊标签不带
 * 百分比，进度百分比只在详情浮层/引导页呈现）。
 */
export function enginePillLabel(state) {
  const eng = (state && state.engine) || {};
  return engineStateLabel(eng.state || null, eng.reason || null, eng.progress ?? null);
}

/**
 * 「分析中」显示保持窗口 ms（显示级迟滞，2026/09/19 人工反馈「文案闪烁」）。
 *
 * 连续查询（全局分析/逐手补算）在两次查询之间会瞬时回 IDLE——FSM 每次查询起止
 * 都触发一次 `engine.status` 广播（实测全局分析数秒内 500+ 次状态翻转），照单
 * 渲染会让胶囊文案/圆点在 `分析中↔空闲中` 间高频闪跳。窗口内的 ANALYZING→IDLE
 * **不渲染**，待窗口到期且仍为 IDLE 才落定。
 */
export const ANALYZING_HOLD_MS = 1000;

/**
 * 胶囊显示状态决策（纯函数，显示级迟滞）。
 * - `ANALYZING` 立即生效并记时（无缝续保：新查询到达即刷新基准）；
 * - `ANALYZING → IDLE` 且距最近一次 ANALYZING 不足保持窗口 → 维持 `ANALYZING`
 *   （`deferMs`＝窗口剩余时长，调用方到期重评）；
 * - 其余状态（STOPPED/INIT/DEAD/FATAL…）**立即生效**——语义状态不得迟滞。
 * @param {{prev?:string|null, next?:string|null, now?:number, lastBusyAt?:number}} opts
 * @returns {{state:string|null, lastBusyAt:number, deferMs:number}}
 */
export function pillDisplayState({ prev = null, next = null, now = 0, lastBusyAt = 0 } = {}) {
  if (next === 'ANALYZING') return { state: 'ANALYZING', lastBusyAt: now, deferMs: 0 };
  if (prev === 'ANALYZING' && next === 'IDLE') {
    const remain = ANALYZING_HOLD_MS - Math.max(0, now - lastBusyAt);
    if (remain > 0) return { state: 'ANALYZING', lastBusyAt, deferMs: remain };
  }
  return { state: next, lastBusyAt, deferMs: 0 };
}

/** 详情浮层行（UI_UX §6.1 胶囊详情；engine/system 均来自状态树）。 */
export function engineDetailLines(state) {
  const lines = [];
  const eng = (state && state.engine) || {};
  lines.push(
    `状态：${engineStateLabel(eng.state || null, eng.reason || null, eng.progress ?? null)}`,
  );
  const unavailable = eng.state === 'DEAD' || eng.state === 'FATAL';
  if (unavailable && eng.reason === ENGINE_REASON.standardModelMissing) {
    lines.push('原因：标准模型缺失（放入模型后点击 [启动]）');
  } else if (unavailable && eng.reason === ENGINE_REASON.engineExecutableMissing) {
    lines.push('原因：katago 可执行文件缺失（就位后点击 [启动]）');
  } else if (unavailable && eng.reason === ENGINE_REASON.startupFailed) {
    const detail = shortenDetail(eng.detail);
    lines.push(`原因：引擎启动失败${detail ? `（${detail}）` : ''}`);
  }
  if (eng.progress !== undefined && eng.progress !== null) {
    lines.push(`调优进度：${eng.progress}%`);
  }
  const sys = state && state.system;
  if (sys) {
    if (sys.host) lines.push(`主机：${sys.host}`);
    if (sys.os) lines.push(`系统：${sys.os}`);
    if (sys.backend) lines.push(`KataGo 后端：${sys.backend}`);
    const mem = memoryUsageText(sys.memory_usage);
    if (mem !== null) lines.push(`内存利用率：${mem}`);
    if (sys.gpu) lines.push(`GPU：${sys.gpu}`);
  }
  if (lines.length <= 1) lines.push('暂无系统详情（连接后自动更新）');
  return lines;
}

/**
 * 将胶囊绑定到状态树与 DOM。
 * 胶囊结构约定：`<button class="eng-pill"><span class="dot s-*"></span><span class="eng-label">…</span></button>`
 * @param {object} opts { pillEl, getState, subscribe, doc? }
 * @returns {() => void} detach
 */
export function attachEnginePill(opts) {
  const { pillEl, getState, subscribe } = opts;
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!pillEl || !doc) return () => {};

  const dotEl = pillEl.querySelector('.dot');
  const labelEl = pillEl.querySelector('.eng-label');
  let pop = null;
  let outsideHandler = null;
  // 显示级迟滞（2026/09/19）：见 pillDisplayState —— 仅对 ANALYZING→IDLE
  // 做最短保持（连续查询间的瞬时回跳不渲染），其余状态立即生效。
  let display = null;
  let lastBusyAt = 0;
  let holdTimer = null;

  function render() {
    const state = getState();
    const eng = state.engine || {};
    const plan = pillDisplayState({
      prev: display,
      next: eng.state ?? null,
      now: Date.now(),
      lastBusyAt,
    });
    display = plan.state;
    lastBusyAt = plan.lastBusyAt;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (plan.deferMs > 0) {
      // 保持窗口到期重评：真实状态仍为 IDLE 则落定为空闲中
      holdTimer = setTimeout(render, plan.deferMs + 30);
    }
    const meta = engineStateMeta(display, eng.progress ?? null);
    if (dotEl) dotEl.className = `dot ${meta.dot}`;
    if (labelEl) {
      labelEl.textContent = enginePillLabel({
        ...state,
        engine: { ...eng, state: display },
      });
    }
  }

  function closePop() {
    if (pop) {
      pop.remove();
      pop = null;
    }
    if (outsideHandler) {
      doc.removeEventListener('pointerdown', outsideHandler);
      outsideHandler = null;
    }
    if (pillEl) pillEl.setAttribute('aria-expanded', 'false');
  }

  function togglePop() {
    if (pop) {
      closePop();
      return;
    }
    const lines = engineDetailLines(getState());
    pop = doc.createElement('div');
    pop.className = 'eng-detail';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '引擎详情');
    const ul = doc.createElement('ul');
    for (const line of lines) {
      const li = doc.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    pop.appendChild(ul);
    doc.body.appendChild(pop);
    pillEl.setAttribute('aria-expanded', 'true'); // disclosure 状态同步（WIG）

    // 浮层定位：胶囊下方（空间不足翻转到上方）
    const rect = pillEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const gap = 8;
    let top = rect.bottom + gap;
    let left = rect.left;
    if (top + popRect.height > window.innerHeight) top = rect.top - popRect.height - gap;
    if (left + popRect.width > window.innerWidth) left = window.innerWidth - popRect.width - 8;
    pop.style.top = `${Math.max(4, top)}px`;
    pop.style.left = `${Math.max(4, left)}px`;

    outsideHandler = (e) => {
      if (pop && !pillEl.contains(e.target) && !pop.contains(e.target)) closePop();
    };
    // 等待本次点击冒泡结束后再注册，避免立即关闭
    setTimeout(() => doc.addEventListener('pointerdown', outsideHandler), 0);
  }

  function onKey(e) {
    if (e.key === 'Escape') closePop();
  }

  pillEl.addEventListener('click', togglePop);
  doc.addEventListener('keydown', onKey);
  const unsub = subscribe(render);
  render();

  return () => {
    pillEl.removeEventListener('click', togglePop);
    doc.removeEventListener('keydown', onKey);
    if (holdTimer) clearTimeout(holdTimer);
    unsub();
    closePop();
  };
}
