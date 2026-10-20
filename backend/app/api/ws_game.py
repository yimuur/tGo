"""WS 对弈/复盘通道（TASK T4.5，API §4.1-4.3）。

- 统一信封解析与分发（``{type, seq, data}``，Pydantic 强校验）；
- 消息处理：start（开局/续行）/play/pass/resign/undo/undo.respond（人人悔棋
  确认回复）/restart（重开）/scoring.confirm/coaching.request/ownership.request/
  deep_analysis.request/global_analysis.request/cancel/restore.request/ping；
- **人人对弈悔棋确认（T6.4 人工确认 2026/09/06）**：人机悔棋直通执行（上限
  ``config.play.max_undo``）；人人悔棋不限制次数，但需对手确认——`undo` 创建
  悔棋申请，仅向其它连接（多设备）广播 ``undo.request``，单连接热座时回投请求方
  本机；对端 ``undo.respond {request_id, accept}`` → 同意执行（``move.undone`` +
  ``game.state``）/ 拒绝或请求方撤回 → ``undo.declined``；请求方断开自动清除申请；
- 推送：game.state/move.applied/move.undone/game.finished/analysis.curve
  （200ms 节流，经 ``GameAnalysisPusher``）/position.ownership/coaching.top5/
  deep_analysis.result/analysis.progress/global_analysis.done/engine.status/error；
- 心跳与断线：30s 无消息判定断线清理；断线回收连接与曲线订阅。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.api.deps import get_services_ws
from app.api.public import to_public_game
from app.api.schemas import (
    WsDeepAnalysisRequest,
    WsEnvelope,
    WsGlobalAnalysisRequest,
    WsOwnershipRequest,
    WsPlay,
    WsRecommendRequest,
    WsScoringConfirm,
    WsTrialEnter,
    WsTrialPlay,
    WsTrialRef,
    WsUndoRespond,
)
from app.api.ws_guard import ORIGIN_REJECT_CODE, channel_already_closed, origin_allowed
from app.bootstrap import AppServices
from app.core.errors import AppError, ErrorCode
from app.db import repos
from app.services.go_rules import handicap_initial_stones

logger = logging.getLogger(__name__)

router = APIRouter()

#: 断线判定：30s 未收到任何消息（API §4.2 心跳）
RECEIVE_TIMEOUT_S = 30.0

#: 对局不存在/已删除的**终态**关闭码（应用私有段 4000–4999，API §4.2）。
#: 必须**先行 accept 再关闭**：握手前 ``close()`` 会被 uvicorn 转为 HTTP 403，
#: 浏览器 ``onclose`` 只得 1006（与断网不可区分）→ 客户端会误判「连接中断」
#: 并无限重连，且掩盖「对局不存在」这一领域事实（BUG-092）。
GAME_GONE_CLOSE_CODE = 4404

Handler = Callable[[AppServices, WebSocket, int, WsEnvelope], Awaitable[None]]


# ============================================================
# 通道入口
# ============================================================


@router.websocket("/ws/games/{game_id}")
async def ws_game(websocket: WebSocket, game_id: int) -> None:
    """对弈/复盘通道（进行中与已结束对局均可连接）。

    对局不存在/已删除：握手成功后以 ``GAME_GONE_CLOSE_CODE``（4404）**终态**关闭
    ——客户端据此停止重连并提示「对局不存在」（而非报连接中断，见常量注释）。
    """
    svc = get_services_ws(websocket)
    # T6.1：Origin/同源校验（浏览器跨源攻击防护；缺失 Origin 放行非浏览器客户端）
    if not origin_allowed(websocket):
        await websocket.close(code=ORIGIN_REJECT_CODE)
        return
    game = await repos.get_game(svc.db.conn, game_id)
    if game is None:
        # 终态拒绝（非网络异常）：accept 后才能把应用关闭码送到浏览器（BUG-092）
        await websocket.accept()
        await websocket.close(code=GAME_GONE_CLOSE_CODE)
        return
    await websocket.accept()
    await svc.session.register_game(game_id, websocket)
    if svc.pusher is not None:
        svc.pusher.subscribe(game_id)
    try:
        await _send_game_state(svc, websocket, game_id)
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_json(), timeout=RECEIVE_TIMEOUT_S)
            except asyncio.TimeoutError:
                logger.debug("WS 对局 #%d 30s 无消息，判定断线", game_id)
                break
            except RuntimeError:
                # BUG-126：推送失败已把通道置为 DISCONNECTED（对端早已断开）→ 按断线收尾；
                # 其它 RuntimeError（真实缺陷）照旧上抛给通道级兜底。
                if not channel_already_closed(websocket):
                    raise
                logger.info("WS 对局 #%d 对端已断开（推送失败后通道状态失效），收尾", game_id)
                break
            await _dispatch(svc, websocket, game_id, raw)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - 通道级兜底（不泄露 Traceback）
        logger.exception("WS 对局通道异常 · 对局 #%s", game_id)
    finally:
        await svc.session.unregister_game(game_id, websocket)
        # T6.4：请求方断开 → 清除其未决悔棋申请（防阻塞该对局后续悔棋）
        pending = svc.session.undo_request_get(game_id)
        if pending is not None and pending["requester"] is websocket:
            svc.session.undo_request_clear(game_id)
        if svc.pusher is not None and svc.session.game_conn_count(game_id) == 0:
            svc.pusher.unsubscribe(game_id)


async def _dispatch(
    svc: AppServices, websocket: WebSocket, game_id: int, raw: object
) -> None:
    """信封解析 + 分发（统一错误信封，API §4.1）。"""
    try:
        envelope = WsEnvelope.model_validate(raw)
    except ValidationError:
        # M-4（2026/09/19 修复）：非对象 JSON（null/[]/数字…）无 seq 可取——旧实现
        # ``raw.get`` 抛 AttributeError 被通道级兜底捕获，整条连接被拆除；此处退化
        # 为无 seq 的 INVALID_PAYLOAD 错误信封，通道保持存活。
        seq = raw.get("seq") if isinstance(raw, dict) else None
        await _send_error(svc, websocket, seq, ErrorCode.INVALID_PAYLOAD.value, "消息格式非法")
        return
    handler = _HANDLERS.get(envelope.type)
    if handler is None:
        # L-8b（决策 A）：防御性兜底——`WsEnvelope._type_known` 预校验下该分支不可达
        # （校验表与 `_HANDLERS` 若未来失衡时仍给出错误信封而非拆通道），保留并注明
        await _send_error(svc, websocket, envelope.seq, ErrorCode.INVALID_PAYLOAD, f"未知消息类型: {envelope.type}")
        return
    try:
        await handler(svc, websocket, game_id, envelope)
    except AppError as exc:
        await _send_error(svc, websocket, envelope.seq, exc.code.value, exc.message)
    except ValidationError:
        # 载荷 Pydantic 校验失败（如坐标越界/死子越界）
        await _send_error(
            svc, websocket, envelope.seq, ErrorCode.INVALID_PAYLOAD.value, "请求参数校验失败"
        )
    except Exception:  # noqa: BLE001 - 处理器兜底
        logger.exception("WS 消息处理失败 · 对局 #%s · 类型 %s", game_id, envelope.type)
        await _send_error(svc, websocket, envelope.seq, ErrorCode.INTERNAL_ERROR.value, "服务器内部错误")


async def _send_error(
    svc: AppServices, websocket: WebSocket, seq: Optional[int], code: str, message: str
) -> None:
    envelope: dict = {"type": "error", "code": code, "message": message}
    if seq is not None:
        envelope["seq"] = seq
    await svc.session.send(websocket, envelope)


# ============================================================
# 消息处理器
# ============================================================


async def _h_play(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """落子（color 可选：服务端唯一事实源推导）。

    人类本方落子经 ``on_committed`` **即时广播**（人机对弈 AI 应手可能耗时
    数秒，本方棋子不等 AI 落子一起显示，2026/09/10 人工反馈）；AI 应手/自动 PASS
    仍随处理器完成后的 ``_broadcast_play_result`` 推送。
    """
    data = WsPlay.model_validate(envelope.data or {})
    color = data.color or await svc.game.requester_color(game_id)
    committed = False

    async def _on_committed(move) -> None:
        nonlocal committed
        committed = True
        await _broadcast_move_applied(svc, game_id, move)

    result = await svc.game.play(
        game_id, x=data.x, y=data.y, color=color, on_committed=_on_committed, defer_ai=True
    )
    if result.ai_deferred:
        # AI 应手后台任务（2026/09/13）：不阻塞消息循环——思考期间悔棋可即时受理
        # （服务层经 KataGo terminate 中止在途查询，结果丢弃不落子）
        _spawn_ai_followup(svc, game_id)
    else:
        await _broadcast_play_result(svc, game_id, result, skip_primary=committed)


async def _h_pass(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    color = await svc.game.requester_color(game_id)
    committed = False

    async def _on_committed(move) -> None:
        nonlocal committed
        committed = True
        await _broadcast_move_applied(svc, game_id, move)

    result = await svc.game.pass_move(
        game_id, color=color, on_committed=_on_committed, defer_ai=True
    )
    if result.ai_deferred:
        _spawn_ai_followup(svc, game_id)
    else:
        await _broadcast_play_result(svc, game_id, result, skip_primary=committed)


async def _h_resign(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """认输（即时终局）。

    认输不广播 ``move.applied``（``resign`` 的 ``PlayResult`` 携带的是末手手数而非
    新落子——广播会被前端当作一次新落子重播动画，2026/09/11 人工反馈），
    仅广播 ``game.finished`` + ``game.state``；同时发起终局预判（引擎可用时）。
    """
    color = await svc.game.requester_color(game_id)
    await svc.game.resign(game_id, color=color)
    await _broadcast_game_over(svc, game_id)
    _start_settlement_prediction(svc, game_id)


async def _h_undo(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """悔棋（人人/人机分支，T6.4 人工确认 2026/09/06）。

    - **人机对弈**：直通执行（ISSUE-039，``config.play.max_undo`` 上限），
      ``move.undone`` + ``game.state`` 广播；**AI 思考期间同样可悔棋**（2026/09/13）：
      服务层先终止在途 AI 应手查询（KataGo terminate，部分结果丢弃不落子）、
      再按末手语义撤 1 步；
    - **人人对弈**：悔棋**不限制次数**，但需**对手确认**——
      本连接发起 `undo` 仅创建「悔棋申请」：有其它连接时仅向其它连接广播
      ``undo.request``（对端确认）；单连接热座时向请求方本机回投
      ``undo.request``（同屏「对方确认」）。请求方再次发 ``undo`` = 撤回申请
      （向申请方及其它连接广播 ``undo.declined {reason: withdrawn}``，关闭对端
      待确认弹窗）。对端经 ``undo.respond`` 回复。
    """
    color = await svc.game.requester_color(game_id)
    game = await repos.get_game(svc.db.conn, game_id)
    if game is None or game["mode"] != "human_human":
        # 人机（或异常）：直通执行（上限在服务层按人机作用域判定）
        result = await svc.game.undo(game_id, color=color)
        await _broadcast_undo(svc, game_id, result)
        return

    # ---- 人人对弈：悔棋申请 + 对手确认 ----
    pending = svc.session.undo_request_get(game_id)
    if pending is not None:
        if pending["requester"] is ws:
            # 请求方再次发 undo = 撤回申请：告知申请方，并同步撤销
            # 其它连接（对端设备）上正等待确认的弹窗/锁定（其忽略 reason）
            svc.session.undo_request_clear(game_id)
            declined = {
                "type": "undo.declined",
                "data": {"request_id": pending["request_id"], "reason": "withdrawn"},
            }
            await svc.session.send(ws, declined)
            await svc.session.send_to_game_others(game_id, ws, declined)
            return
        raise AppError(ErrorCode.UNDO_PENDING, "已有悔棋申请待对方确认")
    plan = await svc.game.undo_preflight(game_id, color=color)  # 无子可悔等在此快速失败
    request_id = svc.session.next_undo_request_id()
    # 先判定是否存在其它连接（含申请方），再登记（避免热座误判）
    others_exist = svc.session.game_conn_count(game_id) > 1
    req = svc.session.undo_request_begin(
        game_id,
        ws,
        request_id=request_id,
        color=color,
        steps=plan["steps"],
        others_exist=others_exist,
    )
    if req is None:
        raise AppError(ErrorCode.UNDO_PENDING, "已有悔棋申请待对方确认")
    payload = {
        "type": "undo.request",
        "data": {
            "request_id": request_id,
            "color": color,
            "steps": plan["steps"],
            "base_move_no": plan["base_move_no"],
        },
    }
    sent_others = await svc.session.send_to_game_others(game_id, ws, payload)
    if not sent_others:
        # 单连接热座：向请求方本机回投（同屏「对方确认悔棋？」）
        await svc.session.send(ws, payload)


async def _h_undo_respond(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """人人对弈悔棋申请回复（``undo.respond {request_id, accept}``，T6.4）。

    - 仅处理**现存且匹配**的申请；申请方自身在**多连接**下不得替对方确认；
      （热座单连接由服务端把 ``undo.request`` 回投申请方，此时同一连接可确认）；
    - accept=True：执行悔棋（``game_service.undo``，无次数上限）→ 广播
      ``move.undone`` + ``game.state``；
    - accept=False：清除申请并向申请方发 ``undo.declined {reason: declined}``。
    """
    data = WsUndoRespond.model_validate(envelope.data or {})
    pending = svc.session.undo_request_get(game_id)
    if pending is None or pending["request_id"] != data.request_id:
        raise AppError(ErrorCode.ILLEGAL_ACTION, "悔棋申请不存在或已处理")
    if pending["others_exist"] and pending["requester"] is ws:
        raise AppError(ErrorCode.ILLEGAL_ACTION, "请由对方确认悔棋")
    svc.session.undo_request_clear(game_id)
    if not data.accept:
        await svc.session.send(
            pending["requester"],
            {
                "type": "undo.declined",
                "data": {"request_id": pending["request_id"], "reason": "declined"},
            },
        )
        return
    # 同意：执行悔棋（人人无上限）。**执行失败必须给申请方终态**（R3，2026/09/16
    # 评审批次）：申请已清除，若只回响应方错误信封，申请方的 ``undoWaiting`` 会
    # 残留（按钮变「取消悔棋申请」+ 棋盘锁定）且无任何提示。
    try:
        result = await svc.game.undo(game_id, color=pending["color"])
    except AppError as exc:
        logger.warning("对局 #%d 悔棋申请执行失败：%s", game_id, exc.message)
        failed = {
            "type": "undo.declined",
            "data": {
                "request_id": pending["request_id"],
                "reason": "failed",
                "code": exc.code.value,
                "message": exc.message,
            },
        }
        await svc.session.send(pending["requester"], failed)
        if pending["requester"] is not ws:
            await svc.session.send(ws, failed)  # 响应方同样收敛（不发裸错误信封）
        return
    await _broadcast_undo(svc, game_id, result)


async def _h_start(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """开局/续行（T6.4 新增）：created→PLAYING（人机 AI 先行触发 AI 首手）；
    active + 人机轮到 AI（``TURN_AI`` 挂起/断点恢复后）→ 恢复触发 AI 落子。

    结果经 ``move.applied``（AI 落子/自动 PASS 多手）与 ``game.state`` 广播；
    无 AI 落子（人人/轮到人类）仅广播 ``game.state`` 全量同步。
    """
    result = await svc.game.start_or_resume_ai(game_id, defer_ai=True)
    if result is not None and result.ai_deferred:
        # AI 首手/续行应手后台化（同 _h_play）：思考期间悔棋可即时受理
        _spawn_ai_followup(svc, game_id)
    elif result is not None:
        await _broadcast_play_result(svc, game_id, result)
    else:
        await _broadcast_game_state(svc, game_id)


async def _h_restart(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """重开（同参数重置，T6.4 新增）：PLAYING → created；清空落子与分析、
    悔棋计数归零（``game_service.restart``），随后广播 ``game.state``。"""
    await svc.game.restart(game_id)
    await _broadcast_game_state(svc, game_id)


async def _h_scoring_confirm(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    data = WsScoringConfirm.model_validate(envelope.data or {})
    dead = [tuple(p) for p in data.dead_points]
    # 未定型终局（导入棋谱且非双 PASS）以 AI 预判结果为权威结果（2026/10/10 人工确认）：
    # 携带同末手缓存预判；缺失（引擎不可用/预判未就绪）由 service 层回退 Python 数子
    predicted = None
    if svc.settlement is not None:
        game = await repos.get_game(svc.db.conn, game_id)
        if game is not None:
            predicted = svc.settlement.last_prediction(
                game_id, move_no=int(game["last_move_no"] or 0)
            )
    result = await svc.game.confirm_scoring(game_id, dead_points=dead, predicted=predicted)
    await svc.session.broadcast_to_game(game_id, {"type": "game.finished", "data": result})
    await _broadcast_game_state(svc, game_id)


async def _h_scoring_cancel(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """结算取消：SCORING → PLAYING（继续对弈，PRD §4.1.8 结算取消；新增类型向后兼容）。"""
    await svc.game.cancel_scoring(game_id)
    await _broadcast_game_state(svc, game_id)


async def _h_scoring_prepare(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """结算准备（2026/09/19 人工决策方案 A）：未结算终局（导入棋谱）触发死子预判。

    - 仅 ``finished`` 且 ``result`` 为空的对局（``game_service.prepare_settle`` 校验，
      状态不变，原地补结算）；
    - 预判缓存命中（同末手）→ 直发请求方；否则提交终局深算（``scoring.prediction``
      到达时广播；引擎不可用由预判器自行降级 ``engine:false``）。
    """
    move_no = await svc.game.prepare_settle(game_id)
    cached = (
        svc.settlement.last_prediction(game_id, move_no=move_no)
        if svc.settlement is not None
        else None
    )
    if cached is not None:
        await svc.session.send(ws, {"type": "scoring.prediction", "data": cached})
        return
    _start_settlement_prediction(svc, game_id)


async def _send_bg_error(
    svc: AppServices, ws: WebSocket, seq: Optional[int], code: str, message: str
) -> None:
    """后台任务错误信封（M-1：与 ``_send_error`` 同构，供异步任务回投）。"""
    envelope: dict = {"type": "error", "code": code, "message": message}
    if seq is not None:
        envelope["seq"] = seq
    await svc.session.send(ws, envelope)


def _request_drop_notice(reason: str) -> tuple[Optional[ErrorCode], str]:
    """按需分析任务被丢弃 → 请求方错误信封（code, message）；``None`` = 静默。

    口径（2026/09/12 终态契约）：丢弃原因来自 ``AnalysisService._notify_drop``——
    ``expired``（悔棋/重开/试下变更 → 局面已变，旧请求无意义）只回**终态空载荷**；
    引擎类故障（``engine_unavailable`` / ``engine_error``）另发错误信封供前端提示。
    """
    if reason == "engine_unavailable":
        return ErrorCode.ENGINE_DEAD, "引擎不可用：按需分析已降级"
    if reason == "engine_error":
        return ErrorCode.INTERNAL_ERROR, "分析查询失败"
    return None, ""


async def _h_coaching(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """支招 TOP5（深度分析 maxVisits，P2；moves 可为空数组）。

    M-1：后台任务执行，不阻塞 WS 接收循环/心跳；结果经 ``coaching.top5`` 广播。
    """
    seq = envelope.seq

    async def _run() -> None:
        try:
            result = await svc.review.coaching(game_id)
            await svc.session.broadcast_to_game(
                game_id, {"type": "coaching.top5", "data": result}
            )
        except AppError as exc:
            await _send_bg_error(svc, ws, seq, exc.code.value, exc.message)
        except Exception:  # noqa: BLE001 - 后台任务兜底
            logger.exception("支招后台任务失败 · 对局 #%s", game_id)
            await _send_bg_error(svc, ws, seq, ErrorCode.INTERNAL_ERROR.value, "服务器内部错误")

    asyncio.create_task(_run(), name=f"coaching-{game_id}")


async def _h_ownership(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """领地按需请求：回读已有分析或触发标准分析（P1）后推送。

    - 试下分支（``trial_id``）：读会话缓存（DATABASE §3.4，仅会话不落库）；
      缺数据（ownership=null）→ 触发 P1 会话分析，完成后回投（T6.8 按需拉）；
    - 主谱：回读持久化分析；缺数据触发 P1 标准分析。
    """
    data = WsOwnershipRequest.model_validate(envelope.data or {})
    if data.trial_id is not None:
        move_no = data.move_no or 0
        payload = await svc.review.trial_ownership(game_id, data.trial_id, move_no)
        if payload["ownership"] is not None:
            await svc.session.broadcast_to_game(
                game_id, {"type": "position.ownership", "data": payload}
            )
            return
        # 试下缺数据：触发 P1（仅会话缓存），结果到达后回投
        key = f"trial:{data.trial_id}:{move_no}"
        seq = envelope.seq

        async def _on_result(_k: str, preprocessed: dict) -> None:
            result = await svc.review.trial_ownership(game_id, data.trial_id, move_no)
            await svc.session.send(
                ws,
                {
                    "type": "position.ownership",
                    "data": result or {"position_key": key, "move_no": move_no, "ownership": None},
                    "seq": seq,
                },
            )

        async def _on_drop(reason: str) -> None:
            # 终态契约：任务被丢弃（过期/引擎故障）也必须终结请求（回投空领地）
            await svc.session.send(
                ws,
                {
                    "type": "position.ownership",
                    "data": {"position_key": key, "move_no": move_no, "ownership": None},
                    "seq": seq,
                },
            )
            code, message = _request_drop_notice(reason)
            if code is not None:
                await _send_bg_error(svc, ws, seq, code.value, message)

        async def _run() -> None:
            try:
                await svc.review.submit_trial_standard(
                    game_id, key, on_result=_on_result, on_drop=_on_drop
                )
            except AppError as exc:
                # 引擎不可用等：回投空所有权（前端显示无数据说明），不阻塞
                await svc.session.send(
                    ws,
                    {
                        "type": "position.ownership",
                        "data": {"position_key": key, "move_no": move_no, "ownership": None},
                        "seq": seq,
                    },
                )
                await _send_bg_error(svc, ws, seq, exc.code.value, exc.message)
            except Exception:  # noqa: BLE001 - 后台任务兜底
                logger.exception("试下领地分析失败 · 对局 #%s · 局面 %s", game_id, key)

        asyncio.create_task(_run(), name=f"trial-ownership-{game_id}")
        return
    game = await repos.get_game(svc.db.conn, game_id)
    if game is None:
        # L-8：删除竞态下旧实现 `game[...]` 触发 TypeError → INTERNAL_ERROR（领域事实
        # 被当作服务端 bug）；统一 GAME_NOT_FOUND（与其余入口同口径）
        raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
    move_no = data.move_no if data.move_no is not None else game["last_move_no"]
    if not (0 <= move_no <= game["last_move_no"]):
        raise AppError(ErrorCode.ILLEGAL_ACTION, f"领地手数越界: {move_no}")
    try:
        payload = await svc.review.ownership(game_id, move_no=move_no)
        await svc.session.broadcast_to_game(
            game_id, {"type": "position.ownership", "data": payload}
        )
        return
    except AppError as exc:
        if exc.code is not ErrorCode.ANALYSIS_INCOMPLETE:
            raise
    await _trigger_ownership_analysis(svc, game_id, move_no, ws=ws, seq=envelope.seq)


async def _h_deep(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """深度分析（一次性深算，P2；主谱 move_no / 试下 position_key）。

    M-1：后台任务执行，不阻塞 WS 接收循环/心跳；结果经 ``deep_analysis.result``
    回投请求方（断线则静默丢弃，符合现有 send 容错语义）。
    """
    data = WsDeepAnalysisRequest.model_validate(envelope.data or {})
    key = data.position_key or f"main:{data.move_no}"
    seq = envelope.seq

    async def _run() -> None:
        try:
            result = await svc.review.deep_analyze(
                game_id, move_no=data.move_no, position_key=data.position_key
            )
            await svc.session.send(
                ws,
                {"type": "deep_analysis.result", "data": {"position_key": key, "result": result}},
            )
        except AppError as exc:
            await _send_bg_error(svc, ws, seq, exc.code.value, exc.message)
        except Exception:  # noqa: BLE001 - 后台任务兜底
            logger.exception("深度分析后台任务失败 · 对局 #%s", game_id)
            await _send_bg_error(svc, ws, seq, ErrorCode.INTERNAL_ERROR.value, "服务器内部错误")

    asyncio.create_task(_run(), name=f"deep-{game_id}")


async def _h_global(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """全局分析（逐手补分析，排队 + 进度，可中断）。

    M-1：后台任务执行，不阻塞 WS 接收循环/心跳；进度/完成经广播推送。
    """
    data = WsGlobalAnalysisRequest.model_validate(envelope.data or {})
    seq = envelope.seq

    async def _on_progress(done: int, total: int) -> None:
        await svc.session.broadcast_to_game(
            game_id,
            {"type": "analysis.progress", "data": {"kind": "global", "done": done, "total": total}},
        )

    async def _run() -> None:
        try:
            result = await svc.review.global_analyze(
                game_id, start_move_no=data.start_move_no or 0, on_progress=_on_progress
            )
            await svc.session.broadcast_to_game(
                game_id, {"type": "global_analysis.done", "data": result}
            )
        except AppError as exc:
            await _send_bg_error(svc, ws, seq, exc.code.value, exc.message)
        except Exception:  # noqa: BLE001 - 后台任务兜底
            logger.exception("全局分析后台任务失败 · 对局 #%s", game_id)
            await _send_bg_error(svc, ws, seq, ErrorCode.INTERNAL_ERROR.value, "服务器内部错误")

    asyncio.create_task(_run(), name=f"global-{game_id}")


async def _h_global_cancel(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    svc.review.global_analyze_cancel(game_id)


# ============================================================
# T6.8 复盘：recommend.request / 试下分支（review_service 后端试下）
# ============================================================


async def _h_recommend(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """复盘 AI 推荐/当前手点评：主谱 ``{move_no}`` / 试下 ``{position_key}``。

    - 读持久化/会话缓存派生（引擎无关），结果回投 ``review.recommend``；
    - 试下缺数据：触发 P1 标准分析（仅会话缓存）→ 完成后回投（前端按需拉语义）；
    - 主谱缺数据：不回投实时计算（空载荷，前端走 [全局分析] 补全 CTA）。
    """
    data = WsRecommendRequest.model_validate(envelope.data or {})
    seq = envelope.seq
    try:
        payload = await svc.review.recommend(
            game_id, move_no=data.move_no, position_key=data.position_key
        )
    except AppError as exc:
        await _send_bg_error(svc, ws, seq, exc.code.value, exc.message)
        return
    if payload["has_data"] or data.position_key is None:
        await svc.session.send(ws, {"type": "review.recommend", "data": payload, "seq": seq})
        return

    # 试下缺数据：触发 P1（仅会话缓存），完成后按最新会话缓存派生回投
    key = data.position_key

    async def _on_result(_pos_key: str, _preprocessed: dict) -> None:
        try:
            result = await svc.review.recommend(game_id, position_key=key)
            await svc.session.send(
                ws, {"type": "review.recommend", "data": result, "seq": seq}
            )
        except AppError as exc:
            await _send_bg_error(svc, ws, seq, exc.code.value, exc.message)
        except Exception:  # noqa: BLE001 - 后台任务兜底
            logger.exception("试下推荐派生失败 · 对局 #%s · 局面 %s", game_id, key)
            await _send_bg_error(
                svc, ws, seq, ErrorCode.INTERNAL_ERROR.value, "服务器内部错误"
            )

    async def _on_drop(reason: str) -> None:
        # 终态契约：任务被丢弃（过期/引擎故障）也必须终结请求（回投空推荐载荷）
        await _on_result(key, {})
        code, message = _request_drop_notice(reason)
        if code is not None:
            await _send_bg_error(svc, ws, seq, code.value, message)

    async def _run() -> None:
        try:
            await svc.review.submit_trial_standard(
                game_id, key, on_result=_on_result, on_drop=_on_drop
            )
        except AppError as exc:
            await _send_bg_error(svc, ws, seq, exc.code.value, exc.message)
        except Exception:  # noqa: BLE001 - 后台任务兜底
            logger.exception("试下推荐分析失败 · 对局 #%s · 局面 %s", game_id, key)
            await _send_bg_error(
                svc, ws, seq, ErrorCode.INTERNAL_ERROR.value, "服务器内部错误"
            )

    asyncio.create_task(_run(), name=f"trial-recommend-{game_id}")


async def _h_trial_enter(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """试下进入：从主谱 ``move_no`` 局面创建临时分支（会话内存，不落库）。"""
    data = WsTrialEnter.model_validate(envelope.data or {})
    trial_id = await svc.review.trial_enter(game_id, data.move_no)
    await _send_trial_state(svc, ws, game_id, trial_id, envelope.seq)


async def _h_trial_play(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """试下落子（规则校验 + 触发 P1 会话分析；color 服务端推导）。"""
    data = WsTrialPlay.model_validate(envelope.data or {})
    await svc.review.trial_play(game_id, data.trial_id, x=data.x, y=data.y)
    await _send_trial_state(svc, ws, game_id, data.trial_id, envelope.seq)


async def _h_trial_pass(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    data = WsTrialRef.model_validate(envelope.data or {})
    await svc.review.trial_pass(game_id, data.trial_id)
    await _send_trial_state(svc, ws, game_id, data.trial_id, envelope.seq)


async def _h_trial_undo(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    data = WsTrialRef.model_validate(envelope.data or {})
    await svc.review.trial_undo(game_id, data.trial_id)
    await _send_trial_state(svc, ws, game_id, data.trial_id, envelope.seq)


async def _h_trial_back_to_real(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """回实战：返回试下进入的主谱局面（分支保留，可再次进入；T6.8）。"""
    data = WsTrialRef.model_validate(envelope.data or {})
    await svc.review.trial_back_to_real(game_id, data.trial_id)
    await _send_trial_state(svc, ws, game_id, data.trial_id, envelope.seq)


async def _send_trial_state(
    svc: AppServices, ws: WebSocket, game_id: int, trial_id: int, seq
) -> None:
    """试下分支状态回投请求方（``trial.state``；仅会话作用域，不广播）。"""
    snap = await svc.review.trial_snapshot(game_id, trial_id)
    await svc.session.send(ws, {"type": "trial.state", "data": snap, "seq": seq})


async def _h_restore(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    """请求全量状态同步（连接后与恢复时推送）。

    - 服务端全局分析为后台任务（WS 断线不中断）：若恢复时仍有该对局全局分析
      进行中，附带重发 ``analysis.progress``（W-08 已确认，UI_UX §12 关闭），
      前端据此恢复"停止分析"进度态。
    """
    await _send_game_state(svc, ws, game_id)
    progress = svc.review.global_analysis_progress(game_id)
    if progress is not None:
        await svc.session.send(ws, {"type": "analysis.progress", "data": progress})


async def _h_ping(svc: AppServices, ws: WebSocket, game_id: int, envelope: WsEnvelope) -> None:
    await svc.session.send(ws, {"type": "pong", "seq": envelope.seq})


_HANDLERS: dict[str, Handler] = {
    "start": _h_start,
    "play": _h_play,
    "pass": _h_pass,
    "resign": _h_resign,
    "undo": _h_undo,
    "undo.respond": _h_undo_respond,
    "restart": _h_restart,
    "scoring.confirm": _h_scoring_confirm,
    "scoring.cancel": _h_scoring_cancel,
    "scoring.prepare": _h_scoring_prepare,
    "coaching.request": _h_coaching,
    "ownership.request": _h_ownership,
    "deep_analysis.request": _h_deep,
    "recommend.request": _h_recommend,
    "global_analysis.request": _h_global,
    "global_analysis.cancel": _h_global_cancel,
    "trial.enter": _h_trial_enter,
    "trial.play": _h_trial_play,
    "trial.pass": _h_trial_pass,
    "trial.undo": _h_trial_undo,
    "trial.back_to_real": _h_trial_back_to_real,
    "restore.request": _h_restore,
    "ping": _h_ping,
}


# ============================================================
# 推送辅助
# ============================================================


def _public_state(payload: dict) -> dict:
    """game.state 载荷：game 子对象经 GameInfo 白名单收敛（T6.1，剔除内部列）。"""
    return {**payload, "game": to_public_game(payload["game"])}


async def _send_game_state(svc: AppServices, ws: WebSocket, game_id: int) -> None:
    payload = await svc.game.snapshot(game_id)
    await svc.session.send(ws, {"type": "game.state", "data": _public_state(payload)})
    await _send_resume_extras(svc, ws, game_id, payload)


async def _send_resume_extras(
    svc: AppServices, ws: WebSocket, game_id: int, snapshot: dict
) -> None:
    """连接/恢复补充推送：最近点评（``analysis.comment``）与结算预判（``scoring.prediction``）。

    - 点评：每手标准分析到达时实时广播；刷新/重连后由这里回投**最近 2 手**（读持久化派生，
      引擎无关；前端保留最近 2 手圆点，2026/09/11）；
    - 预判：结算后连接（或重连）时回投最近一次预判（``move_no`` 不匹配视为过期）；
      结算态**无预判缓存**（推送丢失/服务重启/触发遗漏）则连接即补发起（幂等，
      BUG-029 兜底——面板以 ``scoring.prediction`` 为唯一解除条件，不允许永久等待）。
    """
    game = snapshot.get("game") or {}
    move_no = int(game.get("last_move_no") or 0)
    if move_no >= 1:
        for comment in await svc.review.recent_comments(game_id, count=2):
            await svc.session.send(ws, {"type": "analysis.comment", "data": comment})
    if svc.settlement is not None and str(game.get("status") or "") in ("scoring", "finished"):
        prediction = svc.settlement.last_prediction(game_id, move_no=move_no)
        if prediction is not None:
            await svc.session.send(ws, {"type": "scoring.prediction", "data": prediction})
        elif str(game.get("status") or "") == "scoring":
            _start_settlement_prediction(svc, game_id)


def _start_settlement_prediction(svc: AppServices, game_id: int) -> None:
    """结算预判后台任务（双 PASS 进结算 / 认输终局；引擎不可用时由预判器自行降级）。"""
    if svc.settlement is None:
        return
    asyncio.create_task(svc.settlement.predict(game_id), name=f"settle-{game_id}")


async def _broadcast_game_over(svc: AppServices, game_id: int) -> None:
    """认输即时终局广播：``game.finished`` + ``game.state``（**不含** ``move.applied``）。

    M-3：终局标记与状态快照同持对局锁（与并发悔棋/重开广播保持总序）。
    """
    async with svc.game.game_lock(game_id):
        game = await repos.get_game(svc.db.conn, game_id)
        await svc.session.broadcast_to_game(
            game_id,
            {
                "type": "game.finished",
                "data": {
                    "result": game["result"] if game else None,
                    "black_score": None,
                    "white_score": None,
                },
            },
        )
        await _broadcast_game_state_locked(svc, game_id)


async def _broadcast_game_state(svc: AppServices, game_id: int) -> None:
    """``game.state`` 全量广播（M-3：快照读取与广播同持对局锁）。

    旧实现读快照与广播无锁：两个并发事件（如落子提交回调与悔棋广播）可在广播
    前交错——旧快照的广播晚于新快照到达，客户端回退到旧局面（直到下一次权威
    推送才收敛）。持锁后同一对局的快照读取与发送保持提交顺序（同 R4 口径）。

    持有对局锁的调用方（AI 应手收尾、悔棋/终局广播）改用
    ``_broadcast_game_state_locked``，避免 asyncio.Lock 非重入导致自锁。
    """
    async with svc.game.game_lock(game_id):
        await _broadcast_game_state_locked(svc, game_id)


async def _broadcast_game_state_locked(svc: AppServices, game_id: int) -> None:
    """``game.state`` 全量广播（**调用方已持对局锁**）。"""
    payload = await svc.game.snapshot(game_id)
    await svc.session.broadcast_to_game(game_id, {"type": "game.state", "data": _public_state(payload)})


async def _broadcast_undo(svc: AppServices, game_id: int, result) -> None:
    """悔棋结果广播：``move.undone`` + ``game.state``（人机直通 / 人人确认通过共用）。

    M-3：``move.undone`` 与截断后状态同持对局锁——与 AI 应手收尾（R4）互斥，
    避免 ``move.undone`` 与迟到 ``move.applied`` 交错导致已撤之子“复活”。
    """
    async with svc.game.game_lock(game_id):
        await svc.session.broadcast_to_game(
            game_id,
            {
                "type": "move.undone",
                "data": {
                    "move_no": result.undone_move_no,
                    "new_last_move_no": result.new_last_move_no,
                    "steps": result.steps,
                },
            },
        )
        await _broadcast_game_state_locked(svc, game_id)


async def _broadcast_move_applied(svc: AppServices, game_id: int, move) -> None:
    """单步 ``move.applied`` 即时广播（提交回调用）。

    载荷携带累计提子数（ISSUE-047 方案 1，API §1 向后兼容：可选字段）。
    """
    game = await repos.get_game(svc.db.conn, game_id)
    await svc.session.broadcast_to_game(
        game_id,
        {
            "type": "move.applied",
            "data": _move_applied_payload(move, game),
        },
    )


def _move_applied_payload(extra, game: Optional[dict]) -> dict:
    """``move.applied`` 载荷（落子字段 + 累计提子数，广播时读当前行）。"""
    return {
        "move_no": extra.move_no,
        "color": extra.color,
        "x": extra.x,
        "y": extra.y,
        "is_pass": extra.is_pass,
        "black_captures": game["black_captures"] if game else 0,
        "white_captures": game["white_captures"] if game else 0,
    }


async def _broadcast_play_result(
    svc: AppServices, game_id: int, result, *, skip_primary: bool = False, locked: bool = False
) -> None:
    """广播落子结果（含 AI 落子 / 自动 PASS / 即时终局）。

    ``skip_primary=True``：本方落子已经提交回调即时广播（``_h_play``/``_h_pass``），
    此处不再重发（重发会重复播音效/动画）。
    ``locked=True``（M-3）：调用方已持对局锁（``_spawn_ai_followup`` 的 R4 收尾），
    直接走内部实现；默认路径自行取锁，保证落子事件链与快照的原子顺序。
    """
    if locked:
        await _broadcast_play_result_locked(
            svc, game_id, result, skip_primary=skip_primary
        )
        return
    async with svc.game.game_lock(game_id):
        await _broadcast_play_result_locked(
            svc, game_id, result, skip_primary=skip_primary
        )


async def _broadcast_play_result_locked(
    svc: AppServices, game_id: int, result, *, skip_primary: bool = False
) -> None:
    """``_broadcast_play_result`` 内部实现（**调用方已持对局锁**）。"""
    game = await repos.get_game(svc.db.conn, game_id)

    if not skip_primary:
        await svc.session.broadcast_to_game(
            game_id,
            {"type": "move.applied", "data": _move_applied_payload(result, game)},
        )
    for extra in (result.auto_pass, result.ai_move):
        if extra is not None:
            await svc.session.broadcast_to_game(
                game_id,
                {"type": "move.applied", "data": _move_applied_payload(extra, game)},
            )
    if result.game_over:
        await svc.session.broadcast_to_game(
            game_id,
            {"type": "game.finished", "data": {"result": game["result"], "black_score": None, "white_score": None}},
        )
    if result.entering_scoring:
        # 双 PASS 进入结算：后台预判（终局深算 → 预判死子 + GTP final_score 等价结果）
        _start_settlement_prediction(svc, game_id)
    await _broadcast_game_state_locked(svc, game_id)


def _spawn_ai_followup(svc: AppServices, game_id: int) -> None:
    """AI 应手后台任务（``defer_ai`` 模式）：收尾广播等价 ``_broadcast_play_result``。

    - 被悔棋中断（``ai_cancelled``）→ 不广播（``move.undone``/``game.state`` 由 undo 侧推送）；
    - 悔棋竞态（AI 棋子已被随后完成的悔棋撤掉）→ 不广播过期棋子（新状态由 undo 覆盖）；
    - 服务层异常→ 广播 ``game.state`` 解除客户端等待（不静默悬挂）。
    """

    async def _run() -> None:
        try:
            carrier = await svc.game.resolve_ai_turn(game_id)
            if carrier.ai_cancelled:
                return
            extras = [x for x in (carrier.ai_move, carrier.auto_pass) if x is not None]
            # R4（2026/09/16 评审批次）：截断复查与广播必须**原子**（同一对局锁内）——
            # 否则悔棋可插在复查与广播之间：客户端先收 ``move.undone``+``game.state``
            # （截断后）、又收迟到 ``move.applied``（已撤之子被前端 ``Math.max``
            # 推进“复活”到棋盘，直到下一次权威 game.state 才收敛）。
            async with svc.game.game_lock(game_id):
                if extras:
                    game = await repos.get_game(svc.db.conn, game_id)
                    last = int(game["last_move_no"] or 0) if game is not None else 0
                    if game is None or last < max(int(x.move_no) for x in extras):
                        return  # 已被悔棋截断/对局已删：等 undo 的 game.state 统一刷新
                await _broadcast_play_result(
                    svc, game_id, carrier, skip_primary=True, locked=True
                )
        except AppError as exc:
            logger.warning("AI 应手后台任务失败 · 对局 #%s：%s", game_id, exc.message)
            await _broadcast_game_state_if_exists(svc, game_id)
        except Exception:  # noqa: BLE001 - 后台任务兜底（错误不入库也不悬挂客户端）
            logger.exception("AI 应手后台任务异常 · 对局 #%s", game_id)
            await _broadcast_game_state_if_exists(svc, game_id)

    asyncio.create_task(_run(), name=f"ai-move-{game_id}")


async def _broadcast_game_state_if_exists(svc: AppServices, game_id: int) -> None:
    """后台任务收尾广播：对局已被删除（删除活跃局）时静默跳过。"""
    try:
        await _broadcast_game_state(svc, game_id)
    except AppError as exc:
        if exc.code is not ErrorCode.GAME_NOT_FOUND:
            raise


async def _trigger_ownership_analysis(
    svc: AppServices,
    game_id: int,
    move_no: int,
    *,
    ws: Optional[WebSocket] = None,
    seq: Optional[int] = None,
) -> None:
    """缺分析数据时触发**链精度**分析（P1），结果到达后推送 position.ownership。

    终态契约（2026/09/12）：任务被丢弃（过期/引擎故障）时也必须终结请求——
    回投 ``ownership: null``（前端据此解除 pending），引擎类故障另向请求方
    （``ws``/``seq``）发错误信封；旧实现在此静默丢弃 → 前端 pending 无界悬挂。
    """
    game = await repos.get_game(svc.db.conn, game_id)
    if game is None:
        # L-8：同 `_h_ownership`——删除竞态不得以 TypeError 落为 INTERNAL_ERROR
        raise AppError(ErrorCode.GAME_NOT_FOUND, "对局不存在")
    moves = await repos.list_moves(svc.db.conn, game_id)
    prefix = [m for m in moves if m["move_no"] <= move_no]
    from app.engine.analysis_query import build_standard_query
    from app.services.chain_precision import chain_visits

    query = build_standard_query(
        board_size=game["board_size"],
        rules=game["rules"],
        komi=game["komi"],
        moves=prefix,
        # 让子局：分析查询同样携带初始石（BUG-013）
        initial_stones=handicap_initial_stones(
            game["board_size"], game["handicap"] or 0
        ),
        # BUG-026：补分析精度 = 链精度（否则向链内写入异精度行）
        max_visits=chain_visits(svc.config, game),
    )
    position_key = f"main:{move_no}"

    async def _on_result(key: str, preprocessed: dict) -> None:
        await svc.session.broadcast_to_game(
            game_id,
            {
                "type": "position.ownership",
                "data": {
                    "position_key": position_key,
                    "move_no": move_no,
                    "ownership": preprocessed.get("ownership"),
                },
            },
        )

    async def _on_drop(reason: str) -> None:
        await svc.session.broadcast_to_game(
            game_id,
            {
                "type": "position.ownership",
                "data": {
                    "position_key": position_key,
                    "move_no": move_no,
                    "ownership": None,
                },
            },
        )
        code, message = _request_drop_notice(reason)
        if ws is not None and code is not None:
            await _send_bg_error(svc, ws, seq, code.value, message)

    await svc.analysis.submit(
        game_id, position_key, query, on_result=_on_result, on_drop=_on_drop
    )
