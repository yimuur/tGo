"""T2.5 对弈查询构建 + AI 落子选取 + 坐标换算测试。

用例 ID: COORD-* / SMPL-* / PLAY-Q-* / LVL-*
"""

import random

import pytest

from app.config import AppConfig
from app.engine.coords import gtp_to_xy, is_pass_loc, xy_to_gtp
from app.engine.play_query import (
    PRIORITY_PLAY,
    build_play_query,
    choose_index_with_temperature,
    move_to_gtp,
    select_ai_move,
    select_move_from_policy,
    stone_to_gtp,
)


class TestCoords:
    """坐标换算（KataGo GTP 语义）。"""

    @pytest.mark.parametrize(
        "x,y,gtp",
        [
            (0, 0, "A19"),
            (18, 18, "T1"),
            (2, 15, "C4"),
            (15, 3, "Q16"),
            (18, 0, "T19"),
            (9, 9, "K10"),
        ],
    )
    def test_xy_to_gtp(self, x, y, gtp):
        assert xy_to_gtp(x, y) == gtp

    def test_gtp_to_xy(self):
        assert gtp_to_xy("C4") == (2, 15)
        assert gtp_to_xy("T1") == (18, 18)
        assert gtp_to_xy("A19") == (0, 0)
        assert gtp_to_xy("(3,15)") == (3, 15)

    def test_roundtrip(self):
        for x, y in [(0, 0), (18, 18), (5, 12), (10, 3)]:
            assert gtp_to_xy(xy_to_gtp(x, y)) == (x, y)

    def test_pass_handling(self):
        assert is_pass_loc("pass") is True
        assert is_pass_loc("PASS") is True
        assert is_pass_loc("C4") is False
        with pytest.raises(ValueError):
            gtp_to_xy("pass")

    def test_out_of_bounds(self):
        with pytest.raises(ValueError):
            xy_to_gtp(19, 0)
        with pytest.raises(ValueError):
            xy_to_gtp(0, -1)

    def test_xy_to_gtp_small_board(self):
        """回归（引擎 9/13 路接入）：按盘面大小换算 GTP，曾固定 19 路致 C7 变 C17。"""
        assert xy_to_gtp(2, 2, board_size=9) == "C7"
        assert xy_to_gtp(8, 0, board_size=9) == "J9"
        assert xy_to_gtp(0, 8, board_size=9) == "A1"
        assert xy_to_gtp(2, 2, board_size=13) == "C11"
        assert xy_to_gtp(0, 0, board_size=13) == "A13"

    def test_gtp_to_xy_small_board(self):
        """回归：9/13 路 GTP 解析回内部 (x,y)。"""
        assert gtp_to_xy("C7", board_size=9) == (2, 2)
        assert gtp_to_xy("J9", board_size=9) == (8, 0)
        assert gtp_to_xy("C11", board_size=13) == (2, 2)
        assert gtp_to_xy("J9", board_size=13) == (8, 4)
        with pytest.raises(ValueError):
            gtp_to_xy("C17", board_size=9)   # 行越界（9 路无 17）
        with pytest.raises(ValueError):
            gtp_to_xy("A14", board_size=13)  # 行越界（13 路无 14）
        with pytest.raises(ValueError):
            gtp_to_xy("O1", board_size=13)   # 列越界（O 超出 13 路列）


class TestWeightedSampling:
    """AI 落子加权采样（searchhelpers.cpp chooseIndexWithTemperature 语义）。"""

    def test_temperature_zero_is_argmax(self):
        rng = random.Random(7)
        probs = [3.0, 50.0, 10.0, 1.0]
        for _ in range(50):
            assert choose_index_with_temperature(probs, 0.0, rng=rng) == 1

    def test_high_temperature_distribution(self):
        """时间窗口统计断言：高温下高权重候选被多数采样，低权重亦有命中。"""
        rng = random.Random(42)
        probs = [100.0, 10.0, 1.0]
        counts = [0, 0, 0]
        for _ in range(1000):
            counts[choose_index_with_temperature(probs, 1.0, rng=rng)] += 1
        # (p/max)^(1/T) → [1, 0.1, 0.01] → 首候选约 90%
        assert counts[0] > 800
        assert counts[1] > 50

    def test_reproducible_with_seed(self):
        rng1, rng2 = random.Random(1), random.Random(1)
        probs = [10.0, 20.0, 30.0]
        seq1 = [choose_index_with_temperature(probs, 0.5, rng=rng1) for _ in range(10)]
        seq2 = [choose_index_with_temperature(probs, 0.5, rng=rng2) for _ in range(10)]
        assert seq1 == seq2

    def test_empty_raises(self):
        with pytest.raises(ValueError):
            choose_index_with_temperature([], 1.0)

    def test_all_zero_raises(self):
        with pytest.raises(ValueError):
            choose_index_with_temperature([0.0, 0.0], 1.0)


class TestSelectAiMove:
    def test_select_returns_candidate(self):
        infos = [
            {"move": "C4", "visits": 5, "winrate": 0.4},
            {"move": "D4", "visits": 95, "winrate": 0.6},
        ]
        rng = random.Random(0)
        chosen = select_ai_move(infos, 0.0, rng=rng)
        assert chosen["move"] == "D4"  # 温度 0 → argmax(visits)

    def test_fallback_to_prior_when_no_visits(self):
        infos = [{"move": "Q16", "prior": 0.9}, {"move": "Q4", "prior": 0.1}]
        chosen = select_ai_move(infos, 0.0)
        assert chosen["move"] == "Q16"

    def test_empty_returns_none(self):
        assert select_ai_move([], 1.0) is None

    def test_all_zero_weights_returns_none(self):
        """全部候选无正权重（visits=0 且 prior=0）→ None（调用方回退策略采样）。"""
        infos = [{"move": "C4", "visits": 0, "prior": 0.0}]
        assert select_ai_move(infos, 1.0) is None


class TestSelectMoveFromPolicy:
    """低档位策略回退（A1，2026/09/10 人工决策）：无搜索候选时按根策略温度采样。

    策略数组：长度 = boardSize² + 1（末位 PASS），行主序（左上→右下，y 向下），
    非法点值为 -1（权重置零剔除）。
    """

    @staticmethod
    def _policy(size, weights):
        arr = [-1.0] * (size * size + 1)
        for idx, w in weights.items():
            arr[idx] = w
        return arr

    def test_maps_index_to_gtp(self):
        """19 路：idx=(15,3) → Q16；温度 0（argmax）取最大权重。"""
        policy = self._policy(19, {3 * 19 + 15: 0.9, 9 * 19 + 9: 0.1})
        chosen = select_move_from_policy(policy, 0.0, board_size=19)
        assert chosen is not None
        assert chosen["move"] == "Q16"
        assert chosen["visits"] == 0
        assert chosen["prior"] == pytest.approx(0.9)

    def test_board_size_13_mapping(self):
        """13 路：idx=(3,3) → D10（行号 = 13 - y）。"""
        policy = self._policy(13, {3 * 13 + 3: 1.0})
        chosen = select_move_from_policy(policy, 0.5, board_size=13)
        assert chosen is not None
        assert chosen["move"] == "D10"

    def test_pass_slot_and_illegal_skipped(self):
        """末位为 PASS；非法点（-1）与零权重不参与采样。"""
        policy = self._policy(9, {len(self._policy(9, {})) - 1: 0.7})
        policy[0] = 0.0  # 零权重
        chosen = select_move_from_policy(policy, 0.5, board_size=9)
        assert chosen is not None
        assert chosen["move"] == "pass"

    def test_temperature_sampling_with_seed(self):
        """温度采样：同种子可复现，且可在多候选间采样。"""
        policy = self._policy(19, {0: 50.0, 1: 50.0})
        a = select_move_from_policy(policy, 1.0, board_size=19, rng=random.Random(7))
        b = select_move_from_policy(policy, 1.0, board_size=19, rng=random.Random(7))
        assert a is not None and a["move"] == b["move"]

    @pytest.mark.parametrize(
        "policy,size",
        [
            (None, 19),
            ([], 19),
            ([0.5, 0.5], 19),  # 长度与盘大小不匹配（外部边界校验）
        ],
    )
    def test_none_when_unusable(self, policy, size):
        assert select_move_from_policy(policy, 1.0, board_size=size) is None

    def test_none_when_all_illegal(self):
        policy = [-1.0] * (9 * 9 + 1)
        assert select_move_from_policy(policy, 1.0, board_size=9) is None


class TestQueryBuilding:
    def _moves(self):
        return [
            {"color": "B", "x": 2, "y": 15, "is_pass": False},
            {"color": "W", "x": 15, "y": 3, "is_pass": False},
            {"color": "B", "is_pass": True},
        ]

    def test_standard_style_query(self):
        query = build_play_query(
            board_size=19, rules="chinese", komi=7.5, moves=self._moves(),
            max_visits=100, wide_root_noise=0.1,
        )
        assert query["moves"] == [["B", "C4"], ["W", "Q16"], ["B", "pass"]]
        assert query["rules"] == "chinese"
        assert query["komi"] == 7.5
        assert query["boardXSize"] == 19 and query["boardYSize"] == 19
        assert query["maxVisits"] == 100
        assert query["includeOwnership"] is True
        assert query["priority"] == PRIORITY_PLAY
        # 标准风格：不携带 humanSLProfile/chosenMoveTemperature；
        # 未提供 max_time 时亦不携带（ISSUE-037）；
        # **includePolicy 一律携带**：低档位（maxVisits=1）无候选时回退策略采样
        # （A1，2026/09/10 人工决策）
        assert "humanSLProfile" not in query["overrideSettings"]
        assert query["overrideSettings"]["wideRootNoise"] == 0.1
        assert "chosenMoveTemperature" not in query["overrideSettings"]
        assert "maxTime" not in query["overrideSettings"]
        assert "maxTime" not in query
        assert query["includePolicy"] is True

    def test_human_style_query(self):
        query = build_play_query(
            board_size=9, rules="japanese", komi=6.5, moves=[],
            max_visits=2, human_sl_profile="rank_5k",
        )
        assert query["overrideSettings"]["humanSLProfile"] == "rank_5k"
        assert "wideRootNoise" not in query["overrideSettings"]
        # 人类风格查询默认携带 includePolicy（Analysis_Engine.md Human SL 指南）
        assert query["includePolicy"] is True

    def test_adaptive_playout_doubling(self):
        query = build_play_query(
            board_size=19, rules="chinese", komi=7.5, moves=[],
            max_visits=10, human_sl_profile="rank_5k", playout_doubling_advantage=-1.5,
        )
        assert query["overrideSettings"]["playoutDoublingAdvantage"] == -1.5

    def test_max_time_via_override_settings(self):
        """maxTime 经 overrideSettings 随查询下发（ISSUE-037 已确认），非顶层字段。"""
        query = build_play_query(
            board_size=19, rules="chinese", komi=7.5, moves=[],
            max_visits=10, max_time=0.5,
        )
        assert query["overrideSettings"]["maxTime"] == 0.5
        assert "maxTime" not in query  # 顶层无该字段

    def test_include_policy_explicit_override(self):
        """includePolicy 可显式覆盖：标准查询显式 True / 人类查询显式 False。"""
        std = build_play_query(
            board_size=19, rules="chinese", komi=7.5, moves=[],
            max_visits=10, include_policy=True,
        )
        assert std["includePolicy"] is True
        human = build_play_query(
            board_size=19, rules="chinese", komi=7.5, moves=[],
            max_visits=10, human_sl_profile="rank_5k", include_policy=False,
        )
        assert "includePolicy" not in human

    def test_handicap_initial_stones(self):
        stones = [{"color": "B", "x": 15, "y": 15}, {"color": "B", "x": 3, "y": 15}]
        query = build_play_query(
            board_size=19, rules="chinese", komi=7.5, moves=[], initial_stones=stones,
            max_visits=1,
        )
        assert query["initialStones"] == [["B", "Q4"], ["B", "D4"]]

    def test_no_initial_stones_omits_field(self):
        query = build_play_query(board_size=19, rules="chinese", komi=7.5, moves=[], max_visits=1)
        assert "initialStones" not in query

    def test_move_to_gtp(self):
        assert move_to_gtp({"color": "W", "x": 9, "y": 9}) == ["W", "K10"]
        assert move_to_gtp({"color": "B", "is_pass": True}) == ["B", "pass"]

    def test_stone_to_gtp(self):
        assert stone_to_gtp({"color": "B", "x": 15, "y": 3}) == ["B", "Q16"]

    def test_small_board_moves_use_board_size(self):
        """回归（ISSUE-056）：9 路落子 (2,2)=C7，查询 moves 必须为 C7 而非 C17。"""
        moves = [{"color": "B", "x": 2, "y": 2, "is_pass": False}]
        query = build_play_query(
            board_size=9, rules="chinese", komi=7.5, moves=moves, max_visits=5
        )
        assert query["boardXSize"] == 9
        assert query["moves"] == [["B", "C7"]]

    def test_move_to_gtp_small_board(self):
        assert move_to_gtp({"color": "W", "x": 2, "y": 2}, board_size=9) == ["W", "C7"]
        assert stone_to_gtp({"color": "B", "x": 8, "y": 0}, board_size=9) == ["B", "J9"]


class TestLevelConfig:
    """12 级难度映射（config.yaml 唯一事实源；默认值与 LEVEL.md 一致）。"""

    def test_standard_levels(self):
        cfg = AppConfig()
        assert len(cfg.levels.standard) == 12
        assert cfg.levels.standard_at(1).max_visits == 1
        assert cfg.levels.standard_at(5).max_visits == 5
        assert cfg.levels.standard_at(12).max_visits == 800
        assert cfg.levels.standard_at(12).chosen_move_temperature == 0.0

    def test_human_levels(self):
        cfg = AppConfig()
        assert len(cfg.levels.human) == 12
        assert cfg.levels.human_at(5).human_sl_profile == "rank_5k"
        assert cfg.levels.human_at(1).human_sl_profile == "rank_20k"

    def test_level_out_of_range(self):
        cfg = AppConfig()
        with pytest.raises(ValueError):
            cfg.levels.standard_at(13)
        with pytest.raises(ValueError):
            cfg.levels.human_at(0)

    def test_level_unknown_field_rejected(self):
        from app.config import StandardLevelParam

        with pytest.raises(Exception):
            StandardLevelParam(level=1, target="x", max_visits=1, max_time=0.1,
                               chosen_move_temperature=1.0, wide_root_noise=0.1, bogus=1)
