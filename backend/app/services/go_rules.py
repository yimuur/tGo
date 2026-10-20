"""围棋规则引擎（TASK T3.3，PRD §4.1.2 规则校验）。

在 Python 侧实现吃子 / 禁入点（自杀）/ 打劫校验，与引擎无关——
保证人人对弈在引擎异常时落子照常（ARCHITECTURE §5.2 降级矩阵）。

实现要点：
- **吃子**：四邻域连通棋串，无气即被提；
- **禁入点**：落子后本棋串无气（且未提子）→ 非法；
- **打劫**：简单劫规则——**不得复现上一手之前的局面**：恰提一子后该点为劫点，**紧接
  的下一手**若在劫点回提「恰好只提回对方上一手所下之子」（＝复现该局面）则非法；
  提回多子（倒扑/回提整串）或不提该子 → 局面不复现，照常合法（2026/09/16 修订——
  此前只判「落劫点即禁」，误禁倒扑回提）；
  劫点随每手更新（其余落子清空），**PASS 同样结束劫争**（正式规则：PASS 后劫立即解除，
  2026/09/12 修订——此前 PASS 被回放跳过、劫点残留跨 PASS 误禁）。
"""

from __future__ import annotations

from typing import Optional

#: 各尺寸让子上限（产品决策：9/13/19 路最多 4/6/9 子，2026/09/13）
HANDICAP_LIMITS: dict[int, int] = {9: 4, 13: 6, 19: 9}


def handicap_limit(board_size: int) -> int:
    """棋盘尺寸允许的最大让子数。不支持的尺寸抛 ValueError。"""
    limit = HANDICAP_LIMITS.get(board_size)
    if limit is None:
        raise ValueError(f"不支持的棋盘大小: {board_size}")
    return limit


def _classic_sets(
    corners: list[tuple[int, int]],
    sides: list[tuple[int, int]],
    center: tuple[int, int],
) -> dict[int, list[tuple[int, int]]]:
    """按国际经典让子序（AGA 1991 / 高川格教程 / Sensei's Library 图示 / 岩本薫）生成 1-9 子点位。

    放置序：右上→左下→右下→左上（四角）→ 左右边星 → 天元；
    **5/7 子天元入座、6/8 子不着天元**（偶数子不用天元为经典约定，SGF FF[4] 不定义摆放）。
    """
    ur, ll, lr, ul = corners
    left, right, top, bottom = sides
    base = [ur, ll, lr, ul]
    edges = [left, right, top, bottom]
    return {
        1: [ur],
        2: base[:2],
        3: base[:3],
        4: base[:4],
        5: base + [center],
        6: base + edges[:2],
        7: base + edges[:2] + [center],
        8: base + edges,
        9: base + edges + [center],
    }


#: 让子点位表（坐标 (x, y)，左上原点）。13/9 路按 19 路同构缩放。
_HANDICAP_SETS: dict[int, dict[int, list[tuple[int, int]]]] = {
    19: _classic_sets(
        [(15, 3), (3, 15), (15, 15), (3, 3)],
        [(3, 9), (15, 9), (9, 3), (9, 15)],
        (9, 9),
    ),
    13: _classic_sets(
        [(9, 3), (3, 9), (9, 9), (3, 3)],
        [(3, 6), (9, 6), (6, 3), (6, 9)],
        (6, 6),
    ),
    9: _classic_sets(
        [(6, 2), (2, 6), (6, 6), (2, 2)],
        [(2, 4), (6, 4), (4, 2), (4, 6)],
        (4, 4),
    ),
}


def handicap_points(board_size: int, n: int) -> list[tuple[int, int]]:
    """国际经典让子点位（1-9 子；0 返回空）。非法尺寸/数量抛 ValueError。"""
    if n == 0:
        return []
    sets = _HANDICAP_SETS.get(board_size)
    if sets is None:
        raise ValueError(f"不支持的棋盘大小: {board_size}")
    if not (1 <= n <= 9):
        raise ValueError(f"让子数越界: {n}（支持 1-9 子）")
    return list(sets[n])


def handicap_initial_stones(board_size: int, handicap: int) -> Optional[list[dict]]:
    """让子初始石（查询 ``initialStones`` 载荷：``[{color:'B',x,y},...]``）。

    分析查询必须与对弈查询同样携带初始石——否则让子局被按“无让子”局面分析
    （曲线/点评/报告失真，BUG-013）。``handicap <= 0`` → ``None``（不下发字段）。
    """
    if handicap <= 0:
        return None
    return [{"color": "B", "x": x, "y": y} for x, y in handicap_points(board_size, handicap)]


def build_board(
    *,
    board_size: int,
    handicap: int = 0,
    moves: Optional[list[dict]] = None,
) -> GoBoard:
    """由落子序列回放棋盘（含让子初始石；用于试下/结算等）。

    PASS 逐手经 ``pass_turn`` 回放（结束劫争）——劫点状态与对弈校验完全一致。
    """
    board = GoBoard(board_size)
    if handicap > 0:
        board.place_handicap(handicap_points(board_size, handicap))
    for m in moves or []:
        if m["is_pass"]:
            board.pass_turn()
        else:
            board.play(int(m["x"]), int(m["y"]), m["color"])
    return board


class GoRulesError(RuntimeError):
    """围棋规则违规（吃子/禁入/打劫）。"""


class GoBoard:
    """围棋棋盘（内存态），负责规则校验与状态维护。

    - ``_grid``: ``size x size``，None/\"B\"/\"W\"；
    - ``_ko_point``: 简单劫禁入点（被提单子位置）——紧接的下一手仅当**回提恰好只提回
      ``_ko_stone`` 之子**（＝复现上一手前局面）时非法；其余落子清空、PASS 经
      :meth:`pass_turn` 同样清空（正式规则）；
    - ``_ko_stone``: 造成劫点的上一手落子点（回提合法性对照）；
    - 提供 ``play``（校验 + 落子）、``pass_turn``（PASS）与 ``is_legal_move``（只读探针）。
    """

    def __init__(self, size: int) -> None:
        if size not in (9, 13, 19):
            raise ValueError(f"不支持的棋盘大小: {size}")
        self.size = size
        self._grid: list[list[Optional[str]]] = [
            [None] * size for _ in range(size)
        ]
        self._ko_point: Optional[tuple[int, int]] = None
        self._ko_stone: Optional[tuple[int, int]] = None

    # ---- 基础访问 ----

    def stone_at(self, x: int, y: int) -> Optional[str]:
        """(x,y) 处棋子颜色（None=空）。"""
        return self._grid[y][x]

    def grid(self) -> list[list[Optional[str]]]:
        """棋盘快照（只读副本）。"""
        return [row[:] for row in self._grid]

    @property
    def ko_point(self) -> Optional[tuple[int, int]]:
        """当前劫点（对手下一手禁入）。"""
        return self._ko_point

    def copy(self) -> "GoBoard":
        """棋盘深拷贝（M-8 前缀缓存：缓存快照与调用方修改隔离）。"""
        clone = GoBoard(self.size)
        clone._grid = [row[:] for row in self._grid]
        clone._ko_point = self._ko_point
        clone._ko_stone = self._ko_stone
        return clone

    def _neighbors(self, x: int, y: int):
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < self.size and 0 <= ny < self.size:
                yield nx, ny

    def _group(self, x: int, y: int) -> tuple[set[tuple[int, int]], set[tuple[int, int]]]:
        """(x,y) 所在同色棋串：返回 (棋子集合, 气集合)。"""
        color = self._grid[y][x]
        stones: set[tuple[int, int]] = set()
        liberties: set[tuple[int, int]] = set()
        stack = [(x, y)]
        while stack:
            cx, cy = stack.pop()
            if (cx, cy) in stones:
                continue
            stones.add((cx, cy))
            for nx, ny in self._neighbors(cx, cy):
                if self._grid[ny][nx] is None:
                    liberties.add((nx, ny))
                elif self._grid[ny][nx] == color and (nx, ny) not in stones:
                    stack.append((nx, ny))
        return stones, liberties

    # ---- 落子 ----

    def place_handicap(self, points: list[tuple[int, int]]) -> None:
        """放置让子（初始石子，不校验合法性；黑色）。"""
        for x, y in points:
            if not (0 <= x < self.size and 0 <= y < self.size):
                raise ValueError(f"让子坐标越界: ({x},{y})")
            self._grid[y][x] = "B"

    def play(self, x: int, y: int, color: str) -> int:
        """落子：规则校验（吃子/禁入/打劫），非法抛 ``GoRulesError``。

        合法时提交棋盘状态并返回提子数。
        """
        captured = self._compute_capture(x, y, color)
        opp = "W" if color == "B" else "B"
        # 提交
        self._grid[y][x] = color
        for sx, sy in captured:
            self._grid[sy][sx] = None
        # 劫点：恰好提一子 → 被提子位置为劫点、本手落子点为对照子；否则一并清空
        if len(captured) == 1:
            self._ko_point = captured[0]
            self._ko_stone = (x, y)
        else:
            self._ko_point = None
            self._ko_stone = None
        return len(captured)

    def pass_turn(self) -> None:
        """PASS：结束劫争（正式规则：PASS 后劫立即解除，下一手可落劫点）。"""
        self._ko_point = None
        self._ko_stone = None

    def is_legal_move(self, x: int, y: int, color: str) -> bool:
        """只读探针：不修改棋盘地判断落子是否合法。"""
        try:
            self._compute_capture(x, y, color)
            return True
        except GoRulesError:
            return False

    def has_legal_move(self, color: str) -> bool:
        """该色是否存在任一合法落点（无子可下判定）。"""
        for y in range(self.size):
            for x in range(self.size):
                if self._grid[y][x] is None and self.is_legal_move(x, y, color):
                    return True
        return False

    # ---- 校验核心 ----

    def _compute_capture(self, x: int, y: int, color: str) -> list[tuple[int, int]]:
        """计算落子后的提子序列（不修改棋盘）；非法抛 ``GoRulesError``。

        顺序：越界 → 占点 → 劫点（复现上一手前局面）→ 禁入点（自杀）。
        """
        if not (0 <= x < self.size and 0 <= y < self.size):
            raise GoRulesError("坐标越界")
        if self._grid[y][x] is not None:
            raise GoRulesError("该点已有棋子")

        opp = "W" if color == "B" else "B"
        captured: list[tuple[int, int]] = []
        # 临时放置并计算提子
        self._grid[y][x] = color
        try:
            for nx, ny in self._neighbors(x, y):
                if self._grid[ny][nx] == opp:
                    stones, libs = self._group(nx, ny)
                    if not libs:
                        captured.extend(stones)
                        for sx, sy in stones:
                            self._grid[sy][sx] = None
            # 打劫：回提恰只提回上一手所下之子 ⇔ 结果局面＝上一手之前局面 ⇔ 非法
            # （提回多子＝倒扑/回提整串 → 局面不复现 → 合法）
            if self._ko_point == (x, y) and captured == [self._ko_stone]:
                raise GoRulesError("打劫（劫点禁入）")
            # 禁入点：提子后本棋串仍无气 → 自杀
            _, own_libs = self._group(x, y)
            if not own_libs:
                raise GoRulesError("禁入点（自杀）")
            return captured
        finally:
            # 还原（探针语义）
            self._grid[y][x] = None
            for sx, sy in captured:
                self._grid[sy][sx] = opp
