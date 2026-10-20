"""T3.11 分析报告测试（TASK T3.11 / PRD §4.2.5 / LEVEL.md 指标）。

用例 ID: REPORT-*
- AI 吻合度、平均目数损失、落子质量分布、胜负手、棋力评级；
- 黑白视角切换；数据不完整返回 ANALYSIS_INCOMPLETE。
"""

import json

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.game_service import CreateGameParams, GameService, PlayerInfo
from app.services.report_service import (
    classify_move,
    rating_label,
    ReportService,
)


@pytest.fixture
def bands():
    """默认点评分类带（config.report.quality_bands）。"""
    return default_config().report.quality_bands


@pytest.fixture
def ratings():
    """默认棋力评级带（config.report.ratings）。"""
    return default_config().report.ratings


def _params(**overrides):
    base = dict(
        mode="human_human",
        board_size=19,
        rules="chinese",
        komi=7.5,
        black=PlayerInfo(name="张三", rank="rank_5k"),
        white=PlayerInfo(name="李四", rank="rank_1k"),
    )
    base.update(overrides)
    return CreateGameParams(**base)


@pytest.fixture
def report(db):
    return ReportService(db.conn, default_config())


async def _mk_game(db, *, moves=None, gsvc=None):
    svc = gsvc or GameService(db.conn, default_config(), human_model_available=True)
    gid = await svc.create(_params())
    for i, (c, x, y) in enumerate(moves or [], start=1):
        await svc.play(gid, x=x, y=y, color=c)
    return gid


async def _store(db, gid, move_no, root, infos):
    data = {"rootInfo": root, "moveInfos": infos}
    await repos.upsert_position_analysis(
        db.conn, game_id=gid, position_key=f"main:{move_no}",
        data_json=json.dumps(data), max_visits=100,
    )


async def _mk_reported_game(db, gsvc):
    """构造带完整分析的 4 手对局（双局面差口径：ΔW/ΔS = 落子前后 root 之差，B 视角已知）。

    - 局面 0（B 行棋）→ 局面 1：B 走好（黑胜率 +10%、黑目差 +5）→ move1 ΔW=+0.10、
      ΔS=+5.0（目数变化，好手为正）；且 D16 命中第 1 选点 → 妙着；
    - 局面 2（B 行棋）→ 局面 3：B 略损（黑胜率 -5%、黑目差 -0.5）→ move3 ΔW=-0.05、
      ΔS=-0.5；F14 名次 3（未进前 3 选点）→ 按数值带判 缓着。
    """
    gid = await _mk_game(
        db,
        moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5), ("W", 16, 16)],
        gsvc=gsvc,
    )
    # 局面 0：轮到 B，B(3,3)="D16" 为第 1 选点（吻合度统计用）
    await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.5, "scoreLead": 0.0}, [
        {"move": "D16", "order": 0, "scoreLead": 0.0, "winrate": 0.5},
        {"move": "Q16", "order": 1, "scoreLead": -1.0, "winrate": 0.45},
        {"move": "C4", "order": 2, "scoreLead": -2.0, "winrate": 0.4},
    ])
    # 局面 1：轮到 W
    await _store(db, gid, 1, {"currentPlayer": "W", "winrate": 0.6, "scoreLead": 5.0}, [])
    # 局面 2：轮到 B；B(5,5)="F14" 为第 4 名（超出前 3 选点 → 非命中）
    await _store(db, gid, 2, {"currentPlayer": "B", "winrate": 0.55, "scoreLead": 3.0}, [
        {"move": "Q16", "order": 0, "scoreLead": 3.0, "winrate": 0.55},
        {"move": "D4", "order": 1, "scoreLead": 2.0, "winrate": 0.5},
        {"move": "C6", "order": 2, "scoreLead": 1.0, "winrate": 0.45},
        {"move": "F14", "order": 3, "scoreLead": 0.5, "winrate": 0.4},
    ])
    # 局面 3：轮到 W
    await _store(db, gid, 3, {"currentPlayer": "W", "winrate": 0.5, "scoreLead": 2.5}, [])
    # 局面 4：轮到 B（move4 后）
    await _store(db, gid, 4, {"currentPlayer": "B", "winrate": 0.52, "scoreLead": 2.0}, [])
    return gid


class TestClassify:
    """点评分类（config.report.quality_bands 带位；ΔS=目数变化，好手为正）。"""

    def test_brilliant_move(self, bands):
        assert classify_move(0.05, -0.5, bands) == "妙着"  # ΔW >= 3%

    def test_brilliant_by_score_delta(self, bands):
        assert classify_move(0.0, 0.2, bands) == "妙着"  # ΔS >= 0（目数未亏）

    def test_good_move(self, bands):
        assert classify_move(-0.01, -0.5, bands) == "正着"  # 极微小损失（-0.8 < ΔS < 0）

    def test_slow_move(self, bands):
        assert classify_move(-0.04, -1.0, bands) == "缓着"

    def test_mistake_move(self, bands):
        assert classify_move(-0.10, -3.0, bands) == "失误"

    def test_blunder_move(self, bands):
        assert classify_move(-0.20, -5.0, bands) == "败着"

    def test_hit_first_floor(self, bands):
        """命中 AI 第 1 选点 → 妙着（命中优先，覆盖数值档）。"""
        assert classify_move(-0.10, -3.0, bands, hit_first=True) == "妙着"

    def test_hit_top_floor(self, bands):
        """命中前 N 选点（Top3）→ 至少正着（缓着/失误上抬）；妙着不降档。"""
        assert classify_move(-0.10, -3.0, bands, hit_top=True) == "正着"
        assert classify_move(-0.04, -1.0, bands, hit_top=True) == "正着"
        assert classify_move(0.10, 1.0, bands, hit_top=True) == "妙着"

    def test_empty_bands_rejected(self):
        with pytest.raises(ValueError):
            classify_move(0.0, 0.0, [])


class TestRating:
    """棋力评级映射（config.report.ratings 带位）。"""

    def test_professional(self, ratings):
        assert rating_label(0.1, 0.8, ratings)["label"] == "巅峰/职业"

    def test_amateur_high(self, ratings):
        assert rating_label(0.2, 0.7, ratings)["label"] == "业余 6段-7段"

    def test_amateur_mid(self, ratings):
        assert rating_label(0.5, 0.6, ratings)["label"] == "业余 4段-5段"

    def test_amateur_low(self, ratings):
        assert rating_label(0.9, 0.5, ratings)["label"] == "业余 1段-3段"

    def test_kyu(self, ratings):
        assert rating_label(1.2, 0.4, ratings)["label"] == "高级级位"

    def test_beginner(self, ratings):
        assert rating_label(2.0, 0.2, ratings)["label"] == "初学者"

    def test_mixed_conditions_both_required(self, ratings):
        """两条件需同时满足（低吻合度即使低目损也降级）。"""
        assert rating_label(0.1, 0.2, ratings)["label"] == "初学者"

    def test_empty_ratings_rejected(self):
        with pytest.raises(ValueError):
            rating_label(0.1, 0.8, [])


class TestReport:
    """报告生成。"""

    async def test_black_perspective_metrics(self, db, report):
        from app.services.game_service import GameService

        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await _mk_reported_game(db, gsvc)
        rep = await report.generate(gid, perspective="B")
        assert rep["perspective"] == "B"
        assert rep["player_name"] == "张三"
        assert rep["top_n"] == 3
        # 链精度随报告下发（2026/09/15：报告头部主题色徽章；人人局 = standard_max_visits）
        assert rep["chain_visits"] == default_config().engine.standard_max_visits
        assert rep["match_rate"] == 0.5  # 1/2 命中前 3（move1 第 1 选点；move3 名次 3 未命中）
        assert rep["top_n_hits"] == 1
        # 均损 = -mean(ΔS)：B 两手 ΔS = +5.0（好手为正）与 -0.5（略损）→ -2.25
        assert rep["mean_score_loss"] == -2.25
        assert rep["move_quality"]["妙着"] == 1
        assert rep["move_quality"]["缓着"] == 1
        assert rep["move_quality"]["败着"] == 0

    async def test_white_perspective_switch(self, db, report):
        from app.services.game_service import GameService

        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await _mk_reported_game(db, gsvc)
        rep = await report.generate(gid, perspective="W")
        assert rep["perspective"] == "W"
        assert rep["player_name"] == "李四"
        assert rep["player_move_count"] == 2

    async def test_white_perspective_black_basis_metrics(self, db, report):
        """ISSUE-050 黑方视角存储：白方落子 ΔW/ΔS 按白方换算（取反/取负）。

        存储为黑方视角（``reportAnalysisWinratesAs=BLACK``）：白棋走好会压低
        黑方 winrate/scoreLead —— 白方视角 ΔW = -(黑方变化)、ΔS = -(黑方目差变化)。
        """
        from app.services.game_service import GameService

        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        # W 落子 #2 (15,15)=Q4 与 #4 (16,16)=R3；B 落子 #1 (3,3)=D16、#3 (5,5)=F14
        gid = await _mk_game(
            db,
            moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5), ("W", 16, 16)],
            gsvc=gsvc,
        )
        await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.5, "scoreLead": 0.0}, [
            {"move": "D16", "order": 0, "scoreLead": 0.0, "winrate": 0.5},
        ])
        # 局面 1（W 行棋）→ 局面 2：W 下出好手（黑胜率 0.60→0.50、黑目差 3→0）
        # → move2 白视角 ΔW=+0.10（妙着，且 Q4 命中第 1 选点）、ΔS=+3.0（白得 3 目）
        await _store(db, gid, 1, {"currentPlayer": "W", "winrate": 0.6, "scoreLead": 3.0}, [
            {"move": "Q4", "order": 0, "scoreLead": 3.0, "winrate": 0.6},
            {"move": "D16", "order": 1, "scoreLead": 2.0, "winrate": 0.5},
        ])
        await _store(db, gid, 2, {"currentPlayer": "B", "winrate": 0.5, "scoreLead": 0.0}, [
            {"move": "F14", "order": 0, "scoreLead": 0.0, "winrate": 0.5},
        ])
        # 局面 3（W 行棋）→ 局面 4：W 昏招（黑胜率 0.50→0.60、黑目差 0→4）
        # → move4 白视角 ΔW=-0.10（失误）、ΔS=-4.0（白损 4 目）；R3 不在候选中（非命中）
        await _store(db, gid, 3, {"currentPlayer": "W", "winrate": 0.5, "scoreLead": 0.0}, [
            {"move": "Q4", "order": 0, "scoreLead": -1.0, "winrate": 0.42},
            {"move": "D16", "order": 1, "scoreLead": -2.0, "winrate": 0.4},
        ])
        await _store(db, gid, 4, {"currentPlayer": "B", "winrate": 0.6, "scoreLead": 4.0}, [])
        rep = await report.generate(gid, perspective="W")
        assert rep["player_move_count"] == 2
        assert rep["move_quality"]["妙着"] == 1
        assert rep["move_quality"]["失误"] == 1
        assert rep["mean_score_loss"] == 0.5  # -(+3.0 + -4.0) / 2
        assert rep["top_n_hits"] == 1  # Q4 order0 命中第 1 选点；R3 未在候选中

    async def test_turning_points_winrate_delta(self, db, report):
        """ΔW 绝对值 > 15% → 胜负手（坏棋即时胜率大幅下降）。

        move3 前局面 root winrate 0.70 → 落子后 0.30 → ΔW=-0.40（败着）。
        """
        from app.services.game_service import GameService

        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await _mk_game(
            db,
            moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5), ("W", 16, 16)],
            gsvc=gsvc,
        )
        await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.7, "scoreLead": 5.0}, [
            {"move": "D16", "order": 0, "scoreLead": 5.0, "winrate": 0.7},
        ])
        await _store(db, gid, 1, {"currentPlayer": "W", "winrate": 0.7, "scoreLead": 5.0}, [])
        await _store(db, gid, 2, {"currentPlayer": "B", "winrate": 0.7, "scoreLead": 5.0}, [
            {"move": "Q16", "order": 0, "scoreLead": 5.0, "winrate": 0.7},
            {"move": "D4", "order": 1, "scoreLead": 4.0, "winrate": 0.6},
        ])
        # move3（F14，不在候选中）后黑胜率暴跌（0.70→0.30）、黑目差 5.0→0.5
        # → ΔW=-0.40、ΔS=-4.5（目数变化，恶手为负）
        await _store(db, gid, 3, {"currentPlayer": "W", "winrate": 0.3, "scoreLead": 0.5}, [])
        await _store(db, gid, 4, {"currentPlayer": "B", "winrate": 0.3, "scoreLead": 0.5}, [])
        rep = await report.generate(gid, perspective="B")
        assert rep["turning_points"]
        assert any(tp["move_no"] == 3 for tp in rep["turning_points"])
        assert rep["move_quality"]["败着"] == 1
        # 胜负手附五档英文 grade（T6.9 弹层标签/配色；ΔW=-0.40、ΔS=-4.5 → 败着）
        tp3 = next(tp for tp in rep["turning_points"] if tp["move_no"] == 3)
        assert tp3["grade"] == "blunder"
        assert tp3["delta_winrate"] == -40.0  # 输出百分比（round 2）
        assert tp3["score_delta"] == -4.5  # ΔS=目数变化（恶手为负）
        assert all("grade" in tp for tp in rep["turning_points"])

    async def test_turning_points_grade_consistent_with_quality(self, db):
        """T6.9：胜负手 grade 与落子质量分布同口径（同一 classify_move 带表）。"""
        from app.services.report_service import ReportService

        cfg = default_config()
        cfg.report.turning_point_count_min = 3
        svc = ReportService(db.conn, cfg)
        metrics = [
            {"move_no": 1, "delta_winrate": 0.12, "score_delta": 0.2},  # 妙着（ΔW>=3%）
            {"move_no": 2, "delta_winrate": -0.05, "score_delta": -2.5},  # 失误
            {"move_no": 3, "delta_winrate": 0.4, "score_delta": 0.0},  # 妙着（正 ΔW）
        ]
        tps = svc._turning_points(metrics)
        by_no = {tp["move_no"]: tp["grade"] for tp in tps}
        assert by_no[1] == "brilliant"
        assert by_no[2] == "mistake"
        assert by_no[3] == "brilliant"
        assert all(grade in ("blunder", "mistake", "slow", "good", "brilliant") for grade in by_no.values())

    async def test_turning_points_min_padding(self, db):
        """M-9：胜负手落实 turning_point_count_min——候选足够时至少返回 min 手。"""
        from app.services.report_service import ReportService

        cfg = default_config()
        cfg.report.turning_point_count_min = 3
        cfg.report.turning_point_count_max = 5
        svc = ReportService(db.conn, cfg)
        metrics = [
            {"move_no": 1, "delta_winrate": 0.5, "score_delta": -0.1},  # strong（优先）
            {"move_no": 2, "delta_winrate": 0.1, "score_delta": -1.0},
            {"move_no": 3, "delta_winrate": 0.1, "score_delta": -0.9},
            {"move_no": 4, "delta_winrate": 0.1, "score_delta": -0.8},
        ]
        tps = svc._turning_points(metrics)
        assert len(tps) >= cfg.report.turning_point_count_min  # ≥ min
        assert tps[0]["move_no"] == 2  # |ΔS| 最大者优先（双侧幅度口径）
        # 候选不足时仅返回实际数量（不越界、不抛错）
        sparse = [{"move_no": 1, "delta_winrate": 0.5, "score_delta": -0.1}]
        assert len(svc._turning_points(sparse)) == 1

    async def test_turning_points_two_sided_magnitude(self, db):
        """胜负手按 |ΔS| 降序双侧选取（回归：旧实现按 ΔS 升序只列最差手 → 恒无胜手）。"""
        from app.services.report_service import ReportService

        cfg = default_config()
        cfg.report.turning_point_count_min = 3
        cfg.report.turning_point_count_max = 5
        svc = ReportService(db.conn, cfg)
        # 单手 |ΔW| 均 < 15%（实战常态）→ 旧实现 strong 恒为空、按 ΔS 升序取最差 → 全负手
        metrics = [
            {"move_no": 1, "delta_winrate": -0.05, "score_delta": -1.2},  # 恶手
            {"move_no": 2, "delta_winrate": 0.04, "score_delta": 2.6},  # 好手（|ΔS| 最大）
            {"move_no": 3, "delta_winrate": -0.03, "score_delta": -0.9},
            {"move_no": 4, "delta_winrate": 0.02, "score_delta": 1.8},  # 好手
        ]
        tps = svc._turning_points(metrics)
        assert [tp["move_no"] for tp in tps] == [2, 4, 1, 3]  # |ΔS| 降序
        assert any(tp["score_delta"] > 0 for tp in tps)  # 含胜手
        assert any(tp["score_delta"] < 0 for tp in tps)  # 含负手

    async def test_turning_points_winrate_fallback_without_score(self, db):
        """ΔS 缺失的手按 |ΔW| 兜底纳入（须超 turning_point_winrate_delta）。"""
        from app.services.report_service import ReportService

        cfg = default_config()
        svc = ReportService(db.conn, cfg)
        metrics = [
            {"move_no": 1, "delta_winrate": None, "score_delta": None},
            {"move_no": 2, "delta_winrate": -0.4, "score_delta": None},  # |ΔW|>阈值
            {"move_no": 3, "delta_winrate": -0.1, "score_delta": None},  # 低于阈值
            {"move_no": 4, "delta_winrate": 0.2, "score_delta": 0.5},  # 有 ΔS → 主排序
        ]
        tps = svc._turning_points(metrics)
        assert [tp["move_no"] for tp in tps] == [4, 2]

    async def test_analysis_incomplete(self, db, report):
        """数据不完整 → ANALYSIS_INCOMPLETE。"""
        from app.services.game_service import GameService

        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=gsvc)
        await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.5}, [])
        # main:1 缺失
        with pytest.raises(AppError) as ei:
            await report.generate(gid, perspective="B")
        assert ei.value.code is ErrorCode.ANALYSIS_INCOMPLETE

    async def test_no_moves_for_perspective(self, db, report):
        from app.services.game_service import GameService

        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=gsvc)
        await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.5}, [
            {"move": "D16", "order": 0, "scoreLead": 0.0},
        ])
        await _store(db, gid, 1, {"currentPlayer": "W", "winrate": 0.4}, [])
        # 白方无落子 → 不完整
        with pytest.raises(AppError) as ei:
            await report.generate(gid, perspective="W")
        assert ei.value.code is ErrorCode.ANALYSIS_INCOMPLETE

    async def test_invalid_perspective(self, db, report):
        gid = await _mk_game(db, gsvc=GameService(db.conn, default_config(), human_model_available=True))
        with pytest.raises(AppError) as ei:
            await report.generate(gid, perspective="X")
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD


class TestHitFloor:
    """命中 AI 选点优先（2026/09/11 人工确认）：第一选点→妙着、前 3 选点→至少正着。"""

    async def test_hit_first_overrides_numeric(self, db, report):
        """命中第 1 选点 → 妙着（即使 ΔW=-2% 落 缓着 数值档）。"""
        from app.services.game_service import GameService

        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=gsvc)  # D16
        await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.6, "scoreLead": 2.0}, [
            {"move": "D16", "order": 0, "scoreLead": 2.0, "winrate": 0.6},
            {"move": "Q16", "order": 1, "scoreLead": 1.0, "winrate": 0.55},
        ])
        await _store(db, gid, 1, {"currentPlayer": "W", "winrate": 0.58, "scoreLead": 1.8}, [])
        rep = await report.generate(gid, perspective="B")
        assert rep["top_n_hits"] == 1
        assert rep["move_quality"]["妙着"] == 1

    async def test_hit_top_floor_lifts_mistake(self, db, report):
        """命中前 3 选点（名次 1）→ 至少正着（即使 ΔW=-10% 落 失误 数值档）。"""
        from app.services.game_service import GameService

        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=gsvc)  # D16
        await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.6, "scoreLead": 2.0}, [
            {"move": "Q16", "order": 0, "scoreLead": 3.0, "winrate": 0.65},
            {"move": "D16", "order": 1, "scoreLead": 2.0, "winrate": 0.6},
            {"move": "D4", "order": 2, "scoreLead": 1.0, "winrate": 0.55},
        ])
        await _store(db, gid, 1, {"currentPlayer": "W", "winrate": 0.5, "scoreLead": -2.0}, [])
        rep = await report.generate(gid, perspective="B")
        assert rep["top_n_hits"] == 1  # 名次 1 命中前 3
        assert rep["move_quality"]["正着"] == 1  # 数值档（ΔW=-10%/ΔS=-4.0）被抬为正着


class TestConfigDriven:
    """报告指标配置化（config.yaml 唯一事实源）。"""

    async def test_custom_top_n_and_bands(self, db):
        """自定义 top_n 与点评带 → 指标随之变化。"""
        from app.config import QualityBandConfig
        from app.services.report_service import ReportService

        cfg = default_config()
        cfg.report.top_n = 1  # 只认第 1 选点
        # 宽松带：ΔW≤1.0 或 ΔS≤99 恒归 正着（非命中时的数值带判定）
        cfg.report.quality_bands = [
            QualityBandConfig(label="正着", winrate_delta=1.0, score_delta=99.0),
            QualityBandConfig(label="妙着", winrate_delta=0.03, score_delta=0.0),
        ]
        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        report = ReportService(db.conn, cfg)
        gid = await _mk_game(
            db,
            moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5), ("W", 16, 16)],
            gsvc=gsvc,
        )
        # 全局面分析（候选**不含**实际落子 → 非命中）；双局面差 ΔW：move1=+0.1、move3=-0.05
        for k in range(5):
            winrate = [0.5, 0.6, 0.6, 0.55, 0.55][k]
            await _store(db, gid, k, {"currentPlayer": "B" if k % 2 == 0 else "W", "winrate": winrate}, [])
        await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.5}, [
            {"move": "Q16", "order": 0, "scoreLead": 1.0, "winrate": 0.6},
            {"move": "C6", "order": 1, "scoreLead": 0.9, "winrate": 0.5},
        ])
        await _store(db, gid, 2, {"currentPlayer": "B", "winrate": 0.6}, [
            {"move": "Q16", "order": 0, "scoreLead": 1.0, "winrate": 0.6},
            {"move": "C6", "order": 1, "scoreLead": 0.9, "winrate": 0.5},
        ])
        rep = await report.generate(gid, perspective="B")
        assert rep["top_n"] == 1
        assert rep["top_n_hits"] == 0  # 落子均不在候选中（非命中）
        assert set(rep["move_quality"].keys()) == {"正着", "妙着"}
        assert rep["move_quality"]["正着"] == 2  # 自定义宽松带：两手持平/微差均归 正着

    async def test_custom_ratings(self, db):
        """自定义评级带。"""
        from app.config import RatingBandConfig
        from app.services.report_service import ReportService

        cfg = default_config()
        cfg.report.ratings = [
            RatingBandConfig(label="围棋大师", mean_loss=5.0, match_rate=0.1, description="宽松带"),
        ]
        gsvc = GameService(db.conn, default_config(), human_model_available=True)
        report = ReportService(db.conn, cfg)
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=gsvc)
        await _store(db, gid, 0, {"currentPlayer": "B", "winrate": 0.5}, [
            {"move": "D16", "order": 0, "scoreLead": 0.0, "winrate": 0.5},
        ])
        await _store(db, gid, 1, {"currentPlayer": "W", "winrate": 0.5}, [])
        rep = await report.generate(gid, perspective="B")
        assert rep["rating"]["label"] == "围棋大师"
