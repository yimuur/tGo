"""应用服务装配（Phase 4，AppServices + build_services）。

职责：
- 组装 Phase 0-3 全部组件：Database / EngineManager / AnalysisService /
  GameService / ReviewService / ReportService / SessionManager / GameAnalysisPusher /
  GameCommentPusher / SettlementPredictor；
- 依赖注入接线：分析服务 ← 引擎管理器；对局服务 ← 引擎/自适应/分析；
  复盘服务 ← 对局服务/分析；引擎状态 → 全局 WS 广播；分析结果 → 曲线节流推送 +
  每手点评推送（经 ``AnalysisResultFanout`` 共用回调槽）；结算 → 终局深算预判推送；
- 引擎装配失败（可执行文件/标准模型缺失，`ConfigError`）→ ``manager=None``，引擎相关
  功能降级（人人对弈照常，ARCHITECTURE §5.2 降级矩阵），应用仍可启动；
- **运行时重建装配**（BUG-097，人工决策 A）：文件缺失导致 `manager=None` 时，管理端
  [启动]/[手动重启]/[重启] 经 ``ensure_engine_manager()`` 重新装配并绑定到分析/对局
  服务（放入模型/可执行文件后无需重启服务即可恢复引擎）；失败时以真实原因码/文案
  记录（``engine_unavailable_code/message``），供状态查询如实归因。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Callable, Optional

from app.config import AppConfig, ConfigError, EngineConfig, project_path
from app.core.fsm import EngineFsm
from app.db.database import Database
from app.engine.manager import EngineManager, build_engine, render_analysis_cfg
from app.services.adaptive import AdaptiveDifficulty
from app.services.analysis_service import AnalysisService
from app.services.game_service import GameService
from app.services.report_service import ReportService
from app.services.review_service import ReviewService
from app.updates import UpdateService
from app.ws.pushes import AnalysisResultFanout, GameCommentPusher, SettlementPredictor
from app.ws.session import GameAnalysisPusher, SessionManager

logger = logging.getLogger(__name__)


def _make_manager(
    engine_cfg: EngineConfig,
    session: SessionManager,
    *,
    engine_cfg_fn: Optional[Callable[[], EngineConfig]] = None,
) -> EngineManager:
    """构建引擎管理器（可执行文件识别 + 模型解析；人类模型缺失时仅挂载标准模型）。

    - 装配失败抛 ``ConfigError``（``code`` ∈ {standard_model_missing,
      engine_executable_missing}）；
    - ``engine_cfg_fn``：安全重启重建引擎时读取**最新**引擎配置（缺省用传入快照）。
    """
    engine = build_engine(engine_cfg, EngineFsm())
    return EngineManager(
        engine_cfg,
        engine,
        engine_factory=lambda fsm: build_engine(
            engine_cfg_fn() if engine_cfg_fn is not None else engine_cfg, fsm
        ),
        activity_fn=session.has_game_connections,
    )


@dataclass
class AppServices:
    """应用服务容器（路由经 ``request.app.state.services`` 访问）。"""

    config: AppConfig
    db: Database
    manager: Optional[EngineManager]      # None=引擎未装配（文件缺失，降级；可经 ensure_engine_manager 重建）
    analysis: AnalysisService
    game: GameService
    review: ReviewService
    report: ReportService
    session: SessionManager
    pusher: Optional[GameAnalysisPusher] = None
    comment_pusher: Optional[GameCommentPusher] = None
    settlement: Optional[SettlementPredictor] = None
    #: 应用更新 / KataGo 与模型下载（管理页「版本与资源」卡）
    updates: UpdateService = field(default_factory=UpdateService)
    #: 引擎装配失败归因（BUG-097）：code ∈ {standard_model_missing, engine_executable_missing}；
    #: 管理器就位后为 None
    engine_unavailable_code: Optional[str] = None
    engine_unavailable_message: Optional[str] = None
    #: 运行时重建装配互斥（管理端 [启动]/[手动重启]/[重启] 并发幂等）
    _assemble_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False, compare=False)

    def apply_config(self, cfg: AppConfig) -> None:
        """运行期配置热更新（H-1 修复）：同步刷新服务容器与全部服务持有的配置引用，
        消除 ``app.state.config`` 与各服务内部 ``_cfg`` 的“双事实源”。
        """
        self.config = cfg
        self.analysis.update_config(cfg)
        self.game.update_config(cfg)
        self.review.update_config(cfg)
        self.report.update_config(cfg)
        if self.manager is not None:
            self.manager.update_config(cfg)

    async def ensure_engine_manager(self) -> None:
        """运行时重建引擎子系统（BUG-097）：文件缺失降级后恢复的唯一入口。

        调用点：管理端 ``POST /admin/engines/start|restart``（[启动]/[手动重启]/[重启]）。
        - 幂等：已有管理器直接返回；并发经 ``_assemble_lock`` 串行（仅首者装配）；
        - 成功：构建管理器 → 绑定分析/对局服务（人类模型可用性活取）→ 状态广播接线
          → 渲染 analysis.cfg → ``manager.start()``（拉起空闲监控；常驻模式自动拉起）；
        - 失败：抛 ``ConfigError``（``code`` 标注缺失原因），管理器保持 None 并记录归因。
        """
        if self.manager is not None:
            return
        async with self._assemble_lock:
            if self.manager is not None:
                return
            try:
                manager = _make_manager(
                    self.config.engine,
                    self.session,
                    engine_cfg_fn=lambda: self.config.engine,
                )
            except ConfigError as exc:
                self.engine_unavailable_code = exc.code or "engine_unavailable"
                self.engine_unavailable_message = str(exc)
                raise
            self.manager = manager
            # 迟绑定：分析/对局服务改持新管理器（人类模型可用性经活取函数结算）
            self.analysis.set_engine(manager)
            self.game.set_engine(
                manager,
                human_model_available_fn=lambda: manager.engine.has_human_model,
            )
            _wire_engine_broadcast(manager, self.session)
            try:
                render_analysis_cfg(self.config.engine)
            except OSError as exc:
                logger.warning("引擎重建时 analysis.cfg 渲染失败（将在下次变更时重试）：%s", exc)
            self.engine_unavailable_code = None
            self.engine_unavailable_message = None
            try:
                await manager.start()
            except Exception as exc:  # noqa: BLE001 - 常驻启动失败不阻断装配（退避重启接管）
                logger.warning("引擎管理器重建后常驻启动失败：%s", exc)
            logger.info("引擎管理器已重建装配（文件就位，引擎相关功能恢复）")


def _wire_engine_broadcast(manager: EngineManager, session: SessionManager) -> None:
    """引擎状态变更 → 全局 engine.status WS 广播（API §4.4）。

    携带 ``humanModelAvailable``（当前引擎实例）：人类模型未挂载时前端呈现
    「人类模型不可用」提示并暂停 AI 自动续行（2026/09/10 人工决策 B2）。
    同时携带 ``reason``/``detail``（BUG-097，显式 null 清旧值）：启动失败时
    前端横幅/胶囊呈现真实原因（stderr 摘要），恢复正常即清除。
    """

    def _cb(state, progress) -> None:
        try:
            snapshot = manager.state_snapshot()
            asyncio.create_task(
                session.broadcast_engine_status(
                    state.value,
                    progress,
                    human_model_available=snapshot["humanModelAvailable"],
                    reason=snapshot["reason"],
                    detail=snapshot["detail"],
                ),
                name="engine-status-broadcast",
            )
        except RuntimeError:
            # 事件循环未运行（极早期回调），忽略该次广播
            pass

    manager.on_state_change(_cb)


async def build_services(cfg: AppConfig) -> AppServices:
    """装配全部服务（lifespan 调用）；引擎缺文件时降级启动（可经管理端运行期重建）。"""
    # db 路径经 project_path 锚定项目根（唯一数据目录 <根>/data，与启动 CWD 无关；
    # 文件型数据库父目录由 Database.connect 自动创建——ISSUE-045）
    db_path = cfg.db.path if cfg.db.path == ":memory:" else str(project_path(cfg.db.path))
    db = Database(db_path)
    await db.connect()
    session = SessionManager()

    manager: Optional[EngineManager] = None
    human_model_available = True
    unavailable_code: Optional[str] = None
    unavailable_message: Optional[str] = None
    try:
        manager = _make_manager(cfg.engine, session)
        human_model_available = manager.engine.has_human_model
    except ConfigError as exc:
        # 可执行文件/标准模型缺失：引擎不可用，仅禁用引擎相关功能（ARCHITECTURE §5.2）；
        # 归因按实际缺失项记录（BUG-097：不得一律归因「标准模型缺失」）
        unavailable_code = exc.code or "engine_unavailable"
        unavailable_message = str(exc)
        logger.warning("引擎装配跳过（%s，引擎相关功能降级）：%s", unavailable_code, exc)
        human_model_available = False

    if manager is not None:
        # H-5 修复：启动时即渲染 analysis.cfg（引擎级参数期望值 → 落盘），
        # 保证全新部署/引擎未运行期间修改的参数在下次启动时生效。
        try:
            render_analysis_cfg(cfg.engine)
        except OSError as exc:
            logger.warning("启动时 analysis.cfg 渲染失败（引擎级参数将在下次变更时重试）：%s", exc)

    analysis = AnalysisService(db.conn, cfg, engine=manager)
    adaptive = AdaptiveDifficulty(db.conn, cfg)
    game = GameService(
        db.conn,
        cfg,
        human_model_available=human_model_available,
        # 活取当前引擎实例的人类模型可用性（安全重启重建模型后不失真）
        human_model_available_fn=(
            (lambda: manager.engine.has_human_model) if manager is not None else None
        ),
        engine=manager,
        adaptive=adaptive,
        analysis=analysis,
    )
    review = ReviewService(db.conn, cfg, game_service=game, analysis=analysis)
    report = ReportService(db.conn, cfg)

    if manager is not None:
        _wire_engine_broadcast(manager, session)

    # 分析结果推送：曲线（节流）+ 每手点评（实时）经扇出共用分析调度器回调槽
    # （2026/09/11：对弈页点评改由每手标准分析派送，不再经 recommend.request）
    pusher = GameAnalysisPusher(analysis, session)
    comment_pusher = GameCommentPusher(review, session)
    analysis.set_on_result(AnalysisResultFanout(pusher.on_result, comment_pusher.on_result))
    # 结算预判：双 PASS / 认输 → 终局深算 → GTP final_score 等价结果 + 预判死子
    settlement = SettlementPredictor(db.conn, cfg, analysis, session)
    logger.info("服务装配完成（引擎：%s）", "可用" if manager else "不可用（降级）")
    services = AppServices(
        config=cfg,
        db=db,
        manager=manager,
        analysis=analysis,
        game=game,
        review=review,
        report=report,
        session=session,
        pusher=pusher,
        comment_pusher=comment_pusher,
        settlement=settlement,
        engine_unavailable_code=unavailable_code,
        engine_unavailable_message=unavailable_message,
    )
    if manager is not None:
        # H-5 同族：安全重启重建引擎时读取**最新**配置（apply_config 热更新后不失效）
        manager.set_engine_factory(lambda fsm: build_engine(services.config.engine, fsm))
    return services
