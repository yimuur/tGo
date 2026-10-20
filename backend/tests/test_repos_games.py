"""T1.2 仓储层 games 测试：CRUD、过滤/分页、active-latest、删除。

用例 ID: REP-GAME-*
"""

from app.db import repos


async def _mk(db, **kw):
    params = dict(mode="human_human")
    params.update(kw)
    return await repos.create_game(db.conn, **params)


class TestCreateGame:
    async def test_create_returns_id_with_defaults(self, db):
        game_id = await _mk(db)
        game = await repos.get_game(db.conn, game_id)
        assert game["id"] == game_id
        assert game["status"] == "created"
        assert game["last_move_no"] == 0
        assert game["board_size"] == 19
        assert game["black_name"] == "真人"
        assert game["favorite"] == 0

    async def test_create_human_ai_full_params(self, db):
        game_id = await _mk(
            db,
            mode="human_ai",
            board_size=13,
            rules="japanese",
            komi=6.5,
            handicap=2,
            human_color="W",
            black_name="张三",
            black_rank="rank_5k",
            ai_style="human",
            ai_level=5,
            adaptive_enabled=True,
            adaptive_initial_level="rank_5k",
            coaching_enabled=True,
        )
        game = await repos.get_game(db.conn, game_id)
        assert game["mode"] == "human_ai"
        assert game["ai_style"] == "human"
        assert game["ai_level"] == 5
        assert game["adaptive_enabled"] == 1
        assert game["coaching_enabled"] == 1


class TestGetGame:
    async def test_get_missing_returns_none(self, db):
        assert await repos.get_game(db.conn, 9999) is None

    async def test_detail_includes_counts(self, db):
        game_id = await _mk(db)
        await db.conn.execute(
            "INSERT INTO moves(game_id, move_no, color, x, y) VALUES (?,?,?,?,?)",
            (game_id, 1, "B", 9, 9),
        )
        await db.conn.execute(
            "INSERT INTO position_analyses(game_id, position_key, data_json, max_visits)"
            " VALUES (?,?,?,?)",
            (game_id, "main:0", "{}", 100),
        )
        await db.conn.commit()
        detail = await repos.get_game_detail(db.conn, game_id)
        assert detail["moves_count"] == 1
        assert detail["analyses_count"] == 1

    async def test_detail_missing_returns_none(self, db):
        assert await repos.get_game_detail(db.conn, 9999) is None


class TestListGames:
    async def test_order_by_latest_update(self, db):
        """列表按最近更新（`updated_at` 倒序）而非创建时间（2026/09/13 人工反馈，BUG-060）。"""
        a = await _mk(db)
        b = await _mk(db)
        # a“更晚创建”（旧口径 created_at DESC 会把 a 排在前）
        await db.conn.execute(
            "UPDATE games SET created_at=datetime('now','+1 hour') WHERE id=?", (a,)
        )
        # b“更晚更新”（新口径 updated_at DESC 应把 b 排在前）
        await db.conn.execute(
            "UPDATE games SET updated_at=datetime('now','+2 hour') WHERE id=?", (b,)
        )
        await db.conn.commit()
        _, items = await repos.list_games(db.conn, page=1, page_size=10)
        assert [i["id"] for i in items] == [b, a]

    async def test_move_bumps_game_to_top(self, db):
        """真实路径：落子（`append_move` 同步 updated_at）后该对局排到最前。"""
        played = await _mk(db)
        fresh = await _mk(db)
        # played 置为“陈旧更新”（-2h）；fresh 更晚创建（+1h）且更新较新（-1h）但早于本次落子
        await db.conn.execute(
            "UPDATE games SET updated_at=datetime('now','-2 hour') WHERE id=?", (played,)
        )
        await db.conn.execute(
            "UPDATE games SET created_at=datetime('now','+1 hour'),"
            " updated_at=datetime('now','-1 hour') WHERE id=?",
            (fresh,),
        )
        await db.conn.commit()
        _, before = await repos.list_games(db.conn, page=1, page_size=10)
        assert before[0]["id"] == fresh  # 前置：更新较新的 fresh 在前（新旧口径均如此）
        await repos.append_move(db.conn, game_id=played, move_no=1, color="B", x=9, y=9)
        _, after = await repos.list_games(db.conn, page=1, page_size=10)
        assert after[0]["id"] == played  # 落子后回到最前（旧实现按创建时间排 → 不会）

    async def test_pagination(self, db):
        ids = [await _mk(db) for _ in range(5)]
        total, items = await repos.list_games(db.conn, page=1, page_size=2)
        assert total == 5
        assert len(items) == 2
        _, page2 = await repos.list_games(db.conn, page=2, page_size=2)
        assert len(page2) == 2
        _, page3 = await repos.list_games(db.conn, page=3, page_size=2)
        assert len(page3) == 1

    async def test_filter_status(self, db):
        await _mk(db)
        g2 = await _mk(db)
        await repos.update_game_status(db.conn, g2, "finished")
        total, items = await repos.list_games(db.conn, status="finished")
        assert total == 1 and items[0]["id"] == g2

    async def test_filter_favorite(self, db):
        g = await _mk(db)
        await repos.set_game_favorite(db.conn, g, True)
        total, items = await repos.list_games(db.conn, favorite=True)
        assert total == 1 and items[0]["favorite"] == 1

    async def test_filter_mode(self, db):
        g = await _mk(db, mode="human_ai")
        total, items = await repos.list_games(db.conn, mode="human_ai")
        assert total == 1 and items[0]["id"] == g

    async def test_filter_status_list_or(self, db):
        """多状态过滤 = 同值 OR（如 created+active+scoring 表"进行中"）。"""
        a = await _mk(db)  # created
        b = await _mk(db)
        await repos.update_game_status(db.conn, b, "finished")
        total, items = await repos.list_games(db.conn, status=["created", "active"])
        assert total == 1 and items[0]["id"] == a
        # 单值字符串仍兼容（既有调用方）
        total, items = await repos.list_games(db.conn, status="created")
        assert total == 1 and items[0]["id"] == a

    async def test_filter_name_like(self, db):
        """按玩家名模糊搜索：匹配黑/白任一名（LIKE %name%），与其它过滤 AND。"""
        g_a = await repos.create_game(db.conn, mode="human_human", black_name="张三", white_name="王五")
        g_b = await repos.create_game(db.conn, mode="human_human", black_name="老陈", white_name="张伟")
        g_c = await repos.create_game(db.conn, mode="human_human", black_name="李四", white_name="赵六")
        # 命中黑名
        total, items = await repos.list_games(db.conn, name="张三")
        assert total == 1 and items[0]["id"] == g_a
        # 命中白名
        total, items = await repos.list_games(db.conn, name="王五")
        assert total == 1 and items[0]["id"] == g_a
        # 模糊匹配（黑/白均含"张"）
        total, items = await repos.list_games(db.conn, name="张")
        assert total == 2 and {i["id"] for i in items} == {g_a, g_b}
        # 与 favorite AND 组合
        await repos.set_game_favorite(db.conn, g_c, True)
        total, _ = await repos.list_games(db.conn, name="张", favorite=True)
        assert total == 0
        # 空白 name 忽略
        total, _ = await repos.list_games(db.conn, name="  ")
        assert total == 3


class TestLocateGamePage:
    """`focus_id` 归属页定位（复盘返回列表跨页定位，2026/09/14）。"""

    async def test_locates_page_and_tie_break(self, db):
        """同一时间戳按 id 倒序稳定（新 id 在前）；页码 = COUNT(在其前) // page_size + 1。"""
        ids = [await _mk(db) for _ in range(5)]
        await db.conn.execute("UPDATE games SET updated_at='2026-09-14 00:00:00'")
        await db.conn.commit()
        # 5 局 / 每页 2 → 页序：id5,id4 | id3,id2 | id1
        assert await repos.locate_game_page(db.conn, ids[4], page_size=2) == 1
        assert await repos.locate_game_page(db.conn, ids[3], page_size=2) == 1
        assert await repos.locate_game_page(db.conn, ids[2], page_size=2) == 2
        assert await repos.locate_game_page(db.conn, ids[1], page_size=2) == 2
        assert await repos.locate_game_page(db.conn, ids[0], page_size=2) == 3

    async def test_updated_at_precedes_id(self, db):
        """排序键＝(updated_at DESC, id DESC)：更新更晚者在前（即使 id 更小）。"""
        a = await _mk(db)
        await _mk(db)  # 干扰项（同一时间戳下 id 更大 → 默认排在 a 前）
        # 相对时间戳（禁墙钟硬编码，BUG-001/002 同类）：a 的更新必然晚于干扰项
        await db.conn.execute(
            "UPDATE games SET updated_at=datetime('now','+1 hour') WHERE id=?", (a,)
        )
        await db.conn.commit()
        assert await repos.locate_game_page(db.conn, a, page_size=1) == 1

    async def test_missing_or_filtered_returns_none(self, db):
        g1 = await repos.create_game(
            db.conn, mode="human_human", black_name="张三", white_name="王五"
        )
        g2 = await _mk(db)
        await repos.set_game_favorite(db.conn, g1, True)
        assert await repos.locate_game_page(db.conn, 9999, page_size=10) is None
        # 不匹配过滤 → 不存在于任何页
        assert await repos.locate_game_page(db.conn, g2, favorite=True, page_size=10) is None
        assert await repos.locate_game_page(db.conn, g1, favorite=True, page_size=10) == 1
        await repos.update_game_status(db.conn, g2, "finished")
        assert await repos.locate_game_page(db.conn, g2, status="created", page_size=10) is None
        assert await repos.locate_game_page(db.conn, g2, status="finished", page_size=10) == 1
        assert await repos.locate_game_page(db.conn, g2, name="张三", page_size=10) is None
        assert await repos.locate_game_page(db.conn, g1, name="张三", page_size=10) == 1

    async def test_consistent_with_list_pagination(self, db):
        """定位页必须真的包含该对局（与 list_games 分页同口径，打散更新时间）。"""
        ids = [await _mk(db) for _ in range(7)]
        for i, gid in enumerate(ids):
            await db.conn.execute(
                "UPDATE games SET updated_at=? WHERE id=?",
                (f"2026-09-14 0{i % 3}:00:00", gid),
            )
        await db.conn.commit()
        size = 3
        for gid in ids:
            page = await repos.locate_game_page(db.conn, gid, page_size=size)
            assert page is not None
            _, items = await repos.list_games(db.conn, page=page, page_size=size)
            assert gid in [i["id"] for i in items]


class TestActiveLatest:
    async def test_returns_latest_active(self, db):
        a = await _mk(db)
        await repos.update_game_status(db.conn, a, "active")
        b = await _mk(db)
        await repos.update_game_status(db.conn, b, "active")
        # 手动把 b 的 updated_at 推到更晚（相对 SQLite now 的未来时间，避免依赖墙钟）
        await db.conn.execute(
            "UPDATE games SET updated_at=datetime('now', '+1 hour') WHERE id=?", (b,)
        )
        await db.conn.commit()
        latest = await repos.get_active_latest(db.conn)
        assert latest["id"] == b

    async def test_ignores_non_active(self, db):
        created = await _mk(db)
        await repos.update_game_status(db.conn, created, "created")
        scoring = await _mk(db)
        await repos.update_game_status(db.conn, scoring, "scoring")
        finished = await _mk(db)
        await repos.set_game_result(db.conn, finished, "B+7.5")
        # 全部非 active → 无最近进行中对局
        assert await repos.get_active_latest(db.conn) is None

    async def test_empty_db(self, db):
        assert await repos.get_active_latest(db.conn) is None


class TestUpdates:
    async def test_status_update(self, db):
        g = await _mk(db)
        await repos.update_game_status(db.conn, g, "active")
        assert (await repos.get_game(db.conn, g))["status"] == "active"

    async def test_last_move_no(self, db):
        g = await _mk(db)
        await repos.set_game_last_move_no(db.conn, g, 3)
        assert (await repos.get_game(db.conn, g))["last_move_no"] == 3

    async def test_result(self, db):
        g = await _mk(db)
        await repos.set_game_result(db.conn, g, "B+7.5")
        game = await repos.get_game(db.conn, g)
        assert game["status"] == "finished"
        assert game["result"] == "B+7.5"
        assert game["finished_at"] is not None

    async def test_favorite_toggle(self, db):
        g = await _mk(db)
        await repos.set_game_favorite(db.conn, g, True)
        assert (await repos.get_game(db.conn, g))["favorite"] == 1
        await repos.set_game_favorite(db.conn, g, False)
        assert (await repos.get_game(db.conn, g))["favorite"] == 0

    async def test_add_captures_accumulates_per_color(self, db):
        """ISSUE-047 方案 1：提子数按执色累计（0 跳过）。"""
        g = await _mk(db)
        await repos.add_captures(db.conn, g, "B", 2)
        await repos.add_captures(db.conn, g, "B", 1)
        await repos.add_captures(db.conn, g, "W", 3)
        await repos.add_captures(db.conn, g, "B", 0)  # 0 无变化
        game = await repos.get_game(db.conn, g)
        assert game["black_captures"] == 3
        assert game["white_captures"] == 3


class TestDeleteGame:
    async def test_delete_existing(self, db):
        g = await _mk(db)
        assert await repos.delete_game(db.conn, g) is True
        assert await repos.get_game(db.conn, g) is None

    async def test_delete_missing(self, db):
        assert await repos.delete_game(db.conn, 9999) is False
