"""管理页「版本与资源」REST 集成测试（API-UPD-*，2026/10/18）。

- 应用信息/检查更新/更新受理（容器部署拒绝）；
- KataGo 官方 Release 列表（平台过滤 + 推荐 OpenCL）；
- 官方模型列表与下载参数校验。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.updates.service import UpdateService
import app.updates.service as update_service_module
from app.version import APP_VERSION


def _install_update_service(api_svc, tmp_path, *, mode: str = "source") -> UpdateService:
    """替换服务容器中的更新服务，并把引擎目录钉到 tmp（禁真实 KataGo）。"""
    api_svc.config.engine.executable_dir = str(tmp_path / "missing-engine")
    api_svc.config.engine.model_dir = str(tmp_path / "models")
    api_svc.config.engine.analysis_cfg = str(tmp_path / "analysis.cfg")
    (tmp_path / "models").mkdir(exist_ok=True)
    service = UpdateService(root=tmp_path, deployment_mode=mode)
    api_svc.updates = service
    return service


class TestAppInfo:
    async def test_app_info(self, api_app, api_svc, tmp_path):
        _install_update_service(api_svc, tmp_path)
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/app")
        assert resp.status_code == 200
        body = resp.json()
        assert body["app"]["version"] == APP_VERSION
        assert body["deployment"]["updateSupported"] is True
        assert body["engine"]["installed"] is False
        assert body["task"]["status"] == "idle"

    async def test_container_update_unsupported(self, api_app, api_svc, tmp_path):
        _install_update_service(api_svc, tmp_path, mode="docker")
        with TestClient(api_app) as client:
            info = client.get("/api/admin/app").json()
            check = client.post("/api/admin/app/check")
            update = client.post("/api/admin/app/update", json={})
        assert info["deployment"]["mode"] == "docker"
        assert info["deployment"]["updateSupported"] is False
        assert info["capabilities"]["appUpdate"] is False
        assert check.status_code == 200
        assert check.json()["supported"] is False
        assert update.status_code == 409
        assert update.json()["code"] == "UPDATE_UNSUPPORTED"


class TestKataReleases:
    async def test_platform_filter_and_recommendation(
        self, api_app, api_svc, tmp_path, monkeypatch
    ):
        _install_update_service(api_svc, tmp_path)
        monkeypatch.setattr(update_service_module.up, "platform_tag", lambda: "windows-x64")
        monkeypatch.setattr(
            update_service_module.up,
            "fetch_json",
            lambda *args, **kwargs: [
                {
                    "tag_name": "v1.18.2",
                    "name": "CUDA speedup",
                    "published_at": "2026-08-30T00:00:00Z",
                    "body": "",
                    "html_url": "https://github.com/lightvector/KataGo/releases/tag/v1.18.2",
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
                    "name": "Better benchmark",
                    "published_at": "2026-08-24T00:00:00Z",
                    "body": "",
                    "html_url": "https://github.com/lightvector/KataGo/releases/tag/v1.18.1",
                    "assets": [
                        {
                            "name": "katago-v1.18.1-opencl-windows-x64.zip",
                            "size": 20,
                            "digest": "sha256:" + "b" * 64,
                            "browser_download_url": "https://github.com/lightvector/KataGo/releases/download/v1.18.1/b.zip",
                        }
                    ],
                },
            ],
        )
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/kata/releases")
        assert resp.status_code == 200
        body = resp.json()
        assert body["supported"] is True
        assert [item["tag"] for item in body["releases"]] == ["v1.18.2", "v1.18.1"]
        assert body["recommended"] == {
            "tag": "v1.18.1",
            "asset": "katago-v1.18.1-opencl-windows-x64.zip",
        }

    async def test_unsupported_platform(self, api_app, api_svc, tmp_path, monkeypatch):
        _install_update_service(api_svc, tmp_path)
        monkeypatch.setattr(update_service_module.up, "platform_tag", lambda: None)
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/kata/releases")
        assert resp.status_code == 200
        body = resp.json()
        assert body["supported"] is False
        assert body["releases"] == []


class TestRemoteModels:
    async def test_list_and_download_validation(
        self, api_app, api_svc, tmp_path, monkeypatch
    ):
        _install_update_service(api_svc, tmp_path)
        page = (
            "Latest network: [x](https://media.katagotraining.org/uploaded/networks/"
            "models/kata1/kata1-tf3-b11c768-s1.bin.gz)"
        )
        monkeypatch.setattr(
            update_service_module.up,
            "fetch_text",
            lambda url, **kwargs: page,
        )
        with TestClient(api_app) as client:
            resp = client.get("/api/admin/models/remote")
            bad = client.post(
                "/api/admin/models/download",
                json={"kind": "standard", "name": "../evil.bin.gz"},
            )
            bad_human = client.post(
                "/api/admin/models/download",
                json={"kind": "human", "name": "not-human.bin.gz"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["standard"][0]["name"] == "kata1-tf3-b11c768-s1.bin.gz"
        assert body["standard"][0]["required"] == "1.17.0"
        assert body["human"]["name"] == "b18c384nbt-humanv0.bin.gz"
        assert bad.status_code == 422
        assert bad.json()["code"] == "INVALID_PAYLOAD"
        assert bad_human.status_code == 422
