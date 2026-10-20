"""T0.3 统一错误框架测试：错误码完整性、AppError、HTTP/WS 响应结构。

用例 ID: ERR-*
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.core.errors import (
    ALL_ERROR_CODES,
    AppError,
    ErrorCode,
    HTTP_STATUS,
    error_response_body,
    register_error_handlers,
)


class TestErrorCodeCatalog:
    """错误码完整性：覆盖 API §2 全表，且均有 HTTP 状态映射。"""

    def test_all_codes_have_http_status(self):
        assert len(ALL_ERROR_CODES) == 28
        for code in ALL_ERROR_CODES:
            assert code in HTTP_STATUS, f"{code} 缺少 HTTP 状态映射"

    def test_required_codes_present(self):
        required = {
            "INVALID_PAYLOAD",
            "GAME_NOT_FOUND",
            "GAME_FINISHED",
            "GAME_IN_SCORING",
            "ILLEGAL_ACTION",
            "ILLEGAL_MOVE",
            "UNDO_LIMIT_REACHED",
            "UNDO_PENDING",
            "ENGINE_BUSY",
            "ENGINE_DEAD",
            "ENGINE_FATAL",
            "HUMAN_MODEL_UNAVAILABLE",
            "ANALYSIS_INCOMPLETE",
            "PLAYER_NOT_FOUND",
            "PLAYER_INVALID_RANK",
            "SGF_INVALID",
            "SGF_TOO_LARGE",
            "REPLAY_CONFLICT",
            "DEEP_ANALYSIS_RUNNING",
            "NETWORK_ERROR",
            "ASSET_NOT_FOUND",
            "UPDATE_UNSUPPORTED",
            "UPDATE_IN_PROGRESS",
            "UPDATE_FAILED",
            "UNSUPPORTED_PLATFORM",
            "CHECKSUM_MISMATCH",
            "DOWNLOAD_TOO_LARGE",
            "INTERNAL_ERROR",
        }
        assert {c.value for c in ALL_ERROR_CODES} == required


class TestAppError:
    def test_carries_code_message_status(self):
        err = AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
        assert err.code == ErrorCode.GAME_NOT_FOUND
        assert err.message == "对局不存在"
        assert err.status_code == 404

    def test_str_code_coerced(self):
        err = AppError("GAME_NOT_FOUND", "对局不存在")
        assert err.code == ErrorCode.GAME_NOT_FOUND

    def test_custom_status_override(self):
        err = AppError(ErrorCode.ILLEGAL_MOVE, "禁入点", status_code=400)
        assert err.status_code == 400

    def test_to_dict_structure(self):
        err = AppError(ErrorCode.ENGINE_DEAD, "引擎已崩溃")
        assert err.to_dict() == {"code": "ENGINE_DEAD", "message": "引擎已崩溃"}

    def test_to_ws_envelope(self):
        err = AppError(ErrorCode.ILLEGAL_MOVE, "禁入点")
        env = err.to_ws_envelope(seq=42)
        assert env == {"type": "error", "seq": 42, "code": "ILLEGAL_MOVE", "message": "禁入点"}

    def test_to_ws_envelope_without_seq(self):
        err = AppError(ErrorCode.ENGINE_BUSY, "引擎忙")
        assert "seq" not in err.to_ws_envelope()

    def test_replay_conflict_status_409(self):
        """ISSUE-064：回放失败→领域化错误码，HTTP 409（非 500 内部错误）。"""
        err = AppError(ErrorCode.REPLAY_CONFLICT, "对局记录无法回放")
        assert err.status_code == 409


class TestErrorResponseBody:
    def test_body_structure(self):
        assert error_response_body("ENGINE_FATAL", "引擎连续崩溃") == {
            "code": "ENGINE_FATAL",
            "message": "引擎连续崩溃",
        }


def _build_test_app() -> FastAPI:
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/boom/app-error")
    async def _app_error():
        raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")

    @app.post("/boom/validation")
    async def _validation(body: _Body):
        return {"ok": body.x}

    @app.get("/boom/internal")
    async def _internal():
        raise ValueError("secret-traceback-detail")

    return app


class _Body(BaseModel):
    x: int


class TestHttpMapping:
    """HTTP 错误响应统一 `{code, message}`，且不泄露 Traceback。"""

    def setup_method(self):
        # raise_server_exceptions=False：允许验证 500 响应体（默认会重抛异常）
        self.client = TestClient(_build_test_app(), raise_server_exceptions=False)

    def test_app_error_mapped(self):
        resp = self.client.get("/boom/app-error")
        assert resp.status_code == 404
        assert resp.json() == {"code": "GAME_NOT_FOUND", "message": "对局不存在"}

    def test_validation_error_mapped(self):
        resp = self.client.post("/boom/validation", json={"x": "not-an-int"})
        assert resp.status_code == 422
        body = resp.json()
        assert body["code"] == "INVALID_PAYLOAD"
        assert set(body.keys()) == {"code", "message"}

    def test_unexpected_error_masked(self):
        resp = self.client.get("/boom/internal")
        assert resp.status_code == 500
        body = resp.json()
        assert body == {"code": "INTERNAL_ERROR", "message": "服务器内部错误"}
        assert "secret-traceback-detail" not in resp.text
