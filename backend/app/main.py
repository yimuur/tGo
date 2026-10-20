"""FastAPI 应用工厂、lifespan、静态托管（ARCHITECTURE §1.1/§2）。

- `create_app()`：工厂模式，config 可显式注入（测试用）或从 config.yaml 加载；
  ``services`` 可显式注入（测试用 mock 服务容器），否则 lifespan 内自动装配；
- lifespan：配置加载、日志初始化、服务装配（数据库/引擎/分析/对局/复盘/报告/WS
  会话）、分析 worker 与引擎管理器启动、停止时优雅释放；
- 静态托管：`frontend/static` 存在时挂载 `/static` 并以 `html=True` 根挂载 `/`
  （T5.1 产品 SPA 壳：`GET /` 返回 `index.html`，相对资产 `css/js/*.svg` 在根路径可达）；
- `GET /api/health`：存活探针。
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator, Awaitable, Callable, Optional, Union

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from app.api import register_api_routes
from app.bootstrap import AppServices, build_services
from app.config import AppConfig, load_config, resolve_config_path
from app.core.accept_guard import install_proactor_accept_retry
from app.core.console_guard import install_nonblocking_console
from app.core.errors import register_error_handlers
from app.core.logging_setup import setup_engine_log_handler, setup_logging
from app.core.loop_guard import install_loop_exception_guard
from app.version import APP_VERSION

logger = logging.getLogger(__name__)

#: 环境变量：覆盖前端静态目录（便于测试与自定义部署路径）
STATIC_DIR_ENV = "TGO_STATIC_DIR"


def _default_static_dir() -> Path:
    """默认前端静态目录：项目根 `frontend/static`（backend/app/main.py 上溯 2 级）。"""
    return Path(__file__).resolve().parents[2] / "frontend" / "static"


async def _release_step(name: str, release: Callable[[], Awaitable[None]]) -> None:
    """关停序列中的单步释放：失败只记日志，**不向上抛**。

    关停是“尽力而为的依次释放”：任一步失败都不能跳过后续释放（尤其是
    `db.close()`——漏关使 aiosqlite **非 daemon** 工作线程在解释器收尾的
    `threading._shutdown()` 里永久阻塞，现象为 Ctrl+C 后进程无法退出，BUG-122）。
    取消语义不变：`CancelledError` 照旧上抛（关停取消不得被吞，见 BUG-118 L-1）。
    """
    try:
        await release()
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("关停释放失败（%s，已继续释放其余资源）", name)


def resolve_static_dir() -> Optional[Path]:
    """解析静态目录：环境变量优先，否则默认路径；目录不存在返回 None（不挂载）。"""
    env = os.environ.get(STATIC_DIR_ENV)
    candidate = Path(env) if env else _default_static_dir()
    return candidate if candidate.is_dir() else None


class NoCacheStaticFiles(StaticFiles):
    """静态资源强制协商缓存（``Cache-Control: no-cache``）。

    背景（2026/09/13）：静态托管此前无显式缓存策略——移动端浏览器（尤其
    iOS/Safari）按启发式缓存可长期直接使用本地副本而不回源校验；服务端代码
    更新/重启后，手机可能仍运行**过期 JS 客户端**（与「须清除浏览器数据才能
    恢复」的现象一致）。``no-cache`` = 允许本地缓存但**每次使用前必须回源
    校验**（ETag/Last-Modified 命中即 304，局域网开销可忽略），保证客户端与
    服务端资产版本一致。
    """

    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        response.headers.setdefault("cache-control", "no-cache")
        return response


def create_app(
    config: Optional[AppConfig] = None,
    config_path: Union[str, os.PathLike[str], None] = None,
    services: Optional[AppServices] = None,
) -> FastAPI:
    """创建 FastAPI 应用实例。

    - `config`：显式注入配置（测试用）；缺省时按 `config_path`（缺省按环境变量/当前目录）加载；
    - `config_path`：配置文件路径（仅当 `config` 未提供时生效；记录到 app.state 供
      管理页配置写回）；
    - `services`：显式注入服务容器（测试用 mock 服务）；缺省时 lifespan 自动装配。
    """

    # 非阻塞控制台输出（机制 A / BUG-127）：控制台被冻结/暂停输出时，日志写入不得阻塞
    # 事件循环；此处同时把 uvicorn 在 `Config()` 构造时绑定的控制台 handler 改指代理。
    install_nonblocking_console()
    # Windows Proactor 的 accept 中止致命性（BUG-125）：必须在监听套接字开始 accept
    # **之前**安装重投保护——uvicorn 在 lifespan 之前经 `Config.load()` 调本工厂，故此处
    # 是唯一兼得两条入口（launcher / `uvicorn app.main:create_app --factory`）的时点。
    # 非 Windows 为空操作（selector 循环本就丢弃被中止的连接并继续接受）。
    install_proactor_accept_retry()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        cfg: AppConfig = app.state.config
        setup_logging(cfg.logging)
        setup_engine_log_handler(cfg.logging)
        # 移动端断连（RST/WinError 10054）在 Windows Proactor 下会经循环异常处理器
        # 打出全量 Traceback——过滤该预期收尾噪音（见 app/core/loop_guard.py）
        install_loop_exception_guard()

        svc = app.state.services  # Optional[AppServices]；None 时自建
        built_here = svc is None
        if svc is None:
            svc = await build_services(cfg)
            app.state.services = svc

        await svc.analysis.start()
        if svc.manager is not None:
            await svc.manager.start()
        logger.info("tGo 应用启动（引擎常驻：%s）", "是" if cfg.engine.resident else "否")
        yield
        # ---- 优雅释放：引擎（退出序列）→ 分析 worker → 数据库（自建时） ----
        # 每步独立守卫 + `finally` 兼底（BUG-122）：引擎/分析停失败也不得漏关数据库。
        # ⚠ uvicorn 在 `force_exit`（关停期间再次 Ctrl+C）下会**跳过 lifespan.shutdown()**
        #   本序列 → 由 `Database` 层的解释器退出钩子兼底释放（见 `db/database.py`）。
        try:
            if svc.manager is not None:
                await _release_step("引擎", svc.manager.stop)
            await _release_step("分析 worker", svc.analysis.stop)
        finally:
            if built_here:
                await _release_step("数据库", svc.db.close)
            logger.info("tGo 应用停止")

    app = FastAPI(title="tGo", version=APP_VERSION, lifespan=lifespan)

    app.state.config = config if config is not None else load_config(config_path)
    # 写回语义：config 注入（测试）不落盘；显式 config_path（单文件）→ 写回其自身；
    # 缺省分层加载 → save_config(None) 写项目根 config.yaml（仅增量）。
    if config is not None:
        app.state.config_path = None  # 注入配置（测试）不落盘
        app.state.config_persist = False
    elif config_path is not None:
        app.state.config_path = resolve_config_path(config_path)
        app.state.config_persist = True
    else:
        app.state.config_path = None  # 分层默认：根 config.yaml（增量落盘）
        app.state.config_persist = True
    app.state.services = services

    register_error_handlers(app)

    static_dir = resolve_static_dir()
    if static_dir is not None:
        app.mount("/static", NoCacheStaticFiles(directory=str(static_dir)), name="static")

    _register_routes(app, static_dir)

    # T5.1：产品 SPA 壳根托管。index.html 内相对资产（css/、js/、favicon.svg、
    # title.svg 等）需在根路径可达，故以 html=True 挂载 "/"；必须先于所有
    # API/WS/文档路由注册之后挂载，避免遮蔽 /api、/ws、/docs、/openapi.json。
    if static_dir is not None:
        app.mount("/", NoCacheStaticFiles(directory=str(static_dir), html=True), name="app")
    return app


def _register_routes(app: FastAPI, static_dir: Optional[Path] = None) -> None:
    """路由注册：健康检查 + Phase 4 API 接入层（REST + WS）+ 首页（T5.1）。

    静态目录存在且含 `index.html` 时，`GET /` 返回首页（浏览器打开即渲染）。
    """
    if static_dir is not None:
        index_file = static_dir / "index.html"
        if index_file.is_file():

            @app.get("/", include_in_schema=False)
            async def index_page() -> FileResponse:
                # 协商缓存：首页每次回源校验（防移动端长期使用过期壳）
                return FileResponse(str(index_file), headers={"cache-control": "no-cache"})

    @app.get("/api/health")
    async def health() -> dict:
        return {"status": "ok"}

    register_api_routes(app)
