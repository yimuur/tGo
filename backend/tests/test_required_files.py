"""运行必须文件清单守门（`required-files.txt` ↔ 仓库实际运行文件一致性）。

用例 ID: REQF-*

背景（2026/09/19 人工决策）：
- `start.ps1` / `deploy.sh` 部署前按根目录 `required-files.txt` 对【全部运行必须文件】
  做存在性 + 非零字节预检（缺失/损坏一次列全并拒绝启动）；
- 本测试保证清单与仓库同步：运行文件未登记 / 清单条目不存在或非运行文件，
  任一情况都会失败（防清单漂移）；新增运行文件时须同步登记清单。
"""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = PROJECT_ROOT / "required-files.txt"


def _parse_manifest() -> list[str]:
    entries: list[str] = []
    for raw in MANIFEST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        entries.append(line)
    return entries


def _expected_runtime_files() -> set[str]:
    """仓库实际【运行必须】文件集合（与清单口径一致，见清单头部说明）。

    - `backend/app/**` 的 `.py`（排除 `__pycache__`）与 `.sql`；
    - `backend/requirements.txt`；
    - `frontend/static/**`（排除 `component/` 演示/QA 页）。
    """
    expected: set[str] = set()
    for path in (PROJECT_ROOT / "backend" / "app").rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        if path.suffix in (".py", ".sql"):
            expected.add(path.relative_to(PROJECT_ROOT).as_posix())
    expected.add("backend/requirements.txt")
    for path in (PROJECT_ROOT / "frontend" / "static").rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(PROJECT_ROOT / "frontend" / "static").as_posix()
        if relative.startswith("component/"):
            continue
        expected.add(path.relative_to(PROJECT_ROOT).as_posix())
    return expected


class TestRequiredFilesManifest:
    def test_manifest_entries_are_unique_relative_files(self):
        entries = _parse_manifest()
        assert entries, "清单不得为空"
        assert len(entries) == len(set(entries)), "清单不得包含重复条目"
        for entry in entries:
            assert not entry.startswith(("/", "\\")), f"清单条目必须为相对路径: {entry}"
            assert "\\" not in entry, f"清单条目必须使用正斜杠: {entry}"
            assert ".." not in entry.split("/"), f"清单条目不得越出项目根: {entry}"

    def test_manifest_matches_repository_both_directions(self):
        """清单 ↔ 仓库双向一致（未登记 / 冗余或不存在，任一即失败）。"""
        manifest = set(_parse_manifest())
        expected = _expected_runtime_files()
        unregistered = sorted(expected - manifest)
        stale = sorted(manifest - expected)
        assert not unregistered, f"运行文件未登记到 required-files.txt: {unregistered}"
        assert not stale, f"清单条目不存在或非运行文件: {stale}"

    def test_manifest_files_exist_and_not_empty(self):
        """与脚本预检同口径：清单内文件存在且非零字节。"""
        missing: list[str] = []
        damaged: list[str] = []
        for entry in _parse_manifest():
            path = PROJECT_ROOT / entry
            if not path.is_file():
                missing.append(entry)
            elif path.stat().st_size == 0:
                damaged.append(entry)
        assert not missing, f"清单文件缺失: {missing}"
        assert not damaged, f"清单文件为 0 字节（损坏）: {damaged}"
