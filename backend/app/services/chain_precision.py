"""标准分析链精度策略（BUG-026 修复，2026/09/12 人工确认）。

``main:{n}`` 链与试下分支标准分析恒定使用**同一精度**（链精度 ``chain_visits``）：
差量指标（点评 ΔW/ΔS、报告落子质量/胜负手/均损）建立在「相邻局面同精度」前提上，
混精度配对（同局面 100v 与 800v 读数差可达 18–25pp，且系统性偏向高访问量一侧）
会把「访问量差」混入「棋力差」，导致获胜方全负胜率等矛盾展示（BUGS BUG-026）。

链精度规则（人工确认，本模块为唯一实现位置）：

- **链精度整局冻结**：创建对局时按当时配置与对局参数计算 ``V_chain``，写入
  ``games.chain_visits``（快照）；此后**一切配置变化（管理页调参、等级表调整、
  自适应档位漂移）均不影响进行中对局**——读取路径直接返回冻结值；
  复弈新局继承源对局冻结值（保证与批量复制的链行同精度）；
  迁移前创建的老对局（0）→ 按当前配置派生（老数据忽略，不迁移）。
- **派生规则（仅用于创建时冻结与老局回退）**：
  - 人人对弈：``engine.standard_max_visits``；
  - 人机对弈（非自适应）：``max(standard_max_visits, 该档位对弈查询 max_visits)``
    ——高难度（``V_play >= standard``）自动把标准 P1 精度提高到 ``V_play``，该局全链同精度；
  - 人机对弈（自适应）：``max(standard_max_visits, 人类模型最高段位 9D 的 max_visits)``
    ——自适应档位在对局中漂移，链精度按「可能达到的最高档位」取常量。
    自适应对局 AI 每手双查询（P0 对弈 + 链精度 P1），AI 段位匹配到 9D 时两者精度
    相等 → 合并为 P0 单查询、不再补 P1。

**单查询合并（ISSUE-051 修订）**：仅当对弈查询精度与链精度**相等**
（``V_play == chain_visits``）时，AI 查询结果才作为该局面链行落库/推送；否则
对弈查询仅用于落子选择（``V_play < chain_visits``，AI 待行局面另补链精度 P1）。
"""

from __future__ import annotations

from app.config import AppConfig

#: 深算槽/链槽判定常量（见 ``AnalysisCache`` 与 ``AnalysisService.ingest_result``）
KIND_CHAIN = "chain"
KIND_DEEP = "deep"


def chain_visits(cfg: AppConfig, game: dict) -> int:
    """对局链精度（``maxVisits``，BUG-026 唯一口径）。

    已冻结的对局（``games.chain_visits > 0``）**直接返回冻结值**——整局不随配置变化；
    未冻结（迁移前老对局/创建前的参数推导）→ 按当前配置与对局参数派生
    （见模块 docstring 派生规则）。
    """
    frozen = int(game.get("chain_visits") or 0)
    if frozen > 0:
        return frozen
    base = int(cfg.engine.standard_max_visits)
    if game.get("mode") != "human_ai":
        return base
    if bool(game.get("adaptive_enabled")):
        # 自适应：链精度按人类模型最高段位（9D / rank_9d）的 max_visits 取常量
        return max(base, max(int(lp.max_visits) for lp in cfg.levels.human))
    level = int(game.get("ai_level") or 1)
    if game.get("ai_style") == "human":
        return max(base, int(cfg.levels.human_at(level).max_visits))
    return max(base, int(cfg.levels.standard_at(level).max_visits))
