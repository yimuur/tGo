"""T0.2 配置系统测试：加载/保存/首次生成/校验。

用例 ID: CFG-*
"""

import pytest
import yaml

from app.config import (
    AppConfig,
    ConfigError,
    RANK_LEVELS,
    default_config,
    load_config,
    save_config,
)


class TestLoadFirstRun:
    """首次启动（配置文件缺失）自动生成带注释模板并返回默认值。"""

    def test_missing_file_generates_template(self, tmp_path):
        target = tmp_path / "config.yaml"
        cfg = load_config(target)
        assert target.exists(), "首次加载应自动生成 config.yaml"
        assert isinstance(cfg, AppConfig)
        # 生成的模板应保留注释（带注释的模板来自内置 DEFAULT_YAML_TEMPLATE）
        text = target.read_text(encoding="utf-8")
        assert "# tGo 应用配置" in text

    def test_generated_defaults_match(self, tmp_path):
        target = tmp_path / "config.yaml"
        cfg = load_config(target)
        assert cfg.engine.standard_max_visits == 100
        assert cfg.engine.deep_max_visits == 800
        assert cfg.play.adaptive_initial_level == "rank_5k"
        assert cfg.engine.resident is False


class TestLoadExisting:
    def test_load_valid_yaml(self, tmp_path):
        target = tmp_path / "config.yaml"
        target.write_text(
            yaml.safe_dump(
                {
                    "engine": {"standard_max_visits": 200, "deep_max_visits": 1500},
                    "play": {"adaptive_initial_level": "rank_3d"},
                }
            ),
            encoding="utf-8",
        )
        cfg = load_config(target)
        assert cfg.engine.standard_max_visits == 200
        assert cfg.engine.deep_max_visits == 1500
        assert cfg.play.adaptive_initial_level == "rank_3d"

    def test_invalid_yaml_raises_config_error(self, tmp_path):
        target = tmp_path / "config.yaml"
        target.write_text("engine: [unclosed", encoding="utf-8")
        with pytest.raises(ConfigError):
            load_config(target)


class TestCrossValidation:
    """交叉校验：deep > standard；未知字段拒绝；枚举校验。"""

    def test_deep_must_exceed_standard(self):
        with pytest.raises(Exception):
            AppConfig(engine={"standard_max_visits": 800, "deep_max_visits": 800})

    def test_unknown_field_rejected(self):
        with pytest.raises(Exception):
            AppConfig(engine={"unknown_param": 1})

    def test_invalid_rank_rejected(self):
        with pytest.raises(Exception):
            AppConfig(play={"adaptive_initial_level": "rank_99d"})

    def test_invalid_board_size_rejected(self):
        with pytest.raises(Exception):
            AppConfig(play={"default_board_size": 17})

    def test_invalid_rules_rejected(self):
        with pytest.raises(Exception):
            AppConfig(play={"default_rules": "chinese2"})

    def test_invalid_color_rejected(self):
        with pytest.raises(Exception):
            AppConfig(play={"default_human_color": "X"})

    def test_pv_len_bounds(self):
        with pytest.raises(Exception):
            AppConfig(engine={"analysis_pv_len": 3})
        cfg = AppConfig(engine={"analysis_pv_len": 15})
        assert cfg.engine.analysis_pv_len == 15


class TestSaveRoundtrip:
    def test_save_then_load_roundtrip(self, tmp_path):
        target = tmp_path / "config.yaml"
        cfg = default_config()
        cfg.engine.standard_max_visits = 333
        cfg.play.max_undo = 9
        save_config(cfg, target)
        loaded = load_config(target)
        assert loaded.engine.standard_max_visits == 333
        assert loaded.play.max_undo == 9

    def test_save_creates_parent_dirs(self, tmp_path):
        target = tmp_path / "nested" / "deep" / "config.yaml"
        save_config(default_config(), target)
        assert target.exists()
        assert load_config(target).engine.resident is False


class TestEnvOverride:
    def test_env_var_resolves_path(self, tmp_path, monkeypatch):
        target = tmp_path / "cfg.yaml"
        monkeypatch.setenv("TGO_CONFIG", str(target))
        cfg = load_config()
        assert target.exists()
        assert isinstance(cfg, AppConfig)

    def test_env_unset_uses_layered_default(self, tmp_path, monkeypatch):
        """无 path/TGO_CONFIG → default.yaml 兜底 + 根 config.yaml 用户覆盖（T6.10 决策）。"""
        monkeypatch.delenv("TGO_CONFIG", raising=False)
        user_file = tmp_path / "user" / "config.yaml"
        default_file = tmp_path / "default.yaml"

        def _user():
            return user_file

        def _default():
            return default_file

        monkeypatch.setattr("app.config.user_config_path", _user)
        monkeypatch.setattr("app.config.default_config_path", _default)

        # ① 无用户文件：default.yaml 首次自动生成（模板）并作为兜底默认
        cfg = load_config()
        assert default_file.exists(), "default.yaml 缺失时首次加载应自动生成"
        assert not user_file.exists(), "无参数覆盖时不自动生成用户 config.yaml"
        assert cfg.engine.standard_max_visits == 100
        assert cfg.engine.idle_timeout_s == 1800

        # ② 用户文件部分覆盖 → 深合并（未覆盖参数从 default 兜底）
        user_file.parent.mkdir(parents=True, exist_ok=True)
        user_file.write_text(
            yaml.safe_dump({"engine": {"deep_max_visits": 1500, "num_analysis_threads": 6}}),
            encoding="utf-8",
        )
        cfg2 = load_config()
        assert cfg2.engine.deep_max_visits == 1500  # 用户覆盖
        assert cfg2.engine.num_analysis_threads == 6
        assert cfg2.engine.standard_max_visits == 100  # 未覆盖 → default 兜底
        assert cfg2.play.adaptive_initial_level == "rank_5k"

    def test_save_config_default_writes_user_file(self, tmp_path, monkeypatch):
        """save_config() 缺省写用户 config.yaml（可读写、唯一落盘）。"""
        monkeypatch.delenv("TGO_CONFIG", raising=False)
        user_file = tmp_path / "cfg" / "config.yaml"
        monkeypatch.setattr("app.config.user_config_path", lambda: user_file)
        monkeypatch.setattr("app.config.default_config_path", lambda: tmp_path / "default.yaml")

        cfg = default_config()
        cfg.engine.idle_timeout_s = 5400
        save_config(cfg)
        assert user_file.exists()
        assert load_config().engine.idle_timeout_s == 5400


def test_rank_levels_count():
    """12 档段位定义完整且无重复。"""
    assert len(RANK_LEVELS) == 12
    assert len(set(RANK_LEVELS)) == 12


class TestEngineDirUnified:
    """引擎目录统一：executable_dir 顶层识别 + 默认值对齐引擎初始 cfg 模板。"""

    def test_engine_defaults_unified(self):
        """executable → executable_dir；num_search_threads 默认与 analysis.cfg 模板对齐（16）。"""
        cfg = default_config()
        assert cfg.engine.executable_dir == "engine/katago"
        assert cfg.engine.num_search_threads_per_analysis_thread == 16
        assert cfg.engine.num_analysis_threads == 2
        assert not hasattr(cfg.engine, "executable")

    def test_embedded_template_matches_code_defaults(self):
        """内置默认模板（default.yaml 自动生成源）解析后与代码默认完全一致。"""
        from app.config import DEFAULT_YAML_TEMPLATE

        raw = yaml.safe_load(DEFAULT_YAML_TEMPLATE)
        assert AppConfig.model_validate(raw).model_dump(mode="python") == default_config().model_dump(
            mode="python"
        )

    def test_legacy_executable_key_stripped(self, tmp_path):
        """向后兼容：旧 executable 键加载时静默剔除（回退 executable_dir 默认）。"""
        target = tmp_path / "config.yaml"
        target.write_text(
            yaml.safe_dump(
                {
                    "engine": {
                        "executable": "engine/katago/katago.exe",
                        "num_analysis_threads": 6,
                    }
                }
            ),
            encoding="utf-8",
        )
        cfg = load_config(target)
        assert cfg.engine.executable_dir == "engine/katago"
        assert cfg.engine.num_analysis_threads == 6


class TestServerSection:
    """server 监听参数（T7.2/T7.3）：默认 0.0.0.0:8090，.yaml 可覆盖，越界拒绝。"""

    def test_server_defaults(self):
        cfg = default_config()
        assert cfg.server.host == "0.0.0.0"
        assert cfg.server.port == 8090

    def test_server_override_from_user_file(self, tmp_path):
        target = tmp_path / "config.yaml"
        target.write_text(
            yaml.safe_dump({"server": {"host": "192.168.1.9", "port": 8095}}),
            encoding="utf-8",
        )
        cfg = load_config(target)
        assert cfg.server.host == "192.168.1.9"
        assert cfg.server.port == 8095

    def test_server_port_bounds_rejected(self):
        with pytest.raises(Exception):
            AppConfig(server={"port": 0})
        with pytest.raises(Exception):
            AppConfig(server={"port": 65536})

    def test_server_unknown_field_rejected(self):
        with pytest.raises(Exception):
            AppConfig(server={"listen": "0.0.0.0"})

    def test_server_delta_save(self, tmp_path, monkeypatch):
        """分层模式：仅端口改动 → 根 config.yaml 仅落 server.port 增量。"""
        monkeypatch.delenv("TGO_CONFIG", raising=False)
        user_file = tmp_path / "user" / "config.yaml"
        monkeypatch.setattr("app.config.user_config_path", lambda: user_file)
        monkeypatch.setattr("app.config.default_config_path", lambda: tmp_path / "default.yaml")

        cfg = default_config()
        cfg.server.port = 8092
        save_config(cfg)
        raw = yaml.safe_load(user_file.read_text(encoding="utf-8"))
        assert raw == {"server": {"port": 8092}}


class TestDeltaSave:
    """save_config：分层默认 → 根 config.yaml 仅保存增量；单文件 → 完整落盘。"""

    def test_layered_save_writes_only_deltas(self, tmp_path, monkeypatch):
        monkeypatch.delenv("TGO_CONFIG", raising=False)
        user_file = tmp_path / "user" / "config.yaml"
        default_file = tmp_path / "default.yaml"
        monkeypatch.setattr("app.config.user_config_path", lambda: user_file)
        monkeypatch.setattr("app.config.default_config_path", lambda: default_file)

        cfg = default_config()
        cfg.engine.num_analysis_threads = 4
        cfg.play.max_undo = 7
        save_config(cfg)
        raw = yaml.safe_load(user_file.read_text(encoding="utf-8"))
        assert raw == {
            "engine": {"num_analysis_threads": 4},
            "play": {"max_undo": 7},
        }, "根 config.yaml 应仅保存与默认不同的增量参数"

    def test_layered_save_when_no_change_writes_empty(self, tmp_path, monkeypatch):
        """无差异时增量落盘为空映射（不写回任何默认值）。"""
        monkeypatch.delenv("TGO_CONFIG", raising=False)
        user_file = tmp_path / "user" / "config.yaml"
        monkeypatch.setattr("app.config.user_config_path", lambda: user_file)
        monkeypatch.setattr("app.config.default_config_path", lambda: tmp_path / "default.yaml")
        save_config(default_config())
        raw = yaml.safe_load(user_file.read_text(encoding="utf-8"))
        assert raw in (None, {})

    def test_single_file_save_writes_full_config(self, tmp_path):
        """显式 path（单文件语义）仍写完整配置（该文件即唯一事实源）。"""
        cfg = default_config()
        cfg.engine.num_analysis_threads = 4
        target = tmp_path / "full.yaml"
        save_config(cfg, target)
        raw = yaml.safe_load(target.read_text(encoding="utf-8"))
        assert raw["engine"]["num_analysis_threads"] == 4
        assert raw["engine"]["resident"] is False  # 完整落盘（含默认键）


class TestProjectPath:
    """相对路径锚定（2026/09/13：唯一日志目录 `<根>/logs`、数据目录 `<根>/data`）。"""

    def test_relative_anchored_to_project_root(self):
        from app.config import project_path, project_root

        assert project_path("logs") == project_root() / "logs"
        assert project_path("data/tgo.db") == project_root() / "data" / "tgo.db"

    def test_absolute_path_unchanged(self, tmp_path):
        from app.config import project_path

        absolute = tmp_path / "logs"
        assert project_path(str(absolute)) == absolute

    def test_engine_path_delegates(self):
        from app.config import engine_path, project_path

        assert engine_path("engine/katago") == project_path("engine/katago")
