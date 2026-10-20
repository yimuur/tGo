"""对局领域服务（TASK T3.2-T3.5，PRD §4.1，ARCHITECTURE §3.5/§4.1）。

职责：
- **T3.2 创建对局**：参数校验、players 档案 upsert + 黑白 name/rank 快照、
  段位→难度档位映射、人类模型缺失降级、写入 games（status='created'）；
- **T3.3 对局进行**（后续实现）：规则校验（吃子/禁入/打劫）、落子/PASS/悔棋/
  认输/重开、引擎解耦（人人对弈引擎 DEAD 落子照常）；
- **T3.4 终局结算**（后续实现）：死子确认、数子/目数结算、scorings UPSERT；
- **T3.5 断点恢复**（后续实现）：全量校验对齐、服务端唯一事实源。

约定：
- 服务层以 ``conn``（aiosqlite.Connection）与 ``config``（AppConfig）为依赖，
  不持有连接生命周期；引擎交互经依赖注入的 ``engine_manager`` 抽象；
- 对局流转 FSM 由 ``games.status`` 重建（服务端唯一事实源，GameState.from_db）；
- 所有非法输入抛统一 ``AppError``（API §2），不泄露 Traceback。
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncGenerator, Awaitable, Callable, Optional
from uuid import uuid4

from app.config import AppConfig, RANK_LEVELS
from app.core.errors import AppError, ErrorCode
from app.core.game_fsm import GameFsm, GameState, GameTurn
from app.db import repos
from app.engine.analysis_engine import EngineQueryError
from app.engine.analysis_query import build_standard_query
from app.engine.coords import gtp_to_xy, is_pass_loc
from app.engine.play_query import build_play_query, select_ai_move, select_move_from_policy
from app.services.chain_precision import chain_visits
from app.services.go_rules import (
    GoBoard,
    GoRulesError,
    handicap_initial_stones,
    handicap_limit,
    handicap_points,
)
from app.services.scoring import compute_scoring, replay_position

logger = logging.getLogger(__name__)


def _consume_task_exception(task: asyncio.Task[object]) -> None:
    """消费任务的未检索异常（悔棋中止后不再 await 的引擎提交任务）。"""
    if not task.cancelled():
        task.exception()


class _GameLock:
    """按对局的可重入 asyncio 锁（M-3）。

    同一任务可嵌套获取（play → ai_move → play），避免 asyncio.Lock 重入死锁；
    用于将对局的"读-判-写"临界区串行化，杜绝多终端并发落子/悔棋的 TOCTOU 竞态。
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._owner: Optional[asyncio.Task] = None
        self._depth = 0

    async def __aenter__(self) -> "_GameLock":
        owner = asyncio.current_task()
        if self._owner is not None and owner is self._owner:
            self._depth += 1
            return self
        await self._lock.acquire()
        self._owner = owner
        self._depth = 1
        return self

    async def __aexit__(self, *exc) -> None:
        self._depth -= 1
        if self._depth <= 0:
            self._depth = 0
            self._owner = None
            self._lock.release()

    @property
    def is_held(self) -> bool:
        """是否正被某任务持有（对局删除时据此跳过回收，见 ``release_game``，R5）。"""
        return self._owner is not None


#: 合法对局模式（DATABASE §3.2 CHECK）
VALID_MODES: tuple[str, ...] = ("human_ai", "human_human")
#: 合法 AI 风格
VALID_STYLES: tuple[str, ...] = ("standard", "human")
#: 合法棋盘大小（config 同步）
VALID_BOARD_SIZES: tuple[int, ...] = (9, 13, 19)

#: 日志文案（系统日志须便于人类阅读/理解）：对局模式 → 中文
_MODE_TEXT: dict[str, str] = {"human_ai": "人机", "human_human": "人人"}
#: 日志文案：执色 → 中文（禁 B/W 缩写）
_COLOR_TEXT: dict[str, str] = {"B": "黑", "W": "白"}
#: 合法规则集
VALID_RULESETS: tuple[str, ...] = ("chinese", "japanese", "aga")
#: 让先 2-9 子（0=分先）
HANDICAP_RANGE = range(2, 10)


def rank_to_level(rank: str) -> int:
    """段位（rank_20k ~ rank_9d）→ 难度档位 1-12。"""
    if rank not in RANK_LEVELS:
        raise AppError(ErrorCode.PLAYER_INVALID_RANK, f"非法段位: {rank}")
    return RANK_LEVELS.index(rank) + 1


def fsm_from_game(game: dict) -> GameFsm:
    """由对局行重建对局 FSM（服务端唯一事实源，DATABASE §3.2 映射）。"""
    return GameFsm(GameState.from_db(game["status"]))


def is_double_pass_consecutive(moves: list[dict], reset_move_no: Optional[int]) -> bool:
    """末两手均为 PASS，且**均晚于**双 PASS 计数边界（BUG-025）。

    - 边界 ``games.pass_reset_move_no`` 由结算取消（``scoring.cancel``）写入当前手数：
      取消前的 PASS 已属于上一次结算尝试，不得与取消后新产生的一手 PASS 配对 ——
      落实 UI 文案「需再次双 PASS 才可进入结算」；
    - 两侧 PASS 均为边界后新落子（``moves[-2].move_no > reset``）才判定双 PASS。
    """
    if len(moves) < 2 or not all(m["is_pass"] for m in moves[-2:]):
        return False
    return int(moves[-2]["move_no"]) > int(reset_move_no or 0)


@dataclass(frozen=True)
class PlayerInfo:
    """对局参与方（姓名/段位可选录入）。"""

    name: Optional[str] = None
    rank: Optional[str] = None


@dataclass(frozen=True)
class AiParams:
    """人机 AI 参数。"""

    style: str = "standard"          # standard | human
    level: Optional[int] = None      # 1-12；None=按段位自动匹配
    adaptive: bool = False


@dataclass(frozen=True)
class CreateGameParams:
    """创建对局参数（对应 API §3.1.1 载荷）。"""

    mode: str = "human_human"
    board_size: int = 19
    rules: str = "chinese"
    komi: Optional[float] = None     # None=默认（分先 7.5 / 让子 0）
    handicap: int = 0
    color: str = "B"                 # 仅人机：人类执子颜色（默认 B；让子棋强制 B）
    black: PlayerInfo = field(default_factory=PlayerInfo)
    white: PlayerInfo = field(default_factory=PlayerInfo)
    ai: Optional[AiParams] = None
    coaching: bool = False


@dataclass
class PlayResult:
    """落子结果（对弈 WS 推送载荷，API §4.3）。"""

    move_no: int
    color: str
    x: Optional[int] = None
    y: Optional[int] = None
    is_pass: bool = False
    captures: int = 0
    #: 对局层面
    game_over: bool = False         # 认输即时终局
    entering_scoring: bool = False   # 双 PASS → 进入结算
    auto_pass: Optional["PlayResult"] = None  # 无子可下自动 PASS
    ai_move: Optional["PlayResult"] = None  # 人机：AI 落子结果
    ai_pending: bool = False         # 人机：AI 侧挂起（引擎不可用，TURN_AI）
    ai_cancelled: bool = False       # 人机：AI 应手被悔棋中断（查询已终止/结果丢弃，不落子）
    ai_deferred: bool = False        # 人机：AI 应手交由后台任务（WS defer_ai 模式）


@dataclass
class UndoResult:
    """悔棋结果（ISSUE-039 统一语义）。"""

    undone_move_no: int     # 被撤销的最后一手（原 last_move_no）
    new_last_move_no: int   # 悔棋后的手数
    steps: int              # 本次撤销步数（人机：1=己方末手/2=对方已落子；人人恒 1）
    undo_count: int         # 全局悔棋累计步数（只增不减，重开归零，上限判定）


class GameService:
    """对局领域服务。"""

    def __init__(
        self,
        conn,
        config: AppConfig,
        *,
        human_model_available: bool = True,
        human_model_available_fn: Optional[Callable[[], bool]] = None,
        engine=None,
        adaptive=None,
        analysis=None,
    ) -> None:
        self._conn = conn
        self._cfg = config
        #: 人类模型可用性快照（启动时由 engine.has_human_model / 状态快照注入）
        self._human_model_available = human_model_available
        #: 人类模型可用性**活取**（bootstrap 接线当前引擎实例：安全重启重建后不失真）；
        #: 无活取时回退快照（替身/Mock 测试）
        self._human_model_available_fn = human_model_available_fn
        #: 引擎管理器抽象（EngineManager 兼容：submit/状态；T3.3 人机 AI 落子）
        self._engine = engine
        #: 自适应难度组件（T3.8 注入；None=不启用自适应降级）
        self._adaptive = adaptive
        #: 分析服务（T3.6/T3.7 注入；None=不缓存分析结果）
        self._analysis = analysis
        #: 按对局串行化锁（M-3；对局删除时经 release_game 回收）
        self._game_locks: dict[int, _GameLock] = {}
        #: 人机 AI 应手在途查询 id（game_id → query id；悔棋经此定位并 terminate）
        self._ai_inflight: dict[int, str] = {}
        #: AI 应手中断标志（game_id → 应手局面 last_move_no；悔棋登记、_ai_move 消费）
        self._ai_abort: dict[int, int] = {}
        #: AI 应手挂起原因（game_id → (code, message)；随 game.state 可选字段回投，R2）
        self._ai_pending: dict[int, tuple[str, str]] = {}
        #: 棋盘前缀缓存（M-8）：game_id → (last_move_no, 快照)——同手数直接拷贝，
        #: 较旧快照 + delta 增量回放；悔棋/重开/删除（结构变化）经 ``_bump_analysis_version``
        #: 失效（否则重开后的同手数局面可能命中旧快照）
        self._board_cache: dict[int, tuple[int, GoBoard]] = {}

    def _lock_for(self, game_id: int) -> _GameLock:
        """取/建对局锁（M-3）。"""
        lock = self._game_locks.get(game_id)
        if lock is None:
            lock = _GameLock()
            self._game_locks[game_id] = lock
        return lock

    def release_game(self, game_id: int) -> None:
        """对局删除后回收对局锁（M-2/M-3：防止 ``_game_locks`` 无界增长）。

        **被持有的锁不回收**（R5，2026/09/16 评审批次）：删除发生在在途操作（如
        AI 应手持有对局锁）时 pop，会让该任务后续的嵌套取锁新建另一把锁——同局
        两把锁等于互斥失效（并发写者可能争用同一 ``move_no``）。持锁场景保留条目
        （对局已删，不再有新操作；条目体量极小）。
        """
        lock = self._game_locks.get(game_id)
        if lock is not None and lock.is_held:
            logger.debug("对局 #%d 已删除：对局锁仍被持有，暂不回收", game_id)
            return
        self._game_locks.pop(game_id, None)
        self._ai_pending.pop(game_id, None)

    async def delete_game(self, game_id: int) -> bool:
        """删除对局（M-6，2026/09/19 决策 B：先中止在途 AI + 锁内删除 + 内存态回收）。

        旧流程（路由直接 ``repos.delete_game`` + ``release_game``）的两个残留：
        ① 删除可与在途 AI 写库交错 → 命中已删对局外键 IntegrityError，以
        INTERNAL_ERROR 暴露给前端；② 锁被持有时条目滞留内存，无后续回收。
        本入口先经 ``_locked_after_ai_abort``：登记中断 + terminate 在途查询，
        再取锁（持锁即无在途 AI——其结果一律丢弃），锁内删除；随后二次取锁
        等早先排队的任务 fail-fast 退出，回收 ``_ai_pending/_ai_inflight`` 与
        （未被持有的）对局锁条目。

        @returns 是否删除（False=对局不存在）
        """
        async with self._locked_after_ai_abort(game_id):
            deleted = await repos.delete_game(self._conn, game_id)
        if not deleted:
            return False
        async with self._lock_for(game_id):  # 等早先排队任务（GAME_NOT_FOUND）退出
            pass
        self._ai_pending.pop(game_id, None)
        self._ai_abort.pop(game_id, None)
        self._ai_inflight.pop(game_id, None)
        self._board_cache.pop(game_id, None)
        lock = self._game_locks.get(game_id)
        if lock is not None and not lock.is_held:
            self._game_locks.pop(game_id, None)
        return True

    def game_lock(self, game_id: int) -> _GameLock:
        """对局锁（仅 WS 收尾广播用：让「截断复查 + 广播」原子化，R4）。

        供 ``ws_game._spawn_ai_followup`` 在收尾推送期间持锁，避免悔棋插在复查与
        广播之间（客户端先收截断后的状态、又收迟到 ``move.applied`` → 已撤之子
        被前端“复活”）。**禁止在持锁时等待慢 I/O**（广播为短操作）。
        """
        return self._lock_for(game_id)

    def update_config(self, cfg: AppConfig) -> None:
        """运行期配置热更新（H-1）：刷新本服务与自适应组件持有的配置引用。"""
        self._cfg = cfg
        if self._adaptive is not None:
            self._adaptive.update_config(cfg)

    def set_engine(
        self,
        engine,
        *,
        human_model_available_fn: Optional[Callable[[], bool]] = None,
    ) -> None:
        """迟绑定引擎管理器（BUG-097）：文件缺失降级（engine=None）后管理端重建装配。

        - ``human_model_available_fn`` 活取当前引擎实例的人类模型可用性（替身/无引擎
          时回退创建时快照 ``_human_model_available``），保证重建后判定不失真；
        - 已在途对局不受影响（AI 应手仅在玩家落子后经 ``self._engine`` 发起）。
        """
        self._engine = engine
        if human_model_available_fn is not None:
            self._human_model_available_fn = human_model_available_fn

    # ---- T3.2 创建对局 ----

    async def create(self, params: CreateGameParams) -> int:
        """创建对局（status='created'），返回 game_id。

        校验与映射：
        - 模式/棋盘/规则/让子数合法性；
        - **让子 + 非整贴目** 非法组合拒绝；让子棋默认不贴目（komi=0）；
        - 人类模型缺失时禁用人类风格/自适应（仅标准风格可用，PRD §4.1.1）；
        - 录入段位自动匹配难度档位（固定难度预选；自适应初始水平=段位）；
        - players 档案 upsert（姓名+段位均录入时）+ 黑白 name/rank 快照。
        """
        await self._validate_create(params)
        ai = params.ai or AiParams()
        is_human_ai = params.mode == "human_ai"

        # 让子贴目默认与非法组合
        komi = params.komi
        if params.handicap > 0:
            if komi is None:
                komi = 0.0
            if float(komi) != int(komi):
                raise AppError(
                    ErrorCode.INVALID_PAYLOAD, "让子棋贴目必须为整数（让子 + 非整贴目非法组合）"
                )
        elif komi is None:
            komi = self._cfg.play.default_komi

        # 人类执子颜色（仅人机；让子棋默认人类执黑放置让子）
        color = "B"
        if is_human_ai:
            color = params.color
            if params.handicap > 0:
                color = "B"

        # 难度/风格/自适应映射
        ai_style: Optional[str] = None
        ai_level: Optional[int] = None
        adaptive_enabled = False
        adaptive_initial_level: Optional[str] = None
        if is_human_ai:
            human = params.black if color == "B" else params.white
            rank = human.rank
            adaptive_enabled = bool(ai.adaptive)
            if adaptive_enabled:
                # 自适应：初始水平 = 录入段位 或 配置默认；默认人类风格
                adaptive_initial_level = rank or self._cfg.play.adaptive_initial_level
                if adaptive_initial_level not in RANK_LEVELS:
                    raise AppError(ErrorCode.PLAYER_INVALID_RANK, "非法段位")
                ai_level = rank_to_level(adaptive_initial_level)
                ai_style = "human"
            else:
                if rank:
                    ai_level = rank_to_level(rank)
                elif ai.level is not None:
                    ai_level = ai.level
                else:
                    raise AppError(
                        ErrorCode.INVALID_PAYLOAD, "请选择难度档位（未录入段位时需手动选择）"
                    )
                ai_style = ai.style

        # players 档案 upsert + 快照
        black_player_id = None
        if params.black.name and params.black.rank:
            black_player_id = await repos.upsert_player(
                self._conn, name=params.black.name, rank=params.black.rank
            )
        white_player_id = None
        if params.white.name and params.white.rank:
            white_player_id = await repos.upsert_player(
                self._conn, name=params.white.name, rank=params.white.rank
            )

        # 名称快照：人机 AI 侧默认落「AI」（不落「真人」；展示层按对局参数
        # 另行派生难度/风格 — 2026/09/10 人工反馈）
        ai_side = None
        if is_human_ai:
            ai_side = "white" if color == "B" else "black"
        black_name = params.black.name or ("AI" if ai_side == "black" else "真人")
        white_name = params.white.name or ("AI" if ai_side == "white" else "真人")

        game_id = await repos.create_game(
            self._conn,
            mode=params.mode,
            board_size=params.board_size,
            rules=params.rules,
            komi=komi,
            handicap=params.handicap,
            human_color=color,
            black_player_id=black_player_id,
            black_name=black_name,
            black_rank=params.black.rank,
            white_player_id=white_player_id,
            white_name=white_name,
            white_rank=params.white.rank,
            ai_style=ai_style,
            ai_level=ai_level,
            adaptive_enabled=adaptive_enabled,
            adaptive_initial_level=adaptive_initial_level,
            coaching_enabled=params.coaching,
            # BUG-026 链精度整局冻结：按当时配置与对局参数计算并快照——此后
            # 管理页调参/等级表调整/自适应档位漂移均不影响本局
            chain_visits=chain_visits(
                self._cfg,
                {
                    "mode": params.mode,
                    "ai_style": ai_style,
                    "ai_level": ai_level,
                    "adaptive_enabled": adaptive_enabled,
                },
            ),
        )
        logger.info(
            "创建对局 #%d · 模式=%s · 让子=%d",
            game_id, _MODE_TEXT.get(params.mode, params.mode), params.handicap,
        )
        return game_id

    async def _validate_create(self, params: CreateGameParams) -> None:
        """创建对局参数校验（快速失败）。"""
        if params.mode not in VALID_MODES:
            raise AppError(ErrorCode.INVALID_PAYLOAD, f"非法对局模式: {params.mode}")
        if params.board_size not in VALID_BOARD_SIZES:
            raise AppError(ErrorCode.INVALID_PAYLOAD, "棋盘大小仅支持 9/13/19")
        if params.rules not in VALID_RULESETS:
            raise AppError(ErrorCode.INVALID_PAYLOAD, "规则集仅支持 chinese/japanese/aga")
        if params.handicap != 0 and params.handicap not in HANDICAP_RANGE:
            raise AppError(ErrorCode.INVALID_PAYLOAD, "让子数仅支持 2-9 子（0=分先）")
        limit = handicap_limit(params.board_size)
        if params.handicap > limit:
            raise AppError(
                ErrorCode.INVALID_PAYLOAD, f"{params.board_size} 路棋盘最多让 {limit} 子"
            )

        is_human_ai = params.mode == "human_ai"
        if not is_human_ai and params.ai is not None:
            raise AppError(ErrorCode.INVALID_PAYLOAD, "人人对弈不接受 ai 参数")

        if is_human_ai:
            ai = params.ai or AiParams()
            if ai.style not in VALID_STYLES:
                raise AppError(ErrorCode.INVALID_PAYLOAD, f"非法 AI 风格: {ai.style}")
            if not self._has_human_model() and (ai.style == "human" or ai.adaptive):
                raise AppError(
                    ErrorCode.INVALID_PAYLOAD, "人类模型不可用：仅标准风格可用（人类模型缺失降级）"
                )
            if ai.level is not None and not (1 <= ai.level <= 12):
                raise AppError(ErrorCode.INVALID_PAYLOAD, "难度档位仅支持 1-12")
            if params.color not in ("B", "W"):
                raise AppError(ErrorCode.INVALID_PAYLOAD, "执子颜色仅支持 B/W")
            for side in (params.black, params.white):
                if side.rank is not None and side.rank not in RANK_LEVELS:
                    raise AppError(ErrorCode.PLAYER_INVALID_RANK, f"非法段位: {side.rank}")

    # ---- 共享辅助（T3.3-T3.5） ----

    async def _require_game(self, game_id: int) -> dict:
        """按 id 取对局行；不存在抛 GAME_NOT_FOUND（快速失败）。"""
        game = await repos.get_game(self._conn, game_id)
        if game is None:
            raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
        return game

    def _next_color(self, game: dict) -> str:
        """当前应落子方（让子棋白先，其余黑先；DATABASE §3.3 顺序）。"""
        return self._next_color_after(game, game["last_move_no"])

    def _next_color_after(self, game: dict, after_move_no: int) -> str:
        """第 ``after_move_no`` 手落定后的应落子方（让子棋白先）。"""
        move_no = after_move_no + 1
        if game["handicap"] > 0:
            return "W" if move_no % 2 == 1 else "B"
        return "B" if move_no % 2 == 1 else "W"

    def _ai_color(self, game: dict) -> str:
        """人机：AI 执子颜色（与人类相反）。"""
        return "W" if game["human_color"] == "B" else "B"

    def _is_human_ai(self, game: dict) -> bool:
        return game["mode"] == "human_ai"

    async def _build_board(
        self, game: dict, *, moves: Optional[list[dict]] = None
    ) -> GoBoard:
        """由对局行重建棋盘（含让子初始石 + 已落子序列回放；PASS 结束劫争）。

        M-8 前缀缓存：``_board_cache`` 保存「最近一次构建手数 + 快照」——
        - 同手数 → 直接返回拷贝（零回放）；
        - 较旧快照 → 仅增量回放 ``cached+1..`` 的 delta（让子石不重放）；
        - 结构变化（悔棋/重开/删除）经 ``_bump_analysis_version``/``delete_game``
          失效（避免重开后同手数命中旧快照）。

        历史数据与当前规则不一致（如让子点位修订前的旧对局）时抛
        ``REPLAY_CONFLICT``（领域化错误码，ISSUE-064），不向调用方抛底层规则异常。
        """
        game_id = game["id"]
        move_no = int(game["last_move_no"] or 0)
        cached = self._board_cache.get(game_id)
        if cached is not None and cached[0] == move_no:
            return cached[1].copy()
        if moves is None:
            moves = await repos.list_moves(self._conn, game_id)
        try:
            if cached is not None and 0 <= cached[0] < move_no:
                board = cached[1].copy()
                for m in moves:
                    if m["move_no"] <= cached[0]:
                        continue
                    if m["is_pass"]:
                        board.pass_turn()
                    else:
                        board.play(int(m["x"]), int(m["y"]), m["color"])
            else:
                board = GoBoard(game["board_size"])
                if game["handicap"] > 0:
                    board.place_handicap(handicap_points(game["board_size"], game["handicap"]))
                for m in moves:
                    if m["is_pass"]:
                        board.pass_turn()
                    else:
                        board.play(int(m["x"]), int(m["y"]), m["color"])
        except GoRulesError as exc:
            raise AppError(
                ErrorCode.REPLAY_CONFLICT,
                f"对局记录无法回放：历史数据与当前规则不符（{exc}）",
            ) from None
        self._board_cache[game_id] = (move_no, board.copy())
        return board

    def _validate_player_turn(self, game: dict, color: str, *, allow_ai: bool = False) -> None:
        """落子方校验：人人交替；人机对外仅人类可落其执色（AI 内部调用 allow_ai）。"""
        next_color = self._next_color(game)
        if color != next_color:
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"当前应为 {next_color} 方落子")
        if not allow_ai and self._is_human_ai(game) and color != game["human_color"]:
            raise AppError(ErrorCode.ILLEGAL_ACTION, "当前为 AI 回合，请等待")

    async def requester_color(self, game_id: int) -> str:
        """WS 操作请求方颜色（服务端唯一事实源，API §4.3）。

        - 人机对弈：人类执子颜色（AI 落子为内部操作，WS 不接收）；
        - 人人对弈：当前应落子方（共享棋盘语义——落子/PASS/悔棋/认输
          均由当前回合方发起，ISSUE-039 悔棋步数以此口径判定）。
        """
        game = await self._require_game(game_id)
        if self._is_human_ai(game):
            return game["human_color"]
        return self._next_color(game)

    async def _start_if_needed(self, game: dict) -> None:
        """开局就绪：CREATED → PLAYING（首次落子/PASS 自动开局）。"""
        if game["status"] == "created":
            await repos.update_game_status(self._conn, game["id"], "active")

    async def _notify_committed(
        self,
        game_id: int,
        result: PlayResult,
        callback: Optional[Callable[[PlayResult], Awaitable[None]]],
    ) -> None:
        """落子已落库（含提子/首手分析提交）后回调（WS 层即时广播，先于 AI 应手）。"""
        if callback is not None:
            await callback(result)

    def _bump_analysis_version(self, game_id: int) -> None:
        """局面**结构变化**（悔棋/重开）→ 递增主谱分析版本号 + 失效棋盘缓存。

        旧任务按 ``seq`` 过期丢弃（ARCHITECTURE §4.2 丢弃过期：悔棋/重开/试下
        分支变化后旧任务结果不写库、不推送）；**普通落子不递增**——每手局面的
        分析任务在新一手之后仍然有效（2026/09/10 修订，BUG-012：之前每手递增会
        把排队/进行中的每手分析全部误杀，低难度对局整局无分析数据）。

        M-8：棋盘前缀缓存同步失效——重开/悔棋后同手数局面与旧快照不同。
        """
        self._board_cache.pop(game_id, None)
        if self._analysis is not None:
            self._analysis.bump_version(game_id)

    def _level_param(self, game: dict):
        """当前档位难度参数（标准/人类模型 12 级映射，LEVEL.md）。"""
        level = game["ai_level"] or 1
        if self._is_human_style(game):
            return self._cfg.levels.human_at(level)
        return self._cfg.levels.standard_at(level)

    def _is_human_style(self, game: dict) -> bool:
        """是否人类风格（人类模型）：固定人类风格或自适应难度（二者均需人类模型）。"""
        return game["ai_style"] == "human" or bool(game["adaptive_enabled"])

    def _has_human_model(self) -> bool:
        """当前人类模型可用性。

        优先活取（bootstrap 注入：当前引擎实例——安全重启重建模型后仍为事实）；
        无活取时用启动时注入的快照。创建对局降级（PRD §4.1.1）与 AI 落子阻断
        （2026/09/10 人工决策 B2）共用本判定。
        """
        if self._human_model_available_fn is not None:
            return bool(self._human_model_available_fn())
        return self._human_model_available

    # ---- T6.1/T6.1-BUG-026 每手链精度分析管线 ----

    async def _schedule_move_analysis(
        self,
        game: dict,
        move_no: int,
        *,
        force_ai_turn: bool = False,
        all_moves: Optional[list[dict]] = None,
    ) -> None:
        """T6.1 逐手链精度分析：每手落定后提交该局面 ``main:{move_no}``。

        - 精度 = **链精度**（``chain_precision.chain_visits``：人人 / 低难度 =
          `standard_max_visits`；高难度 = 该档位对弈精度；自适应 = 人类 9D 精度）；
        - 分析服务/引擎不可用 → 不提交（降级矩阵：引擎恢复后的复盘可经全局分析补齐）；
        - **AI 待行局面跳过（BUG-026 修订）**：人机对弈且该局面下一手轮到 AI → 跳过，
          该局面链行一律由 AI 分支产出：自适应对局由判定前置分析
          （``_pre_analyze_turn_position``，BUG-028，先于判定与对弈查询）；其余由
          「对弈查询精度 == 链精度 → P0 单查询合并」或「AI 落子后补链精度 P1」覆盖；
        - 局面查询的 ``moves`` 截断至 ``move_no``（多手已落时保证局面位置正确）；
        - ``all_moves``（M-8）：调用方已读取的完整落子序列（可含本手合成行）——
          避免在同一事件链内重复 ``list_moves``；缺省自行读取；
        - 经调度器提交（链槽落库 / 200ms 节流推送 / 过期丢弃语义复用，T3.6）。
        """
        if self._analysis is None or self._engine is None:
            return
        if game.get("status") in ("scoring", "finished"):
            return
        if (
            not force_ai_turn
            and self._is_human_ai(game)
            and self._next_color_after(game, move_no) == self._ai_color(game)
        ):
            return
        if all_moves is None:
            all_moves = await repos.list_moves(self._conn, game["id"])
        moves = [m for m in all_moves if m["move_no"] <= move_no]
        query = self._build_chain_query(game, moves)
        await self._analysis.submit(game["id"], f"main:{move_no}", query)

    def _build_chain_query(self, game: dict, moves: list[dict]) -> dict:
        """链精度标准分析查询（``main:{move_no}`` 的 V_chain 标准查询）。

        逐手 P1（``_schedule_move_analysis``）与自适应判定前置分析
        （``_pre_analyze_turn_position``，BUG-028）共用同一构建入口——保证两条
        路径查询形状/精度完全一致（同链同精度，BUG-026 口径）。
        """
        return build_standard_query(
            board_size=int(game["board_size"]),
            rules=str(game["rules"]),
            komi=float(game["komi"]),
            moves=moves,
            # 让子局：分析查询同样携带初始石（BUG-013：否则按无让子局面分析）
            initial_stones=handicap_initial_stones(
                int(game["board_size"]), int(game["handicap"] or 0)
            ),
            max_visits=chain_visits(self._cfg, game),
        )

    async def _pre_analyze_turn_position(self, game: dict) -> bool:
        """自适应判定前置分析（BUG-028）：确保 AI 待行局面链行在判定前可用。

        - **背景**：AI 待行局面（人类刚落子后的局面）的链行原由 AI 侧产出（P0 合并 /
          落子后补 P1），而判定（``AdaptiveDifficulty.adjust``）在其之前执行 →
          ``_human_score_lead`` 读 ``main:{H}`` 恒为空，升级与 lead 降级路径不可达；
        - **语义**：提交与逐手 P1 **完全相同**的链精度标准查询并等待结果落链槽——
          判定用真·当前局面数据（LEVEL.md「当前盘面 Score Lead」），点评/曲线
          随之前移到 AI 应手前推送；
        - **悔棋中断（2026/09/13 修复）**：查询登记 ``_ai_inflight`` 并与中断标志
          竞速——悔棋可经 terminate 中止它，且不再等它跑完才能取得对局锁
          （否则「点悔棋后思考中迟迟不清除」）；被中断/登记后到达的结果一律
          丢弃（不落链、不推送——该局面即将被悔棋截断）；
        - 返回 True：该局面链行已可用（含已存在 ≥ V_chain 的重试/恢复情形，
          不重复分析），调用方据此跳过该局面的合并/补 P1；
        - 返回 False：分析服务/引擎不可用、查询失败或被悔棋中断 → 回退既有路径
          （分析降级不得阻断 AI 落子；判定无数据时保守 KEEP；中断标志留给
          ``_ai_move`` 预提交检查统一消费与退出）。
        """
        if self._analysis is None or self._engine is None:
            return False
        move_no = int(game["last_move_no"] or 0)
        existing = await repos.get_main_analysis(self._conn, game["id"], move_no)
        if existing is not None and int(existing["max_visits"] or 0) >= chain_visits(
            self._cfg, game
        ):
            return True
        all_moves = await repos.list_moves(self._conn, game["id"])
        moves = [m for m in all_moves if m["move_no"] <= move_no]
        query = self._build_chain_query(game, moves)
        query_id = str(
            query.get("id") or f"tgo-chain-{game['id']}-{move_no}-{uuid4().hex[:6]}"
        )
        query["id"] = query_id
        self._ai_inflight[game["id"]] = query_id
        submit_task = asyncio.create_task(self._engine.submit(query))
        submit_task.add_done_callback(_consume_task_exception)
        abort_task = asyncio.create_task(self._wait_ai_abort(game["id"], move_no))
        try:
            done, _ = await asyncio.wait(
                {submit_task, abort_task}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            abort_task.cancel()
            self._ai_inflight.pop(game["id"], None)
        if abort_task in done:
            logger.info(
                "对局 #%d 判定前置链分析被悔棋中断（局面 main:%d，不再等待引擎响应）",
                game["id"],
                move_no,
            )
            return False
        try:
            response = submit_task.result()
        except (AppError, EngineQueryError) as exc:
            logger.warning(
                "对局 #%d 判定前置链分析失败（回退合并/补 P1）：%s", game["id"], exc
            )
            return False
        if self._ai_abort.get(game["id"]) == move_no:
            # 引擎返回时悔棋已登记（结果到达晚于中断）：不落链、不推送
            logger.info(
                "对局 #%d 判定前置链分析被悔棋中断（局面 main:%d，查询已终止/丢弃）",
                game["id"],
                move_no,
            )
            return False
        await self._ingest_chain_row(
            game["id"],
            move_no,
            query,
            response,
            # M-5（2026/09/19 修复）：原检查在调用前——竞态窗口内登记的悔棋仍会把
            # 即将被截断的局面写入链槽；此处传入回调，由仓储在**写锁事务内**复核。
            stale_check=lambda: self._ai_abort.get(game["id"]) == move_no,
        )
        return True

    async def _ingest_chain_row(
        self,
        game_id: int,
        move_no: int,
        query: dict,
        response: dict,
        *,
        stale_check: Optional[Callable[[], bool]] = None,
    ) -> None:
        """查询响应 → 主谱链行（``main:{move_no}``）落库 + 节流推送。

        链槽的唯一写入入口，两条来源：
        - ① P0 对弈查询单查询合并（``V_play == V_chain``，BUG-026 修订）；
        - ② 自适应判定前置链分析（``_pre_analyze_turn_position``，BUG-028）。

        ``stale_check``（M-5）：过期回调透传分析调度器（写锁事务内求值），
        竞态窗口内的悔棋/重开不会写入陈旧链行。
        """
        if self._analysis is None:
            return
        from app.engine.preprocess import preprocess_analysis_response

        preprocessed = preprocess_analysis_response(
            response,
            max_moves=self._cfg.play.max_moves,
            analysis_pv_len=self._cfg.engine.analysis_pv_len,
            board_size=int(query.get("boardXSize") or 0) or None,
        )
        await self._analysis.ingest_result(
            game_id,
            f"main:{move_no}",
            preprocessed,
            max_visits=int(query.get("maxVisits") or 0),
            stale_check=stale_check,
        )

    # ---- T3.3 对局进行 ----

    async def start(self, game_id: int) -> Optional[PlayResult]:
        """开局就绪（M-3 串行化入口）。"""
        async with self._lock_for(game_id):
            return await self._start(game_id)

    async def _start(self, game_id: int, *, defer_ai: bool = False) -> Optional[PlayResult]:
        """开局就绪：CREATED → PLAYING；人机且轮到 AI 时触发 AI 首手。

        - 人人对弈/人机人类先行：首次落子自动开局（``_start_if_needed``）；
        - 人机 AI 先行（让子棋/人类执白）：经此显式开局并触发 AI 首手；
          引擎不可用时抛 ENGINE_*（上层转"AI 思考中"提示，TURN_AI 挂起）；
        - ``defer_ai=True``：AI 首手交后台（返回 ``ai_deferred`` 载体，WS 层调度）。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.CREATED, action="开局")
        fsm.start()
        await repos.update_game_status(self._conn, game["id"], "active")
        logger.info("对局 #%d 开局就绪", game_id)
        if self._is_human_ai(game) and self._next_color(game) == self._ai_color(game):
            if defer_ai:
                return PlayResult(
                    move_no=int(game["last_move_no"] or 0),
                    color=self._ai_color(game),
                    ai_deferred=True,
                )
            return await self.ai_move(game_id)
        return None

    async def start_or_resume_ai(self, game_id: int, *, defer_ai: bool = False) -> Optional[PlayResult]:
        """开局/续行（WS ``start``，M-3 串行化入口）：确保对局进入 PLAYING，并
        在**轮到 AI 时触发 AI 落子**（对弈基础流 T6.4）。

        - ``created``：激活开局（CREATED→PLAYING）；人机且轮到 AI（AI 先行：
          人类执白/让子局白先）→ 触发 AI 首手（``_start`` 语义）；
        - ``active`` 且人机轮到 AI（``TURN_AI`` 挂起——引擎恢复后的重试 / 断点
          恢复后 AI 待行）→ 恢复触发 AI 落子（``_ai_move`` 语义）；
        - ``defer_ai=True``（WS 后台化）：AI 应手不在此执行，返回 ``ai_deferred``
          载体（由 WS 层调度 ``resolve_ai_turn`` 后台任务）；
        - 其余（人人 / 轮到人类 / SCORING / FINISHED）抛 ``ILLEGAL_ACTION``（快速失败）。
        """
        async with self._locked_after_ai_abort(game_id):
            game = await self._require_game(game_id)
            fsm = fsm_from_game(game)
            # 仅 CREATED/PLAYING 可开局/续行；FINISHED/SCORING 经 FSM 推导统一错误
            fsm.require(GameState.CREATED, GameState.PLAYING, action="开局/续行")
            if game["status"] == "created":
                return await self._start(game_id, defer_ai=defer_ai)
            if self._is_human_ai(game) and self._next_color(game) == self._ai_color(game):
                if defer_ai:
                    return PlayResult(
                        move_no=int(game["last_move_no"] or 0),
                        color=self._ai_color(game),
                        ai_deferred=True,
                    )
                return await self._ai_move(game_id)
            raise AppError(ErrorCode.ILLEGAL_ACTION, "当前无需开局或 AI 落子")

    async def play(
        self,
        game_id: int,
        *,
        x: int,
        y: int,
        color: str,
        _internal: bool = False,
        on_committed: Optional[Callable[["PlayResult"], Awaitable[None]]] = None,
        defer_ai: bool = False,
    ) -> PlayResult:
        """落子（M-3 串行化入口）：对局级可重入锁内执行读-判-写临界区。

        ``defer_ai=True``（WS 后台化，2026/09/13）：人机且轮到 AI 时**不同步执行
        AI 应手**，仅置 ``result.ai_deferred``——由 WS 层调度 ``resolve_ai_turn``
        后台任务；AI 思考期间不阻塞消息循环（悔棋可即时受理并中断在途查询）。
        """
        async with self._lock_for(game_id):
            return await self._play(
                game_id, x=x, y=y, color=color, _internal=_internal,
                on_committed=on_committed, defer_ai=defer_ai,
            )

    async def _play(
        self,
        game_id: int,
        *,
        x: int,
        y: int,
        color: str,
        _internal: bool = False,
        on_committed: Optional[Callable[["PlayResult"], Awaitable[None]]] = None,
        defer_ai: bool = False,
    ) -> PlayResult:
        """落子：规则校验（吃子/禁入/打劫）+ 单事务写入。

        - 首次落子自动开局（CREATED→PLAYING）；
        - 人机对弈：人类落子后若轮到 AI，同步触发 AI 落子；
          引擎不可用时 AI 侧挂起（``ai_pending=True``，TURN_AI 提示，引擎解耦）；
        - ``_internal=True`` 供 AI 落子内部调用（跳过 human_ai 人类执色校验）；
        - ``on_committed``：本手落库后立即回调（**先于 AI 应手**）——供 WS 层即时
          广播本方落子，人机对弈时人类棋子不再等 AI 落子一起显示（2026/09/10）。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.PLAYING, GameState.CREATED, action="落子")
        self._validate_player_turn(game, color, allow_ai=_internal)

        # M-8：单次读取落子序列——棋盘构建与逐手分析共用（旧实现各自 list_moves）
        all_moves = await repos.list_moves(self._conn, game_id)
        board = await self._build_board(game, moves=all_moves)
        try:
            captured = board.play(x, y, color)
        except GoRulesError as exc:
            raise AppError(ErrorCode.ILLEGAL_MOVE, str(exc)) from None

        await self._start_if_needed(game)
        move_no = game["last_move_no"] + 1
        await repos.append_move(
            self._conn, game_id=game_id, move_no=move_no, color=color, x=x, y=y
        )
        # ISSUE-047 方案 1：累计提子数落库（持久化，断点恢复不丢失）
        if captured > 0:
            await repos.add_captures(self._conn, game_id, color, captured)
        # M-8：本手合成行（尚未进入 all_moves 快照）供逐手分析切片使用
        played_row = {
            "move_no": move_no, "color": color, "x": x, "y": y, "is_pass": False
        }
        # 首手：初始局面 main:0 标准分析（保证曲线/报告覆盖 0..N；AI 先行局由 AI
        # 侧 P0 单查询合并/补 P1 覆盖，_schedule_move_analysis 内按规则跳过）
        if move_no == 1:
            await self._schedule_move_analysis(game, 0, all_moves=all_moves)
        # T6.1 逐手 P1：提交该局面标准分析（人机且轮到 AI 时跳过——AI P0 单查询合并）
        await self._schedule_move_analysis(
            game, move_no, all_moves=[*all_moves, played_row]
        )
        result = PlayResult(
            move_no=move_no, color=color, x=x, y=y, captures=captured
        )
        logger.debug(
            "对局 #%d · 第 %d 手 %s 落子 (%d,%d)，提 %d 子",
            game_id, move_no, _COLOR_TEXT.get(color, color), x, y, captured,
        )

        await self._notify_committed(game_id, result, on_committed)
        if defer_ai and self._is_human_ai(game) and self._next_color_after(game, result.move_no) == self._ai_color(game):
            # AI 应手后台化（2026/09/13）：不阻塞消息循环，思考期间悔棋可即时受理
            # （经 terminate 中止在途查询）；广播由 WS 层后台任务收尾
            result.ai_deferred = True
            return result
        await self._maybe_trigger_ai(game_id, game, result)
        if not result.ai_cancelled:
            await self._handle_no_moves(game_id, result)
        return result

    async def pass_move(
        self,
        game_id: int,
        *,
        color: str,
        _internal: bool = False,
        on_committed: Optional[Callable[["PlayResult"], Awaitable[None]]] = None,
        defer_ai: bool = False,
    ) -> PlayResult:
        """PASS（M-3 串行化入口；``defer_ai`` 语义同 :meth:`play`）。"""
        async with self._lock_for(game_id):
            return await self._pass_move(
                game_id, color=color, _internal=_internal,
                on_committed=on_committed, defer_ai=defer_ai,
            )

    async def _pass_move(
        self,
        game_id: int,
        *,
        color: str,
        _internal: bool = False,
        on_committed: Optional[Callable[["PlayResult"], Awaitable[None]]] = None,
        defer_ai: bool = False,
    ) -> PlayResult:
        """PASS：单方 PASS 对方可落子；双 PASS 触发终局（进入结算）。"""
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.PLAYING, GameState.CREATED, action="PASS")
        self._validate_player_turn(game, color, allow_ai=_internal)

        await self._start_if_needed(game)
        move_no = game["last_move_no"] + 1
        await repos.append_move(
            self._conn, game_id=game_id, move_no=move_no, color=color, is_pass=True
        )
        result = PlayResult(move_no=move_no, color=color, is_pass=True)
        # 双 PASS → 终局（进入结算，SCORING）；边界内的旧 PASS 不参与配对（BUG-025）
        moves = await repos.list_moves(self._conn, game_id)
        if is_double_pass_consecutive(moves, game.get("pass_reset_move_no")):
            fsm.enter_scoring()
            await repos.update_game_status(self._conn, game_id, "scoring")
            result.entering_scoring = True
            logger.info("对局 #%d 双 PASS，进入结算", game_id)
            await self._notify_committed(game_id, result, on_committed)
            return result

        # 首手：初始局面 main:0 标准分析（同上，SEE _play）
        if move_no == 1:
            await self._schedule_move_analysis(game, 0, all_moves=moves)
        # T6.1 逐手 P1：单方 PASS（对局继续）→ 提交该局面标准分析
        await self._schedule_move_analysis(game, move_no, all_moves=moves)
        await self._notify_committed(game_id, result, on_committed)
        if defer_ai and self._is_human_ai(game) and self._next_color_after(game, result.move_no) == self._ai_color(game):
            result.ai_deferred = True
            return result
        await self._maybe_trigger_ai(game_id, game, result)
        if not result.ai_cancelled:
            await self._handle_no_moves(game_id, result)
        return result

    async def _handle_no_moves(self, game_id: int, result: PlayResult) -> None:
        """无子可下自动 PASS（真围棋规则：无合法着法必须 PASS）。

        - 当前方无合法落点 → 自动 PASS；对方亦无 → 双 PASS 进入结算（SCORING）；
        - 记录自动 PASS 到 ``result.auto_pass``，避免对弈流阻塞。
        """
        game = await self._require_game(game_id)
        if game["status"] != "active":
            return
        # M-8：序列只读一次——棋盘（前缀缓存增量）与后续逐手分析共用
        all_moves = await repos.list_moves(self._conn, game_id)
        board = await self._build_board(game, moves=all_moves)
        next_color = self._next_color(game)
        if board.has_legal_move(next_color):
            return
        # 当前方自动 PASS
        move_no = game["last_move_no"] + 1
        await repos.append_move(
            self._conn, game_id=game_id, move_no=move_no, color=next_color, is_pass=True
        )
        result.auto_pass = PlayResult(move_no=move_no, color=next_color, is_pass=True)
        auto_pass_row = {
            "move_no": move_no, "color": next_color, "x": None, "y": None, "is_pass": True
        }
        # 对方亦无着法 → 双 PASS 进入结算
        game2 = await self._require_game(game_id)
        # M-8：单方 PASS 等价于 pass_turn（清劫）——复用棋盘免二次全量回放
        board.pass_turn()
        next2 = self._next_color(game2)
        if not board.has_legal_move(next2):
            move_no2 = game2["last_move_no"] + 1
            await repos.append_move(
                self._conn, game_id=game_id, move_no=move_no2, color=next2, is_pass=True
            )
            fsm = fsm_from_game(game2)
            fsm.enter_scoring()
            await repos.update_game_status(self._conn, game_id, "scoring")
            # BUG-026 补链（人工确认）：终局局面由深算预判落库补齐，但**终局前一手**
            # （第一个自动 PASS 局面）须补链精度分析，否则覆盖 0..N 不完整
            # （force_ai_turn：此处可能轮到 AI，但双方均无子可下、AI 不会再应手）
            await self._schedule_move_analysis(
                game2, move_no, force_ai_turn=True,
                all_moves=[*all_moves, auto_pass_row],
            )
            result.entering_scoring = True
            logger.info("对局 #%d 双方无子可下，进入结算", game_id)
            return
        # 单方自动 PASS（对方可落子）→ 该局面每手分析（T6.1）
        await self._schedule_move_analysis(
            game, move_no, all_moves=[*all_moves, auto_pass_row]
        )

    async def _maybe_trigger_ai(self, game_id: int, game: dict, result: PlayResult) -> None:
        """人机对弈：人类落子后若轮到 AI，触发 AI 落子（引擎解耦）。"""
        if not self._is_human_ai(game):
            return
        # 以刚落子的手数为准判断下一方（避免陈旧 last_move_no）
        if self._next_color_after(game, result.move_no) != self._ai_color(game):
            return
        try:
            ai_result = await self.ai_move(game_id)
        except AppError as exc:
            if exc.code in (
                ErrorCode.ENGINE_BUSY,
                ErrorCode.ENGINE_DEAD,
                ErrorCode.ENGINE_FATAL,
                ErrorCode.HUMAN_MODEL_UNAVAILABLE,
            ):
                # AI 侧挂起（TURN_AI）：引擎/人类模型恢复后由前端重试，断点续弈可恢复
                result.ai_pending = True
                # 挂起原因（R2）：随 game.state 可选字段回投（前端提示/重试依据）
                self._ai_pending[game_id] = (exc.code.value, exc.message)
                logger.warning("对局 #%d AI 落子挂起：%s", game_id, exc.message)
                return
            raise
        if ai_result is None:
            # 悔棋中断（2026/09/13）：查询已终止/结果丢弃，AI 不落子；
            # move.undone/game.state 由 undo 侧统一广播
            result.ai_cancelled = True
            logger.info("对局 #%d AI 应手被悔棋中断（未落子）", game_id)
            return
        result.ai_move = ai_result
        self._ai_pending.pop(game_id, None)  # 应手成功：清除挂起原因（R2）
        # 终局标志上浮（BUG-029）：AI 应手（PASS/自动 PASS）完成双 PASS 进入结算时，
        # 标志须落到**外层**结果——WS 层仅据外层 ``entering_scoring`` 启动终局预判
        # （``_broadcast_play_result``），只留在 ``ai_move`` 会让结算面板永久等待
        if result.ai_move.entering_scoring:
            result.entering_scoring = True

    async def resolve_ai_turn(self, game_id: int) -> PlayResult:
        """AI 应手后台收尾（WS ``defer_ai`` 模式；不阻塞消息循环）。

        等价 ``_play`` 原尾段（``_maybe_trigger_ai`` + ``_handle_no_moves``），
        在对局锁内独立执行；返回**广播载体**（``ai_move``/``ai_pending``/
        ``ai_cancelled``/``auto_pass``/``entering_scoring``）：
        - 被悔棋中断（``ai_cancelled=True``）不落子——状态由 undo 侧广播；
        - 展开时已非 AI 回合（局面已变化）亦置 ``ai_cancelled=True``（无应手可播）；
        - 其余情况由 WS 层按 ``_broadcast_play_result`` 收尾。
        """
        async with self._lock_for(game_id):
            game = await self._require_game(game_id)
            carrier = PlayResult(
                move_no=int(game["last_move_no"] or 0),
                color=self._ai_color(game),
                ai_cancelled=True,  # 默认＝无 AI 应手（确认轮到 AI 时置 False）
            )
            if (
                game["status"] == "active"
                and self._is_human_ai(game)
                and self._next_color(game) == self._ai_color(game)
            ):
                carrier.ai_cancelled = False
                await self._maybe_trigger_ai(game_id, game, carrier)
            if not carrier.ai_cancelled:
                await self._handle_no_moves(game_id, carrier)
            return carrier

    async def ai_move(self, game_id: int) -> Optional[PlayResult]:
        """AI 落子（M-3 串行化入口）；悔棋中断时返回 None（查询已终止/结果丢弃）。"""
        async with self._lock_for(game_id):
            return await self._ai_move(game_id)

    async def _ai_move(self, game_id: int) -> Optional[PlayResult]:
        """人机对弈：AI 落子（引擎 P0 对弈查询 + 温度采样，ARCHITECTURE §3.4/§4.1）。

        - 构建对弈查询（难度/风格参数 + 让子编排；V_play=档位实际值，M-7 不抬高）；
        - **自适应判定前置分析（BUG-028）**：自适应对局在判定与对弈查询之前，先
          同步补算 AI 待行局面 ``main:{H}`` 的链精度链行
          （``_pre_analyze_turn_position``）——判定主指标（当前盘面 Score Lead）
          依赖该链行；成功则该局面不再重复分析（跳过合并/补 P1），失败回退；
        - **单查询合并（BUG-026 修订，取代 ISSUE-051 的“精度 ≥ 标准”口径）**：
          - ``V_play == 链精度``（`chain_precision.chain_visits`：高难度/自适应达 9D）
            → 对弈查询即该局面（``main:{H}``，H=AI 待行前手数）链行——结果经
            ``ingest_result`` 落链槽/推曲线，不再额外补 P1；
          - ``V_play < 链精度``（低难度 / 自适应未达 9D）→ 对弈查询**仅用于落子
            选择**，AI 落子完成后对 ``main:{H}`` 补链精度 P1（双查询）；
        - **人类模型未挂载（人类风格/自适应）→ 阻断**（2026/09/10 人工决策 B2）：
          不下发 `humanSLProfile` 查询（KataGo 会整体拒绝），抛
          ``HUMAN_MODEL_UNAVAILABLE``，上层转 AI 挂起并提示恢复后重试；
        - **低档位无候选 → 根策略采样回退**（同上人工决策 A1）：`maxVisits=1` 档位
          （人类 L1-L4 / 标准 L1-L2）搜索只访问根、`moveInfos` 为空，回退
          ``select_move_from_policy``（人类风格 `humanPolicy` / 标准 `policy`）；
        - 引擎不可用（INIT/DEAD/FATAL）抛 ENGINE_*（上层转挂起提示）；
        - AI 选择 PASS 时同样落子（记为 pass）。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.PLAYING, action="AI 落子")
        ai_color = self._ai_color(game)
        if self._next_color(game) != ai_color:
            raise AppError(ErrorCode.ILLEGAL_ACTION, "未轮到 AI 落子")
        if self._engine is None:
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用：AI 落子挂起")
        is_human_style = self._is_human_style(game)
        if is_human_style and not self._has_human_model():
            # 人类模型未挂载：humanSLProfile 查询会被引擎整体拒绝
            # （"Could not set settings: WARNING: humanSLProfile is specified as config
            #   param but model(s) don't use it"）→ 提前阻断（含存量人类风格对局）
            raise AppError(
                ErrorCode.HUMAN_MODEL_UNAVAILABLE,
                "人类模型不可用：无法继续人类风格对局，请恢复人类模型后重试",
            )

        # 自适应难度：判定前先补算当前（AI 待行）局面链行（BUG-028）→ 判定升/降/保持
        # + 写回档位 + 注入 PDA（T3.8）；前置分析失败则回退既有产出路径（保守 KEEP）
        adaptive_pda: Optional[float] = None
        chain_ready = False
        if game["adaptive_enabled"]:
            # 前置分析按**对局**语义执行（链行来源与是否注入判定组件无关）；
            # 判定本身仍需组件（``self._adaptive``，未注入时不跳档）
            chain_ready = await self._pre_analyze_turn_position(game)
        if game["adaptive_enabled"] and self._adaptive is not None:
            _, new_level, pda = await self._adaptive.adjust(game)
            game["ai_level"] = new_level
            adaptive_pda = pda

        moves = await repos.list_moves(self._conn, game_id)
        query = self._build_ai_query(game, moves, adaptive_pda=adaptive_pda)
        # 悔棋中断（2026/09/13 人工决策）：查询 id 登记在途，供 undo 侧经 KataGo
        # ``terminate`` 中止；提交前先消费一次中断标志（悔棋可能在 AI 预处理
        # （自适应前置分析等）期间就已到达）。id 带唯一后缀：悔棋撤销到同手数
        # 后再落子会再次触发同 token 查询，复用 id 时旧查询的迟到响应会被引擎
        # 层按 id 分发到新查询的 future（AI 拿旧局面结果落子 → "该点已有棋子"）
        abort_token = int(game["last_move_no"] or 0)
        query_id = str(query.get("id") or f"tgo-ai-{game_id}-{abort_token}-{uuid4().hex[:6]}")
        query["id"] = query_id
        if self._ai_abort.pop(game_id, None) == abort_token:
            logger.info("对局 #%d AI 应手在提交前被悔棋中断（局面 main:%d）", game_id, abort_token)
            return None
        v_play = int(query.get("maxVisits") or 0)
        v_chain = chain_visits(self._cfg, game)
        # BUG-026：仅当对弈查询精度与链精度**相等**时，结果才可作为该局面链行
        # （同链其它局面同精度；高难度即此情形）；BUG-028：判定前置分析已产出该
        # 局面链行（标准模型、V_chain）时不重复——避免同精度重复分析，且链行
        # 保持标准分析来源（与整链同精度同模型）
        merged = v_play == v_chain and not chain_ready
        self._ai_inflight[game_id] = query_id
        # 竞速等待（2026/09/13）：悔棋中断一旦登记，立即放弃等待引擎响应——
        # KataGo terminate 已尽力发出（节约搜索），但引擎过载时回包可能迟至
        # 查询超时（默认 180s）；死等会把 undo 一并拖住。submit 任务不取消：
        # 响应到达后由引擎层正常消费丢弃，仅需回调消费其可能的异常。
        submit_task = asyncio.create_task(self._engine.submit(query))
        submit_task.add_done_callback(_consume_task_exception)
        abort_task = asyncio.create_task(self._wait_ai_abort(game_id, abort_token))
        try:
            done, _ = await asyncio.wait(
                {submit_task, abort_task}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            abort_task.cancel()
            self._ai_inflight.pop(game_id, None)
        if abort_task in done:
            logger.info(
                "对局 #%d AI 应手被悔棋中断（局面 main:%d，不再等待引擎响应）",
                game_id, abort_token,
            )
            return None
        try:
            response = submit_task.result()
        except EngineQueryError as exc:
            # H-4 修复：引擎查询失败（超时/引擎返回 error）统一转 ENGINE_BUSY，
            # 由 _maybe_trigger_ai 转 AI 回合挂起——人类落子已提交并广播，
            # 不因 AI 侧失败导致整手对局状态分叉/客户端收到 INTERNAL_ERROR。
            self._ai_abort.pop(game_id, None)
            raise AppError(ErrorCode.ENGINE_BUSY, f"AI 落子引擎查询失败: {exc}") from exc
        # 引擎返回后再次消费中断标志：终止后的（部分）结果一律丢弃——不落子、
        # 不入链（该局面即将被悔棋截断；KataGo terminate 结果为尽力而为的部分数据）
        if self._ai_abort.pop(game_id, None) == abort_token:
            logger.info("对局 #%d AI 应手被悔棋中断（局面 main:%d，查询已终止/丢弃）", game_id, abort_token)
            return None
        # 高精度对弈查询结果即该局面（main:{last_move_no}）链行，落库+推送
        if merged:
            await self._ingest_chain_row(
                game_id, int(game["last_move_no"] or 0), query, response
            )
        move_infos = response.get("moveInfos") or []
        chosen = select_ai_move(move_infos, self._ai_temperature(game))
        if chosen is None:
            # A1 回退（2026/09/10 人工决策）：1 visit 档位根无子节点、moveInfos 为空
            # → 按根策略温度采样（GTP 语义；人类风格取 humanPolicy）
            policy_values = response.get("humanPolicy" if is_human_style else "policy")
            chosen = select_move_from_policy(
                policy_values,
                self._ai_temperature(game),
                board_size=int(game["board_size"]),
            )
            if chosen is not None:
                logger.debug(
                    "对局 #%d AI 低档位策略回退选点：%s", game_id, chosen.get("move")
                )
        if chosen is None:
            raise AppError(ErrorCode.ENGINE_BUSY, "引擎未返回可用落子点")

        move_str = str(chosen.get("move") or "")
        if is_pass_loc(move_str):
            result = await self.pass_move(game_id, color=ai_color, _internal=True)
        else:
            try:
                x, y = gtp_to_xy(move_str, board_size=int(game["board_size"]))
            except (ValueError, IndexError, TypeError):
                raise AppError(ErrorCode.ENGINE_BUSY, f"引擎返回非法落子点: {move_str}") from None
            result = await self.play(game_id, x=x, y=y, color=ai_color, _internal=True)
        # 双查询补充（BUG-026）：AI 待行局面 main:{H}（H=stale last_move_no）在
        # 对弈查询未合并（V_play < 链精度）时补链精度 P1；**不因进入结算而跳过**
        # （人工确认：终局由深算预判落库补齐，但终局**前一手**仍须补链，否则
        # 覆盖 0..N 不完整、报告需先 [补分析]）；判定前置分析已产出则跳过（BUG-028）
        if not merged and not chain_ready:
            await self._schedule_move_analysis(
                game, int(game["last_move_no"] or 0), force_ai_turn=True
            )
        return result

    async def _wait_ai_abort(self, game_id: int, abort_token: int) -> None:
        """轮询「悔棋中断」标志（与引擎提交竞速；由取消终结，不做超时）。"""
        while self._ai_abort.get(game_id) != abort_token:
            await asyncio.sleep(0.05)

    async def _request_ai_abort(self, game_id: int) -> None:
        """登记「AI 应手中断」（悔棋执行前调用，不需要对局锁）。

        - 标志值＝当前 ``last_move_no``（＝AI 应手正在计算的局面号），``_ai_move``
          在提交前/引擎返回后按该值比对消费；
        - 在途查询经 ``EngineManager.terminate`` 发 KataGo ``action=terminate``
          尽快中止搜索（尽力而为；已产出的部分结果由 ``_ai_move`` 丢弃，不落子）。
        """
        game = await repos.get_game(self._conn, game_id)
        if game is None:
            return
        self._ai_abort[game_id] = int(game["last_move_no"] or 0)
        query_id = self._ai_inflight.get(game_id)
        if query_id and self._engine is not None:
            terminated = await self._engine.terminate(query_id)
            if terminated:
                logger.info("对局 #%d 悔棋：已请求终止 AI 应手查询 %s", game_id, query_id)

    @asynccontextmanager
    async def _locked_after_ai_abort(self, game_id: int) -> AsyncGenerator[None, None]:
        """对局锁 + 在途 AI 应手中断（R1，2026/09/16 评审批次）。

        AI 应手全程持有对局锁（``resolve_ai_turn``/``_ai_move`` 在锁内等待引擎
        响应，最长至查询超时 180s）——用户意图（悔棋/认输/重开/续行）不得被在途
        查询排队拖住（否则引擎卡死时操作无任何反馈，且连接内消息循环被阻塞）：

        1. 先登记中断（``_request_ai_abort``：置标志 + ``terminate`` 在途查询）；
        2. 再取对局锁——在途 AI 任务经 ``_wait_ai_abort``（50ms 轮询）尽快退出，
           其（部分）结果一律丢弃（不落子、不入链）；
        3. **持锁即无在途 AI 任务**（AI 查询全程在锁内）→ 取锁后清标记，防残标
           误杀本操作后续触发的新查询（如重开后的 AI 应手）。
        """
        await self._request_ai_abort(game_id)
        async with self._lock_for(game_id):
            self._ai_abort.pop(game_id, None)
            try:
                yield
            finally:
                self._ai_abort.pop(game_id, None)

    def _ai_temperature(self, game: dict) -> float:
        """AI 落子加权采样温度（chosenMoveTemperature，仅后端采样不下发，ISSUE-037）。"""
        return self._level_param(game).chosen_move_temperature

    def _build_ai_query(
        self,
        game: dict,
        moves: list[dict],
        *,
        adaptive_pda: Optional[float] = None,
    ) -> dict:
        """构建对弈 P0 查询（难度参数配置化 + 让子编排）。"""
        handicap = handicap_initial_stones(
            int(game["board_size"]), int(game["handicap"] or 0)
        )
        # 显式类型局部变量（避免 dict 值联合类型无法传给 build_play_query）
        board_size: int = int(game["board_size"])
        rules: str = str(game["rules"])
        komi: float = float(game["komi"])
        analysis_pv_len: int = self._cfg.engine.analysis_pv_len

        level = int(game["ai_level"] or 1)
        if self._is_human_style(game):
            lp_human = self._cfg.levels.human_at(level)
            return build_play_query(
                board_size=board_size,
                rules=rules,
                komi=komi,
                moves=moves,
                initial_stones=handicap or None,
                max_visits=int(lp_human.max_visits),
                analysis_pv_len=analysis_pv_len,
                human_sl_profile=lp_human.human_sl_profile,
                playout_doubling_advantage=adaptive_pda,
                include_policy=True,
            )
        lp_std = self._cfg.levels.standard_at(level)
        return build_play_query(
            board_size=board_size,
            rules=rules,
            komi=komi,
            moves=moves,
            initial_stones=handicap or None,
            max_visits=int(lp_std.max_visits),
            analysis_pv_len=analysis_pv_len,
            wide_root_noise=lp_std.wide_root_noise,
            max_time=lp_std.max_time,
            # 低档位（maxVisits=1）回退策略采样需 `policy`（2026/09/10 人工决策 A1）
            include_policy=True,
        )

    def _undo_steps_for(self, game: dict, last: dict, color: str) -> int:
        """撤销步数（T6.4 修订 2026/09/06：人人对弈仅单步悔棋）。

        - 人机：末手为己方（对方未落子）→ 1；末手为对方（AI 已落子）→ 2；
        - **人人对弈：恒 1**（仅撤最后一手）——公平由对手确认
          （undo.request/undo.respond）保证，2026/09/06 人工反馈限定单步。
        """
        if self._is_human_ai(game):
            return 1 if last["color"] == color else 2
        return 1

    async def recount_captures(self, game_id: int) -> None:
        """按当前棋谱重算提子计数器（M-3 串行化入口；悔棋/重开/复弈/导入后调用）。"""
        async with self._lock_for(game_id):
            await self._recount_captures(game_id)

    async def _recount_captures(self, game_id: int) -> None:
        """提子计数器重算回写（BUG-031）。

        计数器为展示用累计值（``repos.add_captures`` 只在落子时 +N），因此悔棋/
        重开/复弈/导入后必须按**当前棋谱**回算，否则界面提子数虚高（撤掉的吃子手
        残留计数、新局不继承俘虏）；回放与结算同源（``scoring.replay_position``
        ——棋盘与双方俘虏一次产出）。
        """
        game = await self._require_game(game_id)
        moves = await repos.list_moves(self._conn, game_id)
        replayed = replay_position(
            board_size=int(game["board_size"]),
            handicap=int(game["handicap"] or 0),
            moves=moves,
        )
        await repos.set_captures(
            self._conn,
            game_id,
            black_captures=replayed.black_prisoners,
            white_captures=replayed.white_prisoners,
        )

    async def undo(self, game_id: int, *, color: str) -> UndoResult:
        """悔棋（M-3 串行化入口）。

        执行前先登记「AI 应手中断」（不需对局锁）：人机对弈在 AI 思考期间也可悔棋
        ——在途引擎查询经 KataGo ``terminate`` 尽快中止、结果丢弃（不落子），
        随后按末手语义撤 1 步（2026/09/13 人工决策）。

        **预检前置（2026/09/13 修复）**：额度不足/无子可悔等拒绝场景**不得触碰
        在途 AI 应手**——旧顺序（先 abort 后检查）在被拒时已中止 AI：用户看到
        「思考中」滞留（AI 被静默杀死、须等自动续行重试重算才清除）。预检为
        锁外只读检查；锁内 ``_undo`` 仍保留最终校验（预检→锁之间的罕见竞态下
        仍可能中止后拒绝，由调用方错误帧兜底）。
        """
        await self._undo_preflight(game_id, color=color)
        # R1：登记中断 → 取锁（在途 AI 任务尽快退出）→ 撤销（不再被引擎等待拖住）
        async with self._locked_after_ai_abort(game_id):
            return await self._undo(game_id, color=color)

    async def _undo_preflight(self, game_id: int, *, color: str) -> None:
        """人机悔棋预检（锁外、只读）：与 ``_undo`` 同源判定，供 ``undo`` 在
        触碰在途 AI 应手（abort/terminate）之前快速失败。"""
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.PLAYING, action="悔棋")
        if color not in ("B", "W"):
            raise AppError(ErrorCode.INVALID_PAYLOAD, "执子颜色仅支持 B/W")
        moves = await repos.list_moves(self._conn, game_id)
        if not moves:
            raise AppError(ErrorCode.ILLEGAL_ACTION, "无子可悔")
        steps = self._undo_steps_for(game, moves[-1], color)
        if self._is_human_ai(game):
            max_undo = self._cfg.play.max_undo
            if max_undo <= 0:
                raise AppError(ErrorCode.UNDO_LIMIT_REACHED, "悔棋功能已禁用")
            if int(game["undo_count"] or 0) + steps > max_undo:
                raise AppError(ErrorCode.UNDO_LIMIT_REACHED, "悔棋次数已达上限")

    async def undo_preflight(self, game_id: int, *, color: str) -> dict:
        """人人对弈悔棋申请**预检**（不执行，T6.4 人工确认 2026/09/06）。

        - 校验 PLAYING / 执色 / 无子可悔；返回撤销步数与基准手数（供
          ``undo.request`` 载荷与对手确认展示）；
        - **人人对弈：仅单步（steps=1）且不适用 max_undo 上限**（2026/09/06
          人工反馈：单步悔棋 + 对手确认，见 ws undo.request/undo.respond）。
        """
        async with self._lock_for(game_id):
            game = await self._require_game(game_id)
            fsm = fsm_from_game(game)
            fsm.require(GameState.PLAYING, action="悔棋")
            if color not in ("B", "W"):
                raise AppError(ErrorCode.INVALID_PAYLOAD, "执子颜色仅支持 B/W")
            moves = await repos.list_moves(self._conn, game_id)
            if not moves:
                raise AppError(ErrorCode.ILLEGAL_ACTION, "无子可悔")
            last = moves[-1]
            steps = self._undo_steps_for(game, last, color)
            return {
                "steps": steps,
                "base_move_no": int(game["last_move_no"] or 0),
            }

    async def _undo(self, game_id: int, *, color: str) -> UndoResult:
        """悔棋执行（ISSUE-039 统一语义 + T6.4 人工确认作用域修正）。

        规则：
        - **人人对弈（2026/09/06 修订）：仅单步悔棋**——只撤最后一手
          （不限次数，公平由对手确认 undo.request/undo.respond 保证）；
        - 人机：对方未落子（末手为己方）→ 撤 1；对方已落子（AI 末手）→ 撤 2；
        - **上限作用域（2026/09/06 人工确认）**：`config.play.max_undo` 全局计数
          上限**仅适用于人机对弈**（防滥用引擎）；**人人对弈悔棋不限制次数**
          ——公平性由「对手确认」（ws undo.request/undo.respond，热座或多设备）
          保证，本方法为确认通过后的执行路径；
        - 人机：计数只增不减、新落子不重置、重开归零；剩余预算不足整次悔棋时
          **整次拒绝**（原子操作，不部分执行）；
        - 单事务级联清理（``undo_moves_after``）；无子可悔抛 ``ILLEGAL_ACTION``。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.PLAYING, action="悔棋")
        if color not in ("B", "W"):
            raise AppError(ErrorCode.INVALID_PAYLOAD, "执子颜色仅支持 B/W")
        moves = await repos.list_moves(self._conn, game_id)
        if not moves:
            raise AppError(ErrorCode.ILLEGAL_ACTION, "无子可悔")
        last = moves[-1]
        steps = self._undo_steps_for(game, last, color)
        # 上限仅人机（T6.4 人工确认）：人人对弈不限制次数
        if self._is_human_ai(game):
            max_undo = self._cfg.play.max_undo
            if max_undo <= 0:
                raise AppError(ErrorCode.UNDO_LIMIT_REACHED, "悔棋功能已禁用")
            if int(game["undo_count"] or 0) + steps > max_undo:
                raise AppError(ErrorCode.UNDO_LIMIT_REACHED, "悔棋次数已达上限")
        new_last = max(0, game["last_move_no"] - steps)
        await repos.undo_moves_after(
            self._conn, game_id=game_id, move_no=new_last, steps=steps
        )
        # BUG-031：提子计数器按剩余棋谱回算（撤掉的吃子手不得残留展示计数）
        await self._recount_captures(game_id)
        # BUG-026：深算槽为会话缓存，链槽由 repos 截断，深算槽须同步收敛
        if self._analysis is not None:
            self._analysis.cache.truncate_main(game_id, new_last)
        self._bump_analysis_version(game_id)
        self._ai_pending.pop(game_id, None)  # 回合已离开 AI：挂起原因失效（R2）
        logger.info(
            "对局 #%d 悔棋（%s方，%d 步）：截断至第 %d 手",
            game_id, _COLOR_TEXT.get(color, color), steps, new_last,
        )
        updated = await self._require_game(game_id)
        return UndoResult(
            undone_move_no=game["last_move_no"],
            new_last_move_no=new_last,
            steps=steps,
            undo_count=int(updated["undo_count"] or 0),
        )

    async def resign(self, game_id: int, *, color: str) -> PlayResult:
        """认输（M-3 串行化入口；在途 AI 应手经中断竞速放弃，R1）。"""
        async with self._locked_after_ai_abort(game_id):
            return await self._resign(game_id, color=color)

    async def _resign(self, game_id: int, *, color: str) -> PlayResult:
        """认输：即时终局（跳过死子确认），FINISHED + result。

        FSM：PLAYING → SCORING → FINISHED（认输局跳过死子确认，TASK T3.3）。
        任一方均可在对局中认输（不限制回合）；败者 color 决定胜方。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.PLAYING, action="认输")
        if color not in ("B", "W"):
            raise AppError(ErrorCode.INVALID_PAYLOAD, "执子颜色仅支持 B/W")
        fsm.resign()
        winner = "W" if color == "B" else "B"
        result = f"{winner}+Resign"
        await repos.set_game_result(self._conn, game_id, result)
        fsm.confirm_scoring()
        self._ai_pending.pop(game_id, None)  # 终局：挂起原因失效（R2）
        return PlayResult(move_no=game["last_move_no"], color=color, game_over=True)

    async def restart(self, game_id: int) -> None:
        """重开（M-3 串行化入口；在途 AI 应手经中断竞速放弃，R1）。"""
        async with self._locked_after_ai_abort(game_id):
            await self._restart(game_id)

    async def _restart(self, game_id: int) -> None:
        """重开（同参数重置）：清空落子与分析，回到 CREATED（DATABASE §5 级联清理）。"""
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.PLAYING, action="重开")
        fsm.restart()
        await repos.truncate_moves_after(self._conn, game_id=game_id, move_no=0)
        await repos.reset_game_undo_count(self._conn, game_id)  # 重开视为新对局，全局悔棋计数归零
        # BUG-031：落子清空 → 提子计数器归零（按空棋谱回算）
        await self._recount_captures(game_id)
        # BUG-026：重开清空全部深算槽条目（深算结果仅会话有效，不得跨局面残留）
        if self._analysis is not None:
            self._analysis.cache.truncate_main(game_id, 0)
        await repos.update_game_status(self._conn, game_id, "created")
        self._bump_analysis_version(game_id)
        self._ai_pending.pop(game_id, None)  # 重开：挂起原因失效（R2）
        logger.info("对局 #%d 重开：清空落子与分析", game_id)

    # ---- T3.4 终局结算 ----

    async def prepare_settle(self, game_id: int) -> int:
        """未结算终局（导入棋谱）的结算准备校验（2026/09/19 人工决策方案 A）。

        - 仅 ``FINISHED`` 且 ``result`` 为空的对局可补结算；
        - **不改变对局状态**（原地补结算，不做 FINISHED→SCORING 迁移）；
        - 返回终局手数（结算预判以末手局面为准）。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.FINISHED, action="补结算")
        if game["result"] is not None:
            raise AppError(ErrorCode.GAME_FINISHED, "对局已结算")
        return int(game["last_move_no"] or 0)

    async def confirm_scoring(
        self,
        game_id: int,
        dead_points: Optional[list[tuple[int, int]]] = None,
        *,
        predicted: Optional[dict] = None,
    ) -> dict:
        """结算确认（M-3 串行化入口）。"""
        async with self._lock_for(game_id):
            return await self._confirm_scoring(
                game_id, dead_points=dead_points, predicted=predicted
            )

    async def _confirm_scoring(
        self,
        game_id: int,
        dead_points: Optional[list[tuple[int, int]]] = None,
        *,
        predicted: Optional[dict] = None,
    ) -> dict:
        """结算确认：死子校正 → Python 侧数子/目数结算 → FINISHED + result。

        - SCORING 状态（双 PASS/无子可下 触发）；认输局已即时终局跳过此处；
        - **未结算终局例外（2026/09/19 人工决策方案 A）**：``FINISHED`` 且 ``result``
          为空（导入棋谱）允许**原地补结算**——不迁移状态；
        - **未定型终局改用 AI 预判结果（2026/10/10 人工确认）**：导入棋谱末手非双 PASS
          ⇒ 终局局面**未定型**（双方未 PASS，死子/中立判定高度敏感），Python 精确数子
          结果不稳定（实测：同一 SGF 预判 `W+2`、数子 `和局`）。故此类对局以
          ``SettlementPredictor`` 的 ``scoring.prediction``（GTP ``final_score`` 等价、
          lead 取整）为**权威结果**；预判为 lead 估算、无法得出黑目/白目 → 两值置空
          （同认输局）。引擎不可用/预判未就绪（``predicted`` 缺失或降级 ``result=null``）
          → 回退 Python 精确数子（降级不阻断，引擎无关）；
        - ``dead_points`` 人工校正（可省略=跳过，直接按当前棋面结算）；
        - ``scorings`` UPSERT（game_id 整体替换，支持结算取消后再结算）；
        - 返回载荷附 ``ai_predicted``（可选字段，向后兼容）：``True`` ＝ 结果取自 AI
          预判（未定型终局）——前端据此把副行文案换为「终局局面未定型 · 结果为AI 预判」。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        settle_in_place = fsm.state is GameState.FINISHED and game["result"] is None
        if not settle_in_place:
            fsm.require(GameState.SCORING, action="结算确认")
        moves = await repos.list_moves(self._conn, game_id)
        dead = dead_points or []

        # 未定型终局（导入棋谱且非双 PASS）→ 采用 AI 预判结果（GTP final_score 等价）
        predicted_result: Optional[str] = None
        if settle_in_place and predicted is not None and not predicted.get("finished"):
            value = predicted.get("result")
            if value:
                predicted_result = str(value)

        black_score: Optional[float]
        white_score: Optional[float]
        if predicted_result is not None:
            result = predicted_result
            black_score = None
            white_score = None
        else:
            try:
                sr = compute_scoring(
                    board_size=game["board_size"],
                    rules=game["rules"],
                    komi=game["komi"],
                    handicap=game["handicap"],
                    moves=moves,
                    dead_points=dead,
                )
            except ValueError as exc:
                raise AppError(ErrorCode.INVALID_PAYLOAD, str(exc)) from None
            result = sr.result
            black_score = sr.black_score
            white_score = sr.white_score

        await repos.upsert_scoring(
            self._conn,
            game_id=game_id,
            dead_points_json=json.dumps(dead),
            black_score=black_score,
            white_score=white_score,
            result=result,
        )
        await repos.set_game_result(self._conn, game_id, result)
        if not settle_in_place:
            fsm.confirm_scoring()
        if predicted_result is not None:
            logger.info(
                "对局 #%d 结算（补）完成：%s（未定型终局，AI 预判结果）", game_id, result
            )
        else:
            logger.info(
                "对局 #%d 结算%s完成：%s（黑 %.1f / 白 %.1f）",
                game_id,
                "（补）" if settle_in_place else "",
                result, black_score, white_score,
            )
        return {
            "result": result,
            "black_score": black_score,
            "white_score": white_score,
            # 未定型终局（结果取自 AI 预判，无精确目数）——前端副行文案据此区分
            # 「终局局面未定型 · 结果为AI 预判」vs「终局结算完成」（2026/10/10 人工口径）
            "ai_predicted": predicted_result is not None,
        }

    async def cancel_scoring(self, game_id: int) -> None:
        """结算取消（M-3 串行化入口）。"""
        async with self._lock_for(game_id):
            await self._cancel_scoring(game_id)

    async def _cancel_scoring(self, game_id: int) -> None:
        """结算取消：SCORING → PLAYING（继续对弈，DATABASE §3.5 支持再次结算）。

        - BUG-025：同时写双 PASS 计数边界（当前 ``last_move_no``）——取消前的 PASS
          不再参与“连续双 PASS”判定，防取消后单方新 PASS 与旧 PASS 配对而立即
          重新进入结算（落实「需再次双 PASS 才可进入结算」）。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        fsm.require(GameState.SCORING, action="结算取消")
        fsm.cancel_scoring()
        await repos.update_game_status(self._conn, game_id, "active")
        await repos.set_game_pass_reset_move_no(
            self._conn, game_id, int(game["last_move_no"])
        )
        logger.info("对局 #%d 结算取消，回到对弈", game_id)

    # ---- T3.5 断点恢复 ----

    async def snapshot(self, game_id: int) -> dict:
        """对局快照（WS ``game.state`` 载荷，API §4.3；任意状态可用）。

        - 与 ``restore`` 同构但**不校验状态**（终局复盘/连接即推送也用）；
        - 含参数/玩家/序列/当前回合/分析可用性（前端全量对齐与状态映射）。
        """
        game = await self._require_game(game_id)
        moves = await repos.list_moves(self._conn, game_id)
        last = game["last_move_no"]
        covered = await repos.analysis_coverage(self._conn, game_id, last)
        next_color = self._next_color(game)
        turn = None
        if self._is_human_ai(game) and game["status"] == "active":
            if next_color == self._ai_color(game):
                turn = GameTurn.TURN_AI.value
            else:
                turn = GameTurn.TURN_HUMAN.value
        # AI 应手挂起原因（R2，可选字段）：仅人机且轮到 AI 时回投——前端据此把
        # 「思考中」换成可操作的失败提示（后台失败本身不发错误信封，避免噪声）
        ai_pending = None
        if turn == GameTurn.TURN_AI.value:
            pending = self._ai_pending.get(int(game["id"]))
            if pending is not None:
                ai_pending = {"code": pending[0], "message": pending[1]}
        return {
            "game_id": game["id"],
            "status": game["status"],
            "game": game,
            "moves": moves,
            "next_color": next_color,
            "turn": turn,
            "ai_pending": ai_pending,
            "analysis_complete": covered == last + 1,
            "coverage": {"done": covered, "total": last + 1},
        }

    async def restore(self, game_id: int) -> dict:
        """断点恢复：服务端为唯一事实源，全量校验对齐（冲突以服务端为准）。

        - 仅 ``active``（PLAYING）对局可恢复（`created`/`scoring`/`finished` 拒绝，
          API §3.1 active-latest 同语义）；
        - 返回对局快照 + 落子序列 + 分析可用性（前端全量对齐用，API §4.3 game.state）；
        - 人机对弈附当前回合（TURN_HUMAN/TURN_AI）。
        """
        game = await self._require_game(game_id)
        fsm = fsm_from_game(game)
        if fsm.state is GameState.FINISHED:
            raise AppError(ErrorCode.GAME_FINISHED, "对局已结束，不可恢复")
        if fsm.state is not GameState.PLAYING:
            raise AppError(ErrorCode.ILLEGAL_ACTION, "仅进行中对局可断点恢复")
        fsm.restore()  # 强制置入 PLAYING（已 PLAYING 无副作用）

        moves = await repos.list_moves(self._conn, game_id)
        last = game["last_move_no"]
        covered = await repos.analysis_coverage(self._conn, game_id, last)
        next_color = self._next_color(game)
        turn = None
        if self._is_human_ai(game) and next_color == self._ai_color(game):
            turn = GameTurn.TURN_AI.value
        elif self._is_human_ai(game):
            turn = GameTurn.TURN_HUMAN.value

        return {
            "game_id": game["id"],
            "status": "active",
            "game": game,
            "moves": moves,
            "next_color": next_color,
            "turn": turn,
            "analysis_complete": covered == last + 1,
            "coverage": {"done": covered, "total": last + 1},
        }
