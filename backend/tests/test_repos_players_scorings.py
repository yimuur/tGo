"""T1.4 仓储层 players + scorings 测试：档案 upsert、模糊查询排序、结算 UPSERT。

用例 ID: REP-PLAYER-* / REP-SCORE-*
"""

from app.db import repos


async def _mk(db, mode="human_human"):
    return await repos.create_game(db.conn, mode=mode)


class TestPlayers:
    async def test_upsert_creates(self, db):
        pid = await repos.upsert_player(db.conn, name="张三", rank="rank_5k")
        assert pid > 0
        assert await repos.upsert_player(db.conn, name="张三", rank="rank_5k") == pid

    async def test_upsert_idempotent(self, db):
        """同名同段位 upsert 幂等：返回同一 id 且仅一条记录。"""
        p1 = await repos.upsert_player(db.conn, name="李四", rank="rank_3k")
        p2 = await repos.upsert_player(db.conn, name="李四", rank="rank_3k")
        assert p1 == p2
        rows = await repos.list_players(db.conn)
        assert len(rows) == 1

    async def test_same_name_different_rank_separate(self, db):
        """同姓名不同段位为独立档案（UNIQUE 是 (name, rank) 对）。"""
        p1 = await repos.upsert_player(db.conn, name="王五", rank="rank_1d")
        p2 = await repos.upsert_player(db.conn, name="王五", rank="rank_5d")
        assert p1 != p2

    async def test_list_fuzzy_name(self, db):
        await repos.upsert_player(db.conn, name="张三", rank="rank_5k")
        await repos.upsert_player(db.conn, name="张伟", rank="rank_3k")
        await repos.upsert_player(db.conn, name="李四", rank="rank_1k")
        rows = await repos.list_players(db.conn, name="张")
        assert sorted(r["name"] for r in rows) == ["张三", "张伟"]

    async def test_list_ordered_by_recent_use(self, db):
        """按 updated_at 倒序（最近使用优先）。"""
        p1 = await repos.upsert_player(db.conn, name="赵一", rank="rank_5k")
        p2 = await repos.upsert_player(db.conn, name="钱二", rank="rank_3k")
        # 手动把 p1 的 updated_at 推到更晚（相对 SQLite now(UTC) 的未来时间，避免墙钟/时区依赖）
        await db.conn.execute(
            "UPDATE players SET updated_at=datetime('now', '+1 hour') WHERE id=?", (p1,)
        )
        await db.conn.commit()
        rows = await repos.list_players(db.conn)
        assert rows[0]["id"] == p1
        assert rows[1]["id"] == p2


class TestScorings:
    async def test_upsert_insert_and_get(self, db):
        g = await _mk(db)
        await repos.upsert_scoring(
            db.conn, game_id=g, dead_points_json="[[3,3]]", black_score=185.5,
            white_score=174.5, result="B+11",
        )
        scoring = await repos.get_scoring(db.conn, g)
        assert scoring["black_score"] == 185.5
        assert scoring["result"] == "B+11"
        assert scoring["dead_points_json"] == "[[3,3]]"

    async def test_upsert_replaces_whole_row(self, db):
        """以 game_id 为键整体替换（结算取消后再结算），不产生多行。"""
        g = await _mk(db)
        await repos.upsert_scoring(db.conn, game_id=g, result="B+R")
        await repos.upsert_scoring(
            db.conn, game_id=g, dead_points_json="[]", black_score=180.0,
            white_score=178.0, result="B+2",
        )
        scoring = await repos.get_scoring(db.conn, g)
        assert scoring["result"] == "B+2"
        assert scoring["black_score"] == 180.0
        # 仅一条结算记录
        cur = await db.conn.execute("SELECT COUNT(*) AS n FROM scorings WHERE game_id=?", (g,))
        assert (await cur.fetchone())["n"] == 1

    async def test_get_missing_returns_none(self, db):
        assert await repos.get_scoring(db.conn, 9999) is None

    async def test_delete_game_cascades_scoring(self, db):
        g = await _mk(db)
        await repos.upsert_scoring(db.conn, game_id=g, result="B+7.5")
        await repos.delete_game(db.conn, g)
        assert await repos.get_scoring(db.conn, g) is None
