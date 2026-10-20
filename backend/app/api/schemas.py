"""Pydantic 请求/响应模型（TASK T4.1，API §3/§4 强绑定）。

- REST：对局/档案/管理全部请求与响应模型；
- WS：统一信封 `{type, seq, data}` + 各消息 data 载荷；
- 校验规则：`color` B/W、12 档 `rank`、模式/棋盘/规则/让子/难度档位等，
  均与服务层（`game_service`）约束一致（AGENTS.md §2 强类型校验）。
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.config import BOARD_SIZES, RANK_LEVELS, RULESETS

#: 对局模式 / 执色 / AI 风格（与 DATABASE §3.2 / game_service 约束一致）
Mode = Literal["human_ai", "human_human"]
Color = Literal["B", "W"]
AiStyle = Literal["standard", "human"]
GameStatus = Literal["created", "active", "scoring", "finished"]
Perspective = Literal["B", "W"]

#: WS 消息类型（API §4.3/§4.4）
#: ``start``（开局/续行：created→PLAYING；人机轮到 AI 时触发 AI 落子）与
#: ``restart``（重开：同参数重置回 created）为 T6.4 新增（对弈基础流）。
WS_CLIENT_TYPES = (
    "start",
    "play",
    "pass",
    "resign",
    "undo",
    "undo.respond",
    "restart",
    "scoring.confirm",
    "scoring.cancel",
    # 结算准备（2026/09/19 人工决策方案 A）：未结算终局（导入棋谱）触发死子预判
    "scoring.prepare",
    "coaching.request",
    "ownership.request",
    "deep_analysis.request",
    "recommend.request",
    "global_analysis.request",
    "global_analysis.cancel",
    # T6.8 试下分支（后端试下：规则校验/会话缓存，TASK T6.8/PRD §4.2.3）
    "trial.enter",
    "trial.play",
    "trial.pass",
    "trial.undo",
    "trial.back_to_real",
    "restore.request",
    "ping",
)


def _check_color(value: str) -> str:
    if value not in ("B", "W"):
        raise ValueError("执子颜色仅支持 B/W")
    return value


def _check_rank(value: Optional[str]) -> Optional[str]:
    if value is not None and value not in RANK_LEVELS:
        raise ValueError(f"段位必须为 12 档之一: {RANK_LEVELS}")
    return value


def _check_board_size(value: int) -> int:
    if value not in BOARD_SIZES:
        raise ValueError(f"棋盘大小仅支持 {BOARD_SIZES}")
    return value


def _check_rules(value: str) -> str:
    if value not in RULESETS:
        raise ValueError(f"规则集仅支持 {RULESETS}")
    return value


def _check_handicap(value: int) -> int:
    if value != 0 and not (2 <= value <= 9):
        raise ValueError("让子数仅支持 2-9 子（0=分先）")
    return value


# ============================================================
# REST 对局（API §3.1）
# ============================================================


class PlayerIn(BaseModel):
    """参与方录入（姓名/段位可选；未录入姓名默认 `真人`）。"""

    name: Optional[str] = Field(default=None, max_length=64, description="姓名")
    rank: Optional[str] = Field(default=None, description="段位（12 档之一）")

    _rank_ok = field_validator("rank")(_check_rank)


class AiIn(BaseModel):
    """人机 AI 参数。"""

    style: AiStyle = Field(default="standard", description="AI 风格 standard|human")
    level: Optional[int] = Field(default=None, ge=1, le=12, description="难度档位 1-12")
    adaptive: bool = Field(default=False, description="自适应难度")

    @model_validator(mode="after")
    def _check_level_required(self) -> "AiIn":
        # 未录入段位时需手动选择难度；服务层在 create 时校验（此处仅格式校验）
        return self


class CreateGameRequest(BaseModel):
    """创建对局请求（API §3.1.1）。"""

    model_config = ConfigDict(extra="forbid")

    mode: Mode = Field(default="human_human", description="对局模式")
    board_size: int = Field(default=19, description="棋盘大小 9/13/19")
    rules: str = Field(default="chinese", description="规则集 chinese/japanese/aga")
    komi: Optional[float] = Field(default=None, description="贴目（缺省=默认；让子默认 0）")
    handicap: int = Field(default=0, description="让子 0/2-9")
    color: Color = Field(default="B", description="人机：人类执子颜色（默认 B）")
    black: PlayerIn = Field(default_factory=PlayerIn, description="黑方（姓名/段位可选）")
    white: PlayerIn = Field(default_factory=PlayerIn, description="白方（姓名/段位可选）")
    ai: Optional[AiIn] = Field(default=None, description="人机 AI 参数（人人省略）")
    coaching: bool = Field(default=False, description="支招（对弈中按需触发）")

    _board_ok = field_validator("board_size")(_check_board_size)
    _rules_ok = field_validator("rules")(_check_rules)
    _handicap_ok = field_validator("handicap")(_check_handicap)


class CreateGameResponse(BaseModel):
    """创建对局响应 `{game_id}`（API §3.1.1）。"""

    game_id: int


class FavoriteRequest(BaseModel):
    """收藏/取消收藏（API §3.1）。"""

    favorite: bool = Field(description="true=收藏 false=取消")


# ============================================================
# REST 档案（API §3.2）
# ============================================================


# ============================================================
# REST 管理（API §3.3）
# ============================================================


class ConfigUpdate(BaseModel):
    """配置更新载荷（分层落地，全部可选部分更新）。

    - 应用级 / 引擎 cfg 级期望值 → 更新 ``config.yaml``；
    - 引擎 cfg 级（``num_analysis_threads``/``num_search_threads_per_analysis_thread``）
      或默认模型变更 → 触发引擎安全重启（202 Accepted）；
    - 交叉校验 ``deep_max_visits > standard_max_visits``（Pydantic + AppConfig）。
    """

    model_config = ConfigDict(extra="forbid")

    standard_max_visits: Optional[int] = Field(default=None, ge=1)
    deep_max_visits: Optional[int] = Field(default=None, ge=1)
    num_analysis_threads: Optional[int] = Field(default=None, ge=1)
    num_search_threads_per_analysis_thread: Optional[int] = Field(default=None, ge=1)
    analysis_pv_len: Optional[int] = Field(default=None, ge=5, le=15)
    resident: Optional[bool] = None
    idle_timeout_s: Optional[int] = Field(default=None, ge=0)
    executable_dir: Optional[str] = Field(default=None, max_length=512)
    model_dir: Optional[str] = Field(default=None, max_length=512)
    standard_model: Optional[str] = Field(default=None, max_length=256)
    human_model: Optional[str] = Field(default=None, max_length=256)
    analysis_cfg: Optional[str] = Field(default=None, max_length=512)
    adaptive_initial_level: Optional[str] = None
    max_undo: Optional[int] = Field(default=None, ge=0)
    default_board_size: Optional[int] = None
    default_rules: Optional[str] = None
    default_komi: Optional[float] = None
    default_human_color: Optional[str] = None
    max_moves: Optional[int] = Field(default=None, ge=1)
    variation_preview_len: Optional[int] = Field(default=None, ge=1, le=30)
    system_status_interval_s: Optional[int] = Field(default=None, ge=1)
    logging_level: Optional[str] = Field(default=None, pattern="^(DEBUG|INFO|WARNING|ERROR)$")
    logging_max_bytes: Optional[int] = Field(default=None, ge=1024)
    logging_backup_count: Optional[int] = Field(default=None, ge=0)

    _adaptive_rank_ok = field_validator("adaptive_initial_level")(_check_rank)
    _board_ok2 = field_validator("default_board_size")(lambda v: None if v is None else _check_board_size(v))
    _rules_ok2 = field_validator("default_rules")(lambda v: None if v is None else _check_rules(v))
    _color_ok = field_validator("default_human_color")(lambda v: None if v is None else _check_color(v))


class SetDefaultModelRequest(BaseModel):
    """设置默认标准模型（API §3.3）。"""

    model: str = Field(min_length=1, max_length=256, description="模型文件名（model_dir 下）")


class AppUpdateRequest(BaseModel):
    """应用更新（API §3.3，2026/10/18）。"""

    model_config = ConfigDict(extra="forbid")

    version: Optional[str] = Field(
        default=None,
        max_length=64,
        description="目标版本（可省略；提供时须与最新 Release 一致，防过期操作）",
    )


class EngineDownloadRequest(BaseModel):
    """KataGo 官方资产下载（版本/资产名均来自检查接口，服务端二次校验）。"""

    model_config = ConfigDict(extra="forbid")

    release_tag: str = Field(min_length=1, max_length=64, description="KataGo Release tag，如 v1.18.1")
    asset_name: str = Field(min_length=1, max_length=256, description="官方资产文件名")


class ModelDownloadRequest(BaseModel):
    """官方模型下载（标准模型来自 katagotraining，人类模型来自 KataGo v1.15.0 Release）。"""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["standard", "human"] = Field(description="standard=标准模型；human=人类模型")
    name: str = Field(min_length=1, max_length=256, description="模型文件名（*.bin.gz）")


class AcceptedResponse(BaseModel):
    """异步任务受理响应（202 Accepted，API §3.3 安全重启语义）。"""

    status: str = Field(default="accepted", description="accepted")
    message: str = Field(description="任务说明")
    task: str = Field(description="任务类型 start/stop/set_model/restart")
    restart_warning: Optional[str] = Field(
        default=None, description="模型/引擎参数变更：引擎将在空闲时重启的提示"
    )
    task_queued: Optional[bool] = Field(
        default=None,
        description=(
            "是否已排入异步任务（结果经 `admin.task` 推送）：true＝已排队，等待回执；"
            "false＝本次仅落配置/无动作（如引擎未运行时不排队），**不会有回执**——"
            "前端不得进入「已排队/已受理」等待态（BUG-138）"
        ),
    )


class AdminEnginesResponse(BaseModel):
    """引擎状态（API §3.3 / §4.4 engine.status）。"""

    state: str = Field(description="STOPPED/INIT/IDLE/ANALYZING/DEAD/FATAL（STOPPED=未启动；INIT=启动/加载中）")
    progress: Optional[int] = Field(default=None, description="INIT 加载/benchmark 进度")
    humanModelAvailable: bool = Field(default=True, description="人类模型可用性")
    reason: Optional[str] = Field(
        default=None,
        description=(
            "引擎不可用原因（可选机器码，与「连续崩溃」语义区分，供前端文案对齐）："
            "standard_model_missing＝标准模型缺失；engine_executable_missing＝katago "
            "可执行文件缺失；startup_failed＝引擎进程启动失败（detail 携带 stderr 摘要）"
        ),
    )
    detail: Optional[str] = Field(
        default=None,
        description="原因的人类可读说明（缺失路径说明 / stderr 错误行摘录；无原因=null）",
    )


class AdminSystemResponse(BaseModel):
    """系统状态（API §3.3 / §4.4 system.status）。"""

    host: str = Field(description="主机名")
    os: str = Field(description="操作系统")
    cpu_count: int = Field(description="逻辑 CPU 数")
    memory_usage: dict = Field(description="内存使用 {total, used, percent}")
    disk_usage: Optional[dict] = Field(default=None, description="磁盘使用")
    gpu: Optional[str] = Field(default=None, description="NVIDIA GPU 摘要（非 NVIDIA=null/不支持）")
    backend: Optional[str] = Field(
        default=None,
        description="KataGo 实际后端（stderr 检测，如 `OpenCL · NVIDIA GeForce GTX 1660`；未检测=null）",
    )


# ============================================================
# WS 信封与消息载荷（API §4）
# ============================================================


class WsEnvelope(BaseModel):
    """统一消息信封 `{type, seq, data}`（API §4.1）。"""

    type: str = Field(min_length=1, max_length=64, description="消息类型")
    seq: Optional[int] = Field(default=None, ge=0, description="客户端序号（错误回显）")
    data: Optional[dict] = Field(default=None, description="消息载荷（可缺省）")

    @field_validator("type")
    @classmethod
    def _type_known(cls, v: str) -> str:
        if v not in WS_CLIENT_TYPES:
            raise ValueError(f"未知消息类型: {v}（仅支持 {WS_CLIENT_TYPES}）")
        return v


class WsPlay(BaseModel):
    """落子载荷 `{x, y}`（color 可选：服务端唯一事实源推导）。"""

    x: int = Field(ge=0, le=18, description="横坐标 0-18")
    y: int = Field(ge=0, le=18, description="纵坐标 0-18")
    color: Optional[Color] = Field(default=None, description="可选：请求方执色（缺省服务端推导）")


class WsScoringConfirm(BaseModel):
    """死子校正确认载荷 `{dead_points: [[x,y],...]}`。"""

    dead_points: list[tuple[int, int]] = Field(default_factory=list, description="死子坐标列表")

    @field_validator("dead_points")
    @classmethod
    def _points_in_board(cls, v: list[tuple[int, int]]) -> list[tuple[int, int]]:
        for x, y in v:
            if not (0 <= x <= 18 and 0 <= y <= 18):
                raise ValueError(f"死子坐标越界: ({x},{y})")
        return v


class WsOwnershipRequest(BaseModel):
    """领地请求载荷 `{move_no?, trial_id?}`（缺省 move_no=当前局面）。

    - ``trial_id`` 可选：试下分支领地（读会话缓存，DATABASE §3.4 试下语义）；
    - 新增字段可选（向后兼容，API §1）。
    """

    move_no: Optional[int] = Field(default=None, ge=0, description="局面手数（缺省=当前）")
    trial_id: Optional[int] = Field(default=None, ge=1, description="试下分支 id（可选）")


class WsDeepAnalysisRequest(BaseModel):
    """深度分析请求：主谱 `{move_no}` 或 试下 `{position_key}`。"""

    move_no: Optional[int] = Field(default=None, ge=0, description="主谱局面手数")
    position_key: Optional[str] = Field(default=None, max_length=64, description="试下分支键 trial:{id}:{n}")

    @model_validator(mode="after")
    def _one_of(self) -> "WsDeepAnalysisRequest":
        if self.move_no is None and self.position_key is None:
            raise ValueError("深度分析需提供 move_no 或 position_key")
        return self


class WsGlobalAnalysisRequest(BaseModel):
    """全局分析请求 `{start_move_no?}`。"""

    start_move_no: Optional[int] = Field(default=None, ge=0, description="起始手数（续跑）")


class WsRecommendRequest(BaseModel):
    """复盘 AI 推荐请求：主谱 `{move_no}` 或 试下 `{position_key}`（T6.8）。

    - 读持久化/会话缓存派生 TOP5/变化图/当前手点评（引擎无关）；
    - 试下缺数据时触发 P1 标准分析并异步回投 ``review.recommend``。
    """

    move_no: Optional[int] = Field(default=None, ge=0, description="主谱局面手数")
    position_key: Optional[str] = Field(default=None, max_length=64, description="试下分支键 trial:{id}:{n}")

    @model_validator(mode="after")
    def _one_of(self) -> "WsRecommendRequest":
        if self.move_no is None and self.position_key is None:
            raise ValueError("推荐请求需提供 move_no 或 position_key")
        if self.position_key is not None and not self.position_key.startswith("trial:"):
            raise ValueError("position_key 仅支持试下分支键 trial:{id}:{n}")
        return self


class WsTrialEnter(BaseModel):
    """试下进入载荷 `{move_no}`（从主谱局面进入临时分支）。"""

    move_no: int = Field(ge=0, description="主谱进入手数（0..last_move_no）")


class WsTrialRef(BaseModel):
    """试下分支引用载荷 `{trial_id}`（pass/undo/back_to_real）。"""

    trial_id: int = Field(ge=1, description="试下分支 id（trial.enter 返回）")


class WsTrialPlay(BaseModel):
    """试下落子载荷 `{trial_id, x, y}`（color 由服务端按分支轮次推导）。"""

    trial_id: int = Field(ge=1, description="试下分支 id（trial.enter 返回）")
    x: int = Field(ge=0, le=18, description="横坐标 0-18")
    y: int = Field(ge=0, le=18, description="纵坐标 0-18")


class RefightRequest(BaseModel):
    """复弈载荷 `{trial_id}`（REST POST /games/{id}/refight，T6.8）。"""

    trial_id: int = Field(ge=1, description="试下分支 id（trial.enter 返回）")


class WsUndoRespond(BaseModel):
    """人人对弈悔棋申请回复 `{request_id, accept}`（T6.4 人工确认，2026/09/06）。"""

    request_id: int = Field(description="悔棋申请 id（服务端下发 undo.request 载荷）")
    accept: bool = Field(description="true=同意悔棋（服务端执行）；false=拒绝")
