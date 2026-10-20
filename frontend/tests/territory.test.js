/**
 * tGo · [领地] 交互口径测试（T6.5 领地反馈批次，2026/09/12 人工决策）
 * 用例 ID: FE-TERR-*
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TERRITORY_DBLCLICK_MS,
  TERRITORY_RETRY_MS,
  createTerritoryTimeout,
  territoryButtonView,
  territoryButtonClasses,
  territoryButtonClassString,
  territoryClickIntent,
  territoryEnginePlan,
  territoryHeatPlan,
  territoryRequestAction,
  territoryWatchdogAction,
} from '../static/js/core/territory.js';

test('FE-TERR-01 | 常量：双击窗口 300ms / 无回执看门狗重试间隔 12s', () => {
  assert.equal(TERRITORY_DBLCLICK_MS, 300);
  assert.equal(TERRITORY_RETRY_MS, 12000);
});

test('FE-TERR-02 | territoryClickIntent：首击延迟单击 / 窗口内二击立即切换连续模式', () => {
  assert.deepEqual(territoryClickIntent({}), { kind: 'single', delayMs: TERRITORY_DBLCLICK_MS });
  assert.deepEqual(territoryClickIntent({ armed: false }), { kind: 'single', delayMs: TERRITORY_DBLCLICK_MS });
  assert.deepEqual(territoryClickIntent({ armed: true }), { kind: 'auto', delayMs: 0 });
});

test('FE-TERR-03 | territoryHeatPlan：显示/保留/清除/结束矩阵（对弈与复盘共用口径）', () => {
  // 未开启 → 清除（不停止、不请求）
  assert.deepEqual(
    territoryHeatPlan({ active: false, auto: true, hasData: true, positionChanged: true }),
    { display: 'clear', request: false, stop: false },
  );
  // 当前局面有数据 → 显示（棋盘内与既有热力交叉淡变）
  assert.deepEqual(
    territoryHeatPlan({ active: true, auto: false, hasData: true, positionChanged: true }),
    { display: 'show', request: false, stop: false },
  );
  // 同局面等待中（首击请求在途）→ 保留，不重复请求
  assert.deepEqual(
    territoryHeatPlan({ active: true, auto: false, hasData: false, positionChanged: false }),
    { display: 'keep', request: false, stop: false },
  );
  // 连续模式局面推进但数据未到 → 保留旧热力 + 拉起请求（不闪回棋盘背景）
  assert.deepEqual(
    territoryHeatPlan({ active: true, auto: true, hasData: false, positionChanged: true }),
    { display: 'keep', request: true, stop: false },
  );
  // 单击瞬态（非连续）遇局面推进且无数据 → 清除并结束显示（熄灭按钮）
  assert.deepEqual(
    territoryHeatPlan({ active: true, auto: false, hasData: false, positionChanged: true }),
    { display: 'clear', request: false, stop: true },
  );
});

test('FE-TERR-05 | territoryRequestAction：仅同局面在途请求才跳过（连手必须重发，否则热力不刷新）', () => {
  // 无在途 → 发送
  assert.equal(territoryRequestAction({ pending: false, pendingAt: 3, at: 5 }), 'send');
  assert.equal(territoryRequestAction({}), 'send');
  // 同局面 → 跳过（防重）
  assert.equal(territoryRequestAction({ pending: true, pendingAt: 5, at: 5 }), 'skip');
  assert.equal(territoryRequestAction({ pending: true, pendingAt: 'trial:7:2', at: 'trial:7:2' }), 'skip');
  // 局面推进（在途请求属于旧局面）→ 必须重发
  assert.equal(territoryRequestAction({ pending: true, pendingAt: 5, at: 6 }), 'send');
  assert.equal(territoryRequestAction({ pending: true, pendingAt: 'main:5', at: 'main:6' }), 'send');
  // pending 但未记录在途局面（异常态）→ 发送
  assert.equal(territoryRequestAction({ pending: true, pendingAt: null, at: 6 }), 'send');
});

test('FE-TERR-04 | createTerritoryTimeout：arm 超时回调一次 / cancel 撤销 / 重复 arm 重置', () => {
  const fired = [];
  const timers = new Map();
  let seq = 0;
  const timeout = createTerritoryTimeout({
    ms: 1000,
    onTimeout: () => fired.push('t'),
    setTimer: (fn) => {
      seq += 1;
      timers.set(seq, fn);
      return seq;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const fireAll = () => {
    for (const [id, fn] of [...timers.entries()]) {
      timers.delete(id);
      fn();
    }
  };

  assert.equal(timeout.armed, false);
  timeout.arm();
  assert.equal(timeout.armed, true);
  assert.equal(timers.size, 1);
  timeout.arm(); // 重复领取 → 旧计时器撤销，不叠加
  assert.equal(timers.size, 1, '重复 arm 不叠加计时器');
  fireAll();
  assert.deepEqual(fired, ['t'], '超时回调一次');
  assert.equal(timeout.armed, false, '触发后解除');
  assert.equal(timers.size, 0);

  // cancel：不再回调
  timeout.arm();
  assert.equal(timeout.armed, true);
  timeout.cancel();
  assert.equal(timeout.armed, false);
  assert.equal(timers.size, 0);
  assert.deepEqual(fired, ['t']);

  // cancel 幂等 / 未 arm 时安全
  timeout.cancel();
  assert.equal(timeout.armed, false);
});

test('FE-TERR-06 | territoryButtonView：开启=整按钮高亮 / 连续=左上角小圆点 / title 口径', () => {
  // 未开启：不高亮、无圆点、提示双击连续（2026/09/19 用例同步：普通态 title 去前缀，
  // 与 territory.js / game-view.js 现口径一致；连续态保留 `领地：` 前缀；
  // 同日人工确认：测试断言以最新更改为准）
  assert.deepEqual(territoryButtonView({ active: false, auto: false }), {
    lit: false,
    dot: false,
    title: '显示/隐藏热力；双击开启“每步自动”连续模式',
  });
  // 单击瞬态：整按钮高亮（无圆点）
  assert.deepEqual(territoryButtonView({ active: true, auto: false }), {
    lit: true,
    dot: false,
    title: '显示/隐藏热力；双击开启“每步自动”连续模式',
  });
  // 连续模式：高亮 + 左上角小圆点 + 单击取消文案（2026/09/17 回退口径；图标恒空心）
  assert.deepEqual(territoryButtonView({ active: true, auto: true }), {
    lit: true,
    dot: true,
    title: '领地：连续模式（单击取消）',
  });
  // auto 隐含 active（连续模式必然高亮 + 圆点）
  assert.equal(territoryButtonView({ auto: true }).lit, true);
  assert.equal(territoryButtonView({ auto: true }).dot, true);
  assert.equal(territoryButtonView({}).lit, false);
  assert.equal(territoryButtonView({}).dot, false);
});

test('FE-TERR-06b | territoryButtonClasses/ClassString：视图切换与重建共用同一状态映射', () => {
  // 2026/09/17 回退口径：按钮类名只有 `is-on`（圆点/图标为子元素表达，不是按钮类名）
  assert.deepEqual(territoryButtonClasses({ active: false, auto: false }), { 'is-on': false });
  assert.deepEqual(territoryButtonClasses({ active: true, auto: false }), { 'is-on': true });
  assert.deepEqual(territoryButtonClasses({ active: true, auto: true }), { 'is-on': true });
  // 重建拼装串（renderActions 用）：无状态 → 空串，不残留多余空格
  assert.equal(territoryButtonClassString({}), '');
  assert.equal(territoryButtonClassString({ active: true }), 'is-on');
  assert.equal(territoryButtonClassString({ auto: true }), 'is-on');
});

test('FE-TERR-07 | territoryWatchdogAction：无回执看门狗只重试、绝不结束显示（连续/瞬态均不得自动退出）', () => {
  // 仍在等待（请求在途 + 显示开启）→ 重试
  assert.equal(territoryWatchdogAction({ pending: true, active: true }), 'retry');
  // 已销毁 / 已回执 / 显示已关 → 不动（看门狗没有“结束显示”这一出口）
  assert.equal(territoryWatchdogAction({ destroyed: true, pending: true, active: true }), 'idle');
  assert.equal(territoryWatchdogAction({ pending: false, active: true }), 'idle');
  assert.equal(territoryWatchdogAction({ pending: true, active: false }), 'idle');
  assert.equal(territoryWatchdogAction({}), 'idle');
});

test('FE-TERR-08 | territoryEnginePlan：试下无数据拒发领地请求，主谱/已有数据照常（BUG-091）', () => {
  // 引擎可用：一律照常
  assert.equal(territoryEnginePlan({ engineDown: false, hasLocalData: false, trialPosition: true }), 'ok');
  assert.equal(territoryEnginePlan({ engineDown: false, hasLocalData: false, trialPosition: false }), 'ok');
  // 本地已有（持久化/会话）数据：引擎无关，仍可查看
  assert.equal(territoryEnginePlan({ engineDown: true, hasLocalData: true, trialPosition: true }), 'ok');
  assert.equal(territoryEnginePlan({ engineDown: true, hasLocalData: true, trialPosition: false }), 'ok');
  // 引擎不可用 + 无本地数据 + **主谱**：持久化数据由服务端直接回投（引擎无关，UI_UX §6.2）
  assert.equal(territoryEnginePlan({ engineDown: true, hasLocalData: false, trialPosition: false }), 'ok');
  // 引擎不可用 + 无本地数据 + **试下**：会话现算须引擎 → 拒绝开启/结束显示
  assert.equal(territoryEnginePlan({ engineDown: true, hasLocalData: false, trialPosition: true }), 'engine-blocked');
  // 缺省/缺参安全（不误伤主谱）
  assert.equal(territoryEnginePlan({}), 'ok');
  assert.equal(territoryEnginePlan({ engineDown: true, hasLocalData: false }), 'ok');
});
