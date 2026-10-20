#!/usr/bin/env bash
# ============================================================================
# tGo Docker 镜像一键构建
#
# 用法（在 Linux / NAS 上执行）：
#   chmod +x tools/docker-build.sh
#   ./tools/docker-build.sh                 # 构建 tgo:latest（引擎/模型缺失仅提示，不阻断）
#   ./tools/docker-build.sh --no-cache      # 忽略构建缓存
#   ./tools/docker-build.sh --pull          # 构建前拉取最新基础镜像
#   ./tools/docker-build.sh --tag 2026.10   # 指定镜像标签
#   ./tools/docker-build.sh --require-engine
#                                           # 严格校验引擎/模型存在性（缺失即失败）
#
# 构建上下文：
#   - 存在 <仓库>/tGo-Setup/ 时使用发布包（镜像只含运行必需文件）；
#   - 否则使用脚本所在目录的上一级（发布包内直接运行：<tGo-Setup>/tools/docker-build.sh）。
#
# 镜像**永不打包**引擎与模型（由 docker-compose 挂载），默认也不校验其存在性：
#   engine/katago/katago        Linux 版 KataGo 可执行文件（katago.exe 不可用）
#   engine/models/*.bin.gz      至少一个模型（标准模型必需；人类模型可选）
#   --require-engine 仅对上述路径做存在性校验，仍不会把它们打进镜像。
#
# 环境变量：TGO_IMAGE（默认 tgo）、TGO_IMAGE_TAG（默认 latest）、TGO_HTTP_PORT（提示用，默认 8090）
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE="${TGO_IMAGE:-tgo}"
TAG="${TGO_IMAGE_TAG:-latest}"
HTTP_PORT="${TGO_HTTP_PORT:-8090}"
NO_CACHE=0
PULL=0
REQUIRE_ENGINE=0

log() { printf '[tGo] %s\n' "$*"; }
err() {
    if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
        printf '[tGo] \033[31m%s\033[0m\n' "$*" >&2
    else
        printf '[tGo] %s\n' "$*" >&2
    fi
}
fail() { err "$*"; exit 1; }

usage() {
    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-cache) NO_CACHE=1 ;;
        --pull) PULL=1 ;;
        --require-engine) REQUIRE_ENGINE=1 ;;
        --allow-missing-engine)
            # 兼容旧参数：不校验引擎/模型现已成为默认行为
            log "提示：--allow-missing-engine 已是默认行为，参数仅保留兼容"
            ;;
        --tag) [ "$#" -ge 2 ] || fail "--tag 缺少参数"; TAG="$2"; shift ;;
        --image) [ "$#" -ge 2 ] || fail "--image 缺少参数"; IMAGE="$2"; shift ;;
        -h | --help) usage; exit 0 ;;
        *) fail "未知参数：$1（使用 --help 查看用法）" ;;
    esac
    shift
done

# ---- [1] 选择构建上下文 ----
if [ -f "$ROOT/tGo-Setup/required-files.txt" ] && [ -f "$ROOT/tGo-Setup/backend/requirements.txt" ]; then
    CONTEXT="$ROOT/tGo-Setup"
else
    CONTEXT="$ROOT"
fi
DOCKERFILE="$ROOT/tools/Dockerfile"

[ -f "$DOCKERFILE" ] || fail "文件缺失：$DOCKERFILE"
[ -f "$CONTEXT/required-files.txt" ] || fail "文件缺失：$CONTEXT/required-files.txt（构建上下文不完整）"
[ -f "$CONTEXT/backend/requirements.txt" ] || fail "文件缺失：$CONTEXT/backend/requirements.txt"
[ -f "$CONTEXT/backend/app/main.py" ] || fail "文件缺失：$CONTEXT/backend/app/main.py"
[ -f "$CONTEXT/frontend/static/index.html" ] || fail "文件缺失：$CONTEXT/frontend/static/index.html"
[ -f "$CONTEXT/tools/docker-entrypoint.sh" ] || fail "文件缺失：$CONTEXT/tools/docker-entrypoint.sh（请重跑 tools/make-setup.ps1 同步发布包）"

command -v docker >/dev/null 2>&1 || fail "未找到 docker 命令；请先安装 Docker Engine 或 Docker Desktop"
docker info >/dev/null 2>&1 || fail "Docker 守护进程不可用（请启动 Docker 服务，或检查当前用户是否有权限）"

log "[1] 构建上下文：$CONTEXT"
log "[1] Dockerfile ：$DOCKERFILE"

# ---- [2] 引擎/模型存在性（镜像永不打包；默认仅提示，--require-engine 时严格）----
ENGINE_BIN="$CONTEXT/engine/katago/katago"
ENGINE_EXE="$CONTEXT/engine/katago/katago.exe"
MODEL_DIR="$CONTEXT/engine/models"
MISSING_TEXT=""
add_missing() { MISSING_TEXT="${MISSING_TEXT}  - $1
"; }

if [ ! -f "$ENGINE_BIN" ]; then
    if [ -f "$ENGINE_EXE" ]; then
        add_missing "engine/katago/katago（检测到 Windows 版 katago.exe；容器需要 Linux 版可执行文件）"
    else
        add_missing "engine/katago/katago（Linux 版 KataGo 可执行文件）"
    fi
fi
if ! compgen -G "$MODEL_DIR/*.bin.gz" >/dev/null 2>&1; then
    add_missing "engine/models/*.bin.gz（至少一个模型文件）"
fi

if [ -n "$MISSING_TEXT" ]; then
    if [ "$REQUIRE_ENGINE" -eq 1 ]; then
        err "[2] 引擎/模型缺失（已指定 --require-engine）："
        printf '%s' "$MISSING_TEXT" >&2
        err "    构建上下文：$CONTEXT"
        err "    下载：https://github.com/lightvector/KataGo/releases （选择 *-linux-x64.zip）"
        err "    镜像不会打包引擎/模型，此参数仅做存在性校验；如仅需人人对弈/复盘，可去掉 --require-engine"
        exit 1
    fi
    log "[2] 提示：镜像不包含引擎/模型（运行时由 compose 挂载）——"
    printf '%s' "$MISSING_TEXT"
    log "    容器仍可运行：人人对弈、复盘、棋谱导入导出可用；AI 功能降级"
else
    # 从 Windows/SMB 拷贝到 Linux 常丢执行位；尽力补齐（失败不阻断，容器入口会再试）
    if [ ! -x "$ENGINE_BIN" ]; then
        chmod +x "$ENGINE_BIN" 2>/dev/null || true
    fi
    log "[2] 引擎/模型校验通过：$ENGINE_BIN"
fi

# ---- [3] 构建镜像 ----
BUILD_ARGS=(build -f "$DOCKERFILE" -t "$IMAGE:$TAG")
if [ "$NO_CACHE" -eq 1 ]; then
    BUILD_ARGS+=(--no-cache)
fi
if [ "$PULL" -eq 1 ]; then
    BUILD_ARGS+=(--pull)
fi
BUILD_ARGS+=("$CONTEXT")

log "[3] docker ${BUILD_ARGS[*]}"
docker "${BUILD_ARGS[@]}"

# ---- 完成 ----
log "============================================================"
log "  tGo 镜像构建完成"
log "============================================================"
log "  - 镜像 : $IMAGE:$TAG"
log "  - 目录 : $CONTEXT"
log "  - 端口 : http://<主机 IP>:$HTTP_PORT/"
log "  - 启动 : cd $CONTEXT && docker compose up -d"
log "  - 日志 : cd $CONTEXT && docker compose logs -f"
log "  - 数据 : ./config、./data、./logs、./engine（宿主机持久化）"
log "============================================================"
