/**
 * tGo · 棋盘木纹（垂直方向；静态层纹理）
 *
 * 参考 PROMPTS「种子随机木纹」思路，做以下工程化改造（2026/09/21 人工确认后的方案）：
 *   1) **转置为垂直方向**：参考稿笔触沿 x 延伸、随机 y 定位（水平纹）；本实现笔触沿 y
 *      延伸、沿 x 定位（垂直纹，自顶向下）。
 *   2) **等距基准通道 + 抖动**（替代 `rand()*s` 全随机定位）：全随机定位会出现聚簇，
 *      纹路间距忽疏忽密；改为「通道步长＝cell·channelStepCells」等距布点 + 亚步长抖动
 *      （抖动幅度≈半步长），疏密均匀且无规则网格感。
 *   3) **长笔触跨整板 + 偶发断线**：参考稿单笔仅 40–180px（整板 600+ px 时纹路碎成短
 *      线段）；本实现单笔覆盖大半板面（0.78–1.10·side，超出部分由画布自然裁剪），约
 *      30% 通道带一处断口（断口两侧各一段、走向连续），更接近整块木料的顺纹。
 *   4) **叠极淡年轮明暗条带**：等间隔宽笔触（0.8–1.7·cell 宽、极低 alpha、缓侧移）垫在
 *      细木纹之下，模拟木料年轮/顺纹的明暗起伏。
 *   5) **画在网格线之下**（board.js `_drawStatic` 内先木纹、后星位/网格/坐标标签），
 *      木纹不得压暗刻线。
 *   6) **随 cell 缩放**：通道间距/笔触长宽/侧向漂移全部以 cell 为单位推导——9/13/19 路
 *      观感一致；棋盘缩放（>100%）时木纹随之放大（等效「放大镜看木料」）。
 *   7) **定值种子**：`WOOD_GRAIN.seed` 恒定 → 同一盘面木纹稳定，重绘/切主题/换路数都不
 *      跳动；plan 平铺进 Float32Array（不在 rAF 内 new 大量小对象，见 AGENTS §4）。
 *
 * 颜色与基准强度全部来自 CSS token（`--wood-grain` / `--wood-grain-band`，含 baseline
 * alpha）；本模块只输出「相对强度倍率」（≤1，见 `WOOD_GRAIN.alphaHi`），绘制时以
 * `ctx.globalAlpha` 乘在 token 颜色自带的 alpha 上——因此调色/调强度只需改 app.css。
 * 本模块不含任何颜色常量。
 *
 * 本文件为纯函数层（顶层无 DOM），供 board.js 静态层渲染与无头单测（node --test）。
 */

/** 单笔触在 plan 中的分量数：x, y0, len, width, alphaFactor, d1, d2, d3。 */
export const GRAIN_STRIDE = 8;

/**
 * 木纹几何/强度参数（以 cell 归一；集中可调，禁止散落魔数）。
 * @property {number} seed             随机种子（定值 → 纹路稳定）
 * @property {number} channelStepCells 基准通道间距（×cell）：19 路 ≈ 3.7px
 * @property {number} channelJitter    通道位置抖动（×间距，±）
 * @property {number} strokeTopLo      笔触起点 y（×面高，负值＝从面外起笔）
 * @property {number} strokeTopHi      笔触起点 y 上界（×面高）
 * @property {number} strokeSpanLo     笔触长度下界（×面高）
 * @property {number} strokeSpanHi     笔触长度上界（×面高）
 * @property {number} lateralCells     全程侧向（x）位移幅度（×cell，±）
 * @property {number} bowCells         中段弯曲幅度（×cell，±；避免笔直如机织线）
 * @property {number} widthCells       笔触线宽基准（×cell，19 路 ≈ 1px）
 * @property {number} widthVarCells    线宽浮动（×cell）
 * @property {number} alphaLo          相对强度下界（× token alpha）
 * @property {number} alphaHi          相对强度上界（≤1，globalAlpha 上限语义）
 * @property {number} brokenRatio      带断口的通道占比
 * @property {number} breakFirstLo     断口中「首段」占全长比例下界
 * @property {number} breakFirstHi     断口中「首段」占全长比例上界
 * @property {number} breakGapLo       断口长度下界（×cell）
 * @property {number} breakGapHi       断口长度上界（×cell）
 * @property {number} bandEvery        年轮条带：每 N 个通道一条
 * @property {number} bandWidthLo      条带宽度下界（×cell）
 * @property {number} bandWidthHi      条带宽度上界（×cell）
 * @property {number} bandLateralCells 条带全程侧向位移（×cell，±；缓侧移＝年轮走形）
 * @property {number} bandSpanLo       条带长度下界（×面高）
 * @property {number} bandSpanHi       条带长度上界（×面高）
 * @property {number} bandAlphaLo      条带相对强度下界
 * @property {number} bandAlphaHi      条带相对强度上界（≤1）
 * @property {number} maxChannels      通道数上限（异常入参保护）
 */
export const WOOD_GRAIN = Object.freeze({
  seed: 20260921,
  channelStepCells: 0.11,
  channelJitter: 0.45,
  strokeTopLo: -0.08,
  strokeTopHi: 0.22,
  strokeSpanLo: 0.78,
  strokeSpanHi: 1.1,
  lateralCells: 0.45,
  bowCells: 0.35,
  widthCells: 0.022,
  widthVarCells: 0.014,
  alphaLo: 0.15,
  alphaHi: 0.9,
  brokenRatio: 0.3,
  breakFirstLo: 0.42,
  breakFirstHi: 0.68,
  breakGapLo: 0.12,
  breakGapHi: 0.5,
  bandEvery: 26,
  bandWidthLo: 0.8,
  bandWidthHi: 1.7,
  bandLateralCells: 1.6,
  bandSpanLo: 0.9,
  bandSpanHi: 1.15,
  bandAlphaLo: 0.35,
  bandAlphaHi: 0.8,
  maxChannels: 480,
});

const EMPTY_F32 = new Float32Array(0);

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 种子随机数发生器（Lehmer / 16807；同参考稿）。
 * 乘式上限 2147483647×16807 ≈ 3.6e13 < 2^53 → 浮点精确，结果与整数运算一致。
 * @param {number} seed 非零整数种子（0/非法值回退 1）
 * @returns {() => number} 依次返回 [0,1)
 */
export function grainRandom(seed) {
  let rnd = Math.floor(Number(seed));
  if (!Number.isFinite(rnd) || rnd <= 0) rnd = 1;
  return () => {
    rnd = (rnd * 16807) % 2147483647;
    return rnd / 2147483647;
  };
}

/**
 * 生成木纹笔触计划（纯函数、确定性）。
 *
 * 木料面可为**矩形**（2026/09/22 方案 B：整块木料＝棋盘容器整幅，木纹需铺满整个容器）：
 * `width` 决定通道分布与通道数，`height` 决定笔触起点/长度（保证纵向铺满）；
 * 旧调用 `{ side }` 仍兼容（width = height = side，行为与之前逐位相同）。
 *
 * 返回 plan：
 * - `strokeCount` / `strokes`：细木纹（垂直；带断口者拆为两段）——Float32Array，
 *   步长 `GRAIN_STRIDE`，字段见文件头；
 * - `bandCount` / `bands`：年轮明暗条带（宽笔触，同一步长格式）——绘制顺序须在细纹之前。
 *
 * 入参非法（width/height/cell ≤ 0 或非有限数）返回空 plan（不抛错，静态层照常绘制其余内容）。
 *
 * @param {{side?:number, width?:number, height?:number, cell?:number, seed?:number}} [opts]
 * @returns {{side:number, width:number, height:number, cell:number, seed:number, step:number,
 *   strokeCount:number, strokes:Float32Array, bandCount:number, bands:Float32Array}}
 */
export function woodGrainPlan({ side, width, height, cell, seed = WOOD_GRAIN.seed } = {}) {
  const cfg = WOOD_GRAIN;
  const w = Number(width != null ? width : side);
  const h = Number(height != null ? height : side);
  const cs = Number(cell);
  const ok =
    Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 && Number.isFinite(cs) && cs > 0;
  if (!ok) {
    return {
      side: Number.isFinite(h) && h > 0 ? h : 0,
      width: Number.isFinite(w) && w > 0 ? w : 0,
      height: Number.isFinite(h) && h > 0 ? h : 0,
      cell: 0,
      seed,
      step: 0,
      strokeCount: 0,
      strokes: EMPTY_F32,
      bandCount: 0,
      bands: EMPTY_F32,
    };
  }

  const rand = grainRandom(seed);
  const step = cs * cfg.channelStepCells;
  const channels = Math.min(cfg.maxChannels, Math.max(1, Math.round(w / step)));

  // 容量：断口通道拆两段 → 上界 ≈ 通道数 × 1.3；直接按 2× 预留后 subarray，避免二次拷贝
  const strokes = new Float32Array(channels * 2 * GRAIN_STRIDE);
  const bands = new Float32Array(Math.ceil(channels / cfg.bandEvery) * GRAIN_STRIDE);
  let n = 0;
  let bn = 0;

  /** 写入一条笔触（x, y0, len, width, alphaFactor, d1, d2, d3）。 */
  const push = (x, y0, len, w, a, d1, d2, d3) => {
    const o = n * GRAIN_STRIDE;
    strokes[o] = x;
    strokes[o + 1] = y0;
    strokes[o + 2] = len;
    strokes[o + 3] = w;
    strokes[o + 4] = a;
    strokes[o + 5] = d1;
    strokes[o + 6] = d2;
    strokes[o + 7] = d3;
    n += 1;
  };

  for (let i = 0; i < channels; i += 1) {
    const x = (i + 0.5) * step + (rand() - 0.5) * 2 * cfg.channelJitter * step;
    const span = lerp(cfg.strokeSpanLo, cfg.strokeSpanHi, rand()) * h;
    const y0 = lerp(cfg.strokeTopLo, cfg.strokeTopHi, rand()) * h;
    const w = cs * (cfg.widthCells + cfg.widthVarCells * rand());
    const a = lerp(cfg.alphaLo, cfg.alphaHi, rand());
    const lat = (rand() - 0.5) * 2 * cs * cfg.lateralCells;
    const bow1 = (rand() - 0.5) * 2 * cs * cfg.bowCells;
    const bow2 = (rand() - 0.5) * 2 * cs * cfg.bowCells;

    if (rand() < cfg.brokenRatio) {
      // 断口：同一走向（线性侧移弦）上切成两段——第 2 段起点＝弦上 t2 处，段内弯曲幅度
      // 按段长比例折减，故断口两侧走向连续、不出现错位折角
      const t1 = lerp(cfg.breakFirstLo, cfg.breakFirstHi, rand());
      const gap = cs * lerp(cfg.breakGapLo, cfg.breakGapHi, rand());
      const t2 = Math.min(0.94, t1 + gap / span);
      const tailLen = span * (1 - t2);
      push(
        x,
        y0,
        span * t1,
        w,
        a,
        lat * t1 * 0.33 + bow1 * t1 * 0.5,
        lat * t1 * 0.66 + bow2 * t1 * 0.5,
        lat * t1,
      );
      push(
        x + lat * t2,
        y0 + span * t2,
        tailLen,
        w * 0.9,
        a * 0.85,
        lat * (1 - t2) * 0.33 + bow1 * (1 - t2) * 0.5,
        lat * (1 - t2) * 0.66 + bow2 * (1 - t2) * 0.5,
        lat * (1 - t2),
      );
    } else {
      push(x, y0, span, w, a, lat * 0.33 + bow1, lat * 0.66 + bow2, lat);
    }
  }

  for (let i = 0; i < channels; i += cfg.bandEvery) {
    const x = (i + 0.5) * step + (rand() - 0.5) * 4 * cfg.channelJitter * step;
    const o = bn * GRAIN_STRIDE;
    bands[o] = x;
    bands[o + 1] = -h * 0.06 + rand() * h * 0.12;
    bands[o + 2] = h * lerp(cfg.bandSpanLo, cfg.bandSpanHi, rand());
    bands[o + 3] = cs * lerp(cfg.bandWidthLo, cfg.bandWidthHi, rand());
    bands[o + 4] = lerp(cfg.bandAlphaLo, cfg.bandAlphaHi, rand());
    const lat = (rand() - 0.5) * 2 * cs * cfg.bandLateralCells;
    bands[o + 5] = lat * 0.33;
    bands[o + 6] = lat * 0.66;
    bands[o + 7] = lat;
    bn += 1;
  }

  return {
    side: h,          // 兼容旧字段（正方形面时 side = width = height）
    width: w,
    height: h,
    cell: cs,
    seed,
    step,
    strokeCount: n,
    strokes: strokes.subarray(0, n * GRAIN_STRIDE),
    bandCount: bn,
    bands: bands.subarray(0, bn * GRAIN_STRIDE),
  };
}

/** 绘制一组笔触（垂直：沿 y 延伸的三次贝塞尔；侧向漂移为 d1/d2/d3）。 */
function strokeGroup(ctx, arr, count) {
  const BOW_T1 = 1 / 3;
  const BOW_T2 = 2 / 3;
  for (let i = 0; i < count; i += 1) {
    const o = i * GRAIN_STRIDE;
    const x = arr[o];
    const y0 = arr[o + 1];
    const len = arr[o + 2];
    ctx.globalAlpha = arr[o + 4];
    ctx.lineWidth = arr[o + 3];
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.bezierCurveTo(
      x + arr[o + 5],
      y0 + len * BOW_T1,
      x + arr[o + 6],
      y0 + len * BOW_T2,
      x + arr[o + 7],
      y0 + len,
    );
    ctx.stroke();
  }
}

/**
 * 在静态层绘制木纹：**年轮条带（宽、极淡）→ 细木纹（垂直）**，顺序不可颠倒。
 * 颜色/基准强度取自 token（`lineStyle` / `bandStyle`，自带 alpha）；每笔触以
 * `globalAlpha` 施加相对强度倍率（plan 内 alphaFactor ∈ [alphaLo, alphaHi] ⊆ [0,1]）。
 * 调用方负责 setTransform / 裁剪；本函数只做 save/restore。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof woodGrainPlan>} plan
 * @param {{lineStyle?:string, bandStyle?:string}} [styles]
 */
export function paintWoodGrain(ctx, plan, { lineStyle, bandStyle } = {}) {
  if (!ctx || !plan) return;
  const drawBands = Boolean(plan.bandCount && bandStyle);
  const drawLines = Boolean(plan.strokeCount && lineStyle);
  if (!drawBands && !drawLines) return; // 无内容/缺颜色：不触碰 ctx（含 save/restore）
  ctx.save();
  ctx.lineCap = 'round';
  if (drawBands) {
    ctx.strokeStyle = bandStyle;
    strokeGroup(ctx, plan.bands, plan.bandCount);
  }
  if (drawLines) {
    ctx.strokeStyle = lineStyle;
    strokeGroup(ctx, plan.strokes, plan.strokeCount);
  }
  ctx.restore(); // restore 复位 globalAlpha/lineWidth/strokeStyle/lineCap（网格线不继承木纹状态）
}
