"""T3.6 分析调度器 + T3.7 分析结果合并缓存测试（ARCHITECTURE §4.2 / DATABASE §3.4）。

用例 ID: ANA-SCH-*（调度器）/ ANA-CACHE-*（缓存）
- 优先级出队（P0>P1>P2>P3）、并发上限、200ms 节流（FakeTime）、过期丢弃；
- 链槽合并 4 情形、试下分支不落库、试下截断；
- 深算槽（BUG-026）：仅会话不落盘、链行不被覆盖、按对局隔离、截断/清空。
"""

import asyncio
import json

import pytest

from app.config import default_config
from app.db import repos
from app.services.analysis_service import (
    AnalysisCache,
    AnalysisService,
    ThrottledPusher,
)


def _query(priority: int, *, max_visits: int = 100) -> dict:
    return {
        "id": "q",
        "moves": [],
        "rules": "chinese",
        "komi": 7.5,
        "boardXSize": 9,
        "boardYSize": 9,
        "maxVisits": max_visits,
        "priority": priority,
        "includeOwnership": True,
    }


class RecordingEngine:
    """立即完成并按提交顺序记录 priority。"""

    def __init__(self):
        self.order: list[int] = []

    async def submit(self, query, timeout_s=None):
        self.order.append(int(query.get("priority")))
        await asyncio.sleep(0)
        return {"id": query.get("id"), "rootInfo": {"winrate": 0.5, "scoreLead": 0.0}}


class GateEngine:
    """阻塞引擎：跟踪并发数，release 后放行；到达并发上限时置 reached 事件。"""

    def __init__(self, expected: int = 2):
        self.inflight = 0
        self.max_inflight = 0
        self.done = 0
        self._event = asyncio.Event()
        self.reached = asyncio.Event()
        self.expected = expected

    async def submit(self, query, timeout_s=None):
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        if self.max_inflight >= self.expected:
            self.reached.set()
        await self._event.wait()
        self.inflight -= 1
        self.done += 1
        return {"id": query.get("id"), "rootInfo": {}}

    def release_all(self):
        self._event.set()


async def _drain(n=20):
    for _ in range(n):
        await asyncio.sleep(0)


@pytest.fixture
async def gid(db):
    """创建对局（position_analyses 外键依赖）。"""
    return await repos.create_game(db.conn, mode="human_human", board_size=9)


class TestSchedulerPriority:
    """优先级出队（P0 对弈 > P1 标准 > P2 深度/支招 > P3 全局）。"""

    async def test_priority_order(self, db, gid):
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        # 先全部入队（worker 未启动），再启动按优先级出队；
        # 注：本用例测**出队顺序**，各任务用不同局面键（同键会被在途合并，非本用例语义）
        await svc.submit(gid, "main:1", _query(80))   # P1
        await svc.submit(gid, "main:2", _query(10))   # P3
        await svc.submit(gid, "main:3", _query(100))  # P0
        await svc.submit(gid, "main:4", _query(50))   # P2
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert engine.order == [100, 80, 50, 10]

    async def test_same_priority_fifo(self, db, gid):
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        # 同优先级先提交者先（不同局面键；同键合并语义见 TestSchedulerInflightMerge）
        await svc.submit(gid, "main:1", _query(80))
        await svc.submit(gid, "main:2", _query(80))
        await svc.submit(gid, "main:3", _query(80))
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert engine.order == [80, 80, 80]


class TestSchedulerConcurrency:
    """并发上限。"""

    async def test_concurrency_limit(self, db, gid):
        engine = GateEngine(expected=2)
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=2)
        await svc.start()
        for i in range(4):
            await svc.submit(gid, f"main:{i}", _query(80))
        await asyncio.wait_for(engine.reached.wait(), timeout=2)
        assert engine.max_inflight == 2  # 并发上限 2
        engine.release_all()
        await svc._queue.join()
        await svc.stop()
        assert engine.done == 4


class TestSchedulerExpiry:
    """过期任务丢弃（局面版本号）。"""

    async def test_expired_task_discarded(self, db, gid):
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        pushed = []
        await svc.submit(gid, "main:1", _query(80), on_result=lambda k, r: pushed.append(k))
        svc.bump_version(gid)  # 局面变化 → 旧任务过期
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert pushed == []
        assert engine.order == []  # 未向引擎提交

    async def test_result_after_version_change_not_cached(self, db, gid):
        """任务提交后局面变化：结果不写库（过期丢弃）。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        await svc.submit(gid, "main:1", _query(80))
        svc.bump_version(gid)
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert await repos.get_main_analysis(db.conn, gid, 1) is None

    async def test_expired_task_notifies_on_drop(self, db, gid):
        """过期任务必须通知 ``on_drop("expired")``（2026/09/11 修复）。

        缺陷：旧实现在出队/结果两处过期判断处**静默** ``continue`` → 注册了
        ``on_drop`` 的调用方（结算预判）状态永不复位、无任何降级反馈（面板永久
        停在“AI 正在分析终局局面”）。
        """
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        drops: list[str] = []

        async def on_drop(reason: str) -> None:
            drops.append(reason)

        # ① 出队前即过期（悔棋/重开）
        await svc.submit(gid, "main:1", _query(80), on_drop=on_drop)
        svc.bump_version(gid)
        await svc.start()
        await asyncio.wait_for(svc._queue.join(), timeout=2)
        await svc.stop()
        assert drops == ["expired"]
        assert engine.order == []  # 过期任务未向引擎提交

    async def test_result_after_expiry_notifies_on_drop(self, db, gid):
        """② 提交后、结果返回前局面变化（悔棋）→ 结果丢弃并通知 ``on_drop``。"""
        engine = GateEngine(expected=1)
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        drops: list[str] = []

        async def on_drop(reason: str) -> None:
            drops.append(reason)

        await svc.submit(gid, "main:1", _query(80), on_drop=on_drop)
        await svc.start()
        await asyncio.wait_for(engine.reached.wait(), timeout=2)  # 引擎已在处理
        svc.bump_version(gid)  # 局面变化 → 结果到达时过期
        engine.release_all()
        await asyncio.wait_for(svc._queue.join(), timeout=2)
        await svc.stop()
        assert drops == ["expired"]
        assert await repos.get_main_analysis(db.conn, gid, 1) is None


class TestStaleWriteGuard:
    """M-5：过期检查与落库非原子——写后复核 + 补偿删除（防陈旧链行复活）。"""

    async def test_version_change_inside_write_removes_row(self, db, gid, monkeypatch):
        """版本号在**写锁事务内/实际写入时刻**变化 → 写后复核删除本轮写入。

        模拟竞态：结果到达检查已通过，悔棋/重开（版本递增）与落库交错。
        缺陷形态（旧实现）：检查→存储（含 await）非原子，已撤销局面的陈旧分析
        行仍会写库（后续点评/链数据使用错误数据；补偿层修复后行被删除）。
        """
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        orig_upsert_one = repos._upsert_one

        async def bump_before_write(conn, *, game_id, position_key, data_json, max_visits, ts):
            svc.bump_version(game_id)  # 写锁事务内、写入前一刻的悔棋/重开
            return await orig_upsert_one(
                conn,
                game_id=game_id,
                position_key=position_key,
                data_json=data_json,
                max_visits=max_visits,
                ts=ts,
            )

        monkeypatch.setattr(repos, "_upsert_one", bump_before_write)
        await svc.start()
        await svc.submit(gid, "main:1", _query(80))
        await asyncio.wait_for(svc._queue.join(), timeout=2)
        await svc.stop()
        # 旧实现：行已写入且无人删除（断言失败）；修复后：写后复核补偿删除
        assert await repos.get_main_analysis(db.conn, gid, 1) is None

    async def test_concurrent_task_write_unaffected(self, db, gid):
        """补偿删除不得误伤后续正常写入（条件删除按「本轮写入指纹」限定）。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        await svc.start()
        await svc.submit(gid, "main:1", _query(80))
        await asyncio.wait_for(svc._queue.join(), timeout=2)
        await svc.stop()
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert row is not None, "版本未变化时写入必须保留"


class TestStopDrain:
    """L-12：`stop()` 对遗弃任务（队列中/被取消在途）回投终态（丢弃=终态契约）。"""

    async def test_stop_notifies_queued_tasks(self, db, gid):
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        drops: list[str] = []
        await svc.submit(gid, "main:1", _query(80), on_drop=lambda r: drops.append(r))
        await svc.stop()  # 未启动 worker：任务遗弃在队列
        assert drops == ["shutdown"]
        assert svc._inflight == {}
        assert engine.order == []  # 未提交引擎

    async def test_stop_notifies_cancelled_inflight(self, db, gid):
        engine = GateEngine(expected=1)
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        drops: list[str] = []
        await svc.submit(gid, "main:1", _query(80), on_drop=lambda r: drops.append(r))
        await svc.start()
        await asyncio.wait_for(engine.reached.wait(), timeout=2)
        await svc.stop()  # 处理中被取消 → 同样回投终态
        assert drops == ["shutdown"]
        assert svc._inflight == {}


class TestSchedulerGameRemoved:
    """对局删除后回包结果丢弃（防级联落库失败，2026/09/13）。

    背景：删除对局时在途/排队的分析任务无属主；结果回包若直接 ingest 会命中
    position_analyses → games 外键约束（IntegrityError + ERROR traceback）。
    统一在 worker 两处检查点按 ``expired`` 丢弃（调用方复位语义复用）。
    """

    async def test_task_dropped_when_game_deleted_before_engine(self, db, gid):
        """排队期间对局被删：不进引擎、通知 on_drop、不写库。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        drops = []
        await svc.submit(gid, "main:1", _query(80), on_drop=lambda reason: drops.append(reason))
        await repos.delete_game(db.conn, gid)
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert drops == ["expired"]
        assert engine.order == []  # 未向引擎提交（对局已删，无谓查询被拦截）

    async def test_result_dropped_when_game_deleted_after_submit(self, db, gid):
        """引擎回包时对局已删（在途竞态）：不写库、不抛外键异常、通知 on_drop。"""
        engine = GateEngine(expected=1)
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        drops = []
        await svc.submit(gid, "main:1", _query(80), on_drop=lambda reason: drops.append(reason))
        await svc.start()
        await asyncio.wait_for(engine.reached.wait(), timeout=2)  # 任务已通过首检查、进入引擎
        await repos.delete_game(db.conn, gid)
        engine.release_all()
        await svc._queue.join()
        await svc.stop()
        assert drops == ["expired"]
        assert await repos.get_main_analysis(db.conn, gid, 1) is None


class TestSchedulerScopeIsolation:
    """版本域隔离（2026/09/10 修订）：跨域变更不误杀分析任务。

    - 主谱域（``main``）：悔棋/重开递增；
    - 试下域（``trial``）：试下分支落子/撤销递增；
    - 两个域互不影响（试下操作不再误杀排队中的主谱分析）。
    """

    async def test_trial_bump_keeps_main_task(self, db, gid):
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        pushed = []
        await svc.submit(gid, "main:1", _query(80), on_result=lambda k, r: pushed.append(k))
        svc.bump_version(gid, scope="trial")  # 试下分支内容变化 → 主谱任务仍有效
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert pushed == ["main:1"]
        assert await repos.get_main_analysis(db.conn, gid, 1) is not None

    async def test_main_bump_keeps_trial_task(self, db, gid):
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        pushed = []
        await svc.submit(gid, "trial:1:1", _query(80), on_result=lambda k, r: pushed.append(k))
        svc.bump_version(gid)  # 主谱悔棋/重开 → 试下会话任务不受影响
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert pushed == ["trial:1:1"]


class TestSchedulerEngineDown:
    """引擎不可用时任务丢弃（分析类降级）。"""

    async def test_engine_unavailable_dropped(self, db, gid):
        from app.core.errors import AppError, ErrorCode

        class DownEngine(RecordingEngine):
            async def submit(self, query, timeout_s=None):
                raise AppError(ErrorCode.ENGINE_DEAD, "引擎不可用")

        engine = DownEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        pushed = []
        await svc.submit(gid, "main:1", _query(80), on_result=lambda k, r: pushed.append(k))
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert pushed == []
        assert await repos.get_main_analysis(db.conn, gid, 1) is None


class TestSchedulerEngineError:
    """引擎查询抛出非 AppError 异常（BUG-020 回归，2026/09/11）。

    缺陷：worker 未包裹 ``engine.submit`` 的一般异常 → 查询失败使**工作线程整体退出**，
    后续排队任务永不执行（静默丢弃，结算预判/曲线无任何反馈）。
    修复：捕获一般异常 → ``on_drop("engine_error")`` 通知 + continue（worker 存活）。
    """

    async def test_engine_error_notifies_drop_and_worker_survives(self, db, gid):
        class FlakyEngine(RecordingEngine):
            """首次查询抛一般异常，其后照常返回。"""

            def __init__(self):
                super().__init__()
                self.calls = 0

            async def submit(self, query, timeout_s=None):
                self.calls += 1
                if self.calls == 1:
                    raise RuntimeError("引擎管道破裂")
                return await super().submit(query)

        engine = FlakyEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        drops: list[str] = []
        pushed: list[str] = []

        async def on_drop(reason: str) -> None:
            drops.append(reason)

        await svc.submit(gid, "main:1", _query(80), on_drop=on_drop)
        await svc.submit(gid, "main:2", _query(80), on_result=lambda k, r: pushed.append(k))
        await svc.start()
        # 有界等待：worker 若因未捕获异常退出，队列永不 drain → 以超时快速失败（不挂死用例）
        await asyncio.wait_for(svc._queue.join(), timeout=2)
        await svc.stop()
        assert drops == ["engine_error"]          # 失败任务通知丢弃
        assert pushed == ["main:2"]               # worker 存活：后续任务照常完成
        assert await repos.get_main_analysis(db.conn, gid, 2) is not None


class TestResultHandlingFailure:
    """H-4 回归（2026-09-19 代码审查）：结果处理失败必须回投 drop 终态。

    旧实现 ``_handle_result`` 抛错只记日志（不扇出结果/不通知丢弃）——等待者
    （结算预判/复盘 Future）永久悬挂且 ``_inflight`` 登记泄漏。修复：异常分支补
    ``_notify_drop(task, "engine_error")``（恰好一次终态）。
    """

    async def test_ingest_failure_notifies_drop_and_releases_inflight(self, db, gid):
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        results: list[str] = []
        drops: list[str] = []
        calls = {"n": 0}
        orig_ingest = svc.ingest_result

        async def flaky_ingest(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("模拟落库失败（如删除竞态外键违约）")
            return await orig_ingest(*args, **kwargs)

        svc.ingest_result = flaky_ingest  # type: ignore[method-assign]
        await svc.submit(
            gid, "main:1", _query(80),
            on_result=lambda k, r: results.append(k),
            on_drop=lambda reason: drops.append(reason),
        )
        await svc.submit(gid, "main:2", _query(80), on_result=lambda k, r: results.append(k))
        await svc.start()
        # 有界等待：worker 若挂死 → 超时快失败（不挂死用例）
        await asyncio.wait_for(svc._queue.join(), timeout=2)
        await svc.stop()
        assert drops == ["engine_error"]   # 失败任务通知丢弃（旧实现：空）
        assert results == ["main:2"]       # worker 存活：后续任务照常完成
        assert svc._inflight == {}         # 在途登记回收（旧实现：main:1 条目泄漏）


class TestSchedulerInflightMerge:
    """在途合并（幂等，2026/09/12 契约根治）：同局面 + 同存储语义 + 同精度 +
    同版本 → 队列/执行中任务只保留 **1 个**，所有订阅者回调扇出；
    异 kind（链/深算，BUG-026）/异精度/版本变化 → 不合并。"""

    async def test_same_key_merged_single_query(self, db, gid):
        """同键重复提交 → 只消耗一次引擎查询，全部订阅者收到结果。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        await svc.start()
        try:
            got: list[str] = []

            async def cb_a(_k, _r):
                got.append("a")

            async def cb_b(_k, _r):
                got.append("b")

            await svc.submit(gid, "main:1", _query(80), on_result=cb_a)
            await svc.submit(gid, "main:1", _query(80), on_result=cb_b)
            await asyncio.wait_for(svc._queue.join(), timeout=2)
            assert engine.order == [80]          # 只执行一次
            assert got == ["a", "b"]             # 两个订阅者都收到
        finally:
            await svc.stop()

    async def test_submit_after_completion_runs_again(self, db, gid):
        """任务完成后同键重提 → 重新执行（在途登记已释放）。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        await svc.start()
        try:
            await svc.submit(gid, "main:1", _query(80))
            await asyncio.wait_for(svc._queue.join(), timeout=2)
            await svc.submit(gid, "main:1", _query(80))
            await asyncio.wait_for(svc._queue.join(), timeout=2)
            assert engine.order == [80, 80]
        finally:
            await svc.stop()

    async def test_different_kind_not_merged(self, db, gid):
        """链槽 / 深算槽双槽语义（BUG-026）：同键异 kind 不得合并。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        await svc.start()
        try:
            await svc.submit(gid, "main:1", _query(80))
            await svc.submit(gid, "main:1", _query(80), kind="deep")
            await asyncio.wait_for(svc._queue.join(), timeout=2)
            assert engine.order == [80, 80]
        finally:
            await svc.stop()

    async def test_different_max_visits_not_merged(self, db, gid):
        """异精度（链内精度口径，BUG-026）不得合并。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        await svc.start()
        try:
            await svc.submit(gid, "main:1", _query(80, max_visits=100))
            await svc.submit(gid, "main:1", _query(80, max_visits=200))
            await asyncio.wait_for(svc._queue.join(), timeout=2)
            assert engine.order == [80, 80]
        finally:
            await svc.stop()

    async def test_version_change_not_merged(self, db, gid):
        """悔棋/重开（版本号变化）→ 旧任务不吞新请求（新键独立执行）。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        got: list[str] = []

        async def first(_k, _r):
            got.append("first")

        async def second(_k, _r):
            got.append("second")

        await svc.submit(gid, "main:1", _query(80), on_result=first)
        svc.bump_version(gid, "main")  # 在途任务（seq 旧）将被过期丢弃
        await svc.submit(gid, "main:1", _query(80), on_result=second)
        await svc.start()
        await asyncio.wait_for(svc._queue.join(), timeout=2)
        await svc.stop()
        assert got == ["second"]     # 旧任务丢弃、新请求独立完成（未误合并）

    async def test_drop_fans_out_to_all_waiters(self, db, gid):
        """任务被丢弃（引擎异常）→ 全部在途订阅者都收到 on_drop（终态契约基础）。"""
        class BoomEngine:
            def __init__(self):
                self.calls = 0

            async def submit(self, query, timeout_s=None):
                self.calls += 1
                raise RuntimeError("boom")

        engine = BoomEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        await svc.start()
        try:
            drops: list[tuple[str, str]] = []

            async def drop_a(reason: str) -> None:
                drops.append(("a", reason))

            async def drop_b(reason: str) -> None:
                drops.append(("b", reason))

            await svc.submit(gid, "main:1", _query(80), on_drop=drop_a)
            await svc.submit(gid, "main:1", _query(80), on_drop=drop_b)
            await asyncio.wait_for(svc._queue.join(), timeout=2)
            assert engine.calls == 1     # 合并后只执行一次
            assert drops == [("a", "engine_error"), ("b", "engine_error")]
        finally:
            await svc.stop()


class TestThrottle:
    """200ms 时间窗口节流推送（FakeTime，禁硬等待）。"""

    async def test_window_merges_latest(self, fake_time):
        pushed = []

        async def cb(key, payload):
            pushed.append((key, payload))

        pusher = ThrottledPusher(cb, window_s=0.2, sleep=asyncio.sleep)
        pusher.push("g:1", {"v": 1})
        pusher.push("g:1", {"v": 2})
        pusher.push("g:2", {"v": 3})
        assert pushed == []  # 窗口内未推送
        await asyncio.sleep(0.2)
        await _drain()
        assert ("g:1", {"v": 2}) in pushed  # 同 key 只推最新
        assert ("g:2", {"v": 3}) in pushed
        assert len(pushed) == 2

    async def test_flush_direct(self, fake_time):
        pushed = []

        async def cb(key, payload):
            pushed.append((key, payload))

        pusher = ThrottledPusher(cb, window_s=0.2, sleep=asyncio.sleep)
        pusher.push("g:1", {"v": 1})
        await pusher.flush()  # 直接冲刷
        assert pushed == [("g:1", {"v": 1})]


@pytest.fixture
def cache(db):
    return AnalysisCache(db.conn, default_config())


class TestCacheMerge:
    """链槽合并规则 4 情形（maxVisits 大者优先、同值新者替换）。"""

    async def test_larger_max_visits_replaces(self, db, cache, gid):
        await cache.store(gid, "main:1", {"v": "std"}, 100)
        action = await cache.store(gid, "main:1", {"v": "deep"}, 800)
        assert action == "replaced"
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert json.loads(row["data_json"]) == {"v": "deep"}
        assert row["max_visits"] == 800

    async def test_smaller_max_visits_discarded(self, db, cache, gid):
        await cache.store(gid, "main:1", {"v": "deep"}, 800)
        action = await cache.store(gid, "main:1", {"v": "std"}, 100)
        assert action == "discarded"
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert json.loads(row["data_json"]) == {"v": "deep"}

    async def test_same_max_newer_replaces(self, db, cache, gid):
        await cache.store(gid, "main:1", {"v": 1}, 100, updated_at="2026-01-01 00:00:00")
        action = await cache.store(gid, "main:1", {"v": 2}, 100, updated_at="2026-01-02 00:00:00")
        assert action == "replaced"
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert json.loads(row["data_json"]) == {"v": 2}

    async def test_same_max_older_discarded(self, db, cache, gid):
        await cache.store(gid, "main:1", {"v": 2}, 100, updated_at="2026-01-02 00:00:00")
        action = await cache.store(gid, "main:1", {"v": 1}, 100, updated_at="2026-01-01 00:00:00")
        assert action == "discarded"
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert json.loads(row["data_json"]) == {"v": 2}


class TestCacheTrial:
    """试下分支：仅会话缓存不落库；撤销截断。"""

    async def test_trial_session_only_not_persisted(self, db, cache, gid):
        await cache.store(gid, "trial:5:0", {"v": "trial"}, 100)
        assert await repos.get_position_analysis(db.conn, gid, "trial:5:0") is None
        assert cache.get_session("trial:5:0") == {"v": "trial"}

    async def test_trial_merge(self, db, cache, gid):
        await cache.store(gid, "trial:5:0", {"v": 1}, 100)
        action = await cache.store(gid, "trial:5:0", {"v": 2}, 200)
        assert action == "replaced"
        assert cache.get_session("trial:5:0") == {"v": 2}

    async def test_trial_truncate(self, db, cache, gid):
        for n in range(4):
            await cache.store(gid, f"trial:5:{n}", {"n": n}, 100)
        cache.truncate_trial(5, 1)
        assert cache.get_session("trial:5:1") is not None
        assert cache.get_session("trial:5:2") is None
        assert cache.get_session("trial:5:3") is None

    async def test_trial_list(self, db, cache, gid):
        for n in range(3):
            await cache.store(gid, f"trial:5:{n}", {"n": n}, 100)
        items = cache.list_trial(5)
        assert sorted(items.keys()) == [0, 1, 2]
        assert items[1] == {"n": 1}
        assert cache.list_trial(6) == {}  # 其他分支隔离

    async def test_clear_trial(self, db, cache, gid):
        await cache.store(gid, "trial:5:0", {"v": 1}, 100)
        cache.clear_trial(5)
        assert cache.get_session("trial:5:0") is None


class TestCacheDeepSlot:
    """深算槽（BUG-026）：深算结果仅会话有效，作为临时缓存不落盘。"""

    async def test_deep_not_persisted(self, db, cache, gid):
        action = await cache.store(gid, "main:1", {"v": "deep"}, 800, kind="deep")
        assert action == "inserted"
        assert cache.get_deep(gid, "main:1") == {"v": "deep"}
        assert await repos.get_main_analysis(db.conn, gid, 1) is None

    async def test_deep_does_not_overwrite_chain_row(self, db, cache, gid):
        await cache.store(gid, "main:1", {"v": "std"}, 100)
        await cache.store(gid, "main:1", {"v": "deep"}, 800, kind="deep")
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert json.loads(row["data_json"]) == {"v": "std"}
        assert row["max_visits"] == 100
        assert cache.get_deep(gid, "main:1") == {"v": "deep"}

    async def test_deep_keyed_by_game(self, db, cache, gid):
        other = await repos.create_game(db.conn, mode="human_human", board_size=9)
        await cache.store(other, "main:1", {"v": "other"}, 800, kind="deep")
        assert cache.get_deep(gid, "main:1") is None
        assert cache.get_deep(other, "main:1") == {"v": "other"}

    async def test_deep_trial_separate_from_standard(self, db, cache, gid):
        """试下：深算槽与标准槽独立——点评/复弈读标准槽、展示读深算槽。"""
        await cache.store(gid, "trial:5:1", {"v": "std"}, 100)
        await cache.store(gid, "trial:5:1", {"v": "deep"}, 800, kind="deep")
        assert cache.get_session("trial:5:1") == {"v": "std"}
        assert cache.get_deep(gid, "trial:5:1") == {"v": "deep"}
        assert cache.list_trial_with_visits(5) == {1: ({"v": "std"}, 100)}

    async def test_truncate_main_clears_deep(self, db, cache, gid):
        for n in (1, 2, 3):
            await cache.store(gid, f"main:{n}", {"n": n}, 800, kind="deep")
        cache.truncate_main(gid, 2)
        assert cache.get_deep(gid, "main:2") == {"n": 2}
        assert cache.get_deep(gid, "main:3") is None

    async def test_truncate_trial_clears_deep(self, db, cache, gid):
        await cache.store(gid, "trial:5:1", {"n": 1}, 800, kind="deep")
        await cache.store(gid, "trial:5:2", {"n": 2}, 800, kind="deep")
        cache.truncate_trial(5, 1)
        assert cache.get_deep(gid, "trial:5:1") == {"n": 1}
        assert cache.get_deep(gid, "trial:5:2") is None

    async def test_clear_game_clears_deep(self, db, cache, gid):
        await cache.store(gid, "main:1", {"n": 1}, 800, kind="deep")
        await cache.store(gid, "trial:1:0", {"n": 0}, 800, kind="deep")
        cache.clear_game(gid)
        assert cache.get_deep(gid, "main:1") is None
        assert cache.get_deep(gid, "trial:1:0") is None


class TestSchedulerIntegration:
    """调度器 → 缓存落库 集成。"""

    async def test_result_persisted_and_pushed(self, db, gid):
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        pushed = []

        async def cb(key, result):
            pushed.append((key, result))

        await svc.submit(gid, "main:1", _query(80), on_result=cb)
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert pushed and pushed[0][0] == "main:1"
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert row is not None
        assert row["max_visits"] == 100

    async def test_deep_kind_task_session_only(self, db, gid):
        """kind="deep" 任务（深度分析/支招）：入会话深算槽且**不落盘**（BUG-026）。"""
        engine = RecordingEngine()
        svc = AnalysisService(db.conn, default_config(), engine, concurrency=1)
        await svc.submit(gid, "main:1", _query(50), kind="deep")
        await svc.start()
        await svc._queue.join()
        await svc.stop()
        assert svc.cache.get_deep(gid, "main:1") is not None
        assert await repos.get_main_analysis(db.conn, gid, 1) is None
