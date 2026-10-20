"""T0.5 测试基座：跨层可复用的 fixtures（遵循 AGENTS.md §7）。

- `db_conn`      : aiosqlite `:memory:` 连接（唯一内存库，Phase 1 在此挂载 schema）；
- `fake_time`    : 替换 `asyncio.sleep` 的虚拟时钟（杜绝真实硬等待 / 时间窗口计数）；
- `engine_mock`  : AsyncMock 引擎（严禁真实 KataGo 进程 / GPU / 权重文件）；
- `samples_dir`  : 录制 JSON 样本目录（引擎响应 / WS 报文），须提交版本库。
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from unittest.mock import AsyncMock

import aiosqlite
import pytest

SAMPLES_DIR = Path(__file__).parent / "samples"


class FakeTime:
    """虚拟时钟：``sleep(delay>0)`` 立即返回并推进虚拟时间；``sleep(0)`` 保留真实让出语义。

    用于节流/重连/超时相关断言的 Mock 时间流（AGENTS.md §6/§7）。
    """

    def __init__(self) -> None:
        self.now = 0.0
        self._real_sleep = asyncio.sleep

    async def sleep(self, delay: float, result=None):
        if delay == 0:
            # sleep(0) 用于让出事件循环（任务切换），保留真实语义
            return await self._real_sleep(0)
        self.now += delay
        # 让出事件循环一次（模拟真实 sleep 的调度点，防止独占循环）
        await self._real_sleep(0)
        return result

    def advance(self, seconds: float) -> None:
        """手动推进虚拟时钟（配合时间窗口累计计数断言）。"""
        self.now += seconds


@pytest.fixture
def fake_time(monkeypatch):
    """替换 ``asyncio.sleep`` 为虚拟时钟推进（禁真实硬等待断言）。"""
    clock = FakeTime()
    monkeypatch.setattr(asyncio, "sleep", clock.sleep)
    return clock


@pytest.fixture
async def db_conn():
    """aiosqlite `:memory:` 连接（每测试独立，Phase 1 在此挂载 schema）。"""
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    try:
        yield conn
    finally:
        await conn.close()


@pytest.fixture
async def db():
    """已连接并应用迁移的 `:memory:` Database（Phase 1+ 仓储层测试基座）。"""
    from app.db.database import Database

    database = Database(":memory:")
    await database.connect()
    try:
        yield database
    finally:
        await database.close()


@pytest.fixture
def engine_mock():
    """AsyncMock 引擎：拦截子进程输入输出（严禁真实 KataGo/GPU/权重）。

    后续 Phase 2/3 将按引擎接口扩展该 fixture 的具体行为。
    """
    engine = AsyncMock()
    engine.start = AsyncMock()
    engine.stop = AsyncMock()
    engine.ensure_ready = AsyncMock(return_value=True)
    engine.query = AsyncMock(return_value={"id": "mock"})
    engine.state = "IDLE"
    return engine


@pytest.fixture
def samples_dir() -> Path:
    """录制 JSON 样本目录（引擎响应 / WS 报文），须提交版本库。"""
    SAMPLES_DIR.mkdir(exist_ok=True)
    return SAMPLES_DIR


# ============================================================
# Phase 4 API 集成测试基座（mock 引擎 + :memory: DB）
# ============================================================


@pytest.fixture
def fake_manager():
    """mock 引擎管理器（FakeManager，状态可配）。"""
    from tests.fakes import FakeManager

    return FakeManager()


@pytest.fixture
async def api_svc(tmp_path, fake_manager):
    """装配真实服务容器（mock 引擎）；数据库独立 `:memory:`；日志指向 tmp。

    - 供 REST/WS 集成测试使用：``api_svc.xxx`` 直接访问服务；
    - lifespan 启停服务由 ``TestClient`` 驱动（分析 worker/管理器/DB 生命周期）。
    """
    from app.bootstrap import AppServices
    from app.config import default_config
    from app.db.database import Database
    from app.services.adaptive import AdaptiveDifficulty
    from app.services.analysis_service import AnalysisService
    from app.services.game_service import GameService
    from app.services.report_service import ReportService
    from app.services.review_service import ReviewService
    from app.ws.pushes import AnalysisResultFanout, GameCommentPusher, SettlementPredictor
    from app.ws.session import GameAnalysisPusher, SessionManager

    cfg = default_config()
    cfg.logging.dir = str(tmp_path / "logs")
    # 引擎 cfg 同口径隔离（BUG-133）：PUT /admin/config 的引擎级键会**真实渲染** analysis.cfg，
    # 不钉到 tmp 就会写回仓库 `engine/katago/analysis.cfg`（污染开发环境，并与 config.yaml 漂移）
    cfg.engine.analysis_cfg = str(tmp_path / "analysis.cfg")
    db = Database(":memory:")
    await db.connect()

    # 注意：分析 worker 池由 TestClient lifespan 在应用事件循环中启动
    # （不在 fixture 循环启动，避免跨循环任务无人消费导致 WS 挂起）。
    analysis = AnalysisService(db.conn, cfg, engine=fake_manager)
    adaptive = AdaptiveDifficulty(db.conn, cfg)
    game = GameService(
        db.conn,
        cfg,
        human_model_available=fake_manager._human,
        engine=fake_manager,
        adaptive=adaptive,
        analysis=analysis,
    )
    review = ReviewService(db.conn, cfg, game_service=game, analysis=analysis)
    report = ReportService(db.conn, cfg)
    session = SessionManager()
    pusher = GameAnalysisPusher(analysis, session)
    # 分析结果推送接线（与 bootstrap 一致）：曲线节流 + 每手点评（扇出共用回调槽）
    comment_pusher = GameCommentPusher(review, session)
    analysis.set_on_result(AnalysisResultFanout(pusher.on_result, comment_pusher.on_result))
    settlement = SettlementPredictor(db.conn, cfg, analysis, session)

    svc = AppServices(
        config=cfg,
        db=db,
        manager=fake_manager,
        analysis=analysis,
        game=game,
        review=review,
        report=report,
        session=session,
        pusher=pusher,
        comment_pusher=comment_pusher,
        settlement=settlement,
    )
    yield svc
    # 兜底释放（未经过 lifespan 关闭时）
    await analysis.stop()
    await db.close()


@pytest.fixture
def api_app(api_svc):
    """FastAPI 应用（注入 api_svc 服务容器；lifespan 启动/停止服务）。"""
    from app.main import create_app

    return create_app(config=api_svc.config, services=api_svc)


# ============================================================
# 测试隔离守卫：根日志器文件 handler（BUG-128）
# ============================================================

PRODUCT_LOG_DIR = (Path(__file__).resolve().parents[2] / "logs").resolve()


def _writes_to_product_log(handler: logging.Handler) -> bool:
    """该文件 handler 是否写向产品日志目录（``<项目根>/logs``）。"""
    filename = getattr(handler, "baseFilename", None)
    return bool(filename) and Path(filename).resolve().parent == PRODUCT_LOG_DIR


def _product_log_handlers(handlers) -> list[logging.Handler]:
    """筛出写向产品日志目录（``<项目根>/logs``）的文件 handler。"""
    return [handler for handler in handlers if _writes_to_product_log(handler)]


def _attached_handlers() -> dict[int, tuple[logging.Logger, logging.Handler]]:
    """全部日志器（root + 具名）当前挂载的 handler（``id(handler) -> (日志器, handler)``）。

    须覆盖具名日志器：`setup_engine_log_handler` 把 ``engine.log`` 的 handler 挂在
    ``tgo.engine`` 上，只查 root 会漏判。
    """
    attached: dict[int, tuple[logging.Logger, logging.Handler]] = {}
    loggers = [logging.getLogger()]
    loggers += [
        logger
        for logger in logging.Logger.manager.loggerDict.values()
        if isinstance(logger, logging.Logger)
    ]
    for logger in loggers:
        for handler in list(logger.handlers):
            attached[id(handler)] = (logger, handler)
    return attached


@pytest.fixture(autouse=True)
def isolate_root_logging():
    """用例间日志器隔离：回收泄漏 handler，并断言用例未把日志写进产品 ``logs/``。

    根因（BUG-128）：``create_app`` lifespan 按 ``app.state.config.logging.dir`` 装配文件
    handler（root 的 ``tgo.log`` + ``tgo.engine`` 的 ``engine.log``）；用例若把
    ``state.config`` 换成默认 ``AppConfig()``（``logging.dir="logs"``，即产品目录），测试记录
    会写进产品日志，且 handler 跨用例存活、静默污染后续用例——故此处既回收也快速失败
    （AGENTS.md §7 硬件/环境隔离）。
    """
    baseline_level = logging.getLogger().level

    # 会话中已泄漏的产品 handler（非本用例装配）先回收，避免持续污染后续用例
    for logger, handler in _attached_handlers().values():
        if _writes_to_product_log(handler):
            logger.removeHandler(handler)
            handler.close()
    baseline_ids = set(_attached_handlers())

    yield

    added = [pair for handler_id, pair in _attached_handlers().items() if handler_id not in baseline_ids]
    offenders = [
        (logger, handler) for logger, handler in added if _writes_to_product_log(handler)
    ]
    for logger, handler in added:
        logger.removeHandler(handler)
        handler.close()
    logging.getLogger().setLevel(baseline_level)
    if offenders:
        targets = ", ".join(
            sorted(
                f"{logger.name}:{getattr(handler, 'baseFilename', '?')}"
                for logger, handler in offenders
            )
        )
        pytest.fail(
            "测试把日志写进了产品日志目录（须让 logging.dir 指向 tmp_path）：" + targets
        )
