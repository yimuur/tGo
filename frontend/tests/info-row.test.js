/**
 * FE-INROW（core/info-row 纯函数层）· 信息行分段分组 + 信息弹层定位（2026/09/13）
 *
 * 覆盖：groupMetaSegments（移动端单行省略的 DOM 结构依据）/ infoPopPosition
 * （弹层视口钳制与上翻转）。DOM 控制器 createInfoPop 由浏览器实测覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupMetaSegments, infoPopPosition, metaPopText } from '../static/js/core/info-row.js';

test('FE-INROW-01 | groupMetaSegments 文本/徽章/开关三分组（对弈页形态）', () => {
  const segs = [
    { text: '135 手' },
    { text: '19 路' },
    { text: '中国规则' },
    { text: '贴 7.5 目' },
    { text: '分先' },
    { text: 'AI匹配 · 5K', badge: 'accent' },
    { text: '自动点评', coach: true, on: true },
  ];
  const out = groupMetaSegments(segs);
  assert.equal(out.pill, null);
  assert.deepEqual(out.clip.map((s) => s.text), ['135 手', '19 路', '中国规则', '贴 7.5 目', '分先']);
  assert.deepEqual(out.fixed.map((s) => s.text), ['AI匹配 · 5K', '自动点评']);
});

test('FE-INROW-02 | groupMetaSegments 试下胶囊拔首（pillIndex）且不入 clip/fixed', () => {
  const segs = [
    { text: '试下 · 第 12 手 / 30', trial: true },
    { text: '12 / 30 手' },
    { text: '中国规则' },
    { text: '自动点评', coach: true, on: false },
  ];
  const out = groupMetaSegments(segs, { pillIndex: 0 });
  assert.equal(out.pill.text, '试下 · 第 12 手 / 30');
  assert.deepEqual(out.clip.map((s) => s.text), ['12 / 30 手', '中国规则']);
  assert.deepEqual(out.fixed.map((s) => s.text), ['自动点评']);
  // 非试下态（pillIndex=-1）：首段回落 clip（普通文本）
  const plain = groupMetaSegments(segs.map((s, i) => (i === 0 ? { text: '第 12 / 30 手' } : s)));
  assert.equal(plain.pill, null);
  assert.equal(plain.clip[0].text, '第 12 / 30 手');
});

test('FE-INROW-03 | groupMetaSegments 全文本段时 fixed 为空（省略退化为纯文本行）', () => {
  const out = groupMetaSegments([{ text: '0 / 0 手' }, { text: '9 路' }]);
  assert.deepEqual(out.fixed, []);
  assert.equal(out.clip.length, 2);
  // 输入异常容错：非数组 → 空分组（不抛）
  const bad = groupMetaSegments(null);
  assert.deepEqual(bad, { pill: null, clip: [], fixed: [] });
});

test('FE-INROW-04 | infoPopPosition 缺省置于锚点下方并左对齐', () => {  const pos = infoPopPosition({
    anchor: { left: 40, right: 76, top: 20, bottom: 56 },
    size: { width: 300, height: 40 },
    viewport: { width: 390, height: 844 },
  });
  assert.deepEqual(pos, { left: 40, top: 62 });
});

test('FE-INROW-05 | infoPopPosition 右溢左移 + 下溢上翻 + 四周 margin 钳制', () => {
  // 右溢：left 300 + 宽 300 > 390-8 → 贴右边界内缩
  const right = infoPopPosition({
    anchor: { left: 300, right: 336, top: 20, bottom: 56 },
    size: { width: 300, height: 40 },
    viewport: { width: 390, height: 844 },
  });
  assert.equal(right.left, 390 - 8 - 300);
  // 下溢且上方充裕：上翻（top = anchor.top - gap - height）
  const flip = infoPopPosition({
    anchor: { left: 12, right: 48, top: 800, bottom: 836 },
    size: { width: 300, height: 60 },
    viewport: { width: 390, height: 844 },
  });
  assert.equal(flip.top, 800 - 6 - 60);
  // 弹层高于可用视口（横屏窄高）：上下都放不下 → 贴底部边界内缩（maxTop = H - margin - h）
  const clamp = infoPopPosition({
    anchor: { left: 12, right: 48, top: 20, bottom: 56 },
    size: { width: 300, height: 100 },
    viewport: { width: 390, height: 120 },
  });
  assert.equal(clamp.top, 120 - 8 - 100);
  // 左溢：贴左 margin
  const left = infoPopPosition({
    anchor: { left: -20, right: 16, top: 20, bottom: 56 },
    size: { width: 300, height: 40 },
    viewport: { width: 390, height: 844 },
  });
  assert.equal(left.left, 8);
});

test('FE-INROW-06 | metaPopText 弹层全文剔除徽章/开关段（2026/09/13 人工口径：只显示对局信息）', () => {
  const segs = [
    { text: '第 10 手' },
    { text: '13路' },
    { text: '中国' },
    { text: 'AI匹配 · 5K', badge: 'accent' },
    { text: '自动点评', coach: true, on: true },
  ];
  assert.equal(metaPopText(segs), '第 10 手 · 13路 · 中国');
  // 纯文本模式段（人类 · 10K）保留；徽章/开关一律剔除
  assert.equal(metaPopText([{ text: '第 15 / 17 手' }, { text: '人类 · 10K' }]), '第 15 / 17 手 · 人类 · 10K');
  assert.equal(metaPopText([{ text: 'AI匹配 · 5K', badge: 'accent' }]), '');
  assert.equal(metaPopText([{ text: '自动点评', coach: true, on: false }]), '');
  // 试下胶囊（纯文本位置信息，非徽章）保留
  assert.equal(metaPopText([{ text: '试下 · 第 1 手 / 1', trial: true }, { text: '13路' }]), '试下 · 第 1 手 / 1 · 13路');
  // 容错：非数组 / 空元素
  assert.equal(metaPopText(null), '');
  assert.equal(metaPopText([null, { text: '中国' }]), ' · 中国');
});
