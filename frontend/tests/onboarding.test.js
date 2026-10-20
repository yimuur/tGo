/**
 * tGo · T6.2 首启引导/引擎横幅/胶囊纯函数无头单测（node --test）
 * 用例 ID: FE-OB-*（onboarding 派生）/ FE-EB-*（引擎横幅）/ FE-PILL-05/06（胶囊）
 * 覆盖：首启判定、模型自检派生、引擎步进派生、调优文案/耗时格式化、
 *       进入分流计划、引擎降级横幅规格与恢复 Toast、胶囊调优标签与内存解析。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  needsOnboarding,
  onboardingGate,
  deriveModelCheck,
  enterButtonState,
  modelNoteText,
  deriveEngineStep,
  ENGINE_STEP,
  ENGINE_MODE,
  engineOnboardPlan,
  engineCopyOverride,
  engineReconnectRetry,
  clampPercent,
  benchmarkText,
  formatElapsed,
  entryPlan,
  describeActive,
} from '../static/js/views/onboarding-view.js';

import {
  engineBannerKey,
  engineBannerSpec,
  recoveryToast,
} from '../static/js/core/engine-banner.js';

import { ENGINE_REASON } from '../static/js/core/state.js';

import {
  enginePillLabel,
  engineStateLabel,
  engineDetailLines,
  memoryUsagePercent,
} from '../static/js/core/engine-pill.js';

/* ---------------- FE-OB：首启判定 / 模型自检 ---------------- */

test('FE-OB-01 首启判定：onboarded 缺失/假 → 需引导', () => {
  assert.equal(needsOnboarding(false), true);
  assert.equal(needsOnboarding(undefined), true);
  assert.equal(needsOnboarding(null), true);
  assert.equal(needsOnboarding(0), true);
  assert.equal(needsOnboarding(true), false);
  assert.equal(needsOnboarding(1), false);
});

test('FE-OB-18 首启门禁例外（BUG-103）：管理页不受门禁（[去管理页] 可达）', () => {
  // 未完成首启：常规路由强制引导页；**管理页豁免**（首启期修复引擎/模型的唯一出口，
  // 旧实现把 #/admin 也强制回引导页 → 点击 [去管理页] 静默失败）
  assert.equal(onboardingGate('game', false), true);
  assert.equal(onboardingGate('create', false), true);
  assert.equal(onboardingGate('review', false), true);
  assert.equal(onboardingGate('review-list', false), true);
  assert.equal(onboardingGate('admin', false), false);
  assert.equal(onboardingGate('admin', undefined), false);
  // 已完成首启：一律不门禁
  assert.equal(onboardingGate('admin', true), false);
  assert.equal(onboardingGate('game', true), false);
});

test('FE-OB-02 模型自检：标准+人类齐全', () => {
  const check = deriveModelCheck({
    models: [
      { name: 'kata1.bin.gz', human: false, default: true },
      { name: 'human.bin.gz', human: true, default: false },
    ],
    default: 'kata1.bin.gz',
    humanModelAvailable: true,
  });
  assert.ok(check);
  assert.equal(check.standardMissing, false);
  assert.equal(check.standard.ok, true);
  assert.equal(check.standard.name, 'kata1.bin.gz');
  assert.equal(check.human.ok, true);
});

test('FE-OB-03 模型自检：人类模型缺失（影响态，非阻断）', () => {
  const check = deriveModelCheck({
    models: [{ name: 'kata1.bin.gz', human: false, default: true }],
    default: 'kata1.bin.gz',
    humanModelAvailable: false,
  });
  assert.ok(check);
  assert.equal(check.standardMissing, false);
  assert.equal(check.standard.ok, true);
  assert.equal(check.human.ok, false);
});

test('FE-OB-04 模型自检：标准模型缺失（降级态，不阻断进入）', () => {
  const check = deriveModelCheck({
    models: [],
    default: null,
    humanModelAvailable: false,
  });
  assert.ok(check);
  assert.equal(check.standardMissing, true);
  assert.equal(check.standard.ok, false);
  assert.equal(check.human.ok, false);
});

test('FE-OB-05 模型自检：仅人类模型文件（标准缺失 → 降级态）', () => {
  const check = deriveModelCheck({
    models: [{ name: 'human.bin.gz', human: true, default: false }],
    default: null,
    humanModelAvailable: true,
  });
  assert.ok(check);
  assert.equal(check.standardMissing, true);
  assert.equal(check.standard.ok, false);
});

test('FE-OB-06 模型自检：载荷不合法/未就绪 → null（检测失败/加载中）', () => {
  assert.equal(deriveModelCheck(null), null);
  assert.equal(deriveModelCheck(undefined), null);
  assert.equal(deriveModelCheck({}), null);
  assert.equal(deriveModelCheck({ models: 'nope' }), null);
});

test('FE-OB-15 [进入 tGo] 按钮态（BUG-082/090）：仅自检进行中禁用；失败/模型缺失均可进入', () => {
  // 自检进行中（未到且无错误）→ 禁用 + 「检测中…」（防连点）
  assert.deepEqual(enterButtonState({ check: null, checkError: false }), {
    disabled: true,
    text: '检测中…',
  });
  // 自检失败（网络异常/超时）→ 可进入（旧实现 button 仅换文案仍禁用 → 用户永久被困引导页）
  assert.deepEqual(enterButtonState({ check: null, checkError: true }), {
    disabled: false,
    text: '进入 tGo',
  });
  // 自检完成：标准模型缺失＝降级态（非阻断）→ 可进入（BUG-090：标准缺失仅禁用 AI 功能，
  // 人人对弈与历史复盘照常，不得把用户困在引导页）；人类缺失/齐全同样可进入
  assert.deepEqual(enterButtonState({ check: { standardMissing: true } }), {
    disabled: false,
    text: '进入 tGo',
  });
  assert.deepEqual(enterButtonState({ check: { standardMissing: false } }), {
    disabled: false,
    text: '进入 tGo',
  });
  // 无参兜底 = 检测中态（不抛错）
  assert.deepEqual(enterButtonState(), { disabled: true, text: '检测中…' });
});

test('FE-OB-16 模型自检说明文案（modelNoteText）', () => {
  assert.equal(modelNoteText(null), '');
  // 标准缺失（降级态）：明示人机/实时分析不可用 + 人人对弈/历史复盘照常（不得写「对弈不可用」）
  const missing = modelNoteText({ standardMissing: true, human: { ok: false } });
  assert.match(missing, /人机对弈与实时分析不可用/);
  assert.match(missing, /人人对弈、历史复盘照常可用/);
  // 人类缺失：仅风格/难度受限；齐全：无提示
  assert.equal(
    modelNoteText({ standardMissing: false, human: { ok: false } }),
    '人类风格 / 自适应难度不可用，标准风格对弈正常。',
  );
  assert.equal(modelNoteText({ standardMissing: false, human: { ok: true } }), '');
});

test('FE-OB-17 引擎行文案覆盖：归因不得误导为「连续崩溃」（BUG-090/097）', () => {
  const copy = engineCopyOverride(ENGINE_STEP.fatal, ENGINE_REASON.standardModelMissing);
  assert.equal(copy.text, '引擎不可用（标准模型缺失）');
  assert.match(copy.note, /重新检测/);
  assert.match(copy.note, /人人对弈与历史复盘不受影响/);

  const noExec = engineCopyOverride(ENGINE_STEP.fatal, ENGINE_REASON.engineExecutableMissing);
  assert.equal(noExec.text, '引擎不可用（katago 可执行文件缺失）');
  assert.match(noExec.note, /engine\/katago/);

  const failed = engineCopyOverride(
    ENGINE_STEP.fatal,
    ENGINE_REASON.startupFailed,
    'Uncaught exception: No OpenCL devices were found'
  );
  assert.equal(failed.text, '引擎启动失败');
  assert.match(failed.note, /No OpenCL devices/);
  // 无 detail → 仍给恢复指引
  assert.match(engineCopyOverride(ENGINE_STEP.fatal, ENGINE_REASON.startupFailed).note, /手动重启/);

  // 无 reason（真实 FATAL＝连续崩溃）/ 其它原因 / 其它步进类型 → 不覆盖（用引擎表内文案）
  assert.equal(engineCopyOverride(ENGINE_STEP.fatal, null), null);
  assert.equal(engineCopyOverride(ENGINE_STEP.fatal, 'other'), null);
  assert.equal(engineCopyOverride(ENGINE_STEP.dead, ENGINE_REASON.standardModelMissing), null);
  assert.equal(engineCopyOverride(ENGINE_STEP.init, ENGINE_REASON.standardModelMissing), null);
});

/* ---------------- FE-OB：引擎步进 / 进度派生 ---------------- */

test('FE-OB-07 引擎步进派生：无状态→connecting，INIT 分叉 init/tuning', () => {
  assert.equal(deriveEngineStep(null), ENGINE_STEP.connecting);
  assert.equal(deriveEngineStep({}), ENGINE_STEP.connecting);
  assert.equal(deriveEngineStep({ state: 'STOPPED' }), ENGINE_STEP.stopped);
  assert.equal(deriveEngineStep({ state: 'INIT', progress: null }), ENGINE_STEP.init);
  assert.equal(deriveEngineStep({ state: 'INIT' }), ENGINE_STEP.init);
  assert.equal(deriveEngineStep({ state: 'INIT', progress: 25 }), ENGINE_STEP.tuning);
  assert.equal(deriveEngineStep({ state: 'INIT', progress: 0 }), ENGINE_STEP.tuning);
});

test('FE-OB-08 引擎步进派生：六态映射', () => {
  assert.equal(deriveEngineStep({ state: 'IDLE' }), ENGINE_STEP.ready);
  assert.equal(deriveEngineStep({ state: 'ANALYZING' }), ENGINE_STEP.busy);
  assert.equal(deriveEngineStep({ state: 'DEAD' }), ENGINE_STEP.dead);
  assert.equal(deriveEngineStep({ state: 'FATAL' }), ENGINE_STEP.fatal);
  assert.equal(deriveEngineStep({ state: 'STOPPED' }), ENGINE_STEP.stopped);
});

test('FE-OB-09 调优进度：钳制/文案/耗时格式化', () => {
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent(3.7), 4);
  assert.equal(clampPercent('abc'), 0);
  assert.equal(clampPercent(42), 42);

  assert.equal(benchmarkText(null), null);
  assert.equal(benchmarkText(undefined), null);
  assert.equal(benchmarkText(33), 'GPU 调优 33%');
  assert.equal(benchmarkText(2.4), 'GPU 调优 2%');

  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(59000), '0:59');
  assert.equal(formatElapsed(84200), '1:24');
  assert.equal(formatElapsed(3600000), '60:00');
});

/* ---------------- FE-OB：进入分流计划 ---------------- */

test('FE-OB-10 进入分流：无进行中对局 → create', () => {
  assert.deepEqual(entryPlan(null), { resume: false, game: null });
  assert.deepEqual(entryPlan(undefined), { resume: false, game: null });
});

test('FE-OB-11 进入分流：active-latest 存在 → resume + 简述', () => {
  const plan = entryPlan({
    id: 7,
    black_name: '张三',
    white_name: 'AI',
    board_size: 19,
    last_move_no: 12,
  });
  assert.equal(plan.resume, true);
  assert.equal(plan.game.id, 7);
  assert.match(plan.game.title, /黑 张三 vs 白 AI/);
  assert.match(plan.game.title, /19 路/);
  assert.match(plan.game.title, /第 12 手/);
});

test('FE-OB-12 进行中对局简述：字段缺省兜底', () => {
  const t = describeActive({});
  assert.match(t, /黑 真人 vs 白 真人/);
  assert.match(t, /19 路/);
  assert.match(t, /第 0 手/);
});

test('FE-OB-13 引擎行计划（ISSUE-065 方案 B）：首次拉起一次；空闲释放后「未运行」不补拉', () => {
  // STOPPED（未启动：非驻留启动后未被拉起）→ 允许自动拉起一次
  assert.deepEqual(
    engineOnboardPlan({ step: ENGINE_STEP.stopped }),
    { mode: ENGINE_STEP.init, pull: true },
  );
  // 标准模型缺失（引擎无模型无法启动）/ 请求在途 → 不拉起
  assert.equal(engineOnboardPlan({ step: ENGINE_STEP.stopped, standardMissing: true }).pull, false);
  assert.equal(engineOnboardPlan({ step: ENGINE_STEP.stopped, pending: true }).pull, false);
  // INIT（加载/调优进行中）：幂等补发一次（服务端 ensure_ready 空操作），不改变呈现
  assert.deepEqual(
    engineOnboardPlan({ step: ENGINE_STEP.init }),
    { mode: ENGINE_STEP.init, pull: true },
  );
  // 已拉起但未达就绪（进行中/中断）→ 不重复 POST，保持「启动中」
  assert.deepEqual(
    engineOnboardPlan({ step: ENGINE_STEP.init, autoStarted: true }),
    { mode: ENGINE_STEP.init, pull: false },
  );
  // 曾就绪后回 STOPPED（空闲释放/手动停止）→ 「未运行」呈现且不补拉（方案 B）；
  // 与本会话是否拉起过无关（进入页面时引擎已由对局拉起等）
  assert.deepEqual(
    engineOnboardPlan({ step: ENGINE_STEP.stopped, autoStarted: true, everReady: true }),
    { mode: ENGINE_MODE.released, pull: false },
  );
  assert.deepEqual(
    engineOnboardPlan({ step: ENGINE_STEP.stopped, everReady: true }),
    { mode: ENGINE_MODE.released, pull: false },
  );
  // 其它状态透传且永不拉起
  for (const step of [
    ENGINE_STEP.connecting, ENGINE_STEP.tuning, ENGINE_STEP.ready,
    ENGINE_STEP.dead, ENGINE_STEP.fatal,
  ]) {
    assert.deepEqual(
      engineOnboardPlan({ step, autoStarted: false, everReady: false }),
      { mode: step, pull: false },
    );
  }
});

test('FE-OB-14 连接恢复重试（BUG-080 F5）：拉起未达就绪 → 允许再试；就绪后释放 → 不因重连补拉', () => {
  assert.equal(engineReconnectRetry({ autoStarted: true, everReady: false }), true);
  assert.equal(engineReconnectRetry({ autoStarted: true, everReady: true }), false);
  assert.equal(engineReconnectRetry({ autoStarted: false, everReady: false }), false);
  assert.equal(engineReconnectRetry({ autoStarted: false, everReady: true }), false);
  assert.equal(engineReconnectRetry({}), false);
});

/* ---------------- FE-EB：引擎降级横幅与恢复 Toast ---------------- */

test('FE-EB-01 横幅指纹：调优/DEAD/FATAL 有，其余无；FATAL/DEAD 按归因分叉（BUG-090/097）', () => {
  assert.equal(engineBannerKey('INIT', 33), 'tune:33');
  assert.equal(engineBannerKey('INIT', 0), 'tune:0');
  assert.equal(engineBannerKey('INIT', null), null);
  assert.equal(engineBannerKey('INIT', undefined), null);
  assert.equal(engineBannerKey('DEAD'), 'dead');
  assert.equal(engineBannerKey('FATAL'), 'fatal');
  assert.equal(engineBannerKey('FATAL', null, null), 'fatal');
  // 同一 FATAL 态但「标准模型缺失」→ 独立指纹（文案/操作完全不同，不得被去重吞掉）
  assert.equal(
    engineBannerKey('FATAL', null, ENGINE_REASON.standardModelMissing),
    'fatal:no-model',
  );
  // 可执行文件缺失 / 启动失败（含 detail 参与指纹）→ 同样独立
  assert.equal(
    engineBannerKey('FATAL', null, ENGINE_REASON.engineExecutableMissing),
    'fatal:no-exec',
  );
  assert.equal(
    engineBannerKey('FATAL', null, ENGINE_REASON.startupFailed, '驱动异常'),
    'fatal:startup:驱动异常',
  );
  assert.equal(
    engineBannerKey('DEAD', null, ENGINE_REASON.startupFailed, '驱动异常'),
    'dead:startup:驱动异常',
  );
  assert.equal(engineBannerKey('IDLE'), null);
  assert.equal(engineBannerKey('ANALYZING'), null);
});

test('FE-EB-02 横幅规格：首次调优 warn + 文案含进度', () => {
  const spec = engineBannerSpec('INIT', 25);
  assert.ok(spec);
  assert.equal(spec.tone, 'warn');
  assert.match(spec.text, /首次调优中（25%）/);
  assert.match(spec.text, /不影响落子与复盘/);
  assert.equal(engineBannerSpec('INIT', null), null);
});

test('FE-EB-03 横幅规格：DEAD error + 仅 [去管理页]（重启入口收敛到管理页）', () => {
  const spec = engineBannerSpec('DEAD', null);
  assert.equal(spec.tone, 'error');
  assert.match(spec.text, /自动重启中/);
  // 2026/09/20 人工决策：DEAD 期间点击启动/重试会被后端快速失败且回执不可见
  // （假受理）→ 横幅不再提供 [重试]，只导流到管理页
  assert.deepEqual(spec.actions.map((a) => a.key), ['admin']);
});

test('FE-EB-06 横幅规格：FATAL + 标准模型缺失 → 指向模型与管理页 [手动重启] 恢复（BUG-090/097）', () => {
  const spec = engineBannerSpec('FATAL', null, ENGINE_REASON.standardModelMissing);
  assert.equal(spec.tone, 'error');
  assert.match(spec.text, /引擎不可用（标准模型缺失）/);
  assert.match(spec.text, /手动重启/);
  // 文案修订（2026/09/20）：重启入口收敛到管理页 → 句尾改「到管理页 [手动重启] 恢复」
  assert.match(spec.text, /放入模型文件后到管理页 \[手动重启\] 恢复/);
  assert.equal(/崩溃/.test(spec.text), false);
  // 文件就位后可经管理页 [手动重启] 运行时重建装配；横幅只保留 [去管理页]
  assert.deepEqual(spec.actions.map((a) => a.key), ['admin']);
});

test('FE-EB-07 横幅规格：可执行文件缺失 / 启动失败（含 detail）（BUG-097）', () => {
  const noExec = engineBannerSpec('FATAL', null, ENGINE_REASON.engineExecutableMissing);
  assert.match(noExec.text, /引擎不可用（katago 可执行文件缺失）/);
  assert.deepEqual(noExec.actions.map((a) => a.key), ['admin']);

  const failed = engineBannerSpec(
    'FATAL',
    null,
    ENGINE_REASON.startupFailed,
    'Uncaught exception: No OpenCL devices were found on your system.'
  );
  assert.match(failed.text, /引擎启动失败/);
  assert.match(failed.text, /No OpenCL devices/);
  assert.match(failed.text, /请到管理页 \[手动重启\]/);
  assert.equal(/崩溃已停止/.test(failed.text), false);

  // DEAD（自动重启中）附启动失败原因；无 detail → 保持通用文案
  const dead = engineBannerSpec('DEAD', null, ENGINE_REASON.startupFailed, '驱动异常');
  assert.match(dead.text, /自动重启中（驱动异常）/);
  assert.deepEqual(dead.actions.map((a) => a.key), ['admin']);
  assert.equal(
    engineBannerSpec('DEAD', null, ENGINE_REASON.startupFailed).text,
    '引擎异常，自动重启中'
  );
});

test('FE-EB-04 横幅规格：FATAL 无归因 → 仅 [去管理页]（手动重启在管理页）', () => {
  const spec = engineBannerSpec('FATAL', null);
  assert.equal(spec.tone, 'error');
  assert.match(spec.text, /引擎连续崩溃已停止，请到管理页 \[手动重启\]/);
  assert.deepEqual(spec.actions.map((a) => a.key), ['admin']);
});

test('FE-EB-05 恢复 Toast：问题态/调优态 → 就绪', () => {
  assert.equal(recoveryToast('DEAD', 'IDLE', false).text, '引擎已恢复');
  assert.equal(recoveryToast('FATAL', 'ANALYZING', false).level, 'info');
  assert.equal(recoveryToast('INIT', 'IDLE', true).text, '引擎调优完成，已就绪');
  assert.equal(recoveryToast('INIT', 'IDLE', false), null);
  assert.equal(recoveryToast('IDLE', 'DEAD', false), null);
  assert.equal(recoveryToast('IDLE', 'IDLE', false), null);
});

/* ---------------- FE-PILL：胶囊真实化（T6.2） ---------------- */

test('FE-PILL-05 内存利用率解析：对象/数字/null', () => {
  assert.equal(memoryUsagePercent({ percent: 62, used: 100 }), 62);
  assert.equal(memoryUsagePercent(41), 41);
  assert.equal(memoryUsagePercent(null), null);
  assert.equal(memoryUsagePercent(undefined), null);
  assert.equal(memoryUsagePercent({}), null);
});

test('FE-PILL-06 胶囊文案：调优中/加载中分叉（不带百分比，2026/09/17 人工决策）', () => {
  assert.equal(enginePillLabel({ engine: { state: 'INIT', progress: 42 } }), '调优中');
  assert.equal(enginePillLabel({ engine: { state: 'INIT', progress: 0 } }), '调优中');
  assert.equal(enginePillLabel({ engine: { state: 'INIT', progress: null } }), '加载中');
  assert.equal(enginePillLabel({ engine: { state: 'IDLE', progress: null } }), '空闲中');
  assert.equal(enginePillLabel({ engine: { state: 'DEAD' } }), '引擎异常');
  assert.equal(enginePillLabel({ engine: {} }), '连接中');
  assert.equal(enginePillLabel({}), '连接中');
});

test('FE-PILL-07 胶囊/详情：不可用归因集合 → 「引擎不可用」+ 原因行（BUG-090/097）', () => {
  const engine = { state: 'FATAL', progress: null, reason: ENGINE_REASON.standardModelMissing };
  assert.equal(engineStateLabel('FATAL', ENGINE_REASON.standardModelMissing), '引擎不可用');
  assert.equal(engineStateLabel('FATAL', ENGINE_REASON.engineExecutableMissing), '引擎不可用');
  assert.equal(engineStateLabel('FATAL', ENGINE_REASON.startupFailed), '引擎不可用');
  assert.equal(engineStateLabel('FATAL'), '引擎致命');
  assert.equal(enginePillLabel({ engine }), '引擎不可用');
  const lines = engineDetailLines({ engine });
  assert.equal(lines[0], '状态：引擎不可用');
  assert.match(lines[1], /标准模型缺失/);
  assert.match(lines[1], /\[启动\]/);

  // 可执行文件缺失 → 指向目录与恢复路径
  const noExec = engineDetailLines({
    engine: { state: 'FATAL', reason: ENGINE_REASON.engineExecutableMissing },
  });
  assert.match(noExec[1], /可执行文件缺失/);

  // 启动失败（DEAD）→ 附 stderr 摘要行
  const failed = engineDetailLines({
    engine: {
      state: 'DEAD',
      reason: ENGINE_REASON.startupFailed,
      detail: 'Uncaught exception: No OpenCL devices were found',
    },
  });
  assert.match(failed[1], /引擎启动失败（Uncaught exception/);

  // 无 reason 的 FATAL（连续崩溃）→ 沿用既有文案，不误改
  const plain = engineDetailLines({ engine: { state: 'FATAL', progress: null } });
  assert.equal(plain[0], '状态：引擎致命');
  assert.equal(plain.some((l) => /标准模型缺失/.test(l)), false);

  // 就绪态残留旧 reason（如恢复后被清除又回填）→ 不展示原因行（状态门控，防陈旧误导）
  const stale = engineDetailLines({
    engine: { state: 'IDLE', reason: ENGINE_REASON.startupFailed, detail: '旧原因' },
  });
  assert.equal(stale.some((l) => /原因：/.test(l)), false);
});
