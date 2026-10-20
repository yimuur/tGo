"""REST 姓名/段位档案路由（TASK T4.3，API §3.2）。

- ``GET /api/players?name=&limit=``：档案列表（创建对局下拉选择用）；
- ``name`` 可选模糊匹配（LIKE `%name%`），按 ``updated_at`` 倒序（最近使用优先）；
- 档案在创建对局时自动 upsert，无显式新增接口（API §3.2）。
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from app.api.deps import get_services
from app.db import repos

router = APIRouter(prefix="/api/players", tags=["players"])


@router.get("")
async def list_players(
    request: Request,
    name: str = Query(default=None, max_length=64, description="姓名模糊匹配"),
    limit: int = Query(default=50, ge=1, le=200, description="返回条数上限"),
) -> list:
    """档案列表（name LIKE 模糊，updated_at 倒序；API §3.2）。"""
    svc = get_services(request)
    return await repos.list_players(svc.db.conn, name=name or None, limit=limit)
