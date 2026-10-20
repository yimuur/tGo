"""API 层依赖助手（REST/WS 路由访问应用服务容器）。"""

from __future__ import annotations

from fastapi import Request, WebSocket

from app.bootstrap import AppServices
from app.core.errors import AppError, ErrorCode


def get_services(request: Request) -> AppServices:
    """从请求上下文取服务容器（lifespan 装配；未装配快速失败）。"""
    svc: AppServices = getattr(request.app.state, "services", None)
    if svc is None:
        raise AppError(ErrorCode.INTERNAL_ERROR, "服务未初始化")
    return svc


def get_services_ws(websocket: WebSocket) -> AppServices:
    """从 WebSocket 上下文取服务容器（lifespan 装配）。"""
    svc: AppServices = getattr(websocket.app.state, "services", None)
    if svc is None:
        raise AppError(ErrorCode.INTERNAL_ERROR, "服务未初始化")
    return svc
