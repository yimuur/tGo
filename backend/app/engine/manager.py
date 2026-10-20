"""引擎生命周期管理器（ARCHITECTURE §3.1/§3.2，PRD §4.3.1）。

- **常驻开关**：`resident=True` 服务启动即拉起并常驻；`False`（默认）按需加载；
- **按需加载**：`ensure_ready()` 在首次任务前拉起引擎；
- **空闲超时释放**：非常驻模式下，引擎空闲（**仅 IDLE 态**且无进行中查询、超时，
  且**无活跃对弈/复盘连接**）自动停止释放资源；启动/调优（INIT）、崩溃恢复（DEAD/
  FATAL）中一律不释放（BUG-081）；存在活跃连接时空闲计时清零不计时（``activity_fn``
  注入），引擎被停止（空闲释放/手动停止）而仍有活跃连接时由监控自动拉起；
  **启动成功即复位空闲计时**（含退避重启/安全重启，BUG-078：否则服务已运行超阈值时
  新启动的引擎会在下一个监控周期被立即释放，与前端自动拉起形成「释放/拉起」循环）；
- **崩溃指数退避重启**：5 分钟窗内连续崩溃 3 次 → FATAL 并广播；未超限按 2^n 退避重启；
- **安全重启**：仅引擎 IDLE 执行；忙（ANALYZING）时入队，待空闲后执行
  （REST `202 Accepted` 语义，结果经 `/ws/admin` 推送）；
- **首次 benchmark**：stderr 经 BenchmarkParser 解析，INIT 附带 progress 广播，
  benchmark 期间握手延长、不误判启动失败（PRD §4.3.4）；
- **状态广播**：`on_state_change` 回调（前端引擎状态/进度映射；含查询起止 IDLE↔ANALYZING，2026/09/18）；
- **不可用归因**（BUG-097）：stderr 采集**真实后端**（`backend_label`，如
  `OpenCL · NVIDIA GeForce GTX 1660`，供 `/admin/system` 呈现）；启动失败（握手超时/
  进程启动阶段退出/安全重启失败）记录原因（优先 stderr 错误行），DEAD/FATAL 快照经
  `reason=startup_failed` + `detail` 如实下发（前端横幅/胶囊/管理卡呈现真实原因）；
- **生命周期日志**（BUG-082）：引擎**启动成功/失败**（含触发原因：按需加载 / 活跃连接
  自动拉起 / 常驻启动 / 管理端启动 / 崩溃退避重启 / 安全重启）与空闲释放、管理端
  停止均写入应用日志（`tgo.log`）——与 ``engine.log``（子进程原始输出）配对，保证
  排查时「拉起」与「释放」都有应用侧事实记录。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections import deque
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

from app.config import ConfigError, EngineConfig, default_engine_cfg_path, engine_path
from app.core.errors import AppError, ErrorCode
from app.core.fsm import (
    QUERY_STATES,
    EngineFsm,
    EngineFsmError,
    EngineState,
    engine_healthy_running,
    engine_launchable,
    engine_stale_process,
)
from app.engine.analysis_engine import AnalysisEngine, EngineStartError, EngineStoppedError
from app.engine.benchmark import BenchmarkParser
from app.engine.models import resolve_models

logger = logging.getLogger(__name__)

StateCallback = Callable[[EngineState, Optional[int]], None]


class LaunchOutcome(str, Enum):
    """``ensure_ready`` 的结果（幂等语义的可区分回报，ISSUE-069）。

    动机（BUG-119）：旧实现一律回报「引擎启动完成」——引擎因陈旧进程引用被误判
    「已在运行」时管理页出现假成功 toast。三态让管理端如实区分：
    ``LAUNCHED``
        本次真正执行了拉起（含 FATAL 手动重启、清场陈旧引用后再拉起）；
    ``STARTING``
        已有启动尝试在途（INIT + 进程在，加载权重/首次调优中）→ 幂等空操作；
    ``ALREADY_RUNNING``
        引擎已就绪在运行（IDLE/ANALYZING）→ 幂等空操作。
    """

    LAUNCHED = "launched"
    STARTING = "starting"
    ALREADY_RUNNING = "already_running"

#: KataGo 可执行文件名（executable_dir 顶层；按平台优先识别）
_EXECUTABLE_NAMES = ("katago.exe", "katago") if os.name == "nt" else ("katago", "katago.exe")


def resolve_executable(executable_dir: str | os.PathLike[str]) -> Path:
    """在 ``executable_dir`` **顶层**按平台识别 KataGo 可执行文件（Windows: katago.exe / Linux: katago）。

    缺失时抛 ``ConfigError(code="engine_executable_missing")``（引擎不可用降级，不启动进程；
    与标准模型缺失同语义但归因不同，供前端如实呈现缺失的到底是什么，BUG-097）。
    """
    base = Path(executable_dir)
    for name in _EXECUTABLE_NAMES:
        candidate = base / name
        if candidate.is_file():
            return candidate
    raise ConfigError(
        f"KataGo 可执行文件缺失：{base} 下未找到 {'/'.join(_EXECUTABLE_NAMES)}（engine.executable_dir）",
        code="engine_executable_missing",
    )


@dataclass(frozen=True)
class EngineAssemblyCheck:
    """引擎装配前置探测结果（不构建管理器、不启动进程）。

    用于无引擎管理器时如实归因「引擎为何不可用」（BUG-097，人工决策 A）：
    - 文件就位（``ok=True``）→ 引擎可经管理端 [启动]/[手动重启] 运行时重建装配；
    - 缺失（``ok=False``）→ ``code`` ∈ {standard_model_missing, engine_executable_missing}。
    """

    ok: bool
    code: Optional[str] = None
    message: Optional[str] = None


def check_engine_assembly(cfg: EngineConfig) -> EngineAssemblyCheck:
    """探测引擎装配前置条件（可执行文件 + 标准模型，仅文件系统检查、无副作用）。"""
    try:
        resolve_executable(engine_path(cfg.executable_dir))
        resolve_models(
            model_dir=engine_path(cfg.model_dir),
            standard_model=cfg.standard_model,
            human_model=cfg.human_model,
        )
    except ConfigError as exc:
        return EngineAssemblyCheck(ok=False, code=exc.code, message=str(exc))
    return EngineAssemblyCheck(ok=True)


def build_engine(cfg: EngineConfig, fsm: EngineFsm) -> AnalysisEngine:
    """按配置构建 Analysis 引擎（可执行文件识别 + 模型解析；人类模型缺失时仅挂载标准模型）。

    - ``executable_dir`` / ``model_dir`` / ``analysis_cfg`` 相对路径锚定项目根；
      ``executable_dir`` 顶层按平台识别 ``katago.exe``（Windows）/``katago``（Linux），
      缺失抛 ``ConfigError``（引擎不可用降级）；
    - PRD §4.1.1 人类模型缺失降级：``resolve_models`` 检测 ``model_dir`` 下无人类模型时
      不传 ``-human-model``，创建对局由前端据 ``engine.has_human_model`` 禁用人类风格/自适应。
    """
    executable = resolve_executable(engine_path(cfg.executable_dir))
    models = resolve_models(
        model_dir=engine_path(cfg.model_dir),
        standard_model=cfg.standard_model,
        human_model=cfg.human_model,
    )
    return AnalysisEngine(
        fsm,
        executable=str(executable),
        config_path=str(engine_path(cfg.analysis_cfg)),
        model_path=models.standard_model_path,
        human_model_path=models.human_model_path or "",
    )


def _map_fsm_error(state: EngineState) -> AppError:
    """将 FSM 状态映射为统一错误码（API §2 ENGINE_*）。"""
    if state is EngineState.INIT:
        return AppError(ErrorCode.ENGINE_BUSY, "引擎初始化中（加载权重/调优），请稍候")
    if state is EngineState.STOPPED:
        return AppError(ErrorCode.ENGINE_DEAD, "引擎未启动或已停止，请稍后重试")
    if state is EngineState.DEAD:
        return AppError(ErrorCode.ENGINE_DEAD, "引擎已崩溃，正在重启中，请稍后重试")
    if state is EngineState.FATAL:
        return AppError(ErrorCode.ENGINE_FATAL, "引擎连续崩溃已停止，请手动重启")
    return AppError(ErrorCode.ENGINE_BUSY, "引擎状态非法")


# ---- 引擎 cfg 分层：用户层 analysis.cfg / 默认层 default.cfg（2026/09/23 人工决策） ----
#
# 背景（BUG-132）：旧实现每次「启动 / 引擎级参数变更 / 引擎重建」都**整文件覆写**
# analysis.cfg——用户在 analysis.cfg 手工追加的参数（如 DEPLOYMENT §7 指引的
# `openclGpuToUse`）必然被冲掉。现口径与 config.yaml/default.yaml 完全一致：
#   · 默认层 `backend/default.cfg`：只读，缺失时按内置模板生成（用户层首次生成之源）；
#   · 用户层 `<engine.analysis_cfg>`：引擎实际 `-config` 加载的文件，可自由修改/追加参数，
#     应用**只在首次缺失时**按模板生成，其后仅做**行级补丁**校正「应用维护项」。
# 引擎 cfg 键与注释依据 KataGo 上游 `cpp/configs/analysis_example.cfg`；
# 解析语义对齐 `cpp/core/global.cpp::stripComments` + `cpp/core/config_parser.cpp`（见 `_parse_cfg_entry`）。

#: 引擎 cfg 键块（默认层与用户层共用，避免两处漂移）
_ENGINE_CFG_KEY_BLOCK = """\
reportAnalysisWinratesAs = BLACK
# By default, if NOT specified in an individual request, limit maximum number of root visits per search to this much
maxVisits = 500
numAnalysisThreads = 2
numSearchThreadsPerAnalysisThread = 16
nnMaxBatchSize = 64
# Cache up to 2 ** this many neural net evaluations in case of transpositions in the tree.
nnCacheSizePowerOfTwo = 23
# Size of mutex pool for nnCache is 2 ** this
nnMutexPoolSizePowerOfTwo = 17
# Randomize board orientation when running neural net evals?
nnRandomize = true
"""

#: 应用维护项说明（两层模板头部共用）
_ENGINE_CFG_MAINTAINED_NOTE = """\
# 应用维护项（仅这些键会被后端校正，其余键与注释一律不动）：
#   numAnalysisThreads / numSearchThreadsPerAnalysisThread —— 管理页参数（config.yaml 期望值）
#   reportAnalysisWinratesAs —— 强制 BLACK（存储与内部派生统一黑方视角，ARCHITECTURE §3.6）
#   logFile / logDir / logDirDated —— 强制缺省（禁用 KataGo 自身日志，交后端统一托管轮转）
"""

#: 默认层模板（`backend/default.cfg`；只读）
DEFAULT_ENGINE_CFG_TEMPLATE = (
    "# tGo 引擎默认配置（默认层：只读，缺失时由应用按本模板生成）\n"
    "# 引擎实际加载的是用户层 <engine.analysis_cfg>（可自由修改/追加参数）。\n"
    + _ENGINE_CFG_MAINTAINED_NOTE
    + _ENGINE_CFG_KEY_BLOCK
)

#: 用户层模板（用户层文件首次缺失时生成；其后只做行级补丁，不覆写）
USER_ENGINE_CFG_TEMPLATE = (
    "# tGo 引擎配置（用户层：引擎以 -config 加载本文件）\n"
    "# 本文件可自由修改/追加参数；应用不会覆写，仅校正下列应用维护项。\n"
    + _ENGINE_CFG_MAINTAINED_NOTE
    + _ENGINE_CFG_KEY_BLOCK
)

#: 应用维护的引擎 cfg 键（值取 config.yaml 期望值；变更后按 §3.2 安全重启生效）
_MANAGED_CFG_KEYS = ("numAnalysisThreads", "numSearchThreadsPerAnalysisThread")

#: 应用强制键（值恒由应用指定：存储/派生视角语义依赖）
_FORCED_CFG_VALUES = {"reportAnalysisWinratesAs": "BLACK"}

#: 应用禁止键（必须缺省：写文件会脱离后端统一日志托管；KataGo 三者只允许至多其一）
_FORBIDDEN_CFG_KEYS = ("logFile", "logDir", "logDirDated")

#: 禁止键被禁用后的行标记（幂等：标记后的行为注释行，不再判定为生效键）
_DISABLED_CFG_MARK = "# [tGo 已禁用] "


def _ensure_default_engine_cfg() -> Path:
    """确保默认层 ``backend/default.cfg`` 存在（只读；缺失时由内置模板生成一次）。"""
    target = default_engine_cfg_path()
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(DEFAULT_ENGINE_CFG_TEMPLATE, encoding="utf-8")
    return target


def _parse_cfg_entry(line: str) -> Optional[tuple[str, str]]:
    """解析 cfg 行 → ``(key, value)``；非生效键值行（注释/空行/``@include``）返回 None。

    语义对齐 KataGo：``Global::stripComments``（按行截断首个 ``#`` 之后内容）
    + ``ConfigParser::parseKeyValue``（以首个 ``=`` 分割，键/值各自 trim），
    保证「应用认定为生效键的行」与「KataGo 实际读到的键」一致——否则会出现
    应用改了注释行却以为改了生效键，或反过来覆写了用户注释。
    """
    body = line.split("#", 1)[0]
    if "=" not in body:
        return None
    key, value = body.split("=", 1)
    key = key.strip()
    if not key:
        return None
    return key, value.strip()


def _desired_cfg_values(engine_cfg) -> dict[str, str]:
    """应用维护/强制键的期望值（管理页参数取 config.yaml 期望值）。"""
    return {
        "numAnalysisThreads": str(int(engine_cfg.num_analysis_threads)),
        "numSearchThreadsPerAnalysisThread": str(
            int(engine_cfg.num_search_threads_per_analysis_thread)
        ),
        **_FORCED_CFG_VALUES,
    }


def _patch_analysis_cfg(text: str, engine_cfg) -> tuple[str, list[tuple[str, str]]]:
    """用户层 cfg 行级补丁 → ``(新文本, [(级别, 说明)])``。

    - 应用维护/强制键：值不符即改写（强制键的覆盖必须留痕）；
    - 禁止键：整行注释（保留用户原文备查——KataGo 的 ``logFile``/``logDir``/``logDirDated``
      互斥且写文件后其 stdout/stderr 不再是唯一事实源）；
    - 生效键缺失：文件末尾补写（KataGo 对 ``numAnalysisThreads`` 等按必填键读取，
      缺失会 ``Could not find key`` 直接退出）；
    - 其余行（其它默认参数、用户自定义参数、注释）原样保留。
    """
    desired = _desired_cfg_values(engine_cfg)
    out: list[str] = []
    changes: list[tuple[str, str]] = []
    present: set[str] = set()
    for raw in text.splitlines():
        entry = _parse_cfg_entry(raw)
        if entry is None:
            out.append(raw)
            continue
        key, value = entry
        if key in _FORBIDDEN_CFG_KEYS:
            out.append(f"{_DISABLED_CFG_MARK}{raw.strip()}")
            changes.append(("warning", f"{key} 为应用强制缺省项（KataGo 日志交后端托管），已注释禁用：{value!r}"))
            continue
        if key in desired:
            present.add(key)
            if value != desired[key]:
                out.append(f"{key} = {desired[key]}")
                level = "warning" if key in _FORCED_CFG_VALUES else "info"
                changes.append((level, f"{key} 已按应用期望值校正：{value!r} → {desired[key]!r}"))
                continue
        out.append(raw)
    missing = [key for key in (*_MANAGED_CFG_KEYS, *_FORCED_CFG_VALUES) if key not in present]
    if missing:
        out.append("# tGo 应用维护项（缺失补写）")
        out.extend(f"{key} = {desired[key]}" for key in missing)
        changes.append(("info", f"缺失的应用维护项已补写：{', '.join(missing)}"))
    return "\n".join(out) + "\n", changes


def render_analysis_cfg(engine_cfg) -> Path:
    """渲染/校正引擎 cfg（默认层 ``backend/default.cfg`` + 用户层 ``engine.analysis_cfg``）。

    - **用户层不覆写**：仅首次缺失时按用户层模板生成；其后只做行级补丁校正应用维护项
      （`numAnalysisThreads`/`numSearchThreadsPerAnalysisThread` 取 config.yaml 期望值；
      `reportAnalysisWinratesAs` 强制 BLACK；`logFile`/`logDir`/`logDirDated` 强制缺省）。
      用户在 analysis.cfg 的其它修改、自定义参数与注释一律保留（BUG-132）；
    - **默认层只读**：`backend/default.cfg` 缺失时按内置模板生成（与 config.yaml/default.yaml 同口径）；
    - 调用时机：服务启动装配、引擎运行期重建、引擎级参数/模型路径变更（引擎未运行也落盘，下次启动生效）；
    - 禁用 KataGo 自身日志，其 stdout/stderr 交由后端统一托管轮转；
    - 相对路径锚定项目根（与启动 CWD 无关）。
    """
    target = engine_path(engine_cfg.analysis_cfg)
    target.parent.mkdir(parents=True, exist_ok=True)
    _ensure_default_engine_cfg()
    if not target.exists():
        target.write_text(USER_ENGINE_CFG_TEMPLATE, encoding="utf-8")
    try:
        text = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        # 用户层文件非 UTF-8（如记事本另存 ANSI/GBK）：既不覆写也不强改（回写会损坏原字节），
        # 仅告警跳过校正——KataGo 按字节读取，非 UTF-8 注释不影响引擎启动。
        logger.warning(
            "analysis.cfg 非 UTF-8 编码，已跳过应用维护项校正（请以 UTF-8 保存以恢复自动校正）：%s",
            target,
        )
        return target
    patched, changes = _patch_analysis_cfg(text, engine_cfg)
    if patched != text:
        # 先落盘再记录（写失败时不得留下「已校正」的误导日志）
        target.write_text(patched, encoding="utf-8")
    for level, message in changes:
        logger.log(logging.INFO if level == "info" else logging.WARNING, "analysis.cfg %s", message)
    return target


# ---- KataGo 后端识别 / 启动失败归因（BUG-097；标记依据 KataGo 源码逐行确认，勿臆改） ----
#: stderr 后端标记 → 后端名（首匹配生效；`device` 组在存在时补充设备描述）。
#: 来源：openclhelpers.cpp（Using/Found OpenCL Device、Found OpenCL Platform）、
#: openclbackend.cpp（OpenCL backend thread）、cudaandrocmbackend.inc（Cuda backend/
#: CUDA backend/ROCm backend）、trtbackend.cpp（TensorRT backend thread）、
#: eigenbackend.cpp（Eigen (CPU) backend thread）、onnxbackend.cpp（ONNX backend）、
#: metalbackend.cpp（Metal backend）。
_BACKEND_MARKERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"Using OpenCL Device \d+:\s*(?P<device>.+?)\s+OpenCL\b"), "OpenCL"),
    (re.compile(r"Found OpenCL Device \d+:\s*(?P<device>.+?)\s*\(score"), "OpenCL"),
    (re.compile(r"Found OpenCL Platform|Creating context for OpenCL Platform|OpenCL backend thread"), "OpenCL"),
    (re.compile(r"TensorRT backend(?:\s+thread\s+\d+:\s*Found GPU\s+(?P<device>.+?)\s+memory)?"), "TensorRT"),
    (re.compile(r"Eigen \(CPU\) backend"), "Eigen"),
    (re.compile(r"ONNX backend"), "ONNX"),
    (re.compile(r"ROCm backend"), "ROCm"),
    (re.compile(r"Metal backend"), "Metal"),
    (re.compile(r"(?:Cuda|CUDA) backend(?:\s+thread\s+\d+:\s*Found GPU\s+(?P<device>.+?)\s+memory)?"), "CUDA"),
)

#: 设备描述尾部的厂商括注（`NVIDIA GeForce GTX 1660 (NVIDIA Corporation)` → 去尾）
_VENDOR_SUFFIX_PATTERN = re.compile(r"\s*\([^()]*\)\s*$")

#: stderr 错误行特征（启动失败归因取窗口内最后一条命中行；未命中回退最后一条非空行）
_STDERR_ERROR_HINT = re.compile(
    r"uncaught exception|error|exception|failed|failure|cannot|unable|out of memory|driver",
    re.IGNORECASE,
)


def _normalize_device_name(name: str) -> str:
    """设备描述规范化：去除尾部厂商括注（展示口径 `OpenCL · NVIDIA GeForce GTX 1660`）。"""
    return _VENDOR_SUFFIX_PATTERN.sub("", name).strip()


def _pick_stderr_cause(lines: "deque[str]") -> Optional[str]:
    """从 stderr 窗口内提取失败原因：取最后一条**错误特征行**（无则为 None）。"""
    for line in reversed(lines):
        text = line.strip()
        if text and _STDERR_ERROR_HINT.search(text):
            return text
    return None


class EngineManager:
    """引擎生命周期管理器（依赖注入 clock/sleep 便于 Mock 时间）。"""

    def __init__(
        self,
        config,
        engine: AnalysisEngine,
        *,
        engine_factory: Optional[Callable[[EngineFsm], AnalysisEngine]] = None,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable = asyncio.sleep,
        backoff_base_s: float = 1.0,
        max_backoff_s: float = 60.0,
        activity_fn: Optional[Callable[[], bool]] = None,
    ) -> None:
        self._cfg = config
        self._engine = engine
        self._fsm: EngineFsm = engine.fsm
        #: 安全重启时重建引擎的工厂（生产由 bootstrap 注入 build_engine；
        #: 模型/可执行文件变更经重建生效，H-5/模型切换）。None=仅 stop+start 原实例。
        self._engine_factory = engine_factory
        self._monotonic = monotonic
        self._sleep = sleep
        self._backoff_base_s = backoff_base_s
        self._max_backoff_s = max_backoff_s
        #: 活跃连接判据（对弈/复盘 WS 连接存在性，由 bootstrap 注入）——
        #: 有活跃连接时空闲计时清零不计时；引擎停止则自动拉起
        self._activity_fn = activity_fn

        self._resident = bool(getattr(config, "resident", False))
        self._idle_timeout_s = float(getattr(config, "idle_timeout_s", 0) or 0)
        self._idle_poll_s = (
            max(1.0, min(self._idle_timeout_s, 5.0)) if self._idle_timeout_s > 0 else 60.0
        )

        self._backoff_attempt = 0
        self._last_activity = self._monotonic()
        self._benchmark_progress: Optional[int] = None
        self._stopping = False
        #: 本轮启动尝试的 stderr 窗口（启动失败归因只取本轮输出；BUG-097）
        self._recent_stderr: deque[str] = deque(maxlen=60)
        #: stderr 检测的真实后端（首匹配；未检测=None）
        self._backend: Optional[str] = None
        self._backend_device: Optional[str] = None
        #: 最近一次启动失败原因（stderr 错误行为主）；成功启动即清空
        self._last_start_failure: Optional[str] = None

        self._launch_lock = asyncio.Lock()
        self._monitor_task: Optional[asyncio.Task] = None
        self._restart_task: Optional[asyncio.Task] = None
        self._drain_task: Optional[asyncio.Task] = None
        self._pending_restarts: list[asyncio.Future] = []
        self._stop_task: Optional[asyncio.Task] = None
        self._pending_stops: list[asyncio.Future] = []
        self._state_callbacks: list[StateCallback] = []

        self._benchmark_parser = BenchmarkParser(
            on_benchmark_start=self._on_benchmark_start,
            on_progress=self._on_benchmark_progress,
            on_benchmark_end=self._on_benchmark_end,
        )
        self._wire_engine_callbacks(engine)

    # ---- 基础访问 ----
    @property
    def engine(self) -> AnalysisEngine:
        return self._engine

    @property
    def fsm(self) -> EngineFsm:
        return self._fsm

    def state_snapshot(self) -> dict:
        """引擎状态快照（前端映射：state + INIT/benchmark progress + 人类模型可用性）。

        ``state`` 语义分界（2026/09/18）：``STOPPED``＝未启动（进程未运行：从未启动/
        干净停止/重建失败回落），``INIT``＝启动中（拉起/加载权重/首次调优）。

        附**不可用归因**（BUG-097，API §3.3 可选字段）：引擎启动失败且处于 DEAD/FATAL
        时携带 `reason="startup_failed"` + `detail`（stderr 错误行摘录，如
        `Uncaught exception: No OpenCL devices were found...`）；正常时显式 `null` 清旧值。
        """
        reason: Optional[str] = None
        detail: Optional[str] = None
        if self._last_start_failure is not None and self._fsm.state in (
            EngineState.DEAD,
            EngineState.FATAL,
        ):
            reason = "startup_failed"
            detail = self._last_start_failure
        return {
            "state": self._fsm.state.value,
            "progress": self._benchmark_progress,
            "humanModelAvailable": self._engine.has_human_model,
            "reason": reason,
            "detail": detail,
        }

    @property
    def backend_label(self) -> Optional[str]:
        """KataGo 实际后端（stderr 检测，如 `OpenCL · NVIDIA GeForce GTX 1660`；未检测=None）。"""
        if self._backend is None:
            return None
        if self._backend_device:
            return f"{self._backend} · {self._backend_device}"
        return self._backend

    def on_state_change(self, callback: StateCallback) -> None:
        """注册状态变更回调（前端广播用）。"""
        self._state_callbacks.append(callback)

    def update_config(self, cfg) -> None:
        """运行期配置热更新（H-1）：刷新引擎级配置引用与派生参数。"""
        self._cfg = cfg.engine
        self._resident = bool(cfg.engine.resident)
        self._idle_timeout_s = float(getattr(cfg.engine, "idle_timeout_s", 0) or 0)
        self._idle_poll_s = (
            max(1.0, min(self._idle_timeout_s, 5.0)) if self._idle_timeout_s > 0 else 60.0
        )

    def set_engine_factory(self, factory: Callable[[EngineFsm], AnalysisEngine]) -> None:
        """刷新「安全重启重建引擎」工厂（组合根在容器创建后接线）。

        动机（H-5 同族）：工厂若闭包捕获启动时的配置对象，``PUT /admin/config``
        热更新替换 ``AppServices.config`` 后会读旧值——组合根改经本方法把工厂指向
        **活取**最新配置的读法，保证模型/可执行文件/路径类变更在重建时生效。
        """
        self._engine_factory = factory
    def _wire_engine_callbacks(self, engine: AnalysisEngine) -> None:
        """接线引擎回调（stderr 解析 / 崩溃策略 / 查询状态广播）。

        查询状态广播（2026/09/18）：FSM ``begin_query``/``end_query``（IDLE↔ANALYZING）
        须在每次查询起止后通知 ``on_state_change`` 监听者——旧实现仅在生命周期事件
        （启动/停止/崩溃/调优）广播，ANALYZING 永远到不了前端（胶囊无「分析中」）。
        """
        engine.set_callbacks(
            on_stderr_line=self._handle_stderr_line,
            on_crash=self._on_engine_down,
            on_query_state_change=self._notify_state,
        )

    def _notify_state(self) -> None:
        for cb in self._state_callbacks:
            try:
                cb(self._fsm.state, self._benchmark_progress)
            except Exception:  # noqa: BLE001 - 回调异常不得影响管理器
                logger.exception("状态回调异常")

    # ---- 生命周期 ----

    async def start(self) -> None:
        """管理器启动：拉起空闲监控；常驻模式同时启动引擎。

        常驻启动失败（进程退出/启动超时/重建失败）**不向上抛出**（BUG-104）：旧实现
        `AppError` 传播出 lifespan → uvicorn `Application startup failed. Exiting.`
        ——引擎异常把整个应用拖死（违背 PRD 降级矩阵）。引擎降级交由既有恢复链接管：
        DEAD 走指数退避重启；FATAL/重建失败（回落 STOPPED）待文件修正后经管理端
        [启动]/[手动重启] 或活跃连接自动拉起恢复；应用继续运行。
        """
        self._stopping = False
        if self._monitor_task is None or self._monitor_task.done():
            self._monitor_task = asyncio.create_task(
                self._idle_monitor(), name="engine-idle-monitor"
            )
        if self._resident:
            try:
                await self.ensure_ready(reason="常驻启动")
            except AppError as exc:
                # 引擎降级、应用不退出（BUG-104）：失败事实与恢复途径入日志
                logger.warning("常驻启动失败（引擎降级，应用继续运行；恢复链接管）：%s", exc)

    async def stop(self) -> None:
        """管理器停止：停止监控与引擎（优雅退出序列），fail 挂起的重启/停止请求。"""
        self._stopping = True
        for task in (
            self._monitor_task,
            self._restart_task,
            self._drain_task,
            self._stop_task,
        ):
            if task is not None and not task.done():
                task.cancel()
        self._monitor_task = self._restart_task = self._drain_task = None
        self._stop_task = None
        for fut in self._pending_restarts + self._pending_stops:
            if not fut.done():
                fut.set_exception(EngineStoppedError("管理器已停止"))
        self._pending_restarts.clear()
        self._pending_stops.clear()
        if self._engine.is_running:
            await self._engine.stop()
        self._fsm.mark_stopped()  # 停止后回到未运行态（STOPPED＝未启动）
        self._notify_state()

    async def ensure_ready(
        self, *, reset_fatal: bool = False, reason: str = "按需加载"
    ) -> LaunchOutcome:
        """按需加载：确保引擎运行（常驻模式服务启动即调用）。

        - ``reason``：启动原因文案（按需加载 / 活跃连接自动拉起 / 常驻启动 / 管理端启动
          等），仅用于 ``tgo.log`` 生命周期日志（BUG-082），不改变行为；
        - ``reset_fatal=True`` 由管理 API「手动重启」使用：FATAL 终态显式重置后重新拉起
          （H-3 修复，fsm.mark_started 由 engine.start 执行）；
        - 普通查询路径 ``reset_fatal=False``：FATAL 仍抛 ``ENGINE_FATAL``；
        - **幂等（BUG-080/BUG-119）**：空操作**仅限引擎真正健康在运行**
          （``engine_healthy_running``：`is_running` 为真**且**状态 ∈ ``RUNNING_STATES``
          ＝ INIT（拉起/调优中）/ IDLE / ANALYZING）；其余情形一律进入 ``_launch``
          （其内部先停旧再启新）：
            - 未运行且 ``LAUNCHABLE_STATES``（STOPPED / INIT 拉起窗口）→ 真正拉起；
            - **`is_running` 为真但状态非运行态 ＝ 陈旧进程引用**（崩溃/启动中断路径
              未释放，BUG-119）——旧实现按 `is_running` 早退，管理端 [启动] 因此静默
              空操作并回报「完成」（前端假成功 toast、引擎永不再拉起）；
        - ``DEAD`` 入口态仍快速失败（交指数退避重启），FATAL 仅 ``reset_fatal`` 下恢复
          ——两者均为**恢复所有者**独占（ISSUE-069：DEAD→退避链，FATAL→管理端手动重启）。

        @returns ``LaunchOutcome``（``LAUNCHED`` / ``STARTING`` / ``ALREADY_RUNNING``）；
        供管理端区分「启动完成」/「启动中」/「已就绪」回执（BUG-119，`routes_admin`
        据此下发 `admin.task` 文案）。
        """
        state = self._fsm.state
        fatal_recovery = False
        if state is EngineState.FATAL:
            if not reset_fatal:
                raise AppError(ErrorCode.ENGINE_FATAL, "引擎连续崩溃已停止，请手动重启")
            # H-3：管理员手动重启——显式重置 FATAL 终态后强制重新拉起。
            # 注意：崩溃后 engine.is_running 可能残留为 True（进程引用未清理），
            # 因此本次恢复必须绕过下面的幂等守卫。
            fatal_recovery = True
            self._fsm.mark_started()
            self._backoff_attempt = 0
        elif state is EngineState.DEAD:
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎已崩溃，正在重启中，请稍后重试")
        # 启动/停止经同一把锁串行（BUG-078 同族竞态）：空闲释放正在停止引擎时，
        # 本调用等待其完成后重新拉起（旧实现在锁外以 IDLE 早退 → 启动请求被静默丢弃）
        async with self._launch_lock:
            # 幂等守卫（BUG-080/BUG-119）：等待锁期间状态可能已变 → 锁内复判。空操作
            # 仅限健康运行态（`engine_healthy_running`：进程在 且 状态 ∈ RUNNING_STATES）；
            # 陈旧引用必须走 `_launch` 清场重启（停止完成会 mark_stopped() 回 STOPPED
            # 且 is_running=False，故不影响「停止窗口内的启动请求不得丢弃」MGR-24）。
            if not fatal_recovery:
                is_running = self._engine.is_running
                current = self._fsm.state
                if current is EngineState.DEAD:
                    # 恢复所有者独占（ISSUE-069）：等待锁期间崩落 DEAD（典型：本轮退避拉起
                    # 失败）→ 一律交退避链，**不得由本请求立即重拉**（否则管理端点击/
                    # 按需请求会绕过指数退避语义，与退避链形成"轮流拉起"）。
                    raise AppError(
                        ErrorCode.ENGINE_DEAD, "引擎已崩溃，正在重启中，请稍后重试"
                    )
                if current is EngineState.FATAL:
                    raise AppError(ErrorCode.ENGINE_FATAL, "引擎连续崩溃已停止，请手动重启")
                if engine_healthy_running(is_running=is_running, state=current):
                    # 三态回报（ISSUE-069）：加载/调优中与已就绪都是空操作，但回执文案
                    # 必须可区分——旧实现一律回报「引擎启动完成」（BUG-119 假成功）。
                    return (
                        LaunchOutcome.STARTING
                        if current is EngineState.INIT
                        else LaunchOutcome.ALREADY_RUNNING
                    )
                if engine_stale_process(is_running=is_running, state=current):
                    logger.warning(
                        "引擎进程引用陈旧（状态=%s，进程引用仍在），清场后重新拉起（%s）",
                        current.value,
                        reason,
                    )
            await self._launch(reason=reason)
            return LaunchOutcome.LAUNCHED

    async def _launch(self, *, reason: str = "按需加载") -> None:
        # 拉起前清场（BUG-054 同族）：FATAL 恢复等路径可能残留旧进程/引用（崩溃清
        # 理不保证）——先停旧再启新，避免新旧进程并存（GPU 资源泄漏）。
        started_at = self._monotonic()
        if self._engine.is_running:
            await self._engine.stop()
        self._begin_start_attempt()
        # 启动尝试开始 → INIT 并广播（BUG-101）：STOPPED（未启动）经 [启动]/按需拉起
        # 进入「加载中」必须显式广播——旧实现靠「初始态＝INIT」偶然呈现加载态，
        # STOPPED 语义拆分后不再成立（前端需 未启动→加载中→就绪 的完整链路）。
        self._fsm.mark_started()
        self._notify_state()
        # 冷启动按**最新配置**重建引擎实例（H-5 同族，BUG-097 补全）：模型文件/
        # 可执行文件/cfg 路径等变更「下次启动生效」必须真正重读配置（旧实例 argv
        # 构造时已固定；仅靠安全重启重建会在「引擎停止期间改配置」场景下继续用
        # 旧参数——恢复路径可再不可用）。重建失败（文件缺失等）按启动失败归因，
        # 不拉起进程、不进退避（待用户修正文件后重试）。
        if self._engine_factory is not None:
            try:
                new_engine = self._engine_factory(self._fsm)
            except ConfigError as exc:
                self._record_start_failure(f"引擎重建失败：{exc}")
                # 重建失败＝未运行（不进退避）；回落 STOPPED（未启动）供修正文件后 [启动] 重试，
                # 并广播真实状态（旧实现停留 INIT 且不广播，前端误呈「加载中」——语义混用）。
                self._fsm.mark_stopped()
                self._notify_state()
                logger.warning("引擎启动失败（%s，按最新配置重建失败）：%s", reason, exc)
                raise AppError(ErrorCode.ENGINE_FATAL, f"引擎重建失败: {exc}") from exc
            self._wire_engine_callbacks(new_engine)
            self._engine = new_engine
        try:
            await self._engine.start()
        except EngineStartError as exc:
            self._record_start_failure(f"引擎启动失败：{exc}")
            self._on_engine_down()
            logger.warning(
                "引擎启动失败（%s，耗时 %.1fs）", reason, self._monotonic() - started_at
            )
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎启动失败") from exc
        except EngineStoppedError as exc:
            # 两种来源：① 主动停止（服务关闭/空闲释放/安全重启/拉起前清场）——``stop()``
            # 先置 ``_stopping`` 再 fail 在途（含就绪握手 future）；② **启动期崩溃**——
            # 进程退出/读取任务故障 fail 在途握手（``_stopping`` 保持 False，崩溃回调
            # 可能已记账 DEAD/FATAL，也可能尚在竞态窗口）。
            # 分诊只依据事实（FSM 是否已记账 + 是否处于停止流程），不得按「进程引用还在
            # 不在」猜测：旧实现只判 ``state is DEAD``，把**已升级 FATAL** 或**回调未及
            # 执行**的启动期崩溃也当作主动停止 → ``mark_stopped()`` 抹掉 DEAD/FATAL 记账、
            # 恢复链断开，且残留 ``is_running`` 引用使后续 [启动] 静默空操作（BUG-119）。
            #
            # ⚠️ 不变式（ISSUE-069）：`AnalysisEngine.is_stopping` 为假 **即** 启动期崩溃。
            # 因此今后任何新增的「取消/中断启动」路径（超时放弃、用户取消、外部中止）
            # **必须**先置位引擎停止标志，否则会被误计为崩溃并触发指数退避（由
            # `ANA-28`/`MGR-65/66` 守门）。
            if self._fsm.state in (EngineState.DEAD, EngineState.FATAL):
                # 崩溃已记账：保持 DEAD（指数退避重启接管）/ FATAL（待手动重启）
                logger.warning("引擎启动失败（%s，启动期进程退出）", reason)
                raise AppError(ErrorCode.ENGINE_DEAD, "引擎启动失败（进程退出）") from exc
            if self._stopping or self._engine.is_stopping:
                # 主动停止/清场导致的中断：进程已不在运行（或正在回收）→ 显式回落
                # STOPPED（未启动）并广播，不得停在 INIT（否则前端永久「加载中」且无
                # 任何加载进行，BUG-101 口径）。
                self._fsm.mark_stopped()
                self._notify_state()
                logger.warning("引擎启动被中断（%s，已停止）", reason)
                raise AppError(ErrorCode.ENGINE_DEAD, "引擎启动被中断（已停止）") from exc
            # 启动期崩溃（崩溃回调处于竞态窗口，FSM 仍 INIT）：就地按崩溃记账——DEAD →
            # 指数退避重启；5 分钟窗内超限 → FATAL。回落 STOPPED 会把崩溃掩盖成
            # 「未启动」（旧实现），恢复链与归因一并丢失（BUG-119）。
            self._record_start_failure("引擎启动失败（进程退出）")
            self._on_engine_down()
            logger.warning("引擎启动失败（%s，启动期进程退出）", reason)
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎启动失败（进程退出）") from exc
        except OSError as exc:
            # 进程创建失败（如缺少 OpenCL.dll/DLL 加载失败 WinError 126、可执行文件损坏）：
            # 与启动超时同语义——记录归因 + 进退避重启（BUG-097：不得裸抛退化 INTERNAL_ERROR）
            self._record_start_failure(f"引擎进程创建失败：{exc}")
            self._on_engine_down()
            logger.warning(
                "引擎启动失败（%s，进程创建异常，耗时 %.1fs）",
                reason,
                self._monotonic() - started_at,
            )
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎启动失败（进程创建异常）") from exc
        if self._stopping:
            # 关闭与启动交错（评审）：启动完成时管理器已停止 → 立即回收，
            # 不得到“启动后无人管理”的孤儿进程。
            await self._engine.stop()
            self._fsm.mark_stopped()
            logger.warning("引擎启动被中断（%s，管理器已停止），进程已回收", reason)
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎启动被中断（管理器已停止）")
        self._backoff_attempt = 0
        self._record_start_success()
        # 启动即复位空闲计时（BUG-078）：服务已运行超 idle_timeout 时，
        # 新启动的引擎若不复位会被下一个监控周期（≤5s）立即判空闲释放
        self.mark_activity()
        self._drain_pending()
        self._notify_state()
        # 启动事件落应用日志（BUG-082）：与「引擎空闲超时，已释放资源」配对成完整
        # 生命周期记录（engine.log 仅有子进程自身输出，排查时无法对齐触发原因）。
        logger.info("引擎已启动（%s，耗时 %.1fs）", reason, self._monotonic() - started_at)

    async def stop_engine(self, *, only_if_idle: bool = False) -> bool:
        """停止引擎（空闲超时 / 手动 stop 共用）；不改变崩溃语义。

        - 与 ``ensure_ready`` 经 ``_launch_lock`` 串行：停止进行中的 ``ensure_ready``
          会等停止完成后重新启动（旧实现在 IDLE 早退 → 启动请求被静默丢弃）；
        - ``only_if_idle=True``（空闲监控路径）：获得锁后**二次判定**空闲——等待
          期间若引擎已重新启动/有新活动（如前端自动拉起、新查询）则放弃本次释放。
        H-2/M-8 修复保留：引擎停止前先 fail 未执行的 stop/restart 请求，
        避免已入队的 Future 永久挂起（admin.task 永不返回）。
        @returns 是否实际执行了停止（False=未运行或二次判定放弃；供日志对齐 BUG-081）
        """
        async with self._launch_lock:
            if not self._engine.is_running:
                return False
            if only_if_idle and not self._is_idle_timeout_reached():
                return False  # 竞态：等待锁期间出现新启动/新活动 → 不释放
            self._fail_pending_requests()
            # L-3：停止前收敛 benchmark 会话（失败调优的进度/休眠标志不得跨实例残留）
            self._reset_benchmark_state()
            await self._engine.stop()
            self._fsm.mark_stopped()  # 干净停止 → STOPPED（未启动）
            self._notify_state()
            return True

    def request_stop(self) -> asyncio.Future:
        """请求安全停止（REST `202 Accepted` 语义）：仅引擎 IDLE 执行，忙时入队。

        执行结果经 ``/ws/admin`` 推送（``admin.task``）；引擎未运行时立即完成。
        """
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        if not self._engine.is_running:
            if not fut.done():
                fut.set_result(None)
            return fut
        self._pending_stops.append(fut)
        self._maybe_drain_stops()
        return fut

    def _maybe_drain_stops(self) -> None:
        if not self._pending_stops:
            return
        if self._fsm.state is not EngineState.IDLE or not self._engine.is_running:
            return
        if self._stop_task is not None and not self._stop_task.done():
            return
        self._stop_task = asyncio.create_task(
            self._drain_stops(), name="engine-safe-stop"
        )

    async def _drain_stops(self) -> None:
        while (
            self._pending_stops
            and self._fsm.state is EngineState.IDLE
            and self._engine.is_running
        ):
            fut = self._pending_stops.pop(0)
            try:
                stopped = await self.stop_engine()
                if stopped:
                    # 管理端停止同样落应用日志（真实事实对齐：仅实际停止后记录）
                    logger.info("引擎已停止（管理端请求）")
                if not fut.done():
                    fut.set_result(None)
            except Exception as exc:  # noqa: BLE001 - 停止失败通知调用方
                if not fut.done():
                    fut.set_exception(exc)
        # M-2（决策 B）：停止期间新入队的请求不会再有执行机会 → 一并快速失败
        # （旧实现：引擎已 STOPPED 后残留 stop 挂起，直至下次拉起时误停新实例）
        self._fail_pending_requests()

    # ---- 查询入口 ----

    async def submit(self, query: dict, *, timeout_s: Optional[float] = None) -> dict:
        """提交查询（P0-P3）：按需加载 + 状态保护 + 空闲计时。"""
        await self.ensure_ready()
        if self._fsm.state not in QUERY_STATES:
            raise _map_fsm_error(self._fsm.state)
        self.mark_activity()
        try:
            return await self._engine.query(query, timeout_s=timeout_s)
        except EngineStoppedError as exc:
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用") from exc
        except EngineFsmError as exc:
            raise _map_fsm_error(exc.state) from exc
        finally:
            # H-2 修复：查询结束可能回到 IDLE，统一检查待执行的 stop/restart 请求
            self._drain_pending()

    def mark_activity(self) -> None:
        """标记活跃（空闲计时复位）。"""
        self._last_activity = self._monotonic()

    async def terminate(self, query_id: str) -> bool:
        """请求中断在途查询（转发 ``AnalysisEngine.terminate``；引擎未运行 → False）。

        悔棋等场景经此中止在途 AI 应手的 P0 查询（KataGo terminate，尽力而为：
        引擎返回已完成的**部分结果**，由调用方丢弃）。
        """
        try:
            return await self._engine.terminate(query_id)
        except EngineStoppedError:
            return False

    def _drain_pending(self) -> None:
        """引擎可能回到 IDLE 时统一尝试消化已入队的 stop/restart 请求。"""
        self._maybe_drain_restarts()
        self._maybe_drain_stops()

    def _fail_pending_requests(self, reason: str = "引擎已停止") -> None:
        """引擎不可用（停止/FATAL）：尚未执行的 stop/restart 请求无法再执行 → 失败收尾。

        M-2（2026/09/19 决策 B：全面失效化）：取消「排队的 restart 等引擎下次启动
        消化」语义——引擎进入 STOPPED/FATAL 时所有挂起请求**一律快速失败**，不再
        跨引擎实例排队（旧实现：FATAL 后 restart Future 永不消化；停止期间入队的
        stop 会在引擎下次拉起时误停新实例）。
        """
        if not self._pending_restarts and not self._pending_stops:
            return
        exc = EngineStoppedError(f"{reason}，挂起的 stop/restart 请求被取消")
        for fut in self._pending_restarts + self._pending_stops:
            if not fut.done():
                fut.set_exception(exc)
        self._pending_restarts.clear()
        self._pending_stops.clear()

    # ---- 安全重启（202 Accepted 语义） ----

    def request_restart(self) -> asyncio.Future:
        """提交安全重启请求；返回完成 Future（引擎空闲后执行）。

        M-2（决策 B）：引擎未运行 → 立即失败，不挂起等待「下次启动」（调用方——
        管理端三个入口——均在 ``is_running`` 校验后调用，此处为防御性兜底）。
        """
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        if not self._engine.is_running:
            fut.set_exception(EngineStoppedError("引擎未运行，重启请求已取消"))
            return fut
        self._pending_restarts.append(fut)
        self._maybe_drain_restarts()
        return fut

    def _maybe_drain_restarts(self) -> None:
        if not self._pending_restarts:
            return
        if self._fsm.state is not EngineState.IDLE or not self._engine.is_running:
            return
        if self._drain_task is not None and not self._drain_task.done():
            return
        self._drain_task = asyncio.create_task(
            self._drain_restarts(), name="engine-safe-restart"
        )

    async def _drain_restarts(self) -> None:
        while (
            self._pending_restarts
            and self._fsm.state is EngineState.IDLE
            and self._engine.is_running
        ):
            fut = self._pending_restarts.pop(0)
            try:
                await self._do_safe_restart()
                if not fut.done():
                    fut.set_result(None)
            except Exception as exc:  # noqa: BLE001 - 重启失败通知调用方
                if not fut.done():
                    fut.set_exception(exc)
        # M-2（决策 B）：重启链中断（引擎已停止/FATAL）→ 剩余挂起请求快速失败
        self._fail_pending_requests()

    async def _do_safe_restart(self) -> None:
        """引擎空闲时安全重启（模型/线程参数变更触发，ARCHITECTURE §3.2）。

        H-5/模型切换修复：注入 ``engine_factory`` 时停止旧引擎后**重建**引擎实例——
        模型文件/可执行文件/cfg 路径等变更只有重建才会生效（旧实例 argv 构造时已固定）；
        重建失败（如模型文件缺失）→ FSM 回落 STOPPED（未启动），请求方收到失败。

        与启动/释放经同一把 ``_launch_lock`` 串行（评审修复）：旧实现重启在锁外
        stop+start，与排队的 stop／ensure_ready 存在并发窗口（重启与停止互相覆盖、
        结果依赖调度时机）；重启完成后再 ``_drain_pending``，保证忙时入队的请求按序消化。
        """
        async with self._launch_lock:
            started_at = self._monotonic()
            await self._engine.stop()
            self._backoff_attempt = 0
            # BUG-135：重启窗口必须显式广播 INIT（「加载中」），与 ``_launch`` 同口径。
            # 旧实现在此零广播——``engine.stop()`` 不触碰 FSM，新实例 ``start()`` 内的
            # ``mark_started()`` 只改状态不通知监听者，唯一广播在重启**完成后**（已 IDLE）
            # → 前端胶囊在整段重启（停旧/重建/装载权重，可达数十秒）停留旧态。
            # 位置须在 ``stop()`` 之后：旧进程引用已释放（``is_running`` 为假），INIT
            # 不会让 ``ensure_ready`` 的幂等守卫把重启中的引擎误判为「已在运行」。
            self._fsm.mark_started()
            self._notify_state()
            if self._engine_factory is not None:
                try:
                    new_engine = self._engine_factory(self._fsm)
                except ConfigError as exc:
                    self._begin_start_attempt()
                    self._record_start_failure(f"引擎重建失败：{exc}")
                    self._fsm.mark_stopped()
                    self._notify_state()
                    raise AppError(ErrorCode.ENGINE_FATAL, f"引擎重建失败: {exc}") from exc
                self._wire_engine_callbacks(new_engine)
                self._engine = new_engine
            self._begin_start_attempt()
            try:
                await self._engine.start()
            except (EngineStartError, OSError) as exc:
                # 启动超时/进程创建失败（缺 DLL 等）：记录归因 + **按崩溃记账**，与 `_launch`
                # 同口径（BUG-135）。旧实现只记录失败事实就抛：FSM 停在 INIT（无任何加载
                # 在进行）且不广播 → 前端永久「加载中」（BUG-101 明令禁止的形态），归因
                # （`reason`/`detail` 仅在 DEAD/FATAL 随快照下发）与退避恢复链一并丢失。
                self._record_start_failure(f"引擎重启失败：{exc}")
                self._on_engine_down()
                logger.warning(
                    "引擎启动失败（安全重启，耗时 %.1fs）：已按崩溃记账，退避链接管恢复",
                    self._monotonic() - started_at,
                )
                raise
            if self._stopping:
                # 关闭与重启交错：立即回收（同 _launch 口径，不得留孤儿进程）
                await self._engine.stop()
                self._fsm.mark_stopped()
                raise AppError(ErrorCode.ENGINE_DEAD, "引擎重启被中断（管理器已停止）")
            self._record_start_success()
            self.mark_activity()  # 安全重启成功同复位空闲计时（BUG-078）
            self._notify_state()
            self._drain_pending()
            logger.info(
                "引擎已启动（安全重启：配置/模型变更生效，耗时 %.1fs）",
                self._monotonic() - started_at,
            )

    # ---- 崩溃与退避重启 ----

    def _on_engine_down(self) -> None:
        """引擎崩溃/启动失败：FSM 标记 + 指数退避调度重启（FATAL 除外）。

        启动阶段（INIT）失败先记录失败事实（stderr 错误行优先；BUG-097），
        运行期崩溃（IDLE/ANALYZING，如显存耗尽）不改变「启动失败」归因语义。

        服务关闭期（``self._stopping``，如 Ctrl+C 交错：控制台信号先杀引擎、
        关闭序列随后到达）的引擎退出属**预期**：不得崩溃记账/退避调度/广播
        （BUG-100，2026/09/18 人工反馈：关闭被误报为「启动即崩溃」）。
        """
        if self._stopping:
            logger.info("引擎在管理器停止期间退出（按正常停止处理）")
            return
        # L-3：崩溃路径同样收敛 benchmark 会话（否则进度残留 + 握手延长逻辑不复位）
        self._reset_benchmark_state()
        if self._fsm.state is EngineState.STOPPED:
            # 已确认停止（干净停止/重建失败回落）后的进程退出属预期残留事件：
            # ``mark_crashed`` 仅接受 INIT/IDLE/ANALYZING，旧实现在此抛 EngineFsmError
            # 被 ``_watch_process`` 吞掉（仅记日志）→ 崩溃事实丢失、FSM 停在 STOPPED
            # 而 ``is_running`` 失真（BUG-119）。此处按事实忽略，不误记账/不错误退避。
            logger.info("引擎在已停止状态下退出（不记账为崩溃）")
            return
        if self._fsm.state is EngineState.INIT:
            self._record_start_failure("引擎进程启动阶段退出（详见引擎日志）")
        self._fsm.mark_crashed(now=self._monotonic())
        if self._fsm.state is EngineState.FATAL:
            # M-2（决策 B）：FATAL 为终态（不再自动拉起）→ 挂起的 stop/restart
            # 快速失败（旧实现：restart Future 永久挂起，admin.task 永不返回）
            self._fail_pending_requests("引擎连续崩溃已进入 FATAL")
            self._notify_state()
            return
        self._schedule_restart(delay=self._backoff_delay())
        self._notify_state()

    def _backoff_delay(self) -> float:
        self._backoff_attempt += 1
        exponent = self._backoff_attempt - 1
        return min(self._backoff_base_s * (2**exponent), self._max_backoff_s)

    def _schedule_restart(self, delay: float) -> None:
        # 重入保护（BUG-081）：仅当已有**其它**在途重启任务时跳过——旧实现把
        # 「当前正在运行的 _delayed_restart」也当作在途任务拦截，导致重新拉起失败
        # 后无人再排下一轮退避（重启链永久中断，DEAD 状态实际永不自愈）。
        current = self._restart_task
        if (
            current is not None
            and not current.done()
            and current is not asyncio.current_task()
        ):
            return
        self._restart_task = asyncio.create_task(
            self._delayed_restart(delay), name="engine-restart"
        )

    async def _delayed_restart(self, delay: float) -> None:
        await self._sleep(delay)
        if self._stopping or self._fsm.state is EngineState.FATAL:
            return
        # H-1 修复（2026-09-19 代码审查）：清场 + 拉起必须与 ``ensure_ready``/
        # ``_launch``/``stop_engine`` 同持 ``_launch_lock``——旧实现在锁外 stop+start，
        # 与并发 ``ensure_ready`` 的幂等守卫窗口（spawn 期 ``_process=None`` 且
        # FSM=INIT）重叠会双拉起 KataGo：后者覆盖 ``_process``/``_read_tasks``，
        # 先者 ``_wait_ready`` 超时后的清理会误杀健康进程（孤儿进程占用 GPU）。
        async with self._launch_lock:
            # 等待锁期间状态可能已变化（关闭/终态/其它路径已恢复）→ 锁内复判
            if self._stopping or self._fsm.state is EngineState.FATAL:
                return
            if (
                self._engine.is_running
                and self._fsm.state in (EngineState.IDLE, EngineState.ANALYZING)
            ):
                # 其它路径（管理端启动/按需拉起/另一轮退避）已完成恢复：
                # 重启用意已达成，禁止再停健康进程重拉
                return
            # 旧进程清理（BUG-054）：正常崩溃时旧进程已死（stop 幂等兜底）；读取任务
            # 故障场景进程可能仍存活（管道堵塞）——必须先停止，否则新旧进程并存
            # （GPU 资源泄漏）。注意不能因 is_running 为假而跳过 start：崩溃路径依赖
            # 此处重新拉起（启动失败清理由 AnalysisEngine.start 保证）。
            started_at = self._monotonic()
            try:
                if self._engine.is_running:
                    await self._engine.stop()
                self._begin_start_attempt()
                await self._engine.start()
            except (EngineStartError, EngineStoppedError) as exc:
                if self._stopping:
                    return
                # EngineStoppedError：启动期崩溃（读流提前失败）同属启动失败，不得打
                # 全量 Traceback 误当「异常」；后续仍由退避链重试
                self._record_start_failure(f"引擎启动失败（崩溃退避重启）：{exc}")
                logger.warning(
                    "引擎启动失败（崩溃退避重启，耗时 %.1fs），将按退避继续重试",
                    self._monotonic() - started_at,
                )
                self._on_engine_down()
                return
            except Exception:  # noqa: BLE001 - 清场/拉起异常同样进入退避链（不得中断重启）
                if self._stopping:
                    return
                self._record_start_failure("崩溃退避重启异常（详见引擎日志）")
                logger.exception("引擎退避重启异常（将按退避重试）")
                self._on_engine_down()
                return
            self._backoff_attempt = 0
            self._record_start_success()
            self.mark_activity()  # 重启成功同复位空闲计时（BUG-078）
            self._drain_pending()
            self._notify_state()
            logger.info(
                "引擎已启动（崩溃退避重启，耗时 %.1fs）", self._monotonic() - started_at
            )

    # ---- 空闲超时 ----

    def _has_active_connections(self) -> bool:
        """是否存在活跃的对弈/复盘连接（未注入 activity_fn 时恒 False）。"""
        return bool(self._activity_fn and self._activity_fn())

    async def _auto_start_if_needed(self) -> None:
        """活跃连接存在而引擎未运行（空闲释放/未启动/手动停止）→ 自动拉起。

        仅 ``engine_launchable``（未运行 且 状态 ∈ ``LAUNCHABLE_STATES``：STOPPED 未启动 /
        INIT 启动尝试窗口，幂等补发）时执行；崩溃（DEAD）由指数退避链、FATAL 由管理端
        手动重启负责——**恢复所有者不得交叉**（ISSUE-069），避免与退避重启并发重复拉起。
        """
        if self._stopping or self._resident or self._engine.is_running:
            return
        if not engine_launchable(is_running=False, state=self._fsm.state):
            return
        try:
            await self.ensure_ready(reason="活跃连接自动拉起")
        except AppError as exc:  # noqa: BLE001 - 自动拉起失败不阻断监控（崩溃路径接管）
            logger.warning("活跃连接下引擎自动拉起失败：%s", exc)

    async def _release_if_idle(self) -> bool:
        """空闲释放（监控路径）：仅在**真正完成停止**后记录「已释放」日志。

        判定统一收敛到 ``stop_engine`` 的锁内二次判定（BUG-078）：等待启动/停止锁
        期间出现新活动（或引擎已停止）即放弃；旧实现先记日志再尝试停止，竞态放弃时
        日志与事实不符（BUG-081：误导排查——“日志说释放了，其实没释放”）。
        """
        if not self._is_idle_timeout_reached():
            return False
        if not await self.stop_engine(only_if_idle=True):
            logger.debug("空闲释放未执行（引擎已停止或等待锁期间出现新活动）")
            return False
        logger.info("引擎空闲超时，已释放资源")
        return True

    async def _idle_monitor(self) -> None:
        while not self._stopping:
            await self._sleep(self._idle_poll_s)
            try:
                # 有活跃对弈/复盘连接：空闲计时清零不计时（不释放），引擎停止则自动拉起
                if self._has_active_connections():
                    self.mark_activity()
                    await self._auto_start_if_needed()
                    continue
                await self._release_if_idle()
            except Exception:  # noqa: BLE001 - 单轮异常不得让空闲监控永久停摆
                # 释放路径可能抛非预期异常（如 terminate/kill 竞态 OSError）；
                # 监控是长驻保活任务，异常吞掉不重试将导致释放/自愈永久失效
                # （CancelledError 属 BaseException，不受此捕获影响）。
                logger.exception("引擎空闲监控单轮异常（已跳过，下一轮继续）")

    def _is_idle_timeout_reached(self) -> bool:
        if self._resident or self._idle_timeout_s <= 0:
            return False
        if not self._engine.is_running:
            return False
        # 仅 IDLE 可空闲释放（BUG-081）：INIT（启动/握手/调优进行中）、ANALYZING
        # （在途任务，另由 active_queries 防护）与 DEAD/FATAL（崩溃恢复/终态，由
        # 退避重启与手动重启管理）均不得被空闲监控释放——旧实现下启动中的引擎
        # 会被误判「空闲超时」并尝试释放（阻塞到启动完成才放弃，且先记录误导日志）。
        if self._fsm.state is not EngineState.IDLE:
            return False
        if self._fsm.active_queries > 0:
            return False
        return self._monotonic() - self._last_activity >= self._idle_timeout_s

    # ---- 首次 benchmark 进度 ----

    def _handle_stderr_line(self, line: str) -> None:
        """stderr 逐行回调：backend 识别 + 失败归因窗口 + benchmark 解析（各自独立）。"""
        self._recent_stderr.append(line)
        self._detect_backend(line)
        self._benchmark_parser.feed(line)

    def _detect_backend(self, line: str) -> None:
        """从 stderr 识别真实后端/设备（首匹配生效；命中即记，不影响其它行）。"""
        for pattern, backend in _BACKEND_MARKERS:
            match = pattern.search(line)
            if match is None:
                continue
            if self._backend is None:
                self._backend = backend
            if self._backend == backend and self._backend_device is None:
                device = match.groupdict().get("device")
                if device:
                    self._backend_device = _normalize_device_name(device)
            return

    def _begin_start_attempt(self) -> None:
        """开始一次启动尝试：清空 stderr 窗口与上一轮失败事实（归因只取本轮输出）。"""
        self._recent_stderr.clear()
        self._last_start_failure = None

    def _record_start_failure(self, fallback: str) -> None:
        """记录启动失败事实（优先 stderr 本轮错误行；本轮已有记录则保留首条）。"""
        cause = _pick_stderr_cause(self._recent_stderr)
        if cause is not None:
            self._last_start_failure = cause
        elif self._last_start_failure is None:
            self._last_start_failure = fallback

    def _record_start_success(self) -> None:
        """启动成功：清除失败事实（快照恢复 `reason=null`）。"""
        self._last_start_failure = None

    def _on_benchmark_start(self) -> None:
        self._engine.benchmarking = True
        self._benchmark_progress = 0
        self._notify_state()

    def _on_benchmark_progress(self, percent: int, phase: str) -> None:
        self._benchmark_progress = percent
        self._notify_state()

    def _on_benchmark_end(self) -> None:
        self._engine.benchmarking = False
        self._benchmark_progress = None
        self._notify_state()

    def _reset_benchmark_state(self) -> None:
        """收敛 benchmark 会话状态（L-3）。

        旧实现 ``BenchmarkParser.reset()`` 零调用——调优中途失败（无 Done 行）时
        ``benchmarking`` 与进度永久残留（前端一直「调优中」；握手延长逻辑同样不回归）；
        引擎停机/崩溃时调用本入口清零（`reset()` + 进度 + 休眠标志）。
        """
        self._benchmark_parser.reset()
        self._benchmark_progress = None
        self._engine.benchmarking = False
        self._notify_state()
