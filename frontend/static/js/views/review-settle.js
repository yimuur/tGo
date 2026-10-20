/**
 * tGo · 复盘「补结算」死子确认模块（2026/09/19，人工决策方案 A）
 *
 * 职责（PROMPTS L977–979 人工决策）：
 *   - **未结算终局**（``status=finished`` 且 ``result`` 为空，即导入棋谱）在复盘页
 *     经 [结算] 进入死子确认：``scoring.prepare`` 触发后端终局深算预判
 *     （``scoring.prediction``，引擎不可用降级 ``engine:false`` → 纯手动标记）；
 *     点击棋盘棋子切换死/活（✕），[全部确认]/[跳过] → ``scoring.confirm``
 *     （后端同一 Python 数子口径**原地结算**：写 result + scorings，不迁移状态）；
 *   - **第二步「数子结果」（2026/09/19 人工口径）**：``game.finished`` 到达后结算卡
 *     原地转入结果展示——大字结果 + **黑目/白目/贴目/手数**（``deriveScoreGrid`` 同对弈页
 *     口径；认输类无目数时仅大字）→ [完成]/[✕]/ESC 退出并返回复盘；**未定型终局
 *     （2026/10/10 人工口径）**：导入棋谱末手非双 PASS ⇒ 结果取自 AI 预判（无精确目数，
 *     同样无网格），副行文案为「终局局面未定型 · 结果为AI 预判」；
 *   - **取消**＝本地退出（无服务端状态回滚——方案 A 不进入 SCORING）；
 *   - **宿主形态与对弈页结算一致**（人工决策）：≥768 桌面侧栏结算卡
 *     （``hosts.desktop``）；≤767 底部抽屉 ``.settle-drawer``（``hosts.mobile``，
 *     grip 收起/展开、下滑不关闭）；[✕]/ESC = 退出结算模式。
 *
 * 分层：纯函数（``settleDrawerTitle``；提示文案/预判结果复用 ``scoring-panel.js``
 * 的 ``deadConfirmHint``/``predictionResultParts`` 单一口径）+ 本模块（DOM 呈现 +
 * store 订阅；不直写棋盘——由复盘视图经 ``deps.onDead`` 回写 ``deadStones``）。
 */

import { hasOpenDialogMask } from '../core/dialog.js';
import {
  deadConfirmHint,
  deadToTuples,
  deriveScoreGrid,
  normalizePoints,
  predictionResultParts,
  resultHeroParts,
  settleSubtitle,
  toggleDeadPoint,
} from './scoring-panel.js';

/* ============================================================
 * 纯函数层（无 DOM；可无头测试）
 * ============================================================ */

/** 抽屉标题（含已标死子数 / 已结算态）。 */
export function settleDrawerTitle(deadCount = 0, done = false) {
  if (done) return '终局结算 · 已结算';
  const n = Math.max(0, Number(deadCount) || 0);
  return n > 0 ? `终局结算 · 死子已标 ${n} 颗` : '终局结算 · 死子确认';
}

/**
 * 第二步「数子结果」派生（2026/09/19 人工口径：同对弈页结算口径）。
 *
 * ``game`` 为状态树对局（提供 ``params.komi`` 与 ``lastMoveNo``）；``finished`` 为
 * ``game.finished`` 捕获载荷（``{result, blackScore, whiteScore, aiPredicted}``——该载荷
 * 后跟的 ``game.state`` 不携带目数，不得从 store 读分）。无目数（认输类 / 未定型终局
 * 取 AI 预判）时 ``grid.hasNumbers=false``，卡片仅展示大字结果（同对弈页 resultPhaseHTML 行为）。
 * @param {object} game
 * @param {{result?:string|null, blackScore?:number|null, whiteScore?:number|null, aiPredicted?:boolean}|null} finished
 * @returns {{hero:{body:string,note:string}, subtitle:string, grid:{hasNumbers:boolean, items:Array}}}
 */
export function settleResultModel(game, finished) {
  const f = finished || {};
  const result = f.result != null ? f.result : ((game && game.result) ?? null);
  return {
    hero: resultHeroParts(result),
    subtitle: settleSubtitle(game, f) || '终局结算完成',
    grid: deriveScoreGrid(game, { blackScore: f.blackScore, whiteScore: f.whiteScore }),
  };
}

/* ============================================================
 * 模块
 * ============================================================ */

/**
 * @param {object} deps
 * @param {object} deps.store  状态树（store）
 * @param {object} deps.hub    WS 双通道（sendGame：scoring.prepare / scoring.confirm）
 * @param {{desktop?:HTMLElement, mobile?:HTMLElement}} deps.hosts 挂载点：
 *   desktop=桌面侧栏结算卡容器；mobile=≤767 底部抽屉根容器（自建 .settle-drawer）
 * @param {boolean|Function} [deps.isDesktop] 桌面断点（缺省 matchMedia ≥768）
 * @param {Function} deps.context () => {gameId:number, moveNo:number} 当前复盘对局与终局手数
 * @param {Function} [deps.onDead]  (list)=>void 死子集合回写（复盘视图设 board deadStones）
 * @param {Function} [deps.onExit]  退出结算模式（[取消]/[完成]/[✕]/ESC；视图恢复复盘壳）
 * @param {Function} [deps.onDone]  (payload)=>void 结算完成（game.finished 到达；视图刷新详情）
 */
export function createReviewSettleModule(deps = {}) {
  const store = deps.store;
  const hub = deps.hub;
  const hosts = deps.hosts || {};

  let destroyed = false;
  let wrapper = null; // 卡片容器（.scoring-panel；桌面侧栏 / 移动抽屉 body 间迁移）
  let drawerEl = null;
  let drawerBodyEl = null;
  let drawerTitleEl = null;
  let unsub = null;
  let mqHandler = null;
  let escHandler = null;
  let errHandler = null;

  const self = {
    active: false,
    dead: [],
    touched: false, // 用户已手动校正（此后不再被预判覆盖）
    predicted: false, // 已应用服务端预判死子
    predState: 'none', // none | waiting | seeded | no-data
    prediction: null, // scoring.prediction 状态切片（含预判结果）
    submitting: false, // 已提交结算确认（防重复；game.finished 后复位）
    done: false, // 已结算（转入第二步「数子结果」）
    finished: null, // game.finished 捕获载荷 {result, blackScore, whiteScore, aiPredicted}
    collapsed: false, // ≤767 抽屉收起态（露出棋盘；下滑/点空白不关闭）
  };

  /* ---------------- 工具 ---------------- */

  function isDesktop() {
    if (typeof deps.isDesktop === 'function') return Boolean(deps.isDesktop());
    if (deps.isDesktop !== undefined) return Boolean(deps.isDesktop);
    return typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(min-width: 768px)').matches
      : true;
  }

  function context() {
    return (typeof deps.context === 'function' ? deps.context() : null) || { gameId: 0, moveNo: 0 };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------- 死子集合 ---------------- */

  function syncDead() {
    const list = normalizePoints(self.dead);
    self.dead = list;
    if (typeof deps.onDead === 'function') deps.onDead(list);
  }

  /** 棋盘点击棋子：切换死/活（复盘视图在结算模式下经 ``toggleDead`` 驱动）。 */
  function toggleDead(pt) {
    if (!self.active || self.submitting || self.done) return;
    self.touched = true;
    self.dead = toggleDeadPoint(self.dead, pt.x, pt.y);
    syncDead();
    render();
  }

  function clearDead() {
    if (!self.active || self.submitting) return;
    self.touched = true;
    self.dead = [];
    syncDead();
    render();
  }

  /* ---------------- 预判同步（scoring.prediction） ---------------- */

  function syncPrediction() {
    if (!self.active) return;
    const ctx = context();
    const pred = store.getState().prediction;
    const fresh = pred && Number(pred.gameId) === Number(ctx.gameId)
      && Number(pred.moveNo) === Number(ctx.moveNo);
    if (!fresh) {
      // 尚无预判：等待服务端终局深算（失败/引擎不可用由服务端推 engine:false）
      if (self.predState !== 'waiting') {
        self.predState = 'waiting';
        render();
      }
      return;
    }
    self.prediction = pred;
    if (!pred.engine) {
      if (self.predState !== 'no-data') {
        self.predState = 'no-data';
        render();
      }
      return;
    }
    // 用户未开始手动校正 → 按 AI 预判预标死子（点击棋子可切换）
    if (!self.predicted && !self.touched) {
      self.predicted = true;
      self.dead = normalizePoints(pred.deadPoints);
      syncDead();
    }
    if (self.predState !== 'seeded') {
      self.predState = 'seeded';
      render();
    }
  }

  /* ---------------- 提交 ---------------- */

  /** 提交结算确认（``skip=true``＝跳过 = 空死子集合按棋面结算）。 */
  function submitScoring(skip) {
    if (self.submitting || self.done || !self.active) return;
    if (!hub || typeof hub.sendGame !== 'function') return;
    self.submitting = true;
    self.touched = true;
    render();
    hub.sendGame('scoring.confirm', { dead_points: skip ? [] : deadToTuples(self.dead) });
    // game.finished / error 信封到达后复位（store 订阅 / tgo:error 监听）
  }

  /* ---------------- 渲染 ---------------- */

  function hintText() {
    const s = store.getState();
    return deadConfirmHint({
      engineState: (s.engine && s.engine.state) || '',
      predState: self.predState,
      deadCount: self.dead.length,
    });
  }

  function cardHTML() {
    if (self.finished) return resultHTML();
    const hint = hintText();
    const empty = self.dead.length === 0;
    const busy = self.submitting;
    const pred = predictionResultParts(self.prediction);
    return `
      <div class="card" data-ref="rvSettleMain">
        <h3><svg class="icon" aria-hidden="true"><use href="#i-comment"/></svg>终局结算</h3>
        <div class="scoring-steps">
          <div>
            <div class="muted step-line"><b style="color:var(--text-1)">① 死子确认</b>
              <span class="dead-count num">${esc(self.dead.length > 0 ? `已标 ${self.dead.length} 颗` : '')}</span>
            </div>
            <p class="settle-hint">${esc(hint)}</p>
            ${pred ? `<p class="settle-hint muted">AI 预判结果：<span class="settle-pred"><b>${esc(pred.body)}</b>${pred.note ? ` ${esc(pred.note)}` : ''}</span></p>` : ''}
            <div class="dead-tools">
              <button class="btn btn-primary" type="button" data-act="confirm"
                      ${busy ? 'disabled' : ''}>全部确认</button>
              <button class="btn btn-secondary" type="button" data-act="clear"
                      ${empty || busy ? 'disabled' : ''}>全部清除</button>
              <button class="btn btn-ghost" type="button" data-act="skip"
                      ${busy ? 'disabled' : ''}>跳过</button>
            </div>
            <div class="muted" style="font-size:12px;margin-top:8px">
              <svg class="icon" style="width:13px;height:13px;vertical-align:-2px" aria-hidden="true"><use href="#i-info"/></svg>
              结算按当前标记的终局局面数子；任一终端确认即生效
            </div>
          </div>
        </div>
        <div class="divider"></div>
        <div class="dead-tools">
          <button class="btn btn-ghost btn-sm" type="button" data-act="cancel"
                  ${busy ? 'disabled' : ''}>取消结算</button>
          <span class="settle-cancel-hint">取消仅退出结算模式，不改变对局状态</span>
        </div>
      </div>`;
  }

  /** 第二步「数子结果」（同对弈页口径：大字结果 + 黑目/白目/贴目/手数）；[完成] 退回复盘。 */
  function resultHTML() {
    const g = (store.getState() && store.getState().game) || {};
    const model = settleResultModel(g, self.finished);
    return `
      <div class="card" data-ref="rvSettleMain">
        <h3><svg class="icon" aria-hidden="true"><use href="#i-comment"/></svg>终局结算</h3>
        <div class="result-hero">
          <div class="big num">${esc(model.hero.body || '—')}${model.hero.note ? ` <small>${esc(model.hero.note)}</small>` : ''}</div>
          <div class="sub">${esc(model.subtitle)}</div>
        </div>
        ${model.grid.hasNumbers ? `
        <div class="result-grid">
          ${model.grid.items.map((it) => `
            <div class="item"><div class="label">${esc(it.label)}</div>
              <div class="value num">${esc(it.value)}</div></div>`).join('')}
        </div>` : ''}
        <div class="dead-tools" style="justify-content:center">
          <button class="btn btn-primary" type="button" data-act="done">完成</button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">
          <svg class="icon" style="width:13px;height:13px;vertical-align:-2px" aria-hidden="true"><use href="#i-info"/></svg>
          结算已保存 · 补全分析数据后可查看 [报告]
        </div>
      </div>`;
  }

  function render() {
    if (destroyed || !self.active || !wrapper) return;
    wrapper.innerHTML = cardHTML();
    syncDrawerTitle();
  }

  function place() {
    if (destroyed || !wrapper) return;
    const desktop = isDesktop();
    if (hosts.desktop) hosts.desktop.classList.toggle('u-hide', !desktop || !self.active);
    if (hosts.mobile) hosts.mobile.classList.toggle('u-hide', desktop || !self.active);
    if (desktop) {
      if (drawerEl && hosts.mobile && drawerEl.parentNode === hosts.mobile) {
        hosts.mobile.removeChild(drawerEl);
      }
      if (hosts.desktop && wrapper.parentNode !== hosts.desktop) hosts.desktop.appendChild(wrapper);
      return;
    }
    ensureDrawer();
    if (drawerEl && hosts.mobile && drawerEl.parentNode !== hosts.mobile) {
      hosts.mobile.appendChild(drawerEl);
    }
    if (drawerBodyEl && wrapper.parentNode !== drawerBodyEl) drawerBodyEl.appendChild(wrapper);
    if (drawerEl) drawerEl.classList.toggle('collapsed', self.collapsed);
    syncDrawerTitle();
  }

  /* ---------------- ≤767 底部抽屉壳（grip 收起/展开；✕/ESC＝退出结算） ---------------- */

  function syncDrawerTitle() {
    if (!drawerEl) return;
    if (drawerTitleEl) drawerTitleEl.textContent = settleDrawerTitle(self.dead.length, Boolean(self.finished));
    // [✕] 阶段语义：死子确认＝退出结算；已结算（第二步）＝完成返回复盘
    const closeBtn = drawerEl.querySelector('[data-ref2="close"]');
    if (closeBtn) {
      const label = self.finished ? '完成（返回复盘）' : '退出结算';
      closeBtn.setAttribute('aria-label', label);
      closeBtn.title = label;
    }
    const grip = drawerEl.querySelector('.drawer-grip');
    if (grip) {
      grip.setAttribute('aria-expanded', String(!self.collapsed));
      grip.setAttribute('aria-label', self.collapsed ? '展开结算面板' : '收起结算面板（露出棋盘）');
      grip.title = self.collapsed ? '轻点展开' : '轻点收起；按住下滑收起、上滑展开（不关闭）';
    }
  }

  function bindGrip(grip) {
    let drag = null;
    let suppressClickUntil = 0;
    const onMove = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 6) drag.moved = true;
      const ty = self.collapsed ? Math.min(0, dy) : Math.max(0, dy);
      if (drawerEl) drawerEl.style.transform = ty ? `translateY(${ty}px)` : '';
    };
    const end = (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      const moved = drag.moved;
      drag = null;
      if (drawerEl) {
        drawerEl.classList.remove('dragging');
        drawerEl.style.transform = '';
      }
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* 无捕获环境 */
      }
      if (!moved) return; // 轻点交由 click 切换
      suppressClickUntil = Date.now() + 350;
      if (dy > 40 && !self.collapsed) setCollapsed(true);
      else if (dy < -40 && self.collapsed) setCollapsed(false);
    };
    grip.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, moved: false };
      if (drawerEl) drawerEl.classList.add('dragging');
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* 忽略 */
      }
    });
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('click', () => {
      if (Date.now() < suppressClickUntil) return;
      setCollapsed(!self.collapsed);
    });
  }

  function ensureDrawer() {
    if (drawerEl || !hosts.mobile) return;
    drawerEl = document.createElement('div');
    drawerEl.className = 'settle-drawer';
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'false');
    drawerEl.setAttribute('aria-label', '终局结算');
    drawerEl.innerHTML = `
      <button class="drawer-grip" type="button"
              aria-expanded="true" aria-label="收起结算面板（露出棋盘）"
              title="轻点收起/展开；按住下滑收起、上滑展开（不关闭）"></button>
      <div class="settle-drawer-head">
        <span class="settle-drawer-title num" data-ref2="title"></span>
        <button class="icon-btn" type="button" data-ref2="close"
                aria-label="退出结算" title="退出结算">
          <svg class="icon" aria-hidden="true"><use href="#i-close"/></svg>
        </button>
      </div>
      <div class="settle-drawer-body" data-ref2="body"></div>`;
    drawerTitleEl = drawerEl.querySelector('[data-ref2="title"]');
    drawerBodyEl = drawerEl.querySelector('[data-ref2="body"]');
    if (hosts.mobile) hosts.mobile.appendChild(drawerEl);
    bindGrip(drawerEl.querySelector('.drawer-grip'));
    drawerEl.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-ref2="close"]') : null;
      if (btn) exitRequested();
    });
  }

  function setCollapsed(collapsed) {
    self.collapsed = Boolean(collapsed);
    if (drawerEl) drawerEl.classList.toggle('collapsed', self.collapsed);
    syncDrawerTitle();
  }

  /* ---------------- 生命周期 / 订阅 ---------------- */

  function exitRequested() {
    if (typeof deps.onExit === 'function') deps.onExit();
  }

  function onStoreChange(state, message) {
    if (destroyed || !self.active) return;
    const type = message && message.type;
    if (type === 'scoring.prediction') {
      syncPrediction();
      return;
    }
    if (type === 'game.finished') {
      if (self.done) return;
      self.done = true;
      self.submitting = false;
      // 第二步「数子结果」（2026/09/19 人工口径）：捕获载荷（目数不随后的 game.state
      // 携带）→ 结算卡原地转入结果展示；[完成]/[✕]/ESC 后由视图退出结算模式。
      const data = message.data || {};
      self.finished = {
        result: data.result != null ? data.result : null,
        blackScore: data.black_score !== undefined ? data.black_score : null,
        whiteScore: data.white_score !== undefined ? data.white_score : null,
        // 未定型终局（结果取 AI 预判）：后端 `confirm` 载荷可选字段（缺失=false）
        aiPredicted: data.ai_predicted === true,
      };
      render();
      if (typeof deps.onDone === 'function') deps.onDone(data);
      return;
    }
  }

  function ensureBuilt() {
    if (wrapper || destroyed) return;
    wrapper = document.createElement('div');
    wrapper.className = 'scoring-panel';
    wrapper.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'confirm') submitScoring(false);
      else if (act === 'skip') submitScoring(true);
      else if (act === 'clear') clearDead();
      else if (act === 'cancel') exitRequested();
      else if (act === 'done') exitRequested();
    });
    if (!unsub) {
      unsub = store.subscribe((state, message) => onStoreChange(state, message || {}));
    }
    if (typeof window !== 'undefined' && window.matchMedia && !mqHandler) {
      const mql = window.matchMedia('(min-width: 768px)');
      if (typeof mql.addEventListener === 'function') {
        mqHandler = () => {
          if (!destroyed) place();
        };
        mql.addEventListener('change', mqHandler);
      }
    }
    if (typeof document !== 'undefined' && !escHandler) {
      // ESC＝退出结算模式（全断点；**可见**弹层打开时让位给弹层自身——报告弹层单例
      // 常驻 DOM，存在性判定会永久拦截 ESC，见 core/dialog.hasOpenDialogMask）
      escHandler = (e) => {
        if (destroyed || !self.active || e.key !== 'Escape') return;
        if (hasOpenDialogMask()) return;
        e.preventDefault();
        exitRequested();
      };
      document.addEventListener('keydown', escHandler, true);
    }
    if (typeof window !== 'undefined' && !errHandler) {
      // 提交被拒（如并发结算 GAME_FINISHED）→ 解除提交中锁，允许重试/退出
      errHandler = (e) => {
        if (destroyed || !self.active) return;
        const ev = e && e.detail;
        if (!ev || (ev.channel && ev.channel !== 'game')) return;
        if (self.submitting) {
          self.submitting = false;
          render();
        }
      };
      window.addEventListener('tgo:error', errHandler);
    }
  }

  return {
    /** 进入结算模式（视图完成定位与确认后调用）。 */
    activate() {
      if (destroyed) return;
      ensureBuilt();
      self.active = true;
      self.dead = [];
      self.touched = false;
      self.predicted = false;
      self.predState = 'waiting';
      self.prediction = null;
      self.submitting = false;
      self.done = false;
      self.finished = null;
      self.collapsed = false;
      syncDead();
      render();
      place();
    },
    /** 退出结算模式（取消/完成/视图销毁前）。 */
    deactivate() {
      if (destroyed) return;
      self.active = false;
      self.dead = [];
      self.touched = false;
      self.predicted = false;
      self.predState = 'none';
      self.prediction = null;
      self.submitting = false;
      self.done = false;
      self.finished = null;
      syncDead();
      if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      if (hosts.desktop) hosts.desktop.classList.add('u-hide');
      if (hosts.mobile) hosts.mobile.classList.add('u-hide');
      if (drawerEl && drawerEl.parentNode) drawerEl.parentNode.removeChild(drawerEl);
      drawerEl = null;
      drawerBodyEl = null;
      drawerTitleEl = null;
    },
    place,
    isActive: () => self.active,
    isSubmitting: () => self.submitting,
    /** 棋盘棋子点击 → 切换死/活（复盘视图在结算模式下转发）。 */
    toggleDead,
    /** 当前死子集合（复盘视图 syncBoard 读取 → board deadStones）。 */
    deadList: () => normalizePoints(self.dead),
    /** 通知模块退出（抽屉 ✕ 等；视图统一收尾）。 */
    requestExit: exitRequested,
    destroy() {
      destroyed = true;
      if (unsub) {
        unsub();
        unsub = null;
      }
      if (mqHandler && typeof window !== 'undefined' && window.matchMedia) {
        const mql = window.matchMedia('(min-width: 768px)');
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', mqHandler);
        mqHandler = null;
      }
      if (escHandler && typeof document !== 'undefined') {
        document.removeEventListener('keydown', escHandler, true);
        escHandler = null;
      }
      if (errHandler && typeof window !== 'undefined') {
        window.removeEventListener('tgo:error', errHandler);
        errHandler = null;
      }
      if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
      wrapper = null;
      if (drawerEl && drawerEl.parentNode) drawerEl.parentNode.removeChild(drawerEl);
      drawerEl = null;
    },
  };
}
