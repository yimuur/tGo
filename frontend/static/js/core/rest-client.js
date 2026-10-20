/**
 * tGo · REST 客户端（T5.3）
 *
 * 统一封装：
 *   - baseUrl 默认同源 `/api`（后端 REST 前缀，API.md §1）；
 *   - 所有非 2xx 抛 `ApiError`（status/code/message/data），错误信封结构
 *     `{code, message}` 对齐 API §2 —— 不泄露 Traceback；
 *   - `202 Accepted`（管理异步任务入队语义）作为成功返回（`accepted: true`）；
 *   - 网络失败 → `ApiError(code='NETWORK_ERROR', status=0)`；
 *   - **默认请求超时 `DEFAULT_TIMEOUT_MS`（AbortController）**：移动端（iOS/Safari）
 *     网络切换后请求可能永久悬挂（“黑洞网络”）——旧实现无超时，视图会永远停在
 *     加载态（如首启引导「检测中…」不可进入、恢复对局永不完成）；超时 →
 *     `ApiError(code='TIMEOUT')`，由调用方呈现重试/错误态；单次调用可经第三参
 *     `{timeoutMs}` 覆盖（`0`=不超时，仅限确实长耗时的调用）；
 *   - 错误码 → 用户文案映射（UI_UX §6.4 表格）导出供 Toast（T5.4）复用。
 *
 * 无头测试：注入 `fetchImpl`（Node 缺省用全局 fetch）。
 */

/** 默认请求超时（毫秒）；0=不超时。见模块头注释（移动端黑洞网络防护）。 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** 统一 API 错误。 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态（0 = 网络层失败）
   * @param {string} code   业务错误码（API §2）
   * @param {string} message 可展示消息
   * @param {*} [data]      响应体（如有）
   */
  constructor(status, code, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }

  get isApiError() {
    return true;
  }
}

/** UI_UX §6.4 错误码 → 用户文案（前端 Toast 层复用）。 */
export const ERROR_TEXT = Object.freeze({
  ILLEGAL_MOVE: '禁入点/打劫，请另选位置',
  UNDO_LIMIT_REACHED: '悔棋次数已达上限',
  UNDO_PENDING: '已有悔棋申请待对方确认',
  ENGINE_BUSY: '引擎忙，请稍后重试',
  ENGINE_DEAD: '引擎不可用，相关功能已暂停',
  ENGINE_FATAL: '引擎发生致命错误，需手动重启',
  HUMAN_MODEL_UNAVAILABLE: '人类模型不可用：请恢复人类模型后重试',
  ANALYSIS_INCOMPLETE: '分析数据不完整',
  SGF_INVALID: '棋谱格式无效',
  SGF_TOO_LARGE: '文件过大',
  REPLAY_CONFLICT: '该对局无法回放（历史数据与当前规则不符）',
  DEEP_ANALYSIS_RUNNING: '已有深度分析进行中',
  GAME_NOT_FOUND: '对局不存在',
  GAME_FINISHED: '对局已结束',
  ILLEGAL_ACTION: '当前状态不允许该操作',
  INVALID_PAYLOAD: '请求参数不合法',
  PLAYER_INVALID_RANK: '段位不合法',
  TIMEOUT: '请求超时（网络无响应），请重试',
  NETWORK_ERROR: '网络连接失败，请稍后重试',
  ASSET_NOT_FOUND: '远端资源不存在',
  UPDATE_UNSUPPORTED: '当前部署方式不支持该操作',
  UPDATE_IN_PROGRESS: '已有更新/下载任务正在执行',
  UPDATE_FAILED: '更新失败',
  UNSUPPORTED_PLATFORM: '当前平台暂无官方预编译包',
  CHECKSUM_MISMATCH: '文件校验失败',
  DOWNLOAD_TOO_LARGE: '文件体积超过上限',
});

/**
 * 错误码 → 用户文案；未知码回退 code 本身。
 * @param {string} code
 * @returns {string}
 */
export function errorText(code) {
  return ERROR_TEXT[code] || String(code);
}

/**
 * 创建 REST 客户端。
 * @param {object} [options]
 * @param {string} [options.baseUrl='/api']
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {{request, get, post, put, delete: (name:'delete')=>... }}
 */
export function createRestClient(options = {}) {
  const baseUrl = String(options.baseUrl || '/api').replace(/\/+$/, '');
  const fetchImpl =
    options.fetchImpl || (typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);

  async function request(method, path, { query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    let url = baseUrl + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        // 数组 → 重复参数键（后端列表 status 多值 OR 语义：?status=a&status=b）
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (v === undefined || v === null || v === '') continue;
          qs.append(key, String(v));
        }
      }
      const q = qs.toString();
      if (q) url += `?${q}`;
    }

    const headers = {};
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    let timer = null;
    let signal;
    if (Number(timeoutMs) > 0 && typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      signal = controller.signal;
      timer = setTimeout(() => controller.abort(), Number(timeoutMs));
    }
    let text = null;
    try {
      res = await fetchImpl(url, { method, headers, body: payload, signal });
      // M-12（2026/09/19 修复）：超时闸必须覆盖**响应体读取**——旧实现在 fetch
      // resolve 后立即 clearTimeout：服务端响应头已回、体慢/挂起时请求永不超时
      // （调用方永久 loading）；读取中断（AbortError）同样归一为 TIMEOUT。
      text = await res.text();
    } catch (cause) {
      if (cause && cause.name === 'AbortError') {
        throw new ApiError(0, 'TIMEOUT', '请求超时（网络无响应），请重试', { cause });
      }
      throw new ApiError(0, 'NETWORK_ERROR', '网络连接失败，请稍后重试', { cause });
    } finally {
      if (timer) clearTimeout(timer);
    }

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null; // 非 JSON（如 HTML 错误页）：走通用错误
      }
    }

    if (!res.ok) {
      const code = data && typeof data.code === 'string' ? data.code : `HTTP_${res.status}`;
      const message =
        data && typeof data.message === 'string' && data.message ? data.message : `请求失败（HTTP ${res.status}）`;
      throw new ApiError(res.status, code, message, data);
    }

    return { status: res.status, accepted: res.status === 202, data };
  }

  return {
    request,
    get: (path, query, opts) => request('GET', path, { query, ...(opts || {}) }),
    post: (path, body, opts) => request('POST', path, { body, ...(opts || {}) }),
    put: (path, body, opts) => request('PUT', path, { body, ...(opts || {}) }),
    delete: (path, query, opts) => request('DELETE', path, { query, ...(opts || {}) }),
  };
}
