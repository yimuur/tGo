/**
 * tGo · engine-pill 纯映射无头单测（T5.4，node --test）
 * 用例 ID: FE-PILL-*
 * 覆盖：engineStateMeta 状态（含调优子态）→外观映射、详情行组装。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENGINE_STATE_META,
  engineStateMeta,
  engineDetailLines,
  memoryUsagePercent,
  memoryUsageText,
  isEngineTuning,
  pillDisplayState,
  ANALYZING_HOLD_MS,
} from '../static/js/core/engine-pill.js';

test('FE-PILL-01 六种状态元数据完整（含 STOPPED 未启动）', () => {
  for (const s of ['STOPPED', 'INIT', 'IDLE', 'ANALYZING', 'DEAD', 'FATAL']) {
    const meta = ENGINE_STATE_META[s];
    assert.ok(meta.label && meta.dot);
  }
  assert.equal(ENGINE_STATE_META.ANALYZING.label, '分析中');
  assert.equal(ENGINE_STATE_META.IDLE.dot, 's-idle');
  assert.equal(ENGINE_STATE_META.FATAL.dot, 's-fatal');
  // STOPPED＝未启动（进程未运行）；与 INIT「加载中」语义分界（2026/09/18）
  assert.equal(ENGINE_STATE_META.STOPPED.label, '未启动');
  assert.equal(ENGINE_STATE_META.STOPPED.dot, 's-off');
});

test('FE-PILL-02 未知/null → 连接中（骨架）', () => {
  assert.equal(engineStateMeta(null).label, '连接中');
  assert.equal(engineStateMeta('BOGUS').dot, 's-init');
  assert.equal(engineStateMeta('IDLE').label, '空闲中');
  assert.equal(engineStateMeta('STOPPED').label, '未启动');
  assert.equal(engineStateMeta('STOPPED', 42).label, '未启动', 'progress 不得把未启动误并为调优中');
});

test('FE-PILL-08 调优中分叉：INIT + progress 非 null → s-tune/调优中（0 亦属调优）', () => {
  assert.equal(engineStateMeta('INIT', 42).label, '调优中');
  assert.equal(engineStateMeta('INIT', 42).dot, 's-tune');
  assert.equal(engineStateMeta('INIT', 0).dot, 's-tune', 'progress=0 属调优起点，不得因 || 误并回加载中');
  assert.equal(engineStateMeta('INIT', null).label, '加载中');
  assert.equal(engineStateMeta('INIT').label, '加载中');
  assert.equal(isEngineTuning('INIT', 0), true);
  assert.equal(isEngineTuning('INIT', null), false);
  assert.equal(isEngineTuning('ANALYZING', 42), false, '非 INIT 状态不计入调优');
});

test('FE-PILL-09 显示迟滞：ANALYZING→IDLE 保持窗口内维持 分析中（2026/09/19 防全局分析闪烁）', () => {
  const H = ANALYZING_HOLD_MS;
  assert.ok(H > 0);
  // ANALYZING 立即生效并记时
  let r = pillDisplayState({ prev: 'IDLE', next: 'ANALYZING', now: 1000, lastBusyAt: 0 });
  assert.deepEqual(r, { state: 'ANALYZING', lastBusyAt: 1000, deferMs: 0 });
  // 窗口内回 IDLE（连续查询间隙）→ 维持 ANALYZING，返回剩余延迟
  r = pillDisplayState({ prev: 'ANALYZING', next: 'IDLE', now: 1300, lastBusyAt: 1000 });
  assert.equal(r.state, 'ANALYZING');
  assert.equal(r.deferMs, H - 300);
  // 新查询到达 → 无缝续保（刷新基准，窗口重计）
  r = pillDisplayState({ prev: 'ANALYZING', next: 'ANALYZING', now: 1500, lastBusyAt: 1000 });
  assert.equal(r.state, 'ANALYZING');
  assert.equal(r.lastBusyAt, 1500);
  // 窗口外 → 落定 IDLE
  r = pillDisplayState({ prev: 'ANALYZING', next: 'IDLE', now: 1000 + H, lastBusyAt: 1000 });
  assert.equal(r.state, 'IDLE');
  assert.equal(r.deferMs, 0);
  // 语义状态不得迟滞：ANALYZING → STOPPED/INIT/DEAD 立即生效
  for (const st of ['STOPPED', 'INIT', 'DEAD', 'FATAL']) {
    const rr = pillDisplayState({ prev: 'ANALYZING', next: st, now: 1100, lastBusyAt: 1000 });
    assert.equal(rr.state, st, `${st} 必须立即生效（语义状态不迟滞）`);
  }
  // 缺省容错
  assert.deepEqual(pillDisplayState({}), { state: null, lastBusyAt: 0, deferMs: 0 });
});

test('FE-PILL-03 详情行组装：调优态（状态行分叉）与系统信息', () => {
  const lines = engineDetailLines({
    engine: { state: 'INIT', progress: 3 },
    system: {
      host: 'tgo-pc',
      os: 'Windows',
      backend: 'opencl',
      memory_usage: { used: 10 * 2 ** 30, total: 16 * 2 ** 30, percent: 62.5 },
      gpu: 'RTX 3060',
    },
  });
  assert.ok(lines.some((l) => l.includes('状态：调优中')));
  assert.ok(lines.some((l) => l.includes('调优进度：3')));
  assert.ok(lines.some((l) => l.includes('tgo-pc')));
  assert.ok(lines.some((l) => l.includes('RTX 3060')));
  assert.ok(
    lines.some((l) => l.includes('内存利用率：63%（10.0 / 16.0 GB）')),
    '内存利用率须带用量与总量',
  );
  const loading = engineDetailLines({ engine: { state: 'INIT', progress: null }, system: null });
  assert.ok(loading.some((l) => l.includes('状态：加载中')), 'INIT 无进度仍为加载中');
});

test('FE-PILL-10 内存利用率文案：旧数字载荷与缺用量兜底', () => {
  assert.equal(memoryUsagePercent(62), 62);
  assert.equal(memoryUsagePercent({ percent: 62.5 }), 62.5);
  assert.equal(memoryUsagePercent(null), null);
  assert.equal(memoryUsageText(62), '62%');
  assert.equal(memoryUsageText({ used: 2 ** 30, total: 4 * 2 ** 30, percent: 50 }), '50%（1.0 / 4.0 GB）');
  assert.equal(memoryUsageText({ percent: 50 }), '50%');
  assert.equal(memoryUsageText(null), null);
});

test('FE-PILL-04 无系统详情时的兜底行', () => {
  const lines = engineDetailLines({ engine: { state: 'IDLE' }, system: null });
  assert.equal(lines.length, 2); // 状态 + 兜底
  assert.ok(lines[1].includes('暂无系统详情'));
});
