"""T2.1 引擎 FSM 测试：状态转移、越权保护、ANALYZING 计数、崩溃时间窗。

用例 ID: ENG-*
"""

import pytest

from app.core.fsm import EngineFsm, EngineFsmError, EngineState


def _started_fsm(**kwargs) -> EngineFsm:
    """已进入启动尝试的 FSM（STOPPED→INIT），供就绪/崩溃路径用例使用。"""
    fsm = EngineFsm(**kwargs)
    fsm.mark_started()
    return fsm


class TestInitialState:
    def test_initial_is_stopped(self):
        """初始态＝STOPPED（未启动：进程未运行）；与 INIT（启动中）严格分界。"""
        assert EngineFsm().state == EngineState.STOPPED

    def test_ready_from_stopped_rejected(self):
        """未启动不得直接就绪（必须 mark_started 进入 INIT 后握手）。"""
        with pytest.raises(EngineFsmError):
            EngineFsm().mark_ready()

    def test_mark_stopped_from_idle(self):
        """干净停止（IDLE→STOPPED）；未运行态回落供 [启动]/按需拉起重入。"""
        fsm = _started_fsm()
        fsm.mark_ready()
        fsm.mark_stopped()
        assert fsm.state == EngineState.STOPPED


class TestRequireGuard:
    """越权保护：非法状态下写指令/查询抛状态机异常（AGENTS.md §3）。"""

    def test_begin_query_in_stopped_rejected(self):
        fsm = EngineFsm()
        with pytest.raises(EngineFsmError):
            fsm.begin_query()

    def test_begin_query_in_dead_rejected(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        fsm.mark_crashed(now=0.0)
        assert fsm.state == EngineState.DEAD
        with pytest.raises(EngineFsmError):
            fsm.begin_query()

    def test_begin_query_in_fatal_rejected(self):
        fsm = _started_fsm(max_crashes=2)
        fsm.mark_ready()
        fsm.mark_crashed(now=1.0)
        fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=2.0)
        assert fsm.state == EngineState.FATAL
        with pytest.raises(EngineFsmError):
            fsm.begin_query()

    def test_mark_crashed_in_init_goes_dead(self):
        """启动失败（INIT）同样计入崩溃路径 → DEAD。"""
        fsm = _started_fsm()
        fsm.mark_crashed(now=0.0)
        assert fsm.state == EngineState.DEAD

    def test_mark_crashed_in_stopped_rejected(self):
        """未启动（无进程）不得标记崩溃——崩溃回调仅发生在进程存活期。"""
        with pytest.raises(EngineFsmError):
            EngineFsm().mark_crashed(now=0.0)


class TestReadyTransition:
    def test_init_to_idle(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        assert fsm.state == EngineState.IDLE

    def test_mark_ready_twice_rejected(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        with pytest.raises(EngineFsmError):
            fsm.mark_ready()


class TestAnalyzingCounter:
    """ANALYZING↔IDLE 以进行中查询计数为准。"""

    def test_begin_moves_to_analyzing(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        fsm.begin_query()
        assert fsm.state == EngineState.ANALYZING
        assert fsm.active_queries == 1

    def test_concurrent_queries_count(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        fsm.begin_query()
        fsm.begin_query()
        assert fsm.state == EngineState.ANALYZING
        assert fsm.active_queries == 2

    def test_end_returns_to_idle_on_zero(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        fsm.begin_query()
        fsm.end_query()
        assert fsm.state == EngineState.IDLE
        assert fsm.active_queries == 0

    def test_partial_end_keeps_analyzing(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        fsm.begin_query()
        fsm.begin_query()
        fsm.end_query()
        assert fsm.state == EngineState.ANALYZING
        assert fsm.active_queries == 1
        fsm.end_query()
        assert fsm.state == EngineState.IDLE

    def test_end_query_in_idle_rejected(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        with pytest.raises(EngineFsmError):
            fsm.end_query()


class TestCrashWindow:
    """DEAD→FATAL：5 分钟滑动时间窗累计崩溃次数（Mock 时间，禁瞬时值）。"""

    def test_crash_to_dead(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        fsm.mark_crashed(now=100.0)
        assert fsm.state == EngineState.DEAD

    def test_analyzing_crash_to_dead_resets_queries(self):
        fsm = _started_fsm()
        fsm.mark_ready()
        fsm.begin_query()
        fsm.mark_crashed(now=100.0)
        assert fsm.state == EngineState.DEAD
        assert fsm.active_queries == 0

    def test_three_crashes_in_window_fatal(self):
        fsm = _started_fsm(max_crashes=3, crash_window_s=300.0)
        for t in (0.0, 100.0):
            fsm.mark_ready()
            fsm.mark_crashed(now=t)
            fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=200.0)  # 窗口内第 3 次 → FATAL
        assert fsm.state == EngineState.FATAL

    def test_crashes_across_restarts_accumulate(self):
        """快速连续崩溃（窗口内）跨重启累计直至 FATAL。"""
        fsm = _started_fsm(max_crashes=3, crash_window_s=300.0)
        fsm.mark_ready()
        fsm.mark_crashed(now=1.0)
        fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=2.0)
        fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=3.0)
        assert fsm.state == EngineState.FATAL

    def test_crash_outside_window_not_fatal(self):
        """时间窗外旧崩溃不参与计数（时间窗口累计，禁止瞬时值判定）。"""
        fsm = _started_fsm(max_crashes=3, crash_window_s=300.0)
        # t=0 崩溃一次；t=400 已超出 300s 窗口
        fsm.mark_ready()
        fsm.mark_crashed(now=0.0)
        fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=400.0)
        assert fsm.state == EngineState.DEAD  # 窗口内仅 1 次，未 FATAL

    def test_stable_beyond_window_not_fatal(self):
        """稳定运行超过时间窗后崩溃不触发 FATAL（旧崩溃被窗口自然淘汰）。"""
        fsm = _started_fsm(max_crashes=2, crash_window_s=300.0)
        fsm.mark_ready()
        fsm.mark_crashed(now=0.0)
        fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=400.0)  # 0 已超出窗口 → 窗口内仅 1 次
        assert fsm.state == EngineState.DEAD

    def test_idempotent_crash_in_dead(self):
        """已 DEAD 时不重复计数。"""
        fsm = _started_fsm(max_crashes=2)
        fsm.mark_ready()
        fsm.mark_crashed(now=0.0)
        fsm.mark_crashed(now=10.0)  # 重复回调应被忽略
        assert fsm.state == EngineState.DEAD


class TestFatalManualRestart:
    def test_started_from_fatal_allowed(self):
        """FATAL 仅允许显式 mark_started（管理员手动重启）脱离。"""
        fsm = _started_fsm(max_crashes=1)
        fsm.mark_ready()
        fsm.mark_crashed(now=0.0)
        assert fsm.state == EngineState.FATAL
        fsm.mark_started()
        assert fsm.state == EngineState.INIT
        fsm.mark_ready()
        assert fsm.state == EngineState.IDLE


def test_is_available():
    fsm = EngineFsm()
    assert not fsm.is_available  # STOPPED（未启动）
    fsm.mark_started()
    assert not fsm.is_available  # INIT（加载中）
    fsm.mark_ready()
    assert fsm.is_available  # IDLE
    fsm.begin_query()
    assert fsm.is_available  # ANALYZING
    fsm.mark_crashed(now=0.0)
    assert not fsm.is_available  # DEAD
