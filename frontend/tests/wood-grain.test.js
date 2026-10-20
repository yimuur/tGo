/**
 * tGo · wood-grain（棋盘垂直木纹）无头单测（node --test）
 * 用例 ID: FE-GRAIN-*
 * 覆盖：种子确定性 / 等距通道防聚簇 / 垂直方向（沿 y 延伸） / 断线结构 / 强度与线宽区间 /
 *       年轮条带 / 非法入参容错 / 绘制顺序（条带先于细纹）与绘图状态复位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WOOD_GRAIN,
  GRAIN_STRIDE,
  grainRandom,
  woodGrainPlan,
  paintWoodGrain,
} from '../static/js/core/wood-grain.js';

/** 19 路棋盘参考几何：layoutForSize(19, 660) → cell 33.33 / side 660。 */
const SIDE = 660;
const CELL = SIDE / 19.8;

const at = (arr, i, k) => arr[i * GRAIN_STRIDE + k];

test('FE-GRAIN-01 参数区间合理（间距/抖动/强度/断线/条带）', () => {
  assert.ok(WOOD_GRAIN.seed > 0, '种子为正整数');
  assert.ok(WOOD_GRAIN.channelStepCells > 0 && WOOD_GRAIN.channelStepCells < 0.5, '通道间距按 cell 归一且远小于 1 格');
  assert.ok(WOOD_GRAIN.channelJitter > 0 && WOOD_GRAIN.channelJitter < 0.5, '抖动小于半步长（不破坏等距性）');
  assert.ok(WOOD_GRAIN.alphaLo > 0 && WOOD_GRAIN.alphaHi <= 1, '相对强度 ∈ (0,1]（globalAlpha 语义）');
  assert.ok(WOOD_GRAIN.bandAlphaLo > 0 && WOOD_GRAIN.bandAlphaHi <= 1);
  assert.ok(WOOD_GRAIN.brokenRatio > 0 && WOOD_GRAIN.brokenRatio < 1);
  assert.ok(WOOD_GRAIN.bandEvery >= 2, '条带间隔 ≥ 2 通道（条带不得退化成细纹）');
  assert.ok(WOOD_GRAIN.bandWidthLo >= 0.5, '条带宽度远大于细纹宽度（宽幅明暗而非线条）');
});

test('FE-GRAIN-02 grainRandom：同种子可复现、结果 ∈ [0,1)', () => {
  const a = grainRandom(12345);
  const b = grainRandom(12345);
  const c = grainRandom(54321);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB, '同种子同序列（纹路稳定）');
  assert.notDeepEqual([c(), c(), c()], seqA, '不同种子不同序列');
  const r = grainRandom(7);
  for (let i = 0; i < 500; i += 1) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `随机值 ${v} 落在 [0,1)`);
  }
  assert.equal(grainRandom(0)(), grainRandom(1)(), '种子 0/非法值回退 1');
});

test('FE-GRAIN-03 plan 确定性 + 平铺结构（Float32Array / 步长一致）', () => {
  const a = woodGrainPlan({ side: SIDE, cell: CELL });
  const b = woodGrainPlan({ side: SIDE, cell: CELL });
  assert.equal(a.strokeCount, b.strokeCount);
  assert.equal(a.bandCount, b.bandCount);
  assert.deepEqual([...a.strokes], [...b.strokes], '同参数逐元素一致（重绘不跳动）');
  assert.ok(a.strokes instanceof Float32Array, '笔触平铺进 Float32Array（避免 GC 压力）');
  assert.ok(a.bands instanceof Float32Array);
  assert.equal(a.strokes.length, a.strokeCount * GRAIN_STRIDE);
  assert.equal(a.bands.length, a.bandCount * GRAIN_STRIDE);
  assert.ok(a.strokeCount > 0 && a.bandCount > 0);
});

test('FE-GRAIN-04 等距基准通道：无空档/无聚簇（防回退为全随机定位）', () => {
  const plan = woodGrainPlan({ side: SIDE, cell: CELL });
  const { step } = plan;
  assert.ok(Math.abs(step - CELL * WOOD_GRAIN.channelStepCells) < 1e-9);
  const xs = [];
  for (let i = 0; i < plan.strokeCount; i += 1) xs.push(at(plan.strokes, i, 0));
  xs.sort((p, q) => p - q);
  let maxGap = xs[0];
  for (let i = 1; i < xs.length; i += 1) maxGap = Math.max(maxGap, xs[i] - xs[i - 1]);
  // 每个宽度为 step 的区间至少含 1 个基准通道 → 相邻笔触间距 < 2·step
  // （全随机定位会留下数倍 step 的空档，此断言即其回归门禁）
  assert.ok(maxGap < 2 * step, `最大间距 ${maxGap.toFixed(2)}px 应 < 2·step=${(2 * step).toFixed(2)}px`);
  assert.ok(xs[0] >= 0, `首个笔触 x=${xs[0].toFixed(2)} 不越出画布左缘`);
  // 通道数 ≈ side/step（19 路 ≈ 275）
  assert.ok(Math.abs(xs.length - SIDE / step) / (SIDE / step) < 0.6, '笔触总数与通道数同量级（含断线段）');
});

test('FE-GRAIN-05 垂直方向：笔触沿 y 延伸、侧向漂移远小于长度', () => {
  const plan = woodGrainPlan({ side: SIDE, cell: CELL });
  const lateralMax = CELL * WOOD_GRAIN.lateralCells;
  const bowMax = CELL * WOOD_GRAIN.bowCells;
  let longCount = 0;
  for (let i = 0; i < plan.strokeCount; i += 1) {
    const len = at(plan.strokes, i, 2);
    assert.ok(len > 0, '笔触长度为为正');
    assert.ok(len >= SIDE * 0.15, `笔触长度 ${len.toFixed(1)}px 不得退化为短划`);
    const dMax = Math.max(
      Math.abs(at(plan.strokes, i, 5)),
      Math.abs(at(plan.strokes, i, 6)),
      Math.abs(at(plan.strokes, i, 7)),
    );
    // 全程侧向位移 ≤ lateralCells·cell，中段再叠加 bowCells·cell 弯曲
    const dLimit = lateralMax + bowMax;
    assert.ok(dMax <= dLimit * 1.001, `侧向漂移 ${dMax.toFixed(2)}px 应 ≤ ${dLimit.toFixed(2)}px`);
    assert.ok(len >= dMax * 8, '长度 ≫ 侧向漂移 ⇒ 视觉为垂直纹（非水平/斜纹）');
    if (len >= SIDE * WOOD_GRAIN.strokeSpanLo) longCount += 1;
  }
  // 多数「通道」（非断线者）以单笔跨越 0.78–1.10×板面 → 长纹为主、断线为辅
  const channels = Math.round(SIDE / plan.step);
  assert.ok(longCount / channels > 0.6, `长笔触通道占比 ${(longCount / channels).toFixed(2)} 应 > 0.6`);
});

test('FE-GRAIN-06 断线结构：占比符合 brokenRatio、断口为正且长度在区间内', () => {
  const plan = woodGrainPlan({ side: SIDE, cell: CELL });
  const channels = Math.round(SIDE / plan.step);
  let broken = 0;
  let minGap = Infinity;
  let maxGap = 0;
  // 断线判据（几何）：断口两侧的段连续存放，尾段起点 y 严格大于首段终点 y；
  // 非断线通道的下一笔触 y0 ∈ [-0.08, 0.22]·side 而上笔触终点 ≥ 0.7·side → 差值恒为负。
  for (let i = 0; i < plan.strokeCount - 1; i += 1) {
    const yA = at(plan.strokes, i, 1);
    const lenA = at(plan.strokes, i, 2);
    const wA = at(plan.strokes, i, 3);
    const aA = at(plan.strokes, i, 4);
    const wB = at(plan.strokes, i + 1, 3);
    const aB = at(plan.strokes, i + 1, 4);
    const gap = at(plan.strokes, i + 1, 1) - (yA + lenA);
    if (gap > 1e-6) {
      broken += 1;
      minGap = Math.min(minGap, gap);
      maxGap = Math.max(maxGap, gap);
      // 尾段：线宽 ×0.9、强度 ×0.85（与首段同走向同质感）
      assert.ok(Math.abs(wB - wA * 0.9) < 1e-3, '尾段线宽为首段 0.9 倍');
      assert.ok(Math.abs(aB - aA * 0.85) < 1e-3, '尾段强度为首段 0.85 倍');
      i += 1; // 尾段不再作为下一段的“首段”参与判定
    }
  }
  const ratio = broken / channels;
  assert.ok(broken > 0, '存在断线通道');
  assert.ok(Math.abs(ratio - WOOD_GRAIN.brokenRatio) < 0.08, `断线占比 ${ratio.toFixed(2)} 接近 brokenRatio`);
  const gapLo = CELL * WOOD_GRAIN.breakGapLo;
  const gapHi = CELL * WOOD_GRAIN.breakGapHi;
  assert.ok(minGap >= gapLo - 1e-6, `最小断口 ${minGap.toFixed(2)}px ≥ ${gapLo.toFixed(2)}px`);
  assert.ok(maxGap <= gapHi + 1e-6, `最大断口 ${maxGap.toFixed(2)}px ≤ ${gapHi.toFixed(2)}px`);
});

test('FE-GRAIN-07 强度与线宽：alphaFactor ∈ (0,1]、线宽为正且随 cell 缩放', () => {
  for (const cell of [CELL * 0.6, CELL, CELL * 2]) {
    const side = cell * 19.8;
    const plan = woodGrainPlan({ side, cell });
    for (let i = 0; i < plan.strokeCount; i += 1) {
      const a = at(plan.strokes, i, 4);
      const w = at(plan.strokes, i, 3);
      assert.ok(a > 0 && a <= WOOD_GRAIN.alphaHi, `强度 ${a} ∈ (0, ${WOOD_GRAIN.alphaHi}]`);
      assert.ok(a >= WOOD_GRAIN.alphaLo * 0.8, '强度下界（尾段 0.85 折减 → 留 20% 余量）');
      assert.ok(w > 0 && w <= cell * (WOOD_GRAIN.widthCells + WOOD_GRAIN.widthVarCells) + 1e-6);
    }
    // 缩放随动：cell 翻倍 ⇒ 线宽/间距等比（木纹随棋盘放大，非固定像素纹）
    const double = woodGrainPlan({ side: side * 2, cell: cell * 2 });
    assert.ok(Math.abs(at(double.strokes, 0, 3) / at(plan.strokes, 0, 3) - 2) < 1e-3, '线宽随 cell 等比');
  }
});

test('FE-GRAIN-08 年轮条带：数量、宽度、长度、强度区间', () => {
  const plan = woodGrainPlan({ side: SIDE, cell: CELL });
  const channels = Math.round(SIDE / plan.step);
  assert.equal(plan.bandCount, Math.ceil(channels / WOOD_GRAIN.bandEvery));
  for (let i = 0; i < plan.bandCount; i += 1) {
    const w = at(plan.bands, i, 3);
    const len = at(plan.bands, i, 2);
    const a = at(plan.bands, i, 4);
    assert.ok(w >= CELL * WOOD_GRAIN.bandWidthLo - 1e-6 && w <= CELL * WOOD_GRAIN.bandWidthHi + 1e-6, '条带宽度 ∈ 区间');
    assert.ok(w > CELL * WOOD_GRAIN.widthCells * 4, '条带宽度远大于细纹宽度（宽幅明暗）');
    assert.ok(len >= SIDE * WOOD_GRAIN.bandSpanLo - 1e-6 && len <= SIDE * WOOD_GRAIN.bandSpanHi + 1e-6);
    assert.ok(a >= WOOD_GRAIN.bandAlphaLo - 1e-6 && a <= WOOD_GRAIN.bandAlphaHi + 1e-6);
  }
});

test('FE-GRAIN-09 非法/极端入参不抛错（0/负/NaN → 空 plan）', () => {
  for (const bad of [{ side: 0, cell: CELL }, { side: -10, cell: CELL }, { side: NaN, cell: CELL }, { side: SIDE, cell: 0 }, { side: SIDE, cell: NaN }, {}]) {
    const plan = woodGrainPlan(bad);
    assert.equal(plan.strokeCount, 0);
    assert.equal(plan.bandCount, 0);
    assert.equal(plan.strokes.length, 0);
  }
  const tiny = woodGrainPlan({ side: 0.5, cell: 0.02 });
  assert.ok(tiny.strokeCount >= 1 && Number.isFinite(tiny.step), '极小画布仍生成有效 plan');
});

test('FE-GRAIN-12 矩形木料面（方案 B）：通道随宽度、笔触随高度（2026/09/22）', () => {
  const W = 996;
  const H = 700;
  const plan = woodGrainPlan({ width: W, height: H, cell: CELL });
  // 通道数随宽度（与 side=W 时一致），而不是随高度
  assert.ok(Math.abs(plan.strokeCount / (woodGrainPlan({ side: W, cell: CELL }).strokeCount) - 1) < 0.5);
  assert.equal(plan.width, W);
  assert.equal(plan.height, H);
  assert.equal(plan.side, H, 'side 兼容字段 = 面高');
  let longCount = 0;
  for (let i = 0; i < plan.strokeCount; i += 1) {
    const y0 = at(plan.strokes, i, 1);
    const len = at(plan.strokes, i, 2);
    const x = at(plan.strokes, i, 0);
    assert.ok(x >= -CELL * 0.5 && x <= W + CELL * 0.5, '笔触 x 落在面宽内（含抖动）');
    // 纵向铺满：起点不超出面高 22%（strokeTopHi），长度 ≈ 0.78–1.10 × 面高
    assert.ok(y0 >= -H * (WOOD_GRAIN.strokeTopHi + 0.02), `起点 y ${y0} 不越出面顶`);
    assert.ok(len <= H * WOOD_GRAIN.strokeSpanHi + 1e-6, '笔触长度随面高（不随面宽）');
    if (len >= H * WOOD_GRAIN.strokeSpanLo) longCount += 1;
  }
  const channels = Math.round(W / plan.step);
  assert.ok(longCount / channels > 0.6, '绝大多数通道纵向跨过大半面高');
  assert.equal(woodGrainPlan({ width: 0, height: H, cell: CELL }).strokeCount, 0, '宽 0 → 空 plan');
  assert.equal(woodGrainPlan({ width: W, height: -1, cell: CELL }).strokeCount, 0, '高非法 → 空 plan');
});

/** 假 canvas ctx：记录调用顺序与每笔触的绘图状态（无 DOM 依赖）。 */
function fakeCtx() {
  const log = [];
  const ctx = {
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    lineCap: '',
    calls: [],
    log,
    save() { ctx.calls.push('save'); },
    restore() { ctx.calls.push('restore'); },
    beginPath() { ctx.calls.push('beginPath'); },
    moveTo() { ctx.calls.push('moveTo'); },
    bezierCurveTo() { ctx.calls.push('bezierCurveTo'); },
    stroke() {
      ctx.calls.push('stroke');
      log.push({ style: ctx.strokeStyle, alpha: ctx.globalAlpha, width: ctx.lineWidth, cap: ctx.lineCap });
    },
  };
  return ctx;
}

test('FE-GRAIN-10 paintWoodGrain：条带先于细纹、笔触数与 plan 一致、save/restore 配对', () => {
  const plan = woodGrainPlan({ side: SIDE, cell: CELL });
  const ctx = fakeCtx();
  paintWoodGrain(ctx, plan, { lineStyle: 'rgba(1,2,3,.09)', bandStyle: 'rgba(4,5,6,.07)' });
  assert.equal(ctx.log.length, plan.strokeCount + plan.bandCount, 'stroke 调用数 = 细纹 + 条带');
  assert.equal(ctx.calls.filter((c) => c === 'save').length, 1);
  assert.equal(ctx.calls.filter((c) => c === 'restore').length, 1);
  assert.equal(ctx.calls[0], 'save');
  assert.equal(ctx.calls[ctx.calls.length - 1], 'restore');
  const bandCalls = ctx.log.slice(0, plan.bandCount);
  const lineCalls = ctx.log.slice(plan.bandCount);
  assert.ok(bandCalls.every((c) => c.style === 'rgba(4,5,6,.07)'), '年轮条带使用 bandStyle 且先绘制');
  assert.ok(lineCalls.every((c) => c.style === 'rgba(1,2,3,.09)'), '细木纹后绘制（压在条带之上、网格线之下）');
  for (const c of ctx.log) {
    assert.ok(c.cap === 'round', '圆头笔触（避免硬切角）');
    assert.ok(c.alpha > 0 && c.alpha <= 1, `globalAlpha ${c.alpha} ∈ (0,1]（>1 会被 canvas 忽略）`);
  }
  // 每笔触：beginPath → moveTo → bezierCurveTo → stroke
  const seq = ctx.calls.filter((c) => c !== 'save' && c !== 'restore');
  assert.equal(seq.length, ctx.log.length * 4);
  for (let i = 0; i < seq.length; i += 4) {
    assert.deepEqual(seq.slice(i, i + 4), ['beginPath', 'moveTo', 'bezierCurveTo', 'stroke']);
  }
});

test('FE-GRAIN-11 paintWoodGrain 容错：空 plan/null ctx/缺样式零调用', () => {
  const ctx = fakeCtx();
  const empty = woodGrainPlan({ side: 0, cell: 0 });
  paintWoodGrain(ctx, empty, { lineStyle: 'x', bandStyle: 'y' });
  paintWoodGrain(null, woodGrainPlan({ side: SIDE, cell: CELL }), { lineStyle: 'x', bandStyle: 'y' });
  paintWoodGrain(ctx, woodGrainPlan({ side: SIDE, cell: CELL }), {});
  paintWoodGrain(ctx, undefined, undefined);
  assert.equal(ctx.calls.length, 0, '无内容/无颜色时不触碰 ctx');
});
