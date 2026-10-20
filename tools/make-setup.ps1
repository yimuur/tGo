# ============================================================================
# tGo 安装包同步（生成/更新 ./tGo-Setup）
#
# 内容（仅运行必需文件；不含引擎、模型、数据、日志、用户配置）：
#   [1] required-files.txt 清单内全部文件（后端运行模块 + 前端静态资源）；
#   [2] 清单外的随包文件：start.bat / start.ps1 / deploy.sh / tgo.service /
#       required-files.txt / README.md / DEPLOYMENT.md / .dockerignore /
#       docker-compose.yml / tools/Dockerfile / tools/docker-build.ps1 /
#       tools/docker-entrypoint.sh；
#   [3] 预建空目录 engine/katago/ 与 engine/models/（放置引擎与模型用）。
#
# 同步语义：
#   - backend/ 与 frontend/ 按清单镜像（清单移除的文件会从安装包同步删除）；
#   - backend/.venv/、engine/ 下用户放入的引擎/模型、data/、logs/、config.yaml 一律保留。
#
# 用法：powershell -ExecutionPolicy Bypass -File tools\make-setup.ps1 [-Pause] [-NoPause]
#   - 双击（或右键“使用 PowerShell 运行”）：任务结束后**保持窗口**，按任意键关闭，便于阅读结果；
#   - 自动化/CI：传 -NoPause（由编辑器终端等非桌面父进程启动时也不会等待按键）。
# ============================================================================

param(
    [switch]$Pause,   # 强制结束后等待按键（如经快捷方式启动）
    [switch]$NoPause  # 强制不等待（自动化调用）
)

$ErrorActionPreference = 'Stop'

# 控制台中文编码（与 start.ps1 同口径：本文件为 UTF-8 with BOM，PS 5.1 依赖 BOM 正确读取）
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { & chcp.com 65001 | Out-Null } catch { }

# 结束后是否保持窗口：双击/右键运行为“桌面启动”（直接父进程＝资源管理器/Windows Terminal）
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

$Root = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $Root 'tGo-Setup'
$Manifest = Join-Path $Root 'required-files.txt'
$BannerLine = '=' * 60

# 清单外的随包文件（启动/部署入口与说明文档）
$SupportFiles = @(
    'required-files.txt'
    'start.bat'
    'start.ps1'
    'deploy.sh'
    'tgo.service'
    'README.md'
    'LICENSE'
    'DEPLOYMENT.md'
    '.dockerignore'
    'docker-compose.yml'
    'tools/Dockerfile'
    'tools/docker-build.ps1'
    'tools/docker-entrypoint.sh'
)

# 预建空目录（仅目录，不复制任何二进制）
$PlaceholderDirs = @('engine/katago', 'engine/models')

# 镜像修剪范围（这两个树完全由清单管理；backend/.venv 由启动脚本自管，不修剪）
$MirrorDirs = @('backend', 'frontend')
$VenvPrefix = (Join-Path $Target 'backend\.venv')

function Write-Step([string]$Message) { Write-Host "[tGo] $Message" }
function Write-Err([string]$Message) {
    if ($env:NO_COLOR) { Write-Host "[tGo] $Message" } else { Write-Host "[tGo] $Message" -ForegroundColor Red }
}
function Wait-KeepOpen {
    # 双击场景：结束后保持窗口，便于阅读结果（成功与失败两条路径都等待）
    if (-not $KeepWindowOpen) { return }
    Write-Host ''
    Write-Step '按任意键关闭窗口…'
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') }
    catch {
        try { $null = [Console]::ReadKey($true) } catch { $null = Read-Host }
    }
}
function Fail([string]$Message) { Write-Err $Message; Wait-KeepOpen; exit 1 }
function SourcePath([string]$Relative) { Join-Path $Root ($Relative -replace '/', '\') }
function TargetPath([string]$Relative) { Join-Path $Target ($Relative -replace '/', '\') }

Write-Step $BannerLine
Write-Step "  tGo 安装包同步（Windows · tools\make-setup.ps1）"
Write-Step $BannerLine

# ---- [1] 读取清单并校验源文件（存在性 + 非零字节，与启动预检同口径）----
Write-Step "[1] 校验清单与源文件…"
if (-not (Test-Path $Manifest -PathType Leaf)) { Fail "[1] 文件缺失：required-files.txt（仓库根）" }
$Entries = @(
    Get-Content $Manifest -Encoding UTF8 |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne '' -and -not $_.StartsWith('#') }
)
if ($Entries.Count -eq 0) { Fail "[1] 清单为空：required-files.txt" }

$Missing = [System.Collections.Generic.List[string]]::new()
$Damaged = [System.Collections.Generic.List[string]]::new()
foreach ($Relative in ($Entries + $SupportFiles)) {
    $Source = SourcePath $Relative
    if (-not (Test-Path $Source -PathType Leaf)) { $Missing.Add($Relative) }
    elseif ((Get-Item $Source).Length -eq 0) { $Damaged.Add($Relative) }
}
if ($Missing.Count -gt 0 -or $Damaged.Count -gt 0) {
    if ($Missing.Count -gt 0) {
        Write-Err "[1] 源文件缺失（$($Missing.Count) 项）："
        foreach ($Item in $Missing) { Write-Host "  - $Item" }
    }
    if ($Damaged.Count -gt 0) {
        Write-Err "[1] 源文件损坏（0 字节，$($Damaged.Count) 项）："
        foreach ($Item in $Damaged) { Write-Host "  - $Item" }
    }
    Fail "[1] 源文件不完整（清单 $($Entries.Count) 项 + 随包 $($SupportFiles.Count) 项），请先修复仓库文件"
}
$CopyList = @($Entries) + @($SupportFiles)
Write-Step "[1] 通过：清单 $($Entries.Count) 项 + 随包 $($SupportFiles.Count) 项"

# ---- [2] 复制到安装包目录 ----
Write-Step "[2] 复制到 $Target …"
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Force -Path $Target | Out-Null }
foreach ($Relative in $CopyList) {
    $Destination = TargetPath $Relative
    $Parent = Split-Path -Parent $Destination
    if (-not (Test-Path $Parent)) { New-Item -ItemType Directory -Force -Path $Parent | Out-Null }
    Copy-Item -LiteralPath (SourcePath $Relative) -Destination $Destination -Force
}
Write-Step "[2] 已复制 $($CopyList.Count) 项文件"

# ---- [3] 预建引擎/模型目录 + 镜像修剪清单外残留 ----
foreach ($Relative in $PlaceholderDirs) {
    $Path = TargetPath $Relative
    if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
}
Write-Step "[3] 预建目录：$($PlaceholderDirs -join '、')"

$Expected = [System.Collections.Generic.HashSet[string]]::new()
foreach ($Relative in $CopyList) { $null = $Expected.Add($Relative) }
$Removed = [System.Collections.Generic.List[string]]::new()
foreach ($Mirror in $MirrorDirs) {
    $MirrorPath = TargetPath $Mirror
    if (-not (Test-Path $MirrorPath)) { continue }
    foreach ($File in (Get-ChildItem -LiteralPath $MirrorPath -Recurse -File -Force)) {
        $Relative = $File.FullName.Substring($Target.Length + 1) -replace '\\', '/'
        if ($Relative.StartsWith('backend/.venv/')) { continue }
        if ($Expected.Contains($Relative)) { continue }
        $Removed.Add($Relative)
        Remove-Item -LiteralPath $File.FullName -Force
    }
    Get-ChildItem -LiteralPath $MirrorPath -Recurse -Directory -Force |
        Where-Object { -not $_.FullName.StartsWith($VenvPrefix) } |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object {
            if (-not (Get-ChildItem -LiteralPath $_.FullName -Force)) { Remove-Item -LiteralPath $_.FullName -Force }
        }
}
Write-Step "[3] 修剪清单外残留：$($Removed.Count) 项"
foreach ($Item in $Removed) { Write-Host "  - $Item" }

# ---- 汇总 ----
$Files = @(
    Get-ChildItem -LiteralPath $Target -Recurse -File -Force |
        Where-Object { -not $_.FullName.StartsWith($VenvPrefix) }
)
Write-Step $BannerLine
Write-Step "  tGo 安装包已同步"
Write-Step $BannerLine
Write-Step "  - 目录 : $Target"
Write-Step "  - 文件 : $($Files.Count) 项（清单 $($Entries.Count) + 随包 $($SupportFiles.Count)）"
Write-Step "  - 启动 : Windows 双击 start.bat ｜ Linux ./deploy.sh run --open"
Write-Step "  - 引擎 : 置于 engine/katago/ ｜ 模型置于 engine/models/（缺失仅降级，不阻碍启动）"
Write-Step $BannerLine
Wait-KeepOpen
