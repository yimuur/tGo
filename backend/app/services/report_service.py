"""分析报告（TASK T3.11，PRD §4.2.5，LEVEL.md 指标定义）。

按需计算，读持久化 ``position_analyses``（引擎无关）；数据不完整抛
``ANALYSIS_INCOMPLETE``（前端隐藏报告入口）。

指标（LEVEL.md，全部针对**指定视角**玩家；阈值/带位全部来自 ``config.report``，
禁止硬编码）：
- **AI 吻合度（Top-N Match Rate）**：玩家落子命中 KataGo 前 N 选点的百分比
  （命中口径与点评 ``hit_top`` 同源，默认 Top3）；
- **平均目数损失（Mean Score Loss）**：每手 ``ΔS`` 均值取负（均损 = -mean(ΔS)，
  ``ΔS`` 为**目数变化**：好手为正、恶手为负，可负=优于预判）；
- **落子质量（点评分布）**：按 妙着/正着/缓着/失误/败着 分类（命中 AI 选点优先 +
  \u0394W/\u0394S 阈值带，详见 ``classify_move``）；
- **胜负手（Turning Points）**：目数变化幅度最大（|ΔS| 最大，胜手/负手并存）的若干手；
- **棋力评估标签**：按平均目损 + 吻合度综合评级映射（评级带表）。

视角约定（ISSUE-050，2026/09/05 引擎级 ``reportAnalysisWinratesAs=BLACK``）：
引擎输出的 ``winrate``/``scoreLead`` 均统一为**黑方视角**（存储 0..1 / 目数）;
本服务按指定视角换算：黑方玩家直接使用；白方玩家取 ``1 - winrate`` / ``-scoreLead``，
单手 ΔW/ΔS 恒为**落子方视角**相对量（相对量视角无关，见 ``move_delta_winrate``）。

单手口径（2026/09/11 人工确认）：ΔW/ΔS = **本手落子前后两个局面**（``main:{N-1}``
与 ``main:{N}``）标准分析 root 之差，不再依赖候选 ``moveInfos``（旧实现落点不在
``play.max_moves`` 候选内时指标缺失，缺失又被按 0 计入分布 → 全部误判妙着）。
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from app.config import AppConfig, QualityBandConfig, RatingBandConfig
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.engine.coords import data_board_size, xy_to_gtp
from app.services.chain_precision import chain_visits

logger = logging.getLogger(__name__)

#: 点评五档英文 key（与前端 GRADE_TEXT 一致；``config.report.quality_bands`` 从最差到最佳）。
#: 单一事实源：report 胜负手/落子质量与 review 点评共用（review_service 自本模块导入）。
GRADE_KEYS = ("blunder", "mistake", "slow", "good", "brilliant")


def grade_key(bands: list[QualityBandConfig], label: str) -> Optional[str]:
    """点评带 label（中文，如 败着）→ 五档英文 key（blunder..brilliant）；未知带 → None。"""
    idx = next((i for i, b in enumerate(bands) if b.label == label), None)
    if idx is None or idx >= len(GRADE_KEYS):
        return None
    return GRADE_KEYS[idx]


def classify_move(
    delta_w: float,
    score_delta: float,
    bands: list[QualityBandConfig],
    *,
    hit_first: bool = False,
    hit_top: bool = False,
) -> str:
    """按点评分类带分类单手（2026/09/11 口径：ΔS=目数变化，好手为正）。

    - ``bands`` 从最差到最佳；最后一带为兜底（最佳，如 妙着）；
    - 数值条件（未命中时）：非兜底带任一条件命中（\u0394W≤阈值 或 \u0394S≤阈值）归入；
      ``both=True`` 带（正着）两条件均需满足（\u0394W<阈值 且 \u0394S<阈值，即“极微小损失”）；
    - **命中 AI 选点优先**（2026/09/11 人工确认）：命中第一选点 → 妙着（兜底带）；
      命中前 N 选点（``report.top_n``，默认 Top3）→ **至少正着**（把缓着/失误/败着
      上抬为正着，妙着不变）；命中判定见 ``move_hit_rank``（落子前局面标准分析）。
    """
    if not bands:
        raise ValueError("quality_bands 不能为空")
    label: Optional[str] = None
    for band in bands[:-1]:
        if band.both:
            if delta_w < band.winrate_delta and score_delta < band.score_delta:
                label = band.label
                break
        elif delta_w <= band.winrate_delta or score_delta <= band.score_delta:
            label = band.label
            break
    if label is None:
        label = bands[-1].label
    if hit_first:
        return bands[-1].label
    if hit_top and len(bands) >= 2 and label not in (bands[-1].label, bands[-2].label):
        return bands[-2].label
    return label


def rating_label(
    mean_loss: float,
    match_rate: float,
    ratings: list[RatingBandConfig],
) -> dict:
    """棋力评估标签（评级带表，从强到弱；平均目损 ≤ 且 吻合度 ≥ 同时满足命中）。"""
    if not ratings:
        raise ValueError("ratings 不能为空")
    for band in ratings:
        if mean_loss <= band.mean_loss and match_rate >= band.match_rate:
            return {"label": band.label, "description": band.description}
    last = ratings[-1]
    return {"label": last.label, "description": last.description}


# ============================================================
# 单手指标（模块级纯函数：report 与 review 点评共用，T6.8）
# ============================================================


def move_key(move: dict, *, board_size: int = 19) -> Optional[str]:
    """落子记录 → 分析候选 move 键（GTP / pass；按盘大小换算，ISSUE-056）。"""
    if move.get("is_pass"):
        return "pass"
    try:
        return xy_to_gtp(
            int(move["x"]), int(move["y"]), board_size=board_size
        )
    except (ValueError, TypeError):
        return None


def _mover_sign(color: Optional[str]) -> float:
    """落子方符号：黑 +1 / 白 −1（黑方视角存储 → 落子方视角换算）。"""
    return -1.0 if color == "W" else 1.0


def root_winrate_score(data: dict) -> tuple[Optional[float], Optional[float]]:
    """局面分析 root → (winrate 0..1 黑方视角, scoreLead 目 黑方视角)。"""
    root = (data or {}).get("rootInfo") or {}
    winrate = root.get("winrate")
    score = root.get("scoreLead")
    return (
        float(winrate) if winrate is not None else None,
        float(score) if score is not None else None,
    )


def move_delta_winrate(prev_data: dict, cur_data: dict, color: Optional[str]) -> Optional[float]:
    """本手 ΔW（0..1，**落子方视角**）= 落子前后两个局面 root 胜率之差 × 落子方符号。

    - 口径（2026/09/11 人工确认）：AI 评价 = 本手落子前后两个局面的标准分析之差
      （不依赖候选 ``moveInfos``，故不受 ``play.max_moves`` 截断影响）；
    - 两个局面任一缺 root winrate → None（数据不足，不计入统计）；
    - 黑 +1 / 白 −1（白棋走好会压低黑方 winrate，取反后为正）；负=劣于预判。
    """
    prev_w, _ = root_winrate_score(prev_data)
    cur_w, _ = root_winrate_score(cur_data)
    if prev_w is None or cur_w is None:
        return None
    return round((cur_w - prev_w) * _mover_sign(color), 3)


def move_score_delta(prev_data: dict, cur_data: dict, color: Optional[str]) -> Optional[float]:
    """本手 ΔS（目，**落子方视角**）=（落子后 root 目差 − 落子前 root 目差）× 落子方符号。

    - 口径（2026/09/11 人工确认）：ΔS 为**目数变化**（非“目数损失”）——恶手为负、
      好手为正（与 ΔW 同向）；即“本手实际造成的预期目数变化”；
    - 两个局面任一缺 root scoreLead → None。
    """
    _, prev_s = root_winrate_score(prev_data)
    _, cur_s = root_winrate_score(cur_data)
    if prev_s is None or cur_s is None:
        return None
    return round((cur_s - prev_s) * _mover_sign(color), 3)


def move_hit_rank(data: dict, move: dict) -> Optional[int]:
    """实际落子在**落子前局面标准分析**候选中的名次（0=第一选点；未命中/无数据 → None）。

    - 候选来源：``main:{N-1}``（试下为会话缓存对应键）预处理后的 ``moveInfos``
      （已按 ``play.max_moves`` 截断）；
    - 命中口径（2026/09/11 人工确认）：名次 < ``report.top_n``（默认 Top3）＝命中
      AI 选点（正着）；名次 = 0 ＝命中第一选点（妙着）。
    """
    played = move_key(move, board_size=data_board_size(data))
    if played is None:
        return None
    infos = data.get("moveInfos") or []
    for idx, info in enumerate(infos):
        if info.get("move") == played:
            return idx
    return None


class ReportService:
    """分析报告服务（按需计算）。"""

    def __init__(self, conn, config: AppConfig) -> None:
        self._conn = conn
        self._cfg = config

    def update_config(self, cfg: AppConfig) -> None:
        """运行期配置热更新（H-1）：刷新报告指标使用的配置引用。"""
        self._cfg = cfg

    async def generate(self, game_id: int, *, perspective: str = "B") -> dict:
        """生成分析报告（黑/白视角，含人机对弈）。

        数据不完整（0..last_move_no 存在缺失局面分析）→ ``ANALYSIS_INCOMPLETE``。
        """
        if perspective not in ("B", "W"):
            raise AppError(ErrorCode.INVALID_PAYLOAD, "报告视角仅支持 B/W")
        game = await self._require_game(game_id)
        total = game["last_move_no"]

        # 收集全部局面分析（M-5：单次批量读取，避免逐手 N+1 查询）
        analyses: dict[int, dict] = {}
        for row in await repos.list_analyses_for_game(self._conn, game_id):
            key = row["position_key"]
            if not key.startswith("main:"):
                continue
            try:
                analyses[int(key.split(":", 1)[1])] = json.loads(row["data_json"])
            except (ValueError, IndexError):
                continue
        for move_no in range(0, total + 1):
            if move_no not in analyses:
                raise AppError(ErrorCode.ANALYSIS_INCOMPLETE, "分析数据不完整，无法生成报告")

        moves = await repos.list_moves(self._conn, game_id)
        player_moves = [m for m in moves if m["color"] == perspective]
        player_name = game["black_name"] if perspective == "B" else game["white_name"]
        player_rank = game["black_rank"] if perspective == "B" else game["white_rank"]

        # 逐手指标（双局面差：main:{N-1} 与 main:{N} root 之差，落子方视角；
        # 命中名次取自落子前局面标准分析候选——点评“命中 AI 选点”唯一口径）
        move_metrics: list[dict] = []
        top_n = self._cfg.report.top_n
        for m in player_moves:
            move_no = int(m["move_no"])
            before_analysis = analyses[move_no - 1]
            after_analysis = analyses[move_no]
            delta_w = move_delta_winrate(before_analysis, after_analysis, m.get("color"))
            score_delta = move_score_delta(before_analysis, after_analysis, m.get("color"))
            rank = move_hit_rank(before_analysis, m)
            move_metrics.append(
                {
                    "move_no": move_no,
                    "color": perspective,
                    "delta_winrate": delta_w,
                    "score_delta": score_delta,
                    "top_n": rank is not None and rank < top_n,
                    "hit_first": rank == 0,
                }
            )

        if not move_metrics:
            # 无该视角落子（初始局面/无棋谱）→ 数据不完整
            raise AppError(ErrorCode.ANALYSIS_INCOMPLETE, "无该视角落子记录")

        report_cfg = self._cfg.report

        # 聚合指标
        matches = sum(1 for mm in move_metrics if mm["top_n"])
        match_rate = matches / len(move_metrics)
        deltas = [mm["score_delta"] for mm in move_metrics if mm["score_delta"] is not None]
        # 均损恒为“损失”口径：均损 = -mean(ΔS)（ΔS=目数变化，好手为正、恶手为负）
        mean_loss = round(-sum(deltas) / len(deltas), 3) if deltas else None

        quality_labels = [band.label for band in report_cfg.quality_bands]
        quality_counts = {label: 0 for label in quality_labels}
        for mm in move_metrics:
            # 指标缺失（老数据无 root）不计入分布（旧实现按 0 计入 → 误判妙着）
            if mm["delta_winrate"] is None and mm["score_delta"] is None:
                continue
            delta_w = mm["delta_winrate"] if mm["delta_winrate"] is not None else 0.0
            score_delta = mm["score_delta"] if mm["score_delta"] is not None else 0.0
            quality_counts[
                classify_move(
                    delta_w,
                    score_delta,
                    report_cfg.quality_bands,
                    hit_first=mm["hit_first"],
                    hit_top=mm["top_n"],
                )
            ] += 1

        turning_points = self._turning_points(move_metrics)
        rating = rating_label(
            mean_loss if mean_loss is not None else 99.0,
            match_rate,
            report_cfg.ratings,
        )

        return {
            "game_id": game_id,
            "perspective": perspective,
            "player_name": player_name,
            "player_rank": player_rank,
            # 本局链精度（2026/09/15 人工反馈：报告头部主题色徽章展示；
            # 口径同 main:{n} 链行——“已冻结取冻结值，老局按当前配置派生“）
            "chain_visits": chain_visits(self._cfg, game),
            "total_moves": total,
            "player_move_count": len(move_metrics),
            "top_n": top_n,                     # 吻合度 Top-N / 点评“命中 AI 选点（正着）”口径（同一配置）
            "match_rate": round(match_rate, 3),
            "top_n_hits": matches,
            "mean_score_loss": mean_loss,
            "move_quality": quality_counts,
            "turning_points": turning_points,
            "rating": rating,
        }

    # ---- 共享辅助 ----

    async def _require_game(self, game_id: int) -> dict:
        game = await repos.get_game(self._conn, game_id)
        if game is None:
            raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
        return game

    def _turning_points(self, move_metrics: list[dict]) -> list[dict]:
        """胜负手：按 **|ΔS|（目数变化幅度）降序**取 `count_min..count_max` 手。

        ΔS 为**目数变化**（好手为正、恶手为负）——|ΔS| 大者即决定胜负的关键手，
        **正负不限**（胜手与负手并存；2026/10/10 人工确认）。旧实现按 ΔS **升序**
        （只取最差手）补齐 → 报告恒只列出恶手，好手永不入选（实战单手 |ΔW| 极少
        超过 15%，`strong` 恒为空）；现行口径为**双侧幅度**排序。

        ΔS 缺失（老数据无 root scoreLead）的手按 |ΔW| 降序排在末尾补齐，
        仍受 ``turning_point_winrate_delta`` 约束（小于阈值不纳入）。
        """
        cfg = self._cfg.report
        by_magnitude = sorted(
            [mm for mm in move_metrics if mm["score_delta"] is not None],
            key=lambda mm: abs(mm["score_delta"]),
            reverse=True,
        )
        by_winrate = sorted(
            [
                mm
                for mm in move_metrics
                if mm["score_delta"] is None
                and mm["delta_winrate"] is not None
                and abs(mm["delta_winrate"]) > cfg.turning_point_winrate_delta
            ],
            key=lambda mm: abs(mm["delta_winrate"]),
            reverse=True,
        )
        # 合并去重（按 move_no）：双侧幅度排序，先 ΔS、后 ΔW 兜底；返回 [min, max] 手
        # （M-9：落实 turning_point_count_min —— 候选足够时至少返回 min 手）
        seen: set[int] = set()
        result: list[dict] = []

        def _append(mm: dict) -> None:
            seen.add(mm["move_no"])
            # 与落子质量分布同口径分类（缺失指标按 0 兜底），附五档英文 grade 供前端标签/配色；
            # ΔW 输出百分比（round 2，与 review 点评/API §3.1 报告字段口径一致）
            delta_w = mm["delta_winrate"] if mm["delta_winrate"] is not None else 0.0
            score_delta = mm["score_delta"] if mm["score_delta"] is not None else 0.0
            bands = self._cfg.report.quality_bands
            result.append(
                {
                    "move_no": mm["move_no"],
                    "delta_winrate": (
                        round(mm["delta_winrate"] * 100.0, 2)
                        if mm["delta_winrate"] is not None
                        else None
                    ),
                    "score_delta": mm["score_delta"],
                    "grade": grade_key(
                        bands,
                        classify_move(
                            delta_w,
                            score_delta,
                            bands,
                            hit_first=bool(mm.get("hit_first")),
                            hit_top=bool(mm.get("top_n")),
                        ),
                    )
                    if bands
                    else None,
                }
            )

        for mm in by_magnitude + by_winrate:
            if mm["move_no"] in seen:
                continue
            _append(mm)
            if len(result) >= cfg.turning_point_count_max:
                break
        return result[: cfg.turning_point_count_max]

