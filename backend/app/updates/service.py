"""更新/下载任务编排（管理页「版本与资源」卡的后端服务）。

- 所有网络/磁盘重活经 ``asyncio.to_thread``，不阻塞事件循环；
- 单任务串行（``_inflight``）：应用更新与引擎/模型下载互斥，避免同时改写磁盘；
- 进度经 ``/ws/admin`` 的 ``admin.task`` 推送（``status=running``，可选 ``progress``），
  完成/失败沿用既有 ``done``/``failed`` 语义（API 向后兼容）；
- 应用更新仅在非 Docker 部署可用；引擎/模型下载在 Docker 内仍可写入挂载目录。
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from app.config import AppConfig, ConfigError, engine_path
from app.core.errors import AppError, ErrorCode
from app.engine.manager import resolve_executable
from app.updates import common as up
from app.updates.app_update import apply_app_update, run_pip_install, schedule_restart
from app.updates.engine_update import install_engine, normalize_releases, recommended_asset
from app.updates.model_update import install_model, parse_remote_models, verify_model_gzip
from app.version import APP_NAME, APP_VERSION, github_repo

logger = logging.getLogger(__name__)

CACHE_TTL_S = 600.0
ENGINE_VERSION_TTL_S = 60.0
PROGRESS_PUSH_INTERVAL_S = 0.5

TaskOperation = Callable[[], Awaitable[str]]
AfterSuccess = Callable[[], Awaitable[None]]


class UpdateService:
    """更新任务状态机（单实例挂在 ``AppServices.updates``）。"""

    def __init__(
        self,
        *,
        root: str | os.PathLike[str] | None = None,
        deployment_mode: Optional[str] = None,
    ) -> None:
        self._root = Path(root) if root is not None else None
        self._mode = deployment_mode
        self._inflight: Optional[asyncio.Task] = None
        self._state: dict[str, Any] = {
            "task": None,
            "status": "idle",
            "progress": None,
            "message": None,
            "updatedAt": None,
        }
        self._app_cache: Optional[tuple[float, dict]] = None
        self._kata_cache: Optional[tuple[float, list[dict]]] = None
        self._model_pages_cache: Optional[tuple[float, tuple[str, str]]] = None
        self._engine_version_cache: Optional[tuple[float, str, Optional[str]]] = None
        self._restart_install_deps = False

    # ---------------- 基础访问 ----------------

    @property
    def root(self) -> Path:
        return self._root if self._root is not None else up.project_root()

    @property
    def deployment_mode(self) -> str:
        return self._mode if self._mode is not None else up.detect_deployment_mode()

    def status(self) -> dict:
        return dict(self._state)

    def _updates_dir(self) -> Path:
        base = self.root / "data" / "updates"
        for child in ("downloads", "staging", "backups"):
            (base / child).mkdir(parents=True, exist_ok=True)
        return base

    # ---------------- 任务编排 ----------------

    def _ensure_idle(self) -> None:
        if self._inflight is not None and not self._inflight.done():
            raise AppError(ErrorCode.UPDATE_IN_PROGRESS, "已有更新/下载任务正在执行")

    def _spawn(
        self,
        svc,
        task: str,
        operation: TaskOperation,
        *,
        after_success: Optional[AfterSuccess] = None,
    ) -> None:
        self._ensure_idle()
        self._state.update(
            task=task,
            status="running",
            progress=0,
            message="任务已受理…",
            updatedAt=time.time(),
        )
        self._inflight = asyncio.create_task(
            self._run(svc, task, operation, after_success), name=f"update-{task}"
        )

    async def _run(
        self,
        svc,
        task: str,
        operation: TaskOperation,
        after_success: Optional[AfterSuccess],
    ) -> None:
        pusher = asyncio.create_task(self._progress_pusher(svc, task))
        try:
            detail = await operation()
            self._state.update(
                status="done", progress=100, message=detail, updatedAt=time.time()
            )
            await self._broadcast(
                svc,
                {
                    "task": task,
                    "status": "done",
                    "progress": 100,
                    "message": detail,
                },
            )
            if after_success is not None:
                try:
                    await after_success()
                except Exception:  # noqa: BLE001 - 已完成更新；重启编排失败只记日志
                    logger.exception("更新完成后的重启编排失败（请手动重启服务）")
        except asyncio.CancelledError:
            raise
        except AppError as exc:
            await self._fail(svc, task, exc.code.value, exc.message)
        except up.UpdateError as exc:
            await self._fail(svc, task, exc.code, exc.message)
        except Exception as exc:  # noqa: BLE001 - 后台任务兜底：推送失败结果，不泄露 Traceback
            logger.exception("更新任务失败（%s）", task)
            await self._fail(svc, task, ErrorCode.INTERNAL_ERROR.value, f"任务失败：{exc}")
        finally:
            pusher.cancel()
            try:
                await pusher
            except asyncio.CancelledError:
                pass
            self._inflight = None

    async def _fail(self, svc, task: str, code: str, message: str) -> None:
        self._state.update(
            status="failed", message=message, updatedAt=time.time()
        )
        await self._broadcast(
            svc,
            {"task": task, "status": "failed", "code": code, "message": message},
        )

    async def _progress_pusher(self, svc, task: str) -> None:
        last: tuple[Any, ...] = ()
        while True:
            await asyncio.sleep(PROGRESS_PUSH_INTERVAL_S)
            if self._state.get("status") != "running":
                continue
            snapshot = (
                self._state.get("progress"),
                self._state.get("message"),
            )
            if snapshot == last:
                continue
            last = snapshot
            try:
                await self._broadcast(
                    svc,
                    {
                        "task": task,
                        "status": "running",
                        "progress": self._state.get("progress"),
                        "message": self._state.get("message") or "处理中…",
                    },
                )
            except Exception:  # noqa: BLE001 - 进度推送失败不应中断任务
                logger.debug("更新进度推送失败（已忽略）", exc_info=True)

    async def _broadcast(self, svc, data: dict) -> None:
        await svc.session.broadcast_to_admin({"type": "admin.task", "data": data})

    def _update_progress(self, percent: Optional[int], message: str) -> None:
        self._state["progress"] = percent
        self._state["message"] = message
        self._state["updatedAt"] = time.time()

    def _progress_callback(self, loop: asyncio.AbstractEventLoop, prefix: str):
        last = {"percent": -1}

        def callback(done: int, total: int) -> None:
            percent = int(done * 100 / total) if total > 0 else None
            if percent is not None and percent == last["percent"]:
                return
            last["percent"] = percent
            text = f"{prefix} {up.human_size(done)}"
            if total > 0:
                text += f" / {up.human_size(total)}"
            loop.call_soon_threadsafe(self._update_progress, percent, text)

        return callback

    # ---------------- 信息 ----------------

    async def app_info(self, svc) -> dict:
        cfg: AppConfig = svc.config
        executable = self._executable(cfg)
        engine_version = await self._current_engine_version(cfg)
        mode = self.deployment_mode
        models = self._local_models(cfg)
        platform_info = up.platform_summary()
        return {
            "app": {
                "name": APP_NAME,
                "version": APP_VERSION,
                "repo": github_repo(),
                "releaseUrl": f"https://github.com/{github_repo()}/releases",
            },
            "platform": platform_info,
            "deployment": {
                "mode": mode,
                "updateSupported": mode != "docker",
                "reason": (
                    "容器部署：应用更新不持久，请拉取新镜像后重建容器"
                    if mode == "docker"
                    else None
                ),
            },
            "capabilities": {
                "appUpdate": mode != "docker",
                "engineDownload": platform_info["tag"] is not None,
                "modelDownload": True,
            },
            "engine": {
                "installed": executable is not None,
                "version": engine_version,
                "executable": str(executable) if executable is not None else None,
            },
            "models": models,
            "task": self.status(),
        }

    def _executable(self, cfg: AppConfig) -> Optional[Path]:
        try:
            return resolve_executable(engine_path(cfg.engine.executable_dir))
        except ConfigError:
            return None

    async def _current_engine_version(self, cfg: AppConfig) -> Optional[str]:
        executable = self._executable(cfg)
        if executable is None:
            return None
        try:
            mtime = executable.stat().st_mtime
        except OSError:
            mtime = 0.0
        cache = self._engine_version_cache
        now = time.monotonic()
        if (
            cache is not None
            and now - cache[0] < ENGINE_VERSION_TTL_S
            and cache[1] == str(executable)
        ):
            return cache[2]
        version = await asyncio.to_thread(up.run_engine_version, executable)
        self._engine_version_cache = (now, str(executable), version)
        # mtime 仅用于将来扩展（当前不参与缓存键；保留防御性读取）
        _ = mtime
        return version

    def _local_models(self, cfg: AppConfig) -> dict:
        model_dir = engine_path(cfg.engine.model_dir)
        standard: list[dict] = []
        human: list[dict] = []
        if model_dir.is_dir():
            for path in sorted(model_dir.glob("*.bin.gz")):
                entry = {
                    "name": path.name,
                    "size": path.stat().st_size,
                    "human": "human" in path.name.lower(),
                }
                (human if entry["human"] else standard).append(entry)
        default = cfg.engine.standard_model or (standard[0]["name"] if standard else None)
        human_name = cfg.engine.human_model or (human[0]["name"] if human else None)
        return {
            "standard": standard,
            "human": human,
            "default": default,
            "humanModel": human_name,
            "dir": str(model_dir),
        }

    # ---------------- 应用更新 ----------------

    async def check_app_update(self, *, force: bool = False) -> dict:
        now = time.monotonic()
        if not force and self._app_cache is not None and now - self._app_cache[0] < CACHE_TTL_S:
            return self._app_cache[1]
        mode = self.deployment_mode
        supported = mode != "docker"
        result: dict[str, Any] = {
            "currentVersion": APP_VERSION,
            "repo": github_repo(),
            "deploymentMode": mode,
            "supported": supported,
            "updateAvailable": False,
            "latest": None,
            "message": None,
        }
        if not supported:
            result["message"] = "容器部署不支持页内自更新，请拉取新镜像后重建容器"
            result["reason"] = "container"
            self._app_cache = (now, result)
            return result
        try:
            release = await asyncio.to_thread(
                up.fetch_json, up.repo_url("/releases/latest")
            )
        except up.UpdateError as exc:
            if exc.code == "ASSET_NOT_FOUND":
                result["message"] = "GitHub 仓库尚未发布任何 Release"
                self._app_cache = (now, result)
                return result
            raise
        summary = up.app_release_summary(release)
        result["latest"] = summary
        result["updateAvailable"] = up.is_newer(summary["version"], APP_VERSION)
        if result["updateAvailable"] and summary["asset"] is None:
            result["supported"] = False
            result["reason"] = "release_asset_missing"
            result["message"] = "新版本未附带 tGo-Setup 更新包，无法自动更新"
        elif result["updateAvailable"]:
            result["message"] = f"发现新版本 v{summary['version']}"
        else:
            result["message"] = "当前已是最新版本"
        self._app_cache = (now, result)
        return result

    async def start_app_update(
        self, svc, *, version: Optional[str] = None
    ) -> dict:
        if self.deployment_mode == "docker":
            raise AppError(
                ErrorCode.UPDATE_UNSUPPORTED,
                "容器部署不支持页内自更新，请拉取新镜像后重建容器",
            )
        self._ensure_idle()
        self._app_cache = None
        self._spawn(
            svc,
            "app_update",
            lambda: self._app_update_operation(version),
            after_success=lambda: self._schedule_restart_after_update(svc),
        )
        return {"message": "应用更新已受理", "task": "app_update"}

    async def _schedule_restart_after_update(self, svc) -> None:
        # 先让 done 推送落地；`os._exit` 会跳过 lifespan，故显式释放引擎/分析/数据库。
        await asyncio.sleep(1.0)
        for name, release in (
            ("引擎", svc.manager.stop if svc.manager is not None else None),
            ("分析 worker", svc.analysis.stop),
            ("数据库", svc.db.close),
        ):
            if release is None:
                continue
            try:
                await release()
            except Exception:  # noqa: BLE001 - 关停尽力而为，不得阻断重启
                logger.warning("更新重启前释放失败（%s，已继续）", name, exc_info=True)
        install_deps = self._restart_install_deps
        self._restart_install_deps = False
        schedule_restart(delay_s=1.0, install_deps=install_deps, root=self.root)

    async def _app_update_operation(self, version: Optional[str]) -> str:
        check = await self.check_app_update(force=True)
        latest = check.get("latest")
        if not check.get("updateAvailable") or not latest:
            return str(check.get("message") or "当前已是最新版本")
        if version and up.normalize_tag(version) != latest["version"]:
            raise up.UpdateError("INVALID_PAYLOAD", "目标版本已变化，请重新检查更新")
        asset = latest.get("asset")
        if not asset or not asset.get("url"):
            raise up.UpdateError(
                "UPDATE_UNSUPPORTED", "新版本未附带 tGo-Setup 更新包，无法自动更新"
            )
        expected_prefix = f"https://github.com/{github_repo()}/releases/download/"
        if not str(asset["url"]).startswith(expected_prefix):
            raise up.UpdateError("ASSET_NOT_FOUND", "更新包地址不在官方 Release 范围内")
        tag = latest["version"]
        updates = self._updates_dir()
        archive = updates / "downloads" / f"tGo-Setup-{tag}.zip"
        loop = asyncio.get_running_loop()
        await asyncio.to_thread(
            up.download_file,
            asset["url"],
            archive,
            on_progress=self._progress_callback(loop, "下载更新包"),
            expected_sha256=asset.get("digest"),
        )
        self._update_progress(None, "解压更新包…")
        staging = updates / "staging" / f"app-{tag}-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.rmtree(staging, ignore_errors=True)
        await asyncio.to_thread(up.safe_extract_zip, archive, staging)
        payload = up.payload_root(staging, "required-files.txt")
        self._update_progress(None, "备份并覆盖运行文件…")
        result = await asyncio.to_thread(
            apply_app_update,
            payload,
            self.root,
            backup_root=updates / "backups",
            from_version=APP_VERSION,
            to_version=tag,
        )
        self._update_progress(100, f"已更新到 v{tag}")
        install_deps = bool(result.requirements_changed)
        dependency_note = ""
        if install_deps and self.deployment_mode == "systemd":
            # systemd 直接拉起 launcher（不经过 deploy.sh），故退出前先安装
            self._update_progress(99, "安装新版本依赖…")
            installed = await asyncio.to_thread(run_pip_install, self.root)
            dependency_note = "；依赖已安装" if installed else "；依赖安装失败，请手动执行 pip install"
            install_deps = False
        self._restart_install_deps = install_deps
        return (
            f"应用已更新到 v{tag}（备份：{result.backup_dir.name}）{dependency_note}，"
            "服务即将重启"
        )

    # ---------------- KataGo 引擎 ----------------

    async def _fetch_kata_releases(self, *, force: bool = False) -> list[dict]:
        now = time.monotonic()
        if not force and self._kata_cache is not None and now - self._kata_cache[0] < CACHE_TTL_S:
            return self._kata_cache[1]
        tag_platform = up.platform_tag()
        if tag_platform is None:
            self._kata_cache = (now, [])
            return []
        raw = await asyncio.to_thread(
            up.fetch_json,
            f"{up.GITHUB_API}/repos/{up.KATAGO_REPO}/releases?per_page=10",
        )
        items = normalize_releases(raw if isinstance(raw, list) else [], tag_platform)
        self._kata_cache = (now, items)
        return items

    async def list_engine_releases(self, svc, *, force: bool = False) -> dict:
        tag_platform = up.platform_tag()
        current = await self._current_engine_version(svc.config)
        if tag_platform is None:
            return {
                "supported": False,
                "platform": up.platform_summary(),
                "currentVersion": current,
                "releases": [],
                "recommended": None,
                "message": "当前平台/架构暂无 KataGo 官方预编译包（仅支持 Windows/Linux x64）",
            }
        items = await self._fetch_kata_releases(force=force)
        selected = recommended_asset(items, tag_platform)
        return {
            "supported": bool(items),
            "platform": up.platform_summary(),
            "currentVersion": current,
            "releases": items,
            "recommended": (
                {"tag": selected["release"]["tag"], "asset": selected["asset"]["name"]}
                if selected
                else None
            ),
            "message": None if items else "未找到当前平台的 KataGo 官方资产",
        }

    async def start_engine_download(self, svc, release_tag: str, asset_name: str) -> dict:
        self._ensure_idle()
        self._spawn(
            svc,
            "engine_download",
            lambda: self._engine_download_operation(svc, release_tag, asset_name),
        )
        return {"message": "KataGo 下载已受理", "task": "engine_download"}

    async def _engine_download_operation(
        self, svc, release_tag: str, asset_name: str
    ) -> str:
        tag_platform = up.platform_tag()
        if tag_platform is None:
            raise up.UpdateError("UNSUPPORTED_PLATFORM", "当前平台暂无 KataGo 官方预编译包")
        items = await self._fetch_kata_releases(force=True)
        release = next((item for item in items if item["tag"] == release_tag), None)
        if release is None:
            raise up.UpdateError("ASSET_NOT_FOUND", f"未找到 KataGo Release {release_tag}")
        asset = next((a for a in release["assets"] if a["name"] == asset_name), None)
        if asset is None:
            raise up.UpdateError("ASSET_NOT_FOUND", f"未找到资产 {asset_name}")
        if not str(asset.get("url") or "").startswith(
            f"https://github.com/{up.KATAGO_REPO}/releases/download/"
        ):
            raise up.UpdateError("ASSET_NOT_FOUND", "引擎资产地址不在官方仓库范围内")

        updates = self._updates_dir()
        archive = updates / "downloads" / asset["name"]
        loop = asyncio.get_running_loop()
        await asyncio.to_thread(
            up.download_file,
            asset["url"],
            archive,
            on_progress=self._progress_callback(loop, "下载 KataGo"),
            expected_sha256=asset.get("digest"),
        )
        self._update_progress(None, "解压 KataGo…")
        staging = updates / "staging" / f"kata-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.rmtree(staging, ignore_errors=True)
        await asyncio.to_thread(up.safe_extract_zip, archive, staging)

        manager = svc.manager
        was_running = bool(manager is not None and manager.engine.is_running)
        if manager is not None and manager.engine.is_running:
            self._update_progress(None, "停止引擎以替换可执行文件…")
            await manager.stop_engine()
        self._update_progress(None, "安装 KataGo 文件…")
        result = await asyncio.to_thread(
            install_engine,
            staging,
            engine_path(svc.config.engine.executable_dir),
            backup_root=updates / "backups",
            tag_platform=tag_platform,
        )
        self._engine_version_cache = None
        self._kata_cache = None

        notes: list[str] = [f"KataGo {release_tag} 已安装（{asset['name']}）"]
        if manager is None:
            try:
                await svc.ensure_engine_manager()
                manager = svc.manager
            except ConfigError as exc:
                notes.append(f"引擎暂不可用：{exc}")
        if was_running and manager is not None:
            try:
                await manager.ensure_ready(reset_fatal=True, reason="引擎更新")
                notes.append("引擎已重新启动")
            except AppError as exc:
                notes.append(f"引擎重启失败：{exc.message}")
        return "；".join(notes) + f"（备份：{Path(result['backup']).name}）"

    # ---------------- 官方模型 ----------------

    async def _fetch_model_pages(self, *, force: bool = False) -> tuple[str, str]:
        now = time.monotonic()
        if (
            not force
            and self._model_pages_cache is not None
            and now - self._model_pages_cache[0] < CACHE_TTL_S
        ):
            return self._model_pages_cache[1]
        results = await asyncio.gather(
            asyncio.to_thread(up.fetch_text, up.MODEL_SITE),
            asyncio.to_thread(up.fetch_text, up.MODEL_INDEX_URL),
            return_exceptions=True,
        )
        home = results[0] if isinstance(results[0], str) else ""
        index = results[1] if isinstance(results[1], str) else ""
        if not home and not index:
            error = results[0] if isinstance(results[0], Exception) else results[1]
            if isinstance(error, up.UpdateError):
                raise error
            raise up.UpdateError("NETWORK_ERROR", "官方模型站点不可用")
        pages = (home, index)
        self._model_pages_cache = (now, pages)
        return pages

    async def list_remote_models(self, svc, *, force: bool = False) -> dict:
        engine_version = await self._current_engine_version(svc.config)
        home, index = await self._fetch_model_pages(force=force)
        payload = parse_remote_models(home, index, engine_version=engine_version)
        payload["engineVersion"] = engine_version
        payload["source"] = up.MODEL_SITE
        return payload

    async def start_model_download(self, svc, kind: str, name: str) -> dict:
        if kind not in ("standard", "human"):
            raise AppError(ErrorCode.INVALID_PAYLOAD, "模型类型仅支持 standard/human")
        if not up.valid_model_name(name):
            raise AppError(ErrorCode.INVALID_PAYLOAD, "模型文件名不合法")
        if kind == "human" and name != up.HUMAN_MODEL_NAME:
            raise AppError(ErrorCode.INVALID_PAYLOAD, "人类模型文件名须为官方 humanv0 模型")
        self._ensure_idle()
        self._spawn(
            svc,
            "model_download",
            lambda: self._model_download_operation(svc, kind, name),
        )
        return {"message": "模型下载已受理", "task": "model_download"}

    async def _model_download_operation(self, svc, kind: str, name: str) -> str:
        url = up.human_model_url() if kind == "human" else up.standard_model_url(name)
        model_dir = engine_path(svc.config.engine.model_dir)
        model_dir.mkdir(parents=True, exist_ok=True)
        temporary = model_dir / f".{name}.part"
        temporary.unlink(missing_ok=True)
        loop = asyncio.get_running_loop()
        try:
            await asyncio.to_thread(
                up.download_file,
                url,
                temporary,
                on_progress=self._progress_callback(loop, "下载模型"),
                max_bytes=up.MAX_DOWNLOAD_BYTES,
            )
            self._update_progress(None, "校验模型文件…")
            await asyncio.to_thread(verify_model_gzip, temporary)
            self._update_progress(None, "安装模型…")
            result = await asyncio.to_thread(
                install_model,
                temporary,
                model_dir,
                name,
                backup_root=self._updates_dir() / "backups",
            )
        finally:
            temporary.unlink(missing_ok=True)
        engine_version = await self._current_engine_version(svc.config)
        compatibility = up.model_compatibility(name, engine_version)
        note = ""
        if compatibility.get("compatible") is False:
            note = f"；注意：该模型需要 KataGo ≥ {compatibility['required']}，当前为 {engine_version}"
        self._update_progress(100, f"模型已下载：{name}")
        return (
            f"模型已下载：{name}（{up.human_size(result['size'])}）{note}；"
            "如需启用，请在模型卡设为默认并重启引擎"
        )


__all__ = ["UpdateService"]
