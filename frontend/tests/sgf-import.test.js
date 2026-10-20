/**
 * tGo · sgf-import.js 纯函数无头单测（T6.7，node --test）
 * 用例 ID: FE-SGFI-*
 * 覆盖：客户端文件预检（checkSgfFile）、成功 Toast 文案、标题派生、
 * 异常 → Toast 载荷（错误码映射）。DOM 装配（attachSgfImporter）为浏览器薄
 * 胶水，人工验收轮覆盖（项目测试分层约定）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SGF_MAX_BYTES,
  checkSgfFile,
  gameTitleOf,
  importSuccessText,
  importErrorToast,
  importCtaLabelTarget,
  SGF_HINT,
} from '../static/js/core/sgf-import.js';

test('FE-SGFI-01 预检：正常文件通过 / 空与缺失拒绝 / 超 5MB 拒绝', () => {
  const ok = checkSgfFile({ name: 'a.sgf', size: 128 });
  assert.deepEqual(ok, { ok: true, file: { name: 'a.sgf', size: 128 } });
  assert.equal(checkSgfFile(null).code, 'SGF_INVALID');
  assert.equal(checkSgfFile({ name: 'a.sgf', size: 0 }).code, 'SGF_INVALID');
  assert.equal(checkSgfFile({ name: 'a.sgf', size: SGF_MAX_BYTES + 1 }).code, 'SGF_TOO_LARGE');
  assert.equal(checkSgfFile({ name: 'a.sgf', size: SGF_MAX_BYTES }).ok, true, '恰等于上限应通过');
});

test('FE-SGFI-02 标题/成功文案派生（缺名回退默认）', () => {
  assert.equal(gameTitleOf({ black_name: '张三', white_name: 'AI' }), '张三 vs AI');
  assert.equal(gameTitleOf({ black_name: '王先生', white_name: '王太太' }), '王先生 vs 王太太');
  assert.equal(gameTitleOf(null), '真人 vs 真人');
  assert.equal(importSuccessText({ black_name: '张三', white_name: 'AI' }), '已导入：张三 vs AI');
  assert.equal(SGF_HINT, '导入棋谱（SGF）', '顶栏提示信息须为「导入棋谱（SGF）」（2026/09/20 人工反馈）');
});

test('FE-SGFI-03 异常 → Toast 载荷（错误码文案/网络回退）', () => {
  const bad = new Error('x');
  bad.code = 'SGF_INVALID';
  const t = importErrorToast(bad);
  assert.equal(t.level, 'error');
  assert.equal(t.code, 'SGF_INVALID');
  assert.equal(t.key, 'sgf-import');
  const neterr = importErrorToast(new Error('offline'));
  assert.equal(neterr.code, 'NETWORK_ERROR');
  assert.equal(importErrorToast(null), null);
});

test('FE-SGFI-04 忙碌态文本载体：只改写标签节点（不得抹除 svg 图标，BUG-107）', () => {
  // 新模板：按钮内 svg + <span data-ref="ctaImportLabel">导入棋谱</span> → 返回标签节点
  const labelNode = { textContent: '导入棋谱' };
  const cta = {
    innerHTML: '<svg><use href="#i-sgf"/></svg>',
    textContent: '导入棋谱',
    querySelector: (sel) => (sel === '[data-ref="ctaImportLabel"]' ? labelNode : null),
  };
  const got = importCtaLabelTarget(cta);
  assert.equal(got.target, labelNode);
  assert.equal(got.label, '导入棋谱');
  // 旧模板无标签节点 → 回退按钮本体（向后兼容）
  const legacy = { querySelector: () => null, textContent: '导入棋谱' };
  assert.equal(importCtaLabelTarget(legacy).target, legacy);
  // 空入参容错
  assert.deepEqual(importCtaLabelTarget(null), { target: null, label: '' });
});
