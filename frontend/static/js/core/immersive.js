/**
 * tGo · 沉浸模式（T5.4，UI_UX §6.6）
 *
 * 隐藏顶栏/侧栏/信息行/分析抽屉，仅留棋盘 + 棋盘下方一行操作（body.immersive；
 * 样式见 css/app.css）；
 * 退出：ESC 键 / 右上角悬浮“退出沉浸”按钮（2026/09/14 由左上移至右上）；
 * 沉浸中保留引擎警示条（不隐藏 .warn-banner）。
 *
 * 2026/09/21 人工决策（沉浸底行）：保留 左[提子计数器] 右[PASS][悔棋]（[支招]/[领地]/
 * 移动端胜率条隐藏），行恒贴棋盘下方并与棋盘整体垂直居中——纯 CSS 口径，本模块只负责
 * body.immersive 类与退出入口。
 */

/**
 * 创建沉浸管理器。
 * @param {object} [opts]
 * @param {Document} [opts.doc]
 * @param {Function} [opts.onChange]
 */
export function createImmersive(opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  let active = false;
  let exitBtn = null;
  let keyHandler = null;

  function ensureExitButton() {
    if (!doc || exitBtn) return;
    exitBtn = doc.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'btn btn-secondary immersive-exit';
    exitBtn.textContent = '退出沉浸';
    exitBtn.setAttribute('aria-label', '退出沉浸模式');
    exitBtn.addEventListener('click', () => exit());
    doc.body.appendChild(exitBtn);
  }

  function enter() {
    if (!doc || active) return;
    active = true;
    doc.body.classList.add('immersive');
    ensureExitButton();
    keyHandler = (e) => {
      if (e.key === 'Escape' && active) exit();
    };
    doc.addEventListener('keydown', keyHandler);
    if (opts.onChange) opts.onChange(true);
  }

  function exit() {
    if (!doc || !active) return;
    active = false;
    doc.body.classList.remove('immersive');
    if (exitBtn) {
      exitBtn.remove();
      exitBtn = null;
    }
    if (keyHandler) {
      doc.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    if (opts.onChange) opts.onChange(false);
  }

  function toggle() {
    if (active) exit();
    else enter();
  }

  return { enter, exit, toggle, isActive: () => active };
}
