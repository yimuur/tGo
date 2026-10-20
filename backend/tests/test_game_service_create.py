"""T3.2 创建对局测试（TASK T3.2 / PRD §4.1.1 / API §3.1.1）。

用例 ID: GS-CREATE-*
- 参数校验（模式/棋盘/规则/贴目/让子/执色/难度/风格/自适应/点评）；
- players 档案 upsert + 黑白 name/rank 快照；
- 非法组合（让子 + 非整贴目）；
- 录入段位自动匹配难度档位（固定难度预选、自适应初始水平=段位）；
- 人类模型缺失降级（禁用人类风格/自适应，仅标准风格可用）；
- 写入 games（status='created'）。
"""

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.game_service import (
    AiParams,
    CreateGameParams,
    GameService,
    PlayerInfo,
)


@pytest.fixture
def svc(db):
    """GameService（连接 :memory: 库，人类模型默认可用）。"""
    return GameService(db.conn, default_config(), human_model_available=True)


@pytest.fixture
def svc_no_human(db):
    """人类模型缺失场景（创建对局禁用人类风格/自适应）。"""
    return GameService(db.conn, default_config(), human_model_available=False)


def _params(**overrides) -> CreateGameParams:
    base = dict(
        mode="human_human",
        board_size=19,
        rules="chinese",
        komi=7.5,
        handicap=0,
        color="B",
        black=PlayerInfo(name="张三", rank="rank_5k"),
        white=PlayerInfo(name=None, rank=None),
        ai=None,
        coaching=False,
    )
    base.update(overrides)
    return CreateGameParams(**base)


class TestCreateDefaults:
    """默认值与基础写入。"""

    async def test_create_human_human_defaults(self, svc, db):
        gid = await svc.create(_params())
        game = await repos.get_game(db.conn, gid)
        assert game["mode"] == "human_human"
        assert game["board_size"] == 19
        assert game["rules"] == "chinese"
        assert game["komi"] == 7.5
        assert game["handicap"] == 0
        assert game["status"] == "created"
        assert game["last_move_no"] == 0
        assert game["ai_style"] is None
        assert game["ai_level"] is None
        assert game["adaptive_enabled"] == 0

    async def test_create_returns_new_id(self, svc):
        gid1 = await svc.create(_params())
        gid2 = await svc.create(_params())
        assert gid2 > gid1

    async def test_create_no_name_defaults_zhenren(self, svc, db):
        gid = await svc.create(_params(black=PlayerInfo(name=None, rank=None)))
        game = await repos.get_game(db.conn, gid)
        assert game["black_name"] == "真人"
        assert game["black_rank"] is None
        assert game["black_player_id"] is None


class TestCreateHumanAI:
    """人机对弈参数持久化。"""

    async def test_create_human_ai_full_params(self, svc, db):
        gid = await svc.create(
            _params(
                mode="human_ai",
                color="W",
                black=PlayerInfo(name="张三", rank="rank_5k"),
                white=PlayerInfo(name=None, rank=None),
                ai=AiParams(style="standard", level=6, adaptive=False),
                coaching=True,
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["mode"] == "human_ai"
        assert game["human_color"] == "W"
        assert game["ai_style"] == "standard"
        assert game["ai_level"] == 6
        assert game["adaptive_enabled"] == 0
        assert game["coaching_enabled"] == 1

    async def test_create_human_ai_default_ai(self, svc, db):
        """未录入段位时按显式 level 落档（默认标准风格）。"""
        gid = await svc.create(
            _params(
                mode="human_ai",
                black=PlayerInfo(name="张三", rank=None),
                ai=AiParams(level=3),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["ai_style"] == "standard"
        assert game["ai_level"] == 3

    async def test_rank_overrides_explicit_level(self, svc, db):
        """录入段位时按段位自动匹配档位（段位优先，PRD §4.1.1）。"""
        gid = await svc.create(
            _params(
                mode="human_ai",
                black=PlayerInfo(name="张三", rank="rank_5k"),
                ai=AiParams(level=3),  # 显式 level 被段位匹配覆盖
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["ai_level"] == 5

    async def test_create_human_ai_default_human_color(self, svc, db):
        gid = await svc.create(
            _params(mode="human_ai", black=PlayerInfo(name="张三", rank="rank_5k"), ai=AiParams(level=3))
        )
        game = await repos.get_game(db.conn, gid)
        assert game["human_color"] == "B"

    async def test_ai_side_name_snapshot_is_ai(self, svc, db):
        """人机 AI 侧名称快照默认落「AI」（不落「真人」，2026/09/10 人工反馈）。"""
        gid = await svc.create(
            _params(mode="human_ai", black=PlayerInfo(name="张三", rank="rank_5k"), ai=AiParams(level=3))
        )
        game = await repos.get_game(db.conn, gid)
        assert game["black_name"] == "张三"
        assert game["white_name"] == "AI"  # 人类执黑 → AI 执白
        # 人类执白 → AI 执黑
        gid2 = await svc.create(
            _params(
                mode="human_ai",
                color="W",
                black=PlayerInfo(),
                white=PlayerInfo(name="李四", rank="rank_1k"),
                ai=AiParams(level=3),
            )
        )
        game2 = await repos.get_game(db.conn, gid2)
        assert game2["black_name"] == "AI"
        assert game2["white_name"] == "李四"


class TestRankLevelMapping:
    """录入段位自动匹配难度档位。"""

    async def test_fixed_level_auto_matched_from_rank(self, svc, db):
        """固定难度：录入段位自动匹配档位（省略 level）。"""
        gid = await svc.create(
            _params(
                mode="human_ai",
                black=PlayerInfo(name="张三", rank="rank_5k"),  # 第 5 档
                ai=AiParams(style="standard", level=None),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["ai_level"] == 5

    async def test_rank_different_side_matched_by_human_color(self, svc, db):
        """人类执白时按白方段位匹配。"""
        gid = await svc.create(
            _params(
                mode="human_ai",
                color="W",
                black=PlayerInfo(name="AI", rank=None),
                white=PlayerInfo(name="李四", rank="rank_3d"),  # 第 9 档
                ai=AiParams(level=None),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["ai_level"] == 9

    async def test_adaptive_initial_equals_rank(self, svc, db):
        """自适应 + 录入段位 → 初始水平即该段位。"""
        gid = await svc.create(
            _params(
                mode="human_ai",
                black=PlayerInfo(name="张三", rank="rank_1d"),  # 第 8 档
                ai=AiParams(style="human", adaptive=True),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["adaptive_initial_level"] == "rank_1d"
        assert game["ai_level"] == 8
        assert game["ai_style"] == "human"  # 自适应默认人类风格

    async def test_adaptive_default_initial_level(self, svc, db):
        """自适应未录入段位 → 配置默认 rank_5k。"""
        gid = await svc.create(
            _params(
                mode="human_ai",
                black=PlayerInfo(name="张三", rank=None),
                ai=AiParams(style="human", adaptive=True),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["adaptive_initial_level"] == "rank_5k"
        assert game["ai_level"] == 5

    async def test_adaptive_forces_human_style(self, svc, db):
        """自适应默认人类风格（显式 standard 也被覆盖）。"""
        gid = await svc.create(
            _params(
                mode="human_ai",
                black=PlayerInfo(name="张三", rank=None),
                ai=AiParams(style="standard", adaptive=True),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["ai_style"] == "human"

    async def test_no_rank_no_level_rejected(self, svc):
        with pytest.raises(AppError) as ei:
            await svc.create(
                _params(
                    mode="human_ai",
                    black=PlayerInfo(name="张三", rank=None),
                    ai=AiParams(level=None),
                )
            )
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD


class TestPlayerUpsertSnapshot:
    """档案 upsert + 黑白 name/rank 快照。"""

    async def test_upsert_and_snapshot(self, svc, db):
        gid = await svc.create(
            _params(
                black=PlayerInfo(name="张三", rank="rank_5k"),
                white=PlayerInfo(name="李四", rank="rank_1k"),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["black_name"] == "张三"
        assert game["black_rank"] == "rank_5k"
        assert game["white_name"] == "李四"
        assert game["white_rank"] == "rank_1k"
        assert game["black_player_id"] is not None
        assert game["white_player_id"] is not None

    async def test_upsert_idempotent(self, svc, db):
        gid1 = await svc.create(_params())
        gid2 = await svc.create(_params())
        g1, g2 = await repos.get_game(db.conn, gid1), await repos.get_game(db.conn, gid2)
        assert g1["black_player_id"] == g2["black_player_id"]
        players = await repos.list_players(db.conn)
        assert len(players) == 1

    async def test_no_upsert_without_rank(self, svc, db):
        gid = await svc.create(
            _params(black=PlayerInfo(name="张三", rank=None))
        )
        game = await repos.get_game(db.conn, gid)
        assert game["black_player_id"] is None
        assert game["black_name"] == "张三"


class TestHumanModelDegradation:
    """人类模型缺失降级（PRD §4.1.1）。"""

    async def test_human_style_rejected_without_human_model(self, svc_no_human):
        with pytest.raises(AppError) as ei:
            await svc_no_human.create(
                _params(
                    mode="human_ai",
                    black=PlayerInfo(name="张三", rank="rank_5k"),
                    ai=AiParams(style="human", level=5),
                )
            )
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    async def test_adaptive_rejected_without_human_model(self, svc_no_human):
        with pytest.raises(AppError) as ei:
            await svc_no_human.create(
                _params(
                    mode="human_ai",
                    black=PlayerInfo(name="张三", rank=None),
                    ai=AiParams(adaptive=True),
                )
            )
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    async def test_standard_ok_without_human_model(self, svc_no_human, db):
        gid = await svc_no_human.create(
            _params(
                mode="human_ai",
                black=PlayerInfo(name="张三", rank="rank_5k"),
                ai=AiParams(style="standard", level=5),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["ai_style"] == "standard"


class TestValidation:
    """参数校验与非法组合。"""

    @pytest.mark.parametrize("mode", ["human_bot", "", "ai"])
    async def test_invalid_mode_rejected(self, svc, mode):
        with pytest.raises(AppError) as ei:
            await svc.create(_params(mode=mode))
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    @pytest.mark.parametrize("size", [7, 17, 21])
    async def test_invalid_board_size_rejected(self, svc, size):
        with pytest.raises(AppError) as ei:
            await svc.create(_params(board_size=size))
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    @pytest.mark.parametrize("rules", ["chinese2", "", "korean"])
    async def test_invalid_rules_rejected(self, svc, rules):
        with pytest.raises(AppError) as ei:
            await svc.create(_params(rules=rules))
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    @pytest.mark.parametrize("handicap", [1, 10, 15])
    async def test_invalid_handicap_rejected(self, svc, handicap):
        with pytest.raises(AppError) as ei:
            await svc.create(_params(handicap=handicap, komi=0))
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    async def test_handicap_non_integer_komi_rejected(self, svc):
        """让子 + 非整贴目 → 非法组合。"""
        with pytest.raises(AppError) as ei:
            await svc.create(_params(handicap=2, komi=7.5))
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    async def test_handicap_komi_defaults_zero(self, svc, db):
        gid = await svc.create(_params(handicap=2, komi=None))
        game = await repos.get_game(db.conn, gid)
        assert game["komi"] == 0.0
        assert game["handicap"] == 2

    async def test_handicap_integer_komi_ok(self, svc, db):
        gid = await svc.create(_params(handicap=3, komi=0.0))
        game = await repos.get_game(db.conn, gid)
        assert game["komi"] == 0.0

    async def test_handicap_forces_human_black(self, svc, db):
        """让子棋默认人类执黑放置让子。"""
        gid = await svc.create(
            _params(
                mode="human_ai",
                handicap=2,
                komi=0.0,
                color="W",
                black=PlayerInfo(name="张三", rank="rank_5k"),
                ai=AiParams(level=5),
            )
        )
        game = await repos.get_game(db.conn, gid)
        assert game["human_color"] == "B"

    @pytest.mark.parametrize(
        "board_size,handicap",
        [(9, 5), (9, 6), (9, 9), (13, 7), (13, 9)],
    )
    async def test_handicap_over_board_limit_rejected(self, svc, board_size, handicap):
        """让子数超该尺寸上限 → 拒绝（防止创建不能下不能删的僵尸棋局，BUG-049）。"""
        with pytest.raises(AppError) as ei:
            await svc.create(_params(board_size=board_size, handicap=handicap, komi=0))
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD
        assert "最多让" in ei.value.message

    @pytest.mark.parametrize("board_size,handicap", [(9, 4), (13, 6), (19, 9)])
    async def test_handicap_at_board_limit_accepted(self, svc, db, board_size, handicap):
        """恰在上限内的让子可创建（9 路 4 / 13 路 6 / 19 路 9，BUG-049）。"""
        gid = await svc.create(_params(board_size=board_size, handicap=handicap, komi=0))
        game = await repos.get_game(db.conn, gid)
        assert game["handicap"] == handicap

    async def test_invalid_color_rejected(self, svc):
        with pytest.raises(AppError) as ei:
            await svc.create(
                _params(
                    mode="human_ai",
                    color="X",
                    black=PlayerInfo(name="张三", rank="rank_5k"),
                    ai=AiParams(level=5),
                )
            )
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    async def test_human_human_ai_param_rejected(self, svc):
        with pytest.raises(AppError) as ei:
            await svc.create(_params(ai=AiParams(level=3)))
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    async def test_invalid_level_range_rejected(self, svc):
        with pytest.raises(AppError) as ei:
            await svc.create(
                _params(
                    mode="human_ai",
                    black=PlayerInfo(name="张三", rank=None),
                    ai=AiParams(level=13),
                )
            )
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD

    async def test_invalid_rank_rejected(self, svc):
        with pytest.raises(AppError) as ei:
            await svc.create(
                _params(
                    mode="human_ai",
                    black=PlayerInfo(name="张三", rank="rank_99d"),
                    ai=AiParams(level=None),
                )
            )
        assert ei.value.code is ErrorCode.PLAYER_INVALID_RANK

    async def test_invalid_ai_style_rejected(self, svc):
        with pytest.raises(AppError) as ei:
            await svc.create(
                _params(
                    mode="human_ai",
                    black=PlayerInfo(name="张三", rank="rank_5k"),
                    ai=AiParams(style="bot", level=5),
                )
            )
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD
