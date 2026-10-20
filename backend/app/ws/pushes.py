"""WS 分析类推送组件（对局通道，2026/09/11 人工确认）。

- ``AnalysisResultFanout``：分析调度器全局结果回调的扇出器（``AnalysisService``
  只有单个 ``set_on_result`` 槽，多个推送组件在组合根显式接线）；
- ``GameCommentPusher``：**每手标准分析结果到达 → 当前手点评 ``analysis.comment``**
  ——对弈页点评为实时数据、与引擎相关（不再经 ``recommend.request`` 复用复盘派生）；
- ``SettlementPredictor``：**结算预判**（双 PASS / 认输）→ 终局深度分析
  （``deep_max_visits``）→ GTP ``final_score`` 等价结果 + 预判死子 →
  ``scoring.prediction`` 推送（引擎不可用 → ``engine:false`` 降级）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

from app.config import AppConfig
from app.db import repos
from app.engine.analysis_query import build_deep_query
from app.services.final_score import predict_from_analysis
from app.services.go_rules import handicap_initial_stones

logger = logging.getLogger(__name__)

#: 结算预判原因（``scoring.prediction.reason``，前端提示用）
DROP_ENGINE_UNAVAILABLE = "engine_unavailable"
#: 任务因局面变化（悔棋/重开/试下）过期——调用方仅复位状态，不推降级载荷
DROP_EXPIRED = "expired"


class AnalysisResultFanout:
    """分析结果回调扇出（单回调槽 → 多推送组件；单组件异常不影响其余）。"""

    def __init__(self, *sinks: Callable[[int, str, dict], Awaitable[None]]) -> None:
        self._sinks = sinks

    async def __call__(self, game_id: int, position_key: str, preprocessed: dict) -> None:
        for sink in self._sinks:
            try:
                await sink(game_id, position_key, preprocessed)
            except Exception:  # noqa: BLE001 - 单推送组件异常不影响其余组件
                logger.exception("分析结果推送组件异常 · 对局 #%s · 局面 %s", game_id, position_key)


class GameCommentPusher:
    """每手标准分析结果 → 当前手点评 ``analysis.comment``（实时、引擎相关）。

    - 触发：``main:{N}``（N≥1）结果落库后（每手 P1 / 判定前置分析 / AI P0 单查询合并 /
      深算均到达）；
    - 派生：``ReviewService.comment_for_move``（``main:{N-1}`` 与 ``main:{N}`` root 之差，
      落子方视角，命中 AI 选点优先 + LEVEL 带表五档），载荷
      ``{move_no,color,x,y,grade,delta_winrate,score_delta}``（ΔS=目数变化，好手为正）；
    - **前序在途补推（BUG-028）**：相邻两局面分析可能**并发**完成（典型：首手
      ``main:0`` + ``main:1``；自适应对局的判定前置分析与其前一局面）——先到者因
      缺前序 root 派生失败时，**后台重试**（不阻塞分析 worker / 对弈锁；成功即推、
      逾期静默——重连回投与复盘派生仍可补齐）；
    - 仅当该对局存在连接时计算（无连接的复盘场景不做无用功）；
    - 连接/恢复（restore.request）时由 ``ws_game`` 侧回投当前手点评（见 ``_send_game_state``）。
    """

    def __init__(
        self,
        review,
        session,
        *,
        retry_delays_s: tuple[float, ...] = (0.8, 2.4),
        sleep: Callable = asyncio.sleep,
    ) -> None:
        self._review = review
        self._session = session
        self._retry_delays_s = retry_delays_s
        self._sleep = sleep
        self._retry_tasks: set[asyncio.Task] = set()

    async def on_result(self, game_id: int, position_key: str, preprocessed: dict) -> None:
        move_no = _main_move_no(position_key)
        if move_no is None or move_no < 1:
            return
        if self._session.game_conn_count(game_id) == 0:
            return
        comment = await self._review.comment_for_move(game_id, move_no)
        if comment is not None:
            await self._push(game_id, comment)
            return
        self._spawn_retry(game_id, move_no)

    def _spawn_retry(self, game_id: int, move_no: int) -> None:
        """后台上补推任务（前序局面可能仍在途；任务引用持存至完成，防 GC）。"""
        task = asyncio.create_task(
            self._retry_push(game_id, move_no), name=f"comment-retry-{game_id}-{move_no}"
        )
        self._retry_tasks.add(task)
        task.add_done_callback(self._retry_tasks.discard)

    async def _retry_push(self, game_id: int, move_no: int) -> None:
        for delay in self._retry_delays_s:
            await self._sleep(delay)
            if self._session.game_conn_count(game_id) == 0:
                return
            comment = await self._review.comment_for_move(game_id, move_no)
            if comment is not None:
                await self._push(game_id, comment)
                return

    async def wait_retries(self) -> None:
        """等待在途补推任务结束（测试 / 关停用）。"""
        while self._retry_tasks:
            await asyncio.gather(*list(self._retry_tasks), return_exceptions=True)

    async def _push(self, game_id: int, comment: dict) -> None:
        await self._session.broadcast_to_game(
            game_id, {"type": "analysis.comment", "data": comment}
        )


def _main_move_no(position_key: str) -> Optional[int]:
    """主谱键 ``main:{N}`` → 手数；非主谱键/非法键 → None。"""
    if not position_key.startswith("main:"):
        return None
    try:
        return int(position_key.split(":", 1)[1])
    except (ValueError, IndexError):
        return None


def _is_double_pass(moves: list[dict]) -> bool:
    """末两手均为 PASS（双 PASS 终局判定，与 GameService 进入结算判定一致）。"""
    return len(moves) >= 2 and all(bool(m.get("is_pass")) for m in moves[-2:])


class SettlementPredictor:
    """结算预判：终局深算 → GTP ``final_score`` 等价结果 + 预判死子 → 推送。

    - 触发：双 PASS 进入结算（``PlayResult.entering_scoring``）与认输终局
      （``PlayResult.game_over``，WS 层调用 ``predict``）；
    - 查询：``build_deep_query``（``engine.deep_max_visits``，P2，含 ownership）；
      结果**落链槽**（BUG-026 人工确认：终局行由深算补齐/覆盖，供复盘展示；
      其余深算一律仅会话），推送仍照常；
    - 结果：``services.final_score.predict_from_analysis``（双 PASS → 按预判死子精确
      数子；认输 → GTP 预期分支的 lead 取整结果），推送 ``scoring.prediction``；
    - 降级：引擎不可用/查询失败 → 推送 ``engine:false``（前端退化为人工标记死子 +
      Python 结算，结算不受阻断）；
    - 局面已变化（悔棋/重开导致 ``last_move_no`` 不同）→ 预判失效不推送。
    """

    def __init__(self, conn, config: AppConfig, analysis, session) -> None:
        self._conn = conn
        self._cfg = config
        self._analysis = analysis
        self._session = session
        #: 进行中的对局（防重复提交）与最近一次预判（连接/恢复回投）
        self._running: set[int] = set()
        self._last: dict[int, dict] = {}

    def last_prediction(self, game_id: int, *, move_no: Optional[int] = None) -> Optional[dict]:
        """最近一次预判载荷（连接/恢复回投；``move_no`` 不匹配视为过期 → None）。"""
        payload = self._last.get(game_id)
        if payload is None:
            return None
        if move_no is not None and int(payload.get("move_no", -1)) != int(move_no):
            return None
        return payload

    def forget_game(self, game_id: int) -> None:
        """对局删除：回收最近预判与进行中标记（L-6）。

        旧实现无删除钩子：`_last` 条目在对局删除后留守内存，且 `_on_drop` 的
        降级回投会把已删除对局重新写回 `_last`（无属主条目复活）。
        """
        self._last.pop(game_id, None)
        self._running.discard(game_id)

    async def predict(self, game_id: int) -> None:
        """发起终局预判（幂等：同一对局进行中不重复提交；后台任务调用）。"""
        if game_id in self._running:
            return
        game = await repos.get_game(self._conn, game_id)
        if game is None:
            return
        move_no = int(game["last_move_no"] or 0)
        moves = await repos.list_moves(self._conn, game_id)
        finished = _is_double_pass(moves)
        if not self._analysis.engine_available:
            await self._push(
                game_id,
                self._empty_payload(game_id, move_no, finished, DROP_ENGINE_UNAVAILABLE),
            )
            return
        query = build_deep_query(
            board_size=int(game["board_size"]),
            rules=str(game["rules"]),
            komi=float(game["komi"]),
            moves=moves,
            deep_max_visits=int(self._cfg.engine.deep_max_visits),
            # 让子局：分析查询同样携带初始石（BUG-013）
            initial_stones=handicap_initial_stones(
                int(game["board_size"]), int(game["handicap"] or 0)
            ),
        )
        position_key = f"main:{move_no}"
        self._running.add(game_id)

        async def _on_result(_key: str, preprocessed: dict) -> None:
            self._running.discard(game_id)
            await self._on_analysis(game_id, move_no, preprocessed)

        async def _on_drop(reason: str) -> None:
            self._running.discard(game_id)
            if reason == DROP_EXPIRED:
                # 局面已变化（悔棋/重开）→ 预判失效：静默丢弃（不推降级载荷，
                # 避免对已回到对弈的局面显示“引擎不可用”）；
                # ``_running`` 已复位 —— 后续再进结算仍可正常预判
                logger.debug("结算预判过期丢弃 · 对局 #%s · 第 %s 手", game_id, move_no)
                return
            # L-6：对局已删除 → 不推降级载荷（否则删除后 `_last` 被重新写入）
            if await repos.get_game(self._conn, game_id) is None:
                return
            await self._push(
                game_id, self._empty_payload(game_id, move_no, finished, reason)
            )

        # kind="chain"（BUG-026 人工确认）：预判深算结果**落链槽**——终局局面由
        # 深算预判落库补齐（双 PASS 终局无逐手分析）/覆盖（认输终局），供复盘
        # 领地/推荐读取；其余深算（深度分析/支招）仅入会话深算槽不落盘
        await self._analysis.submit(
            game_id, position_key, query, on_result=_on_result, on_drop=_on_drop
        )

    async def _on_analysis(self, game_id: int, move_no: int, preprocessed: dict) -> None:
        """深算结果到达：局面未变化时计算并推送预判。"""
        game = await repos.get_game(self._conn, game_id)
        if game is None or int(game["last_move_no"] or 0) != move_no:
            return  # 悔棋/重开等导致局面变化 → 预判失效
        moves = await repos.list_moves(self._conn, game_id)
        root = preprocessed.get("rootInfo") or {}
        payload = predict_from_analysis(
            board_size=int(game["board_size"]),
            rules=str(game["rules"]),
            komi=float(game["komi"]),
            handicap=int(game["handicap"] or 0),
            moves=moves,
            ownership=preprocessed.get("ownership"),
            score_lead_black=root.get("scoreLead"),
            finished=_is_double_pass(moves),
        )
        await self._push(
            game_id,
            {
                "game_id": game_id,
                "move_no": move_no,
                "engine": True,
                "reason": None,
                **payload,
            },
        )

    @staticmethod
    def _empty_payload(game_id: int, move_no: int, finished: bool, reason: str) -> dict:
        """降级载荷（引擎不可用/失败）：空预判 + 原因，前端转人工标记。"""
        return {
            "game_id": game_id,
            "move_no": move_no,
            "engine": False,
            "reason": reason,
            "finished": finished,
            "dead_points": [],
            "result": None,
            "black_score": None,
            "white_score": None,
            "lead": None,
        }

    async def _push(self, game_id: int, payload: dict) -> None:
        self._last[game_id] = payload
        await self._session.broadcast_to_game(
            game_id, {"type": "scoring.prediction", "data": payload}
        )
