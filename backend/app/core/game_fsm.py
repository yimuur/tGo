"""对局流转 FSM（ARCHITECTURE §3.5，TASK T3.1，AGENTS.md §3）。

状态集合: ``CREATED / PLAYING / SCORING / FINISHED``（与 ``games.status`` 一一映射，
DATABASE §3.2）；人机 ``PLAYING`` 内含 ``TURN_HUMAN / TURN_AI`` 子状态
（人人对弈仅 ``TURN_HUMAN``，ARCHITECTURE §3.5）。

合法操作矩阵：

| 操作 | 允许状态 | 目标状态 |
| --- | --- | --- |
| start（开局就绪） | CREATED | PLAYING |
| play / pass / undo（落子/PASS/悔棋） | PLAYING | PLAYING |
| resign / enter_scoring（认输/双 PASS/无子可下） | PLAYING | SCORING |
| confirm_scoring / cancel_scoring（结算确认/取消） | SCORING | FINISHED / PLAYING |
| restart（重开） | PLAYING | CREATED |
| rematch（再来一局） | FINISHED | CREATED |
| restore（断点恢复） | CREATED/PLAYING/SCORING | PLAYING |

非法状态下的操作直接抛 ``AppError``（ARCHITECTURE §3.5）：
- 当前 ``FINISHED`` → ``GAME_FINISHED``；当前 ``SCORING`` → ``GAME_IN_SCORING``；
- 其他非法 → ``ILLEGAL_ACTION``。

> 双 PASS 触发终局、悔棋级联清理等业务逻辑由 ``game_service`` 实现，
> FSM 仅负责状态合法性（与引擎 FSM 分离，单职责）。
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from app.core.errors import AppError, ErrorCode


#: DB status 一一映射（DATABASE §3.2）。
#: 注：置于模块级——Python 3.14 起枚举类内单下划线前缀属性亦会成为枚举成员。
GAME_DB_STATUS: dict[str, str] = {
    "CREATED": "created",
    "PLAYING": "active",
    "SCORING": "scoring",
    "FINISHED": "finished",
}


class GameState(str, Enum):
    """对局流转状态（与 games.status 一一映射）。"""

    CREATED = "CREATED"
    PLAYING = "PLAYING"
    SCORING = "SCORING"
    FINISHED = "FINISHED"

    def to_db(self) -> str:
        """FSM 状态 → games.status。"""
        return GAME_DB_STATUS[self.value]

    @classmethod
    def from_db(cls, status: str) -> "GameState":
        """games.status → FSM 状态。"""
        for state, db in GAME_DB_STATUS.items():
            if db == status:
                return cls(state)
        raise ValueError(f"非法 DB 状态: {status!r}")


class GameTurn(str, Enum):
    """人机对弈 PLAYING 内子状态（人人对弈仅 TURN_HUMAN）。"""

    TURN_HUMAN = "TURN_HUMAN"
    TURN_AI = "TURN_AI"


class GameFsm:
    """对局流转状态机（与引擎 FSM 分离，单实例由对局生命周期持有）。"""

    def __init__(self, state: GameState = GameState.CREATED) -> None:
        self._state = state
        self._turn: Optional[GameTurn] = None

    # ---- 查询 ----

    @property
    def state(self) -> GameState:
        return self._state

    @property
    def turn(self) -> Optional[GameTurn]:
        """人机 PLAYING 内子状态（None=人人/非 PLAYING）。"""
        return self._turn

    def require(self, *allowed: GameState, action: str = "操作") -> None:
        """越权保护：当前状态不在允许集合内即抛 AppError。"""
        if self._state not in allowed:
            raise self._illegal(action)

    def _illegal(self, action: str) -> AppError:
        """按当前状态推导统一错误码（API §2）。"""
        if self._state is GameState.FINISHED:
            return AppError(ErrorCode.GAME_FINISHED, "对局已结束")
        if self._state is GameState.SCORING:
            return AppError(ErrorCode.GAME_IN_SCORING, "对局结算中，无法执行该操作")
        return AppError(ErrorCode.ILLEGAL_ACTION, f"当前状态({self._state.value})不允许 {action}")

    # ---- 转移 ----

    def start(self) -> None:
        """开局就绪：CREATED → PLAYING（人机: 引擎可用；人人: 双方就绪）。"""
        self.require(GameState.CREATED, action="开局")
        self._state = GameState.PLAYING

    def play(self) -> None:
        """落子：PLAYING → PLAYING。"""
        self.require(GameState.PLAYING, action="落子")

    def pass_move(self) -> None:
        """PASS：PLAYING → PLAYING。"""
        self.require(GameState.PLAYING, action="PASS")

    def undo(self) -> None:
        """悔棋：PLAYING → PLAYING。"""
        self.require(GameState.PLAYING, action="悔棋")

    def resign(self) -> None:
        """认输：PLAYING → SCORING（即时终局，跳过死子确认）。"""
        self.require(GameState.PLAYING, action="认输")
        self._state = GameState.SCORING

    def enter_scoring(self) -> None:
        """结算流转：PLAYING → SCORING（双 PASS / 无子可下）。"""
        self.require(GameState.PLAYING, action="进入结算")
        self._state = GameState.SCORING

    def confirm_scoring(self) -> None:
        """结算确认：SCORING → FINISHED（死子确认 + 数子结算完成）。"""
        self.require(GameState.SCORING, action="结算确认")
        self._state = GameState.FINISHED

    def cancel_scoring(self) -> None:
        """结算取消：SCORING → PLAYING（继续对弈）。"""
        self.require(GameState.SCORING, action="结算取消")
        self._state = GameState.PLAYING

    def restart(self) -> None:
        """重开（同参数重置）：PLAYING → CREATED。"""
        self.require(GameState.PLAYING, action="重开")
        self._state = GameState.CREATED

    def rematch(self) -> None:
        """再来一局：FINISHED → CREATED。"""
        self.require(GameState.FINISHED, action="再来一局")
        self._state = GameState.CREATED

    def restore(self) -> None:
        """断点恢复：强制置入 PLAYING（服务端唯一事实源；已结束对局拒绝）。"""
        self.require(
            GameState.CREATED, GameState.PLAYING, GameState.SCORING, action="断点恢复"
        )
        self._state = GameState.PLAYING

    # ---- 子状态 ----

    def set_turn(self, turn: GameTurn) -> None:
        """人机 PLAYING 内子状态：TURN_HUMAN / TURN_AI。"""
        self.require(GameState.PLAYING, action="设置回合")
        self._turn = turn

    def clear_turn(self) -> None:
        """清除回合子状态（退出 PLAYING 时调用）。"""
        self._turn = None

    # ---- 便捷判断 ----

    @property
    def is_playing(self) -> bool:
        return self._state is GameState.PLAYING

    @property
    def is_finished(self) -> bool:
        return self._state is GameState.FINISHED

    def to_dict(self) -> dict:
        """状态快照（前端映射用）。"""
        return {
            "state": self._state.value,
            "turn": self._turn.value if self._turn is not None else None,
        }

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return f"<GameFsm state={self._state.value} turn={self._turn}>"
