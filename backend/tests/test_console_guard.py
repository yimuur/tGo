"""非阻塞控制台输出（机制 A / BUG-127，2026/09/21 现场反馈）。

用例 ID: CG-*

背景：root logger 的控制台 ``StreamHandler`` 是**同步写**，而应用日志（WS 回调 /
引擎管理器 / uvicorn 访问日志）都在**事件循环线程**内发出。Windows 控制台一旦进入
「标记/选择」状态（快速编辑模式下拖选/点击），或因输出被暂停（Ctrl+S、管道消费者停读）
而不再消费输出，进程的 ``write(stderr)`` 就会**阻塞** → **整个 asyncio 循环停摆**：
端口仍被内核接受握手、但应用不处理任何连接 ⇒ 客户端全部超时（现场现象），
在窗口里按一下键（解除选择）后立刻恢复并一次性吐出积压日志。

本组用例锁定修复契约：控制台写入必须移出事件循环线程（有界队列 + 后台 daemon 线程，
溢出丢弃并计数；单行超长截断；写失败丢弃不抛出；关停有界）。
"""

from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time

import pytest

from app.core import console_guard
from app.core.console_guard import NonBlockingWriter, install_nonblocking_console


class BlockingSink:
    """假控制台：``write`` 阻塞直到 ``release()``（模拟被冻结的控制台/管道）。

    ``wait_entered`` 用于确认「写线程确实卡在 write 里」——后续断言才有意义。
    """

    def __init__(self, *, block: bool = True) -> None:
        self._gate = threading.Event()
        self._entered = threading.Event()
        self.block = block
        self.chunks: list[str] = []
        self.fail_writes = 0
        self.isatty_calls = 0

    # ---- 假控制台接口（NonBlockingWriter 会透传/写入）----
    def write(self, text: str) -> int:
        self._entered.set()
        if self.block:
            self._gate.wait(5.0)
        if self.fail_writes > 0:
            self.fail_writes -= 1
            raise OSError(22, "控制台已关闭")
        self.chunks.append(text)
        return len(text)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        self.isatty_calls += 1
        return True

    def fileno(self) -> int:
        return 1

    # ---- 测试控制 ----
    def release(self) -> None:
        self._gate.set()

    def wait_entered(self, timeout: float = 2.0) -> bool:
        return self._entered.wait(timeout)

    def wait_chunks(self, count: int, timeout: float = 2.0) -> bool:
        """有界窗口轮询（禁瞬时断言）：等到累计片段数 ≥ count。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if len(self.chunks) >= count:
                return True
            time.sleep(0.01)
        return len(self.chunks) >= count


@pytest.fixture(autouse=True)
def _isolate_console_guard():
    """隔离：每个用例前后复位安装状态与共享代理（避免跨用例泄漏线程/状态）。"""
    yield
    console_guard._reset_for_test()


class TestNonBlockingWriter:
    def test_write_returns_while_sink_is_frozen(self):
        """冻结期间：调用方 write 必须立即返回（不得卡在 sink.write 里）。"""
        sink = BlockingSink()
        writer = NonBlockingWriter(sink)

        done = threading.Event()
        threading.Thread(target=lambda: (writer.write("第一行\n"), done.set()), daemon=True).start()
        assert done.wait(2.0), "write 在控制台冻结时不得阻塞调用方"
        assert sink.wait_entered(2.0), "后台写线程应已进入 sink.write 并被冻结"

        sink.release()
        assert sink.wait_chunks(1), "解冻后积压片段应写出"

    async def test_event_loop_keeps_running_while_console_frozen(self):
        """核心契约：控制台冻结期间，事件循环必须照常推进（修复前为整循环停摆）。"""
        sink = BlockingSink()
        handler = logging.StreamHandler(NonBlockingWriter(sink))
        logger = logging.getLogger("app.test.console_guard")
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.01)

        task = asyncio.create_task(ticker())
        try:
            logger.info("先把写线程卡住")
            assert sink.wait_entered(2.0), "写线程应已进入 sink.write（冻结生效）"

            before = ticks
            for index in range(50):
                logger.info("冻结期日志 %d", index)  # 事件循环线程内同步发出

            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and ticks <= before:
                await asyncio.sleep(0.01)
            assert ticks > before, "控制台冻结期间事件循环必须继续运行"

            sink.release()
            assert sink.wait_chunks(51), "解冻后 51 条日志应完整写出"
        finally:
            task.cancel()
            logger.removeHandler(handler)
            logging.getLogger("app.test.console_guard").setLevel(logging.NOTSET)

    def test_overflow_drops_oldest_and_reports_once(self):
        """队列有界：溢出丢弃并计数，且只投递一条「已丢弃 N 条」提示（不刷屏）。"""
        sink = BlockingSink()
        writer = NonBlockingWriter(sink, max_pending=3)
        writer.write("先卡住\n")
        assert sink.wait_entered(2.0), "先让写线程卡在 sink.write（后续计数才可确定）"
        for index in range(10):
            writer.write(f"日志 {index}\n")
        assert writer.dropped == 7, "队列容量 3 之外的 7 条应被丢弃并计数"

        sink.release()
        assert sink.wait_chunks(4), "在途 1 条 + 队列 3 条应写出"
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and not any("已丢弃" in c for c in sink.chunks):
            time.sleep(0.01)
        notices = [c for c in sink.chunks if "已丢弃" in c]
        assert len(notices) == 1 and "7" in notices[0], "应只有一条丢弃提示且携带条数"

    def test_oversized_chunk_is_truncated(self):
        """单行超长（误打印大对象）→ 截断并标注，避免撑爆控制台/队列。"""
        sink = BlockingSink()
        writer = NonBlockingWriter(sink)
        writer.write("x" * (console_guard._MAX_CHUNK_CHARS + 500))

        sink.release()
        assert sink.wait_chunks(1)
        chunk = sink.chunks[0]
        assert len(chunk) < console_guard._MAX_CHUNK_CHARS + 200
        assert "截断" in chunk

    def test_sink_error_drops_chunk_without_raising(self):
        """控制台已关闭（EPIPE/句柄失效）→ 丢弃该片段继续服务，不得抛出到调用方。"""
        sink = BlockingSink(block=False)
        sink.fail_writes = 1
        writer = NonBlockingWriter(sink)
        writer.write("会失败\n")
        writer.write("应成功\n")
        assert sink.wait_chunks(1, timeout=2.0)
        assert sink.chunks == ["应成功\n"]

    def test_close_and_drain_are_bounded_even_if_frozen(self):
        """关停有界：控制台冻结时 drain 也必须在有界时间内返回（不得挂死退出）。"""
        sink = BlockingSink()
        writer = NonBlockingWriter(sink)
        writer.write("释放前的一条\n")
        assert sink.wait_entered(2.0)

        started = time.monotonic()
        writer.close(timeout_s=0.2)
        assert time.monotonic() - started < 2.0, "关停必须有界（不得等待冻结的控制台）"
        assert writer.dropped >= 0

    def test_attributes_passthrough(self):
        """透传 isatty/fileno 等属性（uvicorn 颜色判定、库代码兼容）。"""
        sink = BlockingSink(block=False)
        writer = NonBlockingWriter(sink)
        assert writer.isatty() is True
        assert writer.fileno() == 1
        assert sink.isatty_calls == 1


class TestInstall:
    def _stderr_handler(self) -> logging.Handler:
        handler = logging.StreamHandler(sys.stderr)
        logging.getLogger("app.test.install").addHandler(handler)
        return handler

    def test_retargets_existing_stream_handlers(self):
        """安装后：绑定真实控制台的既有 handler（含 uvicorn 的）必须改指非阻塞代理。"""
        handler = self._stderr_handler()
        target = handler.stream
        try:
            assert install_nonblocking_console() is True
            assert isinstance(handler.stream, NonBlockingWriter)
            assert handler.stream is not target
        finally:
            logging.getLogger("app.test.install").removeHandler(handler)

    def test_same_stream_shares_one_proxy_and_install_is_idempotent(self):
        """同一底层流复用同一代理（不重复起线程）；重复安装为空操作。"""
        first = self._stderr_handler()
        second = self._stderr_handler()
        try:
            install_nonblocking_console()
            assert first.stream is second.stream, "同一 stderr 的两个 handler 应共享代理"
            before = first.stream
            assert install_nonblocking_console() is False, "重复安装应为空操作"
            assert first.stream is before
        finally:
            for handler in (first, second):
                logging.getLogger("app.test.install").removeHandler(handler)

    def test_non_stream_handlers_untouched(self):
        """非控制台 handler（如文件 / pytest 捕获用 StringIO）不得被改写。"""
        import io

        handler = logging.StreamHandler(io.StringIO())
        logging.getLogger("app.test.install").addHandler(handler)
        try:
            install_nonblocking_console()
            assert not isinstance(handler.stream, NonBlockingWriter)
        finally:
            logging.getLogger("app.test.install").removeHandler(handler)


class TestLoggingSetupIntegration:
    def test_late_third_party_handler_is_retargeted_by_setup_logging(self, tmp_path):
        """安装**之后**由三方 logger 自建的控制台 handler：日志初始化时重扫改指。

        2026/09/21 隔离探针暴露的缺口：只做一次「安装时改指」时，安装后新建的 handler
        仍绑定真实控制台 → 冻结时又会阻塞事件循环。故 `setup_logging` 每次重扫一次。
        """
        from app.config import LoggingConfig
        from app.core.logging_setup import setup_logging

        assert install_nonblocking_console() is True
        late = logging.StreamHandler(sys.stderr)  # 安装之后才创建（模拟三方 logger 自建）
        owner = logging.getLogger("uvicorn.access")
        owner.addHandler(late)
        try:
            setup_logging(LoggingConfig(dir=str(tmp_path / "logs")))
            assert isinstance(late.stream, NonBlockingWriter), "重扫必须接管后建的控制台 handler"
        finally:
            owner.removeHandler(late)

    def test_setup_logging_console_handler_is_nonblocking(self, tmp_path):
        """产品控制台 handler（`setup_logging`）必须是非阻塞代理——修复的核心落点。"""
        from app.config import LoggingConfig
        from app.core.logging_setup import setup_logging

        root = logging.getLogger()
        snapshot = list(root.handlers)
        try:
            setup_logging(LoggingConfig(dir=str(tmp_path / "logs")))
            console_handlers = [
                h
                for h in root.handlers
                if isinstance(h, logging.StreamHandler)
                and not isinstance(h, logging.FileHandler)
            ]
            assert console_handlers, "root 应挂有控制台 handler"
            assert all(
                isinstance(h.stream, NonBlockingWriter) for h in console_handlers
            ), "控制台 handler 必须使用非阻塞代理"
        finally:
            for handler in list(root.handlers):
                root.removeHandler(handler)
            for handler in snapshot:
                root.addHandler(handler)
