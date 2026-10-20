"""事件循环连接重置噪音过滤（2026/09/13，移动端断连日志修复）。

用例 ID: LOOPG-*

背景：Windows Proactor 下对端强制断开（`WinError 10054`）时，transport 收尾
回调对已重置 socket 调 `shutdown()` 抛 `ConnectionResetError`，经事件循环默认
异常处理器打印全量 Traceback（连接早已失效，属预期收尾噪音）。本组用例锁定
过滤边界：仅吞「回调上下文中的 ConnectionResetError」，其余一律交还默认处理器。
"""

from __future__ import annotations

import asyncio
import logging

from app.core.loop_guard import (
    install_loop_exception_guard,
    is_benign_transport_reset,
    make_loop_exception_handler,
)

RESET = ConnectionResetError(10054, "远程主机强迫关闭了一个现有的连接。")


class TestIsBenignTransportReset:
    def test_callback_connection_reset_is_benign(self):
        """回调上下文（handle、非 task）中的 ConnectionResetError → 视为噪音。"""
        context = {"exception": RESET, "handle": object(), "message": "Exception in callback ..."}
        assert is_benign_transport_reset(context) is True

    def test_other_exception_not_benign(self):
        context = {"exception": ValueError("boom"), "handle": object()}
        assert is_benign_transport_reset(context) is False

    def test_task_context_not_benign(self):
        """任务异常可能隐藏真实缺陷：同为 ConnectionResetError 也不得过滤。"""
        context = {"exception": RESET, "task": object()}
        assert is_benign_transport_reset(context) is False

    def test_missing_handle_not_benign(self):
        assert is_benign_transport_reset({"exception": RESET}) is False

    def test_missing_exception_not_benign(self):
        assert is_benign_transport_reset({"handle": object()}) is False


class TestLoopExceptionHandler:
    def test_benign_reset_filtered_with_debug_log(self, caplog):
        delegated = []
        handler = make_loop_exception_handler(delegated.append)
        # DEBUG 为应用命名空间专属（2026/09/20 日志治理）：采集须显式指向日志器
        with caplog.at_level(logging.DEBUG, logger="app.core.loop_guard"):
            handler(None, {"exception": RESET, "handle": object()})  # type: ignore[arg-type]
        assert delegated == []
        records = [r for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("连接重置噪音" in r.getMessage() for r in records)

    def test_other_contexts_delegated_to_default(self):
        delegated = []
        handler = make_loop_exception_handler(delegated.append)
        other = {"exception": RuntimeError("x"), "handle": object()}
        handler(None, other)  # type: ignore[arg-type]
        assert delegated == [other]

        task_reset = {"exception": RESET, "task": object()}
        handler(None, task_reset)  # type: ignore[arg-type]
        assert delegated == [other, task_reset]


class TestInstall:
    async def test_install_binds_handler_to_running_loop(self, caplog):
        loop = asyncio.get_running_loop()
        original = loop.get_exception_handler()
        try:
            install_loop_exception_guard()
            handler = loop.get_exception_handler()
            assert handler is not None and handler is not original

            # 良性噪音：被过滤（不抛、不落到默认处理器）
            with caplog.at_level(logging.DEBUG, logger="app.core.loop_guard"):
                handler(loop, {"exception": RESET, "handle": object()})
            assert any("连接重置噪音" in r.getMessage() for r in caplog.records)

            # 其它异常：仍沿用默认处理器（此处仅验证不抛、路径可走）
            handler(loop, {"exception": RuntimeError("boom"), "handle": object()})
        finally:
            loop.set_exception_handler(original)
