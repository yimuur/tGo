"""GTP ``final_score`` 语义等价实现（KataGo 源码对照，2026/09/11 人工确认）。

对照源码：
- ``cpp/command/gtp.cpp`` → ``final_score``：``computeAnticipatedWinnerAndScore(winner, score)``
  后按 ``B+%.1f`` / ``W+%.1f`` / ``0`` 输出；
- ``cpp/command/gtp.cpp::computeAnticipatedWinnerAndScore``（GTPEngine 内）：
  - **已终局且 AREA(!friendlyPassOk) 或 TERRITORY** → 直接用 ``hist.winner`` /
    ``hist.finalWhiteMinusBlackScore``（精确计分，不经预期估算）；
  - 否则 → ``PlayUtils::computeLead(...)``（引擎搜索得到的**白方视角** lead），
    再按 ``hist.rules.gameResultWillBeInteger()`` 取整到整数/半整数，
    ``winner = sign(lead)``；
- ``cpp/program/playutils.cpp::computeAnticipatedStatusesWithOwnership``
  （``final_status_list dead`` 的人机友好路径）：以 ownership 对**整条棋串**判定死活，
  启发式阈值 ``avgThresholdForLife = 0.2`` / ``worstThresholdForLife = -0.6``
  （己方视角权益）；
- ``cpp/game/rules.cpp::gameResultWillBeInteger()``：``komiIsInteger != hasButton``。

本模块用**分析引擎**（Analysis 通道）的结果等价实现上述语义：
- 预判死子：ownership 链级启发式（本项目存储为**黑方视角**，正值=黑方领地）；
- 终局结果：双 PASS 终局 → 按预判死子做精确数子（``services.scoring``）；
  未完局（认输）→ 以深算 ``scoreLead`` 作为 lead 估算并按规则取整。

> 上述两个阈值与取整规则是 KataGo 的**算法常量**（协议等价性），不是产品可调参数，
> 故按源码等价实现固定在此；产品参数（maxVisits / 参与开关）来自 ``config``。
"""

from __future__ import annotations

import math
from typing import Iterable, Optional

from app.services.scoring import replay_position, score_grid

#: ownership 链级死活启发式（KataGo playutils.cpp computeAnticipatedStatusesWithOwnership）
AVG_THRESHOLD_FOR_LIFE = 0.2
WORST_THRESHOLD_FOR_LIFE = -0.6


def _round_half_away(value: float) -> int:
    """四舍五入（远离 0，对齐 C++ ``std::round``；Python ``round`` 为银行家舍入）。"""
    return math.floor(value + 0.5) if value >= 0 else math.ceil(value - 0.5)


def _chains(grid: list[list[Optional[str]]]) -> list[tuple[str, list[tuple[int, int]]]]:
    """棋盘 → 全部棋串 [(颜色, [(x,y)…])]（四邻域连通）。"""
    size = len(grid)
    seen = [[False] * size for _ in range(size)]
    chains: list[tuple[str, list[tuple[int, int]]]] = []
    for y in range(size):
        for x in range(size):
            color = grid[y][x]
            if color is None or seen[y][x]:
                continue
            stack = [(x, y)]
            seen[y][x] = True
            stones: list[tuple[int, int]] = []
            while stack:
                cx, cy = stack.pop()
                stones.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < size and 0 <= ny < size and not seen[ny][nx]:
                        if grid[ny][nx] == color:
                            seen[ny][nx] = True
                            stack.append((nx, ny))
            chains.append((color, stones))
    return chains


def predict_dead_stones(
    grid: list[list[Optional[str]]],
    ownership: Optional[Iterable[float]],
    *,
    avg_threshold: float = AVG_THRESHOLD_FOR_LIFE,
    worst_threshold: float = WORST_THRESHOLD_FOR_LIFE,
) -> list[tuple[int, int]]:
    """GTP ``final_status_list dead`` 等价：按 ownership 判定死子（链级启发式）。

    - ``ownership`` 为 KataGo 输出（本项目经输出侧翻转后的**黑方视角**，正值=黑方领地）；
      与 KataGo 内部白方视角对应关系：``ownership_white = -ownership_black``，
      故黑链存活 ⇔ ``avg > 0.2 且 min > -0.6``；白链存活 ⇔ ``avg < -0.2 且 max < 0.6``；
    - 缺 ownership（引擎不可用/旧数据）或长度不足 → ``[]``（不预判，由人工确认死子）。
    """
    size = len(grid)
    if size <= 0 or ownership is None:
        return []
    values = [float(v) for v in ownership]
    if len(values) < size * size:
        return []
    dead: list[tuple[int, int]] = []
    for color, stones in _chains(grid):
        chain_values = [values[y * size + x] for x, y in stones]
        avg = sum(chain_values) / len(chain_values)
        if color == "B":
            alive = avg > avg_threshold and min(chain_values) > worst_threshold
        else:
            alive = avg < -avg_threshold and max(chain_values) < -worst_threshold
        if not alive:
            dead.extend(stones)
    return dead


def round_lead(lead_white_minus_black: float, *, komi: float, has_button: bool = False) -> float:
    """按 GTP 语义取整 lead（``Rules::gameResultWillBeInteger()`` → 整数/半整数）。"""
    komi_is_integer = float(komi).is_integer()
    if komi_is_integer != bool(has_button):
        return float(_round_half_away(lead_white_minus_black))
    return float(_round_half_away(lead_white_minus_black + 0.5) - 0.5)


def _result_text(lead_white_minus_black: float) -> str:
    """白减黑目差 → 结果字符串（白领先 ``W+x``、黑领先 ``B+x``、0 → ``Draw``）。"""
    if lead_white_minus_black > 0:
        return f"W+{_fmt(lead_white_minus_black)}"
    if lead_white_minus_black < 0:
        return f"B+{_fmt(-lead_white_minus_black)}"
    return "Draw"


def _fmt(value: float) -> str:
    """目数文本：整数原样、一位小数去尾 0（与 scoring.ScoringResult.result 同口径）。"""
    if float(value).is_integer():
        return str(int(value))
    return f"{value:.1f}"


def predict_from_analysis(
    *,
    board_size: int,
    rules: str,
    komi: float,
    handicap: int,
    moves: list[dict],
    ownership: Optional[Iterable[float]],
    score_lead_black: Optional[float],
    finished: bool,
) -> dict:
    """GTP ``final_score`` 等价：预判死子 + 终局结果（``scoring.prediction`` 载荷）。

    - ``finished=True``（双 PASS 终局）：按预判死子精确数子（``scoring.score_grid``，
      复用本函数已回放的终局棋盘，不重复回放）→ ``result``/``black_score``/``white_score``；
    - ``finished=False``（认输）：以 ``score_lead_black`` 折算白方视角 lead 并按规则
      取整 → ``result``（精确目数不适用，``black_score``/``white_score`` 为 None）；
    - ``ownership``/``score_lead`` 缺失时对应部分为空（前端退化为人工确认）。
    """
    replayed = replay_position(board_size=board_size, handicap=handicap, moves=moves)
    grid = replayed.grid
    # 死子预判须先于计分（``score_grid`` 会把死子从传入棋盘上移除）
    dead = predict_dead_stones(grid, ownership)
    payload: dict = {
        "finished": bool(finished),
        "dead_points": [[x, y] for x, y in dead],
        "result": None,
        "black_score": None,
        "white_score": None,
        "lead": None,
    }
    if finished:
        sr = score_grid(
            grid,
            rules=rules,
            komi=komi,
            dead_points=dead,
            black_prisoners=replayed.black_prisoners,
            white_prisoners=replayed.white_prisoners,
        )
        payload.update(
            {
                "result": sr.result,
                "black_score": sr.black_score,
                "white_score": sr.white_score,
                "lead": round(sr.black_score - sr.white_score, 1),
            }
        )
        return payload
    if score_lead_black is None:
        return payload
    # 黑方视角 scoreLead → 白减黑 lead → GTP 取整
    lead_white_minus_black = round_lead(-float(score_lead_black), komi=komi)
    payload["result"] = _result_text(lead_white_minus_black)
    payload["lead"] = -lead_white_minus_black
    return payload


__all__ = [
    "AVG_THRESHOLD_FOR_LIFE",
    "WORST_THRESHOLD_FOR_LIFE",
    "predict_dead_stones",
    "predict_from_analysis",
    "round_lead",
]
