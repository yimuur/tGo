/**
 * tGo · 首启引导视图（T6.2，UI_UX §5.1 / §2.2 J1）
 *
 * 职责（首启检测在 app.js 完成 → 以本视图替代路由视图装载）：
 *   - 模型自检：`GET /api/admin/models` → 标准/人类模型存在性派生
 *     （标准缺失＝**降级态（不阻断进入）**：人机对弈与实时分析不可用，人人对弈/历史复盘
 *      照常 → [如何放置模型] 帮助 + [重新检测]，2026/09/16 人工口径）；
 *   - 引擎初始化/benchmark 进度：订阅 store `engine.status`
 *     （STOPPED＝未启动；INIT 无进度＝启动中；INIT+progress＝`GPU 调优 N% · 已用时 m:ss` + 进度条）；
 *   - 引擎自动拉起（ISSUE-065 方案 B / BUG-080）：仅本页面会话首次（STOPPED 未启动段）
 *     自动 `POST /admin/engines/start`；曾就绪后回 STOPPED（空闲释放/手动停止）不补拉，
 *     改呈现「未运行/按需启动」（引擎实际由对局/复盘的分析提交按需拉起）；
 *     拉起请求被中断/失败（服务重启等）时，在 WS 重连成功后允许重试一次；
 *   - 进入分流：点击 [进入 tGo] → `GET /api/games/active-latest`
 *     （存在 → 恢复确认弹层：恢复 / 新开；否则 → 创建向导）。
 *
 * 纯函数层（deriveXxx）与视图（createView）同文件拆分：前者供 node --test
 * 无头覆盖；视图为 `class XxxView` 形态工厂 `createView(rootEl, props)`，
 * 生命周期 render/destroy 对齐 PROPS §4。本模块顶层无 DOM 副作用。
 */

import { aiSideDisplay } from '../core/game-model.js';
import { ENGINE_REASON, shortenDetail } from '../core/state.js';

/* ============================================================
 * 纯函数层（无头可测）
 * ============================================================ */

/** 首启判定：localStorage 记录 `tgo.onboarded` 缺失/假 → 需要引导。 */
export function needsOnboarding(onboarded) {
  return !Boolean(onboarded);
}

/**
 * 首启门禁适用性（BUG-103）：未完成首启时，**管理页不受门禁**。
 *
 * 管理页是首启期修复引擎/模型的唯一出口——UI_UX §5.1「引擎未运行 · 进入对局或至
 * 管理页启动」、模型帮助弹层 [前往管理页]、引擎降级横幅 [去管理页] 均指向 `#/admin`。
 * 旧实现门禁把 `#/admin` 也强制装载引导页：点击后地址栏变为 `#/admin` 但视图不动
 * （静默失败）。豁免仅限管理页：其余路由（对弈/创建/复盘）仍由引导页把关，
 * [进入 tGo] 仍是完成首启的唯一路径（恢复/新建分流不受影响）。
 *
 * @param {string|null} routeName 规范化路由名（`normalizeRoute().name`）
 * @param {boolean} onboarded     `tgo.onboarded` 已置位
 * @returns {boolean} 是否强制装载 onboarding（虚拟路由）
 */
export function onboardingGate(routeName, onboarded) {
  return needsOnboarding(onboarded) && routeName !== 'admin';
}

/**
 * 模型自检派生（`GET /api/admin/models` 响应体，T6.1 白名单）。
 * @param {object|null|undefined} payload { models:[{name,human,default}],
 *        default, humanModelAvailable }
 * @returns {null|{standard:{ok:boolean,name:string|null}, human:{ok:boolean},
 *          standardMissing:boolean}}
 *   null = 数据未就绪/检测失败（HTTP 错误等）；`standardMissing` = 标准模型缺失
 *   ——**降级态（不阻断进入）**：人机对弈与实时分析不可用，人人对弈/历史复盘照常
 *   （2026/09/16 人工口径；原先记为「阻断态」）。
 */
export function deriveModelCheck(payload) {
  if (!payload || !Array.isArray(payload.models)) return null;
  const models = payload.models;
  const standard = models.filter((m) => !m.human);
  const standardOk = standard.length > 0;
  return {
    standard: {
      ok: standardOk,
      name: standardOk ? payload.default || standard[0].name || null : null,
    },
    human: {
      ok: Boolean(payload.humanModelAvailable) || models.some((m) => m.human),
    },
    standardMissing: !standardOk,
  };
}

/**
 * [进入 tGo] 按钮态（UI_UX §5.3：进入 always 可用，分析类功能降级即可）。
 *
 * BUG-082 教训：旧实现「自检进行中」与「自检失败」一律禁用按钮——移动端
 * （iOS/Safari）网络切换后 `GET /admin/models` 可能长时间不返回，用户被永久
 * 困在引导页（无法进入、无法恢复页面）。
 * BUG-090（2026/09/16 人工口径）：**标准模型缺失同样不得阻断进入**——进入后仅
 * AI 功能降级（创建向导按引擎状态灰置人机模式），**人人对弈与历史复盘照常**。
 * 现行口径：仅「自检**进行中**」禁用（防御连点）；自检失败/完成（含标准模型
 * 缺失）均可进入。
 * @param {{check?:null|object, checkError?:boolean}} state
 * @returns {{disabled:boolean, text:string}}
 */
export function enterButtonState({ check = null, checkError = false } = {}) {
  if (!check && !checkError) return { disabled: true, text: '检测中…' };
  return { disabled: false, text: '进入 tGo' };
}

/**
 * 模型自检说明文案（视图与无头测试共用；空串＝无需提示）。
 * @param {null|object} check `deriveModelCheck` 结果（null＝检测中/失败，由视图另述）
 * @returns {string}
 */
export function modelNoteText(check) {
  if (!check) return '';
  if (check.standardMissing) {
    return '标准模型缺失：人机对弈与实时分析不可用；人人对弈、历史复盘照常可用（放入模型后重新检测）。';
  }
  if (!check.human.ok) return '人类风格 / 自适应难度不可用，标准风格对弈正常。';
  return '';
}

/** 引擎步进类型（onboarding 步骤 2 的呈现分支）。 */
export const ENGINE_STEP = Object.freeze({
  connecting: 'connecting', // 尚无 engine.status（WS 未到/REST 兜底未完成）
  stopped: 'stopped',       // STOPPED（未启动：进程未运行）
  init: 'init',             // INIT 无 benchmark 进度（启动中：加载权重）
  tuning: 'tuning',         // INIT + benchmark 进度（GPU 调优）
  ready: 'ready',           // IDLE
  busy: 'busy',             // ANALYZING
  dead: 'dead',             // DEAD（自动重试中）
  fatal: 'fatal',           // FATAL（连续崩溃，需手动重启）
});

/** 引擎切片 → 步进类型。 */
export function deriveEngineStep(engine) {
  const state = engine && engine.state;
  if (!state) return ENGINE_STEP.connecting;
  if (state === 'STOPPED') return ENGINE_STEP.stopped;
  if (state === 'INIT') {
    return engine.progress !== undefined && engine.progress !== null
      ? ENGINE_STEP.tuning
      : ENGINE_STEP.init;
  }
  if (state === 'IDLE') return ENGINE_STEP.ready;
  if (state === 'ANALYZING') return ENGINE_STEP.busy;
  if (state === 'DEAD') return ENGINE_STEP.dead;
  if (state === 'FATAL') return ENGINE_STEP.fatal;
  return ENGINE_STEP.connecting;
}

/** 引擎行呈现模式 = 步进类型 + `released`（曾就绪后被空闲释放的「未运行」，ISSUE-065 方案 B）。 */
export const ENGINE_MODE = Object.freeze({
  ...ENGINE_STEP,
  released: 'released',
});

/**
 * 引擎行计划（ISSUE-065 方案 B；2026/09/18 STOPPED/INIT 语义拆分）：
 *   1. STOPPED（未启动：进程未运行）且未就绪过、未被标准模型缺失阻断、本页面会话
 *      未拉起过 → pull=true（每会话一次）；
 *   2. 曾就绪（everReady，无论本会话是否拉起过）后回 STOPPED（空闲释放/手动停止）→
 *      呈现 `released`（未运行），不补拉；
 *   3. INIT（加载/调优进行中）：已拉起但未达就绪 → 保持「启动中…」，幂等补发一次
 *      （服务端 ensure_ready 对已在加载的引擎空操作）。
 * 注：旧实现以「INIT 无进度」同时表达未启动与加载中（语义混用），故把未启动段
 *     （STOPPED）单独分支，避免空闲释放后被误重复拉起。
 * @param {{step:string, standardMissing?:boolean, autoStarted?:boolean,
 *          everReady?:boolean, pending?:boolean}} state
 * @returns {{mode:string, pull:boolean}}
 */
export function engineOnboardPlan(state = {}) {
  const {
    step,
    standardMissing = false,
    autoStarted = false,
    everReady = false,
    pending = false,
  } = state;
  if (step !== ENGINE_STEP.stopped && step !== ENGINE_STEP.init) {
    return { mode: step, pull: false };
  }
  const pull = !standardMissing && !autoStarted && !pending;
  if (step === ENGINE_STEP.stopped) {
    return {
      mode: everReady ? ENGINE_MODE.released : ENGINE_STEP.init,
      pull: everReady ? false : pull,
    };
  }
  return { mode: step, pull };
}

/**
 * 引擎行文案覆盖（事实对齐）：引擎不可用归因（`GET /admin/engines` 的 `reason`/`detail`，
 * API §3.3 可选字段）——呈现须指向真实原因（标准模型缺失 / 可执行文件缺失 / 启动失败），
 * 不得误导为「连续崩溃已停止」（BUG-090 同口径；BUG-097 扩展归因集合）。
 * 文件就位后管理页 [手动重启]/[启动] 会运行时重建装配（服务无需重启）。
 * @param {string} mode `engineOnboardPlan().mode`
 * @param {string|null} [reason] 引擎切片 `reason`（API §3.3）
 * @param {string|null} [detail] 原因说明（BUG-097）
 * @returns {{text:string, note:string}|null} null＝用引擎表内文案
 */
export function engineCopyOverride(mode, reason = null, detail = null) {
  if (mode !== ENGINE_STEP.fatal) return null;
  if (reason === ENGINE_REASON.standardModelMissing) {
    return {
      text: '引擎不可用（标准模型缺失）',
      note: '放入标准模型后点击 [重新检测]（或至管理页 [手动重启]）；人人对弈与历史复盘不受影响。',
    };
  }
  if (reason === ENGINE_REASON.engineExecutableMissing) {
    return {
      text: '引擎不可用（katago 可执行文件缺失）',
      note: '请检查 engine/katago 目录（engine.executable_dir）后重新检测；人人对弈与历史复盘不受影响。',
    };
  }
  if (reason === ENGINE_REASON.startupFailed) {
    const cause = shortenDetail(detail, 160);
    return {
      text: '引擎启动失败',
      note: `${cause ? `原因：${cause}；` : ''}可至管理页 [手动重启] 重试；人人对弈与历史复盘不受影响。`,
    };
  }
  return null;
}

/**
 * 连接恢复重试（BUG-080 F5）：本会话已发起自动拉起但从未达就绪（服务重启中断等）
 * → WS 重连成功时允许再试一次（已就绪过（空闲释放）不因重连补拉：方案 B）。
 * 安全性依赖后端 `ensure_ready` 幂等：对已在运行/加载中的引擎重复 POST 为空操作。
 * @param {{autoStarted?:boolean, everReady?:boolean}} state
 * @returns {boolean}
 */
export function engineReconnectRetry(state = {}) {
  return Boolean(state.autoStarted) && !state.everReady;
}

/** benchmark 进度钳制 0..100（服务端已钳制，消费侧防御）。 */
export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 调优行文案：`GPU 调优 N%`；progress 缺省（非调优态）→ null。
 * （后端 engine.status.progress 为 0..100 整数百分比，即产品呈现语义（方案一）；
 *   静态稿示例文案 "3/12" 为 Demo 数值，不回写基线。）
 */
export function benchmarkText(progress) {
  if (progress === undefined || progress === null) return null;
  return `GPU 调优 ${clampPercent(progress)}%`;
}

/** 耗时格式化：毫秒 → `m:ss`（如 84200 → "1:24"）。 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const sec = Math.floor(total % 60);
  const min = Math.floor(total / 60);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/**
 * 进入分流计划：`GET /api/games/active-latest`（GameInfo 白名单或 null）。
 * @returns {{resume:boolean, game:null|{id:number,title:string}}}
 *   resume=true 时由视图弹恢复确认；否则直接进创建向导。
 */
export function entryPlan(activeLatest) {
  if (!activeLatest) return { resume: false, game: null };
  return { resume: true, game: { id: Number(activeLatest.id), title: describeActive(activeLatest) } };
}

/** 进行中对局简述（恢复确认弹层文案）。AI 侧按共享派生显示 `AI`（人工口径 2026/09/10）。 */
export function describeActive(game) {
  const blackAi = aiSideDisplay(game, 'black');
  const whiteAi = aiSideDisplay(game, 'white');
  const black = blackAi ? blackAi.name : (game.black_name || '真人');
  const white = whiteAi ? whiteAi.name : (game.white_name || '真人');
  const size = game.board_size || 19;
  const moveNo = Number(game.last_move_no) || 0;
  return `黑 ${black} vs 白 ${white} · ${size} 路 · 第 ${moveNo} 手`;
}

/* ============================================================
 * 视图工厂（浏览器；依赖经 props 注入，便于 demo/测试替换）
 * ============================================================ */

const ICON_OK = '<svg class="icon ok" aria-hidden="true"><use href="#i-success"/></svg>';
const ICON_NO = '<svg class="icon no" aria-hidden="true"><use href="#i-error"/></svg>';

/** 步骤 2 引擎行的 icon 文本映射（按步进类型）。 */
const STEP_ICON = {
  connecting: '<svg class="icon" style="color:var(--text-3)" aria-hidden="true"><use href="#i-engine"/></svg>',
  init: '<svg class="icon" style="color:var(--eng-init)" aria-hidden="true"><use href="#i-engine"/></svg>',
  tuning: '<svg class="icon" style="color:var(--eng-init)" aria-hidden="true"><use href="#i-tune"/></svg>',
  ready: ICON_OK,
  busy: '<svg class="icon" style="color:var(--eng-busy)" aria-hidden="true"><use href="#i-engine"/></svg>',
  dead: ICON_NO,
  fatal: ICON_NO,
  released: '<svg class="icon" style="color:var(--text-3)" aria-hidden="true"><use href="#i-engine"/></svg>',
};

const STEP_TEXT = {
  connecting: '正在连接引擎服务…',
  init: '引擎启动中…（加载权重）',
  tuning: null, // 动态：GPU 调优 N% · 已用时 m:ss
  ready: '引擎就绪 · 可开始对弈',
  busy: '引擎分析中',
  dead: '引擎异常，自动重试中',
  fatal: '引擎连续崩溃已停止，需手动重启',
  released: '引擎未运行 · 进入对局或至管理页启动',
};

const STEP_NOTE = {
  connecting: '引擎状态由顶栏胶囊常驻呈现。',
  init: '首次加载权重需片刻，期间可正常落子，AI 分析功能延后可用。',
  tuning: '首次调优约 5–10 分钟，期间可正常落子，AI 分析功能延后可用。',
  ready: '',
  busy: '',
  dead: 'AI 相关功能暂不可用；人人对弈落子与复盘不受影响（人机对弈需等待引擎恢复）。',
  fatal: '请至管理页手动重启引擎（或稍后点击顶栏胶囊查看详情）。',
  released: '按需启动：进行 AI 对弈/复盘分析等需要引擎的环节时自动拉起，也可至管理页手动启动。',
};

/**
 * 创建首启引导视图。
 * @param {HTMLElement} rootEl 视图挂载点（className 会被接管为 welcome-wrap）
 * @param {object} props
 * @param {object} props.store        状态树（createStore 实例，必填）
 * @param {object} [props.api]        REST 客户端（{get(path)→{status,data}}） * @param {object} [props.hub]        WS Hub（subscribeStatus 注入；连接恢复重试 BUG-080） * @param {object} [props.ls]         localstore 访问器（进入时写 onboarded）
 * @param {Function} [props.toast]    通知（T5.4 showToast 兼容签名）
 * @param {Function} [props.confirm]  确认框（async opts → boolean）
 * @param {Function} [props.onComplete] 分流完成回调 (dest:'resume'|'create')
 * @param {Function} [props.nav]       跳转 (hash)
 * @param {Document} [props.doc]
 * @returns {{render():void, destroy():void}}
 */
export function createView(rootEl, props = {}) {
  const store = props.store;
  const doc = props.doc || (typeof document !== 'undefined' ? document : null);
  const ls = props.ls || null;
  const api = props.api || null;
  const hub = props.hub || null;
  const toast = props.toast || (() => {});
  const confirmFn = props.confirm || null;
  const onComplete = props.onComplete || (() => {});
  const nav = props.nav || ((hash) => { if (location) location.hash = hash; });

  if (!store || !doc) {
    return {
      render() {},
      destroy() {},
      get modelCheck() { return null; },
    };
  }

  let check = null; // deriveModelCheck 结果 / null=检测中或失败
  let checkError = false;
  let enterBusy = false;
  let elapsedTimer = null;
  let tuningSince = null; // benchmark 起始毫秒（单调时钟）
  let prevStep = null;
  let autoStartPending = false; // 引擎自动 [启动] 请求进行中
  let autoStarted = false; // 本页面会话已发起过自动启动（方案 B：至多一次）
  let everReady = false; // 本页面会话引擎曾达就绪（此后释放不回拉）
  const unsubscribers = [];

  const $ = (id) => rootEl.querySelector(`#${id}`);
  let nodes = {};

  // ---------- 纯 DOM 构造 ----------

  function skeletonHTML() {
    return `
<section class="card welcome">
  <h1 class="welcome-title"><span class="sr-only">欢迎来到 tGo</span></h1>
  <div class="sub">AI 智能围棋对弈与分析平台 · KataGo 驱动</div>

  <div class="welcome-steps">
    <div class="wstep">
      <span class="no">1</span>
      <div class="body">
        <div class="tt">模型自检</div>
        <div class="model-check" id="ob-model-check">
          <div class="mrow" id="ob-model-standard"></div>
          <div class="mrow" id="ob-model-human"></div>
        </div>
        <div class="dd" id="ob-model-note" style="margin-top:6px"></div>
      </div>
    </div>

    <div class="wstep">
      <span class="no">2</span>
      <div class="body">
        <div class="tt" id="ob-engine-tt">引擎初始化</div>
        <div class="dd" id="ob-engine-line" style="display:flex;align-items:center;gap:6px;margin-top:4px"></div>
        <div class="progress" id="ob-engine-bar-wrap" style="display:none">
          <div class="bar warn" id="ob-engine-bar" style="width:0%"></div>
        </div>
        <div class="dd" id="ob-engine-note" style="margin-top:6px"></div>
      </div>
    </div>
  </div>

  <div class="foot" style="flex-wrap:wrap;row-gap:10px">
    <button class="btn btn-primary btn-lg" id="ob-enter" type="button">进入 tGo</button>
    <button class="btn btn-secondary btn-sm" id="ob-help" type="button" style="display:none">如何放置模型</button>
    <button class="btn btn-ghost btn-sm" id="ob-recheck" type="button">重新检测</button>
    <span class="muted" id="ob-hint" style="font-size:12px;width:100%;line-height:1.6">随时可进入，引擎状态由顶栏胶囊常驻呈现</span>
  </div>
</section>`;
  }

  function setModelLoading() {
    nodes.standard.innerHTML =
      '<svg class="icon" style="color:var(--text-3)" aria-hidden="true"><use href="#i-engine"/></svg>标准模型 · 检测中…';
    nodes.human.innerHTML =
      '<svg class="icon" style="color:var(--text-3)" aria-hidden="true"><use href="#i-engine"/></svg>人类模型 · 检测中…';
    nodes.note.textContent = '';
    const btn = nodes.enter;
    btn.disabled = true;
    btn.textContent = '检测中…';
  }

  function renderModel() {
    if (!check) {
      // 检测失败或尚未完成
      const fail = checkError ? '标准模型 · 检测失败（无法连接服务）' : '';
      nodes.standard.innerHTML = checkError
        ? `${ICON_NO}${fail}`
        : '<svg class="icon" style="color:var(--text-3)" aria-hidden="true"><use href="#i-engine"/></svg>标准模型 · 检测中…';
      nodes.human.innerHTML = checkError
        ? ''
        : '<svg class="icon" style="color:var(--text-3)" aria-hidden="true"><use href="#i-engine"/></svg>人类模型 · 检测中…';
      nodes.note.textContent = checkError ? '请确认后端服务已启动后重新检测。' : '';
      // 检测失败 → 允许降级进入（不得把用户永久困在引导页，BUG-082）
      const state = enterButtonState({ check, checkError });
      nodes.enter.disabled = state.disabled;
      nodes.enter.textContent = state.text;
      nodes.recheck.hidden = false;
      nodes.help.style.display = 'none';
      return;
    }

    // 标准模型行（缺失＝降级态：不阻断进入，仅 AI 功能不可用）
    if (check.standard.ok) {
      nodes.standard.innerHTML = `${ICON_OK}标准模型 · 已找到`;
    } else {
      nodes.standard.innerHTML =
        `${ICON_NO}标准模型 · 未找到 <span class="badge danger">影响</span>`;
    }
    // 人类模型行
    if (check.human.ok) {
      nodes.human.innerHTML = `${ICON_OK}人类模型 · 已找到`;
    } else {
      nodes.human.innerHTML = `${ICON_NO}人类模型 · 未找到 <span class="badge warn">影响</span>`;
    }
    // 说明（纯函数派生：标准缺失 → 人机/实时分析不可用，人人对弈/历史复盘照常）
    nodes.note.textContent = modelNoteText(check);
    // 按钮态统一由纯函数派生（与检测失败分支同源，BUG-082/090：进入 always 可用）
    const state = enterButtonState({ check, checkError });
    nodes.enter.disabled = state.disabled;
    nodes.enter.textContent = state.text;
    nodes.help.style.display = check.standardMissing ? '' : 'none';
  }

  function updateEngineUI(mode) {
    const eng = (store.getState() || {}).engine || {};
    const ttEl = nodes.engineTt;
    const lineEl = nodes.engineLine;
    const barWrap = nodes.engineBarWrap;
    const barEl = nodes.engineBar;
    const noteEl = nodes.engineNote;
    // 文案覆盖（事实对齐）：服务端 reason/detail 的 FATAL 归因（BUG-097）
    const copy = engineCopyOverride(mode, eng.reason || null, eng.detail || null);

    // 标题徽章
    ttEl.innerHTML = '引擎初始化';
    const badge = document.createElement('span');
    badge.className = 'badge warn num';
    if (mode === ENGINE_STEP.tuning) {
      badge.textContent = '调优中';
      ttEl.appendChild(badge);
    } else if (mode === ENGINE_STEP.init || mode === ENGINE_STEP.connecting) {
      badge.className = 'badge info num';
      badge.textContent = mode === ENGINE_STEP.init ? '启动中' : '连接中';
      ttEl.appendChild(badge);
    } else if (mode === ENGINE_MODE.released) {
      badge.className = 'badge num';
      badge.textContent = '未运行';
      ttEl.appendChild(badge);
    } else if (mode === ENGINE_STEP.ready) {
      badge.className = 'badge accent num';
      badge.textContent = '就绪';
      ttEl.appendChild(badge);
    }

    // 行文案
    lineEl.innerHTML = STEP_ICON[mode] || '';
    const textSpan = document.createElement('span');
    if (mode === ENGINE_STEP.tuning) {
      const pct = clampPercent(eng.progress);
      const elapsed = tuningSince !== null ? formatElapsed(Date.now() - tuningSince) : '0:00';
      textSpan.textContent = `${benchmarkText(pct)} · 已用时 ${elapsed}`;
      lineEl.style.color = 'var(--eng-init)';
      textSpan.style.fontWeight = '600';
    } else {
      textSpan.textContent = (copy && copy.text) || STEP_TEXT[mode] || '';
      lineEl.style.color = '';
      textSpan.style.fontWeight = '';
    }
    lineEl.appendChild(textSpan);

    // 进度条（仅 加载中/调优 显示）
    if (mode === ENGINE_STEP.tuning || mode === ENGINE_STEP.init || mode === ENGINE_STEP.connecting) {
      barWrap.style.display = '';
      barEl.classList.toggle('indet', mode !== ENGINE_STEP.tuning);
      barEl.style.width = mode === ENGINE_STEP.tuning ? `${clampPercent(eng.progress)}%` : '30%';
    } else {
      barWrap.style.display = 'none';
    }

    // 说明（仅连接/启动/调优/异常/未运行态）
    noteEl.textContent = (copy && copy.note) || STEP_NOTE[mode] || '';
    noteEl.style.display = noteEl.textContent ? '' : 'none';
  }

  // ---------- 引擎订阅与计时 ----------

  function manageTuningTimer(step) {
    if (step === ENGINE_STEP.tuning) {
      if (tuningSince === null) tuningSince = Date.now();
      if (!elapsedTimer) {
        elapsedTimer = setInterval(() => {
          if ((store.getState() || {}).engine && deriveEngineStep(store.getState().engine) === ENGINE_STEP.tuning) {
            updateEngineUI(ENGINE_STEP.tuning);
          }
        }, 1000);
      }
    } else {
      tuningSince = null;
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
    }
  }

  function onEngineChange() {
    const eng = (store.getState() || {}).engine || {};
    const step = deriveEngineStep(eng);
    if (step !== prevStep) {
      prevStep = step;
      manageTuningTimer(step);
    }
    // 曾就绪（含首启自动拉起完成）→ 此后空闲释放不回拉（方案 B）
    if (step === ENGINE_STEP.ready) everReady = true;
    const plan = engineOnboardPlan({
      step,
      standardMissing: Boolean(check && check.standardMissing),
      autoStarted,
      everReady,
      pending: autoStartPending,
    });
    if (nodes.engineLine) updateEngineUI(plan.mode);
    maybeAutoStart(plan);
  }

  /** 首启自动拉起引擎：resident=false 默认后端不会自动启动引擎，
   *  引导页在 STOPPED（未启动）段主动 POST /engines/start（方案 B：每页面会话至多一次），
   *  避免“启动中/加载中”永不结束。 */
  async function autoStartEngine() {
    if (!api) return;
    autoStartPending = true;
    try {
      await api.post('/admin/engines/start');
    } catch (err) {
      // 启动失败（引擎 FATAL/后端异常等）：不打断引导，交由胶囊/引擎状态呈现
      toast({
        level: 'info',
        text: '引擎未能自动启动，可稍后重试或至管理页启动',
      });
    } finally {
      autoStartPending = false;
    }
  }

  function maybeAutoStart(plan) {
    if (!plan.pull || !api) return;
    autoStarted = true; // 标记已拉起（失败也不自动重发；重试由连接恢复触发）
    autoStartEngine();
  }

  // ---------- 数据动作 ----------

  async function runModelCheck() {
    check = null;
    checkError = false;
    if (nodes.enter) renderModel();
    if (!api) {
      // 无后端（纯演示/降级）：保持检测中，不阻断 UI
      return;
    }
    try {
      const res = await api.get('/admin/models');
      check = deriveModelCheck(res && res.data);
      if (!check) throw new Error('models 响应结构异常');
    } catch (err) {
      check = null;
      checkError = true;
      if (toast) toast({ code: (err && err.code) || 'NETWORK_ERROR', message: (err && err.message) || '模型自检失败', level: 'error' });
    }
    // 模型自检同时刷新引擎状态（BUG-097）：服务端 GET /admin/engines 按当前文件系统
    // 重检归因——放入模型/可执行文件后不再停留旧的「缺失」提示（STOPPED 未启动段
    // 则由自动拉起接续）。
    try {
      const eng = await api.get('/admin/engines');
      if (eng && eng.data && eng.data.state && store) {
        store.dispatch({ type: 'engine.status', data: eng.data });
      }
    } catch {
      /* 非致命：引擎行保持现状（WS 状态推送/下次刷新覆盖） */
    }
    if (nodes.enter) renderModel();
  }

  function showModelHelp() {
    if (!confirmFn) return;
    confirmFn({
      title: '如何放置模型',
      message:
        '标准模型与人类模型均为 KataGo 权重文件（*.bin.gz），放置于配置 model_dir 指定目录（默认 engine/models/）。\n' +
        '· 文件名不含 "human" 的文件识别为标准模型（AI 对弈/分析必需；缺失时人机对弈与实时分析不可用，人人对弈/历史复盘照常）；\n' +
        '· 文件名含 "human" 的识别为人类模型（可选，缺失时仅禁用"人类风格/自适应难度"）。\n' +
        '放置完成后点击 [重新检测]；也可前往管理页查看模型。',
      okText: '我知道了',
      cancelText: '前往管理页',
    }).then((ok) => {
      if (!ok) nav('#/admin');
    });
  }

  async function onEnter() {
    // 进入不因模型自检受阻（BUG-090 2026/09/16 人工口径）：标准/人类模型缺失、
    // 自检失败均可进入——标准缺失仅 AI 功能降级（创建向导按引擎状态灰置人机），
    // 人人对弈与历史复盘照常；BUG-082：禁用按钮曾把移动端用户永久困在引导页。
    if (enterBusy) return;
    enterBusy = true;
    nodes.enter.disabled = true;
    nodes.enter.textContent = '检测中…';

    let plan = { resume: false, game: null };
    if (api) {
      try {
        const res = await api.get('/games/active-latest');
        plan = entryPlan(res && res.data);
      } catch (err) {
        enterBusy = false;
        nodes.enter.disabled = false;
        nodes.enter.textContent = '进入 tGo';
        toast({ code: (err && err.code) || 'NETWORK_ERROR', message: (err && err.message) || '无法连接服务器，请稍后重试', level: 'error' });
        return;
      }
    }

    let dest = 'create';
    if (plan.resume && confirmFn) {
      const resume = await confirmFn({
        title: '继续对弈？',
        message: `检测到进行中的对局（${plan.game.title}），是否恢复？`,
        okText: '恢复对局',
        cancelText: '先创建新局',
        okIcon: 'i-resume',
      });
      dest = resume ? 'resume' : 'create';
    } else if (plan.resume) {
      dest = 'resume';
    }

    if (ls && typeof ls.set === 'function') ls.set('tgo.onboarded', true);
    onComplete(dest);
  }

  // ---------- 生命周期 ----------

  function bind() {
    nodes = {
      standard: $('ob-model-standard'),
      human: $('ob-model-human'),
      note: $('ob-model-note'),
      engineTt: $('ob-engine-tt'),
      engineLine: $('ob-engine-line'),
      engineBarWrap: $('ob-engine-bar-wrap'),
      engineBar: $('ob-engine-bar'),
      engineNote: $('ob-engine-note'),
      enter: $('ob-enter'),
      help: $('ob-help'),
      recheck: $('ob-recheck'),
    };
    nodes.enter.addEventListener('click', onEnter);
    nodes.help.addEventListener('click', showModelHelp);
    nodes.recheck.addEventListener('click', runModelCheck);
    const unsub = store.subscribe((state, message) => {
      if (!message || message.type === 'engine.status' || message.type === 'system.status') {
        onEngineChange();
      }
    });
    unsubscribers.push(unsub);
    // 连接恢复（服务重启后重连成功等）：拉起未达就绪 → 允许重试一次（BUG-080）
    if (hub && typeof hub.subscribeStatus === 'function') {
      unsubscribers.push(hub.subscribeStatus((ev) => {
        if (!ev || ev.type !== 'open') return;
        if (!engineReconnectRetry({ autoStarted, everReady })) return;
        autoStarted = false;
        onEngineChange();
      }));
    }
    renderModel();
    onEngineChange();
    runModelCheck();
  }

  return {
    render() {
      rootEl.className = 'welcome-wrap';
      rootEl.innerHTML = skeletonHTML();
      bind();
    },
    destroy() {
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
      for (const off of unsubscribers.splice(0)) off();
      if (rootEl) rootEl.innerHTML = '';
    },
    get modelCheck() {
      return check;
    },
  };
}

export default createView;
