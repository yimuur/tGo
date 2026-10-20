/**
 * tGo · 管理页「添盏清茶」自愿赞助入口（C18）
 *
 * 交互口径（2026/10/20 人工确认）：
 *   - 仅在管理页顶栏替换 [+ 创建对局]；按钮文本 `添盏清茶`，tooltip `蓄力长按，以添清茶`；
 *   - 点击＝发光反馈；按住 3 秒＝蓄力（按钮自下而上茶汤填充，液面为不同高度波峰起伏 +
 *     外围呼吸发光），完成后全屏彩带 + 赞助卡片；鼠标/触摸/键盘（Enter/Space 按住）三通道一致；
 *   - 按下即预取远程配置（jsDelivr → raw），但**不阻塞蓄力**；弹层先开，二维码区以
 *     骨架/错误+重试呈现，卡片尺寸固定不塌陷；
 *   - 支付方式默认微信，金额默认 8 元；两档金额各自独立二维码；
 *   - 关闭（[×]/遮罩/Esc/路由离开）时卡片以 Canvas 粒子「沙化」——粒子在原地细化、
 *     缓慢下沉并逐个淡出，形成溶解沙化；彩带与沙化均为纯 Canvas，无第三方依赖；
 *     `prefers-reduced-motion` 下跳过动效。
 *   - 友情提示末尾 `Powered by yimuur` 链接到当前更新源仓库主页。
 *
 * 边界：
 *   - 触摸端拦截 contextmenu / 文本选择 / 原生长按 callout（CSS + 事件双层）；
 *   - 移动超过 12px、pointercancel、窗口失焦、页面隐藏均取消蓄力；
 *   - 关闭/切路由时取消在途 rAF 与弹层订阅，避免幽灵动画和焦点残留。
 */

import { ensureModalRoot } from './dialog.js';
import {
  DEFAULT_GITHUB_BRANCH,
  DEFAULT_GITHUB_REPO,
  DEFAULT_SPONSOR_AMOUNT,
  DEFAULT_SPONSOR_METHOD,
  SPONSOR_AMOUNTS,
  SPONSOR_METHODS,
  SponsorConfigError,
  loadSponsorConfig,
  selectSponsorQr,
  sponsorQrUrls,
  sponsorMethodLabel,
  sponsorAmountLabel,
  normalizeGithubRepo,
} from './sponsor-config.js';

/** 蓄力时长（毫秒）。 */
export const SPONSOR_CHARGE_MS = 3_000;
/** 指针移动超过该距离取消蓄力（像素）。 */
export const SPONSOR_MOVE_CANCEL_PX = 12;
/** 点击发光动画时长（毫秒，与 CSS 保持一致）。 */
export const SPONSOR_GLOW_MS = 620;
/** 沙化动画时长（毫秒）：粒子原地溶解。 */
export const SPONSOR_SAND_MS = 720;
/** 彩带总时长（毫秒）。 */
export const SPONSOR_CONFETTI_MS = 4_200;
/** 蓄力取消时的回退动画时长（毫秒）。 */
const CHARGE_DRAIN_MS = 180;

/**
 * 蓄力进度（0..1，纯函数，供无头测试）。
 * @param {number} elapsedMs
 * @param {number} duration
 * @returns {number}
 */
export function sponsorChargeProgress(elapsedMs, duration = SPONSOR_CHARGE_MS) {
  const elapsed = Number(elapsedMs);
  const total = Number(duration);
  if (!Number.isFinite(elapsed) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(1, elapsed / total));
}

function nowMs(win) {
  return win && typeof win.performance !== 'undefined' && typeof win.performance.now === 'function'
    ? win.performance.now()
    : Date.now();
}

function reducedMotion(win) {
  try {
    return Boolean(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function cssVar(doc, name, fallback) {
  try {
    const value = doc.defaultView && doc.defaultView.getComputedStyle
      ? doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue(name)
      : '';
    return String(value || '').trim() || fallback;
  } catch {
    return fallback;
  }
}

function errorText(err) {
  if (err && err.code === 'SPONSOR_CONFIG_INVALID') return '赞助配置格式有误';
  if (err && err.code === 'SPONSOR_QR_UNAVAILABLE') return '二维码加载失败';
  return '赞助配置加载失败';
}

/**
 * 绑定赞助按钮。
 *
 * @param {object} opts
 * @param {HTMLButtonElement} opts.cta 顶栏按钮
 * @param {object} [opts.api] 壳级 REST 客户端（用于读取更新源仓库）
 * @param {Document} [opts.doc]
 * @param {Window} [opts.win]
 * @returns {{setActive:Function, destroy:Function, isActive:Function}}
 */
export function attachSponsor(opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const cta = opts.cta || null;
  const api = opts.api || null;
  if (!doc || !win || !cta) {
    return { setActive() {}, destroy() {}, isActive: () => false };
  }

  const raf = typeof win.requestAnimationFrame === 'function'
    ? win.requestAnimationFrame.bind(win)
    : (cb) => win.setTimeout(() => cb(nowMs(win)), 16);
  const caf = typeof win.cancelAnimationFrame === 'function'
    ? win.cancelAnimationFrame.bind(win)
    : (id) => win.clearTimeout(id);

  const defaultLabel = '添盏清茶（长按 3 秒支持作者）';
  const state = {
    active: false,
    destroyed: false,
    listeners: [],
    configPromise: null,
    configAbort: null,
    configToken: 0,
    config: null,
    repo: null,
    repoPromise: null,
    preloaded: [],
    dialog: null,
    charge: {
      active: false,
      complete: false,
      startedAt: 0,
      rafId: 0,
      drainRafId: 0,
      completeTimer: 0,
      source: null,
      pointerId: null,
      startX: 0,
      startY: 0,
      value: 0,
    },
    glowTimer: 0,
    openTimer: 0,
    resetTimer: 0,
    suppressClickUntil: 0,
    tipBackup: null,
  };

  // 液体填充层（若 HTML 未提供则动态补齐，保证按钮结构自洽）。
  let liquid = cta.querySelector('.sponsor-liquid');
  if (!liquid) {
    liquid = doc.createElement('span');
    liquid.className = 'sponsor-liquid';
    liquid.setAttribute('aria-hidden', 'true');
    cta.insertBefore(liquid, cta.firstChild);
  }
  cta.classList.add('hidden');
  if (!cta.getAttribute('data-tip')) cta.setAttribute('data-tip', '蓄力长按，以添清茶');
  cta.setAttribute('aria-label', defaultLabel);

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    state.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  function clearTimer(key) {
    if (state[key]) {
      win.clearTimeout(state[key]);
      state[key] = 0;
    }
  }

  function setChargeValue(value) {
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    state.charge.value = next;
    cta.style.setProperty('--sponsor-charge', next.toFixed(4));
    // 茶汤漫过文字中线后切换为深色墨字：浅色主题下避免白字压在琥珀色液体上对比不足。
    cta.classList.toggle('is-filled', next >= 0.6);
  }

  /** 蓄力期间临时摘除 tooltip：避免气泡遮挡进度；取消/关闭后恢复原文案。 */
  function disableTip() {
    if (state.tipBackup === null) state.tipBackup = cta.getAttribute('data-tip') || '';
    cta.removeAttribute('data-tip');
    if (win.tgoTooltip && typeof win.tgoTooltip.hide === 'function') win.tgoTooltip.hide();
  }

  function restoreTip() {
    if (state.tipBackup === null) return;
    const text = state.tipBackup;
    state.tipBackup = null;
    if (text) cta.setAttribute('data-tip', text);
    else cta.removeAttribute('data-tip');
  }

  function cancelChargeRaf() {
    if (state.charge.rafId) {
      caf(state.charge.rafId);
      state.charge.rafId = 0;
    }
  }

  function cancelDrain() {
    if (state.charge.drainRafId) {
      caf(state.charge.drainRafId);
      state.charge.drainRafId = 0;
    }
  }

  function clearChargeTimer() {
    if (state.charge.completeTimer) {
      win.clearTimeout(state.charge.completeTimer);
      state.charge.completeTimer = 0;
    }
  }

  function releasePointer() {
    const id = state.charge.pointerId;
    state.charge.pointerId = null;
    if (id != null && typeof cta.hasPointerCapture === 'function' && cta.hasPointerCapture(id)) {
      try {
        cta.releasePointerCapture(id);
      } catch {
        /* 指针已释放 */
      }
    }
  }

  function flashGlow() {
    cta.classList.remove('is-glow');
    // 强制重排，保证连续点击也能重新触发动画。
    void cta.offsetWidth;
    cta.classList.add('is-glow');
    clearTimer('glowTimer');
    state.glowTimer = win.setTimeout(() => {
      state.glowTimer = 0;
      cta.classList.remove('is-glow');
    }, SPONSOR_GLOW_MS);
  }

  function resetButtonVisual() {
    cancelChargeRaf();
    cancelDrain();
    clearTimer('openTimer');
    clearTimer('glowTimer');
    clearTimer('resetTimer');
    clearChargeTimer();
    state.charge.active = false;
    state.charge.complete = false;
    setChargeValue(0);
    cta.classList.remove('is-charging', 'is-complete', 'is-glow', 'is-filled');
    cta.setAttribute('aria-label', defaultLabel);
    restoreTip();
    releasePointer();
  }

  function drainCharge(from) {
    cancelDrain();
    const start = nowMs(win);
    const step = () => {
      const t = Math.min(1, (nowMs(win) - start) / CHARGE_DRAIN_MS);
      setChargeValue(from * (1 - t));
      if (t < 1) {
        state.charge.drainRafId = raf(step);
      } else {
        state.charge.drainRafId = 0;
        setChargeValue(0);
      }
    };
    state.charge.drainRafId = raf(step);
  }

  function cancelCharge({ animate = true } = {}) {
    if (!state.charge.active && !state.charge.complete) {
      clearChargeTimer();
      releasePointer();
      return;
    }
    cancelChargeRaf();
    clearChargeTimer();
    const wasComplete = state.charge.complete;
    const current = state.charge.value;
    state.charge.active = false;
    state.charge.complete = false;
    cta.classList.remove('is-charging');
    cta.setAttribute('aria-label', defaultLabel);
    restoreTip();
    releasePointer();
    if (wasComplete) return;
    if (animate && current > 0) drainCharge(current);
    else setChargeValue(0);
  }

  function startCharge(source) {
    if (!state.active || state.destroyed || state.dialog || state.charge.active || state.charge.complete) return;
    // 后台标签页不启动蓄力（rAF 会被暂停，避免进度冻结在“蓄力中”）。
    if (doc.visibilityState === 'hidden') return;
    cancelDrain();
    clearChargeTimer();
    clearTimer('glowTimer');
    clearTimer('openTimer');
    clearTimer('resetTimer');
    state.charge.active = true;
    state.charge.complete = false;
    state.charge.source = source;
    state.charge.startedAt = nowMs(win);
    cta.classList.remove('is-glow', 'is-complete');
    cta.classList.add('is-charging');
    cta.setAttribute('aria-label', '正在蓄力，保持 3 秒后打开赞助卡片');
    disableTip();
    setChargeValue(0);
    state.charge.rafId = raf(tickCharge);
    // 计时兜底：极少数内核在可见页面也可能节流 rAF，定时器保证 3 秒后仍能完成。
    state.charge.completeTimer = win.setTimeout(() => {
      state.charge.completeTimer = 0;
      if (state.charge.active) completeCharge();
    }, SPONSOR_CHARGE_MS + 60);
    // 点击蓄力即提前加载配置与二维码（失败不打断蓄力，弹层内再呈现重试）。
    ensureConfig().catch(() => {});
  }

  function tickCharge(timestamp) {
    if (!state.charge.active) return;
    const current = typeof timestamp === 'number' ? timestamp : nowMs(win);
    const progress = sponsorChargeProgress(current - state.charge.startedAt);
    setChargeValue(progress);
    if (progress >= 1) {
      completeCharge();
      return;
    }
    state.charge.rafId = raf(tickCharge);
  }

  function completeCharge() {
    if (!state.charge.active || state.charge.complete) return;
    cancelChargeRaf();
    clearChargeTimer();
    state.charge.active = false;
    state.charge.complete = true;
    setChargeValue(1);
    cta.classList.remove('is-charging');
    cta.classList.add('is-complete');
    cta.setAttribute('aria-label', '赞助卡片已打开');
    flashGlow();
    state.suppressClickUntil = nowMs(win) + 1_000;
    // 保留满格一瞬再打开，形成“添满 → 呈现”的视觉因果。
    state.openTimer = win.setTimeout(() => {
      state.openTimer = 0;
      openDialog();
    }, 110);
    state.resetTimer = win.setTimeout(() => {
      state.resetTimer = 0;
      if (!state.dialog) resetButtonVisual();
    }, 1_200);
  }

  function onPointerDown(event) {
    if (state.charge.active || state.charge.complete || state.dialog) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    state.charge.pointerId = event.pointerId;
    state.charge.startX = event.clientX;
    state.charge.startY = event.clientY;
    if (typeof cta.setPointerCapture === 'function') {
      try {
        cta.setPointerCapture(event.pointerId);
      } catch {
        /* 老内核/合成事件不支持捕获 */
      }
    }
    startCharge('pointer');
  }

  function onPointerMove(event) {
    if (!state.charge.active || state.charge.source !== 'pointer') return;
    if (state.charge.pointerId != null && event.pointerId !== state.charge.pointerId) return;
    const dx = Number(event.clientX) - state.charge.startX;
    const dy = Number(event.clientY) - state.charge.startY;
    if (Math.hypot(dx, dy) > SPONSOR_MOVE_CANCEL_PX) cancelCharge();
  }

  function onPointerUp(event) {
    if (state.charge.pointerId != null && event.pointerId !== state.charge.pointerId) return;
    if (state.charge.active) cancelCharge();
    else releasePointer();
  }

  function onPointerCancel() {
    cancelCharge();
  }

  function onPointerLeave(event) {
    if (!state.charge.active || state.charge.source !== 'pointer') return;
    if (typeof cta.hasPointerCapture === 'function' && cta.hasPointerCapture(event.pointerId)) return;
    cancelCharge();
  }

  function onClick(event) {
    if (nowMs(win) < state.suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // 长按蓄力期间不叠加点击发光（charge 本身已有持续外发光）。
    if (state.charge.active) return;
    flashGlow();
    ensureConfig().catch(() => {});
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    startCharge('keyboard');
  }

  function onKeyUp(event) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    if (state.charge.active && state.charge.source === 'keyboard') cancelCharge();
  }

  function onBlur() {
    if (state.charge.active) cancelCharge();
  }

  function onWindowBlur() {
    if (state.charge.active) cancelCharge();
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden' && state.charge.active) cancelCharge();
  }

  function prevent(event) {
    event.preventDefault();
  }

  /* ---------------- 配置 / 仓库 ---------------- */

  function resolveRepo() {
    if (state.repo) return Promise.resolve(state.repo);
    if (state.repoPromise) return state.repoPromise;
    const fallback = DEFAULT_GITHUB_REPO;
    if (!api || typeof api.get !== 'function') {
      state.repo = fallback;
      return Promise.resolve(fallback);
    }
    const pending = Promise.resolve()
      .then(() => api.get('/admin/app', null, { timeoutMs: 4_000 }))
      .then((res) => {
        const repo = res && res.data && res.data.app && res.data.app.repo;
        const next = typeof repo === 'string' && repo.trim() ? repo.trim() : fallback;
        state.repo = next;
        return next;
      })
      .catch(() => {
        state.repo = fallback;
        return fallback;
      });
    state.repoPromise = pending.finally(() => {
      state.repoPromise = null;
    });
    return state.repoPromise;
  }

  function ensureConfig({ force = false } = {}) {
    if (state.config && !force) {
      return Promise.resolve({ config: state.config });
    }
    if (state.configPromise && !force) return state.configPromise;
    if (force) {
      if (state.configAbort) {
        try {
          state.configAbort.abort();
        } catch {
          /* 已结束 */
        }
      }
      state.config = null;
    }
    const token = ++state.configToken;
    const controller = typeof win.AbortController === 'function' ? new win.AbortController() : null;
    state.configAbort = controller;
    const promise = resolveRepo()
      .then((repo) => loadSponsorConfig({
        repo,
        branch: DEFAULT_GITHUB_BRANCH,
        fetchImpl: typeof win.fetch === 'function' ? win.fetch.bind(win) : null,
        signal: controller ? controller.signal : undefined,
      }))
      .then((result) => {
        if (token !== state.configToken) {
          throw new SponsorConfigError('SPONSOR_CONFIG_UNAVAILABLE', '赞助配置加载已取消');
        }
        state.config = result.config;
        preloadImages(result.config);
        return result;
      })
      .finally(() => {
        if (state.configPromise === promise) state.configPromise = null;
        if (state.configAbort === controller) state.configAbort = null;
      });
    state.configPromise = promise;
    return promise;
  }

  function preloadImages(config) {
    const ImageCtor = win.Image;
    if (typeof ImageCtor !== 'function') return;
    for (const old of state.preloaded) {
      old.onload = null;
      old.onerror = null;
    }
    state.preloaded = [];
    for (const url of sponsorQrUrls(config)) {
      const image = new ImageCtor();
      image.decoding = 'async';
      image.loading = 'eager';
      image.referrerPolicy = 'no-referrer';
      image.onload = () => {
        image.onload = null;
        image.onerror = null;
      };
      image.onerror = () => {
        image.onload = null;
        image.onerror = null;
      };
      image.src = url;
      state.preloaded.push(image);
    }
  }

  /* ---------------- 弹层 ---------------- */

  function dialogMarkup() {
    const methods = SPONSOR_METHODS.map((method, index) => `
      <button type="button" role="radio" class="${index === 0 ? 'on' : ''}" aria-checked="${index === 0 ? 'true' : 'false'}" data-method="${method.id}">${method.label}</button>`).join('');
    const amounts = SPONSOR_AMOUNTS.map((tier, index) => `
      <button type="button" role="radio" class="sponsor-amount${index === 0 ? ' on' : ''}" aria-checked="${index === 0 ? 'true' : 'false'}" data-amount="${tier.amount}">
        <span class="sponsor-amount-title">${tier.label}</span>
        <span class="sponsor-amount-price"><small>¥</small>${tier.amount}</span>
      </button>`).join('');
    return `
<div class="dialog-mask sponsor-mask" role="presentation">
  <canvas class="sponsor-confetti" aria-hidden="true"></canvas>
  <section class="sponsor-card" role="dialog" aria-modal="true" aria-labelledby="sponsor-title" aria-describedby="sponsor-sub" tabindex="-1">
    <button type="button" class="icon-btn sponsor-close" data-act="close" aria-label="关闭赞助卡片" data-tip="关闭">
      <svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>
    </button>
    <header class="sponsor-head">
      <span class="sponsor-seal" aria-hidden="true"><svg class="icon"><use href="#i-tea"/></svg></span>
      <div class="sponsor-heading">
        <h2 id="sponsor-title">添盏清茶</h2>
        <p id="sponsor-sub" class="sponsor-sub">棋逢对手，敬你一口</p>
      </div>
    </header>
    <div class="sponsor-methods segctl" role="radiogroup" aria-label="支付方式">${methods}</div>
    <div class="sponsor-amounts" role="radiogroup" aria-label="赞助金额">${amounts}</div>
    <div class="sponsor-qr-wrap">
      <div class="sponsor-qr-stage" data-ref="qrStage" aria-busy="true">
        <div class="sponsor-qr-skeleton is-on" data-ref="qrSkeleton" aria-hidden="true"><span></span></div>
        <img class="sponsor-qr-img" data-ref="qrImg" alt="" hidden decoding="async" draggable="false">
        <div class="sponsor-qr-error" data-ref="qrError" hidden>
          <svg class="icon" aria-hidden="true"><use href="#i-warn"/></svg>
          <p class="sponsor-qr-error-title" data-ref="qrErrorText">二维码加载失败</p>
          <span class="sponsor-qr-error-hint">请检查网络后重试</span>
          <button type="button" class="btn btn-secondary btn-sm" data-act="qr-retry">重试</button>
        </div>
      </div>
      <div class="sponsor-qr-caption" data-ref="qrCaption">正在加载二维码…</div>
    </div>
    <p class="sponsor-note">
      <svg class="icon" aria-hidden="true"><use href="#i-info"/></svg>
      <span>本软件由独立开发者开发，赞助将用于软件持续迭代和维护，勿滥用赞助。 <a class="sponsor-powered" data-ref="repoLink" href="${repoHomeUrl()}" target="_blank" rel="noopener noreferrer" data-tip="打开 GitHub 仓库主页">Powered by yimuur</a></span>
    </p>
    <p class="sr-only" data-ref="status" aria-live="polite"></p>
  </section>
</div>`;
  }

  function selectionCaption(dialog) {
    const method = sponsorMethodLabel(dialog.method);
    const tier = sponsorAmountLabel(dialog.amount);
    return `${method} · ${tier} ¥${dialog.amount}`;
  }

  /** 仓库主页（跟随 /admin/app 的 repo，支持 TGO_GITHUB_REPO fork 覆盖）。 */
  function repoHomeUrl() {
    return `https://github.com/${normalizeGithubRepo(state.repo || DEFAULT_GITHUB_REPO)}`;
  }

  function announce(dialog, text) {
    if (!dialog || !dialog.status) return;
    dialog.status.textContent = '';
    win.setTimeout(() => {
      if (state.dialog === dialog) dialog.status.textContent = text;
    }, 20);
  }

  function updateSelection(dialog) {
    for (const button of dialog.methodButtons) {
      const on = button.dataset.method === dialog.method;
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
    }
    for (const button of dialog.amountButtons) {
      const on = Number(button.dataset.amount) === dialog.amount;
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
    }
    dialog.caption.textContent = selectionCaption(dialog);
  }

  function renderQrStage(dialog) {
    const loading = !dialog.qrError && (dialog.qrLoading || !dialog.qrUrl);
    dialog.stage.setAttribute('aria-busy', String(loading));
    // 切换二维码时保留旧图并压低透明度（交叉淡入）；仅首次加载/重试无旧图时显示骨架，
    // 避免“旧图 → 骨架 → 新图”的闪烁。
    dialog.skeleton.classList.toggle('is-on', loading && !dialog.qrUrl);
    dialog.error.hidden = !dialog.qrError;
    dialog.retry.hidden = !dialog.qrError;
    dialog.img.classList.toggle('is-ready', Boolean(dialog.qrUrl) && !dialog.qrError);
    dialog.img.classList.toggle('is-loading', loading && Boolean(dialog.qrUrl));
    if (dialog.qrError) {
      dialog.errorText.textContent = errorText(dialog.qrError);
      dialog.img.hidden = true;
      dialog.caption.textContent = '二维码暂不可用';
      return;
    }
    if (loading) {
      dialog.img.hidden = !dialog.qrUrl;
      dialog.caption.textContent = dialog.qrUrl ? selectionCaption(dialog) : '正在加载二维码…';
      return;
    }
    dialog.img.hidden = false;
    dialog.caption.textContent = selectionCaption(dialog);
  }

  function loadImage(url) {
    const ImageCtor = win.Image;
    if (typeof ImageCtor !== 'function') return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const timer = win.setTimeout(() => finish(false), 12_000);
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        win.clearTimeout(timer);
        loader.onload = null;
        loader.onerror = null;
        resolve(ok);
      };
      const loader = new ImageCtor();
      loader.decoding = 'async';
      loader.onload = () => finish(true);
      loader.onerror = () => finish(false);
      loader.src = url;
      if (typeof loader.decode === 'function') {
        loader.decode().then(() => finish(true), () => {
          /* 由 onload/onerror 兜底 */
        });
      }
    });
  }

  function withRetryToken(url) {
    try {
      const parsed = new URL(url, win.location ? win.location.href : undefined);
      parsed.searchParams.set('_r', String(Date.now()));
      return parsed.href;
    } catch {
      return url;
    }
  }

  async function refreshQr(dialog, { bust = false } = {}) {
    if (state.dialog !== dialog || dialog.closing) return;
    if (!dialog.config) {
      loadConfigForDialog(dialog);
      return;
    }
    const url = selectSponsorQr(dialog.config, dialog.method, dialog.amount);
    if (!url) {
      dialog.qrError = new SponsorConfigError('SPONSOR_CONFIG_INVALID', '二维码地址缺失');
      dialog.qrLoading = false;
      renderQrStage(dialog);
      return;
    }
    dialog.qrError = null;
    dialog.qrLoading = true;
    renderQrStage(dialog);
    const token = ++dialog.qrToken;
    const loadUrl = bust ? withRetryToken(url) : url;
    const ok = await loadImage(loadUrl);
    if (state.dialog !== dialog || token !== dialog.qrToken || dialog.closing) return;
    if (!ok) {
      dialog.qrLoading = false;
      dialog.qrUrl = null;
      dialog.qrError = new SponsorConfigError('SPONSOR_QR_UNAVAILABLE', '二维码加载失败');
      renderQrStage(dialog);
      announce(dialog, '二维码加载失败，请检查网络后重试');
      return;
    }
    dialog.qrUrl = url;
    dialog.qrLoading = false;
    dialog.qrError = null;
    dialog.img.src = loadUrl;
    dialog.img.alt = `${sponsorMethodLabel(dialog.method)}收款二维码：${sponsorAmountLabel(dialog.amount)}（${dialog.amount} 元）`;
    dialog.img.hidden = false;
    renderQrStage(dialog);
  }

  function loadConfigForDialog(dialog) {
    const token = ++dialog.loadToken;
    dialog.qrError = null;
    dialog.qrLoading = true;
    renderQrStage(dialog);
    ensureConfig()
      .then((result) => {
        if (state.dialog !== dialog || token !== dialog.loadToken || dialog.closing) return;
        dialog.config = result.config;
        updateSelection(dialog);
        void refreshQr(dialog);
      })
      .catch((err) => {
        if (state.dialog !== dialog || token !== dialog.loadToken || dialog.closing) return;
        dialog.config = null;
        dialog.qrLoading = false;
        dialog.qrUrl = null;
        dialog.qrError = err instanceof SponsorConfigError
          ? err
          : new SponsorConfigError('SPONSOR_CONFIG_UNAVAILABLE', '赞助配置加载失败');
        renderQrStage(dialog);
        announce(dialog, `${errorText(dialog.qrError)}，请检查网络后重试`);
      });
  }

  function onDialogClick(event) {
    const dialog = state.dialog;
    if (!dialog || dialog.closing) return;
    const close = event.target.closest('[data-act="close"]');
    if (close) {
      closeDialog();
      return;
    }
    const retry = event.target.closest('[data-act="qr-retry"]');
    if (retry) {
      if (dialog.qrError && dialog.qrError.code === 'SPONSOR_QR_UNAVAILABLE' && dialog.config) {
        void refreshQr(dialog, { bust: true });
      } else {
        loadConfigForDialog(dialog);
      }
      return;
    }
    const method = event.target.closest('[data-method]');
    if (method && dialog.card.contains(method)) {
      const next = method.dataset.method;
      if (next && next !== dialog.method) {
        dialog.method = next;
        updateSelection(dialog);
        void refreshQr(dialog);
      }
      return;
    }
    const amount = event.target.closest('[data-amount]');
    if (amount && dialog.card.contains(amount)) {
      const next = Number(amount.dataset.amount);
      if (Number.isFinite(next) && next !== dialog.amount) {
        dialog.amount = next;
        updateSelection(dialog);
        void refreshQr(dialog);
      }
    }
  }

  function onDialogKeydown(event) {
    const dialog = state.dialog;
    if (!dialog || dialog.closing) return;
    const group = event.target.closest && event.target.closest('[role="radiogroup"]');
    if (!group) return;
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(event.key)) return;
    const buttons = Array.from(group.querySelectorAll('[role="radio"]'));
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = buttons[(index + direction + buttons.length) % buttons.length];
    next.focus();
    next.click();
  }

  function onDocumentKeydown(event) {
    const dialog = state.dialog;
    if (!dialog || dialog.closing) return;
    if (event.key === 'Escape' || event.key === 'Esc') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = Array.from(dialog.card.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((el) => !el.hidden && el.getClientRects().length > 0);
    if (focusables.length === 0) {
      event.preventDefault();
      dialog.card.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = doc.activeElement;
    if (!event.shiftKey && (active === last || !dialog.card.contains(active))) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (active === first || !dialog.card.contains(active))) {
      event.preventDefault();
      last.focus();
    }
  }

  function openDialog() {
    if (state.destroyed || !state.active || state.dialog) return;
    const root = ensureModalRoot(doc);
    const host = doc.createElement('div');
    host.innerHTML = dialogMarkup();
    const mask = host.firstElementChild;
    if (!mask) return;
    root.appendChild(mask);
    const card = mask.querySelector('.sponsor-card');
    const dialog = {
      mask,
      card,
      closeBtn: mask.querySelector('[data-act="close"]'),
      methodButtons: Array.from(mask.querySelectorAll('[data-method]')),
      amountButtons: Array.from(mask.querySelectorAll('[data-amount]')),
      stage: mask.querySelector('[data-ref="qrStage"]'),
      img: mask.querySelector('[data-ref="qrImg"]'),
      skeleton: mask.querySelector('[data-ref="qrSkeleton"]'),
      error: mask.querySelector('[data-ref="qrError"]'),
      errorText: mask.querySelector('[data-ref="qrErrorText"]'),
      retry: mask.querySelector('[data-act="qr-retry"]'),
      caption: mask.querySelector('[data-ref="qrCaption"]'),
      status: mask.querySelector('[data-ref="status"]'),
      repoLink: mask.querySelector('[data-ref="repoLink"]'),
      method: DEFAULT_SPONSOR_METHOD,
      amount: DEFAULT_SPONSOR_AMOUNT,
      qrUrl: null,
      qrLoading: false,
      qrError: null,
      qrToken: 0,
      loadToken: 0,
      closing: false,
      confetti: null,
      sandStop: null,
      previousFocus: doc.activeElement,
    };
    state.dialog = dialog;
    updateSelection(dialog);
    renderQrStage(dialog);

    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeDialog();
    });
    card.addEventListener('click', onDialogClick);
    card.addEventListener('keydown', onDialogKeydown);
    doc.addEventListener('keydown', onDocumentKeydown, true);

    dialog.confetti = startConfetti(mask);
    raf(() => {
      if (state.dialog === dialog) dialog.closeBtn.focus({ preventScroll: true });
    });
    // 预取仓库信息可能在弹层打开后才完成：补齐 Powered by 链接的 fork 目标。
    resolveRepo().then(() => {
      if (state.dialog === dialog && dialog.repoLink) dialog.repoLink.href = repoHomeUrl();
    }).catch(() => {});
    loadConfigForDialog(dialog);
  }

  function finishClose(dialog) {
    if (state.dialog !== dialog) return;
    if (typeof dialog.sandStop === 'function') {
      dialog.sandStop();
      dialog.sandStop = null;
    }
    if (dialog.confetti) {
      dialog.confetti.stop();
      dialog.confetti = null;
    }
    doc.removeEventListener('keydown', onDocumentKeydown, true);
    if (dialog.mask.parentNode) dialog.mask.remove();
    state.dialog = null;
    resetButtonVisual();
    if (state.active && dialog.previousFocus && typeof dialog.previousFocus.focus === 'function') {
      try {
        dialog.previousFocus.focus({ preventScroll: true });
      } catch {
        /* 原焦点已移除 */
      }
    }
  }

  function closeDialog({ animate = true } = {}) {
    const dialog = state.dialog;
    if (!dialog) return;
    if (dialog.closing) {
      if (!animate) finishClose(dialog);
      return;
    }
    dialog.closing = true;
    dialog.loadToken += 1;
    dialog.qrToken += 1;
    if (dialog.confetti) {
      dialog.confetti.stop();
      dialog.confetti = null;
    }
    if (!animate || reducedMotion(win)) {
      finishClose(dialog);
      return;
    }
    startSand(dialog, () => finishClose(dialog));
  }

  /* ---------------- 彩带 ---------------- */

  function confettiPalette() {
    return [
      cssVar(doc, '--accent', '#1F4E5F'),
      cssVar(doc, '--sponsor-gold', '#E8B44A'),
      cssVar(doc, '--c-brilliant', '#3B82F6'),
      cssVar(doc, '--c-good', '#22A06B'),
      cssVar(doc, '--c-slow', '#D9A400'),
      cssVar(doc, '--c-mistake', '#F2711C'),
    ];
  }

  function startConfetti(mask) {
    if (reducedMotion(win)) return null;
    const canvas = mask.querySelector('.sponsor-confetti');
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const dpr = Math.min(Number(win.devicePixelRatio) || 1, 2);
    let width = Math.max(1, Number(win.innerWidth) || 1);
    let height = Math.max(1, Number(win.innerHeight) || 1);
    const resize = () => {
      width = Math.max(1, Number(win.innerWidth) || 1);
      height = Math.max(1, Number(win.innerHeight) || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    win.addEventListener('resize', resize);
    const palette = confettiPalette();
    const count = width < 600 ? 90 : 150;
    const pieces = [];
    for (let i = 0; i < count; i += 1) {
      const fromTop = Math.random() < 0.66;
      pieces.push({
        x: fromTop ? Math.random() * width : width / 2 + (Math.random() - 0.5) * width * 0.36,
        y: fromTop ? -20 - Math.random() * height * 0.25 : height * 0.32 + (Math.random() - 0.5) * 90,
        vx: fromTop ? (Math.random() - 0.5) * 1.7 : (Math.random() - 0.5) * 9,
        vy: fromTop ? 2 + Math.random() * 3.2 : -6 - Math.random() * 6,
        w: 4 + Math.random() * 6,
        h: 7 + Math.random() * 8,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.26,
        color: palette[i % palette.length],
        shape: Math.random() < 0.24 ? 'circle' : 'rect',
      });
    }
    let frame = 0;
    let startedAt = 0;
    let previous = 0;
    const tick = (timestamp) => {
      const now = typeof timestamp === 'number' ? timestamp : nowMs(win);
      if (!startedAt) {
        startedAt = now;
        previous = now;
      }
      const elapsed = now - startedAt;
      const dt = Math.min(2.5, Math.max(0.25, (now - previous) / 16.67));
      previous = now;
      ctx.clearRect(0, 0, width, height);
      const fade = elapsed > SPONSOR_CONFETTI_MS - 650
        ? Math.max(0, (SPONSOR_CONFETTI_MS - elapsed) / 650)
        : 1;
      ctx.globalAlpha = fade;
      for (const piece of pieces) {
        piece.vy += 0.16 * dt;
        piece.vx *= 0.995;
        piece.vy *= 0.996;
        piece.x += piece.vx * dt;
        piece.y += piece.vy * dt;
        piece.rot += piece.vr * dt;
        if (piece.y > height + 40 || piece.x < -60 || piece.x > width + 60) continue;
        ctx.save();
        ctx.translate(piece.x, piece.y);
        ctx.rotate(piece.rot);
        ctx.scale(1, Math.max(0.22, Math.abs(Math.cos(piece.rot * 1.7))));
        ctx.fillStyle = piece.color;
        if (piece.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, piece.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      if (elapsed < SPONSOR_CONFETTI_MS) {
        frame = raf(tick);
      } else {
        frame = 0;
        win.removeEventListener('resize', resize);
        canvas.style.opacity = '0';
        win.setTimeout(() => {
          if (canvas.parentNode) canvas.remove();
        }, 220);
      }
    };
    frame = raf(tick);
    return {
      stop() {
        if (frame) caf(frame);
        frame = 0;
        win.removeEventListener('resize', resize);
        if (canvas.parentNode) canvas.remove();
      },
    };
  }

  /* ---------------- 沙化 ---------------- */

  function sandPalette() {
    const dark = doc.documentElement && doc.documentElement.dataset.theme === 'dark';
    return [
      cssVar(doc, '--sponsor-gold', dark ? '#F2C96B' : '#E8B44A'),
      cssVar(doc, '--accent', dark ? '#6FA8B8' : '#1F4E5F'),
      cssVar(doc, '--text-1', dark ? '#E8E6E1' : '#2B2B2B'),
      cssVar(doc, '--bg-glass-strong', dark ? 'rgba(28,30,36,.78)' : 'rgba(255,255,255,.72)'),
      dark ? 'rgba(255,255,255,.42)' : 'rgba(255,255,255,.85)',
    ];
  }

  function startSand(dialog, done) {
    if (reducedMotion(win) || typeof dialog.card.getBoundingClientRect !== 'function') {
      done();
      return;
    }
    const rect = dialog.card.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      done();
      return;
    }
    const canvas = doc.createElement('canvas');
    canvas.className = 'sponsor-sand';
    const dpr = Math.min(Number(win.devicePixelRatio) || 1, 2);
    const width = Math.max(1, Number(win.innerWidth) || 1);
    const height = Math.max(1, Number(win.innerHeight) || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    dialog.mask.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      done();
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dialog.card.classList.add('is-sanding');
    dialog.mask.classList.add('is-closing');
    const palette = sandPalette();
    const count = Math.min(420, Math.max(120, Math.round((rect.width * rect.height) / 520)));
    // 粒子在原地细化、缓慢下沉并逐个淡出，形成“溶解为沙”的效果；不施加横向风场。
    const grains = [];
    for (let i = 0; i < count; i += 1) {
      grains.push({
        x: rect.left + Math.random() * rect.width,
        y: rect.top + Math.random() * rect.height,
        vx: (Math.random() - 0.5) * 0.24,
        vy: 0.1 + Math.random() * 0.4,
        size: 0.8 + Math.random() * 1.6,
        color: palette[i % palette.length],
        delay: Math.random() * 60,
        life: 500 + Math.random() * 160,
      });
    }
    let frame = 0;
    let startedAt = 0;
    let previous = 0;
    let finished = false;
    const stop = () => {
      if (finished) return;
      finished = true;
      if (frame) caf(frame);
      frame = 0;
      if (canvas.parentNode) canvas.remove();
    };
    dialog.sandStop = stop;
    const tick = (timestamp) => {
      if (finished) return;
      const now = typeof timestamp === 'number' ? timestamp : nowMs(win);
      if (!startedAt) {
        startedAt = now;
        previous = now;
      }
      const elapsed = now - startedAt;
      const dt = Math.min(2.4, Math.max(0.25, (now - previous) / 16.67));
      previous = now;
      ctx.clearRect(0, 0, width, height);
      for (const grain of grains) {
        const age = elapsed - grain.delay;
        if (age < 0 || age >= grain.life) continue;
        const progress = age / grain.life;
        grain.vy += 0.025 * dt;
        grain.x += grain.vx * dt;
        grain.y += grain.vy * dt;
        const size = grain.size * (1 - 0.35 * progress);
        ctx.globalAlpha = 1 - progress;
        ctx.fillStyle = grain.color;
        ctx.fillRect(grain.x, grain.y, size, size * 1.2);
      }
      ctx.globalAlpha = 1;
      if (elapsed < SPONSOR_SAND_MS) {
        frame = raf(tick);
      } else {
        stop();
        done();
      }
    };
    frame = raf(tick);
  }

  /* ---------------- 公开生命周期 ---------------- */

  function setActive(active) {
    const next = Boolean(active);
    if (state.active === next) {
      cta.classList.toggle('hidden', !next);
      return;
    }
    state.active = next;
    cta.classList.toggle('hidden', !next);
    if (!next) {
      resetButtonVisual();
      closeDialog({ animate: false });
    } else {
      resolveRepo().catch(() => {});
    }
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.active = false;
    state.configToken += 1;
    if (state.configAbort) {
      try {
        state.configAbort.abort();
      } catch {
        /* 已结束 */
      }
      state.configAbort = null;
    }
    resetButtonVisual();
    closeDialog({ animate: false });
    for (const off of state.listeners.splice(0)) {
      try {
        off();
      } catch {
        /* 监听器已移除 */
      }
    }
    for (const image of state.preloaded) {
      image.onload = null;
      image.onerror = null;
    }
    state.preloaded = [];
    cta.style.removeProperty('--sponsor-charge');
  }

  listen(cta, 'pointerdown', onPointerDown);
  listen(cta, 'pointermove', onPointerMove);
  listen(cta, 'pointerup', onPointerUp);
  listen(cta, 'pointercancel', onPointerCancel);
  listen(cta, 'pointerleave', onPointerLeave);
  listen(cta, 'click', onClick);
  listen(cta, 'keydown', onKeyDown);
  listen(cta, 'keyup', onKeyUp);
  listen(cta, 'blur', onBlur);
  listen(cta, 'contextmenu', prevent);
  listen(cta, 'dragstart', prevent);
  listen(cta, 'selectstart', prevent);
  listen(win, 'blur', onWindowBlur);
  listen(doc, 'visibilitychange', onVisibility);

  return {
    setActive,
    destroy,
    isActive: () => state.active,
  };
}
