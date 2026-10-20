"""分析查询工厂（ARCHITECTURE §3.4 优先级 / PRD §4.2，ISSUE-001 推荐值）。

- 标准分析（P1）：每手曲线 / 试下实时胜率 / AI 推荐；
- 深度分析（P2）：`deep.max_visits` 深算（领地/曲线/推荐/点评按最新结果展示）；
- 支招（P2）：使用**深度分析** `maxVisits`（PRD §4.1.5）；

**全局分析（P3）无查询工厂**：逐手补分析由服务层用 `build_standard_query`（链精度
`maxVisits`）+ 覆写 `priority = PRIORITY_GLOBAL` 逐局面构造（ISSUES 决策：单局面单查询，
规避 `analyzeTurns` 多响应按 id 路由丢失；见 `review_service.global_analyze`）。
"""

from __future__ import annotations

from typing import Iterable, Optional

from app.engine.play_query import move_to_gtp, stone_to_gtp

#: 分析优先级（P1-P3；对弈 P0 = PRIORITY_PLAY 见 play_query）
PRIORITY_STANDARD = 80
PRIORITY_DEEP = 50
PRIORITY_GLOBAL = 10


def _base_position_query(
    *,
    board_size: int,
    rules: str,
    komi: float,
    moves: Iterable[dict],
    initial_stones: Optional[Iterable[dict]],
    max_visits: int,
    priority: int,
    analysis_pv_len: int = 10,
    include_ownership: bool = True,
) -> dict:
    query: dict = {
        "moves": [move_to_gtp(m, board_size=board_size) for m in moves],
        "rules": rules,
        "komi": komi,
        "boardXSize": board_size,
        "boardYSize": board_size,
        "maxVisits": max_visits,
        "analysisPVLen": analysis_pv_len,
        "includeOwnership": include_ownership,
        "priority": priority,
    }
    if initial_stones:
        query["initialStones"] = [
            stone_to_gtp(s, board_size=board_size) for s in initial_stones
        ]
    return query


def build_standard_query(
    *,
    board_size: int,
    rules: str,
    komi: float,
    moves: Iterable[dict],
    max_visits: int,
    initial_stones: Optional[Iterable[dict]] = None,
    analysis_pv_len: int = 10,
) -> dict:
    """标准分析查询（P1）：分析当前局面（默认最后一手）。"""
    return _base_position_query(
        board_size=board_size,
        rules=rules,
        komi=komi,
        moves=moves,
        initial_stones=initial_stones,
        max_visits=max_visits,
        priority=PRIORITY_STANDARD,
        analysis_pv_len=analysis_pv_len,
    )


def build_deep_query(
    *,
    board_size: int,
    rules: str,
    komi: float,
    moves: Iterable[dict],
    deep_max_visits: int,
    initial_stones: Optional[Iterable[dict]] = None,
    analysis_pv_len: int = 10,
) -> dict:
    """深度分析查询（P2，`deep.max_visits`）。"""
    return _base_position_query(
        board_size=board_size,
        rules=rules,
        komi=komi,
        moves=moves,
        initial_stones=initial_stones,
        max_visits=deep_max_visits,
        priority=PRIORITY_DEEP,
        analysis_pv_len=analysis_pv_len,
    )


def build_coaching_query(
    *,
    board_size: int,
    rules: str,
    komi: float,
    moves: Iterable[dict],
    deep_max_visits: int,
    initial_stones: Optional[Iterable[dict]] = None,
    analysis_pv_len: int = 10,
) -> dict:
    """支招查询（P2）：使用深度分析 `maxVisits`（PRD §4.1.5 同优先级调度）。"""
    return _base_position_query(
        board_size=board_size,
        rules=rules,
        komi=komi,
        moves=moves,
        initial_stones=initial_stones,
        max_visits=deep_max_visits,
        priority=PRIORITY_DEEP,
        analysis_pv_len=analysis_pv_len,
    )


