/**
 * tGo · CaptureCounter —— 对弈底部「提子数 / 当前方」自绘动画控件（产品内核版）
 *
 * 来源（T6.4 修订，2026/09/06 人工反馈）：自 `component/GoCaptureCounter.js`（C1 审核
 * 基线）**提取动画实现逻辑**，不再由视图直接 import 审核稿组件；本文件作为产品内核，
 * 在保留原动画语义（执色大小切换 460ms ease、当前方呼吸、云子渐变/投影）基础上做三处
 * 适配：
 *
 * 1. **棋子与文字均固定显示**（PROMPTS L524，2026/09/06 复核）：大子半径 / 小子比 /
 *    数字 / 标签字号一律取脚本开头常量（CAPTURE_BIG_PX=12、CAPTURE_SMALL_RATIO=0.61、
 *    NUM 14 / LABEL 12），**不再随视窗 / 承载宽度缩放**（移除 ResizeObserver 与
 *    window resize 对尺寸的影响，仅保留 DPR 像素精度与主题即时适配）；
 * 2. **主题即时适配**：文字/标签色读取 CSS 变量（`--text-1/--text-2`），rAF 主循环
 *    每帧检测 `documentElement[data-theme]` 变化 → 下帧即重绘（无延迟），透明面板融入
 *    底部行；CSS 变量缺失时回退内置 light/dark 调色板；
 * 3. 纯函数层（captureMetrics / captureThemeKey / capturePalette）
 *    顶层无 DOM → 无头可测（FE-CAP-*）。
 */

import { paintStone, resolveStoneColors } from './stone-style.js'

const SWITCH_DURATION = 460 // ms，大小过渡时长
const BREATH_PERIOD = 2600 // ms，呼吸周期
const BREATH_AMP = 0.06 // 呼吸幅度

/* ============================================================
 * 固定显示参数（PROMPTS L524：棋子/文字不随视窗/承载宽度缩放。
 * 需要调整显示大小——只改这里，几何按 CAPTURE_BIG_PX 推导）
 * ============================================================ */
/** 大子半径（CSS px，固定；2026/09/06 人工确认默认 12）。 */
export const CAPTURE_BIG_PX = 12
/** 小子 / 大子 半径比（固定）。 */
export const CAPTURE_SMALL_RATIO = 0.61
/** 数字（提子数）字号（固定，人工调校 14）。 */
export const CAPTURE_NUM_PX = 14
/** 标签（黑提/白提）字号（固定，人工调校 12）。 */
export const CAPTURE_LABEL_PX = 12

/** CSS 变量缺失时的回退调色板（与 app.css --text-1/--text-2 对齐）。 */
export const FALLBACK_PALETTES = Object.freeze({
  light: { text: '#2B2B2B', muted: '#6B6B6B' },
  dark: { text: '#E8E6E1', muted: '#9A9A94' },
})

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t)
const lerp = (a, b, t) => a + (b - a) * t
/**
 * easeInOutCubic（t ∈ [0,1] → 单调 [0,1]，无负值）。
 * 注意（2026/09/06 BUG-003）：提取时曾误写为 `-2t+3` 且指数 2 → 后半程为负，
 * 执色切换半径反向回摆两次相交（“翻转 2 次”）。
 */
export const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
const NUM_FONT = (s) =>
  `400 ${s.num}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`
const LABEL_FONT = (s) =>
  `400 ${s.label}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`

/* ============================================================
 * 纯函数层（无 DOM；无头可测）
 * ============================================================ */

/** data-theme 属性（已解析 light/dark）→ 调色板键；未知/缺失回退 light。 */
export function captureThemeKey(themeAttr) {
  return themeAttr === 'dark' ? 'dark' : 'light'
}

/** 内置回退调色板（CSS 变量不可读时使用）。 */
export function capturePalette(themeKey) {
  return FALLBACK_PALETTES[captureThemeKey(themeKey)] || FALLBACK_PALETTES.light
}

/**
 * 由大子半径派生整套**固定几何**（棋子/间距按 big 推导；文字恒为
 * CAPTURE_NUM_PX/CAPTURE_LABEL_PX——PROMPTS L524 后不随任何宽度变化）。
 * @param {number} [big=CAPTURE_BIG_PX] 大子半径（CSS px，组件固定用默认）
 * @returns {{big:number, small:number, num:number, label:number, gap:number,
 *            padX:number, padY:number, centerDist:number, stoneRegion:number}}
 */
export function captureMetrics(big = CAPTURE_BIG_PX) {
  const b = Math.max(1, Number(big) || CAPTURE_BIG_PX)
  return {
    big: b,
    small: Math.round(b * CAPTURE_SMALL_RATIO * 10) / 10,
    num: CAPTURE_NUM_PX,
    label: CAPTURE_LABEL_PX,
    gap: Math.round(b * 0.5),
    padX: Math.max(6, Math.round(b * 0.7)),
    padY: Math.max(4, Math.round(b * 0.5)),
    centerDist: b * 1.15,
    stoneRegion: b + b * 1.15 + b,
  }
}

/* ============================================================
 * CaptureCounter 组件（浏览器 DOM；rAF 主循环自绘）
 * ============================================================ */

export class CaptureCounter {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @param {'black'|'white'} [options.current='black']
   * @param {number} [options.blackCaptures=0]
   * @param {number} [options.whiteCaptures=0]
   * @param {{text?:string, muted?:string, panel?:string, border?:string}} [options.colors]
   *        颜色覆盖（panel/border 默认透明以融入底部行）
   * @param {(player:'black'|'white')=>void} [options.onToggle] 点击双子区切换执色回调
   */
  constructor(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('CaptureCounter: 第一个参数必须是 <canvas> 元素')
    }
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.doc = canvas.ownerDocument || (typeof document !== 'undefined' ? document : null)
    this.win = (this.doc && this.doc.defaultView) || (typeof window !== 'undefined' ? window : null)

    this.current = options.current === 'white' ? 'white' : 'black'
    this.blackCaptures = options.blackCaptures ?? 0
    this.whiteCaptures = options.whiteCaptures ?? 0
    this.onToggle = typeof options.onToggle === 'function' ? options.onToggle : null
    // 颜色覆盖（含面板）：文字/标签主色走主题（见 _themeTick），这里仅存覆盖项
    this.colors = { panel: 'transparent', border: 'transparent', ...(options.colors || {}) }

    this._palette = null
    this._themeAttr = null
    this._anim = null
    this._cssW = 0
    this._cssH = 0
    this._reduceMotion = false
    this._layout = null
    this._raf = null
    this._onClick = null
    this._onKeyDown = null
    this._onVisibility = null
    this._mo = null
    this._destroyed = false

    if (this.win && typeof this.win.matchMedia === 'function') {
      this._reduceMotion = !!this.win.matchMedia('(prefers-reduced-motion: reduce)').matches
    }

    // 主题切换即时重绘（2026/09/24）：`_themeTick()` 只在**帧内**比对 data-theme，而本控件在
    // reduce-motion 下按需调度（无动画即无帧）→ 切主题后文字色（--text-1/--text-2）会停在旧
    // 主题，直到下一次状态变化（落子/提子）才更新。故直接观察 html[data-theme]，变化即唤醒一帧。
    if (this.doc && this.doc.documentElement && typeof MutationObserver === 'function') {
      this._mo = new MutationObserver(() => this._invalidate())
      this._mo.observe(this.doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    }

    canvas.style.display = 'block'
    this._bindClick()
    this._syncAria()

    this._loop = this._loop.bind(this)
    // M-11（2026/09/19 决策 A：保留设计性呼吸动画，仅修纯浪费）：
    // - 页面隐藏（document.hidden）→ 停帧，回可见续帧（旧实现后台 60fps 重绘）；
    // - prefers-reduced-motion 且无执色过渡 → 静态显示，仅状态变化重绘单帧；
    // - 常态：呼吸动画持续需要帧（设计保留）。
    this._onVisibility = () => {
      if (this._destroyed) return
      if (this._isHidden()) this._cancelFrame()
      else this._invalidate()
    }
    if (this.doc && typeof this.doc.addEventListener === 'function') {
      this.doc.addEventListener('visibilitychange', this._onVisibility)
    }
    // 首绘：无论 reduce-motion 都必须至少画一帧（静态显示也从这里来）
    this._invalidate()
  }

  /* ---------------- 公共 API ---------------- */

  /** 设置当前执色；不同则触发大小过渡 + 呼吸动画 */
  setCurrent(player, animate = true) {
    const next = player === 'white' ? 'white' : 'black'
    if (next === this.current) return
    const from = this.current
    this.current = next
    this._anim =
      animate && !this._reduceMotion && this.win
        ? { start: this.win.performance.now(), from }
        : null
    this._syncAria()
    this._invalidate()
  }

  /** 切换执色 */
  toggle(animate = true) {
    this.setCurrent(this.current === 'black' ? 'white' : 'black', animate)
  }

  /** 设置提子数，如 { black, white } */
  setCaptures({ black, white } = {}) {
    if (typeof black === 'number') this.blackCaptures = black
    if (typeof white === 'number') this.whiteCaptures = white
    this._syncAria()
    this._invalidate()
  }

  /** 指定一方提子数 +1 */
  addCapture(player) {
    if (player === 'white') this.whiteCaptures += 1
    else this.blackCaptures += 1
    this._syncAria()
    this._invalidate()
  }

  /** 重置提子数与执色 */
  reset() {
    this.blackCaptures = 0
    this.whiteCaptures = 0
    this.current = 'black'
    this._anim = null
    this._syncAria()
    this._invalidate()
  }

  /** 销毁：停止 rAF / 事件监听 */
  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._cancelFrame()
    if (this._mo) {
      this._mo.disconnect()
      this._mo = null
    }
    if (this.doc && this._onVisibility && typeof this.doc.removeEventListener === 'function') {
      this.doc.removeEventListener('visibilitychange', this._onVisibility)
    }
    this._onVisibility = null
    if (this.canvas && this._onClick) this.canvas.removeEventListener('click', this._onClick)
    if (this.canvas && this._onKeyDown) this.canvas.removeEventListener('keydown', this._onKeyDown)
    this._onClick = null
    this._onKeyDown = null
  }

  /* ---------------- 主题 ---------------- */

  _bindClick() {
    if (!this.onToggle || !this.canvas || !this.win) return
    this.canvas.style.cursor = 'pointer'
    this._onClick = (evt) => {
      if (!this._layout) return
      const rect = this.canvas.getBoundingClientRect()
      const x = evt.clientX - rect.left
      const y = evt.clientY - rect.top
      const { hit } = this._layout
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        const next = this.current === 'black' ? 'white' : 'black'
        this.setCurrent(next)
        this.onToggle(next)
      }
    }
    this.canvas.addEventListener('click', this._onClick)
    // 键盘等价路径（WIG：点击切换必须有键盘替代；Enter/Space）
    this._onKeyDown = (evt) => {
      if (evt.key !== 'Enter' && evt.key !== ' ' && evt.key !== 'Spacebar') return
      evt.preventDefault()
      const next = this.current === 'black' ? 'white' : 'black'
      this.setCurrent(next)
      this.onToggle(next)
    }
    this.canvas.addEventListener('keydown', this._onKeyDown)
  }

  /**
   * 读屏替代（WIG）：提子数仅绘制于画布，读屏不可得 → role/aria-label 同步。
   * 有 onToggle 时画布是“切换当前方”按钮（role=button + tabindex，见 _bindClick 键盘接线）。
   */
  _syncAria() {
    if (!this.canvas || typeof this.canvas.setAttribute !== 'function') return
    const label = `黑方提子 ${this.blackCaptures}，白方提子 ${this.whiteCaptures}，当前方 ${this.current === 'black' ? '黑方' : '白方'}`
    if (this.onToggle) {
      this.canvas.setAttribute('role', 'button')
      this.canvas.setAttribute('tabindex', '0')
      this.canvas.setAttribute('aria-label', `${label}；按回车切换当前方`)
    } else {
      this.canvas.setAttribute('role', 'img')
      this.canvas.setAttribute('aria-label', label)
    }
  }

  /** 主题即时适配：data-theme 变化（CSS 变量已同步）→ 下帧读新调色板。 */
  _themeTick() {
    if (!this.doc) return
    const attr = this.doc.documentElement.getAttribute('data-theme') || ''
    if (attr === this._themeAttr && this._palette) return
    this._themeAttr = attr
    const key = captureThemeKey(attr)
    const fallback = capturePalette(key)
    if (this.win && typeof this.win.getComputedStyle === 'function') {
      const cs = this.win.getComputedStyle(this.doc.documentElement)
      const read = (name, fb) => {
        const v = cs.getPropertyValue(name)
        return v && v.trim() ? v.trim() : fb
      }
      this._palette = {
        text: read('--text-1', fallback.text),
        muted: read('--text-2', fallback.muted),
        panel: this.colors.panel,
        border: this.colors.border,
      }
    } else {
      this._palette = { text: fallback.text, muted: fallback.muted, panel: this.colors.panel, border: this.colors.border }
    }
  }

  /* ---------------- rAF 主循环（M-11：按需调度） ---------------- */

  /**
   * 是否需要后续帧：
   * - 销毁 / 页面不可见（document.hidden）→ 停帧（回可见时续帧）；
   * - 执色切换过渡（``_anim``）进行中 → 需要；
   * - 常态（未开启 reduce-motion）→ 设计性呼吸动画持续需要；
   * - reduce-motion 且无过渡 → 静态显示，仅由状态变化触发的单帧重绘。
   */
  _needsFrame() {
    if (this._destroyed || !this.win || this._isHidden()) return false
    if (this._anim) return true
    return !this._reduceMotion
  }

  _isHidden() {
    return Boolean(this.doc && this.doc.hidden)
  }

  _cancelFrame() {
    if (this._raf != null && this.win) this.win.cancelAnimationFrame(this._raf)
    this._raf = null
  }

  /**
   * 状态变化 / 回可见性后确保至少一帧重绘（单帧调度，与「是否持续要帧」解耦）：
   * reduced-motion 或 idle 下状态变化也必有一帧（否则数值/主题不更新）；
   * 常态呼吸循环中已有在途帧 → no-op。
   */
  _invalidate() {
    if (this._destroyed || !this.win || this._isHidden() || this._raf != null) return
    this._raf = this.win.requestAnimationFrame(this._loop)
  }

  _loop(now) {
    this._raf = null
    this._draw(now)
    if (this._needsFrame()) this._raf = this.win.requestAnimationFrame(this._loop)
  }

  /** 测量文本宽度并返回布局 */
  _measure(s, ctx) {
    ctx.font = NUM_FONT(s)
    const blackNumW = ctx.measureText(String(this.blackCaptures)).width
    const whiteNumW = ctx.measureText(String(this.whiteCaptures)).width
    ctx.font = LABEL_FONT(s)
    const labelBW = ctx.measureText('黑提').width
    const labelWW = ctx.measureText('白提').width
    const contentW =
      blackNumW + s.gap + labelBW + s.gap + s.stoneRegion + s.gap + labelWW + s.gap + whiteNumW
    return {
      blackNumW,
      whiteNumW,
      labelBW,
      labelWW,
      width: Math.ceil(contentW + s.padX * 2),
      height: Math.ceil(s.padY * 2 + s.big * 2),
    }
  }

  _draw(now) {
    if (!this.win || !this.ctx) return
    const ctx = this.ctx
    this._themeTick()

    // 固定尺寸（PROMPTS L524）：大子半径取脚本开头常量，不随视窗/承载宽度变化
    const s = captureMetrics()
    const m = this._measure(s, ctx)

    const dpr = Math.max(1, this.win.devicePixelRatio || 1)
    const cssW = Math.round(m.width)
    const cssH = Math.round(m.height)
    const pxW = Math.round(m.width * dpr)
    const pxH = Math.round(m.height * dpr)
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW
      this.canvas.height = pxH
    }
    // 仅尺寸变化才写 style（避免 rAF 每帧触发样式重算，造成控件/整行抖动）
    if (this._cssW !== cssW || this._cssH !== cssH) {
      this._cssW = cssW
      this._cssH = cssH
      this.canvas.style.width = `${cssW}px`
      this.canvas.style.height = `${cssH}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const palette = this._palette || capturePalette(captureThemeKey(this._themeAttr))
    const cy = cssH / 2

    // 面板（透明融入底部行：panel/border 由调用方覆盖或默认 transparent）
    this._roundRect(ctx, 0.5, 0.5, cssW - 1, cssH - 1, cssH / 2)
    ctx.fillStyle = palette.panel
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = palette.border
    ctx.stroke()

    // ------- 内容从左到右布局：黑提数 / 黑提 / ●○ 双子 / 白提 / 白提数 -------
    let x = s.padX
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'

    ctx.font = NUM_FONT(s)
    ctx.fillStyle = palette.text
    ctx.fillText(String(this.blackCaptures), x, cy)
    x += m.blackNumW + s.gap

    ctx.font = LABEL_FONT(s)
    ctx.fillStyle = palette.muted
    ctx.fillText('黑提', x, cy)
    x += m.labelBW + s.gap

    const regionX = x
    const blackX = regionX + s.big
    const whiteX = blackX + s.centerDist
    x += s.stoneRegion + s.gap

    ctx.font = LABEL_FONT(s)
    ctx.fillStyle = palette.muted
    ctx.fillText('白提', x, cy)
    x += m.labelWW + s.gap

    ctx.font = NUM_FONT(s)
    ctx.fillStyle = palette.text
    ctx.fillText(String(this.whiteCaptures), x, cy)

    // 命中区域（中间双子；仅 onToggle 时使用）
    this._layout = {
      hit: { x: regionX - 4, y: cy - s.big, w: s.stoneRegion + 8, h: s.big * 2 },
    }

    // ------- 两子半径：执色大小切换过渡 + 当前方呼吸 -------
    // 平滑性说明（2026/09/06 修正）：切换“翻转 2 次/抖动”根因是 easeInOutCubic
    // 提取笔误（写成 `-2t+3` 且指数 2），使后半程进度 pe 变负 → 半径反向回摆、
    // 与对方半径两次相交，叠层往返。现与 C1 参考一致为 `-2t+2` 立方（pe 单调
    // 0→1），过渡中两子半径仅交汇一次，呼吸按参考式（settle=pe 渐入）叠加。
    let p = 1
    let from = this.current
    if (this._anim) {
      p = clamp01((now - this._anim.start) / SWITCH_DURATION)
      from = this._anim.from
      if (p >= 1) this._anim = null
    }
    const pe = easeInOutCubic(p)
    const radiusFor = (color, cur) => (color === cur ? s.big : s.small)
    const blackR = lerp(radiusFor('black', from), radiusFor('black', this.current), pe)
    const whiteR = lerp(radiusFor('white', from), radiusFor('white', this.current), pe)

    const breath = 1 + BREATH_AMP * Math.sin((now / BREATH_PERIOD) * Math.PI * 2)
    const settle = this._reduceMotion ? 0 : pe
    const blackBreath = this.current === 'black' ? lerp(1, breath, settle) : 1
    const whiteBreath = this.current === 'white' ? lerp(1, breath, settle) : 1

    // 小子先画（下层），大子后画（上层，位于重叠区之上）
    const stones = [
      { x: blackX, y: cy, r: blackR * blackBreath, color: 'black' },
      { x: whiteX, y: cy, r: whiteR * whiteBreath, color: 'white' },
    ].sort((a, b) => a.r - b.r)
    for (const st of stones) this._drawStone(ctx, st.x, st.y, st.r, st.color)
  }

  _drawStone(ctx, x, y, r, color) {
    // 云子材质统一走 core/stone-style（yunzi token：三档渐变 + 物理投影 + 底部-右缘墨绿/丹红微透）
    if (!this._stonePal) this._stonePal = resolveStoneColors(this.doc)
    paintStone(ctx, { x, y, r, color }, this._stonePal)
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, h / 2, w / 2)
    ctx.beginPath()
    ctx.moveTo(x + rad, y)
    ctx.arcTo(x + w, y, x + w, y + h, rad)
    ctx.arcTo(x + w, y + h, x, y + h, rad)
    ctx.arcTo(x, y + h, x, y, rad)
    ctx.arcTo(x, y, x + w, y, rad)
    ctx.closePath()
  }
}

export default CaptureCounter
