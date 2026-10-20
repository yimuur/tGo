"""T3.3 对局进行测试（TASK T3.3 / PRD §4.1.2/§4.1.3 / ARCHITECTURE §3.5/§4.1）。

用例 ID: GS-PLAY-*
- 规则矩阵（吃子/禁入/打劫）、双 PASS、悔棋级联清理事务原子性、认输、重开；
- 引擎解耦（人人对弈引擎 DEAD 落子照常；人机 AI 侧 TURN_AI 挂起）；
- AI 落子走引擎 P0 查询（T2.5），人类风格/让子查询构建。
"""

import asyncio
from unittest.mock import AsyncMock

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.engine.analysis_engine import EngineQueryError
from app.services.game_service import (
    AiParams,
    CreateGameParams,
    GameService,
    PlayerInfo,
)
from app.services import go_rules
from tests.fakes import SlowPlayEngine, StuckPlayEngine

#: 默认 AI 落子响应（Q16 = (15,3)）
AI_Q16 = [{"move": "Q16", "visits": 100, "winrate": 0.6}]


def _make_engine(move_infos=None, error=None):
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


def _ai_params(
    mode="human_ai",
    human_color="B",
    style="standard",
    level=5,
    adaptive=False,
    handicap=0,
    board_size=19,
):
    return _params(
        mode=mode,
        board_size=board_size,
        color=human_color,
        black=PlayerInfo(name="张三", rank="rank_5k") if human_color == "B" else PlayerInfo(name="李四", rank="rank_1k"),
        white=PlayerInfo(name="李四", rank="rank_1k") if human_color == "B" else PlayerInfo(name="张三", rank="rank_5k"),
        ai=AiParams(style=style, level=level, adaptive=adaptive),
        handicap=handicap,
        komi=0.0 if handicap else 7.5,
    )


@pytest.fixture
def engine():
    """默认引擎 mock：返回 Q16 落子。"""
    return _make_engine(AI_Q16)


@pytest.fixture
def svc(db, engine):
    return GameService(
        db.conn, default_config(), human_model_available=True, engine=engine
    )


class TestPlay:
    """落子：规则校验 + 回合交替。"""

    async def test_first_move_black_auto_start(self, svc, db):
        gid = await svc.create(_params())
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.move_no == 1
        assert result.color == "B"
        assert (result.x, result.y) == (3, 3)
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "active"  # 自动开局
        assert game["last_move_no"] == 1

    async def test_alternate_colors(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        result = await svc.play(gid, x=15, y=15, color="W")
        assert result.move_no == 2
        assert result.color == "W"

    async def test_wrong_color_rejected(self, svc, db):
        gid = await svc.create(_params())
        with pytest.raises(AppError) as ei:
            await svc.play(gid, x=3, y=3, color="W")  # 首手应为 B
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_occupied_point_illegal(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        with pytest.raises(AppError) as ei:
            await svc.play(gid, x=3, y=3, color="W")
        assert ei.value.code is ErrorCode.ILLEGAL_MOVE

    async def test_play_after_finished_rejected(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.resign(gid, color="B")
        with pytest.raises(AppError) as ei:
            await svc.play(gid, x=3, y=3, color="W")
        assert ei.value.code is ErrorCode.GAME_FINISHED

    async def test_play_in_scoring_rejected(self, svc, db):
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        await svc.pass_move(gid, color="W")  # 双 PASS → scoring
        with pytest.raises(AppError) as ei:
            await svc.play(gid, x=3, y=3, color="B")
        assert ei.value.code is ErrorCode.GAME_IN_SCORING

    async def test_capture_recorded(self, svc, db):
        gid = await svc.create(_params())
        # B(8,9), W(9,9), B(10,9), W他处, B(9,8), W他处, B(9,10) 提 W(9,9)
        await svc.play(gid, x=8, y=9, color="B")
        await svc.play(gid, x=9, y=9, color="W")
        await svc.play(gid, x=10, y=9, color="B")
        await svc.play(gid, x=0, y=0, color="W")
        await svc.play(gid, x=9, y=8, color="B")
        await svc.play(gid, x=18, y=18, color="W")
        result = await svc.play(gid, x=9, y=10, color="B")
        assert result.captures == 1
        moves = await repos.list_moves(db.conn, gid)
        assert len(moves) == 7

    async def test_engine_dead_human_human_unaffected(self, svc, db):
        """人人对弈引擎 DEAD 落子照常（引擎解耦）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "active"
        assert game["last_move_no"] == 2

    async def test_snapback_recapture_multiple_allowed(self, svc, db):
        """倒扑（snapback）：劫点回提多子合法（修复前误判 ILLEGAL_MOVE「打劫」）。

        着法序＝ `test_go_rules._snapback_position` 同形：B 落 (1,1) 提 W(1,0)（恰提
        一子）后 B 六子串仅一气 (1,0)，W 回提 (1,0) 提回六子 → 非打劫，须落子成功。
        """
        gid = await svc.create(_params())
        seq = [
            (0, 0, "B"), (1, 0, "W"), (2, 0, "B"), (3, 0, "W"), (0, 1, "B"),
            (0, 2, "W"), (2, 1, "B"), (3, 1, "W"), (1, 2, "B"), (2, 2, "W"),
            (8, 8, "B"), (1, 3, "W"), (1, 1, "B"),  # 末手提 W(1,0) → 劫点 (1,0)
        ]
        for x, y, color in seq:
            await svc.play(gid, x=x, y=y, color=color)
        result = await svc.play(gid, x=1, y=0, color="W")
        assert result.captures == 6


class TestPass:
    """PASS 与双 PASS 终局。"""

    async def test_single_pass_opponent_can_play(self, svc, db):
        gid = await svc.create(_params())
        result = await svc.pass_move(gid, color="B")
        assert result.is_pass is True
        assert result.entering_scoring is False
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "active"
        # 对方可落子
        await svc.play(gid, x=15, y=15, color="W")

    async def test_ko_cleared_by_pass(self, svc, db):
        """劫后对方 PASS → 劫争结束：下一手可在劫点落子（正式规则，2026/09/12 修订）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=8, y=9, color="B")
        await svc.play(gid, x=0, y=0, color="W")
        await svc.play(gid, x=10, y=9, color="B")
        await svc.play(gid, x=0, y=1, color="W")
        await svc.play(gid, x=9, y=10, color="B")
        await svc.play(gid, x=9, y=9, color="W")  # 单子：仅 (9,8) 一气
        await svc.play(gid, x=9, y=8, color="B")  # 提 W(9,9) → 劫点 (9,9)
        # 紧接下一手落劫点 → 打劫禁入
        with pytest.raises(AppError) as ei:
            await svc.play(gid, x=9, y=9, color="W")
        assert ei.value.code is ErrorCode.ILLEGAL_MOVE
        # 对方 PASS → 劫争结束；提子方可在劫点落子（修复前此处误判「打劫」）
        await svc.pass_move(gid, color="W")
        result = await svc.play(gid, x=9, y=9, color="B")
        assert result.captures == 0

    async def test_double_pass_enters_scoring(self, svc, db):
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        result = await svc.pass_move(gid, color="W")
        assert result.entering_scoring is True
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "scoring"

    async def test_ai_pass_double_pass_propagates_entering_scoring(self, svc, db):
        """BUG-029 回归：AI 应手 PASS 完成双 PASS，终局标志须上浮到外层结果。

        人类 PASS(#1) → AI 应手 PASS(#2) 即双 PASS 入结算；``entering_scoring``
        必须同时落在 ``result.ai_move`` 与**外层** ``result`` 上——WS 层仅据外层
        标志启动终局预判（``_broadcast_play_result``），只落在子结果会让结算面板
        永久停在「AI 正在分析终局局面」。
        """
        svc._engine = _make_engine([{"move": "pass", "visits": 100, "winrate": 0.5}])
        gid = await svc.create(_ai_params(human_color="B"))  # 人类黑，AI 白
        result = await svc.pass_move(gid, color="B")
        assert result.ai_move is not None
        assert result.ai_move.is_pass is True
        assert result.ai_move.entering_scoring is True  # 内层结果携带终局标志
        assert result.entering_scoring is True          # 外层结果须同步携带
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "scoring"

    async def test_cancel_scoring_requires_two_new_passes(self, svc, db):
        """BUG-025 回归：结算取消后旧 PASS 不得与新手 PASS 配对（需再次双 PASS）。

        取消前（B PASS #1 / W PASS #2）已属于上一次结算尝试；取消（边界=2）后：
        单方新 PASS（#3）**不得**与 #2 配对重新入结算，必须 #3 + #4 两个新 PASS。
        """
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        r = await svc.pass_move(gid, color="W")  # 双 PASS → SCORING
        assert r.entering_scoring is True
        await svc.cancel_scoring(gid)            # 结算取消（写入边界 last_move_no=2）
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "active"
        assert game["pass_reset_move_no"] == 2
        # 单方新 PASS：与取消前 #2 配对无效 → 仍在 PLAYING（不立即重入结算）
        r1 = await svc.pass_move(gid, color="B")
        assert r1.entering_scoring is False
        assert (await repos.get_game(db.conn, gid))["status"] == "active"
        # 第二个新 PASS（#4）：两侧均为边界后新落子 → 双 PASS 入结算
        r2 = await svc.pass_move(gid, color="W")
        assert r2.entering_scoring is True
        assert (await repos.get_game(db.conn, gid))["status"] == "scoring"

    async def test_restart_clears_pass_boundary(self, svc, db):
        """重开清空落子同时重置双 PASS 边界（BUG-025）。"""
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        await svc.pass_move(gid, color="W")
        await svc.cancel_scoring(gid)
        await svc.restart(gid)
        game = await repos.get_game(db.conn, gid)
        assert game["pass_reset_move_no"] == 0

    async def test_handicap_white_first(self, svc, db):
        """人人让子棋白先（黑先放让子）。"""
        gid = await svc.create(
            _params(mode="human_human", handicap=2, komi=0.0)
        )
        result = await svc.play(gid, x=4, y=4, color="W")
        assert result.move_no == 1
        assert result.color == "W"


class TestUndo:
    """悔棋（ISSUE-039 + T6.4 修订：人机 1/2 步含上限；人人仅单步、不限次数）。"""

    async def test_undo_human_human_single_step(self, svc, db):
        """人人对弈悔棋仅单步（2026/09/06 修订）：只撤最后一手（对手末手）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")
        result = await svc.undo(gid, color="B")  # 人人：撤 1 步（仅 W 末手）
        assert result.steps == 1
        assert result.undone_move_no == 2
        assert result.new_last_move_no == 1
        assert result.undo_count == 1
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 1
        moves = await repos.list_moves(db.conn, gid)
        assert [m["move_no"] for m in moves] == [1]

    async def test_undo_restores_capture_counter(self, svc, db):
        """BUG-031 回归：悔棋撤掉吃子手 → 提子计数器按剩余棋谱回退。"""
        gid = await svc.create(_params(board_size=9))
        await svc.play(gid, x=1, y=0, color="B")
        await svc.play(gid, x=0, y=0, color="W")
        await svc.play(gid, x=0, y=1, color="B")  # 提白 1 子
        assert (await repos.get_game(db.conn, gid))["black_captures"] == 1
        await svc.undo(gid, color="B")  # 人人单步：撤 B 吃子手
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 2
        assert game["black_captures"] == 0
        assert game["white_captures"] == 0

    async def test_undo_own_last_move_removes_one(self, svc, db):
        """人人单步悔棋：末手为己方同样只撤一步（回到空盘）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        result = await svc.undo(gid, color="B")  # 人人：撤 1 步
        assert result.steps == 1
        assert result.new_last_move_no == 0
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 0

    async def test_undo_human_ai_two_steps(self, svc, db, engine):
        """人机：人类落子 + AI 落子后，人类悔棋撤两步（回到人类落子前）。"""
        gid = await svc.create(_ai_params(human_color="B"))  # 人类黑，AI 白
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_move is not None  # AI 已落（W）
        ur = await svc.undo(gid, color="B")
        assert ur.steps == 2
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 0
        moves = await repos.list_moves(db.conn, gid)
        assert moves == []

    async def test_undo_cascades_analyses(self, svc, db, engine):
        """人机悔棋（撤 2 步）级联清理当前手数之后的分析（DATABASE §5）。"""
        gid = await svc.create(_ai_params(human_color="B"))  # 人类黑，AI 白
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_move is not None  # AI 已落（W，第 2 手）
        await repos.upsert_position_analysis(
            db.conn, game_id=gid, position_key="main:0", data_json="{}", max_visits=10
        )
        await repos.upsert_position_analysis(
            db.conn, game_id=gid, position_key="main:1", data_json="{}", max_visits=10
        )
        await repos.upsert_position_analysis(
            db.conn, game_id=gid, position_key="main:2", data_json="{}", max_visits=10
        )
        await svc.undo(gid, color="B")  # 撤 2 步 → 截断至 0
        assert await repos.get_position_analysis(db.conn, gid, "main:0") is not None
        assert await repos.get_position_analysis(db.conn, gid, "main:1") is None
        assert await repos.get_position_analysis(db.conn, gid, "main:2") is None

    async def test_undo_global_limit_no_reset_on_new_move(self, db):
        """人机对弈：全局悔棋计数上限（max_undo，T6.4 人工确认：仅人机适用）。

        每撤一步 +1（撤 2 步 +2），新落子不重置；剩余预算不足整次悔棋时整次拒绝。
        """
        from app.config import default_config

        cfg = default_config()
        cfg.play.max_undo = 2
        svc2 = GameService(
            db.conn, cfg, human_model_available=True, engine=_make_engine(AI_Q16)
        )
        gid = await svc2.create(_ai_params(human_color="B"))
        # 人类黑 (3,3) → AI 自动白 Q16=(15,3)
        result = await svc2.play(gid, x=3, y=3, color="B")
        assert result.ai_move is not None
        # 人类（黑）悔棋：末手 W（AI）→ 撤 2 步 +2
        r = await svc2.undo(gid, color="B")
        assert r.steps == 2 and r.undo_count == 2
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 0
        # 新落子不重置计数（undo_count 仍 2）
        await svc2.play(gid, x=3, y=3, color="B")
        game = await repos.get_game(db.conn, gid)
        assert game["undo_count"] == 2
        # 再悔 2 步将超限（2+2>2）→ 整次拒绝（原子，不部分执行）
        with pytest.raises(AppError) as ei:
            await svc2.undo(gid, color="B")
        assert ei.value.code is ErrorCode.UNDO_LIMIT_REACHED

    async def test_undo_human_human_unlimited(self, svc, db):
        """人人对弈悔棋不限次数且仅单步（T6.4 修订：公平性由对手确认保证，无 max_undo 上限）。"""
        gid = await svc.create(_params())
        cells = [(3, 3), (15, 15), (3, 15), (15, 3), (9, 9), (3, 9),
                 (15, 9), (9, 3), (9, 15), (6, 6), (6, 12), (12, 6)]
        for i, (x, y) in enumerate(cells, start=1):
            await svc.play(gid, x=x, y=y, color=("B" if i % 2 else "W"))
        total_steps = 0
        for _ in cells:  # 连续单步撤回 12 次 > max_undo(5)，无 UNDO_LIMIT
            r = await svc.undo(gid, color="B")
            assert r.steps == 1
            total_steps += r.steps
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 0
        assert game["undo_count"] == total_steps == len(cells)  # 计数照常累计（供记录）
        assert total_steps > 5  # 人人无上限

    async def test_undo_preflight_valid_and_errors(self, svc, db):
        """人人悔棋申请预检（undo_preflight）：单步 + 基准手数；无子可悔快速失败。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")
        plan = await svc.undo_preflight(gid, color="B")  # 人人：恒 1 步
        assert plan == {"steps": 1, "base_move_no": 2}
        # 预检不修改局面
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 2
        # 空盘预检失败
        gid2 = await svc.create(_params())
        with pytest.raises(AppError) as ei:
            await svc.undo_preflight(gid2, color="B")
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION
        # 终局预检失败（GAME_FINISHED）
        await svc.play(gid2, x=3, y=3, color="B")
        await svc.resign(gid2, color="W")
        with pytest.raises(AppError) as ei:
            await svc.undo_preflight(gid2, color="W")
        assert ei.value.code is ErrorCode.GAME_FINISHED

    async def test_undo_restart_resets_count(self, svc, db):
        """重开视为新对局：全局悔棋计数归零，可继续悔棋（人人单步）。"""
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")
        await svc.undo(gid, color="B")  # 撤 1 步 → 计数 1
        game = await repos.get_game(db.conn, gid)
        assert game["undo_count"] == 1
        await svc.restart(gid)
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "created"
        assert game["undo_count"] == 0
        # 重开后仍可悔棋
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")
        r = await svc.undo(gid, color="B")
        assert r.steps == 1 and r.undo_count == 1

    async def test_restart_resets_capture_counter(self, svc, db):
        """BUG-031 回归：重开清空落子同时提子计数器归零。"""
        gid = await svc.create(_params(board_size=9))
        await svc.play(gid, x=1, y=0, color="B")
        await svc.play(gid, x=0, y=0, color="W")
        await svc.play(gid, x=0, y=1, color="B")  # 提白 1 子
        assert (await repos.get_game(db.conn, gid))["black_captures"] == 1
        await svc.restart(gid)
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "created"
        assert game["black_captures"] == 0
        assert game["white_captures"] == 0

    async def test_undo_no_moves(self, svc, db):
        gid = await svc.create(_params())
        with pytest.raises(AppError) as ei:
            await svc.undo(gid, color="B")
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_undo_in_scoring_rejected(self, svc, db):
        gid = await svc.create(_params())
        await svc.pass_move(gid, color="B")
        await svc.pass_move(gid, color="W")
        with pytest.raises(AppError) as ei:
            await svc.undo(gid, color="B")
        assert ei.value.code is ErrorCode.GAME_IN_SCORING

    async def test_undo_invalid_color_rejected(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        with pytest.raises(AppError) as ei:
            await svc.undo(gid, color="X")
        assert ei.value.code is ErrorCode.INVALID_PAYLOAD


class TestAnalysisVersionBump:
    """局面版本号（过期任务丢弃接线，ARCHITECTURE §4.2 2026/09/10 修订）。

    - **普通落子不递增**（每手分析任务在新一手后仍有效，BUG-012）；
    - 悔棋/重开（局面结构变化）才递增主谱版本号；
    - 试下分支变化递增独立的 trial 域（不误杀主谱任务）。
    """

    async def test_undo_restart_bump_version(self, db):
        from app.config import default_config
        from app.services.analysis_service import AnalysisService

        analysis = AnalysisService(db.conn, default_config(), engine=None)
        svc = GameService(
            db.conn, default_config(), human_model_available=True, analysis=analysis
        )
        gid = await svc.create(_params())
        assert analysis.current_version(gid) == 0
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")
        # 落子不递增（主谱每手分析不因新一手过期）
        assert analysis.current_version(gid) == 0
        await svc.undo(gid, color="B")  # 人人单步悔棋（仅撤末手）→ 场景失效：+1
        assert analysis.current_version(gid) == 1
        await svc.pass_move(gid, color="W")
        assert analysis.current_version(gid) == 1  # PASS 亦不递增
        await svc.restart(gid)
        assert analysis.current_version(gid) == 2


class TestResignRestart:
    """认输与重开。"""

    async def test_resign_finishes(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        result = await svc.resign(gid, color="W")  # 白认输
        assert result.game_over is True
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "finished"
        assert game["result"] == "B+Resign"

    async def test_resign_wrong_color_rejected(self, svc, db):
        gid = await svc.create(_params())
        with pytest.raises(AppError) as ei:
            await svc.resign(gid, color="W")
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_restart_clears(self, svc, db):
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")
        await repos.upsert_position_analysis(
            db.conn, game_id=gid, position_key="main:1", data_json="{}", max_visits=10
        )
        await svc.restart(gid)
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "created"
        assert game["last_move_no"] == 0
        moves = await repos.list_moves(db.conn, gid)
        assert moves == []
        assert await repos.get_position_analysis(db.conn, gid, "main:1") is None

    async def test_restart_in_created_rejected(self, svc, db):
        gid = await svc.create(_params())
        with pytest.raises(AppError) as ei:
            await svc.restart(gid)
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION


class TestAiMove:
    """人机对弈：AI 落子（引擎 P0 查询）。"""

    async def test_ai_moves_after_human(self, svc, db, engine):
        gid = await svc.create(_ai_params(human_color="B"))  # 人类黑，AI 白
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_move is not None
        assert result.ai_move.color == "W"
        assert result.ai_move.move_no == 2
        assert (result.ai_move.x, result.ai_move.y) == (15, 3)  # Q16
        assert result.ai_pending is False
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 2

    async def test_ai_first_move_on_start(self, svc, db, engine):
        """人类执白：开局触发 AI（黑）首手。"""
        engine.submit = _make_engine(AI_Q16).submit
        gid = await svc.create(_ai_params(human_color="W"))
        result = await svc.start(gid)
        assert result is not None
        assert result.color == "B"
        assert result.move_no == 1
        assert (result.x, result.y) == (15, 3)

    async def test_ai_pending_when_engine_dead(self, svc, db):
        """引擎 DEAD：AI 侧挂起（TURN_AI 提示），人类落子不受影响。"""
        engine = _make_engine(error=AppError(ErrorCode.ENGINE_DEAD, "引擎已崩溃"))
        svc2 = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine
        )
        gid = await svc2.create(_ai_params(human_color="B"))
        result = await svc2.play(gid, x=3, y=3, color="B")
        assert result.ai_move is None
        assert result.ai_pending is True
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 1  # 人类落子已写入

    async def test_ai_query_error_suspends_ai(self, svc, db):
        """H-4：AI 引擎查询失败（EngineQueryError，非 AppError）→ 转挂起而非抛 INTERNAL_ERROR。"""
        from app.engine.analysis_engine import EngineQueryError

        svc._engine = _make_engine(error=EngineQueryError("查询超时"))
        gid = await svc.create(_ai_params(human_color="B"))
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_move is None
        assert result.ai_pending is True  # 人类落子已提交且不抛错 → 前端状态一致
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 1

    async def test_game_lock_reentrant_and_release(self, svc, db):
        """M-3：对局锁可重入（play→ai_move 嵌套不死锁），删除后经 release_game 回收。"""
        gid = await svc.create(_ai_params(human_color="B", style="standard", level=5))
        lock = svc._lock_for(gid)
        async with lock:
            async with lock:  # 同一任务重入
                assert lock._depth == 2
        assert lock._depth == 0
        svc.release_game(gid)
        assert gid not in svc._game_locks


class TestStartResumeAi:
    """T6.4 WS start 语义（开局/续行触发 AI 落子，start_or_resume_ai）。"""

    async def test_start_ai_first_created(self, svc, db):
        """人类执白（AI 黑先）：created → start → 激活 + AI 首手落子。"""
        gid = await svc.create(_ai_params(human_color="W"))
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "created"
        result = await svc.start_or_resume_ai(gid)
        assert result is not None
        assert result.color == "B"
        assert result.move_no == 1
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "active"
        assert game["last_move_no"] == 1

    async def test_start_human_first_created_activates_only(self, svc, db):
        """人类执黑（人类先）：start 仅激活开局，不触发 AI。"""
        gid = await svc.create(_ai_params(human_color="B"))
        result = await svc.start_or_resume_ai(gid)
        assert result is None
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "active"
        assert game["last_move_no"] == 0

    async def test_start_resumes_pending_ai(self, db):
        """TURN_AI 挂起（引擎 DEAD 时人类落子）→ 引擎恢复后 start 触发 AI 落子。"""
        engine = _make_engine(error=AppError(ErrorCode.ENGINE_DEAD, "引擎已崩溃"))
        svc2 = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine
        )
        gid = await svc2.create(_ai_params(human_color="B"))
        result = await svc2.play(gid, x=3, y=3, color="B")
        assert result.ai_pending is True  # AI 挂起
        # 引擎恢复（替换为可用引擎）
        svc2._engine = _make_engine(AI_Q16)
        resumed = await svc2.start_or_resume_ai(gid)
        assert resumed is not None
        assert resumed.color == "W"
        assert resumed.move_no == 2

    async def test_start_when_human_turn_rejected(self, svc, db):
        """active 且轮到人类：start 抛 ILLEGAL_ACTION（快速失败，不重复触发）。"""
        gid = await svc.create(_ai_params(human_color="B"))
        await svc.start_or_resume_ai(gid)  # 激活（人类先）
        with pytest.raises(AppError) as ei:
            await svc.start_or_resume_ai(gid)
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_start_on_finished_rejected(self, svc, db):
        """终局后 start 拒绝（GAME_FINISHED）。"""
        gid = await svc.create(_params(mode="human_human"))
        await svc.play(gid, x=3, y=3, color="B")
        await svc.resign(gid, color="W")
        with pytest.raises(AppError) as ei:
            await svc.start_or_resume_ai(gid)
        assert ei.value.code is ErrorCode.GAME_FINISHED

    async def test_human_cannot_play_ai_turn(self, svc, db, engine):
        """人机：轮到 AI 时人类落子拒绝；AI 交替落子。"""
        async def _submit(query, timeout_s=None):
            n = engine.captured.get("n", 0)
            engine.captured["n"] = n + 1
            move = "Q16" if n == 0 else "C4"
            return {"id": query.get("id"), "moveInfos": [{"move": move, "visits": 100}]}

        engine.submit = _submit
        gid = await svc.create(_ai_params(human_color="W"))  # AI 黑先
        await svc.start(gid)  # AI 首手（黑，Q16）
        # 轮到人类（白）
        result = await svc.play(gid, x=3, y=3, color="W")
        assert result.move_no == 2
        assert result.ai_move is not None  # AI 第二手（C4）
        assert (result.ai_move.x, result.ai_move.y) == (2, 15)  # C4

    async def test_ai_play_standard_query(self, svc, db, engine):
        """标准风格 AI 查询构建（maxVisits 合并 + 无 humanSLProfile）。"""
        async def _submit(query, timeout_s=None):
            engine.captured["query"] = query
            return {"id": query.get("id"), "moveInfos": AI_Q16}

        engine.submit = _submit
        gid = await svc.create(_ai_params(human_color="B", style="standard", level=5))
        await svc.play(gid, x=3, y=3, color="B")
        query = engine.captured["query"]
        assert query["priority"] == 100  # P0
        # M-7：对弈查询使用档位实际 V_play（level 5 = 5 visits），不再被分析精度下限抬高
        assert query["maxVisits"] == 5
        assert "humanSLProfile" not in query["overrideSettings"]
        assert query["overrideSettings"]["wideRootNoise"] == 0.1
        # includePolicy 一律携带（低档位回退策略采样需 `policy`，A1 人工决策）
        assert query["includePolicy"] is True

    async def test_ai_play_human_style_query(self, svc, db, engine):
        """人类风格 AI 查询构建（humanSLProfile + includePolicy）。"""
        async def _submit(query, timeout_s=None):
            engine.captured["query"] = query
            return {"id": query.get("id"), "moveInfos": AI_Q16}

        engine.submit = _submit
        gid = await svc.create(
            _ai_params(human_color="B", style="human", level=5)
        )
        await svc.play(gid, x=3, y=3, color="B")
        query = engine.captured["query"]
        assert query["overrideSettings"]["humanSLProfile"] == "rank_5k"
        assert query["includePolicy"] is True

    async def test_ai_query_handicap_initial_stones(self, svc, db, engine):
        """让子棋查询含 initialStones（黑让子）。"""
        async def _submit(query, timeout_s=None):
            engine.captured["query"] = query
            # 经典 2 子布于 (15,3)/(3,15)，D16 (3,3) 为空点
            return {"id": query.get("id"), "moveInfos": [{"move": "D16", "visits": 100, "winrate": 0.6}]}

        engine.submit = _submit
        gid = await svc.create(_ai_params(human_color="B", handicap=2))
        await svc.start(gid)  # 白（AI）先行
        query = engine.captured["query"]
        assert query["initialStones"] == [["B", "Q16"], ["B", "D4"]]

    async def test_ai_pass_selected(self, svc, db, engine):
        """AI 选择 pass。"""
        engine.submit = _make_engine([{"move": "pass", "visits": 100}]).submit
        gid = await svc.create(_ai_params(human_color="B"))
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_move is not None
        assert result.ai_move.is_pass is True

    async def test_ai_no_move_infos_busy(self, svc, db, engine):
        """引擎未返回 moveInfos → ENGINE_BUSY。"""
        engine.submit = _make_engine([]).submit
        gid = await svc.create(_ai_params(human_color="W"))  # AI 黑先
        with pytest.raises(AppError) as ei:
            await svc.start(gid)
        assert ei.value.code is ErrorCode.ENGINE_BUSY


class TestAiPolicyFallback:
    """A1（2026/09/10 人工决策）：低档位（maxVisits=1）无搜索候选 → 根策略温度采样回退。

    KataGo `maxVisits=1` 仅访问根节点、不产生子节点，响应 `moveInfos` 为空；
    GTP 语义为回退到根策略采样（searchresults.cpp getPlaySelectionValues）。
    """

    @staticmethod
    def _policy(size, weights):
        """构造策略数组（长度 size²+1，非法点 -1，末位 PASS）。"""
        arr = [-1.0] * (size * size + 1)
        for idx, w in weights.items():
            arr[idx] = w
        return arr

    async def test_human_style_13x13_falls_back_to_human_policy(self, svc, db, engine):
        """回归：13 路·人类·L3（rank_10k, maxVisits=1）—— 人类首手后 AI 不得挂起。"""
        # 13 路：K4 = (9,9) → idx = 9*13 + 9 = 126（行主序 y 自上而下）
        human_policy = self._policy(13, {126: 0.4})

        async def _submit(query, timeout_s=None):
            engine.captured["query"] = query
            return {
                "id": query.get("id"),
                "moveInfos": [],  # 1 visit：无子节点候选
                "policy": self._policy(13, {}),
                "humanPolicy": human_policy,
            }

        engine.submit = _submit
        gid = await svc.create(
            _params(
                mode="human_ai",
                board_size=13,
                color="B",
                black=PlayerInfo(name="张三"),  # 不录段位：保持固定 L3 档位（rank_10k）
                white=PlayerInfo(name="真人"),
                ai=AiParams(style="human", level=3),
                komi=0.0,
            )
        )
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_pending is False
        assert result.ai_move is not None
        assert (result.ai_move.x, result.ai_move.y) == (9, 9)  # 策略回退选点 K4
        query = engine.captured["query"]
        assert query["maxVisits"] == 1  # 人类 L3 档位未改动
        assert query["overrideSettings"]["humanSLProfile"] == "rank_10k"

    async def test_standard_style_falls_back_to_policy(self, svc, db, engine):
        """标准风格 L1（maxVisits=1）：moveInfos 为空 → 按标准 `policy` 采样落子。"""
        policy = self._policy(19, {3 * 19 + 15: 0.3})  # Q16 = (15,3)

        async def _submit(query, timeout_s=None):
            engine.captured["query"] = query
            return {"id": query.get("id"), "moveInfos": [], "policy": policy}

        engine.submit = _submit
        gid = await svc.create(
            _params(
                mode="human_ai",
                color="B",
                black=PlayerInfo(name="张三"),  # 不录段位：保持固定 L1 档位
                white=PlayerInfo(name="真人"),
                ai=AiParams(style="standard", level=1),
            )
        )
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_pending is False
        assert result.ai_move is not None
        assert (result.ai_move.x, result.ai_move.y) == (15, 3)  # Q16
        assert engine.captured["query"]["maxVisits"] == 1

    async def test_fallback_ignored_when_move_infos_present(self, svc, db, engine):
        """有搜索候选时仍按 visits 采样（策略回退不参与）——L5（maxVisits=5）。"""
        policy = self._policy(19, {3 * 19 + 15: 0.999})  # 策略推荐 Q16

        async def _submit(query, timeout_s=None):
            engine.captured["query"] = query
            return {
                "id": query.get("id"),
                "moveInfos": [{"move": "C4", "visits": 100}],
                "policy": policy,
            }

        engine.submit = _submit
        gid = await svc.create(_ai_params(human_color="B", style="standard", level=5))
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.ai_move is not None
        assert (result.ai_move.x, result.ai_move.y) == (2, 15)  # C4（visits 采样）


class TestUndoDuringAiThink:
    """悔棋中断 AI 应手（2026/09/13 人工决策）。

    AI 思考期间（``defer_ai`` 后台任务 + 在途引擎查询）悔棋：先经 KataGo terminate
    中止查询并丢弃结果（AI 不落子），再按末手语义撤 1 步。
    """

    async def test_defer_ai_returns_before_ai(self, db):
        """defer_ai：落子处理器返回时 AI 应手未执行（不阻塞消息循环）。"""
        engine = SlowPlayEngine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        result = await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        assert result.ai_deferred is True
        assert engine.state["inflight"] == 0
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 1

    async def test_undo_during_ai_think_terminates_query_and_removes_one(self, db):
        """AI 查询在途时悔棋：terminate 查询 → 结果丢弃不落子 → 撤 1 步。"""
        engine = SlowPlayEngine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        task = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):  # 时间窗口轮询：等待 AI 查询在途（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if engine.state["inflight"]:
                break
        assert engine.state["inflight"] == 1
        ur = await svc.undo(gid, color="B")
        assert ur.steps == 1  # 末手为己方 → 撤 1 步（上限也只消耗 1）
        assert ur.new_last_move_no == 0
        assert ur.undo_count == 1
        # 已请求终止在途查询（id 带随机后缀：同手数复用会撞旧响应）
        assert len(engine.state["terminated"]) == 1
        assert engine.state["terminated"][0].startswith(f"tgo-ai-{gid}-1-")
        carrier = await task
        assert carrier.ai_cancelled is True
        assert carrier.ai_move is None  # 部分结果丢弃：AI 不落子
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 0
        assert await repos.list_moves(db.conn, gid) == []

    async def test_abort_registered_before_submit_skips_query(self, db):
        """悔棋早于查询提交（AI 预处理期到达）→ 提交前消费中断标志，不发查询。"""
        engine = SlowPlayEngine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        svc._ai_abort[gid] = 1  # 模拟悔棋在 resolve_ai_turn 启动前已登记
        carrier = await svc.resolve_ai_turn(gid)
        assert carrier.ai_cancelled is True
        assert engine.state["inflight"] == 0
        assert engine.state["terminated"] == []

    async def test_undo_then_replay_issues_fresh_query_id(self, db):
        """悔棋后同手数再落子：新一轮查询用全新 id，旧响应不再撞入新 future。

        回归背景（2026/09/13）：查询 id 曾为 ``tgo-ai-{gid}-{手数}``——悔棋撤销到
        同手数再落子时 id 复用，第一条查询的迟到响应被引擎层按 id 分发到第二条
        查询的 future，AI 拿旧局面结果落子，撞上人类新落之子（“该点已有棋子”）。
        """
        engine = SlowPlayEngine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        task1 = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):  # 时间窗口轮询：等待 AI 查询在途（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if engine.state["inflight"]:
                break
        ur1 = await svc.undo(gid, color="B")  # 中止第一条查询（竞速不等响应）
        assert ur1.steps == 1
        carrier1 = await task1
        assert carrier1.ai_cancelled is True
        # 同手数再落子（撤销后 #1）→ 第二条查询
        await svc.play(gid, x=15, y=15, color="B", defer_ai=True)
        task2 = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):
            await asyncio.sleep(0.005)
            if engine.state["inflight"]:
                break
        assert engine.state["inflight"] == 1
        ur2 = await svc.undo(gid, color="B")  # 收尾：中止第二条
        assert ur2.steps == 1
        carrier2 = await task2
        assert carrier2.ai_cancelled is True
        ids = engine.state["ids"]
        assert len(ids) == 2
        assert ids[0] != ids[1]  # 同手数不复用 id：旧响应不会撞新查询
        assert ids[0].startswith(f"tgo-ai-{gid}-1-")
        assert ids[1].startswith(f"tgo-ai-{gid}-1-")

    async def test_undo_after_ai_played_two_steps(self, db):
        """对局正常（未被中断）：AI 应手已落子后，悔棋仍撤 2 步（既有语义不变）。"""
        engine = _make_engine(AI_Q16)
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        carrier = await svc.resolve_ai_turn(gid)
        assert carrier.ai_cancelled is False
        assert carrier.ai_move is not None
        ur = await svc.undo(gid, color="B")
        assert ur.steps == 2
        assert ur.new_last_move_no == 0

    async def test_rejected_undo_keeps_ai_thinking(self, db):
        """被拒的悔棋不得中止在途 AI 应手（2026/09/13 修复）。

        回归背景：旧顺序（先登记 abort/terminate、后检查额度）在"思考中点悔棋
        但额度不足"时已把 AI 应手静默中止——用户只收到 UNDO_LIMIT_REACHED，
        「思考中」却滞留（AI 已被杀，须等自动续行重试重算才清除）。
        """
        cfg = default_config()
        cfg.play.max_undo = 2
        engine = _make_engine(AI_Q16)
        svc = GameService(db.conn, cfg, human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        await svc.resolve_ai_turn(gid)  # B#1, W#2（唯一一次 AI 落子）
        ur = await svc.undo(gid, color="B")  # 撤 2 → undo_count=2=max
        assert ur.steps == 2
        # 换慢引擎：B#3 → AI 应手在途（挂起）
        slow = SlowPlayEngine()
        svc._engine = slow
        await svc.play(gid, x=3, y=4, color="B", defer_ai=True)
        task = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):  # 时间窗口轮询：等待 AI 查询在途（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if slow.state["inflight"]:
                break
        assert slow.state["inflight"] == 1
        # 思考中悔棋：撤 1，但 2+1 > 2 → 被拒；关键：AI 应手未被触碰
        with pytest.raises(AppError) as ei:
            await svc.undo(gid, color="B")
        assert ei.value.code is ErrorCode.UNDO_LIMIT_REACHED
        assert slow.state["terminated"] == []  # 未发 terminate
        assert slow.state["inflight"] == 1  # 查询仍在途（未被中止）
        # 收尾：放行慢引擎（空候选 → AI 侧挂起），任务正常结束
        slow.release()
        carrier = await task
        assert carrier.ai_pending is True

    async def test_undo_completes_without_engine_response(self, db):
        """引擎终止后迟迟不回包（过载）→ 悔棋不等响应，立即完成（竞速路径）。

        ``wait_for(2.0)`` 兼作回归闸门：若实现退化为死等引擎响应，测试将超时失败。
        """
        engine = StuckPlayEngine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        task = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):  # 时间窗口轮询：等待 AI 查询在途（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if engine.state["inflight"]:
                break
        assert engine.state["inflight"] == 1
        try:
            ur = await asyncio.wait_for(svc.undo(gid, color="B"), timeout=2.0)
            carrier = await asyncio.wait_for(task, timeout=2.0)
        finally:
            engine.release()  # 放行挂起的 submit 任务，避免悬挂
        assert ur.steps == 1
        assert ur.new_last_move_no == 0
        # 已请求终止在途查询（id 带随机后缀：同手数复用会撞旧响应）
        assert len(engine.state["terminated"]) == 1
        assert engine.state["terminated"][0].startswith(f"tgo-ai-{gid}-1-")
        assert carrier.ai_cancelled is True
        assert carrier.ai_move is None
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 0

    async def test_undo_interrupts_adaptive_pre_analysis(self, db):
        """自适应判定前置链分析在途时悔棋：登记即放弃等待 + terminate 中止查询。

        回归背景（2026/09/13）：前置分析直连引擎且未登记 ``_ai_inflight``——悔棋
        既无法经 terminate 中止它，又须等它跑完才能取得对局锁（``resolve_ai_turn``
        持锁），用户表现为「点悔棋后『思考中』迟迟不清除」；其结果还会在悔棋
        截断后落链/推送 → 曲线旧点残留。
        """
        from app.services.analysis_service import AnalysisService

        engine = SlowPlayEngine()
        analysis = AnalysisService(db.conn, default_config(), engine=None)
        svc = GameService(
            db.conn,
            default_config(),
            human_model_available=True,
            engine=engine,
            analysis=analysis,
        )
        gid = await svc.create(_ai_params(style="human", level=5, adaptive=True))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        task = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):  # 时间窗口轮询：等待前置链查询在途（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if engine.state["inflight"]:
                break
        assert engine.state["inflight"] == 1
        # 悔棋不得被前置分析拖住（wait_for 兼作回归闸门）
        ur = await asyncio.wait_for(svc.undo(gid, color="B"), timeout=2.0)
        assert ur.steps == 1
        assert ur.new_last_move_no == 0
        # 前置链查询已被 terminate 中止（id 前缀/随机后缀可识别）
        assert len(engine.state["terminated"]) == 1
        assert engine.state["terminated"][0].startswith(f"tgo-chain-{gid}-1-")
        carrier = await asyncio.wait_for(task, timeout=2.0)
        assert carrier.ai_cancelled is True
        assert carrier.ai_move is None
        # 被中断的前置分析未落链（该局面已被悔棋截断）
        assert await repos.get_main_analysis(db.conn, gid, 1) is None

    async def test_aborted_pre_analysis_result_not_ingested(self, db):
        """悔棋登记后抵达的前置分析结果不落链、不推曲线（迟到回包丢弃）。

        覆盖「查询先于中断登记完成、结果晚于登记被消费」的时序：回包后须检查
        中断标志，命中即丢弃（否则被撤局面的链行/曲线点会在截断后残留）。
        """
        from app.services.analysis_service import AnalysisService

        engine = SlowPlayEngine()
        analysis = AnalysisService(db.conn, default_config(), engine=None)
        svc = GameService(
            db.conn,
            default_config(),
            human_model_available=True,
            engine=engine,
            analysis=analysis,
        )
        gid = await svc.create(_ai_params(style="human", level=5, adaptive=True))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        task = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):  # 时间窗口轮询：等待前置链查询在途（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if engine.state["inflight"]:
                break
        assert engine.state["inflight"] == 1
        svc._ai_abort[gid] = 1  # 模拟悔棋已登记（查询已提交、结果尚未回）
        engine.release()  # 引擎回包（早于 abort 竞速观察）→ 走登记后消费路径
        carrier = await asyncio.wait_for(task, timeout=2.0)
        assert carrier.ai_cancelled is True
        assert carrier.ai_move is None
        # 结果被丢弃：不落链（对应曲线点亦不推送）
        assert await repos.get_main_analysis(db.conn, gid, 1) is None


class TestUserIntentAbortsAiTurn:
    """R1（2026/09/16 对弈服务评审批次）：认输/重开/续行不得被在途 AI 应手拖住。

    回归背景：AI 应手全程持有对局锁（``resolve_ai_turn``/``_ai_move`` 在锁内等待引擎
    响应，最长至查询超时 180s）；旧实现仅悔棋登记了中断竞速——认输/重开/续行直接
    排队等待，引擎卡死（terminate 后不回包）时用户操作无任何反馈（连接内消息循环
    亦被阻塞）。本组用例以 ``StuckPlayEngine`` 闸门 + ``wait_for`` 兼作回归闸门。
    """

    async def _arm(self, svc, engine, gid) -> asyncio.Task:
        """人类落子 + AI 应手在途（挂起于闸门引擎），返回应手任务。"""
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        task = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):  # 时间窗口轮询：等待 AI 查询在途（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if engine.state["inflight"]:
                break
        assert engine.state["inflight"] == 1
        return task

    async def test_resign_not_blocked_by_inflight_ai(self, db):
        engine = StuckPlayEngine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        task = await self._arm(svc, engine, gid)
        try:
            result = await asyncio.wait_for(svc.resign(gid, color="B"), timeout=0.5)
        finally:
            engine.release()  # 收尾：放行挂起的 submit（避免悬挂任务）
        carrier = await asyncio.wait_for(task, timeout=2.0)
        game = await repos.get_game(db.conn, gid)
        assert result.game_over is True
        assert game["status"] == "finished"
        assert game["result"] == "W+Resign"
        assert game["last_move_no"] == 1  # AI 应手结果丢弃、未落子
        assert engine.state["terminated"] == [engine.state["ids"][0]]
        assert carrier.ai_cancelled is True

    async def test_restart_not_blocked_by_inflight_ai(self, db):
        engine = StuckPlayEngine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        task = await self._arm(svc, engine, gid)
        try:
            await asyncio.wait_for(svc.restart(gid), timeout=0.5)
        finally:
            engine.release()
        carrier = await asyncio.wait_for(task, timeout=2.0)
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "created"
        assert game["last_move_no"] == 0
        assert (await repos.list_moves(db.conn, gid)) == []
        assert carrier.ai_cancelled is True

    async def test_start_resume_not_blocked_by_inflight_ai(self, db):
        engine = StuckPlayEngine()
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        task = await self._arm(svc, engine, gid)
        try:
            carrier = await asyncio.wait_for(
                svc.start_or_resume_ai(gid, defer_ai=True), timeout=0.5
            )
        finally:
            engine.release()
        old = await asyncio.wait_for(task, timeout=2.0)
        assert carrier is not None and carrier.ai_deferred is True
        assert engine.state["terminated"] == [engine.state["ids"][0]]
        assert old.ai_cancelled is True


class TestAiPendingObservability:
    """R2（2026/09/16 对弈服务评审批次）：AI 应手后台失败 → 挂起原因随 ``game.state`` 回投。

    回归背景：``_maybe_trigger_ai`` 捕获引擎类错误只置 ``ai_pending=True``（仅广播
    ``game.state``，无错误信封/原因字段）——引擎仍可用（如查询失败）时前端只看到
    「思考中」，无从判断「AI 应手已失败」，也没有重试依据。
    """

    async def test_pending_reason_exposed_in_snapshot(self, db):
        engine = _make_engine(AI_Q16, error=EngineQueryError("查询超时"))
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        carrier = await svc.resolve_ai_turn(gid)
        assert carrier.ai_pending is True
        snap = await svc.snapshot(gid)
        assert snap["turn"] == "TURN_AI"
        assert snap["ai_pending"] is not None
        assert snap["ai_pending"]["code"] == "ENGINE_BUSY"
        assert "AI 落子引擎查询失败" in snap["ai_pending"]["message"]

    async def test_pending_cleared_after_retry_success(self, db):
        engine = _make_engine(AI_Q16, error=EngineQueryError("查询超时"))
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        assert (await svc.resolve_ai_turn(gid)).ai_pending is True
        svc._engine = _make_engine(AI_Q16)  # 引擎恢复
        carrier = await svc.resolve_ai_turn(gid)
        assert carrier.ai_move is not None
        snap = await svc.snapshot(gid)
        assert snap["ai_pending"] is None
        assert snap["turn"] == "TURN_HUMAN"

    async def test_pending_none_for_human_human(self, db, engine):
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_params())
        snap = await svc.snapshot(gid)
        assert snap["ai_pending"] is None


class TestGameLockLifecycle:
    """R5（2026/09/16 对弈服务评审批次）：``release_game``（对局删除）不得回收**被持有**
    的对局锁——否则在途操作后续嵌套取锁会新建另一把锁（同局两把锁 = 互斥失效）。"""

    async def test_release_skips_held_lock(self, db, engine):
        svc = GameService(db.conn, default_config(), human_model_available=True, engine=engine)
        gid = await svc.create(_params())
        lock = svc._lock_for(gid)
        async with lock:
            svc.release_game(gid)
            assert svc._lock_for(gid) is lock  # 持锁期间保持同一把锁
        svc.release_game(gid)
        assert svc._lock_for(gid) is not lock  # 空闲后可正常回收


class TestDeleteGameAbort:
    """M-6（2026/09/19 决策 B）：删除对局先中止在途 AI + 锁内删除 + 内存态回收。"""

    async def test_delete_during_ai_think_aborts_and_cleans(self, db):
        """AI 思考中删除：在途查询被 terminate、删除等待锁、条目全部回收。

        缺陷形态（旧实现）：路由直接删行不取锁——在途 AI 随后落库命中已删对局
        （外键 IntegrityError → INTERNAL_ERROR）；锁/挂起标记滞留内存无回收。
        """
        engine = SlowPlayEngine()
        svc = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine
        )
        gid = await svc.create(_ai_params(mode="human_ai", human_color="B"))
        await svc.play(gid, x=3, y=3, color="B", defer_ai=True)
        task = asyncio.create_task(svc.resolve_ai_turn(gid))
        for _ in range(200):  # 时间窗口轮询：等待 AI 查询在途（不依赖瞬时值）
            await asyncio.sleep(0.005)
            if engine.state["inflight"]:
                break
        assert engine.state["inflight"] == 1
        try:
            deleted = await asyncio.wait_for(svc.delete_game(gid), timeout=2.0)
            carrier = await asyncio.wait_for(task, timeout=2.0)
        finally:
            engine.release()  # 放行挂起的 submit，避免悬挂
        assert deleted is True
        assert engine.state["terminated"], "在途 AI 查询应被 terminate 中止"
        assert carrier.ai_cancelled is True
        assert await repos.get_game(db.conn, gid) is None
        # 内存态回收：锁/挂起标记不残留（旧实现锁条目滞留）
        assert gid not in svc._game_locks
        assert gid not in svc._ai_pending
        assert gid not in svc._ai_inflight
        assert gid not in svc._ai_abort

    async def test_delete_missing_game_returns_false(self, db, engine):
        svc = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine
        )
        assert await svc.delete_game(9999) is False
        assert 9999 not in svc._ai_abort


class TestBoardPrefixCache:
    """M-8：棋盘前缀缓存——同手数拷贝 / 较旧快照增量回放 / 结构变化失效。"""

    async def test_incremental_replay_skips_handicap(self, db, engine, monkeypatch):
        """增量回放不重放让子初始石；命中零读取（旧实现每手全量回放）。"""
        svc = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine
        )
        gid = await svc.create(_params(handicap=2, komi=0))  # 让子局：白先
        await svc.play(gid, x=3, y=3, color="W")
        calls = {"place": 0, "list": 0}
        orig_place = go_rules.GoBoard.place_handicap
        orig_list = repos.list_moves

        def counting_place(self, points):
            calls["place"] += 1
            return orig_place(self, points)

        async def counting_list(conn, game_id):
            calls["list"] += 1
            return await orig_list(conn, game_id)

        monkeypatch.setattr(go_rules.GoBoard, "place_handicap", counting_place)
        monkeypatch.setattr(repos, "list_moves", counting_list)

        game = await repos.get_game(db.conn, gid)
        b1 = await svc._build_board(game)  # 缓存 #0（首手内部）→ #1：增量
        assert calls["place"] == 0, "增量回放不得重放让子初始石"
        reads_after_b1 = calls["list"]
        b2 = await svc._build_board(game)  # 命中 → 零读取
        assert calls["list"] == reads_after_b1
        b2.play(9, 9, "B")  # 修改返回副本不得污染缓存
        await svc.play(gid, x=15, y=15, color="B")
        assert calls["place"] == 0
        game2 = await repos.get_game(db.conn, gid)
        b3 = await svc._build_board(game2)  # 命中（play 内部已缓存 #2）
        assert b3.stone_at(9, 9) is None, "缓存快照不得被调用方修改污染"
        assert b3.stone_at(15, 15) == "B"
        svc._board_cache.pop(gid)
        b4 = await svc._build_board(game2)  # 清缓存 → 全量回放（重放让子）
        assert calls["place"] == 1
        assert b4.grid() == b3.grid(), "增量/全量回放结果必须一致"

    async def test_structural_change_invalidates_cache(self, db, engine):
        """悔棋/重开（结构变化）必须失效棋盘缓存（防同手数命中旧快照）。"""
        svc = GameService(
            db.conn, default_config(), human_model_available=True, engine=engine
        )
        gid = await svc.create(_params())
        await svc.play(gid, x=3, y=3, color="B")
        game = await repos.get_game(db.conn, gid)
        await svc._build_board(game)
        assert gid in svc._board_cache
        await svc.restart(gid)
        assert gid not in svc._board_cache, "重开必须失效棋盘缓存"
        await svc.play(gid, x=3, y=3, color="B")
        await svc.play(gid, x=15, y=15, color="W")
        game = await repos.get_game(db.conn, gid)
        await svc._build_board(game)
        assert gid in svc._board_cache
        await svc.undo(gid, color="W")
        assert gid not in svc._board_cache, "悔棋必须失效棋盘缓存"


class TestAiHumanModelUnavailable:
    """B2（2026/09/10 人工决策）：人类模型未挂载 → 人类风格对局阻断并提示。

    引擎未挂载人类模型时下发 `humanSLProfile` 会被 KataGo 整体拒绝
    （"Could not set settings: WARNING: humanSLProfile is specified as config param
    but model(s) don't use it"）→ 提前阻断，不下发非法查询。
    """

    async def test_existing_human_style_game_blocked(self, db, engine):
        """存量人类风格对局（创建后人类模型被移除）→ AI 挂起且不下发查询。"""
        available = {"v": True}
        svc2 = GameService(
            db.conn,
            default_config(),
            human_model_available=True,
            human_model_available_fn=lambda: available["v"],
            engine=engine,
        )
        gid = await svc2.create(_ai_params(human_color="B", style="human", level=5))
        available["v"] = False  # 引擎重建后未挂载人类模型
        result = await svc2.play(gid, x=3, y=3, color="B")
        assert result.ai_move is None
        assert result.ai_pending is True
        assert engine.captured == {}  # 未提交任何查询
        game = await repos.get_game(db.conn, gid)
        assert game["last_move_no"] == 1  # 人类落子已写入（对局可恢复）

    async def test_start_resume_blocked_raises(self, db, engine):
        """恢复触发（start_or_resume_ai）→ 抛 HUMAN_MODEL_UNAVAILABLE（WS 错误信封提示）。"""
        available = {"v": True}
        svc2 = GameService(
            db.conn,
            default_config(),
            human_model_available=True,
            human_model_available_fn=lambda: available["v"],
            engine=engine,
        )
        gid = await svc2.create(_ai_params(human_color="W", style="human", level=5))
        available["v"] = False
        with pytest.raises(AppError) as ei:
            await svc2.start_or_resume_ai(gid)
        assert ei.value.code is ErrorCode.HUMAN_MODEL_UNAVAILABLE

    async def test_adaptive_style_blocked(self, db, engine):
        """自适应难度同样依赖人类模型 → 未挂载即阻断（PRD §4.1.1）。"""
        available = {"v": True}
        svc2 = GameService(
            db.conn,
            default_config(),
            human_model_available=True,
            human_model_available_fn=lambda: available["v"],
            engine=engine,
        )
        gid = await svc2.create(
            _ai_params(human_color="B", style="human", level=5, adaptive=True)
        )
        available["v"] = False
        result = await svc2.play(gid, x=3, y=3, color="B")
        assert result.ai_pending is True
        assert engine.captured == {}

    async def test_standard_style_not_blocked(self, db):
        """标准风格不依赖人类模型：人类模型缺失仍正常落子（仅人类风格/自适应阻断）。"""
        engine = _make_engine(AI_Q16)
        svc2 = GameService(
            db.conn,
            default_config(),
            human_model_available=False,
            engine=engine,
        )
        gid = await svc2.create(_ai_params(human_color="B", style="standard", level=5))
        result = await svc2.play(gid, x=3, y=3, color="B")
        assert result.ai_pending is False
        assert result.ai_move is not None


class TestAutoPass:
    """无子可下自动 PASS。"""

    async def test_auto_pass_double_to_scoring(self, svc, db, monkeypatch):
        """无子可下自动 PASS 直至双 PASS 进入结算。"""
        monkeypatch.setattr(
            go_rules.GoBoard, "has_legal_move", lambda self, color: False
        )
        gid = await svc.create(_params())
        result = await svc.play(gid, x=3, y=3, color="B")
        assert result.auto_pass is not None
        assert result.entering_scoring is True
        game = await repos.get_game(db.conn, gid)
        assert game["status"] == "scoring"
        moves = await repos.list_moves(db.conn, gid)
        assert len(moves) == 3  # B(3,3) + W自动PASS + B自动PASS
        assert moves[1]["is_pass"] == 1 and moves[2]["is_pass"] == 1
