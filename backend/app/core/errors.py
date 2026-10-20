"""统一错误框架：错误码、AppError、HTTP/WS 错误响应（API §2）。

约定（API §1 / AGENTS.md §5）：
- 所有接口错误响应统一 JSON 结构 `{"code": ..., "message": ...}`；
- 不向前端泄露 Traceback；未预期异常在框架边界统一映射为 INTERNAL_ERROR 并记录日志；
- WebSocket 错误信封 `{"type": "error", "seq": ..., "code": ..., "message": ...}`。
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)


class ErrorCode(str, Enum):
    """统一错误码（API §2 错误码表全集）。"""

    INVALID_PAYLOAD = "INVALID_PAYLOAD"
    GAME_NOT_FOUND = "GAME_NOT_FOUND"
    GAME_FINISHED = "GAME_FINISHED"
    GAME_IN_SCORING = "GAME_IN_SCORING"
    ILLEGAL_ACTION = "ILLEGAL_ACTION"
    ILLEGAL_MOVE = "ILLEGAL_MOVE"
    UNDO_LIMIT_REACHED = "UNDO_LIMIT_REACHED"
    UNDO_PENDING = "UNDO_PENDING"
    ENGINE_BUSY = "ENGINE_BUSY"
    ENGINE_DEAD = "ENGINE_DEAD"
    ENGINE_FATAL = "ENGINE_FATAL"
    HUMAN_MODEL_UNAVAILABLE = "HUMAN_MODEL_UNAVAILABLE"
    ANALYSIS_INCOMPLETE = "ANALYSIS_INCOMPLETE"
    PLAYER_NOT_FOUND = "PLAYER_NOT_FOUND"
    PLAYER_INVALID_RANK = "PLAYER_INVALID_RANK"
    SGF_INVALID = "SGF_INVALID"
    SGF_TOO_LARGE = "SGF_TOO_LARGE"
    REPLAY_CONFLICT = "REPLAY_CONFLICT"
    DEEP_ANALYSIS_RUNNING = "DEEP_ANALYSIS_RUNNING"
    # ---- 更新 / 下载（管理页「版本与资源」卡，2026/10/18） ----
    NETWORK_ERROR = "NETWORK_ERROR"
    ASSET_NOT_FOUND = "ASSET_NOT_FOUND"
    UPDATE_UNSUPPORTED = "UPDATE_UNSUPPORTED"
    UPDATE_IN_PROGRESS = "UPDATE_IN_PROGRESS"
    UPDATE_FAILED = "UPDATE_FAILED"
    UNSUPPORTED_PLATFORM = "UNSUPPORTED_PLATFORM"
    CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH"
    DOWNLOAD_TOO_LARGE = "DOWNLOAD_TOO_LARGE"
    INTERNAL_ERROR = "INTERNAL_ERROR"


#: 错误码 → HTTP 状态码映射
HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.INVALID_PAYLOAD: 422,
    ErrorCode.GAME_NOT_FOUND: 404,
    ErrorCode.GAME_FINISHED: 409,
    ErrorCode.GAME_IN_SCORING: 409,
    ErrorCode.ILLEGAL_ACTION: 409,
    ErrorCode.ILLEGAL_MOVE: 400,
    ErrorCode.UNDO_LIMIT_REACHED: 409,
    ErrorCode.UNDO_PENDING: 409,
    ErrorCode.ENGINE_BUSY: 409,
    ErrorCode.ENGINE_DEAD: 503,
    ErrorCode.ENGINE_FATAL: 503,
    ErrorCode.HUMAN_MODEL_UNAVAILABLE: 503,
    ErrorCode.ANALYSIS_INCOMPLETE: 422,
    ErrorCode.PLAYER_NOT_FOUND: 404,
    ErrorCode.PLAYER_INVALID_RANK: 422,
    ErrorCode.SGF_INVALID: 422,
    ErrorCode.SGF_TOO_LARGE: 413,
    ErrorCode.REPLAY_CONFLICT: 409,
    ErrorCode.DEEP_ANALYSIS_RUNNING: 409,
    ErrorCode.NETWORK_ERROR: 502,
    ErrorCode.ASSET_NOT_FOUND: 404,
    ErrorCode.UPDATE_UNSUPPORTED: 409,
    ErrorCode.UPDATE_IN_PROGRESS: 409,
    ErrorCode.UPDATE_FAILED: 500,
    ErrorCode.UNSUPPORTED_PLATFORM: 422,
    ErrorCode.CHECKSUM_MISMATCH: 422,
    ErrorCode.DOWNLOAD_TOO_LARGE: 413,
    ErrorCode.INTERNAL_ERROR: 500,
}

#: 所有错误码（测试与完整性校验用）
ALL_ERROR_CODES: tuple[ErrorCode, ...] = tuple(ErrorCode)


class AppError(Exception):
    """业务异常：携带统一错误码与面向用户的错误信息。

    用法：``raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")``
    """

    def __init__(
        self,
        code: ErrorCode | str,
        message: str,
        *,
        status_code: Optional[int] = None,
    ) -> None:
        self.code = ErrorCode(code)
        self.message = message
        self.status_code = status_code or HTTP_STATUS[self.code]
        super().__init__(self.message)

    def to_dict(self) -> dict[str, str]:
        """HTTP 错误响应体（统一结构）。"""
        return {"code": self.code.value, "message": self.message}

    def to_ws_envelope(self, seq: Optional[int] = None) -> dict[str, Any]:
        """WebSocket 错误信封 `{type, seq?, code, message}`。"""
        envelope: dict[str, Any] = {
            "type": "error",
            "code": self.code.value,
            "message": self.message,
        }
        if seq is not None:
            envelope["seq"] = seq
        return envelope


def error_response_body(code: ErrorCode | str, message: str) -> dict[str, str]:
    """构造统一错误响应体。"""
    return AppError(ErrorCode(code), message).to_dict()


def register_error_handlers(app: FastAPI) -> None:
    """注册框架级错误处理器（业务错误 / 校验错误 / 未预期异常）。

    - AppError → 对应 HTTP 状态码 + `{code, message}`；
    - Pydantic 校验失败 → 422 `INVALID_PAYLOAD`（不泄露字段细节）；
    - 未预期异常 → 500 `INTERNAL_ERROR`（记录完整 Traceback 供排查，响应不泄露）。
    """

    @app.exception_handler(AppError)
    async def _app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_dict())

    @app.exception_handler(RequestValidationError)
    async def _validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        err = AppError(ErrorCode.INVALID_PAYLOAD, "请求参数校验失败")
        return JSONResponse(status_code=err.status_code, content=err.to_dict())

    @app.exception_handler(Exception)
    async def _unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
        # 框架边界兜底：精确记录异常，对外统一 INTERNAL_ERROR，不泄露 Traceback
        logger.exception("未预期异常：%s %s —— %r", request.method, request.url.path, exc)
        err = AppError(ErrorCode.INTERNAL_ERROR, "服务器内部错误")
        return JSONResponse(status_code=err.status_code, content=err.to_dict())
