"""复盘服务（TASK T3.9/T3.10，PRD §4.2，ARCHITECTURE §3.5/§4.2）。

职责：
- **回放**：数据组装（优先读持久化 ``position_analyses`` 派生推荐/曲线/点评，
  **引擎无关**——引擎 DEAD 复盘照常，ARCHITECTURE §5.2 降级矩阵）；
- **试下临时分支**：主动落子进入、不限次撤销、``回实战`` 返回原局面、
  不污染主谱（试下落子仅会话内存），分析结果仅会话缓存
  （``trial:{trial_id}:{relative_move_no}``，DATABASE §3.4）；
- **复弈**：生成新对局（``parent_game_id`` 前导），截至复弈手数的分析结果经
  ``bulk_upsert_position_analyses`` **单事务批量落盘**——试下相对手数一对一映射为
  新对局 ``main:{enter_move_no + relative}``、前导分析复制进新对局自包含；
- **收藏**：收藏/取消收藏。
- **深度分析 / 全局分析**（T3.10）：一次性深算、逐手补分析（见 review_analysis）。

> 试下分支的对局流转不进入主对局 FSM（ARCHITECTURE §3.5 试下/复弈属复盘侧临时状态）。
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Optional

from app.api.public import winrate_to_percent
from app.config import AppConfig
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.engine.coords import data_board_size, gtp_to_xy, is_pass_loc
from app.services.chain_precision import KIND_DEEP, chain_visits
from app.services.scoring import replay_position
from app.services.go_rules import (
    GoBoard,
    GoRulesError,
    build_board,
    handicap_initial_stones,
)
from app.services.report_service import (
    GRADE_KEYS,
    classify_move,
    move_delta_winrate,
    move_hit_rank,
    move_score_delta,
)

logger = logging.getLogger(__name__)

#: AI 推荐候选点数（TOP5）
RECOMMEND_TOP_N = 5

#: 试下分支注册表容量上限（M-2：试下无销毁入口，防 ``_trials`` 无界增长）
MAX_TRIALS = 200

#: 深度分析等待超时（运行时安全网；深算 maxVisits 大、耗时可达分钟级）
DEEP_ANALYSIS_TIMEOUT_S = 300.0


@dataclass
class TrialState:
    """试下临时分支（仅会话内存，不落库）。"""

    game_id: int
    trial_id: int
    enter_move_no: int          # 主谱进入手数（试下从该局面开始）
    moves: list[dict] = field(default_factory=list)  # 试下落子（相对手数 1..N）
    #: M-7（2026/09/19 决策 A）：分支级互斥锁。同分支的落子/PASS/撤销/快照串行，
    #: 防止并发操作读到同一 ``relative_last``/应落方（出现两子同色、同相对手数）；
    #: 仅保护本分支内存态，与对局锁无关，不阻塞其他操作。
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def relative_last(self) -> int:
        """试下分支当前相对手数（0=试下进入局面）。"""
        return len(self.moves)


def _side_winrate(black_winrate: Optional[float], side: str) -> Optional[float]:
    """黑方视角 0..1 胜率 → 指定执色方视角百分比（round 2）；非数值原样返回。

    视角约定（2026/09/11 人工确认）：AI 支招 / AI 推荐卡片跟随**当前执色方**；
    对局信息卡 / 胜率目差曲线（黑）仍固定黑方视角（走 curve 载荷，不在此换算）。
    """
    percent = winrate_to_percent(black_winrate)
    if percent is None:
        return None
    return percent if side == "B" else round(100.0 - percent, 2)


def _side_score(black_score: Optional[float], side: str) -> Optional[float]:
    """黑方视角目差 → 指定执色方视角目差（白方取负）。"""
    if black_score is None:
        return None
    value = float(black_score)
    return value if side == "B" else -value


def _next_color_after(game: dict, move_no: int) -> str:
    """第 ``move_no`` 手落定后的应落子方（与 ``GameService._next_color_after`` 同规则：
    让子局白先，其余黑先）。缺分析数据时用它推导载荷 ``side``。
    """
    total = int(move_no) + 1
    if int(game["handicap"] or 0) > 0:
        return "W" if total % 2 == 1 else "B"
    return "B" if total % 2 == 1 else "W"


class ReviewService:
    """复盘服务。"""

    def __init__(
        self,
        conn,
        config: AppConfig,
        *,
        game_service=None,
        analysis=None,
    ) -> None:
        self._conn = conn
        self._cfg = config
        self._game = game_service
        self._analysis = analysis  # AnalysisService（调度/会话缓存）
        self._trials: dict[int, TrialState] = {}
        self._next_trial_id = 1
        #: 深度分析进行中互斥（DEEP_ANALYSIS_RUNNING）
        self._deep_running = False
        #: 全局分析进行中/可中断（按 game_id 作用域）
        self._global_running = False
        self._global_game_id: Optional[int] = None
        self._global_cancelled = False
        #: 进行中全局分析进度（W-08：重连 restore.request 重发 analysis.progress）
        self._global_done = 0
        self._global_total = 0

    def update_config(self, cfg: AppConfig) -> None:
        """运行期配置热更新（H-1）：刷新复盘/深算/全局分析使用的配置引用。"""
        self._cfg = cfg

    # ---- 共享辅助 ----

    async def _require_game(self, game_id: int) -> dict:
        game = await repos.get_game(self._conn, game_id)
        if game is None:
            raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
        return game

    def _new_trial_id(self) -> int:
        tid = self._next_trial_id
        self._next_trial_id += 1
        return tid

    # ---- 回放数据（引擎无关） ----

    async def _main_analyses(self, game_id: int) -> dict[int, dict]:
        """M-5：单次批量读取对局全部主谱分析（position_key → data），避免 N+1 查询。"""
        analyses: dict[int, dict] = {}
        for row in await repos.list_analyses_for_game(self._conn, game_id):
            key = row["position_key"]
            if not key.startswith("main:"):
                continue
            try:
                analyses[int(key.split(":", 1)[1])] = json.loads(row["data_json"])
            except (ValueError, IndexError):
                continue
        return analyses

    async def replay(self, game_id: int) -> dict:
        """回放数据：对局 + 落子序列 + 每手分析（读持久化数据，引擎无关）。"""
        game = await self._require_game(game_id)
        moves = await repos.list_moves(self._conn, game_id)
        return {"game": game, "moves": moves, "analyses": await self._main_analyses(game_id)}

    async def curve(self, game_id: int) -> list[dict]:
        """胜率/目差曲线（读持久化，黑方视角，引擎无关；API §3.1 /curve）。

        - 存储为 KataGo 0..1 黑方视角；输出侧 ``winrate × 100``（round 2，ISSUE-050）；
        - ``score_lead`` 目差单位不变（黑方视角目数，正=黑领先）。
        """
        game = await self._require_game(game_id)
        analyses = await self._main_analyses(game_id)
        return self._curve_points(game, analyses)

    async def replay_bundle(self, game_id: int) -> dict:
        """复盘批量数据（2026/09/21 性能优化，API §3.1 ``/replay``）。

        **目的**：回放页逐手步进不再每次往返取数——一次读取全部分析与落子后
        **纯内存派生**曲线 + 每手推荐/点评，前端按 ``position_key`` 直接命中快照。

        - 与 ``GET /api/games/{id}``（详情 + 落子序列）**互补**，不重复下发对局与落子；
        - 展示口径与 ``recommend()`` **完全一致**（深算槽 → 链槽；``comment`` 恒读链槽
          同精度差量）——由同一 ``_payload_parts`` / ``_chain_comment`` 派生，无第二套口径；
        - ``variations`` 不下发与 ``moves[i]`` 重复的 ``move`` 对象（V2 形态，人工决策
          2026/09/21）：前端本就按同序号取用 ``moves[i]`` / ``variations[i]``；
        - 缺分析的局面下发 ``has_data: false`` 空条目（前端据此渲染空态，无需再发请求）；
        - 试下分支**不在此列**（引擎现算，仍走 WS ``recommend.request``）。
        """
        game = await self._require_game(game_id)
        moves = await repos.list_moves(self._conn, game_id)
        analyses = await self._main_analyses(game_id)
        moves_by_no = {int(m["move_no"]): m for m in moves}
        last = int(game["last_move_no"])
        recommends: list[dict] = []
        for move_no in range(0, last + 1):
            key = f"main:{move_no}"
            data = self._main_display_data(game, move_no, analyses)
            if data is None:
                recommends.append(
                    self._empty_payload(key, move_no, _next_color_after(game, move_no))
                )
                continue
            payload = self._payload_parts(data, move_no, variation_move=False)
            payload["position_key"] = key
            payload["has_data"] = True
            payload["comment"] = self._chain_comment(moves_by_no, analyses, move_no)
            recommends.append(payload)
        return {
            "game_id": game_id,
            "last_move_no": last,
            "curve": self._curve_points(game, analyses),
            "recommends": recommends,
        }

    async def replay_ownership(self, game_id: int) -> dict:
        """整局领地矩阵（懒加载，API §3.1 ``/replay/ownership``）。

        人工决策（2026/09/21）：领地**按需懒加载**——用户首次开启 [领地] 时一次性拉取；
        命中则连续模式（双击）后续步进零请求。

        - 仅下发**确有领地数据**的局面；无分析/无 ownership 的局面**不下发**——前端据此
          回落既有 ``ownership.request`` 路径（服务端缺数据时会触发 P1 补分析，不得用
          “批量快照里的空值”把它降级为终态无数据）；
        - 展示优先级同 ``recommend()``（深算槽 → 链槽）；深算结果到达后的失效由前端按键处理。
        """
        game = await self._require_game(game_id)
        analyses = await self._main_analyses(game_id)
        last = int(game["last_move_no"])
        positions: list[dict] = []
        for move_no in range(0, last + 1):
            data = self._main_display_data(game, move_no, analyses)
            values = data.get("ownership") if data else None
            if values is None:
                continue
            positions.append({"move_no": move_no, "ownership": values})
        return {"game_id": game_id, "last_move_no": last, "positions": positions}

    def _curve_points(self, game: dict, analyses: dict[int, dict]) -> list[dict]:
        """曲线点（链行 root → 黑方视角）：``curve()`` 与批量端点共用。"""
        curve: list[dict] = []
        for move_no in range(0, int(game["last_move_no"]) + 1):
            data = analyses.get(move_no)
            if data is None:
                continue
            root = data.get("rootInfo") or {}
            curve.append(
                {
                    "move_no": move_no,
                    "winrate": winrate_to_percent(root.get("winrate")),
                    "score_lead": root.get("scoreLead"),
                }
            )
        return curve

    def _main_display_data(
        self, game: dict, move_no: int, analyses: dict[int, dict]
    ) -> Optional[dict]:
        """批量路径的展示数据读取：与 ``_display_data`` 同优先级（深算槽 → 链槽），
        但链槽取自**已批量读入**的 ``analyses``（不查库）。"""
        key = f"main:{move_no}"
        if self._analysis is not None:
            deep = self._analysis.cache.get_deep(game["id"], key)
            if deep is not None:
                return deep
        return analyses.get(move_no)

    def _chain_comment(
        self, moves_by_no: dict[int, dict], analyses: dict[int, dict], move_no: int
    ) -> Optional[dict]:
        """链槽点评（落子前后两局面 root 之差 → 五档）：单局面与批量路径**共用口径**。

        - 前手 = ``main:{move_no-1}``、当前 = ``main:{move_no}``（均为**链槽**，深算槽不参与）；
        - 首手（``move_no=0``）/PASS/任一侧缺分析 → ``None``（该手无点评）。
        """
        if move_no <= 0:
            return None
        played = moves_by_no.get(move_no)
        if played is None or played.get("is_pass"):
            return None
        prev_data = analyses.get(move_no - 1)
        cur_data = analyses.get(move_no)
        if prev_data is None or cur_data is None:
            return None
        return self._grade_comment(played, prev_data, cur_data)

    async def recommend(
        self,
        game_id: int,
        move_no: Optional[int] = None,
        *,
        position_key: Optional[str] = None,
    ) -> dict:
        """复盘 AI 推荐 TOP5 / 变化图 / 当前手点评（T6.8，引擎无关）。

        主谱 ``move_no``（展示数据优先**深算槽**、无则链槽 ``main:{N}``）或试下
        ``position_key``（``trial:{id}:{relative}``，展示优先深算槽、无则标准会话槽）。
        返回：

        - ``side``: 该局面当前执色方（B/W，由 ``rootInfo.currentPlayer`` 推导）；
        - ``moves``: TOP5 候选（x/y/winrate/score_lead/visits/pv；``winrate``
          **当前执色方视角** 0..100 百分比、``score_lead`` 同视角目差，2026/09/11）；
        - ``variations``: 各候选变化图（颜色自当前轮走方交替）；
        - ``root``: 本局面 root（同视角 ``winrate`` 百分比 / ``score_lead``）；
        - ``comment``: **当前手**点评（本局面最后一手，LEVEL.md 带表）：
          ``{color,x,y,grade,delta_winrate(%),score_delta}``——该手评估 = 落子前后两个局面
          **链槽**分析 root 之差（**同精度链唯一口径**，BUG-026；深算展示值不参与）；
        - 缺分析数据 → ``has_data: False``（供 WS 层触发链精度分析后回投，不抛错）。
        """
        game = await self._require_game(game_id)
        if position_key is not None:
            return await self._trial_recommend(game, position_key)
        target = game["last_move_no"] if move_no is None else move_no
        if not (0 <= target <= game["last_move_no"]):
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"推荐手数越界: {target}")
        key = f"main:{target}"
        data = await self._display_data(game, key)
        if data is None:
            return self._empty_payload(key, target, _next_color_after(game, target))
        payload = self._payload_parts(data, target)
        payload["position_key"] = key
        payload["has_data"] = True
        payload["comment"] = await self._main_comment(game, target)
        return payload

    async def _display_data(self, game: dict, position_key: str) -> Optional[dict]:
        """展示数据读取（BUG-026）：优先**深算槽**（会话内一次性深算，不落盘）→
        回退**链槽**（主谱持久化 / 试下标准会话槽）。

        - 深算槽仅影响展示（推荐候选/变化图/领地）；点评/报告等差量指标恒读链槽
          （深算槽与链槽可能不同精度，深算值不得参与“两局面差”）；
        - 主谱链槽无数据 → ``None``（调用方按缺数据语义处理）。
        """
        if self._analysis is not None:
            deep = self._analysis.cache.get_deep(game["id"], position_key)
            if deep is not None:
                return deep
        if position_key.startswith("main:"):
            row = await repos.get_main_analysis(
                self._conn, game["id"], int(position_key.split(":", 1)[1])
            )
            if row is None:
                return None
            return json.loads(row["data_json"])
        if self._analysis is not None:
            return self._analysis.cache.get_session(position_key)
        return None

    async def _main_comment(self, game: dict, move_no: int) -> Optional[dict]:
        """当前手（主谱 ``move_no``）点评：本手落子前后两个局面**链槽**分析之差。

        - 落子后取 ``main:{move_no}``、落子前取 ``main:{move_no-1}``（均从链槽读取，
          **不使用深算槽展示数据**——差量指标必须同精度链内计算，BUG-026）；
        - ``move_no=0``/无前手分析 → None（不依赖候选，无 ``max_moves`` 限制）。
        """
        moves_by_no, analyses = await self._chain_inputs(game["id"], move_no)
        return self._chain_comment(moves_by_no, analyses, move_no)

    async def comment_for_move(self, game_id: int, move_no: int) -> Optional[dict]:
        """主谱第 ``move_no`` 手点评（引擎相关、实时）：读库派生，供 WS 推送复用。

        - 对弈中每手标准分析落库后由 ``GameCommentPusher`` 调起（实时推送）；
        - 连接/恢复（restore.request）时回投当前手点评；
        - 缺任一侧分析（``main:{N-1}``/``main:{N}``）或该手为 PASS → None；
        - 对局已被删除时读不到落子/分析 → None（不抛 GAME_NOT_FOUND：调用方为后台推送，
          与删除竞态不应报错）。
        """
        moves_by_no, analyses = await self._chain_inputs(game_id, move_no)
        comment = self._chain_comment(moves_by_no, analyses, move_no)
        if comment is None:
            return None
        played = moves_by_no[move_no]
        return {
            "move_no": move_no,
            "color": played.get("color"),
            **comment,
        }

    async def _chain_inputs(
        self, game_id: int, move_no: int
    ) -> tuple[dict[int, dict], dict[int, dict]]:
        """单局面点评所需的两侧链槽输入（落子行 + ``main:{move_no-1}``/``main:{move_no}``）。

        仅 ``move_no >= 1`` 时读库；越界/PASS 由 ``_chain_comment`` 统一判定。
        """
        if move_no <= 0:
            return {}, {}
        all_moves = await repos.list_moves(self._conn, game_id)
        moves_by_no = {int(m["move_no"]): m for m in all_moves}
        analyses: dict[int, dict] = {}
        prev_row = await repos.get_main_analysis(self._conn, game_id, move_no - 1)
        cur_row = await repos.get_main_analysis(self._conn, game_id, move_no)
        if prev_row is not None:
            analyses[move_no - 1] = json.loads(prev_row["data_json"])
        if cur_row is not None:
            analyses[move_no] = json.loads(cur_row["data_json"])
        return moves_by_no, analyses

    async def recent_comments(
        self, game_id: int, *, count: int = 2, max_scan: int = 6
    ) -> list[dict]:
        """最近 ``count`` 手点评（连接/恢复回投用；按手数**旧→新**排序）。

        - 对弈页保留最近 2 手点评圆点（2026/09/11 人工确认），刷新/重连后回投补齐；
        - 自末手向前扫描至多 ``max_scan`` 手（PASS/缺分析的手跳过），保持有界开销。
        """
        game = await self._require_game(game_id)
        last = int(game["last_move_no"])
        out: list[dict] = []
        for move_no in range(last, max(0, last - max_scan), -1):
            comment = await self.comment_for_move(game_id, move_no)
            if comment is None:
                continue
            out.append(comment)
            if len(out) >= count:
                break
        out.reverse()
        return out

    async def _trial_recommend(self, game: dict, position_key: str) -> dict:
        """试下分支推荐/点评（读会话缓存，DATABASE §3.4 试下语义；T6.8）。"""
        parts = position_key.split(":")
        if len(parts) != 3 or not parts[1].isdigit() or not parts[2].isdigit():
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"非法试下 position_key: {position_key}")
        trial_id, relative = int(parts[1]), int(parts[2])
        trial = self._require_trial(game["id"], trial_id)
        if not (0 <= relative <= trial.relative_last):
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"试下相对手数越界: {relative}")
        key = self._trial_position_key(trial_id, relative)
        data = await self._display_data(game, key)
        if data is None:
            return self._empty_payload(
                key, relative, self._trial_next_color(game, trial, relative)
            )
        payload = self._payload_parts(data, relative)
        payload["position_key"] = key
        payload["has_data"] = True
        payload["comment"] = await self._trial_comment(game, trial, relative)
        return payload

    async def _trial_comment(
        self, game: dict, trial: TrialState, relative: int
    ) -> Optional[dict]:
        """当前手（试下相对 ``relative``）点评：前一手与当前局面**链槽**分析之差。

        - 当前局面 = ``trial:{id}:{relative}``（标准会话槽）；
        - 前一手 = ``trial:{id}:{relative-1}``；relative=1 时为主谱进入局面
          （``main:{enter_move_no}``，持久化）；
        - 点评为差量指标 → 恒读链槽（深算槽不参与，BUG-026）。
        """
        if relative <= 0 or self._analysis is None:
            return None
        played = trial.moves[relative - 1] if len(trial.moves) >= relative else None
        if played is None or played.get("is_pass"):
            return None
        cur_data = self._analysis.cache.get_session(
            self._trial_position_key(trial.trial_id, relative)
        )
        if cur_data is None:
            return None
        if relative == 1:
            prev_row = await repos.get_main_analysis(
                self._conn, game["id"], trial.enter_move_no
            )
            if prev_row is None:
                return None
            prev_data = json.loads(prev_row["data_json"])
        else:
            prev_data = self._analysis.cache.get_session(
                self._trial_position_key(trial.trial_id, relative - 1)
            )
            if prev_data is None:
                return None
        return self._grade_comment(played, prev_data, cur_data)

    def _grade_comment(
        self, played: dict, prev_data: dict, cur_data: dict
    ) -> Optional[dict]:
        """实际落子点评（落子方视角 ΔW/ΔS → LEVEL 带表五档）。

        - 口径（2026/09/11 人工确认）：AI 评价 = **本手落子前后两个局面**
          （``main:{N-1}`` 与 ``main:{N}``，试下为会话缓存对应键）标准分析 root 之差，
          不受候选截断（``play.max_moves``）影响；
        - **ΔS 为目数变化**（恶手为负、好手为正，与 ΔW 同向；旧名“目数损失”已废止）；
        - **命中 AI 选点优先**：命中落子前局面标准分析第一选点 → 妙着；命中前
          ``report.top_n`` 名（默认 Top3）→ 至少正着（``move_hit_rank``）；
        - ``delta_winrate`` 输出百分比（×100、round 2，API/WS 输出口径）；
          ``score_delta`` 目数（round 3）；两项均缺 → None；
        - 五档 key 与前端 GRADE_TEXT 对齐（``GRADE_KEYS`` 索引映射带表序）。
        """
        delta_w = move_delta_winrate(prev_data, cur_data, played.get("color"))
        score_delta = move_score_delta(prev_data, cur_data, played.get("color"))
        if delta_w is None and score_delta is None:
            return None
        bands = self._cfg.report.quality_bands
        if not bands:
            return None
        rank = move_hit_rank(prev_data, played)
        top_n = self._cfg.report.top_n
        label = classify_move(
            delta_w or 0.0,
            score_delta or 0.0,
            bands,
            hit_first=rank == 0,
            hit_top=rank is not None and rank < top_n,
        )
        idx = next((i for i, b in enumerate(bands) if b.label == label), None)
        grade = GRADE_KEYS[idx] if idx is not None and idx < len(GRADE_KEYS) else None
        return {
            "color": played.get("color"),
            "x": played.get("x"),
            "y": played.get("y"),
            "grade": grade,
            "delta_winrate": (
                round(delta_w * 100, 2) if delta_w is not None else None
            ),
            "score_delta": score_delta,
        }

    def _empty_payload(self, position_key: str, move_no: int, side: str) -> dict:
        """推荐缺数据载荷（moves/variations/root/comment 空，has_data=False）。"""
        return {
            "position_key": position_key,
            "move_no": move_no,
            "side": side,
            "has_data": False,
            "moves": [],
            "variations": [],
            "root": None,
            "comment": None,
        }

    def _payload_parts(
        self, data: dict, move_no: int, *, variation_move: bool = True
    ) -> dict:
        """分析结果 → 推荐载荷公共部分（TOP5/变化图/root）。

        视角（2026/09/11 人工确认）：``moves[].winrate/score_lead`` 与 ``root``
        都是**该局面当前执色方（side to move）视角**（附 ``side`` 字段，前端不再换算）。

        ``variation_move=False``（批量端点，2026/09/21 人工决策）：``variations[]`` 不再
        复制 ``moves[i]`` 对象（同一候选元数据重复下发，19 路整局实测多 ~155 KiB），
        仅保留 ``pv``——前端按同序号 ``moves[i]`` / ``variations[i]`` 取用。
        """
        current = (data.get("rootInfo") or {}).get("currentPlayer")
        side = current if current in ("B", "W") else "B"
        moves = self._top_moves(data, side)
        variations = [
            {
                "move": m,
                "pv": _pv_with_colors(
                    m.get("pv", []), side, board_size=data_board_size(data)
                ),
            }
            if variation_move
            else {
                "pv": _pv_with_colors(
                    m.get("pv", []), side, board_size=data_board_size(data)
                )
            }
            for m in moves
        ]
        root = data.get("rootInfo") or {}
        root_w = root.get("winrate")
        return {
            "move_no": move_no,
            "side": side,
            "moves": moves,
            "variations": variations,
            "root": (
                {
                    "winrate": _side_winrate(root_w, side),
                    "score_lead": _side_score(root.get("scoreLead"), side),
                }
                if root_w is not None
                else None
            ),
        }

    def _top_moves(self, data: dict, side: str = "B") -> list[dict]:
        """从分析结果派生 TOP5 候选（x/y/winrate/score_lead/visits/pv，坐标换算）。

        输出边界（2026/09/11）：``winrate``/``score_lead`` 均为**该局面当前执色方
        视角**（黑方视角存储 → 白方取换算/取负）；``side`` 由 ``rootInfo.currentPlayer``
        推导。存储保持 0..1 黑方视角不变（ISSUE-050）。
        """
        infos = data.get("moveInfos") or []
        moves: list[dict] = []
        for info in infos[:RECOMMEND_TOP_N]:
            mv = info.get("move")
            if is_pass_loc(mv or ""):
                continue
            try:
                x, y = gtp_to_xy(mv, board_size=data_board_size(data))
            except (ValueError, IndexError, TypeError):
                continue
            moves.append(
                {
                    "x": x,
                    "y": y,
                    "winrate": _side_winrate(info.get("winrate"), side),
                    "score_lead": _side_score(info.get("scoreLead"), side),
                    "visits": info.get("visits"),
                    "pv": info.get("pv") or [],
                }
            )
        return moves

    async def ownership(self, game_id: int, move_no: Optional[int] = None) -> dict:
        """领地矩阵（引擎无关；API §3.1 /ownership、§4.3 position.ownership）。

        - 缺省 ``move_no``=当前局面；主谱 ``main:{move_no}``；
        - 展示优先**深算槽**（会话内深算结果，不落盘）→ 回退链槽持久化（BUG-026）；
        - 无分析数据 → ``ANALYSIS_INCOMPLETE``（前端隐藏/提示）；
        - 有分析但无 ownership 字段（旧数据）→ ``ownership: null``（字段可缺省语义）。
        """
        game = await self._require_game(game_id)
        target = game["last_move_no"] if move_no is None else move_no
        if not (0 <= target <= game["last_move_no"]):
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"领地手数越界: {target}")
        data = await self._display_data(game, f"main:{target}")
        if data is None:
            raise AppError(ErrorCode.ANALYSIS_INCOMPLETE, "该局面无分析数据")
        return {
            "position_key": f"main:{target}",
            "move_no": target,
            "ownership": data.get("ownership"),
        }

    async def trial_ownership(
        self, game_id: int, trial_id: int, relative_move_no: int
    ) -> dict:
        """试下分支领地（会话缓存，DATABASE §3.4 试下语义；API §4.3 position.ownership）。

        - 键 ``trial:{trial_id}:{relative}``；展示优先深算槽 → 回退标准会话槽（BUG-026）；
        - 无缓存 → ``ownership: null``（可缺省）；相对手数越界 → ``ILLEGAL_ACTION``。
        """
        game = await self._require_game(game_id)
        trial = self._require_trial(game_id, trial_id)
        if not (0 <= relative_move_no <= trial.relative_last):
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"试下相对手数越界: {relative_move_no}")
        key = self._trial_position_key(trial_id, relative_move_no)
        data = await self._display_data(game, key)
        return {
            "position_key": key,
            "move_no": relative_move_no,
            "ownership": data.get("ownership") if data else None,
        }

    async def set_favorite(self, game_id: int, favorite: bool) -> None:
        """收藏/取消收藏。"""
        await self._require_game(game_id)
        await repos.set_game_favorite(self._conn, game_id, favorite)

    # ---- 试下临时分支 ----

    async def trial_enter(self, game_id: int, move_no: int) -> int:
        """试下：从主谱 ``move_no`` 局面进入临时分支，返回 trial_id。

        - 分支内相对手数：0=试下进入局面；
        - 试下不写主谱（仅会话内存），分析结果仅会话缓存。
        """
        game = await self._require_game(game_id)
        if not (0 <= move_no <= game["last_move_no"]):
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"试下进入手数越界: {move_no}")
        trial_id = self._new_trial_id()
        self._trials[trial_id] = TrialState(
            game_id=game_id, trial_id=trial_id, enter_move_no=move_no
        )
        self._evict_stale_trials()
        logger.info("对局 #%d 试下 #%d 进入（主谱第 %d 手）", game_id, trial_id, move_no)
        return trial_id

    def _evict_stale_trials(self) -> None:
        """M-2：注册表超限时淘汰最旧试下分支，并清理其会话分析缓存。"""
        while len(self._trials) > MAX_TRIALS:
            oldest_id = min(self._trials)
            self._trials.pop(oldest_id)
            if self._analysis is not None:
                self._analysis.cache.clear_trial(oldest_id)

    def remove_game(self, game_id: int) -> None:
        """对局删除：回收该对局的全部试下分支与其会话槽（L-12）。

        旧实现删除对局只清主谱侧（`AnalysisService.remove_game`）——试下会话槽
        键为 `trial:{trial_id}:{rel}` 不含 game_id，无法在缓存侧泛清；本入口经
        `_trials` 映射逐一 `clear_trial`（表容量有界，删除为低频操作）。
        """
        for trial_id in [
            tid for tid, trial in self._trials.items() if trial.game_id == game_id
        ]:
            self._trials.pop(trial_id, None)
            if self._analysis is not None:
                self._analysis.cache.clear_trial(trial_id)

    def _require_trial(self, game_id: int, trial_id: int) -> TrialState:
        trial = self._trials.get(trial_id)
        if trial is None or trial.game_id != game_id:
            raise AppError(ErrorCode.ILLEGAL_ACTION, "试下分支不存在")
        return trial

    def _trial_next_color(
        self, game: dict, trial: TrialState, relative: Optional[int] = None
    ) -> str:
        """试下第 ``relative`` 手后应落子方（缺省=分支末手；相对手数 + 主谱进入手数 决定奇偶）。"""
        rel = trial.relative_last if relative is None else relative
        total = trial.enter_move_no + rel
        if game["handicap"] > 0:
            return "W" if (total + 1) % 2 == 1 else "B"
        return "B" if (total + 1) % 2 == 1 else "W"

    def _trial_position_key(self, trial_id: int, relative: int) -> str:
        """试下分支 position_key（相对手数，仅会话缓存）。"""
        return f"trial:{trial_id}:{relative}"

    async def _trial_board(self, game: dict, trial: TrialState) -> GoBoard:
        """试下棋盘 = 主谱前缀（至进入手数）+ 试下落子。

        主谱前缀无法回放（历史数据与当前规则不符，ISSUE-064）时抛
        ``REPLAY_CONFLICT``：冲突发生在试下之前的存量数据上，与试下棋子无关。
        """
        moves = await repos.list_moves(self._conn, game["id"])
        prefix = [m for m in moves if m["move_no"] <= trial.enter_move_no]
        try:
            return build_board(
                board_size=game["board_size"],
                handicap=game["handicap"],
                moves=prefix + trial.moves,
            )
        except GoRulesError as exc:
            raise AppError(
                ErrorCode.REPLAY_CONFLICT,
                f"对局记录无法回放：历史数据与当前规则不符（{exc}）",
            ) from None

    async def trial_play(
        self,
        game_id: int,
        trial_id: int,
        *,
        x: int,
        y: int,
        color: Optional[str] = None,
    ) -> dict:
        """试下落子：规则校验 + 追加（相对手数），触发试下实时分析（P1，会话缓存）。

        ``color`` 缺省由服务端按分支轮次推导（前端不传，T6.8 协议）。
        """
        game = await self._require_game(game_id)
        trial = self._require_trial(game_id, trial_id)
        # M-7：锁内完成「轮次推导 → 棋盘校验 → 追加」全链（含 await 点），
        # 否则两个并发落子可同时读到旧 relative_last/应落方（各追一手同色）。
        async with trial.lock:
            next_color = self._trial_next_color(game, trial)
            if color is None:
                color = next_color
            elif color != next_color:
                raise AppError(ErrorCode.ILLEGAL_ACTION, f"当前应为 {next_color} 方落子")
            board = await self._trial_board(game, trial)
            try:
                captured = board.play(x, y, color)
            except GoRulesError as exc:
                raise AppError(ErrorCode.ILLEGAL_MOVE, str(exc)) from None
            relative = trial.relative_last + 1
            trial.moves.append(
                {"move_no": relative, "color": color, "x": x, "y": y, "is_pass": False}
            )
            result = {
                "trial_id": trial_id,
                "relative_move_no": relative,
                "color": color,
                "x": x,
                "y": y,
                "captures": captured,
            }
            self._bump_trial_version(game_id)
            await self._schedule_trial_analysis(game, trial)
            return result

    async def trial_pass(
        self, game_id: int, trial_id: int, *, color: Optional[str] = None
    ) -> dict:
        """试下 PASS（单方；不触发终局，复盘侧临时状态）。

        ``color`` 缺省由服务端按分支轮次推导（前端不传，T6.8 协议）。
        """
        game = await self._require_game(game_id)
        trial = self._require_trial(game_id, trial_id)
        # M-7：PASS 同落子——轮次推导与追加必须原子
        async with trial.lock:
            next_color = self._trial_next_color(game, trial)
            if color is None:
                color = next_color
            elif color != next_color:
                raise AppError(ErrorCode.ILLEGAL_ACTION, f"当前应为 {next_color} 方落子")
            relative = trial.relative_last + 1
            trial.moves.append(
                {"move_no": relative, "color": color, "x": None, "y": None, "is_pass": True}
            )
            return {
                "trial_id": trial_id,
                "relative_move_no": relative,
                "color": color,
                "is_pass": True,
            }

    async def trial_snapshot(self, game_id: int, trial_id: int) -> dict:
        """试下分支状态快照（WS ``trial.state`` 载荷，T6.8）。"""
        await self._require_game(game_id)
        trial = self._require_trial(game_id, trial_id)
        async with trial.lock:  # M-7：与并发落子/撤销互斥，快照不出现半更新
            return {
                "trial_id": trial_id,
                "enter_move_no": trial.enter_move_no,
                "relative_last": trial.relative_last,
                "moves": self._trial_moves(trial),
            }

    async def submit_trial_standard(
        self, game_id: int, position_key: str, on_result, on_drop=None
    ) -> None:
        """试下推荐缺数据：提交链精度分析（仅会话标准槽），结果经 on_result 回投。

        - 复用 ``_schedule_trial_analysis`` 的查询构造（链精度 maxVisits）；
        - 过期/中断语义由分析调度器按局面版本号处理；
        - ``on_drop(reason)``（2026/09/12 终态契约）：任务被丢弃（过期/引擎故障）
          时回投终态，避免调用方无界等待——旧实现静默丢弃导致前端悬挂。
        """
        game = await self._require_game(game_id)
        if self._analysis is None or self._analysis._engine is None:
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用：试下实时分析降级")
        # M-7：此处只读分支（前缀切片）；并发变更由分支级锁 + 试下域版本号兜底——
        # 读取后若分支再变更，提交的查询会被 bump_version(scope="trial") 过期丢弃。
        # 不在读取期间持锁等待引擎（submit 仅为入队操作）。
        moves = await self._trial_moves_for_deep(game, position_key)
        from app.engine.analysis_query import build_standard_query

        query = build_standard_query(
            board_size=game["board_size"],
            rules=game["rules"],
            komi=game["komi"],
            moves=moves,
            # 让子局：分析查询同样携带初始石（H-5 修复，同 _schedule_trial_analysis /
            # BUG-013：否则试下 TOP5/领地按“无让子”局面分析，复弈还会落盘错误链数据）
            initial_stones=handicap_initial_stones(
                game["board_size"], game["handicap"] or 0
            ),
            max_visits=chain_visits(self._cfg, game),
        )
        await self._analysis.submit(
            game_id, position_key, query, on_result=on_result, on_drop=on_drop
        )

    async def trial_undo(self, game_id: int, trial_id: int) -> dict:
        """试下撤销（不限次）：移除最后一手并截断会话缓存（相对手数）。"""
        await self._require_game(game_id)
        trial = self._require_trial(game_id, trial_id)
        async with trial.lock:  # M-7：撤销与并发落子互斥（不得撤到刚追加之子）
            if not trial.moves:
                raise AppError(ErrorCode.ILLEGAL_ACTION, "试下分支无子可悔")
            undone = trial.moves.pop()
            if self._analysis is not None:
                self._analysis.cache.truncate_trial(trial_id, trial.relative_last)
            self._bump_trial_version(game_id)
            return {
                "trial_id": trial_id,
                "undone_relative": undone["move_no"],
                "relative_last": trial.relative_last,
            }

    async def trial_back_to_real(self, game_id: int, trial_id: int) -> dict:
        """回实战：返回试下进入时的主谱局面（不删除分支，可再次进入）。"""
        await self._require_game(game_id)
        trial = self._require_trial(game_id, trial_id)
        return {
            "game_id": game_id,
            "move_no": trial.enter_move_no,
            "trial_id": trial_id,
        }

    def _trial_moves(self, trial: TrialState) -> list[dict]:
        return [dict(m) for m in trial.moves]

    def _bump_trial_version(self, game_id: int) -> None:
        """试下分支内容变化 → 递增**试下域**版本号（旧试下分析任务过期）。

        分域（2026/09/10 修订）：试下分支变化不再误杀排队中的主谱分析任务。
        L-12（决策 B）：域粒度维持**按对局**——分支 A 变化会把分支 B 的在途试下
        任务一并过期（仅浪费一次重算，无数据面影响；细化到 trial_id 需改动
        ``scope_of``/提交快照/过期判定的域语义，收益不抵改动成本）。
        """
        if self._analysis is not None:
            self._analysis.bump_version(game_id, scope="trial")

    async def _schedule_trial_analysis(self, game: dict, trial: TrialState) -> None:
        """试下实时分析（链精度）：查询 = 主谱前缀 + 试下已落子，结果仅会话标准槽。"""
        if self._analysis is None or self._analysis._engine is None:
            return
        from app.engine.analysis_query import build_standard_query

        moves = await repos.list_moves(self._conn, game["id"])
        prefix = [m for m in moves if m["move_no"] <= trial.enter_move_no]
        query = build_standard_query(
            board_size=game["board_size"],
            rules=game["rules"],
            komi=game["komi"],
            moves=prefix + trial.moves,
            # 让子局：分析查询同样携带初始石（BUG-013）
            initial_stones=handicap_initial_stones(
                game["board_size"], game["handicap"] or 0
            ),
            max_visits=chain_visits(self._cfg, game),
        )
        position_key = self._trial_position_key(trial.trial_id, trial.relative_last)
        await self._analysis.submit(
            game["id"], position_key, query,
            extra={"trial_id": trial.trial_id},
        )

    # ---- 复弈（生成新对局 + 批量落盘） ----

    async def replay_trial(self, game_id: int, trial_id: int) -> int:
        """复弈：生成新对局（``parent_game_id`` 前导），试下分支落子并入正式棋谱。

        - 新对局落子 = 主谱前缀（至进入手数）+ 试下已落子；
        - 分析批量落盘（**单事务**，``bulk_upsert_position_analyses``）：
          前导主谱 ``main:{0..N}`` 复制进新对局自包含；
          试下 ``trial:{r}`` 一对一映射为 ``main:{N+r}``（r≥1，N=进入手数）；
          **仅复制试下标准会话槽**（深算槽为会话展示数据，不得进入新对局链，BUG-026）；
        - 新对局置 ``active``（复弈即可续弈）。
        """
        game = await self._require_game(game_id)
        trial = self._require_trial(game_id, trial_id)
        enter = trial.enter_move_no

        # 1. 创建新对局（复用原对局参数 + parent_game_id 前导）
        new_id = await repos.create_game(
            self._conn,
            mode=game["mode"],
            board_size=game["board_size"],
            rules=game["rules"],
            komi=game["komi"],
            handicap=game["handicap"],
            human_color=game["human_color"],
            black_player_id=game["black_player_id"],
            black_name=game["black_name"],
            black_rank=game["black_rank"],
            white_player_id=game["white_player_id"],
            white_name=game["white_name"],
            white_rank=game["white_rank"],
            ai_style=game["ai_style"],
            ai_level=game["ai_level"],
            adaptive_enabled=bool(game["adaptive_enabled"]),
            adaptive_initial_level=game["adaptive_initial_level"],
            coaching_enabled=bool(game["coaching_enabled"]),
            parent_game_id=game_id,
            # BUG-026：继承源对局**冻结的链精度**——新局需与批量复制的链行同精度，
            # 不得重新按“当前配置”计算（否则新局链内混配）
            chain_visits=int(game.get("chain_visits") or 0),
        )

        # 2. 写入落子（原谱前缀 + 试下）
        moves = await repos.list_moves(self._conn, game_id)
        prefix = [m for m in moves if m["move_no"] <= enter]
        all_moves = prefix + trial.moves
        for i, m in enumerate(all_moves, start=1):
            await repos.append_move(
                self._conn,
                game_id=new_id,
                move_no=i,
                color=m["color"],
                x=m["x"],
                y=m["y"],
                is_pass=bool(m["is_pass"]),
            )

        # 3. 分析批量落盘（单事务原子）
        items: list[tuple[str, str, int]] = []
        # 3a. 前导主谱分析复制（自包含）
        for k in range(0, enter + 1):
            row = await repos.get_main_analysis(self._conn, game_id, k)
            if row is not None:
                items.append(
                    (f"main:{k}", row["data_json"], int(row["max_visits"]))
                )
        # 3b. 试下分析映射（trial:{r} → main:{enter+r}）
        if self._analysis is not None:
            for relative, (data, max_visits) in self._analysis.cache.list_trial_with_visits(
                trial_id
            ).items():
                if relative >= 1:
                    items.append(
                        (
                            f"main:{enter + relative}",
                            json.dumps(data, ensure_ascii=False),
                            max_visits,
                        )
                    )
        if items:
            stats = await repos.bulk_upsert_position_analyses(
                self._conn, game_id=new_id, items=items
            )
            logger.info(
                "复弈对局 #%d 已创建（源对局 #%d · 试下 #%d）：写入 %d 条 · 替换 %d 条 · 丢弃 %d 条",
                new_id, game_id, trial_id,
                stats["inserted"], stats["replaced"], stats["discarded"],
            )

        # 4. 新对局 active（可续弈）
        await repos.update_game_status(self._conn, new_id, "active")
        # BUG-031：提子计数器按复制棋谱（前导 + 试下）回算——新局展示提子数须与棋谱一致
        replayed = replay_position(
            board_size=int(game["board_size"]),
            handicap=int(game["handicap"] or 0),
            moves=all_moves,
        )
        await repos.set_captures(
            self._conn,
            new_id,
            black_captures=replayed.black_prisoners,
            white_captures=replayed.white_prisoners,
        )
        return new_id

    # ---- T3.10 深度分析 / 全局分析 ----

    async def deep_analyze(
        self,
        game_id: int,
        *,
        move_no: Optional[int] = None,
        position_key: Optional[str] = None,
    ) -> dict:
        """深度分析：一次性深算（``deep.max_visits``，P2）。

        - 主谱用 ``{move_no}``（缺省=当前局面）；试下分支用 ``{position_key}``
          （格式 ``trial:{trial_id}:{relative}``）；
        - **深算结果仅会话有效（BUG-026 人工确认）**：结果入会话**深算槽**
          （不落盘，展示类读取优先命中；刷新/重启/悔棋后失效）；
        - **进行中互斥**：已有深算进行中抛 ``DEEP_ANALYSIS_RUNNING``；
        - 结果经调度器会话深算槽并返回（等待完成）。
        """
        game = await self._require_game(game_id)
        if self._deep_running:
            raise AppError(ErrorCode.DEEP_ANALYSIS_RUNNING, "已有深度分析进行中")
        if self._analysis is None or self._analysis._engine is None:
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用：深度分析降级")
        # 互斥标志在首个 await 前置位（避免并发窗口竞态）
        self._deep_running = True
        try:
            if position_key is not None and position_key.startswith("trial:"):
                moves = await self._trial_moves_for_deep(game, position_key)
                key = position_key
            else:
                target = game["last_move_no"] if move_no is None else move_no
                if not (0 <= target <= game["last_move_no"]):
                    raise AppError(ErrorCode.ILLEGAL_ACTION, f"深度分析手数越界: {target}")
                key = f"main:{target}"
                all_moves = await repos.list_moves(self._conn, game["id"])
                moves = [m for m in all_moves if m["move_no"] <= target]

            from app.engine.analysis_query import build_deep_query

            query = build_deep_query(
                board_size=game["board_size"],
                rules=game["rules"],
                komi=game["komi"],
                moves=moves,
                # 让子局：分析查询同样携带初始石（BUG-013）
                initial_stones=handicap_initial_stones(
                    game["board_size"], game["handicap"] or 0
                ),
                deep_max_visits=self._cfg.engine.deep_max_visits,
            )
            return await self._submit_and_wait(game_id, key, query, kind=KIND_DEEP)
        finally:
            self._deep_running = False

    async def _trial_moves_for_deep(self, game: dict, position_key: str) -> list[dict]:
        """试下分支深度分析：主谱前缀 + 试下至相对手数。"""
        parts = position_key.split(":")
        if len(parts) != 3 or not parts[1].isdigit() or not parts[2].isdigit():
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"非法试下 position_key: {position_key}")
        trial_id, relative = int(parts[1]), int(parts[2])
        trial = self._require_trial(game["id"], trial_id)
        if not (0 <= relative <= trial.relative_last):
            raise AppError(ErrorCode.ILLEGAL_ACTION, f"试下相对手数越界: {relative}")
        all_moves = await repos.list_moves(self._conn, game["id"])
        prefix = [m for m in all_moves if m["move_no"] <= trial.enter_move_no]
        return prefix + trial.moves[:relative]

    async def _submit_and_wait(
        self,
        game_id: int,
        position_key: str,
        query: dict,
        *,
        kind: str = "chain",
    ) -> dict:
        """提交分析任务并等待结果（on_result 完成 future；超时抛 ENGINE_BUSY）。

        ``kind``：存储语义透传调度器——``deep``（一次性深算，仅会话深算槽；
        BUG-026 人工确认：深算结果不落盘）/ ``chain``（链槽，如全局分析）。
        """
        if self._analysis is None:
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用：分析服务未接入")
        fut: asyncio.Future = asyncio.get_running_loop().create_future()

        async def _on_result(*args) -> None:
            # 回调签名 (position_key, result)；仅需 result
            if not fut.done() and len(args) >= 2:
                fut.set_result(args[1])

        def _on_drop(reason: str) -> None:
            # H-3 修复（2026-09-19 代码审查）：任务被丢弃（引擎故障/局面过期）必须
            # 立即回投终态——旧实现未注册本回调，调用方只能等满 DEEP_ANALYSIS_TIMEOUT_S
            # （300s；全局分析逐手循环下每缺口一次，UI 长时间“分析中”）。
            # 错误码选型：引擎类 → ENGINE_DEAD（降级语义）；过期（悔棋/重开/分支变更）
            # → ENGINE_BUSY——前端错误矩阵对 ENGINE_BUSY/ENGINE_DEAD 会复位深算/
            # 支招的进行态（详情见 reviewErrorOutcome / game-view.onGameError）。
            if fut.done():
                return
            if reason == "expired":
                fut.set_exception(
                    AppError(ErrorCode.ENGINE_BUSY, "分析已过期：局面已变化")
                )
            else:
                fut.set_exception(
                    AppError(ErrorCode.ENGINE_DEAD, "引擎不可用：分析任务被丢弃（降级）")
                )

        await self._analysis.submit(
            game_id,
            position_key,
            query,
            on_result=_on_result,
            on_drop=_on_drop,
            kind=kind,
        )
        try:
            return await asyncio.wait_for(fut, timeout=DEEP_ANALYSIS_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise AppError(ErrorCode.ENGINE_BUSY, "深度分析超时") from None

    async def coaching(self, game_id: int) -> dict:
        """支招 TOP5（对弈中按需触发，PRD §4.1.5 / API §4.3 coaching.request）。

        - 对当前局面触发**深度分析**（``deep.max_visits``，P2，与深度分析同精度）；
        - **结果仅会话有效（BUG-026 人工确认）**：入会话深算槽（不落盘）——会话内
          推荐卡/领地优先命中，刷新后回到链槽；返回 TOP5 供 ``coaching.top5`` 推送；
        - **视角**（2026/09/11 人工确认）：``moves[].winrate/score_lead`` 与
          ``base_winrate`` 均为当前执色方视角（附 ``side``），前端不再换算；
        - 引擎不可用 → ``ENGINE_DEAD``（支招降级提示）。
        """
        game = await self._require_game(game_id)
        if self._analysis is None or self._analysis._engine is None:
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用：支招降级")

        from app.engine.analysis_query import build_coaching_query

        all_moves = await repos.list_moves(self._conn, game["id"])
        query = build_coaching_query(
            board_size=game["board_size"],
            rules=game["rules"],
            komi=game["komi"],
            moves=all_moves,
            # 让子局：分析查询同样携带初始石（BUG-013）
            initial_stones=handicap_initial_stones(
                game["board_size"], game["handicap"] or 0
            ),
            deep_max_visits=self._cfg.engine.deep_max_visits,
        )
        key = f"main:{game['last_move_no']}"
        result = await self._submit_and_wait(game_id, key, query, kind=KIND_DEEP)
        root = result.get("rootInfo") or {}
        current = root.get("currentPlayer")
        side = current if current in ("B", "W") else "B"
        return {
            "move_no": game["last_move_no"],
            "side": side,
            # 对比基准：当前局面 root 胜率（当前执色方视角百分比，前端卡片脚注用）
            "base_winrate": _side_winrate(root.get("winrate"), side),
            "moves": self._top_moves(result, side),
        }

    async def global_analyze(
        self,
        game_id: int,
        *,
        start_move_no: int = 0,
        on_progress=None,
    ) -> dict:
        """全局分析：逐手补写缺失 ``position_key``（P3、排队 + 进度、可中断续跑）。

        - 缺失推导：0..last_move_no 中无 ``main:{n}`` 记录的局面对手分析；
        - 每局面一查询（链精度 maxVisits，避免 analyzeTurns 多响应路由问题），完成后写链槽；
        - 可中断（``global_analyze_cancel``）：已完成手保留，续跑从覆盖率继续；
        - 引擎不可用降级（分析类功能提示"不可用"）。
        """
        game = await self._require_game(game_id)
        if self._global_running:
            raise AppError(ErrorCode.ILLEGAL_ACTION, "全局分析已在进行中")
        if self._analysis is None or self._analysis._engine is None:
            raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用：全局分析降级")

        total = game["last_move_no"]
        # M-5：单次批量读取已有主谱分析推导缺失手（避免逐手 N+1 查询）
        covered = set(await self._main_analyses(game_id))
        missing: list[int] = [
            n for n in range(max(0, start_move_no), total + 1) if n not in covered
        ]
        if not missing:
            return {"done": 0, "total": 0, "finished": True, "interrupted": False}

        from app.engine.analysis_query import PRIORITY_GLOBAL, build_standard_query

        all_moves = await repos.list_moves(self._conn, game_id)
        required_visits = chain_visits(self._cfg, game)
        self._global_running = True
        self._global_game_id = game_id
        self._global_cancelled = False
        self._global_total = len(missing)
        self._global_done = 0
        done = 0
        try:
            for move_no in missing:
                if self._global_cancelled:
                    break
                # L-12（决策 A）：逐手轻量复核——循环期间其他路径（每手 P1/判定前置链）
                # 可能已补齐该局面；单键索引查询命中即跳过（旧实现 `move_no in covered`
                # 用循环前快照，恒不可达）。
                existing = await repos.get_main_analysis(self._conn, game_id, move_no)
                if existing is not None and int(existing["max_visits"] or 0) >= required_visits:
                    done += 1
                    self._global_done = done
                    if on_progress is not None:
                        await on_progress(done, len(missing))
                    continue
                moves = [m for m in all_moves if m["move_no"] <= move_no]
                query = build_standard_query(
                    board_size=game["board_size"],
                    rules=game["rules"],
                    komi=game["komi"],
                    moves=moves,
                    # 让子局：分析查询同样携带初始石（BUG-013）
                    initial_stones=handicap_initial_stones(
                        game["board_size"], game["handicap"] or 0
                    ),
                    max_visits=required_visits,
                )
                query["priority"] = PRIORITY_GLOBAL  # 全局分析 P3
                try:
                    await self._submit_and_wait(game_id, f"main:{move_no}", query)
                except AppError:
                    raise
                done += 1
                self._global_done = done
                if on_progress is not None:
                    await on_progress(done, len(missing))
        finally:
            self._global_running = False
            self._global_game_id = None
        interrupted = self._global_cancelled
        return {
            "done": done,
            "total": len(missing),
            "finished": not interrupted,
            "interrupted": interrupted,
        }

    def global_analyze_cancel(self, game_id: int) -> None:
        """中断全局分析（已完成手保留，可续跑；仅对进行中的同对局生效）。"""
        if self._global_running and self._global_game_id == game_id:
            self._global_cancelled = True

    def global_analysis_progress(self, game_id: int) -> Optional[dict]:
        """进行中全局分析进度（W-08：重连 restore.request 时重发 analysis.progress）。

        未在进行中的同对局 → ``None``（前端仅显示“分析中”无进度）。
        """
        if not (self._global_running and self._global_game_id == game_id):
            return None
        return {
            "kind": "global",
            "done": self._global_done,
            "total": self._global_total,
        }

    async def analysis_complete(self, game_id: int) -> bool:
        """分析覆盖率推导：0..last_move_no 均有 main:{n} 记录 → 报告入口显示。"""
        game = await self._require_game(game_id)
        covered = await repos.analysis_coverage(self._conn, game_id, game["last_move_no"])
        return covered == game["last_move_no"] + 1


def _pv_with_colors(pv: list, first_color: str, *, board_size: int = 19) -> list[dict]:
    """PV（GTP 串列表）→ 带颜色的落子序列（自 first_color 起交替；按盘大小解析）。"""
    result: list[dict] = []
    color = first_color
    for loc in pv:
        if is_pass_loc(loc):
            result.append({"color": color, "is_pass": True})
        else:
            try:
                x, y = gtp_to_xy(loc, board_size=board_size)
            except (ValueError, IndexError, TypeError):
                break
            result.append({"color": color, "x": x, "y": y, "is_pass": False})
        color = "W" if color == "B" else "B"
    return result
