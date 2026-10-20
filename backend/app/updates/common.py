"""更新/下载的公共能力：HTTP、版本比较、平台识别、路径与压缩包安全。

设计约束（AGENTS §2/§7）：
- 所有网络访问经 ``urllib`` 同步实现，由调用方放入线程池（``asyncio.to_thread``）；
- 下载一律先写临时文件，校验通过后才原子替换（``os.replace``）；
- 压缩包解压必须防目录穿越/符号链接/解压炸弹；
- 远端数据视为不可信：URL、文件名、相对路径均须白名单校验。
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from app.version import APP_NAME, APP_VERSION, github_repo

GITHUB_API = "https://api.github.com"
KATAGO_REPO = "lightvector/KataGo"
KATAGO_OWNER = "lightvector"
MODEL_SITE = "https://katagotraining.org"
MODEL_INDEX_URL = "https://katagotraining.org/networks/"
MODEL_URL_PREFIX = "https://media.katagotraining.org/uploaded/networks/models/kata1/"
HUMAN_MODEL_RELEASE_TAG = "v1.15.0"
HUMAN_MODEL_NAME = "b18c384nbt-humanv0.bin.gz"

#: 单文件下载上限（模型/引擎资产均远小于该值；防误下载超大文件占满磁盘）
MAX_DOWNLOAD_BYTES = 1_500 * 1024 * 1024
#: 解压上限（防解压炸弹）
MAX_EXTRACT_FILES = 20_000
MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024

ProgressCallback = Callable[[int, int], None]

_VERSION_RE = re.compile(r"^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[.+-].*)?$")
_MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.bin\.gz$")
_MODEL_URL_RE = re.compile(
    re.escape(MODEL_URL_PREFIX) + r"([A-Za-z0-9._%-]+\.bin\.gz)"
)
_KATA_VERSION_RE = re.compile(r"KataGo\s+v?([0-9][0-9A-Za-z.+-]*)")


class UpdateError(Exception):
    """更新/下载领域异常（携带统一错误码，路由层映射为 ``AppError``）。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


# ============================================================
# HTTP
# ============================================================


def repo_url(path: str) -> str:
    """GitHub 应用仓库 API 地址（path 以 ``/`` 开头）。"""
    return f"{GITHUB_API}/repos/{github_repo()}{path}"


def _request(url: str, *, timeout: float, accept: str) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        headers={
            "User-Agent": f"{APP_NAME}/{APP_VERSION}",
            "Accept": accept,
        },
    )


def fetch_json(url: str, *, timeout: float = 20.0) -> Any:
    """GET JSON（GitHub API 等）；网络错误转为 ``UpdateError(NETWORK_ERROR)``。"""
    req = _request(url, timeout=timeout, accept="application/vnd.github+json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise UpdateError("ASSET_NOT_FOUND", f"远端资源不存在：{url}") from None
        if exc.code in (403, 429):
            raise UpdateError(
                "NETWORK_ERROR",
                "GitHub 访问受限（请求过于频繁或触发限流），请稍后重试",
            ) from None
        raise UpdateError("NETWORK_ERROR", f"远端请求失败（HTTP {exc.code}）：{url}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise UpdateError("NETWORK_ERROR", f"网络不可用（{exc}）") from None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UpdateError("NETWORK_ERROR", f"远端响应格式无效：{exc}") from None


def fetch_text(url: str, *, timeout: float = 20.0) -> str:
    """GET 文本（官方模型站点页面解析用）。"""
    req = _request(url, timeout=timeout, accept="text/html")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise UpdateError("NETWORK_ERROR", f"远端请求失败（HTTP {exc.code}）：{url}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise UpdateError("NETWORK_ERROR", f"网络不可用（{exc}）") from None


def sha256_file(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_digest(value: Optional[str]) -> Optional[str]:
    """``sha256:<hex>`` / ``<hex>`` → 小写 hex。"""
    if not value:
        return None
    text = str(value).strip().lower()
    if text.startswith("sha256:"):
        text = text.split(":", 1)[1]
    if not re.fullmatch(r"[0-9a-f]{64}", text):
        return None
    return text


def download_file(
    url: str,
    dest: str | os.PathLike[str],
    *,
    on_progress: Optional[ProgressCallback] = None,
    expected_sha256: Optional[str] = None,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
    timeout: float = 60.0,
) -> int:
    """流式下载到 ``dest``（临时文件语义由调用方负责）。

    返回下载字节数；校验失败/超限时删除 ``dest`` 并抛 ``UpdateError``。
    """
    target = Path(dest)
    target.parent.mkdir(parents=True, exist_ok=True)
    req = _request(url, timeout=timeout, accept="*/*")
    expected = normalize_digest(expected_sha256)
    digest = hashlib.sha256()
    done = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(target, "wb") as fp:
            if not str(resp.geturl()).lower().startswith("https://"):
                raise UpdateError("NETWORK_ERROR", "下载地址不是 HTTPS（已拒绝）")
            total = int(resp.headers.get("Content-Length") or 0)
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                done += len(chunk)
                if done > max_bytes:
                    raise UpdateError(
                        "DOWNLOAD_TOO_LARGE",
                        f"下载体积超过上限（{human_size(max_bytes)}）",
                    )
                digest.update(chunk)
                fp.write(chunk)
                if on_progress is not None:
                    on_progress(done, total)
            fp.flush()
            os.fsync(fp.fileno())
    except urllib.error.HTTPError as exc:
        _remove_quiet(target)
        raise UpdateError("NETWORK_ERROR", f"下载失败（HTTP {exc.code}）：{url}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        _remove_quiet(target)
        raise UpdateError("NETWORK_ERROR", f"下载失败（{exc}）：{url}") from None
    except UpdateError:
        _remove_quiet(target)
        raise
    if expected is not None and digest.hexdigest() != expected:
        _remove_quiet(target)
        raise UpdateError("CHECKSUM_MISMATCH", "下载文件校验失败（SHA256 不一致）")
    return done


def human_size(value: int | float | None) -> str:
    """字节数 → 人类可读（后端日志/回执用）。"""
    if not value:
        return "0 B"
    number = float(value)
    for unit in ("B", "KB", "MB", "GB"):
        if number < 1024 or unit == "GB":
            return f"{number:.1f} {unit}" if unit != "B" else f"{int(number)} B"
        number /= 1024
    return f"{number:.1f} GB"


# ============================================================
# 版本
# ============================================================


def normalize_tag(tag: str) -> str:
    """``v1.2.3`` → ``1.2.3``（用于展示与比较）。"""
    return str(tag or "").strip().lstrip("vV")


def version_tuple(version: str) -> tuple[int, ...]:
    """版本字符串 → 可比较元组；无法识别返回空元组。"""
    match = _VERSION_RE.match(str(version or "").strip())
    if match is None:
        return ()
    return tuple(int(part or 0) for part in match.groups())


def is_newer(latest: str, current: str) -> bool:
    """``latest`` 是否比 ``current`` 新（任一无法解析时回退为字符串不等判断）。"""
    newest = version_tuple(latest)
    local = version_tuple(current)
    if not newest or not local:
        return bool(latest) and normalize_tag(latest) != normalize_tag(current)
    size = max(len(newest), len(local))
    return newest + (0,) * (size - len(newest)) > local + (0,) * (size - len(local))


def parse_engine_version(text: str) -> Optional[str]:
    """从 ``katago version`` 输出提取版本号（``KataGo v1.16.5`` → ``1.16.5``）。"""
    match = _KATA_VERSION_RE.search(text or "")
    return match.group(1) if match else None


# ============================================================
# 平台 / 部署形态
# ============================================================


def platform_tag() -> Optional[str]:
    """KataGo 官方资产平台标识：``windows-x64`` / ``linux-x64``；不支持返回 None。"""
    machine = platform.machine().lower()
    is_x64 = machine in ("x86_64", "amd64", "x64")
    if not is_x64:
        return None
    if sys.platform.startswith("win"):
        return "windows-x64"
    if sys.platform.startswith("linux"):
        return "linux-x64"
    return None


def platform_summary() -> dict:
    return {
        "os": platform.system(),
        "machine": platform.machine(),
        "tag": platform_tag(),
    }


def detect_deployment_mode() -> str:
    """运行形态：``docker`` / ``systemd`` / ``source``。

    Docker 内应用自更新不持久（容器重建即丢失），仅允许下载引擎/模型到挂载目录。
    """
    if os.environ.get("TGO_DOCKER") == "1":
        return "docker"
    if Path("/.dockerenv").exists():
        return "docker"
    try:
        cgroup = Path("/proc/1/cgroup").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        cgroup = ""
    if "docker" in cgroup or "kubepods" in cgroup or "containerd" in cgroup:
        return "docker"
    if os.environ.get("INVOCATION_ID") or os.environ.get("NOTIFY_SOCKET"):
        return "systemd"
    return "source"


def project_root() -> Path:
    """项目根（``backend/app/updates/common.py`` 上溯 3 级）。"""
    return Path(__file__).resolve().parents[3]


# ============================================================
# 应用更新包
# ============================================================


def select_app_asset(release: dict) -> Optional[dict]:
    """从应用 Release 资产中选择更新包（``tGo-Setup*.zip`` 优先）。"""
    candidates: list[tuple[int, dict]] = []
    for asset in release.get("assets") or []:
        name = str(asset.get("name") or "")
        lower = name.lower()
        if not lower.endswith(".zip"):
            continue
        if lower == "tgo-setup.zip":
            priority = 0
        elif lower.startswith("tgo-setup"):
            priority = 1
        elif "tgo" in lower:
            priority = 2
        else:
            continue
        candidates.append((priority, asset))
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: item[0])[0][1]


def app_release_summary(release: dict) -> dict:
    """应用 Release → 管理页可用摘要。"""
    asset = select_app_asset(release)
    tag = str(release.get("tag_name") or "")
    return {
        "tag": tag,
        "version": normalize_tag(tag),
        "name": release.get("name") or tag,
        "publishedAt": release.get("published_at"),
        "notes": (release.get("body") or "")[:4000],
        "htmlUrl": release.get("html_url"),
        "asset": (
            {
                "name": asset.get("name"),
                "size": asset.get("size"),
                "digest": asset.get("digest"),
                "url": asset.get("browser_download_url"),
            }
            if asset
            else None
        ),
    }


# ============================================================
# KataGo Release
# ============================================================


def kata_asset_backend(name: str) -> Optional[str]:
    """从官方资产名识别后端（未知/不适用返回 None）。"""
    lower = name.lower()
    if not lower.endswith(".zip") or "+bs50" in lower:
        return None
    for marker, backend in (
        ("onnx-openvino", "onnx-openvino"),
        ("directml", "onnx-directml"),
        ("opencl", "opencl"),
        # TensorRT 资产名同时含 cuda（如 ``trt10.16.1-cuda13.2``），必须先于 cuda 判断
        ("trt", "tensorrt"),
        ("cuda", "cuda"),
        ("rocm", "rocm"),
        ("eigenavx2", "eigen-avx2"),
        ("eigen", "eigen"),
        ("onnx", "onnx"),
    ):
        if marker in lower:
            return backend
    return None


def normalize_kata_release(release: dict, tag_platform: str) -> Optional[dict]:
    """单个官方 Release → 当前平台可用资产列表；无可用资产返回 None。"""
    assets: list[dict] = []
    for asset in release.get("assets") or []:
        name = str(asset.get("name") or "")
        if f"-{tag_platform}" not in name.lower():
            continue
        backend = kata_asset_backend(name)
        if backend is None:
            continue
        assets.append(
            {
                "name": name,
                "backend": backend,
                "size": asset.get("size"),
                "digest": asset.get("digest"),
                "url": asset.get("browser_download_url"),
            }
        )
    if not assets:
        return None
    assets.sort(key=lambda item: (item["backend"] != "opencl", item["name"]))
    return {
        "tag": release.get("tag_name"),
        "name": release.get("name") or release.get("tag_name"),
        "publishedAt": release.get("published_at"),
        "notes": (release.get("body") or "")[:2000],
        "htmlUrl": release.get("html_url"),
        "assets": assets,
    }


# ============================================================
# 官方模型
# ============================================================


def valid_model_name(name: str) -> bool:
    return bool(_MODEL_NAME_RE.fullmatch(str(name or "")))


def standard_model_url(name: str) -> str:
    if not valid_model_name(name):
        raise UpdateError("INVALID_PAYLOAD", "模型文件名不合法")
    return MODEL_URL_PREFIX + urllib.parse.quote(name)


def human_model_url() -> str:
    return (
        f"https://github.com/{KATAGO_REPO}/releases/download/"
        f"{HUMAN_MODEL_RELEASE_TAG}/{urllib.parse.quote(HUMAN_MODEL_NAME)}"
    )


def parse_model_names(html: str, *, limit: int = 30) -> list[str]:
    """从 katagotraining 页面提取官方模型文件名（保持页面顺序、去重）。"""
    names: list[str] = []
    seen: set[str] = set()
    for match in _MODEL_URL_RE.finditer(html or ""):
        name = urllib.parse.unquote(match.group(1))
        if not valid_model_name(name) or name in seen:
            continue
        seen.add(name)
        names.append(name)
        if len(names) >= limit:
            break
    return names


_MODEL_ROW_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.IGNORECASE | re.DOTALL)
_MODEL_FILE_IN_ROW_RE = re.compile(r"([A-Za-z0-9][A-Za-z0-9._-]*\.bin\.gz)")
_ELO_VALUE_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)\s*±")


def _collect_model_elo(block: str, result: dict[str, float]) -> None:
    name_match = _MODEL_FILE_IN_ROW_RE.search(block or "")
    if not name_match:
        return
    name = name_match.group(1)
    if not valid_model_name(name):
        return
    elo_match = _ELO_VALUE_RE.search(block)
    if not elo_match:
        return
    result[name] = float(elo_match.group(1))


def parse_model_elos(html: str) -> dict[str, float]:
    """从 katagotraining 网络页提取每个模型的 Elo 分（近似值）。

    官方页面为 ``<tr>`` 表格（名称 / 上传时间 / ``14549.9 ± 18.7 - (...)``），
    同时兼容单行 Markdown 转写；无法解析时不报错（返回空/部分映射）。
    """
    result: dict[str, float] = {}
    text = html or ""
    for block in _MODEL_ROW_RE.findall(text):
        _collect_model_elo(block, result)
    # 兼容 Markdown 表格（一行一个模型）；HTML 行已在上面处理。
    for line in text.splitlines():
        if "|" in line:
            _collect_model_elo(line, result)
    return result


def parse_model_highlights(html: str) -> dict:
    """解析首页「Latest network」「Strongest confidently-rated network」。

    官方页面为 HTML（``<span>Latest network:</span> <a href=".../x.bin.gz">x</a>``），
    也兼容 Markdown 形态（测试/文档转写）；一律在标签后窗口内取首个模型文件名。
    """
    result: dict[str, Optional[str]] = {"latest": None, "strongest": None}
    text = html or ""
    for key, label in (
        ("latest", "Latest network:"),
        ("strongest", "Strongest confidently-rated network:"),
    ):
        index = text.find(label)
        if index < 0:
            continue
        window = text[index : index + 800]
        match = re.search(r"([A-Za-z0-9._-]+\.bin\.gz)", window)
        if match and valid_model_name(match.group(1)):
            result[key] = match.group(1)
    return result


def required_engine_for_model(name: str) -> Optional[str]:
    """模型所需的最低 KataGo 版本（无法判定返回 None）。

    依据：transformer 网络（``tf1/tf2/tf3``）需要 KataGo ≥ 1.17（模型版本 17）；
    其余主流 b18/b28/b40 卷积网络在随包 v1.16.x 上可加载。
    """
    if re.search(r"(?:^|[-_])tf\d", name, re.IGNORECASE):
        return "1.17.0"
    return None


def model_compatibility(name: str, engine_version: Optional[str]) -> dict:
    required = required_engine_for_model(name)
    if required is None or not engine_version:
        return {"required": required, "compatible": None}
    return {
        "required": required,
        "compatible": not is_newer(required, engine_version),
    }


# ============================================================
# 文件 / 压缩包
# ============================================================


def safe_relative_path(relative: str) -> Path:
    """把远端相对路径规范化为安全的 ``Path``（拒绝绝对路径/盘符/``..``）。"""
    raw = str(relative or "").replace("\\", "/").strip()
    if not raw:
        raise UpdateError("UPDATE_FAILED", "更新包包含空路径")
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise UpdateError("UPDATE_FAILED", f"更新包包含绝对路径：{relative}")
    parts = [part for part in raw.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise UpdateError("UPDATE_FAILED", f"更新包包含越界路径：{relative}")
    return Path(*parts)


def safe_extract_zip(
    zip_path: str | os.PathLike[str],
    dest: str | os.PathLike[str],
    *,
    max_files: int = MAX_EXTRACT_FILES,
    max_bytes: int = MAX_EXTRACT_BYTES,
) -> list[Path]:
    """安全解压（拒绝目录穿越/符号链接/加密/超大条目）。返回已解压文件路径。"""
    target_root = Path(dest)
    target_root.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    total = 0
    try:
        archive = zipfile.ZipFile(zip_path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise UpdateError("UPDATE_FAILED", f"更新包无法解压（{exc}）") from None
    with archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if len(infos) > max_files:
            raise UpdateError("UPDATE_FAILED", "更新包文件数量异常（疑似解压炸弹）")
        for info in infos:
            if info.flag_bits & 0x1:
                raise UpdateError("UPDATE_FAILED", "更新包包含加密条目")
            mode = (info.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                raise UpdateError("UPDATE_FAILED", "更新包包含符号链接条目")
            relative = safe_relative_path(info.filename)
            total += max(0, info.file_size)
            if total > max_bytes:
                raise UpdateError("UPDATE_FAILED", "更新包解压体积异常（疑似解压炸弹）")
            output = target_root / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, open(output, "wb") as sink:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    sink.write(chunk)
            if os.name != "nt":
                mode = (info.external_attr >> 16) & 0o777
                if mode:
                    try:
                        os.chmod(output, mode)
                    except OSError:
                        pass
            extracted.append(output)
    if not extracted:
        raise UpdateError("UPDATE_FAILED", "更新包为空")
    return extracted


def payload_root(extract_dir: Path, marker: str) -> Path:
    """定位压缩包载荷根目录（兼容官方包多套一层目录）。"""
    root = extract_dir.resolve()
    if (root / marker).exists():
        return root
    children = [child for child in root.iterdir() if child.is_dir()]
    if len(children) == 1 and (children[0] / marker).exists():
        return children[0]
    matches = list(root.rglob(marker))
    if not matches:
        raise UpdateError("ASSET_NOT_FOUND", f"更新包内未找到 {marker}")
    return matches[0].parent


def _remove_quiet(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def run_engine_version(executable: str | os.PathLike[str], *, timeout: float = 10.0) -> Optional[str]:
    """执行 ``katago version`` 并解析版本号（失败返回 None）。"""
    import subprocess

    try:
        completed = subprocess.run(
            [str(executable), "version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_engine_version((completed.stdout or "") + "\n" + (completed.stderr or ""))


__all__ = [
    "GITHUB_API",
    "KATAGO_REPO",
    "MODEL_SITE",
    "MODEL_INDEX_URL",
    "MODEL_URL_PREFIX",
    "HUMAN_MODEL_NAME",
    "HUMAN_MODEL_RELEASE_TAG",
    "MAX_DOWNLOAD_BYTES",
    "UpdateError",
    "app_release_summary",
    "detect_deployment_mode",
    "download_file",
    "fetch_json",
    "fetch_text",
    "github_repo",
    "human_model_url",
    "human_size",
    "is_newer",
    "kata_asset_backend",
    "model_compatibility",
    "normalize_digest",
    "normalize_kata_release",
    "normalize_tag",
    "parse_engine_version",
    "parse_model_elos",
    "parse_model_highlights",
    "parse_model_names",
    "payload_root",
    "platform_summary",
    "platform_tag",
    "project_root",
    "required_engine_for_model",
    "repo_url",
    "run_engine_version",
    "safe_extract_zip",
    "safe_relative_path",
    "select_app_asset",
    "sha256_file",
    "standard_model_url",
    "valid_model_name",
    "version_tuple",
]
