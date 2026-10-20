/**
 * tGo · 云子棋子材质（Yunzi Design Token）读取与绘制
 *
 * 单一事实源 = css/app.css 的 Design Token（--stone-b-*、--stone-w-*、--stone-drop-*），
 * 供三类渲染统一取用：对弈/回放 Canvas 石（board.js sprite）、提子计数控件
 * （capture-counter.js）、列表/向导 SVG 缩略石（review-list-view 等）。
 * 脚本只在 CSS Token 缺失（无 DOM / 变量未定义）时回退到内置常量。
 *
 * 绘制入口（2026/10/07 分层，BUG-140）：`paintStoneShadow`＝仅石外投影（投影源离屏，画布上
 * 只出现影子）、`paintStoneBody`＝仅石体（+内缘微透）——供棋盘「先全部影子、再全部石体」
 * 两趟绘制；`paintStone`＝单张合体（外投影随石体一次 fill）——供单子独立绘制场景
 * （提子控件、半透明虚子/残影）。
 *
 * 色板依据 WEBUI/yunzi.html（2026/09/08 人工确认：完全照搬）：
 *   黑子 = 高光 #5a665d → 墨黑 #111111 → #000000，底部-右缘墨绿微透 rgba(26,59,34,.7)；
 *   白子 = 高光 #fff → 暖白 #fdfdfc → #f0ece9，底部-右缘丹红微透 rgba(234,150,141,.8)；
 *   物理投影（外部 drop）：黑 rgba(0,0,0,.6)、白 rgba(0,0,0,.4)。
 */

/** CSS 变量名（app.css Design Tokens）。 */
export const STONE_CSS_VARS = Object.freeze({
  bHi: '--stone-b-hi',
  bMid: '--stone-b-mid',
  bLo: '--stone-b-lo',
  bRim: '--stone-b-rim',
  wHi: '--stone-w-hi',
  wMid: '--stone-w-mid',
  wLo: '--stone-w-lo',
  wRim: '--stone-w-rim',
  dropB: '--stone-drop-b',
  dropW: '--stone-drop-w',
});

/** 预览 SVG 石子专用 CSS 变量（miniBoardSvg 等 SVG 渲染，路径与 Canvas/CSS 不一致，
 *  2026/09/08 起独立成组便于单独微调；初值与 yunzi 相同）。 */
export const PREVIEW_CSS_VARS = Object.freeze({
  bHi: '--pv-stone-b-hi',
  bMid: '--pv-stone-b-mid',
  bLo: '--pv-stone-b-lo',
  bRim: '--pv-stone-b-rim',
  wHi: '--pv-stone-w-hi',
  wMid: '--pv-stone-w-mid',
  wLo: '--pv-stone-w-lo',
  wRim: '--pv-stone-w-rim',
  dropB: '--pv-stone-drop-b',
  dropW: '--pv-stone-drop-w',
});

/** 内置兜底（app.css Token 缺失时；值同 yunzi 色板）。 */
export const STONE_FALLBACK = Object.freeze({
  b: Object.freeze({ hi: '#5a665d', mid: '#111111', lo: '#000000', rim: 'rgba(26,59,34,.7)' }),
  w: Object.freeze({ hi: '#ffffff', mid: '#fdfdfc', lo: '#f0ece9', rim: 'rgba(234,150,141,.8)' }),
  dropB: 'rgba(0,0,0,.6)',
  dropW: 'rgba(0,0,0,.4)',
});

/** 从 documentElement 计算样式读取云子 Token。
 * @param {Document|null} [doc] 无 DOM（node --test）时传 null → 返回兜底色板
 * @returns {{b:{hi,mid,lo,rim},w:{hi,mid,lo,rim},dropB:string,dropW:string}}
 */
export function resolveStoneColors(doc = null) {
  return readTokenColors(doc, STONE_CSS_VARS, STONE_FALLBACK);
}

/** 预览 SVG 石子专用：读取 PREVIEW_CSS_VARS（缺失回退同 yunzi 的 STONE_FALLBACK）。 */
export function resolvePreviewStoneColors(doc = null) {
  return readTokenColors(doc, PREVIEW_CSS_VARS, STONE_FALLBACK);
}

/** 通用读取：按 vars 变量表从 documentElement 计算样式取值，缺失项回退 fallback。 */
function readTokenColors(doc, vars, fallback) {
  let cs = null;
  try {
    if (doc && doc.documentElement && typeof doc.documentElement.ownerDocument === 'object') {
      cs = doc.defaultView
        ? doc.defaultView.getComputedStyle(doc.documentElement)
        : doc.documentElement.ownerDocument.defaultView
          ? doc.documentElement.ownerDocument.defaultView.getComputedStyle(doc.documentElement)
          : null;
    }
  } catch {
    cs = null;
  }
  const read = (name, fb) => {
    if (!cs) return fb;
    try {
      const v = cs.getPropertyValue(name).trim();
      return v || fb;
    } catch {
      return fb;
    }
  };
  return {
    b: {
      hi: read(vars.bHi, fallback.b.hi),
      mid: read(vars.bMid, fallback.b.mid),
      lo: read(vars.bLo, fallback.b.lo),
      rim: read(vars.bRim, fallback.b.rim),
    },
    w: {
      hi: read(vars.wHi, fallback.w.hi),
      mid: read(vars.wMid, fallback.w.mid),
      lo: read(vars.wLo, fallback.w.lo),
      rim: read(vars.wRim, fallback.w.rim),
    },
    dropB: read(vars.dropB, fallback.dropB),
    dropW: read(vars.dropW, fallback.dropW),
  };
}

/**
 * yunzi.html 石体 CSS 几何（以石径 R 归一；WEBUI/yunzi.html .piece 原样推导，2026/09/08）：
 *   - 径向渐变 `circle at 35% 35%`：圆心相对石心 (-0.3R, -0.3R)，半径 = 圆心至最远角
 *     ≈ hypot(1.3, 1.3)·R（≈1.8385R，非“到石缘”）；三档停点 黑 0/0.4/1、白 0/0.5/1；
 *   - 外投影 `2px 4px 6px`（@R20）：偏移 (0.1R, 0.2R)、CSS 模糊 0.3R；
 *   - 内 inset `-3px -4px 8px`（@R20，偏移 (−0.15R, −0.2R)、模糊 0.4R）——底部-右缘
 *     微透；Canvas 无原生 inset，2026/09/08 起用 **Off-screen Hole Shadow** 精确模拟
 *     （方法参考 WEBUI/yunzi-canvas.html，参数按 yunzi token）。
 * blurCanvasK：canvas shadowBlur ↔ CSS box-shadow blur 换算系数（同屏对照标定）。
 */
export const YUNZI_GEOM = Object.freeze({
  focalX: -0.3,
  focalY: -0.3,
  radius: Math.hypot(1.3, 1.3),
  stopB: 0.4,
  stopW: 0.5,
  dropOx: 0.1,
  dropOy: 0.2,
  dropBlur: 0.3,
  blurCanvasK: 1,
  // 内 inset（CSS `-3px -4px 8px` @R20，R 归一）——Off-screen Hole Shadow 参数
  insetOx: -0.15, // CSS offsetX −3px：洞缘阴影净左移 0.15R → 辉光显于右下内侧缘
  insetOy: -0.2, // CSS offsetY −4px：净上移 0.2R
  insetBlur: 0.4, // CSS blur 8px
});

/**
 * Off-screen Hole Shadow 的“离屏挖洞”距离（CSS px）。把挖洞矩形放到画布左侧远处
 * （HOLE_DIST），再用相等 shadowOffsetX 把洞缘阴影移回棋子；源在画布外仍正常出影
 * （WEBUI/yunzi-canvas.html 同款 500，iOS 兼容）。
 */
const HOLE_SHADOW_DIST = 500;

const TWO_PI = Math.PI * 2;

/**
 * 当前 CTM 的均匀缩放（shadow offset/blur 不随 CTM 缩放 → 乘 sc 补偿到设备像素）。
 *
 * ⚠️ shadow 单位修正（2026/09/08）：canvas 的 `shadowOffsetX/Y`、`shadowBlur` **不受
 * CTM 缩放影响**（spec/Chromium 均为设备像素语义）。若直接以 CSS px 设置，在 dpr≠1 时
 * 外投影与 Hole-Shadow 辉光按错误比例/落点渲染，且偏差是**固定设备像素量**——石径越大
 * （棋盘放大）越明显（“放大后透色偏移”）。调用方应保持无旋转的均匀缩放（如 `scale(dpr,dpr)`）。
 * @param {CanvasRenderingContext2D} ctx
 * @returns {number} 均匀缩放系数（无法读取时回退 1）
 */
function uniformScale(ctx) {
  try {
    const t = ctx.getTransform();
    return t && Number.isFinite(t.a) ? Math.hypot(t.a, t.b) : 1;
  } catch {
    return 1;
  }
}

/**
 * 石**外**物理投影（drop，黑 rgba(0,0,0,.6) / 白 rgba(0,0,0,.4)）——不含石体：把投影源的圆盘
 * 放到画布外左侧远处（HOLE_SHADOW_DIST），再用等量 `shadowOffsetX` 把影偏移回石心
 * （源在画布外仍正常出影，与内缘微透同一技法）→ 画布上**只留影子**，无占位填色、无挖洞。
 *
 * 分层理由（BUG-140，2026/10/07 人工口径「对弈/复盘 绘制云子时，其阴影不能遮挡云子本身」）：
 * 石径 0.48·cell（2026/09/24 放大）后邻子净隙仅 0.04·cell（≈1.3px @19 路/660），远小于
 * 投影外扩（offsetY 0.2R + blur 0.3R ≈ 0.39R ≈ 6.8px）——逐子单趟绘制时，后画棋子的
 * 烘焙投影必然压在相邻棋子石面上。分层后棋盘可「先全部影子、再全部石体」（见 board.js
 * `_drawState`），影子只落在木纹上；叠加顺序不变 → 单子观感与单张合体 sprite 逐像素一致。
 * @param {CanvasRenderingContext2D} ctx 已设置 dpr 等均匀缩放的画布上下文（单位 = CSS px）
 * @param {{x:number,y:number,r:number,color:'black'|'white'}} s
 * @param {object} [pal] resolveStoneColors 结果；缺省用 STONE_FALLBACK
 */
export function paintStoneShadow(ctx, s, pal = STONE_FALLBACK) {
  const { x, y, r, color } = s;
  const black = color !== 'white';
  const G = YUNZI_GEOM;
  const sc = uniformScale(ctx);
  ctx.save();
  ctx.shadowColor = black ? pal.dropB : pal.dropW;
  ctx.shadowBlur = r * G.dropBlur * G.blurCanvasK * sc;
  // 源圆在画布外，故偏移 = 离屏距离 + 目标偏移（同步 ×sc 补偿设备像素语义）
  ctx.shadowOffsetX = (HOLE_SHADOW_DIST + r * G.dropOx) * sc;
  ctx.shadowOffsetY = r * G.dropOy * sc;
  ctx.beginPath();
  ctx.arc(x - HOLE_SHADOW_DIST, y, r, 0, TWO_PI);
  ctx.fillStyle = '#ffffff'; // 填色落在画布外，画布上只出现偏移回来的影子
  ctx.fill();
  ctx.restore();
}

/**
 * 石体（35%/35% 三档径向渐变）+ 底部-右缘微透（CSS `inset -3px -4px 8px` 的 **Off-screen
 * Hole Shadow** 精确模拟）。无额外白描边（yunzi 无描边；边界由外投影定义）。
 *
 * `drop=true`（`paintStone` 用）时**外投影随石体一次 fill 烘焙**——与 2026/09/08 起的单张
 * 合体 sprite 逐像素一致（半透明虚子下层不透出自身投影）；`drop=false`（`paintStoneBody`）
 * 仅出石体，供棋盘「影子层 → 石体层」两趟绘制。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,r:number,color:'black'|'white'}} s
 * @param {object} pal resolveStoneColors 结果
 * @param {boolean} drop 是否烘焙外投影
 */
function paintBody(ctx, s, pal, drop) {
  const { x, y, r, color } = s;
  const black = color !== 'white';
  const p = black ? pal.b : pal.w;
  const G = YUNZI_GEOM;
  const sc = uniformScale(ctx);

  // 1) 石体径向渐变：圆心 35%/35%、半径=最远角，三档停点与 yunzi 一致
  //    （不投影时显式清空 shadowColor：石体填充不得继承调用方的投影状态）
  ctx.save();
  ctx.shadowColor = drop ? (black ? pal.dropB : pal.dropW) : 'rgba(0,0,0,0)';
  if (drop) {
    ctx.shadowBlur = r * G.dropBlur * G.blurCanvasK * sc;
    ctx.shadowOffsetX = r * G.dropOx * sc;
    ctx.shadowOffsetY = r * G.dropOy * sc;
  }
  const gx = x + r * G.focalX;
  const gy = y + r * G.focalY;
  const rEnd = r * G.radius;
  const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, rEnd);
  g.addColorStop(0, p.hi);
  g.addColorStop(black ? G.stopB : G.stopW, p.mid);
  g.addColorStop(1, p.lo);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TWO_PI);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  // 2) 底部-右缘微透（墨绿/丹红）= CSS `inset -3px -4px 8px` 精确模拟——Off-screen Hole
  //    Shadow：先 clip 圆内，再把“挖洞矩形”投到画布外左侧（HOLE_SHADOW_DIST），用 rim
  //    色作 shadow 且阴影偏移回 (insetOx·r, insetOy·r)——洞缘的模糊阴影恰好落在棋子
  //    右下内侧缘（与 CSS inset 同几何；Canvas 无原生 inset，径向窄带近似已弃）。
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TWO_PI);
  ctx.clip();
  ctx.beginPath();
  // 覆盖源（矩形）置于离屏：矩形 + 逆时针圆洞 → 非零环绕成“环形”阴影源
  ctx.rect(x - HOLE_SHADOW_DIST - r * 2, y - r * 2, r * 4, r * 4);
  ctx.arc(x - HOLE_SHADOW_DIST, y, r, 0, TWO_PI, true);
  ctx.shadowColor = p.rim;
  ctx.shadowBlur = r * G.insetBlur * G.blurCanvasK * sc;
  ctx.shadowOffsetX = (HOLE_SHADOW_DIST + r * G.insetOx) * sc;
  ctx.shadowOffsetY = r * G.insetOy * sc;
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}

/**
 * 仅石体（+ 内缘微透，**不含外投影**）——棋盘静态棋子「石体层」用；外投影走 `paintStoneShadow`。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,r:number,color:'black'|'white'}} s
 * @param {object} [pal] resolveStoneColors 结果；缺省用 STONE_FALLBACK
 */
export function paintStoneBody(ctx, s, pal = STONE_FALLBACK) {
  paintBody(ctx, s, pal, false);
}

/**
 * 完整一颗云子 = 外投影 + 石体（单张合体烘焙）——供**单子独立绘制**场景（提子计数控件、
 * 半透明虚子/残影等）与离屏 sprite 预烘焙共用（AGENTS 高内聚）。
 *
 * 棋盘静态棋子须改用分层绘制（先全部影子、再全部石体），见 board.js `_drawState` / BUG-140。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{x:number,y:number,r:number,color:'black'|'white'}} s
 * @param {object} [pal] resolveStoneColors 结果；缺省用 STONE_FALLBACK
 */
export function paintStone(ctx, s, pal = STONE_FALLBACK) {
  paintBody(ctx, s, pal, true);
}
