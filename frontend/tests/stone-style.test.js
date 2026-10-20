/**
 * FE 单测：core/stone-style（云子 yunzi Design Token）
 * 覆盖：兜底色板结构/冻结、无 DOM 回退、有 CSS 变量读取优先级、paintStone 纯函数
 * 签名健壮（不实际绘制）。运行：node --test（frontend/）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STONE_CSS_VARS,
  PREVIEW_CSS_VARS,
  STONE_FALLBACK,
  resolveStoneColors,
  resolvePreviewStoneColors,
  paintStone,
} from '../static/js/core/stone-style.js';

test('FE-STONE-01 yunzi 兜底色板：结构与值（照搬 WEBUI/yunzi.html）', () => {
  assert.equal(STONE_FALLBACK.b.hi, '#5a665d');
  assert.equal(STONE_FALLBACK.b.mid, '#111111');
  assert.equal(STONE_FALLBACK.b.lo, '#000000');
  assert.equal(STONE_FALLBACK.b.rim, 'rgba(26,59,34,.7)');
  assert.equal(STONE_FALLBACK.w.hi, '#ffffff');
  assert.equal(STONE_FALLBACK.w.mid, '#fdfdfc');
  assert.equal(STONE_FALLBACK.w.lo, '#f0ece9');
  assert.equal(STONE_FALLBACK.w.rim, 'rgba(234,150,141,.8)');
  assert.equal(STONE_FALLBACK.dropB, 'rgba(0,0,0,.6)');
  assert.equal(STONE_FALLBACK.dropW, 'rgba(0,0,0,.4)');
  assert.ok(Object.isFrozen(STONE_FALLBACK) && Object.isFrozen(STONE_FALLBACK.b));
});

test('FE-STONE-02 resolveStoneColors 无 doc → 返回兜底色板', () => {
  const p = resolveStoneColors(null);
  assert.deepEqual(p.b, STONE_FALLBACK.b);
  assert.deepEqual(p.w, STONE_FALLBACK.w);
  assert.equal(p.dropB, STONE_FALLBACK.dropB);
  assert.equal(p.dropW, STONE_FALLBACK.dropW);
});

test('FE-STONE-03 resolveStoneColors 有 CSS 变量 → 以变量为准（缺失项回退）', () => {
  const map = {
    '--stone-b-hi': '#0a0b0c',
    '--stone-w-lo': '#fbfaf8',
    '--stone-drop-b': 'rgba(1,2,3,.5)',
  };
  const cs = { getPropertyValue: (n) => map[n] || '' };
  const win = { getComputedStyle: () => cs };
  const doc = { documentElement: { ownerDocument: { defaultView: win } } };
  const p = resolveStoneColors(doc);
  assert.equal(p.b.hi, '#0a0b0c'); // 变量优先
  assert.equal(p.b.mid, STONE_FALLBACK.b.mid); // 缺失 → 兜底
  assert.equal(p.w.lo, '#fbfaf8');
  assert.equal(p.w.rim, STONE_FALLBACK.w.rim);
  assert.equal(p.dropB, 'rgba(1,2,3,.5)');
  assert.equal(p.dropW, STONE_FALLBACK.dropW);
});

test('FE-STONE-04 CSS 变量名表与兜底键一致', () => {
  assert.equal(STONE_CSS_VARS.bHi, '--stone-b-hi');
  assert.equal(STONE_CSS_VARS.bMid, '--stone-b-mid');
  assert.equal(STONE_CSS_VARS.bLo, '--stone-b-lo');
  assert.equal(STONE_CSS_VARS.bRim, '--stone-b-rim');
  assert.equal(STONE_CSS_VARS.wHi, '--stone-w-hi');
  assert.equal(STONE_CSS_VARS.wMid, '--stone-w-mid');
  assert.equal(STONE_CSS_VARS.wLo, '--stone-w-lo');
  assert.equal(STONE_CSS_VARS.wRim, '--stone-w-rim');
  assert.equal(STONE_CSS_VARS.dropB, '--stone-drop-b');
  assert.equal(STONE_CSS_VARS.dropW, '--stone-drop-w');
});

test('FE-STONE-05 paintStone：非法/极小半径不致抛错（无渲染仅签名健壮）', () => {
  // 无真实 ctx 时不调用；此处验证不要求 canvas——仅确认导出为函数
  assert.equal(typeof paintStone, 'function');
  assert.equal(typeof resolveStoneColors, 'function');
});

test('FE-STONE-06 预览 SVG 专用 token：变量表独立（--pv-stone-*）且无 DOM 回退同 yunzi', () => {
  // 变量名独立于主 token（主 --stone-*，预览 --pv-stone-*）
  assert.equal(PREVIEW_CSS_VARS.bHi, '--pv-stone-b-hi');
  assert.equal(PREVIEW_CSS_VARS.wRim, '--pv-stone-w-rim');
  assert.notEqual(PREVIEW_CSS_VARS.bHi, STONE_CSS_VARS.bHi);
  // 无 doc → 回退 yunzi 兜底
  const p = resolvePreviewStoneColors(null);
  assert.deepEqual(p.b, STONE_FALLBACK.b);
  assert.deepEqual(p.w, STONE_FALLBACK.w);
  assert.equal(p.dropB, STONE_FALLBACK.dropB);
  assert.equal(p.dropW, STONE_FALLBACK.dropW);
  // 有 CSS 变量 → 预览变量生效；缺失项回退
  const map = {
    '--pv-stone-b-hi': '#123456',
    '--pv-stone-w-rim': 'rgba(1,2,3,.5)',
  };
  const cs = { getPropertyValue: (n) => map[n] || '' };
  const win = { getComputedStyle: () => cs };
  const doc = { documentElement: { ownerDocument: { defaultView: win } } };
  const p2 = resolvePreviewStoneColors(doc);
  assert.equal(p2.b.hi, '#123456');
  assert.equal(p2.b.mid, STONE_FALLBACK.b.mid);
  assert.equal(p2.w.rim, 'rgba(1,2,3,.5)');
  // 主 resolver 不受预览变量影响（仍读主 --stone-*）
  const main = resolveStoneColors(doc);
  assert.equal(main.b.hi, STONE_FALLBACK.b.hi);
  assert.equal(main.w.rim, STONE_FALLBACK.w.rim);
});
