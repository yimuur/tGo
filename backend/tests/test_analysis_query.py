"""T2.6 分析查询构建测试：标准/深度/支招。

用例 ID: AQ-*
全局分析无查询工厂（服务层用 `build_standard_query` 逐局面构造 + 覆写 P3 优先级），
故不在此测试。
"""

from app.engine.analysis_query import (
    PRIORITY_DEEP,
    PRIORITY_GLOBAL,
    PRIORITY_STANDARD,
    build_coaching_query,
    build_deep_query,
    build_standard_query,
)
from app.engine.play_query import PRIORITY_PLAY


def _moves():
    return [
        {"color": "B", "x": 2, "y": 15},
        {"color": "W", "x": 15, "y": 3},
    ]


class TestStandardQuery:
    def test_priority_and_visits(self):
        q = build_standard_query(board_size=19, rules="chinese", komi=7.5, moves=_moves(), max_visits=100)
        assert q["priority"] == PRIORITY_STANDARD
        assert q["maxVisits"] == 100
        assert q["includeOwnership"] is True
        assert "analyzeTurns" not in q  # 单局面（默认最后一手）

    def test_moves_converted(self):
        q = build_standard_query(board_size=19, rules="chinese", komi=7.5, moves=_moves(), max_visits=100)
        assert q["moves"] == [["B", "C4"], ["W", "Q16"]]
        assert q["boardXSize"] == 19


class TestDeepQuery:
    def test_uses_deep_max_visits(self):
        q = build_deep_query(board_size=19, rules="chinese", komi=7.5, moves=_moves(), deep_max_visits=800)
        assert q["maxVisits"] == 800
        assert q["priority"] == PRIORITY_DEEP


class TestCoachingQuery:
    def test_coaching_shares_deep_visits_and_priority(self):
        q = build_coaching_query(board_size=19, rules="chinese", komi=7.5, moves=_moves(), deep_max_visits=800)
        assert q["maxVisits"] == 800
        assert q["priority"] == PRIORITY_DEEP


def test_priority_ordering():
    """P0 对弈 > P1 标准 > P2 深度/支招 > P3 全局。"""
    assert PRIORITY_PLAY > PRIORITY_STANDARD > PRIORITY_DEEP > PRIORITY_GLOBAL
