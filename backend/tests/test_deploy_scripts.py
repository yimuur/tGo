"""部署脚本的引擎/模型路径解析（PROMPTS 2026/09/23）。

要求：`deploy.sh` / `start.ps1` 的引擎自检须**优先**查看用户 `config.yaml` 中自定义的
`engine.executable_dir` / `engine.model_dir`，默认路径（`engine/katago`、`engine/models`）
仅作兜底 —— 不得把默认路径当唯一来源硬编码。

用例 ID: SCR-*
- `SCR-01..04`：真跑 Windows PowerShell（从 `start.ps1` 提取函数执行；非 Windows 平台跳过）；
- `SCR-05..06`：两脚本跨平台契约（同口径读取用户配置；默认兜底常量与平台识别次序一致）。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
START_PS1 = PROJECT_ROOT / "start.ps1"
DEPLOY_SH = PROJECT_ROOT / "deploy.sh"

#: 解析出的路径来源标签（脚本中与用户提示同文案）
SOURCE_CONFIG = "config.yaml"
SOURCE_DEFAULT = "默认兜底"


def _ps_available() -> bool:
    return sys.platform == "win32" and shutil.which("powershell") is not None


pytestmark_ps = pytest.mark.skipif(not _ps_available(), reason="需要 Windows PowerShell（POSIX 平台跳过）")


def _extract_ps_function(name: str) -> str:
    """从 `start.ps1` 提取函数源码（顶层 `}` 收尾；找不到即失败，防脚本漂移后测试静默失效）。"""
    lines = START_PS1.read_text(encoding="utf-8-sig").splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith(f"function {name}")), None)
    assert start is not None, f"start.ps1 未找到函数 {name}（测试需同步更新）"
    for end in range(start + 1, len(lines)):
        if lines[end] == "}":
            return "\n".join(lines[start : end + 1])
    raise AssertionError(f"start.ps1 函数 {name} 缺少结束大括号")


def _resolve_paths_via_powershell(tmp_path: Path, root: Path) -> dict[str, str]:
    """真跑 `start.ps1` 的路径解析函数 → ``{key: value}``（脚本函数 + 极简驱动程序）。"""
    funcs = "\n\n".join(
        (
            _extract_ps_function("Get-TgoConfigScalar"),
            _extract_ps_function("Get-TgoEnginePaths"),
            _extract_ps_function("Get-TgoModelStatus"),
        )
    )
    harness = (
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n"
        f"{funcs}\n"
        f"$paths = Get-TgoEnginePaths -Root '{root}'\n"
        "$status = Get-TgoModelStatus -Paths $paths\n"
        'Write-Output ("exe_dir=" + $paths.ExecutableDir)\n'
        'Write-Output ("exe=" + $(if ($paths.Executable) { $paths.Executable } else { "<none>" }))\n'
        'Write-Output ("model_dir=" + $paths.ModelDir)\n'
        'Write-Output ("standard_model=" + $paths.StandardModel)\n'
        'Write-Output ("human_model=" + $paths.HumanModel)\n'
        'Write-Output ("standard_status=" + $status.Standard)\n'
        'Write-Output ("human_status=" + $status.Human)\n'
        'Write-Output ("exe_source=" + $paths.ExeSource)\n'
        'Write-Output ("model_source=" + $paths.ModelSource)\n'
    )
    script = tmp_path / "resolve_engine_paths.ps1"
    script.write_text(harness, encoding="utf-8-sig")
    result = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=dict(os.environ),
        check=False,
    )
    assert result.returncode == 0, f"PowerShell 执行失败：{result.stdout}\n{result.stderr}"
    parsed: dict[str, str] = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition("=")
        if key:
            parsed[key.strip()] = value.strip()
    return parsed


@pytest.fixture(autouse=True)
def _no_tgo_config_env(monkeypatch):
    """默认清掉 TGO_CONFIG（各用例按需注入，避免外部环境串味）。"""
    monkeypatch.delenv("TGO_CONFIG", raising=False)


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")


@pytestmark_ps
class TestStartScriptEnginePaths:
    """Windows `start.ps1`：真跑解析函数（用户配置优先 / 默认兜底 / 环境变量覆盖）。"""

    def test_user_config_paths_take_priority(self, tmp_path):
        """SCR-01：config.yaml 自定义路径生效（相对路径锚定项目根；引号/行内注释/前置分组混排）。"""
        root = tmp_path / "proj"
        _touch(root / "custom" / "katago" / "katago")
        (root / "custom" / "models").mkdir(parents=True)
        (root / "config.yaml").write_text(
            "# 用户配置\n"
            "server:\n"
            "  port: 8090\n"
            "engine:\n"
            "  executable_dir: custom/katago   # 自定义执行文件目录\n"
            '  model_dir: "custom/models"\n',
            encoding="utf-8",
        )

        paths = _resolve_paths_via_powershell(tmp_path, root)

        assert paths["exe_dir"] == str(root / "custom" / "katago")
        assert paths["exe"] == str(root / "custom" / "katago" / "katago")
        assert paths["model_dir"] == str(root / "custom" / "models")
        assert paths["exe_source"] == SOURCE_CONFIG
        assert paths["model_source"] == SOURCE_CONFIG

    def test_defaults_used_only_as_fallback(self, tmp_path):
        """SCR-02：无用户配置 → 默认路径兜底（来源标注「默认兜底」，可执行文件缺失即如实报告）。"""
        root = tmp_path / "proj"
        root.mkdir()

        paths = _resolve_paths_via_powershell(tmp_path, root)

        assert paths["exe_dir"] == str(root / "engine" / "katago")
        assert paths["model_dir"] == str(root / "engine" / "models")
        assert paths["exe"] == "<none>"
        assert paths["exe_source"] == SOURCE_DEFAULT
        assert paths["model_source"] == SOURCE_DEFAULT

    def test_tgo_config_env_overrides_config_location(self, tmp_path, monkeypatch):
        """SCR-03：TGO_CONFIG 指定配置文件位置（应用侧同口径），默认路径仍仅兜底。"""
        root = tmp_path / "proj"
        elsewhere = tmp_path / "elsewhere.yaml"
        _touch(root / "extern" / "katago" / "katago.exe")
        (root / "extern" / "nets").mkdir(parents=True)
        elsewhere.write_text(
            "engine:\n  executable_dir: extern/katago\n  model_dir: extern/nets\n", encoding="utf-8"
        )
        monkeypatch.setenv("TGO_CONFIG", str(elsewhere))

        paths = _resolve_paths_via_powershell(tmp_path, root)

        assert paths["exe_dir"] == str(root / "extern" / "katago")
        assert paths["exe"] == str(root / "extern" / "katago" / "katago.exe")
        assert paths["model_dir"] == str(root / "extern" / "nets")
        assert paths["exe_source"] == SOURCE_CONFIG

    def test_other_sections_and_empty_values_fall_back(self, tmp_path):
        """SCR-04：仅认 `engine` 段内的声明；空值与其它分组的同名键不得误取。"""
        root = tmp_path / "proj"
        _touch(root / "engine" / "katago" / "katago.exe")
        (root / "config.yaml").write_text(
            "review:\n"
            "  model_dir: review_should_not_win\n"
            "engine:\n"
            "  executable_dir:\n"
            "  model_dir: ''\n"
            "server:\n"
            "  port: 8090\n",
            encoding="utf-8",
        )

        paths = _resolve_paths_via_powershell(tmp_path, root)

        assert paths["exe_dir"] == str(root / "engine" / "katago")  # 空值 → 默认兜底
        assert paths["model_dir"] == str(root / "engine" / "models")
        assert paths["exe"] == str(root / "engine" / "katago" / "katago.exe")
        assert paths["exe_source"] == SOURCE_DEFAULT
        assert paths["model_source"] == SOURCE_DEFAULT


@pytestmark_ps
class TestStartScriptModelStatus:
    """Windows `start.ps1`：模型可用性判定（口径同后端 `resolve_models`）。"""

    def test_declared_models_checked_by_filename(self, tmp_path):
        """SCR-07：声明 `standard_model`/`human_model` → 按文件名精确校验（存在即 ok）。"""
        root = tmp_path / "proj"
        (root / "nets").mkdir(parents=True)
        (root / "nets" / "my-net.bin.gz").write_bytes(b"x")
        (root / "nets" / "my-human.bin.gz").write_bytes(b"x")
        (root / "config.yaml").write_text(
            "engine:\n"
            "  model_dir: nets\n"
            "  standard_model: my-net.bin.gz\n"
            "  human_model: my-human.bin.gz\n",
            encoding="utf-8",
        )

        paths = _resolve_paths_via_powershell(tmp_path, root)

        assert paths["model_dir"] == str(root / "nets")
        assert paths["standard_model"] == "my-net.bin.gz"
        assert paths["human_model"] == "my-human.bin.gz"
        assert paths["standard_status"] == "ok"
        assert paths["human_status"] == "ok"

    def test_declared_standard_model_missing_does_not_fall_back(self, tmp_path):
        """SCR-08：声明的标准模型缺失 → 如实报告（**不回落**扫描其它模型，与后端一致）。"""
        root = tmp_path / "proj"
        models = root / "engine" / "models"
        models.mkdir(parents=True)
        (models / "other-net.bin.gz").write_bytes(b"x")
        (root / "config.yaml").write_text(
            "engine:\n  standard_model: missing-net.bin.gz\n", encoding="utf-8"
        )

        paths = _resolve_paths_via_powershell(tmp_path, root)

        assert paths["standard_status"] == "missing_declared"
        assert paths["standard_model"] == "missing-net.bin.gz"

    def test_auto_scan_excludes_human_model_for_standard(self, tmp_path):
        """SCR-09：未声明 → 自动扫描；人类模型不算标准模型（后端同口径）。"""
        root = tmp_path / "proj"
        models = root / "engine" / "models"
        models.mkdir(parents=True)
        (models / "kata1-b18c384nbt-humanv0.bin.gz").write_bytes(b"x")

        paths = _resolve_paths_via_powershell(tmp_path, root)
        assert paths["standard_status"] == "missing_auto"  # 目录内只有人类模型
        assert paths["human_status"] == "ok"

        (models / "kata1-b18c384nbt.bin.gz").write_bytes(b"x")
        paths = _resolve_paths_via_powershell(tmp_path, root)
        assert paths["standard_status"] == "ok"
        assert paths["human_status"] == "ok"

    def test_declared_human_model_missing(self, tmp_path):
        """SCR-10：声明的人类模型缺失 → 仅标准风格可用（标准模型自动扫描仍可用）。"""
        root = tmp_path / "proj"
        models = root / "engine" / "models"
        models.mkdir(parents=True)
        (models / "kata1-b18c384nbt.bin.gz").write_bytes(b"x")
        (root / "config.yaml").write_text(
            "engine:\n  human_model: missing-human.bin.gz\n", encoding="utf-8"
        )

        paths = _resolve_paths_via_powershell(tmp_path, root)

        assert paths["standard_status"] == "ok"
        assert paths["human_status"] == "missing_declared"


class TestScriptPathContracts:
    """两脚本跨平台契约（POSIX 侧在本机无法执行 → 以文本契约守门，防回退为硬编码）。"""

    def test_both_scripts_read_user_config_paths(self):
        """SCR-05：两脚本均读取 engine 段路径与模型名（TGO_CONFIG 可覆盖配置文件位置），默认仅兜底。"""
        ps1 = START_PS1.read_text(encoding="utf-8-sig")
        sh = DEPLOY_SH.read_text(encoding="utf-8")
        for text, label in ((ps1, "start.ps1"), (sh, "deploy.sh")):
            for token in (
                "executable_dir",
                "model_dir",
                "standard_model",
                "human_model",
                "TGO_CONFIG",
                "config.yaml",
            ):
                assert token in text, f"{label} 未读取用户配置项：{token}"
            for fallback in ("engine/katago", "engine/models"):
                assert fallback in text, f"{label} 缺少默认兜底路径：{fallback}"

    def test_model_name_checks_present(self):
        """SCR-11：声明模型按文件名精确校验（不回落扫描）；自动扫描时标准模型排除人类模型。"""
        ps1 = START_PS1.read_text(encoding="utf-8-sig")
        sh = DEPLOY_SH.read_text(encoding="utf-8")
        assert "function Get-TgoModelStatus" in ps1
        assert "Get-TgoModelStatus -Paths" in ps1
        assert "$_.Name -notmatch 'human'" in ps1  # 标准模型自动扫描排除人类模型
        assert "resolve_model_status" in sh
        assert "*[Hh][Uu][Mm][Aa][Nn]*" in sh  # 人类模型特征匹配（忽略大小写）
        for text, label in ((ps1, "start.ps1"), (sh, "deploy.sh")):
            assert "missing_declared" in text, f"{label} 缺少「声明模型缺失」状态标记"

    def test_no_hardcoded_engine_binary_path(self):
        """SCR-05b：不得先把默认可执行文件路径写死为唯一来源（含 Windows 反斜杠写法）。"""
        ps1 = START_PS1.read_text(encoding="utf-8-sig")
        sh = DEPLOY_SH.read_text(encoding="utf-8")
        for text, label in ((ps1, "start.ps1"), (sh, "deploy.sh")):
            for hardcoded in ("engine/katago/katago", "engine\\katago\\katago"):
                assert hardcoded not in text, f"{label} 仍硬编码引擎可执行文件路径：{hardcoded}"

    def test_missing_standard_model_wording_is_non_blocking(self):
        """SCR-12：脚本提示同 BUG-090 口径（标准模型缺失＝引擎不可用降级，不阻碍进入）。"""
        for text, label in (
            (START_PS1.read_text(encoding="utf-8-sig"), "start.ps1"),
            (DEPLOY_SH.read_text(encoding="utf-8"), "deploy.sh"),
        ):
            assert "引擎不可用（标准模型缺失）" in text, f"{label} 未指明缺失项"
            assert "人人对弈与复盘不受影响" in text, f"{label} 缺少降级可用性说明"

    def test_platform_binary_name_order(self):
        """SCR-06：可执行文件名按平台识别（Windows 先 katago.exe；Linux 先 katago）。"""
        ps1 = START_PS1.read_text(encoding="utf-8-sig")
        sh = DEPLOY_SH.read_text(encoding="utf-8")
        assert "@('katago.exe', 'katago')" in ps1
        assert "for name in katago katago.exe; do" in sh

    def test_docker_build_context_falls_back_when_setup_dir_missing(self):
        """SCR-13：tGo-Setup 不存在时，docker-build.ps1 回退到根目录作为构建上下文。"""
        script = (PROJECT_ROOT / "tools" / "docker-build.ps1").read_text(encoding="utf-8-sig")
        assert "$SetupContext = Join-Path $Root 'tGo-Setup'" in script
        assert "if (Test-Path $SetupContext -PathType Container)" in script
        assert "$Context = $Root" in script
        assert "未找到 tGo-Setup，回退项目根目录" in script
        assert "$ContextHint = if ($Context -eq $Root)" in script
        assert "请确认当前目录是完整项目根" in script

    def test_docker_context_excludes_non_runtime_trees(self):
        """SCR-14：根目录回退构建时排除测试/开发/远程赞助资源，镜像内容与发布包同口径。"""
        ignore = (PROJECT_ROOT / ".dockerignore").read_text(encoding="utf-8")
        for entry in (
            "frontend/sponsor/",
            "frontend/tests/",
            "frontend/package.json",
            "backend/tests/",
            "backend/requirements-dev.txt",
        ):
            assert entry in ignore, f".dockerignore 缺少 {entry}"
