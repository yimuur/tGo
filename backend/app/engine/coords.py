"""GTP 坐标 ↔ (x, y) 换算（KataGo Analysis 引擎坐标语义，支持 9/13/19 路）。

- GTP：列 A-H、J-T（跳过 I），行 1-N（下至上，N=盘大小）；内部 (x, y) 左上原点 (0,0)；
- **换算必须携带 ``board_size``**（默认 19）：行号 = ``board_size - y``——
  曾固定 19 路致 9/13 路落子被拼成 19 路坐标（9 路 C7 → C17，ISSUE-056）；
- 支持 `pass` 与 `(x,y)` 显式坐标形式（KataGo 扩展）。
"""

from __future__ import annotations

from typing import Optional

COLS = "ABCDEFGHJKLMNOPQRST"  # 19 列，跳过 I
PASS_LOC = "pass"


def xy_to_gtp(x: int, y: int, *, board_size: int = 19) -> str:
    """(x, y)（0..board_size-1，左上原点）→ GTP 字符串（如 C4 / 9 路 C7）。"""
    if board_size not in (9, 13, 19):
        raise ValueError(f"不支持的棋盘大小: {board_size}")
    if not (0 <= x < board_size <= len(COLS)):
        raise ValueError(f"x 越界: {x}（棋盘 {board_size}）")
    if not (0 <= y < board_size):
        raise ValueError(f"y 越界: {y}（棋盘 {board_size}）")
    return f"{COLS[x]}{board_size - y}"


def gtp_to_xy(loc: str, *, board_size: int = 19) -> tuple[int, int]:
    """GTP 字符串（如 C4 / (3,15)）→ (x, y)；按盘大小解析；`pass` 抛 ValueError。"""
    if board_size not in (9, 13, 19):
        raise ValueError(f"不支持的棋盘大小: {board_size}")
    loc = loc.strip().upper()
    if loc == PASS_LOC.upper():
        raise ValueError("pass 无坐标")
    if loc.startswith("(") and loc.endswith(")"):
        parts = loc[1:-1].split(",")
        x, y = int(parts[0].strip()), int(parts[1].strip())
        if not (0 <= x < board_size and 0 <= y < board_size):
            raise ValueError(f"坐标越界: {loc}（棋盘 {board_size}）")
        return x, y
    col = loc[0]
    if col not in COLS:
        raise ValueError(f"非法列: {col}")
    x = COLS.index(col)
    if x >= board_size:
        raise ValueError(f"列越界: {col}（棋盘 {board_size}）")
    row = int(loc[1:])
    if not (1 <= row <= board_size):
        raise ValueError(f"非法行: {row}（棋盘 {board_size}）")
    return x, board_size - row


def data_board_size(data: Optional[dict]) -> int:
    """从分析数据取盘大小（preprocess 已注入 ``board_size``）；缺失/非法默认 19。"""
    try:
        b = int((data or {}).get("board_size") or 0)
    except (TypeError, ValueError):
        b = 0
    return b if b in (9, 13, 19) else 19


def is_pass_loc(loc: str) -> bool:
    """是否为 pass 位置。"""
    return loc.strip().upper() == PASS_LOC.upper()
