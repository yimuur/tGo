"""WS 通道 Origin/同源校验（T6.1；PROJECT_STATUS 遗留收口）。

- 浏览器发起 WS 升级必带 ``Origin``：要求与请求 ``Host`` **同源**（局域网信任
  模型下用户经主机名/IP 访问即同源），或命中 ``TGO_WS_ALLOWED_ORIGINS``
  逗号分隔白名单（反代/跨源部署兜底）；
- 缺失 ``Origin``（非浏览器客户端/CLI/脚本）→ 放行（向后兼容测试与工具）；
- 拒绝发生在 ``accept()`` **之前**：直接 ``close(code=1008)``（Policy Violation），
  不注册连接、不订阅推送。
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit

from fastapi import WebSocket
from starlette.websockets import WebSocketState

#: 环境变量：额外允许的 Origin（逗号分隔 netloc 列表，同源放行外的跨源兜底）
ALLOWED_ORIGINS_ENV = "TGO_WS_ALLOWED_ORIGINS"

#: 策略拒绝关闭码（RFC 6455 policy violation）
ORIGIN_REJECT_CODE = 1008


def channel_already_closed(websocket: WebSocket) -> bool:
    """通道是否已被**应用侧**标记为断开（starlette ``application_state``）。

    BUG-126（2026/09/21 现场日志：「WS 对局通道异常 · 对局 #235」）：推送/应答
    ``send_json`` 遇对端已断开时，starlette 捕获 ``OSError`` → ``application_state``
    置为 ``DISCONNECTED`` 并抛 ``WebSocketDisconnect(1006)``（被 ``SessionManager.send``
    按「连接已断开/竞态」吞掉，仅 DEBUG）；接收循环**不知情**，下一轮 ``receive_json()``
    因状态检查抛 ``RuntimeError('WebSocket is not connected…')``。该连接**早已失效**，
    属预期收尾：接收循环应视同断线退出，不得按 ERROR + Traceback 上报。
    """
    return websocket.application_state is WebSocketState.DISCONNECTED


def _allowed_origins() -> frozenset[str]:
    """白名单（netloc，小写去空白）。"""
    raw = os.environ.get(ALLOWED_ORIGINS_ENV, "")
    return frozenset(o.strip().lower() for o in raw.split(",") if o.strip())


def origin_allowed(websocket: WebSocket) -> bool:
    """WS 升级请求是否允许：无 Origin 放行；否则同源或白名单命中。"""
    origin = websocket.headers.get("origin")
    if not origin:
        return True
    host = (websocket.headers.get("host") or "").strip().lower()
    try:
        netloc = (urlsplit(origin).netloc or "").lower()
    except ValueError:
        return False
    if not netloc:
        return False
    if host and host == netloc:
        return True
    return netloc in _allowed_origins()
