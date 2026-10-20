"""T4.1 Pydantic Schemas 测试（TASK T4.1 / API §3/§4 强绑定）。

用例 ID: API-SCH-*
- 创建对局请求全模型校验（模式/棋盘/规则/贴目/让子/执色/难度/风格/自适应/点评）；
- WS 信封（type/seq/data）、各消息载荷校验；
- 配置更新（部分更新、非法值、交叉校验入口）；
- 错误消息（统一结构 `{code,message}` 由 errors 层保证，此处校验 Pydantic 拒绝）。
"""

import pytest
from pydantic import ValidationError

from app.api.schemas import (
    ConfigUpdate,
    CreateGameRequest,
    SetDefaultModelRequest,
    WsDeepAnalysisRequest,
    WsEnvelope,
    WsOwnershipRequest,
    WsPlay,
    WsScoringConfirm,
)


class TestCreateGameRequest:
    """创建对局请求校验。"""

    def test_valid_human_human(self):
        req = CreateGameRequest(
            mode="human_human",
            board_size=19,
            rules="chinese",
            komi=7.5,
            black={"name": "张三", "rank": "rank_5k"},
            white={"name": "李四", "rank": "rank_1d"},
        )
        assert req.mode == "human_human"
        assert req.black.name == "张三"
        assert req.black.rank == "rank_5k"

    def test_valid_human_ai(self):
        req = CreateGameRequest(
            mode="human_ai",
            color="B",
            ai={"style": "human", "level": 5, "adaptive": True},
            coaching=True,
        )
        assert req.ai.style == "human"
        assert req.ai.level == 5
        assert req.ai.adaptive is True
        assert req.coaching is True

    def test_invalid_mode(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(mode="machine_vs_machine")

    def test_invalid_board_size(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(board_size=25)

    def test_invalid_rules(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(rules="korean")

    def test_invalid_handicap(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(handicap=1)

    def test_valid_handicap_2_to_9(self):
        assert CreateGameRequest(handicap=9).handicap == 9
        assert CreateGameRequest(handicap=2).handicap == 2

    def test_invalid_color(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(mode="human_ai", color="R")

    def test_invalid_rank(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(black={"name": "张三", "rank": "rank_99d"})

    def test_invalid_ai_level(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(mode="human_ai", ai={"level": 13})

    def test_invalid_ai_style(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(mode="human_ai", ai={"style": "robot"})

    def test_unknown_field_rejected(self):
        with pytest.raises(ValidationError):
            CreateGameRequest(unknown_extra=1)


class TestWsEnvelope:
    """WS 信封校验（API §4.1）。"""

    def test_valid_envelope(self):
        env = WsEnvelope(type="play", seq=42, data={"x": 3, "y": 3})
        assert env.type == "play"
        assert env.seq == 42

    def test_unknown_type_rejected(self):
        with pytest.raises(ValidationError):
            WsEnvelope(type="hack")

    def test_seq_optional(self):
        env = WsEnvelope(type="ping")
        assert env.seq is None
        assert env.data is None

    def test_scoring_cancel_type_allowed(self):
        """scoring.cancel 为合法客户端消息类型（PRD §4.1.8 结算取消）。"""
        env = WsEnvelope(type="scoring.cancel")
        assert env.type == "scoring.cancel"

    def test_scoring_prepare_type_allowed(self):
        """scoring.prepare 为合法客户端消息类型（2026/09/19 导入棋谱补结算准备）。"""
        env = WsEnvelope(type="scoring.prepare")
        assert env.type == "scoring.prepare"

    def test_negative_seq_rejected(self):
        with pytest.raises(ValidationError):
            WsEnvelope(type="play", seq=-1)


class TestWsPayloads:
    """WS 消息载荷校验。"""

    def test_play_valid(self):
        p = WsPlay(x=3, y=3)
        assert (p.x, p.y) == (3, 3)

    def test_play_out_of_board(self):
        with pytest.raises(ValidationError):
            WsPlay(x=19, y=0)

    def test_play_optional_color(self):
        assert WsPlay(x=0, y=0, color="W").color == "W"

    def test_scoring_confirm_valid(self):
        s = WsScoringConfirm(dead_points=[[3, 3], [9, 9]])
        assert list(s.dead_points) == [(3, 3), (9, 9)]

    def test_scoring_confirm_out_of_board(self):
        with pytest.raises(ValidationError):
            WsScoringConfirm(dead_points=[[20, 3]])

    def test_deep_analysis_requires_key(self):
        with pytest.raises(ValidationError):
            WsDeepAnalysisRequest()

    def test_deep_analysis_move_no(self):
        assert WsDeepAnalysisRequest(move_no=3).move_no == 3

    def test_deep_analysis_position_key(self):
        assert WsDeepAnalysisRequest(position_key="trial:1:2").position_key == "trial:1:2"

    def test_ownership_request_optional_trial_id(self):
        """领地请求 trial_id 可选（向后兼容，试下实时）。"""
        req = WsOwnershipRequest(trial_id=3, move_no=1)
        assert req.trial_id == 3
        assert req.move_no == 1
        assert WsOwnershipRequest().trial_id is None


class TestConfigUpdate:
    """管理配置更新校验（API §3.3）。"""

    def test_empty_update_allowed(self):
        """空更新（全可选，部分更新）。"""
        assert ConfigUpdate().model_dump(exclude_none=True) == {}

    def test_valid_update(self):
        u = ConfigUpdate(standard_max_visits=120, deep_max_visits=900, resident=True)
        assert u.standard_max_visits == 120
        assert u.deep_max_visits == 900
        assert u.resident is True

    def test_invalid_standard_max_visits(self):
        with pytest.raises(ValidationError):
            ConfigUpdate(standard_max_visits=0)

    def test_invalid_analysis_pv_len(self):
        with pytest.raises(ValidationError):
            ConfigUpdate(analysis_pv_len=3)

    def test_invalid_adaptive_rank(self):
        with pytest.raises(ValidationError):
            ConfigUpdate(adaptive_initial_level="rank_99d")

    def test_invalid_default_board_size(self):
        with pytest.raises(ValidationError):
            ConfigUpdate(default_board_size=21)

    def test_unknown_field_rejected(self):
        with pytest.raises(ValidationError):
            ConfigUpdate(no_such_param=1)

    def test_invalid_logging_level(self):
        with pytest.raises(ValidationError):
            ConfigUpdate(logging_level="TRACE")


class TestSetDefaultModel:
    def test_valid(self):
        assert SetDefaultModelRequest(model="kata1.bin.gz").model == "kata1.bin.gz"

    def test_empty_model_rejected(self):
        with pytest.raises(ValidationError):
            SetDefaultModelRequest(model="")
