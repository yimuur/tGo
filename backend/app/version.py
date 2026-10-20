"""应用版本与更新源常量（单一事实源）。

- ``APP_VERSION`` 由发布流程在打 tag 时同步更新（tag 形如 ``v1.2.3``）；
- 自动更新以 GitHub Releases 的 tag 作为版本基准，比较时忽略前缀 ``v``；
- 仓库地址可用环境变量 ``TGO_GITHUB_REPO`` 覆盖（fork/私有镜像部署）。
"""

from __future__ import annotations

import os

APP_NAME = "tGo"

#: 当前应用版本（与 GitHub Release tag 对齐，例如 0.1.0 ↔ v0.1.0）
APP_VERSION = "1.0.0"
#: 默认更新源仓库（owner/name）
DEFAULT_GITHUB_REPO = "yimuur/tGo"


def github_repo() -> str:
    """返回更新源仓库（环境变量优先，便于 fork/镜像部署）。"""
    value = os.environ.get("TGO_GITHUB_REPO", "").strip()
    return value or DEFAULT_GITHUB_REPO
