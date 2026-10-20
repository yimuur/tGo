"""T3.1 GameFlow FSM 测试（TASK T3.1 / ARCHITECTURE §3.5 / AGENTS.md §7 FSM 负面测试）。

用例 ID: GFSM-*
- 合法操作矩阵全覆盖：落子/PASS/悔棋/认输仅 PLAYING；结算确认仅 SCORING；
  重开仅 PLAYING；再来一局仅 FINISHED；
- 非法状态操作拒绝（错误码语义：FINISHED→GAME_FINISHED / SCORING→GAME_IN_SCORING /
  其他→ILLEGAL_ACTION）；
- 人机 PLAYING 内 TURN_HUMAN/TURN_AI 子状态；
- DB status 一一映射（DATABASE §3.2）。
"""

import pytest

from app.core.errors import AppError, ErrorCode
from app.core.game_fsm import GameFsm, GameState, GameTurn


def _playing() -> GameFsm:
    """构造一个处于 PLAYING 的 FSM。"""
    fsm = GameFsm()
    fsm.start()
    return fsm


class TestInitialAndMapping:
    """初始状态与 DB 映射。"""

    def test_initial_is_created(self):
        assert GameFsm().state is GameState.CREATED

    def test_db_mapping_roundtrip(self):
        pairs = [
            (GameState.CREATED, "created"),
            (GameState.PLAYING, "active"),
            (GameState.SCORING, "scoring"),
            (GameState.FINISHED, "finished"),
        ]
        for state, db in pairs:
            assert state.to_db() == db
            assert GameState.from_db(db) is state

    def test_from_db_invalid_raises(self):
        with pytest.raises(ValueError):
            GameState.from_db("bogus")

    def test_to_dict_snapshot(self):
        fsm = _playing()
        fsm.set_turn(GameTurn.TURN_HUMAN)
        snap = fsm.to_dict()
        assert snap["state"] == "PLAYING"
        assert snap["turn"] == "TURN_HUMAN"


class TestStart:
    """开局就绪 CREATED→PLAYING。"""

    def test_start_goes_playing(self):
        fsm = GameFsm()
        fsm.start()
        assert fsm.state is GameState.PLAYING

    def test_start_twice_rejected(self):
        fsm = _playing()
        with pytest.raises(AppError) as ei:
            fsm.start()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_start_from_scoring_rejected(self):
        fsm = _playing()
        fsm.enter_scoring()
        with pytest.raises(AppError) as ei:
            fsm.start()
        assert ei.value.code is ErrorCode.GAME_IN_SCORING


class TestPlayPassUndo:
    """落子/PASS/悔棋仅 PLAYING。"""

    def test_play_in_created_rejected(self):
        with pytest.raises(AppError) as ei:
            GameFsm().play()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_play_in_playing_ok(self):
        _playing().play()

    def test_play_in_scoring_rejected(self):
        fsm = _playing()
        fsm.enter_scoring()
        with pytest.raises(AppError) as ei:
            fsm.play()
        assert ei.value.code is ErrorCode.GAME_IN_SCORING

    def test_play_in_finished_rejected(self):
        fsm = _playing()
        fsm.enter_scoring()
        fsm.confirm_scoring()
        with pytest.raises(AppError) as ei:
            fsm.play()
        assert ei.value.code is ErrorCode.GAME_FINISHED

    def test_pass_in_playing_ok(self):
        _playing().pass_move()

    def test_pass_in_scoring_rejected(self):
        fsm = _playing()
        fsm.enter_scoring()
        with pytest.raises(AppError) as ei:
            fsm.pass_move()
        assert ei.value.code is ErrorCode.GAME_IN_SCORING

    def test_undo_in_playing_ok(self):
        _playing().undo()

    def test_undo_in_created_rejected(self):
        with pytest.raises(AppError) as ei:
            GameFsm().undo()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_undo_in_finished_rejected(self):
        fsm = _playing()
        fsm.enter_scoring()
        fsm.confirm_scoring()
        with pytest.raises(AppError) as ei:
            fsm.undo()
        assert ei.value.code is ErrorCode.GAME_FINISHED


class TestResignAndScoring:
    """认输/结算流转。"""

    def test_resign_goes_scoring(self):
        fsm = _playing()
        fsm.resign()
        assert fsm.state is GameState.SCORING

    def test_resign_in_created_rejected(self):
        with pytest.raises(AppError) as ei:
            GameFsm().resign()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_enter_scoring_from_playing(self):
        fsm = _playing()
        fsm.enter_scoring()
        assert fsm.state is GameState.SCORING

    def test_confirm_scoring_in_playing_rejected(self):
        with pytest.raises(AppError) as ei:
            _playing().confirm_scoring()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_confirm_scoring_finishes(self):
        fsm = _playing()
        fsm.enter_scoring()
        fsm.confirm_scoring()
        assert fsm.state is GameState.FINISHED

    def test_cancel_scoring_back_to_playing(self):
        fsm = _playing()
        fsm.enter_scoring()
        fsm.cancel_scoring()
        assert fsm.state is GameState.PLAYING

    def test_cancel_scoring_in_playing_rejected(self):
        with pytest.raises(AppError) as ei:
            _playing().cancel_scoring()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION


class TestRestartRematchRestore:
    """重开/再来一局/断点恢复。"""

    def test_restart_back_to_created(self):
        fsm = _playing()
        fsm.restart()
        assert fsm.state is GameState.CREATED

    def test_restart_in_created_rejected(self):
        with pytest.raises(AppError) as ei:
            GameFsm().restart()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_rematch_from_finished(self):
        fsm = _playing()
        fsm.enter_scoring()
        fsm.confirm_scoring()
        fsm.rematch()
        assert fsm.state is GameState.CREATED

    def test_rematch_not_from_playing(self):
        with pytest.raises(AppError) as ei:
            _playing().rematch()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_rematch_not_from_created(self):
        with pytest.raises(AppError) as ei:
            GameFsm().rematch()
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_restore_forces_playing(self):
        for fsm in (GameFsm(), _playing()):
            fsm.restore()
            assert fsm.state is GameState.PLAYING

    def test_restore_from_scoring(self):
        fsm = _playing()
        fsm.enter_scoring()
        fsm.restore()
        assert fsm.state is GameState.PLAYING

    def test_restore_rejects_finished(self):
        fsm = _playing()
        fsm.enter_scoring()
        fsm.confirm_scoring()
        with pytest.raises(AppError) as ei:
            fsm.restore()
        assert ei.value.code is ErrorCode.GAME_FINISHED


class TestTurnSubstate:
    """人机 PLAYING 内 TURN_HUMAN/TURN_AI 子状态。"""

    def test_set_turn_human(self):
        fsm = _playing()
        fsm.set_turn(GameTurn.TURN_HUMAN)
        assert fsm.turn is GameTurn.TURN_HUMAN

    def test_set_turn_ai(self):
        fsm = _playing()
        fsm.set_turn(GameTurn.TURN_AI)
        assert fsm.turn is GameTurn.TURN_AI

    def test_set_turn_not_in_playing_rejected(self):
        with pytest.raises(AppError) as ei:
            GameFsm().set_turn(GameTurn.TURN_HUMAN)
        assert ei.value.code is ErrorCode.ILLEGAL_ACTION

    def test_set_turn_in_scoring_rejected(self):
        fsm = _playing()
        fsm.enter_scoring()
        with pytest.raises(AppError) as ei:
            fsm.set_turn(GameTurn.TURN_HUMAN)
        assert ei.value.code is ErrorCode.GAME_IN_SCORING

    def test_clear_turn(self):
        fsm = _playing()
        fsm.set_turn(GameTurn.TURN_AI)
        fsm.clear_turn()
        assert fsm.turn is None

    def test_initial_turn_none(self):
        assert GameFsm().turn is None


class TestConvenience:
    """便捷判断。"""

    def test_is_playing(self):
        assert _playing().is_playing is True
        assert GameFsm().is_playing is False

    def test_is_finished(self):
        fsm = _playing()
        fsm.enter_scoring()
        fsm.confirm_scoring()
        assert fsm.is_finished is True
