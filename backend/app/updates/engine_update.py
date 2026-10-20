"""KataGo 官方 Release：资产筛选与安装。

安装语义：
- 先停止引擎（Windows 下运行中的 exe 无法替换）；
- 将现有引擎目录文件移动到 ``data/updates/backups/engine-<时间>/``（跨卷安全）；
- 保留用户层 ``analysis.cfg``（引擎 cfg 分层，BUG-132），其余按新包覆盖；
- 失败自动回滚；成功保留最近 1 份备份供人工回退。
"""

from __future__ import annotations

import os
import shutil
import stat
import time
from pathlib import Path
from typing import Optional

from app.updates.app_update import prune_backups
from app.updates.common import (
    UpdateError,
    normalize_kata_release,
    payload_root,
)

PRESERVE_FILES: frozenset[str] = frozenset({"analysis.cfg"})
PRESERVE_DIRS: frozenset[str] = frozenset({"gtp_logs"})
ENGINE_BACKUP_KEEP = 1


def normalize_releases(releases: list[dict], tag_platform: Optional[str]) -> list[dict]:
    """GitHub releases → 当前平台可用条目（保持官方顺序）。"""
    if not tag_platform:
        return []
    items: list[dict] = []
    for release in releases:
        normalized = normalize_kata_release(release, tag_platform)
        if normalized is not None:
            items.append(normalized)
    return items


def recommended_asset(items: list[dict], tag_platform: Optional[str]) -> Optional[dict]:
    """推荐资产：优先 OpenCL（通用 GPU），否则取第一个可用条目。"""
    if not items or not tag_platform:
        return None
    for release in items:
        for asset in release.get("assets") or []:
            if asset.get("backend") == "opencl" and f"-{tag_platform}" in asset["name"].lower():
                return {"release": release, "asset": asset}
    first_release = items[0]
    assets = first_release.get("assets") or []
    if not assets:
        return None
    return {"release": first_release, "asset": assets[0]}


def _engine_marker(tag_platform: str) -> str:
    return "katago.exe" if tag_platform.startswith("windows") else "katago"


def _iter_files(root: Path):
    for path in sorted(root.rglob("*")):
        if path.is_file():
            yield path


def _within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def install_engine(
    payload: str | Path,
    target_dir: str | Path,
    *,
    backup_root: str | Path,
    tag_platform: str,
) -> dict:
    """安装已解压的引擎包（带备份/回滚），返回安装摘要。"""
    source_root = payload_root(Path(payload), _engine_marker(tag_platform))
    target = Path(target_dir)
    target.mkdir(parents=True, exist_ok=True)
    backups = Path(backup_root)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir = backups / f"engine-{stamp}"
    moved: list[str] = []
    created: list[str] = []

    def _preserved(relative: Path) -> bool:
        if relative.as_posix() in PRESERVE_FILES:
            return True
        return bool(relative.parts) and relative.parts[0] in PRESERVE_DIRS

    try:
        # 1) 旧文件移入备份（同卷 rename / 跨卷 move）
        for path in list(_iter_files(target)):
            relative = path.relative_to(target)
            if _preserved(relative):
                continue
            destination = backup_dir / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(destination))
            moved.append(relative.as_posix())
        # 2) 拷贝新文件（保留用户 analysis.cfg）
        for path in _iter_files(source_root):
            relative = path.relative_to(source_root)
            if _preserved(relative):
                continue
            destination = target / relative
            if not _within(destination, target):
                raise UpdateError("UPDATE_FAILED", f"引擎包包含越界路径：{relative}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
            created.append(relative.as_posix())
        # 3) Linux 执行位（AppImage/可执行文件）
        binary = target / _engine_marker(tag_platform)
        if not binary.is_file():
            matches = list(target.rglob(_engine_marker(tag_platform)))
            if not matches:
                raise UpdateError("ASSET_NOT_FOUND", "引擎包内未找到 KataGo 可执行文件")
            binary = matches[0]
        if os.name != "nt":
            mode = binary.stat().st_mode
            binary.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        # 4) 清理旧空目录（保留目标根与受保护目录）
        for directory in sorted(
            (p for p in target.rglob("*") if p.is_dir()),
            key=lambda p: len(p.parts),
            reverse=True,
        ):
            relative = directory.relative_to(target)
            if not relative.parts or relative.parts[0] in PRESERVE_DIRS:
                continue
            try:
                directory.rmdir()
            except OSError:
                pass
    except (OSError, UpdateError) as exc:
        _rollback(backup_dir, target, created, moved)
        if isinstance(exc, UpdateError):
            raise
        raise UpdateError("UPDATE_FAILED", f"引擎安装失败（已回滚）：{exc}") from None

    backup_dir.mkdir(parents=True, exist_ok=True)
    prune_backups(backups, prefix="engine-", keep=ENGINE_BACKUP_KEEP)
    return {
        "binary": str(binary),
        "backup": str(backup_dir),
        "files": len(created),
    }


def _rollback(backup_dir: Path, target: Path, created: list[str], moved: list[str]) -> None:
    for relative in reversed(created):
        try:
            (target / relative).unlink(missing_ok=True)
        except OSError:
            continue
    for relative in moved:
        source = backup_dir / relative
        destination = target / relative
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
        except OSError:
            continue


__all__ = [
    "ENGINE_BACKUP_KEEP",
    "PRESERVE_FILES",
    "install_engine",
    "normalize_releases",
    "recommended_asset",
]
