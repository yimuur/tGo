"""T4.5 WS 对弈/复盘通道集成测试（TASK T4.5 / API §4.1-4.3）。

用例 ID: API-WS-GAME-*
- 连接推送 game.state；play/pass/undo/resign/scoring.confirm 广播；
- ping→pong；restore.request→game.state；错误信封（ILLEGAL_MOVE/INVALID_PAYLOAD）；
- coaching.request→coaching.top5；ownership.request→position.ownership；
- deep_analysis.request→deep_analysis.result；global_analysis→progress/done/cancel；
- 结算预判：双 PASS（含 **AI 应手完成**，BUG-029）→ scoring.prediction 推送；结算态无缓存重连补发起；
- 不存在的对局拒绝连接。
"""

import asyncio
import json
import logging
import time
import types
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.api.ws_game import ws_game
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.game_service import AiParams, CreateGameParams, PlayerInfo
from tests.fakes import ChannelTransportStub, channel_scope


async def _make_game(svc, *, mode: str = "human_human", **overrides) -> int:
    params = dict(mode=mode)
    params.update(overrides)
    return await svc.game.create(CreateGameParams(**params))


def _recv_until(ws, msg_type: str, *, max_loop: int = 50):
    """循环接收直到目标类型（其余消息丢弃）。"""
    for _ in range(max_loop):
        msg = ws.receive_json()
        if msg.get("type") == msg_type:
            return msg
    raise AssertionError(f"未在限定循环内收到 {msg_type}")


def _recv_collect(ws, msg_type: str, *, max_loop: int = 50):
    """循环接收直到目标类型，返回（目标消息, 中间收到的其它消息列表）。"""
    seen = []
    for _ in range(max_loop):
        msg = ws.receive_json()
        if msg.get("type") == msg_type:
            return msg, seen
        seen.append(msg)
    raise AssertionError(f"未在限定循环内收到 {msg_type}")


def _recv_all(ws, n: int):
    return [ws.receive_json() for _ in range(n)]


async def _await_deep_submit(svc, *, window_s: float = 2.0) -> None:
    """有界等待终局深算查询提交（后台任务；时间窗口轮询，禁瞬时断言）。

    AGENTS.md §7：预判为后台异步任务，测试以 2s 窗口轮询共享替身状态，
    超时即断言失败（不掩盖「触发缺失」，这正是 BUG-029 的缺陷形态）。
    """
    deep_visits = svc.config.engine.deep_max_visits
    deadline = window_s / 0.02
    for _ in range(int(deadline)):
        if any(int(q.get("maxVisits") or 0) == deep_visits for q in svc.manager.submitted_queries):
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"未在 {window_s}s 内提交终局深算查询（maxVisits={deep_visits}）")


class TestConnect:
    async def test_connect_pushes_game_state(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                msg = _recv_until(ws, "game.state")
        assert msg["data"]["game_id"] == gid
        assert msg["data"]["status"] == "created"
        # T6.1 白名单：game.state.data.game 不暴露内部字段
        game = msg["data"]["game"]
        for internal in ("parent_game_id", "black_player_id", "white_player_id", "adaptive_initial_level"):
            assert internal not in game
        for public in ("undo_count", "black_captures", "white_captures", "adaptive_enabled"):
            assert public in game

    async def test_restore_resends_global_analysis_progress(self, api_app, api_svc):
        """W-08：全局分析进行中，restore.request 附带重发 analysis.progress。"""
        gid = await _make_game(api_svc)
        # 模拟服务端正在进行该对局的全局分析
        api_svc.review.global_analysis_progress = lambda game_id: (
            {"kind": "global", "done": 2, "total": 7} if game_id == gid else None
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "restore.request"})
                state = _recv_until(ws, "game.state")
                assert state["data"]["game_id"] == gid
                progress = _recv_until(ws, "analysis.progress")
        assert progress["data"] == {"kind": "global", "done": 2, "total": 7}

    async def test_connect_unknown_game_rejected(self, api_app):
        """对局不存在 = **终态**拒绝：应用关闭码 4404（BUG-092）。

        必须握手成功后（`accept`）再关闭：握手前 close 会被 uvicorn 转成 HTTP 403，
        浏览器 `onclose` 只得 1006（与断网不可区分）→ 客户端误判“连接中断”并无限重连。
        """
        with TestClient(api_app) as client:
            with client.websocket_connect("/ws/games/9999") as ws:
                with pytest.raises(WebSocketDisconnect) as exc:
                    ws.receive_json()
                assert exc.value.code == 4404

    async def test_ping_pong(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "ping", "seq": 7})
                msg = _recv_until(ws, "pong")
        assert msg["seq"] == 7

    async def test_restore_request_pushes_state(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "restore.request"})
                msg = _recv_until(ws, "game.state")
        assert msg["data"]["game_id"] == gid


class TestPlay:
    async def test_human_human_play(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "seq": 1, "data": {"x": 3, "y": 3}})
                applied = _recv_until(ws, "move.applied")
                state = _recv_until(ws, "game.state")
        assert applied["data"]["color"] == "B"
        assert applied["data"]["x"] == 3
        assert applied["data"]["y"] == 3
        assert applied["data"]["is_pass"] is False
        # ISSUE-047 方案 1：move.applied 携带累计提子数（可选字段）
        assert applied["data"]["black_captures"] == 0
        assert applied["data"]["white_captures"] == 0
        assert state["data"]["status"] == "active"
        assert state["data"]["moves"][-1]["move_no"] == 1
        assert state["data"]["game"]["black_captures"] == 0

    async def test_play_illegal_move_error_envelope(self, api_app, api_svc):
        """禁入点/占位落子 → error 信封（ILLEGAL_MOVE，API §4.1）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                # 黑先 (3,3)
                ws.send_json({"type": "play", "seq": 1, "data": {"x": 3, "y": 3}})
                _recv_until(ws, "move.applied")
                _recv_until(ws, "game.state")
                # 白在同一位置（占位非法）
                ws.send_json({"type": "play", "seq": 2, "data": {"x": 3, "y": 3}})
                err = _recv_until(ws, "error")
        assert err["seq"] == 2
        assert err["code"] == "ILLEGAL_MOVE"

    async def test_play_invalid_payload(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "data": {"x": 99, "y": 0}})
                err = _recv_until(ws, "error")
        assert err["code"] == "INVALID_PAYLOAD"

    async def test_non_object_payload_keeps_channel(self, api_app, api_svc):
        """M-4：非对象 JSON（null/[]/数字…）→ 无 seq 的 INVALID_PAYLOAD 错误，通道存活。

        缺陷形态（旧实现）：``raw.get("seq")`` 在 None 上抛 AttributeError，被通道级
        兜底捕获 → 整条连接被拆；此处要求错误信封后 ping→pong 仍可用。
        """
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_text("null")
                err = _recv_until(ws, "error")
                assert err["code"] == "INVALID_PAYLOAD"
                assert "seq" not in err
                ws.send_json({"type": "ping"})
                pong = _recv_until(ws, "pong")
        assert pong["type"] == "pong"

    async def test_ownership_after_delete_game_not_found(self, api_app, api_svc):
        """L-8：删除竞态下 `ownership.request` 回 GAME_NOT_FOUND（旧实现 TypeError → INTERNAL_ERROR）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                await api_svc.game.delete_game(gid)
                ws.send_json({"type": "ownership.request", "seq": 9})
                err = _recv_until(ws, "error")
        assert err["code"] == "GAME_NOT_FOUND"
        assert err["seq"] == 9

    async def test_human_ai_auto_ai_move(self, api_app, api_svc):
        """人机：人类落子后 AI 自动落子（mock 引擎返回 D4）。"""
        gid = await _make_game(
            api_svc,
            mode="human_ai",
            color="B",
            black=PlayerInfo(name="张三", rank="rank_5k"),
            ai=AiParams(style="standard", level=5, adaptive=False),
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                # 人类执黑首手（避开 AI 返回的 (3,3)）
                ws.send_json({"type": "play", "data": {"x": 15, "y": 15}})
                applied = _recv_until(ws, "move.applied")
                assert applied["data"]["color"] == "B"
                ai_applied = _recv_until(ws, "move.applied")
                assert ai_applied["data"]["color"] == "W"
                # FakeManager 返回 GTP D4 → (3,15)
                assert ai_applied["data"]["x"] == 3
                assert ai_applied["data"]["y"] == 15
                _recv_until(ws, "game.state")


class TestPassUndoResign:
    async def test_pass(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "pass", "seq": 1})
                applied = _recv_until(ws, "move.applied")
                assert applied["data"]["is_pass"] is True
                assert applied["data"]["color"] == "B"

    async def test_undo(self, api_app, api_svc):
        """人人对弈（热座单连接）：undo → undo.request 回投本机 → undo.respond accept 执行。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                _recv_until(ws, "move.applied")
                _recv_until(ws, "game.state")
                # 当前回合方（白）申请悔棋 → 单连接热座回投 undo.request（人人单步）
                ws.send_json({"type": "undo", "seq": 5})
                req = _recv_until(ws, "undo.request")
                assert req["data"]["color"] == "W"
                assert req["data"]["steps"] == 1
                # 同屏「对方确认」→ 同意
                ws.send_json(
                    {
                        "type": "undo.respond",
                        "data": {"request_id": req["data"]["request_id"], "accept": True},
                    }
                )
                undone = _recv_until(ws, "move.undone")
                _recv_until(ws, "game.state")
        assert undone["data"]["steps"] == 1
        assert undone["data"]["new_last_move_no"] == 0

    async def test_resign(self, api_app, api_svc):
        """认输：即时终局，**不**广播 ``move.applied``（防止末手重播落子动画）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                # 先落子进入 PLAYING（认输仅 PLAYING 允许）
                ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                _recv_until(ws, "move.applied")
                _recv_until(ws, "game.state")
                ws.send_json({"type": "resign", "data": {}})
                finished, between = _recv_collect(ws, "game.state")
        assert finished["data"]["status"] == "finished"
        assert finished["data"]["game"]["result"] == "B+Resign"
        assert "move.applied" not in [m["type"] for m in between]
        finished_msgs = [m for m in between if m["type"] == "game.finished"]
        assert finished_msgs and finished_msgs[0]["data"]["result"] == "B+Resign"

    async def test_scoring_confirm(self, api_app, api_svc):
        """双 PASS → 结算 → scoring.confirm → game.finished。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                # 双 PASS
                ws.send_json({"type": "pass"})
                _recv_until(ws, "move.applied")
                ws.send_json({"type": "pass"})
                _recv_until(ws, "move.applied")
                state = _recv_until(ws, "game.state")
                assert state["data"]["status"] == "scoring"
                # 结算确认
                ws.send_json({"type": "scoring.confirm", "data": {"dead_points": []}})
                finished = _recv_until(ws, "game.finished")
        assert "result" in finished["data"]

    async def test_scoring_cancel_returns_to_playing(self, api_app, api_svc):
        """结算取消：scoring.cancel → 回到 PLAYING（继续对弈，PRD §4.1.8）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "pass"})
                _recv_until(ws, "move.applied")
                ws.send_json({"type": "pass"})
                _recv_until(ws, "move.applied")
                state = _recv_until(ws, "game.state")
                assert state["data"]["status"] == "scoring"
                # 结算取消
                ws.send_json({"type": "scoring.cancel"})
                state2 = _recv_until(ws, "game.state")
        assert state2["data"]["status"] == "active"


class TestStartRestart:
    """T6.4 WS start/restart：开局/续行（AI 先行与 TURN_AI 挂起恢复）与重开。"""

    async def test_start_created_human_ai_ai_first(self, api_app, api_svc):
        """created 人机人类执白（AI 黑先）：start → AI 首手 + active。"""
        gid = await _make_game(
            api_svc,
            mode="human_ai",
            color="W",
            white=PlayerInfo(name="张三", rank="rank_5k"),
            ai=AiParams(style="standard", level=5),
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                state = _recv_until(ws, "game.state")
                assert state["data"]["status"] == "created"
                ws.send_json({"type": "start", "seq": 1})
                applied = _recv_until(ws, "move.applied")
                state2 = _recv_until(ws, "game.state")
        assert applied["data"]["color"] == "B"
        assert applied["data"]["move_no"] == 1
        assert state2["data"]["status"] == "active"
        assert state2["data"]["moves"][-1]["move_no"] == 1

    async def test_start_resumes_pending_ai(self, api_app, api_svc):
        """引擎 DEAD 人类落子后 AI 挂起（TURN_AI）：引擎恢复 → start 触发 AI 落子。"""
        gid = await _make_game(
            api_svc,
            mode="human_ai",
            color="B",
            black=PlayerInfo(name="张三", rank="rank_5k"),
            ai=AiParams(style="standard", level=5),
        )
        submit_orig = api_svc.manager.submit

        async def _dead(*args, **kwargs):
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用")

        api_svc.manager.submit = AsyncMock(side_effect=_dead)
        try:
            with TestClient(api_app) as client:
                with client.websocket_connect(f"/ws/games/{gid}") as ws:
                    _recv_until(ws, "game.state")
                    ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                    applied = _recv_until(ws, "move.applied")
                    assert applied["data"]["color"] == "B"
                    state = _recv_until(ws, "game.state")
                    assert state["data"]["status"] == "active"
                    assert state["data"]["turn"] == "TURN_AI"  # AI 挂起
        finally:
            api_svc.manager.submit = submit_orig
        # 引擎恢复后：start → AI 落子（W，第 2 手）
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "start", "seq": 2})
                ai_applied = _recv_until(ws, "move.applied")
                state2 = _recv_until(ws, "game.state")
        assert ai_applied["data"]["color"] == "W"
        assert state2["data"]["moves"][-1]["move_no"] == 2
        assert state2["data"]["turn"] == "TURN_HUMAN"

    async def test_start_when_human_turn_error(self, api_app, api_svc):
        """active 且轮到人类：start → ILLEGAL_ACTION 错误信封（不重复触发）。"""
        gid = await _make_game(
            api_svc,
            mode="human_ai",
            color="B",
            black=PlayerInfo(name="张三", rank="rank_5k"),
            ai=AiParams(style="standard", level=5),
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "start", "seq": 3})
                state = _recv_until(ws, "game.state")
                assert state["data"]["status"] == "active"  # 激活（人类先，无 AI 落子）
                ws.send_json({"type": "start", "seq": 4})
                err = _recv_until(ws, "error")
        assert err["seq"] == 4
        assert err["code"] == "ILLEGAL_ACTION"

    async def test_restart_clears_game_and_state(self, api_app, api_svc):
        """重开：PLAYING → created，清空落子/悔棋计数归零并广播 game.state。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                _recv_until(ws, "move.applied")
                _recv_until(ws, "game.state")
                ws.send_json({"type": "restart", "seq": 9})
                state = _recv_until(ws, "game.state")
        assert state["data"]["status"] == "created"
        assert state["data"]["moves"] == []
        assert state["data"]["game"]["last_move_no"] == 0
        assert state["data"]["game"]["undo_count"] == 0


class TestUndoConfirm:
    """T6.4 人工确认（2026/09/06）：人人对弈悔棋不限制次数，需对手确认（热座/多设备）。"""

    async def test_hot_seat_undo_decline(self, api_app, api_svc):
        """热座单连接：申请方收到 undo.request → 拒绝 → undo.declined，局面不变。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                _recv_until(ws, "move.applied")
                _recv_until(ws, "game.state")
                ws.send_json({"type": "undo", "seq": 5})
                req = _recv_until(ws, "undo.request")
                ws.send_json(
                    {
                        "type": "undo.respond",
                        "data": {"request_id": req["data"]["request_id"], "accept": False},
                    }
                )
                declined = _recv_until(ws, "undo.declined")
        assert declined["data"]["reason"] == "declined"
        # 局面未变（无 move.undone）
        g = await repos.get_game(api_svc.db.conn, gid)
        assert g["last_move_no"] == 1

    async def test_multi_device_undo_confirm(self, api_app, api_svc):
        """多设备：申请仅发对端；申请方不能替对方确认；对端同意 → 执行广播。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws_a:
                _recv_until(ws_a, "game.state")
                ws_a.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                _recv_until(ws_a, "move.applied")
                _recv_until(ws_a, "game.state")
                with client.websocket_connect(f"/ws/games/{gid}") as ws_b:
                    _recv_until(ws_b, "game.state")
                    # ws_a 申请悔棋 → 仅 ws_b 收到 undo.request（人人单步）
                    ws_a.send_json({"type": "undo", "seq": 6})
                    req = _recv_until(ws_b, "undo.request")
                    rid = req["data"]["request_id"]
                    assert req["data"]["color"] == "W"
                    assert req["data"]["steps"] == 1
                    # 申请方（多连接下）不能替对方确认
                    ws_a.send_json(
                        {"type": "undo.respond", "data": {"request_id": rid, "accept": True}}
                    )
                    err = _recv_until(ws_a, "error")
                    assert err["code"] == "ILLEGAL_ACTION"
                    # 对端同意 → move.undone + game.state 广播到两端
                    ws_b.send_json(
                        {"type": "undo.respond", "data": {"request_id": rid, "accept": True}}
                    )
                    undone_a = _recv_until(ws_a, "move.undone")
                    _recv_until(ws_a, "game.state")
                    undone_b = _recv_until(ws_b, "move.undone")
                    _recv_until(ws_b, "game.state")
        assert undone_a["data"]["steps"] == 1
        assert undone_b["data"]["new_last_move_no"] == 0

    async def test_multi_device_undo_decline(self, api_app, api_svc):
        """多设备：对端拒绝 → 申请方 undo.declined；可再次发起新申请。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws_a:
                _recv_until(ws_a, "game.state")
                ws_a.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                _recv_until(ws_a, "move.applied")
                _recv_until(ws_a, "game.state")
                with client.websocket_connect(f"/ws/games/{gid}") as ws_b:
                    _recv_until(ws_b, "game.state")
                    ws_a.send_json({"type": "undo", "seq": 7})
                    req1 = _recv_until(ws_b, "undo.request")
                    ws_b.send_json(
                        {"type": "undo.respond", "data": {"request_id": req1["data"]["request_id"], "accept": False}}
                    )
                    d1 = _recv_until(ws_a, "undo.declined")
                    assert d1["data"]["reason"] == "declined"
                    # 拒绝后可再次申请（不残留 pending）
                    ws_a.send_json({"type": "undo", "seq": 8})
                    req2 = _recv_until(ws_b, "undo.request")
                    assert req2["data"]["request_id"] != req1["data"]["request_id"]
                    # 申请方撤回（再次发 undo）→ 申请方收到 withdrawn；
                    # 对端也收到同一信封（关闭待确认弹窗/解除锁定）
                    ws_a.send_json({"type": "undo", "seq": 9})
                    d2 = _recv_until(ws_a, "undo.declined")
                    assert d2["data"]["reason"] == "withdrawn"
                    assert d2["data"]["request_id"] == req2["data"]["request_id"]
                    d2b = _recv_until(ws_b, "undo.declined")
                    assert d2b["data"]["reason"] == "withdrawn"

    async def test_undo_human_ai_direct(self, api_app, api_svc):
        """人机对弈：悔棋直通执行（无 undo.request 确认；上限在服务层判定）。"""
        gid = await _make_game(
            api_svc,
            mode="human_ai",
            color="B",
            black=PlayerInfo(name="张三", rank="rank_5k"),
            ai=AiParams(style="standard", level=5),
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                _recv_until(ws, "move.applied")  # 人类黑
                _recv_until(ws, "move.applied")  # AI 白（FakeManager）
                _recv_until(ws, "game.state")
                ws.send_json({"type": "undo", "seq": 3})
                undone = _recv_until(ws, "move.undone")  # 直通，无 undo.request
                _recv_until(ws, "game.state")
        assert undone["data"]["steps"] == 2

    async def test_undo_during_ai_think_ws(self, api_app, api_svc):
        """AI 思考期间 WS 悔棋（2026/09/13）：消息循环不被 AI 应手阻塞——
        悔棋帧即时受理，服务端终止在途查询 → 撤 1 步、AI 不落子。"""
        from tests.fakes import SlowPlayEngine

        engine = SlowPlayEngine()
        api_svc.game._engine = engine  # 挂载可控慢引擎（模拟在途 P0 查询）
        gid = await _make_game(
            api_svc,
            mode="human_ai",
            color="B",
            black=PlayerInfo(name="张三", rank="rank_5k"),
            ai=AiParams(style="standard", level=5),
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                applied = _recv_until(ws, "move.applied")  # 人类黑即时广播
                assert applied["data"]["color"] == "B"
                # 时间窗口轮询：等待 AI 应手查询在途（挂起于慢引擎）
                for _ in range(200):
                    if engine.state["inflight"]:
                        break
                    time.sleep(0.005)
                assert engine.state["inflight"] == 1
                # 悔棋帧仍被即时受理（消息循环未被 AI 应手阻塞）
                ws.send_json({"type": "undo", "seq": 2})
                undone = _recv_until(ws, "move.undone")
                assert undone["data"]["steps"] == 1
                assert undone["data"]["new_last_move_no"] == 0
                _recv_until(ws, "game.state")
        # 已请求终止在途查询（id 带随机后缀：同手数复用会撞旧响应）
        assert len(engine.state["terminated"]) == 1
        assert engine.state["terminated"][0].startswith(f"tgo-ai-{gid}-1-")


class TestUndoRespondFailure:
    """R3（2026/09/16 对弈服务评审批次）：人人悔棋「同意后执行失败」→ 申请方收到终态。

    回归背景：``_h_undo_respond`` 先清申请再执行悔棋；执行失败时错误信封只回
    响应方——申请方收不到 ``undo.declined``/``move.undone``/``game.finished`` 中
    任何一个，前端 ``undoWaiting`` 残留（按钮变「取消悔棋申请」、棋盘锁定）。
    """

    async def test_respond_failure_returns_declined_failed(self, api_app, api_svc):
        gid = await _make_game(api_svc)  # human_human
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                _recv_until(ws, "move.applied")
                _recv_until(ws, "game.state")
                # 当前回合方（白）申请悔棋（单连接热座：回投本机）
                ws.send_json({"type": "undo", "seq": 5})
                req = _recv_until(ws, "undo.request")
                # 使 accept 执行失败：重开对局（回到 created，悔棋 FSM 拒绝）
                ws.send_json({"type": "restart", "seq": 6})
                _recv_until(ws, "game.state")
                ws.send_json(
                    {
                        "type": "undo.respond",
                        "data": {"request_id": req["data"]["request_id"], "accept": True},
                    }
                )
                terminal = None
                for _ in range(20):
                    msg = ws.receive_json()
                    if msg.get("type") in ("undo.declined", "error"):
                        terminal = msg
                        break
        assert terminal is not None, "未收到悔棋终态消息"
        assert terminal["type"] == "undo.declined", f"期望终态 undo.declined，实收: {terminal}"
        assert terminal["data"]["reason"] == "failed"
        assert terminal["data"]["request_id"] == req["data"]["request_id"]


class TestAiFollowupAtomicity:
    """R4（2026/09/16 对弈服务评审批次）：AI 应手收尾「截断复查 + 广播」须持对局锁。

    回归背景：复查在锁外时，悔棋可插在复查与广播之间——客户端先收
    ``move.undone``+``game.state``（截断后），再收迟到 ``move.applied``（已撤之子）；
    前端 ``applyMoveApplied``（``Math.max`` 推进手数）会把该子“复活”到棋盘。
    """

    async def test_followup_broadcast_blocks_concurrent_undo(self, api_svc, monkeypatch):
        from app.api import ws_game as ws_game_mod

        svc = api_svc
        gid = await _make_game(
            svc,
            mode="human_ai",
            color="B",
            black=PlayerInfo(name="张三", rank="rank_5k"),
            ai=AiParams(style="standard", level=5),
        )
        # 人类选点让开 AI 默认选点（FakeManager 默认 D4=(3,3)）
        await svc.game.play(gid, x=15, y=15, color="B", defer_ai=True)

        probe = {"undo_task": None, "blocked": None}
        orig = svc.session.broadcast_to_game

        async def spy(game_id: int, envelope: dict) -> None:
            if envelope.get("type") == "move.applied" and probe["undo_task"] is None:
                probe["undo_task"] = asyncio.create_task(svc.game.undo(gid, color="B"))
                await asyncio.sleep(0.05)  # 时间窗口：给悔棋一次抢锁机会
                if not probe["undo_task"].done():
                    probe["blocked"] = True
            await orig(game_id, envelope)

        monkeypatch.setattr(svc.session, "broadcast_to_game", spy)
        ws_game_mod._spawn_ai_followup(svc, gid)
        for _ in range(200):  # 时间窗口轮询：等到 AI 应手广播开始（悔棋任务已创建）
            await asyncio.sleep(0.005)
            if probe["undo_task"] is not None:
                break
        assert probe["undo_task"] is not None, "未观测到 AI 应手广播"
        await asyncio.wait_for(probe["undo_task"], timeout=2.0)
        assert probe["blocked"] is True, "AI 应手广播期间悔棋未被对局锁挡住（复查与广播非原子）"


class TestStateBroadcastAtomicity:
    """M-3：``game.state`` 快照读取与广播同持对局锁（防迟到旧状态覆盖新状态）。"""

    async def test_snapshot_read_and_broadcast_under_game_lock(self, monkeypatch):
        """旧实现读快照与广播无锁：第二路可在第一路广播前完成，旧快照后到。

        锁定后：第一路持锁期间（快照阻塞在闸门）第二路不得读取/广播；
        放行后按提交顺序输出 [1, 2]。
        """
        from app.api import ws_game as ws_mod

        class StubSession:
            def __init__(self) -> None:
                self.broadcasts: list[int] = []

            async def broadcast_to_game(self, game_id: int, message: dict) -> None:
                self.broadcasts.append(message["data"]["game"]["last_move_no"])

        class StubGame:
            def __init__(self) -> None:
                self.lock = asyncio.Lock()
                self.entered = asyncio.Event()
                self.gate = asyncio.Event()
                self.calls = 0

            def game_lock(self, game_id: int):
                return self.lock

            async def snapshot(self, game_id: int) -> dict:
                self.calls += 1
                seq = self.calls
                if seq == 1:
                    self.entered.set()
                    await self.gate.wait()
                return {"game": {"last_move_no": seq}, "moves": []}

        monkeypatch.setattr(ws_mod, "_public_state", lambda payload: payload)
        svc = types.SimpleNamespace(game=StubGame(), session=StubSession())
        first = asyncio.create_task(ws_mod._broadcast_game_state(svc, 1))
        await svc.game.entered.wait()  # 第一路已持锁并停在快照闸门
        second = asyncio.create_task(ws_mod._broadcast_game_state(svc, 1))
        for _ in range(10):
            await asyncio.sleep(0)
        # 旧实现：第二路已越过快照完成广播（列表非空 → 旧快照晚到）；修复后为空
        assert svc.session.broadcasts == [], "持锁期间第二路不得抢先广播"
        svc.game.gate.set()
        await asyncio.gather(first, second)
        assert svc.session.broadcasts == [1, 2]


class TestCoachingOwnership:
    async def test_analysis_comment_pushed_per_move(self, api_app, api_svc):
        """每手标准分析派送当前手点评（analysis.comment；引擎相关实时数据）。

        对弈页不再经 ``recommend.request``：``main:{N}`` 标准分析落库后，服务端派生
        该手点评并推送（落子方视角，含五档 grade 与 ΔS=score_delta）；重连时回投
        **最近 2 手**点评（旧→新，前端保留最近 2 手圆点，2026/09/11）。
        """
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "play", "data": {"x": 3, "y": 3}})
                msg = _recv_until(ws, "analysis.comment")
                assert msg["data"]["move_no"] == 1
                assert msg["data"]["color"] == "B"
                assert msg["data"]["grade"] in ("blunder", "mistake", "slow", "good", "brilliant")
                assert msg["data"]["x"] == 3 and msg["data"]["y"] == 3
                assert "score_delta" in msg["data"]  # ΔS=目数变化（好手为正）
                ws.send_json({"type": "play", "data": {"x": 15, "y": 15}})
                msg2 = _recv_until(ws, "analysis.comment")
                assert msg2["data"]["move_no"] == 2
            # 重连（restore）：最近 2 手点评回投（旧→新，读持久化派生，不依赖实时推送）
            with client.websocket_connect(f"/ws/games/{gid}") as ws2:
                first = _recv_until(ws2, "analysis.comment")
                second = _recv_until(ws2, "analysis.comment")
                assert [first["data"]["move_no"], second["data"]["move_no"]] == [1, 2]

    async def test_scoring_prediction_pushed_on_double_pass(self, api_app, api_svc):
        """双 PASS 进入结算 → 终局深算预判推送（scoring.prediction）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "pass"})
                _recv_until(ws, "move.applied")
                ws.send_json({"type": "pass"})
                _recv_until(ws, "move.applied")
                msg = _recv_until(ws, "scoring.prediction")
        data = msg["data"]
        assert data["engine"] is True and data["finished"] is True
        assert data["result"] is not None
        assert data["dead_points"] == []  # 空盘无死子

    async def test_ai_pass_completes_double_pass_pushes_prediction(self, api_app, api_svc):
        """BUG-029 回归：AI 应手 PASS 完成双 PASS → 结算预判照常推送。

        人机对弈：人类 PASS(#1) → AI 应手 PASS(#2)。终局标志原先只落在 AI 子结果，
        WS 层未启动预判 → 面板永久停在「AI 正在分析终局局面」（对局 #85 实测）。
        """
        api_svc.manager.response["moveInfos"] = [
            {"move": "pass", "visits": 50, "winrate": 0.55, "scoreLead": 0.0, "pv": []}
        ]
        gid = await _make_game(
            api_svc,
            mode="human_ai",
            color="B",
            black=PlayerInfo(name="张三", rank="rank_5k"),
            ai=AiParams(style="standard", level=5, adaptive=False),
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "pass"})
                _recv_until(ws, "move.applied")  # 人类 PASS
                _recv_until(ws, "move.applied")  # AI 应手 PASS
                state = _recv_until(ws, "game.state")
                assert state["data"]["status"] == "scoring"
                await _await_deep_submit(api_svc)  # 有界等待后台预判提交
                msg = _recv_until(ws, "scoring.prediction")
        assert msg["data"]["game_id"] == gid
        assert msg["data"]["engine"] is True and msg["data"]["finished"] is True

    async def test_scoring_reconnect_resumes_missing_prediction(self, api_app, api_svc):
        """结算态重连且无预判缓存（推送丢失/服务重启）→ 连接即补发起预判（幂等）。"""
        gid = await _make_game(api_svc)
        # 直接构造结算态（不走 WS）：双 PASS + status=scoring，且无任何预判缓存
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", is_pass=True)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=2, color="W", is_pass=True)
        await repos.update_game_status(api_svc.db.conn, gid, "scoring")
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                await _await_deep_submit(api_svc)
                msg = _recv_until(ws, "scoring.prediction")
        assert msg["data"]["game_id"] == gid
        assert msg["data"]["move_no"] == 2
        assert msg["data"]["engine"] is True and msg["data"]["finished"] is True


class TestSettleImported:
    """导入棋谱补结算（2026/09/19 人工决策方案 A）：``scoring.prepare`` 预判 +
    ``scoring.confirm`` 原地结算（finished 且 result 为空，不迁移状态）。"""

    async def _make_unsettled(self, svc) -> int:
        """导入语义：finished + result 为空 + 双 PASS 终局（含末手数同步）。"""
        gid = await _make_game(svc)
        await repos.append_move(svc.db.conn, game_id=gid, move_no=1, color="B", is_pass=True)
        await repos.append_move(svc.db.conn, game_id=gid, move_no=2, color="W", is_pass=True)
        await repos.set_game_last_move_no(svc.db.conn, gid, 2)
        await repos.set_game_result(svc.db.conn, gid, None)
        return gid

    async def test_prepare_pushes_prediction_and_cache_resend(self, api_app, api_svc):
        """``scoring.prepare`` → 终局深算预判推送；再次 prepare 命中缓存直发请求方。"""
        gid = await self._make_unsettled(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "scoring.prepare", "seq": 5})
                msg = _recv_until(ws, "scoring.prediction")
                assert msg["data"]["game_id"] == gid
                assert msg["data"]["move_no"] == 2
                assert msg["data"]["engine"] is True and msg["data"]["finished"] is True
            # 缓存回投：新连接 prepare → 同载荷直发（不再重复深算）
            with client.websocket_connect(f"/ws/games/{gid}") as ws2:
                _recv_until(ws2, "game.state")
                ws2.send_json({"type": "scoring.prepare", "seq": 6})
                cached = _recv_until(ws2, "scoring.prediction")
        assert cached["data"] == msg["data"]

    async def test_confirm_settles_in_place(self, api_app, api_svc):
        """``scoring.confirm`` 对未结算终局原地结算：广播 game.finished + game.state。"""
        gid = await self._make_unsettled(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "scoring.confirm", "data": {"dead_points": []}})
                finished = _recv_until(ws, "game.finished")
                state = _recv_until(ws, "game.state")
        assert finished["data"]["result"]
        assert finished["data"]["black_score"] is not None
        assert state["data"]["status"] == "finished"
        assert state["data"]["game"]["result"] == finished["data"]["result"]

    async def test_confirm_unsettled_uses_cached_prediction(self, api_app, api_svc):
        """未定型终局（导入棋谱末手非双 PASS）：confirm 采用缓存 AI 预判结果为权威结果。

        2026/10/10 人工确认：终局未定型 ⇒ Python 精确数子不稳定（实测预判 W+2 /
        数子 和局）→ 结果取 ``scoring.prediction``；无黑/白目数 → 两值置空。
        """
        gid = await _make_game(api_svc)
        await api_svc.game.play(gid, x=3, y=3, color="B")
        await repos.set_game_result(api_svc.db.conn, gid, None)  # 导入语义：finished 未结算
        # 模拟 SettlementPredictor 已缓存 lead 预判（GTP final_score 等价）
        api_svc.settlement._last[gid] = {
            "game_id": gid, "move_no": 1, "engine": True, "reason": None,
            "finished": False, "dead_points": [], "result": "W+2",
            "black_score": None, "white_score": None, "lead": -2.0,
        }
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "scoring.confirm", "data": {"dead_points": []}})
                finished = _recv_until(ws, "game.finished")
        assert finished["data"] == {
            "result": "W+2",
            "black_score": None,
            "white_score": None,
            "ai_predicted": True,
        }
        assert (await repos.get_game(api_svc.db.conn, gid))["result"] == "W+2"

    async def test_prepare_rejected_on_active(self, api_app, api_svc):
        """进行中对局拒绝结算准备（ILLEGAL_ACTION，复盘入口仅未结算终局可见）。"""
        gid = await _make_game(api_svc)
        await api_svc.game.play(gid, x=3, y=3, color="B")
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "scoring.prepare", "seq": 3})
                err = _recv_until(ws, "error")
        assert err["seq"] == 3 and err["code"] == "ILLEGAL_ACTION"

    async def test_confirm_rejected_on_settled(self, api_app, api_svc):
        """已结算终局（认输）拒绝再次结算（GAME_FINISHED）。"""
        gid = await _make_game(api_svc)
        await api_svc.game.play(gid, x=3, y=3, color="B")
        await api_svc.game.resign(gid, color="B")
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "scoring.confirm", "seq": 2, "data": {"dead_points": []}})
                err = _recv_until(ws, "error")
        assert err["seq"] == 2 and err["code"] == "GAME_FINISHED"

    async def test_coaching_request(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "coaching.request"})
                top5 = _recv_until(ws, "coaching.top5")
        assert isinstance(top5["data"]["moves"], list)
        assert top5["data"]["moves"][0]["x"] == 3  # D4

    async def test_ownership_request_with_existing_data(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        data = {
            "rootInfo": {"currentPlayer": "B", "winrate": 0.5},
            "ownership": [0.2] * 361,
        }
        await repos.upsert_position_analysis(
            api_svc.db.conn, game_id=gid, position_key="main:0",
            data_json=json.dumps(data), max_visits=100,
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "ownership.request", "data": {"move_no": 0}})
                msg = _recv_until(ws, "position.ownership")
        assert msg["data"]["move_no"] == 0
        assert len(msg["data"]["ownership"]) == 361

    async def test_ownership_request_triggers_analysis(self, api_app, api_svc):
        """缺分析数据 → 触发标准分析（P1），结果到达后推送。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "ownership.request", "data": {"move_no": 0}})
                msg = _recv_until(ws, "position.ownership")
        assert msg["data"]["position_key"] == "main:0"
        assert len(msg["data"]["ownership"]) == 361
        assert api_svc.manager.submitted_queries  # 已触发 P1 查询

    async def test_ownership_request_trial(self, api_app, api_svc):
        """试下分支领地：读会话缓存（DATABASE §3.4 试下语义）。"""
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        trial_id = await api_svc.review.trial_enter(gid, 1)
        # 直接写入试下会话缓存（模拟分析结果，仅会话不入库）
        await api_svc.analysis.cache.store(
            gid,
            f"trial:{trial_id}:0",
            {"rootInfo": {"winrate": 0.5}, "ownership": [0.3] * 361},
            max_visits=100,
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json(
                    {"type": "ownership.request", "data": {"trial_id": trial_id, "move_no": 0}}
                )
                msg = _recv_until(ws, "position.ownership")
        assert msg["data"]["position_key"] == f"trial:{trial_id}:0"
        assert len(msg["data"]["ownership"]) == 361

    async def test_ownership_request_engine_down_terminal(self, api_app, api_svc):
        """终态契约（2026/09/12）：任务被丢弃（引擎不可用）也必须回投——
        ``position.ownership(ownership=null)`` 广播 + 请求方错误信封（不得静默悬挂）。"""
        gid = await _make_game(api_svc)
        api_svc.analysis._engine = None  # 引擎槽不可用 → worker 丢弃（engine_unavailable）
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "ownership.request", "data": {"move_no": 0}})
                msg = _recv_until(ws, "position.ownership")
                err = _recv_until(ws, "error")
        assert msg["data"]["position_key"] == "main:0"
        assert msg["data"]["move_no"] == 0
        assert msg["data"]["ownership"] is None
        assert err["code"] == "ENGINE_DEAD"

    async def test_ownership_request_trial_engine_error_terminal(self, api_app, api_svc):
        """终态契约：试下请求的分析任务执行失败（engine_error）→ 空领地回投 + 错误信封。"""
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        trial_id = await api_svc.review.trial_enter(gid, 1)

        async def _boom(query, timeout_s=None):
            raise RuntimeError("engine crashed")

        original_submit = api_svc.manager.submit
        api_svc.manager.submit = _boom
        try:
            with TestClient(api_app) as client:
                with client.websocket_connect(f"/ws/games/{gid}") as ws:
                    _recv_until(ws, "game.state")
                    ws.send_json(
                        {"type": "ownership.request", "data": {"trial_id": trial_id, "move_no": 0}}
                    )
                    msg = _recv_until(ws, "position.ownership")
                    err = _recv_until(ws, "error")
        finally:
            api_svc.manager.submit = original_submit
        assert msg["data"]["position_key"] == f"trial:{trial_id}:0"
        assert msg["data"]["ownership"] is None
        assert err["code"] == "INTERNAL_ERROR"

    async def test_ownership_request_expired_terminal_silent(self, api_app, api_svc):
        """终态契约：过期丢弃（悔棋/重开使在途任务失效）→ 空领地回投、**不发**错误信封。"""
        import threading

        gid = await _make_game(api_svc)
        started = threading.Event()
        release = threading.Event()
        original_submit = api_svc.manager.submit

        async def _gated(query, timeout_s=None):
            started.set()
            await asyncio.get_running_loop().run_in_executor(None, release.wait)
            return await original_submit(query, timeout_s)

        api_svc.manager.submit = _gated
        try:
            with TestClient(api_app) as client:
                with client.websocket_connect(f"/ws/games/{gid}") as ws:
                    _recv_until(ws, "game.state")
                    ws.send_json({"type": "ownership.request", "data": {"move_no": 0}})
                    # 有界等待任务进入执行（时间窗口轮询，禁瞬时断言）
                    for _ in range(100):
                        if started.is_set():
                            break
                        await asyncio.sleep(0.02)
                    assert started.is_set(), "任务未在 2s 窗口内进入执行"
                    api_svc.analysis.bump_version(gid, "main")  # 悔棋/重开 → 结果到达即过期
                    release.set()
                    msg, seen = _recv_collect(ws, "position.ownership")
        finally:
            api_svc.manager.submit = original_submit
        assert msg["data"]["position_key"] == "main:0"
        assert msg["data"]["ownership"] is None
        assert [m for m in seen if m.get("type") == "error"] == []


class TestDeepGlobal:
    async def test_deep_analysis_request(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "deep_analysis.request", "data": {"move_no": 0}})
                msg = _recv_until(ws, "deep_analysis.result")
        assert msg["data"]["position_key"] == "main:0"
        assert "rootInfo" in msg["data"]["result"]

    async def test_deep_analysis_missing_key_rejected(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "deep_analysis.request", "data": {}})
                err = _recv_until(ws, "error")
        assert err["code"] == "INVALID_PAYLOAD"

    async def test_global_analysis_progress_and_done(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "global_analysis.request", "data": {}})
                progress = _recv_until(ws, "analysis.progress")
                done = _recv_until(ws, "global_analysis.done")
        assert progress["data"]["kind"] == "global"
        assert done["data"]["finished"] is True

    async def test_global_analysis_cancel(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                # 未开始的取消不报错（幂等）
                ws.send_json({"type": "global_analysis.cancel"})
                ws.send_json({"type": "ping"})
                _recv_until(ws, "pong")


class TestReviewRecommendTrial:
    """T6.8 复盘协议：recommend.request / 试下分支（后端试下）。"""

    async def test_recommend_request_reads_persisted(self, api_app, api_svc):
        """主谱推荐：读持久化派生（引擎无关），缺数据 → has_data=False。"""
        gid = await _make_game(api_svc)
        data = {
            "rootInfo": {"currentPlayer": "B", "winrate": 0.55, "scoreLead": 0.5},
            "moveInfos": [
                {"move": "D4", "order": 0, "visits": 50, "winrate": 0.6, "scoreLead": 1.0, "pv": ["D4"]}
            ],
        }
        await repos.upsert_position_analysis(
            api_svc.db.conn, game_id=gid, position_key="main:0",
            data_json=json.dumps(data), max_visits=100,
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "recommend.request", "data": {"move_no": 0}})
                msg = _recv_until(ws, "review.recommend")
        assert msg["data"]["has_data"] is True
        assert msg["data"]["position_key"] == "main:0"
        assert msg["data"]["moves"][0]["x"] == 3
        # ISSUE-050：winrate 黑方视角百分比
        assert msg["data"]["moves"][0]["winrate"] == 60.0
        assert msg["data"]["root"] == {"winrate": 55.0, "score_lead": 0.5}

    async def test_recommend_request_no_analysis_empty(self, api_app, api_svc):
        """主谱无持久化分析 → 空载荷（前端 [全局分析] 补全 CTA，不触发实时计算）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "recommend.request", "data": {"move_no": 0}})
                msg = _recv_until(ws, "review.recommend")
        assert msg["data"]["has_data"] is False
        assert msg["data"]["moves"] == []

    async def test_trial_enter_play_undo_back(self, api_app, api_svc):
        """试下闭环：enter → play → undo → back_to_real，trial.state 回投。"""
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "trial.enter", "data": {"move_no": 1}})
                st = _recv_until(ws, "trial.state")
                trial_id = st["data"]["trial_id"]
                assert st["data"]["enter_move_no"] == 1
                assert st["data"]["relative_last"] == 0

                ws.send_json({"type": "trial.play", "data": {"trial_id": trial_id, "x": 15, "y": 15}})
                st = _recv_until(ws, "trial.state")
                assert st["data"]["relative_last"] == 1
                # 试下 color 服务端推导：主谱第 1 手 B → 试下第 2 手应 W
                assert st["data"]["moves"][-1]["color"] == "W"
                assert st["data"]["moves"][-1]["x"] == 15

                ws.send_json({"type": "trial.undo", "data": {"trial_id": trial_id}})
                st = _recv_until(ws, "trial.state")
                assert st["data"]["relative_last"] == 0
                assert st["data"]["moves"] == []

                ws.send_json({"type": "trial.back_to_real", "data": {"trial_id": trial_id}})
                st = _recv_until(ws, "trial.state")
                assert st["data"]["trial_id"] == trial_id

    async def test_trial_play_illegal_point(self, api_app, api_svc):
        """试下禁入/占位落子 → ILLEGAL_MOVE 错误信封。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "trial.enter", "data": {"move_no": 0}})
                st = _recv_until(ws, "trial.state")
                trial_id = st["data"]["trial_id"]
                ws.send_json({"type": "trial.play", "data": {"trial_id": trial_id, "x": 9, "y": 9}})
                _recv_until(ws, "trial.state")
                ws.send_json({"type": "trial.play", "data": {"trial_id": trial_id, "x": 9, "y": 9}})
                err = _recv_until(ws, "error")
        assert err["code"] == "ILLEGAL_MOVE"

    async def test_recommend_request_trial_cache(self, api_app, api_svc):
        """试下推荐：读会话缓存派生 TOP5/点评（仅会话不入库）。"""
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        trial_id = await api_svc.review.trial_enter(gid, 1)
        await api_svc.review.trial_play(gid, trial_id, x=15, y=15, color="W")
        # 直接写入试下会话缓存（模拟试下 P1 结果）
        key = f"trial:{trial_id}:1"
        await api_svc.analysis.cache.store(
            gid, key,
            {"rootInfo": {"currentPlayer": "B", "winrate": 0.6, "scoreLead": 2.0},
             "moveInfos": [
                 {"move": "D4", "order": 0, "visits": 100, "winrate": 0.65, "scoreLead": 2.5, "pv": ["D4"]}
             ]},
            max_visits=100,
        )
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                _recv_until(ws, "game.state")
                ws.send_json({"type": "recommend.request", "data": {"position_key": key}})
                msg = _recv_until(ws, "review.recommend")
        assert msg["data"]["has_data"] is True
        assert msg["data"]["position_key"] == key
        assert msg["data"]["moves"][0]["x"] == 3


class TestDisconnectedChannel:
    """BUG-126（2026/09/21 现场日志）：推送失败使通道状态失效 → 接收侧须按断线收尾。

    现场：`02:57:02 ERROR [app.api.ws_game] WS 对局通道异常 · 对局 #235`，Traceback 落在
    `ws_game.py:95 receive_json()` → `RuntimeError('WebSocket is not connected. Need to
    call "accept" first.')`。该连接**早已失效**（推送遇对端已断开），属预期收尾，不得按
    ERROR + Traceback 上报。用例 ID: API-WS-GAME-47/48。
    """

    async def test_send_failure_marks_channel_disconnected(self, api_svc):
        """机制锁定：推送失败后 starlette 置 DISCONNECTED，下一次 receive_json 抛 RuntimeError。

        若上游 starlette 改变该状态机语义，本用例先红 → 提示复核通道守卫是否仍必要。
        """
        transport = ChannelTransportStub(
            inbound=[{"type": "websocket.connect"}], fail_from_send_index=1
        )
        ws = WebSocket(channel_scope(api_svc), transport.receive, transport.send)
        await ws.accept()
        assert ws.application_state is WebSocketState.CONNECTED

        with pytest.raises(WebSocketDisconnect):
            await ws.send_json({"type": "game.state", "data": {}})

        assert ws.application_state is WebSocketState.DISCONNECTED
        with pytest.raises(RuntimeError, match="not connected"):
            await ws.receive_json()

    async def test_disconnected_channel_closes_quietly(self, api_svc, caplog):
        """对端已断开的推送失败 → 通道按断线收尾：INFO 一条，不得 ERROR。"""
        gid = await _make_game(api_svc)
        transport = ChannelTransportStub(
            inbound=[
                {"type": "websocket.connect"},
                {"type": "websocket.receive", "text": json.dumps({"type": "ping", "seq": 7})},
            ],
            fail_from_send_index=2,  # 第 1 帧 game.state 正常；第 2 帧 pong 遇对端已断开
        )
        ws = WebSocket(channel_scope(api_svc), transport.receive, transport.send)

        with caplog.at_level(logging.DEBUG, logger="app.api.ws_game"):
            await ws_game(ws, gid)

        assert transport.payload_frames == 2, "初始 game.state + 一次 pong 应答"
        assert api_svc.session.game_conn_count(gid) == 0, "通道必须已回收"
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR], (
            "连接早已失效属预期收尾，不得按 ERROR 上报（BUG-126）"
        )
        assert any(
            r.levelno == logging.INFO and "对端已断开" in r.getMessage() for r in caplog.records
        ), "须留一条 INFO 说明通道因对端断开而收尾"
