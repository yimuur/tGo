/* ============================================================================
 * tGo · 内联 SVG 图标集（§4.5：stroke 1.6 / 24×24 / 禁止 emoji；插画形态
 * `i-empty-go` 例外，见下方登记）
 * 以 <symbol> 注入页面，用法：<svg class="icon"><use href="#i-plus"/></svg>
 * 纯展示辅助：无业务逻辑、无请求、无状态。
 * ========================================================================== */

(function () {
  'use strict';

  var ICONS = {
    'i-plus': '<path d="M12 5v14M5 12h14"/>',
    /* 赞助（添盏清茶）：茶盏 + 热气 + 茶托 */
    // 'i-tea': '<path d="M5 10h11v4.5A4.5 4.5 0 0 1 11.5 19h-2A4.5 4.5 0 0 1 5 14.5V10z"/><path d="M16 11h1.4a2.3 2.3 0 0 1 0 4.6H16"/><path d="M8 3c-.7 1.1-.7 2.1 0 3.2M12 3c-.7 1.1-.7 2.1 0 3.2"/><path d="M4 21h15"/>',
    /* 赞助（添盏清茶）：无柄茶盏 + 热气 + 茶托，避免咖啡杯观感 */
    'i-tea': '<path d="M5 9h14"/><path d="M6 9c0 5.2 2.7 9 6 9s6-3.8 6-9"/><path d="M9 3c-.7 1.1-.7 2.1 0 3.2M13 3c-.7 1.1-.7 2.1 0 3.2"/><path d="M4 21h16"/>',
    'i-undo': '<path d="M4 10h11a5 5 0 0 1 0 10H9"/><path d="M4 10l4-4M4 10l4 4"/>',
    'i-pass': '<path d="M6 3h12M12 3v14"/><path d="M5 21l14-14"/>',
    'i-resign': '<path d="M6 3h12v4l-2 2v6a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9L6 7V3z"/><path d="M4 21h16"/>',
    'i-restart': '<path d="M6 8a7 7 0 1 1-1 7"/><path d="M6 3v5h5"/>',
    'i-immersive': '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    'i-territory': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h6v6H7zM13 7h4v4h-4zM10 13h4v4h-4z"/>',
    'i-coach': '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.7.6-1 1.3-1 2.5h-6c0-1.2-.3-1.9-1-2.5A6 6 0 0 1 12 3z"/>',
    'i-deep': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
    'i-global': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    'i-curve': '<path d="M3 17l5-6 4 3 6-8 3 4"/><path d="M3 21h18"/>',
    'i-comment': '<path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/><path d="M8 10h8M8 14h5"/>',
    'i-replay': '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    'i-resume': '<path d="M5 4l14 8-14 8V4z"/>',
    'i-trial': '<path d="M12 3v18M5 7l7-4 7 4M5 17l7 4 7-4"/><path d="M5 7v10M19 7v10"/>',
    'i-refight': '<path d="M12 3l3 6 6 1-4.5 4.5 1 6L12 17l-5.5 3.5 1-6L3 10l6-1 3-6z"/>',
    /* 终局信息（对局报告标题右侧图标）：终点旗 */
    'i-finish': '<path d="M6 21V4"/><path d="M6 5h11l-2.5 3.5L17 12H6"/>',
    'i-branch': '<path d="M6 3v6a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4"/><circle cx="6" cy="3" r="2"/><circle cx="18" cy="21" r="2"/>',
    'i-fav': '<path d="M12 21s-7.5-4.7-9.6-9A5.2 5.2 0 0 1 12 6.5 5.2 5.2 0 0 1 21.6 12c-2.1 4.3-9.6 9-9.6 9z"/>',
    'i-fav-on': '<path d="M12 21s-7.5-4.7-9.6-9A5.2 5.2 0 0 1 12 6.5 5.2 5.2 0 0 1 21.6 12c-2.1 4.3-9.6 9-9.6 9z" fill="currentColor" stroke="none"/>',
    'i-play': '<path d="M7 4l13 8-13 8V4z"/>',
    'i-pause': '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    'i-step': '<path d="M5 4l10 8-10 8V4z"/><rect x="17" y="4" width="3" height="16" rx="1"/>',
    'i-engine': '<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M8 20h8M12 16v4M9 9h6M9 12h4"/>',
    'i-model': '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><circle cx="16.5" cy="16.5" r="3.5"/>',
    'i-params': '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="var(--bg-base)"/><circle cx="15" cy="12" r="2" fill="var(--bg-base)"/><circle cx="7" cy="18" r="2" fill="var(--bg-base)"/>',
    'i-system': '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    'i-start': '<circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4V8z"/>',
    'i-stop': '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
    'i-tune': '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
    'i-close': '<path d="M6 6l12 12M18 6L6 18"/>',
    'i-back': '<path d="M15 5l-7 7 7 7"/>',
    'i-info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    'i-warn': '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v4M12 17h.01"/>',
    'i-error': '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    'i-success': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    'i-volume': '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    'i-mute': '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M16 9l6 6M22 9l-6 6"/>',
    'i-sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    'i-moon': '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    /* 自动（跟随系统）主题：左半日实心 + 整圆描边，一眼可辨“自动深/浅” */
    'i-theme-auto': '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18V3z" fill="currentColor" stroke="none"/>',
    'i-fullscreen': '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    'i-exitfull': '<path d="M8 8H3v3M16 8h5v3M8 16H3v-3M16 16h5v-3"/>',
    'i-download': '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>',
    'i-upload': '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 19h16"/>',
    'i-trash': '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
    /* 更多菜单（反馈：移动端 ··· 改为实心点） */
    'i-more': '<circle cx="5" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.9" fill="currentColor" stroke="none"/>',
    'i-search': '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    /* 导入棋谱（反馈：需一眼看出含义）向上导入箭头 */
    'i-sgf': '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 21h16"/>',
    'i-export': '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5z"/><path d="M14 3v5h5"/>',
    /* vs 徽章（反馈：重新设计，一眼可辨）——胶囊底 + 清晰的 V/S 字标 */
    // 'i-vs': '<rect x="2" y="6" width="20" height="12" rx="6" stroke-width="1.4"/><path d="M6.6 9.7l2 4.8 2-4.8" stroke-width="1.9"/><path d="M17.6 10.4c-.4-.6-1.1-.9-1.8-.9-1.1 0-1.9.6-1.9 1.5 0 .8.6 1.2 1.8 1.4 1.1.2 1.9.6 1.9 1.5 0 .9-.8 1.5-2 1.5-.7 0-1.4-.3-1.8-.9" stroke-width="1.9"/>'
    // 'i-vs': '<path d="M 1.5 6 L 6 18 L 10.5 6 M 13.5 17.5 C 15 18.5 18.5 18.5 19.5 16.5 C 20.5 14.5 14 13.5 14 10.5 C 14 7.5 18.5 6.5 19.5 8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
    'i-vs': '<path d="M1 6.2c.7.2 1.8.8 2.3 1.5l2.5 8.8c.2.6.4 1.5.8 1.5.4 0 .6-.8.9-1.5l3.1-9.2c.4-1.1 1.1-1.9 2-2.1-.3.8-.7 1.8-1.1 2.7l-3.4 9.8c-.7 2-1.6 2.3-2.5.5L2.2 8.8C1.7 7.7 1.2 6.8 1 6.2zM14.8 16.8c1.1 1.3 3.1 1.7 4.6 1 1.6-.8 2.1-2.5 1.4-4.1-.6-1.3-2-1.8-3.5-2.4-1.6-.6-2.8-1.2-2.8-2.6 0-1.2 1-2.2 2.5-2.2 1.1 0 2.2.4 3.1 1.2-.2.8-.4 1.6-.6 2.2-.9-.7-1.8-1-2.6-1-.9 0-1.4.5-1.4 1.1 0 .9 1 1.3 2.5 1.8 1.9.7 3.7 1.5 3.7 3.8 0 2.5-1.9 4-4.2 4-1.6 0-3.2-.6-4.2-1.8.2-.8.5-1.6.8-2.2z" fill="currentColor"/>',

    /* 空态插画（§4.7：空态＝SVG 插画 + 一句话 + CTA）——9 路**空棋盘（无子）**：
       「无棋局数据」的通用意象（无进行中对局 / 加载失败 / 无符合筛选 / 视图装载失败共用）。
       单色线稿随 `currentColor` 适配深浅主题；画布 4:3（120×90）与 `.art` 尺寸一致，图形自占满。
       星位五点（含天元）= 9 路棋盘标准星位，令其一眼可辨为围棋盘而非普通网格。
       注：此条为**插画**形态（自定义 viewBox + 线宽），非 24×24 图标。 */
    'i-empty-go': {
      viewBox: '0 0 120 90',
      strokeWidth: 2,
      body: '<rect x="27" y="12" width="66" height="66" rx="6" stroke-width="2.4"/>'
        + '<path d="M36 21v48M48 21v48M60 21v48M72 21v48M84 21v48M36 21h48M36 33h48M36 45h48M36 57h48M36 69h48"/>'
        + '<g fill="currentColor" stroke="none"><circle cx="48" cy="33" r="2.2"/><circle cx="72" cy="33" r="2.2"/><circle cx="60" cy="45" r="2.2"/><circle cx="48" cy="57" r="2.2"/><circle cx="72" cy="57" r="2.2"/></g>'
    }
  };

  var NS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('style', 'display:none');
  svg.setAttribute('aria-hidden', 'true');
  Object.keys(ICONS).forEach(function (id) {
    // 值可为字符串（24×24 图标，默认线宽 1.6）或 {viewBox, strokeWidth, body}（插画）
    var spec = ICONS[id];
    var isIllustration = spec !== null && typeof spec === 'object';
    var sym = document.createElementNS(NS, 'symbol');
    sym.id = id;
    sym.setAttribute('viewBox', isIllustration ? spec.viewBox : '0 0 24 24');
    var g = document.createElementNS(NS, 'g');
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', 'currentColor');
    g.setAttribute('stroke-width', isIllustration ? String(spec.strokeWidth) : '1.6');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    g.innerHTML = isIllustration ? spec.body : spec;
    sym.appendChild(g);
    svg.appendChild(sym);
  });
  document.body.insertBefore(svg, document.body.firstChild);

  // 为所有 <use> 图标补全 href（兼容旧语法）
  document.querySelectorAll('use[href^="#"]').forEach(function (u) {
    u.setAttribute('xlink:href', u.getAttribute('href'));
  });

  // WIG：全部 svg.icon 为装饰性图标（无 role="img"），对读屏隐藏
  document.querySelectorAll('svg.icon').forEach(function (s) {
    if (!s.getAttribute('role')) s.setAttribute('aria-hidden', 'true');
  });
})();
