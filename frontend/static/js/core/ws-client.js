/**
 * tGo · WebSocket 客户端（T5.3）
 *
 * 对齐 API.md §4：
 *   - 统一信封 `{ type, seq, data }`；客户端每个出站消息自增 seq；
 *   - 心跳：每 `heartbeatMs`（15s）发 `ping`，服务端回 `pong`；**应答看门狗**：
 *     连续 `PONG_MISS_LIMIT` 次心跳无任何入站（半开连接——移动端切换网络/静默
 *     断网后 onclose/onerror 可能永不触发）→ 主动放弃 socket 并重连；
 *   - **心跳链不可静默终止**（BUG-076）：心跳到期若 socket 已非 OPEN（浏览器内部
 *     置僵尸态、事件永不投递）→ 立即按断线处理并重连，绝不 `return` 停摆；
 *   - **wake 快速恢复**（BUG-076；hub 接线 `online`/`visibilitychange`/`pageshow`）：
 *     OPEN 连接立即探活（`WAKE_PROBE_MS` 窗口无任何入站 → 重连）；无 socket/僵尸
 *     socket 立即放弃旧句柄并以新 socket 重试（不等退避）；建连中不打断（交看门狗）；
 *   - 断线：指数退避重连 `RETRY_DELAYS=[1s,2s,4s,8s,15s]`（保持末档）；
 *   - **建连看门狗**：`CONNECT_TIMEOUT_MS` 内未 OPEN（iOS/Safari 在服务器重启/
 *     网络中断后可能令 `new WebSocket()` 永久悬挂于 CONNECTING、不触发任何事件）→
 *     放弃该 socket 并重连（放弃不依赖事件回调，旧 socket 交由浏览器回收）；
 *   - 重连成功（open）后，`role='game'` 通道先发 `restore.request` 与服务端对齐；
 *   - **入站白名单**：状态类消息 → `dispatch`（T5.2 store，回调不改 DOM）；
 *     `error`（带 seq）→ `onError`（供 Toast）；`pong`/未知 → 静默容错（onUnknown 可选）；
 *   - **终态关闭**（BUG-092）：服务端以 `GAME_GONE_CLOSE_CODE`（4404，对局不存在）
 *     关闭 → **不重连**，生命周期事件带 `terminal:true`（横幅不得计入「连接中断」）；
 *   - **双通道**：`gameWsUrl/adminWsUrl` 生成端点；`createWsHub` 组合「常驻 admin +
 *     当前 game」两个连接（切换 gameId 时关闭旧 game 通道）。
 *
 * 无头测试：注入 `createSocket`（fake WebSocket）、`timers`（fake setTimeout/clearTimeout）。
 */

/* ---------- 常量 ---------- */

export const HEARTBEAT_MS = 15_000;
/** 连接保持稳定（超过此窗口）后才重置退避计数，避免“连上即断”循环停在首档。 */
export const STABLE_RESET_MS = 3_000;
/** 建连看门狗：超过该时长仍未 OPEN → 放弃并重连（见模块头注释）。 */
export const CONNECT_TIMEOUT_MS = 10_000;
/** 心跳应答看门狗：连续 N 次心跳无任何入站 → 放弃并重连（约 30–45s 检出半开连接）。 */
export const PONG_MISS_LIMIT = 2;
/** wake 探活窗口：网络/可见性恢复后立即 ping，该窗口内无任何入站 → 判定半开并重连。 */
export const WAKE_PROBE_MS = 3_000;
export const RETRY_DELAYS = Object.freeze([1_000, 2_000, 4_000, 8_000, 15_000]);

/**
 * 对局不存在/已删除的**终态**关闭码（服务端 API §4.2；与后端 `GAME_GONE_CLOSE_CODE` 对齐）。
 *
 * 收到该码不得重连（重连必然再被拒），并以 `terminal:true` 上报生命周期——
 * 连接横幅不得计入「连接中断」（这不是网络问题，而是领域事实）。
 * 注：服务端必须在 `accept()` **之后**发该码；握手前关闭会被 uvicorn 转成
 * HTTP 403，浏览器只得 1006（与断网不可区分）——BUG-092。
 */
export const GAME_GONE_CLOSE_CODE = 4404;

/** 客户端 → 服务端消息类型（API §4.3/§4.4）。start/restart/undo.respond 为 T6.4 新增；
 * recommend.request 与 trial.* 为 T6.8 复盘/试下新增；scoring.prepare 为 2026/09/19
 * 导入棋谱补结算新增（复盘页 [结算] 触发死子预判）。 */
export const CLIENT_MESSAGE_TYPES = Object.freeze([
  'start', 'play', 'pass', 'resign', 'undo', 'undo.respond', 'restart', 'scoring.confirm', 'scoring.cancel',
  'scoring.prepare',
  'coaching.request', 'ownership.request', 'deep_analysis.request', 'recommend.request',
  'global_analysis.request', 'global_analysis.cancel',
  'trial.enter', 'trial.play', 'trial.pass', 'trial.undo', 'trial.back_to_real',
  'restore.request', 'ping',
]);

/** 服务端 → 客户端消息类型（含 error/pong；未知消息应容错忽略）。
 *
 * 维护约定（2026/09/11）：后端新增服务端消息类型时**必须同步登记到本表与
 * ``DISPATCH_SET``**（否则入站消息被静默丢弃 —— 曾导致 ``scoring.prediction``
 * 丢失、结算面板永久停在“AI 正在分析终局局面”），并由契约用例
 * ``tests/ws-contract.test.js``（对照 docs/API.md §4.3/§4.4 推送表）守门。
 */
export const SERVER_MESSAGE_TYPES = Object.freeze([
  'game.state', 'move.applied', 'move.undone', 'game.finished', 'analysis.curve',
  'analysis.comment', 'scoring.prediction',
  'position.ownership', 'coaching.top5', 'review.recommend', 'deep_analysis.result',
  'analysis.progress', 'global_analysis.done', 'trial.state',
  'engine.status', 'system.status',
  'admin.task', 'admin.config', 'undo.request', 'undo.declined', 'error', 'pong',
]);

const DISPATCH_SET = new Set([
  'game.state', 'move.applied', 'move.undone', 'game.finished', 'analysis.curve',
  'analysis.comment', 'scoring.prediction',
  'position.ownership', 'coaching.top5', 'review.recommend', 'deep_analysis.result',
  'analysis.progress', 'global_analysis.done', 'trial.state',
  'engine.status', 'system.status', 'admin.task', 'admin.config',
]);

/** 对弈通道控制类消息（人人对弈悔棋确认；不经状态树，由 onControl 钩子消费）。 */
export const CONTROL_TYPES = Object.freeze(['undo.request', 'undo.declined']);

/** L-11：断线期操作队列容量上限（超限丢最旧；终态关闭后不再入队）。 */
export const OUTBOX_LIMIT = 200;

/* ---------- 纯函数（无头可测） ---------- */

/**
 * 构建出站信封（seq 由调用方持有并递增）。
 * @returns {{type:string, seq:number, data?:object}}
 */
export function buildOutgoing(type, data, seq) {
  const msg = { type, seq: Number(seq) };
  if (data !== undefined && data !== null) msg.data = data;
  return msg;
}

/**
 * 解析入站文本 → 信封；非法 JSON / 缺 type 返回 null（容错）。
 * 仅透传已知字段（type/seq/data/code/message），向后兼容未知载荷。
 */
export function parseIncoming(text) {
  let obj;
  try {
    obj = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!obj || typeof obj.type !== 'string') return null;
  const env = { type: obj.type };
  if (obj.seq !== undefined) env.seq = Number(obj.seq) || 0;
  if (obj.data !== undefined) env.data = obj.data;
  if (obj.code !== undefined) env.code = obj.code;
  if (obj.message !== undefined) env.message = obj.message;
  return env;
}

/** 指数退避：attempt 从 1 起，超档后保持末档延迟。 */
export function nextReconnectDelay(delays, attempt) {
  const safe = Array.isArray(delays) && delays.length ? delays : RETRY_DELAYS;
  const idx = Math.min(Math.max(Number(attempt) || 1, 1) - 1, safe.length - 1);
  return safe[idx];
}

/* ---------- URL 工具 ---------- */

/** 将 http(s) origin 归一为 ws(s) 并拼接 ws 路径。 */
export function toWsUrl(origin, path) {
  const base = String(origin || '');
  if (/^ws:\/\//i.test(base) || /^wss:\/\//i.test(base)) return base.replace(/\/+$/, '') + path;
  if (/^https:\/\//i.test(base)) return `wss://${base.replace(/^https:\/\//i, '').replace(/\/+$/, '')}${path}`;
  if (/^http:\/\//i.test(base)) return `ws://${base.replace(/^http:\/\//i, '').replace(/\/+$/, '')}${path}`;
  // 相对/无 origin（同源）：交由浏览器按 location 解析
  return path;
}

/** 对弈/复盘通道端点：/ws/games/{gameId} */
export function gameWsUrl(origin, gameId) {
  return toWsUrl(origin, `/ws/games/${gameId}`);
}

/** 管理通道端点：/ws/admin */
export function adminWsUrl(origin) {
  return toWsUrl(origin, '/ws/admin');
}

/* ---------- 单通道客户端 ---------- */

function defaultCreateSocket(url) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('当前环境无 WebSocket，请注入 createSocket');
  }
  return new WebSocket(url);
}

/**
 * 创建单通道 WS 客户端。
 * @param {object} opts
 * @param {string} opts.url              ws 端点
 * @param {'game'|'admin'} [opts.role='game'] game 通道 open 后自动 restore.request
 * @param {Function} [opts.dispatch]      状态类消息 → store（T5.2）
 * @param {Function} [opts.onError]       error 信封 {seq,code,message}
 * @param {Function} [opts.onStatus]      连接生命周期 {type, ...}
 * @param {Function} [opts.onControl]     对弈控制消息（undo.request/undo.declined）
 * @param {Function} [opts.onUnknown]     未知消息容错钩子（默认忽略）
 * @param {number} [opts.heartbeatMs=15000]
 * @param {number} [opts.stableMs=3000]  open 稳定窗口（超过后重置退避计数）
 * @param {number} [opts.connectTimeoutMs=10000] 建连看门狗（0=关闭）
 * @param {number} [opts.pongMissLimit=2]        心跳应答看门狗（0=关闭）
 * @param {number} [opts.wakeProbeMs=3000]       wake 探活窗口（0=关闭探活）
 * @param {number[]} [opts.retryDelays]
 * @param {Function} [opts.createSocket]
 * @param {{setTimeout,clearTimeout}} [opts.timers]
 */
export function createWsClient(opts) {
  const {
    url,
    role = 'game',
    dispatch = () => {},
    onError,
    onStatus,
    onControl,
    onUnknown,
    heartbeatMs = HEARTBEAT_MS,
    stableMs = STABLE_RESET_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    pongMissLimit = PONG_MISS_LIMIT,
    wakeProbeMs = WAKE_PROBE_MS,
    retryDelays = RETRY_DELAYS,
    createSocket = defaultCreateSocket,
    timers = globalThis,
  } = opts;

  let ws = null;
  let seq = 0;
  let closedByUser = false;
  let terminalClosed = false; // L-11：终态关闭（4404）——不再重连/不再入队
  let started = false; // connect() 至少调用过一次（wake 不得在未启动时抢先建连）
  let attempt = 0;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let stableTimer = null;
  let openTimer = null;
  let wakeProbeTimer = null; // wake 探活窗口（见 probeAlive）
  let awaitingPong = false; // 已发 ping 尚未收到任何入站回应
  let pongMisses = 0; // 连续无入站的心跳轮数（任一入站即清零）
  const outbox = [];

  function clearTimers() {
    if (heartbeatTimer) {
      timers.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (stableTimer) {
      timers.clearTimeout(stableTimer);
      stableTimer = null;
    }
    if (openTimer) {
      timers.clearTimeout(openTimer);
      openTimer = null;
    }
    if (wakeProbeTimer) {
      timers.clearTimeout(wakeProbeTimer);
      wakeProbeTimer = null;
    }
  }

  function emitStatus(type, extra = {}) {
    if (onStatus) onStatus({ type, ...extra });
  }

  function startHeartbeat(delay = heartbeatMs) {
    if (heartbeatTimer) timers.clearTimeout(heartbeatTimer);
    heartbeatTimer = timers.setTimeout(heartbeatTick, delay);
  }

  /**
   * 心跳到期。
   *
   * **心跳链绝不允许静默终止**（BUG-076）：socket 已丢失/僵尸（浏览器内部置
   * CLOSING/CLOSED 但事件永不投递）时，旧实现直接 `return` —— 心跳链与重连链
   * 双双停摆，页面永不恢复（只碰巧在外部触发补投事件时才复活）。此处一律移交
   * 断线/重连路径，保证「无事件也能自愈」。
   */
  function heartbeatTick() {
    heartbeatTimer = null;
    if (closedByUser) return;
    if (!ws || ws.readyState !== 1) {
      if (ws) {
        abandonSocket('stale-socket');
      } else if (!reconnectTimer) {
        scheduleReconnect();
      }
      return;
    }
    if (awaitingPong) {
      pongMisses += 1;
      if (pongMissLimit > 0 && pongMisses >= pongMissLimit) {
        abandonSocket('pong-timeout');
        return;
      }
    } else {
      pongMisses = 0;
    }
    awaitingPong = true;
    send('ping');
    startHeartbeat();
  }

  /**
   * 主动放弃当前 socket 并重连。
   *
   * **不依赖 socket 事件回调**：半开/悬挂连接（移动端切网、服务器重启后的僵尸
   * 连接）可能永远不触发 onclose/onerror——此路径自行完成计时器清理、状态上报
   * 与重连调度；旧 socket 已解绑事件，交由浏览器异步回收。
   * @param {string} reason 放弃原因（`connect-timeout`/`pong-timeout`/
   *        `stale-socket`/`network-online`/`page-visible`/`page-show` 等，透传 `closed`）
   */
  function abandonSocket(reason) {
    const socket = ws;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      /* 竞态：已关闭/不可关闭，忽略 */
    }
    ws = null;
    awaitingPong = false;
    pongMisses = 0;
    clearTimers();
    emitStatus('closed', { manual: false, reason });
    scheduleReconnect();
  }

  /**
   * 立即探活（wake 用）：不等下一次心跳，立刻 ping 并在 `wakeProbeMs` 短窗口内
   * 要求任何入站（pong/推送）；窗口内仍 `awaitingPong` → 半开连接，放弃并重连。
   */
  function probeAlive() {
    awaitingPong = true;
    send('ping');
    if (wakeProbeMs <= 0) return;
    if (wakeProbeTimer) timers.clearTimeout(wakeProbeTimer);
    wakeProbeTimer = timers.setTimeout(() => {
      wakeProbeTimer = null;
      if (closedByUser) return;
      if (awaitingPong && ws && ws.readyState === 1) abandonSocket('pong-timeout');
    }, wakeProbeMs);
  }

  /**
   * 外部唤醒（网络恢复 `online` / 页面可见性恢复 `visibilitychange` / bfcache
   * `pageshow`；由 hub 接线，也可手动调用）：不等退避计时立即恢复链路。
   *
   * - OPEN：立即探活（冻屏/切网后的半开连接秒级判定，无需再等 30–45s 心跳）；
   * - 无 socket / 僵尸 CLOSING|CLOSED：放弃旧句柄（可能绑定在失效网络路径上）
   *   并以**新 socket** 立即重试；**L-11：退避计数不清零**（事件风暴不得重置
   *   重试节奏，计数仅在连接稳定或手动 `connect()` 时归零）；
   * - 终态关闭（4404 对局不存在）后：不再重连（`FE-WS-26`）。
   * - CONNECTING：不打断（正常建连可能正在进行，交由建连看门狗处置）。
   * @param {string} [reason] 诊断用原因（透传 `closed` 事件）
   */
  function wake(reason = 'wake') {
    if (!started || closedByUser || terminalClosed) return;
    const socket = ws;
    if (socket && socket.readyState === 1) {
      probeAlive();
      return;
    }
    if (socket && socket.readyState === 0) return;
    if (socket) abandonSocket(reason);
    if (reconnectTimer) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (!ws && !closedByUser) {
      // L-11：不清零退避计数——弱网下 visible/online 事件反复触发会把退避反复
      // 重置为立即重试（握手风暴）；计数仅在连接稳定（stableMs）或手动 connect 归零
      openSocket();
    }
  }

  function flushOutbox() {
    while (outbox.length) {
      const text = outbox.shift();
      if (ws && ws.readyState === 1) ws.send(text);
    }
  }

  function openSocket() {
    if (closedByUser) return;
    emitStatus('connecting', { attempt });
    let socket;
    try {
      socket = createSocket(url);
    } catch (err) {
      emitStatus('error', { message: String((err && err.message) || err) });
      scheduleReconnect();
      return;
    }
    ws = socket;
    // 建连看门狗：CONNECTING 悬挂（无任何事件）时不依赖回调也能退出并重连
    if (connectTimeoutMs > 0) {
      openTimer = timers.setTimeout(() => {
        openTimer = null;
        if (ws === socket && socket.readyState === 0) abandonSocket('connect-timeout');
      }, connectTimeoutMs);
    }
    socket.onopen = () => {
      if (ws !== socket) {
        // 已被更新的 socket 取代（晚期 open）：关闭该句柄，不得篡改当前状态
        try {
          socket.close();
        } catch {
          /* 已关闭 */
        }
        return;
      }
      if (openTimer) {
        timers.clearTimeout(openTimer);
        openTimer = null;
      }
      awaitingPong = false;
      pongMisses = 0;
      emitStatus('open');
      startHeartbeat();
      if (role === 'game') send('restore.request'); // 重连成功后全量对齐（UI_UX §10）
      flushOutbox();
      // 连接保持稳定（超过 stableMs）后重置退避计数；期间再次断开则退避继续递增
      if (stableMs > 0 && !stableTimer) {
        stableTimer = timers.setTimeout(() => {
          stableTimer = null;
          attempt = 0;
        }, stableMs);
      }
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return; // H-6：被替换/已关闭的旧 socket 残余帧不得进入状态树
      awaitingPong = false; // 任一入站（pong/推送）证明链路存活
      pongMisses = 0;
      const env = parseIncoming(event && event.data);
      if (!env) return; // 非 JSON 行：容错忽略
      if (env.type === 'pong') return;
      if (DISPATCH_SET.has(env.type)) {
        dispatch({ type: env.type, seq: env.seq, data: env.data === undefined ? {} : env.data });
      } else if (CONTROL_TYPES.includes(env.type)) {
        // 对弈控制消息（如人人悔棋确认 undo.request/undo.declined）：供视图消费
        if (onControl) onControl({ seq: env.seq, type: env.type, data: env.data === undefined ? {} : env.data });
      } else if (env.type === 'error') {
        if (onError) onError({ seq: env.seq, code: env.code, message: env.message });
      } else if (onUnknown) {
        onUnknown(env);
      }
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return; // 已被替换/放弃的旧 socket（晚期事件）不得篡改当前状态
      ws = null;
      awaitingPong = false;
      pongMisses = 0;
      if (heartbeatTimer) {
        timers.clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (stableTimer) {
        timers.clearTimeout(stableTimer);
        stableTimer = null;
      }
      if (openTimer) {
        timers.clearTimeout(openTimer);
        openTimer = null;
      }
      if (wakeProbeTimer) {
        timers.clearTimeout(wakeProbeTimer);
        wakeProbeTimer = null;
      }
      // 终态关闭（4404 对局不存在/已删除）：领域事实而非网络异常 —— 不重连，
      // 并以 `terminal` 标记上报（壳/视图据此停止横幅与重试，BUG-092）
      const code = Number((ev && ev.code) || 0);
      const terminal = code === GAME_GONE_CLOSE_CODE;
      if (terminal) terminalClosed = true; // L-11：终态后 send 不再入队
      emitStatus('closed', { manual: closedByUser, terminal, code });
      if (!closedByUser && !terminal) scheduleReconnect();
    };
    socket.onerror = () => {
      /* 错误随后触发 onclose → 统一走重连 */
    };
  }

  function scheduleReconnect() {
    if (closedByUser) return;
    attempt += 1;
    const delay = nextReconnectDelay(retryDelays, attempt);
    emitStatus('reconnecting', { attempt, delay });
    if (reconnectTimer) timers.clearTimeout(reconnectTimer);
    reconnectTimer = timers.setTimeout(openSocket, delay);
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    closedByUser = false;
    terminalClosed = false; // 手动建连（新通道/用户重试）解除终态标记
    started = true;
    attempt = 0;
    if (reconnectTimer) {
      // 已有退避重连在途：合并为本次立即建连，避免双 socket 并存互相篡改状态
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    openSocket();
  }

  /** 发送信封（未 OPEN 时入队，open/重连后依序 flush）。返回 seq。 */
  function send(type, data) {
    seq += 1;
    const msg = buildOutgoing(type, data, seq);
    const text = JSON.stringify(msg);
    if (ws && ws.readyState === 1) ws.send(text);
    else {
      // L-11：终态关闭（4404）后不再入队（永不投递的静默堆积）；超限丢最旧
      if (terminalClosed) return seq;
      if (outbox.length >= OUTBOX_LIMIT) {
        outbox.shift();
        console.warn('[tgo] 断线操作队列超限，已丢弃最旧消息');
      }
      outbox.push(text);
    }
    return seq;
  }

  /** 主动关闭：不再重连。 */
  function close() {
    closedByUser = true;
    clearTimers();
    if (ws) {
      const socket = ws;
      ws = null; // 先失效：晚期事件/残余帧经代际守卫立即丢弃
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
      // H-6：解绑句柄（残余帧不得再分发；回收闭包引用）
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    emitStatus('closed', { manual: true });
  }

  return {
    connect,
    send,
    close,
    wake,
    get isOpen() {
      return !!(ws && ws.readyState === 1);
    },
    get seq() {
      return seq;
    },
  };
}

/* ---------- 双通道 Hub（常驻 admin + 当前 game） ---------- */

/**
 * 组合「管理通道（常驻，自启动）+ 对弈/复盘通道（按 gameId 切换）」。
 * 状态类消息统一 dispatch；生命周期/错误事件带 `channel` 字段上抛。
 *
 * **网络/可见性恢复接线**（BUG-076）：在 `wakeTarget`（默认 `window`）上监听
 * `online`/`pageshow`，并在其 `document` 上监听 `visibilitychange`（仅转 visible），
 * 事件到达即对全部在役通道 `wake()`（立即探活/立即新 socket 重试，不等退避）；
 * `close()` 统一解绑。无头测试可注入 fake wakeTarget。
 * @param {object} opts
 * @param {string} [opts.origin]  http(s) origin（缺省取 location.origin）
 * @param {Function} opts.dispatch
 * @param {object} [opts.clientOpts] 透传 createWsClient（role 强制按通道）
 * @param {object} [opts.wakeTarget]  网络/可见性事件源（缺省 `window`；null=不接线）
 * @returns {{connect, connectGame(gameId:number), sendGame, sendAdmin, wake,
 *            subscribeStatus(fn): (()=>void), closeGame, close, get gameId}}
 */
export function createWsHub(opts) {
  const {
    origin,
    dispatch = () => {},
    clientOpts = {},
    wakeTarget = typeof window !== 'undefined' ? window : null,
  } = opts;
  const originBase =
    origin || (typeof location !== 'undefined' && location.origin) || '';

  let adminClient = null;
  let gameClient = null;
  let gameId = null;
  let wakeOff = null;
  /** 生命周期事件订阅者（视图层，如引导页连接恢复重试 BUG-080）。 */
  const statusListeners = new Set();

  /**
   * 订阅全部通道的生命周期事件（open/closed/connecting…），事件带 `channel` 字段。
   * @param {(ev: object) => void} fn
   * @returns {() => void} 退订函数（destroy 时调用，防泄漏）
   */
  function subscribeStatus(fn) {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
  }

  /** 外部唤醒：全部在役通道（admin + game）立即恢复链路。 */
  function wake(reason = 'wake') {
    if (adminClient) adminClient.wake(reason);
    if (gameClient) gameClient.wake(reason);
  }

  /** 网络恢复（online）/ bfcache 恢复（pageshow）/ 页面可见（visibilitychange）→ wake。 */
  function attachWake() {
    if (!wakeTarget || wakeOff) return;
    const onNetwork = () => wake('network-online');
    const onPageShow = () => wake('page-show');
    const doc = wakeTarget.document || null;
    const onVisible = () => {
      if (doc && doc.visibilityState !== 'visible') return;
      wake('page-visible');
    };
    wakeTarget.addEventListener('online', onNetwork);
    wakeTarget.addEventListener('pageshow', onPageShow);
    if (doc) doc.addEventListener('visibilitychange', onVisible);
    wakeOff = () => {
      wakeTarget.removeEventListener('online', onNetwork);
      wakeTarget.removeEventListener('pageshow', onPageShow);
      if (doc) doc.removeEventListener('visibilitychange', onVisible);
      wakeOff = null;
    };
  }

  function forward(prefix) {
    return (event) => {
      const ev = { ...event, channel: prefix };
      if (clientOpts.onStatus) clientOpts.onStatus(ev);
      // 复制后遍历：回调中退订/新增不得影响本次分发
      for (const fn of [...statusListeners]) fn(ev);
    };
  }

  function connect() {
    if (!adminClient) {
      adminClient = createWsClient({
        ...clientOpts,
        url: adminWsUrl(originBase),
        role: 'admin',
        dispatch,
        onStatus: forward('admin'),
        onError: (e) => clientOpts.onError && clientOpts.onError({ ...e, channel: 'admin' }),
        onControl: (e) => clientOpts.onControl && clientOpts.onControl({ ...e, channel: 'admin' }),
        onUnknown: (e) => clientOpts.onUnknown && clientOpts.onUnknown({ ...e, channel: 'admin' }),
      });
      adminClient.connect();
    }
    if (gameClient) gameClient.connect();
    return this;
  }

  function connectGame(nextGameId) {
    if (gameId !== nextGameId) {
      closeGame();
      gameId = nextGameId;
    }
    if (!gameClient) {
      gameClient = createWsClient({
        ...clientOpts,
        url: gameWsUrl(originBase, nextGameId),
        role: 'game',
        dispatch,
        onStatus: forward('game'),
        onError: (e) => clientOpts.onError && clientOpts.onError({ ...e, channel: 'game' }),
        onControl: (e) => clientOpts.onControl && clientOpts.onControl({ ...e, channel: 'game' }),
        onUnknown: (e) => clientOpts.onUnknown && clientOpts.onUnknown({ ...e, channel: 'game' }),
      });
    }
    gameClient.connect();
    return this;
  }

  function closeGame() {
    if (gameClient) {
      gameClient.close();
      gameClient = null;
    }
    gameId = null;
  }

  function close() {
    closeGame();
    if (adminClient) {
      adminClient.close();
      adminClient = null;
    }
    if (wakeOff) wakeOff();
  }

  attachWake();

  return {
    connect,
    connectGame,
    closeGame,
    close,
    wake,
    subscribeStatus,
    get gameId() {
      return gameId;
    },
    sendGame: (type, data) => (gameClient ? gameClient.send(type, data) : null),
    sendAdmin: (type, data) => (adminClient ? adminClient.send(type, data) : null),
  };
}
