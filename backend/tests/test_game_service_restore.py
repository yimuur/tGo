"""T3.5 断点恢复测试（TASK T3.5 / PRD §4.1.10 / ARCHITECTURE §3.5/§5.3）。

用例 ID: GS-RESTORE-*
- 服务端为唯一事实源，全量校验对齐（冲突以服务端为准）；
- 恢复置 PLAYING；非 active 对局拒绝恢复。
"""

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.game_service import CreateGameParams, GameService, PlayerInfo


def _params(**overrides):
    base = dict(
        mode="human_human",
        board_size=9,
        rules="chinese",
        komi=7.5,
        black=PlayerInfo(name="张三", rank="rank_5k"),
        white=PlayerInfo(name="李四", rank="rank_1k"),
    )
    base.update(overrides)
    return CreateGameParams(**base)


@pytest.fixture
def svc(db):
    return GameService(db.conn, default_config(), human_model_available=True)


class TestRestore:
    """断点恢复。"""

    async def test_restore_active_returns_snapshot(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=4, y=4, color="W")
        snap = await svc.restore(gid)
        assert snap["game_id"] == gid
        assert snap["status"] == "active"
        assert len(snap["moves"]) == 2
        assert snap["next_color"] == "B"
        assert snap["moves"][0]["color"] == "B"

    async def test_restore_returns_analysis_info(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await repos.upsert_position_analysis(
            db.conn, game_id=gid, position_key="main:0", data_json="{}", max_visits=10
        )
        await repos.upsert_position_analysis(
            db.conn, game_id=gid, position_key="main:1", data_json="{}", max_visits=10
        )
        snap = await svc.restore(gid)
        assert snap["analysis_complete"] is True
        assert snap["coverage"] == {"done": 2, "total": 2}

    async def test_restore_created_rejected(self, svc, db):
        gid = await svc.create(_params())
        with pytest.raises(AppError) as ei:
            await svc.restore(gid)
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_restore_scoring_rejected(self, svc, db):
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        await svc.pass_move(gid, color="W")  # scoring
        with pytest.raises(AppError) as ei:
            await svc.restore(gid)
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_restore_finished_rejected(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.resign(gid, color="B")
        with pytest.raises(AppError) as ei:
            await svc.restore(gid)
        assert ei.value.code is ErrorCode.GAME_FINISHED

    async def test_restore_human_ai_turn_info(self, svc, db):
        """人机对弈恢复附带 TURN_HUMAN/TURN_AI。"""
        from unittest.mock import AsyncMock

        from app.services.game_service import AiParams

        engine = AsyncMock()
        async def _submit(query, timeout_s=None):
            return {"id": query.get("id"), "moveInfos": [{"move": "Q16", "visits": 100}]}

        engine.submit = _submit
        svc2 = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine
        )
        gid = await svc2.create(
            _params(
                mode="human_ai",
                board_size=19,
                color="W",  # 人类白，AI 黑先
                ai=AiParams(level=5),
            )
        )
        await svc2.start(gid)  # AI 已落黑首手
        snap = await svc2.restore(gid)
        assert snap["turn"] == "TURN_HUMAN"  # 轮到人类（白）

    async def test_restore_is_authoritative(self, svc, db):
        """服务端唯一事实源：返回的服务端落子序列与手数一致（客户端冲突以服务端为准）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=4, y=4, color="W")
        await svc.play(gid, x=5, y=5, color="B")
        snap = await svc.restore(gid)
        game = await repos.get_game(db.conn, gid)
        assert snap["game"]["last_move_no"] == 3
        assert snap["game"]["last_move_no"] == game["last_move_no"]
        assert [m["move_no"] for m in snap["moves"]] == [1, 2, 3]
