"""T4.4 REST 管理路由集成测试（TASK T4.4 / API §3.3）。

用例 ID: API-ADMIN-*
- config 读取/更新（分层落地、交叉校验拒绝、引擎级变更触发安全重启）；
- engines 状态（含 INIT/benchmark 进度、人类模型可用性）；
- start/stop（202 Accepted 异步任务语义）；
- models 列表 / default 切换（202 + restart_warning）；
- system 采集（psutil；nvidia-smi 缺失 → 不支持）。
"""

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.config import AppConfig, ConfigError


def _engine_dirs_config(tmp_path, *, exe: bool, model: bool) -> AppConfig:
    """构造指向临时目录的引擎配置（按需控制可执行文件/标准模型存在性；BUG-097 测试用）。

    ``analysis_cfg`` 一并指向 tmp，避免重建装配时写回仓库配置文件；``logging.dir`` 同样
    钉到 tmp——lifespan 会按 ``app.state.config`` 装配根文件 handler（否则测试记录写进产品
    ``logs/tgo.log``，BUG-128）。
    """
    exe_dir = tmp_path / "katago"
    exe_dir.mkdir(exist_ok=True)
    if exe:
        # 两平台名都放（识别与平台无关；AGENTS.md §7：仅路径探测，不执行）
        (exe_dir / "katago.exe").write_bytes(b"x")
        (exe_dir / "katago").write_bytes(b"x")
    model_dir = tmp_path / "models"
    model_dir.mkdir(exist_ok=True)
    if model:
        (model_dir / "kata1.bin.gz").write_bytes(b"x")
    return AppConfig(
        engine={
            "executable_dir": str(exe_dir),
            "model_dir": str(model_dir),
            "analysis_cfg": str(tmp_path / "analysis.cfg"),
        },
        logging={"dir": str(tmp_path / "logs")},
    )


class TestConfig:
    async def test_get_config(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/config")
        assert resp.status_code == 200
        body = resp.json()
        assert body["engine"]["standard_max_visits"] > 0
        assert body["engine"]["deep_max_visits"] > body["engine"]["standard_max_visits"]
        assert body["play"]["max_undo"] >= 0
        assert body["logging"]["level"] == "INFO"

    async def test_put_config_partial(self, api_app):
        with TestClient(api_app) as client:
            resp = client.put(
                "/api/admin/config",
                json={"standard_max_visits": 120, "resident": True},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["engine"]["standard_max_visits"] == 120
        assert body["engine"]["resident"] is True
        # 未更新字段保持原值
        assert body["engine"]["deep_max_visits"] == AppConfig().engine.deep_max_visits

    async def test_put_config_empty(self, api_app):
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={})
        assert resp.status_code == 200

    async def test_put_config_broadcasts_admin_config(self, api_app, api_svc, monkeypatch):
        """配置写成功后广播 admin.config（API §4.4：多管理端/后端侧参数同步）。"""
        envelopes = []

        async def _bcast(envelope):
            envelopes.append(envelope)

        monkeypatch.setattr(api_svc.session, "broadcast_to_admin", _bcast)
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={"max_undo": 7})
        assert resp.status_code == 200
        assert envelopes == [{"type": "admin.config", "data": {"source": "config"}}]

    async def test_put_config_cross_validation_rejected(self, api_app):
        """deep_max_visits 必须 > standard_max_visits（API §1 交叉校验）。"""
        with TestClient(api_app) as client:
            resp = client.put(
                "/api/admin/config",
                json={"standard_max_visits": 900, "deep_max_visits": 100},
            )
        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_PAYLOAD"
        # 校验失败不落地
        assert api_app.state.config.engine.standard_max_visits != 900

    async def test_put_config_invalid_value(self, api_app):
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={"max_undo": -1})
        assert resp.status_code == 422

    async def test_put_config_unknown_field_rejected(self, api_app):
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={"hack": 1})
        assert resp.status_code == 422

    async def test_put_config_engine_level_triggers_restart(self, api_app, api_svc):
        """引擎 cfg 级参数变更 → 引擎运行中触发安全重启（202 语义 + restart_warning）。"""
        api_svc.manager.engine.is_running = True
        with TestClient(api_app) as client:
            resp = client.put(
                "/api/admin/config",
                json={"num_analysis_threads": 4},
            )
        assert resp.status_code == 200
        assert resp.json()["restart_warning"] is not None
        assert resp.json()["task_queued"] is True  # 已入队安全重启（admin.task restart）
        assert api_svc.manager.restart_futures  # 已入队重启

    async def test_put_config_engine_level_no_restart_when_idle(self, api_app, api_svc):
        """引擎未运行 → 仅更新配置，不触发重启（下次启动生效），且无异步任务可回执。"""
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={"num_analysis_threads": 3})
        assert resp.status_code == 200
        assert resp.json()["task_queued"] is False  # 2026/09/24：无 admin.task 可等（BUG-138）
        assert resp.json()["restart_warning"] == "引擎参数/模型已变更，将在引擎下次启动时生效"
        assert api_svc.manager.restart_futures == []
        assert api_app.state.config.engine.num_analysis_threads == 3

    async def test_put_config_engine_level_stale_process_no_restart(self, api_app, api_svc):
        """引擎级参数 + FATAL/陈旧引用 → 不排队重启（同「引擎未运行」口径）。"""
        api_svc.manager.state = "FATAL"
        api_svc.manager.engine.is_running = True
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={"num_analysis_threads": 5})
        assert resp.status_code == 200
        assert resp.json()["task_queued"] is False
        assert resp.json()["restart_warning"] == "引擎参数/模型已变更，将在引擎下次启动时生效"
        assert api_svc.manager.restart_futures == []
        assert api_app.state.config.engine.num_analysis_threads == 5

    async def test_put_config_applies_to_services(self, api_app, api_svc):
        """H-1：配置热更新必须传播到服务层（消除 app.state.config 与服务内部 _cfg 双事实源）。"""
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={"max_undo": 7})
        assert resp.status_code == 200
        assert api_app.state.config.play.max_undo == 7
        assert api_svc.config.play.max_undo == 7
        assert api_svc.game._cfg.play.max_undo == 7
        assert api_svc.analysis._cfg.play.max_undo == 7
        assert api_svc.review._cfg.play.max_undo == 7
        assert api_svc.report._cfg.play.max_undo == 7
        # 引擎级参数 → 引擎管理器配置引用
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={"num_analysis_threads": 3})
        assert resp.status_code == 200
        assert api_svc.manager.cfg.engine.num_analysis_threads == 3

    async def test_put_config_engine_level_renders_cfg_when_idle(self, api_app, api_svc, monkeypatch):
        """H-5：引擎未运行时修改引擎级参数也必须渲染 analysis.cfg（下次启动生效）。"""
        import app.api.routes_admin as routes_admin

        rendered = {}

        def _fake_render(engine_cfg, log_dir="logs"):
            rendered["path"] = engine_cfg.analysis_cfg
            return None

        monkeypatch.setattr(routes_admin, "render_analysis_cfg", _fake_render)
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/config", json={"num_analysis_threads": 5})
        assert resp.status_code == 200
        assert rendered.get("path") is not None
        assert api_svc.manager.restart_futures == []  # 未运行不重启

    async def test_set_default_model_rejects_path_escape(self, api_app):
        """L-3：模型名含 `..` 路径组件拒绝。"""
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/models/default", json={"model": "../secret.bin.gz"})
        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_PAYLOAD"


class TestEngines:
    async def test_engines_status(self, api_app, api_svc):
        api_svc.manager.state = "ANALYZING"
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/engines")
        assert resp.status_code == 200
        assert resp.json()["state"] == "ANALYZING"
        assert resp.json()["humanModelAvailable"] is True
        # 引擎管理器在 → 无「不可用原因」（崩溃 FATAL 与标准模型缺失须可区分）
        assert resp.json()["reason"] is None

    async def test_engines_status_no_manager_files_ok(self, api_app, api_svc, tmp_path):
        """无管理器但文件就位 → STOPPED（未启动）+ reason=null（BUG-097：可经 [启动] 重建装配）。"""
        api_svc.manager = None
        cfg = _engine_dirs_config(tmp_path, exe=True, model=True)
        api_app.state.config = cfg
        api_svc.config = cfg
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/engines")
        assert resp.status_code == 200
        body = resp.json()
        assert body["state"] == "STOPPED"
        assert body["reason"] is None
        assert body["detail"] is None
        assert body["humanModelAvailable"] is False

    async def test_engines_status_no_manager_executable_missing(self, api_app, api_svc, tmp_path):
        """无管理器且可执行文件缺失 → FATAL + reason=engine_executable_missing（不得归因模型缺失）。"""
        api_svc.manager = None
        cfg = _engine_dirs_config(tmp_path, exe=False, model=True)
        api_app.state.config = cfg
        api_svc.config = cfg
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/engines")
        assert resp.status_code == 200
        body = resp.json()
        assert body["state"] == "FATAL"
        assert body["reason"] == "engine_executable_missing"
        assert "可执行文件缺失" in body["detail"]

    async def test_engines_status_no_manager_model_missing(self, api_app, api_svc, tmp_path):
        """无管理器且标准模型缺失 → FATAL + reason=standard_model_missing + detail。"""
        api_svc.manager = None
        cfg = _engine_dirs_config(tmp_path, exe=True, model=False)
        api_app.state.config = cfg
        api_svc.config = cfg
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/engines")
        assert resp.status_code == 200
        body = resp.json()
        assert body["state"] == "FATAL"
        assert body["reason"] == "standard_model_missing"
        assert "标准模型缺失" in body["detail"]

    async def test_engines_start_202(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/start")
        assert resp.status_code == 202
        assert resp.json()["status"] == "accepted"
        assert resp.json()["task"] == "start"
        assert resp.json()["task_queued"] is True  # 已排入异步任务（admin.task 回执）

    async def test_engines_start_no_manager_reassembly_fails(self, api_app, api_svc, tmp_path):
        """[启动]：文件仍缺失 → 重建装配失败 503，如实报缺失项（BUG-097）。"""
        api_svc.manager = None
        cfg = _engine_dirs_config(tmp_path, exe=False, model=True)
        api_app.state.config = cfg
        api_svc.config = cfg
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/start")
        assert resp.status_code == 503
        assert resp.json()["code"] == "ENGINE_FATAL"
        assert "可执行文件缺失" in resp.json()["message"]

    async def test_engines_stop_202(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/stop")
        assert resp.status_code == 202
        assert resp.json()["task"] == "stop"

    async def test_engines_stop_no_manager(self, api_app, api_svc):
        api_svc.manager = None
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/stop")
        assert resp.status_code == 202
        assert resp.json()["message"] == "引擎不可用，无需停止"
        assert resp.json()["task_queued"] is False  # 无异步任务 → 不会收到 admin.task

    async def test_engines_restart_202(self, api_app, api_svc):
        """[重启]：引擎运行中 → 202 Accepted + 安全重启入队（admin.task restart 回执）。"""
        api_svc.manager.engine.is_running = True
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/restart")
        assert resp.status_code == 202
        body = resp.json()
        assert body["status"] == "accepted"
        assert body["task"] == "restart"
        assert api_svc.manager.restart_futures  # 已入队安全重启

    async def test_engines_restart_not_running(self, api_app, api_svc):
        """[重启]：引擎未运行 → 202（提示无需重启），不排队（防 pending 永不 drain）。"""
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/restart")
        assert resp.status_code == 202
        assert resp.json()["task"] == "restart"
        assert resp.json()["message"] == "引擎未运行，无需重启"
        assert resp.json()["task_queued"] is False  # 无异步任务（否则前端假受理 60s）
        assert api_svc.manager.restart_futures == []

    async def test_engines_restart_stale_process(self, api_app, api_svc):
        """[重启]：FATAL + 陈旧进程引用 → 同样判「未运行」（不排队；与 ISSUE-069 判据一致）。"""
        api_svc.manager.state = "FATAL"
        api_svc.manager.engine.is_running = True
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/restart")
        assert resp.status_code == 202
        assert resp.json()["message"] == "引擎未运行，无需重启"
        assert resp.json()["task_queued"] is False
        assert api_svc.manager.restart_futures == []

    async def test_engines_restart_no_manager_reassembly_fails(self, api_app, api_svc, tmp_path):
        """[重启]：无管理器且文件仍缺失 → 重建装配失败 503（原因如实，BUG-097）。"""
        api_svc.manager = None
        cfg = _engine_dirs_config(tmp_path, exe=False, model=True)
        api_app.state.config = cfg
        api_svc.config = cfg
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/restart")
        assert resp.status_code == 503
        assert resp.json()["code"] == "ENGINE_FATAL"

    async def test_engines_start_reassembles_manager(self, api_app, api_svc, tmp_path, monkeypatch):
        """[启动]：无管理器但文件就位 → 运行时重建装配后照常受理（BUG-097）。

        以替身接管 ``ensure_engine_manager``（避免真实引擎进程；AGENTS.md §7），
        验证路由在无管理器时先尝试重建、再接续 ensure_ready 流程。
        """
        from tests.fakes import FakeManager

        api_svc.manager = None
        cfg = _engine_dirs_config(tmp_path, exe=True, model=True)
        api_app.state.config = cfg
        api_svc.config = cfg
        rebuilt = FakeManager()
        calls = {"ensure": 0}

        async def fake_ensure_manager() -> None:
            calls["ensure"] += 1
            api_svc.manager = rebuilt
            api_svc.analysis.set_engine(rebuilt)
            api_svc.game.set_engine(
                rebuilt, human_model_available_fn=lambda: rebuilt.engine.has_human_model
            )

        monkeypatch.setattr(api_svc, "ensure_engine_manager", fake_ensure_manager)
        with TestClient(api_app) as client:
            resp = client.post("/api/admin/engines/start")
        assert resp.status_code == 202
        assert calls["ensure"] == 1
        assert api_svc.manager is rebuilt


class TestModels:
    async def test_list_models(self, api_app, api_svc, tmp_path):
        """模型目录扫描（human 标记 + default）。"""
        from app.config import AppConfig

        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "kata1-b18.bin.gz").write_bytes(b"x")
        (model_dir / "kata2-b28c.bin.gz").write_bytes(b"x")
        (model_dir / "b18-human.bin.gz").write_bytes(b"x")

        api_app.state.config = AppConfig(
            engine={"model_dir": str(model_dir), "standard_model": ""},
            logging={"dir": str(tmp_path / "logs")},
        )
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/models")
        assert resp.status_code == 200
        body = resp.json()
        names = [m["name"] for m in body["models"]]
        assert "kata1-b18.bin.gz" in names
        assert "b18-human.bin.gz" in names
        # default = 首个非人类模型
        assert body["default"] == "kata1-b18.bin.gz"
        human = [m for m in body["models"] if m["name"] == "b18-human.bin.gz"][0]
        assert human["human"] is True

    async def test_set_default_model(self, api_app, api_svc, tmp_path):
        from app.config import AppConfig

        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "kata1.bin.gz").write_bytes(b"x")
        (model_dir / "kata2.bin.gz").write_bytes(b"x")
        api_app.state.config = AppConfig(
            engine={"model_dir": str(model_dir)}, logging={"dir": str(tmp_path / "logs")}
        )
        api_svc.manager.engine.is_running = True

        with TestClient(api_app) as client:
            resp = client.put("/api/admin/models/default", json={"model": "kata2.bin.gz"})
        assert resp.status_code == 202
        body = resp.json()
        assert body["task"] == "set_model"
        assert body["restart_warning"] is not None
        assert api_app.state.config.engine.standard_model == "kata2.bin.gz"
        assert api_svc.manager.restart_futures  # 已入队安全重启

    async def test_set_default_model_broadcasts_admin_config(self, api_app, api_svc, tmp_path, monkeypatch):
        """默认模型写成功后广播 admin.config（source=model，多管理端模型下拉同步）。"""
        from app.config import AppConfig

        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "kata1.bin.gz").write_bytes(b"x")
        (model_dir / "kata2.bin.gz").write_bytes(b"x")
        api_app.state.config = AppConfig(
            engine={"model_dir": str(model_dir)}, logging={"dir": str(tmp_path / "logs")}
        )
        api_svc.manager.engine.is_running = True

        envelopes = []

        async def _bcast(envelope):
            envelopes.append(envelope)

        monkeypatch.setattr(api_svc.session, "broadcast_to_admin", _bcast)
        with TestClient(api_app) as client:
            resp = client.put("/api/admin/models/default", json={"model": "kata2.bin.gz"})
        assert resp.status_code == 202
        assert {"type": "admin.config", "data": {"source": "model"}} in envelopes

    async def test_set_default_model_missing(self, api_app, api_svc, tmp_path):
        from app.config import AppConfig

        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "kata1.bin.gz").write_bytes(b"x")
        api_app.state.config = AppConfig(
            engine={"model_dir": str(model_dir)}, logging={"dir": str(tmp_path / "logs")}
        )

        with TestClient(api_app) as client:
            resp = client.put("/api/admin/models/default", json={"model": "nope.bin.gz"})
        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_PAYLOAD"

    async def test_set_default_model_no_change(self, api_app, api_svc, tmp_path):
        from app.config import AppConfig

        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "kata1.bin.gz").write_bytes(b"x")
        api_app.state.config = AppConfig(
            engine={"model_dir": str(model_dir), "standard_model": "kata1.bin.gz"},
            logging={"dir": str(tmp_path / "logs")},
        )

        with TestClient(api_app) as client:
            resp = client.put("/api/admin/models/default", json={"model": "kata1.bin.gz"})
        assert resp.status_code == 202
        assert resp.json()["restart_warning"] is None
        assert api_svc.manager.restart_futures == []

    async def test_set_default_model_not_running_no_queue(self, api_app, api_svc, tmp_path):
        """引擎未运行 → 仅提示「引擎参数/模型已变更，将在引擎下次启动时生效」，不排队（BUG-138）。

        旧实现返回「默认模型已更新（引擎未运行，下次启动生效）」且**不告知前端无异步任务**：
        管理页据此进入「已排队/已受理」假状态 60s（[启动] 等按钮被连带禁用），随后弹出
        「已受理；连接恢复后将收到执行结果」（实为无任何回执可等）。
        """
        from app.config import AppConfig

        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "kata1.bin.gz").write_bytes(b"x")
        (model_dir / "kata2.bin.gz").write_bytes(b"x")
        api_app.state.config = AppConfig(
            engine={"model_dir": str(model_dir)},
            logging={"dir": str(tmp_path / "logs")},
        )
        api_svc.manager.engine.is_running = False

        with TestClient(api_app) as client:
            resp = client.put("/api/admin/models/default", json={"model": "kata2.bin.gz"})
        assert resp.status_code == 202
        body = resp.json()
        assert body["task"] == "set_model"
        assert body["message"] == "引擎参数/模型已变更，将在引擎下次启动时生效"
        assert body["restart_warning"] is None
        assert body["task_queued"] is False  # 无 admin.task 回执可等
        assert api_svc.manager.restart_futures == []
        assert api_app.state.config.engine.standard_model == "kata2.bin.gz"

    async def test_set_default_model_running_queues_task(self, api_app, api_svc, tmp_path):
        """引擎运行中 → 排队安全重启并如实标记 task_queued=True（前端据此进入受理态）。"""
        from app.config import AppConfig

        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "kata1.bin.gz").write_bytes(b"x")
        (model_dir / "kata2.bin.gz").write_bytes(b"x")
        api_app.state.config = AppConfig(
            engine={"model_dir": str(model_dir)},
            logging={"dir": str(tmp_path / "logs")},
        )
        api_svc.manager.state = "IDLE"
        api_svc.manager.engine.is_running = True

        with TestClient(api_app) as client:
            resp = client.put("/api/admin/models/default", json={"model": "kata2.bin.gz"})
        assert resp.status_code == 202
        assert resp.json()["task_queued"] is True
        assert api_svc.manager.restart_futures

    async def test_set_default_model_stale_process_no_restart(self, api_app, api_svc, tmp_path):
        """FATAL + 陈旧进程引用（`is_running` 残留真）→ **不得**当「引擎在运行」排队重启。

        2026/09/24 人工反馈：「[保存默认模型？] 对话框显示 [保存]，实际行为是 [保存并重启]」。
        根因：路由以**原始** `engine.is_running` 判定，而 FATAL/崩溃后进程引用可能残留为真
        （`ensure_ready` 的 fatal 分支已备注此事实）→ 后端排队重启，而按 FSM 状态派生的
        前端文案为「未运行＝下次启动生效」。修复＝与 ISSUE-069 单一判据
        `engine_healthy_running`（进程 **且** 状态 ∈ 运行态）对齐。
        """
        from app.config import AppConfig

        model_dir = tmp_path / "models"
        model_dir.mkdir()
        (model_dir / "kata1.bin.gz").write_bytes(b"x")
        (model_dir / "kata2.bin.gz").write_bytes(b"x")
        api_app.state.config = AppConfig(
            engine={"model_dir": str(model_dir)},
            logging={"dir": str(tmp_path / "logs")},
        )
        api_svc.manager.state = "FATAL"
        api_svc.manager.engine.is_running = True  # 陈旧引用（崩溃后未释放）

        with TestClient(api_app) as client:
            resp = client.put("/api/admin/models/default", json={"model": "kata2.bin.gz"})
        assert resp.status_code == 202
        body = resp.json()
        assert body["message"] == "引擎参数/模型已变更，将在引擎下次启动时生效"
        assert body["task_queued"] is False
        assert body["restart_warning"] is None
        assert api_svc.manager.restart_futures == []


class TestSystem:
    async def test_system_status(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/system")
        assert resp.status_code == 200
        body = resp.json()
        assert body["host"]
        assert body["os"]
        assert body["cpu_count"] >= 1
        assert body["memory_usage"]["total"] > 0
        # 后端经 stderr 检测（BUG-097）：替身未检测 → null（前端显示「—」）
        assert body["backend"] is None
        # GPU 字段可缺省（非 NVIDIA → None，前端显示"不支持"）
        assert "gpu" in body

    async def test_system_status_backend_detected(self, api_app, api_svc):
        """后端标签经 stderr 检测后如实下发（含设备名，BUG-097）。"""
        api_svc.manager.backend_label = "OpenCL · NVIDIA GeForce GTX 1660"
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/system")
        assert resp.status_code == 200
        assert resp.json()["backend"] == "OpenCL · NVIDIA GeForce GTX 1660"


class TestRuntimeAssembly:
    """ensure_engine_manager：文件就位后运行时重建装配（BUG-097，人工决策 A）。"""

    async def test_reassembles_and_binds_services(self, api_svc, tmp_path, monkeypatch):
        """成功：管理器绑定到分析/对局服务、归因清空（以替身引擎验证，不启动真实进程）。"""
        from app import bootstrap as bootstrap_mod

        class FakeBuiltEngine:
            """build_engine 替身（EngineManager 所需最小接口；AGENTS.md §7 硬件隔离）。"""

            def __init__(self, fsm):
                self.fsm = fsm
                self.is_running = False
                self.benchmarking = False
                self.has_human_model = True
                self.start_calls = 0

            def set_callbacks(self, *, on_stderr_line=None, on_crash=None, on_query_state_change=None):
                pass

            async def start(self):
                self.start_calls += 1
                self.is_running = True
                self.fsm.mark_started()
                self.fsm.mark_ready()

            async def stop(self):
                self.is_running = False

            async def query(self, data, timeout_s=None):
                return {"id": data.get("id")}

        api_svc.manager = None
        api_svc.config = _engine_dirs_config(tmp_path, exe=True, model=True)
        monkeypatch.setattr(
            bootstrap_mod, "build_engine", lambda engine_cfg, fsm: FakeBuiltEngine(fsm)
        )
        await api_svc.ensure_engine_manager()
        assert api_svc.manager is not None
        assert api_svc.analysis.engine_available is True
        assert api_svc.game._engine is api_svc.manager
        assert api_svc.engine_unavailable_code is None
        assert api_svc.engine_unavailable_message is None
        await api_svc.manager.stop()

    async def test_failure_records_real_reason(self, api_svc, tmp_path):
        """失败：管理器保持 None、原因码/文案如实记录（供状态查询/前端归因）。"""
        api_svc.manager = None
        api_svc.config = _engine_dirs_config(tmp_path, exe=False, model=True)
        with pytest.raises(ConfigError):
            await api_svc.ensure_engine_manager()
        assert api_svc.manager is None
        assert api_svc.engine_unavailable_code == "engine_executable_missing"
        assert "可执行文件缺失" in api_svc.engine_unavailable_message

    async def test_idempotent_when_manager_present(self, api_svc):
        """管理器已在 → 空操作（幂等；不重复装配/不替换实例）。"""
        original = api_svc.manager
        await api_svc.ensure_engine_manager()
        assert api_svc.manager is original


def _post_request(app, path: str):
    """构造面向 ``app`` 的最小 Request（直调路由处理器，避免 portal 内后台任务的时序竞态）。"""
    from starlette.requests import Request

    return Request(
        {"type": "http", "app": app, "method": "POST", "path": path, "headers": []}
    )


class TestAdminTaskReceipt:
    """管理任务完成回执（BUG-119）：[启动] 必须区分「已就绪」与「启动完成」。

    旧实现一律回报「引擎启动完成」：引擎处于陈旧进程引用（`is_running` 为真而进程实际
    已退出）时 `ensure_ready` 静默空操作，管理页出现**假成功 toast**、引擎从未拉起。
    现由 `ensure_ready` 的返回值（本次是否真正拉起）决定回执文案。
    """

    async def test_receipt_reports_already_ready_when_no_launch(
        self, api_app, api_svc, monkeypatch
    ):
        """API-ADMIN-36 未真正拉起（ALREADY_RUNNING）→ 回执「引擎已就绪，无需重复启动」。"""
        from app.api.routes_admin import engines_start
        from app.engine.manager import LaunchOutcome

        envelopes: list[dict] = []

        async def _bcast(envelope):
            envelopes.append(envelope)

        monkeypatch.setattr(api_svc.session, "broadcast_to_admin", _bcast)

        async def _already_ready(**kwargs) -> LaunchOutcome:
            return LaunchOutcome.ALREADY_RUNNING

        monkeypatch.setattr(api_svc.manager, "ensure_ready", _already_ready)
        resp = await engines_start(_post_request(api_app, "/api/admin/engines/start"))
        assert resp.status == "accepted"
        for _ in range(4):  # 让出事件循环，收敛路由创建的后台任务（无真实等待）
            await asyncio.sleep(0)
        assert envelopes == [
            {
                "type": "admin.task",
                "data": {
                    "task": "start",
                    "status": "done",
                    "message": "引擎已就绪，无需重复启动",
                },
            }
        ]

    async def test_receipt_reports_starting_when_launch_in_flight(
        self, api_app, api_svc, monkeypatch
    ):
        """API-ADMIN-38 拉起/加载中（STARTING）→ 回执「引擎正在启动中…」（不得误报已就绪）。"""
        from app.api.routes_admin import engines_start
        from app.engine.manager import LaunchOutcome

        envelopes: list[dict] = []

        async def _bcast(envelope):
            envelopes.append(envelope)

        monkeypatch.setattr(api_svc.session, "broadcast_to_admin", _bcast)

        async def _starting(**kwargs) -> LaunchOutcome:
            return LaunchOutcome.STARTING

        monkeypatch.setattr(api_svc.manager, "ensure_ready", _starting)
        await engines_start(_post_request(api_app, "/api/admin/engines/start"))
        for _ in range(4):
            await asyncio.sleep(0)
        assert envelopes[-1]["data"]["message"] == "引擎正在启动中（加载权重/首次调优），请稍候"

    async def test_receipt_reports_completed_when_launched(
        self, api_app, api_svc, monkeypatch
    ):
        """API-ADMIN-37 真正拉起（LAUNCHED）→ 回执「引擎启动完成」（原有语义保持）。"""
        from app.api.routes_admin import engines_start, task_done_message
        from app.engine.manager import LaunchOutcome

        assert task_done_message(None, "引擎启动") == "引擎启动完成"  # 非字符串返回兜底
        envelopes: list[dict] = []

        async def _bcast(envelope):
            envelopes.append(envelope)

        monkeypatch.setattr(api_svc.session, "broadcast_to_admin", _bcast)

        async def _launched(**kwargs) -> LaunchOutcome:
            return LaunchOutcome.LAUNCHED

        monkeypatch.setattr(api_svc.manager, "ensure_ready", _launched)
        await engines_start(_post_request(api_app, "/api/admin/engines/start"))
        for _ in range(4):
            await asyncio.sleep(0)
        assert envelopes[-1]["data"]["message"] == "引擎启动完成"
