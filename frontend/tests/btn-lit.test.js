/**
 * FE-LIT（core/btn-lit 图标点亮口径，2026/09/17 人工决策）
 * 覆盖：点亮计划（数据到达判定）、幂等类名应用、到达动效重放与定时清理。
 * 用例 ID: FE-LIT-*
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ICON_LIT_IN_MS, iconLitPlan, applyIconLit, ensureIconLitWrap } from '../static/js/core/btn-lit.js';

/** 最小假元素：只实现 applyIconLit 用到的 classList / offsetWidth（无 DOM 依赖）。 */
function fakeButton() {
  const set = new Set();
  return {
    offsetWidth: 20,
    _classes: set,
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !set.has(c) : Boolean(on);
        if (want) set.add(c);
        else set.delete(c);
        return want;
      },
    },
  };
}

/** 可控计时器（无硬等待）。 */
function fakeTimers() {
  const tasks = new Map();
  let seq = 0;
  return {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      tasks.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => tasks.delete(id),
    fireAll: () => {
      for (const { fn } of [...tasks.values()]) fn();
      tasks.clear();
    },
    size: () => tasks.size,
  };
}

test('FE-LIT-01 | iconLitPlan：点亮态与「数据到达」判定', () => {
  // 未点亮 → 点亮：视为到达（animate）
  assert.deepEqual(iconLitPlan({ lit: true }, false), { lit: true, animate: true });
  // 已点亮 → 仍点亮：不重放动效（避免每次 store 变更都闪一下）
  assert.deepEqual(iconLitPlan({ lit: true }, true), { lit: true, animate: false });
  // 熄灭：从不点亮
  assert.deepEqual(iconLitPlan({ lit: false }, true), { lit: false, animate: false });
  assert.deepEqual(iconLitPlan(), { lit: false, animate: false });
});

test('FE-LIT-02 | applyIconLit：点亮类名 + 到达动效 + 到时移除', () => {
  const btn = fakeButton();
  const timers = fakeTimers();
  applyIconLit(btn, iconLitPlan({ lit: true }, false), timers);
  assert.ok(btn.classList.contains('is-lit'));
  assert.ok(btn.classList.contains('is-lit-in'), '到达帧必须补一次性动效类');
  assert.equal(timers.size(), 1, '必须有动效清理定时器');
  timers.fireAll();
  assert.ok(!btn.classList.contains('is-lit-in'), '动效结束后移除类（回到静态点亮）');
  assert.ok(btn.classList.contains('is-lit'));
});

test('FE-LIT-03 | applyIconLit：已点亮帧不打断进行中的到达动效', () => {
  const btn = fakeButton();
  const timers = fakeTimers();
  applyIconLit(btn, iconLitPlan({ lit: true }, false), timers);
  // 紧随其后的重渲染（仍点亮、非到达帧）→ 类保持、定时器不被清掉
  applyIconLit(btn, iconLitPlan({ lit: true }, true), timers);
  assert.ok(btn.classList.contains('is-lit-in'));
  assert.equal(timers.size(), 1);
});

test('FE-LIT-04 | applyIconLit：熄灭清理类名与待处理定时器', () => {
  const btn = fakeButton();
  const timers = fakeTimers();
  applyIconLit(btn, iconLitPlan({ lit: true }, false), timers);
  applyIconLit(btn, iconLitPlan({ lit: false }, true), timers);
  assert.ok(!btn.classList.contains('is-lit'));
  assert.ok(!btn.classList.contains('is-lit-in'));
  assert.equal(timers.size(), 0, '熄灭后不得残留定时器');
});

test('FE-LIT-05 | applyIconLit：重复到达可重放动效；无元素时安全退出', () => {
  const btn = fakeButton();
  const timers = fakeTimers();
  applyIconLit(btn, iconLitPlan({ lit: true }, false), timers);
  timers.fireAll();
  applyIconLit(btn, iconLitPlan({ lit: false }, true), timers);
  applyIconLit(btn, iconLitPlan({ lit: true }, false), timers);
  assert.ok(btn.classList.contains('is-lit-in'), '第二次到达同样要点亮（重放）');
  // 容错：空元素 / 非元素
  assert.doesNotThrow(() => applyIconLit(null, iconLitPlan({ lit: true }, false), timers));
  assert.doesNotThrow(() => applyIconLit({}, iconLitPlan({ lit: true }, false), timers));
  assert.equal(ICON_LIT_IN_MS, 480);
});

/* ---- 晕影载体（SVG 不支持伪元素 → 幂等包裹 .icon-lit） ---- */

/** 最小假节点（className 承载类名，appendChild/insertBefore/setAttribute 足验包裹）。 */
function fakeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    attrs: {},
    classList: {
      add: (c) => { if (!el.classList.contains(c)) el.className = `${el.className} ${c}`.trim(); },
      remove: (c) => { el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains: (c) => el.className.split(/\s+/).includes(c),
      toggle: (c, on) => {
        const want = on === undefined ? !el.classList.contains(c) : Boolean(on);
        if (want) el.classList.add(c);
        else el.classList.remove(c);
        return want;
      },
    },
    appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
    insertBefore(child, ref) {
      const i = el.children.indexOf(ref);
      el.children.splice(i < 0 ? el.children.length : i, 0, child);
      child.parentNode = el;
      return child;
    },
    setAttribute: (k, v) => { el.attrs[k] = v; },
  };
  return el;
}

/** 假按钮 + 假图标 + 假 document（querySelector 固定返回图标）。 */
function fakeIconHost() {
  const btn = fakeEl('button');
  const icon = fakeEl('svg');
  btn.appendChild(icon);
  btn.querySelector = () => icon;
  return { btn, icon, doc: { createElement: (t) => fakeEl(t) } };
}

test('FE-LIT-06 | ensureIconLitWrap：幂等包裹 svg.icon 为 .icon-lit（晕影伪元素落点）', () => {
  const { btn, icon, doc } = fakeIconHost();
  const wrap = ensureIconLitWrap(btn, doc);
  assert.equal(wrap.className, 'icon-lit');
  assert.equal(icon.parentNode, wrap, '图标必须移入载体');
  assert.equal(wrap.parentNode, btn, '载体占位与原图标一致（不改变布局顺序）');
  assert.equal(wrap.attrs['aria-hidden'], 'true', '装饰层对读屏隐藏');
  // 再次调用：原样返回同一载体（不产生 DOM churn）
  assert.equal(ensureIconLitWrap(btn, doc), wrap);
  // 无图标 / 无 DOM 环境 → null（node 无头环境下不得抛错）
  assert.equal(ensureIconLitWrap(fakeEl('button'), doc), null);
  assert.equal(ensureIconLitWrap(btn, null), null);
});

test('FE-LIT-07 | applyIconLit 自动包裹（常驻：未点亮帧也重放；innerHTML 重建后恢复）', () => {
  const { btn, icon, doc } = fakeIconHost();
  const timers = fakeTimers();
  applyIconLit(btn, iconLitPlan({ lit: true }, false), timers, doc);
  const wrap = icon.parentNode;
  assert.equal(wrap.className, 'icon-lit');
  // 模拟按钮 innerHTML 重建：新图标未包裹 → 下一次点亮（仍点亮、非到达帧）必须重放
  const rebuilt = fakeEl('svg');
  btn.children = [rebuilt];
  rebuilt.parentNode = btn;
  btn.querySelector = () => rebuilt;
  applyIconLit(btn, iconLitPlan({ lit: true }, true), timers, doc);
  assert.equal(rebuilt.parentNode.className, 'icon-lit', '重建后仍点亮必须重放载体');
  // 熄灭不清除载体（下次点亮幂等复用），但类名必须摘掉
  applyIconLit(btn, iconLitPlan({ lit: false }, true), timers, doc);
  assert.ok(!btn.classList.contains('is-lit'));
  // 常驻口径（2026/09/18，iOS 防位移）：**未点亮帧同样包裹**——载体自视图就绪即就位，
  // 点亮瞬间零 DOM 结构变更（曾仅在点亮帧包裹 → 点亮瞬间插入节点引发轻微位移）
  const host2 = fakeIconHost();
  applyIconLit(host2.btn, iconLitPlan({ lit: false }, false), timers, host2.doc);
  assert.equal(host2.icon.parentNode.className, 'icon-lit', '未点亮帧也必须包裹（载体常驻）');
});
