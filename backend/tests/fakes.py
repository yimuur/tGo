"""Phase 4 API 集成测试 fakes（严禁真实 KataGo/GPU，AGENTS.md §7）。

``FakeManager``：mock 引擎管理器（submit 返回可配置 Analysis 响应；
状态可控：IDLE/ANALYZING/DEAD/FATAL；humanModelAvailable 可配）。
"""

from __future__ import annotations

import asyncio
import types
from typing import Optional

from app.core.fsm import EngineState
from app.engine.manager import LaunchOutcome


class FakeEngine:
    """引擎对象最小接口（manager.engine 引用）。"""

    def __init__(self, human_model_available: bool = True, is_running: bool = False) -> None:
        self.has_human_model = human_model_available
        self.is_running = is_running


class FakeManager:
    """mock 引擎管理器：Analysis 响应可配置；状态/重启/停止可观测。"""

    def __init__(
        self,
        *,
        human_model_available: bool = True,
        state: str = "IDLE",
        running: bool = False,
    ) -> None:
        self._human = human_model_available
        self.state = state
        self.engine = FakeEngine(human_model_available, running)
        #: KataGo 后端标签（stderr 检测；Route /admin/system 消费，默认未检测）
        self.backend_label: Optional[str] = None
        self.started = False
        self.stopped = False
        self.submitted_queries: list[dict] = []
        #: 被请求终止的查询 id（悔棋中断 AI 应手场景断言用）
        self.terminated_queries: list[str] = []
        self._state_callbacks: list = []
        self.restart_futures: list[asyncio.Future] = []
        self.stop_futures: list[asyncio.Future] = []
        #: 不可用归因（可选：standard_model_missing/engine_executable_missing/startup_failed）
        self.reason: Optional[str] = None
        self.detail: Optional[str] = None
        #: `ensure_ready` 返回值（ISSUE-069 三态：默认本替身"真拉起"）
        self.ensure_ready_result: LaunchOutcome = LaunchOutcome.LAUNCHED
        #: 默认 Analysis 响应（19 路；AI 落子选 D4=(3,3)，含 ownership）
        self.response: dict = {
            "id": "mock",
            "rootInfo": {
                "currentPlayer": "B",
                "winrate": 0.55,
                "scoreLead": 0.5,
                "visits": 100,
            },
            "moveInfos": [
                {
                    "move": "D4",
                    "order": 0,
                    "visits": 50,
                    "winrate": 0.6,
                    "scoreLead": 1.0,
                    "pv": ["D4", "D16", "Q16"],
                }
            ],
            "ownership": [0.1] * 361,
        }

    @property
    def fsm(self) -> types.SimpleNamespace:
        """FSM 视图（与真实 `EngineManager.fsm` 同构：`state` 为 `EngineState` 成员）。

        管理路由的「引擎是否健康运行」判据（`engine_healthy_running`）取此状态，
        替身必须给出与真实管理器同类型的值，否则判据在测试中永不成立。
        """
        return types.SimpleNamespace(state=EngineState(self.state))

    def state_snapshot(self) -> dict:
        return {
            "state": self.state,
            "progress": None,
            "humanModelAvailable": self._human,
            "reason": self.reason,
            "detail": self.detail,
        }

    def on_state_change(self, callback) -> None:
        self._state_callbacks.append(callback)

    def mark_activity(self) -> None:
        pass

    def update_config(self, cfg) -> None:
        """H-1：记录配置热更新（测试替身无运行期状态，仅需可调用）。"""
        self.cfg = cfg

    async def submit(self, query: dict, timeout_s: Optional[float] = None) -> dict:
        """记录查询并返回可配置响应（可替换 ``self.response`` 定制）。"""
        self.submitted_queries.append(query)
        return dict(self.response)

    async def terminate(self, query_id: str) -> bool:
        """请求终止查询（测试替身：记录调用，默认已发出）。"""
        self.terminated_queries.append(query_id)
        return True

    async def ensure_ready(
        self, *, reset_fatal: bool = False, reason: str = "按需加载"
    ) -> LaunchOutcome:
        self.started = True
        self.engine.is_running = True
        self.state = "IDLE"
        return self.ensure_ready_result

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True
        self.engine.is_running = False

    def request_restart(self) -> asyncio.Future:
        fut = asyncio.get_running_loop().create_future()
        self.restart_futures.append(fut)
        return fut

    def request_stop(self) -> asyncio.Future:
        fut = asyncio.get_running_loop().create_future()
        self.stop_futures.append(fut)
        if not self.engine.is_running:
            fut.set_result(None)
        return fut


class SlowPlayEngine:
    """可控「慢速」引擎替身：``submit`` 挂起于内部 Event，``terminate`` 放行。

    模拟 KataGo 查询在途 + ``action=terminate`` 语义（悔棋中断 AI 应手场景，
    2026/09/13）：终止后返回**无候选**的部分结果（结果一律被服务层丢弃）。
    """

    def __init__(self) -> None:
        self.state = {"inflight": 0, "terminated": [], "ids": []}
        self._gate = asyncio.Event()

    async def submit(self, query: dict, timeout_s: Optional[float] = None) -> dict:
        self.state["inflight"] += 1
        self.state["ids"].append(query.get("id"))
        await self._gate.wait()
        self._gate.clear()  # 放行一次后复位：支持连续多轮（悔棋后同手数再落子）
        self.state["inflight"] -= 1
        return {"id": query.get("id"), "moveInfos": []}

    async def terminate(self, query_id: str) -> bool:
        self.state["terminated"].append(query_id)
        self._gate.set()
        return True

    def release(self) -> None:
        """测试收尾：放行挂起的 ``submit``（无 terminate 语义）。"""
        self._gate.set()


class StuckPlayEngine(SlowPlayEngine):
    """terminate 后仍不回包的引擎替身（过载场景）。

    锁定「悔棋中断不依赖引擎响应」：服务层与引擎响应竞速，abort 登记后立即
    放弃等待；``release``（继承基类）供测试收尾放行挂起的 ``submit``。
    """

    async def terminate(self, query_id: str) -> bool:
        self.state["terminated"].append(query_id)
        return True


# ============================================================
# WS 通道替身（BUG-126：推送失败 → 通道状态失效 → 接收侧报错）
# ============================================================


class ChannelTransportStub:
    """通道 ASGI ``receive``/``send`` 替身：可注入「第 N 个 send 帧起抛 OSError」。

    复现 BUG-126（现场日志：对局 #235「WS 对局通道异常」）：推送/应答时对端已断开 →
    starlette ``send()`` 捕获 ``OSError``，把 ``application_state`` 置为 ``DISCONNECTED``
    并抛 ``WebSocketDisconnect(1006)``——该异常被 ``SessionManager.send`` 按「连接已
    断开/竞态」吞掉（DEBUG），**接收循环不知情**；其下一轮 ``receive_json()`` 因状态
    检查抛 ``RuntimeError('WebSocket is not connected…')``。

    入站脚本耗尽后 ``receive()`` **挂起**（不凭空产生消息，保证用例确定性）。
    """

    def __init__(
        self, *, inbound: list[dict], fail_from_send_index: Optional[int] = None
    ) -> None:
        self._inbound = list(inbound)
        self._fail_from = fail_from_send_index
        #: 已写入 ASGI 的帧（含 accept/close）
        self.sent: list[dict] = []
        #: 业务载荷帧（``websocket.send``）计数——注入失败按此计
        self.payload_frames = 0
        self._exhausted = asyncio.Event()

    async def receive(self) -> dict:
        if self._inbound:
            return self._inbound.pop(0)
        await self._exhausted.wait()
        raise AssertionError("通道替身入站脚本已耗尽，不应再次被接收")

    async def send(self, message: dict) -> None:
        if message["type"] == "websocket.send":
            self.payload_frames += 1
            if self._fail_from is not None and self.payload_frames >= self._fail_from:
                raise OSError(10054, "远程主机强迫关闭了一个现有的连接。")
        self.sent.append(message)


def channel_scope(services, *, path: str = "/ws/games/1") -> dict:
    """通道测试用 ASGI scope（``websocket.app.state.services`` 指向给定服务容器）。"""
    app = types.SimpleNamespace(state=types.SimpleNamespace(services=services))
    return {"type": "websocket", "path": path, "headers": [], "query_string": b"", "app": app}
