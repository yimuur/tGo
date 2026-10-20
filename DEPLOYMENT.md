# tGo 部署指南

适用版本：v1.0.x ｜ 更新日期：2026-10-20

tGo 是运行在一台主机上的围棋对弈与 AI 复盘服务。同一局域网内的电脑、平板、手机用浏览器访问即可，无需安装客户端，也无需注册账号。

系统提供三种部署方式，任选其一：

| 方式 | 适用环境 | 特点 |
| --- | --- | --- |
| Windows 一键启动 | Windows 10 / 11 | 双击即用，自动准备运行环境并打开浏览器 |
| Linux 脚本 + systemd | Debian / Ubuntu 等 | 可安装为开机自启的后台服务 |
| Docker | Linux / NAS | 环境隔离，配置与数据挂载在宿主机 |

> 同一台机器只运行一种方式，避免端口与数据库冲突。

---

## 1. 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10/11；Debian 系 Linux | 单机部署 |
| Python | 3.10 或更高 | 只需系统安装一次；一键脚本自动创建虚拟环境并安装依赖 |
| 显卡 | 支持 OpenCL 的 GPU（可选） | 无显卡时人人对弈、复盘、棋谱导入导出照常，仅 AI 功能不可用 |
| 内存 | 建议 8 GB 以上 | AI 缓存按实际使用逐步增长 |
| 磁盘 | 约 2 GB 富余 | 运行环境约 250 MB + 两个模型约 180 MB |
| 端口 | 默认 8090 | 被其他程序占用时自动顺延，最多 +10 |
| 浏览器 | 现代浏览器 | 前端为静态资源，无需构建步骤 |

引擎与模型文件（缺失不影响启动，仅提示）：

```text
engine/katago/     # 引擎可执行文件（Windows：katago.exe 及同目录全部 dll；Linux：katago）
engine/models/     # 模型文件（*.bin.gz）
```

- 模型文件名不需要解压；标准模型必需，人类模型（文件名含 `human`）可选。
- 也可在管理页「版本与资源」卡片内直接从官方源下载安装引擎与模型（需主机可访问外网）。
- Linux 下引擎文件需有执行位。从 Windows 拷贝或解压常会丢失，`deploy.sh` 会自动补齐并做一次版本自检。

---

## 2. 安全说明

- 本系统**没有账号与密码**，设计为可信局域网内的单机服务。切勿将端口直接暴露到公网。
- 如确需跨网络访问，请在反向代理层补充鉴权（Basic Auth / mTLS / SSO），并把代理域名加入 WebSocket 白名单：

  ```bash
  export TGO_WS_ALLOWED_ORIGINS="tgo.example.com:8443"
  ```

- 对弈与管理两个 WebSocket 通道都会校验 `Origin` 与请求 `Host` 同源；经主机名 / IP 直接访问天然满足，跨源请求被拒绝（`close 1008`）。命令行等无 `Origin` 的客户端放行。

---

## 3. 目录与数据

工程根目录即部署目录。下列内容在升级、重装、卸载服务时**始终保留**：

| 路径 | 内容 |
| --- | --- |
| `config.yaml` | 用户配置（只保存与默认值不同的项） |
| `engine/` | 引擎、模型与引擎参数文件 `analysis.cfg` |
| `data/tgo.db` | 对局数据库（唯一事实源，建议定期备份） |
| `logs/` | 运行日志（自动轮转） |
| `backend/.venv/` | 运行环境，由脚本管理；依赖未变时复用 |
| `backend/default.yaml`、`backend/default.cfg` | 默认配置兜底，缺失时自动生成，无需手改 |

- `engine/katago/analysis.cfg` 属于用户层文件，可直接修改；程序只校正线程数等少量应用维护项，不会整体覆写。
- `data/updates/` 存放自动更新的下载与备份，可安全清理旧备份。

---

## 4. Windows 部署

双击 **`start.bat`**（或右键 `start.ps1` →「使用 PowerShell 运行」）。首次启动依次完成：

1. 按 `required-files.txt` 清单校验运行文件完整性，缺失会一次列全并中止；
2. 检查引擎与模型是否存在（缺失仅提示）；
3. 创建 `backend/.venv` 并安装依赖；
4. 启动服务并自动打开浏览器。

启动完成后窗口会显示访问地址：

```text
[tGo]   tGo Server
[tGo]   - Local    : http://127.0.0.1:8090/
[tGo]   - LAN      : http://192.168.3.7:8090/
```

`LAN` 一行即局域网地址，手机、平板输入它即可使用。

**常见操作**

| 操作 | 方法 |
| --- | --- |
| 停止服务 | 在启动窗口按**一次** `Ctrl+C`，等待几秒完成收尾；不要连按两次 |
| 重复启动 | 若服务已在运行，只打开浏览器、不启动第二个副本 |
| 停止已运行的副本 | 在复用提示窗口按 `S`，再按 `Y` 确认 |
| 强制新起实例 | `start.bat -New`（端口被占用时自动顺延） |
| 局域网无法访问 | 首次运行时在防火墙提示中选择「允许专用网络」 |
| 界面中文乱码 | 一键脚本已自动处理；手工启动时设置 `PYTHONUTF8=1` 并使用 UTF-8 代码页 |

> 关闭启动窗口等同于停止服务。希望长期后台运行，请使用 Linux systemd 或 Docker。

---

## 5. Linux 部署

```bash
chmod +x deploy.sh             # 首次执行（拷贝过来的文件可能没有执行位）
./deploy.sh                    # 一键部署：预检 → 创建/复用虚拟环境 → 安装依赖
./deploy.sh install --service  # 部署并安装 systemd 服务（需 sudo，开机自启）
./deploy.sh run [--open] [--new] # 前台运行；--open 就绪后打开浏览器，--new 忽略复用强制新起
./deploy.sh upgrade            # 升级：重新校验依赖并重启服务，保留用户数据
./deploy.sh service status     # 查看服务状态
./deploy.sh service logs       # 跟踪日志
./deploy.sh service uninstall  # 卸载服务（不删除配置与数据）
./deploy.sh help               # 查看全部命令
```

**说明**

- 脚本可重复执行：虚拟环境复用，依赖按 `requirements.txt` 哈希判断是否需要重装。
- 安装了 systemd 服务时，服务以调用 `sudo` 的用户身份运行，文件属主与数据权限自然一致。
- `./deploy.sh run` 与 Windows 同语义：按一次 `Ctrl+C` 优雅停止；检测到已运行实例时会提示停止或直接退出。
- 服务的 `SIGTERM` 停止流程通常在数秒内完成，最坏约 16 秒，仍在 30 秒超时内；停止后日志中应出现「tGo 应用停止」。
- 引擎自检失败仅提示、不阻断启动。按报错分类处理：

  | 报错 | 原因 | 处理 |
  | --- | --- | --- |
  | `Permission denied` | 无执行位，或所在分区以 `noexec` 挂载 | `chmod +x engine/katago/katago`；必要时更换分区 |
  | `Exec format error` | 二进制与 CPU / 系统架构不符 | 换用对应平台的 KataGo 构建 |
  | `No such file or directory` | 缺少动态库（如 `libOpenCL.so.1`） | `sudo apt install ocl-icd-libopencl1` |

---

## 6. Docker 部署

镜像**不自带** KataGo 与模型，二者通过宿主机目录挂载；镜像只包含 Python 运行时、后端代码、前端静态资源与默认配置模板。

**前置条件**

| 项目 | 要求 |
| --- | --- |
| Docker | Engine 20.10+，含 Compose v2 |
| CPU 架构 | x86_64（ARM 主机仅能使用人人对弈与复盘） |
| 引擎 | 宿主机准备 **Linux 版** `engine/katago/katago`（不能用 `katago.exe`） |
| 模型 | `engine/models/*.bin.gz` 至少一个标准模型 |

**目录结构**（相对于发布包目录，如 `tGo-Setup/`）

```text
.
├── docker-compose.yml
├── config/config.yaml      # 用户配置（首次保存时生成）
├── data/tgo.db             # 对局数据
├── logs/
├── engine/
│   ├── katago/katago
│   ├── katago/analysis.cfg # 首次启动自动生成
│   └── models/*.bin.gz
└── tools/
    ├── Dockerfile
    ├── docker-build.ps1
    └── docker-entrypoint.sh
```

**构建与启动**

```powershell
# Windows（Docker Desktop，Linux 容器模式），在仓库根执行
powershell -ExecutionPolicy Bypass -File tools\make-setup.ps1    # 先同步发布包 tGo-Setup/
powershell -ExecutionPolicy Bypass -File tools\docker-build.ps1
# 优先以 tGo-Setup/ 为构建上下文；若 tGo-Setup/ 不存在，则自动回退项目根目录
# 也可在发布包内直接运行 tools\docker-build.ps1（构建上下文即发布包根目录）
# 导出 tgo-latest.tar.gz；可选参数：-NoCache、-Pull、-Tag <标签>、-NoExport
```

```bash
# Linux / NAS
docker load -i tgo-latest.tar.gz
cd tGo-Setup
docker compose up -d
docker compose logs -f
```

- 容器内固定监听 **8090**，请保持 `config.yaml` 的 `server.port: 8090`。
- 只修改对外端口时使用环境变量：`TGO_HTTP_PORT=9090 docker compose up -d`。
- `config/`、`data/`、`logs/`、`engine/` 都是宿主机目录，容器删除重建不影响数据。
- KataGo 官方 Linux 发行包为 AppImage，容器内无 FUSE，镜像已启用 `APPIMAGE_EXTRACT_AND_RUN=1`，无需额外配置。

**GPU 后端**

| 后端 | 配置 | 适用场景 |
| --- | --- | --- |
| Eigen（CPU） | 无需配置 | 开箱可用；最慢，适合 NAS / 无独显主机 |
| OpenCL | 取消 `devices: /dev/dri` 注释，并挂载宿主机厂商 ICD / 驱动 | Intel / AMD 显卡 |
| NVIDIA CUDA | 取消 `deploy.resources` 中的 GPU 预留；宿主机安装 `nvidia-container-toolkit` | NVIDIA 显卡，需匹配的 CUDA / cuDNN 构建 |
| AMD ROCm | 透传 `/dev/kfd`、`/dev/dri`，挂载 `/opt/rocm:ro` 并设置 `LD_LIBRARY_PATH=/opt/rocm/lib:/opt/rocm/lib64` | 宿主机已安装 ROCm |

> 默认基础镜像为 `python:3.12-slim-bookworm`，不含 CUDA/cuDNN。需要容器内自带 CUDA 运行库时，请以 NVIDIA CUDA 镜像为基础自行扩展 Dockerfile。

**运维**

- 停止：`docker compose down`（30 秒优雅退出上限）。
- 升级：替换发布包 → 重新构建镜像 → `docker load -i` → `docker compose up -d`。
- 备份：复制 `config/`、`data/`、`logs/`、`engine/`。

---

## 7. 配置

`config.yaml` **只需写与默认值不同的项**，其余保持自动。示例：

```yaml
server:
  host: 0.0.0.0   # 监听全部网卡，局域网可达
  port: 8090      # 被其他程序占用时自动顺延

engine:
  standard_max_visits: 100   # 标准分析强度
  num_analysis_threads: 2
  num_search_threads_per_analysis_thread: 16
```

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `TGO_CONFIG` | 指定用户配置文件路径（默认项目根 `config.yaml`） |
| `TGO_STATIC_DIR` | 覆盖前端静态目录（默认 `frontend/static`） |
| `TGO_WS_ALLOWED_ORIGINS` | WebSocket Origin 白名单，逗号分隔 |
| `TGO_GITHUB_REPO` | 自动更新源仓库（fork / 私有镜像时使用） |

端口规则：已是运行中的 tGo 则幂等复用；被其他程序占用则依次尝试 `port+1 … port+10`；全部占用时报错退出。修改 `server.port` 后重启生效。

---

## 8. 引擎、模型与显存

- 推荐网络为 `b18c384nbt`（标准模型与 humanv0 仿人类模型，各约 90 MB），需放入 `engine/models/`；也可在管理页「版本与资源」卡片内直接下载安装（引擎与模型均支持，需主机可访问外网）。
- **模型必须与 KataGo 版本匹配**。版本不匹配时引擎启动即退出，日志出现：

  ```text
  This neural net requires a newer KataGo version … Model version: N
  ```

  此时需更换配套模型，或升级 `engine/katago/` 下的引擎文件；仅切换模型无法解决。

- 显存相关参数位于 `engine/katago/analysis.cfg`（修改后重启引擎生效，默认值见 `backend/default.cfg`）：

  | 参数 | 默认 | 说明 |
  | --- | --- | --- |
  | `nnMaxBatchSize` | 64 | 单批送 GPU 的最大局面数；显存不足时优先调小 |
  | `numAnalysisThreads` × `numSearchThreadsPerAnalysisThread` | 2 × 16 | 并发搜索线程总量 |
  | `nnCacheSizePowerOfTwo` | 23 | 主机内存缓存；按使用懒增长，内存紧张可下调 |

- 显存耗尽时引擎进入 `FATAL` 状态并在管理页显示 stderr 原因；人人对弈与复盘不受影响。
- 首次使用某块显卡或者模型时，OpenCL 会自动调优数秒至数分钟，进度显示在页面上，结果会缓存，后续启动很快。
- 多显卡主机可在 `analysis.cfg` 追加 `openclGpuToUse = 0` 指定设备。

---

## 9. 升级与备份

**方式一：覆盖文件后重跑脚本**

用新版本文件覆盖项目目录（保留用户数据），然后：

- Windows：重新双击 `start.bat`
- Linux：`./deploy.sh upgrade`

运行环境与依赖会自动校验更新，`config.yaml`、`data/`、`logs/`、`engine/` 原样保留。

**方式二：管理页自动更新**

管理页的「版本与资源」卡片可检查并安装 GitHub Releases 中的新版本：

- 仅覆盖运行文件与脚本，更新前备份到 `data/updates/backups/app-<版本>-<时间>/`，失败自动回滚；
- 完成后自动重启服务；
- **Docker 容器内不支持应用自更新**，请拉取新镜像后重建容器（引擎与模型仍可在管理页下载到挂载目录）。

**备份与恢复**

复制 `config.yaml`（Docker 为 `config/`）与 `data/` 即可；恢复时放回原位置并重启服务。数据库迁移在服务启动时自动执行，无需手工操作。

---

## 10. 故障排查

| 现象 | 处理 |
| --- | --- |
| 提示「文件缺失」 | 部署包不完整，重新获取完整文件 |
| 提示「未找到 Python 3.10+」 | 安装 Python 3.10+；Windows 勾选加入 PATH，Linux 安装 `python3-venv` |
| 局域网设备打不开 | 检查防火墙放行、`host: 0.0.0.0`、设备是否同网段，地址以启动窗口的 LAN 行为准 |
| 端口 8090–8100 均被占用 | 释放端口，或修改 `server.port` |
| 管理页显示「引擎不可用 / 标准模型缺失」 | 放入引擎与模型（见第 1 章），或直接在管理页「版本与资源」卡片下载；然后在管理页点「重启引擎」 |
| 引擎启动后立即退出并提示 `requires a newer KataGo version` | 模型与引擎版本不匹配，见第 8 章 |
| 引擎报 `PermissionError` / 无法创建进程 | 引擎无执行位或分区为 `noexec`，`chmod +x` 后重试 |
| 显存不足报错 | 调小 `analysis.cfg` 中的 `nnMaxBatchSize` |
| systemd 服务反复重启 | `./deploy.sh service logs` 查看原因，常见为端口占满或模型缺失 |
| Docker 容器一直 `unhealthy` | 查看 `docker compose logs -f`：常见为 8090 被占用、`config/` 不可写、首次调优超过健康检查宽限期 |
| Docker 报 `Cannot mount AppImage` / 退出码 127 | AppImage 运行时过旧；在宿主机执行 `./katago --appimage-extract` 后使用 `squashfs-root/AppRun` |
| Docker 报 `Exec format error` | 放入的是 Windows 版 `katago.exe` 或非 x86_64 构建，换 Linux x64 版本 |
| Docker OpenCL 报 `libOpenCL.so.1` 缺失 / 找不到设备 | 按第 6 章挂载宿主机驱动与 ICD；或改用 CPU 构建 |
| 反代后 WebSocket 被拒 | 将代理域名加入 `TGO_WS_ALLOWED_ORIGINS`，并在代理层补充鉴权 |

---

## 11. 手工运行（开发 / 高级）

```bash
cd backend
python -m venv .venv
# Windows：.venv\Scripts\activate    Linux：source .venv/bin/activate
pip install -r requirements.txt

python -m app.launcher     # 推荐：含端口探测、实例复用、端口顺延、浏览器打开
# 或仅启动 uvicorn（无端口探测语义）：
uvicorn app.main:create_app --factory
```
