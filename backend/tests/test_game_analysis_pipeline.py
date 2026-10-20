"""T6.1/BUG-026 每手链精度分析管线测试（TASK T6.1 / PRD §4.1.6 / ARCHITECTURE §4.2）。

用例 ID: ANA-PIPE-*
- 人人对弈：每手落子后经调度器提交该局面链精度分析（``main:{move_no}``，
  priority=P1、maxVisits=chain_visits）；
- 人机对弈（BUG-026 修订，取代 ISSUE-051 口径）：**链精度 = max(标准, 该局
  对弈精度)**；**精度相等（V_play == 链精度）单查询合并**——AI P0 对弈查询结果
  即该局面链行（落库/推送），不重复提交 P1；**精度不等每步双查询**——AI 对弈
  查询仅用于落子（不落库），AI 落子完成后对该局面补链精度 P1；
- 自适应对局：链精度恒为人类模型最高段位（9D）精度，AI 每手双查询，
  直到 AI 段位匹配到 9D（V_play == 链精度）合并为 P0 单查询；
- 终局补链：进入结算时终局**前一手**仍须补链精度分析（covered 0..N）；
- AI 引擎不可用：不提交逐手分析（降级矩阵）。
"""

from unittest.mock import AsyncMock

from app.config import default_config
from app.db import repos
from app.services.game_service import (
    AiParams,
    CreateGameParams,
    GameService,
    PlayerInfo,
)

#: 标准分析优先级（analysis_query.PRIORITY_STANDARD）
PRIORITY_P1 = 80


def _engine(move_infos=None, error=None):
    """AsyncMock 引擎：记录查询并返回指定 moveInfos 或抛错。"""
    engine = AsyncMock()
    captured = {}

    async def _submit(query, timeout_s=None):
        captured["query"] = query
        if error is not None:
            raise error
        return {"id": query.get("id"), "moveInfos": move_infos or []}

    engine.submit = _submit
    engine.captured = captured
    return engine


def _params(**overrides) -> CreateGameParams:
    base = dict(
        mode="human_human",
        board_size=19,
        rules="chinese",
        komi=7.5,
        handicap=0,
        color="B",
        black=PlayerInfo(name="张三", rank="rank_5k"),
        white=PlayerInfo(name="李四", rank="rank_1k"),
        ai=None,
        coaching=False,
    )
    base.update(overrides)
    return CreateGameParams(**base)


def _ai_params(human_color="B", style="standard", level=5, adaptive=False, human_rank="rank_5k"):
    return _params(
        mode="human_ai",
        color=human_color,
        black=PlayerInfo(name="张三", rank=human_rank) if human_color == "B" else PlayerInfo(name="李四", rank="rank_1k"),
        white=PlayerInfo(name="李四", rank="rank_1k") if human_color == "B" else PlayerInfo(name="张三", rank=human_rank),
        ai=AiParams(style=style, level=level, adaptive=adaptive),
        handicap=0,
        komi=7.5,
    )


def _ai_params_no_rank(human_color="B", style="standard", level=10, adaptive=False):
    """未录入段位 → 手动难度档位原样生效（避免 rank→level 自动匹配改写）。"""
    return _params(
        mode="human_ai",
        color=human_color,
        black=PlayerInfo(name="张三") if human_color == "B" else PlayerInfo(name="李四"),
        white=PlayerInfo(name="李四") if human_color == "B" else PlayerInfo(name="张三"),
        ai=AiParams(style=style, level=level, adaptive=adaptive),
        handicap=0,
        komi=7.5,
    )


class RecordingAnalysis:
    """记录 GameService 对分析服务的调用（submit / ingest_result）。"""

    def __init__(self) -> None:
        self.submitted: list[dict] = []
        self.ingested: list[dict] = []

    def bump_version(self, game_id: int) -> None:
        pass

    def remove_game(self, game_id: int) -> None:
        pass

    async def submit(self, game_id: int, position_key: str, query: dict, **kwargs) -> None:
        self.submitted.append({"game_id": game_id, "key": position_key, "query": query})

    async def ingest_result(
        self,
        game_id: int,
        position_key: str,
        preprocessed: dict,
        max_visits: int,
        *,
        kind: str = "chain",
        stale_check=None,
    ) -> str:
        self.ingested.append(
            {"game_id": game_id, "key": position_key, "max_visits": max_visits}
        )
        return "inserted"


class TestHumanHumanPipeline:
    """人人对弈：每手落子后提交 P1 标准分析。"""

    async def test_each_move_submits_p1(self, db):
        """首手补初始局面 main:0；B/W 各落一手 → main:0/1/2 各一次 P1（priority=P1、standard visits）。"""
        engine = _engine()
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")

        keys = [s["key"] for s in analysis.submitted]
        assert keys == ["main:0", "main:1", "main:2"]
        for s in analysis.submitted:
            q = s["query"]
            assert q["priority"] == PRIORITY_P1
            assert q["maxVisits"] == default_config().engine.standard_max_visits
        assert analysis.ingested == []

    async def test_no_engine_no_pipeline_submit(self, db):
        """引擎不可用（analysis 存在但 engine=None）→ 不提交逐手分析（降级矩阵）。"""
        engine = None
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        assert analysis.submitted == []

    async def test_pipeline_gated_by_analysis_absent(self, db):
        """分析服务未接入（analysis=None）→ 不提交逐手分析。"""
        engine = _engine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        # 引擎收到的唯一查询：无（人人对弈本无 AI 查询）
        assert engine.captured.get("query") is None

    async def test_double_pass_no_submit_entering_scoring(self, db):
        """双 PASS 进入结算：不提交已结束局面的逐手分析。"""
        engine = _engine()
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        await svc.pass_move(gid, color="W")
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "scoring"
        # 首手 PASS：提交初始局面 main:0 + 该局面 main:1；
        # 双 PASS 第二手（进入结算）不提交已结束局面分析
        assert [s["key"] for s in analysis.submitted] == ["main:0", "main:1"]


class TestHumanAiMerge:
    """人机对弈对弈/分析查询合并（BUG-026 修订口径）。

    - 链精度 = max(standard_max_visits, 该局面局参数下的对弈精度)（非自适应）；
    - ``V_play == 链精度``：AI P0 对弈查询与链分析合并为单查询——结果落链槽/
      推送，不重复提交 P1；
    - ``V_play < 链精度``：每步双查询——AI P0 低精度对弈查询仅用于落子
      （不落库），AI 落子后对该局面另补链精度 P1。
    """

    async def test_low_difficulty_double_query_p1(self, db):
        """低难度（level5 V_play=5 < 链精度 100）：AI 查询不落库；AI 落子后对
        main:{H} 补链精度 P1（force_ai_turn），AI 落子局面 main:{H+1} 亦 P1。"""
        engine = _engine([{"move": "Q16", "visits": 100, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", style="standard", level=5))
        result = await svc.play(gid, x=3, y=3, color="B")

        assert result.ai_move is not None  # AI 已落（Q16 = (15,3)）
        assert analysis.ingested == []  # 低精度对弈查询不落库
        # 首手补初始局面 main:0；AI 落子完成后补标准 P1 main:1（force_ai_turn），
        # AI 落子局面 main:2 走 _play 钩子
        keys = [s["key"] for s in analysis.submitted]
        assert sorted(keys) == ["main:0", "main:1", "main:2"]
        for s in analysis.submitted:
            assert s["query"]["maxVisits"] == default_config().engine.standard_max_visits
            assert s["query"]["priority"] == PRIORITY_P1
        # 对弈查询保持档位实际 V_play（M-7：未被分析精度下限抬高）
        assert engine.captured["query"]["maxVisits"] == 5

    async def test_high_difficulty_merged_single_query(self, db):
        """高难度（level10 V_play=200）：链精度提高到 200（同链同精度）——
        单查询合并：AI P0 结果落链槽 main:{H}（maxVisits=200），不重复提交 P1
        main:{H}；人类侧局面（首手 main:0 / AI 落子后 main:{H+1}）按链精度 200。"""
        engine = _engine([{"move": "Q16", "visits": 1000, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_ai_params_no_rank(human_color="B", style="standard", level=10))
        result = await svc.play(gid, x=3, y=3, color="B")

        assert result.ai_move is not None
        assert [g["key"] for g in analysis.ingested] == ["main:1"]
        assert analysis.ingested[0]["max_visits"] == 200  # = 链精度（level10）
        # 首手补初始局面 main:0（链精度 200）；AI 落子后的新局面（轮到人类）P1 main:2
        assert [s["key"] for s in analysis.submitted] == ["main:0", "main:2"]
        assert all(
            s["query"]["maxVisits"] == 200 for s in analysis.submitted
        )
        assert engine.captured["query"]["maxVisits"] == 200

    async def test_ai_first_move_low_difficulty(self, db):
        """人类执白（AI 黑先）低难度：main:0 不落库（对弈查询仅落子），
        AI 首手落定后补标准 P1 main:0；AI 落子局面 main:1 亦 P1。"""
        engine = _engine([{"move": "Q16", "visits": 100, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="W", style="standard", level=5))
        result = await svc.start(gid)
        assert result is not None
        assert analysis.ingested == []
        keys = [s["key"] for s in analysis.submitted]
        assert sorted(keys) == ["main:0", "main:1"]
        assert all(s["query"]["maxVisits"] == default_config().engine.standard_max_visits
                   for s in analysis.submitted)

    async def test_ai_first_move_high_difficulty_merged(self, db):
        """人类执白（AI 黑先）高难度：main:0 由 AI P0 查询合并落链槽（V_play=200=链精度）。"""
        engine = _engine([{"move": "Q16", "visits": 1000, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_ai_params_no_rank(human_color="W", style="standard", level=10))
        result = await svc.start(gid)
        assert result is not None
        assert [g["key"] for g in analysis.ingested] == ["main:0"]
        assert analysis.ingested[0]["max_visits"] == 200
        assert [s["key"] for s in analysis.submitted] == ["main:1"]

    async def test_ai_engine_error_no_ingest(self, db):
        """AI 引擎查询失败（挂起）→ 不落库/不提交 P1（仅查询成功路径后续处理）。"""
        from app.core.errors import AppError, ErrorCode

        engine = _engine(error=AppError(ErrorCode.ENGINE_DEAD, "引擎已崩溃"))
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B"))
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_pending is True
        assert analysis.ingested == []
        # 仅首手初始局面 main:0（与 AI 无关）；AI 待行局面 main:1 不提交
        assert [s["key"] for s in analysis.submitted] == ["main:0"]


class TestChainPrecision:
    """链精度机制（BUG-026）：**整局冻结**（创建时按当时配置/对局参数计算 `chain_visits`）；
    派生规则（仅创建时与老局回退）：非自适应 = max(标准, 该档位对弈精度)；
    自适应 = max(标准, 人类最高段位 9D 精度) 且每手双查询直至 AI 匹配 9D。"""

    async def test_adaptive_game_chain_uniform_and_deep_session_only(self, db):
        """**BUG-026 核心回归（真实调度器 + 真实仓储）**：自适应对局整局落库行
        精度唯一（恒 500）且覆盖 0..N；深算（kind=\"deep\"）不落库、不改链行。"""
        from app.services.analysis_service import AnalysisService
        from tests.fakes import FakeManager

        cfg = default_config()
        manager = FakeManager()
        move_seq = iter(["K16", "K4", "D10", "Q10", "C17", "R3"])

        async def _submit(query, timeout_s=None):
            mv = next(move_seq, "PASS")
            resp = dict(manager.response)
            resp["id"] = query.get("id")
            resp["moveInfos"] = [
                {"move": mv, "visits": 100, "winrate": 0.6, "scoreLead": 1.0, "pv": [mv]}
            ]
            return resp

        manager.submit = _submit
        analysis = AnalysisService(db.conn, cfg, engine=manager, concurrency=2)
        await analysis.start()
        svc = GameService(
            db.conn, cfg, human_model_available=True, engine=manager, analysis=analysis
        )
        gid = await svc.create(_ai_params(human_color="B", adaptive=True))
        for x, y in [(3, 3), (15, 15), (3, 15)]:
            await svc.play(gid, x=x, y=y, color="B")
        await analysis._queue.join()

        rows = await repos.list_analyses_for_game(db.conn, gid)
        game = await repos.get_game(db.conn, gid)
        keys = sorted(int(r["position_key"].split(":")[1]) for r in rows)
        assert keys == list(range(0, game["last_move_no"] + 1))  # 覆盖 0..N
        assert {int(r["max_visits"]) for r in rows} == {500}  # 链内精度唯一（9D 常量）

        chain_before = {r["position_key"]: r["data_json"] for r in rows}
        await analysis.submit(
            gid,
            "main:1",
            {
                "id": "deep",
                "moves": [],
                "rules": "chinese",
                "komi": 7.5,
                "boardXSize": 19,
                "boardYSize": 19,
                "maxVisits": cfg.engine.deep_max_visits,
                "priority": 50,
                "includeOwnership": True,
            },
            kind="deep",
        )
        await analysis._queue.join()
        assert analysis.cache.get_deep(gid, "main:1") is not None  # 仅会话
        rows_after = await repos.list_analyses_for_game(db.conn, gid)
        assert {r["position_key"]: r["data_json"] for r in rows_after} == chain_before
        await analysis.stop()

    async def test_created_game_freezes_chain_visits(self, db):
        """**创建时冻结链精度（BUG-026，2026/09/12）**：管理页热更新设置不影响
        进行中对局的链精度；新建对局采用新值。"""
        cfg = default_config()
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, cfg, human_model_available=True, engine=_engine(), analysis=analysis
        )
        gid = await svc.create(_params())
        row = await repos.get_game(db.conn, gid)
        assert int(row["chain_visits"]) == 100  # 冻结值 = 创建时派生结果

        cfg.engine.standard_max_visits = 500  # 模拟管理页热更新
        await svc.play(gid, x=3, y=3, color="B")
        assert analysis.submitted  # main:0 + main:1
        assert all(s["query"]["maxVisits"] == 100 for s in analysis.submitted)

        gid2 = await svc.create(_params())
        row2 = await repos.get_game(db.conn, gid2)
        assert int(row2["chain_visits"]) == 500  # 新局采用新值
        analysis.submitted.clear()
        await svc.play(gid2, x=3, y=3, color="B")
        assert all(s["query"]["maxVisits"] == 500 for s in analysis.submitted)

    async def test_frozen_chain_survives_level_table_change(self, db):
        """**整局完全冻结**：等级表调整（config.yaml 手改 + 重启等价场景）不影响
        进行中对局——对弈查询精度不再等于链精度时自动转双查询，链行仍为冻结值。"""
        cfg = default_config()
        engine = _engine([{"move": "Q16", "visits": 1000, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, cfg, human_model_available=True, engine=engine, analysis=analysis
        )
        gid = await svc.create(
            _ai_params_no_rank(human_color="B", style="standard", level=12)
        )
        row = await repos.get_game(db.conn, gid)
        assert int(row["chain_visits"]) == 800

        cfg.levels.standard[11].max_visits = 100  # 等级表调整
        await svc.play(gid, x=3, y=3, color="B")
        assert engine.captured["query"]["maxVisits"] == 100  # 对弈查询按新等级表
        assert analysis.ingested == []  # 精度不等 → 不合并
        assert sorted(s["key"] for s in analysis.submitted) == ["main:0", "main:1", "main:2"]
        assert all(s["query"]["maxVisits"] == 800 for s in analysis.submitted)

    async def test_legacy_game_without_freeze_derives_from_config(self, db):
        """迁移前老对局无冻结值（0）→ 按当前配置派生（老数据忽略，BUG-026）。"""
        from app.services.chain_precision import chain_visits

        cfg = default_config()
        gid = await repos.create_game(db.conn, mode="human_human", board_size=9)
        game = await repos.get_game(db.conn, gid)
        assert int(game["chain_visits"]) == 0
        assert chain_visits(cfg, game) == cfg.engine.standard_max_visits
        cfg.engine.standard_max_visits = 250
        assert chain_visits(cfg, game) == 250

    async def test_level12_chain_raises_to_play_precision(self, db):
        """标准 L12（V_play=800）→ 链精度 800：人类侧局面按 800 分析（同链同精度）。"""
        engine = _engine([{"move": "Q16", "visits": 1000, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(
            _ai_params_no_rank(human_color="B", style="standard", level=12)
        )
        await svc.play(gid, x=3, y=3, color="B")
        assert [g["key"] for g in analysis.ingested] == ["main:1"]
        assert analysis.ingested[0]["max_visits"] == 800  # P0 精度 == 链精度
        assert all(s["query"]["maxVisits"] == 800 for s in analysis.submitted)

    async def test_adaptive_chain_fixed_to_human_9d(self, db):
        """自适应（人类 5K 起始，level=5）：链精度恒为人类 9D 精度（500）；
        AI 待行局面 main:{H} 链行由**判定前置分析**（BUG-028）先于判定/对弈查询
        产出（标准查询，V_chain=500），不再走「合并/P0 低精度仅落子 + 落子后补
        P1」（双查询语义），人类侧局面照常逐手 P1。"""
        engine = _engine([{"move": "Q16", "visits": 10, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", adaptive=True))
        game = await repos.get_game(db.conn, gid)
        assert game["adaptive_enabled"] and int(game["ai_level"]) == 5
        await svc.play(gid, x=3, y=3, color="B")
        # 前置分析落链槽（标准查询 main:1 @ V_chain）；P0 低精度不落库
        assert [g["key"] for g in analysis.ingested] == ["main:1"]
        assert analysis.ingested[0]["max_visits"] == 500
        # 顺序：main:0（首手）→ main:2（AI 落子局面）；main:1 不再补 P1
        assert [s["key"] for s in analysis.submitted] == ["main:0", "main:2"]
        assert all(s["query"]["maxVisits"] == 500 for s in analysis.submitted)
        assert engine.captured["query"]["maxVisits"] == 2  # 人类 L5 对弈精度

    async def test_adaptive_9d_chain_row_from_pre_analysis(self, db):
        """自适应且 AI 已匹配 9D（人类 rank_9d → level12）：链行由**判定前置分析**
        产出（标准查询，V_chain=500）——P0 对弈查询（同为 500）不再重复落链槽。

        BUG-028：自适应对局不再走「P0 单查询合并」（链行必须判定前可用，且保持
        标准查询来源——与整链同精度同模型）；P0 仅用于落子选择。"""
        engine = _engine([{"move": "Q16", "visits": 1000, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", adaptive=True, human_rank="rank_9d"))
        game = await repos.get_game(db.conn, gid)
        assert int(game["ai_level"]) == 12
        await svc.play(gid, x=3, y=3, color="B")
        assert [g["key"] for g in analysis.ingested] == ["main:1"]  # 前置分析落链槽
        assert analysis.ingested[0]["max_visits"] == 500
        assert [s["key"] for s in analysis.submitted] == ["main:0", "main:2"]
        assert engine.captured["query"]["maxVisits"] == 500  # 对弈查询仍为档位精度

    async def test_config_floor_keeps_chain_precision(self, db):
        """管理员提高标准精度（300）：L10（V_play=200 < 300）→ 链精度 300，
        双查询补链（链精度恒 ≥ standard_max_visits）。"""
        cfg = default_config()
        cfg.engine.standard_max_visits = 300
        engine = _engine([{"move": "Q16", "visits": 1000, "winrate": 0.6}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, cfg, human_model_available=True, engine=engine, analysis=analysis
        )
        gid = await svc.create(
            _ai_params_no_rank(human_color="B", style="standard", level=10)
        )
        await svc.play(gid, x=3, y=3, color="B")
        assert analysis.ingested == []
        assert all(s["query"]["maxVisits"] == 300 for s in analysis.submitted)


class TestEnteringScoringBackfill:
    """终局补链（BUG-026 人工确认）：终局局面由深算预判落库补齐，但终局**前一手**
    仍须补链精度分析——否则覆盖 0..N 不完整（报告需先 [补分析]）。"""

    async def test_ai_pass_entering_scoring_backfills_human_position(self, db):
        """人类 PASS → AI 应手 PASS（双 PASS 终局）：main:{H}（人类 PASS 局面）
        仍补链精度 P1，不因 entering_scoring 跳过；终局局面由预判补齐。"""
        engine = _engine([{"move": "pass", "visits": 100, "winrate": 0.5}])
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B"))
        result = await svc.pass_move(gid, color="B")
        assert result.ai_move is not None and result.ai_move.entering_scoring is True
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "scoring" and game["last_move_no"] == 2
        assert sorted(s["key"] for s in analysis.submitted) == ["main:0", "main:1"]

    async def test_no_moves_double_pass_backfills_first_pass(self, db, monkeypatch):
        """双方无子可下（双自动 PASS 终局）：第一个自动 PASS 局面补链精度 P1
        （force_ai_turn 绕过 AI 待行跳过）；终局局面不提交（预判补齐）。"""
        engine = _engine()
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True,
            engine=engine, analysis=analysis,
        )

        class _NoMovesBoard:
            def has_legal_move(self, color):
                return False

            def pass_turn(self):  # M-8：单方 PASS 复用棋盘（清劫）需该接口
                pass

        async def _fake_build_board(game, *, moves=None):
            return _NoMovesBoard()

        monkeypatch.setattr(svc, "_build_board", _fake_build_board)
        gid = await svc.create(_params())
        result = await svc.pass_move(gid, color="B")
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "scoring" and game["last_move_no"] == 3
        assert result.auto_pass is not None
        # main:0（首手）+ main:1（单方 PASS 局面）+ main:2（第一个自动 PASS 局面，补链）
        assert sorted(s["key"] for s in analysis.submitted) == ["main:0", "main:1", "main:2"]


class TestAdaptiveDecisionPipeline:
    """BUG-028：自适应判定数据管线——判定（AI 落子前）必须能读到「当前盘面」链行。

    根因（2026/09/12 排查）：AI 待行局面（= 人类刚落的这一手之后）的链行原由
    AI 侧产出（``V_play == V_chain`` P0 合并 / 否则 AI 落子后补 P1），判定执行时
    该链行尚不存在 → ``_human_score_lead`` 恒 None → 升级与 lead 降级路径不可达。

    修复（方案 A）：自适应对局在判定前**同步补算**该局面链精度分析（与逐手 P1
    完全相同的标准查询，仅顺序提前），判定用真·当前局面数据；成功后该局面不再
    重复分析（合并/补 P1 均跳过），失败则回退既有路径（降级不阻断 AI 落子）。
    """

    @staticmethod
    def _routed_engine(play_queries: list[dict], standard_lead: float = 12.0, ai_moves=None):
        """引擎替身：标准链查询（P1）返回 ``rootInfo.scoreLead``；对弈查询（P0）返回落子。

        ``ai_moves`` 可指定 AI 每手落点序列（默认单点 Q16）。
        """
        engine = AsyncMock()
        remaining = list(ai_moves or ["Q16"])

        async def _submit(query, timeout_s=None):
            if int(query.get("priority") or 0) == PRIORITY_P1:
                return {
                    "id": query.get("id"),
                    "rootInfo": {
                        "currentPlayer": "W",
                        "winrate": 0.8,
                        "scoreLead": standard_lead,
                        "visits": 500,
                    },
                    "moveInfos": [],
                }
            play_queries.append(query)
            move = remaining.pop(0) if remaining else "PASS"
            return {
                "id": query.get("id"),
                "moveInfos": [{"move": move, "visits": 100, "winrate": 0.6}],
            }

        engine.submit = _submit
        return engine

    async def test_decision_reads_current_position_chain_row(self, db):
        """人类大幅领先（当前局面 lead=+12）→ 升档写回；AI 对弈查询已用新档位。"""
        from app.services.adaptive import AdaptiveDifficulty
        from app.services.analysis_service import AnalysisService

        cfg = default_config()
        play_queries: list[dict] = []
        engine = self._routed_engine(play_queries, standard_lead=12.0)
        analysis = AnalysisService(db.conn, cfg, engine=engine, concurrency=1)
        await analysis.start()
        svc = GameService(
            db.conn, cfg, human_model_available=True, engine=engine,
            adaptive=AdaptiveDifficulty(db.conn, cfg), analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", adaptive=True))
        result = await svc.play(gid, x=3, y=3, color="B")

        assert result.ai_move is not None
        game = await repos.get_game(db.conn, gid)
        assert int(game["ai_level"]) == 6  # 5 → 6（判定读到 main:1 lead=+12 → 升级）
        # 对弈查询使用升档后的档位（人类 level6 = 3K 的 humanSLProfile）
        assert play_queries and play_queries[0]["overrideSettings"]["humanSLProfile"] == "rank_3k"
        # 判定前置分析已把 main:1 链行落库（V_chain=500，标准查询）
        row = await repos.get_main_analysis(db.conn, gid, 1)
        assert row is not None and int(row["max_visits"]) == 500
        await analysis.stop()

    async def test_continuous_advantage_upgrades_each_ai_move(self, db):
        """连续领先（每手当前局面 lead=+12）→ 每手 AI 落子前均升一档（5→8），
        且各手对弈查询使用当手升档后的档位（humanSLProfile 逐手漂移）。"""
        from app.services.adaptive import AdaptiveDifficulty
        from app.services.analysis_service import AnalysisService

        cfg = default_config()
        play_queries: list[dict] = []
        engine = self._routed_engine(
            play_queries, standard_lead=12.0, ai_moves=["Q16", "D10", "K10"]
        )
        analysis = AnalysisService(db.conn, cfg, engine=engine, concurrency=1)
        await analysis.start()
        svc = GameService(
            db.conn, cfg, human_model_available=True, engine=engine,
            adaptive=AdaptiveDifficulty(db.conn, cfg), analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", adaptive=True))
        for x, y in [(3, 3), (15, 15), (3, 15)]:
            await svc.play(gid, x=x, y=y, color="B")

        game = await repos.get_game(db.conn, gid)
        assert int(game["ai_level"]) == 8  # 5 → 6 → 7 → 8（每手升一档）
        profiles = [q["overrideSettings"]["humanSLProfile"] for q in play_queries]
        assert profiles == ["rank_3k", "rank_1k", "rank_1d"]
        # 链行覆盖 0..N（前置分析 + AI 落子局面逐手 P1），精度统一 V_chain=500
        rows = await repos.list_analyses_for_game(db.conn, gid)
        keys = sorted(int(r["position_key"].split(":")[1]) for r in rows)
        assert keys == list(range(0, game["last_move_no"] + 1))
        assert {int(r["max_visits"]) for r in rows} == {500}
        await analysis.stop()

    async def test_downgrade_injects_pda_into_play_query(self, db):
        """人类大幅落后（当前局面 lead=-20）→ 降档写回 + 负 PDA 注入对弈查询。"""
        from app.services.adaptive import AdaptiveDifficulty
        from app.services.analysis_service import AnalysisService

        cfg = default_config()
        play_queries: list[dict] = []
        engine = self._routed_engine(play_queries, standard_lead=-20.0)
        analysis = AnalysisService(db.conn, cfg, engine=engine, concurrency=1)
        await analysis.start()
        svc = GameService(
            db.conn, cfg, human_model_available=True, engine=engine,
            adaptive=AdaptiveDifficulty(db.conn, cfg), analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", adaptive=True))
        await svc.play(gid, x=3, y=3, color="B")

        game = await repos.get_game(db.conn, gid)
        assert int(game["ai_level"]) == 4  # 5 → 4（lead=-20 < -15 → 降级）
        assert play_queries and (
            play_queries[0]["overrideSettings"]["playoutDoublingAdvantage"]
            == cfg.adaptive.playout_doubling_advantage
        )
        assert play_queries[0]["overrideSettings"]["humanSLProfile"] == "rank_8k"  # level4
        await analysis.stop()

    async def test_pre_analysis_failure_falls_back_to_legacy_path(self, db):
        """判定前置分析失败（引擎错误）→ 不阻断 AI 落子，档位保守保持，
        main:{H} 链行回退由 AI 落子后补链精度 P1（既有路径）产出。"""
        from app.engine.analysis_engine import EngineQueryError
        from app.services.adaptive import AdaptiveDifficulty

        engine = AsyncMock()

        async def _submit(query, timeout_s=None):
            if int(query.get("priority") or 0) == PRIORITY_P1:
                raise EngineQueryError("mock 标准分析失败")
            return {
                "id": query.get("id"),
                "moveInfos": [{"move": "Q16", "visits": 100, "winrate": 0.6}],
            }

        engine.submit = _submit
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine,
            adaptive=AdaptiveDifficulty(db.conn, default_config()), analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", adaptive=True))
        result = await svc.play(gid, x=3, y=3, color="B")

        assert result.ai_move is not None  # AI 落子未被阻断
        game = await repos.get_game(db.conn, gid)
        assert int(game["ai_level"]) == 5  # 无数据 → 保守保持
        assert "main:1" in [s["key"] for s in analysis.submitted]  # 回退补 P1
        assert analysis.ingested == []  # 无前置分析落库

    async def test_existing_chain_row_not_reanalyzed(self, db):
        """重试/恢复路径：AI 待行局面链行已存在（≥ V_chain）→ 不重复分析（省一次查询）。"""
        from app.services.adaptive import AdaptiveDifficulty

        play_queries: list[dict] = []
        engine = self._routed_engine(play_queries, standard_lead=0.0)
        analysis = RecordingAnalysis()
        svc = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine,
            adaptive=AdaptiveDifficulty(db.conn, default_config()), analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", adaptive=True))
        await repos.append_move(db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        # 模拟既有链行（如前次尝试的合并/补 P1 产出）
        await repos.upsert_position_analysis(
            db.conn, game_id=gid, position_key="main:1",
            data_json='{"rootInfo": {"currentPlayer": "W", "scoreLead": 0.0}, "moveInfos": []}',
            max_visits=500,
        )
        await svc.start(gid)  # created → active 并触发 AI 落子（对局 # 状态机）

        assert [q for q in play_queries]  # 对弈查询照常
        assert [s for s in analysis.submitted if s["key"] == "main:1"] == []  # 不再补 P1
        assert analysis.ingested == []  # 不重复落库
        assert [s["key"] for s in analysis.submitted] == ["main:2"]  # AI 落子局面照常 P1


class TestPipelinePersistence:
    """低难度整局分析落库（BUG-012 回归，真实调度器 + 真实仓储）。

    - 人类每手 + AI 应手后，``main:0..N`` 全部局面须落库（低难度双查询语义
      的最终用户可见结果：复盘曲线/点评/报告有数据）；
    - 构造“分析排队积压”（标准分析被门控阻塞至整局结束）验证：后续落子
      **不得**把排队中的每手分析按过期丢弃（此前每手 ``bump_version`` 导致
      快速对弈下仅最后一手落库）。
    """

    async def test_full_game_all_positions_persisted_with_backlog(self, db):
        import asyncio

        from app.services.analysis_service import AnalysisService
        from tests.fakes import FakeManager

        cfg = default_config()
        manager = FakeManager()
        gate = asyncio.Event()
        move_seq = iter(["K16", "K4", "D10", "Q10", "C17", "R3"])

        async def _submit(query, timeout_s=None):
            if int(query.get("maxVisits") or 0) >= cfg.engine.standard_max_visits:
                await gate.wait()  # 标准分析：阻塞到整局落完（制造排队积压）
            mv = next(move_seq, "PASS")
            resp = dict(manager.response)
            resp["id"] = query.get("id")
            resp["moveInfos"] = [
                {"move": mv, "visits": 10, "winrate": 0.6, "scoreLead": 1.0, "pv": [mv]}
            ]
            return resp

        manager.submit = _submit
        analysis = AnalysisService(db.conn, cfg, engine=manager, concurrency=2)
        await analysis.start()
        svc = GameService(
            db.conn, cfg, human_model_available=True, engine=manager, analysis=analysis,
        )
        gid = await svc.create(_ai_params(human_color="B", style="standard", level=5))

        for x, y in [(3, 3), (15, 15), (3, 15)]:
            await svc.play(gid, x=x, y=y, color="B")

        gate.set()
        await analysis._queue.join()
        await analysis.stop()

        game = await repos.get_game(db.conn, gid)
        rows = await repos.list_analyses_for_game(db.conn, gid)
        keys = sorted(int(r["position_key"].split(":")[1]) for r in rows)
        assert keys == list(range(0, game["last_move_no"] + 1))
