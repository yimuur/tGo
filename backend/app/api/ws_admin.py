"""WS 管理通道（TASK T4.6，API §4.4）。

- 服务端 → 客户端推送：``engine.status``（含 INIT/benchmark progress）、
  ``admin.task``（start/stop/set_model/restart 结果）、``admin.config``（配置/默认模型
  变更，前端订阅后 REST 刷新参数/模型显示）、``system.status``（定时可选）；
- 客户端 → 服务端：``ping``（心跳）；其余消息忽略（管理通道以服务端推送为主）；
- 连接时立即推送当前引擎状态；30s 无消息判定断线清理。
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.api.deps import get_services_ws
from app.api.routes_admin import _collect_system_status
from app.api.schemas import WsEnvelope
from app.api.ws_guard import ORIGIN_REJECT_CODE, channel_already_closed, origin_allowed
from app.bootstrap import AppServices

logger = logging.getLogger(__name__)

router = APIRouter()

RECEIVE_TIMEOUT_S = 30.0


@router.websocket("/ws/admin")
async def ws_admin(websocket: WebSocket) -> None:
    """管理通道：引擎状态 / admin.task / system.status 推送。"""
    svc = get_services_ws(websocket)
    # T6.1：Origin/同源校验（管理通道可下发引擎操作任务，防御跨源网页劫持）
    if not origin_allowed(websocket):
        await websocket.close(code=ORIGIN_REJECT_CODE)
        return
    await websocket.accept()
    await svc.session.register_admin(websocket)

    interval = svc.config.admin.system_status_interval_s
    sys_task: asyncio.Task | None = None
    if interval > 0:
        sys_task = asyncio.create_task(
            _system_status_loop(svc, websocket, interval), name="admin-system-status"
        )
    try:
        # 连接即推送当前引擎状态（含 INIT/benchmark progress）
        if svc.manager is not None:
            await svc.session.send(
                websocket, {"type": "engine.status", "data": svc.manager.state_snapshot()}
            )
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_json(), timeout=RECEIVE_TIMEOUT_S)
            except asyncio.TimeoutError:
                break
            except RuntimeError:
                # BUG-126：推送失败已把通道置为 DISCONNECTED（对端早已断开）→ 按断线收尾；
                # 其它 RuntimeError（真实缺陷）照旧上抛给通道级兜底。
                if not channel_already_closed(websocket):
                    raise
                logger.info("WS 管理通道对端已断开（推送失败后通道状态失效），按断线收尾")
                break
            await _admin_dispatch(svc, websocket, raw)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - 通道级兜底
        logger.exception("WS 管理通道异常")
    finally:
        if sys_task is not None:
            sys_task.cancel()
        await svc.session.unregister_admin(websocket)


async def _admin_dispatch(svc: AppServices, websocket: WebSocket, raw: dict) -> None:
    """管理通道入站消息（仅心跳；其余忽略，避免未知消息类型报错）。"""
    try:
        envelope = WsEnvelope.model_validate(raw)
    except ValidationError:
        return
    if envelope.type == "ping":
        await svc.session.send(websocket, {"type": "pong", "seq": envelope.seq})


async def _system_status_loop(svc: AppServices, websocket: WebSocket, interval_s: int) -> None:
    """定时推送 system.status（可选；psutil/nvidia-smi 采集失败跳过）。

    后端标签（stderr 检测）随管理器**活取**——与 `GET /admin/system` 同源；旧实现
    未传 backend，定时推送恒以 `null` 覆盖前端已显示值（管理页刷新后「KataGo 后端」
    几秒内从 `OpenCL · …` 退化为「—」，2026/09/18 人工反馈）。
    """
    while True:
        await asyncio.sleep(interval_s)
        manager = svc.manager
        try:
            status = await _collect_system_status(
                manager.backend_label if manager is not None else None
            )
        except Exception:  # noqa: BLE001 - 采集失败跳过本次推送
            logger.debug("system.status 采集失败，跳过本轮推送", exc_info=True)
            continue
        await svc.session.send(websocket, {"type": "system.status", "data": status})
