"""一键启动入口（T7.2/T7.3）：端口探测/冲突 +1 / tGo 幂等复用 / 局域网 URL / 浏览器打开。

供 `start.ps1`（Windows 一键启动）、`deploy.sh`（Linux 前台运行）与 systemd 单元
（`tgo.service`）**复用同一实现**，避免双平台脚本各自实现端口逻辑：

1. 读取配置（`config.py` 为唯一事实源）：`server.host`（默认 0.0.0.0，局域网可达）
   与 `server.port`（默认 8090，`.yaml` 可覆盖）；
2. 解决监听端点（逐端口探测，最多尝试 `PORT_FALLBACK_LIMIT` 次 +1）：
   - 该端口已是**运行中的 tGo**（`/api/health` + `/api/games` 签名探测）→ 幂等复用
     （不新起第二个实例；`--open` 时仅打开浏览器）；
   - 端口空闲 → 绑定（Windows 用 `SO_EXCLUSIVEADDRUSE` 防端口劫持；POSIX 用
     `SO_REUSEADDR`；被占用时 bind 直接失败 → 自动 +1）；
   - 全部候选端口被其它程序占用 → 报错退出（退出码 1）。
3. 启动 uvicorn（`app.main:create_app` factory，静态根由后端默认解析 `frontend/static`，
   可用 `TGO_STATIC_DIR` 覆盖）；
4. `--open`：轮询 `/api/health` 待服务就绪后，用**探测到的本机局域网 IP** 打开浏览器
   （局域网内其它设备用同一 URL 即可访问）。

CLI：

```bash
cd backend
python -m app.launcher          # 前台运行（systemd / deploy.sh 用）
python -m app.launcher --open   # 就绪后自动打开浏览器（Windows 一键启动用）
python -m app.launcher --new    # 忽略“运行中的 tGo 复用”，强制在本端口之后新起实例（调试）
```

复用路径（检测到运行中的 tGo、未新起服务）在**交互式控制台**下会保持窗口并
提供控制菜单：`S` 停止运行中的实例（再按 `Y` 确认）、其它键仅关闭窗口。
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from dataclasses import dataclass
from typing import Callable, Optional, Union

import uvicorn

from app.config import load_config
from app.core.console_guard import drain_console

#: 配置端口被占用时的最大顺延次数（端口 +1 ... +10）
PORT_FALLBACK_LIMIT = 10

#: 运行中 tGo 的签名探测超时（秒/请求）
PROBE_TIMEOUT_S = 1.0

#: `--open` 等待服务就绪的上限（秒；与引擎首次自动调优硬上限 900s 对齐）
OPEN_WAIT_TIMEOUT_S = 900.0

#: 就绪轮询间隔（秒）
READY_POLL_INTERVAL_S = 0.25

#: 优雅关停时等待既有连接/任务收尾的上限（秒）——uvicorn `timeout_graceful_shutdown`。
#: 不限时（uvicorn 默认 `None`）时，只要还有浏览器 WebSocket 连接未收尾，Ctrl+C 后
#: 进程就会长时间不退出（日志「Waiting for connections to close. (CTRL+C to force quit)」）；
#: 用户往往因此**再次 Ctrl+C**，而 uvicorn 的 `force_exit` 会**跳过 lifespan 关停**
#: （引擎不停、数据库不关）→ 参见 BUG-122（解释器收尾被 aiosqlite 非 daemon
#: 工作线程永久阻塞）。故此处明确限时：超时后 uvicorn 取消剩余连接任务并继续关停。
GRACEFUL_SHUTDOWN_TIMEOUT_S = 5

#: 控制台横幅宽度（`=` 分隔线字符数；start.ps1 / deploy.sh 同值，排版契约测试锁定）
_BANNER_WIDTH = 60

#: ASGI 应用目标（与现有 `uvicorn app.main:create_app --factory` 调用口径一致）
APP_TARGET = "app.main:create_app"

#: 通配监听地址（浏览器/复用探测需换成具体可达 IP）
_WILDCARD_HOSTS = ("0.0.0.0", "::", "")

#: Windows 控制台 VT 处理标志（ANSI/颜色渲染；Windows 10 1511+ 支持）
_ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004

#: GetStdHandle 标准句柄 ID：标准输出 / 标准错误
_STD_OUTPUT_HANDLE = -11
_STD_ERROR_HANDLE = -12

ProbeFn = Callable[[int, str], bool]


# -------------------- HTTP 探测 --------------------


def _http_get_json(url: str, timeout: float) -> Optional[object]:
    """GET url → 解析 JSON；任何网络/解析异常返回 None（探测语义：无响应＝无此服务）。

    显式绕过系统代理（局域网地址不应经 HTTP(S)_PROXY 转发）。
    """
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None


def probe_running_tgo(port: int, host: str = "127.0.0.1", *, timeout: float = PROBE_TIMEOUT_S) -> bool:
    """签名探测：该端口上是否运行着 **tGo**（幂等复用的判定依据）。

    条件（二者同时满足）：`GET /api/health` == ``{"status":"ok"}`` 且
    `GET /api/games` 返回 ``{total, items, ...}`` 形状（tGo 特有，避免把其它
    FastAPI 应用误判为本服务）。
    """
    base = f"http://{_format_host(host)}:{port}"
    health = _http_get_json(f"{base}/api/health", timeout)
    if not (isinstance(health, dict) and health.get("status") == "ok"):
        return False
    games = _http_get_json(f"{base}/api/games", timeout)
    return isinstance(games, dict) and "total" in games and "items" in games


def _format_host(host: str) -> str:
    """URL 主机名格式化（IPv6 需方括号）。"""
    return f"[{host}]" if ":" in host else host


def wait_until_ready(
    host: str, port: int, *,
    timeout: float = OPEN_WAIT_TIMEOUT_S,
    interval: float = READY_POLL_INTERVAL_S,
    probe: Optional[Callable[[int, str], bool]] = None,
) -> bool:
    """轮询 `/api/health` 直到服务就绪（True）或超时（False）。

    ``host`` 为通配地址时用回环探测；服务尚未进入 serving 阶段时连接可能被
    内核 backlog 接受但无 HTTP 响应——探测超时按未就绪处理。
    """
    probe = probe or probe_running_tgo
    probe_host = "127.0.0.1" if host in _WILDCARD_HOSTS else host
    deadline = time.monotonic() + timeout
    while True:
        if probe(port, probe_host):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


# -------------------- 端点获取（复用 / 绑定 +1） --------------------


@dataclass(frozen=True)
class ReuseEndpoint:
    """该端口上已是运行中的 tGo：幂等复用，不重复启动。"""

    port: int


@dataclass(frozen=True)
class ServeEndpoint:
    """已绑定成功的监听套接字（交给 uvicorn `serve(sockets=[sock])`）。"""

    port: int
    sock: socket.socket


def _is_address_in_use(exc: OSError) -> bool:
    """bind 失败是否属于“地址被占用”（→ 顺延下一端口）。

    - POSIX：``EADDRINUSE``；
    - Windows：``WSAEADDRINUSE``（errno 10048）或对已独占监听者 bind 时的
      ``WSAEACCES``（errno 13，实测语义同为“被占用”）。
    """
    if exc.errno == errno.EADDRINUSE:
        return True
    return os.name == "nt" and exc.errno == errno.EACCES


def bind_server_socket(host: str, port: int) -> socket.socket:
    """绑定监听套接字（未 listen；uvicorn `create_server` 负责 listen）。

    - Windows：``SO_EXCLUSIVEADDRUSE``——防止其它进程用 ``SO_REUSEADDR``
      劫持端口（实测：独占绑定后劫持者被拒），冲突检测也更可靠；
    - POSIX：``SO_REUSEADDR``（服务器标准语义；对**正在监听**的同端口仍报
      ``EADDRINUSE``）。
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        if os.name == "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
    except OSError:
        sock.close()
        raise
    sock.set_inheritable(True)  # 与 uvicorn bind_socket 口径一致
    return sock


def probe_targets(host: str) -> list[str]:
    """复用探测的目标主机列表（“运行中的 tGo”探测范围）。

    - 指定 host → 该 host；
    - 通配 host（0.0.0.0 / ::）→ 回环 + 探测到的本机局域网 IP。
      既有 tGo 可能**只绑定在局域网 IP**（非通配）——此时回环无监听，
      仍应识别为“运行中的 tGo”并幂等复用（同端口通配绑定也会冲突）。
    """
    if host not in _WILDCARD_HOSTS:
        return [host]
    targets = ["127.0.0.1"]
    lan_ip = detect_lan_ip()
    if lan_ip and lan_ip not in targets:
        targets.append(lan_ip)
    return targets


def acquire_endpoint(
    host: str,
    start_port: int,
    *,
    attempts: int = PORT_FALLBACK_LIMIT,
    probe: Optional[ProbeFn] = None,
) -> Union[ReuseEndpoint, ServeEndpoint, None]:
    """逐端口获取端点：复用（tGo 已在运行）→ 绑定 → 占用则 +1；全占用返回 None。

    ``probe`` 可注入（测试）；默认 `probe_running_tgo`。探测先于绑定：若端口上
    已是 tGo（探测目标见 `probe_targets`：回环 + 局域网 IP），则幂等复用而不是
    顺延新起实例。
    """
    probe = probe or probe_running_tgo
    probe_hosts = probe_targets(host)
    for port in range(start_port, start_port + attempts + 1):
        if any(probe(port, probe_host) for probe_host in probe_hosts):
            return ReuseEndpoint(port=port)
        try:
            sock = bind_server_socket(host, port)
        except OSError as exc:
            if _is_address_in_use(exc):
                continue
            raise
        return ServeEndpoint(port=port, sock=sock)
    return None


# -------------------- 访问地址 --------------------


def detect_lan_ip() -> Optional[str]:
    """探测本机默认出口（局域网）IPv4 地址；无可用路由返回 None。

    UDP ``connect`` 只做路由选源，不产生实际流量（TEST-NET-1 保留地址）。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def access_url(host: str, port: int) -> str:
    """访问 URL：通配监听 → 本机局域网 IP（局域网可达）；指定 host → 原样。"""
    if host in _WILDCARD_HOSTS:
        lan_ip = detect_lan_ip() or "127.0.0.1"
        return f"http://{_format_host(lan_ip)}:{port}/"
    return f"http://{_format_host(host)}:{port}/"


def local_url(port: int) -> str:
    """本机回环 URL（通配监听时供服务端本机访问）。"""
    return f"http://127.0.0.1:{port}/"


# -------------------- uvicorn 启动 --------------------


def _enable_windows_vt() -> bool:
    """为当前控制台启用 VT 处理（ANSI/颜色渲染）；无控制台返回 True、启用失败 False。

    背景：PowerShell 5.1 启动时会关闭控制台的
    ``ENABLE_VIRTUAL_TERMINAL_PROCESSING``，导致 uvicorn 的颜色码原样显示为
    ``[32mINFO[0m`` 类乱码；启动服务前重新启用即可正常显示颜色。
    老系统（Win10 1511 之前）``SetConsoleMode`` 失败 → 返回 False（调用方回退无色）；
    输出被重定向（非控制台）时无需 VT（uvicorn 的 isatty 判定亦为 False）。
    """
    import ctypes

    kernel32 = ctypes.windll.kernel32
    kernel32.GetStdHandle.argtypes = [ctypes.c_uint32]
    kernel32.GetStdHandle.restype = ctypes.c_void_p
    kernel32.GetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    kernel32.GetConsoleMode.restype = ctypes.c_int
    kernel32.SetConsoleMode.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.SetConsoleMode.restype = ctypes.c_int

    saw_console = False
    result = True
    for std_id in (_STD_OUTPUT_HANDLE, _STD_ERROR_HANDLE):
        handle = kernel32.GetStdHandle(std_id)
        if not handle:
            continue
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            continue  # 非控制台（重定向/管道）或无效句柄
        saw_console = True
        if not (mode.value & _ENABLE_VIRTUAL_TERMINAL_PROCESSING):
            if not kernel32.SetConsoleMode(
                handle, mode.value | _ENABLE_VIRTUAL_TERMINAL_PROCESSING
            ):
                result = False
    return result


def resolve_use_colors() -> Optional[bool]:
    """解析 uvicorn 颜色开关：``None``=自动（按 isatty，颜色正常渲染），``False``=强制关闭。

    - ``NO_COLOR`` 环境变量置位 → 关闭（用户显式意愿）；
    - Windows：尽力启用控制台 VT；失败（老系统）→ 关闭，避免颜色码乱码；
      输出重定向等无控制台场景不受影响（uvicorn 本就不产生颜色）。
    """
    if os.environ.get("NO_COLOR"):
        return False
    if os.name == "nt" and not _enable_windows_vt():
        return False
    return None


def run_server(
    sock: socket.socket,
    host: str,
    port: int,
    *,
    open_browser: bool = False,
    target: str = APP_TARGET,
) -> int:
    """以既绑定的套接字启动 uvicorn（factory 加载；退出序列由 lifespan 托管）。

    颜色：见 `resolve_use_colors`——Windows 下先启用控制台 VT（PowerShell 5.1
    启动的窗口会关闭 VT，不启用时颜色码显示为 ``[32mINFO[0m`` 类乱码）；
    老系统启用失败或设 ``NO_COLOR`` 时回退无色；输出重定向时 uvicorn 自身不加色。
    """
    server = uvicorn.Server(
        uvicorn.Config(
            target,
            factory=True,
            host=host,
            port=port,
            use_colors=resolve_use_colors(),
            timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_TIMEOUT_S,
        )
    )
    if open_browser:
        threading.Thread(
            target=_open_browser_when_ready,
            args=(host, port),
            name="tgo-open-browser",
            daemon=True,
        ).start()
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:
        # Ctrl+C：与 uvicorn CLI 同口径（优雅退出序列已完成，不打印 Traceback）
        pass
    except SystemExit as exc:  # uvicorn 启动失败路径（lifespan 等）以 SystemExit 表达
        return exc.code if isinstance(exc.code, int) else 1
    finally:
        # 退出前有界刷写控制台积压（非阻塞输出，BUG-127）：冻结的控制台不得拖死退出
        drain_console()
    return 0


def _open_browser_when_ready(host: str, port: int) -> None:
    """后台线程：等服务就绪后打开浏览器（失败仅提示，不影响服务运行）。"""
    if not wait_until_ready(host, port):
        _log(f"服务就绪等待超时（{OPEN_WAIT_TIMEOUT_S:.0f}s），未自动打开浏览器，请手动访问上方地址")
        return
    url = access_url(host, port)
    _log(f"服务就绪，打开浏览器: {url}")
    try:
        webbrowser.open(url)
    except webbrowser.Error:
        _log("浏览器打开失败，请手动访问上方地址")


# -------------------- 复用窗口交互（停止运行中的实例） --------------------


def _is_interactive() -> bool:
    """当前是否为交互式控制台（双击 start.bat 场景）；重定向/服务上下文为 False。"""
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except (AttributeError, ValueError):
        return False


def _read_key() -> str:
    """读取单个按键（小写）：Windows msvcrt / POSIX cbreak 单键（均无需回车）。"""
    if os.name == "nt":
        import msvcrt

        char = msvcrt.getch()
        while char in (b"\x00", b"\xe0"):  # 功能键/方向键前缀，继续读
            char = msvcrt.getch()
        return char.decode("utf-8", errors="ignore").lower()
    return _read_key_posix()


def _read_key_posix() -> str:
    """POSIX 单键读取（termios cbreak：免回车，与 Windows msvcrt 行为一致）。

    termios 不可用（异常环境）或 stdin 不支持（管道）时回退行输入。
    """
    try:
        import termios
        import tty
    except ImportError:
        return _read_key_line()
    try:
        fd = sys.stdin.fileno()
        attrs = termios.tcgetattr(fd)
    except (OSError, ValueError, AttributeError):
        return _read_key_line()
    try:
        tty.setcbreak(fd)
        char = sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, attrs)
    return char.lower()


def _read_key_line() -> str:
    """回退：行输入（取首个字符），用于终端不支持 cbreak 的场景。"""
    try:
        return (input().strip()[:1] or "").lower()
    except EOFError:
        return ""


def _find_listener_pids(port: int) -> list[int]:
    """监听指定端口的进程 PID 列表（排除自身）；无权限/不可用返回 []。"""
    import psutil

    pids: list[int] = []
    try:
        for conn in psutil.net_connections(kind="inet"):
            if (
                conn.status == psutil.CONN_LISTEN
                and conn.laddr
                and conn.laddr.port == port
                and conn.pid
                and conn.pid != os.getpid()
                and conn.pid not in pids
            ):
                pids.append(conn.pid)
    except (psutil.AccessDenied, OSError):
        return []
    return pids


def stop_listener(port: int) -> tuple[bool, str]:
    """停止监听指定端口的实例（复用窗口 [S] 动作）；返回（是否成功，说明文案）。

    Windows：``terminate`` 即强制终止；tGo 实例的 KataGo 子进程会随 stdin 管道
    关闭（EOF）自行退出。POSIX：``SIGTERM``（uvicorn 走优雅退出）。
    """
    import psutil

    pids = _find_listener_pids(port)
    if not pids:
        return False, f"未找到监听端口 {port} 的进程（可能已退出）"
    stopped: list[str] = []
    failed: list[str] = []
    for pid in pids:
        try:
            proc = psutil.Process(pid)
            name = proc.name()
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except psutil.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            stopped.append(f"{pid}（{name}）")
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired) as exc:
            failed.append(f"{pid}: {exc}")
    if not stopped:
        return False, "停止失败：" + "；".join(failed)
    detail = "已停止运行中的实例：" + "、".join(stopped)
    if failed:
        detail += "；部分失败：" + "；".join(failed)
    return True, detail


def prompt_reuse_action(port: int) -> str:
    """复用路径交互菜单（仅交互式控制台调用）：返回 ``"stop"`` 或 ``"close"``。"""
    pids = _find_listener_pids(port)
    pid_text = "、".join(str(pid) for pid in pids) if pids else "未知"
    _log(_banner_line())
    _log("  复用运行中的实例（本窗口未启动服务）")
    _log(f"  - 停止实例 : 按 S（PID {pid_text}，需再按 Y 确认）")
    _log("  - 关闭窗口 : 按其它任意键")
    _log(_banner_line())
    if _read_key() != "s":
        return "close"
    _log("确认停止运行中的实例？按 Y 确认，其它键取消")
    if _read_key() != "y":
        _log("已取消")
        return "close"
    _, detail = stop_listener(port)
    _log(detail)
    _log("按任意键关闭窗口")
    _read_key()
    return "stop"


# -------------------- CLI --------------------


def _log(message: str) -> None:
    print(f"[tGo] {message}", flush=True)


def _banner_line() -> str:
    """横幅分隔线（`=` × `_BANNER_WIDTH`）。"""
    return "=" * _BANNER_WIDTH


def _report_access(host: str, port: int) -> None:
    """打印访问地址横幅（`Local`/`LAN` 键值对齐；两平台脚本同排版）。"""
    if host in _WILDCARD_HOSTS:
        entries = [("Local", local_url(port)), ("LAN", access_url(host, port))]
    else:
        label = "Local" if host in ("127.0.0.1", "::1") else "LAN"
        entries = [(label, access_url(host, port))]
    _log(_banner_line())
    _log("  tGo Server")
    for label, url in entries:
        _log(f"  - {label:<8} : {url}")
    _log(_banner_line())


def main(argv: Optional[list[str]] = None) -> int:
    """CLI 入口。退出码：0=运行结束/幂等复用；1=端口全占用或启动失败。"""
    parser = argparse.ArgumentParser(
        prog="python -m app.launcher",
        description="tGo 一键启动（端口冲突自动 +1；已在运行的 tGo 幂等复用）",
    )
    parser.add_argument("--open", action="store_true", help="服务就绪后自动打开浏览器")
    parser.add_argument(
        "--new",
        action="store_true",
        help="忽略“运行中的 tGo 复用”，强制在本端口之后新起实例（调试用）",
    )
    args = parser.parse_args(argv)

    cfg = load_config()
    host, port = cfg.server.host, cfg.server.port
    no_reuse_probe = (lambda port_arg, host_arg: False) if args.new else None
    if args.new:
        _log("--new：忽略复用检测，强制新起实例（端口自本端口起顺延）")

    try:
        endpoint = acquire_endpoint(host, port, probe=no_reuse_probe)
    except OSError as exc:  # 非“占用”类 bind 失败（如 host 非本机地址）→ 如实报告
        print(f"[tGo] 启动失败：无法监听 {host}:{port}（{exc}）", file=sys.stderr, flush=True)
        return 1

    if endpoint is None:
        print(
            f"[tGo] 启动失败：端口 {port}-{port + PORT_FALLBACK_LIMIT} 均被其它程序占用；"
            f"请释放端口或修改 config.yaml 的 server.port",
            file=sys.stderr,
            flush=True,
        )
        return 1

    if isinstance(endpoint, ReuseEndpoint):
        _log(f"检测到 tGo 已在端口 {endpoint.port} 运行（幂等复用，不重复启动）")
        _report_access(host, endpoint.port)
        if args.open:
            try:
                webbrowser.open(access_url(host, endpoint.port))
            except webbrowser.Error:
                _log("浏览器打开失败，请手动访问上方地址")
        if _is_interactive():
            # 复用且本窗口未启动服务：保持窗口并提供停止运行中实例的控制菜单
            # （两平台一致：--open 只决定是否打开浏览器，不影响菜单）
            try:
                prompt_reuse_action(endpoint.port)
            except KeyboardInterrupt:
                pass
        return 0

    if endpoint.port != port:
        _log(f"配置端口 {port} 被占用，自动改用端口 {endpoint.port}（可在 config.yaml 修改 server.port）")
    _report_access(host, endpoint.port)
    if args.open:
        _log("正在启动服务，就绪后将自动打开浏览器…")
    code = run_server(endpoint.sock, host, endpoint.port, open_browser=args.open)
    if code == 0:
        _log("服务已停止")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
