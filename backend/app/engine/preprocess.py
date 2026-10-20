"""Analysis 响应预处理（DATABASE §3.4.1 / PRD §4.4）。

落盘或下发前端前统一：
- **字段瘦身**：仅保留业务所需字段（保留字段表），冗余/无用字段剔除；
- **候选点截断**：`moveInfos` 截断至 `maxMoves`（config.yaml，默认 5）；
- **PV 截断**：按 `analysisPVLen` 截断；
- **浮点舍入**：scoreLead / winrate / ownership 等 3 位小数；
- **健壮性**：对未知字段（KataGo 版本演进新增）保持忽略，不崩溃。
"""

from __future__ import annotations

from typing import Any, Optional

#: 根级保留字段（DATABASE §3.4.1）
_ROOT_KEEP = ("id", "turnNumber")
#: rootInfo 保留字段
_ROOT_INFO_KEEP = (
    "currentPlayer",
    "winrate",
    "scoreLead",
    "scoreSelfplay",
    "scoreStdev",
    "visits",
    "utility",
    "lcb",
)
#: moveInfos[] 每候选保留字段
_MOVE_INFO_KEEP = (
    "move",
    "order",
    "visits",
    "edgeVisits",
    "winrate",
    "scoreLead",
    "scoreSelfplay",
    "scoreStdev",
    "prior",
    "humanPrior",
    "utility",
    "lcb",
    "pv",
)


def _round3(value: Any) -> Any:
    """浮点 3 位舍入；非浮点原样返回（visits/order 等整数不处理）。"""
    if isinstance(value, float):
        return round(value, 3)
    return value


def preprocess_analysis_response(
    raw: dict,
    *,
    max_moves: int,
    analysis_pv_len: int,
    board_size: Optional[int] = None,
) -> dict:
    """字段瘦身 + 候选点截断 + PV 截断 + 浮点 3 位舍入。

    注入顶层 ``board_size``（ISSUE-056）：供下游把落子/候选/变化图按盘面换算 GTP。
    """
    result: dict = {}
    if board_size is not None:
        result["board_size"] = int(board_size)
    for key in _ROOT_KEEP:
        if key in raw:
            result[key] = raw[key]

    root_info = raw.get("rootInfo")
    if isinstance(root_info, dict):
        result["rootInfo"] = {
            k: _round3(v) for k, v in root_info.items() if k in _ROOT_INFO_KEEP
        }

    move_infos = raw.get("moveInfos")
    if isinstance(move_infos, list):
        result["moveInfos"] = [
            _slim_move_info(info, analysis_pv_len) for info in move_infos[:max_moves]
        ]

    ownership = raw.get("ownership")
    if isinstance(ownership, list):
        result["ownership"] = [round(float(v), 3) for v in ownership]
    return result


def _slim_move_info(info: dict, pv_len: int) -> dict:
    slim = {k: _round3(v) for k, v in info.items() if k in _MOVE_INFO_KEEP}
    pv = info.get("pv")
    if isinstance(pv, list):
        slim["pv"] = pv[:pv_len]
    return slim
