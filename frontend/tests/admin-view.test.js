/**
 * tGo · admin-view.js 纯函数层无头单测（T6.10，node --test）
 * 用例 ID: FE-ADM-*
 * 覆盖（TASK.md T6.10 验收·纯逻辑）：引擎状态元数据/操作可用性、常驻说明文案、空闲
 * 超时滑杆换算（30 分钟步进）、模型载荷派生、参数卡表单（configToForm/内联校验/脏字段
 * 载荷含重启判定）、admin.task Toast 派生、系统卡视图模型（GPU 不支持降级）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ENGINE_REASON } from '../static/js/core/state.js';

import {
  clampPct,
  engineCardMeta,
  manualRestartCopy,
  engineOps,
  engineOpReason,
  modelSaveCopy,
  engineChangeCopy,
  residentNoteText,
  idleSliderDisabled,
  standardModels,
  humanModelInfo,
  currentModel,
  modelSaveEnabled,
  rankCodeOfLevel,
  levelOfRank,
  rankShort,
  snapIdleMin,
  idleOnGrid,
  idleSecondsOfMin,
  fmtIdleLabel,
  configToForm,
  validateConfigForm,
  buildConfigPayload,
  configDirty,
  taskResultToast,
  versionLabel,
  versionTuple,
  isNewerVersion,
  fmtBytes,
  taskProgressVM,
  updateCheckVM,
  releaseNotesHtml,
  kataReleaseOptions,
  kataAssetOptions,
  kataAssetLabel,
  pickKataAsset,
  modelOptionLabel,
  DEPLOYMENT_MODE_LABEL,
  UPDATE_TASKS,
  IDLE_MIN_MIN,
  IDLE_MAX_MIN,
  IDLE_STEP_MIN,
} from '../static/js/views/admin-view.js';

/** 管理页基线配置（GET /admin/config model_dump 形状）。 */
function makeConfig(overrides = {}) {
  const cfg = {
    engine: {
      standard_max_visits: 100,
      deep_max_visits: 800,
      num_analysis_threads: 2,
      num_search_threads_per_analysis_thread: 16,
      resident: false,
      idle_timeout_s: 1800,
    },
    play: {
      adaptive_initial_level: 'rank_5k',
      max_undo: 5,
      default_board_size: 19,
      default_rules: 'chinese',
      default_komi: 7.5,
      default_human_color: 'B',
    },
  };
  if (overrides.engine) cfg.engine = { ...cfg.engine, ...overrides.engine };
  if (overrides.play) cfg.play = { ...cfg.play, ...overrides.play };
  return cfg;
}

/* ---------- 引擎状态 / 操作 ---------- */

test('FE-ADM-01 clampPct 钳制 0..100', () => {
  assert.equal(clampPct(50), 50);
  assert.equal(clampPct(-3), 0);
  assert.equal(clampPct(150), 100);
  assert.equal(clampPct('abc'), 0);
  assert.equal(clampPct(12.6), 13);
});

test('FE-ADM-02 引擎状态卡片元数据（含 INIT 调优进度）', () => {
  assert.deepEqual(engineCardMeta(null), { label: '连接中', sub: '等待引擎状态…', tone: 'init' });
  const stopped = engineCardMeta('STOPPED');
  assert.equal(stopped.label, '未启动');
  assert.equal(stopped.tone, 'off');
  assert.match(stopped.sub, /进程未运行/);
  const init = engineCardMeta('INIT');
  assert.equal(init.label, '启动 / 加载中');
  assert.equal(init.tone, 'init');
  const tune = engineCardMeta('INIT', 42);
  assert.ok(tune.sub.includes('GPU 调优 42%'));
  assert.equal(engineCardMeta('IDLE').tone, 'idle');
  assert.equal(engineCardMeta('ANALYZING').label, '分析中');
  assert.equal(engineCardMeta('DEAD').tone, 'dead');
  assert.equal(engineCardMeta('FATAL').tone, 'fatal');
  // 未知状态兜底
  assert.equal(engineCardMeta('WEIRD').tone, 'init');
});

test('FE-ADM-02b 引擎卡片：FATAL + 标准模型缺失 → 指向模型与恢复路径（BUG-090/097 事实对齐）', () => {
  const meta = engineCardMeta('FATAL', null, ENGINE_REASON.standardModelMissing);
  assert.equal(meta.label, '引擎不可用');
  assert.match(meta.sub, /标准模型缺失/);
  assert.match(meta.sub, /手动重启/);
  assert.equal(/崩溃/.test(meta.sub), false);
  assert.equal(meta.tone, 'fatal');
  // 无 reason（真实 FATAL＝连续崩溃）→ 沿用表内文案；其它原因不误改
  assert.match(engineCardMeta('FATAL').sub, /连续崩溃已停止/);
  assert.match(engineCardMeta('FATAL', null, 'other').sub, /连续崩溃已停止/);
});

test('FE-ADM-02c 引擎卡片：可执行文件缺失 / 启动失败归因（BUG-097）', () => {
  const noExec = engineCardMeta('FATAL', null, ENGINE_REASON.engineExecutableMissing);
  assert.equal(noExec.label, '引擎不可用');
  assert.match(noExec.sub, /可执行文件缺失/);
  assert.equal(/崩溃/.test(noExec.sub), false);

  const failed = engineCardMeta(
    'FATAL',
    null,
    ENGINE_REASON.startupFailed,
    'Uncaught exception: No OpenCL devices were found on your system.'
  );
  assert.equal(failed.label, '引擎启动失败');
  assert.match(failed.sub, /No OpenCL devices/);

  // DEAD（自动重启中）附启动失败原因；无 detail → 无括号
  const dead = engineCardMeta('DEAD', null, ENGINE_REASON.startupFailed, '驱动异常');
  assert.match(dead.sub, /DEAD · 自动重启中（驱动异常）/);
  assert.match(engineCardMeta('DEAD', null, ENGINE_REASON.startupFailed).sub, /自动重启中$/);

  // 超长 detail 截断（避免卡片被 stderr 整行撑爆）
  const long = engineCardMeta('FATAL', null, ENGINE_REASON.startupFailed, 'x'.repeat(300));
  assert.ok(long.sub.length <= 121, long.sub.length);
  assert.match(long.sub, /…$/);
});

test('FE-ADM-14 手动重启确认文案：按归因派生（文件缺失→重新检测；启动失败/崩溃→手动重启）', () => {
  const model = manualRestartCopy(ENGINE_REASON.standardModelMissing);
  assert.equal(model.title, '重新检测并启动引擎？');
  assert.match(model.message, /标准模型缺失/);
  const exe = manualRestartCopy(ENGINE_REASON.engineExecutableMissing);
  assert.match(exe.message, /可执行文件缺失/);
  const startup = manualRestartCopy(ENGINE_REASON.startupFailed, 'OpenCL 驱动异常');
  assert.equal(startup.title, '手动重启引擎？');
  assert.match(startup.message, /OpenCL 驱动异常/);
  const generic = manualRestartCopy(null);
  assert.match(generic.message, /连续崩溃/);
});

test('FE-ADM-15 空闲超时滑杆禁用派生：常驻联动灰置禁用，关闭恢复', () => {
  // 常驻＝常驻语义（空闲超时无实际作用）→ 禁用（2026/09/18 人工反馈）
  assert.equal(idleSliderDisabled({ resident: true }), true);
  assert.equal(idleSliderDisabled({ resident: false }), false);
  // 保存 / 引擎操作在途同样禁用；缺省全 false → 可用
  assert.equal(idleSliderDisabled({ saving: true }), true);
  assert.equal(idleSliderDisabled({ busy: true }), true);
  assert.equal(idleSliderDisabled({}), false);
  assert.equal(idleSliderDisabled(), false);
  // 组合：常驻优先（任一条件成立即禁用）
  assert.equal(idleSliderDisabled({ saving: true, busy: true, resident: true }), true);
});

test('FE-ADM-17 引擎常驻说明文案：开＝保持常驻运行 / 关＝按需自动拉起且空闲超时自动释放（2026/10/10 口径同步）', () => {
  assert.equal(residentNoteText(true), '引擎保持常驻运行');
  assert.equal(residentNoteText(false), '引擎按需自动拉起，空闲超时自动释放');
  // 非布尔真值按 JS 真值判定（配置从 REST 回读时可能为 0/undefined）
  assert.equal(residentNoteText(undefined), '引擎按需自动拉起，空闲超时自动释放');
  assert.equal(residentNoteText(1), '引擎保持常驻运行');
});

test('FE-ADM-03 引擎操作可用性（FSM 语义防非法指令）', () => {
  assert.deepEqual(engineOps(null), { start: true, stop: false, restart: false, manualRestart: false });
  assert.deepEqual(engineOps('STOPPED'), { start: true, stop: false, restart: false, manualRestart: false });
  assert.deepEqual(engineOps('INIT'), { start: true, stop: false, restart: false, manualRestart: false });
  assert.deepEqual(engineOps('IDLE'), { start: false, stop: true, restart: true, manualRestart: false });
  assert.deepEqual(engineOps('ANALYZING'), { start: false, stop: true, restart: true, manualRestart: false });
  assert.deepEqual(engineOps('DEAD'), { start: false, stop: false, restart: false, manualRestart: false });
  assert.deepEqual(engineOps('FATAL'), { start: false, stop: false, restart: false, manualRestart: true });
  // 禁用原因
  assert.equal(engineOpReason('IDLE', 'start'), '引擎已运行');
  assert.equal(engineOpReason('DEAD', 'start'), '引擎崩溃自动重启中');
  assert.equal(engineOpReason('FATAL', 'stop'), '引擎未就绪');
  assert.equal(engineOpReason('IDLE', 'stop'), null);
  assert.equal(engineOpReason('IDLE', 'restart'), null);
  assert.equal(engineOpReason('INIT', 'restart'), '引擎未运行');
  assert.equal(engineOpReason('STOPPED', 'restart'), '引擎未运行');
  assert.equal(engineOpReason('STOPPED', 'start'), null);
  assert.equal(engineOpReason('STOPPED', 'stop'), '引擎未启动');
  assert.equal(engineOpReason('FATAL', 'manualRestart'), null);
  // 非常驻（resident=false）：[停止] 恒禁用——引擎由系统按需自动拉起/释放
  // （2026/09/13 人工决策，ISSUE-055 关闭口径；[重启] 不受限，仍可用于重载引擎配置）
  assert.deepEqual(engineOps('IDLE', { resident: false }), { start: false, stop: false, restart: true, manualRestart: false });
  assert.deepEqual(engineOps('ANALYZING', { resident: false }), { start: false, stop: false, restart: true, manualRestart: false });
  assert.equal(engineOps('IDLE').stop, true, '缺省 resident=true 保持既有语义');
  assert.equal(engineOpReason('IDLE', 'stop', { resident: false }), '非常驻模式：引擎由系统按需自动拉起/释放');
  assert.equal(engineOpReason('FATAL', 'stop', { resident: false }), '非常驻模式：引擎由系统按需自动拉起/释放');
});

test('FE-ADM-47 [保存模型] 确认文案随引擎态分叉（BUG-138：未运行不得谎称「保存并重启」）', () => {
  // 引擎在运行（IDLE/ANALYZING）或拉起中（INIT）→ 切换将安全重启引擎
  for (const st of ['IDLE', 'ANALYZING', 'INIT']) {
    const copy = modelSaveCopy(st);
    assert.equal(copy.okText, '保存并重启', `${st}：应提示保存并重启`);
    assert.match(copy.message, /安全重启引擎/);
  }
  // 未启动 / 崩溃恢复中 / 致命 / 状态未知 → 仅「下次启动生效」（后端不排队、无回执）
  for (const st of ['STOPPED', null, undefined, 'DEAD', 'FATAL']) {
    const copy = modelSaveCopy(st);
    assert.equal(copy.okText, '保存', `${st}：不得出现「保存并重启」`);
    assert.match(copy.message, /引擎当前未运行，新模型将在引擎下次启动时生效/);
    assert.doesNotMatch(copy.message, /安全重启/);
  }
  assert.equal(modelSaveCopy('IDLE').title, '保存默认模型？');
});

test('FE-ADM-48 引擎级变更「生效口径」文案随状态（BUG-139：未运行/致命不得谎称重启）', () => {
  // 运行中 / 拉起中 → 重启口径（生效口径三处一致；engineKeyScope 为分组说明，见下）
  for (const st of ['IDLE', 'ANALYZING', 'INIT']) {
    const c = engineChangeCopy(st);
    assert.equal(c.restarts, true, `${st}：应走重启口径`);
    assert.match(c.modelSaveHint, /安全重启/);
    assert.match(c.dirtyNote, /安全重启/);
    assert.match(c.warnTag, /安全重启/);
  }
  // 未启动 / 崩溃自愈中 / 致命 → 只落配置、下次启动生效（生效口径三处不得出现「安全重启」）
  for (const st of ['STOPPED', 'DEAD', 'FATAL']) {
    const c = engineChangeCopy(st);
    assert.equal(c.restarts, false, `${st}：不得走重启口径`);
    assert.match(c.modelSaveHint, /下次启动时生效/);
    assert.doesNotMatch(c.dirtyNote, /安全重启/);
    assert.doesNotMatch(c.warnTag, /安全重启/);
  }
  // engineKeyScope＝「引擎级」分组说明（两个参数各自的含义，2026/10/10 人工口径）：
  // 与引擎态无关、不承载生效口径（单一口径仍由 modelSaveHint/dirtyNote/warnTag 承载）
  for (const st of [null, undefined, '', 'IDLE', 'ANALYZING', 'INIT', 'STOPPED', 'DEAD', 'FATAL']) {
    const c = engineChangeCopy(st);
    assert.equal(c.engineKeyScope, '（并行分析的局面数 / 每局面分析使用的线程数）', `${st}：分组说明应恒定`);
    assert.doesNotMatch(c.engineKeyScope, /重启/);
  }
  // 状态未达（首屏尚未拉到 engine.status）→ 中性表述（两种情形都成立，不猜）
  for (const st of [null, undefined, '']) {
    const c = engineChangeCopy(st);
    assert.equal(c.restarts, false);
    assert.match(c.modelSaveHint, /运行中时安全重启/);
    assert.match(c.modelSaveHint, /下次启动生效/);
    assert.match(c.warnTag, /下次启动时生效/);
  }
  // 与 [保存模型] 确认弹窗同源（restarts 单一判定，不重复分叉）
  assert.equal(engineChangeCopy('IDLE').restarts, true);
  assert.equal(modelSaveCopy('IDLE').okText, '保存并重启');
  assert.equal(engineChangeCopy('FATAL').restarts, false);
  assert.equal(modelSaveCopy('FATAL').okText, '保存');
});

test('FE-ADM-04 自适应档位 ↔ rank code / 短标', () => {
  assert.equal(rankCodeOfLevel(5), 'rank_5k');
  assert.equal(rankCodeOfLevel(8), 'rank_1d');
  assert.equal(levelOfRank('rank_1d'), 8);
  assert.equal(levelOfRank('rank_bogus'), null);
  assert.equal(rankShort(5), '5K');
  assert.equal(rankShort(8), '1D');
  assert.equal(rankShort(0), '—');
  assert.equal(rankShort(13), '—');
});

/* ---------- 空闲超时滑杆 ---------- */

test('FE-ADM-13 空闲超时文案（分钟 → `X.Y 小时`，数字与「小时」间**带空格**；2026/09/15 人工确认）', () => {
  assert.equal(fmtIdleLabel(30), '0.5 小时');
  assert.equal(fmtIdleLabel(60), '1.0 小时');
  assert.equal(fmtIdleLabel(90), '1.5 小时');
  assert.equal(fmtIdleLabel(120), '2.0 小时');
  assert.equal(fmtIdleLabel(300), '5.0 小时');
  assert.equal(fmtIdleLabel(0), '0.0 小时');
  assert.equal(fmtIdleLabel(-5), '0.0 小时');
  assert.equal(fmtIdleLabel('abc'), '0.0 小时');
  // 非网格值（附注：当前配置提示）同样按小时一位小数展示
  assert.equal(fmtIdleLabel(5), '0.1 小时');
});

test('FE-ADM-05 空闲超时滑杆换算（30 分钟步进 / 0.5–5h）', () => {
  assert.equal(IDLE_MIN_MIN, 30);
  assert.equal(IDLE_MAX_MIN, 300);
  assert.equal(IDLE_STEP_MIN, 30);
  assert.equal(snapIdleMin(1800), 30); // 默认 30 分钟
  assert.equal(snapIdleMin(300), 30); // 老默认 5 分钟 → 吸附量程下限（提示不擅改）
  assert.equal(snapIdleMin(7200), 120);
  assert.equal(snapIdleMin(0), 30); // 0（不自动释放）不在量程 → 量程下限
  assert.equal(idleOnGrid(1800), true);
  assert.equal(idleOnGrid(3600), true);
  assert.equal(idleOnGrid(300), false);
  assert.equal(idleOnGrid(0), false);
  assert.equal(idleSecondsOfMin(90), 5400);
});

/* ---------- 模型载荷 ---------- */

test('FE-ADM-06 模型载荷派生（标准列表 / 人类徽章 / 当前默认）', () => {
  const payload = {
    models: [
      { name: 'kata1-b18.bin.gz', human: false, default: true },
      { name: 'kata2-b28c.bin.gz', human: false, default: false },
      { name: 'b18-human.bin.gz', human: true, default: false },
    ],
    default: 'kata1-b18.bin.gz',
    humanModelAvailable: true,
  };
  assert.deepEqual(standardModels(payload).map((m) => m.name), ['kata1-b18.bin.gz', 'kata2-b28c.bin.gz']);
  assert.deepEqual(humanModelInfo(payload), { ok: true, name: 'b18-human.bin.gz' });
  assert.equal(currentModel(payload), 'kata1-b18.bin.gz');
  // 人类模型缺失：humanModelAvailable=false 且无 human 模型
  const noHuman = { models: [{ name: 'a.bin.gz', human: false }], default: 'a.bin.gz', humanModelAvailable: false };
  assert.deepEqual(humanModelInfo(noHuman), { ok: false, name: null });
  assert.deepEqual(standardModels(null), []);
});

test('FE-ADM-16 保存模型按钮可用性：切换标准模型即可用（BUG-120）', () => {
  const payload = {
    models: [
      { name: 'kata1-b18.bin.gz', human: false, default: true },
      { name: 'kata2-b28c.bin.gz', human: false, default: false },
      { name: 'b18-human.bin.gz', human: true, default: false },
    ],
    default: 'kata1-b18.bin.gz',
    humanModelAvailable: true,
  };
  // 未变化 / 未选 / 数据未就绪 / 任务在途 → 不可用
  assert.equal(modelSaveEnabled({ models: payload, selected: 'kata1-b18.bin.gz' }), false);
  assert.equal(modelSaveEnabled({ models: payload, selected: '' }), false);
  assert.equal(modelSaveEnabled({ models: null, selected: 'kata2-b28c.bin.gz' }), false);
  assert.equal(modelSaveEnabled({ models: payload, selected: 'kata2-b28c.bin.gz', saving: true }), false);
  assert.equal(modelSaveEnabled({ models: payload, selected: 'kata2-b28c.bin.gz', busy: true }), false);
  assert.equal(modelSaveEnabled(), false);
  // 人类模型不是下拉白名单项 → 不可保存为默认标准模型
  assert.equal(modelSaveEnabled({ models: payload, selected: 'b18-human.bin.gz' }), false);
  // 切换为另一标准模型 → 可用（旧实现无 change 监听，按钮恒灰置）
  assert.equal(modelSaveEnabled({ models: payload, selected: 'kata2-b28c.bin.gz' }), true);
  // 别名/不存在项 → 不可用
  assert.equal(modelSaveEnabled({ models: payload, selected: 'missing.bin.gz' }), false);
});

/* ---------- 参数卡表单 ---------- */

test('FE-ADM-07 configToForm 嵌套 → 扁平表单（含缺省兜底）', () => {
  const f = configToForm(makeConfig());
  assert.deepEqual(f, {
    numAnalysisThreads: 2,
    numSearchThreadsPerAnalysisThread: 16,
    standardMaxVisits: 100,
    deepMaxVisits: 800,
    adaptiveLevel: 5,
    maxUndo: 5,
    boardSize: 19,
    rules: 'chinese',
    komi: 7.5,
    humanColor: 'B',
  });
  const f2 = configToForm(makeConfig({ play: { default_board_size: 13, default_rules: 'japanese', default_human_color: 'W', adaptive_initial_level: 'rank_1d' } }));
  assert.equal(f2.boardSize, 13);
  assert.equal(f2.rules, 'japanese');
  assert.equal(f2.humanColor, 'W');
  assert.equal(f2.adaptiveLevel, 8);
  // null/缺省兜底
  const empty = configToForm(null);
  assert.equal(empty.standardMaxVisits, 100);
  assert.equal(empty.boardSize, 19);
  assert.equal(empty.adaptiveLevel, 5);
});

test('FE-ADM-08 validateConfigForm 内联校验（deep > standard 等）', () => {
  const ok = validateConfigForm(configToForm(makeConfig()));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errs, {});
  // deep ≤ standard
  const bad = validateConfigForm({ ...configToForm(makeConfig()), standardMaxVisits: 900, deepMaxVisits: 800 });
  assert.equal(bad.ok, false);
  assert.equal(bad.errs.deepMaxVisits, 'deep 必须大于 standard');
  // 负悔棋 / 0 线程
  const bad2 = validateConfigForm({ ...configToForm(makeConfig()), maxUndo: -1, numAnalysisThreads: 0 });
  assert.equal(bad2.errs.maxUndo, '需为 ≥ 0 的整数');
  assert.equal(bad2.errs.numAnalysisThreads, '需为 ≥ 1 的整数');
});

test('FE-ADM-09 buildConfigPayload 脏字段 → snake 载荷 + 重启判定', () => {
  const base = makeConfig();
  // 无变化
  const noop = buildConfigPayload(configToForm(base), base);
  assert.deepEqual(noop.payload, {});
  assert.equal(noop.restart, false);
  // 对弈级 + 应用级（不重启）
  const f = { ...configToForm(base), maxUndo: 7, deepMaxVisits: 1200, adaptiveLevel: 8 };
  const r1 = buildConfigPayload(f, base);
  assert.deepEqual(r1.payload, { max_undo: 7, deep_max_visits: 1200, adaptive_initial_level: 'rank_1d' });
  assert.equal(r1.restart, false);
  // 引擎级线程变更 → restart
  const f2 = { ...configToForm(base), numAnalysisThreads: 6 };
  const r2 = buildConfigPayload(f2, base);
  assert.deepEqual(r2.payload, { num_analysis_threads: 6 });
  assert.equal(r2.restart, true);
  assert.equal(configDirty(f, base), true);
  assert.equal(configDirty(configToForm(base), base), false);
});

test('FE-ADM-10 taskResultToast admin.task 回执（成功/失败/未知）', () => {
  assert.deepEqual(taskResultToast({ task: 'stop', status: 'done', message: '引擎停止完成' }), {
    level: 'success',
    text: '引擎停止完成',
    key: 'adm-task-stop',
  });
  assert.deepEqual(taskResultToast({ task: 'restart', status: 'done' }), { level: 'success', text: '引擎重启完成', key: 'adm-task-restart' });
  const fail = taskResultToast({ task: 'start', status: 'failed', code: 'ENGINE_FATAL', message: '引擎启动失败' });
  assert.equal(fail.level, 'error');
  assert.equal(fail.code, 'ENGINE_FATAL');
  assert.equal(fail.text, '引擎启动失败');
  assert.equal(taskResultToast({ task: 'restart', status: 'failed', code: 'ENGINE_DEAD' }).text.includes('ENGINE_DEAD'), true);
  assert.equal(taskResultToast(null), null);
});

/* ---------- 版本与资源卡 ---------- */

test('FE-ADM-49 versionLabel / fmtBytes / 部署方式文案', () => {
  assert.equal(versionLabel('1.2.3'), 'v1.2.3');
  assert.equal(versionLabel('v1.2.3'), 'v1.2.3');
  assert.equal(versionLabel(''), '—');
  assert.equal(versionLabel(null), '—');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2 * 1024 * 1024), '2.0 MB');
  assert.equal(fmtBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(DEPLOYMENT_MODE_LABEL.docker, 'Docker 容器');
  assert.deepEqual(UPDATE_TASKS, ['app_update', 'engine_download', 'model_download']);
});

test('FE-ADM-54 版本角标比较：仅服务器版本更高时提示', () => {
  assert.deepEqual(versionTuple('v1.18.2'), [1, 18, 2]);
  assert.deepEqual(versionTuple('1.18'), [1, 18, 0]);
  assert.deepEqual(versionTuple(''), []);
  assert.equal(isNewerVersion('v1.18.2', '1.18.1'), true);
  assert.equal(isNewerVersion('1.18.1', 'v1.18.1'), false);
  assert.equal(isNewerVersion('1.18', '1.18.0'), false);
  assert.equal(isNewerVersion('1.18.0', '1.18'), false);
  assert.equal(isNewerVersion('1.19.0-rc1', '1.18.2'), true);
  assert.equal(isNewerVersion('1.17.0', '1.18.1'), false);
  assert.equal(isNewerVersion(null, '1.18.1'), false);
  assert.equal(isNewerVersion('1.18.1', ''), false);
});

test('FE-ADM-50 taskProgressVM：运行/失败/空闲', () => {
  assert.deepEqual(taskProgressVM(null), { active: false, failed: false, percent: null, text: '' });
  const running = taskProgressVM({
    task: 'app_update',
    status: 'running',
    progress: 42,
    message: '下载更新包 4.2 MB / 10 MB',
  });
  assert.equal(running.active, true);
  assert.equal(running.percent, 42);
  assert.ok(running.text.includes('应用更新执行中'));
  assert.ok(running.text.includes('下载更新包'));
  const failed = taskProgressVM({ task: 'engine_download', status: 'failed', message: '网络不可用' });
  assert.equal(failed.active, false);
  assert.equal(failed.failed, true);
  assert.ok(failed.text.includes('KataGo 下载失败'));
});

test('FE-ADM-51 updateCheckVM：最新/可更新/容器不支持', () => {
  assert.equal(updateCheckVM(null).canUpdate, false);
  const latest = updateCheckVM({
    supported: true,
    updateAvailable: false,
    message: '当前已是最新版本',
    latest: { htmlUrl: 'https://github.com/yimuur/tGo/releases' },
  });
  assert.equal(latest.canUpdate, false);
  assert.equal(latest.text, '当前已是最新版本');
  const available = updateCheckVM({
    supported: true,
    updateAvailable: true,
    message: '发现新版本 v1.2.0',
    latest: {
      version: '1.2.0',
      htmlUrl: 'https://github.com/yimuur/tGo/releases/tag/v1.2.0',
      asset: { name: 'tGo-Setup.zip' },
    },
  });
  assert.equal(available.canUpdate, true);
  assert.equal(available.releaseUrl.includes('v1.2.0'), true);
  const docker = updateCheckVM({
    supported: false,
    message: '容器部署不支持页内自更新，请拉取新镜像后重建容器',
  });
  assert.equal(docker.tone, 'warn');
  assert.equal(docker.canUpdate, false);
});

test('FE-ADM-55 releaseNotesHtml：页内渲染更新说明（转义、无外链）', () => {
  assert.equal(releaseNotesHtml(''), '');
  assert.equal(releaseNotesHtml(null), '');
  const html = releaseNotesHtml('## 修复\n- 修复 **对局** 与 `undo`\n[仓库](https://github.com/x/y)');
  assert.ok(html.includes('<strong>修复</strong>'));
  assert.ok(html.includes('• 修复 <strong>对局</strong> 与 <code>undo</code>'));
  assert.equal(html.includes('<a '), false);
  assert.equal(html.includes('https://github.com/x/y'), false);
  assert.ok(releaseNotesHtml('<img src=x onerror=alert(1)>').includes('&lt;img'));
});

test('FE-ADM-52 KataGo 版本/资产下拉与推荐选择', () => {
  const releases = [
    {
      tag: 'v1.18.2',
      name: 'CUDA speedup',
      assets: [{ name: 'cuda.zip', backend: 'cuda', size: 10 }],
    },
    {
      tag: 'v1.18.1',
      name: 'Better benchmark',
      assets: [
        { name: 'opencl.zip', backend: 'opencl', size: 20 },
        { name: 'eigen.zip', backend: 'eigen', size: 30 },
      ],
    },
  ];
  const options = kataReleaseOptions(releases);
  assert.equal(options[0].value, 'v1.18.2');
  assert.ok(options[0].label.includes('CUDA speedup'));
  const assets = kataAssetOptions(releases, 'v1.18.1');
  assert.equal(assets.length, 2);
  assert.equal(assets[0].label.includes('OpenCL'), true);
  assert.equal(
    kataAssetLabel({
      name: 'katago-v1.18.1-cuda12.1-cudnn9.8.0-windows-x64.zip',
      backend: 'cuda',
      size: 9.7 * 1024 * 1024,
    }),
    'CUDA · cuda12.1-cudnn9.8.0 · 9.7 MB',
  );
  assert.equal(pickKataAsset(releases, 'v1.18.1'), 'opencl.zip');
  assert.equal(pickKataAsset(releases, 'v1.18.1', 'eigen.zip'), 'eigen.zip');
  assert.equal(pickKataAsset(releases, 'v9.9.9'), '');
});

test('FE-ADM-53 官方模型下拉文案（Elo/最新/最强/兼容性）', () => {
  assert.equal(
    modelOptionLabel({ name: 'kata1-tf3.bin.gz', latest: true, compatible: false }),
    'kata1-tf3.bin.gz（最新 · 需更新引擎）',
  );
  assert.equal(
    modelOptionLabel({ name: 'kata1-b18.bin.gz', strongest: true }),
    'kata1-b18.bin.gz（最强）',
  );
  assert.equal(
    modelOptionLabel({ name: 'kata1-b18.bin.gz', elo: 14549.9, latest: true }),
    'Elo 14550 · kata1-b18.bin.gz（最新）',
  );
  assert.equal(modelOptionLabel({ name: 'plain.bin.gz' }), 'plain.bin.gz');
  assert.equal(modelOptionLabel({ name: 'plain.bin.gz', elo: null }), 'plain.bin.gz');
});
