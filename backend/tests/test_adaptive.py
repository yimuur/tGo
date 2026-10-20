"""T3.8 自适应难度测试（TASK T3.8 / LEVEL.md 算法 / PRD §4.1.3）。

用例 ID: ADAPT-*
- 升级/降级/保持三分支（Score Lead 主指标 + Score Loss 副指标）；
- 滑动窗口仅统计人类落子；档位写回 games.ai_level；
- 降级注入负 PDA；阈值配置化；无分析数据保守保持。
"""

import json

import pytest

from app.config import AppConfig, default_config
from app.db import repos
from app.services.adaptive import AdaptiveDecision, AdaptiveDifficulty


async def _mk_game(db, *, level=5, human_color="B", moves=None, handicap=0, komi=7.5):
    """构造自适应人机对局 + 落子序列（direct repos，绕过引擎）。"""
    gid = await _await_create_game(
        db, human_color=human_color, level=level, handicap=handicap, komi=komi
    )
    for i, (color, x, y) in enumerate(moves or [], start=1):
        await repos.append_move(db.conn, game_id=gid, move_no=i, color=color, x=x, y=y)
    return gid


async def _await_create_game(db, *, human_color="B", level=5, handicap=0, komi=7.5):
    return await repos.create_game(
        db.conn,
        mode="human_ai",
        board_size=19,
        komi=komi,
        handicap=handicap,
        human_color=human_color,
        ai_style="human",
        ai_level=level,
        adaptive_enabled=True,
        adaptive_initial_level="rank_5k",
    )


async def _store(db, gid, move_no, root, infos):
    data = {"rootInfo": root, "moveInfos": infos}
    await repos.upsert_position_analysis(
        db.conn, game_id=gid, position_key=f"main:{move_no}",
        data_json=json.dumps(data), max_visits=100,
    )


@pytest.fixture
def adaptive(db):
    return AdaptiveDifficulty(db.conn, default_config())


async def _game(db, gid):
    return await repos.get_game(db.conn, gid)


class TestDecide:
    """升/降/保持三分支。"""

    async def test_upgrade_on_lead_and_zero_mistakes(self, db, adaptive):
        """人类领先 +10 且近期零失误 → UP。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        # 黑方视角 scoreLead（ISSUE-050，人类执黑）＝人类领先 +10
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": 10.0}, [])
        # 局面 main:2 分析：B(5,5)="F14" 目损 0.2
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": 3.0}, [
            {"move": "F14", "scoreLead": 1.8},
            {"move": "Q16", "scoreLead": 2.0},
        ])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.UP

    async def test_downgrade_on_losing_lead(self, db, adaptive):
        """人类落后 -20 → DOWN。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        # 黑方视角 -20（人类执黑即落后）
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": -20.0}, [])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.DOWN

    async def test_downgrade_on_high_loss(self, db, adaptive):
        """近期平均目数损失 > 3.0 → DOWN（即使领先）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": 0.0}, [])
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": 5.0}, [
            {"move": "F14", "scoreLead": -2.0},   # 目损 7.0
            {"move": "Q16", "scoreLead": 5.0},
        ])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.DOWN

    async def test_keep_in_stalemate(self, db, adaptive):
        """胶着状态 → KEEP。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        # 黑方视角 -5（人类执黑落后 5，未达 -15 降级阈值）
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": -5.0}, [])
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": 0.0}, [
            {"move": "F14", "scoreLead": -1.0},   # 目损 1.0（0.5~3.0 之间）
            {"move": "Q16", "scoreLead": 0.0},
        ])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.KEEP

    async def test_no_analysis_keeps(self, db, adaptive):
        """无分析数据（引擎不可用）→ 保守 KEEP。"""
        gid = await _mk_game(db, moves=[("B", 3, 3)])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.KEEP

    async def test_no_human_move_keeps(self, db, adaptive):
        """AI 先行局初始局面（人类尚未落子）→ KEEP，即使初始局面 lead 已过阈值（BUG-028）。

        判定数据（当前局面 lead / 人类目损窗口）来自**人类落子后**的局面：人类未落子
        即无表现数据可言（否则让子局初始目差会立即误升档，偏离「初始水平」语义）。
        """
        gid = await _mk_game(db, human_color="B", moves=[])
        # 黑方视角 +12（人类执黑领先，超过 +8 升级阈值）
        await _store(db, gid, 0, {"currentPlayer": "B", "scoreLead": 12.0}, [])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.KEEP

    async def test_handicap_uses_absolute_lead(self, db, adaptive):
        """让子局按**绝对目差**判定（ISSUE-058 决策，2026/09/12）：不扣除让子基线。

        让 2 子（贴 0）人类执黑首手后黑方视角 +12 = 让子价值本身；绝对口径下
        超过 +8 → 升级（不再额外归一化——让子差计入「领先」，直至收敛到阈值内）。
        """
        gid = await _mk_game(db, moves=[("B", 3, 3)], handicap=2, komi=0.0)
        await _store(db, gid, 1, {"currentPlayer": "W", "scoreLead": 12.0}, [])
        game = await _game(db, gid)
        decision, level, _ = await adaptive.adjust(game)
        assert decision is AdaptiveDecision.UP
        assert level == 6


class TestHumanPerspective:
    """人类视角换算（黑方视角 scoreLead，ISSUE-050：按 human_color 取正/反）。"""

    async def test_human_black_lead_up(self, db, adaptive):
        """人类执黑：黑方视角 scoreLead 直接等于人类领先。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        # 黑方 +12（人类执黑）→ UP
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": 12.0}, [])
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": 0.0}, [
            {"move": "F14", "scoreLead": 0.1},
            {"move": "Q16", "scoreLead": 0.2},
        ])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.UP

    async def test_human_white_lead_negated(self, db, adaptive):
        """人类执白：黑方视角 scoreLead 取反（人类领先 = -黑方）。"""
        gid = await _mk_game(db, human_color="W", moves=[("W", 3, 3), ("B", 15, 15)])
        # 黑方 -10 → 人类（白）+10 → UP（无损失数据）
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": -10.0}, [])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.UP

    async def test_lead_direct_when_human_to_move(self, db, adaptive):
        """人类执黑黑方视角即人类视角（不依赖 currentPlayer/轮次）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)])  # 轮到 B（人类）
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": 10.0}, [])
        game = await _game(db, gid)
        # 人类 +10（>8），无人类落子损失数据 → UP
        assert await adaptive.decide(game) is AdaptiveDecision.UP


class TestWindow:
    """滑动窗口仅统计人类落子。"""

    async def test_window_counts_only_human_moves(self, db, adaptive):
        # 6 手：B,W,B,W,B,W → 人类(B)落子 1,3,5
        gid = await _mk_game(db, moves=[
            ("B", 3, 3), ("W", 15, 15),
            ("B", 5, 5), ("W", 16, 16),
            ("B", 7, 7), ("W", 17, 17),
        ])
        await _store(db, gid, 6, {"currentPlayer": "B", "scoreLead": 0.0}, [])
        # 人类落子 1,3,5 对应的前一局面分析：best - played = 目损
        for prev, loss in [(0, 0.4), (2, 0.3), (4, 0.2)]:
            await _store(db, gid, prev, {"currentPlayer": "B", "scoreLead": 0.0}, [
                {"move": sl_key(prev), "scoreLead": 0.0},  # 实际落子目损 0
                {"move": "Q16", "scoreLead": loss},        # best 目损 = loss
            ])
        game = await _game(db, gid)
        mean = await adaptive._recent_score_loss(game)
        assert mean is not None
        assert abs(mean - 0.3) < 1e-6  # (0.4+0.3+0.2)/3


def sl_key(move_no):
    """局面 move_no 后人类落子的 GTP 键（与 moves 对应）。"""
    return {0: "D16", 2: "F14", 4: "H12"}[move_no]


class TestAdjust:
    """档位调整与写回。"""

    async def test_adjust_up_writes_level(self, db, adaptive):
        gid = await _mk_game(db, level=5, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        # 黑方 +10（人类执黑领先）→ UP
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": 10.0}, [])
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": 0.0}, [
            {"move": "F14", "scoreLead": 0.1},
            {"move": "Q16", "scoreLead": 0.2},
        ])
        game = await _game(db, gid)
        decision, level, pda = await adaptive.adjust(game)
        assert decision is AdaptiveDecision.UP
        assert level == 6
        assert pda is None
        game2 = await _game(db, gid)
        assert game2["ai_level"] == 6  # 写回

    async def test_adjust_down_injects_pda(self, db, adaptive):
        gid = await _mk_game(db, level=5, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        # 黑方 -20（人类执黑落后）→ DOWN
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": -20.0}, [])
        game = await _game(db, gid)
        decision, level, pda = await adaptive.adjust(game)
        assert decision is AdaptiveDecision.DOWN
        assert level == 4
        assert pda == default_config().adaptive.playout_doubling_advantage  # 负 PDA
        assert pda < 0
        game2 = await _game(db, gid)
        assert game2["ai_level"] == 4

    async def test_level_bounds(self, db, adaptive):
        """档位边界：12 不再升、1 不再降。"""
        gid = await _mk_game(db, level=12, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": 10.0}, [])
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": 0.0}, [
            {"move": "F14", "scoreLead": 0.1},
            {"move": "Q16", "scoreLead": 0.2},
        ])
        game = await _game(db, gid)
        decision, level, _ = await adaptive.adjust(game)
        assert decision is AdaptiveDecision.UP
        assert level == 12  # 封顶

        gid2 = await _mk_game(db, level=1, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        await _store(db, gid2, 3, {"currentPlayer": "W", "scoreLead": -20.0}, [])
        game2 = await _game(db, gid2)
        decision2, level2, _ = await adaptive.adjust(game2)
        assert decision2 is AdaptiveDecision.DOWN
        assert level2 == 1  # 保底

    async def test_keep_does_not_write(self, db, adaptive):
        gid = await _mk_game(db, level=5, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": 5.0}, [])
        game = await _game(db, gid)
        decision, level, pda = await adaptive.adjust(game)
        assert decision is AdaptiveDecision.KEEP
        assert level == 5
        assert pda is None
        game2 = await _game(db, gid)
        assert game2["ai_level"] == 5


class TestConfigDriven:
    """阈值配置化（config.yaml 唯一事实源）。"""

    async def test_custom_thresholds(self, db):
        cfg = AppConfig()
        cfg.adaptive.score_lead_up = 20.0   # 更严格的升级阈值
        cfg.adaptive.score_loss_up = 0.1
        cfg.adaptive.score_lead_down = -5.0  # 更宽松的降级阈值
        adaptive = AdaptiveDifficulty(db.conn, cfg)
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        # 人类 +10：默认会 UP，但自定义阈值 >20 才升 → 保持
        await _store(db, gid, 3, {"currentPlayer": "W", "scoreLead": 10.0}, [])
        await _store(db, gid, 2, {"currentPlayer": "B", "scoreLead": 0.0}, [
            {"move": "F14", "scoreLead": 0.1},
            {"move": "Q16", "scoreLead": 0.2},
        ])
        game = await _game(db, gid)
        assert await adaptive.decide(game) is AdaptiveDecision.KEEP

        # 人类 -8 < -5 → 降级
        gid2 = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)])
        await _store(db, gid2, 3, {"currentPlayer": "W", "scoreLead": -8.0}, [])
        game2 = await _game(db, gid2)
        assert await adaptive.decide(game2) is AdaptiveDecision.DOWN
