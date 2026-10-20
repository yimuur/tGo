"""T4.2 REST 对局/复盘路由集成测试（TASK T4.2 / API §3.1）。

用例 ID: API-GAME-*
- 创建/列表（过滤+分页）/active-latest/详情/删除/收藏/曲线/领地/SGF/导入/报告；
- 错误码：GAME_NOT_FOUND / ANALYSIS_INCOMPLETE / INVALID_PAYLOAD；
- TestClient + mock 引擎 + `:memory:` DB（AGENTS.md §7）。

约定：数据准备（建局/落子/写分析）经服务/repos 在 TestClient 打开前完成
（共享同一 `:memory:` 连接），客户端仅做端点断言。
"""

import json

from fastapi.testclient import TestClient

from app.db import repos
from app.services.game_service import CreateGameParams


async def _make_game(svc, *, mode: str = "human_human", **overrides) -> int:
    """经服务层创建对局（数据准备，绕过 HTTP）。"""
    params = dict(mode=mode)
    params.update(overrides)
    return await svc.game.create(CreateGameParams(**params))


async def _seed_analysis(svc, game_id: int, move_no: int, *, ownership: bool = True) -> None:
    """向 `:memory:` 库写入主谱局面分析（模拟持久化结果）。"""
    data = {
        "id": f"a{game_id}",
        "rootInfo": {"currentPlayer": "B", "winrate": 0.55, "scoreLead": 0.5, "visits": 100},
        "moveInfos": [
            {"move": "D4", "order": 0, "visits": 50, "winrate": 0.6, "scoreLead": 1.0, "pv": ["D4"]}
        ],
    }
    if ownership:
        data["ownership"] = [0.1] * 361
    await repos.upsert_position_analysis(
        svc.db.conn,
        game_id=game_id,
        position_key=f"main:{move_no}",
        data_json=json.dumps(data, ensure_ascii=False),
        max_visits=100,
    )


class TestCreateGame:
    async def test_create_human_human(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post(
                "/api/games",
                json={"mode": "human_human", "black": {"name": "张三", "rank": "rank_5k"}},
            )
        assert resp.status_code == 201
        assert resp.json()["game_id"] > 0

    async def test_create_human_ai(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post(
                "/api/games",
                json={
                    "mode": "human_ai",
                    "color": "B",
                    "black": {"name": "张三", "rank": "rank_5k"},
                    "ai": {"style": "standard", "level": 5, "adaptive": False},
                    "coaching": True,
                },
            )
        assert resp.status_code == 201

    async def test_create_invalid_payload(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post("/api/games", json={"mode": "bad_mode"})
        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_PAYLOAD"

    async def test_create_unknown_field_rejected(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post("/api/games", json={"mode": "human_human", "extra": 1})
        assert resp.status_code == 422

    async def test_create_human_ai_rejects_human_style_without_human_model(self, api_app, api_svc):
        """人类模型缺失降级：仅标准风格可用（API §3.1.1 / PRD §4.1.1）。"""
        api_svc.manager._human = False
        api_svc.game._human_model_available = False
        with TestClient(api_app) as client:
            resp = client.post(
                "/api/games",
                json={"mode": "human_ai", "ai": {"style": "human", "level": 5}},
            )
        assert resp.status_code == 422
        assert resp.json()["code"] == "INVALID_PAYLOAD"


class TestListGames:
    async def test_list_empty(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/games")
        assert resp.status_code == 200
        assert resp.json() == {"total": 0, "items": [], "focus_page": None}

    async def test_list_with_games_and_filter(self, api_app, api_svc):
        gid1 = await _make_game(api_svc)
        await _make_game(api_svc)
        await repos.set_game_favorite(api_svc.db.conn, gid1, True)

        with TestClient(api_app) as client:
            assert client.get("/api/games").json()["total"] == 2

            fav_resp = client.get("/api/games", params={"favorite": "true"})
            assert fav_resp.json()["total"] == 1
            assert fav_resp.json()["items"][0]["id"] == gid1

            mode_resp = client.get("/api/games", params={"mode": "human_human"})
            assert mode_resp.json()["total"] == 2

            status_resp = client.get("/api/games", params={"status": "created"})
            assert status_resp.json()["total"] == 2

    async def test_list_pagination(self, api_app, api_svc):
        for _ in range(5):
            await _make_game(api_svc)
        with TestClient(api_app) as client:
            page1 = client.get("/api/games", params={"page": 1, "page_size": 2})
            assert page1.json()["total"] == 5
            assert len(page1.json()["items"]) == 2
            page3 = client.get("/api/games", params={"page": 3, "page_size": 2})
            assert len(page3.json()["items"]) == 1

    async def test_list_sorted_by_latest_update(self, api_app, api_svc):
        """列表按最近更新（`updated_at`）倒序（2026/09/13 人工反馈，BUG-060）。"""
        a = await _make_game(api_svc)
        b = await _make_game(api_svc)
        # a 更晚创建、b 更晚更新 → b 应在前
        await api_svc.db.conn.execute(
            "UPDATE games SET created_at=datetime('now','+1 hour') WHERE id=?", (a,)
        )
        await api_svc.db.conn.execute(
            "UPDATE games SET updated_at=datetime('now','+2 hour') WHERE id=?", (b,)
        )
        await api_svc.db.conn.commit()
        with TestClient(api_app) as client:
            items = client.get("/api/games").json()["items"]
        assert [i["id"] for i in items] == [b, a]

    async def test_list_invalid_status(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/games", params={"status": "bogus"})
        assert resp.status_code == 422

    async def test_list_status_multi_or(self, api_app, api_svc):
        """status 可重复传参 = 同值 OR（前端「进行中」tab＝created+active+scoring）。"""
        g_created = await _make_game(api_svc)
        g_finished = await _make_game(api_svc)
        await repos.update_game_status(api_svc.db.conn, g_finished, "finished")
        with TestClient(api_app) as client:
            resp = client.get(
                "/api/games", params=[("status", "created"), ("status", "scoring")]
            )
            assert resp.status_code == 200
            assert resp.json()["total"] == 1
            assert resp.json()["items"][0]["id"] == g_created
            # 单一 status 仍兼容
            single = client.get("/api/games", params={"status": "finished"})
            assert single.json()["total"] == 1
            assert single.json()["items"][0]["id"] == g_finished

    async def test_list_name_search(self, api_app, api_svc):
        """?name= 服务端模糊搜索（匹配黑/白名，LIKE %name%，与状态 AND）。"""
        g_a = await repos.create_game(
            api_svc.db.conn, mode="human_human", black_name="张三", white_name="王五"
        )
        await repos.create_game(
            api_svc.db.conn, mode="human_human", black_name="老陈", white_name="李四"
        )
        await repos.update_game_status(api_svc.db.conn, g_a, "finished")
        with TestClient(api_app) as client:
            hit = client.get("/api/games", params={"name": "张三"})
            assert hit.json()["total"] == 1 and hit.json()["items"][0]["id"] == g_a
            # 命中白名 + AND 状态过滤
            miss = client.get(
                "/api/games", params={"name": "张三", "status": "created"}
            )
            assert miss.json()["total"] == 0
            both = client.get("/api/games", params={"name": "张"})
            assert both.json()["total"] == 1

    async def test_list_focus_page(self, api_app, api_svc):
        """`?focus_id=` 返回来源对局所在页（复盘返回列表跨页定位，2026/09/14）。"""
        ids = [await _make_game(api_svc) for _ in range(5)]
        # 固定更新时间 → 排序由 id 倒序决定（新 id 在前）
        await api_svc.db.conn.execute(
            "UPDATE games SET updated_at='2026-09-14 00:00:00'"
        )
        await api_svc.db.conn.commit()
        with TestClient(api_app) as client:
            resp = client.get("/api/games", params={"focus_id": ids[0], "page_size": 2})
            body = resp.json()
            assert resp.status_code == 200
            assert body["total"] == 5
            assert body["focus_page"] == 3  # 最旧 id → 第 3 页
            assert [i["id"] for i in body["items"]] == [ids[4], ids[3]]  # items 仍为 page=1
            newest = client.get("/api/games", params={"focus_id": ids[4], "page_size": 2})
            assert newest.json()["focus_page"] == 1

    async def test_list_focus_page_null_when_missing_or_filtered(self, api_app, api_svc):
        """不存在 / 不匹配当前过滤 → focus_page 为 null（调用方回退常规列表）。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            assert (
                client.get("/api/games", params={"focus_id": 99999}).json()["focus_page"]
                is None
            )
            filtered = client.get(
                "/api/games", params={"focus_id": gid, "favorite": "true"}
            )
            assert filtered.json()["focus_page"] is None
            status_miss = client.get(
                "/api/games", params={"focus_id": gid, "status": "finished"}
            )
            assert status_miss.json()["focus_page"] is None
            assert (
                client.get("/api/games", params={"focus_id": gid}).json()["focus_page"]
                == 1
            )


class TestActiveLatest:
    async def test_none_when_empty(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/games/active-latest")
        assert resp.status_code == 200
        assert resp.json() is None

    async def test_only_active_returned(self, api_app, api_svc):
        """仅 active（PLAYING）恢复；created/scoring/finished 不恢复（API §3.1）。"""
        gid = await _make_game(api_svc)  # created
        with TestClient(api_app) as client:
            assert client.get("/api/games/active-latest").json() is None
        # 置 active 后返回
        await repos.update_game_status(api_svc.db.conn, gid, "active")
        with TestClient(api_app) as client:
            resp = client.get("/api/games/active-latest")
            assert resp.json() is not None
            assert resp.json()["id"] == gid

    async def test_latest_by_updated_at(self, api_app, api_svc):
        g1 = await _make_game(api_svc)
        g2 = await _make_game(api_svc)
        await repos.update_game_status(api_svc.db.conn, g1, "active")
        await repos.update_game_status(api_svc.db.conn, g2, "active")
        with TestClient(api_app) as client:
            resp = client.get("/api/games/active-latest")
            assert resp.json()["id"] == g2


class TestGameDetail:
    async def test_detail_with_moves_and_analysis_complete(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        await _seed_analysis(api_svc, gid, 0)
        await _seed_analysis(api_svc, gid, 1)

        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == gid
        assert len(body["moves"]) == 1
        assert body["analysis_complete"] is True
        assert body["moves_count"] == 1

    async def test_detail_not_found(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/games/9999")
        assert resp.status_code == 404
        assert resp.json()["code"] == "GAME_NOT_FOUND"

    async def test_detail_scoring_fields(self, api_app, api_svc):
        """双 PASS 确认结算局：详情携带已确认黑/白目数（scorings 行）；未结算为 null。"""
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            plain = client.get(f"/api/games/{gid}").json()
        assert plain["black_score"] is None
        assert plain["white_score"] is None

        await repos.upsert_scoring(
            api_svc.db.conn,
            game_id=gid,
            dead_points_json="[]",
            black_score=185.5,
            white_score=174.5,
            result="B+11",
        )
        await repos.update_game_status(api_svc.db.conn, gid, "finished")
        with TestClient(api_app) as client:
            body = client.get(f"/api/games/{gid}").json()
        assert body["black_score"] == 185.5
        assert body["white_score"] == 174.5


class TestPublicWhitelist:
    """T6.1 响应 Schema 白名单：games 输出为显式公共字段，内部字段不外泄。"""

    async def _mk_parented_game(self, api_svc) -> tuple[int, int]:
        """构造含内部字段（parent/player FK/adaptive_initial_level）的对局。"""
        pid_b = await repos.upsert_player(api_svc.db.conn, name="张三", rank="rank_5k")
        pid_w = await repos.upsert_player(api_svc.db.conn, name="李四", rank="rank_1k")
        gid1 = await repos.create_game(
            api_svc.db.conn, mode="human_ai", ai_style="standard",
            ai_level=3, adaptive_enabled=True, adaptive_initial_level="rank_5k",
            coaching_enabled=True, black_player_id=pid_b, black_name="张三", black_rank="rank_5k",
            white_player_id=pid_w, white_name="李四", white_rank="rank_1k",
            human_color="B",
        )
        gid2 = await repos.create_game(
            api_svc.db.conn, mode="human_ai", parent_game_id=gid1,
            black_name="张三", black_rank="rank_5k",
        )
        return gid1, gid2

    async def test_list_detail_active_latest_hide_internal(self, api_app, api_svc):
        """内部实现字段（parent/player FK、adaptive_initial_level）绝不外泄。"""
        gid1, gid2 = await self._mk_parented_game(api_svc)
        # gid2 为复弈（parent_game_id=gid1）：确保内部字段在 DB 已填充
        row = await repos.get_game(api_svc.db.conn, gid2)
        assert row["parent_game_id"] == gid1  # 前置：DB 确有值
        await repos.update_game_status(api_svc.db.conn, gid2, "active")

        with TestClient(api_app) as client:
            items = client.get("/api/games").json()["items"]
            detail = client.get(f"/api/games/{gid2}").json()
            latest = client.get("/api/games/active-latest").json()

        bodies = [items[0], detail, latest]
        assert all(b["id"] == gid2 for b in bodies)
        for body in bodies:
            for internal in ("parent_game_id", "black_player_id", "white_player_id", "adaptive_initial_level"):
                assert internal not in body, f"内部字段泄漏: {internal}"

    async def test_public_fields_preserved(self, api_app, api_svc):
        """前端所需公开字段保留（undo_count/提子数/难度/收藏等）。"""
        gid1, gid2 = await self._mk_parented_game(api_svc)
        with TestClient(api_app) as client:
            item = client.get("/api/games").json()["items"][0]
            detail = client.get(f"/api/games/{gid2}").json()
        body = detail
        for public in (
            "id", "mode", "board_size", "rules", "komi", "handicap", "human_color",
            "status", "result", "black_name", "black_rank", "white_name", "white_rank",
            "ai_style", "ai_level", "adaptive_enabled", "coaching_enabled", "favorite",
            "last_move_no", "created_at", "updated_at", "finished_at",
            "black_captures", "white_captures", "undo_count",
        ):
            assert public in body, f"公开字段缺失: {public}"
        # 列表项同一 GameInfo 结构
        for public in ("undo_count", "black_captures", "white_captures", "ai_level"):
            assert public in item

    async def test_active_latest_null_when_empty(self, api_app):
        with TestClient(api_app) as client:
            assert client.get("/api/games/active-latest").json() is None

    async def test_delete_game(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            resp = client.delete(f"/api/games/{gid}")
            assert resp.status_code == 204
            assert client.get(f"/api/games/{gid}").status_code == 404

    async def test_delete_game_clears_pending_memory(self, api_app, api_svc):
        """L-6：删除对局后未决悔棋申请同步回收（请求方未断开也不残留）。"""
        gid = await _make_game(api_svc)
        req = api_svc.session.undo_request_begin(
            gid, object(), request_id=1, color="B", steps=1, others_exist=False
        )
        assert req is not None
        with TestClient(api_app) as client:
            assert client.delete(f"/api/games/{gid}").status_code == 204
        assert api_svc.session.undo_request_get(gid) is None

    async def test_delete_not_found(self, api_app):
        with TestClient(api_app) as client:
            resp = client.delete("/api/games/9999")
        assert resp.status_code == 404


class TestFavorite:
    async def test_set_and_unset(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            resp = client.post(f"/api/games/{gid}/favorite", json={"favorite": True})
            assert resp.status_code == 200
            assert resp.json()["favorite"] is True
            resp2 = client.post(f"/api/games/{gid}/favorite", json={"favorite": False})
            assert resp2.json()["favorite"] is False

    async def test_favorite_missing_game(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post("/api/games/9999/favorite", json={"favorite": True})
        assert resp.status_code == 404


class TestRefight:
    """T6.8 复弈：POST /games/{id}/refight（试下 → 新对局 + 分析批量落盘）。"""

    async def test_refight_creates_new_game(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        # 主谱两手 + 持久化分析（前导 main:0/1/2）
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=2, color="W", x=15, y=15)
        await _seed_analysis(api_svc, gid, 0)
        await _seed_analysis(api_svc, gid, 1)
        await _seed_analysis(api_svc, gid, 2)
        # 试下：从第 1 手进入 + 落子（会话），并写入试下会话分析
        trial_id = await api_svc.review.trial_enter(gid, 1)
        await api_svc.review.trial_play(gid, trial_id, x=15, y=15, color="W")
        key = f"trial:{trial_id}:1"
        await api_svc.analysis.cache.store(
            gid, key,
            {"rootInfo": {"currentPlayer": "B", "winrate": 0.5},
             "moveInfos": [{"move": "D4", "order": 0, "visits": 10, "winrate": 0.5, "scoreLead": 0.0, "pv": ["D4"]}]},
            max_visits=100,
        )

        with TestClient(api_app) as client:
            resp = client.post(f"/api/games/{gid}/refight", json={"trial_id": trial_id})
        assert resp.status_code == 200
        new_id = resp.json()["game_id"]
        assert new_id != gid
        game = await repos.get_game(api_svc.db.conn, new_id)
        # 新对局 active（可续弈），parent 前导（内部列，仅服务层可见）
        assert game["status"] == "active"
        assert game["parent_game_id"] == gid
        moves = await repos.list_moves(api_svc.db.conn, new_id)
        # 新谱 = 主谱前缀(1) + 试下(1) = 2 手
        assert [m["move_no"] for m in moves] == [1, 2]
        assert (moves[0]["x"], moves[0]["y"]) == (3, 3)
        assert (moves[1]["x"], moves[1]["y"]) == (15, 15)
        # 前导分析复制（main:0..1）自包含
        assert await repos.get_main_analysis(api_svc.db.conn, new_id, 0) is not None
        assert await repos.get_main_analysis(api_svc.db.conn, new_id, 1) is not None
        # 试下相对 1 → 新对局 main:{enter+1}=2
        assert await repos.get_main_analysis(api_svc.db.conn, new_id, 2) is not None

    async def test_refight_missing_trial(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post("/api/games/1/refight", json={"trial_id": 999})
        assert resp.status_code in (400, 404)


class TestCurve:
    async def test_curve_reads_analyses(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        await _seed_analysis(api_svc, gid, 0)
        await _seed_analysis(api_svc, gid, 1)

        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/curve")
        assert resp.status_code == 200
        curve = resp.json()
        assert len(curve) == 2
        assert curve[0]["move_no"] == 0
        # ISSUE-050：输出侧 winrate × 100（黑方视角百分比）
        assert curve[0]["winrate"] == 55.0
        assert curve[0]["score_lead"] == 0.5


class TestReplayBundle:
    """复盘批量数据端点（`/replay` 与 `/replay/ownership`，2026/09/21 性能优化）。"""

    async def test_replay_bundle_shape(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        await _seed_analysis(api_svc, gid, 0)
        await _seed_analysis(api_svc, gid, 1)

        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/replay")
        assert resp.status_code == 200
        body = resp.json()
        assert body["game_id"] == gid
        assert body["last_move_no"] == 1
        # 与 /curve 同源（同一派生函数）
        assert body["curve"] == [
            {"move_no": 0, "winrate": 55.0, "score_lead": 0.5},
            {"move_no": 1, "winrate": 55.0, "score_lead": 0.5},
        ]
        # 逐手条目覆盖 0..last_move_no 且与 WS recommend 载荷同字段
        assert [item["position_key"] for item in body["recommends"]] == ["main:0", "main:1"]
        entry = body["recommends"][1]
        assert entry["has_data"] is True
        assert entry["moves"][0]["x"] == 3 and entry["moves"][0]["y"] == 15
        assert entry["root"] == {"winrate": 55.0, "score_lead": 0.5}
        # V2 形态：variations 不含与 moves[i] 重复的 move 对象
        assert all(set(item) == {"pv"} for item in entry["variations"])

    async def test_replay_bundle_missing_analysis_is_empty_entry(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)

        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/replay")
        assert resp.status_code == 200
        body = resp.json()
        assert body["curve"] == []
        assert body["recommends"][1] == {
            "position_key": "main:1",
            "move_no": 1,
            "side": "W",
            "has_data": False,
            "moves": [],
            "variations": [],
            "root": None,
            "comment": None,
        }

    async def test_replay_bundle_game_not_found(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/games/999999/replay")
        assert resp.status_code == 404
        assert resp.json()["code"] == "GAME_NOT_FOUND"

    async def test_replay_ownership_only_positions_with_data(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=2, color="W", x=15, y=15)
        await _seed_analysis(api_svc, gid, 1)  # 含 ownership

        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/replay/ownership")
        assert resp.status_code == 200
        body = resp.json()
        assert body["last_move_no"] == 2
        assert [p["move_no"] for p in body["positions"]] == [1]
        assert len(body["positions"][0]["ownership"]) == 361


class TestOwnership:
    async def test_ownership_with_data(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        await _seed_analysis(api_svc, gid, 1)

        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/ownership", params={"move_no": 1})
        assert resp.status_code == 200
        body = resp.json()
        assert body["position_key"] == "main:1"
        assert body["move_no"] == 1
        assert len(body["ownership"]) == 361

    async def test_ownership_missing_data(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/ownership")
        assert resp.status_code == 422
        assert resp.json()["code"] == "ANALYSIS_INCOMPLETE"

    async def test_ownership_out_of_range(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        await _seed_analysis(api_svc, gid, 0)
        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/ownership", params={"move_no": 5})
        assert resp.status_code == 409
        assert resp.json()["code"] == "ILLEGAL_ACTION"


class TestSgf:
    async def test_export_sgf(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/sgf")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-go-sgf")
        assert "(;" in resp.text

    async def test_export_missing_game(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/games/9999/sgf")
        assert resp.status_code == 404

    async def test_import_sgf(self, api_app):
        content = (
            "(;GM[1]FF[4]SZ[19]KM[7.5]RU[chinese]PB[张三]PW[李四]"
            ";B[dd];W[pp];B[pd])"
        )
        with TestClient(api_app) as client:
            resp = client.post(
                "/api/games/import",
                files={"file": ("game.sgf", content.encode("utf-8"), "application/octet-stream")},
            )
        assert resp.status_code == 201, resp.text
        gid = resp.json()["game_id"]
        detail = client.get(f"/api/games/{gid}").json()
        assert detail["status"] == "finished"
        assert len(detail["moves"]) == 3
        assert detail["black_name"] == "张三"

    async def test_import_sgf_counts_captures(self, api_app):
        """BUG-031 回归：SGF 导入按棋谱回算提子计数器（B 提白 1 子）。"""
        content = (
            "(;GM[1]FF[4]SZ[19]KM[7.5]RU[chinese]PB[张三]PW[李四]"
            ";B[ba];W[aa];B[ab])"
        )
        with TestClient(api_app) as client:
            resp = client.post(
                "/api/games/import",
                files={"file": ("game.sgf", content.encode("utf-8"), "application/octet-stream")},
            )
            assert resp.status_code == 201, resp.text
            gid = resp.json()["game_id"]
            detail = client.get(f"/api/games/{gid}").json()
        assert detail["black_captures"] == 1
        assert detail["white_captures"] == 0

    async def test_import_sgf_main_line_and_rules_note(self, api_app):
        """BUG-084 回归：多分支棋谱（SmartGo 导出）导入取主谱 + `RU[AGA (Territory)]` 归一。

        真实棋谱根属性带附注（`AGA (Territory)`）且含变化图；旧实现①按别名表精确匹配
        拒绝附注、②全文本正则扫描把**所有分支**并成一条棋谱（重复落点 → 回放冲突）。
        """
        content = (
            "(;GM[1]FF[4]SZ[9]CA[utf-8]AP[SmartGo One:3.1.6]"
            "PB[SmartGo+]PW[真人]DT[2026-07-27]KM[6.5]RU[AGA (Territory)]\n"
            ";B[df]VR[76.57];W[fd]VR[76.352]\n"
            ";B[cc]VR[46.218](;W[dd];B[ee])\n"
            "(;W[ee];B[fb]VR[46.658]BM[1];W[hd]))"
        )
        with TestClient(api_app) as client:
            resp = client.post(
                "/api/games/import",
                files={"file": ("smartgo.sgf", content.encode("utf-8"), "application/octet-stream")},
            )
            assert resp.status_code == 201, resp.text
            gid = resp.json()["game_id"]
            detail = client.get(f"/api/games/{gid}").json()
        assert detail["status"] == "finished"
        assert detail["board_size"] == 9
        assert detail["rules"] == "aga"
        assert detail["white_name"] == "真人"
        assert [(m["color"], m.get("x"), m.get("y")) for m in detail["moves"]] == [
            ("B", 3, 5),  # df
            ("W", 5, 3),  # fd
            ("B", 2, 2),  # cc
            ("W", 3, 3),  # dd（主谱分支）
            ("B", 4, 4),  # ee
        ]

    async def test_import_invalid_sgf(self, api_app):
        with TestClient(api_app) as client:
            resp = client.post(
                "/api/games/import",
                files={"file": ("bad.sgf", b"not an sgf", "application/octet-stream")},
            )
        assert resp.status_code == 422
        assert resp.json()["code"] == "SGF_INVALID"

    async def test_import_oversized_sgf(self, api_app):
        content = "(;GM[1]SZ[19]" + ";B[aa]" * 200_000 + ")"  # > 1MB（SGF_SIZE_LIMIT）
        with TestClient(api_app) as client:
            resp = client.post(
                "/api/games/import",
                files={"file": ("big.sgf", content.encode("utf-8"), "application/octet-stream")},
            )
        # 路由确定返回 413 + SGF_TOO_LARGE（精确断言，避免掩盖实现变化）
        assert resp.status_code == 413
        assert resp.json()["code"] == "SGF_TOO_LARGE"


class TestReport:
    async def test_report_generate(self, api_app, api_svc):
        from app.services.game_service import PlayerInfo

        gid = await _make_game(
            api_svc,
            black=PlayerInfo(name="张三", rank="rank_5k"),
            white=PlayerInfo(name="李四", rank="rank_1d"),
        )
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=1, color="B", x=3, y=3)
        await repos.append_move(api_svc.db.conn, game_id=gid, move_no=2, color="W", x=15, y=15)
        for n in range(3):
            await _seed_analysis(api_svc, gid, n)

        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/report", params={"perspective": "B"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["perspective"] == "B"
        assert body["player_name"] == "张三"
        assert "match_rate" in body
        assert "rating" in body

    async def test_report_incomplete(self, api_app, api_svc):
        gid = await _make_game(api_svc)
        with TestClient(api_app) as client:
            resp = client.get(f"/api/games/{gid}/report", params={"perspective": "B"})
        assert resp.status_code == 422
        assert resp.json()["code"] == "ANALYSIS_INCOMPLETE"
