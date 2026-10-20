"""应用自更新 / KataGo 与模型下载（管理页「版本与资源」卡）。

模块划分：
- ``common``：HTTP、版本比较、平台识别、部署形态、路径与压缩包安全工具；
- ``app_update``：应用更新包的选择、校验、备份、覆盖与回滚；
- ``engine_update``：KataGo 官方 Release 资产筛选、解压与安装；
- ``model_update``：官方模型列表解析、下载校验与落盘；
- ``service``：异步任务编排、进度状态与 WS 推送（``admin.task``）。
"""

from app.updates.service import UpdateService

__all__ = ["UpdateService"]
