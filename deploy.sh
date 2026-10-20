#!/usr/bin/env bash
# ============================================================================
# tGo Linux 部署/运维脚本
#
# 用法：
#   ./deploy.sh                       # 一键部署：文件预检 → 创建/复用 backend/.venv → 安装依赖
#   ./deploy.sh install [--service]   # 同上；--service 同时安装 systemd 自启服务并启动
#   ./deploy.sh run [--open] [--new]  # 前台运行（Ctrl+C 停止；--open 就绪后打开浏览器；--new 忽略复用强制新起）
#   ./deploy.sh upgrade               # 升级：重校验/安装依赖 + 重装单元并重启服务（保留用户配置）
#   ./deploy.sh service install       # 安装 systemd 服务（开机自启）
#   ./deploy.sh service uninstall     # 卸载 systemd 服务（不删除用户数据）
#   ./deploy.sh service start|stop|restart|status|logs
#   ./deploy.sh help
#
# 幂等与数据保护：
#   - venv 存在且可用即复用；依赖以 requirements.txt 哈希记账（未变跳过 pip，变更自动重装）；
#   - 重复安装/启动安全；升级/卸载均不覆盖 config.yaml / data/ / logs/ / engine/。
#
# 引擎可执行文件（路径优先取用户 config.yaml 的 engine.executable_dir；默认 engine/katago 兜底）：
#   - 预检自动补齐执行位（从 Windows 拷贝/解压常丢）并做一次 `katago version` 自检；
#   - 引擎不可用仅提示（人人对弈与复盘不受影响），不阻断部署/启动。
#
# 编码：本文件为 UTF-8（Linux 终端默认 UTF-8，无 Windows 代码页问题）。
# ============================================================================

set -euo pipefail

# 与 Windows start.ps1 同口径：强制 Python UTF-8 输出（任意 locale 下中文提示一致）
export PYTHONUTF8=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
VENV="$BACKEND/.venv"
VENV_PY="$VENV/bin/python"
REQUIREMENTS="$BACKEND/requirements.txt"
STAMP="$VENV/.tgo-deps-stamp.json"
UNIT_TEMPLATE="$ROOT/tgo.service"
UNIT_TARGET="/etc/systemd/system/tgo.service"
SERVICE_NAME="tgo.service"
MIN_PY="3.10"
SUDO=""

log() { printf '[tGo] %s\n' "$*"; }
# 错误行红色高亮（仅交互终端；NO_COLOR 置位或重定向时无色），与 Windows 版 Write-Err 同语义
err() {
    if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
        printf '[tGo] \033[31m%s\033[0m\n' "$*" >&2
    else
        printf '[tGo] %s\n' "$*" >&2
    fi
}
fail() { err "$*"; exit 1; }

# 横幅（与 Windows start.ps1 / launcher 同排版：60 个 '=' 分隔线 + 缩进标题）
BANNER_WIDTH=60
banner_line() { printf '%*s' "$BANNER_WIDTH" '' | tr ' ' '='; }
banner() {
    printf '[tGo] %s\n' "$(banner_line)"
    printf '[tGo]   %s\n' "$*"
    printf '[tGo] %s\n' "$(banner_line)"
}

usage() {
    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# -------------------- 基础工具 --------------------

need_sudo() {
    if [ "$(id -u)" -eq 0 ]; then
        SUDO=""
        return 0
    fi
    command -v sudo >/dev/null 2>&1 || fail "需要 root 权限（请以 root 运行或安装 sudo）"
    SUDO="sudo"
}

service_user() {
    if [ -n "${SUDO_USER:-}" ]; then
        printf '%s\n' "$SUDO_USER"
    elif [ "$(id -u)" -eq 0 ]; then
        printf 'root\n'
    else
        id -un
    fi
}

service_group() {
    id -gn "$(service_user)" 2>/dev/null || printf '%s\n' "$(service_user)"
}

configured_port() {
    (cd "$BACKEND" && "$VENV_PY" -c 'from app.config import load_config; print(load_config().server.port)' 2>/dev/null) || printf '8090\n'
}

# -------------------- 预检（安装前校验文件完整性） --------------------

preflight() {
    log "[1] 文件与环境预检（required-files.txt 全量清单）…"
    local manifest="$ROOT/required-files.txt"
    [ -f "$manifest" ] || fail "文件缺失：required-files.txt（部署包不完整，请重新获取完整项目文件）"
    [ -f "$UNIT_TEMPLATE" ] || fail "文件缺失：$UNIT_TEMPLATE（systemd 单元模板）"

    local missing=() damaged=() line file count=0
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        case "$line" in '' | '#'*) continue ;; esac
        count=$((count + 1))
        file="$ROOT/$line"
        if [ ! -f "$file" ]; then
            missing+=("$line")
        elif [ ! -s "$file" ]; then
            damaged+=("$line")
        fi
    done < "$manifest"

    if [ "${#missing[@]}" -gt 0 ] || [ "${#damaged[@]}" -gt 0 ]; then
        if [ "${#missing[@]}" -gt 0 ]; then
            err "[1] 文件缺失（${#missing[@]} 项）："
            printf '  - %s\n' "${missing[@]}" >&2
        fi
        if [ "${#damaged[@]}" -gt 0 ]; then
            err "[1] 文件损坏（0 字节，${#damaged[@]} 项）："
            printf '  - %s\n' "${damaged[@]}" >&2
        fi
        fail "[1] 部署包不完整（共校验 $count 项运行文件），请重新获取完整项目文件"
    fi
    log "[1] 通过：共校验 $count 项运行文件"

    # 引擎/模型配置解析（用户 config.yaml 优先，默认路径仅兜底）→ 再按解析结果自检
    resolve_engine_paths
    if [ "$TGO_EXE_DIR_SOURCE" = "config.yaml" ] || [ "$TGO_MODEL_DIR_SOURCE" = "config.yaml" ] \
        || [ -n "$TGO_STANDARD_MODEL" ] || [ -n "$TGO_HUMAN_MODEL" ]; then
        # 逐项换行显示：路径较长，挤在一行不便阅读（列表样式同文件缺失清单）
        log "[1] 引擎配置取自用户配置（$TGO_CONFIG_FILE）："
        printf '  - %s\n' "executable_dir=$TGO_EXE_DIR"
        printf '  - %s\n' "model_dir=$TGO_MODEL_DIR"
        printf '  - %s\n' "standard_model=${TGO_STANDARD_MODEL:-自动扫描}"
        printf '  - %s\n' "human_model=${TGO_HUMAN_MODEL:-自动扫描}"
    fi
    # 引擎可执行文件自检（补齐执行位 + 拉起自检；仅提示，不阻断）
    check_engine_binary
    # 模型预检（口径同后端 resolve_models；缺失＝**引擎**不可用降级，不阻碍进入——BUG-090）
    resolve_model_status
    case "$TGO_STANDARD_STATUS" in
        ok) ;;
        missing_declared)
            log "[1] 提示：未找到标准模型 $TGO_STANDARD_MODEL（model_dir=$TGO_MODEL_DIR）—— 引擎不可用（标准模型缺失）；人人对弈与复盘不受影响"
            ;;
        *)
            log "[1] 提示：未找到模型文件（model_dir=$TGO_MODEL_DIR，来源：$TGO_MODEL_DIR_SOURCE）—— 引擎不可用（标准模型缺失）；人人对弈与复盘不受影响"
            ;;
    esac
    case "$TGO_HUMAN_STATUS" in
        missing_declared)
            log "[1] 提示：未找到人类模型 $TGO_HUMAN_MODEL（model_dir=$TGO_MODEL_DIR）—— 仅标准风格可用（人类模型缺失降级）"
            ;;
        missing_auto)
            log "[1] 提示：未找到人类模型（*human*.bin.gz）—— 仅标准风格可用（人类模型缺失降级）"
            ;;
    esac
}

# -------------------- 引擎/模型路径（用户 config.yaml 优先，默认仅兜底） --------------------
# 路径/模型口径与应用侧一致（backend/app/config.py::resolve_config_path / engine_path、
# backend/app/engine/models.py::resolve_models）：
#   配置文件 = 环境变量 TGO_CONFIG > 项目根 config.yaml；engine.executable_dir /
#   engine.model_dir 相对路径锚定项目根；未声明 → 默认路径兜底（绝不硬编码为唯一来源）；
#   可执行文件名按平台识别（Linux 优先 katago，与后端 manager.py 同口径）；
#   engine.standard_model / engine.human_model 声明时按**文件名精确校验**（不回落自动
#   扫描，与后端一致）；未声明 → 标准模型扫 *.bin.gz（排除人类模型）、人类模型扫 *human*。
# 配置只做声明式标量的最小子集解析（与产品自写的 yaml.safe_dump 输出一致）；解析不到即回退
# 默认，提示信息回显「来源 + 最终路径」——解析差异一眼可见，不因格式差异误报「文件缺失」。
TGO_CONFIG_FILE=""
TGO_EXE_DIR=""
TGO_EXE=""
TGO_EXE_DIR_SOURCE=""
TGO_MODEL_DIR=""
TGO_MODEL_DIR_SOURCE=""
TGO_STANDARD_MODEL=""
TGO_HUMAN_MODEL=""
TGO_STANDARD_STATUS=""
TGO_HUMAN_STATUS=""

# 取 config.yaml 中 engine 段下的标量（块式映射 + 可选引号/行内注释）
read_engine_scalar() {
    local file="$1" key="$2"
    [ -f "$file" ] || return 0
    # awk 缺失时按「未声明」处理（回退默认；绝不因工具缺失误报文件缺失）
    command -v awk >/dev/null 2>&1 || return 0
    awk -v key="$key" '
        { sub(/\r$/, "") }
        /^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
        /^engine[[:space:]]*:/ { engine = 1; next }
        /^[^[:space:]]/ { engine = 0; next }
        engine != 1 { next }
        {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            keypart = line
            sub(/[[:space:]]*:.*/, "", keypart)
            if (keypart != key) next
            value = line
            sub(/^[^:]*:[[:space:]]*/, "", value)
            sub(/[[:space:]]+$/, "", value)
            print value
            exit
        }
    ' "$file"
}

# 标量清洗：先去行内注释与右空白，再去成对引号（YAML 要求 '#' 前有空白，路径中的 '#' 原样保留）
clean_config_scalar() {
    printf '%s' "$1" | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# 解析引擎/模型路径：用户 config.yaml 优先，默认兜底（结果存全局供自检使用）
resolve_engine_paths() {
    local value
    TGO_CONFIG_FILE="${TGO_CONFIG:-$ROOT/config.yaml}"
    TGO_EXE_DIR="engine/katago"; TGO_EXE_DIR_SOURCE="默认兜底"
    TGO_MODEL_DIR="engine/models"; TGO_MODEL_DIR_SOURCE="默认兜底"

    value="$(read_engine_scalar "$TGO_CONFIG_FILE" executable_dir || true)"
    if [ -n "$value" ]; then
        TGO_EXE_DIR="$(clean_config_scalar "$value")"; TGO_EXE_DIR_SOURCE="config.yaml"
    fi
    value="$(read_engine_scalar "$TGO_CONFIG_FILE" model_dir || true)"
    if [ -n "$value" ]; then
        TGO_MODEL_DIR="$(clean_config_scalar "$value")"; TGO_MODEL_DIR_SOURCE="config.yaml"
    fi
    # 模型文件名（可空：空=自动扫描，与后端 resolve_models 同口径）
    TGO_STANDARD_MODEL="$(read_engine_scalar "$TGO_CONFIG_FILE" standard_model || true)"
    TGO_STANDARD_MODEL="$(clean_config_scalar "$TGO_STANDARD_MODEL")"
    TGO_HUMAN_MODEL="$(read_engine_scalar "$TGO_CONFIG_FILE" human_model || true)"
    TGO_HUMAN_MODEL="$(clean_config_scalar "$TGO_HUMAN_MODEL")"

    # 相对路径锚定项目根（绝对路径原样使用）
    case "$TGO_EXE_DIR" in /*) ;; *) TGO_EXE_DIR="$ROOT/$TGO_EXE_DIR" ;; esac
    case "$TGO_MODEL_DIR" in /*) ;; *) TGO_MODEL_DIR="$ROOT/$TGO_MODEL_DIR" ;; esac

    # 可执行文件名按平台识别（Linux 优先 katago）
    TGO_EXE=""
    local name
    for name in katago katago.exe; do
        if [ -f "$TGO_EXE_DIR/$name" ]; then TGO_EXE="$TGO_EXE_DIR/$name"; break; fi
    done
}

# 模型可用性判定（口径同后端 app/engine/models.py::resolve_models）：
#   声明 → 文件名精确校验（不回落自动扫描）；未声明 → 标准模型扫 *.bin.gz（排除人类模型）、
#   人类模型扫 *human*（忽略大小写）；结果存全局 TGO_STANDARD_STATUS / TGO_HUMAN_STATUS
resolve_model_status() {
    local files=() name
    TGO_STANDARD_STATUS="missing_auto"
    TGO_HUMAN_STATUS="missing_auto"
    shopt -s nullglob
    files=("$TGO_MODEL_DIR"/*.bin.gz)
    shopt -u nullglob
    if [ -n "$TGO_STANDARD_MODEL" ]; then
        if [ -f "$TGO_MODEL_DIR/$TGO_STANDARD_MODEL" ]; then
            TGO_STANDARD_STATUS="ok"
        else
            TGO_STANDARD_STATUS="missing_declared"
        fi
    else
        for name in "${files[@]}"; do
            case "${name##*/}" in
                *[Hh][Uu][Mm][Aa][Nn]*) continue ;;   # 人类模型不参与标准模型自动扫描
                *)
                    TGO_STANDARD_STATUS="ok"
                    break
                    ;;
            esac
        done
    fi
    if [ -n "$TGO_HUMAN_MODEL" ]; then
        if [ -f "$TGO_MODEL_DIR/$TGO_HUMAN_MODEL" ]; then
            TGO_HUMAN_STATUS="ok"
        else
            TGO_HUMAN_STATUS="missing_declared"
        fi
    else
        for name in "${files[@]}"; do
            case "${name##*/}" in
                *[Hh][Uu][Mm][Aa][Nn]*)
                    TGO_HUMAN_STATUS="ok"
                    break
                    ;;
            esac
        done
    fi
}

# 引擎可执行文件自检（BUG-131）：从 Windows 拷贝（SMB / File Station）或 zip 解压常丢执行位，
# 那时后端只会在 tgo.log 里抛 `PermissionError: [Errno 13] Permission denied`（管理器归为
# 「引擎进程创建异常」），用户无从判断该改什么。此处：
#   ① 就地补齐执行位（幂等、无副作用）；
#   ② 真实拉起一次 `katago version`（KataGo cpp/main.cpp：`version : Print version and exit.`，
#      不加载模型、不占 GPU）以区分「执行位缺失 / noexec 挂载 / 架构不匹配 / 动态库缺失」。
# 引擎为可选组件（缺失/损坏时人人对弈与复盘照常）：全部只提示，不阻断部署与启动。
check_engine_binary() {
    if [ -z "$TGO_EXE" ]; then
        log "[1] 提示：未找到引擎可执行文件（executable_dir=$TGO_EXE_DIR，来源：$TGO_EXE_DIR_SOURCE）—— 引擎不可用（引擎可执行文件缺失）；人人对弈与复盘不受影响"
        return 0
    fi
    local exe="$TGO_EXE"
    if [ ! -x "$exe" ] && chmod +x "$exe" 2>/dev/null; then
        log "[1] 已补齐引擎可执行文件的执行位（$exe：chmod +x）"
    fi

    local -a probe=( "$exe" version )
    if command -v timeout >/dev/null 2>&1; then
        probe=( timeout 20 "$exe" version )
    fi
    # LC_ALL=C：错误信息固定为英文，供下方 case 精确分类（与终端 locale 无关）
    local output="" rc=0
    output="$(LC_ALL=C "${probe[@]}" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then
        log "[1] 引擎自检通过（${output%%$'\n'*}）"
        return 0
    fi

    case "$output" in
        *"Permission denied"*)
            err "[1] 提示：引擎不可执行（Permission denied）—— 执行位缺失或所在卷以 noexec 挂载；请 chmod +x $exe，必要时把引擎目录移到可执行分区"
            ;;
        *"Exec format error"* | *"cannot execute binary file"*)
            err "[1] 提示：引擎不可执行（架构不匹配）—— 二进制与当前 CPU/系统不符（如 ARM 设备放了 x86_64 版），请换对应平台构建"
            ;;
        *"No such file or directory"*)
            err "[1] 提示：引擎不可执行（动态库/加载器缺失）—— 常见为缺 libOpenCL.so.1 等运行库，请安装对应依赖"
            ;;
        *)
            err "[1] 提示：引擎自检失败（exit=$rc）：${output:-无输出（可能被 timeout 20s 终止）}"
            ;;
    esac
    log "[1] 引擎不可用不影响服务启动（人人对弈与复盘照常）"
}

# -------------------- venv 与依赖（幂等） --------------------

find_base_python() {
    local candidate
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 \
            && "$candidate" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >/dev/null 2>&1; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

venv_usable() {
    [ -x "$VENV_PY" ] \
        && "$VENV_PY" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >/dev/null 2>&1
}

ensure_venv() {
    if venv_usable; then
        return 0
    fi
    local base
    base="$(find_base_python)" \
        || fail "未找到 Python ${MIN_PY}+（Debian/Ubuntu: sudo apt install python3 python3-venv）"
    log "[2] 首次启动：创建虚拟环境 backend/.venv …"
    "$base" -m venv "$VENV" \
        || fail "虚拟环境创建失败（backend/.venv；Debian/Ubuntu 需安装 python3-venv）"
    venv_usable || fail "虚拟环境不可用（backend/.venv）"
}

hash_file() {
    "$VENV_PY" -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
}

py_version() {
    "$VENV_PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])'
}

stamp_matches() {
    [ -f "$STAMP" ] || return 1
    "$VENV_PY" - "$STAMP" "$1" "$2" <<'PY'
import json
import sys

path, want_hash, want_python = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, ValueError):
    sys.exit(1)
sys.exit(0 if data.get("requirements_sha256") == want_hash and data.get("python") == want_python else 1)
PY
}

write_stamp() {
    "$VENV_PY" - "$STAMP" "$1" "$2" <<'PY'
import datetime
import json
import sys

path, req_hash, python_version = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "requirements_sha256": req_hash,
            "python": python_version,
            "installed_at": datetime.datetime.now().isoformat(),
        },
        handle,
    )
PY
}

ensure_deps() {
    ensure_venv
    local req_hash python_version
    req_hash="$(hash_file "$REQUIREMENTS")"
    python_version="$(py_version)"
    if stamp_matches "$req_hash" "$python_version"; then
        log "[2] 依赖已是最新（跳过安装）：Python $python_version @ backend/.venv"
        return 0
    fi
    log "[2] 安装/校验 Python 依赖（首次安装或 requirements.txt 已变更）…"
    "$VENV_PY" -m pip install --disable-pip-version-check -r "$REQUIREMENTS" \
        || fail "依赖安装失败（pip install -r requirements.txt），请检查网络后重试"
    log "[2] 依赖与应用模块导入冒烟校验…"
    (cd "$BACKEND" && "$VENV_PY" -c "import fastapi, uvicorn, pydantic, aiosqlite, psutil, yaml, multipart, app.main") \
        || fail "依赖/应用模块导入校验失败（安装不完整或后端文件缺失），请删除 backend/.venv 后重试"
    write_stamp "$req_hash" "$python_version"
}

# -------------------- systemd 安装/卸载/管理 --------------------

render_unit() {
    local target="$1" user group
    user="$(service_user)"
    group="$(service_group)"
    "$VENV_PY" - "$UNIT_TEMPLATE" "$target" "$ROOT" "$VENV_PY" "$user" "$group" <<'PY'
import sys

template_path, target_path, root, venv_python, user, group = sys.argv[1:7]
with open(template_path, encoding="utf-8") as handle:
    unit = handle.read()
unit = (
    unit.replace("@ROOT@", root)
    .replace("@VENV_PY@", venv_python)
    .replace("@USER@", user)
    .replace("@GROUP@", group)
)
with open(target_path, "w", encoding="utf-8") as handle:
    handle.write(unit)
PY
}

install_unit() {
    need_sudo
    local tmp user
    tmp="$(mktemp)"
    render_unit "$tmp"
    $SUDO install -m 0644 "$tmp" "$UNIT_TARGET"
    rm -f "$tmp"
    $SUDO systemctl daemon-reload
    user="$(service_user)"
    if $SUDO systemctl is-active --quiet "$SERVICE_NAME"; then
        $SUDO systemctl restart "$SERVICE_NAME"
        log "[3] 服务已重启以应用当前单元/代码（systemd: $SERVICE_NAME，运行用户: $user）"
    else
        $SUDO systemctl enable --now "$SERVICE_NAME"
        log "[3] 服务已安装并启动（systemd: $SERVICE_NAME，运行用户: $user，开机自启）"
    fi
}

install_service() {
    preflight
    ensure_deps
    install_unit
    print_access_hint
}

uninstall_service() {
    need_sudo
    $SUDO systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    if [ -f "$UNIT_TARGET" ]; then
        $SUDO rm -f "$UNIT_TARGET"
    fi
    $SUDO systemctl daemon-reload
    log "服务已卸载（systemd: $SERVICE_NAME）"
    log "用户配置与数据均保留：config.yaml / data/ / logs/ / engine/ "
}

service_ctl() {
    need_sudo
    case "$1" in
        start | stop | restart)
            $SUDO systemctl "$1" "$SERVICE_NAME"
            log "已执行：systemctl $1 $SERVICE_NAME"
            ;;
        status)
            $SUDO systemctl status "$SERVICE_NAME" --no-pager || true
            log "配置端口：$(configured_port)（端口被占用时启动器自动 +1，实际端口见日志）"
            ;;
    esac
}

service_logs() {
    need_sudo
    $SUDO journalctl -u "$SERVICE_NAME" -n 200 -f
}

print_access_hint() {
    local port lan_ip
    port="$(configured_port)"
    lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
    printf '[tGo] %s\n' "$(banner_line)"
    printf '[tGo]   %s\n' "tGo Server"
    printf '[tGo]   - %-8s : %s\n' "LAN" "http://${lan_ip:-<本机IP>}:${port}/"
    printf '[tGo] %s\n' "$(banner_line)"
    log "（局域网可达；端口冲突时自动 +1，实际端口以服务日志为准）"
    log "查看日志：./deploy.sh service logs ｜ 服务状态：./deploy.sh service status"
}

# -------------------- 命令入口 --------------------

cmd_install() {
    local with_service=0 arg
    for arg in "$@"; do
        case "$arg" in
            --service) with_service=1 ;;
            *) fail "未知参数：$arg（用法见 ./deploy.sh help）" ;;
        esac
    done
    banner "tGo 一键部署（Linux · deploy.sh install）"
    preflight
    ensure_deps
    if [ "$with_service" -eq 1 ]; then
        install_unit
        print_access_hint
    else
        log "[3] 部署完成：运行环境已就绪（backend/.venv 依赖已安装/校验）"
        log "[3] 前台启动：./deploy.sh run ｜ 安装 systemd 自启：./deploy.sh install --service"
    fi
}

cmd_run() {
    local arg open_flag=0 new_flag=0
    for arg in "$@"; do
        case "$arg" in
            --open) open_flag=1 ;;
            --new) new_flag=1 ;;
            *) fail "未知参数：$arg（用法见 ./deploy.sh help）" ;;
        esac
    done
    banner "tGo 一键启动（Linux · deploy.sh run）"
    preflight
    ensure_deps
    log "[3] 启动服务（Ctrl+C 停止）…"
    cd "$BACKEND"
    if [ "$open_flag" -eq 1 ] && [ "$new_flag" -eq 1 ]; then
        exec "$VENV_PY" -m app.launcher --open --new
    fi
    if [ "$open_flag" -eq 1 ]; then
        exec "$VENV_PY" -m app.launcher --open
    fi
    if [ "$new_flag" -eq 1 ]; then
        exec "$VENV_PY" -m app.launcher --new
    fi
    exec "$VENV_PY" -m app.launcher
}

cmd_upgrade() {
    banner "tGo 一键升级（Linux · deploy.sh upgrade）"
    preflight
    ensure_deps
    if [ -f "$UNIT_TARGET" ]; then
        install_unit
        print_access_hint
        log "[3] 升级完成：依赖已校验、系统服务已重启"
    else
        log "[3] 升级完成：依赖已校验（未安装 systemd 服务；如需自启请执行 ./deploy.sh install --service）"
    fi
}

cmd_service() {
    local sub="${1:-}"
    case "$sub" in
        install) install_service ;;
        uninstall) uninstall_service ;;
        start | stop | restart | status) service_ctl "$sub" ;;
        logs) service_logs ;;
        *) fail "用法：./deploy.sh service install|uninstall|start|stop|restart|status|logs" ;;
    esac
}

main() {
    local command="${1:-install}"
    shift || true
    case "$command" in
        install) cmd_install "$@" ;;
        run) cmd_run "$@" ;;
        upgrade) cmd_upgrade "$@" ;;
        service) cmd_service "$@" ;;
        help | -h | --help) usage ;;
        *) fail "未知命令：$command（./deploy.sh help 查看用法）" ;;
    esac
}

main "$@"
