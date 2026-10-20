"""T3.9 复盘测试（TASK T3.9 / PRD §4.2 / ARCHITECTURE §3.5/§4.2）。

用例 ID: REVIEW-*
- 回放读持久化数据（引擎 DEAD 仍可用）；试下分支不污染主谱；
- 试下/撤销/回实战；复弈前导 + 批量落盘映射；收藏切换。
"""

import asyncio
import json

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.analysis_service import AnalysisService
from app.services.game_service import (
    CreateGameParams,
    GameService,
    PlayerInfo,
)
from app.services.review_service import ReviewService


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
def game_svc(db):
    return GameService(db.conn, default_config(), human_model_available=True)


@pytest.fixture
def analysis(db):
    return AnalysisService(db.conn, default_config(), engine=None, concurrency=1)


@pytest.fixture
def review(db, game_svc, analysis):
    return ReviewService(
        db.conn, default_config(), game_service=game_svc, analysis=analysis
    )


async def _mk_game(db, *, moves=None, gsvc=None, params=None):
    svc = gsvc or GameService(db.conn, default_config(), human_model_available=True)
    gid = await svc.create(params or _params())
    for i, (c, x, y) in enumerate(moves or [], start=1):
        await svc.play(gid, x=x, y=y, color=c)
    return gid


async def _store_analysis(db, gid, move_no, data, max_visits=100):
    await repos.upsert_position_analysis(
        db.conn, game_id=gid, position_key=f"main:{move_no}",
        data_json=json.dumps(data), max_visits=max_visits,
    )


def _analysis_data(winrate=0.6, score_lead=2.5):
    return {
        "id": "q1",
        "rootInfo": {"currentPlayer": "B", "winrate": winrate, "scoreLead": score_lead},
        "moveInfos": [
            {"move": "Q16", "order": 0, "visits": 100, "winrate": 0.7, "scoreLead": 4.0, "pv": ["Q16", "D16"]},
            {"move": "D4", "order": 1, "visits": 60, "winrate": 0.5, "scoreLead": 1.0, "pv": ["D4"]},
        ],
    }


class TestReplay:
    """回放数据（引擎无关）。"""

    async def test_replay_returns_game_moves_analyses(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        await _store_analysis(db, gid, 0, _analysis_data())
        await _store_analysis(db, gid, 1, _analysis_data())
        data = await review.replay(gid)
        assert data["game"]["id"] == gid
        assert len(data["moves"]) == 2
        assert 0 in data["analyses"] and 1 in data["analyses"]

    async def test_curve_reads_persisted(self, db, game_svc, review):
        """引擎 DEAD 复盘曲线仍可用（读持久化数据）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        await _store_analysis(db, gid, 0, _analysis_data(0.5, -1.0))
        await _store_analysis(db, gid, 2, _analysis_data(0.8, 5.0))
        curve = await review.curve(gid)
        assert len(curve) == 2
        assert curve[0]["winrate"] == 50.0
        assert curve[1]["score_lead"] == 5.0
        assert curve[1]["move_no"] == 2

    async def test_recommend_top5_coords(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        await _store_analysis(db, gid, 1, _analysis_data())
        rec = await review.recommend(gid, 1)
        assert rec["position_key"] == "main:1"
        assert rec["has_data"] is True
        assert rec["side"] == "B"  # 该局面当前执色方（rootInfo.currentPlayer）
        assert len(rec["moves"]) == 2
        # 黑方行棋：winrate 黑方视角百分比（0.7 → 70.0）
        assert rec["moves"][0] == {
            "x": 15, "y": 3, "winrate": 70.0, "score_lead": 4.0,
            "visits": 100, "pv": ["Q16", "D16"],
        }
        assert rec["variations"][0]["pv"][0] == {"color": "B", "x": 15, "y": 3, "is_pass": False}
        # root：同侧视角百分比
        assert rec["root"] == {"winrate": 60.0, "score_lead": 2.5}
        # comment：前一手 main:0 未存储 → None（不阻塞 TOP5）
        assert rec["comment"] is None

    async def test_recommend_white_side_perspective(self, db, game_svc, review):
        """白方行棋局面：推荐卡片跟随当前执色方（胜率 100-x、目差取负，附 side）。

        2026/09/11 人工确认：AI 支招 / AI 推荐卡片视角跟随当前执色方；
        对局信息卡 / 胜率目差曲线（黑）仍固定黑方（走 curve 载荷）。
        """
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        await _store_analysis(db, gid, 2, _analysis_data(0.62, 3.5))
        rec = await review.recommend(gid, 2)
        assert rec["side"] == "B"  # _analysis_data 固定 currentPlayer=B
        # 白方视角样例：显式构造 W 行棋局面
        await _store_analysis(db, gid, 1, {
            "rootInfo": {"currentPlayer": "W", "winrate": 0.62, "scoreLead": 3.5},
            "moveInfos": [
                {"move": "Q16", "order": 0, "visits": 100, "winrate": 0.7, "scoreLead": 4.0, "pv": ["Q16"]},
            ],
        })
        rec_w = await review.recommend(gid, 1)
        assert rec_w["side"] == "W"
        assert rec_w["moves"][0]["winrate"] == 30.0  # 100 - 70（白方胜率）
        assert rec_w["moves"][0]["score_lead"] == -4.0  # 白方视角目差
        assert rec_w["root"] == {"winrate": 38.0, "score_lead": -3.5}

    async def test_recommend_empty_without_analysis(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        rec = await review.recommend(gid, 1)
        assert rec == {
            "position_key": "main:1", "move_no": 1, "side": "W", "has_data": False,
            "moves": [], "variations": [], "root": None, "comment": None,
        }

    async def test_recommend_comment_grade(self, db, game_svc, review):
        """当前手点评：双局面差（落子前后 root 之差，落子方视角 → LEVEL 带表五档）。"""
        gid = await _mk_game(db, moves=[("B", 15, 3)], gsvc=game_svc)  # Q16
        await _store_analysis(db, gid, 0, _analysis_data(0.6, 2.5))
        await _store_analysis(db, gid, 1, _analysis_data(0.7, 4.0))
        rec = await review.recommend(gid, 1)
        assert rec["has_data"] is True
        # ΔW = 0.7-0.6 = +0.1 → 妙着（且 Q16 命中第 1 选点）；
        # ΔS = 4.0-2.5 = +1.5 目（目数变化，黑方多得 1.5 目为正）
        assert rec["comment"] == {
            "color": "B", "x": 15, "y": 3, "grade": "brilliant",
            "delta_winrate": 10.0, "score_delta": 1.5,
        }

    async def test_recommend_comment_hit_first_floor(self, db, game_svc, review):
        """命中第 1 选点 → 妙着（命中优先，覆盖数值带；2026/09/11 人工确认）。"""
        gid = await _mk_game(db, moves=[("B", 15, 3)], gsvc=game_svc)  # Q16（order 0）
        await _store_analysis(db, gid, 0, _analysis_data(0.6, 2.5))
        await _store_analysis(db, gid, 1, _analysis_data(0.58, 2.2))
        rec = await review.recommend(gid, 1)
        # ΔW=-0.02（缓着数值档）、ΔS=-0.3 → 命中第 1 选点抬为 妙着
        assert rec["comment"]["delta_winrate"] == -2.0
        assert rec["comment"]["score_delta"] == -0.3
        assert rec["comment"]["grade"] == "brilliant"

    async def test_comment_for_move_reads_both_positions(self, db, game_svc, review):
        """``comment_for_move``：每手标准分析派送入口（WS 层实时推送复用）。"""
        gid = await _mk_game(db, moves=[("B", 15, 3), ("W", 3, 15)], gsvc=game_svc)
        await _store_analysis(db, gid, 0, _analysis_data(0.6, 2.5))
        await _store_analysis(db, gid, 1, _analysis_data(0.55, 2.0))
        await _store_analysis(db, gid, 2, _analysis_data(0.54, 2.5))
        # 第 2 手（白 D16，不在候选中）：黑胜率 0.55→0.54（白略好 ΔW=+1%）、
        # 黑目差 2.0→2.5 → 白方视角 ΔS = -0.5 目（白略损，极微小损失 → 正着）
        comment = await review.comment_for_move(gid, 2)
        assert comment == {
            "move_no": 2, "color": "W", "x": 3, "y": 15,
            "grade": "good", "delta_winrate": 1.0, "score_delta": -0.5,
        }
        # 首手无前局面 → None；越界/缺数据 → None
        assert await review.comment_for_move(gid, 0) is None
        assert await review.comment_for_move(gid, 9) is None

    async def test_recent_comments_backfill(self, db, game_svc, review):
        """连接/恢复回投最近 2 手点评（旧→新序；无分析/PASS 跳过）。"""
        gid = await _mk_game(
            db, moves=[("B", 15, 3), ("W", 3, 15), ("B", 5, 5)], gsvc=game_svc
        )
        for k in range(4):
            await _store_analysis(db, gid, k, _analysis_data(0.6 - 0.01 * k, 2.5))
        comments = await review.recent_comments(gid, count=2)
        assert [c["move_no"] for c in comments] == [2, 3]
        assert comments[0]["color"] == "W" and comments[1]["color"] == "B"

    async def test_recommend_comment_white_blunder(self, db, game_svc, review):
        """白方恶手：黑方视角 ΔW 为正 → 落子方视角为负（blunder）。"""
        gid = await _mk_game(db, moves=[("B", 15, 3), ("W", 3, 15)], gsvc=game_svc)
        await _store_analysis(db, gid, 1, {
            "rootInfo": {"currentPlayer": "W", "winrate": 0.8, "scoreLead": 12.0},
            "moveInfos": [],
        })
        await _store_analysis(db, gid, 2, {
            "rootInfo": {"currentPlayer": "B", "winrate": 0.95, "scoreLead": 18.0},
            "moveInfos": [],
        })
        rec = await review.recommend(gid, 2)
        assert rec["comment"] is not None
        # 白走恶手 → 黑胜率提升 0.15 → 落子方视角 ΔW = -0.15 → 败着；ΔS=-6.0 目（恶手为负）
        assert rec["comment"]["grade"] == "blunder"
        assert rec["comment"]["delta_winrate"] == -15.0
        assert rec["comment"]["score_delta"] == -6.0

    async def test_set_favorite_toggle(self, db, game_svc, review):
        gid = await _mk_game(db, gsvc=game_svc)
        await review.set_favorite(gid, True)
        game = await repos.get_game(db.conn, gid)
        assert game["favorite"] == 1
        await review.set_favorite(gid, False)
        game = await repos.get_game(db.conn, gid)
        assert game["favorite"] == 0


class TestReplayBundle:
    """批量复盘数据（``/replay``；2026/09/21 性能优化）。

    关键契约：批量条目与逐手 ``recommend()`` **同口径**（含深算槽优先级与链槽点评），
    唯一差异是 ``variations`` 不下发与 ``moves[i]`` 重复的 ``move`` 对象（V2 形态）。
    """

    @staticmethod
    def _strip_variation_move(payload: dict) -> dict:
        """去掉 ``variations[].move`` 后的载荷（V2 形态归一，供逐字段比对）。"""
        out = dict(payload)
        out["variations"] = [
            {k: v for k, v in item.items() if k != "move"} for item in payload["variations"]
        ]
        return out

    async def test_bundle_matches_per_move_recommend(self, db, game_svc, review):
        """逐手等价：0..末手每个局面与 ``recommend()`` 逐字段一致（含缺数据的空条目）。"""
        gid = await _mk_game(
            db,
            moves=[("B", 15, 3), ("W", 3, 15), ("B", 5, 5), ("W", 15, 15)],
            gsvc=game_svc,
        )
        for move_no in (0, 1, 3, 4):  # 第 2 手故意缺分析
            await _store_analysis(db, gid, move_no, _analysis_data(0.6 - 0.01 * move_no, 2.5))
        bundle = await review.replay_bundle(gid)
        assert bundle["game_id"] == gid
        assert bundle["last_move_no"] == 4
        assert [item["position_key"] for item in bundle["recommends"]] == [
            f"main:{n}" for n in range(0, 5)
        ]
        for item in bundle["recommends"]:
            move_no = item["move_no"]
            # recommend() 的 variations 带冗余 move 对象 → 归一为 V2 形态后逐字段比对
            expected = self._strip_variation_move(await review.recommend(gid, move_no))
            assert item == expected

    async def test_bundle_variations_omit_move_but_keep_pv(self, db, game_svc, review):
        """V2 形态：``variations[]`` 只保留 ``pv``（候选元数据只在 ``moves[]``）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        await _store_analysis(db, gid, 1, _analysis_data())
        bundle = await review.replay_bundle(gid)
        entry = bundle["recommends"][1]
        assert entry["has_data"] is True
        assert len(entry["moves"]) == 2
        assert all(set(item) == {"pv"} for item in entry["variations"])
        assert entry["variations"][0]["pv"][0] == {
            "color": "B", "x": 15, "y": 3, "is_pass": False,
        }
        # 候选元数据仍完整（前端按同序号取用）
        assert entry["moves"][0]["pv"] == ["Q16", "D16"]
        assert entry["moves"][0]["visits"] == 100

    async def test_bundle_curve_matches_curve_method(self, db, game_svc, review):
        """曲线口径单一事实源：批量内联曲线 == ``/curve``（同一派生函数）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        await _store_analysis(db, gid, 0, _analysis_data(0.5, -1.0))
        await _store_analysis(db, gid, 2, _analysis_data(0.8, 5.0))
        bundle = await review.replay_bundle(gid)
        assert bundle["curve"] == await review.curve(gid)
        assert bundle["curve"][1] == {"move_no": 2, "winrate": 80.0, "score_lead": 5.0}

    async def test_bundle_prefers_deep_slot_without_breaking_comment(
        self, db, game_svc, review, analysis
    ):
        """展示优先深算槽（同 ``recommend``）；点评恒由链槽差量派生（BUG-026 不被破坏）。"""
        gid = await _mk_game(db, moves=[("B", 15, 3)], gsvc=game_svc)
        await _store_analysis(db, gid, 0, _analysis_data(0.5, 0.0))
        await _store_analysis(db, gid, 1, _analysis_data(0.4, -2.0))
        await analysis.cache.store(
            gid,
            "main:1",
            _analysis_data(0.6, 3.0),
            default_config().engine.deep_max_visits,
            kind="deep",
        )
        bundle = await review.replay_bundle(gid)
        entry = bundle["recommends"][1]
        assert entry["root"] == {"winrate": 60.0, "score_lead": 3.0}  # 深算槽展示值
        assert entry["comment"]["delta_winrate"] == -10.0  # 链槽 0.5→0.4 差量
        assert entry == self._strip_variation_move(await review.recommend(gid, 1))

    async def test_bundle_only_covers_main_line(self, db, game_svc, review):
        """试下分支不进入批量快照（引擎现算，仍走 WS recommend.request）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 2)
        await review.trial_play(gid, trial_id, x=4, y=4)
        bundle = await review.replay_bundle(gid)
        keys = [item["position_key"] for item in bundle["recommends"]]
        assert keys == ["main:0", "main:1", "main:2"]
        assert all(not key.startswith("trial:") for key in keys)

    async def test_replay_ownership_only_positions_with_data(self, db, game_svc, review):
        """整局领地：仅下发确有领地数据的局面（缺失局面留给前端回落 WS 补分析路径）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        with_own = _analysis_data()
        with_own["ownership"] = [0.25] * 361
        await _store_analysis(db, gid, 1, with_own)
        await _store_analysis(db, gid, 2, _analysis_data())  # 无 ownership 字段
        payload = await review.replay_ownership(gid)
        assert payload["last_move_no"] == 2
        assert [(p["move_no"], len(p["ownership"])) for p in payload["positions"]] == [(1, 361)]
        assert payload["positions"][0]["ownership"][0] == 0.25

    async def test_replay_ownership_prefers_deep_slot(
        self, db, game_svc, review, analysis
    ):
        """领地展示优先级与 ``ownership()`` 一致：深算槽 → 链槽。"""
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        chain = _analysis_data()
        chain["ownership"] = [1.0]
        await _store_analysis(db, gid, 1, chain)
        assert (await review.replay_ownership(gid))["positions"] == [
            {"move_no": 1, "ownership": [1.0]}
        ]
        deep = _analysis_data()
        deep["ownership"] = [0.1, 0.9]
        await analysis.cache.store(
            gid,
            "main:1",
            deep,
            default_config().engine.deep_max_visits,
            kind="deep",
        )
        assert (await review.replay_ownership(gid))["positions"] == [
            {"move_no": 1, "ownership": [0.1, 0.9]}
        ]


class TestTrial:
    """试下临时分支（不污染主谱）。"""

    async def test_trial_enter_and_play(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 2)  # 从第 2 手局面进入
        result = await review.trial_play(gid, trial_id, x=4, y=4, color="B")
        assert result["relative_move_no"] == 1
        assert result["color"] == "B"
        # 主谱未被污染
        moves = await repos.list_moves(db.conn, gid)
        assert len(moves) == 2

    async def test_trial_turn_alternates(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 2)
        await review.trial_play(gid, trial_id, x=4, y=4, color="B")  # 第3手 B
        await review.trial_play(gid, trial_id, x=5, y=5, color="W")  # 第4手 W
        # 第5手应为 B：传 W 拒绝
        with pytest.raises(AppError) as ei:
            await review.trial_play(gid, trial_id, x=6, y=6, color="W")
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION
        # 规则校验：占点
        await review.trial_play(gid, trial_id, x=6, y=6, color="B")
        with pytest.raises(AppError) as ei2:
            await review.trial_play(gid, trial_id, x=6, y=6, color="W")
        assert ei2.value.code is ErrorCode.ILLEGAL_MOVE

    async def test_trial_undo_unlimited(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 2)
        await review.trial_play(gid, trial_id, x=4, y=4, color="B")
        await review.trial_play(gid, trial_id, x=5, y=5, color="W")
        r1 = await review.trial_undo(gid, trial_id)
        assert r1["relative_last"] == 1
        r2 = await review.trial_undo(gid, trial_id)
        assert r2["relative_last"] == 0
        with pytest.raises(AppError) as ei:
            await review.trial_undo(gid, trial_id)  # 无子可悔
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    async def test_trial_back_to_real(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 2)
        await review.trial_play(gid, trial_id, x=4, y=4, color="B")
        result = await review.trial_back_to_real(gid, trial_id)
        assert result["move_no"] == 2  # 返回试下进入局面

    async def test_trial_rule_violation_rejected(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 1)
        await review.trial_play(gid, trial_id, x=4, y=4, color="W")
        with pytest.raises(AppError) as ei:
            await review.trial_play(gid, trial_id, x=4, y=4, color="B")  # 占点
        assert ei.value.code is ErrorCode.ILLEGAL_MOVE

    async def test_trial_pass(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 1)
        result = await review.trial_pass(gid, trial_id, color="W")
        assert result["is_pass"] is True
        assert result["relative_move_no"] == 1

    async def test_concurrent_trial_play_serialized(self, db, game_svc, review):
        """M-7：同分支并发落子经分支级锁串行——不得出现两子同色/同相对手数。

        缺陷形态（旧实现）：两路并发均在旧 ``relative_last`` 上推导应落方并各自
        await 棋盘构建 → 后完成的一路仍以旧色追加（两子同色）。此处闸门令两路
        同时停在 ``_trial_board`` 的 await 点以稳定复现。
        """
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 2)
        entered = asyncio.Event()
        release = asyncio.Event()
        orig_board = review._trial_board

        async def gated_board(game, trial):
            entered.set()
            await release.wait()
            return await orig_board(game, trial)

        review._trial_board = gated_board  # type: ignore[method-assign]
        first = asyncio.create_task(review.trial_play(gid, trial_id, x=4, y=4))
        await entered.wait()
        second = asyncio.create_task(review.trial_play(gid, trial_id, x=5, y=5))
        # 给第二路足够调度机会抵达锁/闸门（旧实现停在同一闸门 → 两路均以旧状态推导）
        for _ in range(50):
            await asyncio.sleep(0)
        release.set()
        r1, r2 = await asyncio.gather(first, second)
        assert (r1["relative_move_no"], r1["color"]) == (1, "B")
        assert (r2["relative_move_no"], r2["color"]) == (2, "W")
        snap = await review.trial_snapshot(gid, trial_id)
        assert [m["color"] for m in snap["moves"]] == ["B", "W"]

    async def test_remove_game_clears_trials_and_session_slots(self, db, game_svc, review):
        """L-12：对局删除回收该对局全部试下分支与会话槽（旧实现遗留）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 1)
        assert trial_id in review._trials
        await review._analysis.cache.store(
            gid, f"trial:{trial_id}:1", {"rootInfo": {}}, 100
        )
        assert review._analysis.cache.list_trial(trial_id) != {}
        review.remove_game(gid)
        assert trial_id not in review._trials
        assert review._analysis.cache.list_trial(trial_id) == {}


class TestReplayTrial:
    """复弈：新对局 + 前导 + 批量落盘映射。"""

    async def test_replay_trial_new_game_with_prefix(self, db, game_svc, review):
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 2)  # 从第 2 手局面进入
        await review.trial_play(gid, trial_id, x=4, y=4, color="B")  # 第3手 B（替换主谱第3手）
        await review.trial_play(gid, trial_id, x=6, y=6, color="W")  # 第4手 W
        new_id = await review.replay_trial(gid, trial_id)
        game = await repos.get_game(db.conn, new_id)
        assert game["parent_game_id"] == gid
        assert game["status"] == "active"
        moves = await repos.list_moves(db.conn, new_id)
        # 新对局 = 主谱前缀(1-2) + 试下(2 手) = 4 手（试下替换进入手数之后的主谱）
        assert len(moves) == 4
        assert moves[0]["x"] == 3 and moves[0]["color"] == "B"
        assert moves[1]["x"] == 15 and moves[1]["color"] == "W"
        assert moves[2]["color"] == "B" and moves[2]["x"] == 4
        assert moves[3]["color"] == "W" and moves[3]["x"] == 6

    async def test_replay_trial_counts_captures(self, db, game_svc, review):
        """BUG-031 回归：复弈新对局提子计数器按复制棋谱回算。"""
        gid = await _mk_game(
            db,
            moves=[("B", 1, 0), ("W", 0, 0), ("B", 0, 1), ("W", 15, 15)],
            gsvc=game_svc,
        )
        # 主谱：黑 B(1,0)+B(0,1) 提白 (0,0) 1 子
        assert (await repos.get_game(db.conn, gid))["black_captures"] == 1
        trial_id = await review.trial_enter(gid, 4)
        await review.trial_play(gid, trial_id, x=4, y=4, color="B")
        new_id = await review.replay_trial(gid, trial_id)
        new_game = await repos.get_game(db.conn, new_id)
        assert new_game["black_captures"] == 1
        assert new_game["white_captures"] == 0

    async def test_replay_trial_analyses_bulk_landed(self, db, game_svc, review, analysis):
        gid = await _mk_game(db, moves=[("B", 3, 3), ("W", 15, 15), ("B", 5, 5)], gsvc=game_svc)
        # 前导分析 main:{0..2}
        for k in (0, 1, 2):
            await _store_analysis(db, gid, k, _analysis_data(float(k) / 10), 100)
        trial_id = await review.trial_enter(gid, 2)
        await review.trial_play(gid, trial_id, x=4, y=4, color="B")
        await review.trial_play(gid, trial_id, x=6, y=6, color="W")
        # 试下分析缓存（仅会话）
        await analysis.cache.store(gid, f"trial:{trial_id}:0", {"tag": "trial0"}, 100)
        await analysis.cache.store(gid, f"trial:{trial_id}:1", {"tag": "trial1"}, 150)
        await analysis.cache.store(gid, f"trial:{trial_id}:2", {"tag": "trial2"}, 200)

        new_id = await review.replay_trial(gid, trial_id)
        # 前导复制
        assert await repos.get_main_analysis(db.conn, new_id, 0) is not None
        assert await repos.get_main_analysis(db.conn, new_id, 2) is not None
        # 试下映射：trial:{1} → main:{2+1=3}，trial:{2} → main:{4}
        row3 = await repos.get_main_analysis(db.conn, new_id, 3)
        assert row3 is not None
        assert json.loads(row3["data_json"]) == {"tag": "trial1"}
        assert row3["max_visits"] == 150
        row4 = await repos.get_main_analysis(db.conn, new_id, 4)
        assert json.loads(row4["data_json"]) == {"tag": "trial2"}
        assert row4["max_visits"] == 200

    async def test_replay_trial_trial_state_kept(self, db, game_svc, review):
        """复弈后原试下分支保留（可继续）。"""
        gid = await _mk_game(db, moves=[("B", 3, 3)], gsvc=game_svc)
        trial_id = await review.trial_enter(gid, 1)
        await review.trial_play(gid, trial_id, x=4, y=4, color="W")
        await review.replay_trial(gid, trial_id)
        # 分支仍可撤销
        result = await review.trial_undo(gid, trial_id)
        assert result["relative_last"] == 0


class TestSubmitTrialStandardQuery:
    """H-5 回归（2026-09-19 代码审查）：试下标准分析必须携带让子初始石。

    缺陷：``submit_trial_standard``（试下缺数据补分析）漏传 ``initial_stones``——
    让子局试下 TOP5/领地按“无让子”局面分析；``replay_trial`` 还会把错误行
    批量落盘为正式对局的链数据（BUG-013 修复遗漏路径）。
    """

    async def test_handicap_trial_standard_query_includes_initial_stones(self, db):
        class CapturingEngine:
            def __init__(self):
                self.queries: list[dict] = []

            async def submit(self, query, timeout_s=None):
                self.queries.append(query)
                return {"id": query.get("id"), "rootInfo": {}, "moveInfos": []}

        engine = CapturingEngine()
        analysis = AnalysisService(db.conn, default_config(), engine=engine, concurrency=1)
        await analysis.start()
        game_svc = GameService(db.conn, default_config(), human_model_available=True)
        review = ReviewService(
            db.conn, default_config(), game_service=game_svc, analysis=analysis
        )
        try:
            gid = await _mk_game(
                db, gsvc=game_svc, params=_params(handicap=2, komi=0.0)
            )
            trial_id = await review.trial_enter(gid, 0)
            results: list[str] = []
            await review.submit_trial_standard(
                gid, f"trial:{trial_id}:0", on_result=lambda k, r: results.append(k)
            )
            await asyncio.wait_for(analysis._queue.join(), timeout=2)
            assert results == [f"trial:{trial_id}:0"]
            query = engine.queries[-1]
            # 19 路让 2 子（经典点位，与对弈查询同口径）
            assert query["initialStones"] == [["B", "Q16"], ["B", "D4"]]
        finally:
            await analysis.stop()
