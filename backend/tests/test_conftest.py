"""T0.5 测试基座验证：fixtures 可复用、无真实引擎/GPU、无硬等待。

用例 ID: FIX-*
"""

import asyncio
import logging
from pathlib import Path

import pytest

from tests import conftest as conftest_mod
from tests.conftest import isolate_root_logging


class _StubFileHandler(logging.Handler):
    """仅暴露 ``baseFilename`` 的替身（守卫只读该属性，避免真实打开产品日志文件）。"""

    def __init__(self, path: Path) -> None:
        super().__init__()
        self.baseFilename = str(path)


class TestFakeTime:
    async def test_sleep_advances_virtual_clock(self, fake_time):
        """sleep(>0) 立即返回并推进虚拟时钟（不真实等待）。"""
        await fake_time.sleep(5)
        await fake_time.sleep(0.2)
        assert fake_time.now == pytest.approx(5.2)

    async def test_sleep_zero_yields_event_loop(self, fake_time):
        """sleep(0) 保留真实让出语义（任务切换不受影响）。"""
        order = []

        async def worker():
            await fake_time.sleep(0)
            order.append("worker")

        task = asyncio.create_task(worker())
        order.append("main")
        await task
        assert order == ["main", "worker"]

    def test_manual_advance(self, fake_time):
        fake_time.advance(30)
        assert fake_time.now == 30


class TestDbConn:
    async def test_memory_conn_usable(self, db_conn):
        """`:memory:` 连接可执行基础 SQL。"""
        await db_conn.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
        await db_conn.execute("INSERT INTO t(v) VALUES ('x')")
        await db_conn.commit()
        cur = await db_conn.execute("SELECT v FROM t")
        row = await cur.fetchone()
        assert row["v"] == "x"

    async def test_memory_conn_isolated_per_test(self, db_conn):
        """每个测试独立内存库（无跨测试残留）。"""
        cur = await db_conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        rows = await cur.fetchall()
        assert rows == []  # 上一测试创建的表不残留


class TestEngineMock:
    def test_is_async_mock(self, engine_mock):
        from unittest.mock import AsyncMock

        assert isinstance(engine_mock.query, AsyncMock)
        assert isinstance(engine_mock.start, AsyncMock)

    async def test_query_awaitable(self, engine_mock):
        result = await engine_mock.query()
        assert result == {"id": "mock"}


class TestSamplesDir:
    def test_samples_dir_exists(self, samples_dir):
        assert samples_dir.is_dir()
        assert (samples_dir / "README.md").exists()


class TestRootLoggingIsolation:
    """FIX-05..08：日志器隔离守卫（BUG-128：用例不得把日志写进产品 ``logs/``）。"""

    def test_product_log_handlers_filtered_by_dir(self, tmp_path):
        """FIX-05：仅产品日志目录（``<项目根>/logs``）下的文件 handler 被判越界。"""
        product = _StubFileHandler(conftest_mod.PRODUCT_LOG_DIR / "tgo.log")
        temp = _StubFileHandler(tmp_path / "logs" / "tgo.log")
        assert conftest_mod._product_log_handlers([product, temp]) == [product]

    def test_guard_recycles_pre_existing_product_handler(self):
        """FIX-06：进入用例即回收会话中已泄漏的产品 handler（不牵连后续用例，且不报错）。"""
        root = logging.getLogger()
        stale = _StubFileHandler(conftest_mod.PRODUCT_LOG_DIR / "engine.log")
        root.addHandler(stale)
        try:
            guard = isolate_root_logging.__wrapped__()  # type: ignore[attr-defined]
            next(guard)
            assert stale not in root.handlers
            list(guard)  # 走到用例出口：无越界 handler → 正常收尾（不失败）
        finally:
            root.removeHandler(stale)

    def test_guard_fails_when_case_leaks_product_handler(self):
        """FIX-07：用例新增产品 handler → 退出时快速失败并回收（不静默污染）。"""
        root = logging.getLogger()
        leaked = _StubFileHandler(conftest_mod.PRODUCT_LOG_DIR / "tgo.log")
        guard = isolate_root_logging.__wrapped__()  # type: ignore[attr-defined]
        next(guard)
        root.addHandler(leaked)
        with pytest.raises(pytest.fail.Exception):
            next(guard)
        assert leaked not in root.handlers

    def test_guard_catches_named_logger_product_handler(self):
        """FIX-08：**具名日志器**上的产品 handler（如 `tgo.engine` 的 `engine.log`）同样判越界并回收。"""
        engine_logger = logging.getLogger("tgo.engine.probe")
        leaked = _StubFileHandler(conftest_mod.PRODUCT_LOG_DIR / "engine.log")
        guard = isolate_root_logging.__wrapped__()  # type: ignore[attr-defined]
        next(guard)
        engine_logger.addHandler(leaked)
        with pytest.raises(pytest.fail.Exception):
            next(guard)
        assert leaked not in engine_logger.handlers
