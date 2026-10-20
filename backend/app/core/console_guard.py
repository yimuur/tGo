"""非阻塞控制台输出（机制 A / BUG-127，2026/09/21 现场反馈）。

**现象**（人工反馈）：服务突然「客户端连不上」（浏览器/手机请求全部超时），**在 cmd
窗口里按一下 Ctrl+C 或回车**后立刻恢复，并一次性吐出大量积压输出。

**根因**（源码 + 隔离复现）：root logger 的控制台 ``StreamHandler`` 是**同步写**，而应用
日志（WS 回调 / 引擎管理器 / uvicorn 访问日志）都在**事件循环线程**内发出。当控制台不再
消费输出时，进程的 ``write(stderr)`` 会**阻塞**，从而**整个 asyncio 循环停摆**：

- Windows：控制台进入「标记/选择」状态（快速编辑模式 `QuickEdit=1` 下在窗口里拖选/点击）
  ——conhost 暂停读取输出；按任意键（Ctrl+C 在标记模式下＝复制并退出标记）即解除；
- Linux：终端 ``Ctrl+S``（XOFF 停流）、或标准输出/错误的消费者被暂停（管道缓冲写满）。

现象特征（现场与探针一致）：端口仍由内核接受握手、**但应用不处理任何连接**（客户端
超时）、进程存活、日志文件**在这段时间一行不写**（文件 handler 排在控制台 handler 之后，
写不进去）；解除后立刻恢复并输出积压。

**处置**：把**控制台**写入移出事件循环线程——`NonBlockingWriter`（有界队列 + 后台
**daemon** 线程；溢出丢弃并计数、单片段超长截断、写失败丢弃不抛），并让**所有**控制台
handler（root 的以及 uvicorn 等三方自建的）指向它：

- 事件循环线程只做 ``put_nowait``，控制台冻结多久都不影响服务；
- 队列有界（默认 1000 片段）：冻结期间溢出丢弃并计数，恢复后补一条「已丢弃 N 条」提示；
- 后台线程 ``daemon=True``（2026/09/20 BUG-122 教训：非 daemon 线程会阻塞解释器收尾）；
- **文件日志保持同步**（本地磁盘，且是唯一事实源）；退出前经 `drain_console()` 有界刷写。

覆盖范围说明：本模块只接管 ``logging`` 的控制台 handler。``launcher`` 的少量 ``print``
（启动横幅/失败提示，均在**启动阶段**或 ``--open`` 后台线程中）不在其列。
"""

from __future__ import annotations

import logging
import queue
import sys
import threading
from typing import Any, Iterable, Optional, TextIO

logger = logging.getLogger(__name__)

#: 待写片段上限（冻结期间超出即丢弃并计数；每片段通常＝一行日志）
_MAX_PENDING_LINES = 1000

#: 单片段字符上限（误打印大对象时截断，避免撑爆队列与控制台）
_MAX_CHUNK_CHARS = 8192

#: 退出时刷写积压的上限（秒）——冻结的控制台不得拖死关停
_DRAIN_TIMEOUT_S = 1.0

#: 同一底层流 → 共享代理（每流一个后台写线程，避免多线程重复起）
_proxies: dict[int, "NonBlockingWriter"] = {}

_installed = False


class NonBlockingWriter:
    """把控制台写入搬到后台守护线程：调用方（含事件循环线程）**永不阻塞**。"""

    def __init__(
        self,
        target: TextIO,
        *,
        max_pending: int = _MAX_PENDING_LINES,
        name: str = "tgo-console",
    ) -> None:
        self._target = target
        self._queue: "queue.Queue[Optional[str]]" = queue.Queue(maxsize=max_pending)
        self._dropped_total = 0
        self._dropped_pending = 0
        self._closed = False
        self._thread = threading.Thread(target=self._drain, name=name, daemon=True)
        self._thread.start()

    # ---- 写入接口（logging / print 兼容）----

    def write(self, text: str) -> int:
        """入队并立即返回；队列满则丢弃该片段（计数，恢复后补一条提示）。"""
        if self._closed:
            return len(text)
        chunk = self._fit(text)
        try:
            self._queue.put_nowait(chunk)
        except queue.Full:
            self._dropped_total += 1
            self._dropped_pending += 1
        return len(text)

    def writelines(self, lines: Iterable[str]) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        """空操作：写出由后台线程逐片段完成（不得在此等待控制台，否则又会阻塞调用方）。"""
        return None

    def close(self, *, timeout_s: float = _DRAIN_TIMEOUT_S) -> None:
        """停止后台线程（**有界**等待：控制台冻结时也不得挂死关停）。"""
        if self._closed:
            return
        self._closed = True
        try:
            self._queue.put_nowait(None)  # 哨兵；队列满则跳过（daemon 线程随进程退出）
        except queue.Full:
            pass
        self._thread.join(timeout_s)

    @property
    def dropped(self) -> int:
        """累计被丢弃的片段数（可观测性；提示行由写线程补一条）。"""
        return self._dropped_total

    # ---- 属性透传（isatty/fileno/encoding/…；不经过队列，不会阻塞）----

    def isatty(self) -> bool:
        return bool(self._target.isatty())

    def fileno(self) -> int:
        return int(self._target.fileno())

    def __getattr__(self, name: str) -> Any:
        target = self.__dict__.get("_target")
        if target is None or name.startswith("_"):
            raise AttributeError(name)
        return getattr(target, name)

    # ---- 内部 ----

    def _fit(self, text: str) -> str:
        """截断超长片段（标注原长度），避免单条内容撑爆队列。"""
        if len(text) <= _MAX_CHUNK_CHARS:
            return text
        return text[:_MAX_CHUNK_CHARS] + f"…（单片段 {len(text)} 字符已截断）\n"

    def _drain(self) -> None:
        while True:
            chunk = self._queue.get()
            if chunk is None:
                return
            self._write_chunk(chunk)
            # 队列排空后再补「已丢弃 N 条」提示：既保证顺序（位于被丢弃片段之后），
            # 也保证只在恢复写出能力时输出一次（冻结期间不会反复尝试）
            if self._dropped_pending and self._queue.empty():
                dropped, self._dropped_pending = self._dropped_pending, 0
                self._write_chunk(f"…（控制台输出积压，已丢弃 {dropped} 条日志片段）\n")

    def _write_chunk(self, chunk: str) -> None:
        try:
            self._target.write(chunk)
            self._target.flush()
        except (OSError, ValueError):
            # 控制台已关闭/管道断开/流已 detach：丢弃该片段，服务不受影响
            return


def _proxy_for(stream: TextIO) -> NonBlockingWriter:
    """取（或创建）该底层流的共享代理：同一流只起一个后台写线程。"""
    key = id(stream)
    proxy = _proxies.get(key)
    if proxy is None:
        proxy = NonBlockingWriter(stream, name=f"tgo-console-{len(_proxies)}")
        _proxies[key] = proxy
    return proxy


def _is_console_stream(stream: object) -> bool:
    """是否为进程的真实控制台流（只接管这些，不碰 pytest 捕获/StringIO 等替身）。"""
    return stream is sys.stdout or stream is sys.stderr or stream is sys.__stdout__ or stream is sys.__stderr__


def _iter_console_handlers() -> Iterable[logging.Handler]:
    """遍历 root 与全部既有 logger 上的控制台 ``StreamHandler``（含 uvicorn 等三方）。"""
    seen: set[int] = set()
    loggers: list[logging.Logger] = [logging.getLogger()]
    loggers += [obj for obj in logging.Logger.manager.loggerDict.values() if isinstance(obj, logging.Logger)]
    for owner in loggers:
        for handler in list(owner.handlers):
            if id(handler) in seen:
                continue
            seen.add(id(handler))
            # FileHandler 也是 StreamHandler：按「是否为控制台流」判定，天然排除文件
            if isinstance(handler, logging.StreamHandler) and _is_console_stream(
                getattr(handler, "stream", None)
            ):
                yield handler


def make_console_handler(stream: Optional[TextIO] = None) -> logging.Handler:
    """构建**非阻塞**控制台处理器（`setup_logging` 使用；同一流共享后台写线程）。"""
    target = sys.stderr if stream is None else stream
    return logging.StreamHandler(_proxy_for(target))


def install_nonblocking_console() -> bool:
    """把**既有**控制台 handlers（root + 各 logger，例如 uvicorn 自建的）改指非阻塞代理。

    幂等：已安装过返回 ``False``。调用点须早于第一个日志记录（`create_app`：uvicorn 在
    `Server.startup()` 之前经 `Config.load()` 调工厂，且其 logging 已在 `Config()` 构造时
    配置完毕 ⇒ 此处的「改指既有 handler」正好覆盖 uvicorn 的控制台输出）。

    注：**安装之后**由三方库/旧式代码新建的控制台 handler 不在此列，由 `setup_logging`
    在每次日志初始化时再调一次 `retarget_console_handlers()` 覆盖（见 2026/09/21 探针
    暴露的缺口）；本项目自建一律走 `make_console_handler()`。
    """
    global _installed
    if _installed:
        return False
    count = retarget_console_handlers()
    _installed = True
    logger.debug("已安装非阻塞控制台输出（改指 %d 个既有控制台 handler，BUG-127）", count)
    return True


def retarget_console_handlers() -> int:
    """把绑定真实控制台的既有 handler 改指非阻塞代理；返回改指数（幂等：已代理的跳过）。"""
    count = 0
    for handler in _iter_console_handlers():
        # 直接赋值而非 setStream()：后者会 close() 原流（会把真实控制台/捕获流关掉）
        handler.stream = _proxy_for(getattr(handler, "stream", None))  # type: ignore[assignment]
        count += 1
    return count


def drain_console(timeout_s: float = _DRAIN_TIMEOUT_S) -> None:
    """退出前尽力写出积压（**有界**等待；超时即放弃，文件日志已完整）。"""
    proxies = list(_proxies.values())
    if not proxies:
        return
    per_proxy = max(timeout_s / len(proxies), 0.05)
    for proxy in proxies:
        proxy.close(timeout_s=per_proxy)


def _reset_for_test() -> None:
    """测试隔离：复位安装状态并关闭、清空共享代理（避免线程与状态跨用例泄漏）。"""
    global _installed
    _installed = False
    for proxy in list(_proxies.values()):
        proxy.close(timeout_s=0.2)
    _proxies.clear()
