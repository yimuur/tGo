"""监听 accept 中止重投保护（Windows Proactor；BUG-125，2026/09/21 现场反馈）。

现场日志（2026/09/21 02:42:46）::

    ERROR [asyncio] Task exception was never retrieved
      future: <Task ... coro=<IocpProactor.accept.<locals>.accept_coro() ...>>
      OSError: [WinError 64] 指定的网络名不再可用。
    ERROR [asyncio] Accept failed on a socket
      socket: <asyncio.TransportSocket fd=620 ... laddr=('0.0.0.0', 8090)>

**根因**（源码核对 + 隔离复现）：客户端在「服务端没有待投递 AcceptEx」的窗口内中止连接
（浏览器预连接/提前断开、手机掉网、防火墙或杀软探测）时，Windows ``AcceptEx`` 会以
``ERROR_NETNAME_DELETED(64)`` 立即完成；而 CPython ``asyncio/proactor_events.py`` 的
``_start_serving.loop()`` 对**任何** ``OSError`` 都执行 ``call_exception_handler`` +
``sock.close()``，**且不再重投 accept** ⇒ **监听套接字被关闭、进程照常存活**：此后新连接
全部失败/超时（实测：监听 ``fd=-1``、新连接 ``TimeoutError``），必须重启进程才能恢复。
CPython ``main`` 分支仍是同样代码（上游未修）；``_overlapped`` 只在 **recv/send** 路径把
同族错误（``windows_events.py:465``：``ERROR_NETNAME_DELETED``/``ERROR_OPERATION_ABORTED``）
降级为 ``ConnectionResetError``，**唯独 accept 路径不容忍**。

**处置**：Windows 上把 ``IocpProactor.accept`` 替换为「语义等价 + 中止类失败自动重投」的
实现；**Linux 零改动**——``selector_events._accept_connection`` 本就 ``except
ConnectionAbortedError: continue``（丢弃被中止的连接并继续接受），监听器不会因客户端中止
而死，故 `install_proactor_accept_retry()` 在非 Windows 上空操作。

与原实现的差异（除重投外）：
- 仅重投「客户端中止 / 操作被取消」族（见 `_RETRYABLE_WINERRORS`）；其它错误原样上抛
  （保持快速失败，行为与 stdlib 一致）；
- 监听已失效（``fileno() == -1``）时不重投，交回 asyncio 原有处置（不掩盖真实故障）；
- 消除 stdlib 原实现的**次生噪音**：原实现为每次 accept 额外创建 ``accept_coro`` 任务
  （只处理取消），失败时该任务异常无人领取 → 日志
  ``Task exception was never retrieved``；本实现直接在完成回调内处理取消与错误。

**安装契约**：安装前做**结构校验**（``IocpProactor`` 的 ``_register``/
``_register_with_iocp``/``_get_accept_socket``、``windows_events.NULL``、``_overlapped``
的 ``Overlapped``/``SO_UPDATE_ACCEPT_CONTEXT``）；任一缺失即抛 ``RuntimeError``——宁可
启动失败，也不静默失去该保护（未来 Python 改动这些私有实现时立刻暴露）。
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import socket
import struct
import sys
from typing import Any, Callable

logger = logging.getLogger(__name__)

#: 可安全重投的 accept 失败（Windows ``WinError``）——「连接被中止/操作被取消」族：
#: 无连接可交付，重投语义安全；且与 stdlib 在 recv/send 路径的容忍口径一致。
#: - 64    ``ERROR_NETNAME_DELETED``：连接在 AcceptEx 完成前被中止（现场命中）
#: - 995   ``ERROR_OPERATION_ABORTED``：AcceptEx 被取消（``windows_events.py:465``）
#: - 1236  ``ERROR_CONNECTION_ABORTED``：连接被中止（``windows_events.py:40``）
#: - 10054 ``WSAECONNRESET``：对端强制断开（同族，避免监听器因同类中止而死）
_RETRYABLE_WINERRORS: frozenset[int] = frozenset({64, 995, 1236, 10054})

#: 安装所需 `IocpProactor` 成员（缺一即快速失败）
_REQUIRED_IOCP_MEMBERS = ("_register", "_register_with_iocp", "_get_accept_socket")

#: `IocpProactor.accept` 的替代实现签名（自行实现，见 `_make_accept`）
AcceptImpl = Callable[[Any, Any], "asyncio.Future[Any]"]

_installed = False


def is_retryable_accept_error(exc: BaseException) -> bool:
    """是否为「客户端中止」族、可安全重投的 accept 失败（Windows ``WinError``）。"""
    return getattr(exc, "winerror", None) in _RETRYABLE_WINERRORS


def _make_accept(
    *, overlapped_cls: Any, null: Any, so_update_accept_context: int
) -> AcceptImpl:
    """构建 ``IocpProactor.accept`` 替代实现（依赖由安装方注入：便于隔离测试与结构校验）。"""

    #: 连续重投计数（同一安装内共享）：首次 WARNING、其后 DEBUG，成功一次复位
    retry_burst = [0]

    def accept_with_retry(self: Any, listener: Any) -> "asyncio.Future[Any]":
        loop = self._loop
        result: "asyncio.Future[Any]" = loop.create_future()
        in_flight: list["asyncio.Future[Any]"] = []

        def attempt() -> None:
            self._register_with_iocp(listener)
            conn = self._get_accept_socket(listener.family)
            overlapped = overlapped_cls(null)
            overlapped.AcceptEx(listener.fileno(), conn.fileno())

            def finish_accept(trans: Any, key: Any, ov: Any) -> tuple[Any, Any]:
                ov.getresult()
                # 与原实现一致：SO_UPDATE_ACCEPT_CONTEXT 使 getsockname() 等可用
                conn.setsockopt(
                    socket.SOL_SOCKET,
                    so_update_accept_context,
                    struct.pack("@P", listener.fileno()),
                )
                conn.settimeout(listener.gettimeout())
                return conn, conn.getpeername()

            def on_done(inner: "asyncio.Future[Any]") -> None:
                if inner.cancelled():
                    conn.close()
                    if not result.done():
                        result.cancel()
                    return
                exc = inner.exception()  # 取回异常：避免「never retrieved」噪音
                if exc is None:
                    retry_burst[0] = 0
                    if not result.done():
                        result.set_result(inner.result())
                    return
                if is_retryable_accept_error(exc) and listener.fileno() != -1:
                    conn.close()
                    _log_retry(retry_burst, exc)
                    attempt()  # 客户中止：在同一监听套接字上重投 AcceptEx
                    return
                conn.close()
                if not result.done():
                    result.set_exception(exc)

            inner = self._register(overlapped, listener, finish_accept)
            in_flight[:] = [inner]
            inner.add_done_callback(on_done)

        def on_result_done(fut: "asyncio.Future[Any]") -> None:
            # 外层被取消（关停 `_stop_accept_futures`）→ 取消在途 AcceptEx 并释放套接字
            if fut.cancelled() and in_flight:
                in_flight[0].cancel()

        attempt()
        result.add_done_callback(on_result_done)
        return result

    return accept_with_retry


def _log_retry(retry_burst: list[int], exc: BaseException) -> None:
    """重投日志：同一连续段首次 WARNING（可观测），其后 DEBUG（防断网/扫描刷屏）。"""
    retry_burst[0] += 1
    if retry_burst[0] == 1:
        logger.warning(
            "接受连接时客户端中止（%r）：已自动重投 AcceptEx，监听保持可用"
            "（同一连续段后续同类事件降为 DEBUG）",
            exc,
        )
        return
    logger.debug("接受连接时客户端中止（连续第 %d 次重投）：%r", retry_burst[0], exc)


def _missing_members(windows_events: Any) -> list[str]:
    """安装前结构校验：返回缺失成员名列表（空＝可安装）。"""
    iocp_cls = getattr(windows_events, "IocpProactor", None)
    if iocp_cls is None:
        return ["asyncio.windows_events.IocpProactor"]

    missing = [
        f"IocpProactor.{name}"
        for name in _REQUIRED_IOCP_MEMBERS
        if not hasattr(iocp_cls, name)
    ]
    if not hasattr(windows_events, "NULL"):
        missing.append("asyncio.windows_events.NULL")
    try:
        overlapped = importlib.import_module("_overlapped")
    except ImportError:
        return [*missing, "_overlapped"]
    missing += [
        f"_overlapped.{name}"
        for name in ("Overlapped", "SO_UPDATE_ACCEPT_CONTEXT")
        if not hasattr(overlapped, name)
    ]
    return missing


def install_proactor_accept_retry() -> bool:
    """安装 accept 中止重投保护。

    返回本次是否实际安装：非 Windows（Linux 自愈，无需保护）或已安装过 → ``False``。
    结构校验失败（Python 私有实现变化）→ ``RuntimeError``（快速失败，不静默失去保护）。
    """
    if sys.platform != "win32":
        return False
    global _installed
    if _installed:
        return False

    windows_events = importlib.import_module("asyncio.windows_events")
    missing = _missing_members(windows_events)
    if missing:
        raise RuntimeError(
            "无法安装 accept 中止重投保护：Python 内部结构已变化，缺少 "
            + "、".join(missing)
            + "（不得静默失去该保护，见 app/core/accept_guard.py 模块文档）"
        )

    overlapped = importlib.import_module("_overlapped")
    iocp_cls = windows_events.IocpProactor
    iocp_cls.accept = _make_accept(
        overlapped_cls=overlapped.Overlapped,
        null=windows_events.NULL,
        so_update_accept_context=overlapped.SO_UPDATE_ACCEPT_CONTEXT,
    )
    _installed = True
    logger.debug("已安装监听 accept 中止重投保护（Windows Proactor，BUG-125）")
    return True
