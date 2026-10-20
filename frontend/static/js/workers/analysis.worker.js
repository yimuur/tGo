/**
 * tGo · 分析解析 Web Worker（T5.6）
 *
 * 依据 UI_UX §7 / TASK T5.6：主线程只收**结构化结果**，以下重活移交 Worker：
 *   1. Ownership 矩阵解析与热力量化（[-1,1] → {alphas,signs}，与 GameBoard 同语义）；
 *   2. PV / 变化图树过滤（GTP 串 ↔ 带色坐标序列，越界/超步截断）；
 *   3. 试下分支缓存 LRU（上限 256 局面，UI_UX §7「如 256 局面，LRU 淘汰」）。
 *
 * 本文件**纯逻辑与 Worker 壳分离**：顶部为纯函数/类（可被 node --test 直接 import，
 * 无 DOM、无 Worker 依赖）；仅当运行于 WorkerGlobalScope 时自注册 onmessage。
 * 生产以 `new Worker('js/workers/analysis.worker.js', { type: 'module' })` 加载。
 */

import { quantizeOwnership, xyOfGtp, isPassLoc } from '../core/board.js';

/* ============================================================
 * LRU 缓存（试下分支会话缓存上限 256；Map 顺序即 recency）
 * ============================================================ */

export class LruCache {
  /**
   * @param {{max?:number}} [opts]
   */
  constructor(opts = {}) {
    this.max = Number.isFinite(Number(opts.max)) && opts.max > 0 ? Math.floor(opts.max) : 256;
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  has(key) {
    return this._map.has(key);
  }

  /** 读取并刷新 recency（最近使用置尾）。 */
  get(key) {
    if (!this._map.has(key)) return undefined;
    const v = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }

  /** 写入；超出上限淘汰最久未用（Map 首键）。返回被淘汰键（无则 null）。 */
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    let evicted = null;
    if (this._map.size > this.max) {
      evicted = this._map.keys().next().value;
      this._map.delete(evicted);
    }
    return evicted;
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  /** 遍历（从头到尾=最旧→最新）。 */
  *keys() {
    yield* this._map.keys();
  }
}

/* ============================================================
 * Ownership 解析
 * ============================================================ */

/**
 * Ownership 消息解析：原始 [-1,1] 数组 → 量化热力（与 board.quantizeOwnership 同语义）。
 * 返回可直接 postMessage 的结构化结果（alphas/signs 为 typed array，结构化克隆可传）。
 */
export function parseOwnership(values, n) {
  const q = quantizeOwnership(values, n);
  return { alphas: q.alphas, signs: q.signs, n: q.n };
}

/* ============================================================
 * PV / 变化图过滤
 * ============================================================ */

function normColor(c) {
  if (c === 'W' || c === 'white') return 'white';
  if (c === 'B' || c === 'black') return 'black';
  return null;
}

/**
 * PV → 棋盘序列。输入两种皆可：
 *   - GTP 串数组（coaching.top5[].pv 原始载荷）：颜色自 firstColor 起交替；
 *   - 带色对象数组（review.recommend variations[].pv：{color,x,y,is_pass}）。
 * 越界/非法坐标即中止（与后端 gtp_to_xy 出错 break 同语义）；超 maxSteps 截断。
 * 返回 { points, passCount, truncated, total, invalid }。
 */
export function pvToStones(pv, opts = {}) {
  const n = Number(opts.n) || 19;
  const maxSteps = Number.isFinite(Number(opts.maxSteps)) && opts.maxSteps > 0 ? Math.floor(opts.maxSteps) : 10;
  let first = normColor(opts.firstColor) || 'black';
  const arr = Array.isArray(pv) ? pv : [];
  const points = [];
  let passCount = 0;
  let truncated = false;
  let invalid = 0;
  for (let i = 0; i < arr.length; i += 1) {
    if (points.length + passCount >= maxSteps) {
      truncated = true;
      break;
    }
    const raw = arr[i];
    let color;
    let x = null;
    let y = null;
    let isPass = false;
    if (typeof raw === 'string') {
      color = first;
      if (isPassLoc(raw)) {
        isPass = true;
      } else {
        const xy = xyOfGtp(raw, n);
        if (!xy) {
          invalid += 1;
          break; // 非法串中止（防脏数据继续）
        }
        x = xy.x;
        y = xy.y;
      }
      first = first === 'black' ? 'white' : 'black';
    } else if (raw && typeof raw === 'object') {
      color = normColor(raw.color);
      if (!color) {
        invalid += 1;
        break;
      }
      isPass = Boolean(raw.is_pass);
      if (!isPass) {
        x = Number(raw.x);
        y = Number(raw.y);
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= n || y < 0 || y >= n) {
          invalid += 1;
          break;
        }
      }
    } else {
      invalid += 1;
      break;
    }
    if (isPass) passCount += 1;
    else points.push({ x, y, color });
  }
  return {
    points,
    passCount,
    truncated,
    total: arr.length,
    invalid,
  };
}

/**
 * 变化图树过滤：top5 各候选的 pv → 规格化列表。variations 元素可为
 * { pv } / { points } 或带色 pv 数组；返回元素含 points/passCount/truncated/invalid。
 */
export function filterVariations(variations, opts = {}) {
  const maxVariations = Number.isFinite(Number(opts.maxVariations)) && opts.maxVariations > 0 ? Math.floor(opts.maxVariations) : 5;
  const arr = Array.isArray(variations) ? variations.slice(0, maxVariations) : [];
  return arr.map((v) => {
    const pv = v && Array.isArray(v.pv) ? v.pv : v && Array.isArray(v.points) ? v.points : v && Array.isArray(v) ? v : [];
    const parsed = pvToStones(pv, opts);
    return { ...parsed };
  });
}

/* ============================================================
 * 消息处理（Worker 壳）
 * ============================================================ */

/**
 * 统一消息处理：返回 { ok, result } 或 { ok:false, error:{code,message} }。
 * 供 Worker onmessage 与（无头）单测共用；不直接触碰 postMessage。
 */
export function handleMessage(msg = {}) {
  const { type, data } = msg || {};
  try {
    switch (type) {
      case 'ownership': {
        const r = parseOwnership(data && data.values, data && data.n);
        return { ok: true, result: r };
      }
      case 'pv': {
        const r = pvToStones(data && data.pv, data || {});
        return { ok: true, result: r };
      }
      case 'variations': {
        const r = filterVariations(data && data.variations, data || {});
        return { ok: true, result: r };
      }
      case 'lru_get': {
        const r = workerLru.get(data && data.key);
        return { ok: true, result: r === undefined ? null : r };
      }
      case 'lru_set': {
        const evicted = workerLru.set(data && data.key, data && data.value);
        return { ok: true, result: { size: workerLru.size, evicted: evicted == null ? null : evicted } };
      }
      case 'lru_clear': {
        workerLru.clear();
        return { ok: true, result: { size: 0 } };
      }
      case 'ping':
        return { ok: true, result: 'pong' };
      default:
        return { ok: false, error: { code: 'UNKNOWN_JOB', message: `未知 Worker 任务: ${String(type)}` } };
    }
  } catch (err) {
    return {
      ok: false,
      error: { code: 'WORKER_ERROR', message: err && err.message ? String(err.message) : String(err) },
    };
  }
}

/** 实例级 LRU（试下分支会话缓存，上限 256，可经消息操作）。 */
export const workerLru = new LruCache({ max: 256 });

/** 在 Worker 作用域自注册 onmessage（ESM worker）。 */
export function registerWorker(scope) {
  const sc = scope || (typeof self !== 'undefined' ? self : null);
  if (!sc) return;
  sc.onmessage = (evt) => {
    const msg = (evt && evt.data) || {};
    const out = handleMessage(msg);
    if (msg.id != null) {
      sc.postMessage({ id: msg.id, ...out });
    }
  };
}

const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope;

if (isWorkerScope) {
  registerWorker(self);
}

export default { LruCache, parseOwnership, pvToStones, filterVariations, handleMessage, workerLru, registerWorker };
