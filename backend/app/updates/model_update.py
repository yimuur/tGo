"""官方模型列表解析与安装（katagotraining.org / KataGo 官方 Release）。"""

from __future__ import annotations

import gzip
import os
import shutil
import time
from pathlib import Path
from typing import Optional

from app.updates.common import (
    HUMAN_MODEL_NAME,
    UpdateError,
    human_model_url,
    model_compatibility,
    parse_model_elos,
    parse_model_highlights,
    parse_model_names,
    safe_relative_path,
    standard_model_url,
    valid_model_name,
)


def parse_remote_models(
    home_html: str,
    index_html: str,
    *,
    engine_version: Optional[str],
    limit: int = 30,
) -> dict:
    """官方页面 → 标准模型列表 + 人类模型（含当前引擎兼容性提示）。"""
    highlights = parse_model_highlights(home_html)
    elos = parse_model_elos((index_html or "") + "\n" + (home_html or ""))
    # 首页包含 Latest/Strongest 链接；网络列表页提供更完整的顺序。
    names = parse_model_names((home_html or "") + "\n" + (index_html or ""), limit=limit)
    if not names:
        raise UpdateError("NETWORK_ERROR", "官方模型列表解析失败（页面结构可能已变化）")
    standard = []
    for name in names:
        standard.append(
            {
                "name": name,
                "url": standard_model_url(name),
                "kind": "standard",
                "latest": name == highlights.get("latest"),
                "strongest": name == highlights.get("strongest"),
                "elo": elos.get(name),
                **model_compatibility(name, engine_version),
            }
        )
    return {
        "standard": standard,
        "human": {
            "name": HUMAN_MODEL_NAME,
            "url": human_model_url(),
            "kind": "human",
            "required": None,
            "compatible": None,
        },
        "highlights": highlights,
    }


def verify_model_gzip(path: str | os.PathLike[str]) -> int:
    """校验 gzip 可读并返回解压后字节数（仅读取头部，避免大模型全量解压）。"""
    try:
        with gzip.open(path, "rb") as fp:
            sample = fp.read(64 * 1024)
    except (OSError, EOFError) as exc:
        raise UpdateError("CHECKSUM_MISMATCH", f"模型文件损坏（gzip 校验失败）：{exc}") from None
    if not sample:
        raise UpdateError("CHECKSUM_MISMATCH", "模型文件为空")
    return len(sample)


def install_model(
    download_path: str | os.PathLike[str],
    model_dir: str | os.PathLike[str],
    name: str,
    *,
    backup_root: str | os.PathLike[str],
) -> dict:
    """校验后原子落盘（覆盖同名模型前备份）。"""
    if not valid_model_name(name):
        raise UpdateError("INVALID_PAYLOAD", "模型文件名不合法")
    source = Path(download_path)
    target = Path(model_dir) / safe_relative_path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    backup_path: Optional[Path] = None
    if target.exists():
        backup_dir = Path(backup_root) / "models"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / f"{name}.{time.strftime('%Y%m%d-%H%M%S')}"
        try:
            shutil.move(str(target), str(backup_path))
        except OSError as exc:
            raise UpdateError("UPDATE_FAILED", f"旧模型备份失败：{exc}") from None
    try:
        os.replace(source, target)
    except OSError as exc:
        if backup_path is not None:
            try:
                shutil.move(str(backup_path), str(target))
            except OSError:
                pass
        raise UpdateError("UPDATE_FAILED", f"模型写入失败：{exc}") from None
    return {
        "name": name,
        "path": str(target),
        "size": target.stat().st_size,
        "backup": str(backup_path) if backup_path is not None else None,
    }


__all__ = ["install_model", "parse_remote_models", "verify_model_gzip"]
