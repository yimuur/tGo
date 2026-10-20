"""T2.3 引擎管理器测试：按需加载/常驻、崩溃退避、安全重启、空闲超时、benchmark 进度。

全部使用 FakeEngine（严禁真实 KataGo/GPU）；时间经 fake_time 虚拟时钟（AGENTS.md §7）。
用例 ID: MGR-*
"""

import asyncio
import logging
from pathlib import Path

import pytest

from app.config import ConfigError, EngineConfig
from app.core.errors import AppError, ErrorCode
from app.core.fsm import EngineFsm, EngineState
from app.engine.analysis_engine import EngineStartError, EngineStoppedError
from app.engine.manager import EngineManager, LaunchOutcome, build_engine, check_engine_assembly


class FakeEngine:
    """记录调用并模拟引擎行为的最小 Mock。"""

    def __init__(self, fsm: EngineFsm):
        self.fsm = fsm
        self.is_running = False
        #: 是否处于主动停止流程（真实 AnalysisEngine 同语义：stop() 置位、start() 复位）
        self.is_stopping = False
        self.benchmarking = False
        self.has_human_model = True
        self.start_calls = 0
        self.stop_calls = 0
        self.queries: list[dict] = []
        self.on_stderr_line = None
        self.on_crash = None
        self.on_query_state_change = None
        self.query_error: Exception | None = None
        #: 启动异常注入（BUG-097 启动失败归因测试）
        self.start_error: Exception | None = None

    def set_callbacks(self, *, on_stderr_line=None, on_crash=None, on_query_state_change=None):
        self.on_stderr_line = on_stderr_line
        self.on_crash = on_crash
        self.on_query_state_change = on_query_state_change

    async def start(self):
        self.start_calls += 1
        self.fsm.mark_started()  # 真实引擎启动即进入 INIT（握手中）
        self.is_stopping = False
        if self.start_error is not None:
            raise self.start_error
        self.is_running = True
        self.fsm.mark_ready()

    async def stop(self):
        self.stop_calls += 1
        self.is_stopping = True
        self.is_running = False

    async def query(self, data, timeout_s=None):
        self.queries.append(data)
        if self.query_error is not None:
            raise self.query_error
        return {"id": data.get("id"), "ok": True}


async def _make_manager(fake_time, activity_fn=None, **cfg_kw):
    fsm = EngineFsm()
    engine = FakeEngine(fsm)
    cfg = EngineConfig(**cfg_kw)
    manager = EngineManager(
        cfg,
        engine,
        monotonic=lambda: fake_time.now,
        sleep=fake_time.sleep,
        backoff_base_s=1.0,
        max_backoff_s=60.0,
        activity_fn=activity_fn,
    )
    return manager, engine, fsm


async def _yield_twice():
    await asyncio.sleep(0)
    await asyncio.sleep(0)


async def _yield_many(n: int = 10):
    """多次让出事件循环（确定性推进后台任务，替代时间依赖）。"""
    for _ in range(n):
        await asyncio.sleep(0)


class TestOnDemandLoading:
    async def test_ensure_ready_starts_engine(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time, resident=False)
        await manager.ensure_ready()
        assert engine.start_calls == 1
        assert fsm.state == EngineState.IDLE
        assert engine.is_running

    async def test_ensure_ready_idempotent(self, fake_time):
        manager, engine, _ = await _make_manager(fake_time)
        await manager.ensure_ready()
        await manager.ensure_ready()
        assert engine.start_calls == 1

    async def test_launch_broadcasts_init_then_idle(self, fake_time):
        """BUG-101：冷启动（STOPPED）须广播 INIT（「加载中」）→ 就绪 IDLE 的完整链路。

        旧实现靠「初始态＝INIT」偶然呈现加载态，STOPPED 语义拆分后不再成立——
        启动尝试开始须显式广播 INIT，否则前端错失「未启动→加载中→就绪」中间态。
        """
        manager, engine, _ = await _make_manager(fake_time)
        events: list = []
        manager.on_state_change(lambda s, p: events.append(s))
        await manager.ensure_ready()
        assert events and events[0] is EngineState.INIT, "启动尝试开始须广播 INIT"
        assert events[-1] is EngineState.IDLE
        await manager.stop()

    async def test_admin_start_while_running_is_noop(self, fake_time):
        """管理端「启动」幂等：引擎已就绪（IDLE + 进程在）时 `reset_fatal=True` 也为空操作。

        旧实现：reset_fatal 绕过全部「已在运行」守卫 → `_launch` 重复拉起第二个 KataGo
        进程（旧进程引用被覆盖成孤儿：GPU 显存/进程泄漏）。前端 F5 重试与管理页误点
        都会走到此路径（BUG-080 支撑修复）。
        """
        manager, engine, fsm = await _make_manager(fake_time, resident=False)
        await manager.ensure_ready()
        assert engine.is_running and fsm.state == EngineState.IDLE
        await manager.ensure_ready(reset_fatal=True)
        assert engine.start_calls == 1, "引擎已在运行时重复启动请求不得重复拉起"
        await manager.stop()

    async def test_admin_start_while_initializing_is_noop(self, fake_time):
        """加载/握手中的重复启动请求必须空操作（并发两次 `POST /engines/start`）。"""
        manager, engine, fsm = await _make_manager(fake_time, resident=False)
        entered = asyncio.Event()
        gate = asyncio.Event()
        orig_start = engine.start

        async def gated_start():
            fsm.mark_started()  # 启动尝试开始（真实引擎 start 首行即 mark_started）
            engine.is_running = True  # 子进程已创建（真实：create_subprocess_exec 返回即 True）
            entered.set()
            await gate.wait()
            await orig_start()

        engine.start = gated_start
        first = asyncio.create_task(manager.ensure_ready(reset_fatal=True))
        await entered.wait()  # 第一次启动进行中（INIT + 进程在）
        assert fsm.state == EngineState.INIT
        retry = asyncio.create_task(manager.ensure_ready(reset_fatal=True))
        await asyncio.sleep(0)  # 重试请求在启动锁上等待，不得并发再起进程
        gate.set()
        await asyncio.gather(first, retry)
        assert engine.start_calls == 1, "加载中的重复启动请求不得重复拉起引擎"
        assert fsm.state == EngineState.IDLE
        await manager.stop()

    async def test_shutdown_during_launch_stops_engine(self, fake_time):
        """MGR-33 关闭与启动交错：启动完成时管理器已停止 → 立即回收，不得留孤儿进程。"""
        manager, engine, fsm = await _make_manager(fake_time)
        entered = asyncio.Event()
        gate = asyncio.Event()
        orig_start = engine.start

        async def gated_start():
            entered.set()
            await gate.wait()
            await orig_start()

        engine.start = gated_start
        launch = asyncio.create_task(manager.ensure_ready())
        await entered.wait()
        await manager.stop()  # lifespan shutdown 路径（与启动交错）
        gate.set()
        result = await asyncio.gather(launch, return_exceptions=True)
        assert not engine.is_running, "关闭窗口内完成的启动必须被立即回收"
        assert fsm.state == EngineState.STOPPED  # 回收后未运行态＝STOPPED（未启动）
        assert isinstance(result[0], AppError), "启动方须获知已停止（不得静默或裸异常）"

    async def test_launch_stopped_error_maps_to_app_error(self, fake_time):
        """MGR-35 启动期间被停止（锁内清场）→ AppError(ENGINE_DEAD)；主动停止不得计崩溃/排退避。

        分诊依据为事实而非错误文案（BUG-119）：真实 ``stop()`` 先置 ``is_stopping`` 再
        ``_fail_all_pending``（含就绪握手 future），故“握手以 EngineStoppedError 结束且
        is_stopping 为真”＝主动停止；“is_stopping 为假”＝启动期崩溃（另见 MGR-65/66）。
        """
        manager, engine, fsm = await _make_manager(fake_time)

        async def stopped_start():
            engine.is_stopping = True  # 并发 stop() 已进入停止流程（失败握手 future 的前置条件）
            raise EngineStoppedError("引擎已停止")

        engine.start = stopped_start
        with pytest.raises(AppError) as ei:
            await manager.ensure_ready()
        assert ei.value.code is ErrorCode.ENGINE_DEAD
        assert fsm.state == EngineState.STOPPED  # 主动停止：未启动态，不得计崩溃
        assert manager._restart_task is None

    async def test_resident_starts_on_manager_start(self, fake_time):
        manager, engine, _ = await _make_manager(fake_time, resident=True)
        await manager.start()
        assert engine.start_calls == 1
        await manager.stop()

    async def test_resident_start_failure_does_not_propagate(self, fake_time, caplog):
        """MGR-58（BUG-104）：常驻启动失败（启动超时/进程创建异常）不得向上抛出。

        旧实现：`ensure_ready` 的 AppError 传播出 `manager.start()` → lifespan 失败 →
        uvicorn `Application startup failed. Exiting.`（整个应用退出）。引擎降级须由
        崩溃退避重启（DEAD）接管，应用继续运行（人人对弈/复盘不受影响）。
        """
        manager, engine, fsm = await _make_manager(fake_time, resident=True)
        engine.start_error = EngineStartError("启动超时")
        with caplog.at_level(logging.WARNING):
            await manager.start()  # 不得 raise
        assert fsm.state == EngineState.DEAD  # 降级：退避重启接管
        assert "常驻启动失败" in caplog.text  # 事实入日志（不静默）
        await manager.stop()

    async def test_resident_startup_process_exit_does_not_propagate(self, fake_time):
        """MGR-59（BUG-104 实证形态「引擎启动失败（进程退出）」）：启动期进程退出
        （崩溃回调已置 DEAD 的 `EngineStoppedError`）同样不得传播出 `start()`。"""
        manager, engine, fsm = await _make_manager(fake_time, resident=True)

        async def crash_start():
            engine.fsm.mark_started()  # 启动尝试开始（真实引擎 start 首行即 mark_started）
            engine.on_crash()          # 进程退出（崩溃回调 → DEAD + 退避调度）
            raise EngineStoppedError("引擎输出流意外关闭（进程退出）")

        engine.start = crash_start
        await manager.start()  # 不得 raise
        assert fsm.state == EngineState.DEAD
        await manager.stop()

    async def test_resident_rebuild_failure_does_not_propagate(self, fake_time):
        """MGR-60（BUG-104）：按最新配置重建失败（文件缺失 → AppError FATAL）不得抛出；
        回落 STOPPED（未启动）待文件修正后经管理端/自动拉起恢复。"""
        manager, engine, fsm = await _make_manager(fake_time, resident=True)

        def bad_factory(_fsm):
            raise ConfigError("标准模型缺失：无模型文件", code="standard_model_missing")

        manager.set_engine_factory(bad_factory)
        await manager.start()  # 不得 raise
        assert fsm.state == EngineState.STOPPED
        await manager.stop()

    async def test_ensure_ready_in_dead_raises(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        fsm.mark_crashed(now=0.0)
        with pytest.raises(AppError) as ei:
            await manager.ensure_ready()
        assert ei.value.code == ErrorCode.ENGINE_DEAD

    async def test_ensure_ready_in_fatal_raises(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time)
        fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=0.0)
        fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=1.0)
        fsm.mark_started()
        fsm.mark_ready()
        fsm.mark_crashed(now=2.0)
        assert fsm.state == EngineState.FATAL
        with pytest.raises(AppError) as ei:
            await manager.ensure_ready()
        assert ei.value.code == ErrorCode.ENGINE_FATAL


class TestSubmit:
    async def test_submit_ok(self, fake_time):
        manager, engine, _ = await _make_manager(fake_time)
        result = await manager.submit({"id": "s1", "moves": []})
        assert result["ok"] is True
        assert engine.queries[0]["id"] == "s1"

    async def test_submit_during_init_busy(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time)
        engine.is_running = True
        fsm.mark_started()  # INIT（启动中）
        with pytest.raises(AppError) as ei:
            await manager.submit({"moves": []})
        assert ei.value.code == ErrorCode.ENGINE_BUSY

    async def test_submit_engine_stopped_dead(self, fake_time):
        manager, engine, _ = await _make_manager(fake_time)
        engine.query_error = EngineStoppedError("引擎退出")
        with pytest.raises(AppError) as ei:
            await manager.submit({"moves": []})
        assert ei.value.code == ErrorCode.ENGINE_DEAD


class TestCrashRestart:
    async def test_crash_schedules_backoff_restart(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        engine.on_crash()  # 模拟引擎 watcher 崩溃回调
        assert fsm.state == EngineState.DEAD
        await _yield_twice()  # 退避任务执行（fake sleep 立即推进）
        assert engine.start_calls == 2
        assert fsm.state == EngineState.IDLE

    async def test_fatal_after_repeated_crashes(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        engine.on_crash()  # crash 1
        await _yield_twice()
        engine.on_crash()  # crash 2
        await _yield_twice()
        engine.on_crash()  # crash 3（窗口内）→ FATAL
        assert fsm.state == EngineState.FATAL
        await _yield_twice()
        assert engine.start_calls == 3  # FATAL 后不再自动重启

    async def test_no_restart_when_stopping(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        await manager.stop()
        engine.on_crash()
        assert fsm.state == EngineState.STOPPED  # 关闭期退出不得置 DEAD（BUG-100）
        assert manager._restart_task is None  # 不得调度退避重启
        await _yield_twice()
        assert engine.start_calls == 1  # 停止后不重启

    async def test_backoff_restart_retries_after_launch_failure(self, fake_time):
        """MGR-32 退避重启中「重新拉起失败」不得中断重启链（应继续按退避重试）。

        旧实现：_delayed_restart 内 start 失败 → _on_engine_down → _schedule_restart
        被「重启任务未完成」守卫拦截（当前任务即重启任务）→ 重启链永久中断，
        前端仍显示 DEAD「自动重试中」但实际永不再试。
        """
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        calls = {"n": 0}
        orig_start = engine.start

        async def flaky_start():
            calls["n"] += 1
            if calls["n"] == 1:
                raise EngineStartError("模拟重新拉起失败")
            await orig_start()

        engine.start = flaky_start
        engine.on_crash()  # 崩溃 → 退避重启
        await _yield_twice()  # 第一次重启尝试（失败）
        assert calls["n"] == 1
        await _yield_twice()  # 期望：下一轮退避重试
        assert calls["n"] >= 2, "重新拉起失败后必须继续退避重试（重启链不得中断）"
        assert fsm.state == EngineState.IDLE

    async def test_backoff_restart_survives_cleanup_exception(self, fake_time):
        """MGR-36 重启前的旧进程清场异常同样进入退避链（不得杀死重启任务）。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        flaky = {"n": 0}
        orig_stop = engine.stop

        async def flaky_stop():
            flaky["n"] += 1
            if flaky["n"] == 1:
                raise OSError("清场失败（如 terminate 竞态）")
            await orig_stop()

        engine.stop = flaky_stop
        engine.on_crash()
        await _yield_twice()  # 第一次重启：清场异常
        await _yield_twice()  # 期望：退避后再试
        assert flaky["n"] >= 2, "清场异常后必须继续退避重试"
        assert engine.is_running and fsm.state == EngineState.IDLE

    async def test_fatal_recovery_stops_stale_process_first(self, fake_time):
        """MGR-34 FATAL 手动恢复：崩溃可能残留进程/引用 → 重新拉起前先停旧（BUG-054 同族）。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        for _ in range(3):
            engine.on_crash()
            await _yield_twice()
        assert fsm.state == EngineState.FATAL
        assert engine.is_running  # 崩溃仿真不清理进程引用（真实崩溃也可能残留）
        stop_before = engine.stop_calls
        await manager.ensure_ready(reset_fatal=True)
        assert engine.stop_calls == stop_before + 1, "重新拉起前必须先停止残留进程"
        assert fsm.state == EngineState.IDLE


class TestBackoffRestartConcurrency:
    """H-1 回归（2026-09-19 代码审查）：退避重启与并发拉起必须经 ``_launch_lock`` 串行。

    旧实现 ``_delayed_restart`` 在锁外 stop+start：spawn 窗口（``is_running=False``、
    FSM=INIT）中并发 ``ensure_ready`` 通过幂等守卫 → 第二次 ``engine.start()``；
    两方互相覆盖 ``_process``/读取任务，失败方清理会误杀健康进程（孤儿占 GPU）。
    """

    async def test_restart_serialized_with_concurrent_ensure_ready(self, fake_time):
        """退避重启的 start 期间并发 ensure_ready：只允许一次实际拉起。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        gate = asyncio.Event()

        async def gated_start():
            engine.start_calls += 1
            engine.fsm.mark_started()
            await gate.wait()
            engine.is_running = True
            engine.fsm.mark_ready()

        engine.start = gated_start
        engine.on_crash()  # 调度退避重启（FakeTime：立即到点）
        await _yield_many()
        task = asyncio.create_task(manager.ensure_ready())  # 并发按需拉起
        await _yield_many()
        gate.set()
        await task
        await _yield_many()
        assert engine.start_calls == 2, "退避重启与并发按需拉起只允许一次实际拉起"
        assert fsm.state == EngineState.IDLE
        assert engine.is_running

    async def test_restart_skips_when_engine_already_recovered(self, fake_time):
        """等待锁期间引擎已由其它路径恢复 → 不得再停健康进程重拉。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        async with manager._launch_lock:  # 占锁：令退避重启任务在锁前等待
            engine.on_crash()
            await _yield_many()
            engine.is_running = True  # 模拟其它路径（管理端启动/按需拉起）完成恢复
            fsm.mark_started()
            fsm.mark_ready()
        await _yield_many()
        assert engine.start_calls == 1, "引擎已恢复，不得重复拉起"
        assert fsm.state == EngineState.IDLE


class TestSafeRestart:
    async def test_request_restart_when_idle(self, fake_time):
        manager, engine, _ = await _make_manager(fake_time)
        await manager.ensure_ready()
        fut = manager.request_restart()
        await fut
        assert engine.stop_calls == 1
        assert engine.start_calls == 2

    async def test_request_restart_queued_when_busy(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        fsm.begin_query()  # ANALYZING
        fut = manager.request_restart()
        assert not fut.done()  # 忙时入队
        fsm.end_query()  # → IDLE
        manager._maybe_drain_restarts()
        await fut
        assert engine.stop_calls == 1

    async def test_safe_restart_broadcasts_init_then_idle(self, fake_time):
        """MGR-72（BUG-135）：安全重启窗口须广播 INIT（「加载中」）→ IDLE 完整链路。

        旧实现重启全程零广播：``engine.stop()`` 不触碰 FSM，新实例 ``start()`` 内的
        ``mark_started()`` 只改状态不通知监听者，唯一的广播是重启**完成后**的那次
        ``_notify_state()``（已是 IDLE）——前端胶囊在整段重启（停旧/重建/装载权重，
        可达数十秒）停留重启前的旧态（如「空闲中」），用户看不到重启正在发生。
        与 ``_launch`` 同因（BUG-101）：待引擎停止完成后必须先显式广播 INIT。
        """
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()  # → IDLE
        events: list = []
        manager.on_state_change(lambda s, p: events.append(s))
        entered = asyncio.Event()
        gate = asyncio.Event()
        orig_start = engine.start

        async def gated_start():
            entered.set()
            await gate.wait()  # 挂起在「加载中」窗口内
            await orig_start()

        engine.start = gated_start
        fut = manager.request_restart()
        await entered.wait()
        # 重启仍在进行中（start 被闸门挂起）——此刻必须已广播 INIT
        assert fsm.state is EngineState.INIT
        assert events and events[0] is EngineState.INIT, "重启窗口内须广播「加载中」（INIT）"
        gate.set()
        await fut
        assert events[-1] is EngineState.IDLE

    async def test_safe_restart_start_failure_does_not_stick_in_init(self, fake_time):
        """MGR-73（BUG-135）：重启启动失败须按崩溃记账并广播终态，不得停在 INIT。

        缺陷形态：``_do_safe_restart`` 的启动失败分支只 ``_record_start_failure`` 就抛出，
        FSM 停在 ``INIT`` 且不广播 → 前端永久呈现「加载中」（BUG-101 明令禁止的形态：
        INIT 必须伴随实际加载进行），且 `reason`/`detail`（仅 DEAD/FATAL 下发）与退避
        恢复链一并丢失。与 ``_launch`` 同口径应走 ``_on_engine_down()``（DEAD → 退避链）。
        """
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        events: list = []
        manager.on_state_change(lambda s, p: events.append(s))
        engine.start_error = EngineStartError("模拟重启启动失败")
        fut = manager.request_restart()
        with pytest.raises(EngineStartError):
            await fut
        assert fsm.state is not EngineState.INIT, "启动失败停在 INIT＝前端永久「加载中」"
        assert fsm.state in (EngineState.DEAD, EngineState.FATAL)
        assert events[0] is EngineState.INIT and EngineState.DEAD in events, (
            "失败必须广播终态（归因 reason/detail 随 DEAD/FATAL 快照下发）"
        )
        engine.start_error = None
        await manager.stop()

    async def test_request_stop_queued_when_busy(self, fake_time):
        """H-2：忙时入队的 stop 在查询结束（回 IDLE）后经统一 drain 自动执行完成。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        fsm.begin_query()  # ANALYZING
        fut = manager.request_stop()
        assert not fut.done()  # 忙时入队（不立即执行）
        fsm.end_query()  # → IDLE
        manager._drain_pending()  # 查询结束统一检查 stop/restart
        await fut
        assert engine.stop_calls == 1
        assert engine.is_running is False

    async def test_stop_engine_fails_pending_requests(self, fake_time):
        """H-2/M-8：引擎被（空闲超时等）停止时，挂起的 stop/restart Future 收到异常而非永久挂起。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        fsm.begin_query()
        fut_stop = manager.request_stop()
        fut_restart = manager.request_restart()
        assert not fut_stop.done() and not fut_restart.done()
        fsm.end_query()
        await manager.stop_engine()  # 模拟空闲超时停止
        with pytest.raises(EngineStoppedError):
            await fut_stop
        with pytest.raises(EngineStoppedError):
            await fut_restart

    async def test_safe_restart_serialized_with_queued_stop(self, fake_time):
        """MGR-37 安全重启与排队的停止请求经 `_launch_lock` 串行（不得并发 stop/start 互相覆盖）。

        旧实现：`_do_safe_restart` 在锁外 stop+start，与 `_drain_stops` 的 stop_engine
        存在并发窗口（重启被打断/停止被重启覆盖，结果依赖调度时机）。
        """
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        entries = {"n": 0}
        entered = asyncio.Event()
        gate = asyncio.Event()
        orig_stop = engine.stop

        async def gated_stop():
            entries["n"] += 1
            if entries["n"] == 1:
                entered.set()
                await gate.wait()
            await orig_stop()

        engine.stop = gated_stop
        fsm.begin_query()  # 模拟在途查询（忙）
        fut_stop = manager.request_stop()
        fut_restart = manager.request_restart()
        fsm.end_query()  # → IDLE
        manager._drain_pending()  # 查询结束统一消化（与 submit finally 同一入口）
        await entered.wait()  # 重启已持锁并进入清场（被闸门挂起）
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert entries["n"] == 1, "重启持锁期间排队的停止请求不得并发执行"
        gate.set()
        await asyncio.gather(fut_stop, fut_restart)
        assert not engine.is_running, "重启完成后应消化排队的停止请求（确定性：停止在后）"
        assert fsm.state == EngineState.STOPPED  # 排队停止在后 → 未运行态（STOPPED）

    async def test_pending_requests_fail_on_fatal(self, fake_time):
        """M-2（决策 B）：进入 FATAL 终态 → 挂起的 stop/restart 快速失败（不再永久挂起）。

        缺陷形态（旧实现）：FATAL 后不再拉起引擎，但队列中的 restart Future 无人消化，
        admin.task 永不返回。
        """
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        fsm.begin_query()  # 忙：两请求入队而不被立即消费
        fut_restart = manager.request_restart()
        fut_stop = manager.request_stop()
        assert not fut_restart.done() and not fut_stop.done()
        for _ in range(3):  # 窗口内连续 3 次崩溃 → FATAL
            engine.on_crash()
            await _yield_twice()
        assert fsm.state == EngineState.FATAL
        assert fut_restart.done(), "FATAL 后挂起的 restart 必须快速失败（旧实现永久挂起）"
        assert fut_stop.done()
        with pytest.raises(EngineStoppedError):
            await fut_restart
        with pytest.raises(EngineStoppedError):
            await fut_stop

    async def test_stop_enqueued_during_stop_fails(self, fake_time):
        """M-2（决策 B）：停止进行中入队的第二条 stop 不得挂起等待下次拉起。

        缺陷形态（旧实现）：停止期间入队的 stop 在引擎 STOPPED 后无人消化；下次引擎
        被拉起时残留队列会误停新实例。
        """
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        entered = asyncio.Event()
        gate = asyncio.Event()
        orig_stop = engine.stop

        async def gated_stop():
            entered.set()
            await gate.wait()
            await orig_stop()

        engine.stop = gated_stop
        fut_first = manager.request_stop()
        await entered.wait()  # 第一条 stop 已开始执行（引擎仍报 running）
        fut_second = manager.request_stop()  # 停止期间入队
        assert not fut_second.done()
        gate.set()
        await fut_first
        assert fut_second.done(), "停止完成后残留 stop 必须快速失败（旧实现挂起至下次拉起）"
        with pytest.raises(EngineStoppedError):
            await fut_second
        assert fsm.state == EngineState.STOPPED

    async def test_restart_when_not_running_fails_fast(self, fake_time):
        """M-2（决策 B）：引擎未运行时重启请求立即失败，不挂起等待「下次启动消化」。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        await manager.stop_engine()
        assert not engine.is_running
        fut = manager.request_restart()
        assert fut.done(), "引擎未运行时的 restart 必须快速失败（旧实现挂起等待下次启动）"
        with pytest.raises(EngineStoppedError):
            await fut

    async def test_ensure_ready_reset_fatal(self, fake_time):
        """H-3：FATAL 终态可由管理端 ensure_ready(reset_fatal=True) 显式手动恢复。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        for _ in range(3):  # 窗口内连续 3 次崩溃 → FATAL
            engine.on_crash()
            await _yield_twice()
        assert fsm.state == EngineState.FATAL
        # 普通查询路径仍拒绝
        with pytest.raises(AppError) as ei:
            await manager.ensure_ready()
        assert ei.value.code is ErrorCode.ENGINE_FATAL
        # 管理员手动重启
        await manager.ensure_ready(reset_fatal=True)
        assert fsm.state == EngineState.IDLE
        assert engine.start_calls >= 4


class TestBenchmarkStateReset:
    """L-3：调优会话状态随引擎停机/崩溃收敛（`reset()` 旧无调用点）。"""

    async def test_engine_down_resets_benchmark(self, fake_time):
        manager, engine, _fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        manager._benchmark_parser.feed("Beginning GPU tuning for 1 configs")  # 会话开始
        assert engine.benchmarking is True
        assert manager._benchmark_progress == 0
        engine.on_crash()
        await _yield_twice()
        assert engine.benchmarking is False
        assert manager._benchmark_progress is None
        assert manager._benchmark_parser.active is False

    async def test_stop_engine_resets_benchmark(self, fake_time):
        manager, engine, _fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        manager._benchmark_parser.feed("Tuning 3/10")  # 进度行也可触发会话
        assert engine.benchmarking is True
        await manager.stop_engine()
        assert engine.benchmarking is False
        assert manager._benchmark_progress is None
        assert manager._benchmark_parser.active is False


class TestIdleTimeout:
    async def test_idle_timeout_stops_engine(self, fake_time):
        manager, engine, fsm = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.start()  # 启动空闲监控
        await manager.ensure_ready()
        assert engine.is_running
        fake_time.advance(30)  # 推进虚拟时钟到超时
        await asyncio.sleep(0)  # 监控迭代：sleep(5) 推进 + 检查
        await asyncio.sleep(0)
        assert not engine.is_running
        assert engine.stop_calls >= 1
        await manager.stop()

    async def test_activity_resets_idle(self, fake_time):
        manager, engine, _ = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.start()
        await manager.ensure_ready()
        fake_time.advance(20)
        manager.mark_activity()  # 复位
        fake_time.advance(20)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert engine.is_running  # 未超时
        await manager.stop()

    async def test_start_resets_idle_clock(self, fake_time):
        """启动即复位空闲计时（BUG-078）：服务已运行超阈值后拉起引擎，不得在下一周期被立即释放。

        缺陷复现：`_last_activity` 停留在服务启动时刻 → 引擎启动后在下一个监控周期
        （≤5s）即命中「空闲超时」被释放；引导页看到 INIT 又自动 `POST /engines/start`
        → 形成每 5s「释放/拉起」循环（外因：页面开着但未操作）。
        """
        manager, engine, fsm = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.start()
        fake_time.advance(3600)  # 服务已运行 1 小时：空闲计时早已过期
        await manager.ensure_ready()  # 手动/自动拉起
        assert engine.is_running
        fake_time.advance(5)  # 一个监控周期（≤5s）
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert engine.is_running, "刚启动的引擎不得被判空闲释放"
        assert engine.stop_calls == 0
        # 语义不变：自启动起满额空闲超时后仍正常释放
        fake_time.advance(30)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not engine.is_running
        await manager.stop()

    async def test_resident_ignores_idle(self, fake_time):
        manager, engine, _ = await _make_manager(fake_time, resident=True, idle_timeout_s=10)
        await manager.start()
        await manager.ensure_ready()
        fake_time.advance(100)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert engine.is_running  # 常驻忽略空闲超时
        await manager.stop()

    async def test_active_connection_clears_idle_and_keeps_running(self, fake_time):
        """有活跃连接：空闲计时清零不计时（超时不释放，MGR idle 语义变更）。"""
        manager, engine, _ = await _make_manager(
            fake_time, resident=False, idle_timeout_s=30, activity_fn=lambda: True
        )
        await manager.start()
        await manager.ensure_ready()
        assert engine.is_running
        fake_time.advance(200)  # 远超空闲超时
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert engine.is_running
        assert engine.stop_calls == 0  # 活跃连接下绝不空闲释放
        await manager.stop()

    async def test_active_connection_no_idle_clear_after_release(self, fake_time):
        """无活跃连接时仍按空闲超时释放（回归：不破坏原语义）。"""
        manager, engine, _ = await _make_manager(
            fake_time, resident=False, idle_timeout_s=30, activity_fn=lambda: False
        )
        await manager.start()
        await manager.ensure_ready()
        fake_time.advance(30)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not engine.is_running
        await manager.stop()

    async def test_active_connection_auto_starts_stopped_engine(self, fake_time):
        """引擎被停止（空闲/手动 → STOPPED 未启动）而活跃连接仍在 → 监控自动拉起。"""
        manager, engine, _ = await _make_manager(
            fake_time, resident=False, activity_fn=lambda: True
        )
        await manager.start()
        await manager.ensure_ready()
        assert engine.start_calls == 1
        await manager.stop_engine()  # 干净停止 → fsm 回 STOPPED（未启动）
        assert not engine.is_running
        assert manager.fsm.state == EngineState.STOPPED
        fake_time.advance(5)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert engine.is_running
        assert engine.start_calls >= 2
        await manager.stop()

    async def test_start_during_stop_is_not_dropped(self, fake_time):
        """释放/启动竞态（BUG-078 同族）：引擎正在停止时 ensure_ready 不得被静默丢弃。

        旧实现 ensure_ready 在锁外以 IDLE 早退 → 启动请求已被 202 受理但引擎最终停止
        （表现为“启动受理了却没起来”/引导页停在 INIT）。
        """
        manager, engine, fsm = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.ensure_ready()
        assert engine.is_running

        gate = asyncio.Event()
        orig_stop = engine.stop

        async def gated_stop():
            await gate.wait()
            await orig_stop()

        engine.stop = gated_stop
        stop_task = asyncio.create_task(manager.stop_engine())
        await asyncio.sleep(0)  # 停止进入等待（持锁）
        start_task = asyncio.create_task(manager.ensure_ready())
        await asyncio.sleep(0)
        gate.set()
        await asyncio.gather(stop_task, start_task)
        assert engine.is_running, "停止窗口内的启动请求不得被丢弃"
        assert engine.start_calls == 2
        await manager.stop()

    async def test_idle_release_rechecks_under_lock(self, fake_time):
        """空闲释放二次判定：等待锁期间出现新活动（启动复位/新查询）→ 放弃本次释放。"""
        manager, engine, fsm = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.ensure_ready()
        fake_time.advance(31)  # 空闲超时
        manager.mark_activity()  # 竞态：等待锁期间出现新活动
        await manager.stop_engine(only_if_idle=True)
        assert engine.is_running, "出现新活动后不得释放"
        fake_time.advance(30)
        await manager.stop_engine(only_if_idle=True)
        assert not engine.is_running  # 真正再次空闲后照常释放
        await manager.stop()

    async def test_idle_monitor_skips_release_while_initializing(self, fake_time, caplog):
        """MGR-28 启动/调优中（INIT + 进程在）不得被空闲释放，也不得记「释放」日志（BUG-081）。"""
        manager, engine, fsm = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.start()
        await manager.ensure_ready()
        fsm.mark_started()  # 模拟重新进入 INIT（加载/调优进行中）
        fake_time.advance(31)
        with caplog.at_level(logging.INFO, logger="app.engine.manager"):
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        assert engine.stop_calls == 0, "启动/调优中不得被空闲释放"
        assert engine.is_running
        assert not [
            r for r in caplog.records if r.levelno >= logging.INFO and "释放" in r.getMessage()
        ]
        await manager.stop()

    async def test_idle_release_log_after_actual_stop(self, fake_time, caplog):
        """MGR-29 「已释放」日志必须与事实对齐：停止真正完成后才记录（BUG-081）。"""
        manager, engine, _ = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.start()
        await manager.ensure_ready()
        fake_time.advance(31)
        entered = asyncio.Event()
        gate = asyncio.Event()
        orig_stop = engine.stop

        async def gated_stop():
            entered.set()
            await gate.wait()
            await orig_stop()

        engine.stop = gated_stop
        with caplog.at_level(logging.INFO, logger="app.engine.manager"):
            for _ in range(10):
                if entered.is_set():
                    break
                await asyncio.sleep(0)
            assert entered.is_set(), "监控应进入释放流程"
            assert engine.is_running
            assert not [
                r
                for r in caplog.records
                if r.levelno >= logging.INFO and "释放" in r.getMessage()
            ], "释放尚未完成，不得先记录「已释放」"
            gate.set()
            for _ in range(10):
                if not engine.is_running:
                    break
                await asyncio.sleep(0)
            assert not engine.is_running
            assert [
                r for r in caplog.records if r.levelno >= logging.INFO and "释放" in r.getMessage()
            ], "实际释放完成后应有「已释放」记录"
        await manager.stop()

    async def test_idle_release_race_abort_not_logged(self, fake_time, caplog):
        """MGR-30 等待锁期间出现新活动 → 放弃释放：不得记录「已释放」（竞态窗口日志对齐）。"""
        manager, engine, _ = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.start()
        await manager.ensure_ready()
        fake_time.advance(31)
        await manager._launch_lock.acquire()  # 模拟并发启动/重启占用锁
        try:
            with caplog.at_level(logging.INFO, logger="app.engine.manager"):
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                manager.mark_activity()  # 竞态：等待期间出现新活动
        finally:
            manager._launch_lock.release()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert engine.is_running and engine.stop_calls == 0, "出现新活动后不得释放"
        assert not [
            r for r in caplog.records if r.levelno >= logging.INFO and "释放" in r.getMessage()
        ], "释放被放弃不得记「已释放」"
        await manager.stop()

    async def test_monitor_survives_release_exception(self, fake_time):
        """MGR-31 单轮释放异常不得导致空闲监控永久停摆（后续轮次仍正常释放）。"""
        manager, engine, _ = await _make_manager(fake_time, resident=False, idle_timeout_s=30)
        await manager.start()
        await manager.ensure_ready()
        fake_time.advance(31)
        flaky = {"n": 0}
        orig_stop = engine.stop

        async def flaky_stop():
            flaky["n"] += 1
            if flaky["n"] == 1:
                raise OSError("释放路径异常（如 terminate 竞态）")
            await orig_stop()

        engine.stop = flaky_stop
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert engine.is_running  # 首轮释放失败
        fake_time.advance(30)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not engine.is_running, "监控循环必须存活并在下一轮完成释放"
        await manager.stop()


class TestBenchmark:
    async def test_benchmark_progress_flow(self, fake_time):
        events = []
        manager, engine, _ = await _make_manager(fake_time)
        manager.fsm.mark_started()  # 首次调优发生在启动尝试（INIT）期间（真实时序）
        manager.on_state_change(lambda state, progress: events.append((state, progress)))
        # 真实 KataGo 自动调优 stderr 输出（opencltuner.cpp loadOrAutoTune/tune）
        manager._handle_stderr_line("Performing autotuning")
        assert engine.benchmarking is True
        manager._handle_stderr_line("Tuning 3/10 ...")
        assert manager.state_snapshot()["progress"] == 30
        assert (EngineState.INIT, 30) in events
        manager._handle_stderr_line("Done tuning")
        assert engine.benchmarking is False
        assert manager.state_snapshot()["progress"] is None

    async def test_state_snapshot(self, fake_time):
        manager, _, _ = await _make_manager(fake_time)
        snapshot = manager.state_snapshot()
        assert snapshot["state"] == EngineState.STOPPED.value  # 从未启动 → 未启动（≠ INIT 启动中）
        assert snapshot["progress"] is None
        assert snapshot["humanModelAvailable"] is True
        # 不可用归因字段（BUG-097）：初始/运行期无失败事实 → 显式 None
        assert snapshot["reason"] is None
        assert snapshot["detail"] is None

    async def test_backend_label_none_before_detection(self, fake_time):
        manager, _, _ = await _make_manager(fake_time)
        assert manager.backend_label is None


class TestBackendDetection:
    """stderr 后端识别（BUG-097）。

    标记与样本来源：KataGo 源码（openclhelpers.cpp / cudaandrocmbackend.inc /
    trtbackend.cpp / eigenbackend.cpp / onnxbackend.cpp / rocmbackend.cpp）及官方
    测试输出 `cpp/tests/results/runSearchTestsFP16-iNHWC-cNHWC.txt`（勿臆改）。
    """

    CASES = [
        (
            "2026-09-17 21:45:14+0800: Using OpenCL Device 0: NVIDIA GeForce GTX 1660 "
            "(NVIDIA Corporation) OpenCL 3.0 CUDA (Extensions: cl_khr_fp64 cl_khr_icd)",
            "OpenCL · NVIDIA GeForce GTX 1660",
        ),
        (
            "Found OpenCL Platform 0: NVIDIA CUDA (NVIDIA Corporation) (OpenCL 3.0 CUDA 12.6.65)",
            "OpenCL",
        ),
        (
            "Cuda backend thread 0: Found GPU NVIDIA RTX A5000 memory 25285623808 "
            "compute capability major 8 minor 6",
            "CUDA · NVIDIA RTX A5000",
        ),
        (
            "TensorRT backend thread 0: Found GPU NVIDIA GeForce RTX 4080 memory 25757220864 "
            "compute capability major 8 minor 9",
            "TensorRT · NVIDIA GeForce RTX 4080",
        ),
        ("Eigen (CPU) backend thread 0: Model version 14", "Eigen"),
        ("ONNX backend: creating compute context for 19x19 with provider 'openvino'", "ONNX"),
        ("ROCm backend: using CK fused attention", "ROCm"),
    ]

    async def test_backend_markers(self, fake_time):
        for line, expected in self.CASES:
            manager, _, _ = await _make_manager(fake_time)
            manager._handle_stderr_line(line)
            assert manager.backend_label == expected, line

    async def test_backend_unknown_is_none(self, fake_time):
        """未命中任何标记（加载中/普通日志）→ 未检测（None），不得瞎猜。"""
        manager, _, _ = await _make_manager(fake_time)
        manager._handle_stderr_line("2026-09-17 21:45:13+0800: Analysis Engine starting...")
        assert manager.backend_label is None


class TestStartupFailureFacts:
    """启动失败归因（BUG-097）：快照 `reason=startup_failed` + `detail`（stderr 错误行优先）。"""

    async def test_start_failure_records_stderr_cause(self, fake_time):
        """驱动异常：stderr 错误行（如 OpenCL 设备未找到）如实进入 detail。"""
        manager, engine, fsm = await _make_manager(fake_time, resident=False)

        async def failing_start():
            engine.start_calls += 1
            fsm.mark_started()
            engine.on_stderr_line(
                "Uncaught exception: No OpenCL devices were found on your system. "
                "If you believe you do have a GPU or other device with OpenCL installed, "
                "then your OpenCL installation or drivers may be buggy or broken or "
                "otherwise failing to detect your device."
            )
            raise EngineStartError("引擎启动超时：未收到 query_version 握手响应")

        engine.start = failing_start
        with pytest.raises(AppError) as exc:
            await manager.ensure_ready()
        assert exc.value.code is ErrorCode.ENGINE_DEAD
        snapshot = manager.state_snapshot()
        assert snapshot["state"] == "DEAD"
        assert snapshot["reason"] == "startup_failed"
        assert snapshot["detail"].startswith("Uncaught exception: No OpenCL devices")
        await manager.stop()

    async def test_start_failure_without_stderr_uses_exception(self, fake_time):
        """无 stderr 可用时不空报：回退启动异常文案。"""
        manager, engine, _ = await _make_manager(fake_time, resident=False)
        engine.start_error = EngineStartError("引擎启动超时：未收到 query_version 握手响应")
        with pytest.raises(AppError):
            await manager.ensure_ready()
        snapshot = manager.state_snapshot()
        assert snapshot["reason"] == "startup_failed"
        assert "启动超时" in snapshot["detail"]
        await manager.stop()

    async def test_permission_failure_detail_is_actionable(self, fake_time):
        """MGR-71 引擎无执行权限（BUG-131）：detail 如实下发可操作原因（前端横幅/管理卡）。"""
        manager, engine, _ = await _make_manager(fake_time, resident=False)
        engine.start_error = EngineStartError(
            "KataGo 可执行文件无执行权限：/opt/tGo/engine/katago/katago（Linux/macOS 请执行 chmod +x）"
        )
        with pytest.raises(AppError) as exc:
            await manager.ensure_ready()
        assert exc.value.code is ErrorCode.ENGINE_DEAD
        snapshot = manager.state_snapshot()
        assert snapshot["state"] == "DEAD"
        assert snapshot["reason"] == "startup_failed"
        assert "chmod +x" in snapshot["detail"], snapshot["detail"]
        await manager.stop()

    async def test_spawn_oserror_records_failure(self, fake_time):
        """进程创建失败（如缺少 OpenCL.dll / WinError 126）：归因 + 退避重启，不得裸抛。"""
        manager, engine, _ = await _make_manager(fake_time, resident=False)
        engine.start_error = OSError("[WinError 126] 找不到指定的模块")
        with pytest.raises(AppError) as exc:
            await manager.ensure_ready()
        assert exc.value.code is ErrorCode.ENGINE_DEAD
        snapshot = manager.state_snapshot()
        assert snapshot["state"] == "DEAD"
        assert snapshot["reason"] == "startup_failed"
        assert "进程创建失败" in snapshot["detail"]
        await manager.stop()

    async def test_launch_crash_reports_process_exit(self, fake_time):
        """启动期进程退出（崩溃回调已记账 → DEAD）→ 报「进程退出」，不得误导为「被中断」。"""
        manager, engine, fsm = await _make_manager(fake_time, resident=False)

        async def crashing_start():
            engine.start_calls += 1
            fsm.mark_started()
            engine.on_stderr_line(
                "Uncaught exception: Error loading or parsing model file model.bin.gz"
            )
            engine.is_running = False
            engine.on_crash()  # _watch_process 崩溃回调（读流关闭/进程退出路径）
            raise EngineStoppedError("引擎输出流关闭（进程退出）")

        engine.start = crashing_start
        with pytest.raises(AppError) as exc:
            await manager.ensure_ready()
        assert "进程退出" in exc.value.message
        snapshot = manager.state_snapshot()
        assert snapshot["reason"] == "startup_failed"
        assert "Uncaught exception" in snapshot["detail"]
        await manager.stop()

    async def test_recovery_clears_failure_facts(self, fake_time):
        """退避重启成功 → 失败事实清除（快照 reason/detail 复原 None）。"""
        manager, engine, _ = await _make_manager(fake_time, resident=False)
        engine.start_error = EngineStartError("模拟首次拉起失败")
        with pytest.raises(AppError):
            await manager.ensure_ready()
        assert manager.state_snapshot()["reason"] == "startup_failed"
        engine.start_error = None
        fake_time.advance(1.0)  # 首次退避 1s
        await _yield_twice()
        await _yield_twice()
        snapshot = manager.state_snapshot()
        assert snapshot["state"] == "IDLE"
        assert snapshot["reason"] is None and snapshot["detail"] is None
        await manager.stop()

    async def test_runtime_crash_has_no_startup_reason(self, fake_time):
        """运行期崩溃（IDLE/ANALYZING，如显存耗尽）不属于「启动失败」语义（reason=null）。"""
        manager, engine, fsm = await _make_manager(fake_time, resident=False)
        await manager.ensure_ready()
        engine.is_running = False
        engine.on_crash()
        snapshot = manager.state_snapshot()
        assert snapshot["state"] == "DEAD"
        assert snapshot["reason"] is None and snapshot["detail"] is None
        await manager.stop()


class TestColdStartRebuild:
    """冷启动按最新配置重建引擎实例（BUG-097 补全）。

    场景：引擎停止（INIT/崩溃后）期间修改模型路径/默认模型 → [启动] 必须读取
    最新配置（旧实例 argv 构造时已固定）；重建失败（文件缺失）如实报错且可
    修正文件后重试。
    """

    def _make_with_factory(self, fake_time, factory):
        fsm = EngineFsm()
        engine = FakeEngine(fsm)
        manager = EngineManager(
            EngineConfig(),
            engine,
            monotonic=lambda: fake_time.now,
            sleep=fake_time.sleep,
            engine_factory=factory,
        )
        return manager, engine, fsm

    async def test_launch_rebuilds_via_factory(self, fake_time):
        built = {"n": 0}

        def factory(fsm_):
            built["n"] += 1
            return FakeEngine(fsm_)

        manager, engine, _ = self._make_with_factory(fake_time, factory)
        await manager.ensure_ready()
        assert built["n"] == 1
        assert manager.engine is not engine, "启动须使用按最新配置重建的实例"
        assert manager.engine.start_calls == 1
        assert engine.start_calls == 0
        await manager.stop()

    async def test_rebuild_failure_reports_and_retries(self, fake_time):
        state = {"fail": True}

        def factory(fsm_):
            if state["fail"]:
                raise ConfigError("标准模型缺失：models 下未找到标准模型", code="standard_model_missing")
            return FakeEngine(fsm_)

        manager, engine, fsm = self._make_with_factory(fake_time, factory)
        events: list = []
        manager.on_state_change(lambda s, p: events.append(s))
        with pytest.raises(AppError) as exc:
            await manager.ensure_ready()
        assert exc.value.code is ErrorCode.ENGINE_FATAL
        assert "标准模型缺失" in exc.value.message
        assert manager.engine is engine  # 重建失败保留旧实例，不拉起进程
        # 重建失败＝未运行 → 回落 STOPPED（未启动）并广播真实状态
        # （旧实现停留 INIT 且不广播，前端误呈「加载中」——PROMPTS [语义混用]）
        assert fsm.state is EngineState.STOPPED
        assert events and events[-1] is EngineState.STOPPED, "重建失败须广播 STOPPED"
        # 修正文件（工厂恢复）后重试 → STOPPED 状态可直接再次启动（无需 reset_fatal）
        state["fail"] = False
        await manager.ensure_ready()
        assert manager.engine.start_calls == 1
        await manager.stop()


class TestBuildEngine:
    """build_engine：配置 → AnalysisEngine 装配（可执行文件识别 + 模型解析 + 人类模型缺失降级）。"""

    @staticmethod
    def _seed_exe_dir(tmp_path) -> None:
        """放置占位可执行文件（Windows/Linux 两平台名），仅路径探测用（AGENTS.md §7）。"""
        (tmp_path / "katago.exe").write_bytes(b"x")
        (tmp_path / "katago").write_bytes(b"x")

    def test_build_engine_with_models(self, tmp_path):
        self._seed_exe_dir(tmp_path)
        (tmp_path / "kata1.bin.gz").write_bytes(b"x")
        (tmp_path / "human.bin.gz").write_bytes(b"x")
        cfg = EngineConfig(model_dir=str(tmp_path), executable_dir=str(tmp_path))
        engine = build_engine(cfg, EngineFsm())
        assert engine.has_human_model is True
        assert engine._model_path == str(tmp_path / "kata1.bin.gz")
        assert engine._human_model_path == str(tmp_path / "human.bin.gz")

    def test_build_engine_without_human_model(self, tmp_path):
        """人类模型缺失：仅挂载标准模型（PRD §4.1.1 降级）。"""
        self._seed_exe_dir(tmp_path)
        (tmp_path / "kata1.bin.gz").write_bytes(b"x")
        cfg = EngineConfig(model_dir=str(tmp_path), executable_dir=str(tmp_path))
        engine = build_engine(cfg, EngineFsm())
        assert engine.has_human_model is False
        assert engine._human_model_path == ""
        assert engine._model_path == str(tmp_path / "kata1.bin.gz")

    def test_build_engine_missing_standard_raises(self, tmp_path):
        """标准模型缺失 → 引擎不可用降级（不阻碍进入：人人对弈与复盘照常）；原因码供 API 如实归因（BUG-097）。"""
        self._seed_exe_dir(tmp_path)
        cfg = EngineConfig(model_dir=str(tmp_path), executable_dir=str(tmp_path))
        with pytest.raises(ConfigError) as exc:
            build_engine(cfg, EngineFsm())
        assert exc.value.code == "standard_model_missing"

    def test_build_engine_missing_executable_raises(self, tmp_path):
        """executable_dir 顶层无可执行文件 → ConfigError（引擎不可用降级，与标准模型缺失同语义）。"""
        cfg = EngineConfig(model_dir=str(tmp_path), executable_dir=str(tmp_path))
        with pytest.raises(ConfigError) as exc:
            build_engine(cfg, EngineFsm())
        # 归因不得与标准模型缺失混淆（BUG-097：缺什么就报什么）
        assert exc.value.code == "engine_executable_missing"

    def test_build_engine_detects_top_level_executable(self, tmp_path):
        """executable_dir **顶层**按平台识别可执行文件（katago.exe / katago）。"""
        exe_dir = tmp_path / "katago"
        exe_dir.mkdir()
        (exe_dir / "katago.exe").write_bytes(b"x")
        (tmp_path / "kata1.bin.gz").write_bytes(b"x")
        cfg = EngineConfig(model_dir=str(tmp_path), executable_dir=str(exe_dir))
        engine = build_engine(cfg, EngineFsm())
        # 仅存在 katago.exe 时，两平台识别结果一致
        assert engine._executable == str(exe_dir / "katago.exe")

    def test_build_engine_rejects_platform_subdir(self, tmp_path):
        """可执行文件仅位于平台子目录（windows/linux）时顶层识别不到 → ConfigError。"""
        sub = tmp_path / "windows"
        sub.mkdir()
        (sub / "katago.exe").write_bytes(b"x")
        (tmp_path / "kata1.bin.gz").write_bytes(b"x")
        cfg = EngineConfig(model_dir=str(tmp_path), executable_dir=str(tmp_path))
        with pytest.raises(ConfigError):
            build_engine(cfg, EngineFsm())

    def test_build_engine_anchors_relative_paths_to_project_root(self, tmp_path, monkeypatch):
        """相对 executable_dir/model_dir/analysis_cfg 锚定项目根（与启动 CWD 无关）。"""
        root = tmp_path / "root"
        exe_dir = root / "engine" / "katago"
        models_dir = root / "engine" / "models"
        exe_dir.mkdir(parents=True)
        models_dir.mkdir(parents=True)
        (exe_dir / "katago.exe").write_bytes(b"x")
        (models_dir / "kata1.bin.gz").write_bytes(b"x")

        from app.engine import manager as manager_mod

        monkeypatch.setattr(
            manager_mod, "engine_path", lambda v: Path(v) if Path(v).is_absolute() else root / Path(v)
        )
        cfg = EngineConfig()  # 相对默认路径
        engine = build_engine(cfg, EngineFsm())
        assert engine._executable == str(exe_dir / "katago.exe")
        assert engine._model_path == str(models_dir / "kata1.bin.gz")
        assert engine._config_path == str(root / "engine" / "katago" / "analysis.cfg")



class TestEngineAssemblyCheck:
    """check_engine_assembly：运行时重建装配前置探测（BUG-097；纯文件系统检查、无副作用）。"""

    @staticmethod
    def _seed_exe_dir(base) -> None:
        """放置占位可执行文件（Windows/Linux 两平台名），仅路径探测用（AGENTS.md §7）。"""
        base.mkdir(parents=True, exist_ok=True)
        (base / "katago.exe").write_bytes(b"x")
        (base / "katago").write_bytes(b"x")

    def test_ok_when_files_present(self, tmp_path):
        self._seed_exe_dir(tmp_path / "exe")
        (tmp_path / "models").mkdir()
        (tmp_path / "models" / "kata1.bin.gz").write_bytes(b"x")
        cfg = EngineConfig(executable_dir=str(tmp_path / "exe"), model_dir=str(tmp_path / "models"))
        check = check_engine_assembly(cfg)
        assert check.ok is True
        assert check.code is None and check.message is None

    def test_executable_missing(self, tmp_path):
        (tmp_path / "models").mkdir()
        (tmp_path / "models" / "kata1.bin.gz").write_bytes(b"x")
        cfg = EngineConfig(executable_dir=str(tmp_path / "exe"), model_dir=str(tmp_path / "models"))
        check = check_engine_assembly(cfg)
        assert check.ok is False
        assert check.code == "engine_executable_missing"
        assert "可执行文件缺失" in check.message

    def test_standard_model_missing(self, tmp_path):
        self._seed_exe_dir(tmp_path / "exe")
        (tmp_path / "models").mkdir()
        cfg = EngineConfig(executable_dir=str(tmp_path / "exe"), model_dir=str(tmp_path / "models"))
        check = check_engine_assembly(cfg)
        assert check.ok is False
        assert check.code == "standard_model_missing"
        assert "标准模型缺失" in check.message


class TestStateCallbacks:
    async def test_on_state_change_invoked(self, fake_time):
        events = []
        manager, _, _ = await _make_manager(fake_time)
        manager.on_state_change(lambda state, progress: events.append(state))
        await manager.ensure_ready()
        assert EngineState.IDLE in events

    async def test_query_state_change_notifies_analyzing(self, fake_time):
        """MGR-56：查询起止回调必须接线到状态广播（前端胶囊「分析中」，2026/09/18）。

        缺陷：仅生命周期事件广播 → IDLE↔ANALYZING 计数迁移（每次查询）不产生
        engine.status 推送，胶囊永远停在「就绪」。
        """
        events = []
        manager, engine, fsm = await _make_manager(fake_time)
        manager.on_state_change(lambda state, progress: events.append(state))
        await manager.ensure_ready()
        events.clear()
        assert engine.on_query_state_change == manager._notify_state, "查询状态回调必须接线"
        fsm.begin_query()
        engine.on_query_state_change()
        fsm.end_query()
        engine.on_query_state_change()
        assert events == [EngineState.ANALYZING, EngineState.IDLE]


def _effective_cfg_keys(text: str) -> dict[str, str]:
    """cfg 生效键 → 值（对齐 KataGo `Global::stripComments`：`#` 之后内容不生效）。

    用于断言「键是否真的生效」——头部注释里出现的键名不构成生效键。
    """
    entries: dict[str, str] = {}
    for line in text.splitlines():
        body = line.split("#", 1)[0]
        if "=" not in body:
            continue
        key, value = body.split("=", 1)
        entries[key.strip()] = value.strip()
    return entries


class TestRenderAnalysisCfg:
    def test_render_writes_engine_template(self, tmp_path):
        """analysis.cfg 渲染：不设日志路径（禁用 KataGo 自身日志）+ 统一黑方视角 + 引擎初始模板键。"""
        from app.engine.manager import render_analysis_cfg

        cfg = EngineConfig(analysis_cfg=str(tmp_path / "analysis.cfg"))
        target = render_analysis_cfg(cfg)
        text = target.read_text(encoding="utf-8")
        # 无生效的 logFile/logDir（→ KataGo 不写自身日志文件，输出交后端托管）
        effective = _effective_cfg_keys(text)
        assert "logFile" not in effective
        assert "logDir" not in effective
        assert "logDirDated" not in effective
        assert "reportAnalysisWinratesAs = BLACK" in text
        assert "maxVisits = 500" in text
        assert f"numAnalysisThreads = {cfg.num_analysis_threads}" in text
        assert f"numSearchThreadsPerAnalysisThread = {cfg.num_search_threads_per_analysis_thread}" in text
        assert "nnMaxBatchSize = 64" in text
        assert "nnCacheSizePowerOfTwo = 23" in text
        assert "nnMutexPoolSizePowerOfTwo = 17" in text
        assert "nnRandomize = true" in text

    def test_render_anchors_relative_cfg_to_project_root(self, tmp_path, monkeypatch):
        """相对 analysis_cfg 路径锚定项目根（与启动 CWD 无关，杜绝 backend/ 下残留）。"""
        from app.engine.manager import render_analysis_cfg

        anchor = tmp_path / "anchored"

        def _fake_engine_path(value):
            p = Path(value)
            return p if p.is_absolute() else anchor / p.name

        monkeypatch.setattr("app.engine.manager.engine_path", _fake_engine_path)
        cfg = EngineConfig(analysis_cfg="engine/katago/analysis.cfg")
        target = render_analysis_cfg(cfg)
        assert target == anchor / "analysis.cfg"
        assert target.exists()

    # ---- 分层语义（BUG-132）：用户层 analysis.cfg 不覆写，仅行级校正应用维护项 ----

    def test_user_custom_keys_survive_render(self, tmp_path):
        """用户手改/自定义参数不得被渲染覆写（默认层 + 用户层分层）。"""
        from app.engine.manager import render_analysis_cfg

        target = tmp_path / "analysis.cfg"
        target.write_text(
            "# 用户的注释\nopenclGpuToUse = 1\nmaxVisits = 1234\nnumAnalysisThreads = 9\n",
            encoding="utf-8",
        )
        cfg = EngineConfig(
            analysis_cfg=str(target),
            num_analysis_threads=4,
            num_search_threads_per_analysis_thread=12,
        )

        render_analysis_cfg(cfg)

        text = target.read_text(encoding="utf-8")
        assert "# 用户的注释" in text
        assert "openclGpuToUse = 1" in text  # 用户自定义键保留
        assert "maxVisits = 1234" in text  # 用户覆盖的其它默认参数保留
        assert "numAnalysisThreads = 4" in text  # 应用维护项按 config.yaml 期望值校正
        assert "numSearchThreadsPerAnalysisThread = 12" in text  # 缺失的应用维护项补写
        assert "numAnalysisThreads = 9" not in text

    def test_render_is_idempotent(self, tmp_path):
        """重复渲染（启动/引擎级参数变更/引擎重建）不得产生累积改动。"""
        from app.engine.manager import render_analysis_cfg

        target = tmp_path / "analysis.cfg"
        target.write_text("logFile = engine.log\nmaxVisits = 800\n", encoding="utf-8")
        cfg = EngineConfig(analysis_cfg=str(target))

        render_analysis_cfg(cfg)
        first = target.read_text(encoding="utf-8")
        render_analysis_cfg(cfg)

        assert target.read_text(encoding="utf-8") == first
        assert first.count("logFile") == 1  # 禁止键只被注释处理一次

    def test_non_utf8_user_cfg_is_left_untouched(self, tmp_path, caplog):
        """非 UTF-8 用户文件不得被改写、也不得因解码失败中断启动（仅告警跳过校正）。"""
        from app.engine.manager import render_analysis_cfg

        target = tmp_path / "analysis.cfg"
        raw = "# 中文注释（GBK）\nnumAnalysisThreads = 9\n".encode("gbk")
        target.write_bytes(raw)

        with caplog.at_level(logging.WARNING, logger="app.engine.manager"):
            render_analysis_cfg(EngineConfig(analysis_cfg=str(target)))

        assert target.read_bytes() == raw  # 字节原样（回写会损坏用户文件）
        assert "UTF-8" in caplog.text

    def test_commented_lines_are_not_treated_as_effective_keys(self, tmp_path):
        """对齐 KataGo 解析语义（`#` 之后内容不生效）：注释行原样保留、生效键缺失则补写。"""
        from app.engine.manager import render_analysis_cfg

        target = tmp_path / "analysis.cfg"
        target.write_text(
            "#numAnalysisThreads = 9\nmaxVisits = 300 # 用户备注\nreportAnalysisWinratesAs = BLACK\n",
            encoding="utf-8",
        )
        cfg = EngineConfig(analysis_cfg=str(target), num_analysis_threads=2)

        render_analysis_cfg(cfg)

        text = target.read_text(encoding="utf-8")
        assert "#numAnalysisThreads = 9" in text  # 用户自己的注释保留
        assert "maxVisits = 300 # 用户备注" in text
        # 生效键缺失 → 补写（KataGo 对 numAnalysisThreads 按必填键读取，缺失即启动失败）
        assert "\nnumAnalysisThreads = 2" in text

    def test_render_enforces_black_perspective(self, tmp_path, caplog):
        """`reportAnalysisWinratesAs` 为应用强制项（存储与内部派生统一黑方视角）。"""
        from app.engine.manager import render_analysis_cfg

        target = tmp_path / "analysis.cfg"
        target.write_text("reportAnalysisWinratesAs = SIDETOMOVE\n", encoding="utf-8")
        cfg = EngineConfig(analysis_cfg=str(target))

        with caplog.at_level(logging.WARNING, logger="app.engine.manager"):
            render_analysis_cfg(cfg)

        text = target.read_text(encoding="utf-8")
        assert "reportAnalysisWinratesAs = BLACK" in text
        assert "SIDETOMOVE" not in text
        assert "reportAnalysisWinratesAs" in caplog.text  # 覆盖用户的改动必须留痕

    def test_render_disables_engine_own_logging(self, tmp_path, caplog):
        """`logFile`/`logDir`/`logDirDated` 为应用强制缺省项（日志交后端统一托管）。"""
        from app.engine.manager import render_analysis_cfg

        target = tmp_path / "analysis.cfg"
        target.write_text(
            "logFile = engine.log\nlogDir = logs\n# logDirDated = dated\n", encoding="utf-8"
        )
        cfg = EngineConfig(analysis_cfg=str(target))

        with caplog.at_level(logging.WARNING, logger="app.engine.manager"):
            render_analysis_cfg(cfg)

        text = target.read_text(encoding="utf-8")
        effective = _effective_cfg_keys(text)
        assert "logFile" not in effective and "logDir" not in effective
        assert "logFile = engine.log" in text  # 用户原文保留（仅整行注释）
        assert "logDir = logs" in text
        assert "logFile" in caplog.text
        assert "logDir" in caplog.text

    def test_default_layer_template_holds_code_defaults(self):
        """默认层模板的应用维护项 = 代码默认（与 default.yaml 同口径）。"""
        from app.engine.manager import DEFAULT_ENGINE_CFG_TEMPLATE

        defaults = EngineConfig()
        assert f"numAnalysisThreads = {defaults.num_analysis_threads}" in DEFAULT_ENGINE_CFG_TEMPLATE
        assert (
            f"numSearchThreadsPerAnalysisThread = {defaults.num_search_threads_per_analysis_thread}"
            in DEFAULT_ENGINE_CFG_TEMPLATE
        )

    def test_repository_default_cfg_matches_template(self):
        """仓库 `backend/default.cfg` 与内置模板字节一致（防默认层漂移）。"""
        from app.config import default_engine_cfg_path
        from app.engine.manager import DEFAULT_ENGINE_CFG_TEMPLATE

        path = default_engine_cfg_path()
        assert path.name == "default.cfg"
        assert path.parent.name == "backend"
        assert path.read_text(encoding="utf-8") == DEFAULT_ENGINE_CFG_TEMPLATE

    def test_missing_layers_are_generated(self, tmp_path, monkeypatch):
        """默认层缺失 → 按模板生成；用户层缺失 → 按默认层生成并校正应用维护项。"""
        from app.engine import manager

        default_path = tmp_path / "default.cfg"
        monkeypatch.setattr(manager, "default_engine_cfg_path", lambda: default_path)
        target = tmp_path / "analysis.cfg"
        cfg = EngineConfig(
            analysis_cfg=str(target),
            num_analysis_threads=4,
            num_search_threads_per_analysis_thread=12,
        )

        manager.render_analysis_cfg(cfg)

        assert default_path.read_text(encoding="utf-8") == manager.DEFAULT_ENGINE_CFG_TEMPLATE
        text = target.read_text(encoding="utf-8")
        assert "maxVisits = 500" in text  # 默认层参数落到用户层
        assert "nnMaxBatchSize = 64" in text
        assert "reportAnalysisWinratesAs = BLACK" in text
        assert "numAnalysisThreads = 4" in text
        assert "numSearchThreadsPerAnalysisThread = 12" in text
        assert "logFile" not in _effective_cfg_keys(text)


class TestLifecycleLogging:
    """引擎生命周期日志（BUG-082）：**启动事件**（含触发原因）必须落应用日志。

    人工反馈：非常驻模式下引擎经「活跃连接自动拉起」等路径启动后，只有 ``engine.log``
    （KataGo 子进程原始输出）有记录，``tgo.log`` 无任何启动事件——与「引擎空闲超时，
    已释放资源」不对称，排查时无法从应用日志还原「何时/为何拉起」。日志须与真实事实
    对齐（BUG-081 口径）：仅**启动成功/失败**后记录，且带触发原因。
    """

    async def test_start_logs_reason(self, fake_time, caplog):
        """MGR-38 启动成功 → info「引擎已启动（<原因>，耗时 …）」；默认原因=按需加载。"""
        manager, _, _ = await _make_manager(fake_time)
        with caplog.at_level(logging.INFO, logger="app.engine.manager"):
            await manager.ensure_ready()
        messages = [r.getMessage() for r in caplog.records]
        assert any(m.startswith("引擎已启动（按需加载") for m in messages), messages
        # 显式原因透传（管理端启动/常驻启动等）
        caplog.clear()
        await manager.stop_engine()
        with caplog.at_level(logging.INFO, logger="app.engine.manager"):
            await manager.ensure_ready(reason="测试触发")
        messages = [r.getMessage() for r in caplog.records]
        assert any(m.startswith("引擎已启动（测试触发") for m in messages), messages
        await manager.stop()

    async def test_auto_start_logs_active_connection_reason(self, fake_time, caplog):
        """MGR-39 活跃连接自动拉起（人工反馈路径）：日志原因=「活跃连接自动拉起」。

        复现路径：引擎空闲释放（INIT）后移动端重新进入网页 → 对弈通道连接 → 监控
        自动拉起引擎——旧实现下该启动在 ``tgo.log`` 完全不可见。
        """
        manager, engine, fsm = await _make_manager(
            fake_time, resident=False, activity_fn=lambda: True
        )
        await manager.start()  # 启动空闲监控
        with caplog.at_level(logging.INFO, logger="app.engine.manager"):
            for _ in range(6):
                await asyncio.sleep(0)
        assert engine.start_calls == 1 and fsm.state == EngineState.IDLE
        messages = [r.getMessage() for r in caplog.records]
        assert any(m.startswith("引擎已启动（活跃连接自动拉起") for m in messages), messages
        await manager.stop()

    async def test_start_failure_logs_warning(self, fake_time, caplog):
        """MGR-40 启动失败 → warning「引擎启动失败（<原因>，耗时 …）」+ AppError(ENGINE_DEAD)。"""
        manager, engine, fsm = await _make_manager(fake_time)

        async def failing_start():
            fsm.mark_started()  # 真实引擎 start 首行即 mark_started（失败在 INIT 阶段）
            raise EngineStartError("模拟启动超时")

        engine.start = failing_start
        with caplog.at_level(logging.WARNING, logger="app.engine.manager"):
            with pytest.raises(AppError) as ei:
                await manager.ensure_ready(reason="管理端启动")
        assert ei.value.code is ErrorCode.ENGINE_DEAD
        messages = [r.getMessage() for r in caplog.records]
        assert any(m.startswith("引擎启动失败（管理端启动") for m in messages), messages
        await manager.stop()

    async def test_manual_stop_logs_after_actual_stop(self, fake_time, caplog):
        """MGR-41 管理端停止（`request_stop` 消化）→ info「引擎已停止（管理端请求）」。"""
        manager, engine, _ = await _make_manager(fake_time)
        await manager.ensure_ready()
        with caplog.at_level(logging.INFO, logger="app.engine.manager"):
            fut = manager.request_stop()
            await fut
        messages = [r.getMessage() for r in caplog.records]
        assert any(m == "引擎已停止（管理端请求）" for m in messages), messages
        assert not engine.is_running
        await manager.stop()

    async def test_delayed_restart_logs(self, fake_time, caplog):
        """MGR-42 崩溃退避重启成功 → info「引擎已启动（崩溃退避重启，耗时 …）」。"""
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        with caplog.at_level(logging.INFO, logger="app.engine.manager"):
            engine.on_crash()  # 崩溃 → DEAD → 退避重启
            for _ in range(6):
                await asyncio.sleep(0)
        assert engine.is_running and fsm.state == EngineState.IDLE
        messages = [r.getMessage() for r in caplog.records]
        assert any(m.startswith("引擎已启动（崩溃退避重启") for m in messages), messages
        await manager.stop()


class TestStartInterruptDiagnosis:
    """BUG-119：启动中断分诊 + 陈旧进程引用自愈（现场“引擎再未被拉起”）。

    现场（11:00:59 后管理页无法再启动）：引擎崩溃退避重启失败 → 管理页 [启动] 回报
    「引擎启动完成」但无任何启动日志、引擎再未拉起。根因三连：
    ① ``_launch`` 只按 ``state is DEAD`` 判崩溃，启动期崩溃若已升级 FATAL（或崩溃回调
       尚在竞态窗口）被当作“主动停止” → ``mark_stopped()`` 抹掉 DEAD/FATAL 记账；
    ② 崩溃路径残留 ``is_running``（进程引用未释放）；
    ③ ``ensure_ready`` 幂等守卫只看 ``is_running`` → “陈旧引用 + STOPPED”被判为
       “已在运行” → 静默空操作且回报成功（前端假成功 toast，且 ``_auto_start_if_needed``
       /排队的 [重启] 同样永久无法自愈）。
    """

    async def test_stale_running_reference_relaunches(self, fake_time):
        """MGR-63 陈旧引用（is_running 真 + STOPPED）→ 清场重启，不得静默空操作。"""
        manager, engine, fsm = await _make_manager(fake_time)
        engine.is_running = True  # 崩溃/启动中断残留引用（进程实际已退出）
        assert fsm.state == EngineState.STOPPED
        outcome = await manager.ensure_ready(reset_fatal=True, reason="管理端启动")
        assert outcome is LaunchOutcome.LAUNCHED, "陈旧引用必须进入 _launch（旧实现空操作 + 回报成功）"
        assert engine.stop_calls == 1, "拉起前先清场旧引用（避免新旧进程并存）"
        assert engine.is_running and fsm.state == EngineState.IDLE
        await manager.stop()

    async def test_healthy_running_is_noop_and_reports_not_launched(self, fake_time):
        """MGR-64 健康运行态（IDLE + 进程在）→ 空操作且回报「已在运行」（供回执文案区分）。"""
        manager, engine, fsm = await _make_manager(fake_time)
        assert await manager.ensure_ready() is LaunchOutcome.LAUNCHED
        assert await manager.ensure_ready(reset_fatal=True) is LaunchOutcome.ALREADY_RUNNING
        assert engine.start_calls == 1
        assert fsm.state == EngineState.IDLE
        await manager.stop()

    async def test_starting_reports_starting_outcome(self, fake_time):
        """MGR-69 拉起/加载中（INIT + 进程在）→ 幂等空操作且回报 ``STARTING``。

        ISSUE-069 三态回执：旧实现把「已在运行」与「正在启动」合并为同一个假（回执
        文案把加载中误写为「已就绪，无需重复启动」——BUG-119 同族误导）。
        """
        manager, engine, fsm = await _make_manager(fake_time, resident=False)
        fsm.mark_started()  # 启动尝试进行中（拉起/加载/调优）
        engine.is_running = True  # 子进程已创建（真实：create_subprocess_exec 返回即 True）
        outcome = await manager.ensure_ready(reset_fatal=True)
        assert outcome is LaunchOutcome.STARTING
        assert engine.start_calls == 0, "加载中的重复启动不得重复拉起"
        await manager.stop()

    async def test_dead_detected_while_waiting_lock_is_not_relaunched(self, fake_time):
        """MGR-70 等待锁期间崩落 DEAD（本轮退避拉起失败）→ 交退避链，不得立即重拉。

        旧实现（本轮加固前）：请求在锁上等到后看到 DEAD 仍进入 `_launch` → 绕过指数
        退避语义，与退避链交替拉起（管理者点击 = 隐式无限重试）。
        """
        manager, engine, fsm = await _make_manager(fake_time)
        async with manager._launch_lock:  # 占住锁：模拟退避链正在拉起
            task = asyncio.create_task(manager.ensure_ready(reason="管理端启动"))
            await asyncio.sleep(0)  # 请求进入锁等待
            fsm.mark_started()
            fsm.mark_crashed(now=0.0)  # 窗口内崩溃 → DEAD
            assert fsm.state is EngineState.DEAD
        with pytest.raises(AppError) as ei:
            await task
        assert ei.value.code is ErrorCode.ENGINE_DEAD
        assert engine.start_calls == 0, "DEAD 不得被等待中的请求立即重拉（退避链独占）"
        await manager.stop()

    async def test_recovery_owner_exclusive(self, fake_time):
        """MGR-67 恢复所有者独占（ISSUE-069）：DEAD 只许退避链、FATAL 只许管理端手动重启。

        按需/自动拉起路径（含活跃连接自动拉起）在 DEAD/FATAL 下均不得重新拉起——
        否则会与指数退避链并发双启（H-1 同族）或绕过终态语义。
        """
        manager, engine, fsm = await _make_manager(
            fake_time, resident=False, activity_fn=lambda: True
        )
        # DEAD：按需加载与活跃连接自动拉起一律快速失败/不动作
        fsm.mark_started()
        fsm.mark_crashed(now=0.0)
        assert fsm.state is EngineState.DEAD
        with pytest.raises(AppError) as dead:
            await manager.ensure_ready()
        assert dead.value.code is ErrorCode.ENGINE_DEAD
        await manager._auto_start_if_needed()
        assert engine.start_calls == 0, "DEAD 不得经按需/自动拉起路径启动（退避链独占）"
        # FATAL：仅管理端显式手动重启（reset_fatal=True）可恢复
        for t in (1.0, 2.0):
            fsm.mark_started()
            fsm.mark_ready()
            fsm.mark_crashed(now=t)
        assert fsm.state is EngineState.FATAL
        with pytest.raises(AppError) as fatal:
            await manager.ensure_ready()
        assert fatal.value.code is ErrorCode.ENGINE_FATAL
        await manager._auto_start_if_needed()
        assert engine.start_calls == 0, "FATAL 终态不得被自动拉起越过（仅手动重启）"
        assert await manager.ensure_ready(reset_fatal=True) is LaunchOutcome.LAUNCHED
        assert engine.start_calls == 1 and fsm.state is EngineState.IDLE
        await manager.stop()

    async def test_startup_crash_escalated_to_fatal_is_preserved(self, fake_time):
        """MGR-65 启动期崩溃直接升级 FATAL → 保持 FATAL 终态（不得回落 STOPPED）。"""
        manager, engine, fsm = await _make_manager(fake_time)
        # 预置 5 分钟窗内已崩溃 3 次 → FATAL（虚拟时钟确定性推进，禁用瞬时值判定）
        for t in (0.0, 1.0, 2.0):
            fsm.mark_started()
            fsm.mark_ready()
            fsm.mark_crashed(now=t)
        assert fsm.state is EngineState.FATAL
        engine.is_running = True  # 崩溃残留引用（真实崩溃路径历史行为）

        async def crash_start():
            engine.on_crash()  # 启动期崩溃（窗口内第 4 次 → 直接 FATAL）
            raise EngineStoppedError("引擎输出流意外关闭（进程退出）")

        engine.start = crash_start
        with pytest.raises(AppError) as ei:
            await manager.ensure_ready(reset_fatal=True, reason="管理端启动")
        assert ei.value.code is ErrorCode.ENGINE_DEAD
        assert fsm.state is EngineState.FATAL, "启动期崩溃已记账 FATAL，不得回落 STOPPED"
        await manager.stop()

    async def test_startup_crash_in_race_window_records_dead(self, fake_time):
        """MGR-66 崩溃回调未及执行的启动期崩溃（is_stopping 假 + FSM 仍 INIT）→ 记账 DEAD。

        旧实现回落 STOPPED：崩溃被掩盖成“未启动”、指数退避重启链与失败归因一并丢失。
        """
        manager, engine, fsm = await _make_manager(fake_time)

        async def crash_start():
            fsm.mark_started()  # 真实 start 首行（_launch 已置 INIT，此处幂等）
            raise EngineStoppedError("引擎未运行（进程启动失败）")

        engine.start = crash_start
        with pytest.raises(AppError) as ei:
            await manager.ensure_ready(reason="管理端启动")
        assert ei.value.code is ErrorCode.ENGINE_DEAD
        assert fsm.state is EngineState.DEAD, "启动期崩溃须记账 DEAD（不得回落 STOPPED）"
        assert manager._restart_task is not None, "须排入指数退避重启（恢复链不得中断）"
        await manager.stop()

    async def test_engine_down_after_clean_stop_is_expected(self, fake_time, caplog):
        """MGR-68 已确认停止后的进程退出属预期残留事件 → 不记账/不排退避。

        旧实现：``mark_crashed`` 在 STOPPED 下抛 ``EngineFsmError``（被 ``_watch_process``
        吞掉仅记日志）——崩溃事件丢失且 FSM/``is_running`` 事实错位（BUG-119 同根）。
        """
        manager, engine, fsm = await _make_manager(fake_time)
        await manager.ensure_ready()
        await manager.stop_engine()
        assert fsm.state is EngineState.STOPPED
        with caplog.at_level(logging.INFO, logger="app.engine.manager"):
            engine.on_crash()  # 停止后到达的残留退出事件
        assert fsm.state is EngineState.STOPPED
        assert manager._restart_task is None
        messages = [r.getMessage() for r in caplog.records]
        assert any("已停止状态下退出" in m for m in messages), messages
        await manager.stop()

