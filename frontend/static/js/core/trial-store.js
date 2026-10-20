/**
 * tGo · 试下会话缓存与 LRU（T6.8 交付物，TASK.md T6.8）
 *
 * 复盘视图的**客户端会话缓存**：回放主谱/试下分支步进与撤销后重绘当前局面时，
 * 每局面的 AI 推荐/点评/领地等载荷按 ``position_key`` 缓存，避免反复向服务端
 * 拉取（服务端会话分析仅内存、复盘读持久化 —— 本缓存为纯前端展示层加速）。
 *
 * - 键与后端 ``position_key`` 同构：主谱 ``main:{n}`` / 试下 ``trial:{trialId}:{rel}``；
 * - **LRU 上限防无界增长**（默认 256，对齐 T5.6 analysis.worker LruCache 容量语义）；
 * - 试下撤销按相对手数截断（``truncateTrial``）、分支清除（``clearTrial``）、
 *   主谱越限裁剪（``pruneMain``）——与后端 AnalysisCache 语义一致，纯函数可无头测试。
 *
 * 纯 JS（无 DOM / 无 Worker 依赖）。
 */

/* ============================================================
 * 通用 LRU（Map recency：访问/写入即置最新，超限淘汰最久未用）
 * ============================================================ */

export class LruCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.max=256]  容量上限（≥1）
   */
  constructor(opts = {}) {
    this.max = Math.max(1, Number(opts.max) || 256);
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key);
    // recency：访问后置最新
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  has(key) {
    return this._map.has(key);
  }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    if (this._map.size > this.max) {
      const oldest = this._map.keys().next().value;
      if (oldest !== undefined) this._map.delete(oldest);
    }
    return this;
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  /** 遍历全部键（供范围清理）。 */
  keys() {
    return [...this._map.keys()];
  }
}

/* ============================================================
 * position_key 解析工具
 * ============================================================ */

/** 是否为试下分支键（trial: 前缀）。 */
export function isTrialKey(key) {
  return typeof key === 'string' && key.startsWith('trial:');
}

/**
 * 解析试下键 → {trialId, rel}；非法（非 trial/数字非法/段数不符）→ null。
 * @example parseTrialKey('trial:7:3') → {trialId:7, rel:3}
 */
export function parseTrialKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^trial:(\d+):(\d+)$/.exec(key);
  if (!m) return null;
  return { trialId: Number(m[1]), rel: Number(m[2]) };
}

/** 解析主谱键 → moveNo；非主谱键 → null。 */
export function parseMainKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^main:(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** 试下分支键构造：trial:{trialId}:{rel}。 */
export function trialKey(trialId, rel) {
  return `trial:${trialId}:${rel}`;
}

/** 主谱键构造：main:{moveNo}。 */
export function mainKey(moveNo) {
  return `main:${moveNo}`;
}

/* ============================================================
 * 试下会话缓存 Store
 * ============================================================ */

/**
 * 创建试下会话缓存。
 * @param {object} [opts]
 * @param {number} [opts.max=256] LRU 容量上限
 */
export function createTrialStore(opts = {}) {
  const lru = new LruCache({ max: opts.max });
  /** 键空间回调（供测试/调试）。 */
  const list = () => lru.keys();

  return {
    get size() {
      return lru.size;
    },
    get(key) {
      return lru.get(key);
    },
    set(key, value) {
      if (key == null) return lru;
      return lru.set(key, value);
    },
    has(key) {
      return lru.has(key);
    },
    delete(key) {
      return lru.delete(key);
    },
    clear() {
      lru.clear();
    },
    keys: list,
    isTrialKey,
    parseTrialKey,
    parseMainKey,

    /**
     * 试下撤销截断：删除该分支相对手数 > rel 的全部缓存（DATABASE §3.4 试下语义）。
     * @returns {number} 移除条目数
     */
    truncateTrial(trialId, rel) {
      let removed = 0;
      for (const key of lru.keys()) {
        const t = parseTrialKey(key);
        if (t && t.trialId === Number(trialId) && t.rel > Number(rel)) {
          lru.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    /** 清除某试下分支全部缓存（回实战/分支销毁）。 */
    clearTrial(trialId) {
      let removed = 0;
      for (const key of lru.keys()) {
        const t = parseTrialKey(key);
        if (t && t.trialId === Number(trialId)) {
          lru.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    /** 主谱越限裁剪（移动/悔棋后 > limit 的 main:* 移除；试下键不受影响）。 */
    pruneMain(limit) {
      let removed = 0;
      for (const key of lru.keys()) {
        const n = parseMainKey(key);
        if (n !== null && n > Number(limit)) {
          lru.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export default { LruCache, createTrialStore, isTrialKey, parseTrialKey, parseMainKey, trialKey, mainKey };
