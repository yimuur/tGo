# ============================================================================
# tGo Docker 镜像一键构建（Windows / Docker Desktop）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\docker-build.ps1
#   powershell -ExecutionPolicy Bypass -File tools\docker-build.ps1 -NoCache
#   powershell -ExecutionPolicy Bypass -File tools\docker-build.ps1 -Pull
#   powershell -ExecutionPolicy Bypass -File tools\docker-build.ps1 -Tag 2026.10
#   powershell -ExecutionPolicy Bypass -File tools\docker-build.ps1 -NoExport
#
# 行为：
#   1. 构建上下文优先为 <根>\tGo-Setup\（需先运行 tools\make-setup.ps1 同步发布包）；
#      若该目录不存在，则回退到 <根> 作为构建上下文（仓库根自带 .dockerignore）。
#   2. 校验 Docker 可用（Linux 容器模式）；
#   3. docker build → 导出 <根>\tgo-latest.tar.gz（可用 -NoExport 跳过）；
#      导出物可拷贝到 NAS / Linux 主机后执行 docker load -i tgo-latest.tar.gz。
#
# 说明：镜像不含 KataGo 与模型，由 docker-compose 挂载到 /app/engine：
#   ./engine/katago/katago      ← 用户提供的 **Linux** KataGo 可执行文件
#   ./engine/models/*.bin.gz    ← 标准模型（及可选的人类模型）
# ============================================================================

param(
    [switch]$NoCache,
    [switch]$Pull,
    [switch]$NoExport,
    [switch]$Pause,
    [switch]$NoPause,
    [string]$Image = $(if ($env:TGO_IMAGE) { $env:TGO_IMAGE } else { 'tgo' }),
    [string]$Tag = $(if ($env:TGO_IMAGE_TAG) { $env:TGO_IMAGE_TAG } else { 'latest' }),
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

# ---- 控制台中文编码（与本项目 start.ps1 同口径）----
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { & chcp.com 65001 | Out-Null } catch { }

$Root = Split-Path -Parent $PSScriptRoot
$BannerLine = '=' * 60

function Write-Step([string]$Message) { Write-Host "[tGo] $Message" }
function Write-Err([string]$Message) {
    if ($env:NO_COLOR) { Write-Host "[tGo] $Message" } else { Write-Host "[tGo] $Message" -ForegroundColor Red }
}
function Test-DesktopLaunched {
    try {
        $ParentId = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop).ParentProcessId
        if (-not $ParentId) { return $false }
        $ParentName = (Get-CimInstance Win32_Process -Filter "ProcessId = $ParentId" -ErrorAction Stop).Name
    } catch {
        return $false
    }
    return @('explorer.exe', 'WindowsTerminal.exe', 'wt.exe') -contains $ParentName
}
$KeepWindowOpen = if ($NoPause) { $false } elseif ($Pause) { $true } else { Test-DesktopLaunched }
function Wait-KeepOpen {
    if (-not $KeepWindowOpen) { return }
    Write-Host ''
    Write-Step '按任意键关闭窗口…'
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') }
    catch {
        try { $null = [Console]::ReadKey($true) } catch { $null = Read-Host }
    }
}
function Fail([string]$Message) {
    Write-Err $Message
    Wait-KeepOpen
    exit 1
}

Write-Step $BannerLine
Write-Step '  tGo Docker 镜像构建（Windows · tools\docker-build.ps1）'
Write-Step $BannerLine

# ---- [1] 构建上下文与 Docker 检查 ----
# 优先使用发布包；tGo-Setup 不存在时回退到脚本所在项目的根目录（兼容直接在
# 部署目录/发布包内运行 tools\docker-build.ps1 的场景）。
$SetupContext = Join-Path $Root 'tGo-Setup'
if (Test-Path $SetupContext -PathType Container) {
    $Context = $SetupContext
    $ContextLabel = 'tGo-Setup 发布包'
} else {
    $Context = $Root
    $ContextLabel = '未找到 tGo-Setup，回退项目根目录'
}
$Dockerfile = Join-Path $PSScriptRoot 'Dockerfile'
$ContextHint = if ($Context -eq $Root) {
    '请确认当前目录是完整项目根（含 backend/frontend/required-files.txt）'
} else {
    '请先运行 tools\make-setup.ps1 同步发布包'
}

if (-not (Test-Path (Join-Path $Context 'required-files.txt') -PathType Leaf)) {
    Fail "[1] 构建上下文不完整：$Context（$ContextHint）"
}
if (-not (Test-Path $Dockerfile -PathType Leaf)) { Fail "[1] 文件缺失：$Dockerfile" }
foreach ($Relative in @('required-files.txt', 'backend\requirements.txt', 'backend\app\main.py', 'frontend\static\index.html', 'tools\docker-entrypoint.sh')) {
    if (-not (Test-Path (Join-Path $Context $Relative) -PathType Leaf)) {
        Fail "[1] 构建上下文不完整：缺少 $Context\$Relative（$ContextHint）"
    }
}

$Docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $Docker) { Fail '[1] 未找到 docker 命令；请安装 Docker Desktop 并加入 PATH' }
& docker info --format '{{.OSType}}' *> $null
if ($LASTEXITCODE -ne 0) { Fail '[1] Docker 守护进程不可用（请启动 Docker Desktop，并确认已切换到 Linux 容器）' }
$OsType = (& docker info --format '{{.OSType}}').Trim()
if ($OsType -ne 'linux') { Fail "[1] 当前 Docker 为 $OsType 容器模式；本镜像需要 Linux 容器（Docker Desktop → 切换到 Linux containers）" }

Write-Step "[1] 构建上下文：$Context（$ContextLabel）"
Write-Step "[1] Dockerfile ：$Dockerfile"

# ---- [2] 构建镜像 ----
$FullImage = "${Image}:${Tag}"
$BuildArgs = @('build', '-f', $Dockerfile, '-t', $FullImage)
if ($NoCache) { $BuildArgs += '--no-cache' }
if ($Pull) { $BuildArgs += '--pull' }
$BuildArgs += $Context

Write-Step "[2] docker $($BuildArgs -join ' ')"
& docker @BuildArgs
if ($LASTEXITCODE -ne 0) { Fail "[2] 镜像构建失败（docker build 退出码 $LASTEXITCODE）" }
Write-Step "[2] 镜像构建完成：$FullImage"

if ($NoExport) {
    Write-Step '[3] 已按 -NoExport 跳过镜像导出'
    Wait-KeepOpen
    exit 0
}

# ---- [3] 导出镜像到根目录（tar.gz）----
$SafeName = ("${Image}-${Tag}") -replace '[\\/:*?"<>|]', '-'
if (-not $OutputPath) {
    $OutputPath = Join-Path $Root "$SafeName.tar.gz"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $Root $OutputPath
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$OutputDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $OutputDir -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

$TempTar = Join-Path ([System.IO.Path]::GetTempPath()) ("tgo-image-{0}.tar" -f [guid]::NewGuid().ToString('N'))
Write-Step "[3] 导出镜像 → $OutputPath（先导出临时 tar，再压缩）…"
try {
    & docker save -o $TempTar $FullImage
    if ($LASTEXITCODE -ne 0) { Fail "[3] docker save 失败（退出码 $LASTEXITCODE）" }

    $InputStream = [System.IO.File]::OpenRead($TempTar)
    $OutputStream = [System.IO.File]::Create($OutputPath)
    $GzipStream = New-Object System.IO.Compression.GZipStream($OutputStream, [System.IO.Compression.CompressionMode]::Compress)
    try {
        $InputStream.CopyTo($GzipStream)
    } finally {
        $GzipStream.Dispose()
        $OutputStream.Dispose()
        $InputStream.Dispose()
    }
} catch {
    if (Test-Path $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue }
    Fail "[3] 镜像导出失败：$($_.Exception.Message)"
} finally {
    if (Test-Path $TempTar) { Remove-Item -LiteralPath $TempTar -Force -ErrorAction SilentlyContinue }
}

$SizeMB = [math]::Round((Get-Item -LiteralPath $OutputPath).Length / 1MB, 1)

Write-Step $BannerLine
Write-Step '  tGo 镜像构建并导出完成'
Write-Step $BannerLine
Write-Step "  - 镜像     : $FullImage"
Write-Step "  - 导出文件 : $OutputPath（$SizeMB MB）"
Write-Step "  - 部署     : cd $Context; docker compose up -d"
Write-Step "  - 其它主机 : docker load -i `"$([System.IO.Path]::GetFileName($OutputPath))`""
Write-Step $BannerLine

Wait-KeepOpen
exit 0
