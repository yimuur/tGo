"""API/WS 输出边界公共表示（T6.1 协议收口）。

- ``to_public_game``：``games`` 表行 → 前端公开字段子集（**白名单 Schema**，
  剔除内部实现字段 ``parent_game_id``/``*_player_id``/``adaptive_initial_level``；
  保留前端所需：``undo_count``（UI_UX W-03 悔棋剩余展示）、``ai_level``/
  ``adaptive_enabled``/``black_captures``/``white_captures`` 等）；
- ``GameInfo``：对局公共信息 Pydantic Schema（REST ``response_model`` 与
  WS ``game.state.data.game`` 共用，防止内部实现泄漏到前端协议）；
- ``winrate_to_percent``：KataGo 0..1 胜率 → 0..100 百分比（round 2），
  ISSUE-050 方案一：API/WS 输出侧统一换算（内部存储保持 0..1 黑方视角）。
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

#: games 对外公开字段（剔除内部列；新增 DB 列需在此显式加入后才对外可见）
GAME_INFO_FIELDS: tuple[str, ...] = (
    "id",
    "mode",
    "board_size",
    "rules",
    "komi",
    "handicap",
    "human_color",
    "status",
    "result",
    "black_name",
    "black_rank",
    "white_name",
    "white_rank",
    "ai_style",
    "ai_level",
    "adaptive_enabled",
    "coaching_enabled",
    "favorite",
    "last_move_no",
    "created_at",
    "updated_at",
    "finished_at",
    "black_captures",
    "white_captures",
    "undo_count",
)


class GameInfo(BaseModel):
    """对局公共信息（games 白名单 Schema，extra=forbid 防内部字段泄漏）。"""

    model_config = ConfigDict(extra="forbid")

    id: int
    mode: str
    board_size: int
    rules: str
    komi: Optional[float] = None
    handicap: int = 0
    human_color: Optional[str] = None
    status: str
    result: Optional[str] = None
    black_name: str = "真人"
    black_rank: Optional[str] = None
    white_name: str = "真人"
    white_rank: Optional[str] = None
    ai_style: Optional[str] = None
    ai_level: Optional[int] = None
    adaptive_enabled: bool = False
    coaching_enabled: bool = False
    favorite: bool = False
    last_move_no: int = 0
    created_at: str
    updated_at: str
    finished_at: Optional[str] = None
    black_captures: int = 0
    white_captures: int = 0
    undo_count: int = 0


def to_public_game(row: dict) -> dict:
    """``games`` 行 → 公共字段子集（REST/WS 共用，JSON 类型归一）。"""
    subset = {k: row[k] for k in GAME_INFO_FIELDS if k in row}
    return GameInfo.model_validate(subset).model_dump()


class GameListResponse(BaseModel):
    """对局列表响应（API §3.1；items 为 GameInfo 白名单）。

    ``focus_page``：请求携带 ``focus_id`` 时返回该对局在当前过滤/排序下所在页码
    （1 基）；不存在或不匹配过滤 → null（前端「复盘返回列表」跨页定位用，
    2026/09/14）。未携带 ``focus_id`` 时恒为 null。
    """

    model_config = ConfigDict(extra="forbid")

    total: int
    items: list[GameInfo]
    focus_page: Optional[int] = None


class GameDetailResponse(GameInfo):
    """对局详情响应（GameInfo + 落子序列 + 分析统计；analysis_complete 决定报告入口）。"""

    moves: list = Field(default_factory=list, description="落子序列（DB 行）")
    moves_count: int = 0
    analyses_count: int = 0
    analysis_complete: bool = False
    #: 终局结算目数（scorings 行；**仅双 PASS 确认结算后非空**，认输/未结算为 null）
    black_score: Optional[float] = None
    white_score: Optional[float] = None


def winrate_to_percent(value: Optional[float]) -> Optional[float]:
    """KataGo 0..1 胜率 → 0..100 百分比（round 2，ISSUE-050 方案一输出换算）。

    非数值（None/缺失）原样返回（保持字段可缺省语义，向后兼容）。
    """
    if value is None:
        return None
    try:
        return round(float(value) * 100.0, 2)
    except (TypeError, ValueError):
        return None
