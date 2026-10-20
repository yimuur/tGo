"""WS 分析类推送组件测试（ws/pushes.py，2026/09/11）。

用例 ID: WS-PUSH-*
- ``AnalysisResultFanout``：单回调槽扇出（单组件异常不影响其余）；
- ``GameCommentPusher``：``main:{N}`` 结果 → ``analysis.comment``（有连接才计算）；
- ``SettlementPredictor``：结算预判（引擎不可用 → ``engine:false``；可用 → 深算
  → 预判死子 + GTP final_score 等价结果）。
"""

from app.db import repos
from app.services.game_service import CreateGameParams
from app.ws.pushes import AnalysisResultFanout, GameCommentPusher, SettlementPredictor


class FakeSession:
    def __init__(self, conns: int = 1) -> None:
        self.msgs: list[tuple[int, dict]] = []
        self.conns = conns

    def game_conn_count(self, game_id: int) -> int:
        return self.conns

    async def broadcast_to_game(self, game_id: int, envelope: dict) -> None:
        self.msgs.append((game_id, envelope))


class FakeReview:
    """按“已落库局面”返回点评（模拟 ``comment_for_move``：需 ``main:{N-1}`` 与 ``main:{N}``）。"""

    def __init__(self, stored: Optional[set[int]] = None, comment: Optional[dict] = None) -> None:
        self.stored = stored if stored is not None else set()
        self.comment = comment
        self.calls: list[tuple[int, int]] = []

    async def comment_for_move(self, game_id: int, move_no: int):
        self.calls.append((game_id, move_no))
        if move_no < 1 or not {move_no - 1, move_no} <= self.stored:
            return None
        if self.comment is not None:
            return dict(self.comment)
        return {
            "move_no": move_no,
            "color": "B",
            "grade": "good",
            "delta_winrate": 1.0,
        }


class FakeAnalysis:
    def __init__(self, available: bool = True) -> None:
        self.engine_available = available
        self.tasks: list[dict] = []

    async def submit(self, game_id, position_key, query, *, on_result=None, on_drop=None, extra=None):
        self.tasks.append(
            {
                "game_id": game_id,
                "position_key": position_key,
                "query": query,
                "on_result": on_result,
                "on_drop": on_drop,
                "extra": extra or {},
            }
        )


async def _no_sleep(_delay: float) -> None:
    """测试用：补推重试不实际等待（AGENTS.md §7 禁真实等待）。"""


class TestAnalysisResultFanout:
    async def test_fanout_calls_all_sinks(self):
        calls = []

        async def sink_a(game_id, key, data):
            calls.append(("a", game_id, key))

        async def sink_b(game_id, key, data):
            calls.append(("b", game_id, key))

        fanout = AnalysisResultFanout(sink_a, sink_b)
        await fanout(7, "main:1", {})
        assert calls == [("a", 7, "main:1"), ("b", 7, "main:1")]

    async def test_sink_exception_does_not_break_others(self):
        calls = []

        async def bad(game_id, key, data):
            raise RuntimeError("boom")

        async def good(game_id, key, data):
            calls.append("good")

        fanout = AnalysisResultFanout(bad, good)
        await fanout(1, "main:0", {})
        assert calls == ["good"]


class TestGameCommentPusher:
    def _make(self, stored=None, comment=None, conns: int = 1):
        review = FakeReview(stored, comment)
        session = FakeSession(conns)
        pusher = GameCommentPusher(
            review, session, retry_delays_s=(0.0,), sleep=_no_sleep
        )
        return review, session, pusher

    async def test_pushes_comment_for_main_position(self):
        comment = {"move_no": 3, "color": "B", "grade": "blunder", "delta_winrate": -15.0}
        review, session, pusher = self._make({2, 3}, comment)
        await pusher.on_result(5, "main:3", {})
        await pusher.wait_retries()
        assert review.calls == [(5, 3)]  # 派生成功 → 不触发补推重试
        assert session.msgs == [
            (5, {"type": "analysis.comment", "data": comment}),
        ]

    async def test_skips_without_connections(self):
        review, session, pusher = self._make({0, 1}, {"move_no": 1}, conns=0)
        await pusher.on_result(5, "main:1", {})
        assert review.calls == [] and session.msgs == []

    async def test_skips_trial_and_initial_position(self):
        """试下键不参与；``main:0`` 自身无点评（不入候选）。"""
        review, session, pusher = self._make({0, 1}, {"move_no": 1})
        await pusher.on_result(5, "trial:1:2", {})
        await pusher.on_result(5, "main:0", {})
        assert review.calls == [] and session.msgs == []

    async def test_no_comment_no_push(self):
        review, session, pusher = self._make()
        await pusher.on_result(5, "main:2", {})
        await pusher.wait_retries()
        # 首次派生失败 → 后台补推重试（同机重试仍无点评）→ 不推送
        assert review.calls == [(5, 2), (5, 2)] and session.msgs == []

    async def test_late_predecessor_backfills_comment(self):
        """前序在途补推（BUG-028）：``main:1`` 先到、``main:0`` 尚未落库（首手并发
        竞态）→ 派生失败；后台重试时前序已落库 → 补推第 1 手点评。"""
        review, session, pusher = self._make(stored={1})  # main:0 尚未落库
        await pusher.on_result(5, "main:1", {})
        assert session.msgs == []  # 缺前序 root → 派生失败
        review.stored.add(0)  # 前序局面随后落库（重试窗口内）
        await pusher.wait_retries()
        assert [m["data"]["move_no"] for _, m in session.msgs] == [1]

    async def test_no_duplicate_when_predecessor_arrives_late(self):
        """不重复推送（BUG-028 回归）：两局面并发到达顺序任意，评论只推一次。"""
        review, session, pusher = self._make({0, 1}, {"move_no": 1})
        await pusher.on_result(5, "main:0", {})  # 首手初始局面（自身无点评）
        await pusher.on_result(5, "main:1", {})
        await pusher.wait_retries()
        assert len(session.msgs) == 1  # 第 1 手点评恰一条

        review2, session2, pusher2 = self._make({0, 1}, {"move_no": 1})
        await pusher2.on_result(5, "main:1", {})  # 逆序：先 main:1 后 main:0
        await pusher2.on_result(5, "main:0", {})
        await pusher2.wait_retries()
        assert len(session2.msgs) == 1


class TestSettlementPredictorEngineUnavailable:
    async def test_engine_unavailable_pushes_degraded(self, api_svc):
        """引擎不可用 → 直接推 ``engine:false``（前端转人工标记，结算不阻断）。"""
        gid = await api_svc.game.create(CreateGameParams())
        session = FakeSession()
        predictor = SettlementPredictor(
            api_svc.db.conn, api_svc.config, FakeAnalysis(False), session
        )
        await predictor.predict(gid)
        assert session.msgs
        _, envelope = session.msgs[-1]
        assert envelope["type"] == "scoring.prediction"
        data = envelope["data"]
        assert data["engine"] is False
        assert data["reason"] == "engine_unavailable"
        assert data["dead_points"] == [] and data["result"] is None
        # 连接/恢复回投：最近一次预判（move_no 匹配）
        assert predictor.last_prediction(gid, move_no=0) == data
        assert predictor.last_prediction(gid, move_no=9) is None


class TestSettlementPredictorForget:
    """L-6：对局删除后预判内存态回收；降级回投不得复活已删对局条目。"""

    async def test_forget_game_clears_last_and_running(self, api_svc):
        predictor = SettlementPredictor(
            api_svc.db.conn, api_svc.config, FakeAnalysis(False), FakeSession()
        )
        gid = await api_svc.game.create(CreateGameParams())
        predictor._last[gid] = {"move_no": 0}
        predictor._running.add(gid)
        predictor.forget_game(gid)
        assert predictor.last_prediction(gid) is None
        assert gid not in predictor._running

    async def test_drop_after_game_deleted_does_not_revive(self, api_svc):
        """drop 回投前对局已删 → 不推降级载荷、不复活 `_last`（旧实现重写回）。"""
        captured: dict = {}

        class CaptureAnalysis:
            engine_available = True

            async def submit(self, game_id, position_key, query, *, on_result=None, on_drop=None):
                captured["on_drop"] = on_drop

        session = FakeSession()
        predictor = SettlementPredictor(
            api_svc.db.conn, api_svc.config, CaptureAnalysis(), session
        )
        gid = await api_svc.game.create(CreateGameParams())
        await predictor.predict(gid)
        assert captured.get("on_drop") is not None
        await repos.delete_game(api_svc.db.conn, gid)
        await captured["on_drop"]("engine_error")
        assert predictor.last_prediction(gid) is None  # 未复活
        assert gid not in predictor._running
        assert session.msgs == []  # 未推降级载荷


class TestSettlementPredictorEngineAvailable:
    async def test_predict_uses_deep_query_and_pushes(self, api_svc):
        """引擎可用 → 提交终局深算（deepVisits）→ 推送预判（双 PASS 精确数子）。"""
        gid = await api_svc.game.create(CreateGameParams())
        await api_svc.game.pass_move(gid, color="B")
        await api_svc.game.pass_move(gid, color="W")  # 双 PASS → SCORING
        session = FakeSession()
        analysis = FakeAnalysis(True)
        predictor = SettlementPredictor(api_svc.db.conn, api_svc.config, analysis, session)
        await predictor.predict(gid)
        task = analysis.tasks[-1]
        assert task["position_key"] == "main:2"
        assert task["query"]["maxVisits"] == api_svc.config.engine.deep_max_visits
        assert task["query"]["includeOwnership"] is True
        # 模拟深算结果到达（FakeManager 响应含 ownership + scoreLead）
        await task["on_result"](
            "main:2", {"rootInfo": {"winrate": 0.6, "scoreLead": 2.0}, "ownership": [0.9] * 361}
        )
        data = predictor.last_prediction(gid, move_no=2)
        assert data["engine"] is True and data["finished"] is True
        assert data["result"] is not None
        assert isinstance(data["dead_points"], list)
        assert session.msgs[-1][1]["type"] == "scoring.prediction"

    async def test_predict_skips_after_undo(self, api_svc):
        """局面已变化（悔棋）→ 预判失效不推送。"""
        gid = await api_svc.game.create(CreateGameParams())
        await api_svc.game.play(gid, x=3, y=3, color="B")
        await api_svc.game.play(gid, x=15, y=15, color="W")
        session = FakeSession()
        analysis = FakeAnalysis(True)
        predictor = SettlementPredictor(api_svc.db.conn, api_svc.config, analysis, session)
        await predictor.predict(gid)
        await api_svc.game.undo(gid, color="B")  # 局面回退 → last_move_no 变化
        task = analysis.tasks[-1]
        await task["on_result"](
            "main:2", {"rootInfo": {"winrate": 0.6, "scoreLead": 2.0}, "ownership": [0.9] * 361}
        )
        assert session.msgs == []

    async def test_engine_drop_pushes_degraded(self, api_svc):
        """引擎查询失败（on_drop）→ 降级推送 ``engine:false``。"""
        gid = await api_svc.game.create(CreateGameParams())
        await api_svc.game.pass_move(gid, color="B")
        session = FakeSession()
        analysis = FakeAnalysis(True)
        predictor = SettlementPredictor(api_svc.db.conn, api_svc.config, analysis, session)
        await predictor.predict(gid)
        await analysis.tasks[-1]["on_drop"]("engine_error")
        data = predictor.last_prediction(gid)
        assert data["engine"] is False and data["reason"] == "engine_error"

    async def test_duplicate_predict_ignored_while_running(self, api_svc):
        gid = await api_svc.game.create(CreateGameParams())
        analysis = FakeAnalysis(True)
        predictor = SettlementPredictor(api_svc.db.conn, api_svc.config, analysis, FakeSession())
        await predictor.predict(gid)
        await predictor.predict(gid)
        assert len(analysis.tasks) == 1

    async def test_expired_task_resets_running_without_push(self, api_svc):
        """过期丢弃（``on_drop("expired")``）→ 不推降级载荷，且**复位进行中标记**。

        2026/09/11：旧实现 silent drop 使 ``_running`` 永不复位 → 该对局此后
        再进结算也永不预判（面板永久“AI 正在分析终局局面”）。
        """
        gid = await api_svc.game.create(CreateGameParams())
        await api_svc.game.pass_move(gid, color="B")
        await api_svc.game.pass_move(gid, color="W")  # 双 PASS → SCORING
        session = FakeSession()
        analysis = FakeAnalysis(True)
        predictor = SettlementPredictor(api_svc.db.conn, api_svc.config, analysis, session)
        await predictor.predict(gid)
        assert len(analysis.tasks) == 1

        await api_svc.game.cancel_scoring(gid)  # 结算取消 → 回到对弈
        await api_svc.game.undo(gid, color="W")  # 悔棋 → 主谱版本递增（任务过期）
        await analysis.tasks[-1]["on_drop"]("expired")
        assert session.msgs == []                      # 不推降级载荷
        assert predictor.last_prediction(gid) is None  # 无预判

        # 再次进入结算：边界后需**两个新 PASS**（BUG-025）；幂等标记已复位可重新提交
        r1 = await api_svc.game.pass_move(gid, color="W")   # 补回被撤的一手（边界内 → 不入结算）
        assert r1.entering_scoring is False
        r2 = await api_svc.game.pass_move(gid, color="B")   # 第二个新 PASS → 双 PASS 入结算
        assert r2.entering_scoring is True
        await predictor.predict(gid)
        assert len(analysis.tasks) == 2
