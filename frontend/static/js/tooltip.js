/* ============================================================================
 * tGo 产品前端 · 统一 Tooltip（C17）
 * 全局唯一玻璃浮层（单例 DOM，fixed 定位，z-index 990）：全站唯一提示形态，
 * 浅/深主题与主题色经 CSS token（--bg-glass-strong/--border-strong/--text-1）自动适配。
 *   - 数据源 [data-tip]；事件委托（mouseover/mouseout/focusin/keydown，capture 捕获）
 *     读取，悬停/聚焦 300ms 延迟显示（基线 §4.6）；
 *   - 设备能力门：仅「主指针可悬停且为精细指针」（鼠标/触控板）启用；触屏手机/平板
 *     （hover:none / pointer:coarse）完全禁用——点击目标会合成 mouseover，旧实现在
 *     移动端点击时会额外弹一层提示（与目标的菜单/弹层「双重信息」叠加）；
 *   - 自动上/下翻转：上方空间不足、或会压住顶栏（.topbar）时改为向下弹出；
 *     水平钳制在视口内，箭头始终对准锚点中心 —— 取代旧伪元素方案所需的
 *     topbar 变体 / 右缘右锚定 / z-index 抬升等逐元素补丁；
 *   - [title] → [data-tip] 转换（convert）：MutationObserver 监听动态 DOM
 *     （子节点新增 + title 属性变更）自动转换，消除「部分仍为原生 title」；
 *     title="" 视为显式清除提示（同时移除 data-tip，避免留旧值）；
 *   - 滚动/窗口变化 rAF 节流重定位；锚点被移除/重建自动隐藏。
 * 纯样式增强（仅暴露 convert/hide 两个轻量方法）：无请求 / 无业务状态。
 * window.tgoTooltip.convert() 保留为兼容 API
 * （语义＝立即全量转换；动态 DOM 已由 Observer 覆盖，app.js/app 视图可继续调用）。
 * ========================================================================== */
(function () {
  'use strict';

  var SHOW_DELAY_MS = 300;   // 悬停/聚焦显示延迟（基线 §4.6）
  var GAP_PX = 9;            // 气泡与锚点间距（含箭头视觉高度）
  var EDGE_PX = 8;           // 气泡距视口边缘最小留白
  var ARROW_INSET_PX = 12;   // 箭头中心距气泡两端最小内缩
  var ARROW_HALF_PX = 5;     // 箭头（10px 菱形）半宽
  var TIP_BORDER_PX = 1;     // ＝ .tgo-tip 边框宽（app.css；绝对定位子元素基准为 padding box，故减 1 对齐 border box）
  var TOPBAR_CLEAR_PX = 4;   // 顶栏避让余量（上方起算线低于顶栏底缘即翻转）
  var SKIP_TAGS = { svg: 1, use: 1, symbol: 1 };  // SVG 内标题描述不参与转换

  // 设备能力门：仅鼠标/触控板等「可悬停的精细指针」启用 Tooltip；触屏手机/平板
  // （hover:none / pointer:coarse）完全禁用。无法探测（极旧内核无 matchMedia）时保持旧行为。
  var hoverMedia = typeof window.matchMedia === 'function'
    ? window.matchMedia('(hover: hover) and (pointer: fine)')
    : null;

  function tooltipsEnabled() {
    return hoverMedia ? hoverMedia.matches : true;
  }

  if (hoverMedia) {
    var onHoverMediaChange = function () { if (!tooltipsEnabled()) hide(); };
    if (typeof hoverMedia.addEventListener === 'function') hoverMedia.addEventListener('change', onHoverMediaChange);
    else if (typeof hoverMedia.addListener === 'function') hoverMedia.addListener(onHoverMediaChange);
  }

  var tipEl = null;          // 单例气泡
  var tipTextEl = null;      // 文本容器（textContent 注入，无 HTML 解析）
  var tipArrowEl = null;
  var anchorEl = null;       // 当前锚点（等待显示或显示中）
  var showTimer = 0;
  var rafId = 0;
  var topbarEl = null;

  /* ---------------- 单例气泡 ---------------- */

  function ensureTip() {
    if (tipEl) return;
    tipEl = document.createElement('div');
    tipEl.className = 'tgo-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.setAttribute('aria-hidden', 'true');
    tipTextEl = document.createElement('span');
    tipTextEl.className = 'tgo-tip-txt';
    tipArrowEl = document.createElement('i');
    tipArrowEl.className = 'tgo-tip-arrow';
    tipEl.appendChild(tipTextEl);
    tipEl.appendChild(tipArrowEl);
    document.body.appendChild(tipEl);
  }

  function tipTextOf(el) {
    var text = el.getAttribute('data-tip');
    return text == null ? '' : text;
  }

  function topbarBottom() {
    if (!topbarEl || !topbarEl.isConnected) topbarEl = document.querySelector('.topbar');
    return topbarEl ? topbarEl.getBoundingClientRect().bottom : 0;
  }

  /** 计算并应用气泡/箭头位置（每次调用按当前锚点矩形重新判定翻转）。 */
  function place(el) {
    var rect = el.getBoundingClientRect();
    var boxW = tipEl.offsetWidth;
    var boxH = tipEl.offsetHeight;
    var viewW = window.innerWidth;
    var viewH = window.innerHeight;
    var aboveTop = rect.top - boxH - GAP_PX;
    // 上方放不下、或会压住顶栏 → 向下弹出（下方越界由 top 钳制兜底；顶栏内元素天然走此支）
    var below = aboveTop < EDGE_PX || aboveTop < topbarBottom() + TOPBAR_CLEAR_PX;
    var rawTop = below ? rect.bottom + GAP_PX : aboveTop;
    var top = Math.min(Math.max(rawTop, EDGE_PX), Math.max(EDGE_PX, viewH - boxH - EDGE_PX));
    var centerX = rect.left + rect.width / 2;
    var left = Math.min(Math.max(centerX - boxW / 2, EDGE_PX), Math.max(EDGE_PX, viewW - boxW - EDGE_PX));
    // 箭头中心对准锚点中心（钳制在气泡两端内缩范围内），再折算为箭头左边缘偏移
    var arrowCenter = Math.min(Math.max(centerX - left, ARROW_INSET_PX), Math.max(ARROW_INSET_PX, boxW - ARROW_INSET_PX));
    tipEl.classList.toggle('below', below);
    tipEl.style.left = Math.round(left) + 'px';
    tipEl.style.top = Math.round(top) + 'px';
    tipArrowEl.style.left = Math.round(arrowCenter - ARROW_HALF_PX - TIP_BORDER_PX) + 'px';
  }

  /* ---------------- 显示 / 隐藏 ---------------- */

  function show(el) {
    var text = tipTextOf(el);
    if (!text) { hide(); return; }
    ensureTip();
    anchorEl = el;
    tipEl.classList.remove('on');   // 先回落隐藏态，保证每次入场都有过渡
    tipTextEl.textContent = text;
    place(el);
    tipEl.classList.add('on');
  }

  function hide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
    anchorEl = null;
    if (tipEl) tipEl.classList.remove('on');
  }

  function scheduleShow(el) {
    if (showTimer) clearTimeout(showTimer);
    anchorEl = el;
    showTimer = window.setTimeout(function () {
      showTimer = 0;
      if (anchorEl === el && el.isConnected) show(el);
    }, SHOW_DELAY_MS);
  }

  /* ---------------- 事件委托（capture：不受业务层 stopPropagation 影响） ---------------- */

  function tipAnchorOf(target) {
    return target && target.closest ? target.closest('[data-tip]') : null;
  }

  document.addEventListener('mouseover', function (event) {
    if (!tooltipsEnabled()) return;   // 触屏设备禁用：点击会合成 mouseover，避免与目标弹层叠加
    var el = tipAnchorOf(event.target);
    if (!el) { if (anchorEl) hide(); return; }
    if (el === anchorEl) return;      // 同一锚点内部移动（含等待显示期间）
    scheduleShow(el);
  }, true);

  document.addEventListener('mouseout', function (event) {
    if (!anchorEl) return;
    var to = event.relatedTarget;
    if (to && anchorEl.contains(to)) return;   // 仍是锚点内部
    hide();
  }, true);

  document.addEventListener('focusin', function (event) {
    if (!tooltipsEnabled()) return;   // 触屏设备禁用（无鼠标悬停语义）
    var el = tipAnchorOf(event.target);
    if (!el) return;
    var keyboard = false;
    try { keyboard = el.matches(':focus-visible'); } catch (error) { keyboard = false; }
    if (keyboard) scheduleShow(el);
  }, true);

  document.addEventListener('focusout', function () { hide(); }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' || event.key === 'Esc') hide();
  }, true);

  function onViewportChange() {
    if (!anchorEl || rafId) return;
    rafId = window.requestAnimationFrame(function () {
      rafId = 0;
      if (!anchorEl || !tipEl || !tipEl.classList.contains('on')) return;
      if (!anchorEl.isConnected) { hide(); return; }
      place(anchorEl);
    });
  }

  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);

  /* ---------------- title → data-tip 转换 + 动态 DOM 兜底 ---------------- */

  function convertElement(el) {
    if (!el || el.nodeType !== 1) return;
    if (SKIP_TAGS[String(el.tagName).toLowerCase()]) return;
    var text = el.getAttribute('title');
    if (text === null) return;
    if (text) el.setAttribute('data-tip', text);
    else el.removeAttribute('data-tip');   // title="" ＝显式清除提示
    el.removeAttribute('title');
    if (el === anchorEl) {
      if (!text) { hide(); return; }
      if (tipEl && tipEl.classList.contains('on')) {   // 提示文案热更新（如悔棋剩余次数）
        tipTextEl.textContent = text;
        place(el);
      }
    }
  }

  function convertTree(root) {
    convertElement(root);
    var nodes = root.querySelectorAll ? root.querySelectorAll('[title]') : [];
    for (var i = 0; i < nodes.length; i += 1) convertElement(nodes[i]);
  }

  function convert() {
    convertTree(document.documentElement);
  }

  function observeMutations() {
    if (typeof window.MutationObserver !== 'function') return;
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (record.type === 'attributes') {
          convertElement(record.target);
          continue;
        }
        for (var j = 0; j < record.addedNodes.length; j += 1) {
          var node = record.addedNodes[j];
          if (node.nodeType === 1) convertTree(node);
        }
      }
      if (anchorEl && !anchorEl.isConnected) hide();   // 视图重建时锚点被整体替换
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title'],
    });
  }

  function init() {
    convert();
    observeMutations();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // hide()：业务层主动收起提示（如赞助按钮进入长按蓄力，提示气泡会遮挡进度）
  window.tgoTooltip = { convert: convert, hide: hide };
})();
