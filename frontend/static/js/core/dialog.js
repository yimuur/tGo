/**
 * tGo · Dialog / 二次确认（T5.4，C15）
 *
 * 复用 app.css Part Ⅰ 既有 `.dialog-mask / .dialog`（与报告弹层同体系）。
 * 交互（UI_UX §6.5 / §6.8）：遮罩点击与 Esc 取消、焦点进入首按钮、返回原焦点。
 * DOM 模块：人工验收轮覆盖；无业务逻辑可无头断言。
 *
 * T6.4 扩展：``confirmAbortable`` —— 返回 { promise, dismiss }，可由服务端事件
 * （如悔棋申请被对方撤回/已处理）主动撤销弹窗（等同取消 resolve(false)），
 * 用于对端设备上的待确认弹窗避免永久悬挂。
 */

export function ensureModalRoot(doc = document) {
  let root = doc.getElementById('modal-root');
  if (!root) {
    root = doc.createElement('div');
    root.id = 'modal-root';
    doc.body.appendChild(root);
  }
  return root;
}

/**
 * 是否存在**可见**的弹层遮罩（ESC 让位判定，2026/09/19 修正）。
 *
 * 注意：报告弹层（`report-dialog.js`）为全站单例 `.dialog-mask.report-modal`——
 * 首次打开后元素**常驻 DOM**（`.open` 类控显隐，不 remove）；因此
 * `document.querySelector('.dialog-mask')` 的存在性判定会在弹层关闭后**永久**
 * 拦截宿主 ESC（复盘补结算 / 对弈结算抽屉实测踩坑）。必须按**可见性**判定：
 * 计算样式 `display !== 'none'` 同时覆盖常驻单例（display 切换）与一次性确认框
 * （挂载即可见、关闭即 remove）。
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function hasOpenDialogMask(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return false;
  const view = doc.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  for (const m of doc.querySelectorAll('.dialog-mask')) {
    if (view.getComputedStyle(m).display !== 'none') return true;
  }
  return false;
}

/** 构建并挂载确认框（不接线事件，由 confirm / confirmAbortable 各自接线）。 */
function mountConfirm(opts) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  const {
    title = '确认操作', message = '', okText = '确定', cancelText = '取消',
    danger = false, okIcon = 'i-success',
  } = opts;

  const root = ensureModalRoot(doc);
  const mask = doc.createElement('div');
  mask.className = 'dialog-mask';
  mask.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
        <div class="dialog-title">${escapeHtml(title)}</div>
        ${message ? `<div class="dialog-msg">${escapeHtml(message)}</div>` : ''}
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">
            <svg class="icon" aria-hidden="true"><use href="#${escapeHtml(okIcon)}"/></svg>${escapeHtml(okText)}
          </button>
        </div>
      </div>`;

  const previousFocus = doc.activeElement;
  root.appendChild(mask);
  const okBtn = mask.querySelector('[data-act="ok"]');
  okBtn.focus();

  return {
    doc,
    mask,
    previousFocus,
    ok: okBtn,
    cancel: mask.querySelector('[data-act="cancel"]'),
  };
}

/** 拆除弹窗并归还焦点。 */
function teardownConfirm(handle) {
  if (handle.mask && handle.mask.parentNode) handle.mask.remove();
  handle.doc.removeEventListener('keydown', handle.onKey, true);
  if (handle.previousFocus && typeof handle.previousFocus.focus === 'function') {
    handle.previousFocus.focus();
  }
}

/**
 * 打开确认框。
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.message]
 * @param {string} [opts.okText='确定']
 * @param {string} [opts.cancelText='取消']
 * @param {boolean} [opts.danger=false] 主按钮使用 danger 样式
 * @param {string} [opts.okIcon]  icons symbol id（默认 i-success）
 * @returns {Promise<boolean>} true=确认
 */
export function confirm(opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return Promise.resolve(false);

  const handle = mountConfirm(opts);
  if (!handle) return Promise.resolve(false);

  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      teardownConfirm(handle);
      resolve(value);
    };
    handle.onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    handle.mask.addEventListener('click', (e) => {
      if (e.target === handle.mask) finish(false); // 遮罩取消
    });
    handle.mask.addEventListener('keydown', handle.onKey, true);
    handle.ok.addEventListener('click', () => finish(true));
    handle.cancel.addEventListener('click', () => finish(false));
  });
}

/**
 * 可撤销确认框（T6.4）：行为与 ``confirm`` 一致，另暴露 ``dismiss()``，
 * 供外部事件（如悔棋申请被撤回）主动关闭（等同取消，resolve(false)）。
 * @returns {{ promise: Promise<boolean>, dismiss: () => void }}
 */
export function confirmAbortable(opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const handle = doc ? mountConfirm(opts) : null;

  const promise = new Promise((resolve) => {
    if (!handle) {
      resolve(false);
      return;
    }
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      teardownConfirm(handle);
      resolve(value);
    };
    handle.onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    handle.mask.addEventListener('click', (e) => {
      if (e.target === handle.mask) finish(false); // 遮罩取消
    });
    handle.mask.addEventListener('keydown', handle.onKey, true);
    handle.ok.addEventListener('click', () => finish(true));
    handle.cancel.addEventListener('click', () => finish(false));
    handle._finish = finish;
  });

  return {
    promise,
    dismiss: () => {
      if (handle && handle._finish) handle._finish(false);
    },
  };
}

/** 简单 HTML 转义（message/title 为外部数据，防注入）。 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { escapeHtml };
