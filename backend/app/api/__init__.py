"""API 接入层：REST 路由、WebSocket 通道、Pydantic Schemas。

``register_api_routes(app)``：统一挂载 REST（games/players/admin）与
WS（/ws/games、/ws/admin）路由（TASK T4.2-T4.6）。
"""

from __future__ import annotations

from fastapi import FastAPI


def register_api_routes(app: FastAPI) -> None:
    """挂载 Phase 4 全部 REST 与 WS 路由（API.md 强绑定）。"""
    from app.api.routes_admin import router as admin_router
    from app.api.routes_games import router as games_router
    from app.api.routes_players import router as players_router
    from app.api.ws_admin import router as ws_admin_router
    from app.api.ws_game import router as ws_game_router

    app.include_router(games_router)
    app.include_router(players_router)
    app.include_router(admin_router)
    app.include_router(ws_game_router)
    app.include_router(ws_admin_router)
