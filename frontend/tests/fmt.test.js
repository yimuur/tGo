/**
 * tGo · fmt.js 格式化工具无头单测（T5.6，node --test）
 * 用例 ID: FE-FMT-*
 * 覆盖（TASK.md T5.6 验收「格式化矩阵」）：符号约定（负号 U+2212）、胜率/目差/时间
 * Intl、段位、结果、点评五色、Visit 紧凑数。全部纯函数注入式（now/formatter）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRADE_TEXT,
  GRADE_ALT,
  rankText,
  round,
  signed,
  pct,
  pctCompact,
  signedPct,
  scoreLead,
  scoreLeadUnit,
  visits,
  relTimeText,
  absoluteTimeText,
  toTime,
  resultText,
  gradeText,
  gradeAlt,
  gradeBubbleTitle,
  winrateToPercent,
} from '../static/js/core/fmt.js';

/* 固定基准时刻（2026-09-05 12:00 UTC）供相对时间断言确定性 */
const T0 = Date.UTC(2026, 8, 5, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('FE-FMT-01 | round 与负零', () => {
  assert.equal(round(3.14159, 2), 3.14);
  assert.equal(round(3, 1), 3);
  assert.equal(round(-2.75, 1), -2.8);
  assert.equal(round(-0.004, 2), 0, '负零归零');
  assert.ok(Number.isNaN(round('abc', 1)));
});

test('FE-FMT-02 | signed 符号约定（负 = U+2212）', () => {
  assert.equal(signed(3.1, 1), '+3.1');
  assert.equal(signed(-9.2, 1), '−9.2', '负号为 U+2212');
  assert.equal(signed(3, 0), '+3');
  assert.equal(signed(-2.75, 1), '−2.8');
  assert.equal(signed(0, 1), '+0');
  assert.equal(signed(-5, 0), '−5');
  assert.equal(signed(null, 1), '');
});

test('FE-FMT-03 | pct / pctCompact', () => {
  assert.equal(pct(54.2), '54.2%');
  assert.equal(pct(62), '62%');
  assert.equal(pct(100), '100%');
  assert.equal(pct(null), '');
  assert.equal(pctCompact(43.4), '43%');
  assert.equal(pctCompact(62), '62%');
});

test('FE-FMT-04 | signedPct（coach 行 / 胜率条 delta）', () => {
  assert.equal(signedPct(4.2), '+4.2%');
  assert.equal(signedPct(-9.2), '−9.2%');
  assert.equal(signedPct(-5, 0), '−5%');
  assert.equal(signedPct(1, 0), '+1%');
});

test('FE-FMT-05 | scoreLead / scoreLeadUnit', () => {
  assert.equal(scoreLead(3.1), '+3.1');
  assert.equal(scoreLead(-0.4), '−0.4');
  assert.equal(scoreLeadUnit(3.1), '+3.1 目');
  assert.equal(scoreLeadUnit(-2.8), '−2.8 目');
  assert.equal(scoreLeadUnit(null), '');
});

test('FE-FMT-06 | visits 紧凑数', () => {
  assert.equal(visits(512), '512 Visit');
  assert.equal(visits(860), '860 Visit');
  assert.equal(visits(1200), '1.2k Visit');
  assert.equal(visits(5120), '5.1k Visit');
  assert.equal(visits(0), '0 Visit');
  assert.equal(visits(null), '');
});

test('FE-FMT-07 | rankText 段位', () => {
  assert.equal(rankText('rank_5k'), '5K');
  assert.equal(rankText('rank_1d'), '1D');
  assert.equal(rankText('rank_20k'), '20K');
  assert.equal(rankText('rank_9d'), '9D');
  assert.equal(rankText('5k'), '5K', '非 rank_ 前缀也兼容');
  assert.equal(rankText('3D'), '3D');
  assert.equal(rankText('rank_3k'), '3K');
  assert.equal(rankText(null), '');
  assert.equal(rankText(''), '');
  assert.equal(rankText('1段'), '1段', '非标文本原样返回');
});

test('FE-FMT-08 | resultText 结果文案', () => {
  assert.equal(resultText('B+7.5'), '黑胜 7.5 目 (B+7.5)');
  assert.equal(resultText('B+7.5', { verbose: false }), '黑胜 7.5 目');
  assert.equal(resultText('W+2'), '白胜 2 目 (W+2)');
  assert.equal(resultText('W+2', { verbose: false }), '白胜 2 目');
  assert.equal(resultText('B+Resign'), '黑中盘胜 (B+Resign)');
  assert.equal(resultText('W+Resign', { verbose: false }), '白中盘胜');
  assert.equal(resultText('W+R'), '白中盘胜 (W+R)', '兼容 W+R');
  assert.equal(resultText('Draw'), '和棋');
  assert.equal(resultText(null), '');
  assert.equal(resultText(''), '');
  assert.equal(resultText('xyz'), 'xyz', '未知结果原样');
});

test('FE-FMT-09 | 点评五色文案', () => {
  assert.equal(gradeText('brilliant'), '妙着');
  assert.equal(gradeText('mistake'), '失误');
  assert.equal(gradeText('blunder'), '败着');
  assert.equal(gradeAlt('good'), '好棋');
  assert.equal(gradeBubbleTitle('mistake'), '失误（恶手）');
  assert.equal(gradeBubbleTitle('blunder'), '败着（昏招）');
  assert.equal(gradeBubbleTitle('brilliant'), '妙着（绝妙）');
  assert.equal(gradeText('slow'), '缓着');
  assert.equal(gradeText('zz'), 'zz', '未知原样');
  assert.ok(GRADE_TEXT.brilliant === '妙着' && GRADE_ALT.blunder === '昏招');
});

test('FE-FMT-10 | relTimeText 相对时间', () => {
  const now = T0;
  assert.equal(relTimeText(T0 - 30 * 1000, { now }), '刚刚');
  assert.equal(relTimeText(T0 - 90 * 1000, { now }), '1 分钟前');
  assert.equal(relTimeText(T0 - 5 * MIN, { now }), '5 分钟前');
  assert.equal(relTimeText(T0 - 2 * HOUR, { now }), '2 小时前');
  assert.equal(relTimeText(T0 - 26 * HOUR, { now }), '昨天');
  assert.equal(relTimeText(T0 - 3 * DAY, { now }), '3 天前');
  assert.equal(relTimeText(T0 - 7 * DAY, { now }), '7 天前', '≤7 天仍相对');
  const past8 = T0 - 8 * DAY;
  const abs = relTimeText(past8, { now });
  assert.ok(abs.length > 0 && !abs.includes('天前'), '>7 天回退绝对时间');
  assert.equal(abs, absoluteTimeText(past8, { now }));
  // 非法输入
  assert.equal(relTimeText(null, { now }), '');
  assert.equal(relTimeText('not-a-date', { now }), '');
});

test('FE-FMT-11 | absoluteTimeText 注入式 Intl', () => {
  const formatter = { format: () => '2026/09/05 20:00' };
  assert.equal(absoluteTimeText(T0, { formatter }), '2026/09/05 20:00');
  assert.equal(absoluteTimeText(null, { formatter }), '');
});

test('FE-FMT-12 | toTime 归一', () => {
  assert.equal(toTime(T0), T0);
  assert.equal(toTime(new Date(T0)), T0);
  assert.equal(toTime(new Date('bad')), null);
  assert.equal(toTime('2026-09-05T12:00:00Z'), T0);
  assert.equal(toTime(null), null);
});

test('FE-FMT-14 | toTime：SQLite 无时区时间按 UTC 解析（修复列表“最后更新”时区偏移）', () => {
  // 后端 datetime('now') 输出 'YYYY-MM-DD HH:MM:SS'（UTC 无时区标记），不得当本地时间解析
  assert.equal(toTime('2026-09-06 13:29:41'), Date.UTC(2026, 8, 6, 13, 29, 41));
  assert.equal(toTime('2026-09-05 04:00:00'), T0 - 8 * HOUR);
  assert.equal(toTime('2026-09-05T12:00:00Z'), T0); // 含 Z 维持原解析
  // 相对时间正确（naive UTC 距 now=12:00Z 应为 8 小时前，而非“2 小时前/未来”）
  assert.equal(relTimeText('2026-09-05 04:00:00', { now: T0 }), '8 小时前');
});

test('FE-FMT-13 | winrateToPercent 单位换算', () => {
  assert.equal(winrateToPercent(0.542, 'fraction'), 54.2);
  assert.equal(winrateToPercent(54.2, 'percent'), 54.2);
  assert.equal(winrateToPercent(0.15, 'fraction'), 15);
  assert.equal(winrateToPercent(null, 'fraction'), null);
});
