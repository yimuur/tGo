"""Docker 部署文件的守门测试（2026/10/17）。

目标：镜像构建与 compose 的**关键契约**不被后续改动静默破坏：
- 镜像不自带引擎/模型，运行时由 compose 挂载 `./engine`（Dockerfile 不得 COPY engine）；
- 配置保留「default.yaml 兜底 + 增量写回」语义（使用 `config/` 挂载，而不是 TGO_CONFIG 单文件模式）；
- 镜像构建仅使用发布包 `tGo-Setup/` 作为上下文（不支持 Linux 端构建脚本，不在仓库根构建）；
- 构建脚本不对引擎/模型做校验（镜像永不打包，运行时由 compose 挂载）；
- 发布包（tGo-Setup）同步 Docker 文件，DEPLOYMENT.md 位于包根；
- release.ps1 构建的镜像 tag 固定为 latest（compose 可直接引用）。

用例 ID: DCK-01..03, DCK-05..11
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = PROJECT_ROOT / "docker-compose.yml"
DOCKERFILE = PROJECT_ROOT / "tools" / "Dockerfile"
BUILD_PS1 = PROJECT_ROOT / "tools" / "docker-build.ps1"
ENTRYPOINT_SCRIPT = PROJECT_ROOT / "tools" / "docker-entrypoint.sh"
DOCKERIGNORE = PROJECT_ROOT / ".dockerignore"
MAKE_SETUP = PROJECT_ROOT / "tools" / "make-setup.ps1"
RELEASE_SCRIPT = PROJECT_ROOT / "tools" / "release.ps1"


@pytest.fixture(scope="module")
def compose_service() -> dict:
    raw = yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))
    return raw["services"]["tgo"]


def test_compose_mounts_runtime_dirs_and_exposes_port(compose_service):
    """DCK-01：引擎/数据/日志/配置全部挂载；内部端口固定 8090。"""
    assert compose_service["ports"] == ["${TGO_HTTP_PORT:-8090}:8090"]
    assert compose_service["volumes"] == [
        "./config:/app/config",
        "./data:/app/data",
        "./logs:/app/logs",
        "./engine:/app/engine",
    ]
    # 使用 config/ 目录 + 镜像内符号链接，保留增量配置语义；不得退回 TGO_CONFIG 单文件模式
    assert "TGO_CONFIG" not in compose_service.get("environment", {})


def test_dockerfile_does_not_bake_engine_and_wires_entrypoint():
    """DCK-02：镜像不含引擎/模型；入口脚本、健康检查、端口契约齐全。"""
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert "COPY engine" not in text
    assert "COPY tools/docker-entrypoint.sh" in text
    assert "EXPOSE 8090" in text
    assert "HEALTHCHECK" in text
    assert "ln -sfn /app/config/config.yaml /app/config.yaml" in text


def test_dockerignore_excludes_runtime_assets():
    """DCK-03：构建上下文不得把引擎/模型/数据/日志打进镜像。"""
    entries = {
        line.strip()
        for line in DOCKERIGNORE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    }
    assert {"engine/", "data/", "logs/", "config/", "backend/.venv/"} <= entries


def test_setup_package_syncs_docker_files():
    """DCK-05：发布包随包清单包含 Docker 文件（否则 tGo-Setup 无法自足构建）。"""
    text = MAKE_SETUP.read_text(encoding="utf-8")
    for relative in (
        ".dockerignore",
        "docker-compose.yml",
        "tools/Dockerfile",
        "tools/docker-build.ps1",
        "tools/docker-entrypoint.sh",
    ):
        assert f"'{relative}'" in text, f"make-setup.ps1 缺少随包文件：{relative}"
    # Linux 端构建脚本已移除，不得再随包同步
    assert "'tools/docker-build.sh'" not in text
    # 部署说明位于仓库根，随包目录与源路径一致（无重命名映射）
    assert (PROJECT_ROOT / "DEPLOYMENT.md").is_file()
    assert "'DEPLOYMENT.md'" in text
    assert "$SupportRenames" not in text
    assert "docs/DEPLOYMENT.md" not in text


def test_entrypoint_is_lf_and_checks_linux_binary():
    """DCK-06：入口脚本可执行位提示与 Windows 二进制误用提示。"""
    text = ENTRYPOINT_SCRIPT.read_text(encoding="utf-8")
    assert "chmod +x" in text
    assert "katago.exe" in text
    assert b"\r\n" not in ENTRYPOINT_SCRIPT.read_bytes()


def test_appimage_extract_and_run_configured(compose_service):
    """DCK-08：KataGo AppImage 在容器内无 FUSE，必须启用 extract-and-run。"""
    assert compose_service["environment"]["APPIMAGE_EXTRACT_AND_RUN"] == "1"
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    assert "APPIMAGE_EXTRACT_AND_RUN=1" in dockerfile
    entrypoint = ENTRYPOINT_SCRIPT.read_text(encoding="utf-8")
    assert "APPIMAGE_EXTRACT_AND_RUN" in entrypoint
    assert "414901|414902" in entrypoint  # AppImage Type 1/2 magic 检测
    # 不应要求特权 FUSE 透传
    compose_text = COMPOSE_FILE.read_text(encoding="utf-8")
    assert "SYS_ADMIN" not in compose_text
    assert "/dev/fuse" not in compose_text


def test_rocm_runtime_libraries_present():
    """DCK-09：ROCm 后端所需系统运行库已安装，并给出 kfd/rocm 挂载说明。"""
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    for package in (
        "libelf1",
        "libdw1",
        "libdrm2",
        "libdrm-amdgpu1",
        "libnuma1",
        "libpciaccess0",
        "libudev1",
        "libzstd1",
        "libsqlite3-0",
        "libxml2",
        "libyaml-0-2",
    ):
        assert package in dockerfile, f"Dockerfile 缺少 ROCm 运行库：{package}"
    compose_text = COMPOSE_FILE.read_text(encoding="utf-8")
    assert "/dev/kfd" in compose_text
    assert "/opt/rocm" in compose_text
    assert "LD_LIBRARY_PATH" in compose_text


def test_windows_build_script_exports_to_root():
    """DCK-07：Windows 脚本仅用 tGo-Setup 作上下文，导出 tar.gz 到根目录。"""
    raw = BUILD_PS1.read_bytes()
    # PowerShell 5.1 依赖 BOM 正确读取中文
    assert raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    assert "docker save" in text
    assert '.tar.gz' in text
    assert "$OutputPath = Join-Path $Root" in text
    # 构建上下文固定为 <根>\tGo-Setup，且不再回退到脚本上一级目录
    assert "$Context = Join-Path $Root 'tGo-Setup'" in text
    assert "Join-Path $Root 'tGo-Setup\\required-files.txt'" not in text
    # 引擎/模型不校验、不打包，-RequireEngine 已移除
    assert "-RequireEngine" not in text
    assert "$RequireEngine" not in text
    assert "engine\\models" not in text


def test_linux_build_script_removed():
    """DCK-11：不在 Linux 端构建镜像，docker-build.sh 已从仓库移除。"""
    assert not (PROJECT_ROOT / "tools" / "docker-build.sh").exists()


def test_release_script_tags_docker_image_latest():
    """DCK-10：release.ps1 构建的镜像 tag 固定 latest（compose 直接可用）。"""
    text = RELEASE_SCRIPT.read_text(encoding="utf-8-sig")
    assert "$DockerImageTag = 'latest'" in text
    assert "'-Tag', $DockerImageTag" in text
    assert "'-Tag', $Tag" not in text
