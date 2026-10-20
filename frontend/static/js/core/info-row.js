/**
 * tGo · 信息行共用内核（对弈/复盘）：分段分组 + 移动端「全部对局信息」弹层。
 *
 * 需求（2026/09/13 人工反馈，均移动端 ≤767）：
 *   - 棋盘上方信息行超出一行时单行省略（`…`，同棋谱列表口径）；
 *   - 行首常驻「对局信息」SVG 图标 → 点击弹出**全部对局信息**（顶层浮层）；
 *   - `自动点评`、`AI匹配 · 5K`、[···] 菜单等标签固定完整显示（不参与省略）；
 *   - 任意其他操作回收弹层（外部点击 / 滚动 / Esc / 视图销毁）。
 *
 * 纯函数层（无 DOM，无头可测）：groupMetaSegments / infoPopPosition。
 * DOM 层：createInfoPop 弹层控制器（对弈/复盘各持一个实例）。
 */

/**
 * 信息行分段分组（移动端单行省略的 DOM 结构依据）：
 *   - `pill`：首个试下胶囊段（可点击按钮，固定完整；`pillIndex` 指定，缺省无）；
 *   - `clip`：文本段（渲染为 `.meta-clip` 内联流，移动端单行省略）；
 *   - `fixed`：徽章（`badge`）与自动点评开关（`coach`），固定完整显示。
 * 顺序保持：pill（若有）→ clip → fixed（game/review 的徽章/开关本就位于文本段之后）。
 *
 * @param {Array<{text:string, badge?:string, coach?:boolean, trial?:boolean}>} segs
 * @param {{pillIndex?:number}} [opts] pillIndex 为 `pill` 段下标（-1/缺省 = 无 pill）
 * @returns {{pill:object|null, clip:Array, fixed:Array}}
 */
export function groupMetaSegments(segs, { pillIndex = -1 } = {}) {
  const out = { pill: null, clip: [], fixed: [] };
  const list = Array.isArray(segs) ? segs : [];
  list.forEach((seg, i) => {
    if (i === pillIndex && seg) {
      out.pill = seg;
      return;
    }
    if (seg && (seg.badge || seg.coach)) out.fixed.push(seg);
    else out.clip.push(seg);
  });
  return out;
}

/**
 * 信息弹层全文（` · ` 连接）：**不含徽章/开关等控件段**——`AI匹配 · 5K`（徽章）、`自动点评`
 * （可点击开关）一律不展示（2026/09/13 人工口径：该图标只显示对局信息）；试下胶囊（纯文本
 * 位置信息）保留。
 *
 * @param {Array<{text:string, badge?:string, coach?:boolean}>} segs 信息行分段（metaSegments / reviewMeta）
 * @returns {string}
 */
export function metaPopText(segs) {
  return (Array.isArray(segs) ? segs : [])
    .filter((s) => !(s && (s.coach || s.badge)))
    .map((s) => (s ? s.text : ''))
    .join(' · ');
}

/**
 * 信息弹层定位（视口内钳制）。
 * 缺省置于锚点正下方（间距 6px）；下方空间不足且上方更充裕时上翻；
 * 水平右溢时左移；四周保留 `margin` 安全边距。
 *
 * @param {{anchor:{left:number,right:number,top:number,bottom:number},
 *          size:{width:number,height:number},
 *          viewport:{width:number,height:number}, margin?:number}} o
 * @returns {{left:number, top:number}}
 */
export function infoPopPosition(o = {}) {
  const anchor = o.anchor || { left: 0, right: 0, top: 0, bottom: 0 };
  const size = o.size || { width: 0, height: 0 };
  const viewport = o.viewport || { width: 0, height: 0 };
  const margin = Number.isFinite(o.margin) ? o.margin : 8;
  const gap = 6;
  const maxLeft = Math.max(margin, viewport.width - margin - size.width);
  const maxTop = Math.max(margin, viewport.height - margin - size.height);

  let left = Math.min(Math.max(anchor.left, margin), maxLeft);

  let top = anchor.bottom + gap;
  if (top > maxTop) {
    const above = anchor.top - gap - size.height;
    top = above >= margin ? above : maxTop;
  }
  return { left, top };
}

/**
 * 「全部对局信息」顶部弹层控制器（顶层浮层，任意其他操作回收）。
 * 用法：`const pop = createInfoPop(); pop.toggle(iconEl, '全部信息文本'); pop.destroy();`
 *
 * @param {{doc?:Document, win?:Window}} [opts]
 * @returns {{toggle:Function, show:Function, hide:Function, isOpen:Function, destroy:Function}}
 */
export function createInfoPop({ doc = null, win = null } = {}) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const w = win || (d && d.defaultView) || (typeof window !== 'undefined' ? window : null);
  let el = null;
  let anchorEl = null;
  let open = false;

  function ensure() {
    if (!el && d) {
      el = d.createElement('div');
      el.className = 'info-pop';
      el.hidden = true;
      d.body.appendChild(el);
    }
    return el;
  }

  function place() {
    if (!el || !anchorEl) return;
    el.style.left = '0px';
    el.style.top = '0px';
    const a = anchorEl.getBoundingClientRect();
    const viewport = {
      width: (d.documentElement && d.documentElement.clientWidth) || w.innerWidth || 0,
      height: (d.documentElement && d.documentElement.clientHeight) || w.innerHeight || 0,
    };
    const { left, top } = infoPopPosition({
      anchor: { left: a.left, right: a.right, top: a.top, bottom: a.bottom },
      size: { width: el.offsetWidth, height: el.offsetHeight },
      viewport,
    });
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function onDocDown(e) {
    if (!open) return;
    if (el && e.target && el.contains(e.target)) return;
    if (anchorEl && e.target && anchorEl.contains(e.target)) return; // 锚点点击交给 toggle
    hide();
  }

  function onScroll() {
    if (open) hide();
  }

  function onKey(e) {
    if (open && (e.key === 'Escape' || e.key === 'Esc')) hide();
  }

  function onResize() {
    if (open) hide();
  }

  function bind() {
    if (!d) return;
    d.addEventListener('pointerdown', onDocDown, true);
    d.addEventListener('keydown', onKey, true);
    if (w) {
      w.addEventListener('scroll', onScroll, true);
      w.addEventListener('resize', onResize);
    }
  }

  function unbind() {
    if (!d) return;
    d.removeEventListener('pointerdown', onDocDown, true);
    d.removeEventListener('keydown', onKey, true);
    if (w) {
      w.removeEventListener('scroll', onScroll, true);
      w.removeEventListener('resize', onResize);
    }
  }

  function show(anchor, text) {
    if (!d) return;
    ensure();
    anchorEl = anchor || anchorEl;
    el.textContent = String(text == null ? '' : text);
    el.style.visibility = 'hidden';
    el.hidden = false;
    place();
    el.style.visibility = '';
    open = true;
    bind();
  }

  function hide() {
    if (!el) return;
    unbind();
    el.hidden = true;
    open = false;
    anchorEl = null;
  }

  function toggle(anchor, text) {
    if (open) hide();
    else show(anchor, text);
  }

  function destroy() {
    hide();
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
  }

  return { toggle, show, hide, isOpen: () => open, destroy };
}
