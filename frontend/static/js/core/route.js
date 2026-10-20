/**
 * tGo · 前端 hash 路由纯函数（T5.1）
 *
 * 路由表依据 UI_UX §3.3（无框架 hash 路由）：
 *   #/                game        对弈（默认，未知路由兜底至此）
 *   #/create          create      创建对局
 *   #/review          review-list 棋谱列表（复盘入口）
 *   #/review/:id      review      回放工作台
 *   #/report/:id?p=B|W report     对局报告弹层直达（query 透传）
 *   #/admin           admin       管理视图
 *
 * 本模块为**纯函数、无 DOM 依赖**，供 node --test 无头测试；导航副作用由
 * app.js 负责（监听 hashchange → normalizeRoute → 装载视图 → 广播 tgo:route）。
 */

/** 路由表：pattern 匹配 path（不含 query）；build 由 params 生成 path。 */
export const ROUTES = [
  { name: 'game', nav: 'game', label: '对弈',
    pattern: /^\/?$/, build: () => '/' },
  { name: 'create', nav: null, label: '创建对局',
    pattern: /^\/create\/?$/, build: () => '/create' },
  { name: 'review-list', nav: 'review', label: '棋谱列表',
    pattern: /^\/review\/?$/, build: () => '/review' },
  { name: 'review', nav: 'review', label: '回放工作台',
    pattern: /^\/review\/(\d+)\/?$/, build: (p) => `/review/${p.id}` },
  { name: 'report', nav: null, label: '对局报告',
    pattern: /^\/report\/(\d+)\/?$/, build: (p) => `/report/${p.id}` },
  { name: 'admin', nav: 'admin', label: '管理',
    pattern: /^\/admin\/?$/, build: () => '/admin' },
];

/** 顶栏主导航（顺序即展示顺序；key 与 ROUTES[].nav / navKeyOf() 输出对齐，
 *  页面锚点 data-route 取同名值）。 */
export const NAV_ITEMS = [
  { key: 'game', href: '#/', text: '对弈' },
  { key: 'review', href: '#/review', text: '复盘' },
  { key: 'admin', href: '#/admin', text: '管理' },
];

/** 解析 hash 字符串 → { name, label, params, query }；无匹配返回 name='unknown'。 */
export function parseHash(hash = '') {
  let h = String(hash);
  if (h.startsWith('#')) h = h.slice(1);

  const qIdx = h.indexOf('?');
  const pathRaw = qIdx === -1 ? h : h.slice(0, qIdx);
  // 归一：空→'/'，去尾斜杠（'/review/' → '/review'），保留内部斜杠
  const path = pathRaw.replace(/\/+$/, '') || '/';
  const qs = qIdx === -1 ? '' : h.slice(qIdx + 1);

  const query = {};
  if (qs) {
    for (const [key, val] of new URLSearchParams(qs)) query[key] = val;
  }

  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    const params = {};
    if (m[1] !== undefined) params.id = m[1];
    return { name: route.name, label: route.label, params, query };
  }
  return { name: 'unknown', label: '未知页面', params: {}, query };
}

/** 未知/空路由归一为默认对弈视图（保留 query 以向后兼容）。 */
export function normalizeRoute(hash = '') {
  const parsed = parseHash(hash);
  if (parsed.name !== 'unknown') return parsed;
  const fallback = ROUTES.find((r) => r.name === 'game');
  return { name: fallback.name, label: fallback.label, params: {}, query: parsed.query };
}

/**
 * 由路由参数构建标准 hash（'#/...'）。
 * @param {string} name   路由名（ROUTES[].name）
 * @param {object} [params] 路径参数（如 { id: 12 }）
 * @param {object} [query]  查询参数（空值忽略）
 */
export function buildHash(name, params = {}, query = {}) {
  const route = ROUTES.find((r) => r.name === name);
  if (!route) return '#/';
  const path = route.build(params || {});

  const qs = new URLSearchParams();
  for (const [key, val] of Object.entries(query || {})) {
    if (val !== undefined && val !== null && val !== '') qs.set(key, String(val));
  }
  const queryStr = qs.toString();
  return `#${path}${queryStr ? `?${queryStr}` : ''}`;
}

/** 顶栏导航高亮键（null=非主导航页，如 create/report）。 */
export function navKeyOf(routeName) {
  const route = ROUTES.find((r) => r.name === routeName);
  return route ? route.nav : null;
}
