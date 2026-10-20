/**
 * tGo · 引擎状态分类（**唯一分类点**；ISSUE-069 硬化）
 *
 * 权威定义在**后端** `backend/app/core/fsm.py`（`RUNNING_STATES`/`QUERY_STATES`/
 * `LAUNCHABLE_STATES`），本模块是它的前端镜像，由 `contracts.test.js` 的 `FE-CTR-34`
 * 逐项比对锁定——单侧修改即测试失败。
 *
 * 为什么独立成文件：状态分类需要被 `views/*`、`core/game-model.js` 共用，而
 * `core/state.js` 已依赖 `game-model.js`；若把分类放进 `state.js` 会让
 * `game-model.js → state.js → game-model.js` 形成循环依赖。
 *
 * 动机（BUG-119）：引擎"是否在运行 / 可否拉起 / 可否查询"原先由后端管理器与前端
 * `engineOps` 各自解释状态，同一事实多处解释 → 判定漂移（陈旧进程引用被当成"已在运行"）。
 */

/** 运行态（进程在跑）：拉起/加载/调优中、就绪、分析中——与后端 `RUNNING_STATES` 同值。 */
export const ENGINE_RUNNING_STATES = Object.freeze(['INIT', 'IDLE', 'ANALYZING']);

/** 可接收查询的状态（就绪/分析中；INIT 仍在加载）——与后端 `QUERY_STATES` 同值。 */
export const ENGINE_QUERY_STATES = Object.freeze(['IDLE', 'ANALYZING']);

/** 可按需拉起的空闲态（未启动 / 启动尝试窗口）——与后端 `LAUNCHABLE_STATES` 同值。 */
export const ENGINE_LAUNCHABLE_STATES = Object.freeze(['STOPPED', 'INIT']);

/**
 * 引擎状态 → 分类（全局唯一分类入口）。
 *
 * - `unknown`：尚未收到 engine.status（按"可启动"处理，幂等语义）；
 * - `ready`：IDLE/ANALYZING（可受理查询）；
 * - `starting`：INIT（拉起/加载/调优中）；
 * - `recovering`：DEAD（崩溃，指数退避链自愈中——**恢复所有者独占**，UI 不提供启动/重启入口）；
 * - `fatal`：FATAL（终态，需到管理页手动重启）；
 * - `stopped`：STOPPED（未启动，可按需/自动拉起）。
 * @param {string|null|undefined} state
 * @returns {'unknown'|'ready'|'starting'|'recovering'|'fatal'|'stopped'}
 */
export function engineStateClass(state) {
  const s = String(state || '').toUpperCase() || null;
  if (!s) return 'unknown';
  if (ENGINE_QUERY_STATES.includes(s)) return 'ready';
  if (ENGINE_RUNNING_STATES.includes(s)) return 'starting';
  if (s === 'DEAD') return 'recovering';
  if (s === 'FATAL') return 'fatal';
  return 'stopped';
}
