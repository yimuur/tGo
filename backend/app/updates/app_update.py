"""应用更新包：清单校验、备份、覆盖与回滚、进程重启编排。

更新语义（人工决策 2026/10/18）：
- 仅覆盖发布包清单内的运行文件 + 随包脚本/文档；
- ``config.yaml`` / ``data/`` / ``logs/`` / ``engine/`` / ``backend/.venv/`` 一律保留；
- 覆盖前逐文件备份到 ``data/updates/backups/app-<版本>-<时间>/``，失败自动回滚；
- 成功后按部署形态重启：systemd 以非零退出交 ``Restart=on-failure``；源码部署由
  分离的辅助进程等待旧进程退出后重新拉起 ``python -m app.launcher``。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.updates.common import (
    UpdateError,
    detect_deployment_mode,
    project_root,
    safe_relative_path,
)

#: 发布包内清单之外的随包文件（缺失则跳过，保持向后兼容）
SUPPORT_FILES: tuple[str, ...] = (
    "required-files.txt",
    "start.bat",
    "start.ps1",
    "deploy.sh",
    "tgo.service",
    "README.md",
    "DEPLOYMENT.md",
    ".dockerignore",
    "docker-compose.yml",
    "tools/Dockerfile",
    "tools/docker-build.ps1",
    "tools/docker-entrypoint.sh",
)

#: 更新包必须具备的最小文件（防止误用源码 zipball/不完整包）
REQUIRED_MARKERS: tuple[str, ...] = (
    "backend/app/main.py",
    "frontend/static/index.html",
)

APP_BACKUP_KEEP = 3


@dataclass(frozen=True)
class UpdateFile:
    relative: str
    source: Path


@dataclass(frozen=True)
class ApplyResult:
    backup_dir: Path
    applied: tuple[str, ...]
    created: tuple[str, ...]
    #: requirements.txt 内容是否变化（重启前需安装依赖）
    requirements_changed: bool = False


def read_manifest(payload_root: Path) -> list[str]:
    """读取发布包清单（UTF-8，容忍 BOM；忽略注释/空行）。"""
    manifest = payload_root / "required-files.txt"
    if not manifest.is_file():
        raise UpdateError("ASSET_NOT_FOUND", "更新包缺少 required-files.txt 清单")
    try:
        text = manifest.read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise UpdateError("UPDATE_FAILED", f"更新包清单读取失败：{exc}") from None
    entries = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    if not entries:
        raise UpdateError("UPDATE_FAILED", "更新包清单为空")
    for marker in REQUIRED_MARKERS:
        if marker not in entries:
            raise UpdateError("UPDATE_FAILED", f"更新包不完整（清单缺少 {marker}）")
    return entries


def collect_update_files(payload_root: Path) -> list[UpdateFile]:
    """组装待覆盖文件（清单 + 存在的随包文件）。"""
    entries = read_manifest(payload_root)
    seen: set[str] = set()
    files: list[UpdateFile] = []
    for relative in list(entries) + list(SUPPORT_FILES):
        safe = safe_relative_path(relative)
        key = safe.as_posix()
        if key in seen:
            continue
        source = payload_root / safe
        if not source.is_file():
            # 清单内缺失＝包损坏（快速失败）；随包文件缺失＝旧版本兼容（跳过）
            if relative in entries:
                raise UpdateError("UPDATE_FAILED", f"更新包缺少清单文件：{key}")
            continue
        seen.add(key)
        files.append(UpdateFile(relative=key, source=source))
    return files


def _copy_backup(source: Path, backup_root: Path, relative: str) -> None:
    target = backup_root / safe_relative_path(relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def _restore(backup_dir: Path, target_root: Path, applied: list[str], created: set[str]) -> None:
    for relative in reversed(applied):
        destination = target_root / safe_relative_path(relative)
        try:
            if relative in created:
                destination.unlink(missing_ok=True)
            else:
                backup = backup_dir / safe_relative_path(relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(backup, destination)
        except OSError:
            # 回滚尽力而为：单个文件失败不阻断其余文件恢复
            continue


def apply_app_update(
    payload_root: str | Path,
    target_root: str | Path,
    *,
    backup_root: str | Path,
    from_version: str,
    to_version: str,
) -> ApplyResult:
    """覆盖运行文件（带逐文件备份与失败回滚）。"""
    payload = Path(payload_root)
    target = Path(target_root)
    backups = Path(backup_root)
    files = collect_update_files(payload)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir = backups / f"app-{to_version or 'unknown'}-{stamp}"
    applied: list[str] = []
    created: set[str] = set()
    requirements_changed = False
    try:
        for item in files:
            destination = target / item.relative
            if item.relative == "backend/requirements.txt":
                try:
                    requirements_changed = (
                        not destination.exists()
                        or destination.read_bytes() != item.source.read_bytes()
                    )
                except OSError:
                    requirements_changed = True
            if destination.exists():
                _copy_backup(destination, backup_dir, item.relative)
            else:
                created.add(item.relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + ".tgo-new")
            shutil.copy2(item.source, temporary)
            os.replace(temporary, destination)
            applied.append(item.relative)
    except OSError as exc:
        _restore(backup_dir, target, applied, created)
        raise UpdateError("UPDATE_FAILED", f"应用更新失败（已回滚）：{exc}") from None

    if os.name != "nt":
        # Windows 打出的 zip 常丢执行位；随包脚本在 Linux 部署下需保持可执行
        for script in ("deploy.sh", "tools/docker-entrypoint.sh"):
            path = target / script
            if path.is_file():
                try:
                    path.chmod(path.stat().st_mode | 0o111)
                except OSError:
                    pass

    backup_dir.mkdir(parents=True, exist_ok=True)
    (backup_dir / "update.json").write_text(
        json.dumps(
            {
                "fromVersion": from_version,
                "toVersion": to_version,
                "applied": applied,
                "created": sorted(created),
                "appliedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    prune_backups(backups, prefix="app-", keep=APP_BACKUP_KEEP)
    return ApplyResult(
        backup_dir=backup_dir,
        applied=tuple(applied),
        created=tuple(created),
        requirements_changed=requirements_changed,
    )


def prune_backups(root: str | Path, *, prefix: str, keep: int) -> None:
    """仅保留最近 ``keep`` 份同前缀备份。"""
    base = Path(root)
    if not base.is_dir():
        return
    entries = sorted(
        (p for p in base.iterdir() if p.is_dir() and p.name.startswith(prefix)),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for stale in entries[keep:]:
        shutil.rmtree(stale, ignore_errors=True)


def restart_mode() -> str:
    """重启方式：``docker``（不支持）/ ``systemd`` / ``detached``。"""
    mode = detect_deployment_mode()
    if mode == "docker":
        return "docker"
    if mode == "systemd":
        return "systemd"
    return "detached"


def _launcher_args() -> list[str]:
    """当前进程经 launcher 启动时沿用其参数（``--open``/``--new`` 等）。"""
    argv = list(getattr(sys, "orig_argv", sys.argv))
    if "app.launcher" in argv:
        index = argv.index("app.launcher")
        return argv[index + 1 :]
    return []


#: 分离的重启辅助进程（不 import 应用模块——更新期间代码文件可能刚被替换）
_RESTART_HELPER = r"""
import ctypes, json, os, subprocess, sys, time

def process_alive(pid):
    if os.name != "nt":
        # POSIX: signal 0 仅做存在性检查
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    # Windows: os.kill(pid, 0) 中的 0 等于 CTRL_C_EVENT，会向控制台进程组
    # 发送 Ctrl+C（不是存活探测，且会误伤同组进程）。改用等待句柄。
    SYNCHRONIZE = 0x00100000
    WAIT_TIMEOUT = 0x00000102
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(SYNCHRONIZE, 0, pid)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)

parent_pid = int(sys.argv[1])
cwd = sys.argv[2]
log_path = sys.argv[3]
config = json.loads(sys.argv[4])
extra = config.get("launcher") or []
deadline = time.time() + float(config.get("waitTimeout", 120.0))
exited = False
while time.time() < deadline:
    if not process_alive(parent_pid):
        exited = True
        break
    time.sleep(0.5)
if os.name == "nt":
    # 进程退出后监听套接字/连接句柄可能尚未完全释放；短暂让出，避免新实例误判端口占用
    time.sleep(0.5)
if config.get("noLaunch"):
    raise SystemExit(0)
with open(log_path, "ab") as log:
    log.write(
        ("[restart-helper] parent=%s exited=%s, starting launcher\n" % (parent_pid, exited)).encode("utf-8")
    )
    log.flush()
    if config.get("installDeps"):
        # 新版本 requirements.txt 可能新增依赖；失败也继续拉起（旧依赖通常仍可运行）
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", os.path.join(cwd, "requirements.txt")],
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                timeout=900,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    command = [sys.executable, "-m", "app.launcher", *extra]
    if os.name == "nt":
        flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            close_fds=True,
            creationflags=flags,
        )
    else:
        subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            close_fds=True,
            start_new_session=True,
        )
"""


def run_pip_install(root: str | Path, *, timeout: float = 900.0) -> bool:
    """安装新版本依赖（systemd 在退出前调用；源码部署由辅助进程执行）。"""
    backend_dir = Path(root) / "backend"
    requirements = backend_dir / "requirements.txt"
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-r", str(requirements)],
            cwd=str(backend_dir),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if completed.returncode != 0:
        return False
    return True


def spawn_restart_helper(root: str | Path, *, install_deps: bool = False) -> int:
    """启动分离辅助进程，等待当前进程退出后（可选）安装依赖并重新拉起服务。"""
    base = Path(root)
    backend_dir = base / "backend"
    log_dir = base / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "update-restart.log"
    command = [
        sys.executable,
        "-c",
        _RESTART_HELPER,
        str(os.getpid()),
        str(backend_dir),
        str(log_path),
        json.dumps({"launcher": _launcher_args(), "installDeps": bool(install_deps)}),
    ]
    kwargs: dict = {
        "cwd": str(backend_dir),
        "env": os.environ.copy(),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        kwargs["stdout"] = subprocess.DEVNULL
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)
    return process.pid


def schedule_restart(
    *, delay_s: float = 1.0, install_deps: bool = False, root: str | Path | None = None
) -> str:
    """安排进程退出以触发重启（响应/WS 先落地），返回重启方式。

    ``install_deps``：仅源码部署交给辅助进程执行 ``pip install``；systemd 路径
    需调用方在退出前自行安装（见 ``run_pip_install``）。
    """
    mode = restart_mode()
    if mode == "docker":
        raise UpdateError("UPDATE_UNSUPPORTED", "容器部署不支持页内自更新，请拉取新镜像重建")
    loop = asyncio.get_running_loop()
    if mode == "systemd":
        # 非零退出触发 Restart=on-failure
        loop.call_later(delay_s, os._exit, 1)
        return mode
    # 源码部署：辅助进程负责重新拉起；正常退出 0，避免 start.ps1 误报启动失败
    spawn_restart_helper(root if root is not None else project_root(), install_deps=install_deps)
    loop.call_later(delay_s, os._exit, 0)
    return mode


def latest_backup(root: str | Path, *, prefix: str = "app-") -> Optional[Path]:
    base = Path(root)
    if not base.is_dir():
        return None
    entries = sorted(
        (p for p in base.iterdir() if p.is_dir() and p.name.startswith(prefix)),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return entries[0] if entries else None


__all__ = [
    "ApplyResult",
    "SUPPORT_FILES",
    "apply_app_update",
    "collect_update_files",
    "latest_backup",
    "prune_backups",
    "run_pip_install",
    "read_manifest",
    "restart_mode",
    "schedule_restart",
    "spawn_restart_helper",
]
