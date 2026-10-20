"""事件循环异常噪音过滤（Windows Proactor 连接重置）。

背景（2026/09/13，移动端断连排查）：

Windows 下 asyncio 使用 ``ProactorEventLoop``；当**对端强制断开**（手机锁屏/切网/
服务端重启 → 客户端发出 RST，WinError 10054「远程主机强迫关闭了一个现有的连接」）
时，transport 的收尾回调 ``_ProactorBasePipeTransport._call_connection_lost`` 会对
已被重置的 socket 调用 ``shutdown(SHUT_RDWR)`` 并抛 ``ConnectionResetError``。该异常
发生在**回调**（Handle）而非任务内，最终经由事件循环异常处理器打印成
``ERROR [asyncio] Exception in callback ...`` 全量 Traceback——此时连接早已失效、
会话清理照常完成，属预期收尾噪音（每次移动端断网都会刷一条，掩盖真实告警）。

处置：应用启动（lifespan）时安装过滤处理器——**仅**吞掉「回调上下文中的
``ConnectionResetError``」（上下文带 ``handle`` 且**非**任务异常），其余异常一律
交还默认处理器（保持既有报错行为）；被过滤项降级为 DEBUG 日志，排障时仍可开启。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

logger = logging.getLogger(__name__)


def is_benign_transport_reset(context: dict[str, Any]) -> bool:
    """判断是否为「对端强制断开」在 transport 收尾回调中产生的连接重置噪音。

    - 必须是 ``ConnectionResetError``；
    - 必须发生在**回调**上下文（带 ``handle``）且**不是任务异常**（无 ``task``）——
      任务内异常可能隐藏真实缺陷，一律按原样上报，不得过滤。
    """
    if not isinstance(context.get("exception"), ConnectionResetError):
        return False
    return context.get("handle") is not None and context.get("task") is None


def make_loop_exception_handler(
    default_handler: Callable[[dict[str, Any]], None],
) -> Callable[[asyncio.AbstractEventLoop, dict[str, Any]], None]:
    """构建事件循环异常处理器：过滤良性连接重置噪音，其余交还 ``default_handler``。"""

    def _handler(_loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        if is_benign_transport_reset(context):
            logger.debug(
                "忽略断连收尾回调的连接重置噪音（对端已强制断开）：%r",
                context.get("exception"),
            )
            return
        default_handler(context)

    return _handler


def install_loop_exception_guard() -> None:
    """为当前运行中的事件循环安装连接重置噪音过滤（lifespan 启动时调用）。"""
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(make_loop_exception_handler(loop.default_exception_handler))
