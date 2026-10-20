/**
 * tGo · 前端应用入口（T5.1 壳 + T5.4 全局设施 + T6.2 首启门禁与壳真实化）
 *
 * 职责：
 *   - 主题·主题色管理（浅/深/跟随系统 × 黛蓝/朱砂，持久化，顶栏按钮轮转）；
 *   - 音量/静音持久化 + 音效（首次交互解锁，Web Audio 合成）；
 *   - 引擎状态胶囊数据驱动（C3，store engine/system 切片 → #engine-pill）；
 *   - **T6.2 壳真实化**：常驻 `/ws/admin` 通道（createWsHub，状态入 store）+
 *     REST 兜底快照（GET /admin/engines|system → dispatch，覆盖“无引擎不推
 *     engine.status”场景）；连接横幅（重连中/已恢复 Toast）；引擎降级横幅
 *     （首次调优/DEAD/FATAL + [重试]/[手动重启]/[去管理页] + 恢复 Toast）；
 *   - **T6.2 首启门禁**：`tgo.onboarded` 未置位 → 以虚拟路由装载 onboarding 视图
 *     （隐藏顶栏导航行），进入分流完成后回写标记并按目标路由跳转；
 *   - hash 路由监听 / 顶栏导航高亮 / 页面标题 / Tooltip 重扫 / 竞态丢弃（T5.1）。
 */
import { normalizeRoute, parseHash, buildHash, navKeyOf } from './core/route.js';
import { mountView } from './core/view-loader.js';
import { store } from './core/state.js';
import { createLocalStore, LS_KEYS } from './core/localstore.js';
import { createRestClient } from './core/rest-client.js';
import { createWsHub } from './core/ws-client.js';
import { createThemeManager } from './core/theme.js';
import { createSettings, decorEnabled } from './core/settings.js';
import { createAudioManager } from './core/audio.js';
import { attachEnginePill } from './core/engine-pill.js';
import { attachEngineBanner } from './core/engine-banner.js';
import { showBanner } from './core/banner.js';
import { createConnBannerController } from './core/conn-banner.js';
import { showToast } from './core/toast.js';
import { confirm, confirmAbortable } from './core/dialog.js';
import { createReportDialog } from './views/report-dialog.js';
import { createImmersive } from './core/immersive.js';
import { onboardingGate } from './views/onboarding-view.js';
import { attachSgfImporter } from './core/sgf-import.js';
import { attachSponsor } from './core/sponsor.js';
import { DEFAULT_GITHUB_REPO, normalizeGithubRepo } from './core/sponsor-config.js';

// 视图挂载点：#main（视图负责设置 className 与内容，见 index.html）
const rootEl = document.getElementById('main');
const titleEl = document.getElementById('page-title');
const themeBtn = document.getElementById('theme-toggle');
const muteBtn = document.getElementById('mute-toggle');
const pillEl = document.getElementById('engine-pill');
// 顶栏主 CTA（T6.7）：复盘视图 [+创建对局] 原地演化为 [导入棋谱]（UI_UX §5.5.1）
const ctaCreate = document.getElementById('cta-create');
const ctaImport = document.getElementById('cta-import');
const ctaSponsor = document.getElementById('cta-sponsor');
const brandLink = document.getElementById('brand-link');

let navSeq = 0;
let currentView = null;
//: 当前已装载视图的路由名（onboarding 为虚拟路由）
let renderedRouteName = null;
//: 最近一次**页面级**路由 hash（不含 create 覆盖层），用于取消创建时原地恢复
let lastViewHash = '#/';
//: 创建对局覆盖层状态（2026/10/21）：{ baseHash } —— 打开期间背景视图保持挂载
let createOverlay = null;
let createWizard = null;
let createWizardLoading = null;
// 管理页赞助控件（长按 3 秒；仅管理路由激活）
let sponsorController = null;

// ---- T6.2 运行时：本地存储 / REST / WS 双通道 / 首启标记 ----
const ls = createLocalStore();
let onboarded = ls.get(LS_KEYS.onboarded, false) === true;
const api = createRestClient({ baseUrl: '/api' });

// ---- T5.4 全局偏好与设施 ----
const settings = createSettings();
// T6.10：主题变更（顶栏按钮/管理页 UI 设置卡）后同步刷新顶栏按钮图标
const theme = createThemeManager({ onChange: () => updateThemeButton() });
const audio = createAudioManager({
  isMuted: () => settings.isMuted(),
  getVolume: () => settings.getVolume(),
});

/**
 * 顶栏图标按钮写入 + 切换平滑动效（主题/静音，2026/09/13 人工反馈）：
 * 图标换新时重启动画类 `is-icon-swap`（CSS keyframes；减弱动效由全局规则关停）。
 * 首次渲染（`btn.dataset.icon` 未置位，含静态占位→真实图标）不做动效，避免加载即闪。
 */
function setTopIcon(btn, iconId) {
  const prev = btn.dataset.icon;
  if (prev === iconId) return;
  btn.dataset.icon = iconId;
  btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg>`;
  if (!prev) return;
  btn.classList.remove('is-icon-swap');
  void btn.offsetWidth; // 强制重排，保证动画可被重新触发
  btn.classList.add('is-icon-swap');
}

function updateThemeButton() {
  const mode = theme.getMode();
  const dark = theme.getResolved() === 'dark';
  // 图标语义＝**当前主题状态**（UI_UX 顶栏三态规格；2026/09/13 人工反馈修正此前的反向映射）：
  // 当前浅色 → 太阳；当前深色 → 月亮；自动（跟随系统）→ 半日/半月专用图标。
  const icon = mode === 'system' ? 'i-theme-auto' : (dark ? 'i-moon' : 'i-sun');
  setTopIcon(themeBtn, icon);
  themeBtn.setAttribute(
    'aria-label',
    `主题（当前${mode === 'system' ? '跟随系统 · ' : ''}${dark ? '深' : '浅'}色）`,
  );
}

function updateMuteButton() {
  const muted = settings.isMuted();
  muteBtn.setAttribute('aria-pressed', String(muted));
  muteBtn.setAttribute('aria-label', muted ? '取消静音' : '静音');
  setTopIcon(muteBtn, muted ? 'i-mute' : 'i-volume');
}

/** 顶栏品牌 Logo → GitHub 仓库主页；repo 跟随 /admin/app（TGO_GITHUB_REPO 可覆盖）。 */
function setBrandRepo(repo) {
  if (!brandLink) return;
  const target = normalizeGithubRepo(repo || DEFAULT_GITHUB_REPO);
  brandLink.href = `https://github.com/${target}`;
  brandLink.setAttribute('aria-label', `打开 ${target} 的 GitHub 仓库主页`);
}

// ============================================================
// T6.2 首启门禁与壳真实化（全局联动）
// ============================================================

/** 门禁期间隐藏顶栏导航行（仅品牌/胶囊/静音/主题，对齐 WEBUI 引导基线）。 */
function setGateUI(active) {
  document.body.classList.toggle('tgo-onboarding', Boolean(active));
}

/** 首启完成：回写标记 → 按分流目标跳转（resume=恢复对弈 / create=创建向导）。 */
function finishOnboarding(dest) {
  onboarded = true;
  ls.set(LS_KEYS.onboarded, true);
  setGateUI(false);
  const target = dest === 'resume' ? buildHash('game') : buildHash('create');
  if (location.hash === target) {
    renderRoute();
  } else {
    location.hash = target;
  }
}

// ---- WS 双通道（T5.3）：常驻 admin；game 通道由后续视图 connectGame ----
// 连接横幅控制器（T6.2/BUG-059）：聚合通道状态 → 横幅/恢复 Toast；
// **主动关闭（视图切换卸载 game 通道）不计为连接中断**（见 core/conn-banner.js）；
// BUG-077：断线持续 ≥ 60s 未恢复 → 横幅升级出 [重新加载] 逃生入口。
const connBanner = createConnBannerController({
  showBanner,
  showToast,
  reload: () => location.reload(),
});

const hub = createWsHub({
  dispatch: (message) => store.dispatch(message),
  clientOpts: {
    onStatus: (ev) => connBanner.handleStatus(ev),
    onError: (ev) => {
      if (ev && ev.code) showToast({ code: ev.code, message: ev.message });
      // 广播给视图（对弈页据此 flashIllegal / 清除忙碌态等；DOM 由视图处理）
      window.dispatchEvent(new CustomEvent('tgo:error', { detail: { ...ev } }));
    },
    onControl: (ev) => {
      // 对弈控制消息（人人悔棋确认 undo.request / undo.declined）→ 视图订阅
      if (ev && ev.type) {
        window.dispatchEvent(new CustomEvent('tgo:game-msg', { detail: { ...ev } }));
      }
    },
  },
});

/**
 * 引擎降级横幅动作（2026/09/20 人工决策，ISSUE-069）：启动/重启入口收敛到管理页。
 *
 * 旧实现在 DEAD/FATAL 直接调用引擎启动接口（POST .../engines/start）：退避重启期间
 * 后端快速失败（`ENGINE_DEAD`），而失败回执（admin.task）只有管理页视图消费 →
 * 横幅先弹「引擎启动已受理」、随后什么都没发生（假受理）。
 */
function handleEngineAction(actionKey) {
  if (actionKey === 'admin') location.hash = '#/admin';
}

/** REST 兜底快照：覆盖无 manager（标准模型缺失）不推 engine.status 等场景。 */
async function primeShell() {
  try {
    const eng = await api.get('/admin/engines');
    if (eng && eng.data && eng.data.state) {
      store.dispatch({ type: 'engine.status', data: eng.data });
    }
  } catch {
    /* 服务未就绪：交由 WS 通道/胶囊状态呈现 */
  }
  try {
    const sys = await api.get('/admin/system');
    if (sys && sys.data && sys.data.host) {
      store.dispatch({ type: 'system.status', data: sys.data });
    }
  } catch {
    /* 非致命：系统详情保持“暂无” */
  }
  try {
    const app = await api.get('/admin/app', null, { timeoutMs: 4_000 });
    if (app && app.data && app.data.app) setBrandRepo(app.data.app.repo);
  } catch {
    /* 非致命：保留 index.html 的默认仓库链接 */
  }
}

/** 视图注入上下文（Phase 6 各视图消费 store/api/hub/ls；onboarding 专用回调在其内）。 */
const immersive = createImmersive();
// T6.9 对局报告弹层（全站单例，挂 #modal-root）：视图经 ctx.openReport 打开；#/report 直达见 renderRoute
const reportDialog = createReportDialog({
  api,
  toast: showToast,
  nav: (hash) => {
    location.hash = hash;
  },
});
const viewCtx = {
  store,
  ls,
  api,
  hub,
  audio,
  immersive,
  toast: showToast,
  confirm,
  confirmAbortable,
  // T6.10 管理页 UI 设置卡：共享壳级主题/偏好管理器（同源 localStorage）
  theme,
  settings,
  // 管理页偏好变更后刷新顶栏主题/静音按钮
  refreshChrome: () => {
    updateThemeButton();
    updateMuteButton();
  },
  nav: (hash) => {
    location.hash = hash;
  },
  openReport: (gameId, opts) => reportDialog.open(gameId, opts),
  onComplete: finishOnboarding,
};

/**
 * 顶栏主 CTA 按路由切换：
 *   - 默认：[+创建对局]
 *   - 复盘视图（review-list/review）：[导入棋谱]
 *   - 管理视图（admin）：[添盏清茶]（长按 3 秒，2026/10/20）
 */
function updateTopCta(routeName) {
  const isReviewView = routeName === 'review-list' || routeName === 'review';
  const isAdminView = routeName === 'admin';
  if (ctaCreate) ctaCreate.classList.toggle('hidden', isReviewView || isAdminView);
  if (ctaImport) ctaImport.classList.toggle('hidden', !isReviewView);
  if (sponsorController) sponsorController.setActive(isAdminView);
}

/* ============================================================
 * 创建对局覆盖层（2026/10/21 人工反馈）
 * ============================================================
 * 旧实现把 #/create 当普通路由：进入时卸载对弈/复盘/列表视图（#main 清空）→
 * 向导只剩下空页背景，取消时再重挂页面 → 顶栏/页面尺寸重算，表现为「背景被
 * 隐藏 + 取消时抖动」。
 *
 * 现行口径：`#/create` 为**覆盖层路由**——保留当前已装载视图与 DOM，向导以
 * `.dialog-mask.create-wizard`（背景模糊遮罩）盖在其上；`lastViewHash` 记录背景
 * 页 hash。取消/浏览器返回只收起遮罩并用 replaceState 恢复 hash，**零视图重建**。
 * 直达 `#/create`（含首启完成跳转）无背景页时，先装载默认对局页作背景。
 */

/** hash 归一（尾斜杠/空 hash → 标准形式），用于「是否同一背景页」判定。 */
function canonicalHash(hash) {
  const route = normalizeRoute(hash);
  return buildHash(route.name, route.params, route.query);
}

/** 懒加载并复用向导单例（跨多次打开，避免重复 import/绑定）。 */
function ensureCreateWizard() {
  if (createWizard) return Promise.resolve(createWizard);
  if (!createWizardLoading) {
    createWizardLoading = import('./views/create-wizard.js')
      .then((mod) => {
        createWizard = mod.createWizard({
          store,
          api,
          ls,
          toast: showToast,
          nav: (hash) => {
            location.hash = hash;
          },
          // 取消仅收起覆盖层并恢复背景 hash（不触发路由重建）
          onCancel: cancelCreateOverlay,
          // 创建成功：交回普通路由（新对局需重新装载对弈页）
          onCreated: () => {
            createOverlay = null;
          },
        });
        return createWizard;
      })
      .catch((err) => {
        createWizardLoading = null;
        throw err;
      });
  }
  return createWizardLoading;
}

/** 收起创建覆盖层：恢复背景 hash，背景页保持原样。 */
function cancelCreateOverlay() {
  const base = createOverlay ? createOverlay.baseHash : lastViewHash;
  createOverlay = null;
  if (createWizard) createWizard.close();
  if (base && canonicalHash(location.hash) !== base) {
    history.replaceState(null, '', base);
  }
}

/** 打开创建覆盖层：确保有背景页 → 记录背景 hash → 打开向导。 */
async function enterCreateOverlay() {
  if (createOverlay) return;
  const mySeq = ++navSeq;
  // 无背景页（直达 #/create / 首启完成）：先挂默认对局页
  if (!currentView || renderedRouteName === 'onboarding') {
    if (currentView && typeof currentView.destroy === 'function') {
      try {
        currentView.destroy();
      } catch (err) {
        console.warn('[app] 旧视图销毁异常：', err);
      }
    }
    currentView = null;
    const baseRoute = normalizeRoute('#/');
    let view;
    try {
      view = await mountViewGuarded(baseRoute, rootEl, viewCtx);
    } catch (err) {
      if (mySeq !== navSeq) return;
      console.error('[app] 创建对局背景页装载失败：', err);
      renderMountError();
      return;
    }
    if (mySeq !== navSeq) {
      if (view && typeof view.destroy === 'function') view.destroy();
      return;
    }
    currentView = view;
    renderedRouteName = baseRoute.name;
    lastViewHash = '#/';
    if (view && typeof view.render === 'function') view.render();
  }

  createOverlay = { baseHash: canonicalHash(lastViewHash) };
  try {
    const wizard = await ensureCreateWizard();
    if (mySeq !== navSeq || !createOverlay) return;
    await wizard.open();
  } catch (err) {
    if (mySeq !== navSeq) return;
    console.error('[app] 创建对局面板装载失败：', err);
    createOverlay = null;
    showToast({ level: 'error', text: '创建对局面板加载失败，请重试', key: 'create-open-fail' });
  }
}

//: 视图模块装载看门狗（毫秒）：超时视为失败——悬挂的 import 不得让页面永久空白。
const VIEW_MOUNT_TIMEOUT_MS = 20_000;

/**
 * 带上限的视图装载（BUG-082）：正常完成返回视图实例；失败/超时抛错。
 * 超时后晚到的视图实例（import 最终成功）**销毁而不渲染**——避免幽灵视图残留
 * 订阅/监听；用户已看到错误面板并可 [重试]。
 */
function mountViewGuarded(route, rootEl, ctx) {
  const pending = mountView(route, rootEl, ctx);
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('视图装载超时')), VIEW_MOUNT_TIMEOUT_MS);
  });
  return Promise.race([pending, timeout])
    .catch((err) => {
      pending
        .then((late) => {
          if (late && typeof late.destroy === 'function') late.destroy();
        })
        .catch(() => {});
      throw err;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/** 视图装载失败面板（#main 兜底）：明确提示 + [重试]/[重新加载] 出口（BUG-082）。 */
function renderMountError() {
  rootEl.className = 'layout';
  rootEl.innerHTML = `
    <div class="center-panel">
      <div class="empty-state">
        <svg class="art" aria-hidden="true"><use href="#i-empty-go"/></svg>
        <div class="t">页面加载失败</div>
        <div class="s">视图资源加载失败或超时，请检查网络后重试。</div>
        <div class="empty-actions">
          <button class="btn btn-primary" type="button" data-act="retry">重试</button>
          <button class="btn btn-secondary" type="button" data-act="reload">重新加载</button>
        </div>
      </div>
    </div>`;
  const retryBtn = rootEl.querySelector('[data-act="retry"]');
  const reloadBtn = rootEl.querySelector('[data-act="reload"]');
  if (retryBtn) retryBtn.addEventListener('click', () => renderRoute());
  if (reloadBtn) reloadBtn.addEventListener('click', () => location.reload());
}

async function renderRoute() {
  // 未知/非法 hash 归一为 #/（地址栏同步，避免 URL 与视图不一致）
  if (parseHash(location.hash).name === 'unknown') {
    history.replaceState(null, '', buildHash('game'));
  }
  const raw = normalizeRoute(location.hash);
  // 首启门禁：未置位 tgo.onboarded → 任何路由均装载 onboarding（虚拟路由）。
  // 例外：管理页不受门禁（BUG-103）——引导页的引擎降级横幅 [去管理页] 与模型帮助
  // [前往管理页] 都指向它（首启期修复引擎/模型的唯一出口）；旧实现把 #/admin 也
  // 强制回引导页，点击后 hash 变化而视图不动（静默失败）。
  const gateOn = onboardingGate(raw.name, onboarded);
  // 离开创建覆盖层：先收遮罩。若目标就是背景页 hash（取消/浏览器返回），
  // 背景视图仍在挂载 → 直接返回，不销毁/重建（消除顶栏与页面抖动）。
  if (!gateOn && createOverlay && raw.name !== 'create') {
    const baseHash = createOverlay.baseHash;
    createOverlay = null;
    if (createWizard) createWizard.close();
    if (canonicalHash(location.hash) === baseHash) return;
  }
  setGateUI(gateOn);
  let route = gateOn
    ? { name: 'onboarding', label: '首启引导', params: {}, query: raw.query }
    : raw;
  // T6.9 报告直达 #/report/:id?p=B|W：以同局复盘为背景（hash 归一为 #/review/:id，
  // replaceState 不触发 hashchange），复盘装载后开弹层；关闭即停留在复盘页。
  let reportDeep = null;
  if (!gateOn && route.name === 'report') {
    const gid = Number(route.params && route.params.id);
    if (Number.isInteger(gid) && gid > 0) {
      const qp = route.query && route.query.p;
      reportDeep = {
        gameId: gid,
        perspective: qp === 'W' ? 'W' : qp === 'B' ? 'B' : undefined,
      };
      history.replaceState(null, '', `#/review/${gid}`);
    } else {
      history.replaceState(null, '', '#/review');
    }
    route = normalizeRoute(location.hash);
  }

  // 创建对局＝覆盖层：不卸载当前视图，不更新页面标题/导航高亮（保持背景页语义）
  if (!gateOn && route.name === 'create') {
    await enterCreateOverlay();
    return;
  }

  const mySeq = ++navSeq;

  // —— 壳 chrome 更新 ——
  const isHome = !gateOn && route.name === 'game';
  document.title = gateOn ? 'tGo 围棋 · 首启引导' : isHome ? 'tGo 围棋' : `tGo · ${route.label}`;
  if (titleEl) titleEl.textContent = route.label;
  updateTopCta(gateOn ? 'onboarding' : route.name);

  const navKey = navKeyOf(route.name);
  document.querySelectorAll('nav.main a[data-route]').forEach((anchor) => {
    anchor.classList.toggle('active', anchor.dataset.route === navKey);
  });

  // —— 卸载旧视图（清理订阅/监听，避免跨路由污染）——
  if (currentView && typeof currentView.destroy === 'function') {
    try {
      currentView.destroy();
    } catch (err) {
      console.warn('[app] 旧视图销毁异常：', err);
    }
  }
  currentView = null;

  // —— 装载新视图（动态 import；过期结果丢弃；ctx 注入 store/api/hub）——
  // 模块加载防护（BUG-082）：移动端（iOS/Safari）网络切换后动态 import 可能失败或
  // 长时间悬挂——旧实现失败后 #main 永久空白、无任何出口（用户只能清浏览器数据）。
  // 现行口径：view-loader 单次自动重试 → 仍失败/超时 → 错误面板（[重试]/[重新加载]）。
  let view;
  try {
    view = await mountViewGuarded(route, rootEl, viewCtx);
  } catch (err) {
    if (mySeq !== navSeq) return;
    console.error('[app] 视图装载失败：', err);
    renderMountError();
    return;
  }
  if (mySeq !== navSeq) {
    if (view && typeof view.destroy === 'function') view.destroy();
    return;
  }
  currentView = view;
  if (view && typeof view.render === 'function') view.render();
  renderedRouteName = route.name;
  if (route.name !== 'onboarding') lastViewHash = canonicalHash(location.hash);

  window.scrollTo({ top: 0 });

  // Tooltip 重扫动态 DOM（product 版暴露 window.tgoTooltip.convert）
  if (window.tgoTooltip && typeof window.tgoTooltip.convert === 'function') {
    window.tgoTooltip.convert();
  }

  // 通知订阅方（状态树/全局层，T5.2+ 消费）
  window.dispatchEvent(new CustomEvent('tgo:route', { detail: { route } }));

  // T6.9 直达弹层：复盘视图已装载，打开对局报告（含 loading 骨架；背景复盘并行加载）
  if (reportDeep && reportDialog && typeof reportDialog.open === 'function') {
    reportDialog.open(reportDeep.gameId, { perspective: reportDeep.perspective });
  }
}

function init() {
  // 主题 / 静音按钮
  updateThemeButton();
  updateMuteButton();
  themeBtn.addEventListener('click', () => {
    theme.cycleMode();
    updateThemeButton();
  });
  muteBtn.addEventListener('click', () => {
    settings.setMuted(!settings.isMuted());
    updateMuteButton();
  });

  // T6.7 顶栏 [导入棋谱]（复盘视图）：multipart 上传 → 成功进入回放 / 失败 Toast 停留重试
  if (ctaImport) {
    attachSgfImporter({
      cta: ctaImport,
      api,
      toast: showToast,
      onImported: (detail) => {
        const gameId =
          detail && (Number(detail.id) || Number(detail.game_id));
        if (!gameId) return;
        location.hash = `#/review/${gameId}`;
      },
    });
  }

  // 管理页顶栏 [添盏清茶]（自愿赞助；长按 3 秒蓄力 → 彩带 + 赞助卡片）
  if (ctaSponsor) {
    sponsorController = attachSponsor({
      cta: ctaSponsor,
      api,
    });
  }

  // 引擎胶囊（C3）：由状态树 engine/system 驱动
  attachEnginePill({
    pillEl,
    getState: () => store.getState(),
    subscribe: (fn) => store.subscribe(fn),
  });

  // 引擎降级横幅（T6.2：首次调优/DEAD/FATAL + 恢复 Toast）
  attachEngineBanner({
    getState: () => store.getState(),
    subscribe: (fn) => store.subscribe(fn),
    showBanner,
    showToast,
    onAction: handleEngineAction,
  });

  // 音效：首次用户交互解锁（浏览器策略）
  audio.arm();

  // T6.10 装饰纹理（页面背景 background.svg）：应用存储偏好到 body
  document.body.classList.toggle('tgo-decor', decorEnabled());

  // T6.2 通信真实化：常驻 /ws/admin 通道 + REST 兜底快照
  hub.connect();
  primeShell();
  // 重连成功（服务重启/断网恢复等）→ 重播 REST 快照：断线期间引擎状态可能已陈旧
  // （如服务重启后引擎实际未运行），视图/胶囊据此还原真实状态（BUG-080）。
  // 首连亦会触发一次（与上方 boot 快照重复但幂等）；game 通道 open 追加一次，无副作用。
  hub.subscribeStatus((ev) => {
    if (ev && ev.type === 'open') primeShell();
  });

  // 降级逃生（BUG-077）：offline/online 仅用于横幅文案（“网络已断开，等待网络
  // 恢复…”）；连接正确性只依赖 socket 事件与看门狗（navigator.onLine 不可靠）
  window.addEventListener('offline', () => connBanner.handleNetwork(false));
  window.addEventListener('online', () => connBanner.handleNetwork(true));
  connBanner.handleNetwork(navigator.onLine !== false);

  window.addEventListener('hashchange', renderRoute);
  renderRoute();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
