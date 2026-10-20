"""Analysis 子进程封装（单引擎，标准模型必挂 / 人类模型可选，ARCHITECTURE §3.1/§3.4）。

- `asyncio.create_subprocess_exec` 拉起：`analysis -config ... -model ... [-human-model ...]`；
  人类模型缺失时仅挂载标准模型（PRD §4.1.1 人类模型缺失降级）；
- stdin 单行 JSON 查询，stdout 响应按 `id` 关联路由到对应 Future（异步协议，乱序到达）；
- **stdout / stderr 并发读取**（独立 asyncio 任务，`asyncio.gather` 语义防管道死锁）；
- 就绪握手：发送 `query_version`（零成本）并等待响应 → FSM INIT→IDLE；超时 → DEAD；
  首次自动调优期间（stderr 解析为唯一事实源）仅延长等待、**不重发握手**；
- 进程意外退出：fail 全部挂起查询并回调 `on_crash`（崩溃策略由 EngineManager 负责）；
- 退出序列：关闭 stdin（EOF 优雅）→ `terminate()`（SIGTERM）→ 超时 → `kill()`（SIGKILL）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import uuid
from typing import Callable, Optional

from app.core.fsm import EngineFsm, EngineFsmError, EngineState

#: 引擎日志器（Phase 0 托管，独立落盘 engine.log）
engine_logger = logging.getLogger("tgo.engine")

#: 就绪握手查询 id（query_version 确认引擎可处理 stdin/stdout）
READY_QUERY_ID = "__ready__"
DEFAULT_READY_TIMEOUT_S = 120.0
DEFAULT_QUERY_TIMEOUT_S = 180.0
GRACEFUL_EXIT_TIMEOUT_S = 5.0
TERMINATE_TIMEOUT_S = 3.0
#: 首次自动调优（benchmark）延长等待的总硬上限（秒）：调优挂起时不得无限阻塞 INIT
DEFAULT_MAX_BENCHMARK_WAIT_S = 900.0
#: 子进程 stdout/stderr 单行上限（asyncio StreamReader limit）。KataGo 分析响应单行
#: 可达百 KB 级（宽搜索 moveInfos × PV + policy/ownership）；默认 64KiB 时超长行会抛
#: ValueError 击毙读取协程——stdout 失去消费者后引擎写管道堵塞、整个引擎静默停摆
#: （BUG-054，2026/09/13）。8MiB 对最坏响应仍留充分余量。
STREAM_LIMIT_BYTES = 8 * 1024 * 1024

#: Windows：新建进程组标志（不接收控制台 CTRL_C_EVENT；BUG-100）。
#: `subprocess.CREATE_NEW_PROCESS_GROUP` 仅 Windows 存在——取不到时回退字面值（0x200）
#: 保证跨平台可导入/可测。
_CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)


def _spawn_kwargs() -> dict:
    """子进程创建参数：与终端控制信号解耦（2026/09/18，BUG-100）。

    动机：Windows 控制台按 Ctrl+C 时 CTRL_C_EVENT 会送达**同控制台全部进程**
    （含 katago 子进程）——引擎先于服务关闭序列被杀死（无 "All cleaned up"），
    ``_watch_process`` 将其误报为「引擎输出流意外关闭（进程退出），按故障处理」
    并触发无效崩溃记账/退避。``CREATE_NEW_PROCESS_GROUP``（Windows）/``start_new_session``
    （POSIX）使子进程不接收终端中断——退出统一走服务自身的退出序列
    （stdin 关闭 → 优雅退出 → 超时 terminate/kill）。
    """
    if os.name == "nt":
        return {"creationflags": _CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _executable_permission_problem(executable: str) -> Optional[str]:
    """POSIX 拉起前预检：文件存在但缺执行位 → 返回可操作原因（Windows 无执行位概念恒不拦截）。

    动机（BUG-131，2026/09/22 Linux 部署现场）：`engine/katago/katago` 经 SMB / File Station
    从 Windows 拷贝（或 zip 解压）后**丢失执行位**，`create_subprocess_exec` 只能抛
    `PermissionError: [Errno 13] Permission denied`——管理器侧退化为「引擎进程创建异常」
    （归因文案与「该改什么」无关）+ 每轮退避重启打全量 Traceback。此处提前给出**可操作**
    原因（chmod +x / noexec 卷）。

    仅判定「文件存在且不可执行」：文件不存在或路径异常不在此拦截，交由
    `create_subprocess_exec` 的 `OSError` 如实归因（也不干扰缺失降级路径与测试替身）。
    """
    if os.name == "nt" or not os.path.exists(executable):
        return None
    if os.access(executable, os.X_OK):
        return None
    return (
        f"KataGo 可执行文件无执行权限：{executable}"
        "（Linux/macOS 请执行 chmod +x；若该目录所在卷以 noexec 挂载，需改用可执行分区）"
    )


class EngineStartError(RuntimeError):
    """引擎启动失败（超时/权重缺失/显存不足）。"""


class EngineQueryError(RuntimeError):
    """引擎对查询返回 error 响应。"""

    def __init__(self, message: str, *, field: Optional[str] = None, query_id: Optional[str] = None) -> None:
        self.field = field
        self.query_id = query_id
        super().__init__(f"引擎查询错误: {message}")


class EngineStoppedError(RuntimeError):
    """引擎已停止/崩溃（查询无法完成）。"""


StderrLineCallback = Callable[[str], None]
CrashCallback = Callable[[], None]
#: 查询状态变更回调（begin_query/end_query 后触发，无参——状态从 FSM 读取）
QueryStateCallback = Callable[[], None]


class AnalysisEngine:
    """KataGo Analysis 子进程封装（单进程双模型挂载）。"""

    def __init__(
        self,
        fsm: EngineFsm,
        *,
        executable: str,
        config_path: str,
        model_path: str,
        human_model_path: str,
        ready_timeout_s: float = DEFAULT_READY_TIMEOUT_S,
        query_timeout_s: float = DEFAULT_QUERY_TIMEOUT_S,
        max_benchmark_wait_s: float = DEFAULT_MAX_BENCHMARK_WAIT_S,
        stream_limit_bytes: int = STREAM_LIMIT_BYTES,
        on_stderr_line: Optional[StderrLineCallback] = None,
        on_crash: Optional[CrashCallback] = None,
        on_query_state_change: Optional[QueryStateCallback] = None,
    ) -> None:
        self._fsm = fsm
        self._executable = executable
        self._config_path = config_path
        self._model_path = model_path
        self._human_model_path = human_model_path
        self._ready_timeout_s = ready_timeout_s
        self._query_timeout_s = query_timeout_s
        self._max_benchmark_wait_s = max_benchmark_wait_s
        self._stream_limit_bytes = stream_limit_bytes
        self._on_stderr_line = on_stderr_line
        self._on_crash = on_crash
        self._on_query_state_change = on_query_state_change

        self._process: Optional[asyncio.subprocess.Process] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._read_tasks: list[asyncio.Task] = []
        #: 进程退出监控的内层任务（engine-exit；L-2：随 `_cleanup` 取消，不遗留孤儿等待）
        self._exit_task: Optional[asyncio.Task] = None
        self._write_lock = asyncio.Lock()
        self._stop_lock = asyncio.Lock()
        self._stopping = False
        #: 首次 benchmark 进行中（由管理器根据 BenchmarkParser 事件置位）
        self.benchmarking = False

    # ---- 基础访问 ----

    @property
    def fsm(self) -> EngineFsm:
        return self._fsm

    @property
    def process(self) -> Optional[asyncio.subprocess.Process]:
        return self._process

    @property
    def is_running(self) -> bool:
        """子进程是否已拉起（进程确认退出/清理后为 False）。"""
        return self._process is not None

    @property
    def is_stopping(self) -> bool:
        """是否处于（或刚完成）**主动停止**流程。

        启动中断分诊的事实依据（BUG-119）：``stop()`` 先置 ``_stopping`` 再
        ``_fail_all_pending``（含就绪握手 future），故「握手以 ``EngineStoppedError``
        结束时 ``is_stopping`` 为真」⟺ 中断来自主动停止（服务关闭/空闲释放/安全重启/
        拉起前清场）；为假 ⟺ 启动期崩溃（读取任务/进程退出 fail 在途）。旧实现按
        「进程引用是否还在」猜测来源，会把启动期崩溃误判为「主动停止」并回落
        STOPPED——抹掉 DEAD/FATAL 崩溃记账，恢复链断开（BUG-119）。新一轮 ``start()``
        会复位该标志。
        """
        return self._stopping

    @property
    def has_human_model(self) -> bool:
        """是否挂载了人类模型（False=仅标准模型，创建对局禁用人类风格/自适应）。"""
        return bool(self._human_model_path)

    def set_callbacks(
        self,
        *,
        on_stderr_line: Optional[StderrLineCallback] = None,
        on_crash: Optional[CrashCallback] = None,
        on_query_state_change: Optional[QueryStateCallback] = None,
    ) -> None:
        """运行时接线回调（EngineManager 注入 stderr 解析、崩溃策略与查询状态广播）。"""
        if on_stderr_line is not None:
            self._on_stderr_line = on_stderr_line
        if on_crash is not None:
            self._on_crash = on_crash
        if on_query_state_change is not None:
            self._on_query_state_change = on_query_state_change

    # ---- 生命周期 ----

    async def _spawn(self, argv: list[str]) -> asyncio.subprocess.Process:
        """创建子进程（stdin/stdout/stderr 全管道）；权限类失败归因为可操作文案（BUG-131）。"""
        try:
            return await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=self._stream_limit_bytes,
                **_spawn_kwargs(),
            )
        except PermissionError as exc:
            # 预检（`_executable_permission_problem`）未覆盖的权限拒绝：noexec 挂载、
            # 目录缺搜索权限、ACL 限制——同归因为可操作原因，不得裸抛 PermissionError
            # 退化「进程创建异常」+ 每轮退避重启打全量 Traceback。
            raise EngineStartError(
                f"引擎进程创建被拒（权限不足）：{self._executable}"
                f"（errno {exc.errno}：{exc.strerror}；检查执行位与所在卷是否 noexec 挂载）"
            ) from exc

    async def start(self) -> None:
        """拉起子进程并等待就绪握手；成功 FSM→IDLE，超时 FSM→DEAD 并抛 EngineStartError。

        拉起前预检可执行文件执行位（BUG-131）：无执行权限属**环境问题**，就地以
        ``EngineStartError`` 快速失败（可操作文案），不进入 spawn——否则只能拿到
        ``PermissionError``，管理器侧归为「进程创建异常」，用户无从判断该改什么。
        """
        self._stopping = False
        problem = _executable_permission_problem(self._executable)
        if problem is not None:
            raise EngineStartError(problem)
        self._fsm.mark_started()
        argv = [
            self._executable,
            "analysis",
            "-config",
            self._config_path,
            "-model",
            self._model_path,
        ]
        if self._human_model_path:
            # 人类模型缺失时仅挂载标准模型（PRD §4.1.1 人类模型缺失降级）
            argv += ["-human-model", self._human_model_path]
        self._process = await self._spawn(argv)
        self._read_tasks = [
            asyncio.create_task(self._read_stdout(), name="engine-stdout"),
            asyncio.create_task(self._read_stderr(), name="engine-stderr"),
            asyncio.create_task(self._watch_process(), name="engine-watch"),
        ]
        try:
            await self._wait_ready(timeout=self._ready_timeout_s)
        except asyncio.TimeoutError:
            # C-1 修复：启动失败（超时/调优挂起）必须先彻底清理子进程与读取任务，
            # 防止孤儿进程残留（否则后续退避重启会重复拉起第二个 KataGo 进程）。
            try:
                await self.stop()
            except Exception:  # noqa: BLE001 - 清理失败不掩盖原始启动失败
                engine_logger.exception("引擎启动失败后清理子进程异常")
            raise EngineStartError("引擎启动超时：未收到 query_version 握手响应") from None
        self._fsm.mark_ready()

    async def stop(
        self,
        *,
        graceful_timeout_s: float = GRACEFUL_EXIT_TIMEOUT_S,
        terminate_timeout_s: float = TERMINATE_TIMEOUT_S,
    ) -> None:
        """退出序列：关闭 stdin（EOF）→ SIGTERM → 超时 → SIGKILL（ARCHITECTURE §3.1）。

        经 ``_stop_lock`` 串行化，保证并发 stop（空闲超时与安全重启等）幂等安全。
        """
        async with self._stop_lock:
            self._stopping = True
            self._fail_all_pending(EngineStoppedError("引擎已停止"))
            process = self._process
            if process is None:
                await self._cleanup()
                return

            # 1. 优雅：关闭 stdin（EOF），Analysis 引擎会完成队列后自然退出
            stdin = process.stdin
            if stdin is not None:
                try:
                    stdin.close()
                    await stdin.wait_closed()
                except Exception:  # noqa: BLE001 - 关闭流异常不阻断退出序列
                    pass
            if await self._wait_exit(process, graceful_timeout_s):
                await self._cleanup()
                return

            # 2. SIGTERM
            process.terminate()
            if await self._wait_exit(process, terminate_timeout_s):
                await self._cleanup()
                return

            # 3. SIGKILL（强制）
            process.kill()
            await self._wait_exit(process, terminate_timeout_s)
            await self._cleanup()

    async def _wait_exit(self, process: asyncio.subprocess.Process, timeout: float) -> bool:
        """等待进程退出；超时返回 False。"""
        try:
            await asyncio.wait_for(process.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def _cleanup(self) -> None:
        """取消读取任务、释放进程引用。

        L-1（2026/09/19 决策）：子任务取消/异常单独收敛（``gather(return_exceptions=True)``）——
        旧实现 ``except (asyncio.CancelledError, Exception)`` 会把**调用方自身被取消**
        一并吞掉（关停序列在取消后仍继续执行，取消失效）；L-2：同批取消 ``engine-exit``
        等待任务（否则进程挂死时残留一个孤儿等待任务）。
        """
        if self._exit_task is not None:
            self._exit_task.cancel()
            self._exit_task = None
        tasks = list(self._read_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._read_tasks.clear()
        self._process = None

    def _release_process(self, process: asyncio.subprocess.Process) -> None:
        """释放**已确认退出**进程的引用（仅当引用未被新一轮拉起替换时）。

        ``is_running`` 是管理器幂等守卫、restart 排队与「拉起前清场」的**事实依据**：
        崩溃路径旧实现只 fail 在途、不清 ``_process``（BUG-119）→ 管理器视角「进程仍在
        跑」而实际已死，管理端 [启动] 被误判为「已在运行」→ 静默空操作 + 前端假成功
        toast，引擎永不再拉起。此处只做引用释放，不清读取任务（当前任务可能就是
        ``_watch_process`` 自身；读取任务的清理由 ``stop()``/``_cleanup`` 或下次拉起前
        清场负责），也不用于「主动停止」路径（进程可能仍在终止序列中，引用须保留供
        ``stop()`` 回收，避免留下孤儿进程）。
        """
        if self._process is process:
            self._process = None

    # ---- 查询 ----

    async def query(self, data: dict, *, timeout_s: Optional[float] = None) -> dict:
        """提交单行 JSON 查询并等待响应（按 `id` 路由）。

        查询起止（FSM ``begin_query``/``end_query``）触发 ``on_query_state_change``：
        IDLE↔ANALYZING 计数迁移须得通知管理器（前端胶囊「分析中」，2026/09/18）。
        """
        self._fsm.require(EngineState.IDLE, EngineState.ANALYZING, action="query")
        query_id = str(data.get("id") or uuid.uuid4())
        payload = {**data, "id": query_id}
        fut = self._new_pending(query_id)
        self._fsm.begin_query()
        self._notify_query_state()
        try:
            await self._send_query(payload)
            # L-3（决策 A）：``None`` 或非正值一律取 ``query_timeout_s``（有效值必须 > 0；
            # `or` 短路使显式 0 与 None 同义）——语义在此写明，不引入「 0=不限时」面。
            response = await asyncio.wait_for(fut, timeout_s or self._query_timeout_s)
        except asyncio.TimeoutError:
            raise EngineQueryError(f"查询超时: {query_id}") from None
        finally:
            # 终态回收（2026-09-19 代码审查 C-1）：成功/超时/异常/取消任一终态都必须
            # 从在途表移除——旧实现只在超时/错误路径 pop，成功响应把完整结果
            # （ownership/moveInfos 等，单条数十 KB）永久留在 `_pending`：常驻模式下
            # 内存无界增长，且 terminate() 会把已完成查询误判为在途（发出无效终止帧）。
            self._pending.pop(query_id, None)
            self._end_query_quietly()
        return response

    def _end_query_quietly(self) -> None:
        """结束查询计数并广播状态（崩溃竞态容错）。

        ``mark_crashed`` 已把计数清零并转 DEAD：崩溃路径上 finally 的 end_query
        属重复语义（计数已由崩溃路径清理）——不得让 EngineFsmError 覆盖原异常，
        也不得阻断状态广播。
        """
        try:
            self._fsm.end_query()
        except EngineFsmError:
            pass
        self._notify_query_state()

    def _notify_query_state(self) -> None:
        """查询起止后通知（回调异常不得影响引擎查询路径）。"""
        if self._on_query_state_change is None:
            return
        try:
            self._on_query_state_change()
        except Exception:  # noqa: BLE001 - 回调属外部（广播）路径
            engine_logger.exception("查询状态回调异常")

    def _new_pending(self, query_id: str) -> asyncio.Future:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[query_id] = fut
        return fut

    async def terminate(self, query_id: str) -> bool:
        """请求中断在途查询（KataGo ``action=terminate``，Analysis_Engine.md §terminate）。

        - 仅当该 ``id`` 仍在途时发送；引擎“尽力而为”尽快停止其搜索，并以
          **已完成部分**的结果回投响应（未分析任何 visits 时含 ``noResults:true``，
          仍路由到原 Future → ``query()`` 正常返回到达的部分结果）；
        - terminate 动作自身的 ack 响应无需等待（不注册 pending，未匹配响应由路由层忽略）；
        - 返回是否已发出终止请求（引擎未运行/写管道失败 → False）。
        """
        if query_id not in self._pending:
            return False
        try:
            await self._send_query(
                {
                    "id": f"__terminate__{query_id}",
                    "action": "terminate",
                    "terminateId": query_id,
                }
            )
        except (EngineStoppedError, OSError):
            return False
        return True

    async def _send_query(self, payload: dict) -> None:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        async with self._write_lock:
            if self._process is None or self._process.stdin is None:
                raise EngineStoppedError("引擎未运行")
            self._process.stdin.write(line.encode("utf-8"))
            await self._process.stdin.drain()

    # ---- 读取与路由 ----

    async def _wait_ready(self, timeout: float) -> None:
        """就绪握手：发送一次 query_version 并等待其响应。

        首次自动调优（``self.benchmarking``，由 stderr 解析为唯一事实源）期间引擎无法
        立即响应握手：此时**不重发握手**、仅延长等待，直至就绪或调优结束后超时，
        避免 5-10 分钟 GPU 调优被误判为启动失败（PRD §4.3.4）。
        """
        loop = asyncio.get_running_loop()
        # 单个持久 Future：避免到达的响应被丢弃
        fut = self._new_pending(READY_QUERY_ID)
        await self._send_query({"id": READY_QUERY_ID, "action": "query_version"})
        deadline = loop.time() + timeout
        # M-4 修复：benchmark 延长等待设总硬上限（防 GPU 调优挂起导致 INIT 永久卡死）
        hard_deadline = loop.time() + max(timeout, self._max_benchmark_wait_s)
        while True:
            try:
                remaining = max(0.0, deadline - loop.time())
                # shield 防止 wait_for 超时取消持久 Future（仅取消外层等待）
                await asyncio.wait_for(asyncio.shield(fut), remaining)
                # 握手条目同族回收（审查 C-1）：每次成功启动遗留一条完整响应
                self._pending.pop(READY_QUERY_ID, None)
                return
            except asyncio.TimeoutError:
                if not self.benchmarking:
                    raise
                if loop.time() >= hard_deadline:
                    # 调优总超时：视为启动失败（调用方按崩溃恢复路径处理）
                    raise
                # 仍在调优：延长等待并让出事件循环（不重发握手），但不越过硬上限
                deadline = min(loop.time() + timeout, hard_deadline)
                await asyncio.sleep(0)

    async def _read_stdout(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        stream = self._process.stdout
        while True:
            try:
                line = await stream.readline()
            except ValueError:
                # 单行超过 STREAM_LIMIT_BYTES：前缀已被丢弃，继续从数据流读取到换行
                # （残留片段按非 JSON 行忽略）。绝不因单行异常终止读取循环——循环终止
                # 会使 stdout 不再消费、引擎写管道堵塞并整体停摆（BUG-054）
                engine_logger.error(
                    "引擎 stdout 单行超过 %d 字节（超长响应），已丢弃该行", self._stream_limit_bytes
                )
                continue
            if not line:
                break
            try:
                # M-1（2026/09/19 决策 A：接受现状 + 注明边界）：JSON 解析在事件循环
                # 线程同步执行。查询侧已限 analysisPVLen（PV 条数）/maxMoves 默认值，
                # 响应典型数十 KB（单行最坏 8MiB 由 _stream_limit_bytes 设界），实测
                # 停顿为毫秒级；若未来启用全量 ownership/policy 大矩阵导致响应显著增大，
                # 再评估 orjson/msgspec（须先实测其 GIL 行为）或独立解析线程方案。
                msg = json.loads(line.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                engine_logger.warning("引擎 stdout 非 JSON 行已忽略：%r", line[:200])
                continue
            if isinstance(msg, dict):
                self._route_response(msg)

    def _route_response(self, msg: dict[str, object]) -> None:
        raw_id = msg.get("id")
        query_id = raw_id if isinstance(raw_id, str) else None
        if "error" in msg:
            raw_field = msg.get("field")
            fut = self._pending.pop(query_id, None) if query_id else None
            if fut is not None and not fut.done():
                fut.set_exception(
                    EngineQueryError(
                        str(msg["error"]),
                        field=raw_field if isinstance(raw_field, str) else None,
                        query_id=query_id,
                    )
                )
            else:
                engine_logger.error("引擎返回错误：%s", msg.get("error"))
            return
        fut = self._pending.get(query_id) if query_id else None
        if fut is None:
            engine_logger.debug("忽略未匹配的引擎响应（id=%s）", query_id)
            return
        if not fut.done():
            fut.set_result(msg)

    async def _read_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        stream = self._process.stderr
        while True:
            try:
                line = await stream.readline()
            except ValueError:
                # 同 stdout：单行超限不得终止读取循环（BUG-054 防护）
                engine_logger.error(
                    "引擎 stderr 单行超过 %d 字节，已丢弃该行", self._stream_limit_bytes
                )
                continue
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip("\n")
            engine_logger.info("[engine] %s", text)
            if self._on_stderr_line is not None:
                try:
                    self._on_stderr_line(text)
                except Exception:  # noqa: BLE001 - 回调异常不得中断读取
                    engine_logger.exception("引擎 stderr 回调异常")

    async def _watch_process(self) -> None:
        """监控进程退出与读取任务故障（BUG-054；EOF 崩溃竞态修复 2026/09/17）。

        原实现只等待进程退出——读取协程被单行超长等异常击毙时进程仍"活着"，
        stdout 失去消费者后引擎写管道堵塞、全部查询静默挂起（外部仅见"引擎空闲
        但不响应"）。故改为「进程退出 or 读取任务结束」复合监控：读取任务
        异常按引擎故障处理（fail 挂起查询 + ``on_crash`` 交管理器退避重启，
        重启前由管理器停止存活但故障的旧进程）。

        **EOF 竞态修复（BUG-097 E2E 实测）**：引擎启动即崩时 stdout/stderr 会先于
        ``process.wait()`` 返回 EOF——旧实现把非主动停止的 EOF 也当作「正常 EOF」
        直接返回（仅 stop 序列才会关管道），导致崩溃回调永不触发、挂起握手只能
        等满 120s 超时（外显「一直停在加载阶段」）。现非 ``_stopping`` 下的
        任意读取任务结束（EOF 或异常）一律按故障处理：立即 fail 挂起 + 通知崩溃。
        """
        assert self._process is not None
        process = self._process
        current = asyncio.current_task()
        exit_task = asyncio.create_task(process.wait(), name="engine-exit")
        self._exit_task = exit_task  # L-2：登记以便 `_cleanup` 统一取消
        watched = [exit_task, *(t for t in self._read_tasks if t is not current)]
        done, _ = await asyncio.wait(watched, return_when=asyncio.FIRST_COMPLETED)
        if self._stopping:
            return  # 主动停止：挂起清理与进程回收由 stop 自身负责
        if exit_task in done:
            returncode = process.returncode
            engine_logger.error("引擎进程意外退出（退出码 %s）", returncode)
            # 进程已确认退出 → 引用如实释放（BUG-119：否则 is_running 恒为真，管理器
            # 幂等守卫把「进程已死」误判为「已在运行」）
            self._release_process(process)
            self._fail_all_pending(EngineStoppedError(f"引擎进程退出 (returncode={returncode})"))
            if self._on_crash is not None:
                # L-2：崩溃回调（管理器 mark_crashed 等）异常不得炸掉监控任务——否则
                # 崩溃事件无人消费（退避重启链中断）；回调异常仅记录，不吞崩溃事实
                try:
                    self._on_crash()
                except Exception:  # noqa: BLE001 - 回调异常仅记录
                    engine_logger.exception("引擎崩溃回调异常（监控任务继续）")
            return
        failures = []
        for task in done:
            exc = None if task.cancelled() else task.exception()
            if exc is not None:
                failures.append(f"{task.get_name()}: {exc!r}")
        if failures:
            engine_logger.error(
                "引擎读取任务异常退出（将不再响应请求，按故障处理）：%s",
                "; ".join(failures),
            )
            self._fail_all_pending(EngineStoppedError("引擎读取任务异常退出"))
        else:
            # 非主动停止的输出流 EOF＝进程退出关闭管道（如启动即崩）→ 同崩溃语义
            engine_logger.error("引擎输出流意外关闭（进程已退出），按故障处理")
            self._fail_all_pending(EngineStoppedError("引擎输出流关闭（进程退出）"))
        if self._on_crash is not None:
            try:
                self._on_crash()
            except Exception:  # noqa: BLE001 - 回调异常仅记录（同进程退出分支，L-2）
                engine_logger.exception("引擎崩溃回调异常（监控任务继续）")

    def _fail_all_pending(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()
