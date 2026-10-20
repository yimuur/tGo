"""分级日志系统：控制台 + RotatingFileHandler 轮转（PRD §4.3.6 / AGENTS.md §5）。

- 单文件大小、保留份数来自 config.yaml（logging 分组）；
- **DEBUG 仅作用于应用自身日志器**（``app.*`` / ``tgo.*`` 命名空间）——根日志器最高
  ``INFO``，第三方库（aiosqlite / websockets / asyncio / uvicorn / httpx…）不随应用
  DEBUG 逐操作刷屏（每条 SQL、每个 WS 帧一行原文，属人类不可读的无意义内容；
  2026/09/20 人工确认：开启 ``level: DEBUG`` 后须只看到应用自身调试信息）；
- 高频调试信息经 ``logger.debug`` / ``debug_log`` 输出，生产环境（非 DEBUG）不输出；
- 引擎输出日志由后端托管：``setup_engine_log_handler`` 为 `tgo.engine` 日志器挂载
  独立轮转文件（Phase 2 子进程 stdout/stderr 重定向目标）。

日志文案规范（系统日志须便于人类阅读/理解；2026/09/20 人工确认）::

    - 一律中文（KataGo / WebSocket / SGF / maxVisits / PASS 等专有名词保留原文）；
    - 中文语境使用全角标点（`：`、`（）`、`，`），`：` 后不再留半角空格；
    - 结构 `主体：事件（补充/参数）`；附加上下文用 ` · ` 分隔；
    - 对象词：`对局 #<id>`、`局面 <position_key>`（如 `main:42`）、`第 <n> 手`、
      `试下 #<id>`、`引擎`、`WS 对局通道` / `WS 管理通道`；
    - 颜色一律 `黑/白`（禁 `B/W`）；枚举值译中文并带键名（`动作=写入`、`判定=升级`）；
    - ``logger.exception`` 文案只描述“什么失败了”，异常对象经占位符附加；
    - 引擎生命周期关键句（`引擎已启动（…）` / `引擎已停止（管理端请求）` /
      `引擎空闲超时，已释放资源`）为 BUG 文档/人工验收引用口径，不得随意改名。
"""

from __future__ import annotations

import logging
import logging.handlers

from app.config import LoggingConfig, project_path
from app.core.console_guard import make_console_handler, retarget_console_handlers

#: 应用日志器命名空间（便于统一过滤与轮转）
APP_LOGGER_NAME = "tgo"
ENGINE_LOGGER_NAME = f"{APP_LOGGER_NAME}.engine"

#: 应用自身日志器命名空间：模块日志器 ``logging.getLogger(__name__)`` → `app.*`，
#: 引擎托管链路 → `tgo.*`。`level: DEBUG` 仅对这两个命名空间生效（第三方库最高 INFO）。
APP_LOGGER_NAMESPACES: tuple[str, ...] = ("app", APP_LOGGER_NAME)

#: 配置允许的日志级别（default.yaml 注释口径：DEBUG/INFO/WARNING/ERROR）
_LEVELS: dict[str, int] = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
}

_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


def _make_formatter() -> logging.Formatter:
    return logging.Formatter(_FORMAT, datefmt=_DATEFMT)


def setup_logging(cfg: LoggingConfig) -> logging.Logger:
    """初始化应用日志：控制台 + 轮转文件（`<项目根>/logs/tgo.log`），返回应用日志器。

    日志目录经 ``project_path`` 锚定项目根（唯一日志目录，与启动 CWD 无关）；
    幂等：重复调用会先清空根日志器已有 handlers，避免重复追加。

    控制台 handler 经 `console_guard.make_console_handler()` 构建为**非阻塞**——控制台
    被冻结/暂停输出时不得阻塞事件循环（机制 A / BUG-127，2026/09/21）。
    """
    log_dir = project_path(cfg.dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    # 应用级别来自配置；根日志器**最高 INFO**——第三方库 DEBUG（aiosqlite 逐 SQL/
    # websockets 逐帧/asyncio 等）不是人类可读的系统日志，不得随应用 DEBUG 刷屏
    app_level = _LEVELS[cfg.level.upper()]
    root = logging.getLogger()
    root.setLevel(max(app_level, logging.INFO))
    for namespace in APP_LOGGER_NAMESPACES:
        logging.getLogger(namespace).setLevel(app_level)
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()

    formatter = _make_formatter()
    # 接管「安装非阻塞控制台之后」才出现的控制台 handler（三方库/旧式代码自建）：
    # 冻结的控制台不得阻塞事件循环（机制 A / BUG-127）
    retarget_console_handlers()
    console = make_console_handler()
    console.setFormatter(formatter)
    root.addHandler(console)

    file_handler = logging.handlers.RotatingFileHandler(
        log_dir / "tgo.log",
        maxBytes=cfg.max_bytes,
        backupCount=cfg.backup_count,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    return get_logger()


def get_logger(name: str = "") -> logging.Logger:
    """获取应用日志器（统一挂在 `tgo` 命名空间下）。"""
    if name:
        return logging.getLogger(f"{APP_LOGGER_NAME}.{name}")
    return logging.getLogger(APP_LOGGER_NAME)


def debug_log(logger: logging.Logger, msg: str, *args: object) -> None:
    """高频调试开关：仅当目标日志器启用 DEBUG 级别时输出，否则零开销跳过。"""
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(msg, *args)


def setup_engine_log_handler(cfg: LoggingConfig) -> logging.Logger:
    """引擎日志托管入口：为 `tgo.engine` 日志器挂载独立轮转文件（`<项目根>/logs/engine.log`）。

    Phase 2 引擎管理器将子进程 stdout/stderr 行经该日志器写入，
    与系统日志统一轮转（轮转参数同样来自 config.yaml；目录经 ``project_path`` 锚定）。
    """
    log_dir = project_path(cfg.dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    engine_logger = logging.getLogger(ENGINE_LOGGER_NAME)
    # 幂等：先清空旧 handler
    for handler in list(engine_logger.handlers):
        engine_logger.removeHandler(handler)
        handler.close()

    file_handler = logging.handlers.RotatingFileHandler(
        log_dir / "engine.log",
        maxBytes=cfg.max_bytes,
        backupCount=cfg.backup_count,
        encoding="utf-8",
    )
    file_handler.setFormatter(_make_formatter())
    engine_logger.addHandler(file_handler)
    engine_logger.propagate = False  # 引擎日志独立落盘，不重复进入 tgo.log
    return engine_logger
