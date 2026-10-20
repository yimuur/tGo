/**
 * tGo · 管理视图（T6.10，UI_UX §5.6 / API §3.3 / API §4.4 / PROPS C14）
 *
 * 布局与文案以 WEBUI/pages/admin.html 为静态样式基线（app.css Part Ⅰ 基线类）。
 *
 * 职责：
 *   - **引擎与模型卡**：引擎状态（色块 + 文案 + INIT 调优进度）、常驻开关 +
 *     空闲超时滑杆（30 分钟步进 0.5–5h，改动即保存 config）、[启动/停止/重启]
 *     （FATAL → [手动重启]；停止/重启/模型切换＝202 异步，二次确认，结果经
 *     `/ws/admin` admin.task Toast 回执）；标准模型下拉 + 人类模型徽章 +
 *     [保存模型]（生效口径随引擎态：运行中＝安全重启 / 未运行＝下次启动生效，
 *     取值源 `engineChangeCopy`，2026/09/24 BUG-139）；
 *   - **参数卡**：引擎级（线程数，引擎**运行中**变更触发安全重启；未运行时只落
 *     配置、下次启动生效）/ 应用级（standard/deep
 *     maxVisits，内联校验 deep > standard）/ 对弈级（自适应初始水平 12 档滑杆、
 *     显示当前 AI 匹配档位（本地偏好）、最大悔棋数、默认棋盘/规则/贴目/执色），
 *     [重置] / [保存更改] → PUT /api/admin/config（仅提交脏字段，分层落地）；
 *   - **UI 设置卡**：主题色（黛蓝/朱砂）、明暗（浅/深/跟随系统）、静音开关、
 *     落子动效、装饰纹理（background.svg 页面背景）、变化图预览步数 5–15；
 *     与壳偏好同源 localStorage（T5.4），不同步服务端；
 *   - **自动同步**：引擎/模型/参数在自身动作或 `admin.task`（任意来源）/`admin.config`
 *     （后端参数/默认模型变更推送，API §4.4）回执后 REST 刷新最新数据——后端权威值
 *     直接覆盖参数表单（含他端未保存编辑）；订阅状态树（engine 切片）驱动实时更新。
 *
 * 纯函数层（deriveXxx/buildXxx）与视图（createView）同文件拆分：前者供
 * node --test 无头覆盖；视图为 `createView(rootEl, props)` 工厂，生命周期
 * render/destroy 对齐 PROPS §4。本模块顶层无 DOM 副作用。
 */

import { rankText } from '../core/fmt.js';
import { LEVEL_RANK_CODES } from '../core/game-model.js';
import { ENGINE_REASON, shortenDetail } from '../core/state.js';
import { engineStateClass } from '../core/engine-state.js';
import { ensureModalRoot } from '../core/dialog.js';
import {
  LS_KEYS,
  createLocalStore,
} from '../core/localstore.js';
import {
  getPreviewSteps,
  setPreviewSteps,
  setShowAiMatch,
  showAiMatchEnabled,
  setDecor,
  decorEnabled,
  setStoneMotion,
  stoneMotionEnabled,
} from '../core/settings.js';

/* ============================================================
 * 常量
 * ============================================================ */

/** 空闲超时滑杆量程（分钟；人工确认：30 分钟步进、最长 5 小时）。 */
export const IDLE_MIN_MIN = 30;
export const IDLE_MAX_MIN = 300;
export const IDLE_STEP_MIN = 30;

/** 202 异步任务无回执兜底（WS 中断时解除操作锁，避免永久禁用）。 */
const OP_TASK_TIMEOUT_MS = 60000;

/** 后端 ConfigUpdate 扁平键（snake_case，extra=forbid 白名单）。 */
const CFG_KEYS = Object.freeze({
  numAnalysisThreads: 'num_analysis_threads',
  numSearchThreadsPerAnalysisThread: 'num_search_threads_per_analysis_thread',
  standardMaxVisits: 'standard_max_visits',
  deepMaxVisits: 'deep_max_visits',
  maxUndo: 'max_undo',
  boardSize: 'default_board_size',
  rules: 'default_rules',
  komi: 'default_komi',
  humanColor: 'default_human_color',
  // 自适应初始水平：特殊映射（档位 → rank code）
  adaptiveLevel: 'adaptive_initial_level',
});

/** 引擎 cfg 级（变更触发安全重启）键集（对齐后端 ENGINE_RESTART_KEYS 子集）。 */
const RESTART_KEYS = new Set([
  'num_analysis_threads',
  'num_search_threads_per_analysis_thread',
]);

/** 规则集 / 棋盘 / 执色选项（显示文案，对齐 create-wizard）。 */
const RULE_OPTIONS = Object.freeze([
  { value: 'chinese', label: '中国' },
  { value: 'japanese', label: '日本' },
  { value: 'aga', label: 'AGA' },
]);
const BOARD_OPTIONS = Object.freeze([19, 13, 9]);
const COLOR_OPTIONS = Object.freeze([
  { value: 'B', label: '黑（先行）' },
  { value: 'W', label: '白' },
]);

/** 主题明暗 / 主题色档位（UI 设置卡 segctl，与壳 theme.js 同源）。 */
const THEME_MODE_OPTIONS = Object.freeze([
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]);
const ACCENT_OPTIONS = Object.freeze([
  { value: 'dai', label: '黛蓝' },
  { value: 'zhu', label: '朱砂' },
]);

/** 引擎状态 → 卡片文案/色调（对齐 engine-pill ENGINE_STATE_META 与 UI_UX §6.1）。
 *  STOPPED（未启动）＝进程未运行（从未启动/干净停止/空闲释放）；INIT＝启动/加载中。
 */
export const ENGINE_CARD_META = Object.freeze({
  STOPPED: { label: '未启动', sub: 'STOPPED · 进程未运行（可按需自动拉起）', tone: 'off' },
  INIT: { label: '启动 / 加载中', sub: 'INIT · 加载权重或自动调优', tone: 'init' },
  IDLE: { label: '已就绪', sub: 'IDLE · 空闲等待查询', tone: 'idle' },
  ANALYZING: { label: '分析中', sub: 'ANALYZING · 有进行中的查询', tone: 'busy' },
  DEAD: { label: '引擎异常', sub: 'DEAD · 自动重启中', tone: 'dead' },
  FATAL: { label: '引擎致命', sub: 'FATAL · 连续崩溃已停止，需手动重启', tone: 'fatal' },
});

/** admin.task 类型 → 动作名（Toast 文案用）。 */
export const ADMIN_TASK_LABEL = Object.freeze({
  start: '引擎启动',
  stop: '引擎停止',
  restart: '引擎重启',
  set_model: '模型切换',
  app_update: '应用更新',
  engine_download: 'KataGo 下载',
  model_download: '模型下载',
});

/** 更新/下载类后台任务（进度经 admin.task status=running 推送）。 */
export const UPDATE_TASKS = Object.freeze(['app_update', 'engine_download', 'model_download']);

/** 部署形态 → 文案。 */
export const DEPLOYMENT_MODE_LABEL = Object.freeze({
  docker: 'Docker 容器',
  systemd: 'systemd 服务',
  source: '源码 / 启动脚本',
});

/** KataGo 官方资产后端 → 中文标签。 */
export const KATA_BACKEND_LABEL = Object.freeze({
  opencl: 'OpenCL（通用 GPU）',
  cuda: 'CUDA',
  tensorrt: 'TensorRT',
  rocm: 'ROCm',
  eigen: 'Eigen（CPU）',
  'eigen-avx2': 'Eigen AVX2（CPU）',
  onnx: 'ONNX',
  'onnx-openvino': 'ONNX · OpenVINO',
  'onnx-directml': 'ONNX · DirectML',
});

/* ============================================================
 * 纯函数层（无头可测，FE-ADM-*）
 * ============================================================ */

/** 0..100 钳制取整。 */
export function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 引擎状态 + progress + reason + detail → 卡片元数据（label/sub/tone）。 */
export function engineCardMeta(state, progress = null, reason = null, detail = null) {
  if (!state) return { label: '连接中', sub: '等待引擎状态…', tone: 'init' };
  const meta = ENGINE_CARD_META[state] || { label: String(state), sub: '', tone: 'init' };
  // 引擎不可用归因（BUG-097）：文案指向真实缺失项/失败原因，不得呈现为「连续崩溃」
  if (state === 'FATAL' && reason === ENGINE_REASON.standardModelMissing) {
    return { label: '引擎不可用', sub: '标准模型缺失 · 放入模型后点击 [手动重启]', tone: 'fatal' };
  }
  if (state === 'FATAL' && reason === ENGINE_REASON.engineExecutableMissing) {
    return { label: '引擎不可用', sub: 'katago 可执行文件缺失 · 就位后点击 [手动重启]', tone: 'fatal' };
  }
  if (state === 'FATAL' && reason === ENGINE_REASON.startupFailed) {
    return {
      label: '引擎启动失败',
      sub: shortenDetail(detail) || '查看引擎日志后手动重启',
      tone: 'fatal',
    };
  }
  if (state === 'DEAD' && reason === ENGINE_REASON.startupFailed) {
    const suffix = detail ? `（${shortenDetail(detail)}）` : '';
    return { ...meta, sub: `DEAD · 自动重启中${suffix}` };
  }
  if (state === 'INIT' && progress !== undefined && progress !== null) {
    return { ...meta, sub: `INIT · GPU 调优 ${clampPct(progress)}%` };
  }
  return meta;
}

/**
 * FATAL 手动重启确认文案（按归因派生；BUG-097：文件缺失→「重新检测并启动」，
 * 启动失败/连续崩溃→「手动重启」；纯函数供无头测试）。
 * @param {string|null} [reason] API §3.3 `reason`
 * @param {string|null} [detail] 原因说明（stderr 摘要）
 * @returns {{title:string, message:string, okText:string, okIcon:string}}
 */
export function manualRestartCopy(reason = null, detail = null) {
  if (reason === ENGINE_REASON.standardModelMissing) {
    return {
      title: '重新检测并启动引擎？',
      message: '引擎不可用（标准模型缺失）。若已放入模型文件，将重建引擎并启动；仍缺失时将如实提示。',
      okText: '重新检测并启动',
      okIcon: 'i-restart',
    };
  }
  if (reason === ENGINE_REASON.engineExecutableMissing) {
    return {
      title: '重新检测并启动引擎？',
      message: '引擎不可用（katago 可执行文件缺失）。若已放入可执行文件，将重建引擎并启动；仍缺失时将如实提示。',
      okText: '重新检测并启动',
      okIcon: 'i-restart',
    };
  }
  if (reason === ENGINE_REASON.startupFailed) {
    const suffix = detail ? `（${shortenDetail(detail)}）` : '';
    return {
      title: '手动重启引擎？',
      message: `引擎启动失败${suffix}。手动重启将重新检测并拉起引擎进程，是否继续？`,
      okText: '手动重启',
      okIcon: 'i-restart',
    };
  }
  return {
    title: '手动重启引擎？',
    message: '引擎连续崩溃已停止（FATAL）。手动重启将重新拉起引擎进程，是否继续？',
    okText: '手动重启',
    okIcon: 'i-restart',
  };
}

/**
 * 引擎操作可用性（UI_UX §5.6；FSM 语义防非法指令）——**分类统一取 `engineStateClass`**
 * （ISSUE-069：后端 `app/core/fsm.py` 为权威定义，`FE-CTR-34` 契约测试锁定镜像）：
 *   - `stopped`（STOPPED 未启动）/`unknown`（状态未达）→ [启动]（ensure_ready 幂等）；
 *   - `starting`（INIT 拉起/加载/调优中）→ [启动]（幂等空操作，回执「启动中」）；
 *   - `ready`（IDLE/ANALYZING）→ [停止][重启]（202，忙时入队）；**非常驻（resident=false）
 *     时 [停止] 恒禁用**——非常驻引擎由系统按需自动拉起/释放，手动停止会被自动拉起
 *     相互抵消（2026/09/13 人工决策，ISSUE-055 关闭口径）；
 *   - `recovering`（DEAD 自动重启中）/`fatal`（FATAL 终态）→ **本页不提供启动/重启入口**
 *     （2026/09/20 人工决策）：DEAD 由退避链自愈、FATAL 由「[手动重启]（POST start
 *     reset_fatal）恢复——两态的重新拉起属**恢复所有者独占**（ISSUE-069）。
 */
export function engineOps(state, { resident = true } = {}) {
  const cls = engineStateClass(state);
  if (cls === 'ready') {
    return { start: false, stop: resident, restart: true, manualRestart: false };
  }
  if (cls === 'fatal') return { start: false, stop: false, restart: false, manualRestart: true };
  if (cls === 'recovering') {
    return { start: false, stop: false, restart: false, manualRestart: false };
  }
  // unknown / stopped / starting → 允许启动（ensure_ready 幂等返回）
  return { start: true, stop: false, restart: false, manualRestart: false };
}

/** 禁用操作的原因文案（按钮 Tooltip；null=可用）。 */
export function engineOpReason(state, op, { resident = true } = {}) {
  const cls = engineStateClass(state);
  if (op === 'start') {
    if (cls === 'ready') return '引擎已运行';
    if (cls === 'recovering') return '引擎崩溃自动重启中';
    return null;
  }
  if (op === 'stop') {
    // 非常驻时优先给出策略原因（与引擎当前态无关：该模式下按钮恒禁用）
    if (!resident) return '非常驻模式：引擎由系统按需自动拉起/释放';
    if (cls === 'stopped') return '引擎未启动';
    if (cls !== 'ready') return '引擎未就绪';
    return null;
  }
  if (op === 'restart') {
    if (cls !== 'ready') return '引擎未运行';
    return null;
  }
  if (op === 'manualRestart') {
    return cls === 'fatal' ? null : '仅引擎致命（FATAL）时需要手动重启';
  }
  return null;
}

/**
 * 引擎级变更（模型 / `numAnalysisThreads` 等）的「生效口径」文案——**单一事实源**
 * （2026/09/24 BUG-139）：
 *   - 引擎在运行（`ready`＝IDLE/ANALYZING / `starting`＝INIT 拉起中）→ 保存后**安全重启**；
 *   - 其余（未启动 / 崩溃自愈中 / 致命）→ 只落配置，**下次启动生效**（不重启、无 `admin.task` 回执）；
 *   - 状态未达（`unknown`）→ 中性表述（两种情形都成立），不猜。
 * 生效口径仅由 3 处承载：`modelSaveHint` / `dirtyNote` / `warnTag`；`engineKeyScope` 改为
 * 「引擎级」**分组说明**（两个参数各自的含义，2026/10/10 人工口径）——与引擎态无关，不承载口径。
 *
 * 动机：这些文案原先写死在骨架里（按钮标签带「重启引擎生效」后缀、参数卡三处提示均写「安全
 * 重启」），引擎未运行/致命时与事实相左（用户反馈「按钮文案与事实不符」）。
 * @param {string|null|undefined} engineState 引擎 FSM 状态
 * @returns {{restarts:boolean, modelSaveHint:string, engineKeyScope:string, dirtyNote:string, warnTag:string}}
 */
export function engineChangeCopy(engineState) {
  const cls = engineStateClass(engineState);
  if (cls === 'unknown') {
    return {
      restarts: false,
      modelSaveHint: '切换默认模型：引擎运行中时安全重启，未运行时于下次启动生效',
      engineKeyScope: '（并行分析的局面数 / 每局面分析使用的线程数）',
      dirtyNote: '和当前 .yaml 不一致（未保存 · 保存后生效）',
      warnTag: '引擎级变更保存后：引擎运行中＝安全重启（空闲时执行）/ 未运行＝下次启动时生效',
    };
  }
  if (cls === 'ready' || cls === 'starting') {
    return {
      restarts: true,
      modelSaveHint: '切换将安全重启引擎，进行中对局与分析数据不受影响',
      engineKeyScope: '（并行分析的局面数 / 每局面分析使用的线程数）',
      dirtyNote: '和当前 .yaml 不一致（未保存 · 保存后引擎将安全重启）',
      warnTag: '引擎级变更保存后将触发引擎安全重启（引擎空闲时执行）',
    };
  }
  return {
    restarts: false,
    modelSaveHint: '引擎当前未运行，新模型将在引擎下次启动时生效',
    engineKeyScope: '（并行分析的局面数 / 每局面分析使用的线程数）',
    dirtyNote: '和当前 .yaml 不一致（未保存 · 保存后引擎下次启动生效）',
    warnTag: '引擎未运行：引擎级变更保存后将在引擎下次启动时生效',
  };
}

/**
 * [保存模型] 确认弹窗文案（随引擎态分叉；2026/09/24 人工反馈 BUG-138）：
 *   - 引擎在运行（`ready`＝IDLE/ANALYZING / `starting`＝INIT 拉起中）→ 切换将**安全重启**
 *     引擎（排队执行，`admin.task` 回执）；
 *   - 其余（未启动 / 崩溃恢复中 / 致命 / 状态未知）→ 引擎当前未运行，新模型**下次启动
 *     生效**——后端此时只落配置、不排队也无回执，文案不得谎称「保存并重启」。
 * @param {string|null} engineState 引擎 FSM 状态（可为 null＝尚未拉取）
 * @returns {{title:string, message:string, okText:string}}
 */
export function modelSaveCopy(engineState) {
  if (engineChangeCopy(engineState).restarts) {
    return {
      title: '保存默认模型？',
      message: '切换默认模型将安全重启引擎，进行中的对局与分析任务不受影响。是否继续？',
      okText: '保存并重启',
    };
  }
  return {
    title: '保存默认模型？',
    message: '引擎当前未运行，新模型将在引擎下次启动时生效。是否继续？',
    okText: '保存',
  };
}

/**
 * 「常驻」开关旁的说明文案（2026/09/21 人工口径；关态 2026/10/10 追补「自动」）：
 * 开＝引擎保持常驻运行；关＝引擎按需自动拉起，空闲超时自动释放
 *（与 [停止] 恒禁用同源语义，ISSUE-055 关闭口径）。
 * @param {boolean} resident
 * @returns {string}
 */
export function residentNoteText(resident) {
  return resident ? '引擎保持常驻运行' : '引擎按需自动拉起，空闲超时自动释放';
}

/**
 * 空闲超时滑杆禁用派生（2026/09/18 人工反馈）：**常驻＝常驻语义**（引擎不因空闲超时
 * 释放，滑杆无实际作用）→ 联动灰置禁用；保存/引擎操作在途同样禁用；关闭常驻恢复可用。
 * @param {{saving?:boolean, busy?:boolean, resident?:boolean}} opts
 * @returns {boolean}
 */
export function idleSliderDisabled({ saving = false, busy = false, resident = false } = {}) {
  return Boolean(saving || busy || resident);
}

/** 模型载荷 → 标准模型下拉数据（GET /admin/models 白名单）。 */
export function standardModels(payload) {
  if (!payload || !Array.isArray(payload.models)) return [];
  return payload.models.filter((m) => !m.human);
}

/** 模型载荷 → 人类模型徽章信息。 */
export function humanModelInfo(payload) {
  const list = payload && Array.isArray(payload.models) ? payload.models : [];
  const human = list.filter((m) => m.human);
  const ok = Boolean(payload && payload.humanModelAvailable) || human.length > 0;
  return { ok, name: human.length ? human[0].name : null };
}

/** 模型载荷 → 当前默认标准模型名。 */
export function currentModel(payload) {
  return (payload && payload.default) || null;
}

/**
 * 「保存模型」按钮可用性（BUG-120）：选中项是**有效且不同于当前默认**的标准模型、
 * 且无保存/引擎任务在途时才可用。
 *
 * 缺陷现场：模型目录下放多个模型时切换标准模型，按钮恒为灰置——`onRootChange` 缺少
 * `modelSelect` 分支，选中项变化从不触发 `renderModel()` 重算（按钮态判据本身是对的）。
 * @param {{models?: object, selected?: string, saving?: boolean, busy?: boolean}} opts
 * @returns {boolean}
 */
export function modelSaveEnabled({
  models = null,
  selected = '',
  saving = false,
  busy = false,
} = {}) {
  if (saving || busy) return false;
  if (!models || !selected) return false;
  if (!standardModels(models).some((m) => m.name === selected)) return false;
  return selected !== currentModel(models);
}

/** 档位 1..12 → rank code（LEVEL.md 12 档顺序 = game-model LEVEL_RANK_CODES）。 */
export function rankCodeOfLevel(level) {
  const n = Number(level);
  const idx = Math.max(1, Math.min(12, Number.isFinite(n) ? Math.round(n) : 4)) - 1;
  return LEVEL_RANK_CODES[idx];
}

/** rank code（'rank_5k'）→ 档位 1..12；未知 → null。 */
export function levelOfRank(rank) {
  if (!rank) return null;
  const idx = LEVEL_RANK_CODES.indexOf(rank);
  return idx === -1 ? null : idx + 1;
}

/** 档位 1..12 → 短标（'5K'/'1D'）；越界 → '—'。 */
export function rankShort(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n < 1 || n > 12) return '—';
  return rankText(LEVEL_RANK_CODES[Math.round(n) - 1]);
}

/** 空闲超时秒 → 滑杆档（30 分钟步进量程内就近吸附）。 */
export function snapIdleMin(seconds) {
  const min = (Number(seconds) || 0) / 60;
  if (!(min > 0)) return IDLE_MIN_MIN; // 0/负值（不自动释放）不在滑杆量程，取量程下限
  const snapped = Math.round(min / IDLE_STEP_MIN) * IDLE_STEP_MIN;
  return Math.max(IDLE_MIN_MIN, Math.min(IDLE_MAX_MIN, snapped));
}

/** 当前秒值是否落在滑杆 30 分钟网格上（否则显示提示、不擅自改写）。 */
export function idleOnGrid(seconds) {
  const min = (Number(seconds) || 0) / 60;
  return min >= IDLE_MIN_MIN && min <= IDLE_MAX_MIN && min % IDLE_STEP_MIN === 0;
}

/** 分钟 → 秒。 */
export function idleSecondsOfMin(min) {
  return Math.round(Number(min) || 0) * 60;
}

/**
 * 空闲超时文案（分钟 → `X.Y 小时`，数字与「小时」间保留一个空格；2026/09/13 改为
 * 「`1.5 小时`/`2.0 小时`」不再带分钟，2026/09/15 人工确认**带空格为准**）。
 * 量程 30–300 分钟 ⇒ `0.5 小时`…`5.0 小时`，一位小数定长——
 * 滑杆旁标签宽度恒定（`app.css` 里已按最坏情况固定 52px），滑杆不再抖动。
 */
export function fmtIdleLabel(minutes) {
  const m = Math.max(0, Number(minutes) || 0);
  return `${(m / 60).toFixed(1)} 小时`;
}

/** 嵌套 config（GET /admin/config model_dump）→ 参数卡扁平表单（含默认值兜底）。 */
export function configToForm(cfg) {
  const e = (cfg && cfg.engine) || {};
  const p = (cfg && cfg.play) || {};
  const board = Number(p.default_board_size);
  return {
    numAnalysisThreads: Number.isFinite(Number(e.num_analysis_threads)) ? Number(e.num_analysis_threads) : 2,
    numSearchThreadsPerAnalysisThread: Number.isFinite(Number(e.num_search_threads_per_analysis_thread))
      ? Number(e.num_search_threads_per_analysis_thread)
      : 16,
    standardMaxVisits: Number.isFinite(Number(e.standard_max_visits)) ? Number(e.standard_max_visits) : 100,
    deepMaxVisits: Number.isFinite(Number(e.deep_max_visits)) ? Number(e.deep_max_visits) : 800,
    adaptiveLevel: levelOfRank(p.adaptive_initial_level) || 5,
    maxUndo: Number.isFinite(Number(p.max_undo)) ? Number(p.max_undo) : 10,
    boardSize: BOARD_OPTIONS.includes(board) ? board : 19,
    rules: ['chinese', 'japanese', 'aga'].includes(p.default_rules) ? p.default_rules : 'chinese',
    komi: Number.isFinite(Number(p.default_komi)) ? Number(p.default_komi) : 7.5,
    humanColor: p.default_human_color === 'W' ? 'W' : 'B',
  };
}

/** 参数卡表单内联校验 → {ok, errs}（UI_UX §5.6：deep > standard 等）。 */
export function validateConfigForm(form) {
  const errs = {};
  if (!Number.isFinite(form.numAnalysisThreads) || form.numAnalysisThreads < 1) {
    errs.numAnalysisThreads = '需为 ≥ 1 的整数';
  }
  if (!Number.isFinite(form.numSearchThreadsPerAnalysisThread) || form.numSearchThreadsPerAnalysisThread < 1) {
    errs.numSearchThreadsPerAnalysisThread = '需为 ≥ 1 的整数';
  }
  if (!Number.isFinite(form.standardMaxVisits) || form.standardMaxVisits < 1) {
    errs.standardMaxVisits = '需为 ≥ 1 的整数';
  }
  if (!Number.isFinite(form.deepMaxVisits) || form.deepMaxVisits < 1) {
    errs.deepMaxVisits = '需为 ≥ 1 的整数';
  } else if (form.deepMaxVisits <= form.standardMaxVisits) {
    errs.deepMaxVisits = 'deep 必须大于 standard';
  }
  if (!Number.isFinite(form.maxUndo) || form.maxUndo < 0) {
    errs.maxUndo = '需为 ≥ 0 的整数';
  }
  if (!Number.isFinite(form.komi) || form.komi < 0) {
    errs.komi = '需为 ≥ 0 的数';
  }
  return { ok: Object.keys(errs).length === 0, errs };
}

/**
 * 表单脏字段 → PUT /api/admin/config 载荷（snake_case 扁平键）。
 * 仅提交与基线不同的字段（引擎级键未变更则不触发重启）。
 * @returns {{payload: object, changed: string[], restart: boolean}}
 */
export function buildConfigPayload(form, baseCfg) {
  const base = configToForm(baseCfg);
  const payload = {};
  const changed = [];
  const pairs = [
    ['numAnalysisThreads', form.numAnalysisThreads, base.numAnalysisThreads],
    ['numSearchThreadsPerAnalysisThread', form.numSearchThreadsPerAnalysisThread, base.numSearchThreadsPerAnalysisThread],
    ['standardMaxVisits', form.standardMaxVisits, base.standardMaxVisits],
    ['deepMaxVisits', form.deepMaxVisits, base.deepMaxVisits],
    ['maxUndo', form.maxUndo, base.maxUndo],
    ['boardSize', form.boardSize, base.boardSize],
    ['rules', form.rules, base.rules],
    ['komi', form.komi, base.komi],
    ['humanColor', form.humanColor, base.humanColor],
  ];
  for (const [key, next, prev] of pairs) {
    if (next !== prev) {
      payload[CFG_KEYS[key]] = next;
      changed.push(CFG_KEYS[key]);
    }
  }
  if (form.adaptiveLevel !== base.adaptiveLevel) {
    payload.adaptive_initial_level = rankCodeOfLevel(form.adaptiveLevel);
    changed.push('adaptive_initial_level');
  }
  const restart = changed.some((k) => RESTART_KEYS.has(k));
  return { payload, changed, restart };
}

/** 表单是否有脏字段（相对基线）。 */
export function configDirty(form, baseCfg) {
  return buildConfigPayload(form, baseCfg).changed.length > 0;
}

/** admin.task 回执 → Toast 载荷（UI_UX §6.4：成功/失败 + 错误码文案）。 */
export function taskResultToast(data) {
  if (!data) return null;
  const label = ADMIN_TASK_LABEL[data.task] || data.task || '任务';
  if (data.status === 'done') {
    return { level: 'success', text: data.message || `${label}完成`, key: `adm-task-${data.task}` };
  }
  if (data.status === 'failed') {
    const code = data.code || 'INTERNAL_ERROR';
    return {
      level: 'error',
      code,
      text: data.message || `${label}失败（${code}）`,
      key: `adm-task-${data.task}`,
    };
  }
  return null;
}

/** 版本号展示（``1.2.3`` → ``v1.2.3``；缺失 → ``—``）。 */
export function versionLabel(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '—';
  return text.startsWith('v') || text.startsWith('V') ? `v${text.slice(1)}` : `v${text}`;
}

/** 版本字符串 → 数字元组（忽略 v 前缀/预发布后缀；无法识别 → []）。 */
export function versionTuple(value) {
  const text = String(value == null ? '' : value).trim().replace(/^[vV]/, '');
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return [];
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

/** 服务器版本是否高于本地版本（任一无法解析时不提示）。 */
export function isNewerVersion(latest, current) {
  const newest = versionTuple(latest);
  const local = versionTuple(current);
  if (!newest.length || !local.length) return false;
  for (let i = 0; i < Math.max(newest.length, local.length); i += 1) {
    const a = newest[i] || 0;
    const b = local[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** 字节 → KB/MB/GB（一位小数）。 */
export function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** 更新/下载任务 → 进度条视图模型。 */
export function taskProgressVM(task) {
  if (!task || !task.task || task.status === 'idle') {
    return { active: false, failed: false, percent: null, text: '' };
  }
  const label = ADMIN_TASK_LABEL[task.task] || task.task;
  const percent = Number.isFinite(Number(task.progress)) ? clampPct(task.progress) : null;
  const statusText =
    task.status === 'running'
      ? `${label}执行中…`
      : task.status === 'failed'
        ? `${label}失败`
        : `${label}完成`;
  return {
    active: task.status === 'running',
    failed: task.status === 'failed',
    percent,
    text: task.message ? `${statusText} · ${task.message}` : statusText,
  };
}

/** 检查更新结果 → 卡片文案/动作可用性。 */
export function updateCheckVM(check) {
  if (!check) {
    return { tone: 'info', text: '尚未检查更新', canUpdate: false, releaseUrl: null, version: null };
  }
  if (!check.supported) {
    return {
      tone: 'warn',
      text: check.message || '当前部署方式不支持自动更新',
      canUpdate: false,
      releaseUrl: check.latest && check.latest.htmlUrl,
      version: null,
    };
  }
  if (check.updateAvailable) {
    const version = check.latest ? check.latest.version : null;
    return {
      tone: 'ok',
      text: check.message || `发现新版本 ${versionLabel(version)}`,
      canUpdate: Boolean(check.latest && check.latest.asset),
      releaseUrl: check.latest ? check.latest.htmlUrl : null,
      version,
    };
  }
  return {
    tone: 'info',
    text: check.message || '当前已是最新版本',
    canUpdate: false,
    releaseUrl: check.latest ? check.latest.htmlUrl : null,
    version: null,
  };
}

/**
 * 应用 Release 说明 → 页内 HTML（不跳转仓库）。
 *
 * GitHub Release body 为 Markdown：先整体 HTML 转义，再仅还原标题/列表/粗体/行内代码
 * 这类无风险标记；外链语法（`[文本](url)`）降级为纯文本，避免页内出现跳转入口。
 */
export function releaseNotesHtml(notes) {
  const text = String(notes == null ? '' : notes)
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => {
      const escaped = String(line)
        .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(escaped);
      if (heading) return `<strong>${heading[1]}</strong>`;
      if (/^\s{0,3}[-*+]\s+/.test(escaped)) {
        return `<span class="upd-notes-li">${escaped.replace(/^(\s{0,3})[-*+]\s+/, '$1• ')}</span>`;
      }
      return escaped;
    })
    .join('\n');
}

/** KataGo Releases → 下拉选项（tag + 发布名）。 */
export function kataReleaseOptions(releases) {
  return (releases || []).map((release) => ({
    value: release.tag,
    label: `${release.tag}${release.name ? ` · ${release.name}` : ''}`,
  }));
}

/** KataGo 资产 → 可区分文案（后端 + 构建变体 + 体积）。 */
export function kataAssetLabel(asset) {
  if (!asset) return '';
  const backend = KATA_BACKEND_LABEL[asset.backend] || asset.backend || '构建';
  const variant = String(asset.name || '')
    .replace(/^katago-[^-]+-/, '')
    .replace(/-(windows|linux)-x64\.zip$/i, '')
    .replace(/\+bs50$/i, '')
    .replace(/\.zip$/i, '');
  const suffix = variant && variant !== asset.backend ? ` · ${variant}` : '';
  return `${backend}${suffix} · ${fmtBytes(asset.size)}`;
}

/** 选择指定 Release 的资产选项（后端已按当前平台过滤）。 */
export function kataAssetOptions(releases, tag) {
  const release = (releases || []).find((item) => item.tag === tag);
  return ((release && release.assets) || []).map((asset) => ({
    value: asset.name,
    label: kataAssetLabel(asset),
    backend: asset.backend,
    size: asset.size,
  }));
}

/** 选定 Release 下的默认资产（保留用户选择 → OpenCL → 第一项）。 */
export function pickKataAsset(releases, tag, preferred = null) {
  const release = (releases || []).find((item) => item.tag === tag);
  const assets = (release && release.assets) || [];
  if (preferred && assets.some((asset) => asset.name === preferred)) {
    return preferred;
  }
  const opencl = assets.find((asset) => asset.backend === 'opencl');
  return opencl ? opencl.name : assets.length ? assets[0].name : '';
}

/** 官方模型项 → 下拉文案（Elo / 最新 / 最强 / 兼容性）。
 *  Elo 前置：原生 select 会裁剪长文案，放末尾不可见。 */
export function modelOptionLabel(model) {
  if (!model) return '';
  const tags = [];
  if (model.latest) tags.push('最新');
  if (model.strongest) tags.push('最强');
  if (model.compatible === false) tags.push('需更新引擎');
  const elo = Number(model.elo);
  const hasElo =
    model.elo !== null && model.elo !== undefined && model.elo !== '' && Number.isFinite(elo);
  const prefix = hasElo ? `Elo ${Math.round(elo)} · ` : '';
  const suffix = tags.length ? `（${tags.join(' · ')}）` : '';
  return `${prefix}${model.name}${suffix}`;
}

/* ============================================================
 * 视图（createView；DOM 仅限此处）
 * ============================================================ */

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function icn(name, size) {
  return `<svg class="icon" aria-hidden="true"${size ? ` style="width:${size}px;height:${size}px"` : ''}><use href="#${name}"></use></svg>`;
}

/* ============================================================
 * 幂等 DOM 写入助手（2026/10/10 人工反馈「保存后卡片会闪烁一下」）
 * ============================================================
 * 管理页每次数据到达都要整体重渲染（saveConfigPatch / renderDynamic / WS 推送…）。
 * 若不加比对地写 textContent/innerHTML/disabled，就会产生**与事实无关的 DOM 变更** →
 * 触发重排+重绘；`.card` 是毛玻璃卡（backdrop-filter），重绘与「保存中控件整卡灰置→
 * 恢复」叠加起来，用户看到的就是「卡片闪烁一下」。以下写入前一律比对现值，值未变
 * 则零 DOM 写入（回填 value 亦然：无差别回填会在输入过程中扰动光标/选区）。
 */

/** 文本写入（值相同则跳过）。 */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** 受控 HTML 写入（签名相同则跳过；签名挂在元素自身上，不外泄）。
 * @returns {boolean} 是否实际写入（供「仅在变化时重扫 tooltip」等下游使用）
 */
function setHTML(el, html) {
  if (!el || el.__tgoHtml === html) return false;
  el.__tgoHtml = html;
  el.innerHTML = html;
  return true;
}

/** input/select 值回填（值相同则跳过）。 */
function setValue(el, value) {
  if (el && el.value !== value) el.value = value;
}

/**
 * `<select>` 选项集重建（签名相同则跳过）。
 * 管理页的重建守卫（BUG-120：重建会丢失用户未保存的选择）就落在这里，统一入口
 * 以免出现「无签名守卫的裸 innerHTML 写入」——那类写入每次数据到达都会重建下拉，
 * 既吞选择又触发重绘（保存后卡片闪烁同源，2026/10/10）。
 * @returns {boolean} 是否实际重建
 */
function setOptions(sel, html, signature) {
  if (!sel || sel.dataset.sig === signature) return false;
  sel.innerHTML = html;
  sel.dataset.sig = signature;
  return true;
}

/** disabled 同步（状态相同则跳过——无差别写 disabled 同样会重绘）。 */
function setDisabled(el, disabled) {
  if (el && el.disabled !== disabled) el.disabled = disabled;
}

/** hidden 同步。 */
function setHidden(el, hidden) {
  if (el && el.hidden !== hidden) el.hidden = hidden;
}

/** 样式属性同步（如内存条宽度）。 */
function setStyleProp(el, prop, value) {
  if (el && el.style[prop] !== value) el.style[prop] = value;
}

/** class 开关（force 语义，与现值一致时不触碰 classList）。 */
function setClassOn(el, on) {
  if (el && el.classList.contains('on') !== on) el.classList.toggle('on', on);
}

/** aria-checked 同步。 */
function setAriaChecked(el, on) {
  const next = String(on);
  if (el && el.getAttribute('aria-checked') !== next) el.setAttribute('aria-checked', next);
}

export function createView(rootEl, props) {
  const store = props.store;
  const api = props.api;
  const ls = props.ls || createLocalStore();
  const toast = props.toast || (() => {});
  const confirmDialog = props.confirm || (() => Promise.resolve(false));
  const theme = props.theme || null;
  const settings = props.settings || null;
  const refreshChrome = props.refreshChrome || null;

  /** 运行时数据（引擎/模型/参数；UI 设置仅 localStorage 不同步）。 */
  const self = {
    engine: { state: null, progress: null, reason: null, detail: null },
    models: null,
    cfg: null,
    form: null,
    opTask: null,
    //: 本次受理是否**已确认**排入异步任务（后端 `task_queued`）——只有 true 才可展示
    //: 「已排队，将在引擎空闲时执行」（BUG-138：未运行/无需重启时后端不排队、无回执）
    opQueued: false,
    opTimer: null,
    saving: false,
    unsubs: [],
    timers: [],
    destroyed: false,
    fetchToken: 0,
    updates: {
      info: null,
      check: null,
      //: 最近一次更新检查的网络/远端错误（不影响 info 中的本地版本展示）
      checkError: null,
      releases: null,
      models: null,
      loading: false,
      checking: false,
      pendingCheck: false,
      kataTag: null,
      kataAsset: null,
      stdModel: '',
      task: null,
    },
  };

  /* ---------------- 数据动作 ---------------- */

  function toastError(err, fallback) {
    const code = (err && err.code) || 'INTERNAL_ERROR';
    const message = (err && err.message) || fallback;
    toast({ code, message, level: 'error' });
  }

  /** 并行刷新引擎/模型/参数（自动同步，去重在途并发）。 */
  function refreshAll() {
    const token = ++self.fetchToken;
    const run = async () => {
      if (token !== self.fetchToken) return;
      const reqs = [];
      if (!api) return;
      reqs.push(api.get('/admin/config').then((r) => ({ ok: true, value: r })).catch((e) => ({ ok: false, error: e })));
      reqs.push(api.get('/admin/models').then((r) => ({ ok: true, value: r })).catch((e) => ({ ok: false, error: e })));
      reqs.push(api.get('/admin/engines').then((r) => ({ ok: true, value: r })).catch((e) => ({ ok: false, error: e })));
      const results = await Promise.all(reqs);
      if (token !== self.fetchToken || self.destroyed) return;
      const cfg = results[0].ok ? results[0].value.data : null;
      const models = results[1].ok ? results[1].value.data : null;
      const eng = results[2].ok ? results[2].value.data : null;
      if (cfg) applyConfig(cfg);
      if (models) applyModels(models);
      if (eng) {
        setEngineState(eng.state || null, eng.progress === undefined ? null : eng.progress);
        if (typeof eng.humanModelAvailable === 'boolean') self.engine.humanModelAvailable = eng.humanModelAvailable;
        // 不可用归因（BUG-097）：REST 快照恒携带 reason/detail（显式 null 清旧值）
        setEngineReason(eng.reason, eng.detail);
      }
      renderDynamic();
    };
    run();
  }

  function applyConfig(cfg) {
    self.cfg = cfg;
    self.form = configToForm(cfg);
  }

  function applyModels(payload) {
    self.models = payload;
  }

  function setEngineState(state, progress) {
    self.engine.state = state || null;
    self.engine.progress = progress === undefined || progress === null ? null : progress;
  }

  /** 不可用归因（BUG-097）：reason/detail 显式 null 清旧值，缺省保留既有值（增量化）。 */
  function setEngineReason(reason, detail) {
    if (reason !== undefined) self.engine.reason = reason === null ? null : String(reason);
    if (detail !== undefined) self.engine.detail = detail === null ? null : String(detail);
  }

  /* ---------------- 引擎/模型操作（202 异步） ---------------- */

  async function engineTask(act, { confirmText = null, path, method = 'post', body } = {}) {
    if (self.opTask || self.saving || !api) return;
    if (confirmText) {
      const ok = await confirmDialog(confirmText);
      if (!ok) return;
    }
    self.opTask = act;
    self.opQueued = false; // 回执前不得谎报「已排队」（见 engineQueueHTML）
    renderOpsBusy();
    clearOpTimer();
    self.opTimer = setTimeout(() => {
      self.opTimer = null;
      if (self.destroyed) return;
      self.opTask = null;
      self.opQueued = false;
      renderOpsBusy();
      toast({
        level: 'info',
        text: `${ADMIN_TASK_LABEL[act] || act}已受理；连接恢复后将收到执行结果`,
        key: 'adm-op-timeout',
      });
    }, OP_TASK_TIMEOUT_MS);
    self.timers.push(self.opTimer);

    try {
      const res = await api[method](path, body);
      const data = res && res.data;
      const msg = (data && data.message) || `${ADMIN_TASK_LABEL[act] || act}已受理`;
      toast({ level: 'info', text: msg, key: '202' });
      // 后端如实告知是否已排入异步任务（BUG-138）：`task_queued === false`＝本次仅落配置/
      // 无动作（引擎未运行、无需重启或停止）——**不会再有 admin.task 回执**，故立即解除
      // 受理态：否则 [启动] 等按钮被假受理态连带禁用 60s，再弹「连接恢复后将收到执行结果」。
      if (data && data.task_queued === false) {
        self.opTask = null;
        self.opQueued = false;
        clearOpTimer();
        renderOpsBusy();
      } else {
        self.opQueued = true;
        renderOpsBusy();
      }
      if (act === 'set_model' && self.models && self._modelNext) {
        self.models = { ...self.models, default: self._modelNext };
        self._modelNext = null;
        renderModel();
      }
    } catch (err) {
      self.opTask = null;
      self.opQueued = false;
      clearOpTimer();
      renderOpsBusy();
      toastError(err, `${ADMIN_TASK_LABEL[act] || act}请求失败`);
    }
  }

  function clearOpTimer() {
    if (self.opTimer) {
      clearTimeout(self.opTimer);
      self.opTimer = null;
    }
  }

  /** admin.task 回执（订阅状态树）。任意来源回执（含他端发起）都 REST 刷新，保持多管理端同步。 */
  function onAdminTask(data) {
    const t = taskResultToast(data);
    if (t) toast(t);
    if (data && self.opTask === data.task) {
      self.opTask = null;
      self.opQueued = false;
      clearOpTimer();
      renderOpsBusy();
    }
    if (data && UPDATE_TASKS.includes(data.task)) {
      self.updates.task = { ...data };
      renderUpdates();
      if (data.status === 'done' || data.status === 'failed') {
        const timer = setTimeout(() => loadUpdates({ check: false }), 400);
        self.timers.push(timer);
      }
    }
    if (data && (data.status === 'done' || data.status === 'failed')) {
      refreshAll();
    }
  }

  /* ---------------- 引擎常驻 / 空闲超时（config 即时保存） ---------------- */

  async function saveConfigPatch(patch, { successText = null } = {}) {
    if (!api || self.saving || self.opTask) return;
    // 即时保存（常驻开关 / 空闲超时滑杆）**不做任何忙碌态渲染**：这两个控件位于引擎卡，
    // 而首次渲染只发生在响应到达后（applyConfig → renderDynamic）——期间不碰 DOM，
    // 卡片零变化（旧实现会令整卡控件灰置一瞬＝闪烁）。重入由 self.saving 守门（见上）。
    self.saving = true;
    try {
      const res = await api.put('/admin/config', patch);
      const data = res && res.data;
      if (data) applyConfig(data);
      const warn = data && data.restart_warning;
      toast({
        level: 'info',
        text: successText || (warn ? warn : '配置已保存（应用级热更新即时生效）'),
        key: 'adm-cfg-saved',
      });
      renderDynamic();
    } catch (err) {
      toastError(err, '配置保存失败');
    } finally {
      self.saving = false;
    }
  }

  async function toggleResident(next) {
    const cur = Boolean(self.cfg && self.cfg.engine && self.cfg.engine.resident);
    if (self.opTask || cur === next || !api) return;
    const label = next ? '启用常驻' : '关闭常驻';
    const ok = await confirmDialog({
      title: `${label}引擎？`,
      message: next
        ? '常驻引擎将保持运行，不再因空闲超时自动释放。'
        : '关闭常驻后，引擎将按下方“空闲超时”自动释放。',
      okText: label,
    });
    if (!ok) return;
    if (self.cfg) self.cfg = { ...self.cfg, engine: { ...self.cfg.engine, resident: next } };
    await saveConfigPatch({ resident: next }, { successText: next ? '引擎常驻已启用' : '引擎常驻已关闭' });
  }

  async function saveIdleTimeout(minutes) {
    if (!api || self.saving || self.opTask) return;
    const seconds = idleSecondsOfMin(minutes);
    const cur = Number((self.cfg && self.cfg.engine && self.cfg.engine.idle_timeout_s) || 0);
    if (seconds === cur) return;
    if (self.cfg) self.cfg = { ...self.cfg, engine: { ...self.cfg.engine, idle_timeout_s: seconds } };
    await saveConfigPatch({ idle_timeout_s: seconds }, { successText: `空闲超时已设为 ${fmtIdleLabel(minutes)}` });
  }

  /* ---------------- 参数卡 ---------------- */

  function readFormFromDom() {
    const f = self.form ? { ...self.form } : configToForm(self.cfg);
    const $ = (name) => rootEl.querySelector(`[data-cfg="${name}"]`);
    const numeric = (name) => {
      const el = $(name);
      if (!el) return NaN;
      const n = Number(el.value);
      return el.value === '' || !Number.isFinite(n) ? NaN : n;
    };
    f.numAnalysisThreads = numeric('numAnalysisThreads');
    f.numSearchThreadsPerAnalysisThread = numeric('numSearchThreadsPerAnalysisThread');
    f.standardMaxVisits = numeric('standardMaxVisits');
    f.deepMaxVisits = numeric('deepMaxVisits');
    f.maxUndo = numeric('maxUndo');
    f.komi = numeric('komi');
    const range = $('adaptiveLevel');
    if (range) f.adaptiveLevel = Number(range.value) || f.adaptiveLevel;
    const rules = $('rules');
    if (rules) f.rules = rules.value;
    // boardSize / humanColor 为 segctl（无 data-cfg），已由点击即时写入 self.form
    return f;
  }

  /** 参数校验错误字段顺序（渲染与聚焦共用；须与 validateConfigForm 错误键一致）。 */
  const CONFIG_FORM_FIELDS = ['numAnalysisThreads', 'numSearchThreadsPerAnalysisThread', 'standardMaxVisits', 'deepMaxVisits', 'maxUndo', 'komi'];

  function renderFormErrors(errs) {
    for (const name of CONFIG_FORM_FIELDS) {
      const el = rootEl.querySelector(`[data-err="${name}"]`);
      if (el) {
        setText(el, errs[name] || '');
        setStyleProp(el, 'display', errs[name] ? '' : 'none');
      }
      // 控件态同步（WIG：错误就地呈现 + aria-invalid 标记）
      const input = rootEl.querySelector(`[data-cfg="${name}"]`);
      if (input) {
        const invalid = Boolean(errs[name]);
        if (input.hasAttribute('aria-invalid') !== invalid) {
          if (invalid) input.setAttribute('aria-invalid', 'true');
          else input.removeAttribute('aria-invalid');
        }
      }
    }
  }

  /** 校验失败 → 聚焦首个错误输入（WIG：focus first error on submit）。 */
  function focusFirstFormError(errs) {
    for (const name of CONFIG_FORM_FIELDS) {
      if (!errs[name]) continue;
      const input = rootEl.querySelector(`[data-cfg="${name}"]`);
      if (input && typeof input.focus === 'function') {
        input.focus();
        return;
      }
    }
  }

  async function saveConfigForm() {
    if (!api || self.saving || self.opTask) return;
    const form = readFormFromDom();
    const { ok, errs } = validateConfigForm(form);
    renderFormErrors(errs);
    if (!ok) {
      focusFirstFormError(errs);
      toast({ level: 'error', text: '参数校验未通过，请修正高亮项', key: 'adm-cfg-invalid' });
      return;
    }
    const { payload, changed, restart } = buildConfigPayload(form, self.cfg);
    if (changed.length === 0) {
      toast({ level: 'info', text: '没有需要保存的更改', key: 'adm-cfg-nodiff' });
      return;
    }
    self.saving = true;
    renderConfigBusy();
    try {
      const res = await api.put('/admin/config', payload);
      const data = res && res.data;
      if (data) applyConfig(data);
      const warn = data && data.restart_warning;
      const text = restart
        ? warn || '参数已保存；引擎级变更将在引擎空闲时安全重启生效'
        : '配置已保存（应用级热更新即时生效）';
      toast({ level: 'success', text, key: 'adm-cfg-saved' });
      renderDynamic();
    } catch (err) {
      toastError(err, '配置保存失败');
    } finally {
      self.saving = false;
      renderConfigBusy();
    }
  }

  function resetConfigForm() {
    self.form = configToForm(self.cfg);
    renderParamValues();
    renderFormErrors({});
  }

  /* ---------------- 模型保存 ---------------- */

  async function saveModel() {
    if (!api || self.saving || self.opTask || !self.models) return;
    const sel = rootEl.querySelector('[data-ref="modelSelect"]');
    if (!sel || !sel.value) return;
    const next = sel.value;
    const cur = currentModel(self.models);
    if (next === cur) return;
    const ok = await confirmDialog({
      ...modelSaveCopy(self.engine.state),
      okIcon: 'i-model',
    });
    if (!ok) return;
    self._modelNext = next;
    await engineTask('set_model', {
      path: '/admin/models/default',
      method: 'put',
      body: { model: next },
    });
  }

  /* ---------------- UI 设置（localStorage；与壳偏好同源） ---------------- */

  function applyDecorBody() {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('tgo-decor', decorEnabled());
  }

  function handleUiClick(act, value) {
    if (act === 'accent') {
      if (theme) theme.setAccent(value);
      else ls.set(LS_KEYS.accent, value);
    } else if (act === 'mode') {
      if (theme) theme.setMode(value);
      else ls.set(LS_KEYS.theme, value);
      if (refreshChrome) refreshChrome();
    } else if (act === 'mute') {
      const next = value === 'on';
      if (settings) settings.setMuted(next);
      else ls.set(LS_KEYS.muted, next);
      if (refreshChrome) refreshChrome();
    } else if (act === 'stone') {
      const next = value === 'on';
      if (settings) settings.setStoneMotion(next);
      else setStoneMotion(next);
    } else if (act === 'decor') {
      const next = value === 'on';
      if (settings) settings.setDecor(next);
      else setDecor(next);
      applyDecorBody();
    } else if (act === 'match') {
      const next = value === 'on';
      if (settings) settings.setShowAiMatch(next);
      else setShowAiMatch(next);
    }
    syncSegByAct(act, value);
  }

  function syncSegByAct(act, value) {
    const segName = act === 'accent' ? 'uiAccent' : act === 'mode' ? 'uiMode' : null;
    if (!segName) return;
    const host = rootEl.querySelector(`[data-seg="${segName}"]`);
    if (!host) return;
    host.querySelectorAll('button').forEach((btn) => {
      const on = btn.dataset.v === value;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  function syncSwitch(ref, on) {
    const el = rootEl.querySelector(`[data-switch="${ref}"]`);
    if (!el) return;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', String(on));
  }

  /* ---------------- 渲染 ---------------- */

  function segButtons(options, current) {
    return options
      .map(
        (o) =>
          `<button type="button" class="${o.value === current ? 'on' : ''}" data-v="${o.value}" aria-pressed="${o.value === current}">${o.label}</button>`,
      )
      .join('');
  }

  /**
   * 开关（项目统一样式 button.switch）。
   * label 为可访问名（aria-label）——role=switch 空按钮无文本可取名（WIG 合规轮）。
   * 注意：Tooltip 一律放邻近标签文字（历史约束：旧伪元素方案下 `.switch` 自身挂
   * [data-tip] 会被 `[data-tip]::after` 劫持滑块伪元素；现为全局单例浮层已无此
   * 冲突，保持现状以减少 DOM 变更）。
   */
  function switchHTML(ref, on, label) {
    return `<button type="button" class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}" data-switch="${ref}" aria-label="${label}"></button>`;
  }

  function engineOpsHTML() {
    // 引擎任务（start/stop/restart）进行中：操作区替换为受理提示（set_model 不影响引擎按钮区）
    if (self.opTask && self.opTask !== 'set_model') {
      return `<div class="eng-ops"><span class="muted" style="font-size:12px;align-self:center">${ADMIN_TASK_LABEL[self.opTask] || self.opTask}已受理，执行中…</span></div>`;
    }
    const state = self.engine.state;
    // 非常驻（resident=false）时 [停止] 恒禁用：引擎由系统按需自动拉起/释放（ISSUE-055 关闭口径）。
    // 配置尚未加载（self.cfg=null）时按常驻处理避免误禁——applyConfig 后 renderDynamic 会按真实值刷新。
    const resident = !self.cfg || Boolean(self.cfg.engine && self.cfg.engine.resident);
    const ops = engineOps(state, { resident });
    // 灰置只跟引擎异步任务（self.opTask）：配置保存（self.saving）与引擎控制无关，
    // 不得让 [启动/停止/重启] 随配置保存灰置一瞬（＝卡片闪烁，2026/10/10 人工反馈）。
    const busy = Boolean(self.opTask);
    if (state === 'FATAL') {
      return `<div class="eng-ops">
        <button type="button" class="btn btn-primary btn-sm" data-act="eng-start"${busy ? ' disabled' : ''}>${icn('i-restart', 15)}手动重启</button>
      </div>`;
    }
    const btns = [
      { act: 'eng-start', label: '启动', icon: 'i-start', enabled: ops.start },
      { act: 'eng-stop', label: '停止', icon: 'i-stop', enabled: ops.stop },
      { act: 'eng-restart', label: '重启', icon: 'i-restart', enabled: ops.restart },
    ];
    return `<div class="eng-ops">${btns
      .map((b) => {
        const disabled = busy || !b.enabled;
        const reason = disabled && !busy ? engineOpReason(state, b.act.slice(4), { resident }) : null;
        return `<button type="button" class="btn btn-secondary btn-sm" data-act="${b.act}"${disabled ? ' disabled' : ''}${reason ? ` data-tip="${reason}"` : ''}>${icn(b.icon, 15)}${b.label}</button>`;
      })
      .join('')}</div>`;
  }

  /**
   * 「已排队，将在引擎空闲时执行」提示：**仅在确认排入异步任务后**展示（BUG-138），
   * 且不用于 [启动]——拉起不是「排队等空闲」，其受理提示由操作区（[启动] 已受理，执行中…）
   * 给出；引擎未运行/无需重启等**无排队**情形只保留后端返回的单条文案。
   */
  function engineQueueHTML() {
    if (self.opQueued !== true || self.opTask === 'start') return '';
    return `<div style="margin-top:10px" aria-live="polite">
      <div class="toast toast-info" role="status" style="justify-content:flex-start">
        <span class="toast-icon">${icn('i-info', 16)}</span>
        <span class="toast-text">已排队，将在引擎空闲时执行</span>
      </div>
    </div>`;
  }

  function renderEngine() {
    const region = rootEl.querySelector('[data-ref="engRegion"]');
    if (!region) return;
    const meta = engineCardMeta(
      self.engine.state,
      self.engine.progress,
      self.engine.reason || null,
      self.engine.detail || null
    );
    const labelEl = region.querySelector('[data-ref="engLabel"]');
    const subEl = region.querySelector('[data-ref="engSub"]');
    const icoEl = region.querySelector('[data-ref="engIco"]');
    setText(labelEl, meta.label);
    setText(subEl, meta.sub);
    setStyleProp(icoEl, 'color', `var(--eng-${meta.tone})`);

    // 引擎卡控件的灰置只跟「引擎异步任务在途」（self.opTask）走：**配置保存（self.saving）
    // 与引擎卡无关**——旧实现把它算进 busy，于是保存空闲超时/常驻时，整张引擎卡的
    // [启动/停止/重启]+滑杆+模型区会灰置一瞬再恢复（＝卡片闪烁一下，2026/10/10 人工反馈）。
    // 保存期间的重复操作由各处理器的 self.saving 早退守门（行为不变，只是不再闪烁）。
    const busy = Boolean(self.opTask);
    const resident = Boolean(self.cfg && self.cfg.engine && self.cfg.engine.resident);
    const residentEl = region.querySelector('[data-switch="resident"]');
    if (residentEl) {
      setClassOn(residentEl, resident);
      setAriaChecked(residentEl, resident);
      setDisabled(residentEl, busy);
    }
    // 「常驻」旁说明文案：开＝引擎保持常驻运行 / 关＝引擎按需自动拉起，空闲超时自动释放
    setText(region.querySelector('[data-ref="residentNote"]'), residentNoteText(resident));
    const idleSec = Number((self.cfg && self.cfg.engine && self.cfg.engine.idle_timeout_s) || 0);
    const idleMin = snapIdleMin(idleSec);
    const idleRange = region.querySelector('[data-ref="idleRange"]');
    setValue(idleRange, String(idleMin));
    setDisabled(idleRange, idleSliderDisabled({ busy, resident }));
    setText(region.querySelector('[data-ref="idleVal"]'), fmtIdleLabel(idleMin));
    setText(
      region.querySelector('[data-ref="idleNote"]'),
      idleOnGrid(idleSec)
        ? ''
        : `当前配置 ${fmtIdleLabel(Math.round((idleSec / 60) * 10) / 10)}，拖动滑杆将按 ${IDLE_STEP_MIN} 分钟步进保存`,
    );

    const ops = region.querySelector('[data-ref="engOps"]');
    if (setHTML(ops, engineOpsHTML())) rescanTips();
    const queue = region.querySelector('[data-ref="engQueue"]');
    setHTML(queue, engineQueueHTML());
  }

  function renderModel() {
    const region = rootEl.querySelector('[data-ref="modelRegion"]');
    if (!region) return;
    const models = standardModels(self.models);
    const cur = currentModel(self.models);
    const sel = region.querySelector('[data-ref="modelSelect"]');
    if (sel) {
      if (!self.models) {
        // 数据未就绪：保留占位，禁选（签名置空 → 数据到达后必定重建）
        setOptions(sel, '<option value="">— 加载中… —</option>', '');
        setDisabled(sel, true);
      } else {
        // 选项集变化才重建（签名含默认模型）：重建会丢失用户未保存的选择，故重建后
        // 回填「待保存选择」——否则他端 admin.config 广播 / admin.task 触发的
        // refreshAll 会在用户点击 [保存模型] 前静默吞掉刚选中的模型（BUG-120）。
        const pending = models.some((m) => m.name === sel.value) ? sel.value : '';
        const signature = `${cur}|${models.map((m) => m.name).join('\u0000')}`;
        setOptions(
          sel,
          models
            .map((m) => `<option value="${escapeHtml(m.name)}"${m.name === cur ? ' selected' : ''}>${escapeHtml(m.name)}</option>`)
            .join(''),
          signature,
        );
        const fallback = cur && models.some((m) => m.name === cur) ? cur : models.length ? models[0].name : '';
        setValue(sel, pending || fallback);
        // 模型区灰置同 renderEngine：只跟引擎异步任务（self.opTask），与配置保存无关
        setDisabled(sel, Boolean(self.opTask));
      }
    }
    const human = humanModelInfo(self.models);
    const badge = region.querySelector('[data-ref="modelHuman"]');
    if (badge) {
      setHTML(
        badge,
        human.ok
          ? `<span class="badge accent">${icn('i-model', 12)}人类模型</span><span class="muted ellipsis" style="font-size:12px;min-width:0">${escapeHtml(human.name || '已就绪')}</span>`
          : `<span class="badge warn">${icn('i-error', 12)}未找到</span><span class="muted" style="font-size:12px">人类模型 · 未找到（*human*.bin.gz）</span>`,
      );
    }
    const saveBtn = region.querySelector('[data-ref="modelSave"]');
    if (saveBtn) {
      setDisabled(
        saveBtn,
        !modelSaveEnabled({ models: self.models, selected: sel ? sel.value : '', busy: Boolean(self.opTask) }),
      );
    }
  }

  function renderParamValues() {
    const f = self.form || configToForm(self.cfg);
    const $ = (name) => rootEl.querySelector(`[data-cfg="${name}"]`);
    const setNum = (name, v) => setValue($(name), String(v));
    setNum('numAnalysisThreads', f.numAnalysisThreads);
    setNum('numSearchThreadsPerAnalysisThread', f.numSearchThreadsPerAnalysisThread);
    setNum('standardMaxVisits', f.standardMaxVisits);
    setNum('deepMaxVisits', f.deepMaxVisits);
    setNum('maxUndo', f.maxUndo);
    setNum('komi', f.komi);
    setValue($('rules'), f.rules);
    setValue($('adaptiveLevel'), String(f.adaptiveLevel));
    setText(rootEl.querySelector('[data-ref="adaptiveVal"]'), rankShort(f.adaptiveLevel));
    // segctl（默认棋盘 / 执色）：同步选中态
    const syncSegEl = (name, val) => {
      const host = rootEl.querySelector(`[data-seg="${name}"]`);
      if (!host) return;
      host.querySelectorAll('button').forEach((b) => {
        setClassOn(b, b.dataset.v === String(val));
      });
    };
    syncSegEl('boardSize', f.boardSize);
    syncSegEl('humanColor', f.humanColor);
  }

  /** 引擎级脏提示：numAnalysisThreads / numSearchThreadsPerAnalysis 相对已存 .yaml 不一致。 */
  function renderDirty() {
    const el = rootEl.querySelector('[data-ref="dirtyEngine"]');
    if (!el) return;
    let dirty = false;
    if (self.cfg && api) {
      const { changed } = buildConfigPayload(readFormFromDom(), self.cfg);
      dirty =
        changed.includes('num_analysis_threads') ||
        changed.includes('num_search_threads_per_analysis_thread');
    }
    setHidden(el, !dirty);
  }

  function renderDynamic() {
    renderEngine();
    renderModel();
    renderParamValues();
    renderDirty();
    renderScopeCopy();
    renderUpdates();
  }

  /**
   * 引擎级变更的「生效口径」文案随引擎态刷新（BUG-139）：模型卡提示 / 参数卡三处提示
   * 原先写死「安全重启」，引擎未运行或致命时与事实不符（一旦改动模型/引擎参数，实际只落
   * 配置、下次启动生效）。单一取值源＝`engineChangeCopy(self.engine.state)`。
   */
  function renderScopeCopy() {
    const copy = engineChangeCopy(self.engine.state);
    const set = (ref, text) => setText(rootEl.querySelector(`[data-ref="${ref}"]`), text);
    set('modelSaveHint', copy.modelSaveHint);
    set('engineKeyScope', copy.engineKeyScope);
    set('dirtyEngineNote', copy.dirtyNote);
    set('engineKeyWarn', copy.warnTag);
  }

  /* ---------------- 版本与资源卡（应用更新 / KataGo / 模型） ---------------- */

  function updateTaskOf() {
    return self.updates.task || (self.updates.info && self.updates.info.task) || null;
  }

  function updateBusy() {
    const task = updateTaskOf();
    return Boolean(task && task.status === 'running') || self.updates.loading;
  }

  async function loadUpdates({ check = false, force = false } = {}) {
    if (!api) return;
    if (self.updates.loading) {
      // 首次加载较慢时用户点击「检查更新」：排入下一轮，避免静默忽略
      self.updates.pendingCheck = self.updates.pendingCheck || check;
      return;
    }
    self.updates.loading = true;
    if (check) self.updates.checking = true;
    renderUpdates();
    try {
      // 先取服务端本地信息（不依赖 GitHub）：应用版本 / KataGo 实际版本可立即如实展示，
      // 不受后续远端请求失败或 20s 超时影响。
      const infoRes = await api.get('/admin/app');
      if (self.destroyed) return;
      if (infoRes && infoRes.data) {
        self.updates.info = infoRes.data;
        if (infoRes.data.task) self.updates.task = infoRes.data.task;
      }
      renderUpdates();

      const [checkRes, kataRes, modelRes] = await Promise.all([
        // 更新检查依赖 GitHub：失败必须**局部降级**，只提示检查失败，不得影响版本展示。
        check
          ? api
              .post('/admin/app/check', undefined, { query: force ? { force: 1 } : undefined })
              .catch((err) => ({ error: err }))
          : Promise.resolve(null),
        api.get('/admin/kata/releases').catch((err) => ({ error: err })),
        api.get('/admin/models/remote').catch((err) => ({ error: err })),
      ]);
      if (self.destroyed) return;
      if (checkRes && checkRes.data) {
        self.updates.check = checkRes.data;
        self.updates.checkError = null;
      } else if (check) {
        // 保留上一次成功的检查结果（若有），仅提示本次检查失败
        self.updates.checkError =
          (checkRes && checkRes.error && checkRes.error.message) || '无法访问更新服务器';
      }
      self.updates.releases =
        kataRes && kataRes.data
          ? kataRes.data
          : {
              supported: false,
              releases: [],
              message:
                (kataRes && kataRes.error && kataRes.error.message) || 'KataGo 版本列表加载失败',
            };
      self.updates.models =
        modelRes && modelRes.data
          ? modelRes.data
          : {
              standard: [],
              human: null,
              message:
                (modelRes && modelRes.error && modelRes.error.message) || '官方模型列表加载失败',
            };
      const releases = self.updates.releases.releases || [];
      const recommended = self.updates.releases.recommended || null;
      if (!self.updates.kataTag) {
        self.updates.kataTag =
          (recommended && recommended.tag) || (releases[0] && releases[0].tag) || null;
      }
      if (!releases.some((release) => release.tag === self.updates.kataTag)) {
        self.updates.kataTag = (releases[0] && releases[0].tag) || null;
      }
      self.updates.kataAsset = pickKataAsset(
        releases,
        self.updates.kataTag,
        self.updates.kataAsset,
      );
      const standard = (self.updates.models && self.updates.models.standard) || [];
      if (!standard.some((model) => model.name === self.updates.stdModel)) {
        // 默认选第一个与当前引擎兼容的模型（最新 transformer 可能需要更新引擎）
        const compatible = standard.find((model) => model.compatible !== false) || standard[0];
        self.updates.stdModel = compatible ? compatible.name : '';
      }
    } catch (err) {
      if (!self.destroyed) toastError(err, '版本信息加载失败');
    } finally {
      self.updates.loading = false;
      self.updates.checking = false;
      if (!self.destroyed) renderUpdates();
      if (self.updates.pendingCheck) {
        self.updates.pendingCheck = false;
        loadUpdates({ check: true, force: true });
      }
    }
  }

  function renderUpdates() {
    const region = rootEl.querySelector('[data-ref="updRegion"]');
    if (!region) return;
    const info = self.updates.info;
    const task = updateTaskOf();
    const busy = updateBusy();
    const set = (ref, text) => setText(region.querySelector(`[data-ref="${ref}"]`), text);

    set('updAppVersion', versionLabel(info && info.app && info.app.version));
    const appLatest = self.updates.check && self.updates.check.latest;
    setVersionDot(
      region,
      'updAppDot',
      isNewerVersion(appLatest && appLatest.version, info && info.app && info.app.version),
      appLatest && appLatest.version,
    );
    set(
      'updMode',
      info && info.deployment
        ? DEPLOYMENT_MODE_LABEL[info.deployment.mode] || info.deployment.mode
        : '—',
    );
    set(
      'updEngineVersion',
      info && info.engine && info.engine.version
        ? versionLabel(info.engine.version)
        : info && info.engine && info.engine.installed
          ? '已安装（版本未知）'
          : '未安装',
    );
    const repoLink = region.querySelector('[data-ref="updRepoLink"]');
    if (repoLink && info && info.app) {
      setText(repoLink, info.app.repo || '—');
      if (repoLink.getAttribute('href') !== info.app.releaseUrl) {
        repoLink.setAttribute('href', info.app.releaseUrl || '#');
      }
    }
    const dockerNote = region.querySelector('[data-ref="updDockerNote"]');
    const updateSupported = !info || !info.deployment || info.deployment.updateSupported !== false;
    setHidden(dockerNote, updateSupported);
    if (!updateSupported && dockerNote) {
      setText(
        dockerNote.querySelector('[data-ref="updDockerText"]'),
        (info.deployment && info.deployment.reason) ||
          '容器部署不支持页内自更新，请拉取新镜像后重建',
      );
    }

    const checkVM = updateCheckVM(self.updates.check);
    const checkError = self.updates.checkError;
    set(
      'updCheckText',
      self.updates.checking
        ? '检查中…'
        : checkError
          ? `更新检查失败：${checkError}`
          : checkVM.text,
    );
    setDisabled(region.querySelector('[data-act="upd-check"]'), busy || self.updates.checking);
    const detail = region.querySelector('[data-ref="updCheckDetail"]');
    const hasUpdate = Boolean(self.updates.check && self.updates.check.updateAvailable);
    setHidden(detail, !hasUpdate);
    if (detail && hasUpdate) {
      const latest = self.updates.check.latest;
      setText(
        detail.querySelector('[data-ref="updLatest"]'),
        `${versionLabel(latest.version)} · ${latest.publishedAt ? String(latest.publishedAt).slice(0, 10) : '发布日期未知'}${latest.asset ? ` · ${latest.asset.name}` : ' · 无更新包'}`,
      );
      setDisabled(detail.querySelector('[data-act="upd-apply"]'), busy || !checkVM.canUpdate);
      // 弹窗可展示 Release 正文；无正文时仍允许跳转 GitHub 查看
      setHidden(detail.querySelector('[data-act="upd-notes"]'), !latest.notes && !latest.htmlUrl);
    }

    const progressVM = taskProgressVM(task);
    const progress = region.querySelector('[data-ref="updProgress"]');
    setHidden(progress, !progressVM.active && !progressVM.failed);
    if (progress) {
      setStyleProp(
        progress.querySelector('[data-ref="updProgressBar"]'),
        'width',
        `${progressVM.percent == null ? 0 : progressVM.percent}%`,
      );
      setText(progress.querySelector('[data-ref="updProgressText"]'), progressVM.text);
    }

    /* ---- KataGo 引擎 ---- */
    const kata = self.updates.releases || {};
    const releases = kata.releases || [];
    const recommended = kata.recommended || null;
    const engineCurrent = (info && info.engine && info.engine.version) || kata.currentVersion || null;
    const engineLatest = (releases[0] && releases[0].tag) || (recommended && recommended.tag) || null;
    setVersionDot(
      region,
      'updEngineDot',
      isNewerVersion(engineLatest, engineCurrent),
      engineLatest,
    );
    const releaseSel = region.querySelector('[data-ref="updRelease"]');
    const releaseOptions = kataReleaseOptions(releases);
    if (releaseSel) {
      setOptions(
        releaseSel,
        releaseOptions
          .map((option) => {
            const recommendedMark =
              recommended && recommended.tag === option.value ? '（推荐）' : '';
            return `<option value="${escapeHtml(option.value)}"${option.value === self.updates.kataTag ? ' selected' : ''}>${escapeHtml(option.label)}${recommendedMark}</option>`;
          })
          .join('') || '<option value="">— 暂无可用版本 —</option>',
        releases.map((release) => release.tag).join('\u0000'),
      );
      setValue(releaseSel, self.updates.kataTag || '');
      setDisabled(releaseSel, busy || !kata.supported || releases.length === 0);
    }
    const assetOptions = kataAssetOptions(releases, self.updates.kataTag);
    const assetSel = region.querySelector('[data-ref="updAsset"]');
    if (assetSel) {
      setOptions(
        assetSel,
        assetOptions
          .map(
            (option) =>
              `<option value="${escapeHtml(option.value)}"${option.value === self.updates.kataAsset ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
          )
          .join('') || '<option value="">— 暂无可用构建 —</option>',
        assetOptions.map((option) => option.value).join('\u0000'),
      );
      setValue(assetSel, self.updates.kataAsset || '');
      setDisabled(assetSel, busy || assetOptions.length === 0);
    }
    set(
      'updKataHint',
      kata.currentVersion
        ? `当前 ${versionLabel(kata.currentVersion)}`
        : info && info.engine && info.engine.installed
          ? '当前版本未知'
          : '未安装',
    );
    setDisabled(
      region.querySelector('[data-act="kata-download"]'),
      busy || !kata.supported || !self.updates.kataAsset,
    );

    /* ---- 官方模型 ---- */
    const modelsPayload = self.updates.models || {};
    const standard = modelsPayload.standard || [];
    const modelSel = region.querySelector('[data-ref="updStdModel"]');
    if (modelSel) {
      setOptions(
        modelSel,
        standard
          .map(
            (model) =>
              `<option value="${escapeHtml(model.name)}"${model.name === self.updates.stdModel ? ' selected' : ''}>${escapeHtml(modelOptionLabel(model))}</option>`,
          )
          .join('') || '<option value="">— 暂无官方模型 —</option>',
        standard.map((model) => `${model.name}|${model.compatible}|${model.elo ?? ''}`).join('\u0000'),
      );
      setValue(modelSel, self.updates.stdModel || '');
      setDisabled(modelSel, busy || standard.length === 0);
    }
    const selectedModel = standard.find((model) => model.name === self.updates.stdModel) || null;
    let compatHint = modelsPayload.message || '';
    if (!compatHint && selectedModel) {
      if (selectedModel.compatible === false) {
        compatHint = `该模型需要 KataGo ≥ ${selectedModel.required}（当前 ${versionLabel(modelsPayload.engineVersion)}），请先更新引擎。`;
      } else if (selectedModel.compatible === true) {
        compatHint = '与当前引擎兼容。';
      } else {
        compatHint = '该模型未声明最低引擎版本（如无法加载请升级 KataGo）。';
      }
    }
    set('updModelCompat', compatHint);
    set(
      'updModelHint',
      standard.length ? `前 ${standard.length} 个训练模型 · ` : '',
    );
    set(
      'updHumanModelName',
      modelsPayload.human ? modelsPayload.human.name : 'b18c384nbt-humanv0.bin.gz',
    );
    setDisabled(
      region.querySelector('[data-act="model-download"]'),
      busy || !self.updates.stdModel,
    );
    setDisabled(
      region.querySelector('[data-act="model-download-human"]'),
      busy || !modelsPayload.human,
    );
  }

  /** 引擎异步任务（start/stop/restart/set_model）在途：刷新引擎卡（受理提示 + 控件灰置）。 */
  function renderOpsBusy() {
    renderEngine();
    renderModel();
  }

  /**
   * 配置表单保存在途（self.saving）：**只**同步参数卡自身的 [保存更改]/[重置] 禁用态。
   * 不得调用 renderEngine/renderModel——否则引擎卡控件会随保存灰置一瞬再恢复，
   * 用户在管理页看到的就是「保存后卡片闪烁一下」（2026/10/10 人工反馈）。
   * 仅 [保存更改] 触发的表单保存需要此锁（即时保存见 saveConfigPatch）。
   */
  function renderConfigBusy() {
    setDisabled(rootEl.querySelector('[data-ref="cfgSave"]'), self.saving);
    setDisabled(rootEl.querySelector('[data-ref="cfgReset"]'), self.saving);
  }

  function rescanTips() {
    if (typeof window !== 'undefined' && window.tgoTooltip && typeof window.tgoTooltip.convert === 'function') {
      window.tgoTooltip.convert();
    }
  }

  /** 版本角标红点同步（隐藏/显示 + 最新版本 tooltip）。 */
  function setVersionDot(region, ref, outdated, latestVersion) {
    const dot = region.querySelector(`[data-ref="${ref}"]`);
    if (!dot) return;
    setHidden(dot, !outdated);
    if (!outdated || !latestVersion) return;
    const tip = `有新版本：${versionLabel(latestVersion)}`;
    if (dot.getAttribute('data-tip') !== tip) {
      dot.setAttribute('data-tip', tip);
      dot.setAttribute('aria-label', tip);
    }
  }

  /* ---------------- 事件 ---------------- */

  async function runUpdateAction(path, body, task) {
    if (!api) return;
    const previous = self.updates.task;
    self.updates.task = {
      task,
      status: 'running',
      progress: 0,
      message: '任务已受理…',
    };
    renderUpdates();
    try {
      const res = await api.post(path, body);
      const message = (res && res.data && res.data.message) || `${ADMIN_TASK_LABEL[task] || task}已受理`;
      toast({ level: 'info', text: message, key: 'upd-202' });
    } catch (err) {
      self.updates.task = previous;
      renderUpdates();
      toastError(err, `${ADMIN_TASK_LABEL[task] || task}请求失败`);
    }
  }

  /**
   * [更新说明] → 页内弹窗（复用 `.dialog-mask/.dialog`）。
   * 正文为 Release body；若该 Release 有 htmlUrl，额外提供「在 GitHub 查看」按钮，
   * 由用户自行选择是否外跳。
   */
  function openReleaseNotesDialog() {
    const latest = self.updates.check && self.updates.check.latest;
    if (!latest || (!latest.notes && !latest.htmlUrl)) return;
    const doc = rootEl.ownerDocument || document;
    const modalRoot = ensureModalRoot(doc);
    if (modalRoot.querySelector('.upd-notes-dialog')) return; // 单例：已在展示

    const previousFocus = doc.activeElement;
    const mask = doc.createElement('div');
    mask.className = 'dialog-mask upd-notes-mask';
    const notes = releaseNotesHtml(latest.notes);
    const published = latest.publishedAt
      ? String(latest.publishedAt).slice(0, 10)
      : null;
    mask.innerHTML = `
      <div class="dialog upd-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="updNotesTitle" tabindex="-1">
        <div class="upd-notes-head">
          <div class="dialog-title" id="updNotesTitle">${escapeHtml(versionLabel(latest.version))} 更新说明</div>
          ${published ? `<span class="muted">发布于 ${escapeHtml(published)}</span>` : ''}
        </div>
        <div class="upd-notes-body">${notes || '<span class="muted">该版本未提供更新说明。</span>'}</div>
        <div class="dialog-actions">
          ${latest.htmlUrl ? `<a class="btn btn-secondary" href="${escapeHtml(latest.htmlUrl)}" target="_blank" rel="noopener">${icn('i-export', 15)}在 GitHub 查看</a>` : ''}
          <button type="button" class="btn btn-primary" data-act="close">关闭</button>
        </div>
      </div>`;
    modalRoot.appendChild(mask);

    const closeBtn = mask.querySelector('[data-act="close"]');
    closeBtn.focus();

    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      close();
    };
    function close() {
      mask.removeEventListener('click', onMaskClick);
      doc.removeEventListener('keydown', onKey, true);
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    }
    function onMaskClick(ev) {
      const target = ev.target;
      if (target === mask || (target.closest && target.closest('[data-act="close"]'))) close();
    }
    mask.addEventListener('click', onMaskClick);
    doc.addEventListener('keydown', onKey, true);
  }

  async function applyAppUpdate() {
    const check = self.updates.check;
    if (!check || !check.updateAvailable || !check.latest) return;
    const version = check.latest.version;
    const ok = await confirmDialog({
      title: `更新到 ${versionLabel(version)}？`,
      message:
        '更新将覆盖程序文件（保留 config.yaml、data、logs、engine 与虚拟环境），完成后服务会自动重启。请先保存正在进行的工作。',
      okText: '立即更新',
      okIcon: 'i-download',
    });
    if (!ok) return;
    await runUpdateAction('/admin/app/update', { version }, 'app_update');
  }

  async function downloadKata() {
    const tag = self.updates.kataTag;
    const asset = self.updates.kataAsset;
    if (!tag || !asset) return;
    const ok = await confirmDialog({
      title: '下载并安装 KataGo？',
      message:
        '安装前会停止当前引擎（进行中的分析与对局会中断），完成后按原状态重新启动。用户 analysis.cfg 会保留。',
      okText: '下载并安装',
      okIcon: 'i-download',
    });
    if (!ok) return;
    await runUpdateAction(
      '/admin/kata/download',
      { release_tag: tag, asset_name: asset },
      'engine_download',
    );
  }

  async function downloadStandardModel() {
    const name = self.updates.stdModel;
    if (!name) return;
    const ok = await confirmDialog({
      title: '下载标准模型？',
      message: `将下载 ${name} 到模型目录；下载后请在「引擎与模型」卡设为默认并重启引擎。`,
      okText: '下载模型',
      okIcon: 'i-download',
    });
    if (!ok) return;
    await runUpdateAction('/admin/models/download', { kind: 'standard', name }, 'model_download');
  }

  async function downloadHumanModel() {
    const human = self.updates.models && self.updates.models.human;
    if (!human) return;
    const ok = await confirmDialog({
      title: '下载人类模型？',
      message: `将下载 ${human.name} 到模型目录；下载后重启引擎即可启用人类风格/自适应对局。`,
      okText: '下载模型',
      okIcon: 'i-download',
    });
    if (!ok) return;
    await runUpdateAction(
      '/admin/models/download',
      { kind: 'human', name: human.name },
      'model_download',
    );
  }

  async function onRootClick(ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act) {
      if (act === 'eng-start') {
        const fatal = self.engine.state === 'FATAL';
        await engineTask('start', {
          confirmText: fatal
            ? manualRestartCopy(self.engine.reason || null, self.engine.detail || null)
            : null,
          path: '/admin/engines/start',
        });
      } else if (act === 'eng-stop') {
        await engineTask('stop', {
          confirmText: {
            title: '停止引擎？',
            message: '引擎将在空闲时安全停止（进行中的分析任务不受影响）。',
            okText: '停止引擎',
          },
          path: '/admin/engines/stop',
        });
      } else if (act === 'eng-restart') {
        await engineTask('restart', {
          confirmText: {
            title: '重启引擎？',
            message: '引擎将在空闲时安全重启，进行中的对局与分析任务不受影响。',
            okText: '重启引擎',
          },
          path: '/admin/engines/restart',
        });
      } else if (act === 'cfg-save') {
        await saveConfigForm();
      } else if (act === 'cfg-reset') {
        resetConfigForm();
      } else if (act === 'model-save') {
        await saveModel();
      } else if (act === 'upd-check') {
        await loadUpdates({ check: true, force: true });
      } else if (act === 'upd-apply') {
        await applyAppUpdate();
      } else if (act === 'upd-notes') {
        openReleaseNotesDialog();
      } else if (act === 'kata-download') {
        await downloadKata();
      } else if (act === 'model-download') {
        await downloadStandardModel();
      } else if (act === 'model-download-human') {
        await downloadHumanModel();
      }
      return;
    }

    if (btn.dataset.switch) {
      const on = btn.getAttribute('aria-checked') === 'true';
      const ref = btn.dataset.switch;
      const next = !on;
      if (ref === 'resident') {
        await toggleResident(next);
      } else if (ref === 'uiMute') {
        handleUiClick('mute', on ? 'off' : 'on');
        syncSwitch('uiMute', next);
      } else if (ref === 'uiStone') {
        handleUiClick('stone', on ? 'off' : 'on');
        syncSwitch('uiStone', next);
      } else if (ref === 'uiDecor') {
        handleUiClick('decor', on ? 'off' : 'on');
        syncSwitch('uiDecor', next);
      } else if (ref === 'uiMatch') {
        handleUiClick('match', on ? 'off' : 'on');
        syncSwitch('uiMatch', next);
      }
      return;
    }

    const segHost = btn.closest('[data-seg]');
    if (segHost) {
      const segName = segHost.dataset.seg;
      const value = btn.dataset.v;
      if (segName === 'uiAccent') {
        handleUiClick('accent', value);
      } else if (segName === 'uiMode') {
        handleUiClick('mode', value);
      } else {
        // 对弈级默认棋盘/执色（参数表单；写 self.form，随 [保存更改] 提交）
        if (segName === 'boardSize' && self.form) self.form.boardSize = Number(value);
        if (segName === 'humanColor' && self.form) self.form.humanColor = value;
        segHost.querySelectorAll('button').forEach((b) => {
          const on = b.dataset.v === value;
          b.classList.toggle('on', on);
        });
      }
      return;
    }
  }

  function onRootChange(ev) {
    const el = ev.target;
    if (!el || !el.dataset) return;
    if (el.dataset.ref === 'idleRange') {
      const val = Math.max(IDLE_MIN_MIN, Math.min(IDLE_MAX_MIN, Math.round(Number(el.value) || IDLE_MIN_MIN)));
      setText(rootEl.querySelector('[data-ref="idleVal"]'), fmtIdleLabel(val));
      saveIdleTimeout(val);
      return;
    }
    if (el.dataset.ref === 'previewRange') {
      const steps = Math.max(5, Math.min(15, Math.round(Number(el.value) || 10)));
      setText(rootEl.querySelector('[data-ref="previewVal"]'), String(steps));
      if (settings) settings.setPreviewSteps(steps);
      else setPreviewSteps(steps);
      return;
    }
    if (el.dataset.ref === 'modelSelect') {
      // 标准模型下拉变化 → 重算 [保存模型] 可用态（BUG-120：旧实现无此分支，按钮恒灰置）
      renderModel();
      return;
    }
    if (el.dataset.ref === 'updRelease') {
      self.updates.kataTag = el.value || null;
      self.updates.kataAsset = pickKataAsset(
        (self.updates.releases && self.updates.releases.releases) || [],
        self.updates.kataTag,
      );
      renderUpdates();
      return;
    }
    if (el.dataset.ref === 'updAsset') {
      self.updates.kataAsset = el.value || null;
      renderUpdates();
      return;
    }
    if (el.dataset.ref === 'updStdModel') {
      self.updates.stdModel = el.value || '';
      renderUpdates();
      return;
    }
    if (el.dataset.cfg) {
      if (el.dataset.cfg === 'deepMaxVisits' || el.dataset.cfg === 'standardMaxVisits') {
        const { errs } = validateConfigForm(readFormFromDom());
        renderFormErrors(errs);
      }
      renderDirty();
    }
  }

  function onRootInput(ev) {
    const el = ev.target;
    if (!el || !el.dataset) return;
    if (el.dataset.ref === 'idleRange') {
      const val = Math.max(IDLE_MIN_MIN, Math.min(IDLE_MAX_MIN, Math.round(Number(el.value) || IDLE_MIN_MIN)));
      // 幂等写入：拖动中每个 input 事件都写 textContent 会无谓替换文本节点（同值也替换）
      setText(rootEl.querySelector('[data-ref="idleVal"]'), fmtIdleLabel(val));
    } else if (el.dataset.ref === 'adaptiveRange') {
      const val = Math.max(1, Math.min(12, Math.round(Number(el.value) || 5)));
      setText(rootEl.querySelector('[data-ref="adaptiveVal"]'), rankShort(val));
    } else if (el.dataset.ref === 'previewRange') {
      const val = Math.max(5, Math.min(15, Math.round(Number(el.value) || 10)));
      setText(rootEl.querySelector('[data-ref="previewVal"]'), String(val));
    } else if (el.dataset.cfg) {
      // 数字输入键入中：即时刷新引擎级脏提示
      renderDirty();
    }
  }

  /* ---------------- 订阅状态树 ---------------- */

  function subscribe() {
    if (!store) return;
    const unsub = store.subscribe((state, message) => {
      if (!message) return;
      if (message.type === 'engine.status') {
        const d = message.data || {};
        setEngineState(d.state || null, d.progress === undefined ? null : d.progress);
        if (typeof d.humanModelAvailable === 'boolean') self.engine.humanModelAvailable = d.humanModelAvailable;
        setEngineReason(d.reason, d.detail);
        renderEngine();
        renderScopeCopy();
      } else if (message.type === 'admin.config') {
        // 后端参数/默认模型已变更（本端或他端 PUT）→ REST 刷新（权威值覆盖表单）
        refreshAll();
      } else if (message.type === 'admin.task') {
        onAdminTask(message.data);
      }
    });
    self.unsubs.push(unsub);
  }

  /* ---------------- 骨架 ---------------- */

  function skeleton() {
    const uiAccent = theme ? theme.getAccent() : ls.get(LS_KEYS.accent, 'dai');
    const uiMode = theme ? theme.getMode() : ls.get(LS_KEYS.theme, 'light');
    const uiMute = settings ? settings.isMuted() : Boolean(ls.get(LS_KEYS.muted, false));
    const uiStone = settings ? settings.stoneMotion() : stoneMotionEnabled();
    const uiDecor = settings ? settings.decor() : decorEnabled();
    const uiMatch = settings ? settings.showAiMatch() : showAiMatchEnabled();
    const previewSteps = settings ? settings.previewSteps() : getPreviewSteps();
    const idleSec = Number((self.cfg && self.cfg.engine && self.cfg.engine.idle_timeout_s) || 0);
    const idleMin = snapIdleMin(idleSec);

    return `
<div class="admin-grid">
  <!-- ============ 引擎与模型卡 ============ -->
  <section class="card admin-header" data-card="engine">
    <h3>${icn('i-engine')}引擎与模型</h3>
    <div data-ref="engRegion">
      <div class="eng-status">
        <div class="eng-ico" data-ref="engIco" style="color:var(--eng-init)">${icn('i-engine', 34)}</div>
        <div class="eng-state"><span data-ref="engLabel">连接中</span><small data-ref="engSub">等待引擎状态…</small></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;align-items:center">
        <div class="checkline" style="gap:10px">
          ${switchHTML('resident', false, '引擎常驻')}<span data-tip="引擎常驻：不因空闲超时自动释放">常驻</span>
        </div>
        <!-- 说明文案随开关联动（renderEngine 按 residentNoteText 刷新；初始＝默认配置 resident=false 文案） -->
        <span class="muted" style="font-size:12px" data-ref="residentNote">${residentNoteText(false)}</span>
      </div>
      <div class="field" style="margin-top:10px">
        <label for="idle-range">空闲超时释放时间</label>
        <div class="form-row">
          <input type="range" class="range" id="idle-range" data-ref="idleRange" min="${IDLE_MIN_MIN}" max="${IDLE_MAX_MIN}" step="${IDLE_STEP_MIN}" value="${idleMin}" aria-label="空闲超时（分钟）">
          <span class="range-val num" data-ref="idleVal">${fmtIdleLabel(idleMin)}</span>
        </div>
        <div class="hint" data-ref="idleNote"></div>
      </div>
      <div data-ref="engOps">${engineOpsHTML()}</div>
      <div style="font-size:12px;color:var(--text-3);margin-top:8px">停止 / 重启将在引擎空闲时执行，完成后推送结果通知</div>
      <div data-ref="engQueue"></div>
    </div>
    <div class="divider"></div>
    <div data-ref="modelRegion">
      <div class="field" style="margin-bottom:10px">
        <label for="model-select">默认标准模型</label>
        <select class="select" id="model-select" data-ref="modelSelect" aria-label="默认标准模型">
          <option value="">— 加载中… —</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px" data-ref="modelHuman"></div>
      <button type="button" class="btn btn-primary btn-sm" data-act="model-save" data-ref="modelSave" style="display:flex;justify-content:center;align-items:center;" disabled>保存默认标准模型</button>
      <div style="font-size:12px;color:var(--text-3);margin-top:8px" data-ref="modelSaveHint">${engineChangeCopy(self.engine.state).modelSaveHint}</div>
    </div>
  </section>

  <!-- ============ 参数卡 ============ -->
  <section class="card admin-header" data-card="params">
    <h3>${icn('i-params')}参数配置</h3>

    <div class="param-group param-group--engine">
      <h4>引擎级 <span class="muted" style="font-weight:400;font-size:12px" data-ref="engineKeyScope">${engineChangeCopy(self.engine.state).engineKeyScope}</span></h4>
      <div class="create-grid">
        <div class="field">
          <label for="cfg-num-threads">numAnalysisThreads</label>
          <input class="input" id="cfg-num-threads" data-cfg="numAnalysisThreads" type="number" min="1" step="1">
          <div class="err" style="display:none" role="alert" data-err="numAnalysisThreads"></div>
        </div>
        <div class="field">
          <label for="cfg-num-threads-per">numSearchThreadsPerAnalysisThread</label>
          <input class="input" id="cfg-num-threads-per" data-cfg="numSearchThreadsPerAnalysisThread" type="number" min="1" step="1">
          <div class="err" style="display:none" role="alert" data-err="numSearchThreadsPerAnalysisThread"></div>
        </div>
      </div>
      <div class="dirty-note" data-ref="dirtyEngine" hidden>${icn('i-info', 12)}<span data-ref="dirtyEngineNote">${engineChangeCopy(self.engine.state).dirtyNote}</span></div>
      <div class="warn-tag" style="display:flex;align-items:center;gap:4px">${icn('i-warn', 12)}<span data-ref="engineKeyWarn">${engineChangeCopy(self.engine.state).warnTag}</span></div>
    </div>

    <div class="param-group">
      <h4>应用级 <span class="muted" style="font-weight:400;font-size:12px">（标准分析精度 / 深度分析精度，deep &gt; standard）</span></h4>
      <div class="create-grid">
        <div class="field">
          <label for="cfg-std-visits">standard maxVisits</label>
          <input class="input" id="cfg-std-visits" data-cfg="standardMaxVisits" type="number" min="1" step="1">
          <div class="err" style="display:none" role="alert" data-err="standardMaxVisits"></div>
        </div>
        <div class="field">
          <label for="cfg-deep-visits">deep maxVisits</label>
          <input class="input" id="cfg-deep-visits" data-cfg="deepMaxVisits" type="number" min="1" step="1">
          <div class="err" style="display:none" role="alert" data-err="deepMaxVisits"></div>
        </div>
      </div>
    </div>

    <div class="param-group">
      <h4>对弈级</h4>
      <div class="create-grid">
        <div class="field">
          <label for="cfg-adaptive">自适应初始水平</label>
          <div class="form-row">
            <input type="range" class="range" id="cfg-adaptive" data-ref="adaptiveRange" data-cfg="adaptiveLevel" min="1" max="12" step="1" aria-label="自适应初始水平（12 档）">
            <span class="range-val num" data-ref="adaptiveVal">5K</span>
          </div>
          <div class="hint">12 档（20K → 9D）</div>
        </div>
        <div class="field">
          <label for="cfg-max-undo">最大悔棋数（仅人机模式）</label>
          <input class="input" id="cfg-max-undo" data-cfg="maxUndo" type="number" min="0" step="1">
          <div class="err" style="display:none" role="alert" data-err="maxUndo"></div>
        </div>
        <div class="field">
          <label id="lbl-default-board">默认棋盘</label>
          <div class="segctl" role="group" aria-labelledby="lbl-default-board" data-seg="boardSize">${segButtons(BOARD_OPTIONS.map((b) => ({ value: String(b), label: `${b} 路` })), '19')}</div>
        </div>
        <div class="field">
          <label id="lbl-default-rule">默认规则 / 贴目</label>
          <div class="form-row">
            <select class="select" style="flex:1" data-cfg="rules" aria-label="默认规则">${RULE_OPTIONS.map((r) => `<option value="${r.value}">${r.label}</option>`).join('')}</select>
            <input class="input" style="width:76px" data-cfg="komi" type="number" min="0" step="0.5" aria-label="默认贴目">
          </div>
          <div class="err" style="display:none" role="alert" data-err="komi"></div>
        </div>
        <div class="field">
          <label id="lbl-default-color">默认执色</label>
          <div class="segctl" role="group" aria-labelledby="lbl-default-color" data-seg="humanColor">${segButtons(COLOR_OPTIONS, 'B')}</div>
        </div>
      </div>
      <div class="warn-tag" style="display:flex;align-items:center;gap:4px">${icn('i-info', 12)}应用级 / 对弈级为热更新保存后即时生效</div>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:6px">
      <button type="button" class="btn btn-secondary" data-act="cfg-reset" data-ref="cfgReset">重置</button>
      <button type="button" class="btn btn-primary" data-act="cfg-save" data-ref="cfgSave">保存更改</button>
    </div>
  </section>

  <!-- ============ UI 设置卡 ============ -->
  <section class="card admin-header" data-card="ui">
    <h3>${icn('i-sun')}UI 设置</h3>
    <div class="create-grid">
      <div class="field">
        <label id="lbl-ui-accent">主题色</label>
        <div class="segctl" role="group" aria-labelledby="lbl-ui-accent" data-seg="uiAccent">${segButtons(ACCENT_OPTIONS, uiAccent)}</div>
      </div>
      <div class="field">
        <label id="lbl-ui-mode">明暗</label>
        <div class="segctl" role="group" aria-labelledby="lbl-ui-mode" data-seg="uiMode">${segButtons(THEME_MODE_OPTIONS, uiMode)}</div>
      </div>
      <div class="field">
        <label id="lbl-ui-ai-match">显示当前 AI 匹配档位</label>
        <div class="checkline">${switchHTML('uiMatch', uiMatch, '显示当前 AI 匹配档位')}<span data-tip="开='AI 匹配 · 5K'；关='AI 自适应'">开启</span></div>
        <div class="hint">开：对弈信息行显示「AI 匹配 · 5K」，关：显示「AI 自适应」</div>
      </div>
      <div class="field">
        <label>声音</label>
        <div class="checkline">${switchHTML('uiMute', uiMute, '静音')}<span data-tip="静音：关闭全部提示音">静音</span></div>
      </div>
      <div class="field">
        <label>装饰纹理</label>
        <div class="checkline">${switchHTML('uiDecor', uiDecor, '装饰纹理')}<span data-tip="页面背景：山峦 / 墨迹纹理（background.svg）">山峦 / 墨迹纹理</span></div>
      </div>
      <div class="field">
        <label>动效</label>
        <div class="checkline">${switchHTML('uiStone', uiStone, '落子动效')}<span data-tip="落子动画：云子人手斜放效果">落子动效</span></div>
      </div>
      <div class="field">
        <label for="preview-range">变化图预览步数</label>
        <div class="form-row">
          <input type="range" class="range" id="preview-range" data-ref="previewRange" min="5" max="15" step="1" value="${previewSteps}" aria-label="变化图预览步数（5–15）">
          <span class="range-val num" data-ref="previewVal">${previewSteps}</span>
        </div>
        <div class="hint">5–15 步；预览逐步动画使用</div>
      </div>
    </div>
    <div style="font-size:12px;color:var(--text-3)">UI 设置随浏览器本地数据持久化，不随对局结束删除</div>
  </section>

  <!-- ============ 版本与资源卡 ============ -->
  <section class="card admin-header" data-card="updates">
    <h3>${icn('i-system')}版本与资源</h3>
    <div data-ref="updRegion">
      <div class="kv" style="grid-template-columns:1fr 1fr">
        <div class="item"><div class="label">应用版本</div><div class="value num" style="font-size:14px"><span data-ref="updAppVersion">—</span><span class="upd-dot" data-ref="updAppDot" data-tip="检测到新版本" role="img" aria-label="检测到新版本" hidden></span></div></div>
        <div class="item"><div class="label">部署方式</div><div class="value" style="font-size:14px" data-ref="updMode">—</div></div>
        <div class="item"><div class="label">KataGo</div><div class="value num" style="font-size:14px"><span data-ref="updEngineVersion">—</span><span class="upd-dot" data-ref="updEngineDot" data-tip="检测到新版本" role="img" aria-label="检测到新版本" hidden></span></div></div>
        <div class="item"><div class="label">更新源</div><div class="value ellipsis" style="font-size:14px"><a data-ref="updRepoLink" href="#" target="_blank" rel="noopener">—</a></div></div>
      </div>

      <div class="warn-tag upd-note" data-ref="updDockerNote" hidden>
        ${icn('i-warn', 12)}<span data-ref="updDockerText">容器部署不支持页内自更新，请拉取新镜像后重建</span>
      </div>

      <div style="display:flex;gap:10px;margin-top:12px;align-items:center;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary btn-sm" data-act="upd-check">${icn('i-restart', 15)}检查更新</button>
        <span class="muted" style="font-size:12px;min-width:0" data-ref="updCheckText">尚未检查更新</span>
      </div>
      <div data-ref="updCheckDetail" hidden style="margin-top:8px">
        <div class="toast toast-info" role="status" style="justify-content:flex-start;margin-bottom:8px">
          <span class="toast-icon">${icn('i-info', 16)}</span>
          <span class="toast-text" data-ref="updLatest">—</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-primary btn-sm" data-act="upd-apply" disabled>${icn('i-download', 15)}立即更新并重启</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="upd-notes" hidden>${icn('i-info', 15)}更新说明</button>
        </div>
      </div>

      <div data-ref="updProgress" hidden style="margin-top:10px" aria-live="polite">
        <div class="mem-bar"><i style="width:0" data-ref="updProgressBar"></i></div>
        <div class="muted" style="font-size:12px;margin-top:4px" data-ref="updProgressText"></div>
      </div>

      <div class="divider"></div>
      <h3>${icn('i-engine')}KataGo 引擎 <span class="muted" style="font-weight:400;font-size:12px" data-ref="updKataHint">—</span></h3>
      <div class="field">
        <label for="upd-release">引擎版本</label>
        <select class="select" id="upd-release" data-ref="updRelease" aria-label="KataGo 官方版本">
          <option value="">— 加载中… —</option>
        </select>
      </div>
      <div class="field">
        <label for="upd-asset">构建 / 后端</label>
        <select class="select" id="upd-asset" data-ref="updAsset" aria-label="KataGo 构建">
          <option value="">— 加载中… —</option>
        </select>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-act="kata-download" style="margin-top:8px" disabled>${icn('i-download', 15)}下载并安装 KataGo</button>

      <div class="divider"></div>
      <h3>${icn('i-model')}训练模型 <span class="muted" style="font-weight:400;font-size:12px"><span data-ref="updModelHint"></span><a href="https://katagotraining.org/networks/" target="_blank" rel="noopener">katagotraining.org</a></span></h3>
      <div class="field">
        <label for="upd-model">标准模型</label>
        <select class="select" id="upd-model" data-ref="updStdModel" aria-label="官方标准模型">
          <option value="">— 加载中… —</option>
        </select>
        <div class="hint" data-ref="updModelCompat"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-secondary btn-sm" data-act="model-download" disabled>${icn('i-download', 15)}下载标准模型</button>
        <button type="button" class="btn btn-secondary btn-sm" data-act="model-download-human" disabled>${icn('i-model', 15)}下载人类模型</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">
        人类模型：<span class="num" data-ref="updHumanModelName">b18c384nbt-humanv0.bin.gz</span>（KataGo v1.15.0 官方 Release）
      </div>
      <div class="warn-tag upd-note" style="margin-top:8px">
        <span>${icn('i-warn', 12)} 模型下载完成后需在「引擎与模型」卡设为默认并重启引擎。</span>
      </div>
    </div>
  </section>
</div>`;
  }

  /* ---------------- 生命周期 ---------------- */

  /**
   * 双列 masonry：
   *   左列：引擎与模型 → 版本与资源；
   *   右列：参数配置 → UI 设置。
   * ≤767 经 `.admin-col{display:contents}` + 卡片内联 `order` 还原单列阅读序：
   *   引擎与模型 → 参数配置 → UI 设置 → 版本与资源。
   */
  function masonryLayout() {
    const grid = rootEl.querySelector('.admin-grid');
    if (!grid) return;
    const cardOf = (name) => grid.querySelector(`[data-card="${name}"]`);
    const engine = cardOf('engine');
    const params = cardOf('params');
    const ui = cardOf('ui');
    const updates = cardOf('updates');
    if (!engine || !params || !ui || !updates) return;
    const left = [engine, updates];
    const right = [params, ui];
    const order = [engine, params, ui, updates];
    const col1 = document.createElement('div');
    const col2 = document.createElement('div');
    col1.className = 'admin-col';
    col2.className = 'admin-col';
    // 单列阅读序（移动端 display:contents 后以 order 排列）
    order.forEach((card, index) => {
      card.style.order = String(index + 1);
    });
    left.forEach((card) => col1.appendChild(card));
    right.forEach((card) => col2.appendChild(card));
    grid.appendChild(col1);
    grid.appendChild(col2);
  }

  function bind() {
    rootEl.addEventListener('click', onRootClick);
    rootEl.addEventListener('change', onRootChange);
    rootEl.addEventListener('input', onRootInput);
    subscribe();
    applyDecorBody();
    refreshAll();
    // 打开管理页检查一次更新（后端 10 分钟缓存；手动按钮可强制刷新）
    loadUpdates({ check: true });
  }

  return {
    render() {
      rootEl.className = 'layout';
      rootEl.innerHTML = skeleton();
      masonryLayout();
      bind();
      renderDynamic();
      rescanTips();
    },
    destroy() {
      self.destroyed = true;
      clearOpTimer();
      for (const t of self.timers.splice(0)) clearTimeout(t);
      for (const off of self.unsubs.splice(0)) {
        try {
          off();
        } catch { /* 忽略退订异常 */ }
      }
      rootEl.removeEventListener('click', onRootClick);
      rootEl.removeEventListener('change', onRootChange);
      rootEl.removeEventListener('input', onRootInput);
      if (rootEl) rootEl.innerHTML = '';
    },
  };
}

export default createView;

