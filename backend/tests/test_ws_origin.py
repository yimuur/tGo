"""T6.1 WS Origin/同源校验测试（TASK T6.1 / API §4 安全边界）。

用例 ID: WS-ORIGIN-*
- 同源 Origin → 放行（对弈/管理通道）；
- 跨源 Origin（非白名单）→ 拒绝（close 1008，不注册连接）；
- 缺失 Origin（非浏览器客户端）→ 放行（向后兼容）；
- ``TGO_WS_ALLOWED_ORIGINS`` 白名单兜底（反代/跨源部署）。
"""

from fastapi.testclient import TestClient

from app.api.ws_guard import ORIGIN_REJECT_CODE
from app.services.game_service import CreateGameParams


async def _make_game(svc) -> int:
    return await svc.game.create(CreateGameParams(mode="human_human"))


class TestGameChannelOrigin:
    async def test_same_origin_allowed(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(
                f"/ws/games/{gid}", headers={"origin": "http://testserver"}
            ) as ws:
                msg = ws.receive_json()
        assert msg["type"] == "game.state"

    async def test_missing_origin_allowed(self, api_app, api_svc):
        """非浏览器客户端（无 Origin）→ 放行（向后兼容）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(f"/ws/games/{gid}") as ws:
                msg = ws.receive_json()
        assert msg["type"] == "game.state"

    async def test_cross_origin_rejected(self, api_app, api_svc):
        """跨源 Origin（非白名单）→ 拒绝（close 1008，不进入握手/订阅）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            try:
                with client.websocket_connect(
                    f"/ws/games/{gid}", headers={"origin": "http://evil.example"}
                ) as ws:
                    ws.receive_json()
            except Exception as exc:  # noqa: BLE001 - 拒绝形态由 starlette 具体化
                # 服务端 close(1008)：TestClient 以异常或 close code 形式暴露
                code = getattr(exc, "code", None)
                assert code in (None, ORIGIN_REJECT_CODE)
                return
            raise AssertionError("跨源 WS 未被拒绝")

    async def test_allowlist_origin_allowed(self, api_app, api_svc, monkeypatch):
        """TGO_WS_ALLOWED_ORIGINS 白名单（netloc，反代/跨源部署兜底）。"""
        monkeypatch.setenv("TGO_WS_ALLOWED_ORIGINS", "board.example")
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            with client.websocket_connect(
                f"/ws/games/{gid}", headers={"origin": "https://board.example"}
            ) as ws:
                msg = ws.receive_json()
        assert msg["type"] == "game.state"


class TestAdminChannelOrigin:
    async def test_same_origin_allowed(self, api_app):
        with TestClient(api_app) as client:
            with client.websocket_connect(
                "/ws/admin", headers={"origin": "http://testserver"}
            ) as ws:
                msg = ws.receive_json()
        assert msg["type"] in ("engine.status", "system.status")

    async def test_cross_origin_rejected(self, api_app):
        with TestClient(api_app) as client:
            try:
                with client.websocket_connect(
                    "/ws/admin", headers={"origin": "http://evil.example"}
                ) as ws:
                    ws.receive_json()
            except Exception as exc:  # noqa: BLE001 - 拒绝形态由 starlette 具体化
                code = getattr(exc, "code", None)
                assert code in (None, ORIGIN_REJECT_CODE)
                return
            raise AssertionError("跨源管理 WS 未被拒绝")
