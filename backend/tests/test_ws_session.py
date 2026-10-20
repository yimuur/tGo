"""T4.7 WS 会话管理测试（TASK T4.7 / API §4，ARCHITECTURE §1.1/§5）。

用例 ID: API-WS-SESS-*
- 按 game_id 分组的连接注册/回收/计数；
- 广播（对局组 / 管理通道）；全局 engine.status 广播（对弈+管理均收到）；
- GameAnalysisPusher：订阅/退订、主谱曲线节流推送（200ms 合并）、
  试下分支不推曲线、多对局按 key 合并。
"""

import asyncio
import logging

from app.ws.session import GameAnalysisPusher, SessionManager


class FakeWs:
    """mock WebSocket：记录发送的报文。"""

    def __init__(self, name: str) -> None:
        self.name = name
        self.sent: list[dict] = []

    async def send_json(self, envelope: dict) -> None:
        self.sent.append(envelope)


class TestSendFailureVisibility:
    """L-5：载荷不可序列化必须 ERROR 级可见（旧实现与断线异常同列 DEBUG 静默）。"""

    async def test_serialization_error_logged(self, caplog):
        class BadWs:
            async def send_json(self, envelope):
                raise TypeError("Object of type set is not JSON serializable")

        manager = SessionManager()
        with caplog.at_level(logging.ERROR):
            await manager.send(BadWs(), {"type": "x", "data": {1, 2}})
        assert any("不可序列化" in (r.getMessage() or "") for r in caplog.records)


class HangingWs:
    """挂起连接：``send_json`` 阻塞至被取消（模拟半开 TCP 写缓冲写满，H-2）。"""
    def __init__(self, name: str, *, release: asyncio.Event | None = None) -> None:
        self.name = name
        self.sent: list[dict] = []
        self.started = asyncio.Event()
        self.cancelled = False
        self._release = release

    async def send_json(self, envelope: dict) -> None:
        self.started.set()
        try:
            if self._release is None:
                await asyncio.Event().wait()  # 永不完成：只能被超时取消
            else:
                await self._release.wait()
            self.sent.append(envelope)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class SignalingWs(FakeWs):
    """发送完成后信号（并发隔离断言用，不依赖时间猜测）。"""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.received = asyncio.Event()

    async def send_json(self, envelope: dict) -> None:
        await super().send_json(envelope)
        self.received.set()


class TestSessionManager:
    async def test_register_unregister_and_count(self):
        session = SessionManager()
        ws1, ws2 = FakeWs("a"), FakeWs("b")
        assert session.game_conn_count(1) == 0

        await session.register_game(1, ws1)
        await session.register_game(1, ws2)
        assert session.game_conn_count(1) == 2

        await session.unregister_game(1, ws1)
        assert session.game_conn_count(1) == 1

        await session.unregister_game(1, ws2)
        assert session.game_conn_count(1) == 0
        # 组空后再次回收幂等
        await session.unregister_game(1, ws2)
        assert session.game_conn_count(1) == 0

    async def test_broadcast_to_game(self):
        session = SessionManager()
        ws1, ws2 = FakeWs("a"), FakeWs("b")
        await session.register_game(7, ws1)
        await session.register_game(7, ws2)
        await session.broadcast_to_game(7, {"type": "move.applied", "data": {}})
        assert ws1.sent == [{"type": "move.applied", "data": {}}]
        assert ws2.sent == [{"type": "move.applied", "data": {}}]

    async def test_broadcast_to_admin(self):
        session = SessionManager()
        admin = FakeWs("admin")
        await session.register_admin(admin)
        await session.broadcast_to_admin({"type": "admin.task", "data": {"task": "start", "status": "done"}})
        assert admin.sent[-1]["type"] == "admin.task"

    async def test_broadcast_engine_status_global(self):
        """全局 engine.status：对弈/管理通道均收到（API §4.4）。"""
        session = SessionManager()
        game_ws, admin_ws = FakeWs("game"), FakeWs("admin")
        await session.register_game(1, game_ws)
        await session.register_admin(admin_ws)

        await session.broadcast_engine_status("INIT", 42)
        # reason/detail 恒携带（显式 null 清旧值，BUG-097）；humanModelAvailable 未知时不携带
        expected = {
            "type": "engine.status",
            "data": {"state": "INIT", "progress": 42, "reason": None, "detail": None},
        }
        assert game_ws.sent[-1] == expected
        assert admin_ws.sent[-1] == expected

    async def test_send_ignores_broken_connection(self):
        """断线连接发送失败静默丢弃（广播容错）。"""

        class BrokenWs:
            async def send_json(self, envelope: dict) -> None:
                raise RuntimeError("connection closed")

        session = SessionManager()
        await session.register_game(1, BrokenWs())
        # 不应抛出
        await session.broadcast_to_game(1, {"type": "x"})


class TestSendIsolation:
    """H-2 回归（2026-09-19 代码审查）：单连接发送必须有界且并发隔离。

    旧实现：``send`` 无超时（半开 TCP → ``send_json`` 无限挂起），广播为顺序
    ``await``——一个僵死连接会拖住同局/全局广播，乃至持对局锁的收尾路径。
    """

    async def test_send_times_out_instead_of_hanging(self):
        """``send`` 对挂起连接在超时后返回（旧实现无限悬挂 → 红）。"""
        session = SessionManager(send_timeout_s=0.05)
        ws = HangingWs("wedge")
        await asyncio.wait_for(session.send(ws, {"type": "x"}), timeout=1)
        assert ws.cancelled is True
        assert ws.sent == []

    async def test_broadcast_bounded_by_send_timeout(self):
        """同局广播：挂起连接不阻塞健康连接（超时取消；旧实现整体悬挂 → 红）。"""
        session = SessionManager(send_timeout_s=0.05)
        stalled, healthy = HangingWs("stalled"), FakeWs("healthy")
        await session.register_game(7, stalled)
        await session.register_game(7, healthy)
        await asyncio.wait_for(
            session.broadcast_to_game(7, {"type": "game.state", "data": {}}), timeout=1
        )
        assert healthy.sent == [{"type": "game.state", "data": {}}]
        assert stalled.cancelled is True

    async def test_engine_status_concurrent_across_games(self):
        """全局广播并发扇出：一个挂起连接不拖延其它对局/管理连接（旧实现顺序 → 红）。"""
        session = SessionManager(send_timeout_s=5.0)  # 长超时：验证“并发”而非“等超时”
        release = asyncio.Event()
        stalled = HangingWs("stalled", release=release)
        healthy = SignalingWs("healthy")
        await session.register_game(1, stalled)
        await session.register_game(2, healthy)
        task = asyncio.create_task(session.broadcast_engine_status("IDLE"))
        try:
            await asyncio.wait_for(healthy.received.wait(), timeout=1)
            assert not task.done()  # 挂起连接仍在等待，但不得拖住其它连接
        finally:
            release.set()
            await asyncio.wait_for(task, timeout=1)


class FakeAnalysis:
    def __init__(self) -> None:
        self.callback = None

    def set_on_result(self, callback) -> None:
        self.callback = callback


class FakeSessionForPusher:
    def __init__(self) -> None:
        self.game_msgs: list[tuple[int, dict]] = []

    async def broadcast_to_game(self, game_id: int, envelope: dict) -> None:
        self.game_msgs.append((game_id, envelope))


class TestGameAnalysisPusher:
    def _make(self, session=None, sleep=asyncio.sleep):
        analysis = FakeAnalysis()
        session = session or FakeSessionForPusher()
        pusher = GameAnalysisPusher(analysis, session, window_s=0.2, sleep=sleep)
        # 组合根接线（与 bootstrap 一致：扇出器注册分析结果回调）
        analysis.set_on_result(pusher.on_result)
        return analysis, session, pusher

    async def test_curve_push_merged_in_window(self):
        """200ms 窗口内同 key 合并只推最新（ARCHITECTURE §4.2）。"""
        analysis, session, pusher = self._make()
        pusher.subscribe(1)
        await analysis.callback(1, "main:0", {"rootInfo": {"winrate": 0.5, "scoreLead": 1.0}})
        await analysis.callback(1, "main:0", {"rootInfo": {"winrate": 0.6, "scoreLead": 2.0}})
        # 手动 flush 窗口
        await pusher._pushers[1].flush()
        assert len(session.game_msgs) == 1
        msg = session.game_msgs[0]
        assert msg[0] == 1
        assert msg[1]["type"] == "analysis.curve"
        assert msg[1]["data"]["winrate"] == 60.0
        assert msg[1]["data"]["score_lead"] == 2.0

    async def test_curve_only_for_subscribed_game(self):
        """未订阅对局的结果不推送。"""
        analysis, session, pusher = self._make()
        pusher.subscribe(1)
        await analysis.callback(2, "main:0", {"rootInfo": {"winrate": 0.5}})
        assert session.game_msgs == []

    async def test_trial_key_not_pushed_as_curve(self):
        """试下分支（trial:）不推曲线。"""
        analysis, session, pusher = self._make()
        pusher.subscribe(1)
        await analysis.callback(1, "trial:1:0", {"rootInfo": {"winrate": 0.5}})
        assert session.game_msgs == []

    async def test_subscribe_unsubscribe(self):
        analysis, session, pusher = self._make()
        assert pusher.is_subscribed(1) is False
        pusher.subscribe(1)
        assert pusher.is_subscribed(1) is True
        pusher.subscribe(1)  # 幂等
        pusher.unsubscribe(1)
        assert pusher.is_subscribed(1) is False

    async def test_unsubscribe_stops_push(self):
        analysis, session, pusher = self._make()
        pusher.subscribe(1)
        pusher.unsubscribe(1)
        await analysis.callback(1, "main:0", {"rootInfo": {"winrate": 0.5}})
        assert session.game_msgs == []
