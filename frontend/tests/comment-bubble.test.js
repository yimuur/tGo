/**
 * tGo · comment-bubble.js 无头单测（2026/09/13 人工反馈：对弈/复盘点评气泡统一）
 * 用例 ID: FE-CBUB-*
 * 覆盖：气泡内联结构（转义/两行/单行）与锚定几何（棋子附近：优先右上、上方不足
 * 改左下、四周钳制、几何未就绪返回 null）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { commentBubbleHTML, boardBubblePlacement, BUBBLE_GRADES } from '../static/js/core/comment-bubble.js';

/* ---------- HTML ---------- */

test('FE-CBUB-01 结构：色点 + 两行文案（.board-bubble 共用结构，无关闭钮）', () => {
  const html = commentBubbleHTML({ grade: 'good', line1: '白 第 10 手 · 正着（好棋）', line2: 'ΔW +1.2% · ΔS +0.3 目' });
  assert.match(html, /class="b-dot" style="background:var\(--c-good\)"/);
  assert.match(html, /<span class="b-text"><span class="b-line1">白 第 10 手 · 正着（好棋）<\/span><span class="b-line2">ΔW \+1\.2% · ΔS \+0\.3 目<\/span><\/span>/);
  assert.equal(html.includes('button'), false, '统一气泡不带任何按钮（右侧不留关闭钮空白）');
});

test('FE-CBUB-02 line2 缺省剔除；grade/文案均转义', () => {
  const only1 = commentBubbleHTML({ grade: 'slow', line1: '第 7 手 · 缓着（不当）' });
  assert.equal(only1.includes('b-line2'), false);
  const escaped = commentBubbleHTML({ grade: 'a"b', line1: '<img src=x>', line2: '&"' });
  assert.equal(escaped.includes('<img'), false);
  assert.ok(escaped.includes('&lt;img src=x&gt;'));
  assert.ok(escaped.includes('&amp;&quot;'));
});

test('FE-CBUB-05 grade 白名单（L-9）：非法/注入值回退 good，不得拼接进样式', () => {
  const evil = commentBubbleHTML({ grade: 'x);background:url(javascript:alert(1))', line1: 'x' });
  assert.match(evil, /background:var\(--c-good\)/);
  assert.equal(evil.includes('javascript'), false);
  const unknown = commentBubbleHTML({ grade: 'weird', line1: 'x' });
  assert.match(unknown, /background:var\(--c-good\)/);
  for (const g of BUBBLE_GRADES) {
    assert.match(
      commentBubbleHTML({ grade: g, line1: 'x' }),
      new RegExp(`background:var\\(--c-${g}\\)`),
      `${g} 应直通`,
    );
  }
});

/* ---------- 定位 ---------- */

const wrap = { w: 400, h: 400 };
const point = { left: 200, top: 200, stoneR: 18 };

test('FE-CBUB-03 默认：气泡在棋子右上（左缘对石心内缩 6、底边距棋子 6）', () => {
  const p = boardBubblePlacement(point, wrap, { w: 200, h: 60 });
  assert.deepEqual(p, { left: 194, top: 200 - 18 - 60 - 6 });
});

test('FE-CBUB-04 上方放不下：改棋子下方（右缘超界 → 钳制在容器内）', () => {
  const topStone = { left: 200, top: 10, stoneR: 18 };
  const p = boardBubblePlacement(topStone, wrap, { w: 200, h: 60 });
  assert.deepEqual(p, { left: 194, top: 10 + 18 + 6 });
  const rightStone = { left: 390, top: 300, stoneR: 18 };
  const q = boardBubblePlacement(rightStone, wrap, { w: 200, h: 60 });
  assert.equal(q.left, 400 - 200 - 4);
});

test('FE-CBUB-05 下缘钳制与几何未就绪：钳制到容器内 / null 兜底', () => {
  // 气泡高于石子上方空间 → 改下方后仍越过下缘 → 钳制到 h - bh - 4
  const p = boardBubblePlacement(point, wrap, { w: 200, h: 200 });
  assert.deepEqual(p, { left: 194, top: 400 - 200 - 4 });
  assert.equal(boardBubblePlacement(null, wrap, { w: 1, h: 1 }), null);
  assert.equal(boardBubblePlacement(point, null, { w: 1, h: 1 }), null);
  assert.equal(boardBubblePlacement(point, { w: 0, h: 0 }, { w: 1, h: 1 }), null);
});
