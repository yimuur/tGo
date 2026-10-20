"""配置系统：default.yaml 兜底 + config.yaml 用户覆盖（Pydantic 模型，唯一配置事实源）。

依据 ARCHITECTURE §3.6 参数分层：
- 应用级参数（本模块管理）：engine / play / review / admin / logging / db 分组，写入 config.yaml；
- 引擎 cfg 级参数（num_analysis_threads / num_search_threads_per_analysis_thread）
  在 config.yaml 保存**期望值**，由 Phase 2/7 渲染写入 analysis.cfg 后生效；
- 请求级参数（maxVisits / maxTime / analysisPVLen / wideRootNoise / humanSLProfile）
  不落盘，随 Analysis 查询动态传入。

双文件分层：
- ``<backend>/default.yaml``：回退兜底默认（只读；缺失时首次启动由内置模板内容自动生成）；
- ``<项目根>/config.yaml``：用户自定义配置（可读写、优先级最高；**仅保存与默认不同的增量参数**），
  未指定参数时从 default.yaml 兜底；
- ``TGO_CONFIG`` 环境变量显式指定用户配置文件（单文件语义，缺省自动生成完整模板）。

约定：
- 显式传入 ``path`` / 设置 ``TGO_CONFIG`` 时按**单文件**加载（兼容既有用法：缺失自动生成完整模板）；
- 两者皆无时走**分层默认**：default.yaml 兜底，根 config.yaml（存在时）逐参数覆盖；
- 分层模式下 ``save_config()`` 写回根 config.yaml 时按**增量（delta）**保存：仅落盘与默认不同的参数；
- 引擎相关相对路径（executable_dir / model_dir / analysis_cfg）经 ``engine_path()`` 锚定项目根；
- 运行期资源相对路径（logging.dir / db.path 等）经 ``project_path()`` 锚定项目根——
  唯一日志目录 `<项目根>/logs`、数据目录 `<项目根>/data`，与启动 CWD 无关；
- 未知字段一律拒绝（extra="forbid"），保证配置演进可控（向后兼容原则）。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

CONFIG_FILE_NAME = "config.yaml"
CONFIG_ENV_VAR = "TGO_CONFIG"

#: 回退兑底默认文件名（backend/ 下，只读；缺失时首次启动由内置模板内容自动生成）
DEFAULT_FILE_NAME = "default.yaml"

#: 引擎 cfg 默认层文件名（backend/ 下，与 default.yaml 同级；只读，缺失时自动生成）
DEFAULT_CFG_FILE_NAME = "default.cfg"

#: 内置带注释的默认配置模板（与 backend/default.yaml 保持一致；
#: default.yaml 缺失或显式单文件配置缺失时用于自动生成）
DEFAULT_YAML_TEMPLATE = """# ============================================================
# tGo 应用配置（唯一配置事实源）
# 本文件为默认值兜底层（只读）；根目录 config.yaml 仅保存与默认不同的用户参数。
# 参数分层：engine 级参数由后端渲染写入 analysis.cfg；请求级参数随查询动态下发。
# ============================================================

# -------------------- engine：引擎参数 --------------------
engine:
  standard_max_visits: 100                   # 标准分析 maxVisits（曲线/AI 推荐/试下实时）
  deep_max_visits: 800                       # 深度分析 maxVisits（须大于 standard_max_visits）
  num_analysis_threads: 2                    # 引擎 cfg 级：analysis.cfg numAnalysisThreads（修改后安全重启）
  num_search_threads_per_analysis_thread: 16 # 引擎 cfg 级：analysis.cfg numSearchThreadsPerAnalysisThread
  analysis_pv_len: 10                        # PV 截断长度 [5-15]
  resident: false                            # 引擎常驻开关（默认 OFF：按需加载 + 空闲超时释放）
  idle_timeout_s: 1800                       # 非常驻模式空闲超时释放（秒）
  executable_dir: engine/katago              # KataGo 可执行文件目录（顶层含 katago.exe / katago，按平台识别）
  model_dir: engine/models                   # 模型目录（*.bin.gz）
  standard_model: ""                         # 默认标准模型文件名（空=自动扫描）
  human_model: ""                            # 人类模型文件名（空=自动扫描 *human*.bin.gz）
  analysis_cfg: engine/katago/analysis.cfg   # 引擎 cfg 文件（首次启动自动生成，后端渲染维护）

# -------------------- play：对弈参数 --------------------
play:
  adaptive_initial_level: rank_5k  # 自适应难度 AI 初始水平（12 档之一）
  max_undo: 10                     # 全局悔棋步数上限（仅人机对弈）
  default_board_size: 19           # 默认棋盘大小 9/13/19
  default_rules: chinese           # 默认规则集 chinese/japanese/aga
  default_komi: 7.5                # 默认贴目
  default_human_color: B           # 人机默认执子颜色 B/W
  max_moves: 5                     # 候选点截断大小（持久化）

# -------------------- review：复盘参数 --------------------
review:
  variation_preview_len: 10        # 变化图预览默认步数

# -------------------- adaptive：自适应难度参数 --------------------
adaptive:
  window: 5                        # 近期目数损失滑动窗口（仅统计人类落子）
  score_lead_up: 8.0               # 升级：人类领先目数阈值（Score Lead > 该值 且 近期零失误）
  score_loss_up: 0.5               # 升级：近期平均目数损失上限（低于该值视为零失误）
  score_lead_down: -15.0           # 降级：人类落后目数阈值（Score Lead < 该值）
  score_loss_down: 3.0             # 降级：近期平均目数损失下限（高于该值视为昏招）
  playout_doubling_advantage: -0.05  # 降级注入负 PDA（让 AI 收缩防线）

# -------------------- report：分析报告指标参数 --------------------
report:
  top_n: 3                         # AI 吻合度 Top-N 与点评“命中 AI 选点（正着=前 N 名；第一名=妙着）”统一口径
  # 点评分类带（最差→最佳；ΔW≤阈值 或 ΔS≤阈值 命中，both=True 时两条件均需满足；
  # ΔS=目数变化（恶手为负、好手为正，与 ΔW 同向）；命中 AI 选点优先：第一选点→妙着、前 N 选点→至少正着）
  quality_bands:
    - label: 败着
      winrate_delta: -0.15
      score_delta: -4.5
    - label: 失误
      winrate_delta: -0.06
      score_delta: -2.0
    - label: 缓着
      winrate_delta: -0.02
      score_delta: -0.8
    - label: 正着
      winrate_delta: 0.03
      score_delta: 0.0
      both: true
    - label: 妙着
      winrate_delta: 0.03
      score_delta: 0.0
  turning_point_winrate_delta: 0.15  # 胜负手：按 |ΔS| 降序取（正负不限）；ΔS 缺失时 |ΔW| 须超该值才兜底
  turning_point_count_min: 3         # 胜负手最少返回手数
  turning_point_count_max: 5         # 胜负手最多返回手数
  # 棋力评级带（从强到弱；平均目损 ≤ 且 吻合度 ≥ 同时满足命中）
  ratings:
    - label: 巅峰/职业
      mean_loss: 0.15
      match_rate: 0.75
      description: 几乎没有非受迫性失误，后半盘极其精确
    - label: 业余 6段-7段
      mean_loss: 0.30
      match_rate: 0.65
      description: 具备极强的计算力，极少出现 2 目以上的亏损
    - label: 业余 4段-5段
      mean_loss: 0.60
      match_rate: 0.55
      description: 大局观良好，但在复杂战斗中偶尔会下出缓着
    - label: 业余 1段-3段
      mean_loss: 1.00
      match_rate: 0.45
      description: 掌握基本定式，但死活与方向判断存在盲区
    - label: 高级级位
      mean_loss: 1.50
      match_rate: 0.35
      description: 经常下出价值偏低的缓着，局部容易崩盘
    - label: 初学者
      mean_loss: 99.0
      match_rate: 0.0
      description: 满盘存在大量无理手和直接送吃的失误

# -------------------- admin：管理模块参数 --------------------
admin:
  system_status_interval_s: 5      # 系统状态推送间隔（秒）

# -------------------- logging：日志轮转参数 --------------------
logging:
  dir: logs                        # 日志目录
  level: INFO                      # 日志级别 DEBUG/INFO/WARNING/ERROR
  max_bytes: 5242880               # 单日志文件最大字节数
  backup_count: 5                  # 轮转保留份数

# -------------------- db：数据库参数 --------------------
db:
  path: data/tgo.db                # SQLite 数据库文件路径

# -------------------- server：服务监听（一键启动/部署脚本读取，修改后重启生效） --------------------
server:
  host: 0.0.0.0   # 监听地址（0.0.0.0=全部网卡，局域网可达）
  port: 8090      # 监听端口（被其它程序占用时启动器自动 +1，最多 +10；已是 tGo 则复用）

# -------------------- levels：12 级难度映射 --------------------
# 说明：max_visits 随查询顶层下发；wide_root_noise/max_time 经 overrideSettings 下发；
# chosen_move_temperature 仅用于后端 AI 落子加权采样，不随查询下发。
levels:
  # 标准模型 12 级难度
  standard:
    - {level: 1, target: "20K", max_visits: 1, max_time: 0.1, chosen_move_temperature: 2.00, wide_root_noise: 0.30}
    - {level: 2, target: "15K", max_visits: 1, max_time: 0.2, chosen_move_temperature: 1.70, wide_root_noise: 0.22}
    - {level: 3, target: "10K", max_visits: 2, max_time: 0.3, chosen_move_temperature: 1.40, wide_root_noise: 0.18}
    - {level: 4, target: "8K", max_visits: 3, max_time: 0.5, chosen_move_temperature: 1.10, wide_root_noise: 0.14}
    - {level: 5, target: "5K", max_visits: 5, max_time: 1.0, chosen_move_temperature: 0.95, wide_root_noise: 0.10}
    - {level: 6, target: "3K", max_visits: 10, max_time: 2.0, chosen_move_temperature: 0.80, wide_root_noise: 0.08}
    - {level: 7, target: "1K", max_visits: 25, max_time: 4.0, chosen_move_temperature: 0.55, wide_root_noise: 0.05}
    - {level: 8, target: "1D", max_visits: 50, max_time: 8.0, chosen_move_temperature: 0.40, wide_root_noise: 0.03}
    - {level: 9, target: "3D", max_visits: 100, max_time: 10.0, chosen_move_temperature: 0.25, wide_root_noise: 0.01}
    - {level: 10, target: "5D", max_visits: 200, max_time: 12.0, chosen_move_temperature: 0.15, wide_root_noise: 0.00}
    - {level: 11, target: "7D", max_visits: 500, max_time: 16.0, chosen_move_temperature: 0.05, wide_root_noise: 0.00}
    - {level: 12, target: "9D", max_visits: 800, max_time: 20.0, chosen_move_temperature: 0.00, wide_root_noise: 0.00}
  # 仿人类模型 12 级难度
  human:
    - {level: 1, target: "启蒙", human_sl_profile: "rank_20k", max_visits: 1, chosen_move_temperature: 1.00}
    - {level: 2, target: "入门", human_sl_profile: "rank_15k", max_visits: 1, chosen_move_temperature: 0.95}
    - {level: 3, target: "初级", human_sl_profile: "rank_10k", max_visits: 1, chosen_move_temperature: 0.88}
    - {level: 4, target: "中级", human_sl_profile: "rank_8k", max_visits: 1, chosen_move_temperature: 0.82}
    - {level: 5, target: "中高级", human_sl_profile: "rank_5k", max_visits: 2, chosen_move_temperature: 0.75}
    - {level: 6, target: "高级", human_sl_profile: "rank_3k", max_visits: 5, chosen_move_temperature: 0.70}
    - {level: 7, target: "准段", human_sl_profile: "rank_1k", max_visits: 15, chosen_move_temperature: 0.60}
    - {level: 8, target: "初段", human_sl_profile: "rank_1d", max_visits: 30, chosen_move_temperature: 0.50}
    - {level: 9, target: "3段", human_sl_profile: "rank_3d", max_visits: 50, chosen_move_temperature: 0.35}
    - {level: 10, target: "5段", human_sl_profile: "rank_5d", max_visits: 100, chosen_move_temperature: 0.25}
    - {level: 11, target: "7段", human_sl_profile: "rank_7d", max_visits: 200, chosen_move_temperature: 0.10}
    - {level: 12, target: "9段", human_sl_profile: "rank_9d", max_visits: 500, chosen_move_temperature: 0.00}
"""

#: 12 档棋力段位（LEVEL.md 映射，标准/人类模型共用）
RANK_LEVELS: tuple[str, ...] = (
    "rank_20k",
    "rank_15k",
    "rank_10k",
    "rank_8k",
    "rank_5k",
    "rank_3k",
    "rank_1k",
    "rank_1d",
    "rank_3d",
    "rank_5d",
    "rank_7d",
    "rank_9d",
)

BOARD_SIZES: tuple[int, ...] = (9, 13, 19)
RULESETS: tuple[str, ...] = ("chinese", "japanese", "aga")
COLORS: tuple[str, ...] = ("B", "W")


class ConfigError(RuntimeError):
    """配置加载或校验失败。

    ``code`` 为可选机器码（引擎装配失败归因：``standard_model_missing`` /
    ``engine_executable_missing``），供 API 层向前端如实转述缺失原因（BUG-097）。
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


class EngineConfig(BaseModel):
    """引擎参数（应用级期望值；cfg 级参数由渲染写入 analysis.cfg）。"""

    model_config = ConfigDict(extra="forbid")

    standard_max_visits: int = Field(default=100, ge=1, description="标准分析 maxVisits（每手曲线/试下实时/推荐）")
    deep_max_visits: int = Field(default=800, ge=1, description="深度分析 maxVisits（须大于 standard_max_visits）")
    num_analysis_threads: int = Field(default=2, ge=1, description="引擎 cfg 级：analysis.cfg numAnalysisThreads 期望值")
    num_search_threads_per_analysis_thread: int = Field(
        default=16, ge=1, description="引擎 cfg 级：analysis.cfg numSearchThreadsPerAnalysisThread 期望值"
    )
    analysis_pv_len: int = Field(default=10, ge=5, le=15, description="PV 截断长度 [5-15]")
    resident: bool = Field(default=False, description="引擎常驻开关（默认 OFF）")
    idle_timeout_s: int = Field(
        default=1800, ge=0, description="非常驻模式空闲超时释放（秒；管理页滑杆 30 分钟步进，默认 30 分钟）"
    )
    executable_dir: str = Field(
        default="engine/katago", description="KataGo 可执行文件目录（顶层含 katago.exe/katago，按平台自动识别）"
    )
    model_dir: str = Field(default="engine/models", description="模型目录")
    standard_model: str = Field(default="", description="默认标准模型文件名（空=自动扫描）")
    human_model: str = Field(default="", description="人类模型文件名（空=自动扫描 *human*.bin.gz）")
    analysis_cfg: str = Field(
        default="engine/katago/analysis.cfg", description="引擎 cfg 文件（首次启动自动生成，后端渲染维护）"
    )


class PlayConfig(BaseModel):
    """对弈参数。"""

    model_config = ConfigDict(extra="forbid")

    adaptive_initial_level: str = Field(default="rank_5k", description="自适应难度 AI 初始水平（12 档之一）")
    max_undo: int = Field(default=10, ge=0, description="全局悔棋步数上限（人机对弈悔棋上限）")
    default_board_size: int = Field(default=19, description="默认棋盘大小 9/13/19")
    default_rules: str = Field(default="chinese", description="默认规则集 chinese/japanese/aga")
    default_komi: float = Field(default=7.5, description="默认贴目")
    default_human_color: str = Field(default="B", description="人机默认执子颜色 B/W")
    max_moves: int = Field(default=5, ge=1, description="候选点截断大小（持久化）")

    @field_validator("adaptive_initial_level")
    @classmethod
    def _check_rank(cls, v: str) -> str:
        if v not in RANK_LEVELS:
            raise ValueError(f"adaptive_initial_level 必须是 12 档之一: {RANK_LEVELS}")
        return v

    @field_validator("default_board_size")
    @classmethod
    def _check_board_size(cls, v: int) -> int:
        if v not in BOARD_SIZES:
            raise ValueError(f"default_board_size 仅支持 {BOARD_SIZES}")
        return v

    @field_validator("default_rules")
    @classmethod
    def _check_rules(cls, v: str) -> str:
        if v not in RULESETS:
            raise ValueError(f"default_rules 仅支持 {RULESETS}")
        return v

    @field_validator("default_human_color")
    @classmethod
    def _check_color(cls, v: str) -> str:
        if v not in COLORS:
            raise ValueError(f"default_human_color 仅支持 {COLORS}")
        return v


class ReviewConfig(BaseModel):
    """复盘参数。"""

    model_config = ConfigDict(extra="forbid")

    variation_preview_len: int = Field(default=10, ge=1, le=30, description="变化图预览默认步数")


class QualityBandConfig(BaseModel):
    """点评分类带（LEVEL.md 点评表；命中 AI 选点优先 + 数值条件按**最差带**判定）。"""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(description="点评标签（妙着/正着/缓着/失误/败着）")
    winrate_delta: float = Field(description="ΔW 阈值：ΔW ≤ 该值命中（both 带为 ΔW < 该值）")
    score_delta: float = Field(description="ΔS 阈值（目数变化，好手为正）：ΔS ≤ 该值命中（both 带为 ΔS < 该值）")
    both: bool = Field(default=False, description="True=两条件均需满足（正着带：ΔW<阈值 且 ΔS<阈值）")


class RatingBandConfig(BaseModel):
    """棋力评级带（LEVEL.md 综合评级表，从强到弱）。"""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(description="评级标签")
    mean_loss: float = Field(description="平均目数损失上限（≤ 命中）")
    match_rate: float = Field(description="Top-N 吻合度下限（≥ 命中）")
    description: str = Field(default="", description="棋局特征描述")


def _default_quality_bands() -> list[QualityBandConfig]:
    """点评分类默认带（LEVEL.md 点评表；config.yaml 为唯一事实源，可覆盖）。

    ΔS=目数变化（恶手为负、好手为正）；命中 AI 选点优先（第一选点→妙着、
    前 ``report.top_n`` 名→至少正着）由 ``classify_move`` 统一实现。
    """
    return [
        QualityBandConfig(label="败着", winrate_delta=-0.15, score_delta=-4.5),
        QualityBandConfig(label="失误", winrate_delta=-0.06, score_delta=-2.0),
        QualityBandConfig(label="缓着", winrate_delta=-0.02, score_delta=-0.8),
        QualityBandConfig(label="正着", winrate_delta=0.03, score_delta=0.0, both=True),
        QualityBandConfig(label="妙着", winrate_delta=0.03, score_delta=0.0),
    ]


def _default_ratings() -> list[RatingBandConfig]:
    """棋力评级默认表（LEVEL.md；config.yaml 为唯一事实源，可覆盖）。"""
    return [
        RatingBandConfig(label="巅峰/职业", mean_loss=0.15, match_rate=0.75, description="几乎没有非受迫性失误，后半盘极其精确"),
        RatingBandConfig(label="业余 6段-7段", mean_loss=0.30, match_rate=0.65, description="具备极强的计算力，极少出现 2 目以上的亏损"),
        RatingBandConfig(label="业余 4段-5段", mean_loss=0.60, match_rate=0.55, description="大局观良好，但在复杂战斗中偶尔会下出缓着"),
        RatingBandConfig(label="业余 1段-3段", mean_loss=1.00, match_rate=0.45, description="掌握基本定式，但死活与方向判断存在盲区"),
        RatingBandConfig(label="高级级位", mean_loss=1.50, match_rate=0.35, description="经常下出价值偏低的缓着，局部容易崩盘"),
        RatingBandConfig(label="初学者", mean_loss=99.0, match_rate=0.0, description="满盘存在大量无理手和直接送吃的失误"),
    ]


class ReportConfig(BaseModel):
    """分析报告指标参数（LEVEL.md，全部配置化禁止硬编码）。"""

    model_config = ConfigDict(extra="forbid")

    top_n: int = Field(default=3, ge=1, le=10, description="AI 吻合度 Top-N / 点评“命中 AI 选点（正着）”前 N 名（同一口径）")
    quality_bands: list[QualityBandConfig] = Field(default_factory=_default_quality_bands, description="点评分类带（最差→最佳）")
    turning_point_winrate_delta: float = Field(default=0.15, ge=0, le=1, description="胜负手：ΔS 缺失时按 |ΔW| 兜底纳入的阈值（ΔS 存在时按 |ΔS| 降序取）")
    turning_point_count_min: int = Field(default=3, ge=1, le=20, description="胜负手最少返回手数")
    turning_point_count_max: int = Field(default=5, ge=1, le=20, description="胜负手最多返回手数")
    ratings: list[RatingBandConfig] = Field(default_factory=_default_ratings, description="棋力评级带（从强到弱）")

    @model_validator(mode="after")
    def _check_turning_point_range(self) -> "ReportConfig":
        if self.turning_point_count_min > self.turning_point_count_max:
            raise ValueError("turning_point_count_min 必须 ≤ turning_point_count_max")
        return self



class AdaptiveConfig(BaseModel):
    """自适应难度参数（LEVEL.md 算法，全部配置化）。"""

    model_config = ConfigDict(extra="forbid")

    window: int = Field(default=5, ge=3, le=10, description="近期目数损失滑动窗口（仅统计人类落子，5-7 手黄金平衡）")
    score_lead_up: float = Field(default=8.0, description="升级：人类领先目数阈值（Score Lead > 该值）")
    score_loss_up: float = Field(default=0.5, description="升级：近期平均目数损失上限（低于该值视为零失误）")
    score_lead_down: float = Field(default=-15.0, description="降级：人类落后目数阈值（Score Lead < 该值）")
    score_loss_down: float = Field(default=3.0, description="降级：近期平均目数损失下限（高于该值视为昏招）")
    playout_doubling_advantage: float = Field(default=-0.05, description="降级注入负 PDA（让 AI 收缩防线）")


class AdminConfig(BaseModel):
    """管理模块参数。"""

    model_config = ConfigDict(extra="forbid")

    system_status_interval_s: int = Field(default=5, ge=1, description="系统状态推送间隔（秒）")


class LoggingConfig(BaseModel):
    """日志轮转参数（PRD §4.3.6 / AGENTS.md §5）。"""

    model_config = ConfigDict(extra="forbid")

    dir: str = Field(default="logs", description="日志目录")
    level: str = Field(default="INFO", description="日志级别 DEBUG/INFO/WARNING/ERROR")
    max_bytes: int = Field(default=5 * 1024 * 1024, ge=1024, description="单日志文件最大字节数")
    backup_count: int = Field(default=5, ge=0, description="轮转保留份数")


class DbConfig(BaseModel):
    """数据库参数。"""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(default="data/tgo.db", description="SQLite 数据库文件路径")


class ServerConfig(BaseModel):
    """服务监听参数（一键启动/部署脚本经 launcher 读取；修改后需重启服务生效）。

    - ``host``：监听地址。默认 ``0.0.0.0``＝监听全部网卡（局域网可达）；
      浏览器自动打开时仍使用探测到的本机局域网 IP 访问；
    - ``port``：监听端口。被**其它程序**占用时启动器自动 +1（最多 +10）；
      若该端口上已是运行中的 tGo（``/api/health`` 签名探测）则视为已启动、
      幂等复用（仅打开浏览器），不再新起实例。
    """

    model_config = ConfigDict(extra="forbid")

    host: str = Field(default="0.0.0.0", description="监听地址（0.0.0.0=全部网卡，局域网可达）")
    port: int = Field(default=8090, ge=1, le=65535, description="监听端口（其它程序占用时自动 +1）")


class StandardLevelParam(BaseModel):
    """标准模型难度档位（LEVEL.md 标准模型表，12 级）。"""

    model_config = ConfigDict(extra="forbid")

    level: int = Field(ge=1, le=12, description="难度等级 1-12")
    target: str = Field(description="目标段位（展示）")
    max_visits: int = Field(ge=1, description="对弈查询 maxVisits（顶层字段）")
    max_time: float = Field(ge=0, description="对弈查询 maxTime（经 overrideSettings.maxTime 随查询下发，ISSUE-037）")
    chosen_move_temperature: float = Field(ge=0, description="AI 落子加权采样温度（客户端采样用）")
    wide_root_noise: float = Field(ge=0, description="overrideSettings.wideRootNoise")


class HumanLevelParam(BaseModel):
    """仿人类模型难度档位（LEVEL.md 仿人类模型表，12 级）。"""

    model_config = ConfigDict(extra="forbid")

    level: int = Field(ge=1, le=12, description="难度等级 1-12")
    target: str = Field(description="目标段位（展示）")
    human_sl_profile: str = Field(description="overrideSettings.humanSLProfile（rank_20k ~ rank_9d）")
    max_visits: int = Field(ge=1, description="对弈查询 maxVisits（顶层字段）")
    chosen_move_temperature: float = Field(ge=0, description="AI 落子加权采样温度（客户端采样用）")


def _default_standard_levels() -> list[StandardLevelParam]:
    """12 级标准难度默认值（LEVEL.md 标准模型表；config.yaml 为唯一事实源，可覆盖）。"""
    return [
        StandardLevelParam(level=1, target="20K", max_visits=1, max_time=0.1, chosen_move_temperature=2.00, wide_root_noise=0.30),
        StandardLevelParam(level=2, target="15K", max_visits=1, max_time=0.2, chosen_move_temperature=1.70, wide_root_noise=0.22),
        StandardLevelParam(level=3, target="10K", max_visits=2, max_time=0.3, chosen_move_temperature=1.40, wide_root_noise=0.18),
        StandardLevelParam(level=4, target="8K", max_visits=3, max_time=0.5, chosen_move_temperature=1.10, wide_root_noise=0.14),
        StandardLevelParam(level=5, target="5K", max_visits=5, max_time=1.0, chosen_move_temperature=0.95, wide_root_noise=0.10),
        StandardLevelParam(level=6, target="3K", max_visits=10, max_time=2.0, chosen_move_temperature=0.80, wide_root_noise=0.08),
        StandardLevelParam(level=7, target="1K", max_visits=25, max_time=4.0, chosen_move_temperature=0.55, wide_root_noise=0.05),
        StandardLevelParam(level=8, target="1D", max_visits=50, max_time=8.0, chosen_move_temperature=0.40, wide_root_noise=0.03),
        StandardLevelParam(level=9, target="3D", max_visits=100, max_time=10.0, chosen_move_temperature=0.25, wide_root_noise=0.01),
        StandardLevelParam(level=10, target="5D", max_visits=200, max_time=12.0, chosen_move_temperature=0.15, wide_root_noise=0.00),
        StandardLevelParam(level=11, target="7D", max_visits=500, max_time=16.0, chosen_move_temperature=0.05, wide_root_noise=0.00),
        StandardLevelParam(level=12, target="9D", max_visits=800, max_time=20.0, chosen_move_temperature=0.00, wide_root_noise=0.00),
    ]


def _default_human_levels() -> list[HumanLevelParam]:
    """12 级仿人类难度默认值（LEVEL.md 仿人类模型表；config.yaml 为唯一事实源，可覆盖）。"""
    return [
        HumanLevelParam(level=1, target="启蒙", human_sl_profile="rank_20k", max_visits=1, chosen_move_temperature=1.00),
        HumanLevelParam(level=2, target="入门", human_sl_profile="rank_15k", max_visits=1, chosen_move_temperature=0.95),
        HumanLevelParam(level=3, target="初级", human_sl_profile="rank_10k", max_visits=1, chosen_move_temperature=0.88),
        HumanLevelParam(level=4, target="中级", human_sl_profile="rank_8k", max_visits=1, chosen_move_temperature=0.82),
        HumanLevelParam(level=5, target="中高级", human_sl_profile="rank_5k", max_visits=2, chosen_move_temperature=0.75),
        HumanLevelParam(level=6, target="高级", human_sl_profile="rank_3k", max_visits=5, chosen_move_temperature=0.70),
        HumanLevelParam(level=7, target="准段", human_sl_profile="rank_1k", max_visits=15, chosen_move_temperature=0.60),
        HumanLevelParam(level=8, target="初段", human_sl_profile="rank_1d", max_visits=30, chosen_move_temperature=0.50),
        HumanLevelParam(level=9, target="3段", human_sl_profile="rank_3d", max_visits=50, chosen_move_temperature=0.35),
        HumanLevelParam(level=10, target="5段", human_sl_profile="rank_5d", max_visits=100, chosen_move_temperature=0.25),
        HumanLevelParam(level=11, target="7段", human_sl_profile="rank_7d", max_visits=200, chosen_move_temperature=0.10),
        HumanLevelParam(level=12, target="9段", human_sl_profile="rank_9d", max_visits=500, chosen_move_temperature=0.00),
    ]


class LevelsConfig(BaseModel):
    """12 级难度映射（标准 + 仿人类），配置唯一事实源（禁止代码硬编码运行时参数）。"""

    model_config = ConfigDict(extra="forbid")

    standard: list[StandardLevelParam] = Field(default_factory=_default_standard_levels)
    human: list[HumanLevelParam] = Field(default_factory=_default_human_levels)

    def standard_at(self, level: int) -> StandardLevelParam:
        return _level_at(self.standard, level)

    def human_at(self, level: int) -> HumanLevelParam:
        return _level_at(self.human, level)


def _level_at(levels: list, level: int):
    if not (1 <= level <= 12):
        raise ValueError(f"难度等级越界: {level}（仅 1-12）")
    return levels[level - 1]


class AppConfig(BaseModel):
    """应用总配置（唯一配置事实源）。"""

    model_config = ConfigDict(extra="forbid")

    engine: EngineConfig = Field(default_factory=EngineConfig)
    play: PlayConfig = Field(default_factory=PlayConfig)
    review: ReviewConfig = Field(default_factory=ReviewConfig)
    adaptive: AdaptiveConfig = Field(default_factory=AdaptiveConfig)
    report: ReportConfig = Field(default_factory=ReportConfig)
    admin: AdminConfig = Field(default_factory=AdminConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    db: DbConfig = Field(default_factory=DbConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    levels: LevelsConfig = Field(default_factory=LevelsConfig)

    @model_validator(mode="after")
    def _cross_check_deep_vs_standard(self) -> "AppConfig":
        """交叉校验：深度分析 maxVisits 必须大于标准分析 maxVisits（API §1 通用约束）。"""
        if self.engine.deep_max_visits <= self.engine.standard_max_visits:
            raise ValueError("engine.deep_max_visits 必须大于 engine.standard_max_visits")
        return self


def default_config() -> AppConfig:
    """返回全默认配置（不落盘）。"""
    return AppConfig()


def _package_dir() -> Path:
    """backend/ 目录（default.yaml 与其同级）。"""
    return Path(__file__).resolve().parents[1]


def _project_root() -> Path:
    """项目根目录（用户 config.yaml、engine/ 引擎目录与其同级）。"""
    return Path(__file__).resolve().parents[2]


def project_root() -> Path:
    """项目根目录（公开访问）。"""
    return _project_root()


def project_path(value: str | os.PathLike[str]) -> Path:
    """解析运行期资源相对路径 → 项目根锚定的绝对路径（与启动 CWD 无关）。

    适用：``logging.dir``（唯一日志目录 `<根>/logs`）、``db.path``（数据目录 `<根>/data`）等。
    相对路径一律相对项目根解析（绝对路径原样返回）——杜绝启动 CWD 漂移分裂出
    ``backend/logs``、``backend/data`` 等影子目录（2026/09/13 人工反馈修订）。
    """
    p = Path(value)
    return p if p.is_absolute() else (_project_root() / p).resolve()


def engine_path(value: str | os.PathLike[str]) -> Path:
    """解析引擎相关相对路径 → 项目根锚定（语义同 ``project_path``）。

    ``executable_dir`` / ``model_dir`` / ``analysis_cfg`` 等配置项为相对路径时，
    一律相对项目根解析（绝对路径原样返回），杜绝测试/部署时 CWD 漂移产生的残留文件。
    """
    return project_path(value)


def user_config_path() -> Path:
    """用户自定义配置（可读写、优先级最高）：TGO_CONFIG > 项目根 config.yaml。"""
    env = os.environ.get(CONFIG_ENV_VAR)
    if env:
        return Path(env).resolve()
    return (_project_root() / CONFIG_FILE_NAME).resolve()


def default_config_path() -> Path:
    """回退兜底 default.yaml 路径（backend/ 下；只读，缺失时自动生成）。"""
    return (_package_dir() / DEFAULT_FILE_NAME).resolve()


def default_engine_cfg_path() -> Path:
    """引擎 cfg 默认兜底层 ``default.cfg`` 路径（backend/ 下；只读，缺失时自动生成）。

    与 ``default_config_path()`` 同口径：默认层集中放 ``backend/``，用户层为
    ``engine.analysis_cfg``（引擎实际以 ``-config`` 加载、用户可自由修改的文件）。
    模板与渲染逻辑见 ``app.engine.manager``（KataGo 引擎 cfg 属引擎域）。
    """
    return (_package_dir() / DEFAULT_CFG_FILE_NAME).resolve()


def resolve_config_path(path: str | os.PathLike[str] | None = None) -> Path:
    """解析用户配置文件路径：显式传入 > 环境变量 TGO_CONFIG > 项目根 config.yaml。"""
    if path is not None:
        return Path(path).resolve()
    return user_config_path()


#: 已废弃/移除的配置键（向后兼容：加载时静默剔除，避免 extra="forbid" 拒绝旧配置）
_DEPRECATED_KEYS = {
    "engine": {"executable"},  # executable → executable_dir（引擎目录统一，顶层按平台识别）
    "play": {"analysis_min_visits"},  # M-7：V_analysis_min 已移除
}


def _strip_deprecated_keys(raw: dict) -> dict:
    """向后兼容：剔除已废弃配置键（executable / analysis_min_visits）。"""
    for group, keys in _DEPRECATED_KEYS.items():
        section = raw.get(group)
        if isinstance(section, dict):
            for key in keys:
                section.pop(key, None)
    return raw


def _read_yaml_file(path: Path) -> dict:
    """读取 yaml 文件 → 顶层 dict（剔除废弃键）。"""
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (yaml.YAMLError, OSError) as exc:
        raise ConfigError(f"配置加载失败: {path} -> {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"配置格式错误: {path} 顶层须为映射")
    return _strip_deprecated_keys(raw)


def _validate_raw(raw: dict) -> AppConfig:
    try:
        return AppConfig.model_validate(raw)
    except (ValidationError, ValueError) as exc:
        raise ConfigError(f"配置校验失败: {exc}") from exc


def _deep_merge(base: dict, override: dict) -> dict:
    """逐键深合并：override 覆盖 base（分组内仅覆盖出现的键）。"""
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _ensure_default_file() -> Path:
    """确保 default.yaml 存在（只读回退层；缺失时由内置模板内容自动生成一次）。"""
    target = default_config_path()
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(DEFAULT_YAML_TEMPLATE, encoding="utf-8")
    return target


def _load_single_file(path: Path) -> AppConfig:
    """单文件加载（显式 path / TGO_CONFIG）：文件缺失时自动生成完整带注释模板。"""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(DEFAULT_YAML_TEMPLATE, encoding="utf-8")
    return _validate_raw(_read_yaml_file(path))


def load_config(path: str | os.PathLike[str] | None = None) -> AppConfig:
    """加载配置。

    - 显式 ``path`` 或设置 ``TGO_CONFIG``：单文件语义（缺失自动生成模板副本）；
    - 两者皆无：分层默认 —— ``default.yaml`` 兜底 + 项目根 ``config.yaml``（存在时）
      逐参数覆盖（未覆盖参数沿用兜底默认）。
    """
    if path is not None or os.environ.get(CONFIG_ENV_VAR):
        return _load_single_file(resolve_config_path(path))
    # 分层默认：default.yaml 兜底
    defaults_raw = _read_yaml_file(_ensure_default_file())
    user_target = user_config_path()
    if not user_target.exists():
        return _validate_raw(defaults_raw)
    return _validate_raw(_deep_merge(defaults_raw, _read_yaml_file(user_target)))


def _normalized(raw: dict) -> dict:
    """规范化配置字典（经 AppConfig 校验，剔除语义等价的显式默认值噪音）。"""
    return AppConfig.model_validate(raw).model_dump(mode="python")


def _delta(defaults: dict, user: dict) -> dict:
    """递归求 ``user`` 相对 ``defaults`` 的差异（仅保留不同的键/分组，供根 config.yaml 增量落盘）。"""
    out: dict = {}
    for key, value in user.items():
        if key not in defaults:
            out[key] = value
            continue
        base = defaults[key]
        if isinstance(value, dict) and isinstance(base, dict):
            sub = _delta(base, value)
            if sub:
                out[key] = sub
        elif value != base:
            out[key] = value
    return out


def save_config(cfg: AppConfig, path: str | os.PathLike[str] | None = None) -> Path:
    """将配置写回用户层 yaml（配置唯一事实源）。

    - 分层默认（``path=None`` 且未设 ``TGO_CONFIG``）：写项目根 config.yaml，且**仅保存与
      default.yaml 不同的增量参数**（默认值变更可自然生效，不被旧默认回写覆盖）；
    - 单文件语义（显式 ``path`` 或设置 ``TGO_CONFIG``）：写完整配置（该文件即唯一事实源）。
    """
    target = resolve_config_path(path)
    layered = path is None and not os.environ.get(CONFIG_ENV_VAR)
    if layered:
        defaults_raw = _read_yaml_file(_ensure_default_file())
        data = _delta(_normalized(defaults_raw), cfg.model_dump(mode="python"))
    else:
        data = cfg.model_dump(mode="python")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return target
