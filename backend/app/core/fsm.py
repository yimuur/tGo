"""引擎生命周期 FSM（ARCHITECTURE §3.1，AGENTS.md §3）。

状态集合: ``STOPPED / INIT / IDLE / ANALYZING / DEAD / FATAL``：

- `STOPPED`＝**未启动**（进程未运行：从未启动 / 干净停止），为初始态，只能由启动
  尝试（``mark_started``）进入 INIT；与 INIT 严格分界（2026/09/18，PROMPTS [语义混用]）：
  ``INIT``＝**启动中**（进程已在拉起/加载权重/首次调优）；
- `ANALYZING` 以**进行中查询计数**为准——首个查询 IDLE→ANALYZING，计数归零才回 IDLE
  （支撑并发查询由引擎内部线程调度）；
- `DEAD→FATAL` 采用 **5 分钟滑动时间窗累计崩溃次数**判定（默认 3 次），禁止瞬时值判定；
- 所有写入口（查询/就绪/崩溃）先 ``require(...)`` 越权保护，非法状态操作抛 ``EngineFsmError``。

FATAL 为终态：仅允许显式 ``mark_started``（管理员手动重启）脱离。
"""

from __future__ import annotations

from collections import deque
from enum import Enum


class EngineState(str, Enum):
    """引擎状态。

    ``STOPPED``（未启动，进程未运行）/ ``INIT``（启动中）的语义拆分见
    ``EngineFsm.mark_stopped`` 与 ``mark_started``（2026/09/18）。
    """

    STOPPED = "STOPPED"
    INIT = "INIT"
    IDLE = "IDLE"
    ANALYZING = "ANALYZING"
    DEAD = "DEAD"
    FATAL = "FATAL"


class EngineFsmError(RuntimeError):
    """状态机非法操作/非法转移。"""

    def __init__(
        self,
        action: str,
        state: EngineState,
        allowed: tuple[EngineState, ...],
    ) -> None:
        self.action = action
        self.state = state
        self.allowed = allowed
        allowed_txt = ", ".join(s.value for s in allowed) if allowed else "无"
        super().__init__(
            f"引擎状态非法: 操作 {action} 不允许在 {state.value} (允许: {allowed_txt})"
        )


# ---- 状态集合：**唯一权威定义**（2026/09/20 硬化，ISSUE-069）----
#
# 动机（BUG-119）："进程是否在跑"与"处于哪个状态"曾由各调用点各自解释
# （`ensure_ready` 只看 `is_running`、`submit` 另判 INIT、前端 `engineOps` 又维护一份
# 状态表）——同一事实多个解释即本次事故的根因类别。现集中于此，所有调用点（含前端
# 镜像 `frontend/static/js/core/state.js`，由 `FE-CTR-34` 契约测试锁定一致）从此派生。
#: 运行态（进程在跑）：拉起/加载/调优中、就绪、分析中——**与 `is_running` 合取**才是
#: 「引擎已在运行」（`is_running` 为真但状态不在此列 ＝ 陈旧进程引用，BUG-119）。
RUNNING_STATES: tuple[EngineState, ...] = (
    EngineState.INIT,
    EngineState.IDLE,
    EngineState.ANALYZING,
)
#: 可接收查询的状态（就绪/分析中；INIT 仍在加载，一律 `ENGINE_BUSY`）。
QUERY_STATES: tuple[EngineState, ...] = (EngineState.IDLE, EngineState.ANALYZING)
#: 可按需拉起的空闲态：未启动（从未启动/干净停止）与启动尝试窗口（幂等补发）。
LAUNCHABLE_STATES: tuple[EngineState, ...] = (EngineState.STOPPED, EngineState.INIT)


def engine_healthy_running(*, is_running: bool, state: EngineState) -> bool:
    """引擎已在健康运行（进程在且状态属运行态）——作为「无需重新拉起」的**唯一判据**。

    幂等守卫（`ensure_ready`）用此判定：真 → 空操作；假 → 交由 `_launch`（先停旧再启新）。
    """
    return is_running and state in RUNNING_STATES


def engine_stale_process(*, is_running: bool, state: EngineState) -> bool:
    """进程引用仍在但状态非运行态 ＝ 陈旧引用（崩溃/启动中断残留，BUG-119）。

    此类引用必须被清场重启（不得当作「已在运行」而空操作）；仅在拉起前记告警便于排查。
    """
    return is_running and state not in RUNNING_STATES


def engine_launchable(*, is_running: bool, state: EngineState) -> bool:
    """可按需拉起（未启动 / 启动尝试窗口 且 进程不在）。

    **恢复所有者**（ISSUES-069）：`DEAD` 只允许指数退避链重新拉起、`FATAL` 只允许
    管理端显式 `reset_fatal=True`（手动重启）；两者均不得经按需/自动拉起路径进入。
    """
    return not is_running and state in LAUNCHABLE_STATES


class EngineFsm:
    """引擎生命周期状态机。"""

    def __init__(
        self,
        *,
        crash_window_s: float = 300.0,
        max_crashes: int = 3,
    ) -> None:
        self._state: EngineState = EngineState.STOPPED
        self._active_queries: int = 0
        self._crash_window_s = crash_window_s
        self._max_crashes = max_crashes
        self._crash_times: deque[float] = deque()

    # ---- 查询 ----

    @property
    def state(self) -> EngineState:
        return self._state

    @property
    def active_queries(self) -> int:
        """进行中查询计数（ANALYZING 语义依据）。"""
        return self._active_queries

    def require(self, *allowed: EngineState, action: str = "操作") -> None:
        """越权保护：当前状态不在允许集合内即抛错。"""
        if self._state not in allowed:
            raise EngineFsmError(action, self._state, allowed)

    # ---- 转移 ----

    def mark_started(self) -> None:
        """开始启动尝试（拉起子进程）：任意状态（含 FATAL 手动重启、STOPPED 首次启动）→ INIT。"""
        self._state = EngineState.INIT

    def mark_stopped(self) -> None:
        """进程已确认停止（手动停止/空闲释放/服务关闭/重建失败回落）→ STOPPED（未启动）。

        与 INIT 的语义分界（2026/09/18，PROMPTS [语义混用]）：STOPPED＝进程未运行
        （从未启动或干净停止，可按需重新拉起）；INIT＝启动尝试进行中（拉起/加载/调优）。
        仅由管理器在 ``await engine.stop()`` 完成后调用，禁止在进程存活时调用。
        """
        self._state = EngineState.STOPPED

    def mark_ready(self) -> None:
        """就绪（INIT→IDLE）。

        崩溃窗口保持累计，由**滑动时间窗**自然过期（稳定运行超过窗口后旧崩溃自动失效），
        确保 5 分钟内的快速连续崩溃跨重启累计直至 FATAL。
        """
        self.require(EngineState.INIT, action="mark_ready")
        self._state = EngineState.IDLE

    def begin_query(self) -> None:
        """提交查询：IDLE→ANALYZING（计数+1）；已在 ANALYZING 仅计数+1。"""
        self.require(EngineState.IDLE, EngineState.ANALYZING, action="begin_query")
        self._active_queries += 1
        if self._state is EngineState.IDLE:
            self._state = EngineState.ANALYZING

    def end_query(self) -> None:
        """查询完成：计数-1；归零回 IDLE。"""
        self.require(EngineState.ANALYZING, action="end_query")
        if self._active_queries <= 0:
            raise EngineFsmError("end_query", self._state, (EngineState.ANALYZING,))
        self._active_queries -= 1
        if self._active_queries == 0:
            self._state = EngineState.IDLE

    def mark_crashed(self, now: float) -> None:
        """进程崩溃/启动失败：INIT/IDLE/ANALYZING→DEAD；时间窗内连续崩溃超限→FATAL。

        - 启动失败（INIT）同样计入崩溃窗口（指数退避重启策略）；
        - 采用滑动时间窗累计（``crash_window_s`` 秒内累计 ``max_crashes`` 次）；
        - 已处于 DEAD/FATAL 时不重复计数。
        """
        if self._state in (EngineState.DEAD, EngineState.FATAL):
            return
        self.require(
            EngineState.INIT, EngineState.IDLE, EngineState.ANALYZING, action="mark_crashed"
        )
        self._active_queries = 0
        # 滑动窗口：剔除窗口外的旧崩溃
        while self._crash_times and self._crash_times[0] < now - self._crash_window_s:
            self._crash_times.popleft()
        self._crash_times.append(now)
        if len(self._crash_times) >= self._max_crashes:
            self._state = EngineState.FATAL
        else:
            self._state = EngineState.DEAD

    # ---- 便捷判断 ----

    @property
    def is_available(self) -> bool:
        """可接收查询：IDLE 或 ANALYZING。"""
        return self._state in (EngineState.IDLE, EngineState.ANALYZING)

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return f"<EngineFsm state={self._state.value} active_queries={self._active_queries}>"
