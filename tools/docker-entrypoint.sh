#!/bin/sh
# ============================================================================
# tGo 容器入口：
#   1) 确保运行期目录存在（命名卷首次创建时为空）；
#   2) 尽力补齐 KataGo 执行位（从 Windows/SMB 拷贝到 Linux 常丢执行位）；
#   3) 对“误放 Windows 版 katago.exe”给出明确提示；
#   4) exec 到 CMD（由 tini 负责 PID 1 的信号转发与僵尸回收）。
# 不修改用户配置，不复制/下载任何引擎或模型。
# ============================================================================
set -eu

mkdir -p /app/config /app/data /app/logs /app/engine/katago /app/engine/models

# KataGo 官方 Linux 发行包是 AppImage：Docker 内无 FUSE，使用 extract-and-run。
# 允许用户显式覆盖（如置 0），未设置或空值时兜底为 1。
export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"

if [ -n "${TGO_HTTP_PORT:-}" ]; then
    echo "[tGo] Docker 模式：请使用 http://<宿主机 IP>:${TGO_HTTP_PORT}/ 访问（下方 LAN 地址为容器内网地址）"
fi

ENGINE_BIN=/app/engine/katago/katago
ENGINE_EXE=/app/engine/katago/katago.exe

if [ -f "$ENGINE_BIN" ] && [ ! -x "$ENGINE_BIN" ]; then
    chmod +x "$ENGINE_BIN" 2>/dev/null || true
fi

# AppImage magic（偏移 8）：Type 1 = 41 49 01，Type 2 = 41 49 02
if [ -f "$ENGINE_BIN" ]; then
    ENGINE_MAGIC=$(od -An -tx1 -j8 -N3 "$ENGINE_BIN" 2>/dev/null | tr -d ' \n')
    case "$ENGINE_MAGIC" in
        414901|414902)
            echo "[tGo] 检测到 KataGo AppImage：已启用 extract-and-run（无需 FUSE）"
            ;;
    esac
fi

if [ -f "$ENGINE_EXE" ] && [ ! -f "$ENGINE_BIN" ]; then
    echo "[tGo] 警告：engine/katago/ 中只有 Windows 版 katago.exe；Linux 容器需要 Linux 版 katago 可执行文件。" >&2
    echo "[tGo]       下载地址：https://github.com/lightvector/KataGo/releases" >&2
fi

exec "$@"
