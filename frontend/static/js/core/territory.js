/**
 * tGo · [领地] 交互口径（纯函数：对弈/复盘共用）
 *
 * 2026/09/12 人工决策（三项反馈：① 对弈「每步自动连续领地」两次领地间闪回棋盘背景且无
 * 平滑动画；② 复盘单击领地展示后操作其它命令不清除；③ 复盘无法双击开启连续模式）：
 *   - 单击 = **瞬态查看**：任何局面类命令（上一手/下一手/滑轨/点曲线/点棋盘/回实战/
 *     自动播放）即清除热力并熄灭按钮（对弈单击落子后同样熄灭）；
 *   - 双击（≤300ms）=「每步自动」连续模式：每次步进自动跟随；**新数据未到达前保留
 *     上一手热力**（不闪回棋盘背景，等待期间无背景空档），到达后由棋盘 240ms 交叉淡变；
 *   - 请求无回执：**看门狗只重新发起、绝不自动退出**（2026/09/12 三次修订：引擎忙时
 *     响应常晚于 12s，旧“超时熄灭”会把正常等待误判为失败 —— 人工反馈“维持十多秒后
 *     自动退出”）；显示只由用户操作/引擎 DEAD·FATAL/对局结束终结；
 *   - 响应为 `ownership: null`（终态无数据）：瞬态显示熄灭，连续模式保留待下一手。
 *
 * 本模块只含纯函数/可注入计时器逻辑（可无头测试）；DOM 事件与画布动效留在视图与 board。
 */

/** 双击判定窗口（与对弈 U-17 一致；单击动作延迟该窗口执行，避免双击时闪一下单击态）。 */
export const TERRITORY_DBLCLICK_MS = 300;

/**
 * 请求无回执看门狗间隔：到期仅**重新发起请求**（不结束显示）。
 *
 * 取值与旧“回执超时”一致（12s）；语义不同：失败/排队中的请求不会导致显示熄灭。
 */
export const TERRITORY_RETRY_MS = 12000;

/**
 * 单击/双击仲裁：首击 → 延迟执行单击动作（等双击窗口）；窗口内二击 → 立即切换连续模式。
 * @param {{armed?:boolean}} opts armed = 单击动作仍在双击窗口内等待
 * @returns {{kind:'single'|'auto', delayMs:number}}
 */
export function territoryClickIntent(opts = {}) {
  if (opts.armed) return { kind: 'auto', delayMs: 0 };
  return { kind: 'single', delayMs: TERRITORY_DBLCLICK_MS };
}

/**
 * 热力显示计划（对弈 `syncTerritoryHeat` / 复盘 `syncBoard` 共用口径）。
 *
 * | active | hasData | positionChanged | auto  | display | request | stop  |
 * | false  | *       | *               | *     | clear   | false   | false |
 * | true   | true    | *               | *     | show    | false   | false |
 * | true   | false   | false           | *     | keep    | false   | false |
 * | true   | false   | true            | true  | keep    | true    | false |
 * | true   | false   | true            | false | clear   | false   | true  |
 *
 * @param {{active?:boolean,auto?:boolean,hasData?:boolean,positionChanged?:boolean}} opts
 * @returns {{display:'show'|'keep'|'clear', request:boolean, stop:boolean}}
 *   display=show 应用数据（棋盘内与当前热力平滑交叉）；keep 保留当前显示（可含拉起请求）；
 *   clear 清除热力（board 240ms 淡出）；stop 结束显示（熄灭按钮/退出连续模式）。
 */
export function territoryHeatPlan(opts = {}) {
  if (!opts.active) return { display: 'clear', request: false, stop: false };
  if (opts.hasData) return { display: 'show', request: false, stop: false };
  if (!opts.positionChanged) return { display: 'keep', request: false, stop: false };
  if (opts.auto) return { display: 'keep', request: true, stop: false };
  return { display: 'clear', request: false, stop: true };
}

/**
 * 领地请求防重口径：**仅同局面**在途请求才跳过；局面已推进必须重发。
 *
 * 旧实现只判 `pending` → 连手（上一手分析未回）时新场面请求被挡下，且旧响应因
 * “非当前局面”被丢弃、pending 永不解除 → 热力滞留上一手旧值直到 12s 超时被熄灭
 * （人工反馈「连续模式下每步领地数据不刷新」，2026/09/12 二次修订）。
 * @param {{pending?:boolean, pendingAt?:*, at?:*}} opts pendingAt=在途请求的局面（手数/键）
 * @returns {'skip'|'send'}
 */
export function territoryRequestAction(opts = {}) {
  if (!opts.pending || opts.pendingAt == null) return 'send';
  return opts.pendingAt === opts.at ? 'skip' : 'send';
}

/**
 * 看门狗口径：请求超时后**只允许重试、不允许结束显示**（对弈 `terrTimeout` / 复盘
 * `terrTimeout` 共用）。
 *
 * 根因：旧实现把“12s 无回执”当作失败并自动退出——引擎忙于 AI 走子/P1 排队时响应
 * 本就可能晚于 12s（甚至因任务被丢弃而永不回投，服务端 `_trigger_ownership_analysis`
 * 未挂 on_drop）→ 正常等待被误判，显示莫名熄灭（人工反馈 2026/09/12）。
 * @param {{destroyed?:boolean, pending?:boolean, active?:boolean}} opts
 * @returns {'retry'|'idle'} retry=重新发起请求并继续等待；idle=无事可做（看门狗无“退出”出口）
 */
export function territoryWatchdogAction(opts = {}) {
  if (opts.destroyed) return 'idle';
  if (!opts.pending || !opts.active) return 'idle';
  return 'retry';
}

/**
 * [领地] 按钮视图口径（对弈 `updateTerrButton` / 复盘 `updateTerritoryButton` /
 * 复盘按钮模板 `renderActions` 共用，单一事实源）。
 *
 * 2026/09/17 人工决策（回退口径，最终以本条为准）：
 *   - 单击瞬态（开启）＝ **整按钮高亮** `is-on`（accent 文字 + accent 描边，**非填充**）；
 *   - 连续模式（双击）＝ 同上 ＋ 按钮**左上角小圆点**（绝对定位，**不改变按钮尺寸**）；
 *   - 图标**恒为空心** `i-territory`（单击/双击都不换图标）；**不呼吸、不填充、不用金色点亮**；
 *   - `title`：连续模式（单击取消）/ 普通（显示/隐藏 + 双击开启）。
 *
 * 复盘 `renderActions` 全量重建按钮 DOM 时必须从本函数/`territoryButtonClasses` 派生
 * （BUG-045：写死开启态/圆点隐藏态 → 下一手等重建操作会抹掉“开启/连续”指示）。
 * @param {{active?:boolean, auto?:boolean}} opts
 * @returns {{lit:boolean, dot:boolean, title:string}} lit=开启（整按钮高亮）；dot=连续模式（左上角小圆点）
 */
export function territoryButtonView(opts = {}) {
  const auto = Boolean(opts.auto);
  const active = Boolean(opts.active) || auto;
  return {
    lit: active,
    dot: auto,
    title: auto
      ? '领地：连续模式（单击取消）'
      : '显示/隐藏热力；双击开启“每步自动”连续模式',
  };
}

/**
 * [领地] 按钮状态类名映射（视图 toggle / 重建拼装的**唯一来源**）。
 * @param {{active?:boolean, auto?:boolean}} opts
 * @returns {Object<string, boolean>} class → 是否启用（仅 `is-on` 整按钮高亮；圆点为子元素，非按钮类名）
 */
export function territoryButtonClasses(opts = {}) {
  const { lit } = territoryButtonView(opts);
  return { 'is-on': lit };
}

/**
 * [领地] 按钮状态类名串（供 `renderActions` 全量重建时拼装；与 `territoryButtonClasses` 同源）。
 * @param {{active?:boolean, auto?:boolean}} opts
 * @returns {string} 如 `'is-on'`；无状态时为空串
 */
export function territoryButtonClassString(opts = {}) {
  return Object.entries(territoryButtonClasses(opts))
    .filter(([, on]) => on)
    .map(([cls]) => cls)
    .join(' ');
}

/**
 * 领地察看可用性（BUG-091）。
 *
 * 领地数据来源两分：主谱读**持久化** `position_analyses.ownership`（服务端直接回投，
 * 引擎无关，UI_UX §6.2）→ 引擎不可用照常请求；试下为**会话现算**（须引擎）→
 * 引擎不可用时得到“立即空载回投”的终态，连续模式还会逐手重入 → 拒发无效请求：
 * **结束显示**并提示一次（keyed，不逐手弹报）。已有本地数据（两种情况）时一律照常。
 * @param {{engineDown?:boolean, hasLocalData?:boolean, trialPosition?:boolean}} opts
 * @returns {'ok'|'engine-blocked'}
 */
export function territoryEnginePlan(opts = {}) {
  if (!opts.engineDown) return 'ok';
  if (opts.hasLocalData) return 'ok';
  return opts.trialPosition ? 'engine-blocked' : 'ok';
}

/**
 * 领地请求超时闸：`arm` 领取请求（重置计时）→ 超时回调一次；`cancel` 回执/关闭/销毁撤销。
 * 计时器可注入（无头测试传假计时器；产品用 setTimeout/clearTimeout）。
 * @param {{ms?:number, onTimeout?:()=>void, setTimer?:Function, clearTimer?:Function}} opts
 * @returns {{armed:boolean, arm:()=>void, cancel:()=>void}}
 */
export function createTerritoryTimeout(opts = {}) {
  const ms = Number(opts.ms) > 0 ? Number(opts.ms) : TERRITORY_RETRY_MS;
  const setTimer = typeof opts.setTimer === 'function'
    ? opts.setTimer
    : ((fn, delay) => setTimeout(fn, delay));
  const clearTimer = typeof opts.clearTimer === 'function'
    ? opts.clearTimer
    : ((id) => clearTimeout(id));
  const onTimeout = typeof opts.onTimeout === 'function' ? opts.onTimeout : (() => {});
  let id = null;
  return {
    get armed() {
      return id !== null;
    },
    /** 领取请求：重置计时（同一请求重复 arm 不叠加）。 */
    arm() {
      if (id !== null) clearTimer(id);
      id = setTimer(() => {
        id = null;
        onTimeout();
      }, ms);
    },
    /** 回执/关闭：撤销计时。 */
    cancel() {
      if (id === null) return;
      clearTimer(id);
      id = null;
    },
  };
}
