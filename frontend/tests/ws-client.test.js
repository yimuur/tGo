/**
 * tGo · ws-client.js 无头单测（T5.3，node --test）
 * 用例 ID: FE-WS-*
 * 覆盖：信封构建/解析、心跳（FakeTimers）、指数退避重连、重连后 restore.request、
 * 状态类分发/error 回调/未知容错、手动关闭停止重连、双通道 Hub 切换、URL 生成、
 * 建连/心跳应答看门狗（悬挂 CONNECTING 与半开连接的自愈，2026/09/13）、
 * 移动端断网恢复（僵尸 socket 心跳链自愈 + wake 快速恢复，2026/09/14）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEARTBEAT_MS,
  CONNECT_TIMEOUT_MS,
  WAKE_PROBE_MS,
  PONG_MISS_LIMIT,
  RETRY_DELAYS,
  OUTBOX_LIMIT,
  GAME_GONE_CLOSE_CODE,
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  buildOutgoing,
  parseIncoming,
  nextReconnectDelay,
  toWsUrl,
  gameWsUrl,
  adminWsUrl,
  createWsClient,
  createWsHub,
} from '../static/js/core/ws-client.js';

/* ---------- Fake 计时器（确定性，无硬等待） ---------- */

class FakeTimers {
  constructor() {
    this.nowMs = 0;
    this.tasks = [];
    this.nextId = 1;
  }

  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.nowMs + ms, fn });
    return id;
  }

  clearTimeout(id) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i >= 0) this.tasks.splice(i, 1);
  }

  /** 推进时间并执行到期任务（时间单调、无真实等待）。 */
  tick(ms) {
    const target = this.nowMs + ms;
    for (;;) {
      const next = this.tasks
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      const i = this.tasks.indexOf(next);
      this.tasks.splice(i, 1);
      this.nowMs = next.at;
      next.fn();
    }
    this.nowMs = target;
  }
}

/* ---------- Fake WebSocket ---------- */

function makeSocketEnv() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.sent = [];
      instances.push(this);
    }

    send(text) {
      this.sent.push(text);
    }

    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }

    _open() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }

    _msg(payload) {
      if (this.onmessage) {
        this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
      }
    }

    _close(code = 1006) {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code });
    }
  }
  return {
    all: instances,
    factory: (url) => new FakeWebSocket(url),
    last: () => instances[instances.length - 1],
    count: () => instances.length,
  };
}

function lastSent(socket) {
  return socket.sent.length ? JSON.parse(socket.sent[socket.sent.length - 1]) : null;
}

/* ---------- 用例 ---------- */

test('FE-WS-01 消息类型白名单完整', () => {
  assert.ok(CLIENT_MESSAGE_TYPES.includes('restore.request'));
  assert.ok(CLIENT_MESSAGE_TYPES.includes('ping'));
  assert.ok(CLIENT_MESSAGE_TYPES.includes('scoring.cancel'));
  assert.ok(SERVER_MESSAGE_TYPES.includes('game.state'));
  assert.ok(SERVER_MESSAGE_TYPES.includes('engine.status'));
  assert.ok(SERVER_MESSAGE_TYPES.includes('error'));
  assert.ok(RETRY_DELAYS.length === 5 && RETRY_DELAYS[4] === 15_000);
});

test('FE-WS-02 buildOutgoing 信封形状', () => {
  assert.deepEqual(buildOutgoing('play', { x: 3, y: 3 }, 1), { type: 'play', seq: 1, data: { x: 3, y: 3 } });
  // 无 data 时不携带该键（ping 等）
  assert.deepEqual(buildOutgoing('ping', undefined, 2), { type: 'ping', seq: 2 });
});

test('FE-WS-03 parseIncoming 解析与容错', () => {
  const env = parseIncoming('{"type":"move.applied","seq":9,"data":{"move_no":1}}');
  assert.equal(env.type, 'move.applied');
  assert.equal(env.seq, 9);
  assert.deepEqual(env.data, { move_no: 1 });

  // error 信封透传 code/message
  const err = parseIncoming('{"type":"error","seq":3,"code":"ILLEGAL_MOVE","message":"禁入点"}');
  assert.equal(err.code, 'ILLEGAL_MOVE');
  assert.equal(err.message, '禁入点');

  // 非法 JSON / 缺 type → null（容错不抛）
  assert.equal(parseIncoming('not-json'), null);
  assert.equal(parseIncoming('{"seq":1}'), null);
});

test('FE-WS-04 nextReconnectDelay 指数退避', () => {
  assert.equal(nextReconnectDelay(RETRY_DELAYS, 1), 1_000);
  assert.equal(nextReconnectDelay(RETRY_DELAYS, 2), 2_000);
  assert.equal(nextReconnectDelay(RETRY_DELAYS, 3), 4_000);
  assert.equal(nextReconnectDelay(RETRY_DELAYS, 4), 8_000);
  assert.equal(nextReconnectDelay(RETRY_DELAYS, 5), 15_000);
  assert.equal(nextReconnectDelay(RETRY_DELAYS, 99), 15_000); // 超档保持末档
  assert.equal(nextReconnectDelay([], 1), 1_000); // 空数组回退默认
});

test('FE-WS-05 心跳：连接后每 15s 发 ping（FakeTimers）', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
  });
  client.connect();
  const sock = env.last();
  sock._open();
  const sentBefore = sock.sent.length;

  timers.tick(HEARTBEAT_MS);
  const ping = lastSent(sock);
  assert.equal(ping.type, 'ping');
  assert.ok(sock.sent.length > sentBefore);

  timers.tick(HEARTBEAT_MS); // 再次调度
  assert.equal(lastSent(sock).type, 'ping');
  client.close();
});

test('FE-WS-06 断线退避重连：delay 序列与 connecting 状态', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const statuses = [];
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    onStatus: (e) => statuses.push(e),
  });
  client.connect();
  env.last()._open();
  env.last()._close(1006); // 意外断线

  // 第 1 次重连在 1s 后
  timers.tick(1_000);
  assert.equal(env.count(), 2);
  const s2 = env.last();
  s2._open();
  s2._close(1006);
  timers.tick(2_000); // 第 2 次：2s
  assert.equal(env.count(), 3);
  const s3 = env.last();
  s3._open();
  s3._close(1006);
  timers.tick(4_000); // 第 3 次：4s
  assert.equal(env.count(), 4);

  const reconnecting = statuses.filter((s) => s.type === 'reconnecting');
  assert.deepEqual(reconnecting.map((r) => r.delay), [1_000, 2_000, 4_000]);
  client.close();
});

test('FE-WS-07 重连成功后（game 通道）自动发 restore.request 对齐', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/7', role: 'game',
    createSocket: env.factory, timers,
  });
  client.connect();
  env.last()._open();
  env.last()._close(1006);
  timers.tick(1_000); // 重连
  const sock2 = env.last();
  sock2._open();
  const first = sock2.sent.length ? JSON.parse(sock2.sent[0]) : null;
  assert.equal(first.type, 'restore.request');
  client.close();
});

test('FE-WS-21 终态关闭 4404（对局不存在）：不重连、status 标记 terminal（BUG-092）', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const statuses = [];
  const client = createWsClient({
    url: 'ws://x/ws/games/9', role: 'game',
    createSocket: env.factory, timers,
    onStatus: (e) => statuses.push(e),
  });
  client.connect();
  env.last()._open();
  env.last()._close(GAME_GONE_CLOSE_CODE);
  // 终态：不得再建连（对照 1006 断线会退避重连）
  timers.tick(60_000);
  assert.equal(env.count(), 1, '终态关闭后不得重连');
  const closed = statuses.filter((s) => s.type === 'closed').pop();
  assert.equal(closed.manual, false);
  assert.equal(closed.terminal, true);
  assert.equal(closed.code, 4404);
  const reconnecting = statuses.filter((s) => s.type === 'reconnecting');
  assert.equal(reconnecting.length, 0, '终态关闭不得进入重连态');
  // 对照：普通异常断线（1006）仍退避重连
  client.connect();
  assert.equal(env.count(), 2);
  env.last()._close(1006);
  timers.tick(1_000);
  assert.equal(env.count(), 3, '普通断线仍应重连');
  client.close();
});

test('FE-WS-22 Hub 透传 terminal 标记（game 通道终态关闭可见，BUG-092）', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const seen = [];
  const hub = createWsHub({
    origin: 'http://localhost:8000',
    dispatch: () => {},
    clientOpts: { createSocket: env.factory, timers },
    wakeTarget: makeWakeTarget(),
  });
  hub.subscribeStatus((ev) => seen.push(ev));
  hub.connectGame(9);
  env.last()._open();
  env.last()._close(GAME_GONE_CLOSE_CODE);
  timers.tick(60_000);
  assert.equal(env.count(), 1, '终态关闭不得重连');
  const closed = seen.filter((s) => s.type === 'closed' && s.channel === 'game').pop();
  assert.equal(closed.terminal, true);
  assert.equal(closed.code, 4404);
  hub.close();
});

test('FE-WS-08 入站分发：状态类→dispatch；error→onError；pong/未知容错', () => {
  const env = makeSocketEnv();
  const dispatched = [];
  const errors = [];
  const unknown = [];
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    dispatch: (m) => dispatched.push(m),
    onError: (e) => errors.push(e),
    onUnknown: (e) => unknown.push(e),
  });
  client.connect();
  const sock = env.last();
  sock._open();

  sock._msg({ type: 'game.state', seq: 1, data: { game_id: 1 } });
  sock._msg({ type: 'move.applied', seq: 2, data: { move_no: 1 } });
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].type, 'game.state');
  assert.equal(dispatched[1].seq, 2);

  // error 走 onError，不进 dispatch
  sock._msg({ type: 'error', seq: 3, code: 'ILLEGAL_MOVE', message: '禁入点' });
  assert.equal(dispatched.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'ILLEGAL_MOVE');

  // pong 忽略
  sock._msg({ type: 'pong', seq: 4 });
  assert.equal(dispatched.length, 2);
  assert.equal(unknown.length, 0);

  // 未知类型容错（不抛）
  sock._msg({ type: 'whatever.new', data: {} });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].type, 'whatever.new');

  // data 缺省 → {} 再分发
  sock._msg({ type: 'engine.status', seq: 5 });
  const last = dispatched[dispatched.length - 1];
  assert.deepEqual(last.data, {});
  client.close();
});

test('FE-WS-09 手动 close 停止重连', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
  });
  client.connect();
  env.last()._open();
  env.last()._close(1006); // 意外断线 → 已排 1s 重连
  client.close(); // 用户主动关闭
  timers.tick(10_000); // 即使时间推进也不应新建连接
  assert.equal(env.count(), 1);
});

test('FE-WS-10 URL 工具：http(s)→ws(s) 与端点拼接', () => {
  assert.equal(gameWsUrl('http://localhost:8000', 3), 'ws://localhost:8000/ws/games/3');
  assert.equal(gameWsUrl('https://tgo.example', 3), 'wss://tgo.example/ws/games/3');
  assert.equal(adminWsUrl('http://localhost:8000'), 'ws://localhost:8000/ws/admin');
  assert.equal(toWsUrl('ws://x:1', '/ws/a'), 'ws://x:1/ws/a');
  assert.equal(toWsUrl('', '/ws/a'), '/ws/a'); // 无 origin 走相对
});

test('FE-WS-11 双通道 Hub：常驻 admin + game 按 gameId 切换', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const dispatched = [];
  const hub = createWsHub({
    origin: 'http://localhost:8000',
    dispatch: (m) => dispatched.push(m),
    clientOpts: { createSocket: env.factory, timers },
  });
  hub.connect(); // 打开 admin
  assert.equal(env.count(), 1);
  assert.ok(env.last().url.endsWith('/ws/admin'));

  hub.connectGame(1);
  assert.equal(env.count(), 2);
  assert.ok(env.last().url.endsWith('/ws/games/1'));

  hub.connectGame(1); // 同 id：不重复建连
  assert.equal(env.count(), 2);

  hub.connectGame(2); // 切换：关闭 1、新建 2
  assert.equal(env.count(), 3);
  assert.ok(env.last().url.endsWith('/ws/games/2'));

  // 打开对应 socket 后，消息经 admin/game 通道发送到对应连接
  env.all[0]._open(); // admin
  const gameSock = env.last();
  gameSock._open(); // game2
  hub.sendAdmin('ping');
  hub.sendGame('restore.request');
  const adminSock = env.all[0];
  assert.equal(JSON.parse(adminSock.sent[0]).type, 'ping');
  assert.equal(JSON.parse(gameSock.sent[0]).type, 'restore.request');

  // game 通道入站照常 dispatch
  gameSock._open();
  gameSock._msg({ type: 'engine.status', data: { state: 'IDLE' } });
  assert.equal(dispatched.length, 1);

  hub.close();
  assert.equal(env.all[0].readyState, 3);
  assert.equal(env.last().readyState, 3);
});

test('FE-WS-12 建连看门狗：CONNECTING 悬挂超时 → 放弃并重连（不依赖事件回调）', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const statuses = [];
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    onStatus: (e) => statuses.push(e),
  });
  client.connect();
  assert.equal(env.count(), 1);
  const hung = env.last(); // 模拟移动端悬挂：无 onopen/onerror/onclose 任何事件

  timers.tick(CONNECT_TIMEOUT_MS - 1);
  assert.equal(hung.readyState, 0); // 未到超时：保持等待
  assert.equal(env.count(), 1);

  timers.tick(1); // 超时：放弃悬挂 socket（主动 close，不等其事件）
  assert.equal(hung.readyState, 3);
  const closed = statuses.find((s) => s.type === 'closed');
  assert.equal(closed.reason, 'connect-timeout');
  assert.equal(closed.manual, false);

  timers.tick(1_000); // 退避档位 1s：创建新连接（旧实现这里永远停在 1 个 socket）
  assert.equal(env.count(), 2);
  assert.ok(statuses.some((s) => s.type === 'reconnecting'));

  env.last()._open(); // 新 socket 正常 open → 恢复可用
  assert.ok(client.isOpen);
  client.close();
});

test('FE-WS-13 心跳应答看门狗：连续无入站 → 放弃半开连接并重连', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const statuses = [];
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    onStatus: (e) => statuses.push(e),
  });
  client.connect();
  const sock = env.last();
  sock._open();

  // 服务端静默（半开连接：网络切换后 ping 发得出、pong/推送回不来）
  for (let i = 0; i <= PONG_MISS_LIMIT; i += 1) timers.tick(HEARTBEAT_MS);
  const pings = sock.sent.map((t) => JSON.parse(t)).filter((m) => m.type === 'ping');
  assert.equal(pings.length, PONG_MISS_LIMIT); // 探活 N 次无应答 → 放弃，不再续发
  assert.equal(sock.readyState, 3);
  const closed = statuses.find((s) => s.type === 'closed');
  assert.equal(closed.reason, 'pong-timeout');
  assert.equal(closed.manual, false);

  timers.tick(1_000); // 退避重连
  assert.equal(env.count(), 2);
  assert.ok(statuses.some((s) => s.type === 'reconnecting'));

  // 新连接 pong 正常应答：后续心跳保持存活（同一 socket，不误杀）
  const sock2 = env.last();
  sock2._open();
  for (let i = 0; i <= PONG_MISS_LIMIT; i += 1) {
    timers.tick(HEARTBEAT_MS);
    sock2._msg({ type: 'pong', seq: i + 1 });
  }
  assert.equal(sock2.readyState, 1);
  assert.equal(env.count(), 2);
  client.close();
});

test('FE-WS-14 入站消息（非 pong）同样证明链路存活：不清零前不误杀', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const statuses = [];
  const dispatched = [];
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    onStatus: (e) => statuses.push(e),
    dispatch: (m) => dispatched.push(m),
  });
  client.connect();
  const sock = env.last();
  sock._open();

  // 场景：服务端推送比 pong 先到（或 pong 丢包但推送正常）→ 链路存活判定以任一入站为准
  for (let i = 0; i <= PONG_MISS_LIMIT; i += 1) {
    timers.tick(HEARTBEAT_MS);
    sock._msg({ type: 'move.applied', seq: i + 1, data: { move_no: i + 1 } });
  }
  assert.equal(sock.readyState, 1);
  assert.equal(env.count(), 1);
  assert.ok(!statuses.some((s) => s.type === 'closed'));
  assert.equal(dispatched.length, PONG_MISS_LIMIT + 1);
  client.close();
});

/* ---------- 移动端断网/恢复（BUG-076）：心跳链不得静默终止 + wake 快速恢复 ---------- */

/** 假窗口/文档事件源（网络与可见性恢复事件注入用）。 */
function makeWakeTarget() {
  const win = { listeners: {}, document: { visibilityState: 'visible', listeners: {} } };
  const doc = win.document;
  const on = (map) => (type, fn) => {
    (map[type] || (map[type] = [])).push(fn);
  };
  const off = (map) => (type, fn) => {
    const arr = map[type] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  const emit = (map) => (type) => {
    (map[type] || []).slice().forEach((fn) => fn({ type }));
  };
  win.addEventListener = on(win.listeners);
  win.removeEventListener = off(win.listeners);
  doc.addEventListener = on(doc.listeners);
  doc.removeEventListener = off(doc.listeners);
  win.dispatch = emit(win.listeners);
  win.dispatchDoc = emit(doc.listeners);
  return win;
}

test('FE-WS-15 僵尸 socket 静默失效（无任何事件）：心跳链不得终止，自动放弃并重连', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const statuses = [];
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    onStatus: (e) => statuses.push(e),
  });
  client.connect();
  const sock = env.last();
  sock._open();
  assert.ok(client.isOpen);

  // 移动端典型场景：浏览器内部已把连接置为 CLOSED（网络长时间中断/页面冻结所致），
  // 但 onclose/onerror/onopen 全部不投递——旧实现在下一次心跳到期时 `return`，
  // 心跳链与重连链双双静默终止 → 页面永不恢复（手机端须重启 WIFI 开关才能触发事件）。
  sock.readyState = 3;

  timers.tick(HEARTBEAT_MS);
  const closed = statuses.find((s) => s.type === 'closed');
  assert.ok(closed, '僵尸 socket 必须被判定为断线，而不是让心跳链静默终止');
  assert.equal(closed.reason, 'stale-socket');
  assert.equal(closed.manual, false);

  timers.tick(1_000); // 退避首档：新建连接
  assert.equal(env.count(), 2);
  env.last()._open();
  assert.ok(client.isOpen); // 自愈完成
  client.close();
});

test('FE-WS-16 wake() 网络恢复：取消退避等待立即重试；不打断建连；手动关闭后不复活', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
  });
  client.connect();
  env.last()._open();
  env.last()._close(1006); // 意外断线 → 退避计时（1s）在途

  client.wake('network-online'); // 网络已恢复：不等退避，立即新 socket 重试
  assert.equal(env.count(), 2);
  assert.equal(env.last().readyState, 0);

  client.wake('page-visible'); // 建连中：不打断（交由 CONNECT_TIMEOUT_MS 看门狗处置）
  assert.equal(env.count(), 2);

  timers.tick(1_000); // 被取消的退避计时不得再产生第三条连接
  assert.equal(env.count(), 2);

  env.last()._open();
  assert.ok(client.isOpen);

  client.close(); // 主动关闭（视图卸载）
  client.wake('page-show');
  timers.tick(30_000);
  assert.equal(env.count(), 2); // 主动关闭后 wake 不得复活连接
});

test('FE-WS-17 wake() 探活：OPEN 半开连接短窗口无入站 → 放弃重连；有入站则保持', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const statuses = [];
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    onStatus: (e) => statuses.push(e),
  });
  client.connect();
  const sock = env.last();
  sock._open();

  client.wake('page-visible'); // 立即探活（不等 15s 心跳）
  const pings = sock.sent.map((t) => JSON.parse(t)).filter((m) => m.type === 'ping');
  assert.equal(pings.length, 1);

  timers.tick(WAKE_PROBE_MS); // 短窗口无任何入站（切网后半开连接）
  const closed = statuses.find((s) => s.type === 'closed');
  assert.ok(closed);
  assert.equal(closed.reason, 'pong-timeout');
  timers.tick(1_000);
  assert.equal(env.count(), 2);

  // 健康链路：探活 ping 得到 pong → 保持存活不误杀
  const sock2 = env.last();
  sock2._open();
  client.wake('page-visible');
  sock2._msg({ type: 'pong', seq: 99 });
  timers.tick(WAKE_PROBE_MS + 1);
  assert.equal(sock2.readyState, 1);
  assert.equal(env.count(), 2);
  client.close();
});

test('FE-WS-18 wake() 僵尸 CLOSING（无事件）：放弃旧 socket 并立即新建', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const statuses = [];
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    onStatus: (e) => statuses.push(e),
  });
  client.connect();
  env.last()._open();
  env.last().readyState = 2; // CLOSING 悬挂：close 事件永不投递

  client.wake('network-online');
  assert.equal(env.count(), 2); // 旧 socket 被放弃、立即新建
  const closed = statuses.find((s) => s.type === 'closed');
  assert.equal(closed.reason, 'network-online');
  assert.equal(closed.manual, false);
  client.close();
});

test('FE-WS-19 Hub 自动接线网络/可见性恢复事件 → 全体通道唤醒；close() 解绑', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const wakeTarget = makeWakeTarget();
  const hub = createWsHub({
    origin: 'http://localhost:8000',
    dispatch: () => {},
    clientOpts: { createSocket: env.factory, timers },
    wakeTarget,
  });
  hub.connect();
  hub.connectGame(1);
  const adminSock = env.all[0];
  const gameSock = env.all[1];
  adminSock._open();
  gameSock._open();

  wakeTarget.dispatch('online'); // 网络恢复：两通道立即探活
  assert.equal(lastSent(adminSock).type, 'ping');
  assert.equal(lastSent(gameSock).type, 'ping');

  // 页面可见性恢复：仅 visible 触发
  wakeTarget.document.visibilityState = 'hidden';
  const before = gameSock.sent.length;
  wakeTarget.dispatchDoc('visibilitychange');
  assert.equal(gameSock.sent.length, before);
  wakeTarget.document.visibilityState = 'visible';
  wakeTarget.dispatchDoc('visibilitychange');
  assert.equal(lastSent(gameSock).type, 'ping');

  // bfcache 恢复（pageshow）同样唤醒
  wakeTarget.dispatch('pageshow');
  assert.equal(lastSent(gameSock).type, 'ping');

  hub.close();
  assert.equal((wakeTarget.listeners.online || []).length, 0);
  assert.equal((wakeTarget.listeners.pageshow || []).length, 0);
  assert.equal((wakeTarget.document.listeners.visibilitychange || []).length, 0);
});

test('FE-WS-20 Hub 状态订阅：subscribeStatus 收到带 channel 的生命周期事件；退订后不再回调', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const seen = [];
  const hub = createWsHub({
    origin: 'http://localhost:8000',
    dispatch: () => {},
    clientOpts: { createSocket: env.factory, timers },
  });
  const off = hub.subscribeStatus((ev) => seen.push(`${ev.channel}:${ev.type}`));
  const off2 = hub.subscribeStatus((ev) => seen.push(`dup:${ev.channel}:${ev.type}`));

  hub.connect();
  env.last()._open(); // admin open
  hub.connectGame(3);
  env.last()._open(); // game open
  assert.deepEqual(seen, [
    'admin:connecting', 'dup:admin:connecting',
    'admin:open', 'dup:admin:open',
    'game:connecting', 'dup:game:connecting',
    'game:open', 'dup:game:open',
  ]);

  off(); // 退订其一
  env.last()._close(1006);
  assert.ok(seen.includes('dup:game:closed'), '未退订的订阅者仍应收到事件');
  assert.ok(!seen.some((s) => s === 'game:closed'), '已退订者不得再收到事件');

  hub.close();
  off2();
});

test('FE-WS-23 旧 socket 残余帧不得进入 dispatch（代际守卫，H-6）', () => {
  const env = makeSocketEnv();
  const dispatched = [];
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    dispatch: (m) => dispatched.push(m),
  });
  client.connect();
  const s1 = env.last();
  s1._open();
  s1.readyState = 2; // CLOSING：换 socket 窗口（旧句柄/旧帧仍可能到达）
  client.connect();
  const s2 = env.last();
  assert.notEqual(s2, s1, 'CLOSING 时应新建 socket');
  s1._msg({ type: 'game.state', seq: 1, data: { game_id: 1 } }); // 旧残余帧
  assert.equal(dispatched.length, 0, '旧 socket 残余帧不得分发');
  s2._open();
  s2._msg({ type: 'game.state', seq: 2, data: { game_id: 1 } });
  assert.equal(dispatched.length, 1, '当前 socket 照常分发');
  client.close();
});

test('FE-WS-24 close() 解绑句柄：残余帧不得再分发（H-6）', () => {
  const env = makeSocketEnv();
  const dispatched = [];
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
    dispatch: (m) => dispatched.push(m),
  });
  client.connect();
  const sock = env.last();
  sock._open();
  sock._msg({ type: 'move.applied', seq: 1, data: { move_no: 1 } });
  assert.equal(dispatched.length, 1);
  client.close();
  sock._msg({ type: 'move.applied', seq: 2, data: { move_no: 2 } });
  assert.equal(dispatched.length, 1, 'close() 后残余帧不得再分发');
});

test('FE-WS-25 outbox 容量上限：超限丢最旧，重连后仅补发最新 200 条（L-11）', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const warn = console.warn;
  console.warn = () => {}; // 吞掉超限告警的测试噪点
  try {
    const client = createWsClient({
      url: 'ws://x/ws/games/1', role: 'game',
      createSocket: env.factory, timers,
    });
    client.connect();
    const sock = env.last(); // CONNECTING：消息全部入队
    for (let i = 0; i < OUTBOX_LIMIT + 1; i += 1) client.send('ping', { i });
    sock._open();
    const pings = sock.sent
      .map((t) => JSON.parse(t))
      .filter((m) => m.type === 'ping');
    assert.equal(pings.length, OUTBOX_LIMIT, '入队量不得超过上限');
    assert.equal(pings[0].data.i, 1, '超限丢弃的是最旧一条（i=0）');
    assert.equal(pings[pings.length - 1].data.i, OUTBOX_LIMIT, '最新一条保留');
    client.close();
  } finally {
    console.warn = warn;
  }
});

test('FE-WS-26 终态关闭后 send 不再入队、wake 不复活（L-11）', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/9', role: 'game',
    createSocket: env.factory, timers,
  });
  client.connect();
  env.last()._open();
  env.last()._close(GAME_GONE_CLOSE_CODE);
  client.send('ping', { i: 1 }); // 终态：应直接丢弃
  client.wake('network-online');
  timers.tick(60_000);
  assert.equal(env.count(), 1, '终态后 wake 不得重连（旧实现会立即建连）');
  // 对照：手动 connect（新通道/用户重试）解除终态，且终态期间消息不得补发
  client.connect();
  const s2 = env.last();
  s2._open();
  const flushed = s2.sent.map((t) => JSON.parse(t)).some((m) => m.data && m.data.i === 1);
  assert.equal(flushed, false, '终态期间的消息不得在重连后补发');
  client.close();
});

test('FE-WS-27 wake() 不清零退避计数（L-11：事件风暴不得重置重试节奏）', () => {
  const env = makeSocketEnv();
  const timers = new FakeTimers();
  const client = createWsClient({
    url: 'ws://x/ws/games/1', role: 'game',
    createSocket: env.factory, timers,
  });
  client.connect();
  env.last()._open();
  env.last()._close(1006); // 意外断线：attempt=1（下次退避 1s）
  client.wake('page-visible'); // 立即重试；旧实现会把 attempt 清零
  assert.equal(env.count(), 2);
  env.last()._close(1006); // 第二次失败：attempt 应为 2（下次退避 2s）
  timers.tick(1_000);
  assert.equal(env.count(), 2, '2s 未到不得重连（旧实现 wake 清零退避 → 1s 即重连）');
  timers.tick(1_000);
  assert.equal(env.count(), 3);
  client.close();
});

