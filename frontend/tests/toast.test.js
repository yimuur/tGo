/**
 * tGo · toast 无头单测（T5.4，node --test）
 * 用例 ID: FE-TOAST-*
 * 覆盖：code/message→级别与文案解析、合并窗口（3s 同 key）、时长分级、
 * 堆叠上限逐出、dismiss、自动过期（FakeTimers，无硬等待）；
 * 棋盘定位锚点 toastAnchor（棋盘正上方换算/视口钳制/无棋盘回退）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ToastQueue,
  resolveToast,
  TOAST_DURATION_MS,
  TOAST_ICON_ID,
  toastAnchor,
} from '../static/js/core/toast.js';

class FakeTimers {
  constructor() {
    this.nowMs = 0;
    this.tasks = [];
    this.nextId = 1;
  }

  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.nowMs + ms, fn });
    return id;
  }

  clearTimeout(id) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i >= 0) this.tasks.splice(i, 1);
  }

  tick(ms) {
    const target = this.nowMs + ms;
    for (;;) {
      const next = this.tasks
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.tasks.splice(this.tasks.indexOf(next), 1);
      this.nowMs = next.at;
      next.fn();
    }
    this.nowMs = target;
  }
}

/** 构造时钟同步的队列（now 与 timers 同一时间轴）。 */
function makeQueue(overrides = {}) {
  const timers = new FakeTimers();
  const queue = new ToastQueue({
    now: () => timers.nowMs,
    timers,
    durations: { error: 6_000, warning: 4_000, success: 4_000, info: 4_000 },
    ...overrides,
  });
  return { queue, timers };
}

test('FE-TOAST-01 resolveToast：错误码→文案/级别', () => {
  const r = resolveToast('ILLEGAL_MOVE', '禁入点');
  assert.equal(r.level, 'error');
  assert.equal(r.text, '禁入点/打劫，请另选位置'); // UI_UX §6.4 文案优先
  // B2：人类模型不可用（人类风格对局阻断）→ error 级 + 专用文案
  const human = resolveToast('HUMAN_MODEL_UNAVAILABLE', '');
  assert.equal(human.level, 'error');
  assert.equal(human.text, '人类模型不可用：请恢复人类模型后重试');
  // ISSUE-064：存量对局回放冲突 → error 级 + 专用文案（不再落 INTERNAL_ERROR 泛文案）
  const conflict = resolveToast('REPLAY_CONFLICT', '对局记录无法回放：历史数据与当前规则不符');
  assert.equal(conflict.level, 'error');
  assert.equal(conflict.text, '该对局无法回放（历史数据与当前规则不符）');
});

test('FE-TOAST-02 resolveToast：非错误码回退 message / 显式级别', () => {
  const r = resolveToast(undefined, '已排队，将在引擎空闲时执行');
  assert.equal(r.level, 'info');
  assert.equal(r.text, '已排队，将在引擎空闲时执行');

  const ok = resolveToast(undefined, '保存成功', 'success');
  assert.equal(ok.level, 'success');
});

test('FE-TOAST-03 时长分级：error 6s、info 4s', () => {
  assert.equal(TOAST_DURATION_MS.error, 6_000);
  assert.equal(TOAST_DURATION_MS.info, 4_000);
  const { queue } = makeQueue();
  const a = queue.push('错误', { level: 'error' });
  const b = queue.push('消息', { level: 'info' });
  assert.equal(a.item.expiresAt - a.item.addedAt, 6_000);
  assert.equal(b.item.expiresAt - b.item.addedAt, 4_000);
});

test('FE-TOAST-04 3s 内同 key 合并（只更新不新增）', () => {
  const { queue } = makeQueue();
  queue.push('第一次', { level: 'error', key: 'E1' });
  const merged = queue.push('第二次（更新）', { level: 'error', key: 'E1' });
  assert.equal(merged.result, 'merged');
  assert.equal(queue.getItems().length, 1);
  assert.equal(queue.getItems()[0].text, '第二次（更新）');
});

test('FE-TOAST-05 超过合并窗口的同 key 视为新条', () => {
  const { queue, timers } = makeQueue();
  queue.push('旧', { level: 'info', key: 'A' });
  timers.tick(3_100);
  const r = queue.push('新', { level: 'info', key: 'A' });
  assert.equal(r.result, 'added');
  assert.equal(queue.getItems().length, 2);
});

test('FE-TOAST-06 堆叠上限：超出逐出最旧', () => {
  const { queue } = makeQueue({ max: 3 });
  queue.push('一', { key: '1' });
  queue.push('二', { key: '2' });
  queue.push('三', { key: '3' });
  const r = queue.push('四', { key: '4' });
  assert.equal(r.result, 'added');
  assert.equal(queue.getItems().length, 3);
  assert.ok(!queue.getItems().some((it) => it.text === '一')); // 最旧被逐出
});

test('FE-TOAST-07 dismiss 手动关闭', () => {
  const { queue } = makeQueue();
  const { item } = queue.push('x', { key: 'x' });
  assert.equal(queue.dismiss(item.id), true);
  assert.equal(queue.getItems().length, 0);
  assert.equal(queue.dismiss(item.id), false); // 已不存在
});

test('FE-TOAST-08 自动过期（FakeTimers 推进）', () => {
  const { queue, timers } = makeQueue();
  queue.push('短', { level: 'info' }); // 4s
  queue.push('长', { level: 'error' }); // 6s
  timers.tick(4_500);
  const texts = queue.getItems().map((it) => it.text);
  assert.deepEqual(texts, ['长']); // info 已过期移除，error 仍在
  timers.tick(2_000);
  assert.equal(queue.getItems().length, 0);
});

/* ---- 棋盘定位锚点（toastAnchor：棋盘正上方 / 无棋盘回退） ---- */

test('FE-TOAST-09 toastAnchor：棋盘模式换算（底边贴棋盘上缘、中心对齐棋盘）', () => {
  const anchor = toastAnchor(
    { left: 200, top: 300, width: 600, height: 600 },
    { rootWidth: 420, viewportW: 1440, viewportH: 900 },
  );
  assert.equal(anchor.mode, 'board');
  assert.equal(anchor.left, 500);              // 堆叠中心 X = 棋盘中心
  assert.equal(anchor.bottom, 900 - 300 + 8);  // 堆叠底边 = 棋盘上缘 − 8px（视口底起算）
});

test('FE-TOAST-10 toastAnchor：水平钳制在视口内（左右越界）', () => {
  const opts = { rootWidth: 420, viewportW: 1440, viewportH: 900 };
  const right = toastAnchor({ left: 1200, top: 300, width: 600, height: 600 }, opts);
  assert.equal(right.left, 1440 - 210 - 8);
  const left = toastAnchor({ left: -100, top: 300, width: 600, height: 600 }, opts);
  assert.equal(left.left, 210 + 8);
});

test('FE-TOAST-11 toastAnchor：无棋盘/零尺寸 → 回退顶部模式', () => {
  const opts = { rootWidth: 420, viewportW: 1440, viewportH: 900 };
  assert.deepEqual(toastAnchor(null, opts), { mode: 'top' });
  assert.deepEqual(toastAnchor({ left: 0, top: 0, width: 0, height: 0 }, opts), { mode: 'top' });
});

test('FE-TOAST-12 toastAnchor：堆叠超出上方空间时整体下移（不裁切到视口外）', () => {
  const anchor = toastAnchor(
    { left: 0, top: 132, width: 1440, height: 600 },
    { rootWidth: 420, rootHeight: 200, viewportW: 1440, viewportH: 900 },
  );
  // 默认 bottom＝900−132+8＝776（top＝−76 越界）→ 下移后 bottom＝900−8−200＝692
  assert.equal(anchor.bottom, 692);
  assert.equal(anchor.left, 720);   // 未触发水平钳制
});

/* ---- 语义图标映射（`[SVG 语义色图标] + 文案`：每级别必有图标，未知级别兜底 info） ---- */

test('FE-TOAST-13 TOAST_ICON_ID：级别 → 语义图标 symbol 一一对应', () => {
  assert.equal(TOAST_ICON_ID.success, 'i-success');
  assert.equal(TOAST_ICON_ID.info, 'i-info');
  assert.equal(TOAST_ICON_ID.warning, 'i-warn');
  assert.equal(TOAST_ICON_ID.error, 'i-error');
  // 与时长表同集合：新增级别必须同步补图标，否则会渲染出无图标（且无配色）的条目
  assert.deepEqual(Object.keys(TOAST_ICON_ID).sort(), Object.keys(TOAST_DURATION_MS).sort());
});
