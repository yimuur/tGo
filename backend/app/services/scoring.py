"""终局结算（Python 侧实现，引擎无关；TASK T3.4，PRD §4.1.8）。

**本模块是全系统唯一的“数子/目数”计分实现**（未被 ``final_score`` 取代，二者分工）：

| 调用方 | 用途 |
| --- | --- |
| ``game_service.confirm_scoring`` | 结算确认落盘（``scorings`` 表）的 Python 结算（引擎不可用亦可结算） |
| ``final_score.predict_from_analysis`` | GTP ``final_score`` 预判：双 PASS 终局时按预判死子复用本模块 ``score_grid`` 精确数子 |

``final_score.py`` 只叠加 GTP 语义层（ownership 链级死子预判 / ``gameResultWillBeInteger``
取整 / 结果串），**不重复实现计分**。

保证引擎异常不影响人人对弈结算（ARCHITECTURE §5.2 降级矩阵）：
- **数子法（中国/AGA）**：黑/白 领地空点 + 活子数，白方加贴目（komi）；
- **目数法（日本）**：黑/白 领地空点 + 对方俘虏（**对局中被提的子 + 终局标记的死子**，BUG-030），白方加贴目；
- **死子确认**：`dead_points` 人工校正，移除后重算领地；
- **result 格式**：`B+7.5` / `W+2` / `Draw`（胜方 + 差值）。

> 双活/劫材等极端棋形简化为"中立"处理（不属于任何一方领地），
> 与常见在线对弈平台的简化实现一致。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.core.errors import AppError, ErrorCode
from app.services.go_rules import GoBoard, GoRulesError, handicap_points


@dataclass(frozen=True)
class ScoringResult:
    """结算结果（scorings 表 UPSERT 载荷，DATABASE §3.5）。"""

    black_score: float
    white_score: float
    result: str
    black_territory: int
    white_territory: int
    neutral: int
    dead_black: int
    dead_white: int


@dataclass(frozen=True)
class ReplayedPosition:
    """对局回放结果（终局棋盘 + 双方**对局**俘虏数）。"""

    grid: list[list[Optional[str]]]
    #: 黑方提掉的白子数（对局中，不含终局标记死子）
    black_prisoners: int
    #: 白方提掉的黑子数
    white_prisoners: int


def replay_position(
    *, board_size: int, handicap: int, moves: list[dict]
) -> ReplayedPosition:
    """回放整局：终局棋盘 + 双方对局俘虏数（按落子方归属）。

    俘虏数取**落子记录回放**结果，不读 ``games.black_captures``/``white_captures``
    计数列——后者为展示用累计值，悔棋/重开不回退；回放天然与当前棋谱一致。
    PASS 逐手回放（``pass_turn``，结束劫争）——劫点状态与对弈校验一致。

    历史数据与当前规则不符（如让子点位修订前的旧对局，ISSUE-064）时抛
    ``REPLAY_CONFLICT``，由调用方（HTTP/WS 层）统一转为领域错误响应。
    """
    board = GoBoard(board_size)
    black_prisoners = 0
    white_prisoners = 0
    try:
        if handicap > 0:
            board.place_handicap(handicap_points(board_size, handicap))
        for m in moves:
            if m["is_pass"]:
                board.pass_turn()
                continue
            captured = board.play(int(m["x"]), int(m["y"]), m["color"])
            if m["color"] == "B":
                black_prisoners += captured
            else:
                white_prisoners += captured
    except GoRulesError as exc:
        raise AppError(
            ErrorCode.REPLAY_CONFLICT,
            f"对局记录无法回放：历史数据与当前规则不符（{exc}）",
        ) from None
    return ReplayedPosition(
        grid=board.grid(),
        black_prisoners=black_prisoners,
        white_prisoners=white_prisoners,
    )


def build_final_grid(
    *, board_size: int, handicap: int, moves: list[dict]
) -> list[list[Optional[str]]]:
    """由对局参数回放终局棋盘（含让子初始石与全部落子）。"""
    return replay_position(board_size=board_size, handicap=handicap, moves=moves).grid


def compute_scoring(
    *,
    board_size: int,
    rules: str,
    komi: float,
    handicap: int,
    moves: list[dict],
    dead_points: Optional[list[tuple[int, int]]] = None,
) -> ScoringResult:
    """终局结算：回放终局棋盘 → 移除死子 → 领地划分 → 按规则集计分。

    - ``rules``: chinese / japanese / aga（中国/AGA 数子，日本目数）；
    - ``dead_points``: 人工校正的死子坐标列表（可为空=跳过）；
    - 日本目数法的俘虏 = 对局回放提子 + ``dead_points``（BUG-030）。
    """
    replayed = replay_position(board_size=board_size, handicap=handicap, moves=moves)
    return score_grid(
        replayed.grid,
        rules=rules,
        komi=komi,
        dead_points=dead_points,
        black_prisoners=replayed.black_prisoners,
        white_prisoners=replayed.white_prisoners,
    )


def score_grid(
    grid: list[list[Optional[str]]],
    *,
    rules: str,
    komi: float,
    dead_points: Optional[list[tuple[int, int]]] = None,
    black_prisoners: int = 0,
    white_prisoners: int = 0,
) -> ScoringResult:
    """对给定棋盘直接结算（测试/复用友好）。

    - ``dead_points``：终局标记的死子（移除后重算领地）；
    - ``black_prisoners``/``white_prisoners``：对局中双方各自提掉对方的子数
      （**仅日本目数法计入**；数子法为面积口径、忽略——BUG-030）。
    """
    if rules not in ("chinese", "japanese", "aga"):
        raise ValueError(f"不支持的规则集: {rules}")

    board_size = len(grid)
    dead = dead_points or []

    # 死子计数（按移除前颜色）
    dead_black = 0
    dead_white = 0
    for x, y in dead:
        if not (0 <= x < board_size and 0 <= y < board_size):
            raise ValueError(f"死子坐标越界: ({x},{y})")
        if grid[y][x] == "B":
            dead_black += 1
        elif grid[y][x] == "W":
            dead_white += 1
        grid[y][x] = None  # 移除死子

    black_terr, white_terr, neutral = _territory(grid)
    black_stones = sum(1 for row in grid for c in row if c == "B")
    white_stones = sum(1 for row in grid for c in row if c == "W")

    if rules in ("chinese", "aga"):
        # 数子法：领地 + 活子；白方加贴目（面积口径，俘虏不影响）
        black_total = float(black_stones + black_terr)
        white_total = float(white_stones + white_terr + komi)
    else:  # japanese
        # 目数法：领地 + 对方俘虏（对局提子 + 终局标记死子）；白方加贴目
        black_total = float(black_terr + dead_white + black_prisoners)
        white_total = float(white_terr + dead_black + white_prisoners + komi)

    diff = black_total - white_total
    if diff > 0:
        result = f"B+{_fmt(diff)}"
    elif diff < 0:
        result = f"W+{_fmt(-diff)}"
    else:
        result = "Draw"

    return ScoringResult(
        black_score=black_total,
        white_score=white_total,
        result=result,
        black_territory=black_terr,
        white_territory=white_terr,
        neutral=neutral,
        dead_black=dead_black,
        dead_white=dead_white,
    )


def _territory(grid: list[list[Optional[str]]]) -> tuple[int, int, int]:
    """领地划分：空域连通区，仅邻接单色 → 该色领地；双色邻接 → 中立。"""
    size = len(grid)
    visited: set[tuple[int, int]] = set()
    black_terr = white_terr = neutral = 0
    for y in range(size):
        for x in range(size):
            if grid[y][x] is not None or (x, y) in visited:
                continue
            region: list[tuple[int, int]] = []
            colors: set[str] = set()
            stack = [(x, y)]
            while stack:
                cx, cy = stack.pop()
                if (cx, cy) in visited:
                    continue
                visited.add((cx, cy))
                region.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < size and 0 <= ny < size:
                        neighbor = grid[ny][nx]
                        if neighbor is None:
                            stack.append((nx, ny))
                        else:
                            colors.add(neighbor)
            if colors == {"B"}:
                black_terr += len(region)
            elif colors == {"W"}:
                white_terr += len(region)
            else:
                neutral += len(region)
    return black_terr, white_terr, neutral


def _fmt(value: float) -> str:
    """差值格式化（7.5 → "7.5"，2.0 → "2"）。"""
    return f"{value:g}"
