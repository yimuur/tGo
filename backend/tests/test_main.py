"""T0.6 FastAPI 应用骨架测试：健康检查、lifespan、配置注入、静态托管。

用例 ID: APP-*
"""

from fastapi.testclient import TestClient

from app.config import AppConfig
from app.main import STATIC_DIR_ENV, create_app


def _cfg(tmp_path) -> AppConfig:
    """测试配置：日志/DB/引擎全部指向临时目录，避免污染仓库与真实引擎/模型依赖。"""
    exe_dir = tmp_path / "katago"
    models_dir = tmp_path / "models"
    exe_dir.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)
    # 占位可执行文件/模型（仅路径探测，绝不启动真实 KataGo 进程；AGENTS.md §7）
    (exe_dir / "katago.exe").write_bytes(b"x")
    (exe_dir / "katago").write_bytes(b"x")
    (models_dir / "kata1.bin.gz").write_bytes(b"x")
    return AppConfig(
        engine={
            "executable_dir": str(exe_dir),
            "model_dir": str(models_dir),
            "analysis_cfg": str(tmp_path / "analysis.cfg"),
        },
        logging={"dir": str(tmp_path / "logs")},
        db={"path": str(tmp_path / "tgo.db")},
    )


class TestHealth:
    def test_health_returns_ok(self, tmp_path):
        app = create_app(config=_cfg(tmp_path))
        with TestClient(app) as client:
            resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


class TestLifespan:
    def test_start_stop_no_error(self, tmp_path):
        """lifespan 启停无异常，且日志目录被创建。"""
        cfg = _cfg(tmp_path)
        app = create_app(config=cfg)
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200
        assert (tmp_path / "logs").is_dir()

    def test_missing_db_dir_auto_created(self, tmp_path):
        """ISSUE-045：db 父目录缺失（首启 `data/` 未预建）→ 启动时自动创建。"""
        cfg = _cfg(tmp_path)
        cfg.db.path = str(tmp_path / "data" / "tgo.db")
        app = create_app(config=cfg)
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200
        assert (tmp_path / "data" / "tgo.db").exists()

    def test_relative_db_path_anchored_via_project_path(self, tmp_path, monkeypatch):
        """相对 db 路径经 project_path 锚定（此处锚到 tmp 验证装配接线，不触碰真实 data/）。"""
        monkeypatch.setattr("app.bootstrap.project_path", lambda v: tmp_path / v)
        cfg = _cfg(tmp_path)
        cfg.db.path = "data/tgo.db"
        app = create_app(config=cfg)
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200
        assert (tmp_path / "data" / "tgo.db").exists()

    def test_injected_config_available(self, tmp_path):
        cfg = _cfg(tmp_path)
        cfg.engine.standard_max_visits = 250
        app = create_app(config=cfg)
        with TestClient(app):
            assert app.state.config.engine.standard_max_visits == 250

    def test_release_failure_still_closes_db(self, tmp_path, monkeypatch):
        """关停释放任一步失败也不得漏关数据库（BUG-122）。

        漏关后果：aiosqlite **非 daemon** 工作线程在解释器收尾的
        `threading._shutdown()` 里永久阻塞 → Ctrl+C 后进程无法退出。
        """
        from app.db.database import Database
        from app.engine.manager import EngineManager
        from app.services.analysis_service import AnalysisService

        async def boom(self) -> None:
            raise RuntimeError("关停失败（测试构造）")

        closed: list[bool] = []
        real_close = Database.close

        async def spy_close(self) -> None:
            closed.append(True)
            await real_close(self)

        monkeypatch.setattr(EngineManager, "stop", boom)
        monkeypatch.setattr(AnalysisService, "stop", boom)
        monkeypatch.setattr(Database, "close", spy_close)
        app = create_app(config=_cfg(tmp_path))
        with TestClient(app) as client:  # 退出上下文即触发 lifespan 关停（异常不得逸出）
            assert client.get("/api/health").status_code == 200
        assert closed == [True]

    def test_loop_exception_guard_installed_on_startup(self, tmp_path, monkeypatch):
        """2026/09/13：lifespan 启动时安装连接重置噪音过滤（见 app/core/loop_guard.py）。"""
        calls = []
        monkeypatch.setattr("app.main.install_loop_exception_guard", lambda: calls.append(True))
        app = create_app(config=_cfg(tmp_path))
        with TestClient(app):
            pass
        assert calls == [True]


class TestResidentStartupDegrade:
    """BUG-104：常驻模式下引擎启动失败不得拖死应用（lifespan 不得因引擎失败而失败）。"""

    def test_lifespan_survives_resident_engine_start_failure(self, tmp_path, monkeypatch):
        """引擎「启动期进程退出」→ 应用照常启动（引擎降级 DEAD 由退避重启接管）。

        旧实现：`manager.start()` → `ensure_ready` 抛 `AppError: 引擎启动失败（进程退出）`
        传播出 lifespan → uvicorn `Application startup failed. Exiting.`（整个应用退出）。
        """
        from app.core.fsm import EngineState
        from app.engine.analysis_engine import EngineStoppedError

        class _CrashOnStartEngine:
            """启动即「进程退出」的引擎替身（严禁真实 KataGo 进程，AGENTS §7）。"""

            def __init__(self, fsm):
                self.fsm = fsm
                self.has_human_model = True
                self.benchmarking = False
                self.is_running = False
                self.on_crash = None

            def set_callbacks(self, *, on_stderr_line=None, on_crash=None, on_query_state_change=None):
                self.on_crash = on_crash

            async def start(self):
                self.fsm.mark_started()
                self.is_running = True
                self.on_crash()  # 进程退出（崩溃回调 → DEAD + 退避调度）
                self.is_running = False
                raise EngineStoppedError("引擎输出流意外关闭（进程退出）")

            async def stop(self):
                self.is_running = False

            async def query(self, data, timeout_s=None):
                raise EngineStoppedError("引擎未运行")

        monkeypatch.setattr(
            "app.bootstrap.build_engine", lambda cfg, fsm: _CrashOnStartEngine(fsm)
        )

        cfg = _cfg(tmp_path)
        cfg.engine.resident = True
        app = create_app(config=cfg)
        with TestClient(app) as client:  # 旧实现此处即抛「Application startup failed」
            assert client.get("/api/health").status_code == 200
            manager = app.state.services.manager
            assert manager is not None
            # 引擎降级（DEAD→退避重启；连续失败后 FATAL），应用不退出
            assert manager.fsm.state in (EngineState.DEAD, EngineState.FATAL)


class TestStaticHosting:
    def test_static_mounted_when_dir_exists(self, tmp_path, monkeypatch):
        static = tmp_path / "static"
        static.mkdir()
        (static / "index.html").write_text("<html>tGo</html>", encoding="utf-8")
        monkeypatch.setenv(STATIC_DIR_ENV, str(static))

        app = create_app(config=_cfg(tmp_path))
        with TestClient(app) as client:
            resp = client.get("/static/index.html")
            assert resp.status_code == 200
            assert resp.text == "<html>tGo</html>"

    def test_root_serves_index_when_static_exists(self, tmp_path, monkeypatch):
        """T5.1：静态目录存在且含 index.html 时，`GET /` 返回首页（浏览器打开即渲染）。"""
        static = tmp_path / "static"
        static.mkdir()
        (static / "index.html").write_text("<html>tGo 首页</html>", encoding="utf-8")
        monkeypatch.setenv(STATIC_DIR_ENV, str(static))

        app = create_app(config=_cfg(tmp_path))
        with TestClient(app) as client:
            resp = client.get("/")
            assert resp.status_code == 200
            assert resp.text == "<html>tGo 首页</html>"
            assert resp.headers["content-type"].startswith("text/html")

    def test_static_not_mounted_when_missing(self, tmp_path, monkeypatch):
        monkeypatch.setenv(STATIC_DIR_ENV, str(tmp_path / "no-such-dir"))
        app = create_app(config=_cfg(tmp_path))
        with TestClient(app) as client:
            assert client.get("/static/index.html").status_code == 404
            assert client.get("/").status_code == 404
            assert client.get("/css/app.css").status_code == 404  # 根挂载同样缺失

    def test_root_assets_served_when_static_exists(self, tmp_path, monkeypatch):
        """T5.1：SPA 壳相对资产（css/js/svg）在根路径可达（html=True 根挂载）。"""
        static = tmp_path / "static"
        static.mkdir()
        (static / "index.html").write_text("<html>tGo 首页</html>", encoding="utf-8")
        css_dir = static / "css"
        css_dir.mkdir()
        (css_dir / "app.css").write_text("body{}", encoding="utf-8")
        (static / "favicon.svg").write_text("<svg/>", encoding="utf-8")
        monkeypatch.setenv(STATIC_DIR_ENV, str(static))

        app = create_app(config=_cfg(tmp_path))
        with TestClient(app) as client:
            resp = client.get("/css/app.css")
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/css")
            assert resp.text == "body{}"

            resp = client.get("/favicon.svg")
            assert resp.status_code == 200
            assert "image/svg" in resp.headers["content-type"]

    def test_static_responses_no_cache(self, tmp_path, monkeypatch):
        """2026/09/13：静态资源（首页/根资产/`/static`）带 `Cache-Control: no-cache` 协商缓存。

        防移动端（尤其 iOS/Safari）启发式缓存长期不回源——服务端更新/重启后
        手机仍跑过期 JS 客户端（「须清除浏览器数据才能恢复」同族现象）。
        """
        static = tmp_path / "static"
        static.mkdir()
        (static / "index.html").write_text("<html>tGo</html>", encoding="utf-8")
        (static / "css").mkdir()
        (static / "css" / "app.css").write_text("body{}", encoding="utf-8")
        monkeypatch.setenv(STATIC_DIR_ENV, str(static))

        app = create_app(config=_cfg(tmp_path))
        with TestClient(app) as client:
            for path in ("/", "/static/index.html", "/css/app.css"):
                resp = client.get(path)
                assert resp.status_code == 200, path
                assert resp.headers.get("cache-control") == "no-cache", path

    def test_api_routes_win_over_root_mount(self, tmp_path, monkeypatch):
        """T5.1：根静态挂载不得遮蔽 API/未知 API 仍返回 JSON 404。"""
        static = tmp_path / "static"
        static.mkdir()
        (static / "index.html").write_text("<html>tGo</html>", encoding="utf-8")
        (static / "css").mkdir()
        (static / "css" / "app.css").write_text("body{}", encoding="utf-8")
        monkeypatch.setenv(STATIC_DIR_ENV, str(static))

        app = create_app(config=_cfg(tmp_path))
        with TestClient(app) as client:
            # API 路由优先于根挂载
            resp = client.get("/api/health")
            assert resp.status_code == 200
            assert resp.json() == {"status": "ok"}

            # 未知 API 路径不得被 SPA 根挂载吞掉（保持 JSON 404）
            resp = client.get("/api/no-such-endpoint")
            assert resp.status_code == 404
            assert resp.headers["content-type"].startswith("application/json")


class TestBootstrap:
    async def test_build_services_renders_analysis_cfg(self, tmp_path, monkeypatch):
        """H-5：服务装配（启动）时即渲染 analysis.cfg（引擎级参数期望值落盘）。"""
        from app.bootstrap import build_services
        from app.config import AppConfig

        rendered: dict = {}

        def _fake_render(engine_cfg):
            rendered["path"] = engine_cfg.analysis_cfg

        monkeypatch.setattr("app.bootstrap.render_analysis_cfg", _fake_render)

        class _FakeEngine:
            def __init__(self, fsm):
                self.fsm = fsm
                self.has_human_model = True
                self.benchmarking = False
                self.is_running = False

            def set_callbacks(self, *, on_stderr_line=None, on_crash=None, on_query_state_change=None):
                pass

        def _fake_build(cfg, fsm):
            return _FakeEngine(fsm)

        monkeypatch.setattr("app.bootstrap.build_engine", _fake_build)

        cfg = AppConfig(
            logging={"dir": str(tmp_path / "logs")},
            db={"path": str(tmp_path / "tgo.db")},
        )
        svc = await build_services(cfg)
        try:
            assert rendered.get("path") == cfg.engine.analysis_cfg
        finally:
            await svc.analysis.stop()
            await svc.db.close()


class TestAcceptGuard:
    """BUG-125（2026/09/21 现场反馈）：应用工厂须安装 accept 中止重投保护。

    时点契约：uvicorn 在 `Server.startup()`（创建监听套接字并开始 accept）**之前**经
    `Config.load()` 调用本工厂——这是同时覆盖 launcher 与 `uvicorn app.main:create_app
    --factory` 两条入口的唯一时点，故安装点必须在工厂体内（放 lifespan 已太晚：
    首批 AcceptEx 早已投递）。
    """

    def test_create_app_installs_accept_retry_guard(self, monkeypatch, tmp_path):
        from app import main as main_module

        installed: list[int] = []
        monkeypatch.setattr(
            main_module, "install_proactor_accept_retry", lambda: installed.append(1)
        )

        create_app(config=_cfg(tmp_path))

        assert installed == [1], "create_app 必须安装 accept 中止重投保护（BUG-125）"


class TestConsoleGuard:
    """机制 A / BUG-127（2026/09/21 现场反馈）：应用工厂须安装非阻塞控制台输出。

    时点契约：须早于首个日志记录，并覆盖 uvicorn 在 `Config()` 构造时绑定到真实控制台的
    既有 handler（`install_nonblocking_console()` 会把它们改指非阻塞代理）——故安装点在
    工厂体内（`Config.load()` 调工厂，早于 `Server.startup()` 与服务就绪）。
    """

    def test_create_app_installs_nonblocking_console(self, monkeypatch, tmp_path):
        from app import main as main_module

        installed: list[int] = []
        monkeypatch.setattr(
            main_module, "install_nonblocking_console", lambda: installed.append(1)
        )

        create_app(config=_cfg(tmp_path))

        assert installed == [1], "create_app 必须安装非阻塞控制台输出（BUG-127）"
