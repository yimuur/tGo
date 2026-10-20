/**
 * tGo · GameBoard 棋盘纯函数层无头单测（T5.5，node --test）
 * 用例 ID: FE-BOARD-*
 * 覆盖（TASK.md T5.5 验收）：坐标换算矩阵 / 布局尺寸纯函数 / 键盘点序 / 热力量化
 * + colLetters 与 GTP 语义（与 backend coords.py / test_play_query.py TestCoords 对齐）。
 *
 * 组件 GameBoard 依赖 DOM/Canvas，属人工浏览器验收轮；本文件只测纯函数层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GTP_ALPHABET,
  BOARD_SIZES,
  GRADE_ORDER,
  normalizeSize,
  colLetters,
  gtpOf,
  xyOfGtp,
  isPassLoc,
  describeMove,
  moveAnnouncementText,
  labelStride,
  edgeLabelIndices,
  hoshiIndices,
  hoshiPoints,
  layoutForSize,
  xyToPx,
  noteOverlapsBoard,
  pxToXY,
  snapDevice,
  snapLineCenter,
  spriteGeometry,
  KEY_DIRS,
  navigatePoint,
  quantizeOwnership,
  isOwnershipVector,
  stoneKey,
  diffStones,
  BOARD_ZOOM,
  clampZoom,
  clampBoardView,
  layoutRasterChanged,
  woodSurfaceLayout,
  gridLineWidths,
  snapBoardPos,
  GRID_OUTER_SCALE_FALLBACK,
  TOUCH_DBL_MS,
  TOUCH_TAP_FALLBACK_MS,
  isTouchDoubleTap,
  touchTapCommitAction,
  isOutsideBoard,
  dropDirSign,
  heatClearAction,
  stateLayerAffected,
  staticLayerAffected,
  pointerDownPlan,
  heatAnimating,
  top5FadeBusy,
} from '../static/js/core/board.js';

/* ---------------- 常量与基础 ---------------- */

test('FE-BOARD-01 | 常量完整性', () => {
  assert.ok(GTP_ALPHABET.includes('A') && GTP_ALPHABET.includes('T'));
  assert.ok(!GTP_ALPHABET.includes('I'), 'GTP 列字母必须跳过 I');
  assert.deepEqual(BOARD_SIZES, [9, 13, 19]);
  assert.deepEqual(GRADE_ORDER, ['brilliant', 'good', 'slow', 'mistake', 'blunder']);
  assert.ok(KEY_DIRS.ArrowUp.dy === -1 && KEY_DIRS.ArrowRight.dx === 1);
});

test('FE-BOARD-02 | normalizeSize 归一', () => {
  assert.equal(normalizeSize(19), 19);
  assert.equal(normalizeSize(13), 13);
  assert.equal(normalizeSize(9), 9);
  assert.equal(normalizeSize(17), 19);
  assert.equal(normalizeSize(0), 19);
  assert.equal(normalizeSize(undefined), 19);
  assert.equal(normalizeSize('19'), 19, '数字字符串应可接受');
});

test('FE-BOARD-03 | colLetters 按路数且跳 I', () => {
  assert.equal(colLetters(19).length, 19);
  assert.deepEqual(colLetters(19).slice(0, 9), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J']);
  assert.equal(colLetters(19)[18], 'T');
  assert.equal(colLetters(13).length, 13);
  assert.equal(colLetters(13)[12], 'N', '13 路末列为 N');
  assert.equal(colLetters(9).length, 9);
  assert.equal(colLetters(9)[8], 'J', '9 路末列为 J');
  assert.ok(!colLetters(13).includes('I') && !colLetters(9).includes('I'));
});

/* ---------------- 坐标换算矩阵（与 backend coords.py 语义一致） ---------------- */

test('FE-BOARD-04 | gtpOf 19 路矩阵', () => {
  assert.equal(gtpOf(0, 0, 19), 'A19');
  assert.equal(gtpOf(18, 18, 19), 'T1');
  assert.equal(gtpOf(2, 15, 19), 'C4');
  assert.equal(gtpOf(3, 15, 19), 'D4', 'GTP D4 → (3,15) 往返');
  assert.equal(gtpOf(15, 3, 19), 'Q16');
  assert.equal(gtpOf(18, 0, 19), 'T19');
  assert.equal(gtpOf(9, 9, 19), 'K10');
});

test('FE-BOARD-05 | gtpOf 越界 → null', () => {
  assert.equal(gtpOf(-1, 0, 19), null);
  assert.equal(gtpOf(19, 0, 19), null);
  assert.equal(gtpOf(0, -1, 19), null);
  assert.equal(gtpOf(0, 19, 19), null);
  assert.equal(gtpOf(3.5, 3, 19), null, '非整数列');
  assert.equal(gtpOf('3', 3, 19), null, '非数值');
});

test('FE-BOARD-06 | gtpOf 13/9 路', () => {
  assert.equal(gtpOf(0, 0, 13), 'A13');
  assert.equal(gtpOf(12, 12, 13), 'N1');
  assert.equal(gtpOf(0, 0, 9), 'A9');
  assert.equal(gtpOf(8, 8, 9), 'J1');
  assert.equal(gtpOf(6, 6, 13), 'G7', '13 路中心 G7');
});

test('FE-BOARD-07 | xyOfGtp 19 路矩阵', () => {
  assert.deepEqual(xyOfGtp('C4', 19), { x: 2, y: 15 });
  assert.deepEqual(xyOfGtp('D4', 19), { x: 3, y: 15 });
  assert.deepEqual(xyOfGtp('T1', 19), { x: 18, y: 18 });
  assert.deepEqual(xyOfGtp('A19', 19), { x: 0, y: 0 });
  assert.deepEqual(xyOfGtp('(3,15)', 19), { x: 3, y: 15 }, 'KataGo 显式形式');
  assert.deepEqual(xyOfGtp('c4', 19), { x: 2, y: 15 }, '小写兼容');
  assert.deepEqual(xyOfGtp(' K10 ', 19), { x: 9, y: 9 }, '空白容忍');
});

test('FE-BOARD-08 | xyOfGtp 13/9 路', () => {
  assert.deepEqual(xyOfGtp('A13', 13), { x: 0, y: 0 });
  assert.deepEqual(xyOfGtp('N1', 13), { x: 12, y: 12 });
  assert.deepEqual(xyOfGtp('J1', 9), { x: 8, y: 8 });
  assert.deepEqual(xyOfGtp('H9', 9), { x: 7, y: 0 });
});

test('FE-BOARD-09 | xyOfGtp 非法/越界 → null', () => {
  assert.equal(xyOfGtp('I4', 19), null, '跳过 I');
  assert.equal(xyOfGtp('T1', 13), null, '列超路数');
  assert.equal(xyOfGtp('A0', 19), null, '行 0');
  assert.equal(xyOfGtp('A20', 19), null, '行超路数');
  assert.equal(xyOfGtp('pass', 19), null);
  assert.equal(xyOfGtp('', 19), null);
  assert.equal(xyOfGtp('K10', 9), null, 'K 超 9 路');
  assert.equal(xyOfGtp(null, 19), null);
});

test('FE-BOARD-10 | GTP↔(x,y) 往返采样', () => {
  const samples19 = [[0, 0], [18, 18], [2, 15], [15, 3], [18, 0], [9, 9], [5, 11], [13, 2]];
  for (const [x, y] of samples19) {
    const gtp = gtpOf(x, y, 19);
    assert.deepEqual(xyOfGtp(gtp, 19), { x, y }, `${gtp} 往返`);
  }
  for (const n of [13, 9]) {
    for (let x = 0; x < n; x += 4) {
      for (let y = 0; y < n; y += 5) {
        const gtp = gtpOf(x, y, n);
        assert.deepEqual(xyOfGtp(gtp, n), { x, y }, `${n}路 ${gtp} 往返`);
      }
    }
  }
});

test('FE-BOARD-11 | isPassLoc', () => {
  assert.equal(isPassLoc('pass'), true);
  assert.equal(isPassLoc('PASS'), true);
  assert.equal(isPassLoc(' Pass '), true);
  assert.equal(isPassLoc('D4'), false);
  assert.equal(isPassLoc(''), false);
  assert.equal(isPassLoc(null), false);
});

test('FE-BOARD-12 | describeMove 播报文本', () => {
  assert.equal(describeMove({ color: 'black', x: 3, y: 15 }, 19), '黑方落子 D4');
  assert.equal(describeMove({ color: 'white', x: 0, y: 0 }, 19), '白方落子 A19');
  assert.equal(describeMove({ color: 'white', x: null, y: null }, 19), '白方 pass');
  assert.equal(describeMove({ color: 'black', isPass: true }, 19), '黑方 pass');
  assert.equal(describeMove({ color: 'white', x: 2, y: 2 }, 9), '白方落子 C7', '9 路 A9 语义');
});

/* ---------------- 布局 / 尺寸纯函数 ---------------- */

test('FE-BOARD-13 | layoutForSize 660 锚定（19 路）', () => {
  const m = layoutForSize(19, 660);
  assert.equal(m.n, 19);
  assert.ok(Math.abs(m.span - 600) < 1e-6, `span=${m.span}`);
  assert.ok(Math.abs(m.margin - 30) < 1e-6, `margin=${m.margin}`);
  assert.ok(Math.abs(m.cell - 600 / 18) < 1e-6, `cell=${m.cell}`);
  // 石径 2026/09/24 人工反馈「直径增大一点、间隙缩小一点」：0.45 → 0.48·cell
  assert.ok(Math.abs(m.stoneR - m.cell * 0.48) < 1e-9, `stoneR=${m.stoneR}`);
  assert.ok(Math.abs(m.stoneR - 16) < 1e-9, 'stoneR=16 @660（直径 32）');
  assert.ok(m.cell - m.stoneR * 2 > 0 && m.cell - m.stoneR * 2 < m.cell * 0.1, '石间净隙为正且小于旧基线 0.1·cell');
  assert.ok(Math.abs(m.hoshiR - 4) < 1e-6, 'hoshiR=4 @660');
  assert.ok(m.hitR > m.stoneR, '命中半径覆盖棋子');
  assert.ok(m.hitR < m.cell * 0.707, '命中半径小于格对角中点（空隙拒绝）');
});

test('FE-BOARD-14 | layoutForSize 尺寸等比缩放', () => {
  const a = layoutForSize(19, 660);
  const b = layoutForSize(19, 330);
  const ratio = (x) => Math.abs((a[x] / b[x]) - 2) < 1e-9;
  assert.ok(ratio('margin') && ratio('span') && ratio('cell') && ratio('stoneR'));
  // 任意小尺寸仍合法（hitR 等为正）
  for (const s of [320, 480, 720, 1080]) {
    const m = layoutForSize(13, s);
    assert.ok(m.cell > 0 && m.stoneR > 0 && Number.isFinite(m.cell));
  }
});

test('FE-BOARD-15 | layoutForSize 非法输入归一', () => {
  const m = layoutForSize(17, 660);
  assert.equal(m.n, 19);
  assert.ok(layoutForSize(19, 0).cell > 0, 'side<=0 按 1 处理不产生 NaN');
});

test('FE-BOARD-16 | layoutForSize 路数间几何（边距随 cell）', () => {
  const m19 = layoutForSize(19, 660);
  const m13 = layoutForSize(13, 660);
  const m9 = layoutForSize(9, 660);
  assert.equal(m13.n, 13);
  // 19 路与静态稿一致；13/9 路按 cell = side/(n+0.8)、margin = 0.9·cell 同构缩放
  assert.ok(Math.abs(m13.cell - 660 / 13.8) < 1e-9, `m13.cell=${m13.cell}`);
  assert.ok(Math.abs(m13.margin - 0.9 * m13.cell) < 1e-9);
  assert.ok(Math.abs(m13.span - m13.cell * 12) < 1e-9);
  assert.ok(Math.abs(m9.cell - 660 / 9.8) < 1e-9);
  assert.ok(Math.abs(m9.margin - 0.9 * m9.cell) < 1e-9);
  assert.ok(Math.abs(m9.span - m9.cell * 8) < 1e-9);
  assert.ok(m13.stoneR > m19.stoneR, '路少格大 → 石径大');
});

test('FE-BOARD-31 | 几何不变式：边角不裁剪 & 角部标签不重叠', () => {
  for (const n of [9, 13, 19]) {
    for (const side of [320, 480, 660, 1080]) {
      const m = layoutForSize(n, side);
      // 石缘到画布缘净空 ≥ 烘焙投影外扩 0.5·石径（offsetY 0.2R + blur 0.3R）
      //   → 边角棋子连同投影完整落在木纹区内（不被圆角/画布裁剪）
      assert.ok(m.margin - m.stoneR >= m.stoneR * 0.5 - 1e-9, `${n}路@${side} 边距容纳边角棋子与投影`);
      assert.ok(m.margin + m.span <= m.side + 1e-9, `${n}路@${side} 网格不越界`);
      // 顶缘字母带（基线 letterY 下沿）与左上角行号字顶纵向分离 → 无重叠
      const cap = m.coordFont * 0.72; // 大写字母近似字高
      const numTop = m.margin + m.rowBaselineOff - cap; // 顶部行号文字顶部
      assert.ok(m.letterY <= numTop - 1e-6, `${n}路@${side} 顶缘字母与行号纵向分离`);
    }
  }
});

test('FE-BOARD-17 | xyToPx 交叉点像素', () => {
  const m = layoutForSize(19, 660);
  const c = xyToPx(m, 9, 9);
  assert.ok(Math.abs(c.px - 330) < 1e-6 && Math.abs(c.py - 330) < 1e-6);
  const tl = xyToPx(m, 0, 0);
  assert.ok(Math.abs(tl.px - 30) < 1e-6 && Math.abs(tl.py - 30) < 1e-6);
  const br = xyToPx(m, 18, 18);
  assert.ok(Math.abs(br.px - 630) < 1e-6 && Math.abs(br.py - 630) < 1e-6);
});

test('FE-BOARD-18 | pxToXY 命中与拒绝', () => {
  const m = layoutForSize(19, 660);
  assert.deepEqual(pxToXY(m, 330, 330), { x: 9, y: 9 });
  assert.deepEqual(pxToXY(m, 30, 30), { x: 0, y: 0 });
  assert.deepEqual(pxToXY(m, 630, 630), { x: 18, y: 18 });
  assert.deepEqual(pxToXY(m, 320, 330), { x: 9, y: 9 }, '近邻吸附');
  assert.deepEqual(pxToXY(m, 340, 330), { x: 9, y: 9 });
  assert.deepEqual(pxToXY(m, 351, 330), { x: 10, y: 9 }, '跨格吸附');
  // 格对角空隙（距离 > hitR）→ null
  assert.equal(pxToXY(m, 345, 345), null);
  // 棋盘外
  assert.equal(pxToXY(m, 10, 10), null);
  assert.equal(pxToXY(m, 660, 330), null);
  assert.equal(pxToXY(m, 330, 660), null);
  assert.equal(pxToXY(m, -5, 330), null);
});

test('FE-BOARD-19 | 边沿标签步长与下标', () => {
  assert.equal(labelStride(19), 3);
  assert.equal(labelStride(13), 2);
  assert.equal(labelStride(9), 2);
  assert.deepEqual(edgeLabelIndices(19), [0, 3, 6, 9, 12, 15, 18]);
  assert.deepEqual(edgeLabelIndices(13), [0, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(edgeLabelIndices(9), [0, 2, 4, 6, 8]);
});

test('FE-BOARD-20 | 星位下标与点位', () => {
  assert.deepEqual(hoshiIndices(19), [3, 9, 15]);
  assert.deepEqual(hoshiIndices(13), [3, 6, 9]);
  assert.deepEqual(hoshiIndices(9), [2, 4, 6]);
  const pts = hoshiPoints(19);
  assert.equal(pts.length, 9);
  assert.ok(pts.some((p) => p.x === 3 && p.y === 3));
  assert.ok(pts.some((p) => p.x === 15 && p.y === 15));
  assert.ok(pts.some((p) => p.x === 3 && p.y === 15), '边星');
  assert.ok(pts.some((p) => p.x === 9 && p.y === 9), '天元');
});

/* ---------------- 键盘点序 ---------------- */

test('FE-BOARD-21 | navigatePoint 中心四方向', () => {
  assert.deepEqual(navigatePoint({ x: 9, y: 9 }, 'ArrowUp', 19), { x: 9, y: 8 });
  assert.deepEqual(navigatePoint({ x: 9, y: 9 }, 'ArrowDown', 19), { x: 9, y: 10 });
  assert.deepEqual(navigatePoint({ x: 9, y: 9 }, 'ArrowLeft', 19), { x: 8, y: 9 });
  assert.deepEqual(navigatePoint({ x: 9, y: 9 }, 'ArrowRight', 19), { x: 10, y: 9 });
});

test('FE-BOARD-22 | navigatePoint 边界夹取（无环绕）', () => {
  assert.deepEqual(navigatePoint({ x: 0, y: 0 }, 'ArrowUp', 19), { x: 0, y: 0 });
  assert.deepEqual(navigatePoint({ x: 0, y: 0 }, 'ArrowLeft', 19), { x: 0, y: 0 });
  assert.deepEqual(navigatePoint({ x: 18, y: 18 }, 'ArrowDown', 19), { x: 18, y: 18 });
  assert.deepEqual(navigatePoint({ x: 18, y: 18 }, 'ArrowRight', 19), { x: 18, y: 18 });
});

test('FE-BOARD-23 | navigatePoint 缺省起自天元', () => {
  assert.deepEqual(navigatePoint(null, 'ArrowUp', 19), { x: 9, y: 8 });
  assert.deepEqual(navigatePoint(null, 'ArrowRight', 13), { x: 7, y: 6 });
  assert.deepEqual(navigatePoint(null, 'ArrowUp', 9), { x: 4, y: 3 });
});

test('FE-BOARD-24 | navigatePoint 未知方向不动', () => {
  assert.deepEqual(navigatePoint({ x: 5, y: 5 }, 'Tab', 19), { x: 5, y: 5 });
  assert.deepEqual(navigatePoint({ x: 5, y: 5 }, 'Enter', 19), { x: 5, y: 5 });
});

/* ---------------- 热力量化 ---------------- */

test('FE-BOARD-25 | quantizeOwnership 基本量化', () => {
  const q = quantizeOwnership([0.5, -0.5, 1, -1, 0, 0.123], 19);
  assert.equal(q.n, 19);
  assert.equal(q.alphas.length, 361);
  assert.equal(q.signs.length, 361);
  assert.equal(q.alphas[0], 128);
  assert.equal(q.signs[0], 1, '黑领地 +1');
  assert.equal(q.alphas[1], 128);
  assert.equal(q.signs[1], -1, '白领地 -1');
  assert.equal(q.alphas[2], 255);
  assert.equal(q.alphas[3], 255);
  assert.equal(q.alphas[4], 0);
  assert.equal(q.alphas[5], 31, 'round(0.123*255)');
  assert.equal(q.alphas[6], 0, '越界索引补齐 0');
});

test('FE-BOARD-26 | quantizeOwnership 钳制与容错', () => {
  const q = quantizeOwnership([2, -2, NaN, Infinity, -Infinity, undefined], 9);
  assert.equal(q.alphas.length, 81);
  assert.equal(q.alphas[0], 255, '>1 钳制到 255');
  assert.equal(q.signs[0], 1);
  assert.equal(q.alphas[1], 255);
  assert.equal(q.signs[1], -1);
  assert.equal(q.alphas[2], 0, 'NaN → 0');
  assert.equal(q.alphas[3], 0, 'Infinity（非有限值）→ 0，防脏数据热像素');
  assert.equal(q.alphas[4], 0, '-Infinity（非有限值）→ 0');
  assert.equal(q.alphas[5], 0, 'undefined → 0');
});

test('FE-BOARD-27 | quantizeOwnership 类型与长度', () => {
  assert.ok(quantizeOwnership([], 19).alphas instanceof Uint8Array);
  assert.ok(quantizeOwnership([], 19).signs instanceof Int8Array);
  const q = quantizeOwnership(null, 19);
  assert.equal(q.alphas.length, 361, 'null 输入安全');
});

test('FE-BOARD-40 | TypedArray 领地矩阵可量化（BUG-124：复盘批量快照 Float32Array）', () => {
  // 背景：批量快照以 Float32Array 承载整局领地；旧实现用 `Array.isArray` 判定
  // → TypedArray 被当作「非原始矩阵」→ 热力被当空值清除（点击 [领地] “无数据”）。
  assert.equal(isOwnershipVector([1, 0]), true);
  assert.equal(isOwnershipVector(new Float32Array([1, 0])), true);
  assert.equal(isOwnershipVector(new Int8Array(2)), true);
  assert.equal(isOwnershipVector(null), false);
  assert.equal(isOwnershipVector({ alphas: new Uint8Array(2) }), false, '已量化形态不走本判定');
  assert.equal(isOwnershipVector('0.5,0.5'), false);
  const q = quantizeOwnership(new Float32Array([0.5, -0.5, 1, -1]), 9);
  assert.equal(q.alphas.length, 81);
  assert.equal(q.alphas[0], 128, 'TypedArray 不再被当空输入 → 强度保留');
  assert.equal(q.signs[1], -1);
  assert.equal(q.alphas[2], 255);
  assert.equal(Math.max(...q.alphas), 255, '至少一侧非零（否则热力不显示）');
});

/* ---------------- 状态推导 ---------------- */

test('FE-BOARD-28 | stoneKey 唯一键', () => {
  assert.equal(stoneKey(0, 0), '0,0');
  assert.equal(stoneKey(18, 18), '18,18');
  assert.notEqual(stoneKey(1, 2), stoneKey(2, 1));
});

test('FE-BOARD-29 | diffStones 增删检测', () => {
  const prev = [
    { x: 0, y: 0, color: 'black' },
    { x: 3, y: 3, color: 'white' },
    { x: 5, y: 5, color: 'black' },
  ];
  const next = [
    { x: 3, y: 3, color: 'white' },
    { x: 5, y: 5, color: 'black' },
    { x: 9, y: 9, color: 'black' },
  ];
  const d = diffStones(prev, next);
  assert.deepEqual(d.added, [{ x: 9, y: 9, color: 'black' }]);
  assert.deepEqual(d.removed, [{ x: 0, y: 0, color: 'black' }]);
});

test('FE-BOARD-30 | diffStones 空与不变', () => {
  assert.deepEqual(diffStones([], []), { added: [], removed: [] });
  const s = [{ x: 1, y: 1, color: 'black' }];
  assert.deepEqual(diffStones(s, [...s]), { added: [], removed: [] });
  const d = diffStones(null, [{ x: 1, y: 1, color: 'black' }]);
  assert.deepEqual(d.added, [{ x: 1, y: 1, color: 'black' }]);
});

/* ---------------- 棋盘缩放（zoom/pan 纯函数） ---------------- */

test('FE-BOARD-32 | BOARD_ZOOM 常量 & clampZoom 钳制', () => {
  assert.equal(BOARD_ZOOM.min, 1);
  assert.ok(BOARD_ZOOM.max >= BOARD_ZOOM.min);
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(BOARD_ZOOM.max), BOARD_ZOOM.max);
  assert.equal(clampZoom(99), BOARD_ZOOM.max);
  assert.equal(clampZoom(0.2), BOARD_ZOOM.min);
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(NaN), BOARD_ZOOM.min);
});

test('FE-BOARD-33 | clampBoardView：不溢出方向居中，溢出方向限 [vw-surf,0]', () => {
  // surf ≤ 视口 → 居中（无平移）
  assert.deepEqual(clampBoardView(50, 50, 600, 600, 600), { left: 0, top: 0 });
  assert.deepEqual(clampBoardView(0, 0, 500, 600, 600), { left: 50, top: 50 });
  // 正方形视口 + 2x：只允许负向平移，且画布始终盖住视口
  const { left, top } = clampBoardView(-600, -600, 1200, 600, 600);
  assert.ok(left <= 0 && left >= 600 - 1200);
  assert.ok(top <= 0 && top >= 600 - 1200);
  assert.equal(left, -600); // 在合法范围内按期望返回
  // 越界拖拽 → 钳到边界（不露出空白）
  const out = clampBoardView(10, -4000, 1200, 600, 600);
  assert.equal(out.left, 0); // 画布右缘不越过视口左缘？不：surf>vw 时 left 上限为 0
  assert.equal(out.top, 600 - 1200);
  assert.ok(out.left <= 0 && out.left + 1200 >= 600);
  assert.ok(out.top <= 0 && out.top + 1200 >= 600);
  // 宽矩形容器（surf<vw）：水平居中、垂直可平移
  const wide = clampBoardView(-200, -200, 600, 1200, 600);
  assert.equal(wide.left, 300); // (1200-600)/2
  assert.ok(wide.top <= 0 && wide.top >= -600);
  // zoom=1（surf=视口）时恒居中/原点
  assert.deepEqual(clampBoardView(-999, -999, 600, 600, 600), { left: 0, top: 0 });
});

test('FE-BOARD-34 | TOUCH_DBL_MS & isTouchDoubleTap 触摸双击判定', () => {
  assert.ok(TOUCH_DBL_MS > 0 && TOUCH_DBL_MS <= 500);
  const cur = { x: 3, y: 7 };
  // 同一交叉点且在窗口内 → true
  assert.equal(isTouchDoubleTap({ x: 3, y: 7, at: 1000 }, cur, 1000 + TOUCH_DBL_MS), true);
  // 超出窗口 → false
  assert.equal(isTouchDoubleTap({ x: 3, y: 7, at: 1000 }, cur, 1000 + TOUCH_DBL_MS + 1), false);
  // 不同交叉点 → false
  assert.equal(isTouchDoubleTap({ x: 4, y: 7, at: 1000 }, cur, 1010), false);
  // 无前次记录 / 空 → false
  assert.equal(isTouchDoubleTap(null, cur, 1010), false);
});

/* ---------------- 设备像素对齐（BUG-007 修复：防刻线/棋子“发虚”） ---------------- */

test('FE-BOARD-35 | snapDevice 吸附设备像素（返回 CSS 单位）', () => {
  // dpr=1：即四舍五入到整数 CSS px
  assert.equal(snapDevice(30.4, 1), 30);
  assert.equal(snapDevice(30.6, 1), 31);
  assert.equal(snapDevice(30, 1), 30);
  // 任意 dpr：结果×dpr 恒为整数（吸附到设备网格）
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    for (const v of [0.4, 27.27, 57.58, 330.1, 630.9]) {
      const s = snapDevice(v, dpr);
      assert.ok(Number.isInteger(s * dpr), `v=${v} dpr=${dpr} → s*dpr=${s * dpr} 应为整数`);
    }
  }
  assert.equal(snapDevice(0, 2), 0);
});

test('FE-BOARD-36 | snapLineCenter 奇偶线宽 +0.5 规则（偶数取整、奇数 +0.5 设备像素）', () => {
  // dpr=1：奇数宽 → 线心落在半像素（像素中线）；偶数宽 → 整像素
  assert.equal(snapLineCenter(30.4, 1, 1), 30.5);
  assert.equal(snapLineCenter(30.6, 1, 1), 31.5);
  assert.equal(snapLineCenter(30.4, 1, 2), 30);
  assert.equal(snapLineCenter(30.6, 1, 2), 31);
  // dpr=2：CSS 坐标需在设备域判断奇偶
  assert.equal(snapLineCenter(10.2, 2, 1), 20.5 / 2); // 设备心 20.5（奇数宽）
  assert.equal(snapLineCenter(10.2, 2, 2), 20 / 2); // 设备心 20（偶数宽）
  // 分数 DPR（1.25）：偶数宽 → 设备心整数；奇数宽 → 设备心 x.5
  const even = snapLineCenter(27.27, 1.25, 2);
  const odd = snapLineCenter(27.27, 1.25, 1);
  assert.ok(Number.isInteger(even * 1.25), `偶数宽设备心 ${even * 1.25} 应为整数`);
  assert.ok((odd * 1.25) % 1 === 0.5, `奇数宽设备心 ${odd * 1.25} 应为 x.5`);
  // 与 snapDevice 派生自同一 round → 静态层网格/星位/棋子共用一个设备网格
  assert.equal(snapLineCenter(27.27, 1.25, 2), snapDevice(27.27, 1.25));
});

test('FE-BOARD-37 | heatClearAction：有热力且允许动效 → 淡出；否则即时清除（reduced-motion）', () => {
  assert.equal(heatClearAction({ hasHeat: true, motion: true }), 'fade');
  assert.equal(heatClearAction({ hasHeat: true, motion: false }), 'reset');
  assert.equal(heatClearAction({ hasHeat: false, motion: true }), 'reset');
  assert.equal(heatClearAction({}), 'reset');
});

test('FE-BOARD-38 | noteOverlapsBoard：提示矩形 ∩ 棋盘方形（2026/09/24 简化口径）', () => {
  // 提示矩形（相对棋盘容器）：`白 J3` 胶囊实际尺寸量级 left12/top10/w56/h24
  const note = { left: 12, top: 10, right: 68, bottom: 34 };
  // 棋盘方形覆盖提示所在区域 → 降级半透明
  assert.equal(noteOverlapsBoard(note, { left: 0, top: 0, size: 400 }), true);
  // 棋盘整体在提示右侧/下方（木料留白）→ 不降级
  assert.equal(noteOverlapsBoard(note, { left: 183, top: 0, size: 400 }), false);
  assert.equal(noteOverlapsBoard(note, { left: 0, top: 120, size: 400 }), false);
  // 仅部分相交（棋盘左上角落在提示内）→ 降级
  assert.equal(noteOverlapsBoard(note, { left: 40, top: 20, size: 300 }), true);
  // 边界贴合（不相交）不算重叠
  assert.equal(noteOverlapsBoard(note, { left: 68, top: 0, size: 400 }), false);
  assert.equal(noteOverlapsBoard(note, { left: 0, top: 34, size: 400 }), false);
  // 容错：缺参/边长非正 → false（不抛）
  assert.equal(noteOverlapsBoard(null, { left: 0, top: 0, size: 400 }), false);
  assert.equal(noteOverlapsBoard(note, null), false);
  assert.equal(noteOverlapsBoard(note, { left: 0, top: 0, size: 0 }), false);
});

test('FE-BOARD-51 | noteOverlapsBoard 缩放/平移语义：按棋盘真实方形（含 zoom/平移）判定', () => {
  const note = { left: 12, top: 10, right: 68, bottom: 34 };
  // 形形容器 766×766：surf=766、居中 offset=0 → 提示落在盘面内 → 降级
  assert.equal(noteOverlapsBoard(note, { left: 0, top: 0, size: 766 }), true);
  // 矩形容器 766×400（棋盘被高度钳制）：surf=400、居中 left=183 → 提示在木料留白处 → 不降级
  assert.equal(noteOverlapsBoard(note, { left: 183, top: 0, size: 400 }), false, '真实几何：提示在留白处，不遮挡');
  // zoom=2（surf=800）+ 向左上平移 → 提示重新落回盘面 → 降级
  assert.equal(noteOverlapsBoard(note, { left: -200, top: -150, size: 800 }), true);
  // 反向平移：提示被推出盘面 → 不降级
  assert.equal(noteOverlapsBoard(note, { left: 300, top: 60, size: 800 }), false);
  // 回归守卫：按“容器宽 + 无偏移”的错误写法会误判为遮挡（真几何在留白处，BUG-129）
  assert.equal(noteOverlapsBoard(note, { left: 0, top: 0, size: 766 }), true, '按容器宽/无偏移 → 误判为遮挡');
});

test('FE-BOARD-50 | snapBoardPos：画布位置吸附到设备像素（缩放后 BUG-007 回归修复 2026/09/22）', () => {
  // ① 居中且能整除：吸附不动
  assert.deepEqual(snapBoardPos(0, 0, { surf: 700, vw: 996, vh: 700, dpr: 1.25 }), { left: 148, top: 0 });
  // ② 居中但含小数：按设备像素取整（≤0.5 设备像素偏心）
  const frac = snapBoardPos((995 - 700) / 2, 12.3, { surf: 700, vw: 995, vh: 700, dpr: 1.25 });
  assert.equal(frac.left, Math.round(147.5 * 1.25) / 1.25);
  assert.ok(Number.isInteger(frac.left * 1.25) && Number.isInteger(frac.top * 1.25), '吸附后必为设备像素整数倍');
  // ③ 缩放/平移（画布大于容器）：吸附 + 不露边（区间端点向内取整）
  for (const [surf, vw, vh] of [[1400, 996, 700], [1149, 766, 766], [1050, 996, 700], [1400, 995, 700]]) {
    for (const raw of [-383.2, -382.83, -404, -191.5, -12.7]) {
      for (const dpr of [1, 1.25, 2, 3]) {
        const p = snapBoardPos(raw, raw, { surf, vw, vh, dpr });
        assert.ok(Number.isInteger(p.left * dpr) && Number.isInteger(p.top * dpr), `dpr=${dpr} surf=${surf} raw=${raw} 应设备对齐`);
        if (surf > vw) {
          // 画布大于容器：合法区间 [vw−surf, 0] 且端点向内取整 → 既盖满容器又设备对齐
          assert.ok(p.left <= 0 && p.left + surf >= vw, '画布须仍盖满容器（不露底）');
          const inRange = Math.max(vw - surf, Math.min(0, raw));
          // 吸附位移 ≤ 1 设备像素：端点未对齐时需「向内取整」（ceil）→ 相对钳位值最多偏 1 设备像素
          assert.ok(Math.abs(p.left - inRange) <= 1 / dpr + 1e-9, '吸附位移 ≤ 1 设备像素');
        } else {
          assert.equal(p.left, Math.round(((vw - surf) / 2) * dpr) / dpr, '小于容器时恒居中');
        }
      }
    }
  }
  // ④ 极值（贴边）：下界向内取整 → 仍盖满且设备对齐（995−1400=−405 → ceil 到 −404.8）
  const edge = snapBoardPos(-405, 0, { surf: 1400, vw: 995, vh: 700, dpr: 1.25 });
  assert.equal(edge.left, -404.8);
  assert.ok(edge.left + 1400 >= 995);
  // ⑤ 非法输入不抛
  assert.deepEqual(snapBoardPos(NaN, undefined, {}), { left: 0, top: 0 });
});

test('FE-BOARD-52 | spriteGeometry：棋子 sprite 偶数设备宽 + 石心落正中整像素（缩放不改规则，2026/09/22 回归守卫）', () => {
  // ① 契约：任意半径/DPR 下内容宽恒为偶数整数设备像素、石心恒在正中整像素 ⇒ 可 1:1 blit 且圆心设备对齐
  for (const radius of [8, 12.34, 16.272727272727273, 24.40909090909091, 32.54545454545455]) {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const g = spriteGeometry({ radius, dpr });
      assert.ok(Number.isInteger(g.w) && g.w % 2 === 0, `radius=${radius} dpr=${dpr} 内容宽须为偶数整数`);
      assert.ok(Number.isInteger(g.halfDev), 'halfDev 须为整数（石心落整像素）');
      assert.equal(g.centerCss, g.halfDev / dpr, '石心 CSS 位置 ≡ 正中');
      assert.equal(g.cssW * dpr, g.w, '源/目标设备尺寸须一致（1:1 blit 前提）');
      assert.ok(g.w >= radius * 2 * dpr, '须完整容纳棋子本体');
    }
  }
  // ② zoom 改变 R，规则不变：每级 zoom 重新烘焙为更大的偶数宽（与浏览器实测 74/96/110/148 一致）
  const widths = [];
  for (const zoom of [1, 1.3, 1.5, 2]) {
    const g = spriteGeometry({ radius: 16.272727272727273 * zoom, dpr: 1.25 });
    assert.equal(g.w % 2, 0, `zoom=${zoom} 须为偶数设备宽`);
    widths.push(g.w);
  }
  assert.deepEqual(widths, [74, 96, 110, 148], '逐级 zoom 的设备宽须单调增且偶数（与浏览器实测一致）');
  // ③ 非法输入不抛，且不产生非法画布尺寸（0/NaN/负值 → 空几何）
  assert.deepEqual(spriteGeometry({ radius: NaN, dpr: 0 }), { pad: 0, halfDev: 0, w: 0, cssW: 0, centerCss: 0 });
  assert.equal(spriteGeometry().w, 0);
  assert.equal(spriteGeometry({ radius: -5, dpr: 2 }).w, 0);
});

test('FE-BOARD-39 | isOutsideBoard：板外 pointerdown 判定（触摸幻影清理依据）', () => {
  const inside = { nodeType: 1 };
  const outside = { nodeType: 1 };
  const boardEl = { contains: (t) => t === inside };
  // 板内（棋盘容器及其子节点）→ false：交给板内手势（预览移动/双击落子）
  assert.equal(isOutsideBoard(inside, boardEl), false);
  // 板外任意元素（按钮/滑轨/菜单/弹层等）→ true：视为“不继续落子”，清除幻影与双击记录
  assert.equal(isOutsideBoard(outside, boardEl), true);
  // 无目标 / 非元素节点（裸文本）/ 无棋盘元素 → 一律视为板外（不抛）
  assert.equal(isOutsideBoard(null, boardEl), true);
  assert.equal(isOutsideBoard(undefined, boardEl), true);
  assert.equal(isOutsideBoard({ nodeType: 3 }, boardEl), true);
  assert.equal(isOutsideBoard(inside, null), true);
  assert.equal(isOutsideBoard(inside, {}), true, '无 contains 能力的宿主元素视为板外');
});

test('FE-BOARD-40 | dropDirSign：落子动画方向符号（+1 由下到上 / −1 由上到下，2026/09/13）', () => {
  // 缺省（upColor=black）：黑由下到上、白由上到下
  assert.equal(dropDirSign('black'), 1);
  assert.equal(dropDirSign('white'), -1);
  // 人机人类执白：白由下到上、黑由上到下（方向随“人类/AI”而非“黑/白”）
  assert.equal(dropDirSign('white', 'white'), 1);
  assert.equal(dropDirSign('black', 'white'), -1);
  // 非法 upColor 归一为 black（与 board setProps 归一一致）
  assert.equal(dropDirSign('black', 'weird'), 1);
  assert.equal(dropDirSign('white', 'weird'), -1);
});

/* ---------------- 双层 Canvas / 按需重绘（2026/09/17 性能修订） ---------------- */

test('FE-BOARD-41 | stateLayerAffected：状态层失效判定覆盖叠加标记类 Prop', () => {
  const base = {
    size: 19, stones: [], top5: [], variations: [], toMove: 'black', comments: [],
    deadStones: [], lastMarker: 'dot', ownership: null, commentRing: true,
    heatVisible: true, interactive: true, hoverGhost: true, reduceMotion: false, stoneMotion: true,
  };
  // 全部相同（同值）→ 不失效
  assert.equal(stateLayerAffected(base, { ...base }), false);
  // 路数与叠加标记/动画外观相关 Prop 任一变更 → 失效（含无需动画的静态叠加，须重绘一次）
  const flips = {
    size: 13,
    stones: [{ x: 1, y: 1 }],
    toMove: 'white',
    comments: [{ x: 1, y: 1, grade: 'good' }],
    commentRing: false,
    deadStones: [{ x: 1, y: 1 }],
    lastMarker: 'ring',
    ownership: [0.5],
    top5: [{ x: 1, y: 1, rank: 1 }],
    variations: [{ x: 1, y: 1 }],
    heatVisible: false,
    interactive: false,
    hoverGhost: false,
    reduceMotion: true,
    stoneMotion: false,
  };
  for (const [k, v] of Object.entries(flips)) {
    assert.equal(stateLayerAffected(base, { ...base, [k]: v }), true, `${k} 变更应使状态层失效`);
  }
  // 与画布无关的 Prop 不失效（容器 CSS 类/播报/无障碍标签）
  assert.equal(stateLayerAffected(base, { ...base, engineDead: true, ariaLabel: 'x', announceMoves: false }), false);
  // 缺省参数容错（首次 setProps：prev 为空对象）
  assert.equal(stateLayerAffected({}, {}), false);
  assert.equal(stateLayerAffected({}, { stones: [] }), true);
});

test('FE-BOARD-42 | staticLayerAffected：仅路数/边沿坐标开关影响静态层', () => {
  const base = { size: 19, showCoordinates: true };
  assert.equal(staticLayerAffected(base, { ...base }), false);
  assert.equal(staticLayerAffected(base, { ...base, size: 13 }), true);
  assert.equal(staticLayerAffected(base, { ...base, showCoordinates: false }), true);
  assert.equal(staticLayerAffected(base, { ...base, stones: [{ x: 0, y: 0 }] }), false, '棋子变化不重绘静态层');
  assert.equal(staticLayerAffected({}, {}), false);
});

test('FE-BOARD-43 | pointerDownPlan：鼠标 100% 不登记按压态，平移意图提前捕获（L-9）', () => {
  // 触摸：手势链（轻点预览/双击/平移判定）——任何缩放均登记按压态
  assert.equal(pointerDownPlan('touch', 1), 'press');
  assert.equal(pointerDownPlan('touch', 2), 'press');
  // 100% 鼠标/笔：pointerdown 即提交（旧实现在此也登记 `_drag` → 出界释放残留吞下一次点击）
  assert.equal(pointerDownPlan('mouse', 1), 'tap');
  assert.equal(pointerDownPlan('pen', 1), 'tap');
  // zoom>1：平移——登记按压态并在按下即捕获指针（移出画布释放仍回投 pointerup）
  assert.equal(pointerDownPlan('mouse', 1.5), 'pan');
  assert.equal(pointerDownPlan('pen', 2), 'pan');
});

test('FE-BOARD-43 | heatAnimating：热力插值/淡出进行中才继续动画帧', () => {
  assert.equal(heatAnimating(null), false);
  assert.equal(heatAnimating(undefined), false);
  assert.equal(heatAnimating({ dirty: false, fading: false }), false);
  assert.equal(heatAnimating({ dirty: true, fading: false }), true);
  assert.equal(heatAnimating({ dirty: false, fading: true }), true);
  assert.equal(heatAnimating({ dirty: true, fading: true }), true);
});

test('FE-BOARD-44 | top5FadeBusy：150ms 淡入窗口内/新键应保持动画帧', () => {
  const seen = new Map([['3,3', 1000]]);
  // 已过窗口且无新键 → 不忙（空闲停画）
  assert.equal(top5FadeBusy(seen, ['3,3'], 1200), false);
  // 窗口内 → 忙
  assert.equal(top5FadeBusy(seen, ['3,3'], 1100), true);
  // 未登记的新键 → 忙（按“本帧刚出现”处理）
  assert.equal(top5FadeBusy(seen, ['3,3', '4,4'], 1200), true);
  // reduced-motion → 立即呈现，不占用动画帧
  assert.equal(top5FadeBusy(seen, ['4,4'], 1000, { motion: true }), false);
  // 自定义时长
  assert.equal(top5FadeBusy(seen, ['3,3'], 1200, { fade: 100 }), false);
  assert.equal(top5FadeBusy(seen, ['3,3'], 1200, { fade: 300 }), true);
  // 空键集 → 不忙
  assert.equal(top5FadeBusy(seen, [], 1000), false);
});

test('FE-BOARD-45 | layoutRasterChanged：重栅格指纹幂等（BUG-096 空窗帧）', () => {
  const base = { surf: 384, left: 0, top: 0, dpr: 1.25, bw: 480, size: 19 };
  // 首次（尚未栅格化）→ 必须栅格化
  assert.equal(layoutRasterChanged(null, base), true);
  // 与上次实际栅格化完全一致（重复 observe / 同尺寸 RO 回调）→ 跳过重栅格
  assert.equal(layoutRasterChanged(base, { ...base }), false);
  // 各字段单独变化均需重栅格
  assert.equal(layoutRasterChanged(base, { ...base, surf: 400 }), true, '画布边长变化');
  assert.equal(layoutRasterChanged(base, { ...base, left: -16 }), true, '平移变化');
  assert.equal(layoutRasterChanged(base, { ...base, top: -16 }), true, '平移变化（纵向）');
  assert.equal(layoutRasterChanged(base, { ...base, dpr: 2 }), true, 'dpr 变化（跨屏拖动）');
  assert.equal(layoutRasterChanged(base, { ...base, bw: 481 }), true, '设备像素边长变化');
  assert.equal(layoutRasterChanged(base, { ...base, size: 13 }), true, '路数变化（同尺寸改路数）');
  // 2026/09/22（方案 B）：木料面（容器整幅）变化同样必须重栅格
  const face = { ...base, bh: 800, sw: 996, sh: 700, sl: 0, st: 0 };
  assert.equal(layoutRasterChanged(face, { ...face }), false);
  assert.equal(layoutRasterChanged(face, { ...face, sw: 1100 }), true, '木料面宽变化（容器变宽）');
  assert.equal(layoutRasterChanged(face, { ...face, sh: 640 }), true, '木料面高变化');
  assert.equal(layoutRasterChanged(face, { ...face, sl: -37 }), true, '木料面平移（zoom 后外扩）');
});

test('FE-BOARD-48 | woodSurfaceLayout：木料面＝容器整幅，随 zoom 缩放/平移（方案 B 2026/09/22）', () => {
  // zoom=1：木料面恰等于容器（覆盖两侧留白；位置归零）
  const one = woodSurfaceLayout({ vw: 996, vh: 700, zoom: 1, boardLeft: 148, boardTop: 0 });
  assert.deepEqual(one, { w: 996, h: 700, left: 0, top: 0, padX: 148, padY: 0 });
  // zoom=2：尺寸 ×2；位置＝棋盘位置向外扩「留白 × zoom」→ 木纹随棋盘一同缩放/平移
  const two = woodSurfaceLayout({ vw: 996, vh: 700, zoom: 2, boardLeft: -404, boardTop: -350 });
  assert.equal(two.w, 1992);
  assert.equal(two.h, 1400);
  assert.equal(two.padX, 296);
  assert.equal(two.left, -700);
  assert.equal(two.top, -350);
  // 随动一致性（面与棋盘两套映射等价）：面.left + padX ≡ 棋盘.left、面.top + padY ≡ 棋盘.top
  //   —— 这正是“木纹与棋盘严格贴合”的几何依据（面内坐标 = pad + zoom×基础坐标）
  assert.equal(two.left + two.padX, -404);
  assert.equal(two.top + two.padY, -350);
  // "始终盖满容器"不变量（zoom>1 且棋盘已按 clampBoardView 钳位时）
  for (const zoom of [1, 1.3, 1.75, 2]) {
    const base = Math.min(996, 700);
    const surf = base * zoom;
    const left = surf <= 996 ? (996 - surf) / 2 : Math.min(0, Math.max(996 - surf, -120 * zoom));
    const top = surf <= 700 ? (700 - surf) / 2 : Math.min(0, Math.max(700 - surf, -60 * zoom));
    const f = woodSurfaceLayout({ vw: 996, vh: 700, zoom, boardLeft: left, boardTop: top });
    assert.ok(f.left <= 1e-9 && f.top <= 1e-9, `zoom=${zoom} 木料面不得卷边`);
    assert.ok(f.left + f.w >= 996 - 1e-9 && f.top + f.h >= 700 - 1e-9, `zoom=${zoom} 木料面须盖满容器`);
  }
  // 非法 zoom/尺寸 → 钳到合法值，不抛错
  const bad = woodSurfaceLayout({ vw: 800, vh: 600, zoom: 99, boardLeft: 0, boardTop: 0 });
  assert.equal(bad.w, 1600);
  const zero = woodSurfaceLayout({});
  assert.deepEqual(zero, { w: 0, h: 0, left: 0, top: 0, padX: 0, padY: 0 });
});

test('FE-BOARD-49 | gridLineWidths：外圈加粗开关（≤1 关闭）与设备像素整数线宽', () => {
  // 内线与既有口径一致：max(1, round(lineW·dpr))
  const a = gridLineWidths({ lineW: 1.2, dpr: 1.25, outerScale: 1.55 });
  assert.equal(a.inner, Math.max(1, Math.round(1.2 * 1.25)));
  assert.ok(a.outer > a.inner, '倍率 >1 → 外圈更粗');
  assert.equal(a.outer, Math.max(a.inner + 1, Math.round(a.inner * 1.55)));
  assert.ok(Number.isInteger(a.inner) && Number.isInteger(a.outer));
  // 开关关闭：1 / 0.8 / 0 / 负数 / null（Number(null)=0）→ 与内线同宽
  for (const off of [1, 0.8, 0, -2, null]) {
    const w = gridLineWidths({ lineW: 1.2, dpr: 2, outerScale: off });
    assert.equal(w.outer, w.inner, `outerScale=${String(off)} 应视为关闭`);
  }
  // 非法值（NaN，如 token 写成非数字）→ 不作「关闭」处理，回退脚本兜底倍率（保持默认观感）
  const nan = gridLineWidths({ lineW: 1.2, dpr: 2, outerScale: 'x' });
  assert.equal(
    nan.outer,
    Math.max(nan.inner + 1, Math.round(nan.inner * GRID_OUTER_SCALE_FALLBACK)),
  );
  // 缺省 → 脚本兜底倍率
  const fallback = gridLineWidths({ lineW: 1.2, dpr: 1, outerScale: undefined });
  assert.ok(fallback.outer > fallback.inner);
  assert.equal(
    fallback.outer,
    Math.max(fallback.inner + 1, Math.round(fallback.inner * GRID_OUTER_SCALE_FALLBACK)),
  );
  // 极端入参不抛错
  assert.deepEqual(gridLineWidths({ lineW: 0, dpr: 0, outerScale: 1.5 }), { inner: 1, outer: 2 });
});

test('FE-BOARD-46 | touchTapCommitAction：仅纯轻点提交，捏合/平移/取消/异指针一律丢弃（BUG-105）', () => {
  const select = { id: 3, kind: 'select', x: 4, y: 5 };
  const place = { id: 3, kind: 'place', x: 4, y: 5 };
  // 交付兜底窗口：存在且为短窗口（覆盖 iOS 缺失 up/click 的极端时序，不得静默失效）
  assert.ok(TOUCH_TAP_FALLBACK_MS > 0 && TOUCH_TAP_FALLBACK_MS <= 600);
  // 纯轻点（同一指针、无位移、未取消）→ 按登记动作提交
  assert.equal(touchTapCommitAction(select, { pointerId: 3 }), 'select');
  assert.equal(touchTapCommitAction(place, { pointerId: 3 }), 'place');
  // 平移（位移越阈值）→ 丢弃（首指落下不得提交）
  assert.equal(touchTapCommitAction(select, { pointerId: 3, moved: true }), null);
  assert.equal(touchTapCommitAction(place, { pointerId: 3, moved: true }), null);
  // 手势取消 → 丢弃
  assert.equal(touchTapCommitAction(select, { pointerId: 3, cancelled: true }), null);
  // 指针不匹配（残留待定）→ 丢弃
  assert.equal(touchTapCommitAction(select, { pointerId: 8 }), null);
  // 空/非法 → null
  assert.equal(touchTapCommitAction(null, { pointerId: 3 }), null);
  assert.equal(touchTapCommitAction(undefined, { pointerId: 3 }), null);
  assert.equal(touchTapCommitAction({ id: 3, kind: 'nope' }, { pointerId: 3 }), null);
});

test('FE-BOARD-47 | moveAnnouncementText：落子播报含手数（UI_UX §6.8 aria-live）', () => {
  assert.equal(
    moveAnnouncementText({ color: 'black', x: 3, y: 15, moveNo: 42 }, 19),
    '第 42 手，黑方落子 D4',
  );
  assert.equal(
    moveAnnouncementText({ color: 'white', x: 0, y: 0 }, 19),
    '白方落子 A19',
    'moveNo 缺失 → 退化为 describeMove（不得输出「第 NaN 手」）',
  );
  assert.equal(
    moveAnnouncementText({ color: 'white', x: 2, y: 2, moveNo: 0 }, 9),
    '白方落子 C7',
    'moveNo 非正整数 → 退化',
  );
  assert.equal(
    moveAnnouncementText({ color: 'black', x: null, y: null, moveNo: 3 }, 19),
    '第 3 手，黑方 pass',
  );
});

