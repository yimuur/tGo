/**
 * tGo · curve.js 曲线纯函数层无头单测（T5.6，node --test）
 * 用例 ID: FE-CURVE-*
 * 覆盖（TASK.md T5.6 验收「曲线刻度/动态缩放纯函数」）：几何、量程 scaleFor、
 * 手数刻度、数据归一（小数↔百分/去重）、路径 d、markup 结构。
 * DOM 渲染/240ms morph 归人工浏览器验收轮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  curveGeometry,
  scaleFor,
  fmt1,
  winrateY,
  scoreY,
  xOfMove,
  niceTickStep,
  moveTicks,
  toSeries,
  linePath,
  areaPath,
  buildCurveMarkup,
  buildLabelsMarkup,
  morphPts,
  pointsEqual,
  clientXToViewBoxX,
  moveNoAtViewBoxX,
  nearestPoint,
  hoverDetailText,
} from '../static/js/core/curve.js';

const G = curveGeometry();

test('FE-CURVE-01 | 几何常量（与静态稿 340×160）', () => {
  assert.equal(G.width, 340);
  assert.equal(G.height, 160);
  assert.equal(G.x0, 44);
  assert.equal(G.x1, 300);
  assert.equal(G.top, 14);
  assert.equal(G.bottom, 144);
  assert.equal(G.mid, 79, '中线 (14+144)/2');
  assert.equal(G.plotW, 256);
  assert.equal(G.plotH, 130);
});

test('FE-CURVE-02 | scaleFor 动态量程（×1.15 → 0.5 整数倍）', () => {
  assert.equal(scaleFor(0), 1.5, '零数据下限量程（1×1.15 向上取 0.5）');
  assert.equal(scaleFor(10.9), 13, '演示数据 ±10.9 → ±13');
  assert.equal(scaleFor(5.5), 6.5);
  assert.equal(scaleFor(1), 1.5);
  assert.equal(scaleFor(-8), 9.5, '负输入取绝对值');
});

test('FE-CURVE-03 | 坐标映射', () => {
  assert.equal(winrateY(G, 50), G.mid);
  assert.equal(winrateY(G, 0), G.bottom);
  assert.equal(winrateY(G, 100), G.top);
  assert.equal(scoreY(G, 0, 13), G.mid);
  assert.equal(scoreY(G, 13, 13), G.top);
  assert.equal(scoreY(G, -13, 13), G.bottom);
  assert.equal(xOfMove(G, 0, 42), G.x0);
  assert.equal(xOfMove(G, 42, 42), G.x1);
  assert.ok(Math.abs(xOfMove(G, 21, 42) - (G.x0 + G.x1) / 2) < 1e-9, '半数 → 绘图区中点 x');
  assert.equal(xOfMove(G, 5, 0), G.x0, 'total<=0 贴左缘');
});

test('FE-CURVE-04 | 底部手数刻度', () => {
  assert.equal(niceTickStep(42), 10);
  assert.equal(niceTickStep(88), 20);
  assert.equal(niceTickStep(13), 2);
  assert.deepEqual(moveTicks(42), [10, 20, 30, 40]);
  assert.deepEqual(moveTicks(88), [20, 40, 60, 80]);
  assert.deepEqual(moveTicks(5), [1, 2, 3, 4]);
  assert.deepEqual(moveTicks(1), []);
  assert.deepEqual(moveTicks(0), []);
});

test('FE-CURVE-05 | toSeries 归一（小数↔百分 + 排序去重）', () => {
  const s1 = toSeries([
    { moveNo: 2, winrate: 0.55, scoreLead: 1.5 },
    { moveNo: 1, winrate: 0.5, scoreLead: 0 },
    { moveNo: 2, winrate: 0.6, scoreLead: 2.5 }, // 同 moveNo 后写覆盖
  ], { winrateUnit: 'fraction' });
  assert.equal(s1.total, 2);
  assert.equal(s1.pts.length, 2);
  assert.equal(s1.pts[0].moveNo, 1);
  assert.equal(s1.pts[0].winrate, 50, 'fraction ×100');
  assert.equal(s1.pts[1].winrate, 60);
  assert.equal(s1.pts[1].scoreLead, 2.5);

  const s2 = toSeries([
    { moveNo: 0, winrate: 54.2, scoreLead: null },
    { moveNo: 3, winrate: null, scoreLead: -4.5 },
  ]);
  assert.equal(s2.pts[0].winrate, 54.2, 'percent 直通');
  assert.equal(s2.pts[0].scoreLead, null);
  assert.equal(s2.pts[1].winrate, null);

  assert.equal(toSeries(null).pts.length, 0);
  assert.equal(toSeries([{ moveNo: 'x', winrate: 1 }]).total, 0, '非法 moveNo 剔除');
});

test('FE-CURVE-06 | 路径 d 构建', () => {
  const g = curveGeometry();
  g.__total = 42;
  const pts = toSeries([
    { moveNo: 0, winrate: 50, scoreLead: 0 },
    { moveNo: 10, winrate: 60, scoreLead: 5 },
    { moveNo: 20, winrate: null, scoreLead: null }, // 空洞被跳过
    { moveNo: 42, winrate: 40, scoreLead: -3 },
  ]).pts;
  const dW = linePath(pts, 'winrate', g, (v) => winrateY(g, v));
  assert.ok(dW.startsWith('M') && dW.includes(' L'), '折线路径');
  const dD = linePath(pts, 'scoreLead', g, (v) => scoreY(g, v, 7));
  assert.ok(dD.startsWith('M') && dD.includes(' L'));
  assert.equal(linePath([], 'winrate', g, () => 0), '');
  assert.equal(linePath([{ moveNo: 1, winrate: null, scoreLead: null }], 'winrate', g, () => 0), '');
  const dA = areaPath(pts, g);
  assert.ok(dA.endsWith('Z'), '面积闭合');
  assert.equal(areaPath([], g), '');
});

test('FE-CURVE-07 | markup 结构与轴标签', () => {
  const html = buildCurveMarkup({
    pts: [
      { moveNo: 0, winrate: 50, scoreLead: 0 },
      { moveNo: 1, winrate: 56, scoreLead: 0.9 },
      { moveNo: 2, winrate: 55, scoreLead: -4.5 },
      { moveNo: 3, winrate: 62, scoreLead: 3.6 },
      { moveNo: 4, winrate: 60, scoreLead: -1.8 },
      { moveNo: 5, winrate: 66, scoreLead: 5.5 },
      { moveNo: 6, winrate: 64, scoreLead: 0 },
      { moveNo: 7, winrate: 69, scoreLead: 7.3 },
      { moveNo: 8, winrate: 67, scoreLead: 1.8 },
      { moveNo: 9, winrate: 72, scoreLead: 9.1 },
      { moveNo: 10, winrate: 70, scoreLead: 3.6 },
      { moveNo: 11, winrate: 75, scoreLead: 10.9 },
      { moveNo: 12, winrate: 73, scoreLead: 5.5 },
    ],
    current: 12,
    total: 42,
    xTicks: [10, 20, 30, 40],
  });
  for (const cls of ['cr-mid', 'cr-area', 'cr-w', 'cr-d', 'cr-cur', 'cr-dot', 'cr-labels']) {
    assert.ok(html.includes(`class="${cls}"`) || html.includes(cls), `包含 ${cls}`);
  }
  // 轴标签（2026/09/06 人工反馈）：左 100/50/0；目差右轴仅满量程与 0（±13 / 0），
  // 不显示中间 ±half（±6.5）刻度
  for (const token of ['100%', '50%', '0%', '+13', '0', '−13', '>10</text>', '>20</text>', '>40</text>']) {
    assert.ok(html.includes(token), `含 ${token}`);
  }
  for (const absent of ['+6.5', '−6.5']) {
    assert.ok(!html.includes(absent), `不含中间半刻度 ${absent}`);
  }
  // 颜色语义（2026/09/05 人工确认）：胜率线/面积随主题（CSS var）；仅目差虚线固定色且细
  assert.ok(html.includes('stroke="var(--accent)"'), '胜率主轴随主题 accent');
  assert.ok(html.includes('fill="var(--accent-soft)"'), '胜率面积随主题 accent-soft');
  assert.ok(html.includes('stroke="#7A8B99"'), '目差虚线固定色');
  assert.ok(html.includes('stroke-width="1"'), '目差虚线 1.0（细）');
});

test('FE-CURVE-08 | 空数据与边界', () => {
  const html = buildCurveMarkup({ pts: [] });
  assert.ok(html.includes('cr-mid'));
  assert.ok(html.includes('cr-labels'));
  assert.ok(html.includes('0%'));
  // 全部 null
  const html2 = buildCurveMarkup({ pts: [{ moveNo: 0, winrate: null, scoreLead: null }], total: 10 });
  assert.ok(html2.includes('cr-w'));
});

test('FE-CURVE-09 | labels 片段独立可用（右轴仅满量程+0）', () => {
  const g = curveGeometry();
  const labels = buildLabelsMarkup(g, 13, 42, [10, 20, 30, 40]);
  assert.ok(labels.includes('100%'));
  assert.ok(labels.includes('50%'));
  assert.ok(labels.includes('+13'));
  assert.ok(labels.includes('0'));
  assert.ok(labels.includes('−13'));
  assert.ok(!labels.includes('6.5'), '无中间半刻度');
  assert.ok(labels.includes('>40</text>'));
});

test('FE-CURVE-10 | morphPts 新增点前值外推生长 + 删点保持', () => {
  const prev = [
    { moveNo: 1, winrate: 50, scoreLead: 0 },
    { moveNo: 2, winrate: 60, scoreLead: 4 },
  ];
  const next = [
    { moveNo: 1, winrate: 50, scoreLead: 0 },
    { moveNo: 2, winrate: 62, scoreLead: 5 },
    { moveNo: 3, winrate: 70, scoreLead: 8 },
  ];
  // 既有点：逐点插值
  const mid = morphPts(prev, next, 0.5);
  const p2 = mid.find((p) => p.moveNo === 2);
  assert.equal(p2.winrate, 61);
  assert.equal(p2.scoreLead, 4.5);
  // 新增点 t=0 = 上一数据点前值（生长动效而非弹出）；t=1 = 目标值
  const startP3 = morphPts(prev, next, 0).find((p) => p.moveNo === 3);
  assert.equal(startP3.winrate, 60, '新增点从上一数据点生长');
  assert.equal(startP3.scoreLead, 4);
  const endP3 = morphPts(prev, next, 1).find((p) => p.moveNo === 3);
  assert.equal(endP3.winrate, 70);
  // 删点（撤销）：保持原值至结束帧（由精确目标帧剔除）
  const undone = morphPts(prev, [{ moveNo: 1, winrate: 50, scoreLead: 0 }], 1);
  assert.equal(undone.find((p) => p.moveNo === 2).winrate, 60);
  assert.deepEqual(morphPts([], [], 0.5), []);
});

test('FE-CURVE-11 | clientX/viewBox 反解（绘图区 padding，禁止整宽近似）', () => {
  assert.equal(clientXToViewBoxX(44, { left: 0, width: 340 }), 44, '1:1');
  assert.equal(clientXToViewBoxX(188, { left: 100, width: 680 }), 44, '2× 宽线性映射');
  assert.equal(clientXToViewBoxX(0, { left: 0, width: 0 }), 0, '零宽兜底');
  // 绘图区 x0=44 → 0 手；x1=300 → total（曾按整宽比例近似→点击定位错位）
  assert.equal(moveNoAtViewBoxX(44, 28), 0);
  assert.equal(moveNoAtViewBoxX(172, 28), 14);
  assert.equal(moveNoAtViewBoxX(300, 28), 28);
  assert.equal(moveNoAtViewBoxX(0, 28), 0, '左越界钳制');
  assert.equal(moveNoAtViewBoxX(400, 28), 28, '右越界钳制');
  assert.equal(moveNoAtViewBoxX(172, 0), 0, 'total<=0 → 0');
});

test('FE-CURVE-12 | nearestPoint 就近吸附', () => {
  const pts = [{ moveNo: 0 }, { moveNo: 5 }, { moveNo: 9 }];
  assert.equal(nearestPoint(pts, 4).moveNo, 5);
  assert.equal(nearestPoint(pts, 2.4).moveNo, 0);
  assert.equal(nearestPoint(pts, 100).moveNo, 9);
  assert.equal(nearestPoint([], 3), null);
});

test('FE-CURVE-13 | hoverDetailText 明细文案（负号 U+2212 / 缺项省略）', () => {
  assert.equal(
    hoverDetailText({ moveNo: 45, winrate: 54.2, scoreLead: 3.1 }),
    '第 45 手 · 胜率 54.2% · 目差 +3.1',
  );
  assert.equal(
    hoverDetailText({ moveNo: 12, winrate: 60, scoreLead: -2.4 }),
    '第 12 手 · 胜率 60% · 目差 −2.4',
  );
  assert.equal(hoverDetailText({ moveNo: 7, winrate: null, scoreLead: 1 }), '第 7 手 · 目差 +1');
  assert.equal(hoverDetailText({ moveNo: 0, winrate: 50, scoreLead: null }), '第 0 手 · 胜率 50%');
  assert.equal(hoverDetailText(null), '');
});

test('FE-CURVE-14 | markup 含 hover 联动层（初始隐藏）', () => {
  const html = buildCurveMarkup({ pts: [{ moveNo: 1, winrate: 50, scoreLead: 0 }], total: 2 });
  assert.ok(html.includes('class="cr-hover u-hide"'), 'hover 组存在且初始隐藏');
  assert.ok(html.includes('class="cr-hx"'), '最近点竖线');
  assert.ok(html.includes('class="cr-hd"'), '最近点圆点');
});

test('FE-CURVE-15 | pointsEqual：仅当前手/量程变化不播动画', () => {
  const a = [
    { moveNo: 0, winrate: 50, scoreLead: 0 },
    { moveNo: 1, winrate: 55.5, scoreLead: 2 },
  ];
  assert.equal(pointsEqual(a, a.map((p) => ({ ...p }))), true, '同值等价（拷贝）');
  assert.equal(pointsEqual(a, [...a, { moveNo: 2, winrate: 60, scoreLead: 3 }]), false, '新增点 → 需动画');
  assert.equal(pointsEqual(a, [a[0], { ...a[1], winrate: 55.6 }]), false, '数值修订 → 需动画');
  assert.equal(
    pointsEqual([{ moveNo: 0, winrate: null, scoreLead: 0 }], [{ moveNo: 0, winrate: null, scoreLead: 0 }]),
    true,
  );
  assert.equal(pointsEqual([{ moveNo: 0, winrate: null }], [{ moveNo: 0, winrate: 50 }]), false, 'null ↔ 数值');
  assert.equal(
    pointsEqual([{ moveNo: 0, winrate: 50.000000001 }], [{ moveNo: 0, winrate: 50 }]),
    true,
    '浮点尾差容差（morph 末帧衔接）',
  );
  assert.equal(pointsEqual([], []), true);
  assert.equal(pointsEqual(a, a.slice(0, 1)), false, '长度不同');
});
