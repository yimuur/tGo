"""更新/下载纯逻辑与服务测试（UPD-*，2026/10/18）。

约束（AGENTS §7）：不访问真实网络、不启动 KataGo、不在真实项目目录写文件。
"""

from __future__ import annotations

import asyncio
import gzip
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.config import AppConfig
from app.core.errors import AppError
from app.updates import common as up
from app.updates.app_update import apply_app_update
from app.updates.engine_update import install_engine, normalize_releases, recommended_asset
from app.updates.model_update import parse_remote_models, verify_model_gzip
from app.updates.service import UpdateService
from app.version import APP_VERSION


# ============================================================
# 版本 / 资产选择
# ============================================================


def test_upd_01_version_compare():
    assert up.normalize_tag("v1.2.3") == "1.2.3"
    assert up.version_tuple("v1.2.3-beta") == (1, 2, 3)
    assert up.is_newer("1.2.3", "1.2.2")
    assert up.is_newer("1.10.0", "1.9.9")
    assert not up.is_newer("1.2.3", "1.2.3")
    assert not up.is_newer("v1.2.3", "1.2.3+local")
    assert up.parse_engine_version("KataGo v1.16.5\nGit revision: x") == "1.16.5"
    assert up.parse_engine_version("no version") is None


def test_upd_02_app_asset_selection_prefers_setup_zip():
    release = {
        "tag_name": "v1.0.0",
        "assets": [
            {"name": "source.zip", "browser_download_url": "u1"},
            {"name": "tGo-Setup-v1.0.0.zip", "browser_download_url": "u2"},
            {"name": "tGo-Setup.zip", "browser_download_url": "u3"},
        ],
    }
    asset = up.select_app_asset(release)
    assert asset["name"] == "tGo-Setup.zip"
    summary = up.app_release_summary(release)
    assert summary["version"] == "1.0.0"
    assert summary["asset"]["url"] == "u3"


def test_upd_03_kata_release_filter_and_recommendation():
    releases = [
        {
            "tag_name": "v1.18.2",
            "assets": [
                {
                    "name": "katago-v1.18.2-cuda12.8-cudnn9.8.0-windows-x64.zip",
                    "size": 10,
                    "digest": "sha256:" + "a" * 64,
                    "browser_download_url": "https://github.com/lightvector/KataGo/releases/download/v1.18.2/a.zip",
                }
            ],
        },
        {
            "tag_name": "v1.18.1",
            "assets": [
                {
                    "name": "katago-v1.18.1-opencl-windows-x64.zip",
                    "size": 20,
                    "digest": "sha256:" + "b" * 64,
                    "browser_download_url": "https://github.com/lightvector/KataGo/releases/download/v1.18.1/b.zip",
                },
                {
                    "name": "katago-v1.18.1-eigen-linux-x64.zip",
                    "size": 30,
                    "browser_download_url": "https://github.com/lightvector/KataGo/releases/download/v1.18.1/c.zip",
                },
                {
                    "name": "katago-v1.18.1-opencl-windows-x64+bs50.zip",
                    "size": 30,
                    "browser_download_url": "https://github.com/lightvector/KataGo/releases/download/v1.18.1/d.zip",
                },
            ],
        },
    ]
    items = normalize_releases(releases, "windows-x64")
    assert [item["tag"] for item in items] == ["v1.18.2", "v1.18.1"]
    assert items[0]["assets"][0]["backend"] == "cuda"
    assert [a["name"] for a in items[1]["assets"]] == [
        "katago-v1.18.1-opencl-windows-x64.zip"
    ]
    chosen = recommended_asset(items, "windows-x64")
    assert chosen["release"]["tag"] == "v1.18.1"
    assert chosen["asset"]["backend"] == "opencl"
    # TensorRT 资产名同时含 cuda，识别顺序必须先 trt 后 cuda
    assert (
        up.kata_asset_backend("katago-v1.18.1-trt10.16.1-cuda13.2-windows-x64.zip")
        == "tensorrt"
    )


def test_upd_04_model_pages_and_compatibility():
    home = (
        "Latest network: [kata1-tf3-b11c768-s1](https://media.katagotraining.org/"
        "uploaded/networks/models/kata1/kata1-tf3-b11c768-s1.bin.gz)\n"
        "Strongest confidently-rated network: [kata1-b18c384nbt-s2]"
        "(https://media.katagotraining.org/uploaded/networks/models/kata1/"
        "kata1-b18c384nbt-s2.bin.gz)"
    )
    index = (
        "<table><tbody>"
        "<tr class=\"normalNetworkStyle\"><td>kata1-b18c384nbt-s2</td>"
        "<td>2024-01-01 00:00:00 UTC</td><td>14000.4 ± 10.0 - (4,000 games)</td>"
        "<td><a href=\"https://media.katagotraining.org/uploaded/networks/models/kata1/"
        "kata1-b18c384nbt-s2.bin.gz\">[Download]</a></td></tr>"
        "<tr class=\"normalNetworkStyle\"><td>kata1-tf3-b11c768-s1</td>"
        "<td>2024-01-01 00:00:00 UTC</td><td>14549.9 ± 18.7 - (3,620 games)</td>"
        "<td><a href=\"https://media.katagotraining.org/uploaded/networks/models/kata1/"
        "kata1-tf3-b11c768-s1.bin.gz\">[Download]</a></td></tr>"
        "</tbody></table>"
    )
    payload = parse_remote_models(home, index, engine_version="1.16.5")
    names = [item["name"] for item in payload["standard"]]
    assert names == ["kata1-tf3-b11c768-s1.bin.gz", "kata1-b18c384nbt-s2.bin.gz"]
    transformer = payload["standard"][0]
    assert transformer["latest"] is True
    assert transformer["compatible"] is False
    assert transformer["required"] == "1.17.0"
    assert transformer["elo"] == 14549.9
    assert payload["standard"][1]["strongest"] is True
    assert payload["standard"][1]["elo"] == 14000.4
    assert payload["human"]["name"] == up.HUMAN_MODEL_NAME


def test_upd_04b_parse_model_elos_tolerates_missing_values():
    html = (
        "<tr><td>kata1-b18c384nbt-s1.bin.gz</td>"
        "<td>14000.4 ± 10.0 - (4,000 games)</td></tr>"
        "<tr><td>kata1-b18c384nbt-s2.bin.gz</td><td>未评级</td></tr>"
    )
    assert up.parse_model_elos(html) == {"kata1-b18c384nbt-s1.bin.gz": 14000.4}
    assert up.parse_model_elos("") == {}


def test_upd_05_unsafe_paths_rejected():
    for value in ("../evil.txt", "/etc/passwd", "C:/Windows/x", "a/../../b"):
        with pytest.raises(up.UpdateError) as info:
            up.safe_relative_path(value)
        assert info.value.code == "UPDATE_FAILED"


def test_upd_06_safe_extract_rejects_zip_slip(tmp_path):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../evil.txt", "x")
    with pytest.raises(up.UpdateError) as info:
        up.safe_extract_zip(archive, tmp_path / "out")
    assert info.value.code == "UPDATE_FAILED"
    assert not (tmp_path / "evil.txt").exists()


# ============================================================
# 应用更新 / 引擎安装 / 模型校验
# ============================================================


def _write_setup_payload(root: Path, *, version: str = "0.2.0") -> Path:
    payload = root / "payload"
    (payload / "backend" / "app").mkdir(parents=True)
    (payload / "frontend" / "static").mkdir(parents=True)
    (payload / "backend" / "app" / "main.py").write_text(f"# app {version}", encoding="utf-8")
    (payload / "backend" / "requirements.txt").write_text("fastapi\n", encoding="utf-8")
    (payload / "frontend" / "static" / "index.html").write_text(
        f"<html>{version}</html>", encoding="utf-8"
    )
    (payload / "required-files.txt").write_text(
        "backend/app/main.py\nbackend/requirements.txt\nfrontend/static/index.html\n",
        encoding="utf-8",
    )
    (payload / "start.ps1").write_text("# start", encoding="utf-8")
    return payload


def test_upd_07_apply_update_preserves_user_data(tmp_path):
    payload = _write_setup_payload(tmp_path)
    target = tmp_path / "target"
    (target / "backend" / "app").mkdir(parents=True)
    (target / "backend" / "app" / "main.py").write_text("# old", encoding="utf-8")
    (target / "backend" / "requirements.txt").write_text("fastapi==0.1\n", encoding="utf-8")
    (target / "backend" / ".venv").mkdir(parents=True)
    (target / "backend" / ".venv" / "marker").write_text("venv", encoding="utf-8")
    (target / "config.yaml").write_text("engine: {}", encoding="utf-8")
    (target / "data").mkdir()
    (target / "data" / "tgo.db").write_text("db", encoding="utf-8")
    (target / "engine" / "katago").mkdir(parents=True)
    (target / "engine" / "katago" / "katago.exe").write_text("bin", encoding="utf-8")

    result = apply_app_update(
        payload,
        target,
        backup_root=tmp_path / "backups",
        from_version="0.1.0",
        to_version="0.2.0",
    )
    assert (target / "backend" / "app" / "main.py").read_text(encoding="utf-8") == "# app 0.2.0"
    assert (target / "frontend" / "static" / "index.html").exists()
    assert (target / "required-files.txt").exists()
    assert (target / "start.ps1").exists()
    assert (target / "config.yaml").read_text(encoding="utf-8") == "engine: {}"
    assert (target / "data" / "tgo.db").read_text(encoding="utf-8") == "db"
    assert (target / "backend" / ".venv" / "marker").exists()
    assert (target / "engine" / "katago" / "katago.exe").exists()
    assert (target / "backend" / "requirements.txt").read_text(encoding="utf-8") == "fastapi\n"
    assert result.requirements_changed is True
    assert (result.backup_dir / "backend" / "app" / "main.py").read_text(encoding="utf-8") == "# old"


def test_upd_08_apply_update_rolls_back_on_failure(tmp_path, monkeypatch):
    payload = _write_setup_payload(tmp_path)
    target = tmp_path / "target"
    (target / "backend" / "app").mkdir(parents=True)
    (target / "backend" / "app" / "main.py").write_text("# old main", encoding="utf-8")
    (target / "frontend" / "static").mkdir(parents=True)
    (target / "frontend" / "static" / "index.html").write_text("old index", encoding="utf-8")

    import app.updates.app_update as app_update_module

    real_copy = shutil.copy2

    def flaky_copy(source, destination, *args, **kwargs):
        if str(destination).endswith("index.html.tgo-new"):
            raise OSError("disk full")
        return real_copy(source, destination, *args, **kwargs)

    monkeypatch.setattr(app_update_module.shutil, "copy2", flaky_copy)
    with pytest.raises(up.UpdateError) as info:
        apply_app_update(
            payload,
            target,
            backup_root=tmp_path / "backups",
            from_version="0.1.0",
            to_version="0.2.0",
        )
    assert info.value.code == "UPDATE_FAILED"
    assert (target / "backend" / "app" / "main.py").read_text(encoding="utf-8") == "# old main"
    assert (target / "frontend" / "static" / "index.html").read_text(encoding="utf-8") == "old index"


def test_upd_09_install_engine_preserves_analysis_cfg(tmp_path):
    payload = tmp_path / "engine-new"
    payload.mkdir()
    (payload / "katago.exe").write_bytes(b"new-bin")
    (payload / "new.dll").write_bytes(b"dll")
    target = tmp_path / "engine"
    target.mkdir()
    (target / "katago.exe").write_bytes(b"old-bin")
    (target / "old.dll").write_bytes(b"old-dll")
    (target / "analysis.cfg").write_text("user-config", encoding="utf-8")

    result = install_engine(
        payload,
        target,
        backup_root=tmp_path / "backups",
        tag_platform="windows-x64",
    )
    assert (target / "katago.exe").read_bytes() == b"new-bin"
    assert (target / "new.dll").exists()
    assert not (target / "old.dll").exists()
    assert (target / "analysis.cfg").read_text(encoding="utf-8") == "user-config"
    backup = Path(result["backup"])
    assert (backup / "katago.exe").read_bytes() == b"old-bin"
    assert (backup / "old.dll").exists()


def test_upd_10_verify_model_gzip(tmp_path):
    good = tmp_path / "good.bin.gz"
    with gzip.open(good, "wb") as fp:
        fp.write(b"model-bytes" * 100)
    assert verify_model_gzip(good) > 0
    bad = tmp_path / "bad.bin.gz"
    bad.write_bytes(b"not-gzip")
    with pytest.raises(up.UpdateError) as info:
        verify_model_gzip(bad)
    assert info.value.code == "CHECKSUM_MISMATCH"


# ============================================================
# UpdateService 编排
# ============================================================


def _fake_service(tmp_path: Path, mode: str = "source") -> UpdateService:
    return UpdateService(root=tmp_path, deployment_mode=mode)


def _fake_svc(tmp_path: Path):
    cfg = AppConfig(
        engine={
            "executable_dir": str(tmp_path / "missing-engine"),
            "model_dir": str(tmp_path / "models"),
            "analysis_cfg": str(tmp_path / "analysis.cfg"),
        },
        logging={"dir": str(tmp_path / "logs")},
    )
    (tmp_path / "models").mkdir(exist_ok=True)
    return SimpleNamespace(config=cfg)


async def test_upd_11_app_info(tmp_path):
    service = _fake_service(tmp_path, mode="source")
    info = await service.app_info(_fake_svc(tmp_path))
    assert info["app"]["version"] == APP_VERSION
    assert info["deployment"]["mode"] == "source"
    assert info["engine"]["installed"] is False
    assert "standard" in info["models"]


async def test_upd_12_check_update_and_apply(tmp_path, monkeypatch):
    service = _fake_service(tmp_path, mode="source")
    major, minor, patch = up.version_tuple(APP_VERSION)
    target_version = f"{major}.{minor}.{patch + 1}"
    target_tag = f"v{target_version}"
    setup_zip = tmp_path / "tGo-Setup.zip"
    payload = _write_setup_payload(tmp_path, version=target_version)
    with zipfile.ZipFile(setup_zip, "w") as zf:
        for path in payload.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(payload).as_posix())

    release = {
        "tag_name": target_tag,
        "name": f"tGo {target_version}",
        "published_at": "2026-10-18T00:00:00Z",
        "body": "release notes",
        "html_url": f"https://github.com/yimuur/tGo/releases/tag/{target_tag}",
        "assets": [
            {
                "name": "tGo-Setup.zip",
                "size": setup_zip.stat().st_size,
                "digest": "sha256:" + up.sha256_file(setup_zip),
                "browser_download_url": (
                    "https://github.com/yimuur/tGo/releases/download/"
                    f"{target_tag}/tGo-Setup.zip"
                ),
            }
        ],
    }
    monkeypatch.setattr(service_module_up(), "fetch_json", lambda *a, **k: release)

    def fake_download(url, dest, **kwargs):
        shutil.copy2(setup_zip, dest)
        return Path(dest).stat().st_size

    monkeypatch.setattr(service_module_up(), "download_file", fake_download)

    # 目标根补一个旧文件，验证覆盖/备份
    (tmp_path / "backend" / "app").mkdir(parents=True)
    (tmp_path / "backend" / "app" / "main.py").write_text("# old", encoding="utf-8")

    check = await service.check_app_update(force=True)
    assert check["updateAvailable"] is True
    assert check["latest"]["asset"]["name"] == "tGo-Setup.zip"

    message = await service._app_update_operation(target_version)
    assert target_version in message
    assert (
        tmp_path / "backend" / "app" / "main.py"
    ).read_text(encoding="utf-8") == f"# app {target_version}"
    assert (tmp_path / "config.yaml").exists() is False  # 未在仓库里创建用户配置


def service_module_up():
    """``service.py`` 使用 ``from app.updates import common as up``（同一模块对象）。"""
    return up


async def test_upd_13_docker_update_unsupported(tmp_path):
    service = _fake_service(tmp_path, mode="docker")
    with pytest.raises(AppError) as info:
        await service.start_app_update(_fake_svc(tmp_path), version="0.2.0")
    assert info.value.code.value == "UPDATE_UNSUPPORTED"


async def test_upd_14_update_in_progress_guard(tmp_path):
    service = _fake_service(tmp_path)
    service._inflight = asyncio.create_task(asyncio.sleep(10))
    try:
        with pytest.raises(AppError) as info:
            await service.start_app_update(_fake_svc(tmp_path))
        assert info.value.code.value == "UPDATE_IN_PROGRESS"
    finally:
        service._inflight.cancel()
        try:
            await service._inflight
        except asyncio.CancelledError:
            pass


async def test_upd_15_kata_release_listing(monkeypatch, tmp_path):
    service = _fake_service(tmp_path)
    monkeypatch.setattr(service_module_up(), "platform_tag", lambda: "windows-x64")
    monkeypatch.setattr(
        service_module_up(),
        "fetch_json",
        lambda *a, **k: [
            {
                "tag_name": "v1.18.1",
                "assets": [
                    {
                        "name": "katago-v1.18.1-opencl-windows-x64.zip",
                        "size": 1,
                        "digest": None,
                        "browser_download_url": "https://github.com/lightvector/KataGo/releases/download/v1.18.1/x.zip",
                    }
                ],
            }
        ],
    )
    payload = await service.list_engine_releases(_fake_svc(tmp_path), force=True)
    assert payload["supported"] is True
    assert payload["recommended"]["asset"] == "katago-v1.18.1-opencl-windows-x64.zip"


async def test_upd_16_remote_models(monkeypatch, tmp_path):
    service = _fake_service(tmp_path)
    monkeypatch.setattr(
        service_module_up(),
        "fetch_text",
        lambda url, **k: (
            "Latest network: [x](https://media.katagotraining.org/uploaded/networks/"
            "models/kata1/kata1-b18c384nbt-s1.bin.gz)"
            if "katagotraining.org" in url
            else "https://media.katagotraining.org/uploaded/networks/models/kata1/"
            "kata1-b18c384nbt-s1.bin.gz"
        ),
    )
    payload = await service.list_remote_models(_fake_svc(tmp_path), force=True)
    assert payload["standard"][0]["name"] == "kata1-b18c384nbt-s1.bin.gz"
    assert payload["human"]["name"] == up.HUMAN_MODEL_NAME


def test_upd_17_restart_helper_waits_without_killing_parent(tmp_path):
    """UPD-17：重启辅助进程必须等待父进程自然退出。

    Windows 缺陷形态（2026/10/18 应用内更新）：``os.kill(parent_pid, 0)`` 中
    的 0 等于 CTRL_C_EVENT，会向控制台进程组发送 Ctrl+C 直接打断父进程；
    辅助进程随后在 8090 尚未释放时拉起新实例 → 回退 8091，表现为“重启失败”。
    修复后 Windows 使用 OpenProcess + WaitForSingleObject；POSIX 仍用合法的
    ``os.kill(pid, 0)`` 存活探测。本用例在两端均验证：等待期间父进程不得被杀。
    """
    import app.updates.app_update as app_update_module

    popen_kwargs = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        if sys.platform == "win32"
        else {"start_new_session": True}
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **popen_kwargs,
    )
    try:
        config = json.dumps(
            {"launcher": [], "installDeps": False, "waitTimeout": 1.5, "noLaunch": True}
        )
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                app_update_module._RESTART_HELPER,
                str(parent.pid),
                str(tmp_path),
                str(tmp_path / "update-restart.log"),
                config,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **popen_kwargs,
            timeout=20,
        )
        assert completed.returncode == 0, "重启辅助进程异常退出"
        assert parent.poll() is None, "重启辅助进程不得杀死父进程"
    finally:
        if parent.poll() is None:
            parent.terminate()
            try:
                parent.wait(timeout=5)
            except subprocess.TimeoutExpired:
                parent.kill()
                parent.wait(timeout=5)
