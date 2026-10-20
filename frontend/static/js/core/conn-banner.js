/**
 * tGo · 连接状态横幅控制器（壳级，纯逻辑无 DOM）
 *
 * 职责：聚合「曾 open 过的通道 × 当前断开集合」→ 驱动「连接中断，正在重连…」
 * 横幅与「连接已恢复」Toast（`showBanner`/`showToast` 注入，便于无头测试）。
 *
 * 规则（2026/09/13，BUG-059——修复「切到管理页误报连接中断」）：
 *   - `open`：通道恢复；曾断开过的通道 → 收起横幅 + 恢复 Toast；
 *   - `closed {manual:true}`：**主动关闭**（对弈/复盘视图卸载 → `hub.closeGame()`）
 *     ≠ 连接中断——从断开集合移除、不挂横幅；该通道此后**不会重连**，若仍计入
 *     会让横幅永久误挂（切回对弈类视图时还会误弹「连接已恢复」）；
 *   - `closed {terminal:true}`：**终态关闭**（服务端 4404 对局不存在/已删除，
 *     BUG-092）≠ 连接中断——领域事实而非网络异常；同样从断开集合移除、
 *     不挂横幅、不参与升级计时（否则「删掉一个未开局对局」会误导成网络问题）；
 *   - `closed {manual:false}` / `reconnecting`：意外断线 → 计入断开集合；
 *   - 首次连接（从未 open 过）失败不计入（不误报“中断”）。
 *
 * **降级逃生**（2026/09/14，移动端网络可用性）：断线持续 ≥ `escalateMs`（默认 60s）
 * 仍未恢复 → 横幅升级为「连接长时间未恢复，可尝试重新加载页面」+ [重新加载]
 * （`reload` 注入）——覆盖应用层无法自愈的场景（浏览器网络栈僵死、悬挂连接
 * 不回收、须外部触发才恢复等），整页重载是最后手段。计时口径 = 存在未恢复
 * 通道的**连续时长**（含首连失败）；全部恢复/主动关闭清零。
 *
 * `handleNetwork(online)` 由壳接线 `offline`/`online` 事件：**仅影响文案**
 * （「网络已断开，等待网络恢复…」），不参与任何连接判定——`navigator.onLine`
 * 不可靠，正确性只依赖 socket 事件与看门狗。
 */

/** 断线持续多久后升级横幅（提供手动逃生入口）。 */
export const ESCALATE_AFTER_MS = 60_000;

/** 横幅文案（§6.4 / §10 与 UI_UX 同步维护）。 */
export const CONN_TEXT = Object.freeze({
  reconnecting: '连接中断，正在重连…',
  offline: '网络已断开，等待网络恢复…',
  escalated: '连接长时间未恢复，可尝试重新加载页面',
});

/**
 * @param {object} deps
 * @param {(spec:{tone:string, text:string, actions?:object[]}) => () => void} deps.showBanner
 *        显示横幅，返回收起函数（对齐 core/banner.js）
 * @param {Function} deps.showToast  Toast（对齐 core/toast.js）
 * @param {Function} [deps.reload]    逃生动作（默认 `location.reload()`）
 * @param {{setTimeout,clearTimeout}} [deps.timers]
 * @param {number} [deps.escalateMs=60000] 升级阈值（0 = 关闭升级）
 * @returns {{ handleStatus(ev): void, handleNetwork(online:boolean): void }}
 */
export function createConnBannerController({
  showBanner,
  showToast,
  reload = () => {
    if (typeof location !== 'undefined') location.reload();
  },
  timers = globalThis,
  escalateMs = ESCALATE_AFTER_MS,
}) {
  const seenOpen = new Set(); // 曾成功 open 的通道（首连失败不视为“中断”）
  const down = new Set(); // 意外断线/重连中的通道（横幅判定用，含从未 open 的）
  const pending = new Set(); // 当前未恢复的通道（升级计时口径；主动关闭不计入）
  let offline = false;
  let escalated = false;
  let escalateTimer = null;
  let dismissBanner = null;
  let specKey = null; // 当前已挂横幅的内容签名（变化才重挂，避免闪烁）

  /** 当前应展示的横幅规格；null = 无需横幅。 */
  function currentSpec() {
    if (escalated) {
      return {
        tone: 'warn',
        text: CONN_TEXT.escalated,
        actions: [{ label: '重新加载', primary: true, onClick: () => reload() }],
      };
    }
    const anyDown = [...down].some((channel) => seenOpen.has(channel));
    if (!anyDown) return null;
    return { tone: 'warn', text: offline ? CONN_TEXT.offline : CONN_TEXT.reconnecting };
  }

  function refresh() {
    const next = currentSpec();
    if (!next) {
      if (dismissBanner) {
        dismissBanner();
        dismissBanner = null;
      }
      specKey = null;
      return;
    }
    const key = `${escalated}|${next.text}`;
    if (key === specKey) return; // 内容未变：保持现有横幅（不重挂）
    if (dismissBanner) {
      dismissBanner();
      dismissBanner = null;
    }
    dismissBanner = showBanner(next);
    specKey = key;
  }

  /** 升级计时：存在未恢复通道时开始，全部恢复/主动关闭后清零。 */
  function syncEscalation() {
    if (pending.size === 0) {
      if (escalateTimer) {
        timers.clearTimeout(escalateTimer);
        escalateTimer = null;
      }
      escalated = false;
      return;
    }
    if (!escalated && !escalateTimer && escalateMs > 0) {
      escalateTimer = timers.setTimeout(() => {
        escalateTimer = null;
        if (pending.size > 0) {
          escalated = true;
          refresh();
        }
      }, escalateMs);
    }
  }

  /**
   * 处理通道连接生命周期事件（ws-client `onStatus` 载荷，含 `channel`）。
   * @param {{type:string, channel?:string, manual?:boolean}} ev
   */
  function handleStatus(ev) {
    const channel = ev && ev.channel;
    if (!channel) return;
    if (ev.type === 'open') {
      const wasDown = seenOpen.has(channel) && down.has(channel);
      down.delete(channel);
      pending.delete(channel);
      seenOpen.add(channel);
      if (pending.size === 0) escalated = false;
      syncEscalation();
      refresh();
      // 聚合恢复（2026/09/14）：等**全部**曾断开通道都恢复才提示一次「连接已恢复」——
      // 旧实现按通道各弹一次（key=`conn-${channel}`，Toast 合并不生效），服务器重启
      // 等双通道（admin + game）并发恢复时用户会看到 2 次；判定与横幅收起口径一致
      // （`down` 中已无「曾 open 过」的通道）。
      const stillDown = [...down].some((ch) => seenOpen.has(ch));
      if (wasDown && !stillDown) {
        showToast({ level: 'info', text: '连接已恢复', key: 'conn-recovered' });
      }
    } else if (ev.type === 'closed' && (ev.manual || ev.terminal)) {
      // 主动关闭（视图卸载）/ 终态关闭（4404 对局不存在）：不是中断、也不会有重连
      // ——不得计入断开集合（也不参与升级计时）
      down.delete(channel);
      pending.delete(channel);
      syncEscalation();
      refresh();
    } else if (ev.type === 'closed' || ev.type === 'reconnecting') {
      down.add(channel);
      pending.add(channel);
      syncEscalation();
      refresh();
    }
  }

  /**
   * 浏览器离线/在线（壳接线 `offline`/`online`）：仅用于文案。
   * @param {boolean} online
   */
  function handleNetwork(online) {
    const nextOffline = online === false;
    if (nextOffline === offline) return;
    offline = nextOffline;
    refresh();
  }

  return { handleStatus, handleNetwork };
}
