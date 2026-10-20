# Dockerfile（使用 BuildKit 内置前端，不依赖 docker/dockerfile 外部镜像）
# ============================================================================
# tGo Docker 镜像（Linux 容器）
#
# 构建上下文：优先 tGo-Setup/（发布包，由 tools/docker-build.ps1 构建）；
# 若 tGo-Setup/ 不存在，则回退项目根目录（仓库根 .dockerignore 已排除非运行文件）。
# 镜像不含 KataGo 可执行文件与模型；二者由 docker-compose 挂载到 /app/engine：
#   ./engine/katago/katago      ← 用户提供的 **Linux** KataGo 可执行文件
#   ./engine/models/*.bin.gz    ← 标准模型（及可选的人类模型）
#   ./engine/katago/analysis.cfg ← 首次启动自动生成，持久化在宿主机
#
# 说明：
#   - 运行用户为 root。若宿主机要求 UID 映射，可在 compose 中设置 user:，并保证
#     挂载目录对相应用户可写；入口脚本会尽力补齐 KataGo 执行位。
#   - 镜像内置 OpenCL 加载器（ocl-icd-libopencl1）；使用 OpenCL 后端时仍需把
#     宿主机的厂商驱动/ICD 配置挂载进容器（见 docker-compose.yml 注释）。
#   - 纯 CPU（Eigen AVX2）可直接运行，无需任何 GPU 透传。
#   - KataGo Linux 构建针对 x86_64；ARM 宿主机上 AI 功能不可用（应用按缺失降级）。
# ============================================================================
ARG BASE_IMAGE=python:3.12-slim-bookworm
FROM ${BASE_IMAGE}

ENV PYTHONUTF8=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # KataGo 官方 Linux 发行包是 AppImage；Docker 内通常没有 FUSE。
    # extract-and-run：解包到临时目录后运行，不依赖 /dev/fuse 或 SYS_ADMIN。
    APPIMAGE_EXTRACT_AND_RUN=1

# KataGo 运行库 + OpenCL 加载器 + ROCm/AMD 运行时依赖 + 时区 + tini。
# ROCm 用户态库由宿主机 /opt/rocm 挂载提供；这里安装其依赖的系统库
# （libelf/libdrm-amdgpu/libnuma/libpciaccess 等，避免引擎加载 .so 失败）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
        tzdata \
        libstdc++6 \
        libgomp1 \
        libatomic1 \
        zlib1g \
        libssl3 \
        libzip4 \
        ocl-icd-libopencl1 \
        libelf1 \
        libdw1 \
        libdrm2 \
        libdrm-amdgpu1 \
        libnuma1 \
        libpciaccess0 \
        libudev1 \
        libzstd1 \
        libsqlite3-0 \
        libxml2 \
        libyaml-0-2 \
        libbsd0 \
        libmd0 \
        libquadmath0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖层：requirements.txt 未变时可复用缓存
COPY backend/requirements.txt /app/backend/requirements.txt
RUN python -m pip install -r /app/backend/requirements.txt

# 应用本体（来自发布包：仅运行必需文件）
COPY backend /app/backend
COPY frontend /app/frontend
COPY required-files.txt /app/required-files.txt
COPY LICENSE /app/LICENSE
COPY tools/docker-entrypoint.sh /usr/local/bin/tgo-entrypoint

# 运行期目录（被 bind mount 覆盖时以宿主机目录为准）。
# /app/config.yaml 指向 /app/config/config.yaml：保留应用「default.yaml 兜底 +
# 根 config.yaml 增量写回」语义（不使用 TGO_CONFIG 单文件模式，升级时默认值仍可演进）。
RUN chmod +x /usr/local/bin/tgo-entrypoint \
    && mkdir -p /app/config /app/data /app/logs /app/engine/katago /app/engine/models \
    && ln -sfn /app/config/config.yaml /app/config.yaml

WORKDIR /app/backend

# 容器内固定监听 8090；对外端口由 compose 的 TGO_HTTP_PORT 映射。
# Docker 模式下请保持 config.yaml 的 server.port: 8090（详见 DEPLOYMENT.md §6）。
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/api/health', timeout=3).status == 200 else 1)"

LABEL org.opencontainers.image.title="tGo" \
      org.opencontainers.image.description="tGo · KataGo Web 对弈与分析平台" \
      org.opencontainers.image.licenses="GPL-3.0-only"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tgo-entrypoint"]
CMD ["python", "-m", "app.launcher"]
