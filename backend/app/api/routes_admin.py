"""REST 管理路由（TASK T4.4，API §3.3 / PRD §4.3）。

- ``GET/PUT /api/admin/config``：读取/更新参数（分层落地：应用级→config.yaml；
  引擎 cfg 级→渲染 analysis.cfg + 安全重启；交叉校验 deep > standard）；
- ``GET engines``：引擎状态（含 INIT/benchmark 进度、人类模型可用性）；
- ``POST start/stop``：**异步任务（202 Accepted）**，安全停止/按需启动，
  结果经 ``/ws/admin`` 推送（``admin.task``）；
- ``GET models`` / ``PUT default``：标准模型列表与默认模型切换（202 + restart_warning）；
- ``GET system``：psutil/nvidia-smi 经 ``run_in_threadpool`` 采集（非 NVIDIA 返回"不支持"）。
"""

from __future__ import annotations

import asyncio
import logging
import platform
import subprocess
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_services
from app.api.schemas import (
    AcceptedResponse,
    AdminEnginesResponse,
    AdminSystemResponse,
    AppUpdateRequest,
    ConfigUpdate,
    EngineDownloadRequest,
    ModelDownloadRequest,
    SetDefaultModelRequest,
)
from app.config import AppConfig, ConfigError, engine_path, save_config
from app.core.errors import AppError, ErrorCode
from app.core.fsm import engine_healthy_running
from app.engine.manager import LaunchOutcome, check_engine_assembly, render_analysis_cfg
from app.updates import common as updates_common

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

#: 变更后触发引擎安全重启的配置键（引擎 cfg 级 / 模型路径，ARCHITECTURE §3.6）
ENGINE_RESTART_KEYS = {
    "num_analysis_threads",
    "num_search_threads_per_analysis_thread",
    "standard_model",
    "human_model",
    "model_dir",
    "executable_dir",
    "analysis_cfg",
}

#: 配置扁平键 → 嵌套路径（config.yaml 分层模型）
_CONFIG_PATH = {
    "standard_max_visits": ("engine", "standard_max_visits"),
    "deep_max_visits": ("engine", "deep_max_visits"),
    "num_analysis_threads": ("engine", "num_analysis_threads"),
    "num_search_threads_per_analysis_thread": ("engine", "num_search_threads_per_analysis_thread"),
    "analysis_pv_len": ("engine", "analysis_pv_len"),
    "resident": ("engine", "resident"),
    "idle_timeout_s": ("engine", "idle_timeout_s"),
    "executable_dir": ("engine", "executable_dir"),
    "model_dir": ("engine", "model_dir"),
    "standard_model": ("engine", "standard_model"),
    "human_model": ("engine", "human_model"),
    "analysis_cfg": ("engine", "analysis_cfg"),
    "adaptive_initial_level": ("play", "adaptive_initial_level"),
    "max_undo": ("play", "max_undo"),
    "default_board_size": ("play", "default_board_size"),
    "default_rules": ("play", "default_rules"),
    "default_komi": ("play", "default_komi"),
    "default_human_color": ("play", "default_human_color"),
    "max_moves": ("play", "max_moves"),
    "variation_preview_len": ("review", "variation_preview_len"),
    "system_status_interval_s": ("admin", "system_status_interval_s"),
    "logging_level": ("logging", "level"),
    "logging_max_bytes": ("logging", "max_bytes"),
    "logging_backup_count": ("logging", "backup_count"),
}


def _engine_healthy_running(manager: Any) -> bool:
    """引擎是否**健康运行**（进程在 且 FSM 状态 ∈ 运行态）——管理端「运行中 / 未运行」的**唯一判据**。

    禁止直接用 `engine.is_running`：崩溃/启动中断后进程引用可能残留为真（陈旧引用，
    BUG-119，`ensure_ready` 的 FATAL 分支已注明此事实）——按「运行中」处理会排队一次
    永远不执行的安全重启（或误报「已受理」），而前端按 FSM 状态呈现「引擎未运行，
    下次启动生效」→ 对话框与实际行为不符（2026/09/24 人工反馈：「[保存默认模型？]
    显示 [保存]，实际行为是 [保存并重启]」）。与 `ensure_ready` 幂等守卫同源（
    `app/core/fsm.py::engine_healthy_running`，ISSUE-069 硬化）。
    """
    return engine_healthy_running(
        is_running=manager.engine.is_running, state=manager.fsm.state
    )


def _config_response(cfg: AppConfig) -> dict:
    """配置读取响应（分组返回）。"""
    return cfg.model_dump(mode="python")


def _apply_update(data: dict, key: str, value: Any) -> None:
    """扁平键 → 嵌套模型写入。"""
    group, field = _CONFIG_PATH[key]
    data[group][field] = value


#: 配置/默认模型变更广播消息（API §4.4：管理通道前端订阅后 REST 刷新参数/模型显示）
ADMIN_CONFIG_CHANGE = "admin.config"


async def _broadcast_config_changed(svc, *, source: str) -> None:
    """向 /ws/admin 广播 ``admin.config``（配置/默认模型已变更，多管理端同步刷新）。

    触发源：``PUT /api/admin/config`` / ``PUT /api/admin/models/default`` 写成功
    （含引擎级变更安全重启场景）；载荷 ``source`` ∈ {config, model}，向后兼容可忽略。
    """
    await svc.session.broadcast_to_admin(
        {"type": ADMIN_CONFIG_CHANGE, "data": {"source": source}}
    )


# ============================================================
# 配置
# ============================================================


@router.get("/config")
async def get_config(request: Request) -> dict:
    """读取配置（应用级 → config.yaml 唯一事实源）。"""
    return _config_response(request.app.state.config)


@router.put("/config")
async def update_config(request: Request, payload: ConfigUpdate) -> dict:
    """更新配置（部分更新，分层落地）。

    - 应用级 → 写回 config.yaml；引擎 cfg 级 / 模型路径变更 → 渲染 analysis.cfg
      并触发引擎安全重启（``admin.task`` 推送结果）；
    - 交叉校验 ``deep_max_visits > standard_max_visits``（AppConfig 全量校验）。
    """
    svc = get_services(request)
    cfg: AppConfig = request.app.state.config
    updates = payload.model_dump(exclude_none=True)
    if not updates:
        return _config_response(cfg)

    # L-3 防御：路径类字段（executable_dir/model_dir/analysis_cfg）拒绝 `..` 路径组件
    for _key in ("executable_dir", "model_dir", "analysis_cfg"):
        if _key in updates:
            _reject_path_escape(str(updates[_key]), _key)

    data = cfg.model_dump(mode="python")
    for key, value in updates.items():
        _apply_update(data, key, value)
    try:
        new_cfg = AppConfig.model_validate(data)
    except (ValidationError, ValueError) as exc:
        raise AppError(ErrorCode.INVALID_PAYLOAD, f"配置校验失败: {exc}") from None

    request.app.state.config = new_cfg
    # H-1 修复：配置热更新必须同步刷新服务容器与各服务持有的配置引用，
    # 否则运行期行为（悔棋上限/分析精度/自适应阈值等）不会随配置变更生效。
    svc.apply_config(new_cfg)
    # 分层默认启动 → save_config(None) 写根 config.yaml 增量；显式单文件 → 完整写回其自身
    if getattr(request.app.state, "config_persist", False):
        try:
            # L-7：磁盘写回经线程池（同步 I/O 不得阻塞事件循环）
            await run_in_threadpool(
                save_config, new_cfg, getattr(request.app.state, "config_path", None)
            )
        except OSError as exc:
            logger.warning("配置写回失败（内存态已更新）：%s", exc)

    # 配置已变更 → 管理通道广播（多管理端/后端侧参数同步；前端订阅后 REST 刷新）
    await _broadcast_config_changed(svc, source="config")

    # 引擎 cfg 级 / 模型路径变更 → 渲染 analysis.cfg + 安全重启（202 语义）
    if ENGINE_RESTART_KEYS & updates.keys():
        restart_warning: Optional[str]
        task_queued: bool
        if svc.manager is not None:
            # H-5 修复：无论引擎是否运行都渲染落盘（引擎未运行/不可用时下次启动生效）
            try:
                await run_in_threadpool(render_analysis_cfg, new_cfg.engine)
            except OSError as exc:
                logger.warning("analysis.cfg 渲染失败（配置仍生效于下次启动）：%s", exc)
            if _engine_healthy_running(svc.manager):
                restart_warning = "引擎参数/模型已变更，将在引擎空闲时安全重启生效"
                fut = svc.manager.request_restart()
                asyncio.create_task(
                    _report_task(svc, fut, "restart", task_label="配置变更重启")
                )
                task_queued = True
            else:
                # 引擎未运行：仅落配置，**不排队**（无异步任务 → 无 admin.task 回执，
                # 前端不得进入「已排队/已受理」等待态；BUG-138）
                restart_warning = "引擎参数/模型已变更，将在引擎下次启动时生效"
                task_queued = False
        else:
            restart_warning = "引擎参数/模型已变更（引擎不可用，将在启动时生效）"
            task_queued = False
        return {
            **_config_response(new_cfg),
            "restart_warning": restart_warning,
            "task_queued": task_queued,
        }
    return _config_response(new_cfg)


async def _report_task(svc, fut: Optional[asyncio.Future], task: str, *, task_label: str) -> None:
    """异步任务结果 → /ws/admin admin.task 推送（API §4.4）。"""
    try:
        if fut is not None:
            await fut
        await svc.session.broadcast_to_admin(
            {"type": "admin.task", "data": {"task": task, "status": "done", "message": f"{task_label}完成"}}
        )
    except Exception as exc:  # noqa: BLE001 - 任务失败推送错误结果
        logger.warning("管理任务失败（%s）：%s", task_label, exc)
        await svc.session.broadcast_to_admin(
            {
                "type": "admin.task",
                "data": {
                    "task": task,
                    "status": "failed",
                    "code": "INTERNAL_ERROR",
                    "message": f"{task_label}失败: {exc}",
                },
            }
        )


# ============================================================
# 引擎
# ============================================================


@router.get("/engines", response_model=AdminEnginesResponse)
async def engines_status(request: Request) -> dict:
    """引擎状态（含 INIT 加载/benchmark 进度、人类模型可用性、不可用归因）。

    无引擎管理器（服务启动时可执行文件/标准模型缺失，bootstrap 降级）时按**当前**
    文件系统重新探测（BUG-097，人工决策 A）：
    - 文件已就位 → 呈现 `STOPPED`（未启动）+ `reason=null`，可经 [启动]/[手动重启]
      运行时重建装配（无需重启服务）；
    - 仍缺失 → `FATAL` + `reason` ∈ {standard_model_missing, engine_executable_missing}
      + `detail`（缺失说明），与「连续崩溃」语义区分。
    """
    svc = get_services(request)
    if svc.manager is None:
        cfg: AppConfig = request.app.state.config
        check = check_engine_assembly(cfg.engine)
        if check.ok:
            return {
                "state": "STOPPED",
                "progress": None,
                "humanModelAvailable": False,
                "reason": None,
                "detail": None,
            }
        return {
            "state": "FATAL",
            "progress": None,
            "humanModelAvailable": False,
            "reason": check.code or "engine_unavailable",
            "detail": check.message,
        }
    return svc.manager.state_snapshot()


@router.post("/engines/start", status_code=202, response_model=AcceptedResponse)
async def engines_start(request: Request) -> AcceptedResponse:
    """启动引擎进程（按需加载；异步任务，benchmark 期间不阻塞请求）。

    - 无引擎管理器（文件缺失降级）→ 先尝试**运行时重建装配**（BUG-097）：文件就位则
      装配成功照常启动（无需重启服务）；仍缺失 → 503 如实报缺失原因（不再一律
      归因「标准模型缺失」）；
    - H-3 修复：``reset_fatal=True`` —— FATAL（连续崩溃停止）可由管理员
      在此显式"手动重启"脱离终态（fsm.mark_started 后重新拉起）。
    """
    svc = get_services(request)
    try:
        await svc.ensure_engine_manager()
    except ConfigError as exc:
        raise AppError(ErrorCode.ENGINE_FATAL, f"引擎不可用（{exc}）") from None
    manager = svc.manager
    if manager is None:
        # 防御：ensure_engine_manager 成功即已绑定；保持不可用语义快速失败
        raise AppError(ErrorCode.ENGINE_FATAL, "引擎不可用")

    async def _start() -> str:
        # 局部引用（闭包内 svc.manager 的 None 收窄不可靠；Pylance 类型收敛）
        outcome = await manager.ensure_ready(reset_fatal=True, reason="管理端启动")
        return start_receipt_text(outcome)

    task = asyncio.create_task(
        _run_admin_task(_start, svc, "start", task_label="引擎启动")
    )
    return AcceptedResponse(status="accepted", message="引擎启动已受理", task="start", task_queued=True)


@router.post("/engines/stop", status_code=202, response_model=AcceptedResponse)
async def engines_stop(request: Request) -> AcceptedResponse:
    """停止引擎进程；异步任务：仅引擎 IDLE 状态执行，忙时入队待空闲。"""
    svc = get_services(request)
    if svc.manager is None:
        return AcceptedResponse(
            status="accepted",
            message="引擎不可用，无需停止",
            task="stop",
            task_queued=False,
        )
    fut = svc.manager.request_stop()
    asyncio.create_task(_report_task(svc, fut, "stop", task_label="引擎停止"))
    return AcceptedResponse(
        status="accepted",
        message="引擎停止已受理（空闲时执行）",
        task="stop",
        task_queued=True,
    )


@router.post("/engines/restart", status_code=202, response_model=AcceptedResponse)
async def engines_restart(request: Request) -> AcceptedResponse:
    """重启引擎进程（T6.10 管理视图 [重启]）；异步任务语义同 stop：

    - 无引擎管理器（文件缺失降级）→ 先尝试**运行时重建装配**（BUG-097）：文件就位则
      装配成功（引擎未运行 → 「无需重启」提示）；仍缺失 → 503 如实报缺失原因；
    - 安全重启仅引擎 IDLE 状态执行，忙（ANALYZING/INIT）时入队待空闲；
    - 引擎未运行时无需重启（不排队，避免 pending restart 永不 drain）；
    - 执行结果经 ``/ws/admin`` 推送（``admin.task`` task=restart）。
    """
    svc = get_services(request)
    try:
        await svc.ensure_engine_manager()
    except ConfigError as exc:
        raise AppError(ErrorCode.ENGINE_FATAL, f"引擎不可用（{exc}）") from None
    if svc.manager is None:
        raise AppError(ErrorCode.ENGINE_FATAL, "引擎不可用")
    if not _engine_healthy_running(svc.manager):
        return AcceptedResponse(
            status="accepted",
            message="引擎未运行，无需重启",
            task="restart",
            task_queued=False,
        )
    fut = svc.manager.request_restart()
    asyncio.create_task(_report_task(svc, fut, "restart", task_label="引擎重启"))
    return AcceptedResponse(
        status="accepted",
        message="引擎重启已受理（空闲时执行）",
        task="restart",
        task_queued=True,
    )


def task_done_message(detail: object, task_label: str) -> str:
    """异步管理任务完成回执文案。

    ``operation`` 返回非空字符串时用其作为回执（[启动] 据此区分「已就绪」/「启动中」/
    「启动完成」，BUG-119）；否则沿用默认「<任务标签>完成」。旧实现一律回报「完成」：
    引擎因陈旧进程引用被误判「已在运行」时管理页出现假成功 toast。
    """
    return detail if isinstance(detail, str) and detail else f"{task_label}完成"


#: [启动] 回执文案（`LaunchOutcome` → 人类可读；ISSUE-069 三态回执）
START_RECEIPT_TEXT: dict[LaunchOutcome, str] = {
    LaunchOutcome.LAUNCHED: "引擎启动完成",
    LaunchOutcome.STARTING: "引擎正在启动中（加载权重/首次调优），请稍候",
    LaunchOutcome.ALREADY_RUNNING: "引擎已就绪，无需重复启动",
}


def start_receipt_text(outcome: LaunchOutcome) -> str:
    """[启动] 结果 → 回执文案（三态可区分；BUG-119/ISSUE-069）。"""
    return START_RECEIPT_TEXT[outcome]


async def _run_admin_task(operation, svc, task: str, *, task_label: str) -> None:
    """通用异步任务包装（start 等）：执行 + 结果推送。

    ``operation`` 可返回字符串作为**完成回执文案**（如 [启动]；BUG-119）。
    """
    try:
        detail = await operation()
        await svc.session.broadcast_to_admin(
            {
                "type": "admin.task",
                "data": {
                    "task": task,
                    "status": "done",
                    "message": task_done_message(detail, task_label),
                },
            }
        )
    except Exception as exc:  # noqa: BLE001 - 任务失败推送错误结果
        logger.warning("%s失败：%s", task_label, exc)
        code = exc.code if isinstance(exc, AppError) else "INTERNAL_ERROR"
        await svc.session.broadcast_to_admin(
            {
                "type": "admin.task",
                "data": {"task": task, "status": "failed", "code": code, "message": f"{task_label}失败: {exc.message if isinstance(exc, AppError) else exc}"},
            }
        )


# ============================================================
# 模型
# ============================================================


def _scan_models(model_dir: str | Path) -> tuple[list[str], Optional[str]]:
    """扫描模型目录（*.bin.gz），返回 (模型名列表, 默认标准模型名)。"""
    base = Path(model_dir)
    if not base.is_dir():
        return [], None
    names = sorted(p.name for p in base.glob("*.bin.gz"))
    default = None
    for name in names:
        if "human" not in name.lower():
            default = name
            break
    return names, default


@router.get("/models/remote")
async def list_remote_models(request: Request, force: bool = False) -> dict:
    """官方模型列表（katagotraining.org + KataGo v1.15.0 人类模型）。"""
    svc = get_services(request)
    try:
        return await svc.updates.list_remote_models(svc, force=force)
    except updates_common.UpdateError as exc:
        raise AppError(ErrorCode(exc.code), exc.message) from None


@router.post("/models/download", status_code=202, response_model=AcceptedResponse)
async def download_model(request: Request, payload: ModelDownloadRequest) -> AcceptedResponse:
    """下载/更新官方模型（202；进度与结果经 ``admin.task`` 推送）。"""
    svc = get_services(request)
    try:
        result = await svc.updates.start_model_download(svc, payload.kind, payload.name)
    except updates_common.UpdateError as exc:
        raise AppError(ErrorCode(exc.code), exc.message) from None
    return AcceptedResponse(
        status="accepted",
        message=result["message"],
        task=result["task"],
        task_queued=True,
    )


@router.get("/models")
async def list_models(request: Request) -> dict:
    """标准模型列表（engine/models/ 扫描；human 标记 + default）。"""
    svc = get_services(request)
    cfg: AppConfig = request.app.state.config
    names, auto_default = await run_in_threadpool(
        _scan_models, engine_path(cfg.engine.model_dir)
    )
    explicit_default = cfg.engine.standard_model
    default = explicit_default if explicit_default else auto_default
    human_available = (
        svc.manager is not None and svc.manager.engine.has_human_model
    )
    return {
        "models": [
            {"name": n, "human": "human" in n.lower(), "default": n == default}
            for n in names
        ],
        "default": default,
        "humanModelAvailable": human_available,
    }


def _reject_path_escape(value: str, field: str) -> None:
    """L-3 防御：拒绝含 ``..`` 路径组件或绝对路径探测的配置/模型名（路径字段白名单化）。"""
    if ".." in value.replace("\\", "/").split("/"):
        raise AppError(ErrorCode.INVALID_PAYLOAD, f"{field} 不允许包含 .. 路径组件")


@router.put("/models/default", status_code=202, response_model=AcceptedResponse)
async def set_default_model(request: Request, payload: SetDefaultModelRequest) -> AcceptedResponse:
    """设置默认标准模型（作为单进程 -model；切换触发引擎安全重启）。"""
    svc = get_services(request)
    cfg: AppConfig = request.app.state.config
    _reject_path_escape(payload.model, "模型文件名")
    model_dir = engine_path(cfg.engine.model_dir)
    if not (model_dir / payload.model).is_file():
        raise AppError(ErrorCode.INVALID_PAYLOAD, "模型文件不存在")
    if payload.model == cfg.engine.standard_model:
        return AcceptedResponse(
            status="accepted",
            message="默认模型未变化",
            task="set_model",
            restart_warning=None,
        )
    cfg.engine.standard_model = payload.model
    # H-1 修复：模型切换必须同步刷新服务容器/引擎管理器配置引用，
    # 否则安全重启重建引擎时仍使用旧模型路径。
    svc.apply_config(cfg)
    # 分层默认启动 → save_config(None) 写根 config.yaml 增量；显式单文件 → 完整写回其自身
    if getattr(request.app.state, "config_persist", False):
        try:
            # L-7：磁盘写回经线程池（同步 I/O 不得阻塞事件循环）
            await run_in_threadpool(
                save_config, cfg, getattr(request.app.state, "config_path", None)
            )
        except OSError as exc:
            logger.warning("配置写回失败：%s", exc)

    # 默认模型已变更 → 管理通道广播（多管理端模型下拉/参数同步）
    await _broadcast_config_changed(svc, source="model")

    if svc.manager is not None and _engine_healthy_running(svc.manager):
        fut = svc.manager.request_restart()
        asyncio.create_task(_report_task(svc, fut, "set_model", task_label="模型切换重启"))
        return AcceptedResponse(
            status="accepted",
            message="默认模型已更新，引擎将在空闲时重启",
            task="set_model",
            restart_warning="模型切换将重启引擎进程",
            task_queued=True,
        )
    # 引擎未运行：仅落配置，**不排队**（无异步任务 → 无 admin.task 回执）。文案与
    # 引擎级参数变更同口径（BUG-138）：一条「将在引擎下次启动时生效」即可，
    # 不再叠加「已排队/已受理」等假状态。
    return AcceptedResponse(
        status="accepted",
        message="引擎参数/模型已变更，将在引擎下次启动时生效",
        task="set_model",
        restart_warning=None,
        task_queued=False,
    )


# ============================================================
# 系统状态
# ============================================================


#: nvidia-smi 采集缓存（L-4：默认 5s 一次 system.status 推送不宜每次 spawn 子进程）
_GPU_CACHE_TTL_S = 10.0
_gpu_cache: dict = {"ts": 0.0, "value": None}


def _nvidia_gpu_summary() -> Optional[str]:
    """nvidia-smi 查询（非 NVIDIA/不可用 → None，前端显示"不支持"）。

    L-4 修复：结果按 10s 时间窗口缓存，避免高频 system.status 推送反复 spawn 子进程。
    """
    import time as _time

    now = _time.monotonic()
    if now - _gpu_cache["ts"] < _GPU_CACHE_TTL_S:
        return _gpu_cache["value"]
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode != 0 or not out.stdout.strip():
            value: Optional[str] = None
        else:
            parts = [p.strip() for p in out.stdout.strip().splitlines()[0].split(",")]
            if len(parts) < 3:
                value = None
            else:
                name, total, used = parts[0], parts[1], parts[2]
                value = f"{name}（{used}/{total} MiB）"
    except (OSError, subprocess.SubprocessError):
        value = None
    _gpu_cache["ts"] = now
    _gpu_cache["value"] = value
    return value


async def _collect_system_status(backend: Optional[str] = None) -> dict:
    """系统状态采集（psutil/nvidia-smi 经线程池，避免阻塞事件循环）。

    ``backend``：KataGo 实际后端标签（stderr 检测；引擎未启动/未检测为 None，
    前端显示「—」；BUG-097）。
    """

    def _collect() -> dict:
        import psutil

        host = platform.node()
        os_name = f"{platform.system()} {platform.release()}"
        cpu_count = psutil.cpu_count(logical=True) or 0
        vm = psutil.virtual_memory()
        memory_usage = {"total": vm.total, "used": vm.used, "percent": vm.percent}
        disk_usage = None
        try:
            du = psutil.disk_usage("/")
            disk_usage = {"total": du.total, "used": du.used, "percent": du.percent}
        except (OSError, ValueError):
            pass
        return {
            "host": host,
            "os": os_name,
            "cpu_count": cpu_count,
            "memory_usage": memory_usage,
            "disk_usage": disk_usage,
            "gpu": _nvidia_gpu_summary(),
            "backend": backend,
        }

    return await run_in_threadpool(_collect)


@router.get("/system", response_model=AdminSystemResponse)
async def system_status(request: Request) -> dict:
    """主机名/系统、内存、GPU（NVIDIA）、KataGo 后端（stderr 检测；未检测=None）。"""
    svc = get_services(request)
    backend = svc.manager.backend_label if svc.manager is not None else None
    return await _collect_system_status(backend)


# ============================================================
# 版本 / 应用更新 / 官方引擎与模型（2026/10/18）
# ============================================================


def _update_app_error(exc: updates_common.UpdateError) -> AppError:
    """更新领域异常 → 统一 AppError（错误码白名单已在 ``ErrorCode`` 登记）。"""
    return AppError(ErrorCode(exc.code), exc.message)


@router.get("/app")
async def app_info(request: Request) -> dict:
    """应用版本/部署形态/当前引擎与模型/更新任务状态（管理页「版本与资源」卡）。"""
    svc = get_services(request)
    return await svc.updates.app_info(svc)


@router.post("/app/check")
async def app_check_update(request: Request, force: bool = False) -> dict:
    """检查 GitHub Releases 最新版本（``force=true`` 跳过 10 分钟缓存）。"""
    svc = get_services(request)
    try:
        return await svc.updates.check_app_update(force=force)
    except updates_common.UpdateError as exc:
        raise _update_app_error(exc) from None


@router.post("/app/update", status_code=202, response_model=AcceptedResponse)
async def app_update(request: Request, payload: AppUpdateRequest) -> AcceptedResponse:
    """应用自动更新（202；下载/校验/备份/覆盖/重启，结果经 ``admin.task``）。"""
    svc = get_services(request)
    try:
        result = await svc.updates.start_app_update(svc, version=payload.version)
    except updates_common.UpdateError as exc:
        raise _update_app_error(exc) from None
    return AcceptedResponse(
        status="accepted",
        message=result["message"],
        task=result["task"],
        task_queued=True,
    )


@router.get("/app/update/status")
async def app_update_status(request: Request) -> dict:
    """当前更新/下载任务状态（WS 断线重连后的权威兜底）。"""
    svc = get_services(request)
    return svc.updates.status()


@router.get("/kata/releases")
async def kata_releases(request: Request, force: bool = False) -> dict:
    """KataGo 官方 Releases（按当前平台过滤；推荐资产优先 OpenCL）。"""
    svc = get_services(request)
    try:
        return await svc.updates.list_engine_releases(svc, force=force)
    except updates_common.UpdateError as exc:
        raise _update_app_error(exc) from None


@router.post("/kata/download", status_code=202, response_model=AcceptedResponse)
async def kata_download(request: Request, payload: EngineDownloadRequest) -> AcceptedResponse:
    """下载/更新 KataGo（安装前停止引擎，完成后按原状态重启）。"""
    svc = get_services(request)
    try:
        result = await svc.updates.start_engine_download(
            svc, payload.release_tag, payload.asset_name
        )
    except updates_common.UpdateError as exc:
        raise _update_app_error(exc) from None
    return AcceptedResponse(
        status="accepted",
        message=result["message"],
        task=result["task"],
        task_queued=True,
    )
