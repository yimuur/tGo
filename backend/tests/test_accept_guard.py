"""监听 accept 中止保护（BUG-125，2026/09/21 现场反馈）。

用例 ID: ACC-*

背景：Windows Proactor 下客户端在「无待投递 AcceptEx」窗口内中止连接（浏览器预连接、
手机掉网、防火墙/杀软探测）→ `AcceptEx` 以 `ERROR_NETNAME_DELETED(64)` 完成；CPython
`asyncio/proactor_events.py::_start_serving.loop` 对**任何** `OSError` 都 `sock.close()`
且不再重投 accept ⇒ **监听器死亡、进程存活**，此后客户端全部无法连接（实测：监听
`fd=-1`、新连接 `TimeoutError`，须重启进程）。

本组用例锁定修复契约（不启动真实网络会话，故障注入伪 proactor）：
- 分类边界：仅「连接被中止/操作被取消」族（64/995/1236/10054）重投；
- 中止 → 自动重投、监听器不被关闭、成功交接；不可重试错误原样上抛（快速失败）；
- 取消语义：内层（AcceptEx）取消 → 关闭伪套接字；外层取消 → 传播到在途 AcceptEx；
- 日志口径：连续首次 WARNING、其后 DEBUG，成功一次后复位；
- 安装契约：非 Windows 空操作、结构校验缺失即快速失败、幂等。
"""

from __future__ import annotations

import asyncio
import logging
import socket
import sys
import types

import pytest

from app.core import accept_guard
from app.core.accept_guard import install_proactor_accept_retry, is_retryable_accept_error

PEER = ("127.0.0.1", 5555)


def _winerror_exc(winerror: int) -> OSError:
    """真实 `OSError` + 显式 `winerror`（POSIX 构造器不写该属性，测试内补齐）。"""
    exc = OSError(22, "指定的网络名不再可用。")
    exc.winerror = winerror  # type: ignore[attr-defined]
    return exc


class _FakeConn:
    """伪接受套接字（`_get_accept_socket` 的产物）。"""

    def __init__(self) -> None:
        self.closed = False
        self.timeout: float | None = None
        self.setsockopt_calls: list[tuple] = []

    def fileno(self) -> int:
        return 4321

    def settimeout(self, timeout: float | None) -> None:
        self.timeout = timeout

    def setsockopt(self, *args) -> None:
        self.setsockopt_calls.append(args)

    def getpeername(self):
        return PEER

    def close(self) -> None:
        self.closed = True


class _FakeListener:
    """伪监听套接字（`fileno() == -1` 表示监听已失效/已关闭）。"""

    family = socket.AF_INET

    def __init__(self, *, alive: bool = True) -> None:
        self.alive = alive

    def fileno(self) -> int:
        return 1234 if self.alive else -1

    def gettimeout(self) -> float | None:
        return None


class _FakeOverlapped:
    """伪 `_overlapped.Overlapped`：只记录 AcceptEx 调用（不触碰真实 IOCP）。"""

    def __init__(self, null) -> None:
        self.null = null
        self.accept_ex_calls: list[tuple[int, int]] = []

    def AcceptEx(self, listener_fd: int, conn_fd: int) -> None:  # noqa: N802 - 复刻 stdlib 命名
        self.accept_ex_calls.append((listener_fd, conn_fd))


class _FakeProactor:
    """伪 `IocpProactor`：`_register` 按脚本投递完成结果。

    脚本项：``None`` 成功 / ``int`` 以该 winerror 失败 / ``"cancel"`` 内层取消 /
    ``"pending"`` 永不完成（用于外层取消用例）。
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, script: list) -> None:
        self._loop = loop
        self.script = list(script)
        self.conns: list[_FakeConn] = []
        self.register_calls = 0
        self.iocp_registrations = 0
        self.pending_inner: asyncio.Future | None = None

    def _register_with_iocp(self, obj) -> None:
        self.iocp_registrations += 1

    def _get_accept_socket(self, family: int) -> _FakeConn:
        conn = _FakeConn()
        self.conns.append(conn)
        return conn

    def _register(self, overlapped, obj, callback) -> asyncio.Future:
        self.register_calls += 1
        step = self.script.pop(0) if self.script else None
        inner = self._loop.create_future()
        if step == "cancel":
            inner.cancel()
        elif step == "pending":
            self.pending_inner = inner
        elif step is None:
            inner.set_result((self.conns[-1], PEER))
        else:
            inner.set_exception(_winerror_exc(step))
        return inner


def _make_accept():
    return accept_guard._make_accept(
        overlapped_cls=_FakeOverlapped, null=0, so_update_accept_context=0x1234
    )


async def _settle(times: int = 4) -> None:
    """让 `call_soon` 链式回调跑完（重投/取消传播均为回调驱动）。"""
    for _ in range(times):
        await asyncio.sleep(0)


class TestRetryableClassification:
    def test_connection_torn_down_family_is_retryable(self):
        """64（NETNAME_DELETED）/995（OPERATION_ABORTED）/1236（CONNECTION_ABORTED）/
        10054（WSAECONNRESET）：客户端中止同族，重投安全。"""
        for winerror in (64, 995, 1236, 10054):
            assert is_retryable_accept_error(_winerror_exc(winerror)) is True, winerror

    def test_other_failures_are_not_retryable(self):
        """其它错误（拒绝连接/参数非法/无 winerror/非 OSError）一律快速失败。"""
        for exc in (
            _winerror_exc(10061),  # WSAECONNREFUSED
            _winerror_exc(10022),  # WSAEINVAL
            OSError(22, "无 winerror"),
            ValueError("boom"),
            TimeoutError(),
        ):
            assert is_retryable_accept_error(exc) is False, exc


class TestAcceptRetry:
    async def test_aborted_client_retries_and_hands_over(self):
        """中止（winerror 64）→ 自动重投，监听器存活，成功那次套接字交付不关闭。"""
        loop = asyncio.get_running_loop()
        proactor = _FakeProactor(loop, script=[64, None])
        accept = _make_accept()
        listener = _FakeListener()

        result = await accept(proactor, listener)

        assert result == (proactor.conns[-1], PEER)
        assert proactor.register_calls == 2, "中止后必须重投 AcceptEx"
        assert proactor.conns[0].closed is True, "中止那次的伪套接字应释放"
        assert proactor.conns[-1].closed is False, "成功交接的套接字不得关闭"

    async def test_non_retryable_error_propagates(self):
        """不可重试错误原样上抛（快速失败），该次套接字释放、不重投。"""
        loop = asyncio.get_running_loop()
        proactor = _FakeProactor(loop, script=[10061])
        accept = _make_accept()

        with pytest.raises(OSError) as excinfo:
            await accept(proactor, _FakeListener())

        assert getattr(excinfo.value, "winerror", None) == 10061
        assert proactor.register_calls == 1
        assert proactor.conns[0].closed is True

    async def test_retry_stops_when_listener_is_gone(self):
        """监听已失效（fileno()==-1）时不得盲目重投：原样上抛由 asyncio 处置。"""
        loop = asyncio.get_running_loop()
        proactor = _FakeProactor(loop, script=[64])
        accept = _make_accept()

        with pytest.raises(OSError):
            await accept(proactor, _FakeListener(alive=False))

        assert proactor.register_calls == 1

    async def test_inner_cancellation_closes_socket(self):
        """内层（AcceptEx）取消 → 释放伪套接字 + 外层取消（与 stdlib accept_coro 等价）。"""
        loop = asyncio.get_running_loop()
        proactor = _FakeProactor(loop, script=["cancel"])
        accept = _make_accept()

        with pytest.raises(asyncio.CancelledError):
            await accept(proactor, _FakeListener())

        assert proactor.conns[0].closed is True

    async def test_outer_cancellation_propagates_to_inflight_accept(self):
        """外层取消（关停 `_stop_accept_futures`）→ 取消在途 AcceptEx 并释放套接字。"""
        loop = asyncio.get_running_loop()
        proactor = _FakeProactor(loop, script=["pending"])
        accept = _make_accept()

        result = accept(proactor, _FakeListener())
        await _settle(1)
        assert proactor.pending_inner is not None

        result.cancel()
        with pytest.raises(asyncio.CancelledError):
            await result
        await _settle()

        assert proactor.pending_inner.cancelled() is True
        assert proactor.conns[0].closed is True


class TestRetryLogging:
    async def test_first_retry_warns_then_debug_resets_after_success(self, caplog):
        """日志口径：连续首次 WARNING、其后 DEBUG；成功一次后计数复位。"""
        loop = asyncio.get_running_loop()
        accept = _make_accept()  # 计数器随安装（工厂）生命周期，单测内独立

        with caplog.at_level(logging.DEBUG, logger="app.core.accept_guard"):
            await accept(_FakeProactor(loop, script=[64, None]), _FakeListener())
            await accept(_FakeProactor(loop, script=[64, 64, None]), _FakeListener())
            await accept(_FakeProactor(loop, script=[64, None]), _FakeListener())

        ours = [r for r in caplog.records if r.name == "app.core.accept_guard"]
        warnings = [r for r in ours if r.levelno == logging.WARNING]
        debug = [r for r in ours if r.levelno == logging.DEBUG]
        assert len(warnings) == 3, "每个连续段的首例均记 WARNING（成功受理后计数复位）"
        assert len(debug) == 1, "同一连续段内第 2 例降为 DEBUG"
        assert all("中止" in r.getMessage() for r in ours)


class TestInstall:
    @pytest.fixture(autouse=True)
    def _fresh_state(self, monkeypatch):
        """安装类用例互不短路：复位「已安装」标志。"""
        monkeypatch.setattr(accept_guard, "_installed", False)

    def test_non_windows_is_noop(self, monkeypatch):
        """非 Windows：空操作，且不触碰 `asyncio.windows_events`。"""
        fake = types.ModuleType("asyncio.windows_events")

        class _Untouched:
            def accept(self, listener):
                raise AssertionError("非 Windows 不得安装补丁")

        fake.IocpProactor = _Untouched  # type: ignore[attr-defined]
        monkeypatch.setattr(sys, "platform", "linux")
        monkeypatch.setitem(sys.modules, "asyncio.windows_events", fake)

        assert install_proactor_accept_retry() is False
        assert getattr(fake.IocpProactor, "accept").__name__ == "accept"  # 未被替换

    def test_missing_internals_fail_fast(self, monkeypatch):
        """结构校验缺失 → RuntimeError（不得静默失去保护）。"""
        fake = types.ModuleType("asyncio.windows_events")

        class _Incomplete:
            def _register(self, overlapped, obj, callback):  # 缺 _get_accept_socket
                raise AssertionError("unused")

        fake.IocpProactor = _Incomplete  # type: ignore[attr-defined]
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.setitem(sys.modules, "asyncio.windows_events", fake)

        with pytest.raises(RuntimeError) as excinfo:
            install_proactor_accept_retry()
        assert "_get_accept_socket" in str(excinfo.value)

    def test_install_replaces_accept_and_is_idempotent(self, monkeypatch):
        """校验通过 → 替换 `IocpProactor.accept`；重复安装返回 False（幂等）。"""
        fake = types.ModuleType("asyncio.windows_events")

        class _Iocp:
            def _register(self, overlapped, obj, callback):
                raise AssertionError("unused")

            def _register_with_iocp(self, obj):
                raise AssertionError("unused")

            def _get_accept_socket(self, family):
                raise AssertionError("unused")

            def accept(self, listener):
                raise AssertionError("原实现不应被调用")

        fake.IocpProactor = _Iocp  # type: ignore[attr-defined]
        fake.NULL = 0  # type: ignore[attr-defined]
        overlapped = types.ModuleType("_overlapped")
        overlapped.Overlapped = _FakeOverlapped  # type: ignore[attr-defined]
        overlapped.SO_UPDATE_ACCEPT_CONTEXT = 0x1234  # type: ignore[attr-defined]
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.setitem(sys.modules, "asyncio.windows_events", fake)
        monkeypatch.setitem(sys.modules, "_overlapped", overlapped)

        assert install_proactor_accept_retry() is True
        assert getattr(_Iocp.accept, "__name__") == "accept_with_retry"
        assert install_proactor_accept_retry() is False, "重复安装必须幂等"
