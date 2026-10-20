/**
 * tGo · capture-counter.js 提子/当前方控件纯函数层无头单测（T6.4 修订，node --test）
 * 用例 ID: FE-CAP-*
 * 覆盖（T6.4 修订验收·纯逻辑）：**固定显示尺寸**（大子半径/字号为脚本开头常量，不随
 * 视窗缩放）、几何派生（随 big 但文字恒为固定字号）、主题键与回退调色板映射。
 * 顶层无 DOM，可无头断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE_BIG_PX,
  CAPTURE_SMALL_RATIO,
  CAPTURE_NUM_PX,
  CAPTURE_LABEL_PX,
  captureMetrics,
  captureThemeKey,
  capturePalette,
  easeInOutCubic,
  FALLBACK_PALETTES,
  CaptureCounter,
} from '../static/js/core/capture-counter.js';

test('FE-CAP-01 | 固定显示尺寸：大子/小子/字号为脚本开头常量，不随视窗缩放', () => {
  // 固定常量合法性
  assert.ok(CAPTURE_BIG_PX > 0 && Number.isFinite(CAPTURE_BIG_PX));
  assert.ok(CAPTURE_SMALL_RATIO > 0 && CAPTURE_SMALL_RATIO < 1);
  // 组件固定调用 captureMetrics()（无入参）→ 取 CAPTURE_BIG_PX
  const s = captureMetrics();
  assert.equal(s.big, CAPTURE_BIG_PX);
  assert.equal(Math.round(s.small * 10), Math.round(CAPTURE_BIG_PX * CAPTURE_SMALL_RATIO * 10));
  assert.ok(s.small > 0 && s.small < s.big);
  assert.equal(s.num, CAPTURE_NUM_PX);
  assert.equal(s.label, CAPTURE_LABEL_PX);
  // 显式传 big 仍按该 big 推导几何（文字不变）；无任何宽度输入参与
  const s2 = captureMetrics(18);
  assert.equal(s2.big, 18);
  assert.equal(s2.num, CAPTURE_NUM_PX);
  assert.equal(s2.label, CAPTURE_LABEL_PX);
});

test('FE-CAP-02 | captureMetrics：几何随 big 单调推导；非法输入回退固定默认', () => {
  const a = captureMetrics(12);
  const b = captureMetrics(30);
  assert.ok(b.small > a.small && b.padX >= a.padX && b.stoneRegion > a.stoneRegion);
  assert.ok(b.centerDist > b.big); // 双字中心距大于半径
  assert.equal(Math.round(a.stoneRegion), Math.round(a.big + a.centerDist + a.big));
  assert.equal(b.num, a.num, '字号与 big 无关（固定显示）');
  assert.equal(b.label, a.label);
  // NaN / 非法输入 → 回退固定默认 CAPTURE_BIG_PX
  const fb = captureMetrics(NaN);
  assert.equal(fb.big, CAPTURE_BIG_PX);
  assert.equal(fb.num, CAPTURE_NUM_PX);
  assert.equal(fb.label, CAPTURE_LABEL_PX);
});

test('FE-CAP-03 | captureMetrics：棋子几何随 big 缩放；文字固定基线字号', () => {
  const s = captureMetrics(18);
  assert.equal(s.big, 18);
  assert.ok(s.small > 0 && s.small < s.big); // 小子小于大子
  // 2026/09/06 人工反馈：数字/标签字号固定为脚本开头常量（14/12），不随 big/窗口缩放
  assert.equal(s.num, CAPTURE_NUM_PX);
  assert.equal(s.label, CAPTURE_LABEL_PX);
  assert.ok(s.centerDist > s.big); // 双字中心距大于半径（有重叠留白余量）
  assert.equal(Math.round(s.stoneRegion), Math.round(s.big + s.centerDist + s.big));
  // big 更小 → 棋子/间距几何项不增（monotonic），但文字字号恒定
  const s2 = captureMetrics(30);
  assert.ok(s2.small > s.small && s2.padX > s.padX);
  assert.equal(s2.num, s.num, '字号与 big 无关');
  assert.equal(s2.label, s.label);
  // 任意大子半径下文字恒为固定字号（固定显示语义）
  for (const big of [CAPTURE_BIG_PX, 12, 18, 22]) {
    assert.equal(captureMetrics(big).num, CAPTURE_NUM_PX);
    assert.equal(captureMetrics(big).label, CAPTURE_LABEL_PX);
  }
  // 非法 big → 回退固定默认（不抛错）
  const fb = captureMetrics(NaN);
  assert.equal(fb.big, CAPTURE_BIG_PX);
  assert.equal(fb.num, CAPTURE_NUM_PX);
});

test('FE-CAP-04 | captureThemeKey / capturePalette 映射', () => {
  assert.equal(captureThemeKey('dark'), 'dark');
  assert.equal(captureThemeKey('light'), 'light');
  assert.equal(captureThemeKey(''), 'light');
  assert.equal(captureThemeKey(undefined), 'light');
  assert.equal(captureThemeKey('system'), 'light'); // 已解析 light/dark，其余兜底浅色
  // 回退调色板：与主题键一致且非空
  assert.deepEqual(capturePalette('dark'), FALLBACK_PALETTES.dark);
  assert.deepEqual(capturePalette('light'), FALLBACK_PALETTES.light);
  assert.ok(capturePalette('dark').text && capturePalette('dark').muted);
  assert.ok(capturePalette('weird').text); // 未知 → light 回退
});
test('FE-CAP-05 | easeInOutCubic 单调 0→1 无负值（防 BUG-003 公式笔误回归）', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(1), 1);
  // 在 [0,1] 上严格递增且不出现负进度（曾误写为指数 2/-2t+3 → 后半程为负、回摆）
  let prev = -1;
  for (let i = 0; i <= 100; i += 1) {
    const t = i / 100;
    const v = easeInOutCubic(t);
    assert.ok(v >= 0 && v <= 1, `t=${t} v=${v} 越界`);
    assert.ok(v >= prev - 1e-9, `t=${t} 非单调递增`);
    prev = v;
  }
  // 中心对称（ease 曲线：v(t) = 1 - v(1-t)）
  for (const t of [0.1, 0.3, 0.6, 0.9]) {
    assert.ok(Math.abs(easeInOutCubic(t) + easeInOutCubic(1 - t) - 1) < 1e-9);
  }
});

/* ============================================================
 * M-11：rAF 按需调度（假 DOM 环境；无头可测）
 * ============================================================ */

/** 最小假环境：可控 rAF 队列 / matchMedia(reduced) / document.hidden / 可见性事件。 */
function makeEnv({ reducedMotion = false, hidden = false } = {}) {
  const listeners = {};
  const doc = {
    hidden,
    documentElement: { getAttribute: () => 'light' },
    defaultView: null,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
  };
  let now = 0;
  let idc = 0;
  const frames = new Map();
  const win = {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame(cb) {
      const id = ++idc;
      frames.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    performance: { now: () => now },
    devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  doc.defaultView = win;
  const canvas = {
    ownerDocument: doc,
    getContext: () => ({}),
    style: {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    doc,
    win,
    canvas,
    listeners,
    frames,
    pump() {
      const cbs = [...frames.values()];
      frames.clear();
      now += 16;
      cbs.forEach((cb) => cb(now));
    },
    fireVisibility() {
      (listeners.visibilitychange || []).slice().forEach((fn) => fn());
    },
  };
}

test('FE-CAP-06 | M-11 常态：呼吸动画持续请求帧（设计保留）；状态变化不叠加双重帧', () => {
  const env = makeEnv();
  const counter = new CaptureCounter(env.canvas);
  let draws = 0;
  counter._draw = () => { draws += 1; };
  assert.equal(env.frames.size, 1, '构造即申请首帧');
  env.pump();
  assert.equal(draws, 1);
  assert.equal(env.frames.size, 1, '常态（呼吸）每帧后继续申请下一帧');
  counter.setCaptures({ black: 3 });
  assert.equal(env.frames.size, 1, '已有在途帧时不重复申请');
  env.pump();
  assert.equal(draws, 2);
});

test('FE-CAP-07 | M-11 reduce-motion：无过渡时不持续绘制，状态变化仅重绘单帧', () => {
  const env = makeEnv({ reducedMotion: true });
  const counter = new CaptureCounter(env.canvas);
  let draws = 0;
  counter._draw = () => { draws += 1; };
  assert.equal(env.frames.size, 1, '构造仍需一帧首绘');
  env.pump();
  assert.equal(draws, 1);
  assert.equal(env.frames.size, 0, 'reduce-motion 下降帧（旧实现无条件 60fps 重绘）');
  counter.setCaptures({ black: 2 });
  assert.equal(env.frames.size, 1, '状态变化 → 单帧重绘');
  env.pump();
  assert.equal(draws, 2);
  assert.equal(env.frames.size, 0);
  counter.setCurrent('white');
  env.pump();
  assert.equal(draws, 3, '执色切换（reduce-motion 无过渡）仍需一帧；之后停帧');
  assert.equal(env.frames.size, 0);
});

test('FE-CAP-08 | M-11 页面隐藏：停帧；回可见续帧（旧实现后台 60fps 重绘）', () => {
  const env = makeEnv();
  const counter = new CaptureCounter(env.canvas);
  counter._draw = () => {};
  env.pump();
  assert.equal(env.frames.size, 1);
  env.doc.hidden = true;
  env.fireVisibility();
  assert.equal(env.frames.size, 0, '隐藏时取消在途帧并停止循环');
  counter.setCaptures({ black: 1 });
  assert.equal(env.frames.size, 0, '隐藏期间状态变化不申请帧');
  env.doc.hidden = false;
  env.fireVisibility();
  assert.equal(env.frames.size, 1, '回可见续帧');
  env.pump();
  assert.equal(env.frames.size, 1, '常态继续呼吸循环');
});

test('FE-CAP-09 | M-11 destroy：停帧并移除可见性监听（无残留）', () => {
  const env = makeEnv();
  const counter = new CaptureCounter(env.canvas);
  assert.equal((env.listeners.visibilitychange || []).length, 1);
  counter.destroy();
  assert.equal(env.frames.size, 0);
  assert.equal((env.listeners.visibilitychange || []).length, 0);
  counter.setCaptures({ black: 9 });
  assert.equal(env.frames.size, 0, '销毁后不再申请帧');
});