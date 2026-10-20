# tGo 后端

基于 FastAPI + asyncio + SQLite 的 KataGo 围棋对弈与 AI 分析平台后端。

## 目录结构

严格遵循 [ARCHITECTURE.md](../docs/ARCHITECTURE.md) §2：

```text
backend/
├── app/
│   ├── main.py                 # FastAPI 工厂、lifespan、静态托管
│   ├── config.py               # config.yaml 加载/保存（Pydantic 模型）
│   ├── core/                   # FSM、统一错误码、日志
│   ├── engine/                 # KataGo Analysis 引擎封装
│   ├── db/                     # aiosqlite、迁移、仓储
│   ├── services/               # 领域服务
│   ├── api/                    # REST/WS 路由
│   └── ws/                     # WS 会话管理
├── tests/                      # pytest 测试（严禁真实 KataGo/GPU）
├── requirements.txt            # 运行依赖
└── requirements-dev.txt        # 测试依赖
```

## 安装与运行

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux
source .venv/bin/activate

pip install -r requirements-dev.txt
pytest                        # 运行全部测试
uvicorn app.main:create_app --factory --reload
```
