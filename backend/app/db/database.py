"""SQLite 连接管理 + 迁移执行器（DATABASE §4，唯一事实源）。

- 基线 DDL 位于 `schema.sql`（全部 `IF NOT EXISTS`，幂等可重执行）；
- 增量迁移位于 `migrations/NNNN_描述.sql`，按 NNNN 前缀升序执行；
- `schema_migrations` 记录已应用版本，重复启动不重复执行；
- 强制开启 `PRAGMA foreign_keys = ON`（支持 ON DELETE CASCADE）。
"""

from __future__ import annotations

import logging
import threading
import weakref
from pathlib import Path
from typing import Callable, Optional

import aiosqlite

logger = logging.getLogger(__name__)

SCHEMA_FILE = "schema.sql"
MIGRATIONS_DIR = "migrations"

#: `threading._register_atexit`：在解释器 join 非 daemon 线程**之前**执行的钩子
#: （`concurrent.futures` 同款内部 API，CPython ≥3.8 稳定存在）。用 `getattr` 取——
#: 该私有属性不在 typeshed 中；**无默认值**：缺失即导入期快速失败，不得静默失去担保。
_register_before_thread_join: Callable[[Callable[[], None]], None] = getattr(
    threading, "_register_atexit"
)

#: 存活 aiosqlite 连接登记（解释器退出前的兼底释放，见 `_release_open_connections`）。
#: 用 `WeakSet`：连接被正常关闭后条目自然消失，不阻断回收。
_open_connections: "weakref.WeakSet[aiosqlite.Connection]" = weakref.WeakSet()
_exit_hook_installed = False


def _release_open_connections() -> None:
    """解释器退出前的**同步**兼底释放（无需事件循环）。

    背景（BUG-122，2026/09/20）：aiosqlite 为每个连接起一个**非 daemon** 工作线程，
    阻塞在内部队列读取上，直到收到 `Connection.close()/stop()` 写入的停用哨兵。若关停
    路径未走到 `close()`，解释器收尾的 `threading._shutdown()` 会**永久阻塞**在该线程的
    join 上——现象：Ctrl+C 后进程无法退出，再次 Ctrl+C 打出
    「Exception ignored while joining a thread in _thread._shutdown()」。
    本函数在此处兜底（用 `Connection.stop()`——公开的同步 API，无事件循环也可用）。
    """
    for conn in list(_open_connections):
        try:
            conn.stop()
        except Exception:  # noqa: BLE001 - 退出钩子不得因单条连接异常中断其余释放
            logger.exception("解释器退出前释放数据库连接失败（已跳过）")


def _install_exit_hook() -> None:
    """安装一次性退出钩子（**必须早于线程 join**）。

    钩子时机：`threading._register_atexit`（`concurrent.futures` 同款内部 API）在
    `threading._shutdown()` 之前执行；普通 `atexit.register` **太晚**（实测仍卡死，
    2026/09/20）。
    """
    global _exit_hook_installed
    if _exit_hook_installed:
        return
    _register_before_thread_join(_release_open_connections)
    _exit_hook_installed = True


def _default_schema_path() -> Path:
    return Path(__file__).with_name(SCHEMA_FILE)


def _default_migrations_dir() -> Path:
    return Path(__file__).with_name(MIGRATIONS_DIR)


class Database:
    """aiosqlite 连接与迁移执行器。

    用法::

        db = Database(":memory:")          # 测试一律 :memory:（AGENTS.md §7）
        await db.connect()
        await db.conn.execute(...)         # 仓储层函数以 conn 为入参
        await db.close()
    """

    def __init__(
        self,
        path: str,
        *,
        schema_path: Optional[Path] = None,
        migrations_dir: Optional[Path] = None,
    ) -> None:
        self.path = path
        self._schema_path = schema_path or _default_schema_path()
        self._migrations_dir = migrations_dir or _default_migrations_dir()
        self._conn: Optional[aiosqlite.Connection] = None

    @property
    def conn(self) -> aiosqlite.Connection:
        """已连接的可写连接；未连接时抛出（快速失败）。"""
        if self._conn is None:
            raise RuntimeError("数据库尚未连接，请先调用 connect()")
        return self._conn

    async def connect(self) -> aiosqlite.Connection:
        """建立连接、开启外键约束、应用迁移，返回连接。

        文件型数据库自动创建父目录（ISSUE-045：首启无需手工预建 ``data/``；
        调用方应将相对路径经 ``config.project_path`` 锚定项目根）。
        """
        if self.path and self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA foreign_keys = ON")
        await self._conn.commit()
        _open_connections.add(self._conn)
        _install_exit_hook()
        await self.run_migrations()
        return self._conn

    async def close(self) -> None:
        """关闭连接（事件循环内正常关停路径）。"""
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    def release_sync(self) -> None:
        """**同步**释放连接（循环外可用；`Force exit`/异常路径的兼底）。

        Calls `aiosqlite.Connection.stop()`——该 API 不依赖事件循环（源码：
        `get_event_loop()` 失败时仍照常投递停用哨兵），故可在事件循环已关闭
        （如 uvicorn `force_exit` 跳过 lifespan 关停）时调用：工作线程退出，
        `threading._shutdown()` 不再永久阻塞。幂等：未连接/已关闭时为空操作。
        """
        conn = self._conn
        self._conn = None
        if conn is not None:
            conn.stop()

    async def run_migrations(self) -> None:
        """应用基线 schema + 未应用的增量迁移（幂等）。"""
        conn = self.conn
        # 1. 基线 DDL（全部 IF NOT EXISTS，重复执行无害）
        await conn.executescript(self._schema_path.read_text(encoding="utf-8"))
        await conn.commit()

        # 2. 已应用版本集合
        cursor = await conn.execute("SELECT version FROM schema_migrations")
        rows = await cursor.fetchall()
        applied = {int(row["version"]) for row in rows}

        # 3. 顺序应用未执行的增量迁移
        for migration in sorted(self._migrations_dir.glob("[0-9]*.sql")):
            version = int(migration.name.split("_", 1)[0])
            if version in applied:
                continue
            await conn.executescript(migration.read_text(encoding="utf-8"))
            await conn.execute("INSERT INTO schema_migrations(version) VALUES (?)", (version,))
            await conn.commit()
            logger.info("已应用数据库迁移：%s", migration.name)
