"""T3.12 SGF 导入/导出测试（TASK T3.12 / PRD §4.2.1/§4.2.3 / API §3.1）。

用例 ID: SGF-*
- 标准棋谱导出（玩家/规则/贴目/让子/PASS）；导出→导入→回放一致性；
- 导入校验：大小限制 SGF_TOO_LARGE、合法性 SGF_INVALID（结构/棋盘/坐标）；
- 规则集别名归一、复弈棋谱同样可导出。
"""

import pytest

from app.config import default_config
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.game_service import CreateGameParams, GameService, PlayerInfo
from app.services.sgf_io import (
    export_game_sgf,
    export_sgf,
    game_params_from_parsed,
    parse_sgf,
    xy_to_sgf,
)


def _game(**overrides):
    base = dict(
        board_size=19,
        rules="chinese",
        komi=7.5,
        handicap=0,
        black_name="张三",
        black_rank="rank_5k",
        white_name="李四",
        white_rank="rank_1k",
    )
    base.update(overrides)
    return base


def _moves():
    return [
        {"color": "B", "x": 3, "y": 3, "is_pass": False},
        {"color": "W", "x": 15, "y": 15, "is_pass": False},
        {"color": "B", "is_pass": True},
    ]


class TestExport:
    """导出。"""

    def test_export_basic(self):
        sgf = export_sgf(_game(), _moves())
        assert sgf.startswith("(;GM[1] FF[4] CA[UTF-8] SZ[19] KM[7.5] RU[chinese]")
        assert "PB[张三]" in sgf
        assert "PW[李四]" in sgf
        assert "BR[rank_5k]" in sgf
        assert "WR[rank_1k]" in sgf
        assert ";B[dd]" in sgf  # (3,3)
        assert ";W[pp]" in sgf  # (15,15)
        assert ";B[]" in sgf    # PASS
        assert sgf.endswith(")")

    def test_export_handicap(self):
        sgf = export_sgf(_game(handicap=2, komi=0.0), [])
        assert "HA[2]" in sgf
        assert "AB[pd][dp]" in sgf  # 经典让子坐标显式锁定（右上 (15,3) + 左下 (3,15)）
        assert "KM[0]" in sgf

    def test_export_handicap_small_board(self):
        """9 路让 4：AB 为四角（同构缩放）。"""
        sgf = export_sgf(_game(board_size=9, handicap=4, komi=0.0), [])
        assert "HA[4]" in sgf
        assert "AB[gc][cg][gg][cc]" in sgf

    def test_export_no_names(self):
        sgf = export_sgf(_game(black_name=None, black_rank=None, white_name=None, white_rank=None), [])
        assert "PB[" not in sgf
        assert "BR[" not in sgf

    def test_export_escapes_special_chars(self):
        sgf = export_sgf(_game(black_name="张三]黑"), [])
        assert "PB[张三\\]黑]" in sgf

    def test_xy_to_sgf(self):
        assert xy_to_sgf(0, 0) == "aa"
        assert xy_to_sgf(18, 18) == "ss"
        assert xy_to_sgf(3, 3) == "dd"

    async def test_export_game_from_db(self, db):
        svc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await svc.create(
            CreateGameParams(
                mode="human_human", board_size=9, rules="chinese", komi=6.5,
                black=PlayerInfo(name="张三", rank="rank_5k"),
                white=PlayerInfo(name="李四", rank="rank_1k"),
            )
        )
        await svc.play(gid, x=2, y=2, color="B")
        sgf = await export_game_sgf(db.conn, gid)
        assert "SZ[9]" in sgf
        assert "KM[6.5]" in sgf
        assert ";B[cc]" in sgf

    async def test_export_replay_game(self, db):
        """复弈棋谱（parent_game_id）作为正式对局记录同样可导出。"""
        svc = GameService(db.conn, default_config(), human_model_available=True)
        gid = await svc.create(
            CreateGameParams(
                mode="human_human", board_size=9, black=PlayerInfo(name="张三", rank="rank_5k")
            )
        )
        await repos.update_game_status(db.conn, gid, "finished")  # 终局
        sgf = await export_game_sgf(db.conn, gid)
        assert sgf.startswith("(;")


class TestImport:
    """导入校验与解析。"""

    def test_import_valid(self):
        sgf = "(;GM[1]FF[4]SZ[19]KM[7.5]RU[chinese]PB[张三]PW[李四]HA[0];B[dd];W[pp];B[]) "
        parsed = parse_sgf(sgf)
        assert parsed["board_size"] == 19
        assert parsed["komi"] == 7.5
        assert parsed["rules"] == "chinese"
        assert parsed["black_name"] == "张三"
        assert parsed["moves"] == [
            {"color": "B", "x": 3, "y": 3, "is_pass": False},
            {"color": "W", "x": 15, "y": 15, "is_pass": False},
            {"color": "B", "is_pass": True},
        ]

    def test_import_rules_alias(self):
        parsed = parse_sgf("(;SZ[19]RU[cn];B[aa])")
        assert parsed["rules"] == "chinese"
        parsed2 = parse_sgf("(;SZ[19]RU[jp];B[aa])")
        assert parsed2["rules"] == "japanese"

    def test_import_uppercase_coords(self):
        parsed = parse_sgf("(;SZ[9];B[DD])")  # 兼容大写坐标
        assert parsed["moves"] == [{"color": "B", "x": 3, "y": 3, "is_pass": False}]

    def test_import_too_large(self):
        big = "(;SZ[19]" + ";B[aa]" * 200000 + ")"
        with pytest.raises(AppError) as ei:
            parse_sgf(big, max_size=1000)
        assert ei.value.code is ErrorCode.SGF_TOO_LARGE

    def test_import_move_count_cap(self):
        """M-6：落子数超上限 → SGF_TOO_LARGE（防海量写入）。"""
        from app.services.sgf_io import SGF_MAX_MOVES

        nodes = "".join(
            ";B[dd]" if i % 2 == 0 else ";W[qq]" for i in range(SGF_MAX_MOVES + 1)
        )
        with pytest.raises(AppError) as ei:
            parse_sgf(f"(;GM[1]SZ[19]{nodes})")
        assert ei.value.code is ErrorCode.SGF_TOO_LARGE
        # 恰在上限内可通过
        nodes_ok = "".join(
            ";B[dd]" if i % 2 == 0 else ";W[qq]" for i in range(SGF_MAX_MOVES)
        )
        parsed = parse_sgf(f"(;GM[1]SZ[19]{nodes_ok})")
        assert len(parsed["moves"]) == SGF_MAX_MOVES

    def test_import_invalid_structure(self):
        with pytest.raises(AppError) as ei:
            parse_sgf("not an sgf")
        assert ei.value.code is ErrorCode.SGF_INVALID

    def test_import_invalid_board_size(self):
        with pytest.raises(AppError) as ei:
            parse_sgf("(;SZ[17];B[aa])")
        assert ei.value.code is ErrorCode.SGF_INVALID

    def test_import_coord_out_of_bounds(self):
        with pytest.raises(AppError) as ei:
            parse_sgf("(;SZ[9];B[ss])")  # 9 路棋盘坐标 s=18 越界
        assert ei.value.code is ErrorCode.SGF_INVALID

    def test_import_invalid_rules(self):
        with pytest.raises(AppError) as ei:
            parse_sgf("(;SZ[19]RU[korean];B[aa])")
        assert ei.value.code is ErrorCode.SGF_INVALID

    def test_import_handicap_over_limit(self):
        """9 路让 6 子超上限 → SGF_INVALID（BUG-049）。"""
        with pytest.raises(AppError) as ei:
            parse_sgf("(;SZ[9]HA[6];W[dd])")
        assert ei.value.code is ErrorCode.SGF_INVALID

    def test_import_handicap_at_limit_ok(self):
        """上限内让子（含 13 路 6）可导入。"""
        assert parse_sgf("(;SZ[9]HA[4];W[dd])")["handicap"] == 4
        assert parse_sgf("(;SZ[13]HA[6];W[dd])")["handicap"] == 6

    def test_import_rules_with_parenthetical_note(self):
        """BUG-084：规则集附注归一（SmartGo 导出 ``AGA (Territory)`` → ``aga``）。"""
        assert parse_sgf("(;SZ[9]RU[AGA (Territory)];B[aa])")["rules"] == "aga"
        assert parse_sgf("(;SZ[19]RU[Chinese (Area)];B[aa])")["rules"] == "chinese"

    def test_import_main_line_only(self):
        """BUG-084：只取主谱（每层第一条分支）；变化图不入棋谱。"""
        sgf = (
            "(;GM[1]FF[4]SZ[9]CA[utf-8]AP[SmartGo One:3.1.6]"
            "PB[SmartGo+]PW[真人]DT[2026-07-27]KM[6.5]RU[AGA (Territory)]\n"
            ";B[df]VR[76.57]V[0.339290257];W[fd]VR[76.352]V[0.356994029]\n"
            ";B[gg]VR[46.218]V[-0.37079391]BM[1]\n"
            "(;W[eh]VR[82.113];B[ff]VR[84.944]\n"
            "(;W[dc];B[cd])\n"
            "(;W[ge]))\n"
            "(;W[ff];B[eh]VR[46.658]BM[1];W[hd]))"
        )
        parsed = parse_sgf(sgf)
        assert parsed["rules"] == "aga"
        assert parsed["board_size"] == 9
        assert parsed["komi"] == 6.5
        assert parsed["white_name"] == "真人"
        assert parsed["moves"] == [
            {"color": "B", "x": 3, "y": 5, "is_pass": False},
            {"color": "W", "x": 5, "y": 3, "is_pass": False},
            {"color": "B", "x": 6, "y": 6, "is_pass": False},
            {"color": "W", "x": 4, "y": 7, "is_pass": False},
            {"color": "B", "x": 5, "y": 5, "is_pass": False},
            {"color": "W", "x": 3, "y": 2, "is_pass": False},
            {"color": "B", "x": 2, "y": 3, "is_pass": False},
        ]

    def test_import_ignores_comments_and_escaped_values(self):
        r"""BUG-084：属性值转义（``\]``）与注释内伪落子不破坏结构与棋谱。"""
        sgf = (
            "(;GM[1]SZ[9]PB[张三\\]黑]C[参考变化 ;B[cc] 之后]"
            ";B[aa];W[]TB[aa:cc][dd];B[bb]C[白方 ;W[gg] 是正着])"
        )
        parsed = parse_sgf(sgf)
        assert parsed["black_name"] == "张三]黑"
        assert parsed["moves"] == [
            {"color": "B", "x": 0, "y": 0, "is_pass": False},
            {"color": "W", "is_pass": True},
            {"color": "B", "x": 1, "y": 1, "is_pass": False},
        ]


class TestRoundtrip:
    """导出 → 导入 → 回放一致性。"""

    def test_roundtrip_full(self):
        game = _game(handicap=2, komi=0.0)
        moves = [
            {"color": "W", "x": 4, "y": 4, "is_pass": False},
            {"color": "B", "x": 5, "y": 5, "is_pass": False},
            {"color": "W", "is_pass": True},
        ]
        sgf = export_sgf(game, moves)
        parsed = parse_sgf(sgf)
        assert parsed["board_size"] == game["board_size"]
        assert parsed["rules"] == game["rules"]
        assert parsed["komi"] == game["komi"]
        assert parsed["handicap"] == game["handicap"]
        assert parsed["black_name"] == game["black_name"]
        assert parsed["moves"] == moves

    def test_roundtrip_pass_alternation(self):
        game = _game()
        sgf = export_sgf(game, _moves())
        parsed = parse_sgf(sgf)
        assert parsed["moves"] == _moves()

    def test_game_params_from_parsed(self):
        parsed = parse_sgf("(;SZ[9]KM[6.5]RU[cn]PB[王五]PW[赵六];B[cc])")
        params = game_params_from_parsed(parsed)
        assert params["board_size"] == 9
        assert params["komi"] == 6.5
        assert params["rules"] == "chinese"
        assert params["black"]["name"] == "王五"
        assert params["black"]["rank"] is None
