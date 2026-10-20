/**
 * tGo · core/dialog.js 纯逻辑无头单测（2026/09/19，node --test）
 * 用例 ID: FE-DLG-*
 * 覆盖：`hasOpenDialogMask`——ESC 让位判定必须按**可见性**（报告弹层单例常驻 DOM，
 * 关闭后 `display:none`；存在性判定会永久拦截宿主 ESC，实测踩坑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasOpenDialogMask } from '../static/js/core/dialog.js';

function fakeDoc(items) {
  return {
    querySelectorAll: () => items,
    defaultView: { getComputedStyle: (el) => ({ display: el.display }) },
  };
}

test('FE-DLG-01 | hasOpenDialogMask：仅可见遮罩判定为打开（常驻单例 display:none 不拦截）', () => {
  assert.equal(hasOpenDialogMask(fakeDoc([])), false);
  // 报告弹层单例：关闭后仍常驻 DOM（display:none）→ 不算打开
  assert.equal(hasOpenDialogMask(fakeDoc([{ display: 'none' }])), false);
  // 任一可见遮罩（确认框挂载即见 / 报告弹层 .open）→ 视为打开
  assert.equal(hasOpenDialogMask(fakeDoc([{ display: 'none' }, { display: 'flex' }])), true);
  assert.equal(hasOpenDialogMask(fakeDoc([{ display: 'block' }])), true);
  // 容错：无 Document / 无 defaultView（Node 裸环境）→ 不拦截
  assert.equal(hasOpenDialogMask(null), false);
  assert.equal(hasOpenDialogMask({ querySelectorAll: () => [] }), false);
});
