"""T0.4 日志系统测试：初始化、轮转、分级、调试开关、引擎日志托管。

用例 ID: LOG-*
"""

import logging

from app.config import LoggingConfig
from app.core.logging_setup import (
    ENGINE_LOGGER_NAME,
    debug_log,
    get_logger,
    setup_engine_log_handler,
    setup_logging,
)


class TestSetupLogging:
    def test_creates_log_file(self, tmp_path):
        cfg = LoggingConfig(dir=str(tmp_path / "logs"))
        logger = setup_logging(cfg)
        assert logger.name == "tgo"
        logger.info("hello tgo")
        log_file = tmp_path / "logs" / "tgo.log"
        assert log_file.exists()
        assert "hello tgo" in log_file.read_text(encoding="utf-8")

    def test_idempotent_reconfigure(self, tmp_path):
        """重复 setup 不重复追加 handlers（幂等）。"""
        cfg = LoggingConfig(dir=str(tmp_path / "logs"))
        setup_logging(cfg)
        setup_logging(cfg)
        root = logging.getLogger()
        file_handlers = [h for h in root.handlers if getattr(h, "baseFilename", "").endswith("tgo.log")]
        assert len(file_handlers) == 1

    def test_level_filtering(self, tmp_path):
        """分级输出：level=WARNING 时 INFO 不落盘、WARNING 落盘。"""
        cfg = LoggingConfig(dir=str(tmp_path / "logs"), level="WARNING")
        logger = setup_logging(cfg)
        logger.info("should-not-appear")
        logger.warning("should-appear")
        text = (tmp_path / "logs" / "tgo.log").read_text(encoding="utf-8")
        assert "should-not-appear" not in text
        assert "should-appear" in text


class TestRotation:
    def test_rotation_triggers_backup(self, tmp_path):
        """小 max_bytes 触发轮转并生成备份文件。"""
        cfg = LoggingConfig(dir=str(tmp_path / "logs"), max_bytes=1024, backup_count=2)
        logger = setup_logging(cfg)
        for i in range(60):
            logger.info("padding line %03d " % i + "x" * 160)
        log_dir = tmp_path / "logs"
        assert (log_dir / "tgo.log").exists()
        backups = sorted(p.name for p in log_dir.glob("tgo.log.*"))
        assert backups, "应生成轮转备份文件 tgo.log.N"
        assert "tgo.log.1" in backups


class TestDebugSwitch:
    def test_debug_suppressed_when_level_info(self, tmp_path):
        """调试开关：非 DEBUG 级别下 debug_log 不输出。"""
        cfg = LoggingConfig(dir=str(tmp_path / "logs"), level="INFO")
        logger = setup_logging(cfg)
        debug_log(logger, "coord move x=%d y=%d", 3, 3)
        text = (tmp_path / "logs" / "tgo.log").read_text(encoding="utf-8")
        assert "coord move" not in text

    def test_debug_emitted_when_level_debug(self, tmp_path):
        cfg = LoggingConfig(dir=str(tmp_path / "logs"), level="DEBUG")
        logger = setup_logging(cfg)
        debug_log(logger, "heartbeat seq=%d", 7)
        text = (tmp_path / "logs" / "tgo.log").read_text(encoding="utf-8")
        assert "heartbeat seq=7" in text


class TestDebugScope:
    """2026/09/20 人工确认：``level: DEBUG`` 仅作用于应用自身日志器（app.* / tgo.*）。

    背景：开启 DEBUG 后第三方库逐操作刷屏（aiosqlite 每条 SQL、websockets 每帧、
    asyncio 事件循环行）——人类不可读的无意义内容；系统日志须只保留应用自身调试信息。
    """

    def test_third_party_debug_suppressed_app_debug_kept(self, tmp_path):
        cfg = LoggingConfig(dir=str(tmp_path / "logs"), level="DEBUG")
        setup_logging(cfg)
        logging.getLogger("aiosqlite").debug("第三方逐 SQL 噪声")
        logging.getLogger("websockets.legacy.protocol").debug("第三方逐帧噪声")
        logging.getLogger("asyncio").debug("第三方事件循环噪声")
        logging.getLogger("app.services.game_service").debug("应用调试：对局 #1 · 第 2 手 黑 落子")
        text = (tmp_path / "logs" / "tgo.log").read_text(encoding="utf-8")
        assert "第三方逐 SQL 噪声" not in text
        assert "第三方逐帧噪声" not in text
        assert "第三方事件循环噪声" not in text
        assert "应用调试：对局 #1 · 第 2 手 黑 落子" in text

    def test_third_party_info_still_logged(self, tmp_path):
        """封顶只针对 DEBUG：第三方 INFO 及以上照常（运行期第三方记录不丢失）。"""
        cfg = LoggingConfig(dir=str(tmp_path / "logs"), level="DEBUG")
        setup_logging(cfg)
        logging.getLogger("external_lib.access").info("第三方 INFO 行")
        text = (tmp_path / "logs" / "tgo.log").read_text(encoding="utf-8")
        assert "第三方 INFO 行" in text

    def test_engine_namespace_follows_app_level(self, tmp_path):
        """引擎托管链路（tgo.engine）属应用自身命名空间：DEBUG 开关同样生效。"""
        cfg = LoggingConfig(dir=str(tmp_path / "logs"), level="DEBUG")
        setup_logging(cfg)
        setup_engine_log_handler(cfg)
        logging.getLogger(ENGINE_LOGGER_NAME).debug("引擎调试：忽略未匹配的引擎响应")
        engine_text = (tmp_path / "logs" / "engine.log").read_text(encoding="utf-8")
        assert "引擎调试：忽略未匹配的引擎响应" in engine_text

    def test_warning_level_keeps_third_party_cap(self, tmp_path):
        """WARNING 级：第三方 INFO 不得因命名空间改设而回漏，WARNING 照常。"""
        cfg = LoggingConfig(dir=str(tmp_path / "logs"), level="WARNING")
        setup_logging(cfg)
        logging.getLogger("external_lib.access").info("第三方 INFO 行")
        logging.getLogger("external_lib.access").warning("第三方 WARNING 行")
        text = (tmp_path / "logs" / "tgo.log").read_text(encoding="utf-8")
        assert "第三方 INFO 行" not in text
        assert "第三方 WARNING 行" in text


class TestEngineLogHandler:
    def test_engine_log_isolated_file(self, tmp_path):
        """引擎日志独立落盘至 logs/engine.log，且不进入 tgo.log。"""
        cfg = LoggingConfig(dir=str(tmp_path / "logs"))
        app_logger = setup_logging(cfg)
        engine_logger = setup_engine_log_handler(cfg)
        assert engine_logger.name == ENGINE_LOGGER_NAME

        app_logger.info("app message")
        engine_logger.info("engine stderr line")
        log_dir = tmp_path / "logs"
        engine_text = (log_dir / "engine.log").read_text(encoding="utf-8")
        app_text = (log_dir / "tgo.log").read_text(encoding="utf-8")
        assert "engine stderr line" in engine_text
        assert "engine stderr line" not in app_text

    def test_engine_handler_idempotent(self, tmp_path):
        cfg = LoggingConfig(dir=str(tmp_path / "logs"))
        setup_engine_log_handler(cfg)
        engine_logger = setup_engine_log_handler(cfg)
        assert len(engine_logger.handlers) == 1


class TestPathAnchoring:
    """2026/09/13 修订：相对日志目录经 project_path 锚定项目根（唯一日志目录 `<根>/logs`）。"""

    def test_relative_dir_anchored_via_project_path(self, tmp_path, monkeypatch):
        """相对 dir 不再相对启动 CWD——不会落到 backend/logs 等影子目录。"""
        anchored = tmp_path / "root"
        monkeypatch.setattr("app.core.logging_setup.project_path", lambda v: anchored / v)
        app_logger = setup_logging(LoggingConfig(dir="logs"))
        engine_logger = setup_engine_log_handler(LoggingConfig(dir="logs"))
        app_logger.info("应用日志锚定检查")
        engine_logger.info("引擎日志锚定检查")
        assert (anchored / "logs" / "tgo.log").exists()
        assert (anchored / "logs" / "engine.log").exists()
        assert not (tmp_path / "logs").exists(), "不得在启动 CWD 落下影子日志目录"


def test_get_logger_namespace():
    assert get_logger().name == "tgo"
    assert get_logger("game").name == "tgo.game"
