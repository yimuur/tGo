/**
 * tGo · 视图装载器（T5.1）
 *
 * 约定（PROPS §4）：产品视图为 `class XxxView { constructor(rootEl, props) }`，
 * 由 `createView(rootEl, props)` 工厂创建；返回实例至少含 `render()` / `destroy()`。
 * 视图模块位于 `js/views/`，按路由名动态 import（Phase 6 各功能模块视图沿用此契约）。
 *
 * 生命周期：
 *   1. app.js 解析路由 → 调用 mountView(route, rootEl)
 *   2. mountView 卸载旧视图（destroy）→ 动态加载新视图模块 → create → render
 * 本模块不含 DOM 细节之外的业务逻辑。
 */

/** 路由名 → 视图模块文件名映射（无映射回落 game-view）。
 * 注：`report` 路由在 app.js 已归一为 `#/review/:id` + ReportDialog 弹层（2026/09/13），
 * 无独立报告视图模块。 */
export const VIEW_MODULES = {
  game: 'game-view',
  create: 'create-wizard',
  'review-list': 'review-list-view',
  review: 'review-view',
  admin: 'admin-view',
  // T6.2：首启引导（非 hash 路由；app.js 首启门禁以虚拟路由装载）
  onboarding: 'onboarding-view',
};

export function viewModuleName(routeName) {
  return VIEW_MODULES[routeName] || 'game-view';
}

/**
 * 动态 import 失败后的自动重试延迟（毫秒）；第二次仍失败则上抛。
 *
 * 移动端（iOS/Safari）网络切换瞬间首个模块请求可能落到失效连接上——单次重试
 * 即可自愈（模块已缓存/新连接就绪后极快）；仍失败由调用方（app.js）渲染错误
 * 面板与出口（BUG-082：旧实现失败后 #main 永久空白）。
 */
export const VIEW_IMPORT_RETRY_MS = 400;

/**
 * 带一次自动重试的模块装载（纯逻辑，便于无头测试）。
 * @param {() => Promise<*>} importer 实际装载函数（首次 + 重试各调用一次）
 * @param {number} retryMs 重试延迟；≤0 表示不重试
 * @returns {Promise<*>} 装载结果（两次均失败时抛最后一次错误）
 */
export async function importWithRetry(importer, retryMs) {
  try {
    return await importer();
  } catch (err) {
    if (!(Number(retryMs) > 0)) throw err;
    await new Promise((resolve) => setTimeout(resolve, Number(retryMs)));
    return importer();
  }
}

/** 加载视图模块（带一次自动重试）。 */
async function importViewModule(moduleName, retryMs) {
  return importWithRetry(() => import(`../views/${moduleName}.js`), retryMs);
}

/**
 * 装载（或切换）视图。
 * @param {{name:string}} route   当前规范化路由
 * @param {HTMLElement} rootEl    视图挂载容器（视图负责设置 className/innerHTML）
 * @param {object} [ctx]          注入上下文（状态树/通信层等，Phase 5.2+ 提供）
 * @param {object} [opts]
 * @param {number} [opts.retryMs=VIEW_IMPORT_RETRY_MS] 首次失败后的重试延迟（0=不重试）
 * @returns {Promise<object>}     视图实例 { render, destroy }（destroy 可能为 noop）
 */
export async function mountView(route, rootEl, ctx = {}, opts = {}) {
  const moduleName = viewModuleName(route.name);
  const retryMs = opts.retryMs === undefined ? VIEW_IMPORT_RETRY_MS : opts.retryMs;
  const mod = await importViewModule(moduleName, retryMs);
  const create = mod.default || mod.createView;
  if (typeof create !== 'function') {
    throw new TypeError(`视图模块 ${moduleName} 未导出 createView(rootEl, props) 工厂`);
  }
  return create(rootEl, { route, ...ctx });
}
