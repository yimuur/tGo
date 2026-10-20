"""自适应难度（TASK T3.8，LEVEL.md 算法，ARCHITECTURE §3.4/PRD §4.1.3）。

算法（LEVEL.md）：
- **主指标**：当前盘面 Score Lead（人类视角领先目数）；
- **副指标**：近期平均 Score Loss（滑动窗口 5-7 手，**仅统计人类落子**）；
- **升级**：Score Lead > +8.0 且 近窗口平均 Score Loss < 0.5（遇强则强）；
- **降级**：Score Lead < -15.0 或 近窗口平均 Score Loss > 3.0（放水挽救），
  并注入负 ``playoutDoublingAdvantage``（PDA）让 AI 收缩防线；
- **保持**：其余（胶着状态维持当前档位）；
- **档位写回**：每次 AI 落子前判定后写回 ``games.ai_level``（断点恢复不丢失）；
- 阈值/窗口/PDA 全部来自 ``config.yaml``（config.adaptive，禁止硬编码）。

Score Lead 语义（ISSUE-050，2026/09/05 引擎级 ``reportAnalysisWinratesAs=BLACK``）：
``rootInfo.scoreLead`` 统一为**黑方视角**（正=黑领先）；判定发生在 AI 落子前，
人类视角 = 黑方领先数（人类执黑）或取反（人类执白）。
Score Loss：某手人类落子（局面 N-1 处分析）的 ``best - played scoreLead``（
候选同局面同视角的相对量，视角无关；按落子方颜色取 best 的 max/min）。
"""

from __future__ import annotations

import json
import logging
from enum import Enum
from typing import Optional

from app.config import AppConfig
from app.db import repos
from app.engine.coords import data_board_size, xy_to_gtp

logger = logging.getLogger(__name__)


class AdaptiveDecision(str, Enum):
    """自适应判定结果。"""

    UP = "up"
    DOWN = "down"
    KEEP = "keep"


#: 判定 → 日志中文文案（系统日志须便于人类阅读/理解）
_DECISION_TEXT: dict[AdaptiveDecision, str] = {
    AdaptiveDecision.UP: "升级",
    AdaptiveDecision.DOWN: "降级",
    AdaptiveDecision.KEEP: "保持",
}


class AdaptiveDifficulty:
    """自适应难度组件（对局级；conn 与 GameService 共用）。"""

    def __init__(self, conn, config: AppConfig) -> None:
        self._conn = conn
        self._cfg = config

    def update_config(self, cfg: AppConfig) -> None:
        """运行期配置热更新（H-1）：刷新自适应阈值/窗口/PDA 配置引用。"""
        self._cfg = cfg

    # ---- 判定 ----

    async def decide(self, game: dict) -> AdaptiveDecision:
        """AI 落子前判定：升级/降级/保持不变。

        - 无分析数据（引擎不可用/未落盘）时返回 KEEP（保守不跳档）；
        - **人类尚未落子**（AI 先行局初始局面）恒 KEEP（BUG-028）：主/副指标均取
          人类落子后的局面数据（LEVEL.md「每次人类落子后获取…」），初始局面没有
          人类表现可言——否则让子局初始目差会立刻误升档，偏离「初始水平」语义。
        """
        cfg = self._cfg.adaptive
        human_moves = await self._human_moves(game)
        if not human_moves:
            return AdaptiveDecision.KEEP
        lead = await self._human_score_lead(game)
        mean_loss = await self._recent_score_loss(game, human_moves)

        # 主指标：人类领先 > +8 且 近期零失误 → 升级
        if lead is not None and lead > cfg.score_lead_up and (
            mean_loss is None or mean_loss < cfg.score_loss_up
        ):
            return AdaptiveDecision.UP
        # 主指标：人类落后 < -15 或 近期昏招 → 降级
        if (lead is not None and lead < cfg.score_lead_down) or (
            mean_loss is not None and mean_loss > cfg.score_loss_down
        ):
            return AdaptiveDecision.DOWN
        return AdaptiveDecision.KEEP

    async def adjust(self, game: dict) -> tuple[AdaptiveDecision, int, Optional[float]]:
        """判定 + 写回档位，返回 (decision, new_level, pda)。

        - 升级/降级时调整档位并写回 ``games.ai_level``；
        - 降级注入负 PDA（``config.adaptive.playout_doubling_advantage``）。
        """
        decision = await self.decide(game)
        level = int(game["ai_level"] or 1)
        pda: Optional[float] = None
        if decision is AdaptiveDecision.UP:
            level = min(12, level + 1)
        elif decision is AdaptiveDecision.DOWN:
            level = max(1, level - 1)
            pda = self._cfg.adaptive.playout_doubling_advantage
        if level != int(game["ai_level"] or 1):
            await repos.update_game_ai_level(self._conn, game["id"], level)
            logger.info(
                "对局 #%d 自适应难度：%d 级 → %d 级（判定=%s）",
                game["id"], int(game["ai_level"] or 1), level, _DECISION_TEXT[decision],
            )
        return decision, level, pda

    # ---- 指标计算 ----

    async def _human_score_lead(self, game: dict) -> Optional[float]:
        """人类视角当前盘面 Score Lead（黑方视角 rootInfo.scoreLead，ISSUE-050）。"""
        row = await repos.get_main_analysis(self._conn, game["id"], game["last_move_no"])
        if row is None:
            return None
        data = json.loads(row["data_json"])
        root = data.get("rootInfo") or {}
        score_lead = root.get("scoreLead")
        if score_lead is None:
            return None
        # 黑方视角 → 人类视角：人类执黑直接用；执白取反（不再依赖 currentPlayer）
        if game["human_color"] == "B":
            return float(score_lead)
        return -float(score_lead)

    async def _human_moves(self, game: dict) -> list[dict]:
        """人类落子序列（人机对弈按 ``human_color``；其余按黑方口径，同点评口径）。"""
        moves = await repos.list_moves(self._conn, game["id"])
        human_color = game["human_color"] if game["mode"] == "human_ai" else "B"
        return [m for m in moves if m["color"] == human_color]

    async def _recent_score_loss(
        self, game: dict, human_moves: Optional[list[dict]] = None
    ) -> Optional[float]:
        """近窗口平均 Score Loss（仅统计人类落子；M-5：批量读取避免逐手 N+1）。

        ``human_moves`` 可由 ``decide`` 传入复用（避免重复读取落子序列）。
        """
        cfg = self._cfg.adaptive
        if human_moves is None:
            human_moves = await self._human_moves(game)
        human_moves = human_moves[-cfg.window :]
        if not human_moves:
            return None
        # 单手 Score Loss 需局面 move_no-1 的分析 → 一次性批量读取所需局面
        needed = {int(m["move_no"]) - 1 for m in human_moves if int(m["move_no"]) >= 1}
        analyses: dict[int, dict] = {}
        if needed:
            for row in await repos.list_analyses_for_game(self._conn, game["id"]):
                key = row["position_key"]
                if not key.startswith("main:"):
                    continue
                try:
                    n = int(key.split(":", 1)[1])
                except (ValueError, IndexError):
                    continue
                if n in needed:
                    analyses[n] = json.loads(row["data_json"])
        losses: list[float] = []
        for m in human_moves:
            move_no = int(m["move_no"])
            prev_data = analyses.get(move_no - 1)
            if prev_data is None:
                continue
            loss = _score_loss_from_data(prev_data, m)
            if loss is not None:
                losses.append(loss)
        if not losses:
            return None
        return sum(losses) / len(losses)


def _score_loss_from_data(data: dict, played: dict) -> Optional[float]:
    """单手 Score Loss（纯函数，M-5）：落子方视角 best - played（黑方 scoreLead，ISSUE-050）。

    局面 N-1 处 moveInfos 的 scoreLead 为黑方视角：黑方落子取候选最大值、
    白方落子（人类视角=-scoreLead）取黑方最小值，loss = best - played（白方
    恒 ≥0：played - min）。
    """
    infos = data.get("moveInfos") or []
    if not infos:
        return None
    if played.get("is_pass") or played.get("x") is None or played.get("y") is None:
        played_key = "pass"
    else:
        played_key = xy_to_gtp(
            int(played["x"]), int(played["y"]), board_size=data_board_size(data)
        )
    is_black = played.get("color") == "B"
    best: Optional[float] = None
    played_score: Optional[float] = None
    for info in infos:
        sl = info.get("scoreLead")
        if sl is None:
            continue
        if best is None or (float(sl) > best if is_black else float(sl) < best):
            best = float(sl)
        if info.get("move") == played_key:
            played_score = float(sl)
    if best is None or played_score is None:
        return None
    loss = (best - played_score) if is_black else (played_score - best)
    return loss
