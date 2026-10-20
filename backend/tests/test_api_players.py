"""T4.3 REST 档案路由集成测试（TASK T4.3 / API §3.2）。

用例 ID: API-PLAYER-*
- 档案列表（name LIKE 模糊、updated_at 倒序）；
- 档案在创建对局时自动 upsert（无显式新增接口）；
- 返回纯列表（API §3.2 未定义分页信封）。
"""

from fastapi.testclient import TestClient

from app.db import repos


class TestListPlayers:
    async def test_list_empty(self, api_app):
        with TestClient(api_app) as client:
            resp = client.get("/api/players")
        assert resp.status_code == 200
        assert resp.json() == []

    async def test_list_with_filter_and_sort(self, api_app, api_svc):
        """模糊匹配 + updated_at 倒序（最近使用优先）。"""
        await repos.upsert_player(api_svc.db.conn, name="张三", rank="rank_5k")
        await repos.upsert_player(api_svc.db.conn, name="张三丰", rank="rank_1d")
        await repos.upsert_player(api_svc.db.conn, name="李四", rank="rank_3k")
        # 推进"张三"的 updated_at（最近使用优先；避免同秒精度歧义）
        await api_svc.db.conn.execute(
            "UPDATE players SET updated_at=datetime('now','+1 hour') WHERE name='张三'"
        )
        await api_svc.db.conn.commit()

        with TestClient(api_app) as client:
            all_resp = client.get("/api/players")
            assert len(all_resp.json()) == 3

            # 模糊匹配 name
            filter_resp = client.get("/api/players", params={"name": "张三"})
            body = filter_resp.json()
            assert len(body) == 2
            names = {item["name"] for item in body}
            assert names == {"张三", "张三丰"}

            # updated_at 倒序：最近使用的"张三"在前
            assert body[0]["name"] == "张三"

    async def test_players_auto_upsert_on_game_create(self, api_app, api_svc):
        """创建对局时录入姓名/段位 → 档案自动 upsert（API §3.2）。"""
        with TestClient(api_app) as client:
            client.post(
                "/api/games",
                json={
                    "mode": "human_human",
                    "black": {"name": "王五", "rank": "rank_5k"},
                    "white": {"name": "赵六", "rank": "rank_3k"},
                },
            )
            resp = client.get("/api/players")
        assert len(resp.json()) == 2
        ranks = {item["rank"] for item in resp.json()}
        assert ranks == {"rank_5k", "rank_3k"}

    async def test_limit(self, api_app, api_svc):
        for i in range(5):
            await repos.upsert_player(api_svc.db.conn, name=f"玩家{i}", rank="rank_5k")
        with TestClient(api_app) as client:
            resp = client.get("/api/players", params={"limit": 3})
        assert len(resp.json()) == 3
