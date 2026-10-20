"""ISSUE-064 存量数据回放冲突测试：回放失败路径 → 领域化错误码 REPLAY_CONFLICT。

用例 ID: REPLAY-CONFLICT-*
- 场景：旧对局（创建于让子点位/规则修订前）落子行与当前让子序冲突，
  全量回放抛底层 ``GoRulesError``；
- 期望：各回放入口（对弈落子 / 试下 / 结算回放）统一转 ``REPLAY_CONFLICT``（HTTP 409），
  调用方无需感知底层规则异常，前端可映射专用文案。
"""

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.analysis_service import AnalysisService
from app.services.game_service import CreateGameParams, GameService, PlayerInfo
from app.services.go_rules import handicap_points
from app.services.review_service import ReviewService
from app.services.scoring import replay_position


def _params(**overrides):
    base = dict(
        mode="human_human",
        board_size=19,
        rules="chinese",
        komi=7.5,
        black=PlayerInfo(name="张三", rank="rank_5k"),
        white=PlayerInfo(name="李四", rank="rank_1k"),
    )
    base.update(overrides)
    return CreateGameParams(**base)


@pytest.fixture
def game_svc(db):
    return GameService(db.conn, default_config(), human_model_available=True)


@pytest.fixture
def review(db, game_svc):
    return ReviewService(
        db.conn,
        default_config(),
        game_service=game_svc,
        analysis=AnalysisService(db.conn, default_config(), engine=None, concurrency=1),
    )


async def _mk_legacy_conflicting_game(db, game_svc) -> tuple[int, list[dict]]:
    """让子局 + 直写一手落在让子点位上（绕过规则校验，模拟修订前落库数据）。"""
    gid = await game_svc.create(_params(handicap=2, komi=0.0))
    hx, hy = handicap_points(19, 2)[0]
    await repos.append_move(db.conn, game_id=gid, move_no=1, color="W", x=hx, y=hy)
    return gid, await repos.list_moves(db.conn, gid)


class TestReplayConflict:
    """回放冲突：所有回放入口统一抛领域化错误码。"""

    async def test_play_rebuild_reports_domain_code(self, db, game_svc):
        """对弈落子前重建棋盘失败 → REPLAY_CONFLICT（非底层 GoRulesError）。"""
        gid, _ = await _mk_legacy_conflicting_game(db, game_svc)
        # 让子局白先：第 1 手为 W（直写模拟旧数据）→ 第 2 手 B
        with pytest.raises(AppError) as ei:
            await game_svc.play(gid, x=9, y=9, color="B")
        assert ei.value.code is ErrorCode.REPLAY_CONFLICT
        assert "该点已有棋子" in ei.value.message  # 底层原因保留（面向用户可读）

    async def test_trial_reports_domain_code(self, db, game_svc, review):
        """试下重建主谱前缀失败 → REPLAY_CONFLICT（进入试下即时失败）。"""
        gid, _ = await _mk_legacy_conflicting_game(db, game_svc)
        trial_id = await review.trial_enter(gid, 1)
        with pytest.raises(AppError) as ei:
            await review.trial_play(gid, trial_id, x=9, y=9, color="B")
        assert ei.value.code is ErrorCode.REPLAY_CONFLICT

    def test_scoring_replay_reports_domain_code(self):
        """结算回放（纯函数入口）同样抛领域化错误码。"""
        hx, hy = handicap_points(19, 2)[0]
        moves = [{"color": "W", "x": hx, "y": hy, "is_pass": 0}]
        with pytest.raises(AppError) as ei:
            replay_position(board_size=19, handicap=2, moves=moves)
        assert ei.value.code is ErrorCode.REPLAY_CONFLICT

    async def test_consistent_game_replay_ok(self, db, game_svc, review):
        """回归护栏：数据与规则一致时回放正常（不让新增捕获误伤正常路径）。"""
        gid = await game_svc.create(_params(handicap=2, komi=0.0))
        await game_svc.play(gid, x=3, y=3, color="W")
        trial_id = await review.trial_enter(gid, 1)
        result = await review.trial_play(gid, trial_id, x=4, y=4, color="B")
        assert result["relative_move_no"] == 1
