"""T3.10 深度分析 / 全局分析测试（TASK T3.10 / PRD §4.2.6/§4.2.7 / API §4.3）。

用例 ID: REVIEW-DEEP-* / REVIEW-GLOBAL-*
- 深度分析：deep.max_visits、{move_no}/{position_key} 路由、进行中互斥；
- 全局分析：逐手补写缺失、进度、可中断续跑、中断保留已完成手；
- analysis_complete 覆盖率推导；引擎不可用降级。
"""

import asyncio
import json

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.analysis_service import AnalysisService
from app.services.game_service import GameService
from app.services.review_service import ReviewService


class MockEngine:
    """即时完成的分析引擎 mock。"""

    def __init__(self):
        self.queries: list[dict] = []

    async def submit(self, query, timeout_s=None):
        self.queries.append(query)
        return {
            "id": query.get("id"),
            "rootInfo": {"currentPlayer": "B", "winrate": 0.6, "scoreLead": 3.0},
            "moveInfos": [],
        }


class BlockingEngine:
    """阻塞引擎：可手动放行（深度互斥/全局中断测试）。"""

    def __init__(self, block_from: int = 1):
        self.block_from = block_from
        self.submits = 0
        self.release = asyncio.Event()
        self.blocked = asyncio.Event()  # 进入阻塞时置位（供测试事件同步，杜绝时序依赖）
        self.queries: list[dict] = []

    async def submit(self, query, timeout_s=None):
        self.submits += 1
        self.queries.append(query)
        if self.submits >= self.block_from:
            self.blocked.set()
            await self.release.wait()
        return {
            "id": query.get("id"),
            "rootInfo": {"currentPlayer": "B", "winrate": 0.6, "scoreLead": 3.0},
            "moveInfos": [],
        }


async def _mk_game(db, *, moves=None, gsvc=None):
    from app.services.game_service import CreateGameParams, PlayerInfo

    svc = gsvc or GameService(db.conn, default_config(), human_model_available=True)
    gid = await svc.create(
        CreateGameParams(
            mode="human_human",
            board_size=19,
            komi=7.5,
            black=PlayerInfo(name="张三", rank="rank_5k"),
            white=PlayerInfo(name="李四", rank="rank_1k"),
        )
    )
    for i, (c, x, y) in enumerate(moves or [], start=1):
        await svc.play(gid, x=x, y=y, color=c)
    return gid


async def _store_analysis(db, gid, move_no, data, max_visits=100):
    await repos.upsert_position_analysis(
        db.conn, game_id=gid, position_key=f"main:{move_no}",
        data_json=json.dumps(data), max_visits=max_visits,
    )


@pytest.fixture
async def review_ctx(db):
    """已启动调度器的复盘上下文（含 MockEngine）。"""
    engine = MockEngine()
    analysis = AnalysisService(db.conn, default_config(), engine=engine, concurrency=2)
    await analysis.start()
    game_svc = GameService(db.conn, default_config(), human_model_available=True)
    review = ReviewService(
        db.conn, default_config(), game_service=game_svc, analysis=analysis
    )
    try:
        yield review, analysis, engine, game_svc
    finally:
        await analysis.stop()


class TestDeep:
    """深度分析（BUG-026：深算结果仅会话有效，不落盘）。"""

    async def test_deep_analyze_main(self, review_ctx, db):
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        result = await review.deep_analyze(gid, move_no=1)
        assert result["rootInfo"]["winrate"] == 0.6
        query = engine.queries[-1]
        assert query["maxVisits"] == default_config().engine.deep_max_visits
        assert query["priority"] == 50  # P2
        # BUG-026：深算结果仅入会话深算槽，**不落盘**
        assert analysis.cache.get_deep(gid, "main:1") is not None
        assert await repos.get_main_analysis(db.conn, gid, 1) is None

    async def test_deep_does_not_break_chain_delta(self, review_ctx, db):
        """深算不覆盖链行：点评仍由链槽（同精度）计算；展示读取优先深算槽。"""
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        await _store_analysis(db, gid, 0, {"rootInfo": {"winrate": 0.5, "scoreLead": 0.0}})
        await _store_analysis(db, gid, 1, {"rootInfo": {"winrate": 0.4, "scoreLead": -2.0}})
        await review.deep_analyze(gid, move_no=1)
        rec = await review.recommend(gid, move_no=1)
        # 展示 root 来自深算槽（0.6），点评 ΔW 仍由链槽（0.5→0.4，落子方黑）计算
        assert rec["root"]["winrate"] == 60.0
        assert rec["comment"]["delta_winrate"] == -10.0

    async def test_ownership_prefers_deep_slot(self, review_ctx, db):
        """领地展示优先会话深算槽（不落盘），无深算时回退链槽。"""
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        await _store_analysis(db, gid, 1, {"rootInfo": {}, "ownership": [1.0]})
        before = await review.ownership(gid, move_no=1)
        assert before["ownership"] == [1.0]
        # 深算槽写入后 → 展示优先深算值（同步验证不落盘）
        await analysis.cache.store(
            gid, "main:1", {"rootInfo": {}, "ownership": [0.1, 0.9]},
            default_config().engine.deep_max_visits, kind="deep",
        )
        after = await review.ownership(gid, move_no=1)
        assert after["ownership"] == [0.1, 0.9]
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert json.loads(row["data_json"])["ownership"] == [1.0]  # 链行未被覆盖

    async def test_deep_analyze_default_current(self, review_ctx, db):
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        await review.deep_analyze(gid)  # 缺省 = 当前局面
        query = engine.queries[-1]
        assert len(query["moves"]) == 2

    async def test_deep_analyze_move_out_of_range(self, review_ctx, db):
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=gsvc)
        with pytest.raises(AppError) as ei:
            await review.deep_analyze(gid, move_no=99)
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_deep_analyze_trial_session_only(self, review_ctx, db):
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        trial_id = await review.trial_enter(gid, 1)
        await review.trial_play(gid, trial_id, x=4, y=4, color="W")
        result = await review.deep_analyze(gid, position_key=f"trial:{trial_id}:1")
        assert result is not None
        # 试下分支仅会话缓存，不落库；深算入深算槽（展示优先），标准槽不被顶替
        key = f"trial:{trial_id}:1"
        assert analysis.cache.get_deep(gid, key) is not None
        assert await repos.get_position_analysis(db.conn, gid, key) is None

    async def test_trial_deep_not_exported_by_replay(self, review_ctx, db):
        """复弈批量落盘仅复制试下**标准槽**（深算槽不得进入新对局链，BUG-026）。"""
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        trial_id = await review.trial_enter(gid, 1)
        await review.trial_play(gid, trial_id, x=4, y=4, color="W")
        key = f"trial:{trial_id}:1"
        await analysis.cache.store(gid, key, {"v": "std"}, 100)
        await analysis.cache.store(gid, key, {"v": "deep"}, 800, kind="deep")
        new_id = await review.replay_trial(gid, trial_id)
        row = await repos.get_main_analysis(db.conn, new_id, 2)
        # 复弈落盘的是试下标准槽（max_visits=100）；深算标记不得进入新对局链
        assert row["max_visits"] == 100
        assert json.loads(row["data_json"]) != {"v": "deep"}

    async def test_replay_inherits_frozen_chain_visits(self, review_ctx, db):
        """复弈新局继承源对局**冻结的链精度**（BUG-026）：不得重新按“当前配置”计算，
        否则新局链内混配（批量复制的前导链行为源局精度）。"""
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        trial_id = await review.trial_enter(gid, 1)
        await review.trial_play(gid, trial_id, x=4, y=4, color="W")
        # 管理页热更新（当前配置变化）→ 复弈新局仍继承源局冻结值
        gsvc._cfg.engine.standard_max_visits = 500
        review._cfg.engine.standard_max_visits = 500
        new_id = await review.replay_trial(gid, trial_id)
        new_game = await repos.get_game(db.conn, new_id)
        source = await repos.get_game(db.conn, gid)
        assert int(new_game["chain_visits"]) == int(source["chain_visits"]) == 100

    async def test_deep_mutex(self, db):
        """进行中互斥：DEEP_ANALYSIS_RUNNING。"""
        engine = BlockingEngine(block_from=1)
        analysis = AnalysisService(db.conn, default_config(), engine=engine, concurrency=1)
        await analysis.start()
        game_svc = GameService(db.conn, default_config(), human_model_available=True)
        review = ReviewService(
            db.conn, default_config(), game_service=game_svc, analysis=analysis
        )
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        task = asyncio.create_task(review.deep_analyze(gid, move_no=1))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        with pytest.raises(AppError) as ei:
            await review.deep_analyze(gid, move_no=1)
        assert ei.value.code is ErrorCode.DEEP_ANALYSIS_RUNNING
        engine.release.set()
        await asyncio.wait_for(task, timeout=2)
        # 完成后可再次深算
        await review.deep_analyze(gid, move_no=1)
        await analysis.stop()

    async def test_deep_engine_unavailable(self, db):
        from app.services.game_service import CreateGameParams, PlayerInfo

        game_svc = GameService(db.conn, default_config(), human_model_available=True)
        review = ReviewService(db.conn, default_config(), game_service=game_svc, analysis=None)
        gid = await _mk_game(db, gsvc=game_svc)
        with pytest.raises(AppError) as ei:
            await review.deep_analyze(gid)
        assert ei.value.code is ErrorCode.ENGINE_DEAD


class TestGlobal:
    """全局分析。"""

    async def test_global_fills_missing(self, review_ctx, db):
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)], gsvc=gsvc)
        await _store_analysis(db, gid, 1, {"rootInfo": {}})  # 仅 main:1 已有
        result = await review.global_analyze(gid)
        assert result["done"] == 3  # 补 0,2,3
        assert result["total"] == 3
        assert result["finished"] is True
        assert result["interrupted"] is False
        # 覆盖率提升 → 报告入口显示
        assert await review.analysis_complete(gid) is True
        # P3 优先级
        assert all(q["priority"] == 10 for q in engine.queries[-3:])

    async def test_global_already_complete(self, review_ctx, db):
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=gsvc)
        await _store_analysis(db, gid, 0, {"rootInfo": {}})
        await _store_analysis(db, gid, 1, {"rootInfo": {}})
        result = await review.global_analyze(gid)
        assert result["total"] == 0
        assert result["finished"] is True

    async def test_global_skips_position_filled_during_loop(self, review_ctx, db, monkeypatch):
        """L-12：循环期间其他路径补齐的局面逐手复核后跳过（旧实现快照分支不可达）。"""
        review, _analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)], gsvc=gsvc)
        orig = repos.get_main_analysis

        async def faked(conn, game_id, move_no):
            if game_id == gid and move_no == 2:
                return {"max_visits": 100}  # 模拟循环期间被后台补齐（链精度）
            return await orig(conn, game_id, move_no)

        monkeypatch.setattr(repos, "get_main_analysis", faked)
        seen: list[int] = []

        async def on_progress(done, total):
            seen.append(done)

        result = await review.global_analyze(gid, on_progress=on_progress)
        assert result["done"] == 4 and result["total"] == 4
        assert len(engine.queries) == 3, "main:2 应被跳过（旧实现仍会提交）"
        assert seen[-1] == 4, "跳过同样计入进度"

    async def test_global_interrupt_resume(self, db):
        """可中断续跑：中断保留已完成手，续跑从覆盖率继续。"""
        engine = BlockingEngine(block_from=2)  # 第二手起阻塞
        analysis = AnalysisService(db.conn, default_config(), engine=engine, concurrency=1)
        await analysis.start()
        game_svc = GameService(db.conn, default_config(), human_model_available=True)
        review = ReviewService(
            db.conn, default_config(), game_service=game_svc, analysis=analysis
        )
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)], gsvc=game_svc)
        task = asyncio.create_task(review.global_analyze(gid))
        # 事件同步：等待第二手进入阻塞（替换真实 sleep，杜绝时序依赖）
        await asyncio.wait_for(engine.blocked.wait(), timeout=3)
        review.global_analyze_cancel(gid)
        engine.release.set()
        result = await asyncio.wait_for(task, timeout=3)
        assert result["interrupted"] is True
        assert result["done"] >= 1
        # 已完成手保留
        covered = await repos.analysis_coverage(db.conn, gid, 3)
        assert covered == result["done"]
        # 续跑：仅补剩余缺失
        result2 = await review.global_analyze(gid)
        assert await review.analysis_complete(gid) is True
        assert result2["done"] == 4 - covered
        await analysis.stop()

    async def test_global_uses_frozen_chain_visits(self, review_ctx, db):
        """全局分析（补分析）按**冻结链精度**补写（BUG-026）：管理页热更新不影响。"""
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        review._cfg.engine.standard_max_visits = 500  # 管理页热更新
        await review.global_analyze(gid)
        assert engine.queries and all(q["maxVisits"] == 100 for q in engine.queries)

    async def test_global_engine_unavailable(self, db):
        from app.services.game_service import CreateGameParams, PlayerInfo

        game_svc = GameService(db.conn, default_config(), human_model_available=True)
        review = ReviewService(db.conn, default_config(), game_service=game_svc, analysis=None)
        gid = await _mk_game(db, gsvc=game_svc)
        with pytest.raises(AppError) as ei:
            await review.global_analyze(gid)
        assert ei.value.code is ErrorCode.ENGINE_DEAD


class TestCoverage:
    """分析覆盖率推导。"""

    async def test_analysis_complete_true(self, review_ctx, db):
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        for k in (0, 1, 2):
            await _store_analysis(db, gid, k, {"rootInfo": {}})
        assert await review.analysis_complete(gid) is True

    async def test_analysis_complete_false(self, review_ctx, db):
        review, analysis, engine, gsvc = review_ctx
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        await _store_analysis(db, gid, 0, {"rootInfo": {}})  # main:1/2 缺失
        assert await review.analysis_complete(gid) is False


class TestReviewDropTerminal:
    """H-3 回归（2026-09-19 代码审查）：任务被丢弃时 ``_submit_and_wait`` 必须立即回投终态。

    旧实现未注册 ``on_drop``：引擎故障/局面过期只能等满 ``DEEP_ANALYSIS_TIMEOUT_S``
    （300s）超时——全局分析逐手循环下每缺口 300s，UI 长时间“分析中”。
    修复：按丢弃原因回投 ``ENGINE_DEAD``（引擎类）/``ENGINE_BUSY``（过期）。
    """

    async def test_engine_drop_returns_terminal_error_fast(self, db):
        class FailingEngine:
            async def submit(self, query, timeout_s=None):
                raise RuntimeError("引擎管道破裂")

        analysis = AnalysisService(
            db.conn, default_config(), engine=FailingEngine(), concurrency=1
        )
        await analysis.start()
        game_svc = GameService(db.conn, default_config(), human_model_available=True)
        review = ReviewService(
            db.conn, default_config(), game_service=game_svc, analysis=analysis
        )
        try:
            gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
            with pytest.raises(AppError) as ei:
                # 外层有界等待：旧实现拖延到 300s 超时——超时即红相（不挂死用例）
                await asyncio.wait_for(review.deep_analyze(gid, move_no=1), timeout=1)
            assert ei.value.code is ErrorCode.ENGINE_DEAD
        finally:
            await analysis.stop()

    async def test_expired_drop_returns_terminal_error_fast(self, db):
        class GatedEngine:
            def __init__(self):
                self.entered = asyncio.Event()
                self.release = asyncio.Event()

            async def submit(self, query, timeout_s=None):
                self.entered.set()
                await self.release.wait()
                return {"id": query.get("id"), "rootInfo": {}}

        engine = GatedEngine()
        analysis = AnalysisService(db.conn, default_config(), engine=engine, concurrency=1)
        await analysis.start()
        game_svc = GameService(db.conn, default_config(), human_model_available=True)
        review = ReviewService(
            db.conn, default_config(), game_service=game_svc, analysis=analysis
        )
        try:
            gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
            task = asyncio.create_task(review.deep_analyze(gid, move_no=1))
            await asyncio.wait_for(engine.entered.wait(), timeout=1)  # 查询在途
            analysis.bump_version(gid, scope="main")  # 悔棋/重开 → 结果过期
            engine.release.set()
            with pytest.raises(AppError) as ei:
                await asyncio.wait_for(task, timeout=1)
            assert ei.value.code is ErrorCode.ENGINE_BUSY
        finally:
            await analysis.stop()
