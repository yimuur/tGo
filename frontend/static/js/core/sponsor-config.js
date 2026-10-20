/**
 * tGo · 赞助（添盏清茶）配置加载与校验（纯数据层）
 *
 * 设计口径（2026/10/20 人工确认）：
 *   - 配置与二维码图片均**不进入发布包**，从 GitHub 仓库 `frontend/sponsor/` 远程加载；
 *   - 默认源：jsDelivr 优先（国内可达性更好），失败回退 GitHub raw；
 *   - 配置 JSON 使用相对图片路径（如 `wechat_qr/8.png`），解析基准＝成功加载配置的
 *     同一源——避免“配置从 jsDelivr 来、图片却走 raw”的混合可用性问题；
 *   - 两档金额（8/18 元）× 两种支付方式（微信/支付宝）各自独立二维码；
 *   - 仅允许 https 绝对地址或无协议相对路径；拒绝 `http:`、`data:`、`javascript:`
 *     与 `..` 越界路径（配置虽由作者维护，仍在边界处做防御性校验）。
 *
 * 本模块无 DOM / 无副作用，可直接用 `node --test` 覆盖。
 */

/** 默认更新源仓库（与 backend/app/version.py DEFAULT_GITHUB_REPO 对齐）。 */
export const DEFAULT_GITHUB_REPO = 'yimuur/tGo';
/** 默认分支（仓库当前默认分支）。 */
export const DEFAULT_GITHUB_BRANCH = 'main';
/** 仓库内资源目录（不在 frontend/static 下，故不会进入发布包）。 */
export const SPONSOR_ASSET_DIR = 'frontend/sponsor';
/** 远程配置文件名。 */
export const SPONSOR_CONFIG_FILE = 'sponsor.json';

/** 两档金额（顺序即 UI 顺序，默认第一档）。 */
export const SPONSOR_AMOUNTS = Object.freeze([
  Object.freeze({ amount: 8, label: '请作者尝杯清茶', shortLabel: '清茶' }),
  Object.freeze({ amount: 18, label: '请作者喝壶浓茶', shortLabel: '浓茶' }),
]);

/** 支付方式（顺序即 UI 顺序，默认微信）。 */
export const SPONSOR_METHODS = Object.freeze([
  Object.freeze({ id: 'wechat', label: '微信' }),
  Object.freeze({ id: 'alipay', label: '支付宝' }),
]);

/** 默认支付方式 / 金额（人工确认：微信 + 8 元档）。 */
export const DEFAULT_SPONSOR_METHOD = 'wechat';
export const DEFAULT_SPONSOR_AMOUNT = 8;

/** 单源请求超时（毫秒）：弱网下不无限悬挂；卡片可先呈现加载/重试态。 */
export const SPONSOR_FETCH_TIMEOUT_MS = 8_000;

/** 赞助配置领域错误（UI 按 code 派生文案，不向用户暴露底层异常）。 */
export class SponsorConfigError extends Error {
  /**
   * @param {'SPONSOR_CONFIG_UNAVAILABLE'|'SPONSOR_CONFIG_INVALID'|'SPONSOR_QR_UNAVAILABLE'} code
   * @param {string} message
   * @param {*} [details]
   */
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SponsorConfigError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 规范化 GitHub 仓库标识（owner/name）。非法值回退默认仓库，避免把任意字符串拼进 URL。
 * @param {*} repo
 * @returns {string}
 */
export function normalizeGithubRepo(repo) {
  const text = String(repo == null ? '' : repo).trim();
  const parts = text.split('/');
  if (parts.length !== 2) return DEFAULT_GITHUB_REPO;
  if (parts.some((part) => !part || part === '.' || part === '..')) return DEFAULT_GITHUB_REPO;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text : DEFAULT_GITHUB_REPO;
}

/**
 * 规范化分支名。只接受常见分支字符，拒绝 `..` / 首尾斜杠。
 * @param {*} branch
 * @returns {string}
 */
export function normalizeGithubBranch(branch) {
  const text = String(branch == null ? '' : branch).trim();
  if (!text || text.length > 128) return DEFAULT_GITHUB_BRANCH;
  if (text.startsWith('/') || text.endsWith('/') || text.includes('..')) return DEFAULT_GITHUB_BRANCH;
  return /^[A-Za-z0-9._/-]+$/.test(text) ? text : DEFAULT_GITHUB_BRANCH;
}

/**
 * 构建配置源（按尝试顺序）。jsDelivr 是 GitHub 仓库的 CDN 镜像，raw 为权威兜底。
 * @param {string} [repo]
 * @param {string} [branch]
 * @returns {Array<{id:string,label:string,baseUrl:string,configUrl:string}>}
 */
export function sponsorConfigSources(repo = DEFAULT_GITHUB_REPO, branch = DEFAULT_GITHUB_BRANCH) {
  const repoPath = normalizeGithubRepo(repo);
  const branchName = normalizeGithubBranch(branch);
  const assetDir = SPONSOR_ASSET_DIR;
  return [
    {
      id: 'jsdelivr',
      label: 'jsDelivr',
      baseUrl: `https://cdn.jsdelivr.net/gh/${repoPath}@${branchName}/${assetDir}/`,
      configUrl: `https://cdn.jsdelivr.net/gh/${repoPath}@${branchName}/${assetDir}/${SPONSOR_CONFIG_FILE}`,
    },
    {
      id: 'raw',
      label: 'GitHub raw',
      baseUrl: `https://raw.githubusercontent.com/${repoPath}/${branchName}/${assetDir}/`,
      configUrl: `https://raw.githubusercontent.com/${repoPath}/${branchName}/${assetDir}/${SPONSOR_CONFIG_FILE}`,
    },
  ];
}

/**
 * 解析图片地址：相对路径按配置源 baseUrl 解析，并追加版本查询参数以穿透 CDN 缓存。
 * @param {*} value
 * @param {string} baseUrl
 * @param {string} cacheKey
 * @param {string} field 出错时用于定位的字段名
 * @returns {string}
 */
export function resolveSponsorAssetUrl(value, baseUrl, cacheKey, field = 'qr') {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置缺少图片地址：${field}`);
  }
  // 拒绝协议相对地址（`//host`）与绝对路径（`/host`）——避免绕过仓库目录。
  if (text.startsWith('//') || text.startsWith('/') || text.startsWith('\\')) {
    throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置图片地址必须为相对路径或 https 地址：${field}`);
  }
  // 相对路径越界检查。
  if (text.split(/[\\/]/).includes('..')) {
    throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置图片地址不得越出资源目录：${field}`);
  }
  // 显式协议：只允许 https。
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
    let absolute;
    try {
      absolute = new URL(text);
    } catch {
      throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置图片地址无效：${field}`);
    }
    if (absolute.protocol !== 'https:') {
      throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置图片地址必须使用 https：${field}`);
    }
    return absolute.href;
  }
  let resolved;
  try {
    resolved = new URL(text, baseUrl);
  } catch {
    throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置图片地址无效：${field}`);
  }
  if (resolved.protocol !== 'https:') {
    throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置图片地址必须使用 https：${field}`);
  }
  if (cacheKey) resolved.searchParams.set('v', cacheKey);
  return resolved.href;
}

/**
 * 校验并归一化远程配置。
 *
 * 期望结构：
 * ```json
 * {
 *   "version": 1,
 *   "wechat": { "qr": { "8": "wechat_qr/8.png", "18": "wechat_qr/18.png" } },
 *   "alipay": { "qr": { "8": "alipay_qr/8.png", "18": "alipay_qr/18.png" } }
 * }
 * ```
 *
 * @param {*} raw
 * @param {string} baseUrl 成功加载配置的源目录（用于解析相对图片路径）
 * @returns {{version:string, methods:Record<string,{id:string,label:string,qr:Record<string,string>}>}}
 */
export function parseSponsorConfig(raw, baseUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', '赞助配置必须为 JSON 对象');
  }
  const version = String(raw.version == null ? '' : raw.version).trim();
  const cacheKey = version || '';
  const methods = {};
  for (const method of SPONSOR_METHODS) {
    const node = raw[method.id];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置缺少支付方式：${method.id}`);
    }
    const qr = node.qr;
    if (!qr || typeof qr !== 'object' || Array.isArray(qr)) {
      throw new SponsorConfigError('SPONSOR_CONFIG_INVALID', `赞助配置缺少二维码映射：${method.id}`);
    }
    const resolved = {};
    for (const tier of SPONSOR_AMOUNTS) {
      const key = String(tier.amount);
      resolved[key] = resolveSponsorAssetUrl(
        qr[key],
        baseUrl,
        cacheKey,
        `${method.id}.qr.${key}`,
      );
    }
    methods[method.id] = { id: method.id, label: method.label, qr: resolved };
  }
  return { version: cacheKey, methods };
}

/**
 * 取指定支付方式/金额的二维码地址。
 * @param {ReturnType<typeof parseSponsorConfig>} config
 * @param {string} method
 * @param {number|string} amount
 * @returns {string|null}
 */
export function selectSponsorQr(config, method, amount) {
  const node = config && config.methods ? config.methods[method] : null;
  if (!node) return null;
  return node.qr[String(amount)] || null;
}

/**
 * 枚举全部二维码地址（用于长按蓄力时预加载）。
 * @param {ReturnType<typeof parseSponsorConfig>} config
 * @returns {string[]}
 */
export function sponsorQrUrls(config) {
  const urls = [];
  for (const method of SPONSOR_METHODS) {
    const node = config && config.methods ? config.methods[method.id] : null;
    if (!node) continue;
    for (const tier of SPONSOR_AMOUNTS) {
      const url = node.qr[String(tier.amount)];
      if (url) urls.push(url);
    }
  }
  return urls;
}

/** 支付方式显示名（固定文案，不读取远程 label，避免远端文本注入）。 */
export function sponsorMethodLabel(methodId) {
  const node = SPONSOR_METHODS.find((item) => item.id === methodId);
  return node ? node.label : '';
}

/** 金额档位显示名。 */
export function sponsorAmountLabel(amount) {
  const node = SPONSOR_AMOUNTS.find((item) => item.amount === Number(amount));
  return node ? node.label : '';
}

/**
 * 拉取 JSON（带超时与外部取消信号）。
 * @param {string} url
 * @param {{fetchImpl:Function, timeoutMs?:number, signal?:AbortSignal}} opts
 * @returns {Promise<*>}
 */
async function fetchSponsorJson(url, { fetchImpl, timeoutMs = SPONSOR_FETCH_TIMEOUT_MS, signal } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new SponsorConfigError('SPONSOR_CONFIG_UNAVAILABLE', '当前环境不支持远程加载');
  }
  if (signal && signal.aborted) {
    throw new SponsorConfigError('SPONSOR_CONFIG_UNAVAILABLE', '远程加载已取消');
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  let onExternalAbort = null;
  if (controller && Number(timeoutMs) > 0) {
    timer = setTimeout(() => controller.abort(), Number(timeoutMs));
  }
  if (controller && signal) {
    onExternalAbort = () => controller.abort();
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      signal: controller ? controller.signal : undefined,
    });
    if (!res || res.ok !== true) {
      const status = res && res.status ? res.status : 0;
      throw new SponsorConfigError('SPONSOR_CONFIG_UNAVAILABLE', `赞助配置请求失败（HTTP ${status}）`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof SponsorConfigError) throw err;
    if (err && err.name === 'AbortError') {
      throw new SponsorConfigError('SPONSOR_CONFIG_UNAVAILABLE', '赞助配置请求超时');
    }
    throw new SponsorConfigError('SPONSOR_CONFIG_UNAVAILABLE', '赞助配置网络请求失败', { cause: err });
  } finally {
    if (timer) clearTimeout(timer);
    if (controller && signal && onExternalAbort) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * 按源顺序加载并校验配置（jsDelivr → raw）。
 *
 * @param {object} [opts]
 * @param {string} [opts.repo]
 * @param {string} [opts.branch]
 * @param {Function} [opts.fetchImpl]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @param {Array<{id:string,label:string,baseUrl:string,configUrl:string}>} [opts.sources]
 * @returns {Promise<{config:ReturnType<typeof parseSponsorConfig>, source:object, baseUrl:string}>}
 */
export async function loadSponsorConfig(opts = {}) {
  const fetchImpl =
    opts.fetchImpl ||
    (typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
  const sources = Array.isArray(opts.sources)
    ? opts.sources
    : sponsorConfigSources(opts.repo, opts.branch);
  const attempts = [];
  for (const source of sources) {
    try {
      const raw = await fetchSponsorJson(source.configUrl, {
        fetchImpl,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
      const config = parseSponsorConfig(raw, source.baseUrl);
      return { config, source, baseUrl: source.baseUrl };
    } catch (err) {
      attempts.push({ source: source.id, error: err });
    }
  }
  const allInvalid =
    attempts.length > 0 &&
    attempts.every((item) => item.error && item.error.code === 'SPONSOR_CONFIG_INVALID');
  throw new SponsorConfigError(
    allInvalid ? 'SPONSOR_CONFIG_INVALID' : 'SPONSOR_CONFIG_UNAVAILABLE',
    allInvalid ? '赞助配置格式有误' : '赞助配置加载失败',
    { attempts },
  );
}
