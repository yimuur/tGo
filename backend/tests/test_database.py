"""T1.1 数据库连接与迁移执行器测试：schema、迁移幂等、约束、级联。

用例 ID: DB-*
"""

import asyncio
import threading

import pytest

from app.db import database as db_module
from app.db.database import Database

BASE_TABLES = {"schema_migrations", "players", "games", "moves", "position_analyses", "scorings"}


class TestRelease:
    """BUG-122：连接释放的同步路径 + 解释器退出兼底（防 Ctrl+C 后进程无法退出）。

    背景：aiosqlite 每连接一个**非 daemon** 工作线程，仅 `close()/stop()` 写入的
    停用哨兵能让它退出；若关停路径未走到（uvicorn `force_exit` 跳过 lifespan 关停、
    或关停中途抛异常），解释器收尾的 `threading._shutdown()` 会永久阻塞在该线程
    join 上（现场报错「Exception ignored while joining a thread in _thread._shutdown()」）。
    """

    def test_release_sync_stops_worker_without_loop(self, tmp_path):
        """事件循环已关闭时，`release_sync()` 仍能停掉工作线程（`stop()` 无需循环）。"""
        dbase = Database(str(tmp_path / "t.db"))
        asyncio.run(dbase.connect())
        worker = dbase.conn._thread
        assert worker is not None and worker.daemon is False
        dbase.release_sync()  # 循环已关闭（asyncio.run 已返回）
        worker.join(timeout=5)
        assert not worker.is_alive()
        with pytest.raises(RuntimeError):  # 公共接入点：已释放
            _ = dbase.conn

    def test_release_sync_is_idempotent(self, tmp_path):
        """未连接/重复释放均为空操作（幂等）。"""
        dbase = Database(str(tmp_path / "t.db"))
        dbase.release_sync()  # 未连接
        asyncio.run(dbase.connect())
        dbase.release_sync()
        dbase.release_sync()  # 重复
        with pytest.raises(RuntimeError):
            _ = dbase.conn

    def test_exit_hook_stops_tracked_connections_once(self, tmp_path):
        """退出钩子：必须挂在「join 非 daemon 线程之前」的登记表、只注册一次，且本体会同步释放未关连接。"""
        def _hooks_wrapping(func):
            """在 `_threading_atexits` 中找出包装了 `func` 的登记项（stdlib 以 lambda 包装）。"""
            found = []
            for hook in threading._threading_atexits:  # noqa: SLF001 - stdlib：join 前执行
                for cell in getattr(hook, "__closure__", None) or ():
                    try:
                        if cell.cell_contents is func:
                            found.append(hook)
                    except ValueError:  # 空单元格（未绑定）
                        continue
            return found

        dbase = Database(str(tmp_path / "a.db"))
        asyncio.run(dbase.connect())
        registered = _hooks_wrapping(db_module._release_open_connections)
        assert registered, "退出钩子必须注册（否则未关连接的线程会阻塞解释器收尾）"

        other = Database(str(tmp_path / "b.db"))
        asyncio.run(other.connect())
        assert len(_hooks_wrapping(db_module._release_open_connections)) == len(registered)  # 不重复注册

        worker = dbase.conn._thread
        db_module._release_open_connections()  # 模拟解释器退出前的兼底调用
        worker.join(timeout=5)
        assert not worker.is_alive()


class TestSchema:
    async def test_all_tables_created(self, db):
        """基线 schema 全表创建成功。"""
        cur = await db.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
        tables = {row["name"] for row in await cur.fetchall()}
        assert BASE_TABLES <= tables

    async def test_indexes_created(self, db):
        """基线索引创建成功。"""
        cur = await db.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
        )
        indexes = {row["name"] for row in await cur.fetchall()}
        assert {"idx_games_status", "idx_games_favorite", "idx_moves_game"} <= indexes

    async def test_check_constraint_mode(self, db):
        """games.mode CHECK 约束生效。"""
        with pytest.raises(Exception):
            await db.conn.execute(
                "INSERT INTO games(mode) VALUES ('invalid_mode')"
            )
        await db.conn.commit()

    async def test_check_constraint_status(self, db):
        """games.status CHECK 约束生效（仅 created/active/scoring/finished）。"""
        with pytest.raises(Exception):
            await db.conn.execute(
                "INSERT INTO games(mode, status) VALUES ('human_human', 'bogus')"
            )
        await db.conn.commit()

    async def test_unique_game_move(self, db):
        """moves (game_id, move_no) UNIQUE 约束生效。"""
        await db.conn.execute("INSERT INTO games(mode) VALUES ('human_human')")
        await db.conn.commit()
        cur = await db.conn.execute("SELECT id FROM games")
        game_id = (await cur.fetchone())["id"]
        await db.conn.execute(
            "INSERT INTO moves(game_id, move_no, color, x, y) VALUES (?,?,?,?,?)",
            (game_id, 1, "B", 9, 9),
        )
        await db.conn.commit()
        with pytest.raises(Exception):
            await db.conn.execute(
                "INSERT INTO moves(game_id, move_no, color, x, y) VALUES (?,?,?,?,?)",
                (game_id, 1, "W", 3, 3),
            )
        await db.conn.commit()


class TestMigrations:
    async def test_migrations_idempotent(self, db):
        """重复执行迁移不重复应用（schema_migrations 记录稳定）。"""
        await db.run_migrations()
        cur = await db.conn.execute("SELECT COUNT(*) AS n FROM schema_migrations")
        n1 = (await cur.fetchone())["n"]
        await db.run_migrations()
        cur = await db.conn.execute("SELECT COUNT(*) AS n FROM schema_migrations")
        n2 = (await cur.fetchone())["n"]
        # 2026/09/18 迁移基线化后仓库迁移目录为空：记录数恒稳；
        # 机制级“新增迁移只应用一次”见 DB-07（DB-11 守护基线完整性）
        assert n1 == n2

    async def test_new_migration_applied_once(self, tmp_path):
        """新增量迁移只应用一次，并记录版本。"""
        # 独立临时迁移目录，验证增量迁移机制（不污染仓库 migrations/）
        mig_dir = tmp_path / "migrations"
        mig_dir.mkdir()
        (mig_dir / "0001_add_marker_table.sql").write_text(
            "CREATE TABLE IF NOT EXISTS marker_table(id INTEGER PRIMARY KEY);",
            encoding="utf-8",
        )
        db = Database(":memory:", migrations_dir=mig_dir)
        await db.connect()
        cur = await db.conn.execute("SELECT version FROM schema_migrations")
        versions = [row["version"] for row in await cur.fetchall()]
        assert 1 in versions
        cur = await db.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='marker_table'"
        )
        assert (await cur.fetchone()) is not None
        # 再跑一次：不重复应用
        await db.run_migrations()
        cur = await db.conn.execute(
            "SELECT COUNT(*) AS n FROM schema_migrations WHERE version=1"
        )
        assert (await cur.fetchone())["n"] == 1
        await db.close()

    async def test_baseline_complete_without_migrations(self, tmp_path):
        """基线已吸收历史增量（2026/09/18 合并 0001-0005）：无迁移条目时结构仍完整。"""
        empty_dir = tmp_path / "migrations"
        empty_dir.mkdir()
        db = Database(":memory:", migrations_dir=empty_dir)
        await db.connect()
        try:
            cur = await db.conn.execute("PRAGMA table_info(games)")
            columns = {row["name"] for row in await cur.fetchall()}
            assert {
                "undo_count",
                "black_captures",
                "white_captures",
                "pass_reset_move_no",
                "chain_visits",
            } <= columns
            # 全新库簿记为空：schema_migrations 仅记录真实应用过的增量条目
            cur = await db.conn.execute("SELECT COUNT(*) AS n FROM schema_migrations")
            assert (await cur.fetchone())["n"] == 0
        finally:
            await db.close()

    async def test_in_memory_mode(self):
        """`:memory:` 模式可用。"""
        db = Database(":memory:")
        await db.connect()
        cur = await db.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {row["name"] for row in await cur.fetchall()}
        assert BASE_TABLES <= tables
        await db.close()

    async def test_connect_creates_missing_parent_dir(self, tmp_path):
        """ISSUE-045：文件型数据库父目录缺失时自动创建（首启免手工预建 data/）。"""
        db_file = tmp_path / "data" / "tgo.db"
        db = Database(str(db_file))
        await db.connect()
        try:
            assert db_file.exists()
        finally:
            await db.close()


class TestForeignKeyCascade:
    async def test_delete_game_cascades(self, db):
        """外键级联：删除对局清理 moves / position_analyses / scorings。"""
        await db.conn.execute("INSERT INTO games(mode) VALUES ('human_human')")
        await db.conn.commit()
        cur = await db.conn.execute("SELECT id FROM games")
        game_id = (await cur.fetchone())["id"]
        await db.conn.execute(
            "INSERT INTO moves(game_id, move_no, color, x, y) VALUES (?,?,?,?,?)",
            (game_id, 1, "B", 9, 9),
        )
        await db.conn.execute(
            "INSERT INTO position_analyses(game_id, position_key, data_json, max_visits)"
            " VALUES (?,?,?,?)",
            (game_id, "main:0", "{}", 100),
        )
        await db.conn.execute(
            "INSERT INTO scorings(game_id, result) VALUES (?, 'B+7.5')",
            (game_id,),
        )
        await db.conn.execute("DELETE FROM games WHERE id=?", (game_id,))
        await db.conn.commit()

        for table in ("moves", "position_analyses", "scorings"):
            cur = await db.conn.execute(f"SELECT COUNT(*) AS n FROM {table} WHERE game_id=?", (game_id,))
            assert (await cur.fetchone())["n"] == 0, f"{table} 应级联删除"
