"""launcher（T7.2/T7.3 一键启动入口）单元测试：端口探测/复用/绑定 +1/地址/CLI。

用例 ID: LAUN-*
硬件隔离：仅本机回环 socket 与内存 mock（不启动真实引擎/GPU）。
"""

import errno
import json
import os
import socket
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil
import pytest

from app import launcher
from app.config import default_config


# -------------------- 测试工具 --------------------


def _tgo_http_server(*, health=True, games=True):
    """最小 tGo 签名 HTTP 服务（回环随机端口），返回 (server, port)。"""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # 静默
            pass

        def _send(self, code, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802 - http.server 接口
            if self.path == "/api/health":
                if health:
                    self._send(200, {"status": "ok"})
                else:
                    self._send(200, {"status": "degraded"})
            elif self.path == "/api/games":
                if games:
                    self._send(200, {"total": 0, "items": [], "focus_page": None})
                else:
                    self._send(404, {"detail": "not found"})
            else:
                self._send(404, {"detail": "not found"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, server.server_address[1]


def _find_free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _find_free_port_pair() -> tuple[int, int]:
    """找到一对连续（P, P+1）均空闲的回环端口。"""
    for _ in range(50):
        first = _find_free_port()
        probe = socket.socket()
        try:
            probe.bind(("127.0.0.1", first + 1))
        except OSError:
            continue
        finally:
            probe.close()
        return first, first + 1
    raise RuntimeError("无法找到连续空闲端口对")


# -------------------- 签名探测 --------------------


class TestProbeRunningTgo:
    def test_detects_running_tgo(self):
        server, port = _tgo_http_server()
        try:
            assert launcher.probe_running_tgo(port) is True
        finally:
            server.shutdown()
            server.server_close()

    def test_rejects_wrong_health(self):
        server, port = _tgo_http_server(health=False)
        try:
            assert launcher.probe_running_tgo(port) is False
        finally:
            server.shutdown()
            server.server_close()

    def test_rejects_health_ok_without_games_shape(self):
        """health 相同但 /api/games 形状不同 → 不视为 tGo（防其它 FastAPI 应用误判）。"""
        server, port = _tgo_http_server(games=False)
        try:
            assert launcher.probe_running_tgo(port) is False
        finally:
            server.shutdown()
            server.server_close()

    def test_connection_refused_returns_false(self):
        port = _find_free_port()
        assert launcher.probe_running_tgo(port, timeout=0.5) is False


# -------------------- 端点获取 --------------------


class TestAcquireEndpoint:
    def test_free_port_binds_and_serves(self):
        port = _find_free_port()
        endpoint = launcher.acquire_endpoint(
            "127.0.0.1", port, attempts=3, probe=lambda p, h: False
        )
        assert isinstance(endpoint, launcher.ServeEndpoint)
        assert endpoint.port == port
        assert endpoint.sock.getsockname()[1] == port  # 真实绑定
        endpoint.sock.close()

    def test_running_tgo_reused_without_binding(self, monkeypatch):
        """占用者是运行中的 tGo → 幂等复用（且不得尝试绑定）。"""
        calls: list[int] = []

        def _probe(port, host):
            calls.append(port)
            return True

        def _bind_forbidden(host, port):
            raise AssertionError("复用路径不应绑定套接字")

        monkeypatch.setattr(launcher, "bind_server_socket", _bind_forbidden)
        endpoint = launcher.acquire_endpoint("127.0.0.1", 8090, attempts=3, probe=_probe)
        assert endpoint == launcher.ReuseEndpoint(port=8090)
        assert calls == [8090], "命中复用即停止，不再探测后续端口"

    def test_occupied_port_skips_to_next(self):
        """端口被其它监听者持有时 +1（Windows 独占绑定语义实测）。"""
        held, nxt = _find_free_port_pair()
        listener = socket.socket()
        listener.bind(("127.0.0.1", held))
        listener.listen(1)
        try:
            endpoint = launcher.acquire_endpoint(
                "127.0.0.1", held, attempts=3, probe=lambda p, h: False
            )
            assert isinstance(endpoint, launcher.ServeEndpoint)
            assert endpoint.port == nxt
            endpoint.sock.close()
        finally:
            listener.close()

    def test_all_occupied_returns_none(self, monkeypatch):
        def _always_busy(host, port):
            raise OSError(errno.EADDRINUSE, "in use")

        monkeypatch.setattr(launcher, "bind_server_socket", _always_busy)
        endpoint = launcher.acquire_endpoint("127.0.0.1", 8100, attempts=2, probe=lambda p, h: False)
        assert endpoint is None

    def test_non_conflict_bind_error_raises(self, monkeypatch):
        def _fatal(host, port):
            raise OSError(errno.EADDRNOTAVAIL, "cannot assign requested address")

        monkeypatch.setattr(launcher, "bind_server_socket", _fatal)
        with pytest.raises(OSError):
            launcher.acquire_endpoint("127.0.0.1", 8100, attempts=2, probe=lambda p, h: False)

    def test_probe_uses_loopback_for_wildcard_host(self, monkeypatch):
        monkeypatch.setattr(launcher, "detect_lan_ip", lambda: None)
        seen: list[tuple[int, str]] = []

        def _probe(port, host):
            seen.append((port, host))
            return False

        port = _find_free_port()
        endpoint = launcher.acquire_endpoint("0.0.0.0", port, attempts=0, probe=_probe)
        assert isinstance(endpoint, launcher.ServeEndpoint)
        assert seen == [(port, "127.0.0.1")]
        endpoint.sock.close()

    def test_probe_targets_include_lan_for_wildcard(self, monkeypatch):
        monkeypatch.setattr(launcher, "detect_lan_ip", lambda: "10.9.8.7")
        assert launcher.probe_targets("0.0.0.0") == ["127.0.0.1", "10.9.8.7"]
        assert launcher.probe_targets("127.0.0.1") == ["127.0.0.1"]

    def test_reuse_detected_via_lan_bound_tgo(self, monkeypatch):
        """既有 tGo 只绑局域网 IP（回环无监听）→ 仍识别复用，不顺延 +1。"""
        monkeypatch.setattr(launcher, "detect_lan_ip", lambda: "10.9.8.7")

        def _probe(port, host):
            return host == "10.9.8.7"

        def _bind_forbidden(host, port):
            raise AssertionError("复用路径不应绑定套接字")

        monkeypatch.setattr(launcher, "bind_server_socket", _bind_forbidden)
        endpoint = launcher.acquire_endpoint("0.0.0.0", 8090, attempts=3, probe=_probe)
        assert endpoint == launcher.ReuseEndpoint(port=8090)


class TestAddressInUseClassification:
    def test_eaddrinuse_is_conflict(self):
        assert launcher._is_address_in_use(OSError(errno.EADDRINUSE, "in use")) is True

    def test_eacces_only_conflict_on_windows(self):
        exc = OSError(errno.EACCES, "denied")
        assert launcher._is_address_in_use(exc) is (os.name == "nt")

    def test_other_errno_not_conflict(self):
        assert launcher._is_address_in_use(OSError(errno.EADDRNOTAVAIL, "x")) is False


# -------------------- 就绪等待（Mock 时间流） --------------------


class TestWaitUntilReady:
    def _mock_clock(self, monkeypatch):
        clock = {"t": 0.0}
        monkeypatch.setattr(launcher.time, "monotonic", lambda: clock["t"])
        monkeypatch.setattr(launcher.time, "sleep", lambda s: clock.__setitem__("t", clock["t"] + s))
        return clock

    def test_ready_within_timeout(self, monkeypatch):
        clock = self._mock_clock(monkeypatch)
        seq = iter([False, False, True])
        assert launcher.wait_until_ready(
            "127.0.0.1", 8090, timeout=2.0, interval=0.5, probe=lambda p, h: next(seq)
        ) is True
        assert clock["t"] <= 2.0

    def test_timeout_returns_false(self, monkeypatch):
        clock = self._mock_clock(monkeypatch)
        assert launcher.wait_until_ready(
            "0.0.0.0", 8090, timeout=1.0, interval=0.25, probe=lambda p, h: False
        ) is False
        assert clock["t"] >= 1.0


# -------------------- 地址 --------------------


class TestAccessUrl:
    def test_wildcard_uses_lan_ip(self, monkeypatch):
        monkeypatch.setattr(launcher, "detect_lan_ip", lambda: "10.1.2.3")
        assert launcher.access_url("0.0.0.0", 8090) == "http://10.1.2.3:8090/"

    def test_wildcard_fallback_loopback(self, monkeypatch):
        monkeypatch.setattr(launcher, "detect_lan_ip", lambda: None)
        assert launcher.access_url("0.0.0.0", 8090) == "http://127.0.0.1:8090/"

    def test_specific_host_passthrough(self):
        assert launcher.access_url("192.168.1.9", 8091) == "http://192.168.1.9:8091/"

    def test_ipv6_bracketed(self):
        assert launcher.access_url("::1", 8090) == "http://[::1]:8090/"

    def test_detect_lan_ip_without_route_returns_none(self, monkeypatch):
        class _BoomSocket:
            def connect(self, addr):
                raise OSError("no route")

            def close(self):
                pass

            def getsockname(self):
                return ("0.0.0.0", 0)

        monkeypatch.setattr(launcher.socket, "socket", lambda *a, **k: _BoomSocket())
        assert launcher.detect_lan_ip() is None


# -------------------- uvicorn 启动与 CLI --------------------


class TestConsoleColors:
    """终端颜色解析：Windows 启用控制台 VT；失败/NO_COLOR 回退无色。"""

    def test_no_color_env_forces_colorless(self, monkeypatch):
        monkeypatch.setenv("NO_COLOR", "1")
        assert launcher.resolve_use_colors() is False

    def test_non_windows_auto(self, monkeypatch):
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(launcher.os, "name", "posix")
        assert launcher.resolve_use_colors() is None

    def test_windows_vt_enabled_auto(self, monkeypatch):
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(launcher.os, "name", "nt")
        monkeypatch.setattr(launcher, "_enable_windows_vt", lambda: True)
        assert launcher.resolve_use_colors() is None

    def test_windows_vt_failure_forces_colorless(self, monkeypatch):
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(launcher.os, "name", "nt")
        monkeypatch.setattr(launcher, "_enable_windows_vt", lambda: False)
        assert launcher.resolve_use_colors() is False


class TestRunServer:
    def test_socket_passed_to_uvicorn(self, monkeypatch):
        monkeypatch.setattr(launcher, "resolve_use_colors", lambda: False)
        recorded = {}

        class FakeServer:
            def __init__(self, config):
                recorded["config"] = config

            def run(self, sockets=None):
                recorded["sockets"] = sockets

        monkeypatch.setattr(launcher.uvicorn, "Server", FakeServer)
        sock = socket.socket()
        try:
            rc = launcher.run_server(sock, "127.0.0.1", 8090, open_browser=False)
        finally:
            sock.close()
        assert rc == 0
        assert recorded["sockets"] == [sock]
        assert recorded["config"].factory is True
        assert recorded["config"].port == 8090
        assert recorded["config"].use_colors is False

    def test_graceful_shutdown_is_bounded(self, monkeypatch):
        """优雅关停必须限时（BUG-122）：不限时（uvicorn 默认 None）时浏览器连接未收尾
        会让 Ctrl+C 后进程长时间不退出，用户再按一次即 uvicorn `force_exit` →
        跳过 lifespan 关停（引擎不停、数据库不关）。
        """
        monkeypatch.setattr(launcher, "resolve_use_colors", lambda: False)
        recorded = {}

        class FakeServer:
            def __init__(self, config):
                recorded["config"] = config

            def run(self, sockets=None):
                return None

        monkeypatch.setattr(launcher.uvicorn, "Server", FakeServer)
        sock = socket.socket()
        try:
            assert launcher.run_server(sock, "127.0.0.1", 8090) == 0
        finally:
            sock.close()
        assert recorded["config"].timeout_graceful_shutdown == launcher.GRACEFUL_SHUTDOWN_TIMEOUT_S
        assert isinstance(launcher.GRACEFUL_SHUTDOWN_TIMEOUT_S, int)
        assert 0 < launcher.GRACEFUL_SHUTDOWN_TIMEOUT_S <= 30

    def test_system_exit_code_normalized(self, monkeypatch):
        class FakeServer:
            def __init__(self, config):
                pass

            def run(self, sockets=None):
                raise SystemExit(3)

        monkeypatch.setattr(launcher.uvicorn, "Server", FakeServer)
        sock = socket.socket()
        try:
            assert launcher.run_server(sock, "127.0.0.1", 8090) == 3
        finally:
            sock.close()

    def test_keyboard_interrupt_is_clean_stop(self, monkeypatch):
        """Ctrl+C → 优雅退出后不得逃逸 Traceback（与 uvicorn CLI 同口径）。"""

        class FakeServer:
            def __init__(self, config):
                pass

            def run(self, sockets=None):
                raise KeyboardInterrupt

        monkeypatch.setattr(launcher.uvicorn, "Server", FakeServer)
        sock = socket.socket()
        try:
            assert launcher.run_server(sock, "127.0.0.1", 8090) == 0
        finally:
            sock.close()


class TestMain:
    def _cfg(self, port=8090, host="127.0.0.1"):
        cfg = default_config()
        cfg.server.host = host
        cfg.server.port = port
        return cfg

    def test_reuse_path_exits_zero_and_opens_browser(self, monkeypatch):
        monkeypatch.setattr(launcher, "load_config", lambda: self._cfg())
        monkeypatch.setattr(launcher, "acquire_endpoint", lambda host, port, **_: launcher.ReuseEndpoint(port=port))
        opened: list[str] = []
        monkeypatch.setattr(launcher.webbrowser, "open", lambda url: opened.append(url) or True)
        monkeypatch.setattr(launcher, "run_server", lambda *a, **k: pytest.fail("复用路径不应启动服务"))
        # 非交互式（重定向/测试环境）不进入控制菜单
        monkeypatch.setattr(launcher, "_is_interactive", lambda: False)
        monkeypatch.setattr(launcher, "prompt_reuse_action", lambda port: pytest.fail("非交互式不应弹菜单"))

        assert launcher.main(["--open"]) == 0
        assert opened == ["http://127.0.0.1:8090/"]

    def test_reuse_interactive_menu_without_open_flag(self, monkeypatch):
        """交互式复用：未传 --open（如 ./deploy.sh run）也保持窗口并提供控制菜单。"""
        monkeypatch.setattr(launcher, "load_config", lambda: self._cfg())
        monkeypatch.setattr(launcher, "acquire_endpoint", lambda host, port, **_: launcher.ReuseEndpoint(port=port))
        opened: list[str] = []
        monkeypatch.setattr(launcher.webbrowser, "open", lambda url: opened.append(url) or True)
        prompted: list[int] = []
        monkeypatch.setattr(launcher, "_is_interactive", lambda: True)
        monkeypatch.setattr(launcher, "prompt_reuse_action", lambda port: prompted.append(port) or "close")
        monkeypatch.setattr(launcher, "run_server", lambda *a, **k: pytest.fail("复用路径不应启动服务"))

        assert launcher.main([]) == 0
        assert prompted == [8090]
        assert opened == []  # 未传 --open：不打开浏览器，仅保持窗口菜单

    def test_serve_path_passes_open_flag(self, monkeypatch):
        monkeypatch.setattr(launcher, "load_config", lambda: self._cfg(port=8091))
        sock = socket.socket()
        captured = {}

        def _fake_run(sock_arg, host, port, *, open_browser=False):
            captured.update(sock=sock_arg, host=host, port=port, open_browser=open_browser)
            return 0

        monkeypatch.setattr(launcher, "acquire_endpoint", lambda host, port, **_: launcher.ServeEndpoint(port=port, sock=sock))
        monkeypatch.setattr(launcher, "run_server", _fake_run)
        assert launcher.main(["--open"]) == 0
        assert captured == {"sock": sock, "host": "127.0.0.1", "port": 8091, "open_browser": True}

    def test_new_flag_skips_reuse_probe(self, monkeypatch):
        """--new：忽略复用探测（probe 恒 False），强制自本端口起绑定顺延。"""
        monkeypatch.setattr(launcher, "load_config", lambda: self._cfg(port=8091))
        sock = socket.socket()
        captured = {}

        def _fake_acquire(host, port, *, probe=None):
            captured["probe"] = probe
            return launcher.ServeEndpoint(port=port, sock=sock)

        monkeypatch.setattr(launcher, "acquire_endpoint", _fake_acquire)
        monkeypatch.setattr(launcher, "run_server", lambda *a, **k: 0)
        assert launcher.main(["--new"]) == 0
        probe = captured["probe"]
        assert callable(probe)
        assert probe(8090, "127.0.0.1") is False
        assert probe(8091, "10.9.8.7") is False

    def test_all_ports_occupied_exits_one(self, monkeypatch, capsys):
        monkeypatch.setattr(launcher, "load_config", lambda: self._cfg())
        monkeypatch.setattr(launcher, "acquire_endpoint", lambda host, port, **_: None)
        assert launcher.main([]) == 1
        err = capsys.readouterr().err
        assert "8090-8100" in err and "config.yaml" in err

    def test_bind_failure_exits_one(self, monkeypatch, capsys):
        monkeypatch.setattr(launcher, "load_config", lambda: self._cfg())

        def _boom(host, port, **_):
            raise OSError(errno.EADDRNOTAVAIL, "cannot assign requested address")

        monkeypatch.setattr(launcher, "acquire_endpoint", _boom)
        assert launcher.main([]) == 1
        assert "启动失败" in capsys.readouterr().err


class TestReuseMenu:
    """复用控制菜单：S（+Y 确认）=停止运行中的实例；其它键=仅关闭窗口。"""

    def _cfg(self):
        cfg = default_config()
        cfg.server.host = "127.0.0.1"
        cfg.server.port = 8090
        return cfg

    def _prepare(self, monkeypatch, keys):
        monkeypatch.setattr(launcher, "load_config", lambda: self._cfg())
        monkeypatch.setattr(
            launcher, "acquire_endpoint", lambda host, port, **_: launcher.ReuseEndpoint(port=port)
        )
        monkeypatch.setattr(launcher.webbrowser, "open", lambda url: True)
        monkeypatch.setattr(launcher, "_is_interactive", lambda: True)
        key_iter = iter(keys)
        monkeypatch.setattr(launcher, "_read_key", lambda: next(key_iter, ""))
        monkeypatch.setattr(launcher, "run_server", lambda *a, **k: pytest.fail("复用路径不应启动服务"))

    def test_stop_flow_stops_listener(self, monkeypatch):
        self._prepare(monkeypatch, ["s", "y", "x"])
        stopped: list[int] = []
        monkeypatch.setattr(
            launcher,
            "stop_listener",
            lambda port: (stopped.append(port), (True, "已停止运行中的实例：1（python）"))[1],
        )
        assert launcher.main(["--open"]) == 0
        assert stopped == [8090]

    def test_any_other_key_closes_without_stop(self, monkeypatch):
        self._prepare(monkeypatch, ["q"])
        monkeypatch.setattr(launcher, "stop_listener", lambda port: pytest.fail("不应停止"))
        assert launcher.main(["--open"]) == 0

    def test_cancel_confirmation_skips_stop(self, monkeypatch):
        self._prepare(monkeypatch, ["s", "n"])
        monkeypatch.setattr(launcher, "stop_listener", lambda port: pytest.fail("确认被拒不应停止"))
        assert launcher.main(["--open"]) == 0


class TestStopListener:
    def test_no_listener_reports(self, monkeypatch):
        monkeypatch.setattr(launcher, "_find_listener_pids", lambda port: [])
        ok, detail = launcher.stop_listener(8090)
        assert ok is False
        assert "未找到" in detail

    def test_terminates_all_pids(self, monkeypatch):
        terminated: list[int] = []
        killed: list[int] = []

        class FakeProc:
            def __init__(self, pid):
                self.pid = pid

            def name(self):
                return "python"

            def terminate(self):
                terminated.append(self.pid)

            def wait(self, timeout=None):
                return 0

            def kill(self):
                killed.append(self.pid)

        monkeypatch.setattr(psutil, "Process", FakeProc)
        monkeypatch.setattr(launcher, "_find_listener_pids", lambda port: [111, 222])
        ok, detail = launcher.stop_listener(8090)
        assert ok is True
        assert terminated == [111, 222]
        assert killed == []
        assert "已停止运行中的实例" in detail


class TestReadKey:
    """按键读取：POSIX cbreak 单键（免回车，与 Windows msvcrt 一致）与行输入回退。"""

    def test_posix_cbreak_single_key(self, monkeypatch):
        """POSIX：经 termios cbreak 读单键、归一小写、恰好读 1 字节、恢复终端属性。"""
        restored: list[tuple] = []
        fake_termios = types.SimpleNamespace(
            tcgetattr=lambda fd: "attrs",
            tcsetattr=lambda fd, when, attrs: restored.append((fd, when, attrs)),
            TCSADRAIN=1,
        )
        fake_tty = types.SimpleNamespace(setcbreak=lambda fd: None)
        monkeypatch.setitem(sys.modules, "termios", fake_termios)
        monkeypatch.setitem(sys.modules, "tty", fake_tty)
        read_sizes: list[int] = []
        fake_stdin = types.SimpleNamespace(fileno=lambda: 7, read=lambda n: read_sizes.append(n) or "S")
        monkeypatch.setattr(sys, "stdin", fake_stdin)

        assert launcher._read_key_posix() == "s"
        assert read_sizes == [1]
        assert restored == [(7, 1, "attrs")]

    def test_posix_fallback_to_line_input(self, monkeypatch):
        """POSIX：termios 不可用（sys.modules 置 None 模拟 ImportError）→ 回退行输入。"""
        monkeypatch.setitem(sys.modules, "termios", None)
        monkeypatch.setitem(sys.modules, "tty", None)
        monkeypatch.setattr("builtins.input", lambda: " Y ")
        assert launcher._read_key_posix() == "y"


class TestConsoleLayout:
    """控制台排版契约：横幅与键值对齐两平台一致（LAUN-33..35）。"""

    def test_access_banner_layout(self, monkeypatch, capsys):
        """访问地址横幅：`=` 分隔线 + `tGo Server` + Local/LAN 冒号对齐。"""
        monkeypatch.setattr(launcher, "detect_lan_ip", lambda: "192.168.3.7")
        launcher._report_access("0.0.0.0", 8090)
        banner = "[tGo] " + "=" * 60
        assert capsys.readouterr().out.strip().splitlines() == [
            banner,
            "[tGo]   tGo Server",
            "[tGo]   - Local    : http://127.0.0.1:8090/",
            "[tGo]   - LAN      : http://192.168.3.7:8090/",
            banner,
        ]

    def test_reuse_menu_banner_layout(self, monkeypatch, capsys):
        """复用菜单：横幅化 + 中文键值对齐（停止/关闭两行）。"""
        monkeypatch.setattr(launcher, "_find_listener_pids", lambda port: [12345])
        monkeypatch.setattr(launcher, "_read_key", lambda: "q")
        assert launcher.prompt_reuse_action(8090) == "close"
        out = capsys.readouterr().out
        assert "[tGo]   复用运行中的实例（本窗口未启动服务）" in out
        assert "[tGo]   - 停止实例 : 按 S（PID 12345，需再按 Y 确认）" in out
        assert "[tGo]   - 关闭窗口 : 按其它任意键" in out

    def test_banner_width_consistent_across_platform_scripts(self):
        """排版契约：launcher 与 start.ps1/deploy.sh 的横幅宽度一致（60）。"""
        root = Path(__file__).resolve().parents[2]
        assert launcher._BANNER_WIDTH == 60
        assert "'=' * 60" in (root / "start.ps1").read_text(encoding="utf-8-sig")
        assert "BANNER_WIDTH=60" in (root / "deploy.sh").read_text(encoding="utf-8")
