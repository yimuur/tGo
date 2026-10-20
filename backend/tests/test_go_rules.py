"""T3.3 围棋规则引擎测试（吃子/禁入/打劫，TASK T3.3）。

用例 ID: RULES-*
"""

import pytest

from app.services.go_rules import (
    GoBoard,
    GoRulesError,
    build_board,
    handicap_limit,
    handicap_points,
)


class TestBasic:
    def test_initial_board_empty(self):
        b = GoBoard(9)
        assert b.stone_at(4, 4) is None
        assert b.ko_point is None

    def test_place_stone(self):
        b = GoBoard(9)
        assert b.play(3, 3, "B") == 0
        assert b.stone_at(3, 3) == "B"

    def test_occupied_point_rejected(self):
        b = GoBoard(9)
        b.play(0, 0, "B")
        with pytest.raises(GoRulesError):
            b.play(0, 0, "W")

    def test_out_of_bounds_rejected(self):
        b = GoBoard(9)
        with pytest.raises(GoRulesError):
            b.play(-1, 0, "B")
        with pytest.raises(GoRulesError):
            b.play(9, 0, "B")
        with pytest.raises(GoRulesError):
            b.play(0, 9, "B")

    def test_unsupported_size(self):
        with pytest.raises(ValueError):
            GoBoard(7)


class TestCapture:
    """吃子规则。"""

    def test_capture_single_stone(self):
        b = GoBoard(19)
        b.play(8, 9, "B")
        b.play(9, 9, "W")
        b.play(10, 9, "B")
        b.play(9, 8, "B")
        captured = b.play(9, 10, "B")  # 填最后一气 → 提 W(9,9)
        assert captured == 1
        assert b.stone_at(9, 9) is None

    def test_capture_group(self):
        b = GoBoard(19)
        b.play(9, 9, "W")
        b.play(10, 9, "W")
        for p in [(9, 10), (10, 10), (9, 8), (10, 8), (8, 9)]:
            b.play(*p, "B")
        captured = b.play(11, 9, "B")  # 填最后一气 → 提 2 子
        assert captured == 2
        assert b.stone_at(9, 9) is None
        assert b.stone_at(10, 9) is None

    def test_capture_does_not_affect_board_rest(self):
        b = GoBoard(19)
        b.play(8, 9, "B")
        b.play(9, 9, "W")
        b.play(10, 9, "B")
        b.play(9, 8, "B")
        b.play(9, 10, "B")
        assert b.stone_at(9, 9) is None
        assert b.stone_at(8, 9) == "B"
        assert b.stone_at(9, 10) == "B"


class TestSuicide:
    """禁入点（自杀）。"""

    def test_suicide_rejected(self):
        b = GoBoard(19)
        for p in [(8, 9), (10, 9), (9, 8), (9, 10)]:
            b.play(*p, "W")
        with pytest.raises(GoRulesError):
            b.play(9, 9, "B")  # 四邻全为 W → 自杀

    def test_capture_saves_from_suicide(self):
        """提子后可落子（非自杀）。"""
        b = GoBoard(19)
        b.play(8, 9, "B")
        b.play(9, 9, "W")
        b.play(10, 9, "B")
        b.play(9, 8, "B")
        # B 落 (9,10)：填气并提 W(9,9)，自身有气（非自杀）
        captured = b.play(9, 10, "B")
        assert captured == 1
        assert b.stone_at(9, 9) is None


class TestKo:
    """简单劫规则。"""

    def _ko_position(self) -> GoBoard:
        """构造经典劫：B 单子 (9,9) 仅一气 (9,8)，W 落 (9,8) 提子后劫点 (9,9) 禁入。"""
        b = GoBoard(19)
        b.play(8, 9, "W")
        b.play(10, 9, "W")
        b.play(9, 10, "W")
        b.play(9, 9, "B")  # 单子，仅 (9,8) 一气
        captured = b.play(9, 8, "W")  # 提 B(9,9)
        assert captured == 1
        return b

    def test_ko_capture_sets_ko_point(self):
        b = self._ko_position()
        assert b.ko_point == (9, 9)

    def test_ko_recapture_rejected(self):
        b = self._ko_position()
        with pytest.raises(GoRulesError):
            b.play(9, 9, "B")  # 劫点禁入

    def test_ko_resolved_after_elsewhere(self):
        b = self._ko_position()
        b.play(0, 0, "B")  # 他处落子 → 劫解除
        assert b.ko_point is None

    def test_ko_point_only_single_capture(self):
        """提多子不产生劫点。"""
        b = GoBoard(19)
        b.play(9, 9, "W")
        b.play(10, 9, "W")
        for p in [(9, 10), (10, 10), (9, 8), (10, 8), (8, 9)]:
            b.play(*p, "B")
        b.play(11, 9, "B")  # 提 2 子
        assert b.ko_point is None

    def _snapback_position(self) -> GoBoard:
        """倒扑（snapback）形：B 落 (1,1) 提 W(1,0)（恰提一子）后，B 六子串仅剩一气 (1,0)。

        B(0,0)/(0,1) 串、B(2,0)/(2,1) 串、B(1,2) 与 W 单子 (1,0) 均仅一气 (1,1)；
        B 落 (1,1) 提 W(1,0) 后三串连通，仅一气 (1,0)——W 回提 (1,0) 提回六子。
        """
        b = GoBoard(19)
        for x, y in [(0, 0), (2, 0), (0, 1), (2, 1), (1, 2)]:
            b.play(x, y, "B")
        for x, y in [(1, 0), (3, 0), (0, 2), (3, 1), (2, 2), (1, 3)]:
            b.play(x, y, "W")
        captured = b.play(1, 1, "B")  # 提 W(1,0) → 劫点 (1,0)
        assert captured == 1
        return b

    def test_ko_snapback_recapture_multiple_allowed(self):
        """回提多子（倒扑）合法：劫点回提提回整串六子 → 不复现上一手前局面，非打劫。"""
        b = self._snapback_position()
        assert b.ko_point == (1, 0)
        captured = b.play(1, 0, "W")  # 回提：B 六子串整体被提
        assert captured == 6
        assert b.ko_point is None  # 提多子不产生新劫点

    def _real_ko_position(self) -> GoBoard:
        """真实劫形：B 提 W(9,9) 后，B(9,8) 仅一气 (9,9)——W 回提 (9,9) 本身可成立（非自杀）。"""
        b = GoBoard(19)
        b.play(8, 9, "B")
        b.play(9, 7, "W")
        b.play(10, 9, "B")
        b.play(8, 8, "W")
        b.play(9, 10, "B")
        b.play(10, 8, "W")
        b.play(9, 9, "W")  # W 单子：仅 (9,8) 一气
        captured = b.play(9, 8, "B")  # 提 W(9,9) → 劫点 (9,9)
        assert captured == 1
        return b

    def test_pass_clears_ko_point(self):
        """PASS 结束劫争（正式规则，2026/09/12 修订）：劫点立即解除、回提合法。"""
        b = self._real_ko_position()
        assert b.ko_point == (9, 9)
        with pytest.raises(GoRulesError, match="打劫"):
            b.play(9, 9, "W")  # 紧接下一手：劫点禁入（回提被禁）
        assert b.stone_at(9, 9) is None  # 失败尝试不改变棋盘
        b.pass_turn()
        assert b.ko_point is None
        assert b.play(9, 9, "W") == 1  # PASS 后回提成立

    def test_build_board_replays_pass_clears_ko(self):
        """build_board 回放 PASS（结束劫争）——劫点状态与对弈校验完全一致。"""
        moves = [
            dict(color="B", x=8, y=9, is_pass=0),
            dict(color="W", x=9, y=7, is_pass=0),
            dict(color="B", x=10, y=9, is_pass=0),
            dict(color="W", x=8, y=8, is_pass=0),
            dict(color="B", x=9, y=10, is_pass=0),
            dict(color="W", x=10, y=8, is_pass=0),
            dict(color="W", x=9, y=9, is_pass=0),
            dict(color="B", x=9, y=8, is_pass=0),  # 提 W(9,9) → 劫点 (9,9)
        ]
        b = build_board(board_size=19, moves=moves)
        assert b.ko_point == (9, 9)
        with pytest.raises(GoRulesError, match="打劫"):
            b.play(9, 9, "W")
        b2 = build_board(board_size=19, moves=[
            *moves,
            dict(color="W", x=None, y=None, is_pass=1),  # PASS → 劫争结束
        ])
        assert b2.ko_point is None
        assert b2.play(9, 9, "W") == 1


class TestProbe:
    """只读探针。"""

    def test_is_legal_move_probe_no_mutation(self):
        b = GoBoard(9)
        b.play(0, 0, "B")
        assert b.is_legal_move(0, 0, "W") is False  # 占点
        assert b.stone_at(0, 0) == "B"
        assert b.is_legal_move(1, 0, "W") is True
        assert b.stone_at(1, 0) is None  # 未被探针修改

    def test_is_legal_move_suicide(self):
        b = GoBoard(9)
        for p in [(2, 2), (4, 2), (3, 1), (3, 3)]:
            b.play(*p, "W")
        assert b.is_legal_move(3, 2, "B") is False  # 自杀
        assert b.stone_at(3, 2) is None

    def test_has_legal_move_true(self):
        b = GoBoard(9)
        assert b.has_legal_move("B") is True
        assert b.has_legal_move("W") is True

    def test_has_legal_move_false_when_only_suicide_points(self):
        """全盘仅剩禁入点时无合法着法（双眼全被 W 包围且 W 有气）。

        白盒构造：直接设置棋盘（仅此用例，验证 has_legal_move 逻辑）。
        空点 (4,4)/(6,6) 四邻全为 W；W 大棋串经两空点保持有气。
        """
        b = GoBoard(9)
        empty = {(4, 4), (6, 6)}
        for y in range(9):
            for x in range(9):
                if (x, y) not in empty:
                    b._grid[y][x] = "W"
        assert b.has_legal_move("B") is False  # 任一点落子均自杀
        assert b.has_legal_move("W") is True   # W 落空点有气合法


class TestHandicap:
    """让子点位（国际经典序）与尺寸上限。"""

    def test_handicap_19_classic_order(self):
        """四角按 右上→左下→右下→左上；5/7 子天元入座、6/8 子不着天元。"""
        assert handicap_points(19, 2) == [(15, 3), (3, 15)]
        assert handicap_points(19, 4) == [(15, 3), (3, 15), (15, 15), (3, 3)]
        assert handicap_points(19, 5) == [(15, 3), (3, 15), (15, 15), (3, 3), (9, 9)]
        assert handicap_points(19, 6) == [
            (15, 3), (3, 15), (15, 15), (3, 3), (3, 9), (15, 9),
        ]
        assert handicap_points(19, 7)[-1] == (9, 9)
        assert (9, 9) not in handicap_points(19, 8)
        assert len(handicap_points(19, 8)) == 8
        assert len(handicap_points(19, 9)) == 9

    def test_handicap_13_9_classic(self):
        """13/9 路按 19 路同构缩放。"""
        assert handicap_points(13, 6) == [
            (9, 3), (3, 9), (9, 9), (3, 3), (3, 6), (9, 6),
        ]
        assert handicap_points(9, 2) == [(6, 2), (2, 6)]
        assert handicap_points(9, 4) == [(6, 2), (2, 6), (6, 6), (2, 2)]
        assert handicap_points(9, 5)[-1] == (4, 4)

    def test_handicap_limits(self):
        """尺寸让子上限（创建校验依据，BUG-049）。"""
        assert handicap_limit(9) == 4
        assert handicap_limit(13) == 6
        assert handicap_limit(19) == 9
        with pytest.raises(ValueError):
            handicap_limit(7)

    def test_handicap_zero(self):
        assert handicap_points(19, 0) == []

    def test_handicap_out_of_range(self):
        with pytest.raises(ValueError):
            handicap_points(19, 10)
        with pytest.raises(ValueError):
            handicap_points(19, -1)

    def test_handicap_unsupported_size(self):
        with pytest.raises(ValueError):
            handicap_points(7, 2)

    def test_place_handicap(self):
        b = GoBoard(19)
        b.place_handicap(handicap_points(19, 2))
        assert b.stone_at(15, 3) == "B"
        assert b.stone_at(3, 15) == "B"
        assert b.stone_at(9, 9) is None
