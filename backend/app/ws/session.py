"""WebSocket 会话管理（TASK T4.7，ARCHITECTURE §1.1/§5.1，API §4）。

职责：
- **按 game_id 分组的连接管理**：对弈/复盘通道 `/ws/games/{game_id}` 连接注册、
  广播与断线回收（API §4.1）；
- **管理通道**：`/ws/admin` 连接集合与广播；
- **全局 engine.status 广播**：引擎状态（含 INIT/benchmark 进度）对弈/复盘/管理
  通道均收到（API §4.4）；
- **分析结果 → analysis.curve 节流推送**（``GameAnalysisPusher``）：订阅分析调度器
  结果，按 200ms 时间窗口合并推送（ARCHITECTURE §4.2，AGENTS.md §6/§7 时间窗口）。

> 分析结果的其它推送（``analysis.comment`` 点评、``scoring.prediction`` 结算预判）
> 见 ``ws/pushes.py``，与曲线推送在组合根经 ``AnalysisResultFanout`` 共同接线。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, Optional

from fastapi import WebSocket

from app.api.public import winrate_to_percent
from app.services.analysis_service import ThrottledPusher

logger = logging.getLogger(__name__)

#: analysis.curve 节流窗口（秒，ARCHITECTURE §4.2）
CURVE_THROTTLE_WINDOW_S = 0.2

#: 单连接发送超时（秒）：半开/僵死连接不得让广播与持锁路径无限悬挂（H-2）
DEFAULT_SEND_TIMEOUT_S = 5.0


class SessionManager:
    """按 game_id 分组的连接管理与广播（断线清理、全局 engine.status）。"""

    def __init__(self, *, send_timeout_s: float = DEFAULT_SEND_TIMEOUT_S) -> None:
        self._send_timeout_s = send_timeout_s
        self._game_groups: dict[int, set[WebSocket]] = {}
        self._admin: set[WebSocket] = set()
        #: 人人对弈悔棋申请：game_id → {request_id, requester, color, steps, others_exist}
        self._undo_requests: dict[int, dict] = {}
        self._undo_seq = 0
        self._lock = asyncio.Lock()

    # ---- 注册 / 回收 ----

    def game_conn_count(self, game_id: int) -> int:
        """某对局当前连接数（订阅生命周期判定用）。"""
        return len(self._game_groups.get(game_id, set()))

    async def register_game(self, game_id: int, ws: WebSocket) -> None:
        """对弈/复盘通道连接注册。"""
        async with self._lock:
            self._game_groups.setdefault(game_id, set()).add(ws)

    async def unregister_game(self, game_id: int, ws: WebSocket) -> None:
        """对弈/复盘通道连接回收（组空即整体回收）。"""
        async with self._lock:
            group = self._game_groups.get(game_id)
            if group is None:
                return
            group.discard(ws)
            if not group:
                self._game_groups.pop(game_id, None)

    async def register_admin(self, ws: WebSocket) -> None:
        """管理通道连接注册。"""
        async with self._lock:
            self._admin.add(ws)

    async def unregister_admin(self, ws: WebSocket) -> None:
        """管理通道连接回收。"""
        async with self._lock:
            self._admin.discard(ws)

    def has_game_connections(self) -> bool:
        """是否存在活跃的对弈/复盘连接（引擎空闲计时不计时 / 停止自动拉起的判据）。"""
        return any(bool(group) for group in self._game_groups.values())

    # ---- 发送 / 广播 ----

    async def send(self, ws: WebSocket, envelope: dict) -> None:
        """单连接发送（断线/竞态失败静默丢弃，不阻塞广播）。

        H-2 修复（2026-09-19 代码审查）：发送加**超时上限**——半开/僵死连接
        （移动端写缓冲写满、无 ACK）会让 ``send_json`` 长时间挂起；旧实现无界等待
        会把广播乃至持对局锁的收尾路径（``play`` 提交回调 / AI 应手收尾）一起拖住。
        超时视同断线：取消本次发送并记 warning；连接回收仍由接收循环（30s 无消息
        判线）或对端关闭统一完成（此处不重复处理）。
        """
        try:
            await asyncio.wait_for(
                ws.send_json(envelope), timeout=self._send_timeout_s
            )
        except asyncio.TimeoutError:
            logger.warning(
                "WS 发送超时（%.1fs 未完成，按断线处理；连接将由接收循环回收）",
                self._send_timeout_s,
            )
        except TypeError as exc:
            # L-5：载荷不可序列化（误塞 set/对象等）属**编程错误**——必须 ERROR 级可见；
            # 旧实现与连接类异常同列 DEBUG，请求方等不到响应且无任何日志线索
            logger.error("WS 发送载荷不可序列化（检查信封字段）：%r", exc)
        except Exception as exc:  # noqa: BLE001 - 连接已断开/竞态，广播容错
            # L-6：调试级记录发送失败（连接回收由 unregister 完成，此处不重复处理）
            logger.debug("WS 发送失败（连接已断开/竞态）：%r", exc)

    async def _send_all(self, targets: list[WebSocket], envelope: dict) -> None:
        """并发扇出同一信封（H-2）：各连接独立超时，互不队头阻塞。

        ``send`` 内部已吞掉连接类异常；``gather`` 仅向上传递取消
        （关闭/任务取消），与旧顺序 await 的取消语义一致。
        """
        if not targets:
            return
        await asyncio.gather(*(self.send(ws, envelope) for ws in targets))

    async def broadcast_to_game(self, game_id: int, envelope: dict) -> None:
        """向某对局全部连接广播（并发扇出，H-2）。"""
        await self._send_all(list(self._game_groups.get(game_id, set())), envelope)

    async def send_to_game_others(self, game_id: int, ws: WebSocket, envelope: dict) -> bool:
        """向某对局**除指定连接外**的其余连接发送（人人对弈悔棋确认用）。

        返回是否有其它连接收到（``False`` = 单连接热座场景，由调用方转投请求方本机）。
        """
        others = [
            other for other in self._game_groups.get(game_id, set()) if other is not ws
        ]
        await self._send_all(others, envelope)
        return bool(others)

    # ---- 人人对弈悔棋申请（pending undo proposal；单实例进程内） ----

    def next_undo_request_id(self) -> int:
        """悔棋申请自增 id。"""
        self._undo_seq += 1
        return self._undo_seq

    def undo_request_begin(
        self,
        game_id: int,
        requester: WebSocket,
        *,
        request_id: int,
        color: str,
        steps: int,
        others_exist: bool,
    ) -> Optional[dict]:
        """创建悔棋申请（同对局已有申请则返回 None，防堆积）。"""
        if game_id in self._undo_requests:
            return None
        req = {
            "game_id": game_id,
            "request_id": request_id,
            "requester": requester,
            "color": color,
            "steps": steps,
            "others_exist": others_exist,
        }
        self._undo_requests[game_id] = req
        return req

    def undo_request_get(self, game_id: int) -> Optional[dict]:
        """读取当前悔棋申请（无则 None）。"""
        return self._undo_requests.get(game_id)

    def undo_request_clear(self, game_id: int) -> Optional[dict]:
        """清除悔棋申请并返回原申请（无则 None）。"""
        return self._undo_requests.pop(game_id, None)

    async def broadcast_to_admin(self, envelope: dict) -> None:
        """向管理通道全部连接广播（并发扇出，H-2）。"""
        await self._send_all(list(self._admin), envelope)

    async def broadcast_engine_status(
        self,
        state: str,
        progress: Optional[int] = None,
        *,
        human_model_available: Optional[bool] = None,
        reason: Optional[str] = None,
        detail: Optional[str] = None,
    ) -> None:
        """全局 engine.status 广播（API §4.4：对弈/复盘/管理通道均收到）。

        ``humanModelAvailable`` 为可选字段（API §1 向后兼容）：前端据此呈现
        「人类模型不可用」提示；未知（None）时不携带该字段。
        ``reason``/``detail``（BUG-097）**恒携带**（显式 null 清旧值）：前端据此
        呈现引擎不可用真实原因（standard_model_missing / engine_executable_missing /
        startup_failed + stderr 摘要），恢复就绪即被 null 清除。
        """
        data: dict = {
            "state": state,
            "progress": progress,
            "reason": reason,
            "detail": detail,
        }
        if human_model_available is not None:
            data["humanModelAvailable"] = bool(human_model_available)
        envelope = {"type": "engine.status", "data": data}
        # H-2：跨对局/管理连接统一并发扇出——单连接停滞不再逐个拖慢后续对局
        # （旧实现按对局顺序 await，一个僵死连接会推迟全部状态更新）。
        targets = [ws for group in self._game_groups.values() for ws in group]
        targets.extend(self._admin)
        await self._send_all(targets, envelope)


class GameAnalysisPusher:
    """按 game_id 订阅分析结果并节流推送 analysis.curve（200ms 窗口）。

    - 订阅生命周期：首个对局连接注册时 ``subscribe``，末个连接断开时 ``unsubscribe``；
    - 仅推送主谱结果（``main:{move_no}``）；试下分支不推曲线（复盘侧另行处理）；
    - 窗口为全局共享（单定时器），以 ``(game_id, position_key)`` 为键合并，
      多对局并发互不干扰（ARCHITECTURE §4.2）；
    - ``on_result`` 为分析调度器回调，由组合根（bootstrap）经 ``AnalysisResultFanout``
      与其它推送组件（点评推送）一并接线（2026/09/11）。
    """

    def __init__(
        self,
        analysis,
        session: SessionManager,
        *,
        window_s: float = CURVE_THROTTLE_WINDOW_S,
        sleep: Callable = asyncio.sleep,
    ) -> None:
        self._analysis = analysis
        self._session = session
        self._window_s = window_s
        self._sleep = sleep
        self._pushers: dict[int, ThrottledPusher] = {}

    def subscribe(self, game_id: int) -> None:
        """订阅某对局分析曲线推送（幂等）。"""
        if game_id not in self._pushers:
            self._pushers[game_id] = ThrottledPusher(
                self._push_curve, window_s=self._window_s, sleep=self._sleep
            )

    def unsubscribe(self, game_id: int) -> None:
        """取消订阅（末个连接断开时调用，回收节流器）。"""
        self._pushers.pop(game_id, None)

    def is_subscribed(self, game_id: int) -> bool:
        return game_id in self._pushers

    async def on_result(self, game_id: int, position_key: str, preprocessed: dict) -> None:
        """分析调度器结果回调：主谱结果合并进节流窗口推送曲线。"""
        pusher = self._pushers.get(game_id)
        if pusher is None or not position_key.startswith("main:"):
            return
        try:
            move_no = int(position_key.split(":", 1)[1])
        except (ValueError, IndexError):
            return
        root = preprocessed.get("rootInfo") or {}
        pusher.push(
            f"{game_id}:{position_key}",
            {
                "type": "analysis.curve",
                "data": {
                    "move_no": move_no,
                    # ISSUE-050：黑方视角 0..1 → 输出百分比（round 2）
                    "winrate": winrate_to_percent(root.get("winrate")),
                    "score_lead": root.get("scoreLead"),
                },
            },
        )

    async def _push_curve(self, key: str, envelope: dict) -> None:
        """节流窗口 flush 回调：向所属对局广播。"""
        try:
            game_id = int(key.split(":", 1)[0])
        except (ValueError, IndexError):
            return
        await self._session.broadcast_to_game(game_id, envelope)
