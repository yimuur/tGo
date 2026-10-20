"""分析调度器 + 分析结果双槽缓存（TASK T3.6/T3.7，ARCHITECTURE §4.2，DATABASE §3.4）。

职责：
- **T3.6 分析调度器**：
  - 任务队列按查询 ``priority`` 出队（P0 对弈 > P1 标准 > P2 深度/支招 > P3 全局）；
  - 并发上限（``concurrency``，默认 2，可配）；
  - **200ms 时间窗口节流推送**（窗口末只推最新一条，``ThrottledPusher``）；
  - **过期任务丢弃**：以对局局面版本号（``seq``，按 ``main``/``trial`` 域）判定，
    悔棋/重开/试下分支变化后**同域**旧任务结果不写库、不推送（2026/09/10 修订：
    普通落子不再递增版本号——每手分析仍有效，BUG-012 修复）；
  - 对弈/分析单查询合并。
- **T3.7 分析结果合并缓存**（``AnalysisCache``，双槽结构 BUG-026）：
  - **链槽**（``kind="chain"``）：主谱 ``main:{move_no}`` 落库（合并 upsert）；
    试下分支 ``trial:{trial_id}:{move_no}`` 仅会话缓存不落库；试下撤销按相对手数截断。
    链槽精度恒为链精度（``services.chain_precision``）——差量指标（点评/报告）
    唯一数据源；
  - **深算槽**（``kind="deep"``）：深算/支招结果**仅会话内存不落盘**（人工确认）；
    展示类读取优先深算槽、无则回退链槽。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from app.config import AppConfig
from app.core.errors import AppError
from app.db import repos
from app.engine.preprocess import preprocess_analysis_response
from app.services.chain_precision import KIND_CHAIN, KIND_DEEP

logger = logging.getLogger(__name__)

#: 结果推送默认节流窗口（秒）
DEFAULT_THROTTLE_WINDOW_S = 0.2

#: 试下分支会话缓存容量上限（M-2：防 ``_session`` 无界增长，超出按插入序淘汰最旧）
DEFAULT_MAX_SESSION_ENTRIES = 2000

#: 缓存动作 → 日志中文文案（系统日志须便于人类阅读/理解）
_ACTION_TEXT: dict[str, str] = {
    "inserted": "写入",
    "replaced": "替换",
    "discarded": "丢弃（精度不升）",
    "stale": "过期丢弃",
}


def _now_str() -> str:
    """当前 UTC 时间（与 SQLite datetime('now') 同口径）。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ============================================================
# 200ms 时间窗口节流推送
# ============================================================


class ThrottledPusher:
    """高频结果按时间窗口合并推送：窗口内只推每个 key 的最新一条。

    - ``push(key, payload)`` 在窗口内合并（同 key 覆盖）；
    - 窗口结束（``window_s``，默认 200ms）统一 flush，只推最新；
    - ``sleep`` 可注入（FakeTime 测试，AGENTS.md §6/§7 禁硬等待）。
    """

    def __init__(
        self,
        callback: Callable[[str, Any], Any],
        window_s: float = DEFAULT_THROTTLE_WINDOW_S,
        *,
        sleep: Callable = asyncio.sleep,
    ) -> None:
        self._callback = callback
        self._window_s = window_s
        self._sleep = sleep
        self._pending: dict[str, Any] = {}
        self._flush_task: Optional[asyncio.Task] = None

    def push(self, key: str, payload: Any) -> None:
        """窗口内合并（同 key 覆盖为最新）。"""
        self._pending[key] = payload
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(
                self._delayed_flush(), name="analysis-throttle"
            )

    async def _delayed_flush(self) -> None:
        await self._sleep(self._window_s)
        await self.flush()

    async def flush(self) -> None:
        """立即推送窗口内所有最新条目（测试可直接调用）。"""
        items, self._pending = self._pending, {}
        for key, payload in items.items():
            try:
                await self._callback(key, payload)
            except Exception:  # noqa: BLE001 - 推送回调异常不影响其余
                logger.exception("节流推送回调异常 · 局面 %s", key)


# ============================================================
# T3.7 分析结果双槽缓存（链槽 + 深算槽，BUG-026）
# ============================================================


@dataclass
class _SessionEntry:
    """会话缓存条目（试下分支标准槽 / 深算槽）。"""

    data: dict
    max_visits: int
    updated_at: str


class AnalysisCache:
    """每局面分析结果合并缓存（双槽：链槽 + 深算槽，BUG-026）。

    - **链槽**：主谱键 ``main:{move_no}`` → 落库（``repos.upsert_position_analysis``
      合并规则）；试下键 ``trial:{trial_id}:{move_no}`` → 仅会话内存缓存
      （不落库，DATABASE §3.4）。链槽精度恒为链精度（``chain_precision``），
      是差量指标（点评/报告）唯一数据源；
    - **深算槽**：深算/支招结果仅会话内存**不落盘**（2026/09/12 人工确认）；
      键含 ``game_id`` 防跨对局串号；展示类读取优先深算槽、无则回退链槽；
    - 合并规则（各槽独立）：``max_visits`` 大者恒优先，同值更新时间新者替换。
    """

    def __init__(
        self,
        conn,
        config: AppConfig,
        *,
        max_session_entries: int = DEFAULT_MAX_SESSION_ENTRIES,
    ) -> None:
        self._conn = conn
        self._cfg = config
        #: 试下分支标准槽：position_key -> entry（data 为预处理后 dict）
        self._session: dict[str, _SessionEntry] = {}
        #: 深算槽：(game_id, position_key) -> entry（仅会话，不落库）
        self._deep: dict[tuple[int, str], _SessionEntry] = {}
        self._max_session_entries = max(1, max_session_entries)

    def is_trial_key(self, position_key: str) -> bool:
        """试下分支键（``trial:`` 前缀）。"""
        return position_key.startswith("trial:")

    async def store(
        self,
        game_id: int,
        position_key: str,
        result: dict,
        max_visits: int,
        *,
        updated_at: Optional[str] = None,
        kind: str = KIND_CHAIN,
        stale_check: Optional[Callable[[], bool]] = None,
    ) -> str:
        """合并写入：链槽（主谱落库/试下标准会话槽）/ 深算槽（仅会话）。

        返回动作 inserted/replaced/discarded/stale。``kind="deep"`` 恒不落盘
        （BUG-026 人工确认：深算结果仅在会话中有效，作为临时缓存）。

        ``stale_check``（M-5）：过期回调——
        - 会话槽（试下/深算）：写前同步求值（无 await 间隔，严格原子）；
        - 主谱落库：传入仓储在**写锁事务内**求值，写入后再次复核；仍过期则
          按本次写入指纹（ts + max_visits）条件删除，防陈旧链行“复活”。
        """
        ts = updated_at or _now_str()
        if kind == KIND_DEEP:
            if stale_check is not None and stale_check():
                return "stale"
            return self._merge_into(
                self._deep, (game_id, position_key), result, max_visits, ts
            )
        if self.is_trial_key(position_key):
            if stale_check is not None and stale_check():
                return "stale"
            return self._merge_into(self._session, position_key, result, max_visits, ts)
        action = await repos.upsert_position_analysis(
            self._conn,
            game_id=game_id,
            position_key=position_key,
            data_json=json.dumps(result, ensure_ascii=False),
            max_visits=max_visits,
            updated_at=ts,
            stale_check=stale_check,
        )
        if (
            action in ("inserted", "replaced")
            and stale_check is not None
            and stale_check()
        ):
            # M-5 第二层：事务内检查之后、提交完成之前版本再度变化（极小窗口）→
            # 补偿删除本轮写入指纹；已被更新写入替换（不同指纹）则不动。
            removed = await repos.delete_position_analysis_if_match(
                self._conn,
                game_id=game_id,
                position_key=position_key,
                updated_at=ts,
                max_visits=max_visits,
            )
            if removed:
                return "stale"
        return action

    def _merge_into(
        self, store: dict, key, result: dict, max_visits: int, ts: str
    ) -> str:
        """单槽合并写入（M-2 容量上限：超出按插入序淘汰最旧）。"""
        existing = store.get(key)
        if existing is None:
            # M-2：容量上限，超出时按插入序淘汰最旧条目（dict 保持插入序）
            if len(store) >= self._max_session_entries:
                store.pop(next(iter(store)))
            store[key] = _SessionEntry(result, max_visits, ts)
            return "inserted"
        if max_visits > existing.max_visits or (
            max_visits == existing.max_visits and ts >= existing.updated_at
        ):
            existing.data = result
            existing.max_visits = max_visits
            existing.updated_at = ts
            return "replaced"
        return "discarded"

    def get_session(self, position_key: str) -> Optional[dict]:
        """读试下分支**标准槽**结果（无则 None）。

        差量指标（试下点评）与复弈批量落盘仅用本槽——深算结果不得进入链。
        """
        entry = self._session.get(position_key)
        return entry.data if entry else None

    def get_deep(self, game_id: int, position_key: str) -> Optional[dict]:
        """读**深算槽**结果（无则 None）；展示类读取优先深算槽（BUG-026）。"""
        entry = self._deep.get((game_id, position_key))
        return entry.data if entry else None

    def list_trial(self, trial_id: int, up_to: Optional[int] = None) -> dict[int, dict]:
        """试下分支全部会话结果（相对手数 → data）；``up_to`` 截断。"""
        prefix = f"trial:{trial_id}:"
        result: dict[int, dict] = {}
        for key, entry in self._session.items():
            if key.startswith(prefix):
                move_no = int(key.rsplit(":", 1)[1])
                if up_to is None or move_no <= up_to:
                    result[move_no] = entry.data
        return result

    def list_trial_with_visits(self, trial_id: int) -> dict[int, tuple[dict, int]]:
        """试下分支会话结果（相对手数 → (data, max_visits)），复弈批量落盘用。"""
        prefix = f"trial:{trial_id}:"
        result: dict[int, tuple[dict, int]] = {}
        for key, entry in self._session.items():
            if key.startswith(prefix):
                move_no = int(key.rsplit(":", 1)[1])
                result[move_no] = (entry.data, entry.max_visits)
        return result

    def truncate_trial(self, trial_id: int, move_no: int) -> None:
        """试下撤销：截断当前手数之后的会话缓存（标准槽 + 深算槽）。"""
        prefix = f"trial:{trial_id}:"
        for key in list(self._session):
            if key.startswith(prefix) and int(key.rsplit(":", 1)[1]) > move_no:
                del self._session[key]
        for key in list(self._deep):
            pos_key = key[1]
            if pos_key.startswith(prefix) and int(pos_key.rsplit(":", 1)[1]) > move_no:
                del self._deep[key]

    def clear_trial(self, trial_id: int) -> None:
        """清空试下分支会话缓存（标准槽 + 深算槽；回实战/分支销毁）。"""
        prefix = f"trial:{trial_id}:"
        for key in list(self._session):
            if key.startswith(prefix):
                del self._session[key]
        for key in list(self._deep):
            if key[1].startswith(prefix):
                del self._deep[key]

    def truncate_main(self, game_id: int, move_no: int) -> None:
        """悔棋/重开：清理该对局主谱深算槽中超过 ``move_no`` 的条目。

        链槽（落库）由 repos 清理；深算槽为会话数据，须同步截断——否则被撤销
        局面的深算值仍会在展示读取中被优先命中（BUG-026）。
        """
        for key in list(self._deep):
            if key[0] != game_id or not key[1].startswith("main:"):
                continue
            try:
                n = int(key[1].split(":", 1)[1])
            except (ValueError, IndexError):
                continue
            if n > move_no:
                del self._deep[key]

    def clear_game(self, game_id: int) -> None:
        """对局删除：清理该对局深算槽全部条目（防跨对局串号与无界增长）。"""
        for key in [k for k in self._deep if k[0] == game_id]:
            self._deep.pop(key, None)


# ============================================================
# T3.6 分析调度器
# ============================================================


@dataclass
class AnalysisTask:
    """分析任务（队列项）。"""

    game_id: int
    position_key: str
    query: dict
    priority: int
    seq: int                     # 提交时对局局面版本号（过期判定，按 scope 分域）
    scope: str = "main"          # 版本域：main（主谱）/ trial（试下分支）
    #: 存储语义：chain（链槽：主谱落库/试下会话槽）/ deep（深算槽：仅会话不落盘）
    kind: str = KIND_CHAIN
    on_result: Optional[Callable] = None
    #: 丢弃回调（引擎不可用/查询失败 → ``cb(reason)``；结算预判等需失败降级提示）
    on_drop: Optional[Callable] = None
    extra: dict = field(default_factory=dict)


def scope_of(position_key: str) -> str:
    """局面键 → 版本域（``trial:{id}:{n}`` → trial；其余 → main）。

    版本号分域的意义：悔棋/重开/试下分支变化只应使**同域**的旧任务过期——
    主谱落子不再递增版本号（每手分析仍有效，BUG-012），试下分支变化也不会
    误杀排队中的主谱分析（两个域互不影响）。
    """
    return "trial" if position_key.startswith("trial:") else "main"


class AnalysisService:
    """分析调度器：优先级队列 + 并发上限 + 过期丢弃 + 节流推送 + 结果缓存。

    用法::

        svc = AnalysisService(conn, config, engine=manager)
        await svc.start()
        await svc.submit(game_id, "main:1", query, on_result=cb)
        ...
        await svc.stop()
    """

    def __init__(
        self,
        conn,
        config: AppConfig,
        engine=None,
        *,
        concurrency: int = 2,
        sleep: Callable = asyncio.sleep,
    ) -> None:
        self._conn = conn
        self._cfg = config
        self._engine = engine
        self._concurrency = max(1, concurrency)
        self._queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._versions: dict[tuple[int, str], int] = {}
        #: 在途任务登记（幂等合并，2026/09/12）：键 → [(on_result, on_drop), ...]
        #: 同局面 + 同存储槽 + 同精度 + 同版本 → 同一任务，订阅者扇出
        self._inflight: dict[tuple, list[tuple]] = {}
        self._counter = 0
        self._stopping = False
        self._worker_tasks: list[asyncio.Task] = []
        self._sleep = sleep
        self.cache = AnalysisCache(conn, config)
        self._on_result: Optional[Callable] = None

    def update_config(self, cfg: AppConfig) -> None:
        """运行期配置热更新（H-1）：刷新调度器/预处理使用的配置引用。"""
        self._cfg = cfg

    def set_engine(self, engine) -> None:
        """迟绑定引擎管理器（BUG-097）：文件缺失降级（engine=None）后管理端重建装配。

        绑定后 ``engine_available`` 翻转，worker 对新生效任务恢复正常提交。
        """
        self._engine = engine

    # ---- 生命周期 ----

    async def start(self) -> None:
        """启动 worker 池（``concurrency`` 个并发处理任务）。"""
        if self._worker_tasks:
            return
        self._worker_tasks = [
            asyncio.create_task(self._worker(), name=f"analysis-worker-{i}")
            for i in range(self._concurrency)
        ]

    async def stop(self) -> None:
        """停止 worker 池；遗弃的任务回投终态。

        L-1/L-12（2026/09/19 决策）：① 子任务收尾用 ``gather(return_exceptions=True)``——
        旧实现 ``except (CancelledError, Exception)`` 会把**调用方自身被取消**吞掉；
        ② 队列中未处理任务不再执行，按“丢弃=终态”契约回投 ``on_drop("shutdown")``
        （否则结算预判/复盘 Future 在关停窗口悬挂），随后清空在途登记。
        """
        self._stopping = True
        while True:
            try:
                _, _, _, task = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._queue.task_done()
            await self._notify_drop(task, "shutdown")
        tasks = list(self._worker_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._worker_tasks = []
        self._inflight.clear()

    # ---- 局面版本号（过期判定） ----

    def bump_version(self, game_id: int, scope: str = "main") -> int:
        """局面结构变化后递增**对应域**版本号 → 该域旧任务过期。

        调用时机（2026/09/10 修订，BUG-012）：
        - ``main``：悔棋（局面回退）/重开——被撤销的局面不再有效；
          **普通落子不递增**（之前每手递增会把排队中的每手分析全部误杀）；
        - ``trial``：试下分支落子/撤销（会话分支内容变化）。
        """
        key = (game_id, scope)
        ver = self._versions.get(key, 0) + 1
        self._versions[key] = ver
        return ver

    def current_version(self, game_id: int, scope: str = "main") -> int:
        return self._versions.get((game_id, scope), 0)

    def remove_game(self, game_id: int) -> None:
        """对局删除后回收版本号条目与深算会话缓存（M-2：防无界增长）。"""
        for key in [k for k in self._versions if k[0] == game_id]:
            self._versions.pop(key, None)
        self.cache.clear_game(game_id)
        # 在途登记同样回收（对局已删：后续完成/丢弃时回退到任务自身回调）
        for key in [k for k in self._inflight if k[0] == game_id]:
            self._inflight.pop(key, None)

    def _is_expired(self, task: AnalysisTask) -> bool:
        """过期判定：任务所属版本域的版本号变化 → 旧任务丢弃（不写库、不推送）。"""
        return self.current_version(task.game_id, task.scope) != task.seq

    async def _game_removed(self, game_id: int) -> bool:
        """对局是否已删除（删除时在途任务的结果无属主：回包即丢弃）。

        防级联落库失败（position_analyses 外键指向 games）：删除对局后回包的
        结果统一在此丢弃，不再进入 ingest（2026/09/13）。
        """
        return await repos.get_game(self._conn, game_id) is None

    # ---- 提交与处理 ----

    @staticmethod
    def _inflight_key(
        game_id: int, position_key: str, kind: str, max_visits: int, seq: int
    ) -> tuple:
        """在途合并键：同局面 + **同存储槽**（chain/deep，BUG-026 双槽语义）+
        同链内精度（maxVisits）+ 同局面版本（``seq``，悔棋/重开/试下变化后不合并）。"""
        return (game_id, position_key, kind, max_visits, seq)

    def _take_waiters(self, task: AnalysisTask) -> list[tuple]:
        """取出该任务的全部在途订阅者（恰好一次）；登记被回收（如对局删除）
        时回退为任务自身回调，保证创建者总能收到终态。"""
        key = self._inflight_key(
            task.game_id,
            task.position_key,
            task.kind,
            int(task.query.get("maxVisits") or 0),
            task.seq,
        )
        waiters = self._inflight.pop(key, None)
        if waiters is None:
            return [(task.on_result, task.on_drop)]
        return waiters

    async def _fan_out_result(self, task: AnalysisTask, preprocessed: dict) -> None:
        """结果到达 → 向全部订阅者扇出（单订阅者异常不阻断其余）。"""
        for on_result, _on_drop in self._take_waiters(task):
            if on_result is None:
                continue
            try:
                ret = on_result(task.position_key, preprocessed)
                if inspect.isawaitable(ret):
                    await ret
            except Exception:  # noqa: BLE001 - 订阅者异常不得阻断其余回调
                logger.exception(
                    "分析结果回调异常 · 对局 #%s · 局面 %s",
                    task.game_id, task.position_key,
                )

    async def submit(
        self,
        game_id: int,
        position_key: str,
        query: dict,
        *,
        on_result: Optional[Callable] = None,
        on_drop: Optional[Callable] = None,
        extra: Optional[dict] = None,
        kind: str = KIND_CHAIN,
    ) -> None:
        """提交分析任务（按查询 priority 出队；seq 快照当前域版本号）。

        - ``kind``：结果存储语义——``chain``（链槽：主谱落库/试下会话槽）/
          ``deep``（深算槽：仅会话不落盘，BUG-026）；
        - ``on_drop(reason)``：引擎不可用/查询失败导致结果永不回投时的通知
          （结算预判等需要失败降级提示的调用方使用；普通每手分析不需）；
        - **在途合并（幂等，2026/09/12 契约根治）**：同局面 + 同 kind + 同 maxVisits +
          同版本的任务已在队列/执行中 → 只登记订阅者不重排查询（逐手链分析与
          领地补分析常命中同一局面；多端请求同一局面也只消耗一次引擎）。
        """
        priority = int(query.get("priority") or 0)
        scope = scope_of(position_key)
        seq = self.current_version(game_id, scope)
        max_visits = int(query.get("maxVisits") or 0)
        inflight_key = self._inflight_key(game_id, position_key, kind, max_visits, seq)
        waiters = self._inflight.get(inflight_key)
        if waiters is not None:
            waiters.append((on_result, on_drop))
            return
        task = AnalysisTask(
            game_id=game_id,
            position_key=position_key,
            query=query,
            priority=priority,
            seq=seq,
            scope=scope,
            kind=kind,
            on_result=on_result,
            on_drop=on_drop,
            extra=extra or {},
        )
        self._inflight[inflight_key] = [(on_result, on_drop)]
        # 优先级高者先（-priority）；同优先级先提交者先（counter 递增保证唯一序）
        self._counter += 1
        await self._queue.put((-priority, task.seq, self._counter, task))

    def set_on_result(self, callback: Optional[Callable]) -> None:
        """注册全局结果回调（节流推送：``cb(game_id, position_key, preprocessed)``）。

        - WS 层经此订阅 ``analysis.curve`` 推送（``GameAnalysisPusher``）；
        - 回调含 ``game_id`` 供多对局并发路由（ARCHITECTURE §4.2）。
        """
        self._on_result = callback

    @property
    def engine_available(self) -> bool:
        """引擎是否接入（引擎缺失 → 分析类功能降级，调用方可提前快速失败）。"""
        return self._engine is not None

    async def _notify_drop(self, task: AnalysisTask, reason: str) -> None:
        """任务被丢弃（结果不会回投）→ 向全部在途订阅者扇出 ``on_drop``。

        2026/09/12 终态契约：丢弃也是终态——调用方（领地/预判/推荐）据此回投
        空载荷/降级提示，避免前端无界等待。单订阅者异常不得杀死 worker。"""
        for _on_result, on_drop in self._take_waiters(task):
            if on_drop is None:
                continue
            try:
                ret = on_drop(reason)
                if inspect.isawaitable(ret):
                    await ret
            except Exception:  # noqa: BLE001 - 丢弃回调异常不得杀死 worker
                logger.exception("分析丢弃回调异常 · 对局 #%s · 局面 %s", task.game_id, task.position_key)

    async def _worker(self) -> None:
        while not self._stopping:
            try:
                _, _, _, task = await self._queue.get()
            except asyncio.CancelledError:
                break
            try:
                if self._stopping:
                    continue
                if self._is_expired(task) or await self._game_removed(task.game_id):
                    # 局面已变化（悔棋/重开/试下变更）或**对局已删除** → 任务失效：
                    # 必须**通知**（调用方据此复位状态；旧实现在此静默丢弃，导致
                    # 结算预判等调用方永久停在等待态，2026/09/11 修复）；对局删除后
                    # 结果无属主，落库会级联失败（外键），同样在此统一丢弃
                    await self._notify_drop(task, "expired")
                    continue
                if self._engine is None:
                    await self._notify_drop(task, "engine_unavailable")
                    continue
                try:
                    response = await self._engine.submit(task.query)
                except AppError as exc:
                    # 引擎不可用（INIT/DEAD/FATAL）→ 降级丢弃（分析类功能降级提示）
                    logger.debug(
                        "分析任务丢弃（引擎不可用）· 对局 #%s · 局面 %s：%s",
                        task.game_id, task.position_key, exc.message,
                    )
                    await self._notify_drop(task, "engine_unavailable")
                    continue
                except Exception:  # noqa: BLE001 - 单次查询异常不得杀死 worker
                    logger.exception("分析查询失败 · 对局 #%s · 局面 %s", task.game_id, task.position_key)
                    await self._notify_drop(task, "engine_error")
                    continue
                if self._is_expired(task) or await self._game_removed(task.game_id):
                    # 结果到达时局面已变（如结算中悔棋）或对局已删除 → 同样通知失败
                    await self._notify_drop(task, "expired")
                    continue
                try:
                    await self._handle_result(task, response)
                except Exception:  # noqa: BLE001 - 单任务失败不得杀死 worker
                    # H-4 修复（2026-09-19 代码审查）：结果处理失败同样必须回投终态——
                    # 旧实现只记日志，不扇出结果也不通知丢弃：等待者（结算预判/复盘
                    # Future）永久悬挂，且 `_inflight` 订阅登记泄漏。
                    logger.exception("分析结果处理失败 · 对局 #%s · 局面 %s", task.game_id, task.position_key)
                    await self._notify_drop(task, "engine_error")
            except asyncio.CancelledError:
                # L-12：worker 在处理/等待中被取消（关停窗口）——等待者同样必须收到终态
                # （覆盖范围：引擎 await 中/落库中任一阶段；内层不再单独通知，防二次回调）
                await self._notify_drop(task, "shutdown")
                raise
            finally:
                self._queue.task_done()

    async def _handle_result(self, task: AnalysisTask, response: dict) -> None:
        """结果处理：预处理 → 合并缓存 → 全局推送（供对弈 P0 单查询合并复用）。"""
        preprocessed = preprocess_analysis_response(
            response,
            max_moves=self._cfg.play.max_moves,
            analysis_pv_len=self._cfg.engine.analysis_pv_len,
            board_size=int(task.query.get("boardXSize") or 0) or None,
        )
        max_visits = int(task.query.get("maxVisits") or 0)
        await self.ingest_result(
            task.game_id,
            task.position_key,
            preprocessed,
            max_visits,
            kind=task.kind,
            # M-5：写锁事务内复核版本号——结果到达检查与落库之间的悔棋/重开会
            # 递增版本域，命中即不写入（防陈旧链行复活）
            stale_check=lambda: self._is_expired(task),
        )
        # 结果扇出：任务自身 + 在途合并的全部订阅者（恰好一次）
        await self._fan_out_result(task, preprocessed)

    async def ingest_result(
        self,
        game_id: int,
        position_key: str,
        preprocessed: dict,
        max_visits: int,
        *,
        kind: str = KIND_CHAIN,
        stale_check: Optional[Callable[[], bool]] = None,
    ) -> str:
        """结果合并写入 + 全局推送回调（``analysis.curve`` 节流推送）。

        供调度器 worker（``_handle_result``）、**对弈 P0 单查询合并**（T6.1/修订：
        对弈查询精度与链精度相等时结果作为链行落库/推曲线）与**结算预判**（终局
        局面落库补齐，人工确认）复用——避免重复实现缓存合并与推送语义；
        返回动作 ``inserted/replaced/discarded/stale``。

        ``kind="deep"`` → 仅入会话深算槽（不落盘，BUG-026）；推送仍照常
        （展示类实时更新，刷新后回到链槽数据）。
        ``stale_check``（M-5）：过期回调，透传缓存层——写前（事务内）与写后
        复核（详见 ``AnalysisCache.store``）。
        """
        action = await self.cache.store(
            game_id,
            position_key,
            preprocessed,
            max_visits,
            kind=kind,
            stale_check=stale_check,
        )
        logger.debug(
            "分析结果入缓存 · 对局 #%s · 局面 %s（maxVisits=%d，动作=%s）",
            game_id, position_key, max_visits, _ACTION_TEXT.get(action, action),
        )
        if self._on_result is not None:
            await self._on_result(game_id, position_key, preprocessed)
        return action
