"""对弈查询构建 + AI 落子选取（LEVEL.md 12 级映射，ARCHITECTURE §3.4，PRD §4.1.3）。

- 构建 Analysis 对弈查询：moves / initialStones（让子编排）/ rules / komi / 棋盘规格
  + 难度参数（maxVisits 顶层 + overrideSettings 覆盖级）；
- **请求级模型选择**：携带 `humanSLProfile` → 人类网络；否则标准网络；
- **AI 落子选取**：按 `chosenMoveTemperature` 对候选点加权采样（后端实现，
  还原 GTP `chooseIndexWithTemperature()`，searchhelpers.cpp）；
- **低档位策略回退**（2026/09/10 人工决策，见 `select_move_from_policy`）：
  `maxVisits=1` 档位（人类 L1-L4 / 标准 L1-L2）搜索只访问根、响应 `moveInfos`
  为空 → 回退到根策略（人类风格 `humanPolicy` / 标准 `policy`）温度采样，
  与 GTP `getPlaySelectionValues()`（无子节点 → `policyProbs`）语义一致。

> 注（ISSUE-037 已确认，依据 KataGo 源码）：
> - Analysis 查询**顶层**仅解析 `maxVisits`/`analysisPVLen`/`rootPolicyTemperature`/
>   `rootFpuReductionMax` 等（`cpp/command/analysis.cpp` expectedKeys）；
> - `maxTime` 是 SearchParams cfg 键（`cpp/program/setup.cpp` loadParams 读取），
>   经 **`overrideSettings.maxTime`** 随查询下发即可生效（覆盖 config 后 loadParams 生效）；
> - `chosenMoveTemperature` 同为 cfg 键，但仅用于**落子选择**（GTP genmove），
>   Analysis 引擎不落子 → **对分析结果无效果**，故不随查询下发，仅作后端采样参数；
> - 人类风格查询须携带 **`includePolicy=true`**（Analysis_Engine.md "Human SL Analysis
>   Guide"），否则响应不含 `humanPolicy`；标准查询同样携带以便低档位回退采样。
"""

from __future__ import annotations

import math
import random
from typing import Iterable, Optional

from app.engine.coords import xy_to_gtp

#: 对弈查询优先级（P0，ISSUE-001 推荐值）
PRIORITY_PLAY = 100

#: 加权采样：温度 ≤ 阈值视为 argmax（searchhelpers.cpp 语义）
_TEMP_ARGMAX_THRESHOLD = 1.0e-4


def choose_index_with_temperature(
    relative_probs: list[float],
    temperature: float,
    *,
    only_below_prob: float = 1.0,
    rng: Optional[random.Random] = None,
) -> int:
    """按温度加权采样候选点（还原 `chooseIndexWithTemperature`，searchhelpers.cpp）。

    - `temperature <= 1e-4` 且 `onlyBelowProb >= 1.0` → 直接 argmax；
    - 否则对 log-相对权重做带 onlyBelowProb 阈值的温度化 softmax，按比例采样。
    """
    n = len(relative_probs)
    if n == 0:
        raise ValueError("relative_probs 为空")
    max_rel = 0.0
    sum_rel = 0.0
    for p in relative_probs:
        sum_rel += max(0.0, p)
        if p > max_rel:
            max_rel = p
    if max_rel <= 0.0 or sum_rel <= 0.0:
        raise ValueError("relative_probs 必须含正权重")

    if temperature <= _TEMP_ARGMAX_THRESHOLD and only_below_prob >= 1.0:
        return max(range(n), key=lambda i: relative_probs[i])

    log_max = math.log(max_rel)
    log_sum = math.log(sum_rel)
    log_only = math.log(max(1e-50, only_below_prob))
    processed: list[float] = []
    total = 0.0
    for p in relative_probs:
        if p <= 0.0:
            processed.append(0.0)
        else:
            log_rel = math.log(p) - log_max
            log_thresh = min(0.0, log_only + log_sum - log_max)
            new_log = (
                log_rel
                if log_rel > log_thresh
                else (log_rel - log_thresh) / temperature + log_thresh
            )
            processed.append(math.exp(new_log))
        total += processed[-1]

    r = (rng.random() if rng is not None else random.random()) * total
    cumulative = 0.0
    for i, weight in enumerate(processed):
        cumulative += weight
        if r <= cumulative:
            return i
    return n - 1


def select_ai_move(
    move_infos: list[dict],
    temperature: float,
    *,
    rng: Optional[random.Random] = None,
) -> Optional[dict]:
    """从 Analysis 响应 `moveInfos` 中按 `chosenMoveTemperature` 加权采样 AI 落子。

    - 权重取各候选 `visits`（GTP 语义），缺失/为零时回退 `prior`；
    - **无可用候选返回 None**（空列表，或全部候选权重 ≤ 0）——`maxVisits=1` 档位
      搜索只访问根、无子节点，响应 `moveInfos` 为空；调用方据此回退
      ``select_move_from_policy``（2026/09/10 人工决策）。
    """
    if not move_infos:
        return None
    weights: list[float] = []
    for info in move_infos:
        w = info.get("visits")
        if w is None or w <= 0:
            w = info.get("prior", 0.0)
        weights.append(float(w))
    if not any(w > 0.0 for w in weights):
        return None
    idx = choose_index_with_temperature(weights, temperature, rng=rng)
    return move_infos[idx]


def select_move_from_policy(
    policy: Optional[list[float]],
    temperature: float,
    *,
    board_size: int = 19,
    rng: Optional[random.Random] = None,
) -> Optional[dict]:
    """搜索无子节点时按根策略采样落子（低档位回退，GTP 语义，2026/09/10 人工决策）。

    依据（KataGo 源码 + Analysis_Engine.md Human SL 指南）：
    - `maxVisits=1` 时搜索仅访问根节点 → 响应 `moveInfos` 为空；GTP 的
      `Search::getChosenMoveLoc()` 在无子节点时正是回退到根策略
      （`searchresults.cpp::getPlaySelectionValues`：`numChildren == 0` → `policyProbs`），
      再按 `chosenMoveTemperature` 调用 `chooseIndexWithTemperature()` 采样；
    - 人类风格（含自适应）用响应 `humanPolicy`（人类模型按 `humanSLProfile` 输出；
      官方文档：仅 1 visit + 全温度按策略比例采样最接近该段位人类）；标准风格用
      响应 `policy`（对弈查询已携带 `includePolicy=true`）；
    - 策略数组长度 = `boardSize² + 1`（末位为 PASS），行主序（左上 → 右下，与
      ``coords`` 的 y 自上而下约定一致），非法点为 `-1`（权重置零剔除）。

    返回与 `moveInfos` 条目同构的候选（``move``/``visits=0``/``prior``），
    无正权重候选（缺策略数组 / 长度不匹配 / 全部非法或零）返回 None。
    """
    if not policy:
        return None
    size = int(board_size)
    # 外部边界校验（KataGo 响应）：长度必须为盘面积 + 1，不匹配不得猜测坐标映射
    if len(policy) != size * size + 1:
        return None
    pass_idx = len(policy) - 1
    moves: list[str] = []
    weights: list[float] = []
    for idx, value in enumerate(policy):
        weight = float(value)
        if weight <= 0.0:
            continue
        move = "pass" if idx == pass_idx else xy_to_gtp(
            idx % size, idx // size, board_size=size
        )
        moves.append(move)
        weights.append(weight)
    if not weights:
        return None
    chosen = choose_index_with_temperature(weights, temperature, rng=rng)
    return {"move": moves[chosen], "visits": 0, "prior": weights[chosen]}


def move_to_gtp(move: dict, *, board_size: int = 19) -> list:
    """对局落子记录 → `["B","C4"]` / `["B","pass"]`（按盘大小换算，ISSUE-056）。"""
    color = move["color"]
    if move.get("is_pass") or move.get("x") is None or move.get("y") is None:
        return [color, "pass"]
    return [color, xy_to_gtp(int(move["x"]), int(move["y"]), board_size=board_size)]


def stone_to_gtp(stone: dict, *, board_size: int = 19) -> list:
    """让子/初始石子记录 → `["B","Q16"]`（按盘大小换算）。"""
    return [stone["color"], xy_to_gtp(int(stone["x"]), int(stone["y"]), board_size=board_size)]


def build_play_query(
    *,
    board_size: int,
    rules: str,
    komi: float,
    moves: Iterable[dict],
    initial_stones: Optional[Iterable[dict]] = None,
    max_visits: int,
    wide_root_noise: Optional[float] = None,
    human_sl_profile: Optional[str] = None,
    playout_doubling_advantage: Optional[float] = None,
    max_time: Optional[float] = None,
    include_policy: Optional[bool] = None,
    analysis_pv_len: int = 10,
    include_ownership: bool = True,
) -> dict:
    """构建对弈 Analysis 查询（单查询合并：精度等于链精度时结果同时作为链行，
    见 ``services.chain_precision``；否则仅用于落子选择）。

    - `moves`/`initial_stones`: `{"color","x","y","is_pass"?}` 记录序列；
    - 请求级模型选择：携带 `human_sl_profile` → 人类网络（-human-model）；
      否则标准网络（-model）；
    - `max_time`（秒）：经 **`overrideSettings.maxTime`** 随查询下发（ISSUE-037 已确认，
      cfg 键在 analysis 引擎 overrideSettings 中生效）；None 时不携带；
    - `include_policy`：默认一律 True——人类查询取 `humanPolicy`（Analysis_Engine.md
      Human SL 指南）、标准查询取 `policy`，二者供低档位（`maxVisits=1`）无候选时
      回退策略采样（2026/09/10 人工决策；官方说明该字段「Will not significantly
      affect performance」）；可显式覆盖；
    - 查询携带 `includeOwnership=true`（领地随分析落库，PRD §4.1.4）。
    """
    override: dict = {}
    if human_sl_profile:
        override["humanSLProfile"] = human_sl_profile
    if wide_root_noise is not None:
        override["wideRootNoise"] = wide_root_noise
    if playout_doubling_advantage is not None:
        override["playoutDoublingAdvantage"] = playout_doubling_advantage
    if max_time is not None:
        override["maxTime"] = max_time

    if include_policy is None:
        include_policy = True

    query: dict = {
        "moves": [move_to_gtp(m, board_size=board_size) for m in moves],
        "rules": rules,
        "komi": komi,
        "boardXSize": board_size,
        "boardYSize": board_size,
        "maxVisits": max_visits,
        "analysisPVLen": analysis_pv_len,
        "includeOwnership": include_ownership,
        "overrideSettings": override,
        "priority": PRIORITY_PLAY,
    }
    if include_policy:
        query["includePolicy"] = True
    if initial_stones:
        query["initialStones"] = [
            stone_to_gtp(s, board_size=board_size) for s in initial_stones
        ]
    return query
