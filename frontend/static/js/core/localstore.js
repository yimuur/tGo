/**
 * tGo · 本地存储安全读写（T5.2）
 *
 * 约束（UI_UX §10 / AGENTS §5）：
 *   - JSON 损坏：**静默清理该键并回退默认值**（不回抛、不留脏数据）；
 *   - 写入失败（配额/隐私禁用）：返回 false 且**不破坏既有值**；
 *   - 无 `localStorage` 环境（Node 无头测试 / 隐私模式）回退内存存储，行为一致；
 *   - 键集中管理（新增键先在此登记，避免散落字符串）。
 *
 * 用法：
 *   const ls = createLocalStore();          // 浏览器：真实 localStorage（失败回退内存）
 *   ls.set(LS_KEYS.recent, { gameId: 7 });  // 序列化 JSON
 *   ls.get(LS_KEYS.recent, null);           // 损坏/缺失 → null
 */

/** 已知键清单（全局唯一事实源）。 */
export const LS_KEYS = Object.freeze({
  theme: 'tgo.theme',
  accent: 'tgo.accent',
  volume: 'tgo.volume',
  muted: 'tgo.muted',
  recent: 'tgo.recent', // 最近对局记录 { gameId, ts }（刷新恢复）
  createPrefill: 'tgo.create-prefill', // 创建对局预填
  onboarded: 'tgo.onboarded', // 首启引导完成标记
  //: 复盘来源对局 { gameId, ts }——复盘页加载时登记（任何入口），列表返回时据此跨页定位（一次消费）
  reviewSelect: 'tgo.review-select',
  //: 复盘显示手数 { gameId, moveNo, ts }——每次主谱定位更新（仅最近一条、试下不参与），
  //: 再次进入同一对局 / 刷新时恢复到上次显示手数（与 tgo.recent 同机制）
  reviewPos: 'tgo.review-pos',
  stoneMotion: 'tgo.stone-motion', // 落子动画开关（默认开；管理页可关，T6.10 UI 设置卡）
  showAiMatch: 'tgo.show-ai-match', // 显示当前 AI 匹配档位（默认开；关='AI 自适应'，管理页 T6.10）
  previewSteps: 'tgo.preview-steps', // 变化图预览步数 5–15（默认 10，管理页 T6.10）
  decor: 'tgo.decor', // 页面背景装饰纹理（background.svg 山峦/墨迹，默认关；管理页 T6.10）
});

/** 独立内存存储（测试与降级回退共用）。 */
export function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
  };
}

/** 解析可用 storage：真实 localStorage 探测失败（不存在/禁用/抛错）→ 内存回退。
 *
 * L-11：解析结果**缓存**（探测只做一次）——上层 settings 每个 getter 都会
 * `createLocalStore()`，旧实现每次调用都 setItem/removeItem 探测（同步 I/O 开销），
 * 且内存回退每次新建实例（会话内不可持续）；缓存后回退实例跨调用复用。
 */
let resolvedStorage = null;

function defaultStorage() {
  if (resolvedStorage) return resolvedStorage;
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      const probe = '__tgo_probe__';
      globalThis.localStorage.setItem(probe, '1');
      globalThis.localStorage.removeItem(probe);
      resolvedStorage = globalThis.localStorage;
      return resolvedStorage;
    }
  } catch {
    /* 隐私模式等：走内存回退 */
  }
  resolvedStorage = memoryStorage();
  return resolvedStorage;
}

/**
 * 创建本地存储访问器。
 * @param {Pick<Storage,'getItem'|'setItem'|'removeItem'>} [storage] 显式注入（测试/Node）；
 *        缺省自动选择 localStorage，不可用时回退内存存储。
 * @returns {{storage:object, get(key:string, fallback:unknown):unknown,
 *            set(key:string, value:unknown):boolean, remove(key:string):void}}
 */
export function createLocalStore(storage) {
  const st = storage || defaultStorage();

  function set(key, value) {
    try {
      st.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false; // 配额/禁用：保留旧值
    }
  }

  function get(key, fallback) {
    let raw;
    try {
      raw = st.getItem(key);
    } catch {
      return fallback;
    }
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      remove(key); // 损坏：静默清理，回退默认值
      return fallback;
    }
  }

  function remove(key) {
    try {
      st.removeItem(key);
    } catch {
      /* 忽略：删除失败无副作用可处理 */
    }
  }

  return { storage: st, get, set, remove };
}
