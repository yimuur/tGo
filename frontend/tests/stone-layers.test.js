/**
 * FE 单测：云子「影子层 / 石体层」分层绘制契约（BUG-140，node --test）
 * 用例 ID: FE-STONE-07..09（模块层）、FE-BOARD-53（棋盘状态层）
 *
 * 需求（2026/10/07 人工确认）：「对弈/复盘 绘制云子时，其阴影不能遮挡云子本身」。
 * 事实：`layoutForSize` 石径 = 0.48·cell（净隙 0.04·cell ≈ 1.3px @19 路/660），
 * 而 yunzi 外投影外扩（offsetY 0.2R + blur 0.3R）≈ 0.39R ≈ 6.8px → 逐子单趟绘制时，
 * 后画棋子的烘焙投影压在**相邻棋子石面**上。
 *
 * 契约：
 *   1) `stone-style` 提供分层入口——`paintStoneShadow`（仅石外投影：石体圆盘挖空）、
 *      `paintStoneBody`（仅石体 + 内缘微透）；`paintStone` = 两层（影子在石体之下）。
 *   2) 棋盘状态层静态棋子**两趟**绘制：先全部影子、再全部石体；每颗子两层同几何。
 *
 * 断言方式：记录型 ctx（**非真实 Canvas/DOM**，无头可跑）。每次 `drawImage` 按该离屏
 * sprite 自身烘焙特征分类（`destination-out` 挖洞 → 影子层；径向渐变 → 石体层），
 * 再断言全序关系，从而在无像素环境下守卫「影子不落石体」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STONE_FALLBACK,
  YUNZI_GEOM,
  paintStone,
  paintStoneBody,
  paintStoneShadow,
} from '../static/js/core/stone-style.js';
import GameBoard, { layoutForSize } from '../static/js/core/board.js';

/* ---------------- 记录型 ctx ---------------- */

const DROP_COLORS = [STONE_FALLBACK.dropB, STONE_FALLBACK.dropW];

class RecCtx {
  constructor() {
    this.ops = [];
    this.draws = []; // { kind, dx, dy, dw, dh }
    this.arcs = []; // { x, y, r }（挖洞/投影源圆心半径）
    this.fills = []; // { shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY, fillStyle }
    // canvas 状态（模块可能读写；仅需可赋值）
    this.shadowColor = 'rgba(0,0,0,0)';
    this.shadowBlur = 0;
    this.shadowOffsetX = 0;
    this.shadowOffsetY = 0;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.font = '';
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this.lineCap = 'butt';
    this.lineJoin = 'miter';
    this._scale = 1;
  }

  _op(name) { this.ops.push(name); }
  save() { this._op('save'); }
  restore() { this._op('restore'); }
  setTransform() { this._op('setTransform'); }
  scale(x) { this._scale = x; this._op('scale'); }
  translate() { this._op('translate'); }
  clearRect() { this._op('clearRect'); }
  beginPath() { this._op('beginPath'); }
  closePath() { this._op('closePath'); }
  arc(x, y, r) { this.arcs.push({ x, y, r }); this._op('arc'); }
  rect() { this._op('rect'); }
  moveTo() { this._op('moveTo'); }
  lineTo() { this._op('lineTo'); }
  clip() { this._op('clip'); }
  stroke() { this._op('stroke'); }
  fillText() { this._op('fillText'); }
  strokeText() { this._op('strokeText'); }
  createRadialGradient() { this._op('radial'); return { addColorStop() {} }; }
  getTransform() { return { a: this._scale, b: 0, c: 0, d: this._scale, e: 0, f: 0 }; }
  fill() {
    this.fills.push({
      shadowColor: this.shadowColor,
      shadowBlur: this.shadowBlur,
      shadowOffsetX: this.shadowOffsetX,
      shadowOffsetY: this.shadowOffsetY,
      composite: this.globalCompositeOperation,
    });
    this._op('fill');
  }
  drawImage(canvas, dx, dy, dw, dh) {
    this.draws.push({ kind: canvas.__kind, dx, dy, dw, dh });
  }
}

/** 记录型离屏 canvas：`__kind` 由该 canvas 自身烘焙调用特征推导（与实现解耦的语义分类）。 */
function makeCanvas() {
  const ctx = new RecCtx();
  return {
    width: 0,
    height: 0,
    ctx,
    getContext() { return ctx; },
    get __kind() {
      const drop = ctx.fills.some((f) => DROP_COLORS.includes(f.shadowColor));
      const body = ctx.ops.includes('radial');
      if (drop && !body) return 'shadow'; // 只画了外投影（无石体）
      if (body && !drop) return 'body'; // 只画了石体（无外投影）
      if (body && drop) return 'combined'; // 单张合体
      return 'other';
    },
  };
}

/** 在假 canvas 环境下执行 fn（`_sprites()` 用全局 document.createElement）。 */
function withFakeCanvas(fn) {
  const prev = globalThis.document;
  globalThis.document = { createElement: () => makeCanvas() };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  }
}

/* ---------------- FE-STONE-07..09：模块分层契约 ---------------- */

test('FE-STONE-07 paintStoneShadow：投影源离屏、偏移回石心 —— 画布上只出现影子（无占位填色/无挖洞）', () => {
  const R = 10;
  const ctx = new RecCtx();
  paintStoneShadow(ctx, { x: 30, y: 40, r: R, color: 'black' });

  assert.ok(!ctx.ops.includes('radial'), '影子层不得绘制石体径向渐变');
  assert.equal(ctx.fills.length, 1, '只允许一次填充（投影源，本身落在画布外）');
  const src = ctx.arcs[0];
  assert.ok(src.x < -100, `投影源须置于画布外（x=${src.x}），画布上不得留占位填色`);
  assert.equal(src.r, R, '投影源半径 = 石径');
  const [fill] = ctx.fills;
  assert.equal(fill.shadowColor, STONE_FALLBACK.dropB, '黑子外投影色取 drop token');
  assert.equal(fill.shadowOffsetY, R * YUNZI_GEOM.dropOy, '投影纵向偏移 = 0.2R');
  // 源在画布外 → 偏移量 = 离屏距离 + 目标偏移：影子落回 (x + 0.1R, y + 0.2R)
  assert.ok(
    Math.abs(src.x + fill.shadowOffsetX - (30 + R * YUNZI_GEOM.dropOx)) < 1e-9,
    '影子须精确落回石心右下方（0.1R / 0.2R）',
  );
  assert.ok(!ctx.ops.includes('destination-out'), '无需挖洞（源本就在画布外）');
});

test('FE-STONE-08 paintStoneBody：只画石体（三档渐变 + 内缘微透），不投 drop 外影', () => {
  const ctx = new RecCtx();
  paintStoneBody(ctx, { x: 30, y: 30, r: 10, color: 'black' });
  assert.ok(ctx.ops.includes('radial'), '石体须为三档径向渐变');
  assert.ok(ctx.ops.includes('clip'), '内缘微透须 clip 在石体圆内');
  assert.ok(
    !ctx.fills.some((f) => DROP_COLORS.includes(f.shadowColor)),
    '石体层不得投黑/白子 drop 外影',
  );
});

test('FE-STONE-09 paintStone：单张合体（外投影随石体一次 fill 烘焙）——半透明虚子下层不透出自身投影', () => {
  const ctx = new RecCtx();
  paintStone(ctx, { x: 30, y: 30, r: 10, color: 'white' });
  assert.deepEqual(ctx.ops.slice(0, 1), ['save']);
  const bodyFill = ctx.fills[0];
  assert.equal(bodyFill.shadowColor, STONE_FALLBACK.dropW, '石体填充自身携带 drop（合体烘焙）');
  assert.ok(ctx.ops.includes('radial'), '石体渐变与 drop 同一次 fill');
  assert.equal(ctx.fills.length, 2, '仅石体 + 内缘微透两次填充');
});

/* ---------------- FE-BOARD-53：棋盘状态层两趟绘制 ---------------- */

/** 构造只含状态层的外壳棋盘（不触真实 DOM/Canvas）。 */
function makeShell(stones, n = 19) {
  const ctx = new RecCtx();
  const board = Object.create(GameBoard.prototype);
  board.el = null;
  board._geom = layoutForSize(n, 660);
  board._dpr = 2;
  board._layers = { state: { ctx } };
  board._props = {
    stones,
    lastMarker: 'none',
    comments: [],
    deadStones: [],
    interactive: false,
    hoverGhost: false,
    top5: [],
    variations: [],
    heatVisible: false,
    toMove: 'black',
    showCoordinates: false,
  };
  board._anims = { drops: [], captures: [] };
  board._ringFx = new Map();
  board._top5Seen = new Map();
  board._heat = null;
  board._cursor = null;
  board._ghost = null;
  board._illegal = null;
  board._lastKey = null;
  board._flyingKeys = null;
  board._sprite = null;
  board._dirty = { static: true, state: true };
  board._motion = false;
  board._resolveColors = () => ({
    grid: '#000',
    coord: '#000',
    accent: '#1F4E5F',
    accentContrast: '#fff',
    font: 'sans-serif',
    grade: { brilliant: '#3B82F6', good: '#22A06B', slow: '#D9A400', mistake: '#F2711C', blunder: '#D64545' },
  });
  board._now = () => 1000;
  return { board, ctx };
}

test('FE-BOARD-53 静态棋子两趟绘制：全部影子 blit 早于任何石体 blit，且每子两层同几何（BUG-140）', () => {
  // 相邻三角（含纵/斜向近邻，正是净隙 1.3px < 投影外扩 6.8px 的暴露场景）
  const stones = [
    { x: 3, y: 3, color: 'black' },
    { x: 3, y: 4, color: 'white' },
    { x: 4, y: 4, color: 'black' },
  ];
  const { board, ctx } = makeShell(stones);
  withFakeCanvas(() => board._drawState(1000));

  const classOf = (k) => k;
  const shadowIdx = ctx.draws.map((d, i) => ({ ...d, i })).filter((d) => classOf(d.kind) === 'shadow');
  const bodyIdx = ctx.draws.map((d, i) => ({ ...d, i })).filter((d) => classOf(d.kind) === 'body');
  assert.equal(ctx.draws.length, stones.length * 2, '每颗子恰好 2 次 blit（影子 + 石体）');
  assert.equal(shadowIdx.length, stones.length, '影子 blit 数 = 棋子数');
  assert.equal(bodyIdx.length, stones.length, '石体 blit 数 = 棋子数');
  assert.ok(
    Math.max(...shadowIdx.map((d) => d.i)) < Math.min(...bodyIdx.map((d) => d.i)),
    '影子层必须先于石体层全部画完（否则后画子的投影会压在前画子石面上）',
  );

  // 每颗子两层同几何（同圆心同尺寸）——分类后按矩形配对
  const rects = (list) => list
    .map((d) => [d.dx, d.dy, d.dw, d.dh])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(rects(shadowIdx), rects(bodyIdx), '同一颗子的影子与石体须同步几何');
  assert.ok(shadowIdx.every((d) => d.kind === 'shadow'), '分类稳定（影子层不含石体像素）');
});

test('FE-BOARD-54 单子绘制（含半透明虚子/飞行）用合体 sprite：石体不透明 → 下层不透出自身投影', () => {
  const R = layoutForSize(19, 660).stoneR;
  const { board, ctx } = makeShell([]);
  withFakeCanvas(() => board._drawStoneImage(ctx, 100, 100, R, 'white', 0.45));
  assert.deepEqual(ctx.draws.map((d) => d.kind), ['combined'], '默认层 = 单张合体（半透明虚子观感不变）');

  ctx.draws.length = 0;
  withFakeCanvas(() => board._drawStoneImage(ctx, 100, 100, R, 'black', 1, 1, 'shadow'));
  assert.deepEqual(ctx.draws.map((d) => d.kind), ['shadow'], '显式影子层只画影子');

  ctx.draws.length = 0;
  withFakeCanvas(() => board._drawStoneImage(ctx, 100, 100, R, 'black', 1, 1, 'body'));
  assert.deepEqual(ctx.draws.map((d) => d.kind), ['body'], '显式石体层只画石体');
});
