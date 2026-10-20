/**
 * tGo · 顶部横幅（T5.4）
 *
 * 承载「重连中 / 引擎降级」等全局提示（UI_UX §6.2/§10、重连横幅）；
 * 单例渲染到 #banner-root。DOM 模块：驱动交给 Phase 6（WS 状态/onboarding），
 * 此处仅提供组件能力，供壳与视图手动调用。
 */

const BANNER_TONE = {
  warn: 'tone-warn',
  error: 'tone-error',
  info: 'tone-info',
};

function ensureRoot(doc = document) {
  let root = doc.getElementById('banner-root');
  if (!root) {
    root = doc.createElement('div');
    root.id = 'banner-root';
    root.className = 'banner-root';
    doc.body.appendChild(root);
  }
  return root;
}

/**
 * 显示横幅（同一 tone 覆盖旧横幅，避免叠层）。
 * @param {object} opts {tone:'warn'|'error'|'info', text, actions?:[{label,onClick,primary?}]}
 * @returns {() => void} dismiss
 */
export function showBanner(opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return () => {};
  const root = ensureRoot(doc);
  // 同一 tone 只保留最新
  root.querySelectorAll(`.banner[data-tone="${opts.tone || 'info'}"]`).forEach((el) => el.remove());

  const el = doc.createElement('div');
  el.className = `banner ${BANNER_TONE[opts.tone] || BANNER_TONE.info}`;
  el.dataset.tone = opts.tone || 'info';
  el.setAttribute('role', opts.tone === 'error' ? 'alert' : 'status');

  const text = doc.createElement('span');
  text.className = 'banner-text';
  text.textContent = opts.text || '';
  el.appendChild(text);

  if (Array.isArray(opts.actions)) {
    const group = doc.createElement('span');
    group.className = 'banner-actions';
    for (const act of opts.actions) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = act.primary ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm';
      btn.textContent = act.label || '';
      btn.addEventListener('click', () => {
        if (act.onClick) act.onClick();
      });
      group.appendChild(btn);
    }
    el.appendChild(group);
  }

  const dismissBtn = doc.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'icon-btn banner-close';
  dismissBtn.setAttribute('aria-label', '关闭提示');
  dismissBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>';
  dismissBtn.addEventListener('click', () => dismiss());
  el.appendChild(dismissBtn);

  root.appendChild(el);

  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    el.remove();
  }
  return dismiss;
}
