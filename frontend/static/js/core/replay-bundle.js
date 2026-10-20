/**
 * tGo · 复盘批量快照（T6.8 性能优化，2026/09/21 人工决策）
 *
 * **目的**：回放页逐手步进此前每次都发 WS ``recommend.request``（服务端 ~5 次 SQL/步），
 * 本模块承接 ``GET /api/games/{id}/replay``（曲线 + 每手推荐/点评）与懒加载的
 * ``GET /api/games/{id}/replay/ownership``（整局领地），让步进/自动播放/滑轨拖拽
 * 变成**纯本地读取**。
 *
 * ```text
 *   1. **实时覆盖**：``views/review-view.js`` 的 LRU（WS ``review.recommend`` / 深算结果）；
 *   2. **批量快照**（本模块）：仅当该键未被 ``invalidate`` 且确有快照条目；
 *   3. **回落 WS**：试下分支、快照外局面（别端续下的新手）、被失效的键。
 * ```
 *
 * 失效语义（关键正确性约束）：
 *   - 快照是**载入时刻的持久化数据**，不随服务端后续变化自动更新；
 *   - 任一「数据已变化」事件（深算结果到达、补分析完成、结算补分析、悔棋/重开/续下）
 *     必须对相关状态键 ``invalidate``（该键此后一律回落 WS，绝不返回陈旧快照）；
 *   - 重新拉取快照（``load()`` 成功后 ``set()``）会清空失效标记。
 *
 * 领地为**懒加载（人工决策）**：用户首次开启 [领地] 时拉取一次；仅下发确有领地数据的
 * 局面，缺失局面回落既有 ``ownership.request``（服务端缺数据时会触发补分析，不得被
 * 快照的空值降级为终态无数据）。为防 19 路整局大数组占用，矩阵按 ``Float32Array`` 存储，
 * **不进入状态树**（仅同步取用）。
 *
 * 纯 JS（无 DOM / 无 WS）；纯函数导出供无头测试。
 */

/* ============================================================
 * 纯函数层
 * ============================================================ */

/**
 * 批量推荐条目 → 按 ``position_key`` 索引（可无头测试）。
 * @param {Array<object>} recommends ``GET /replay`` 的 ``recommends``
 * @returns {Map<string, object>} ``main:{n}`` → 推荐载荷（与 WS 同字段）
 */
export function buildRecommendIndex(recommends) {
  const index = new Map();
  for (const item of Array.isArray(recommends) ? recommends : []) {
    const key = item && item.position_key;
    if (typeof key === 'string' && key) index.set(key, item);
  }
  return index;
}

/**
 * 领地载荷 → ``move_no`` → ``Float32Array``（数值缺失的局面不入表）。
 * @param {{positions?:Array<{move_no:number, ownership?:number[]}>}} payload
 * @returns {Map<number, Float32Array>}
 */
export function buildOwnershipIndex(payload) {
  const index = new Map();
  const positions = payload && Array.isArray(payload.positions) ? payload.positions : [];
  for (const item of positions) {
    const moveNo = Number(item && item.move_no);
    const values = item && item.ownership;
    if (!Number.isInteger(moveNo) || !Array.isArray(values) || !values.length) continue;
    index.set(moveNo, Float32Array.from(values, (v) => Number(v) || 0));
  }
  return index;
}

/**
 * 快照键是否可服务（未被失效 + 快照内存在）。
 * @param {{blocked?:Set<string>, index?:Map<string, object>, key?:string}} opts
 * @returns {boolean}
 */
export function snapshotServes(opts = {}) {
  const key = opts.key;
  if (typeof key !== 'string' || !key) return false;
  if (opts.blocked && opts.blocked.has(key)) return false;
  return Boolean(opts.index && opts.index.has(key));
}

/**
 * 清空 LRU 中「空载荷」主谱条目（``has_data:false``）。
 *
 * 补分析/结算完成后，此前因缺数据而缓存的空条目会遮住新的快照内容（LRU 优先于快照）；
 * 仅清空条目，保留深算/实时结果（非空条目）。
 * @param {{keys:()=>string[], get:(key:string)=>object|undefined, delete:(key:string)=>void}} cache
 * @returns {number} 清除条数
 */
export function purgeEmptyEntries(cache) {
  if (!cache || typeof cache.keys !== 'function') return 0;
  let removed = 0;
  for (const key of cache.keys()) {
    if (typeof key === 'string' && key.startsWith('trial:')) continue;
    const value = cache.get(key);
    if (value && value.has_data === false) {
      cache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/* ============================================================
 * 快照存储（会话内存，控制器持有）
 * ============================================================ */

/**
 * @returns {object} 快照存储
 */
export function createReplayBundle() {
  let recommendIndex = null; // null = 未载入（get/curve 据此区分“无快照”与“无此键”）
  let curve = [];
  let ownershipIndex = null; // null=未加载
  const blocked = new Set();

  return {
    /** 载入 ``GET /replay`` 响应：建立索引并清空失效标记。 */
    set(payload) {
      const data = payload || {};
      recommendIndex = buildRecommendIndex(data.recommends);
      curve = Array.isArray(data.curve) ? data.curve : [];
      blocked.clear();
      return this;
    },
    /** 快照条目（未被失效且存在）；未命中返回 null（调用方回落 WS）。 */
    get(key) {
      if (!recommendIndex) return null;
      if (!snapshotServes({ blocked, index: recommendIndex, key })) return null;
      return recommendIndex.get(key) || null;
    },
    /** 曲线点（黑方视角，与 REST ``/curve`` 同源）；未载入返回 null。 */
    curve() {
      return recommendIndex === null ? null : curve;
    },
    /**
     * 失效某状态键（深算结果到达、补分析、结算、棋谱变更）：该键此后一律回落 WS。
     * 试下键无快照条目，调用无副作用。
     */
    invalidate(key) {
      if (typeof key === 'string' && key) blocked.add(key);
      return this;
    },

    // ---- 领地（懒加载） ----
    /** 领地是否已加载。 */
    hasOwnership() {
      return ownershipIndex !== null;
    },
    /** 载入 ``GET /replay/ownership`` 响应（``Float32Array`` 表，不入状态树）。 */
    setOwnership(payload) {
      ownershipIndex = buildOwnershipIndex(payload);
      return this;
    },
    /**
     * 领地取值：``{covered:true, values}`` 命中快照；``{covered:false}`` 未命中/未加载/
     * 该局面被失效 → 调用方回落 ``ownership.request``。
     */
    ownership(moveNo) {
      if (ownershipIndex === null) return { covered: false, values: null };
      const no = Number(moveNo);
      if (!Number.isInteger(no) || blocked.has(`main:${no}`)) {
        return { covered: false, values: null };
      }
      const values = ownershipIndex.get(no);
      if (!values) return { covered: false, values: null };
      return { covered: true, values };
    },
  };
}
