"""T4.6 WS 管理通道集成测试（TASK T4.6 / API §4.4）。

用例 ID: API-WS-ADMIN-*
- 连接即推送 engine.status（含 INIT/benchmark progress）；
- ping→pong；admin.task 推送；admin.config 推送（T7.1 后端参数同步）；
- 全局 engine.status 广播（对弈/管理通道均收到）；
- system.status 定时推送（可选）。
"""

import asyncio
import json
import logging

from fastapi.testclient import TestClient
from starlette.websockets import WebSocket

from app.api.ws_admin import ws_admin
from app.services.game_service import CreateGameParams
from tests.fakes import ChannelTransportStub, channel_scope


def _recv_until(ws, msg_type: str, *, max_loop: int = 60):
    for _ in range(max_loop):
        msg = ws.receive_json()
        if msg.get("type") == msg_type:
            return msg
    raise AssertionError(f"未在限定循环内收到 {msg_type}")


class TestAdminChannel:
    async def test_connect_pushes_engine_status(self, api_app):
        with TestClient(api_app) as client:
            with client.websocket_connect("/ws/admin") as ws:
                msg = _recv_until(ws, "engine.status")
        assert msg["data"]["state"] in ("STOPPED", "INIT", "IDLE", "ANALYZING", "DEAD", "FATAL")
        assert "progress" in msg["data"]

    async def test_ping_pong(self, api_app):
        with TestClient(api_app) as client:
            with client.websocket_connect("/ws/admin") as ws:
                _recv_until(ws, "engine.status")
                ws.send_json({"type": "ping", "seq": 3})
                msg = _recv_until(ws, "pong")
        assert msg["seq"] == 3

    async def test_admin_task_push(self, api_app, api_svc):
        """start/stop/set_model 异步任务结果经 /ws/admin 推送（API §4.4）。"""
        with TestClient(api_app) as client:
            with client.websocket_connect("/ws/admin") as ws:
                _recv_until(ws, "engine.status")
                await api_svc.session.broadcast_to_admin(
                    {"type": "admin.task", "data": {"task": "stop", "status": "done"}}
                )
                msg = _recv_until(ws, "admin.task")
        assert msg["data"]["task"] == "stop"
        assert msg["data"]["status"] == "done"

    async def test_admin_config_push(self, api_app, api_svc):
        """配置变更广播 admin.config（API §4.4；REST 触发接线见 API-ADMIN-23/24）。"""
        from app.api.routes_admin import _broadcast_config_changed

        with TestClient(api_app) as client:
            with client.websocket_connect("/ws/admin") as ws:
                _recv_until(ws, "engine.status")
                await _broadcast_config_changed(api_svc, source="config")
                msg = _recv_until(ws, "admin.config")
        assert msg["data"]["source"] == "config"

    async def test_global_engine_status_broadcast(self, api_app, api_svc):
        """全局 engine.status：对弈与管理通道均收到（API §4.4）。"""
        gid = await api_svc.game.create(CreateGameParams(mode="human_human"))
        with TestClient(api_app) as client:
            with client.websocket_connect("/ws/admin") as admin_ws:
                _recv_until(admin_ws, "engine.status")
                with client.websocket_connect(f"/ws/games/{gid}") as game_ws:
                    _recv_until(game_ws, "game.state")
                    await api_svc.session.broadcast_engine_status("ANALYZING", None)
                    admin_msg = _recv_until(admin_ws, "engine.status")
                    game_msg = _recv_until(game_ws, "engine.status")
        assert admin_msg["data"]["state"] == "ANALYZING"
        assert game_msg["data"]["state"] == "ANALYZING"

    async def test_system_status_periodic(self, api_app, api_svc, fake_time):
        """定时推送 system.status（经虚拟时钟推进，避免真实 ~1s 硬等待，AGENTS.md §7）。

        后端标签必须随管理器活取（API-WS-ADMIN-05，2026/09/18）：旧实现漏传
        backend → 定时推送恒以 null 覆盖前端已显示值（管理页「KataGo 后端」几秒内
        从 `OpenCL · …` 退化为「—」）。
        """
        api_svc.config.admin.system_status_interval_s = 1
        api_svc.manager.backend_label = "OpenCL · NVIDIA GeForce GTX 1660"
        with TestClient(api_app) as client:
            with client.websocket_connect("/ws/admin") as ws:
                _recv_until(ws, "engine.status")
                msg = _recv_until(ws, "system.status", max_loop=200)
        assert msg["data"]["host"]
        assert "memory_usage" in msg["data"]
        assert msg["data"]["backend"] == "OpenCL · NVIDIA GeForce GTX 1660", (
            "定时推送必须携带 stderr 检测的后端标签（不得以 null 覆盖）"
        )


class TestDisconnectedChannel:
    """BUG-126：管理通道同族缺陷——推送遇对端已断开 → 接收侧须按断线收尾（非 ERROR）。

    用例 ID: API-WS-ADMIN-07。
    """

    async def test_disconnected_channel_closes_quietly(self, api_svc, caplog):
        transport = ChannelTransportStub(
            inbound=[
                {"type": "websocket.connect"},
                {"type": "websocket.receive", "text": json.dumps({"type": "ping", "seq": 3})},
            ],
            fail_from_send_index=2,  # 第 1 帧 engine.status 正常；第 2 帧 pong 遇对端已断开
        )
        ws = WebSocket(
            channel_scope(api_svc, path="/ws/admin"), transport.receive, transport.send
        )

        with caplog.at_level(logging.DEBUG, logger="app.api.ws_admin"):
            await ws_admin(ws)
        await asyncio.sleep(0)  # 让 finally 取消的 system.status 任务收尾

        assert transport.payload_frames == 2, "初始 engine.status + 一次 pong 应答"
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR], (
            "连接早已失效属预期收尾，不得按 ERROR 上报（BUG-126）"
        )
        assert any(
            r.levelno == logging.INFO and "对端已断开" in r.getMessage() for r in caplog.records
        )
