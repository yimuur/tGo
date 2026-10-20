"""T2.2 Analysis 子进程封装测试：就绪握手、查询路由、并发读防死锁、退出序列、崩溃通知。

全部通过 Fake 子进程/管道拦截（严禁真实 KataGo/GPU，AGENTS.md §7）。
用例 ID: ANA-*
"""

import asyncio
import json
import os
from unittest.mock import AsyncMock, patch

import pytest

from app.core.fsm import EngineFsm, EngineState
from app.engine.analysis_engine import (
    AnalysisEngine,
    EngineQueryError,
    EngineStartError,
    EngineStoppedError,
    READY_QUERY_ID,
)


class FakeStream:
    """可注入行的异步字节流（模拟子进程管道）。"""

    def __init__(self, seed=None):
        self._queue = asyncio.Queue()
        self.written: list[bytes] = []
        self.closed = False
        for item in seed or []:
            self._queue.put_nowait(item)

    async def readline(self) -> bytes:
        if self.closed and self._queue.empty():
            return b""
        item = await self._queue.get()
        if item is None:  # EOF 哨兵
            return b""
        return item if isinstance(item, bytes) else item.encode()

    def feed(self, line) -> None:
        self._queue.put_nowait(line)

    def feed_eof(self) -> None:
        self._queue.put_nowait(None)

    # ---- 写侧（stdin） ----
    # StreamWriter.write 为同步方法（返回 None）；drain 为异步
    def write(self, data: bytes) -> None:
        self.written.append(data)

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True
        on_close = getattr(self, "_on_close", None)
        if on_close is not None:
            on_close()

    async def wait_closed(self) -> None:
        pass

    # 读侧数据（供断言使用）
    @property
    def written_text(self) -> list[str]:
        return [b.decode("utf-8").strip() for b in self.written]


class FakeProcess:
    """模拟 asyncio.subprocess.Process。

    `exit_on_stdin_close=True`（默认）时，stdin 关闭（EOF）即自动退出，
    还原 Analysis 引擎"stdin 关闭→自然退出"的真实语义。
    """

    def __init__(
        self,
        stdin: FakeStream,
        stdout: FakeStream,
        stderr: FakeStream,
        returncode: int = 0,
        exit_on_stdin_close: bool = True,
    ):
        self.stdin = stdin
        self.stdout = stdout
        self.stderr = stderr
        self._returncode = returncode
        self._exited = asyncio.Event()
        self.terminate_called = False
        self.kill_called = False
        if exit_on_stdin_close:
            stdin._on_close = self._on_stdin_close

    def _on_stdin_close(self) -> None:
        if not self._exited.is_set():
            self.set_exit(0)

    @property
    def returncode(self) -> int:
        return self._returncode

    async def wait(self) -> int:
        await self._exited.wait()
        return self._returncode

    def set_exit(self, code: int) -> None:
        self._returncode = code
        self._exited.set()

    def terminate(self) -> None:
        self.terminate_called = True
        self.set_exit(-15)

    def kill(self) -> None:
        self.kill_called = True
        self.set_exit(-9)


class OversizeOnceStream(FakeStream):
    """第 N 次 readline 抛 ValueError（模拟 StreamReader 单行超限，BUG-054）。"""

    def __init__(self, after: int, seed=None):
        super().__init__(seed)
        self._calls = 0
        self._after = after

    async def readline(self) -> bytes:
        self._calls += 1
        if self._calls == self._after:
            raise ValueError("Separator is not found, and chunk exceed the limit")
        return await super().readline()


class BombStream(FakeStream):
    """调用 ``arm()`` 后下一次 readline 抛 RuntimeError（模拟读取协程被未预见异常击毙，BUG-054）。

    手动引爆以精确控制故障时机：先提交查询（注册 pending），再引爆，验证
    监控任务的故障处理（fail 挂起查询 + on_crash）确实覆盖在途请求。
    """

    def __init__(self, seed=None):
        super().__init__(seed)
        self._armed = False

    def arm(self) -> None:
        self._armed = True

    async def readline(self) -> bytes:
        if self._armed:
            raise RuntimeError("reader exploded")
        return await super().readline()


def _version_response() -> dict:
    return {"id": READY_QUERY_ID, "action": "query_version", "version": "1.6.1", "git_hash": "x"}


async def _make_engine(stdout_seed=None, stderr_seed=None, **kw) -> tuple[AnalysisEngine, FakeProcess, FakeStream, FakeStream]:
    """构造引擎 + Fake 子进程，返回 (engine, process, stdout, stderr)。"""
    fsm = EngineFsm()
    stdin = FakeStream()
    stdout = FakeStream(seed=stdout_seed or [_json(_version_response())])
    stderr = FakeStream(seed=stderr_seed or [])
    proc = FakeProcess(stdin, stdout, stderr)
    engine = AnalysisEngine(
        fsm,
        executable="katago",
        config_path="analysis.cfg",
        model_path="model.bin.gz",
        human_model_path="human.bin.gz",
        query_timeout_s=5,  # 测试防误挂起：异常时 5s 内失败而非默认 180s
        **kw,
    )
    with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
        await engine.start()
    return engine, proc, stdout, stderr


def _json(obj: dict) -> str:
    return json.dumps(obj, separators=(",", ":"))


def _decode(written: list[bytes]) -> list[dict]:
    return [json.loads(b.decode("utf-8")) for b in written]


class TestStart:
    async def test_start_launches_with_dual_model(self):
        """拉起命令含 -config/-model/-human-model 双模型挂载；含终端信号解耦参数（BUG-100）。"""
        from app.engine import analysis_engine as ae

        fsm = EngineFsm()
        stdin, stdout, stderr = FakeStream(), FakeStream(seed=[_json(_version_response())]), FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(
            fsm, executable="katago.exe", config_path="cfg", model_path="std.bin.gz", human_model_path="human.bin.gz"
        )
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)) as m:
            await engine.start()
        args = m.await_args.args
        assert args[0] == "katago.exe"
        assert "analysis" in args
        assert "-model" in args and "std.bin.gz" in args
        assert "-human-model" in args and "human.bin.gz" in args
        kwargs = m.await_args.kwargs
        for key, value in ae._spawn_kwargs().items():
            assert kwargs.get(key) == value, f"子进程必须携带 {key}（Ctrl+C 不得直杀 katago，BUG-100）"
        assert engine.has_human_model is True
        assert fsm.state == EngineState.IDLE

    def test_spawn_kwargs_platform_matrix(self, monkeypatch):
        """ANA-21：子进程创建参数与终端控制信号解耦（平台矩阵，BUG-100）。

        动机：Windows 控制台 Ctrl+C 的 CTRL_C_EVENT 送达同控制台全部进程（含 katago
         子进程）→ 引擎先于服务关闭序列被杀死（无 All cleaned up）→ 被误报为崩溃。
        """
        from app.engine import analysis_engine as ae

        monkeypatch.setattr(ae.os, "name", "nt")
        assert ae._spawn_kwargs() == {"creationflags": ae._CREATE_NEW_PROCESS_GROUP}
        monkeypatch.setattr(ae.os, "name", "posix")
        assert ae._spawn_kwargs() == {"start_new_session": True}

    async def test_start_without_human_model_omits_flag(self):
        """人类模型缺失时仅挂载标准模型（不传 -human-model，PRD §4.1.1 降级）。"""
        fsm = EngineFsm()
        stdin, stdout, stderr = FakeStream(), FakeStream(seed=[_json(_version_response())]), FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(
            fsm, executable="katago.exe", config_path="cfg", model_path="std.bin.gz", human_model_path=""
        )
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)) as m:
            await engine.start()
        args = m.await_args.args
        assert "-human-model" not in args
        assert engine.has_human_model is False
        assert fsm.state == EngineState.IDLE

    async def test_start_ready_handshake_sent(self):
        """就绪握手发送 query_version。"""
        _, proc, _, _ = await _make_engine()
        queries = _decode(proc.stdin.written_text and proc.stdin.written)
        ready = queries[0]
        assert ready["id"] == READY_QUERY_ID
        assert ready["action"] == "query_version"

    async def test_start_timeout_raises(self):
        """握手超时（非 benchmark）→ 抛 EngineStartError，FSM 保持 INIT（由管理器决策崩溃）。"""
        fsm = EngineFsm()
        stdin, stdout, stderr = FakeStream(), FakeStream(), FakeStream()  # 无响应
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(fsm, executable="k", config_path="c", model_path="m", human_model_path="h", ready_timeout_s=0)
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            with pytest.raises(EngineStartError):
                await engine.start()
        assert fsm.state == EngineState.INIT

    async def test_start_timeout_cleans_up_process(self):
        """C-1：启动超时后必须彻底清理子进程（孤儿进程防护），引擎可再次安全拉起。"""
        fsm = EngineFsm()
        stdin, stdout, stderr = FakeStream(), FakeStream(), FakeStream()  # 无响应
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(fsm, executable="k", config_path="c", model_path="m", human_model_path="h", ready_timeout_s=0)
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            with pytest.raises(EngineStartError):
                await engine.start()
        # 退出序列已执行：stdin 关闭（EOF）→ 进程退出 → 引用清理
        assert engine.is_running is False
        assert engine._process is None
        assert engine._read_tasks == []
        assert stdin.closed is True

    async def test_benchmark_wait_hard_cap(self):
        """M-4：调优延长等待设总硬上限（max_benchmark_wait_s），超限视为启动失败（不死锁 INIT）。"""
        fsm = EngineFsm()
        stdin, stdout, stderr = FakeStream(), FakeStream(), FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(
            fsm, executable="k", config_path="c", model_path="m", human_model_path="h",
            ready_timeout_s=0, max_benchmark_wait_s=0,
        )
        engine._process = proc
        engine.benchmarking = True  # 调优中（正常情况下会无限延长）
        with pytest.raises(asyncio.TimeoutError):
            await engine._wait_ready(timeout=0)
        # 握手仅发送一次（不重发）
        sends = [q for q in _decode(stdin.written) if q.get("id") == READY_QUERY_ID]
        assert len(sends) == 1

    async def test_start_benchmark_extends_ready_wait(self):
        """首次调优期间握手超时不判失败，仅延长等待直至就绪（不重发握手）。"""
        fsm = EngineFsm()
        stdin, stdout, stderr = FakeStream(), FakeStream(), FakeStream()
        stdout.feed(_json(_version_response()))
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(
            fsm, executable="k", config_path="c", model_path="m", human_model_path="h",
            ready_timeout_s=0,
        )
        engine.benchmarking = True
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            await engine.start()
        assert fsm.state == EngineState.IDLE

    async def test_benchmark_wait_does_not_resend_handshake(self):
        """调优期间仅延长等待、**不重发握手**（stderr 为唯一事实源）。"""
        fsm = EngineFsm()
        stdin, stdout, stderr = FakeStream(), FakeStream(), FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(
            fsm, executable="k", config_path="c", model_path="m", human_model_path="h",
            ready_timeout_s=0,
        )
        engine._process = proc
        engine.benchmarking = True
        task = asyncio.create_task(engine._wait_ready(timeout=0))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        # 多次超时延长后，握手仍只发送一次
        sends = [q for q in _decode(stdin.written) if q.get("id") == READY_QUERY_ID]
        assert len(sends) == 1
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


class TestExecutablePreflight:
    """拉起前可执行文件预检（BUG-131，2026/09/22 Linux 部署现场）。

    缺陷现场：`./deploy.sh run` 后管理页点 [启动] → `PermissionError: [Errno 13]
    Permission denied`（`engine/katago/katago` 从 Windows 拷贝/解压丢了执行位），管理器
    只报「引擎进程创建异常」、每轮退避重启打一份全量 Traceback——提示与「该改什么」无关。
    """

    async def test_start_rejects_non_executable_binary(self, tmp_path):
        """ANA-29（POSIX）文件在但无执行位 → 拉起前快速失败，且不尝试创建子进程。"""
        if os.name == "nt":
            pytest.skip("执行位是 POSIX 概念（Windows 侧按扩展名判定）")
        binary = tmp_path / "katago"
        binary.write_bytes(b"#!/bin/sh\n")
        binary.chmod(0o644)
        fsm = EngineFsm()
        engine = AnalysisEngine(
            fsm, executable=str(binary), config_path="c", model_path="m", human_model_path=""
        )
        spawn = AsyncMock()
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=spawn):
            with pytest.raises(EngineStartError) as exc:
                await engine.start()
        assert "执行权限" in str(exc.value), str(exc.value)
        assert "chmod +x" in str(exc.value), str(exc.value)
        assert spawn.await_count == 0, "无执行权限不得尝试创建子进程"
        assert engine.is_running is False

    async def test_spawn_permission_error_is_actionable(self):
        """ANA-30 spawn 仍抛 PermissionError（noexec 挂载/ACL）→ 可操作文案，不得裸抛 OSError。"""
        fsm = EngineFsm()
        engine = AnalysisEngine(
            fsm, executable="katago", config_path="c", model_path="m", human_model_path=""
        )
        spawn = AsyncMock(side_effect=PermissionError(13, "Permission denied"))
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=spawn):
            with pytest.raises(EngineStartError) as exc:
                await engine.start()
        message = str(exc.value)
        assert "权限" in message, message
        assert "noexec" in message, message
        assert engine.is_running is False, "创建失败不得残留进程引用"

    def test_precheck_matrix(self, tmp_path, monkeypatch):
        """ANA-31 预检矩阵：不存在/已可执行/Windows → 不拦截（交操作系统如实归因）。"""
        from app.engine import analysis_engine as ae

        assert ae._executable_permission_problem(str(tmp_path / "missing")) is None
        binary = tmp_path / "katago"
        binary.write_bytes(b"x")
        binary.chmod(0o755)
        assert ae._executable_permission_problem(str(binary)) is None
        if os.name == "posix":
            binary.chmod(0o644)
            problem = ae._executable_permission_problem(str(binary))
            assert problem is not None and "执行权限" in problem, problem
        monkeypatch.setattr(ae.os, "name", "nt")
        assert ae._executable_permission_problem(str(binary)) is None, "Windows 无执行位概念"


class TestQuery:
    async def test_query_routes_by_id(self):
        engine, proc, stdout, _ = await _make_engine()
        response = {"id": "q1", "moveInfos": [], "rootInfo": {}, "turnNumber": 1}
        stdout.feed(_json(response))
        result = await engine.query({"id": "q1", "moves": []})
        assert result["turnNumber"] == 1
        # FSM 回到 IDLE
        assert engine.fsm.state == EngineState.IDLE
        assert engine.fsm.active_queries == 0

    async def test_query_state_callback_marks_analyzing(self):
        """ANA-19：查询起止必须回调状态（ANALYZING→IDLE）——前端胶囊「分析中」广播依据。

        缺陷（2026/09/18 人工反馈）：FSM 的 begin_query/end_query 计数迁移无任何
        通知，管理器仅在生命周期事件广播 → 前端永远收不到 ANALYZING（胶囊停在
        「就绪」，无文案也无动画）。
        """
        seen = []
        engine, _proc, stdout, _stderr = await _make_engine(
            on_query_state_change=lambda: seen.append(engine.fsm.state)
        )
        stdout.feed(_json({"id": "q1", "rootInfo": {}}))
        await engine.query({"id": "q1", "moves": []})
        assert seen == [EngineState.ANALYZING, EngineState.IDLE]

    async def test_query_crash_keeps_error_and_still_notifies(self):
        """ANA-20：崩溃竞态下 finally 的重复 end_query 不得覆盖原异常，且状态回调仍触发。

        mark_crashed 会把计数清零并转 DEAD：旧实现在 finally 直接 end_query →
        EngineFsmError 覆盖 EngineStoppedError；终态广播也会被跳过。
        """
        seen = []
        engine, proc, _stdout, _stderr = await _make_engine(
            on_query_state_change=lambda: seen.append(engine.fsm.state)
        )
        pending = asyncio.create_task(engine.query({"id": "q9", "moves": []}))
        await asyncio.sleep(0)  # 让查询写入 stdin
        engine.fsm.mark_crashed(100.0)  # 模拟管理器崩溃路径（计数清零 + DEAD）
        proc.set_exit(1)
        with pytest.raises(EngineStoppedError):
            await pending
        assert seen[0] == EngineState.ANALYZING
        assert seen[-1] == EngineState.DEAD
        assert engine.fsm.state == EngineState.DEAD

    async def test_query_auto_assigns_id(self):
        engine, proc, stdout, _ = await _make_engine()
        task = asyncio.create_task(engine.query({"moves": []}))
        await asyncio.sleep(0)  # 让查询写入 stdin
        sent = _decode(proc.stdin.written)
        auto = next(q for q in sent if q["id"] != READY_QUERY_ID)
        assert auto["id"], "未自动分配 id"
        # 响应回显自动分配的 id → 按 id 路由成功
        stdout.feed(_json({"id": auto["id"], "rootInfo": {}}))
        result = await task
        assert result["id"] == auto["id"]

    async def test_query_error_response_raises(self):
        engine, proc, stdout, _ = await _make_engine()
        stdout.feed(_json({"error": "bad rules", "field": "rules", "id": "q2"}))
        with pytest.raises(EngineQueryError):
            await engine.query({"id": "q2", "moves": []})

    async def test_query_in_dead_rejected(self):
        """崩溃后提交查询被 FSM 拒绝。"""
        fsm = EngineFsm()
        stdin, stdout, stderr = FakeStream(), FakeStream(seed=[_json(_version_response())]), FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(fsm, executable="k", config_path="c", model_path="m", human_model_path="h")
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            await engine.start()
        fsm.mark_crashed(now=1.0)
        with pytest.raises(Exception):
            await engine.query({"moves": []})


class TestConcurrentRead:
    async def test_stderr_and_stdout_read_concurrently(self):
        """stdout/stderr 并发读取：大量 stderr 行不阻塞 stdout 响应（防管道死锁）。"""
        stderr_seed = [f"log line {i}" * 50 for i in range(200)]  # 大流量 stderr
        engine, proc, stdout, _ = await _make_engine(stderr_seed=stderr_seed)
        stdout.feed(_json({"id": "q3", "rootInfo": {}}))
        result = await asyncio.wait_for(engine.query({"id": "q3", "moves": []}), timeout=2)
        assert "rootInfo" in result

    async def test_stderr_lines_logged_and_callback(self):
        lines = []
        engine, proc, _, _ = await _make_engine(
            stderr_seed=["first", "second"], on_stderr_line=lambda s: lines.append(s)
        )
        await asyncio.sleep(0)  # 让 stderr 读取任务消费
        await asyncio.sleep(0)
        assert lines[:2] == ["first", "second"]


class TestCrash:
    async def test_unexpected_exit_fails_pending_and_notifies(self):
        crashed = []
        engine, proc, stdout, _ = await _make_engine(on_crash=lambda: crashed.append(True))
        pending = asyncio.create_task(engine.query({"id": "q9", "moves": []}))
        await asyncio.sleep(0)  # 让查询写入 stdin
        proc.set_exit(1)  # 进程崩溃
        with pytest.raises(EngineStoppedError):
            await pending
        assert crashed == [True]

    async def test_clean_stop_not_treated_as_crash(self):
        crashed = []
        engine, proc, stdout, _ = await _make_engine(on_crash=lambda: crashed.append(True))
        await engine.stop()
        assert crashed == []
        assert engine.fsm.state in (EngineState.IDLE, EngineState.INIT)  # 停止不改变崩溃语义

    async def test_output_eof_treated_as_crash_promptly(self):
        """启动期输出流 EOF（进程退出关管道、exit_task 尚未完成）→ 立即崩溃处理。

        BUG-097 E2E 实测回归：旧实现把非主动停止的 EOF 也当「正常 EOF」静默返回，
        崩溃回调永不触发、挂起握手只能等满超时（外显「一直停在加载阶段」）。
        """
        fsm = EngineFsm()
        stdin = FakeStream()
        stdout = FakeStream()
        stderr = FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        crashed = []
        engine = AnalysisEngine(
            fsm,
            executable="k",
            config_path="c",
            model_path="m",
            human_model_path="h",
            ready_timeout_s=30,  # 若退化为超时等待，本测试将超时失败（30s）而非快速通过
            on_crash=lambda: crashed.append(True),
        )
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            start_task = asyncio.create_task(engine.start())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            stdout.feed_eof()  # 进程退出 → stdout EOF（exit_task 未完成：竞态窗口）
            with pytest.raises(EngineStoppedError):
                await start_task
        assert crashed == [True]


class TestStopSequence:
    async def test_graceful_exit_closes_stdin(self):
        engine, proc, stdout, _ = await _make_engine()
        await engine.stop()
        assert proc.stdin.closed is True

    async def test_terminate_when_no_graceful_exit(self):
        """stdin 关闭后进程未退出 → 走 SIGTERM。"""
        engine, proc, stdout, _ = await _make_engine()
        stubborn = FakeProcess(proc.stdin, proc.stdout, proc.stderr, exit_on_stdin_close=False)
        engine._process = stubborn
        await engine.stop(graceful_timeout_s=0, terminate_timeout_s=0)
        assert stubborn.terminate_called is True

    async def test_kill_when_terminate_times_out(self):
        """SIGTERM 超时 → SIGKILL。"""
        engine, proc, stdout, _ = await _make_engine()

        class NoExitProcess(FakeProcess):
            def __init__(self, *args, **kw):
                super().__init__(*args, **kw, exit_on_stdin_close=False)

            async def wait(self):  # 永不退出
                await asyncio.Event().wait()
                return 0

            def terminate(self):
                self.terminate_called = True

            def kill(self):
                self.kill_called = True

        no_exit = NoExitProcess(proc.stdin, proc.stdout, proc.stderr)
        engine._process = no_exit
        await engine.stop(graceful_timeout_s=0, terminate_timeout_s=0)
        assert no_exit.kill_called is True


class TestTerminate:
    """KataGo ``action=terminate``：中止在途查询并回投部分结果（悔棋中断 AI 应手用，2026/09/13）。"""

    async def test_terminate_inflight_query_sends_action(self):
        """terminate：在途查询 → 发送 terminateId 对位的 terminate 动作；部分结果正常路由解除。"""
        engine, proc, stdout, _ = await _make_engine()
        task = asyncio.create_task(engine.query({"id": "q1", "moves": []}))
        await asyncio.sleep(0)
        await asyncio.sleep(0)  # 让查询写入 stdin / 注册 pending
        assert await engine.terminate("q1") is True
        term = [q for q in _decode(proc.stdin.written) if q.get("action") == "terminate"]
        assert len(term) == 1
        assert term[0]["terminateId"] == "q1"
        # 引擎回投终止后的部分结果（noResults）→ 原查询 Future 正常解除（不悬挂）
        stdout.feed(_json({"id": "q1", "isDuringSearch": False, "noResults": True, "turnNumber": 1}))
        result = await task
        assert result.get("noResults") is True

    async def test_terminate_unknown_query_is_noop(self):
        """terminate：非在途查询不发帧（避免无效终止请求）。"""
        engine, proc, _, _ = await _make_engine()
        before = len(proc.stdin.written)
        assert await engine.terminate("nope") is False
        assert len(proc.stdin.written) == before


class TestStreamResilience:
    """BUG-054：读取循环防超长行击毙 + 读取任务故障监控（2026/09/13）。

    背景：KataGo 响应单行可达百 KB 级；StreamReader 默认 64KiB 上限下超长行
    会使 ``readline`` 抛 ValueError 并击毙读取协程——stdout 失去消费者后引擎
    写管道堵塞、整个引擎静默停摆（外部仅见“引擎空闲但不响应任何查询”）。
    """

    async def test_oversized_line_does_not_kill_reader(self):
        """单行超限（ValueError）后读取循环存活，后续响应仍被正常路由。"""
        fsm = EngineFsm()
        stdin = FakeStream()
        stdout = OversizeOnceStream(after=2, seed=[_json(_version_response())])
        stderr = FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(
            fsm, executable="k", config_path="c", model_path="m", human_model_path="h", query_timeout_s=5
        )
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            await engine.start()
        # 读循环第 2 次 readline 已触发一次超限异常；随后 feed 正常响应行
        stdout.feed(_json({"id": "q1", "moveInfos": []}))
        result = await asyncio.wait_for(engine.query({"id": "q1", "moves": []}), timeout=5)
        assert result["id"] == "q1"
        assert not engine._read_tasks[0].done()  # 读取任务存活（未被单行异常击毙）

    async def test_reader_failure_triggers_crash_callback(self):
        """读取任务异常结束 → 挂起查询被 fail + on_crash（交管理器退避重启）。"""
        fsm = EngineFsm()
        stdin = FakeStream()
        stdout = BombStream(seed=[_json(_version_response())])
        stderr = FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        crashed = []
        engine = AnalysisEngine(
            fsm,
            executable="k",
            config_path="c",
            model_path="m",
            human_model_path="h",
            query_timeout_s=5,
            on_crash=lambda: crashed.append(True),
        )
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            await engine.start()
        # 先提交查询（注册 pending），再引爆读取任务（下一次 readline 抛 RuntimeError）
        pending = asyncio.create_task(engine.query({"id": "q1", "moves": []}))
        await asyncio.sleep(0)  # 让查询写入 stdin 并挂起
        stdout.arm()
        stdout.feed(b'{"id":"wake"}\n')  # 唤醒读循环 → 下一次 readline 引爆
        for _ in range(200):  # 时间窗口轮询：等待监控任务触发故障处理（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if crashed:
                break
        assert crashed == [True]
        with pytest.raises(EngineStoppedError):
            await pending


class TestCleanupLifecycle:
    """L-1/L-2：`_cleanup` 不得吞自身取消；engine-exit 任务随清理取消。"""

    async def test_cleanup_propagates_own_cancellation(self):
        """调用方（如 stop 序列）被取消时，`_cleanup` 必须传播 CancelledError。

        旧实现 `except (CancelledError, Exception)` 会把取消一并吞掉——关停序列
        在取消后仍继续执行（取消失效）；修复后子任务收尾走
        `gather(return_exceptions=True)`，自身取消正常传播。
        """
        engine, _proc, _stdout, _stderr = await _make_engine()

        async def _hang():
            await asyncio.Event().wait()

        engine._read_tasks.append(asyncio.create_task(_hang()))
        cleanup = asyncio.create_task(engine._cleanup())
        await asyncio.sleep(0)
        cleanup.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cleanup

    async def test_cleanup_cancels_exit_task(self):
        """engine-exit 等待任务登记后随 `_cleanup` 取消（L-2，防孤儿任务）。"""
        engine, _proc, _stdout, _stderr = await _make_engine()
        assert engine._exit_task is not None  # 启动期已登记
        await engine._cleanup()
        assert engine._exit_task is None
        assert engine._read_tasks == []

    async def test_crash_callback_exception_does_not_break_monitor(self):
        """崩溃回调异常（FSM 竞态）不得炸掉进程监控任务（L-2）。"""
        engine, _proc, _stdout, _stderr = await _make_engine()

        class _ExitedProcess:
            returncode = 137

            async def wait(self):
                return 137

        engine._process = _ExitedProcess()

        async def _hang():
            await asyncio.Event().wait()

        engine._read_tasks = [asyncio.create_task(_hang())]

        def _raising():
            raise RuntimeError("FSM 竞态：mark_crashed 失败")

        engine._on_crash = _raising
        # 修复前：RuntimeError 直接冒出（监控任务死亡）；修复后：仅记日志
        await asyncio.wait_for(engine._watch_process(), timeout=2)


class TestPendingLifecycle:
    """在途查询表生命周期：任一终态必须回收 ``_pending`` 条目（无界内存泄漏防护）。

    缺陷（2026-09-19 代码审查项 C-1）：成功响应仅 ``set_result`` 从不 ``pop``——
    每条成功查询把完整响应 dict（``ownership``/``policy``/``moveInfos×PV``，
    单条数十 KB）永久留在 ``_pending``；常驻（resident）模式下内存随对局量
    无界增长，且 ``terminate()`` 会把已完成查询误判为“在途”并发出无效终止帧。
    """

    async def test_successful_query_releases_pending_entry(self):
        """成功查询结束后 ``_pending`` 必须为空（握手条目亦已回收）。"""
        engine, _proc, stdout, _ = await _make_engine()
        stdout.feed(_json({"id": "q1", "rootInfo": {}}))
        await engine.query({"id": "q1", "moves": []})
        assert engine._pending == {}

    async def test_ready_handshake_releases_pending_entry(self):
        """就绪握手（__ready__）成功后不得在 ``_pending`` 残留。"""
        engine, _proc, _stdout, _ = await _make_engine()
        assert READY_QUERY_ID not in engine._pending

    async def test_terminate_after_completion_returns_false_and_sends_nothing(self):
        """已完成查询不属于“在途”：terminate 返回 False 且不发 terminate 帧。"""
        engine, proc, stdout, _ = await _make_engine()
        stdout.feed(_json({"id": "q1", "rootInfo": {}}))
        await engine.query({"id": "q1", "moves": []})
        before = len(proc.stdin.written)
        assert await engine.terminate("q1") is False
        assert len(proc.stdin.written) == before

    async def test_timeout_releases_pending_entry(self):
        """超时终态同样回收条目（既有行为回归：修复不得只覆盖成功路径）。"""
        fsm = EngineFsm()
        stdin = FakeStream()
        stdout = FakeStream(seed=[_json(_version_response())])
        stderr = FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        engine = AnalysisEngine(
            fsm,
            executable="k",
            config_path="c",
            model_path="m",
            human_model_path="h",
            query_timeout_s=0.01,
        )
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            await engine.start()
        with pytest.raises(EngineQueryError):
            await engine.query({"id": "q1", "moves": []})
        assert "q1" not in engine._pending


class TestProcessReferenceLifecycle:
    """进程引用真实性与主动停止判据（BUG-119）。

    缺陷现场：引擎崩溃退避重启失败后，管理页 [启动] 回报「引擎启动完成」但引擎再未拉起。
    根因之一是 ``_watch_process`` 崩溃路径只 fail 在途、**不释放** ``_process`` → 管理器
    幂等守卫（`engine.is_running`）把「进程已死」误判为「已在运行」→ 静默空操作。
    另一根因：启动中断分诊曾按「进程引用还在不在」猜测来源，需以 ``is_stopping``
    （stop() 置位 / start() 复位）作为**主动停止**的事实判据。
    """

    async def test_exit_releases_process_reference(self):
        """ANA-26 进程确认退出 → 释放引用，`is_running` 如实为 False。"""
        engine, _proc, _stdout, _stderr = await _make_engine()

        class _ExitedProcess:
            returncode = 137

            async def wait(self):
                return 137

        engine._process = _ExitedProcess()
        # 读取任务保持挂起（模拟管道未关闭/读取协程仍在跑）：退出分支须自行释放引用
        engine._read_tasks = [asyncio.create_task(asyncio.Event().wait())]
        try:
            await asyncio.wait_for(engine._watch_process(), timeout=2)
        finally:
            for task in engine._read_tasks:
                task.cancel()
        assert engine.is_running is False, "进程已退出 → is_running 必须如实为 False"

    async def test_stop_never_releases_reference_early(self):
        """ANA-27 主动停止路径不得提前释放引用（进程可能仍在终止序列，须留给 stop 回收）。"""
        engine, _proc, _stdout, _stderr = await _make_engine()
        assert engine.is_running is True
        assert engine.is_stopping is False
        await engine.stop()
        assert engine.is_stopping is True, "stop() 须置停止标志（启动中断分诊依据）"
        assert engine.is_running is False

    async def test_start_resets_stopping_flag(self):
        """ANA-28 新一轮拉起复位停止标志（否则上一轮停止会把重启误分诊为“主动停止”）。"""
        engine, _proc, _stdout, _stderr = await _make_engine()
        await engine.stop()
        assert engine.is_stopping is True
        stdin, stdout, stderr = FakeStream(), FakeStream(seed=[_json(_version_response())]), FakeStream()
        proc = FakeProcess(stdin, stdout, stderr)
        with patch("app.engine.analysis_engine.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)):
            await engine.start()
        assert engine.is_stopping is False
        assert engine.is_running is True
        await engine.stop()
