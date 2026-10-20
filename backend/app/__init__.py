"""tGo 后端应用包。

模块分层（严格按 ARCHITECTURE.md 隔离）：
- core/      跨层基础设施：FSM、统一错误、日志
- engine/    KataGo Analysis 引擎封装（生命周期/查询构建）
- db/        SQLite 数据访问（aiosqlite、迁移、仓储）
- services/  领域服务（对局/分析/复盘/报告/自适应/SGF）
- api/       REST 路由与 WebSocket 通道（Pydantic 强校验）
- ws/        按 game_id 分组的连接管理与广播
"""
