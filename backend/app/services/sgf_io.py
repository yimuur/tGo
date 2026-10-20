"""SGF 导入/导出（TASK T3.12，PRD §4.2.1/§4.2.3，API §3.1）。

- **导出**：标准棋谱（含玩家/规则/贴目/让子；复弈棋谱作为正式对局记录同样可导出）；
- **导入校验**：编码兼容（UTF-8）、大小限制（``SGF_TOO_LARGE``）、合法性
  （``SGF_INVALID``，含棋盘/坐标/结构校验）；导入**只取主谱**（每层第一条分支，
  变化图/分支不得与主谱合并写成一条棋谱，BUG-084）。

SGF 约定：坐标小写字母 a-t（左上原点，与内部 (x,y) 一致）；
PASS 记 ``;B[]``；根属性 ``SZ/KM/RU/HA/PB/PW/BR/WR``（**只读根节点**，
分支节点属性不覆盖对局参数）；规则集允许附注写法（``AGA (Territory)`` → ``aga``）。
"""

from __future__ import annotations

import re
from typing import Optional

from app.core.errors import AppError, ErrorCode
from app.services.go_rules import handicap_limit, handicap_points

#: 导入大小限制（字节；AI 智谱阈值）
SGF_SIZE_LIMIT = 1_000_000

#: 导入落子数上限（M-6：防超大棋谱/脏形 SGF 引发海量写入）
SGF_MAX_MOVES = 2000

#: 规则集别名 → 标准规则集（附注与大小写不敏感，见 `_normalize_rules`）
_RULES_ALIAS = {
    "chinese": "chinese",
    "cn": "chinese",
    "japanese": "japanese",
    "jp": "japanese",
    "aga": "aga",
    "": "chinese",
}


def _fmt(value: float) -> str:
    return f"{value:g}"


def _escape(value: str) -> str:
    """SGF 文本转义（`\\` 与 `]`）。"""
    return value.replace("\\", "\\\\").replace("]", "\\]")


def xy_to_sgf(x: int, y: int) -> str:
    """内部 (x,y) → SGF 坐标（小写字母，左上原点）。"""
    return chr(97 + x) + chr(97 + y)


def export_sgf(game: dict, moves: list[dict]) -> str:
    """导出标准棋谱 SGF。

    - 含玩家姓名/段位（PB/PW/BR/WR）、规则（RU）、贴目（KM）、让子（HA + AB 显式坐标）；
    - PASS 记 ``;X[]``；让子棋黑先放让子（HA 仅为数目、AB 锁定经典让子坐标——SGF FF[4]
      不定义摆放方式，显式 AB 避免其他软件按各自约定摆放导致复盘/分析局面错位）。
    """
    props = ["GM[1]", "FF[4]", "CA[UTF-8]", f"SZ[{game['board_size']}]"]
    if game.get("komi") is not None:
        props.append(f"KM[{_fmt(game['komi'])}]")
    props.append(f"RU[{game.get('rules') or 'chinese'}]")
    if game.get("handicap"):
        props.append(f"HA[{game['handicap']}]")
        stones = handicap_points(int(game["board_size"]), int(game["handicap"]))
        props.append("AB" + "".join(f"[{xy_to_sgf(x, y)}]" for x, y in stones))
    if game.get("black_name"):
        props.append(f"PB[{_escape(str(game['black_name']))}]")
    if game.get("white_name"):
        props.append(f"PW[{_escape(str(game['white_name']))}]")
    if game.get("black_rank"):
        props.append(f"BR[{_escape(str(game['black_rank']))}]")
    if game.get("white_rank"):
        props.append(f"WR[{_escape(str(game['white_rank']))}]")

    nodes: list[str] = []
    for m in moves:
        if m.get("is_pass"):
            nodes.append(f";{m['color']}[]")
        else:
            nodes.append(f";{m['color']}[{xy_to_sgf(int(m['x']), int(m['y']))}]")
    return f"(;{' '.join(props)}{''.join(nodes)})"


def parse_sgf(content: str, *, max_size: int = SGF_SIZE_LIMIT) -> dict:
    """导入校验 + 解析 SGF → 对局参数 + 落子序列。

    校验（API §3.1 / TASK T3.12）：
    - 编码兼容（UTF-8 解码已由调用方保证）；字节数超 ``max_size`` → ``SGF_TOO_LARGE``；
    - 结构/棋盘/坐标非法 → ``SGF_INVALID``；
    - 规则集别名归一（cn→chinese 等，含附注写法）。

    **主谱语义（BUG-084）**：变化图/分支不并入棋谱——按 SGF 约定逐层取**第一条**
    分支，其余分支解析后丢弃（旧实现按全文正则扫描会把所有分支拼成一条非法棋谱）。
    """
    if len(content.encode("utf-8", errors="ignore")) > max_size:
        raise AppError(ErrorCode.SGF_TOO_LARGE, "SGF 文件过大")
    text = content.strip()
    if not text.startswith("(") or ";" not in text:
        raise AppError(ErrorCode.SGF_INVALID, "非法的 SGF 结构")

    try:
        nodes, _ = _parse_game_tree(text, 0)
        root = nodes[0] if nodes else {}
        props = {ident: values[0] for ident, values in root.items()}
        board_size = int(props.get("SZ", "19") or "19")
        if board_size not in (9, 13, 19):
            raise ValueError(f"棋盘大小不支持: {board_size}")
        komi = float(props.get("KM", "0") or "0")
        rules = _normalize_rules(props.get("RU", ""))
        if rules is None:
            raise ValueError(f"规则集不支持: {props.get('RU')}")
        handicap = int(props.get("HA", "0") or "0")
        if handicap != 0:
            if handicap < 2 or handicap > 9:
                raise ValueError(f"让子数非法: {handicap}")
            limit = handicap_limit(board_size)
            if handicap > limit:
                raise ValueError(f"{board_size} 路棋盘最多让 {limit} 子（收到 {handicap}）")

        moves: list[dict] = []
        for node in nodes:
            for color in ("B", "W"):
                values = node.get(color)
                if not values:
                    continue
                loc = values[0].strip()
                if not loc:
                    moves.append({"color": color, "is_pass": True})
                else:
                    # 兼容大写坐标；SGF 坐标固定两字符（``tt`` 类旧式 PASS 不在支持范围）
                    if len(loc) != 2 or not (loc[0].isalpha() and loc[1].isalpha()):
                        raise ValueError(f"坐标格式非法: {loc}")
                    x = ord(loc[0].lower()) - ord("a")
                    y = ord(loc[1].lower()) - ord("a")
                    if not (0 <= x < board_size and 0 <= y < board_size):
                        raise ValueError(f"坐标越界: {loc}")
                    moves.append({"color": color, "x": x, "y": y, "is_pass": False})
                break
        if len(moves) > SGF_MAX_MOVES:
            raise AppError(ErrorCode.SGF_TOO_LARGE, f"SGF 落子数超限（>{SGF_MAX_MOVES} 手）")
    except (ValueError, TypeError) as exc:
        raise AppError(ErrorCode.SGF_INVALID, f"SGF 解析失败: {exc}") from None

    return {
        "board_size": board_size,
        "komi": komi,
        "rules": rules,
        "handicap": handicap,
        "black_name": props.get("PB"),
        "white_name": props.get("PW"),
        "black_rank": props.get("BR"),
        "white_rank": props.get("WR"),
        "moves": moves,
    }


def _normalize_rules(raw: str) -> Optional[str]:
    """规则集归一（大小写/附注不敏感）：``AGA (Territory)`` → ``aga``、``Chinese (Area)`` → ``chinese``。

    对局软件导出的 ``RU`` 常带括号附注（SmartGo：``AGA (Territory)``），附注不参与匹配；
    未归一匹配到的规则集返回 ``None``（调用方转 ``SGF_INVALID``）。
    """
    text = " ".join(re.sub(r"\([^)]*\)", " ", raw).lower().split())
    for candidate in (text, text.split(" ", 1)[0]):
        mapped = _RULES_ALIAS.get(candidate)
        if mapped is not None:
            return mapped
    return None


def _scan_node_properties(text: str, pos: int) -> tuple[dict[str, list[str]], int]:
    """扫描一个节点的属性（``;`` 后至 ``;``/``(``/``)`` 前），返回 (属性表, 新位置)。

    值按 SGF 规范解转义：``\\]``/``\\\\`` 还原为字面量、``\\`` + 换行为续行；
    注释/棋手名中出现的 ``;B[cc]`` 类文本只是值的一部分，不产生落子
    （旧实现全文正则扫描会误当落子）。属性值未闭合 → ``ValueError``。
    """
    properties: dict[str, list[str]] = {}
    length = len(text)
    while pos < length:
        char = text[pos]
        if char in "(;)":
            break
        if not char.isupper():
            pos += 1
            continue
        ident_start = pos
        while pos < length and text[pos].isupper():
            pos += 1
        ident = text[ident_start:pos]
        values: list[str] = []
        while pos < length and text[pos] == "[":
            pos += 1
            buffer: list[str] = []
            closed = False
            while pos < length:
                char = text[pos]
                if char == "\\":
                    pos += 1
                    if pos >= length:
                        break
                    if text[pos] == "\r" and pos + 1 < length and text[pos + 1] == "\n":
                        pos += 2  # CRLF 续行
                        continue
                    if text[pos] not in "\r\n":
                        buffer.append(text[pos])
                    pos += 1
                    continue
                if char == "]":
                    pos += 1
                    closed = True
                    break
                buffer.append(char)
                pos += 1
            if not closed:
                raise ValueError("属性值未闭合")
            values.append("".join(buffer))
        if values:
            properties.setdefault(ident, []).extend(values)
    return properties, pos


def _parse_game_tree(text: str, pos: int) -> tuple[list[dict[str, list[str]]], int]:
    """解析一个 GameTree，返回 (主谱节点列表, 新位置)。

    主谱 = 本序列节点 + **第一条**子分支的主谱（SGF 约定：变化图首分支为主谱）；
    其余分支仍递归解析但丢弃结果——不能改按括号计数跳过（属性值内可含括号）。
    """
    pos += 1  # 跳过 '('
    nodes: list[dict[str, list[str]]] = []
    first_child: Optional[list[dict[str, list[str]]]] = None
    length = len(text)
    while pos < length:
        char = text[pos]
        if char == ";":
            properties, pos = _scan_node_properties(text, pos + 1)
            nodes.append(properties)
        elif char == "(":
            child, pos = _parse_game_tree(text, pos)
            if first_child is None:
                first_child = child
        elif char == ")":
            pos += 1
            break
        else:
            pos += 1
    return nodes + (first_child or []), pos


async def export_game_sgf(conn, game_id: int) -> str:
    """按对局导出 SGF（读 games + moves）。"""
    from app.db import repos

    game = await repos.get_game(conn, game_id)
    if game is None:
        raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
    moves = await repos.list_moves(conn, game_id)
    return export_sgf(game, moves)


def game_params_from_parsed(parsed: dict) -> dict:
    """SGF 解析结果 → 创建对局参数（供 API 层创建对局 + 写入落子）。"""
    return {
        "mode": "human_human",
        "board_size": parsed["board_size"],
        "rules": parsed["rules"],
        "komi": parsed["komi"],
        "handicap": parsed["handicap"],
        "black": {"name": parsed["black_name"] or "真人", "rank": parsed["black_rank"]},
        "white": {"name": parsed["white_name"] or "真人", "rank": parsed["white_rank"]},
    }
