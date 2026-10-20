/**
 * tGo · 连接横幅控制器无头单测（node --test）
 * 用例 ID: FE-CONN-*
 *
 * 背景（2026/09/13 人工反馈，BUG-059）：主动从对弈/复盘页切换到管理页时误报
 * 「连接中断，正在重连…」——`game` 通道随视图卸载被**主动关闭**
 * （`closed {manual:true}`），旧实现不区分「主动关闭 / 意外断线」→ 计入断开集合；
 * 该通道此后不会重连，横幅永久误挂（切换回对弈类视图还会误弹「连接已恢复」）。
 *
 * 本组用例锁定控制器规则：
 *   - 主动关闭（manual）不计为中断、不挂横幅、不弹恢复 Toast；
 *   - 意外断线/重连中 → 横幅（只挂一次）；恢复 → 收起 + 恢复 Toast；
 *   - 首连失败（从未 open 过）不误报；多通道相互独立；
 *   - **降级逃生**（2026/09/14）：断线持续 ≥ escalateMs 未恢复 → 升级为
 *     「连接长时间未恢复，可尝试重新加载页面」+ [重新加载]；阈值内恢复不升级；
 *     多通道需全部恢复才清零计时；主动关闭不计时；离线/在线仅切换文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnBannerController } from '../static/js/core/conn-banner.js';

/* ---------- 测试替身：记录横幅 show/收起 与 Toast ---------- */

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
      const i = this.tasks.indexOf(next);
      this.tasks.splice(i, 1);
      this.nowMs = next.at;
      next.fn();
    }
    this.nowMs = target;
  }
}

function makeHarness({ escalateMs, timers } = {}) {
  const events = [];
  const reloads = [];
  const tm = timers || new FakeTimers();
  const controller = createConnBannerController({
    showBanner: (spec) => {
      events.push({ kind: 'banner', spec });
      return () => events.push({ kind: 'banner-dismiss' });
    },
    showToast: (toast) => events.push({ kind: 'toast', toast }),
    reload: () => reloads.push('reload'),
    timers: tm,
    ...(escalateMs === undefined ? {} : { escalateMs }),
  });
  return {
    controller,
    events,
    reloads,
    timers: tm,
    banners: () => events.filter((e) => e.kind === 'banner'),
    dismisses: () => events.filter((e) => e.kind === 'banner-dismiss'),
    toasts: () => events.filter((e) => e.kind === 'toast'),
  };
}

/* ---------- 用例 ---------- */

test('FE-CONN-01 主动关闭（视图切换）不挂横幅、不弹恢复 Toast', () => {
  const h = makeHarness();
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: true });
  // 回到对弈页重新建连（新 client open）
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  assert.equal(h.banners().length, 0, '主动关闭不得显示连接中断横幅');
  assert.equal(h.toasts().length, 0, '主动关闭后重连不得弹“连接已恢复”');
});

test('FE-CONN-02 意外断线 → 横幅；重连中保持；恢复 → 收起 + 恢复 Toast', () => {
  const h = makeHarness();
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: false });
  assert.equal(h.banners().length, 1);
  assert.equal(h.banners()[0].spec.text, '连接中断，正在重连…');
  h.controller.handleStatus({ type: 'reconnecting', channel: 'game', attempt: 1 });
  assert.equal(h.banners().length, 1, '重连中不重复挂横幅');
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  assert.equal(h.dismisses().length, 1, '恢复即收起横幅');
  assert.equal(h.toasts().length, 1);
  assert.equal(h.toasts()[0].toast.text, '连接已恢复');
});

test('FE-CONN-03 首连失败（从未 open 过）不显示横幅', () => {
  const h = makeHarness();
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: false });
  h.controller.handleStatus({ type: 'reconnecting', channel: 'game', attempt: 1 });
  assert.equal(h.banners().length, 0);
});

test('FE-CONN-04 多通道独立：game 主动关闭不影响 admin 断线横幅', () => {
  const h = makeHarness();
  h.controller.handleStatus({ type: 'open', channel: 'admin' });
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  h.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false }); // 管理通道真断
  assert.equal(h.banners().length, 1);
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: true }); // 切页主动关 game
  assert.equal(h.dismisses().length, 0, 'admin 仍断 → 横幅保持');
  h.controller.handleStatus({ type: 'open', channel: 'admin' }); // 管理通道恢复
  assert.equal(h.dismisses().length, 1);
});

test('FE-CONN-05 game 真断线中切页（主动关闭）→ 横幅收起（该通道不再需要）', () => {
  const h = makeHarness();
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: false });
  assert.equal(h.banners().length, 1);
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: true });
  assert.equal(h.dismisses().length, 1, '视图卸载后不得继续假装“正在重连”');
});

test('FE-CONN-06 多通道并发恢复只弹一次「连接已恢复」（2026/09/14）', () => {
  const h = makeHarness();
  h.controller.handleStatus({ type: 'open', channel: 'admin' });
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  // 服务器重启/断网：两个通道同时断开
  h.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false });
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: false });
  assert.equal(h.banners().length, 1, '仅一条横幅');
  // admin 先恢复：仍有通道未恢复 → 不得提前提示
  h.controller.handleStatus({ type: 'open', channel: 'admin' });
  assert.equal(h.toasts().length, 0, '尚有通道未恢复时不得提示“连接已恢复”');
  // game 后恢复：全部恢复 → 只提示一次（修复前按通道各弹一次 → 2 次）
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  assert.equal(h.toasts().length, 1, '全部恢复只弹一次「连接已恢复」');
  assert.equal(h.toasts()[0].toast.text, '连接已恢复');
  assert.equal(h.dismisses().length, 1, '恢复即收起横幅');
  // 下一轮断/恢复仍会在“全部恢复”时正常提示（不被去重吞掉）
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: false });
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  assert.equal(h.toasts().length, 2, '每一轮恢复各提示一次');
});

/* ---------- 降级逃生（2026/09/14，移动端网络可用性）：长时间未恢复 →「重新加载」---------- */

test('FE-CONN-07 长时间未恢复 → 升级「重新加载」逃生；恢复后重置', () => {
  const h = makeHarness({ escalateMs: 1_000 });
  h.controller.handleStatus({ type: 'open', channel: 'admin' });
  h.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false });
  assert.equal(h.banners().length, 1);
  assert.equal(h.banners()[0].spec.text, '连接中断，正在重连…');

  h.timers.tick(999); // 未到阈值：不升级
  assert.equal(h.banners().length, 1);

  h.timers.tick(1); // 阈值到达：升级（旧横幅先收起再挂逃生横幅）
  assert.equal(h.banners().length, 2);
  assert.equal(h.dismisses().length, 1);
  const esc = h.banners()[1].spec;
  assert.equal(esc.text, '连接长时间未恢复，可尝试重新加载页面');
  assert.equal(esc.actions.length, 1);
  assert.equal(esc.actions[0].label, '重新加载');
  assert.equal(esc.actions[0].primary, true);
  esc.actions[0].onClick();
  assert.deepEqual(h.reloads, ['reload'], '按钮触发注入的 reload');

  // 恢复：收起 + 恢复 Toast；下一轮断线重新从普通横幅开始计时
  h.controller.handleStatus({ type: 'open', channel: 'admin' });
  assert.equal(h.dismisses().length, 2);
  assert.equal(h.toasts().length, 1);
  h.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false });
  assert.equal(h.banners().length, 3);
  assert.equal(h.banners()[2].spec.text, '连接中断，正在重连…');
  h.timers.tick(1_000);
  assert.equal(h.banners().length, 4, '再次长时间未恢复可再次升级');
});

test('FE-CONN-08 阈值内恢复不升级；多通道需全部恢复才清零计时', () => {
  // 单通道：阈值前恢复 → 全程无升级横幅
  const a = makeHarness({ escalateMs: 1_000 });
  a.controller.handleStatus({ type: 'open', channel: 'admin' });
  a.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false });
  a.timers.tick(500);
  a.controller.handleStatus({ type: 'open', channel: 'admin' });
  a.timers.tick(10_000);
  assert.equal(a.banners().length, 1, '阈值内恢复 → 仅出现过一次普通横幅');

  // 双通道：一个恢复后另一个仍断 → 计时继续，到阈值仍升级
  const b = makeHarness({ escalateMs: 1_000 });
  b.controller.handleStatus({ type: 'open', channel: 'admin' });
  b.controller.handleStatus({ type: 'open', channel: 'game' });
  b.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false });
  b.controller.handleStatus({ type: 'closed', channel: 'game', manual: false });
  b.timers.tick(600);
  b.controller.handleStatus({ type: 'open', channel: 'admin' }); // 尚有 game 未恢复
  b.timers.tick(400);
  assert.equal(b.banners().length, 2, '未全部恢复 → 到阈值照常升级');
  assert.equal(b.banners()[1].spec.actions[0].label, '重新加载');
  b.controller.handleStatus({ type: 'open', channel: 'game' }); // 全部恢复
  assert.equal(b.dismisses().length, 2);
  b.timers.tick(60_000);
  assert.equal(b.banners().length, 2, '恢复后不得再挂横幅');
});

test('FE-CONN-09 离线/在线仅切换文案（不影响判定）', () => {
  const h = makeHarness({ escalateMs: 60_000 });
  h.controller.handleStatus({ type: 'open', channel: 'admin' });
  h.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false });
  h.controller.handleNetwork(false);
  assert.equal(h.banners().length, 2);
  assert.equal(h.banners()[1].spec.text, '网络已断开，等待网络恢复…');
  h.controller.handleNetwork(false); // 重复事件不重挂
  assert.equal(h.banners().length, 2);
  h.controller.handleNetwork(true);
  assert.equal(h.banners()[2].spec.text, '连接中断，正在重连…');

  // 原生离线不得凭空产生横幅（无任何断线时仅记录文案状态）
  const h2 = makeHarness();
  h2.controller.handleNetwork(false);
  assert.equal(h2.banners().length, 0);

  // 升级态：离线文案不覆盖逃生文案（信息量以逃生为准）
  const h3 = makeHarness({ escalateMs: 500 });
  h3.controller.handleStatus({ type: 'open', channel: 'admin' });
  h3.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false });
  h3.timers.tick(500);
  h3.controller.handleNetwork(false);
  assert.equal(h3.banners().length, 2, '升级态离线切换不重挂');
  assert.equal(h3.banners()[1].spec.text, '连接长时间未恢复，可尝试重新加载页面');
});

test('FE-CONN-10 首连失败：阈值前不误报；阈值后给出逃生入口；主动关闭不计时', () => {
  // 页面打开时服务器不可达：阈值前无横幅（FE-CONN-03 语义），阈值后升级
  const h = makeHarness({ escalateMs: 1_000 });
  h.controller.handleStatus({ type: 'reconnecting', channel: 'game', attempt: 1 });
  h.timers.tick(900);
  assert.equal(h.banners().length, 0, '首连失败阈值前不得误报「中断」');
  h.timers.tick(100);
  assert.equal(h.banners().length, 1);
  assert.equal(h.banners()[0].spec.text, '连接长时间未恢复，可尝试重新加载页面');

  // 主动关闭（视图卸载）后该通道不再需要 → 不升级
  const h2 = makeHarness({ escalateMs: 1_000 });
  h2.controller.handleStatus({ type: 'open', channel: 'game' });
  h2.controller.handleStatus({ type: 'closed', channel: 'game', manual: false });
  h2.controller.handleStatus({ type: 'closed', channel: 'game', manual: true });
  h2.timers.tick(5_000);
  assert.equal(h2.banners().length, 1, '主动关闭后不得升级（无未恢复通道）');
});

test('FE-CONN-11 终态关闭（4404 对局不存在）不算连接中断（BUG-092）', () => {
  // 场景：曾打开过 game 通道 → 对局被删除后重进对弈页 → 服务端终态关闭 4404
  const h = makeHarness({ escalateMs: 1_000 });
  h.controller.handleStatus({ type: 'open', channel: 'game' });
  h.controller.handleStatus({ type: 'closed', channel: 'game', manual: false, terminal: true, code: 4404 });
  assert.equal(h.banners().length, 0, '终态关闭不得显示「连接中断」横幅');
  h.timers.tick(5_000);
  assert.equal(h.banners().length, 0, '终态关闭不得参与升级计时');
  assert.equal(h.toasts().length, 0);

  // 与真断线共存：终态关闭不得把 admin 的断线横幅收起
  const h2 = makeHarness();
  h2.controller.handleStatus({ type: 'open', channel: 'admin' });
  h2.controller.handleStatus({ type: 'closed', channel: 'admin', manual: false });
  h2.controller.handleStatus({ type: 'closed', channel: 'game', terminal: true, code: 4404 });
  assert.equal(h2.banners().length, 1, 'admin 仍断 → 横幅保持');
  h2.controller.handleStatus({ type: 'open', channel: 'admin' });
  assert.equal(h2.dismisses().length, 1, 'admin 恢复后收起');
});
