"""T1.3 仓储层 moves + position_analyses 测试：追加、级联清理、合并规则、查询。

用例 ID: REP-MOVE-* / REP-ANA-*
"""

import pytest

from app.db import repos


async def _mk(db):
    return await repos.create_game(db.conn, mode="human_human")


async def _seed_analyses(db, game_id, up_to):
    """写入主谱 0..up_to 的标准分析（max_visits=100）。"""
    for move_no in range(up_to + 1):
        await repos.upsert_position_analysis(
            db.conn,
            game_id=game_id,
            position_key=f"main:{move_no}",
            data_json=f'{{"move_no":{move_no}}}',
            max_visits=100,
        )


class TestAppendMove:
    async def test_append_updates_last_move_no(self, db):
        """单事务：写入落子并同步 games.last_move_no。"""
        g = await _mk(db)
        await repos.append_move(db.conn, game_id=g, move_no=1, color="B", x=9, y=9)
        move = await repos.get_move(db.conn, g, 1)
        assert move["color"] == "B" and move["x"] == 9 and move["y"] == 9
        assert move["is_pass"] == 0
        assert (await repos.get_game(db.conn, g))["last_move_no"] == 1

    async def test_append_pass(self, db):
        g = await _mk(db)
        await repos.append_move(db.conn, game_id=g, move_no=1, color="B", is_pass=True)
        move = await repos.get_move(db.conn, g, 1)
        assert move["is_pass"] == 1
        assert move["x"] is None and move["y"] is None

    async def test_append_duplicate_rolls_back_atomically(self, db):
        """UNIQUE(game_id, move_no)：重复手数抛错且整体回滚（moves 与 last_move_no 均不变）。"""
        g = await _mk(db)
        await repos.append_move(db.conn, game_id=g, move_no=1, color="B", x=9, y=9)
        with pytest.raises(Exception):
            await repos.append_move(db.conn, game_id=g, move_no=1, color="W", x=3, y=3)
        assert len(await repos.list_moves(db.conn, g)) == 1
        assert (await repos.get_game(db.conn, g))["last_move_no"] == 1

    async def test_list_moves_ordered(self, db):
        g = await _mk(db)
        for n in (2, 1, 3):
            await repos.append_move(db.conn, game_id=g, move_no=n, color="B" if n % 2 else "W", x=n, y=n)
        moves = await repos.list_moves(db.conn, g)
        assert [m["move_no"] for m in moves] == [1, 2, 3]

    async def test_get_move_missing(self, db):
        g = await _mk(db)
        assert await repos.get_move(db.conn, g, 5) is None


class TestTruncateMovesAfter:
    async def _setup(self, db):
        g = await _mk(db)
        for n in range(1, 5):
            await repos.append_move(db.conn, game_id=g, move_no=n, color="B" if n % 2 else "W", x=n, y=n)
        await _seed_analyses(db, g, 4)
        return g

    async def test_truncate_cascades(self, db):
        """悔棋级联：move_no>2 的 moves 与 main:3/4 分析被清理，main:0..2 保留，last_move_no 回写。"""
        g = await self._setup(db)
        await repos.truncate_moves_after(db.conn, game_id=g, move_no=2)

        moves = await repos.list_moves(db.conn, g)
        assert [m["move_no"] for m in moves] == [1, 2]

        assert await repos.get_main_analysis(db.conn, g, 0) is not None
        assert await repos.get_main_analysis(db.conn, g, 2) is not None
        assert await repos.get_main_analysis(db.conn, g, 3) is None
        assert await repos.get_main_analysis(db.conn, g, 4) is None

        assert (await repos.get_game(db.conn, g))["last_move_no"] == 2

    async def test_truncate_zero_clears_all_but_initial(self, db):
        """重开：截断到 0，仅保留初始局面 main:0。"""
        g = await self._setup(db)
        await repos.truncate_moves_after(db.conn, game_id=g, move_no=0)
        assert await repos.list_moves(db.conn, g) == []
        assert await repos.get_main_analysis(db.conn, g, 0) is not None
        assert await repos.get_main_analysis(db.conn, g, 1) is None
        assert (await repos.get_game(db.conn, g))["last_move_no"] == 0


class TestMergeUpsert:
    """合并规则：max_visits 大者恒优先；同值按 updated_at 新者替换。"""

    async def test_insert_new(self, db):
        g = await _mk(db)
        action = await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json="{}", max_visits=100
        )
        assert action == "inserted"

    async def test_larger_max_visits_replaces(self, db):
        g = await _mk(db)
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":1}', max_visits=100
        )
        action = await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":2}', max_visits=800
        )
        assert action == "replaced"
        row = await repos.get_position_analysis(db.conn, g, "main:0")
        assert row["max_visits"] == 800
        assert row["data_json"] == '{"v":2}'

    async def test_smaller_max_visits_discarded(self, db):
        g = await _mk(db)
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":1}', max_visits=800
        )
        action = await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":2}', max_visits=100
        )
        assert action == "discarded"
        row = await repos.get_position_analysis(db.conn, g, "main:0")
        assert row["max_visits"] == 800
        assert row["data_json"] == '{"v":1}'

    async def test_equal_max_newer_ts_replaces(self, db):
        g = await _mk(db)
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":1}',
            max_visits=100, updated_at="2026-08-29 01:00:00",
        )
        action = await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":2}',
            max_visits=100, updated_at="2026-08-29 02:00:00",
        )
        assert action == "replaced"
        assert (await repos.get_position_analysis(db.conn, g, "main:0"))["data_json"] == '{"v":2}'

    async def test_equal_max_older_ts_discarded(self, db):
        g = await _mk(db)
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":1}',
            max_visits=100, updated_at="2026-08-29 02:00:00",
        )
        action = await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":2}',
            max_visits=100, updated_at="2026-08-29 01:00:00",
        )
        assert action == "discarded"
        assert (await repos.get_position_analysis(db.conn, g, "main:0"))["data_json"] == '{"v":1}'


class TestBulkUpsert:
    """单事务批量合并写入（复弈落盘原子性）。"""

    async def test_bulk_insert_all_new(self, db):
        g = await _mk(db)
        stats = await repos.bulk_upsert_position_analyses(
            db.conn,
            game_id=g,
            items=[("main:0", '{"m":0}', 100), ("main:1", '{"m":1}', 100)],
        )
        assert stats == {"inserted": 2, "replaced": 0, "discarded": 0}
        assert await repos.count_analyses_for_game(db.conn, g) == 2

    async def test_bulk_merges_existing(self, db):
        """批量与存量按合并规则逐键收敛（大者替换/新增/同值旧丢弃）。"""
        g = await _mk(db)
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json='{"v":"old"}',
            max_visits=100, updated_at="2026-08-29 01:00:00",
        )
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:2", data_json='{"v":"old2"}',
            max_visits=100, updated_at="2026-08-29 02:00:00",
        )
        stats = await repos.bulk_upsert_position_analyses(
            db.conn,
            game_id=g,
            updated_at="2026-08-29 01:30:00",
            items=[
                ("main:0", '{"v":"deep"}', 800),   # 大者替换
                ("main:1", '{"v":"new"}', 50),     # 新增
                ("main:2", '{"v":"stale"}', 100),  # 同值旧时间戳丢弃
            ],
        )
        assert stats == {"inserted": 1, "replaced": 1, "discarded": 1}
        assert (await repos.get_main_analysis(db.conn, g, 0))["data_json"] == '{"v":"deep"}'
        assert (await repos.get_main_analysis(db.conn, g, 1))["data_json"] == '{"v":"new"}'
        assert (await repos.get_main_analysis(db.conn, g, 2))["data_json"] == '{"v":"old2"}'

    async def test_bulk_rollback_on_failure(self, db, monkeypatch):
        """中途失败整体回滚：已插入的部分不残留（复弈落盘原子性）。"""
        g = await _mk(db)
        orig = repos._upsert_one
        calls = {"n": 0}

        async def failing(_conn, **_kw):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("boom")
            return await orig(_conn, **_kw)

        monkeypatch.setattr(repos, "_upsert_one", failing)
        with pytest.raises(RuntimeError):
            await repos.bulk_upsert_position_analyses(
                db.conn,
                game_id=g,
                items=[("main:0", "{}", 100), ("main:1", "{}", 100)],
            )
        assert await repos.count_analyses_for_game(db.conn, g) == 0


class TestConcurrentWrites:
    """连接级写锁（BUG-012）：同一连接上的并发写事务不得互相交错/静默丢失。"""

    async def test_concurrent_upserts_all_persist(self, db):
        """两个并发 BEGIN IMMEDIATE 写事务（分析 worker 场景）：两键均落库。"""
        import asyncio

        g = await _mk(db)

        await asyncio.gather(
            repos.upsert_position_analysis(
                db.conn, game_id=g, position_key="main:0", data_json='{"v":0}', max_visits=100
            ),
            repos.upsert_position_analysis(
                db.conn, game_id=g, position_key="main:1", data_json='{"v":1}', max_visits=100
            ),
        )
        assert await repos.count_analyses_for_game(db.conn, g) == 2
        assert (await repos.get_main_analysis(db.conn, g, 0))["data_json"] == '{"v":0}'
        assert (await repos.get_main_analysis(db.conn, g, 1))["data_json"] == '{"v":1}'

    async def test_concurrent_mixed_writes_serialized(self, db):
        """分析写事务与对局写语句并发：互不打断（含单语句写路径）。"""
        import asyncio

        g = await _mk(db)

        async def _many_analyses() -> None:
            for n in range(4):
                await repos.upsert_position_analysis(
                    db.conn, game_id=g, position_key=f"main:{n}",
                    data_json=f'{{"v":{n}}}', max_visits=100,
                )

        async def _game_writes() -> None:
            for n in range(1, 5):
                await repos.update_game_ai_level(db.conn, g, n)
                await repos.update_game_status(db.conn, g, "active")

        await asyncio.gather(_many_analyses(), _game_writes())
        assert await repos.count_analyses_for_game(db.conn, g) == 4
        assert (await repos.get_game(db.conn, g))["ai_level"] == 4


class TestQueries:
    async def test_get_main_analysis(self, db):
        g = await _mk(db)
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:3", data_json="{}", max_visits=100
        )
        assert await repos.get_main_analysis(db.conn, g, 3) is not None
        assert await repos.get_main_analysis(db.conn, g, 4) is None

    async def test_count_and_list(self, db):
        g = await _mk(db)
        await _seed_analyses(db, g, 3)
        assert await repos.count_analyses_for_game(db.conn, g) == 4
        rows = await repos.list_analyses_for_game(db.conn, g)
        assert [r["position_key"] for r in rows] == ["main:0", "main:1", "main:2", "main:3"]

    async def test_analysis_coverage(self, db):
        g = await _mk(db)
        # 仅 main:0 / main:2 有分析
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:0", data_json="{}", max_visits=100
        )
        await repos.upsert_position_analysis(
            db.conn, game_id=g, position_key="main:2", data_json="{}", max_visits=100
        )
        assert await repos.analysis_coverage(db.conn, g, 2) == 2
        assert await repos.analysis_coverage(db.conn, g, 5) == 2
