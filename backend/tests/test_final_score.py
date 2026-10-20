"""GTP ``final_score`` 语义等价实现测试（services/final_score.py，2026/09/11）。

用例 ID: FS-*
- ``predict_dead_stones``：ownership 链级启发式（avg 0.2 / worst -0.6，KataGo
  playutils.cpp computeAnticipatedStatusesWithOwnership 等价）；
- ``round_lead``：``gameResultWillBeInteger()``（komi 整数性 vs button）取整；
- ``predict_from_analysis``：双 PASS 精确数子 / 认输 lead 估算。
"""

from app.services.final_score import predict_dead_stones, predict_from_analysis, round_lead


def _grid(size: int, stones: dict[tuple[int, int], str]) -> list[list]:
    grid = [[None] * size for _ in range(size)]
    for (x, y), color in stones.items():
        grid[y][x] = color
    return grid


class TestPredictDeadStones:
    def test_alive_black_chain_not_marked(self):
        """黑链在黑方强领地（avg>0.2 且 min>-0.6）→ 活棋不标记。"""
        grid = _grid(3, {(0, 0): "B"})
        ownership = [0.9] * 9
        assert predict_dead_stones(grid, ownership) == []

    def test_dead_black_chain_marked(self):
        """黑链位于白方领地（avg<0.2）→ 死子标记。"""
        grid = _grid(3, {(0, 0): "B"})
        ownership = [-0.5] * 9
        assert predict_dead_stones(grid, ownership) == [(0, 0)]

    def test_white_chain_dead_in_black_territory(self):
        """白链位于黑方领地（avg>-0.2）→ 死子标记。"""
        grid = _grid(3, {(2, 2): "W"})
        ownership = [0.7] * 9
        assert predict_dead_stones(grid, ownership) == [(2, 2)]

    def test_white_chain_alive_in_white_territory(self):
        grid = _grid(3, {(2, 2): "W"})
        ownership = [-0.7] * 9
        assert predict_dead_stones(grid, ownership) == []

    def test_whole_chain_evaluated_together(self):
        """整条棋串取 avg/min（同串两子：一子弱一子强 → 按链判定）。"""
        grid = _grid(3, {(0, 0): "B", (1, 0): "B"})
        ownership = [0.9, -0.9, 0, 0, 0, 0, 0, 0, 0]
        # avg = 0.0 不大于 0.2 → 死
        assert predict_dead_stones(grid, ownership) == [(0, 0), (1, 0)]

    def test_missing_ownership_returns_empty(self):
        grid = _grid(3, {(0, 0): "B"})
        assert predict_dead_stones(grid, None) == []
        assert predict_dead_stones(grid, [0.1]) == []


class TestRoundLead:
    def test_half_integer_when_komi_is_half(self):
        """komi 7.5（非整数）→ 半整数取整（C++ round 语义，远离 0）。"""
        assert round_lead(3.2, komi=7.5) == 3.5
        assert round_lead(-3.2, komi=7.5) == -3.5

    def test_integer_when_komi_is_integer(self):
        """komi 0（整数）→ 整数取整。"""
        assert round_lead(3.2, komi=0) == 3
        assert round_lead(-3.7, komi=0) == -4


class TestPredictFromAnalysis:
    def test_finished_scoring_with_predicted_dead(self):
        """双 PASS（finished）→ 按预判死子精确数子（含死子移除）。"""
        # 9 路：黑 1 子在于白方领地（预判死子）→ 移除后白领地扩张
        moves = [
            {"move_no": 1, "color": "B", "x": 0, "y": 0, "is_pass": False},
            {"move_no": 2, "color": "W", "x": 8, "y": 8, "is_pass": False},
            {"move_no": 3, "color": "B", "is_pass": True},
            {"move_no": 4, "color": "W", "is_pass": True},
        ]
        ownership = [-0.5] * 81
        ownership[0] = -0.8  # (0,0) 黑子在白方强领地 → 预判死子；白子自身在己方领地
        pred = predict_from_analysis(
            board_size=9,
            rules="chinese",
            komi=7.5,
            handicap=0,
            moves=moves,
            ownership=ownership,
            score_lead_black=None,
            finished=True,
        )
        assert pred["finished"] is True
        assert pred["dead_points"] == [[0, 0]]
        assert pred["result"] is not None
        assert pred["black_score"] is not None
        assert pred["white_score"] is not None
        assert pred["lead"] == round(pred["black_score"] - pred["white_score"], 1)

    def test_finished_japanese_counts_in_play_prisoners(self):
        """BUG-030 回归：日本规则双 PASS 精确数子须含**对局俘虏**（非仅终局死子）。

        B(1,0) → W(0,0) → B(0,1) 提白 1 子后双 PASS：黑地 79 + 俘虏 1 = 80
        （修复前面板给出黑 79 : 白 0，少算净提子差 1 目）。
        """
        moves = [
            {"move_no": 1, "color": "B", "x": 1, "y": 0, "is_pass": False},
            {"move_no": 2, "color": "W", "x": 0, "y": 0, "is_pass": False},
            {"move_no": 3, "color": "B", "x": 0, "y": 1, "is_pass": False},
            {"move_no": 4, "color": "W", "is_pass": True},
            {"move_no": 5, "color": "B", "is_pass": True},
        ]
        pred = predict_from_analysis(
            board_size=9,
            rules="japanese",
            komi=0.0,
            handicap=0,
            moves=moves,
            ownership=[0.9] * 81,
            score_lead_black=None,
            finished=True,
        )
        assert pred["dead_points"] == []  # 黑子均在己方领地 → 无终局死子
        assert pred["black_score"] == 80.0
        assert pred["white_score"] == 0.0
        assert pred["result"] == "B+80"

    def test_unfinished_resign_uses_lead_estimate(self):
        """认输（未终局）→ 黑方 scoreLead 折白方视角 lead 取整 → B+x/W+x。"""
        pred = predict_from_analysis(
            board_size=19,
            rules="chinese",
            komi=7.5,
            handicap=0,
            moves=[],
            ownership=None,
            score_lead_black=3.2,  # 黑领先 3.2 → 白减黑 -3.2 → 半整数 -3.5
            finished=False,
        )
        assert pred["finished"] is False
        assert pred["dead_points"] == []
        assert pred["result"] == "B+3.5"
        assert pred["lead"] == 3.5
        assert pred["black_score"] is None and pred["white_score"] is None

    def test_unfinished_without_lead_returns_empty_result(self):
        pred = predict_from_analysis(
            board_size=19,
            rules="chinese",
            komi=7.5,
            handicap=0,
            moves=[],
            ownership=None,
            score_lead_black=None,
            finished=False,
        )
        assert pred["result"] is None
