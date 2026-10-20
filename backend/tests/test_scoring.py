"""T3.4 终局结算测试（TASK T3.4 / PRD §4.1.8 / DATABASE §3.5）。

用例 ID: SCORE-*
- 数子法（中国/AGA）、目数法（日本）在 Python 侧实现（引擎无关）；
- 死子确认移除重算、result 格式、结算取消后再结算。
"""

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.game_service import CreateGameParams, GameService, PlayerInfo
from app.services.scoring import (
    build_final_grid,
    compute_scoring,
    score_grid,
)


def _grid(size=9, stones=None):
    g = [[None] * size for _ in range(size)]
    for x, y, c in (stones or []):
        g[y][x] = c
    return g


def _params(**overrides):
    base = dict(
        mode="human_human",
        board_size=9,
        rules="chinese",
        komi=7.5,
        handicap=0,
        black=PlayerInfo(name="张三", rank="rank_5k"),
        white=PlayerInfo(name="李四", rank="rank_1k"),
    )
    base.update(overrides)
    return CreateGameParams(**base)


@pytest.fixture
def svc(db):
    return GameService(db.conn, default_config(), human_model_available=True)


class TestChineseScoring:
    """数子法（中国规则）。"""

    def test_half_split_neutral_komi(self):
        """B/W 各半盘，中立列不计 → 白胜 7.5。"""
        stones = []
        for y in range(9):
            for x in range(9):
                if x <= 3:
                    stones.append((x, y, "B"))
                elif x >= 5:
                    stones.append((x, y, "W"))
        sr = score_grid(_grid(9, stones), rules="chinese", komi=7.5)
        assert sr.black_score == 36.0
        assert sr.white_score == 43.5
        assert sr.result == "W+7.5"
        assert sr.neutral == 9

    def test_black_corner_territory_counted(self):
        """黑封边形成 3x3 角部领地 → 领地计入黑方。"""
        # 黑占据 (3,3) 围线（L 形），角部 (x<3,y<3) 为空 → 黑领地 9
        stones = []
        for x in range(9):
            for y in range(9):
                if x == 3 or y == 3:
                    stones.append((x, y, "B"))
                elif x < 3 and y < 3:
                    pass  # 领地空点
                else:
                    stones.append((x, y, "W"))
        sr = score_grid(_grid(9, stones), rules="chinese", komi=0)
        assert sr.black_territory == 9
        # 黑：领地 9 + 围线 17 = 26；白：55
        assert sr.black_score == 26.0
        assert sr.white_score == 55.0
        assert sr.result == "W+29"

    def test_full_board_count(self):
        """全盘填满无领地 → 按子数比较。"""
        stones = []
        for y in range(9):
            for x in range(9):
                stones.append((x, y, "B" if (x + y) % 2 == 0 else "W"))
        sr = score_grid(_grid(9, stones), rules="chinese", komi=7.5)
        assert sr.black_score == 41.0
        assert sr.white_score == 40.0 + 7.5
        assert sr.result == "W+6.5"

    def test_dead_stones_removed_chinese(self):
        """死子确认：移除白死子后白方子数下降。"""
        stones = [(4, 4, "W"), (4, 5, "W")]
        for y in range(9):
            for x in range(9):
                if (x, y) not in [(4, 4), (4, 5)]:
                    stones.append((x, y, "B"))
        before = score_grid(_grid(9, stones), rules="chinese", komi=0)
        after = score_grid(
            _grid(9, stones), rules="chinese", komi=0, dead_points=[(4, 4), (4, 5)]
        )
        assert before.white_score == 2.0
        assert after.white_score == 0.0
        assert after.dead_white == 2

    def test_result_draw_when_equal(self):
        """贴目 0 且双方子数相等 → Draw。"""
        stones = []
        for y in range(9):
            for x in range(9):
                if x < 4:
                    stones.append((x, y, "B"))
                elif x > 4:
                    stones.append((x, y, "W"))
        # 中间列中立，B=36 W=36，komi=0 → Draw
        sr = score_grid(_grid(9, stones), rules="chinese", komi=0)
        assert sr.result == "Draw"
        assert sr.black_score == sr.white_score == 36.0


class TestAgaScoring:
    """AGA 规则同中国数子。"""

    def test_same_as_chinese(self):
        stones = []
        for y in range(9):
            for x in range(9):
                if x <= 3:
                    stones.append((x, y, "B"))
                elif x >= 5:
                    stones.append((x, y, "W"))
        sr_ch = score_grid(_grid(9, stones), rules="chinese", komi=7.5)
        sr_aga = score_grid(_grid(9, stones), rules="aga", komi=7.5)
        assert sr_aga.result == sr_ch.result
        assert sr_aga.black_score == sr_ch.black_score
        assert sr_aga.white_score == sr_ch.white_score


class TestJapaneseScoring:
    """目数法（日本规则）。"""

    def test_prisoners_count(self):
        """死子作为俘虏计给对方目数。"""
        stones = [(4, 4, "W"), (4, 5, "W")]
        for y in range(9):
            for x in range(9):
                if (x, y) not in [(4, 4), (4, 5)]:
                    stones.append((x, y, "B"))
        sr = score_grid(
            _grid(9, stones), rules="japanese", komi=0, dead_points=[(4, 4), (4, 5)]
        )
        # 白死子 2 枚 → 黑目数 +2
        assert sr.dead_white == 2
        assert sr.black_score == sr.black_territory + 2

    def test_territory_only(self):
        """无死子时日本规则只算领地。"""
        stones = []
        for y in range(9):
            for x in range(9):
                if x <= 3:
                    stones.append((x, y, "B"))
                elif x >= 5:
                    stones.append((x, y, "W"))
        sr = score_grid(_grid(9, stones), rules="japanese", komi=6.5)
        # 无领地（中立列），无俘虏 → 黑 0 / 白 6.5
        assert sr.black_score == 0.0
        assert sr.white_score == 6.5
        assert sr.result == "W+6.5"
    def test_prisoners_parameter_shifts_totals(self):
        """BUG-030：对局俘虏直接计入日本目数（黑提 3 / 白提 5）。"""
        sr = score_grid(
            _grid(9, [(0, 0, "B")]),
            rules="japanese",
            komi=0.0,
            black_prisoners=3,
            white_prisoners=5,
        )
        assert sr.black_score == sr.black_territory + 3
        assert sr.white_score == 5.0

    def test_prisoners_ignored_by_area_rules(self):
        """数子法（中国/AGA）不受对局俘虏影响（面积计分）。"""
        stones = [(0, 0, "B")]
        base = score_grid(_grid(9, stones), rules="chinese", komi=0.0)
        with_caps = score_grid(
            _grid(9, stones),
            rules="chinese",
            komi=0.0,
            black_prisoners=3,
            white_prisoners=5,
        )
        assert with_caps.black_score == base.black_score
        assert with_caps.white_score == base.white_score

    def test_compute_scoring_counts_in_play_prisoners(self):
        """BUG-030 回归（端到端）：回放提子后日本目数含对局俘虏。

        B(1,0) → W(0,0) → B(0,1) 提白 1 子：终局黑地 79（含提子点）+ 俘虏 1 = 80。
        """
        moves = [
            {"color": "B", "x": 1, "y": 0, "is_pass": False},
            {"color": "W", "x": 0, "y": 0, "is_pass": False},
            {"color": "B", "x": 0, "y": 1, "is_pass": False},
        ]
        sr = compute_scoring(
            board_size=9, rules="japanese", komi=0.0, handicap=0, moves=moves
        )
        assert sr.black_territory == 79
        assert sr.black_score == 80.0
        assert sr.white_score == 0.0
        assert sr.result == "B+80"

    def test_compute_scoring_area_ignores_prisoners(self):
        """同一走法按中国数子：不受俘虏影响（2 子 + 79 空点 = 81）。"""
        moves = [
            {"color": "B", "x": 1, "y": 0, "is_pass": False},
            {"color": "W", "x": 0, "y": 0, "is_pass": False},
            {"color": "B", "x": 0, "y": 1, "is_pass": False},
        ]
        sr = compute_scoring(
            board_size=9, rules="chinese", komi=0.0, handicap=0, moves=moves
        )
        assert sr.black_score == 81.0
        assert sr.result == "B+81"

class TestComputeScoring:
    """compute_scoring（由对局落子回放终局棋盘）。"""

    def test_build_final_grid_places_stones(self):
        moves = [
            {"color": "B", "x": 3, "y": 3, "is_pass": False},
            {"color": "W", "x": 15, "y": 15, "is_pass": False},
        ]
        grid = build_final_grid(board_size=19, handicap=0, moves=moves)
        assert grid[3][3] == "B"
        assert grid[15][15] == "W"

    def test_build_final_grid_with_handicap(self):
        moves = []
        grid = build_final_grid(board_size=19, handicap=2, moves=moves)
        assert grid[3][15] == "B"   # 右上 Q16
        assert grid[15][3] == "B"   # 左下 D4

    def test_compute_handicap_game(self):
        """让子棋：黑让子占角，白先落子后结算。"""
        moves = [
            {"color": "W", "x": 4, "y": 4, "is_pass": False},
            {"color": "B", "x": 5, "y": 5, "is_pass": False},
        ]
        sr = compute_scoring(
            board_size=19, rules="chinese", komi=0.0, handicap=2, moves=moves
        )
        assert sr.black_score > 0
        assert sr.white_score > 0
        assert sr.result.startswith(("B+", "W+")) or sr.result == "Draw"

    def test_invalid_rules_rejected(self):
        with pytest.raises(ValueError):
            score_grid(_grid(), rules="korean", komi=0)

    def test_dead_point_out_of_bounds(self):
        with pytest.raises(ValueError):
            score_grid(_grid(), rules="chinese", komi=0, dead_points=[(99, 99)])


class TestGameServiceScoring:
    """game_service 结算流转（对局级）。"""

    async def test_confirm_scoring_flow(self, svc, db):
        """双 PASS → 结算确认 → FINISHED + result + scorings UPSERT。"""
        gid = await svc.create(_params())
        # 走几步后双 PASS
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=4, y=4, color="W")
        await svc.pass_move(gid, color="B")
        await svc.pass_move(gid, color="W")
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "scoring"

        result = await svc.confirm_scoring(gid)
        assert result["result"]
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "finished"
        assert game["result"] == result["result"]

    async def test_confirm_scoring_counts_in_play_prisoners(self, svc, db):
        """BUG-030 回归（对局级）：日本规则结算确认计入对局俘虏。

        黑 B(1,0)+B(0,1) 提白 (0,0) 1 子后双 PASS → 黑地 79 + 俘虏 1 = B+80
        （修复前黑 79 : 白 0，少算 1 目）。
        """
        gid = await svc.create(_params(rules="japanese", komi=0.0, board_size=9))
        await svc.play(gid, x=1, y=0, color="B")
        await svc.play(gid, x=0, y=0, color="W")
        await svc.play(gid, x=0, y=1, color="B")  # 提白 1 子
        await svc.pass_move(gid, color="W")
        await svc.pass_move(gid, color="B")
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "scoring"
        assert game["black_captures"] == 1

        result = await svc.confirm_scoring(gid)
        assert result["result"] == "B+80"
        assert result["black_score"] == 80.0
        assert (await repos.get_game(db.conn, gid))["result"] == "B+80"
        scoring = await repos.get_scoring(db.conn, gid)
        assert scoring is not None
        assert scoring["black_score"] is not None
        assert scoring["result"] == result["result"]

    async def test_confirm_scoring_in_playing_rejected(self, svc, db):
        gid = await svc.create(_params())
        with pytest.raises(AppError) as ei:
            await svc.confirm_scoring(gid)
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_cancel_scoring_back_to_playing(self, svc, db):
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        await svc.pass_move(gid, color="W")
        await svc.cancel_scoring(gid)
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "active"
        # 取消后可继续对弈
        await svc.play(gid, x=3, y=3, color="B")

    async def test_rescoring_overwrites(self, svc, db):
        """结算取消后再结算 → scorings UPSERT 整体替换（单条）。"""
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        await svc.pass_move(gid, color="W")
        await svc.confirm_scoring(gid)
        first = await repos.get_scoring(db.conn, gid)
        # 回退：直接改状态回 scoring（模拟"再来一局"前的结算修正场景）
        await repos.update_game_status(db.conn, gid, "scoring")
        await svc.confirm_scoring(gid, dead_points=[])
        second = await repos.get_scoring(db.conn, gid)
        assert second["id"] == first["id"]  # 单条 UPSERT
        rows = await db.conn.execute_fetchall(
            "SELECT COUNT(*) AS n FROM scorings WHERE game_id=?", (gid,)
        )
        assert rows[0]["n"] == 1

    async def test_resign_skips_scoring(self, svc, db):
        """认输即时终局（跳过死子确认与结算）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.resign(gid, color="B")
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "finished"
        assert game["result"] == "W+Resign"
        assert await repos.get_scoring(db.conn, gid) is None

    async def test_confirm_scoring_unsettled_finished_in_place(self, svc, db):
        """导入棋谱补结算（2026/09/19 方案 A）：finished 且 result 为空 → 原地结算。

        不迁移状态（保持 finished），同一 Python 数子口径写 result + scorings。
        """
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await repos.set_game_result(db.conn, gid, None)  # 导入语义：finished 未结算
        before = await repos.get_game(db.conn, gid)
        assert before["status"] == "finished" and before["result"] is None

        result = await svc.confirm_scoring(gid, dead_points=[])
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "finished"  # 原地补结算，无状态迁移
        assert game["result"] == result["result"]
        scoring = await repos.get_scoring(db.conn, gid)
        assert scoring is not None
        assert scoring["result"] == result["result"]
        assert scoring["black_score"] == result["black_score"]

    async def test_confirm_scoring_settled_finished_rejected(self, svc, db):
        """已结算终局（result 非空）拒绝再次结算（GAME_FINISHED）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.resign(gid, color="B")  # finished + result
        with pytest.raises(AppError) as ei:
            await svc.confirm_scoring(gid)
        assert ei.value.code is ErrorCode.GAME_FINISHED

    async def test_prepare_settle_unsettled_finished(self, svc, db):
        """结算准备：仅 finished 且 result 为空可补结算，返回末手数（不改状态）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await repos.set_game_result(db.conn, gid, None)
        assert await svc.prepare_settle(gid) == 1
        assert (await repos.get_game(db.conn, gid))["status"] == "finished"

    async def test_prepare_settle_rejected(self, svc, db):
        """结算准备拒绝：进行中（ILLEGAL_ACTION）/ 已结算（GAME_FINISHED）。"""
        active = await svc.create(_params())
        with pytest.raises(AppError) as ei:
            await svc.prepare_settle(active)
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

        settled = await svc.create(_params())
        await svc.play(settled, x=3, y=3, color="B")
        await svc.resign(settled, color="B")
        with pytest.raises(AppError) as ei2:
            await svc.prepare_settle(settled)
        assert ei2.value.code is ErrorCode.GAME_FINISHED

    async def test_confirm_scoring_unsettled_uses_ai_prediction(self, svc, db):
        """未定型终局（导入棋谱，末手非双 PASS）结算采用 AI 预判结果（2026/10/10 人工确认）。

        终局局面未定型 ⇒ Python 精确数子不稳定（实测同一 SGF 预判 `W+2`、数子 `和局`）
        → 以 ``scoring.prediction``（GTP ``final_score`` 等价）为权威结果；lead 估算
        无黑/白目数 → 两值置空（同认输局）。
        """
        gid = await svc.create(_params(rules="japanese", komi=0.0))
        await svc.play(gid, x=3, y=3, color="B")
        await repos.set_game_result(db.conn, gid, None)  # 导入语义：finished 未结算
        predicted = {"finished": False, "engine": True, "result": "W+2", "dead_points": []}

        result = await svc.confirm_scoring(gid, dead_points=[], predicted=predicted)
        assert result == {
            "result": "W+2",
            "black_score": None,
            "white_score": None,
            "ai_predicted": True,
        }
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "finished" and game["result"] == "W+2"
        scoring = await repos.get_scoring(db.conn, gid)
        assert scoring["result"] == "W+2"
        assert scoring["black_score"] is None and scoring["white_score"] is None

    async def test_confirm_scoring_unsettled_falls_back_without_prediction(self, svc, db):
        """预判缺失（引擎不可用/未就绪，``result=null``）→ 回退 Python 精确数子（不阻断）。"""
        for predicted in (None, {"finished": False, "engine": False, "result": None}):
            gid = await svc.create(_params(rules="japanese", komi=0.0))
            await svc.play(gid, x=3, y=3, color="B")
            await repos.set_game_result(db.conn, gid, None)
            result = await svc.confirm_scoring(gid, dead_points=[], predicted=predicted)
            assert result["black_score"] is not None
            assert result["result"] != "W+2"
            assert result["ai_predicted"] is False  # 回退 Python 数子 → 非 AI 预判

    async def test_confirm_scoring_double_pass_keeps_exact_count(self, svc, db):
        """双 PASS 终局（``finished=True`` 预判）仍走 Python 精确数子，不被预判覆盖。"""
        gid = await svc.create(_params(rules="japanese", komi=0.0))
        await svc.play(gid, x=3, y=3, color="B")
        await svc.pass_move(gid, color="W")
        await svc.pass_move(gid, color="B")
        predicted = {"finished": True, "engine": True, "result": "W+99", "dead_points": []}
        result = await svc.confirm_scoring(gid, dead_points=[], predicted=predicted)
        assert result["result"] != "W+99"
        assert result["black_score"] is not None
        assert result["ai_predicted"] is False  # 双 PASS 终局：精确数子（非 AI 预判）
