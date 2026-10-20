# ============================================================================
# tGo 一键发布（版本同步 → 安装包同步 → 打包 → 提交打 tag → 创建 Release）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 v0.2.0
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 0.2.0
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 v0.2.0 -Draft
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 v0.2.0 -Prerelease
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 v0.2.0 -Docker
#   powershell -ExecutionPolicy Bypass -File tools\release.ps1 v0.2.0 -NoPause
#
# 前提：
#   - 已安装 git 与 GitHub CLI（gh，位于 PATH 或 tools\gh.exe），并执行过 gh auth login；
#   - 工作区干净（git status 无改动），当前分支可推送到 origin；
#   - tag 在本地、远端、Release 中均不存在（避免覆盖已发布版本）；
#   - 指定 -Docker 时，Docker Desktop 已启动且使用 Linux 容器模式。
#
# 行为（任一步失败即中止；版本文件在提交前会回滚）：
#   [1] 校验 tag 格式、git 仓库/工作区、gh 登录、tag 与 Release 不存在；
#   [2] backend/app/version.py::APP_VERSION 写入 tag（去掉前缀 v）；
#   [3] 执行 tools/make-setup.ps1 同步 tGo-Setup（清单 + 随包文件）；
#   [4] （-Docker）执行 tools/docker-build.ps1 构建并导出 dist/tgo-latest.tar.gz
#       （镜像 tag 固定 latest，compose 可直接引用 tgo:latest）；
#   [5] 打包 dist/tGo-Setup-<tag>.zip（顶层目录 tGo-Setup/；排除引擎/模型/venv/
#       数据/日志/配置，保留 engine/katago 与 engine/models 空目录占位）；
#   [6] 仅提交 backend/app/version.py（chore(release): <tag>）；
#   [7] 创建附注 tag，推送当前分支与 tag；
#   [8] 从根目录 CHANGELOG.md 提取该版本段落作为 Release 说明（找不到则
#       --generate-notes 自动生成）；
#   [9] gh release create 上传资产并输出 Release 地址。
# ============================================================================

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Tag,

    [switch]$Draft,       # 创建为草稿 Release
    [switch]$Prerelease,  # 标记为预发布
    [switch]$Docker,      # 同步构建并导出 Docker 镜像
    [switch]$Pause,       # 强制结束后等待按键
    [switch]$NoPause      # 强制不等待（自动化调用）
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.3+ 默认可能把原生命令 stderr/非零退出码升级为终止错误；
# PS 5.1 在 Stop 策略下也有同样行为。所有原生命令经 Invoke-Native 调用，
# 统一按 $LASTEXITCODE 判断，避免绕过友好的错误提示与回滚流程。
$PSNativeCommandUseErrorActionPreference = $false

# 控制台中文编码（与 start.ps1 / make-setup.ps1 同口径）
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { & chcp.com 65001 | Out-Null } catch { }

$Root = Split-Path -Parent $PSScriptRoot
$BannerLine = '=' * 60
$VersionRelative = 'backend/app/version.py'
$VersionFile = Join-Path $Root ($VersionRelative -replace '/', '\')
$ChangelogFile = Join-Path $Root 'CHANGELOG.md'
$SetupDir = Join-Path $Root 'tGo-Setup'
$DistDir = Join-Path $Root 'dist'
$MakeSetupScript = Join-Path $PSScriptRoot 'make-setup.ps1'

# 版本文件回滚状态（仅“已写入但尚未提交”时需要回滚）
$script:VersionWritten = $false
$script:OriginalText = $null
$script:HasBom = $false

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

function Write-Step([string]$Message) { Write-Host "[tGo] $Message" }
function Write-Err([string]$Message) {
    if ($env:NO_COLOR) { Write-Host "[tGo] $Message" } else { Write-Host "[tGo] $Message" -ForegroundColor Red }
}
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
    Restore-VersionFile
    Write-Err $Message
    Wait-KeepOpen
    exit 1
}

# 提交前的失败回滚：恢复 version.py 原始内容并撤销暂存
function Restore-VersionFile {
    if (-not $script:VersionWritten) { return }
    try {
        if ($null -ne $script:OriginalText) {
            [IO.File]::WriteAllText(
                $VersionFile,
                $script:OriginalText,
                (New-Object System.Text.UTF8Encoding($script:HasBom))
            )
        }
        Invoke-Native 'git' @('reset', '-q', '--', $VersionRelative) *> $null
    } catch {
        # 回滚尽力而为；原始失败原因才是用户需要看到的信息
    }
    $script:VersionWritten = $false
}

function Assert-ExitCode([int]$Code, [string]$Message) {
    if ($Code -ne 0) { Fail $Message }
}

# 原生命令统一入口：临时降级错误策略，使非零退出码由 $LASTEXITCODE 判断
function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments
    } finally {
        $ErrorActionPreference = $previous
    }
}

# gh 优先取 PATH；兼容把 gh.exe 放在 tools\ 或 tools\gh\bin\ 的便携安装
function Resolve-GhCommand {
    $command = Get-Command gh -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $PSScriptRoot 'gh.exe'),
        (Join-Path $PSScriptRoot 'gh\bin\gh.exe')
    )) {
        if (Test-Path $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Test-ExcludedSetupPath([string]$Relative) {
    $parts = $Relative -split '/'
    $first = $parts[0].ToLowerInvariant()
    # 引擎/模型体积大且由用户自备；data/logs/config 属于运行时数据，均不入发布包
    if (@('engine', 'data', 'logs', 'config') -contains $first) { return $true }
    if ($Relative.StartsWith('backend/.venv/', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($parts -contains '__pycache__') { return $true }
    if (@($parts | Where-Object { $_ -like '.pytest_cache*' }).Count -gt 0) { return $true }
    if ($Relative -eq 'config.yaml') { return $true }
    $name = $parts[-1]
    return ($name -like '*.pyc' -or $name -like '*.pyo' -or $name -eq '.DS_Store' -or $name -eq 'Thumbs.db')
}

# 未预期异常（IO/网络/子进程）同样回滚版本文件并保留窗口供阅读
trap {
    Restore-VersionFile
    Write-Err "[tGo] 发布失败：$($_.Exception.Message)"
    Wait-KeepOpen
    exit 1
}

# ----------------------------------------------------------------------------
# [1] 环境与版本校验
# ----------------------------------------------------------------------------
Write-Step $BannerLine
Write-Step '  tGo 一键发布（Windows · tools\release.ps1）'
Write-Step $BannerLine
Write-Step '[1/9] 校验环境与版本…'

if ($Tag -notmatch '^[vV]?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)$') {
    Fail "[1] tag 格式无效：$Tag（示例：v0.2.0、0.2.0、v0.2.0-rc1）"
}
$AppVersion = $Matches[1]
$Tag = "v$AppVersion"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail '[1] 未找到 git 命令，请安装 Git 并加入 PATH' }
$GhExe = Resolve-GhCommand
if (-not $GhExe) { Fail '[1] 未找到 gh 命令（PATH、tools\gh.exe 或 tools\gh\bin\gh.exe），请安装 GitHub CLI' }
if ($Docker) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Fail '[1] 指定了 -Docker，但未找到 docker 命令；请安装/启动 Docker Desktop 并加入 PATH'
    }
    $dockerOsType = (Invoke-Native 'docker' @('info', '--format', '{{.OSType}}') 2>$null | Out-String).Trim()
    Assert-ExitCode $LASTEXITCODE '[1] Docker 守护进程不可用；请启动 Docker Desktop 后重试'
    if ($dockerOsType -ne 'linux') {
        Fail "[1] 当前 Docker 为 $dockerOsType 容器模式；构建镜像需要 Linux 容器"
    }
}
foreach ($required in @($VersionFile, $MakeSetupScript)) {
    if (-not (Test-Path $required -PathType Leaf)) { Fail "[1] 文件缺失：$required" }
}

Set-Location -LiteralPath $Root
Invoke-Native 'git' @('rev-parse', '--is-inside-work-tree') *> $null
Assert-ExitCode $LASTEXITCODE "[1] 当前目录不是 git 仓库：$Root"
Invoke-Native 'git' @('remote', 'get-url', 'origin') *> $null
Assert-ExitCode $LASTEXITCODE '[1] 未配置远端 origin，无法推送 tag'
Invoke-Native 'git' @('var', 'GIT_COMMITTER_IDENT') *> $null
Assert-ExitCode $LASTEXITCODE '[1] git 未配置 user.name/user.email，无法创建提交与 tag'

$Dirty = @(Invoke-Native 'git' @('status', '--porcelain'))
if ($Dirty.Count -gt 0) {
    Write-Err '[1] 工作区不干净，请先提交或清理以下改动：'
    foreach ($line in $Dirty) { Write-Host "  $line" }
    Fail '[1] 发布要求工作区干净（仅允许脚本自动修改 version.py）'
}

$Branch = (Invoke-Native 'git' @('rev-parse', '--abbrev-ref', 'HEAD') | Out-String).Trim()
if ($Branch -eq 'HEAD') { Fail '[1] 当前处于 detached HEAD，请切回分支后再发布' }

Invoke-Native 'git' @('rev-parse', '--verify', '--quiet', "refs/tags/$Tag") *> $null
if ($LASTEXITCODE -eq 0) { Fail "[1] 本地已存在 tag：$Tag" }
$RemoteTag = @(Invoke-Native 'git' @('ls-remote', '--tags', 'origin', "refs/tags/$Tag") 2>$null)
Assert-ExitCode $LASTEXITCODE '[1] 无法读取远端 tag（请检查网络与 origin 权限）'
if ($RemoteTag.Count -gt 0) { Fail "[1] 远端已存在 tag：$Tag" }

Invoke-Native $GhExe @('auth', 'status') *> $null
Assert-ExitCode $LASTEXITCODE '[1] GitHub CLI 未登录，请先执行 gh auth login'
Invoke-Native $GhExe @('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner') *> $null
Assert-ExitCode $LASTEXITCODE '[1] 当前仓库未关联 GitHub 仓库（gh 无法定位发布目标）'
Invoke-Native $GhExe @('release', 'view', $Tag) *> $null
if ($LASTEXITCODE -eq 0) { Fail "[1] 该 tag 已存在 Release：$Tag" }

Write-Step "[1] 通过：tag=$Tag，分支=$Branch，版本=$AppVersion"

# ----------------------------------------------------------------------------
# [2] 同步 APP_VERSION
# ----------------------------------------------------------------------------
Write-Step "[2/9] 更新 $VersionRelative …"

$raw = [IO.File]::ReadAllBytes($VersionFile)
$script:HasBom = ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF)
$script:OriginalText = [IO.File]::ReadAllText($VersionFile, [System.Text.Encoding]::UTF8)

$VersionPattern = '(?m)^APP_VERSION\s*=\s*"[^"]*"\s*$'
if ([regex]::Matches($script:OriginalText, $VersionPattern).Count -ne 1) {
    Fail '[2] version.py 中未找到唯一的 APP_VERSION = "..." 定义（文件格式已变更）'
}
$evaluator = [System.Text.RegularExpressions.MatchEvaluator] { param($match) "APP_VERSION = `"$AppVersion`"" }
$updatedText = [regex]::Replace($script:OriginalText, $VersionPattern, $evaluator)
$versionChanged = ($updatedText -ne $script:OriginalText)

if ($versionChanged) {
    [IO.File]::WriteAllText($VersionFile, $updatedText, (New-Object System.Text.UTF8Encoding($script:HasBom)))
    $script:VersionWritten = $true
    Write-Step "[2] APP_VERSION → $AppVersion（待提交）"
} else {
    Write-Step "[2] APP_VERSION 已为 $AppVersion（无需提交）"
}

# ----------------------------------------------------------------------------
# [3] 同步安装包
# ----------------------------------------------------------------------------
Write-Step '[3/9] 同步 tGo-Setup …'
Invoke-Native 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MakeSetupScript, '-NoPause')
Assert-ExitCode $LASTEXITCODE '[3] tools\make-setup.ps1 执行失败'

$SetupVersionFile = Join-Path $SetupDir ($VersionRelative -replace '/', '\')
if (-not (Test-Path $SetupVersionFile -PathType Leaf)) { Fail "[3] 安装包缺少 $VersionRelative" }
if (-not (Test-Path (Join-Path $SetupDir 'required-files.txt') -PathType Leaf)) {
    Fail '[3] 安装包缺少 required-files.txt（make-setup 未完成同步）'
}
$setupVersionText = [IO.File]::ReadAllText($SetupVersionFile, [System.Text.Encoding]::UTF8)
if ($setupVersionText -notmatch ('APP_VERSION\s*=\s*"' + [regex]::Escape($AppVersion) + '"')) {
    Fail "[3] 安装包内 APP_VERSION 与 $AppVersion 不一致"
}
Write-Step "[3] 通过：$SetupDir"

# ----------------------------------------------------------------------------
# [4] （可选）构建并导出 Docker 镜像
# ----------------------------------------------------------------------------
Write-Step '[4/9] 构建 Docker 镜像 …'
$DockerImage = 'tgo'
# 镜像 tag 固定 latest：docker-compose.yml 默认引用 ${TGO_IMAGE:-tgo}:${TGO_IMAGE_TAG:-latest}，
# 容器部署方无需同步版本号；发布资产的版本信息由 Release/tag 本身承载。
$DockerImageTag = 'latest'
$DockerTarPath = Join-Path $DistDir "$DockerImage-$DockerImageTag.tar.gz"
$dockerTarSizeMb = 0
if ($Docker) {
    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    if (Test-Path $DockerTarPath) { Remove-Item -LiteralPath $DockerTarPath -Force }
    # docker-build.ps1 在存在 tGo-Setup 时自动以其为构建上下文
    $dockerBuildArgs = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $PSScriptRoot 'docker-build.ps1'),
        '-Image', $DockerImage, '-Tag', $DockerImageTag,
        '-OutputPath', $DockerTarPath, '-NoPause'
    )
    Invoke-Native 'powershell.exe' $dockerBuildArgs
    Assert-ExitCode $LASTEXITCODE '[4] Docker 镜像构建/导出失败（尚未提交或推送，发布已中止）'
    if (-not (Test-Path $DockerTarPath -PathType Leaf)) {
        Fail "[4] 未生成镜像导出文件：$DockerTarPath"
    }
    $dockerTarSizeMb = [math]::Round((Get-Item -LiteralPath $DockerTarPath).Length / 1MB, 1)
    Write-Step "[4] 通过：${DockerImage}:$DockerImageTag → $DockerTarPath（$dockerTarSizeMb MB）"
} else {
    Write-Step '[4] 未指定 -Docker，跳过镜像构建'
}

# ----------------------------------------------------------------------------
# [5] 打包 Release 资产
# ----------------------------------------------------------------------------
Write-Step '[5/9] 打包 Release 资产 …'
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$ZipPath = Join-Path $DistDir "tGo-Setup-$Tag.zip"
if (Test-Path $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }

$SetupRootFull = (Resolve-Path -LiteralPath $SetupDir).Path.TrimEnd('\')
$setupFiles = @(
    Get-ChildItem -LiteralPath $SetupDir -Recurse -File -Force |
        Where-Object {
            $relative = $_.FullName.Substring($SetupRootFull.Length + 1) -replace '\\', '/'
            -not (Test-ExcludedSetupPath $relative)
        }
)
if ($setupFiles.Count -eq 0) { Fail '[5] tGo-Setup 中没有可打包的文件' }

$archive = [System.IO.Compression.ZipFile]::Open(
    $ZipPath,
    [System.IO.Compression.ZipArchiveMode]::Create
)
try {
    foreach ($file in $setupFiles) {
        $relative = $file.FullName.Substring($SetupRootFull.Length + 1) -replace '\\', '/'
        $entryName = "tGo-Setup/$relative"
        $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $file.FullName,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        )
    }
    # 保留引擎/模型空目录占位（用户解压后按文档放入二进制即可）
    $null = $archive.CreateEntry('tGo-Setup/engine/katago/')
    $null = $archive.CreateEntry('tGo-Setup/engine/models/')
} finally {
    $archive.Dispose()
}

$zipItem = Get-Item -LiteralPath $ZipPath
if ($zipItem.Length -le 0) { Fail '[5] 生成的 zip 为空' }
$zipSizeMb = [math]::Round($zipItem.Length / 1MB, 2)
Write-Step "[5] 通过：$ZipPath（$($setupFiles.Count) 个文件，$zipSizeMb MB）"

# ----------------------------------------------------------------------------
# [6] 提交版本变更
# ----------------------------------------------------------------------------
Write-Step '[6/9] 提交版本变更 …'
if ($versionChanged) {
    Invoke-Native 'git' @('add', '--', $VersionRelative)
    Assert-ExitCode $LASTEXITCODE '[6] git add 失败'
    Invoke-Native 'git' @('commit', '-m', "chore(release): $Tag")
    Assert-ExitCode $LASTEXITCODE '[6] git commit 失败'
    $script:VersionWritten = $false
    Write-Step '[6] 已提交 version.py'
} else {
    $script:VersionWritten = $false
    Write-Step '[6] 版本未变化，跳过提交'
}

# ----------------------------------------------------------------------------
# [7] 创建并推送 tag
# ----------------------------------------------------------------------------
Write-Step '[7/9] 创建并推送 tag …'
Invoke-Native 'git' @('tag', '-a', $Tag, '-m', "tGo $Tag")
Assert-ExitCode $LASTEXITCODE "[7] 创建 tag 失败：$Tag"
Invoke-Native 'git' @('push', 'origin', $Branch)
Assert-ExitCode $LASTEXITCODE "[7] 推送分支失败：$Branch（本地 tag $Tag 已创建，修复后执行 git push origin $Branch $Tag）"
Invoke-Native 'git' @('push', 'origin', $Tag)
Assert-ExitCode $LASTEXITCODE "[7] 推送 tag 失败：$Tag（修复后执行 git push origin $Tag）"
Write-Step "[7] 已推送：$Branch、$Tag"

# ----------------------------------------------------------------------------
# [8] 生成 Release 说明
# ----------------------------------------------------------------------------
Write-Step '[8/9] 生成 Release 说明 …'
$notesPath = Join-Path $DistDir "release-notes-$Tag.md"
$hasNotes = $false
if (Test-Path $ChangelogFile -PathType Leaf) {
    $changelog = [IO.File]::ReadAllText($ChangelogFile, [System.Text.Encoding]::UTF8)
    $escapedVersion = [regex]::Escape($AppVersion)
    # 兼容 CRLF：多行模式的 $ 不匹配 \r，故用 [\r\n] 作为行尾边界
    $headingPattern = "(?m)^##\s*\[?[vV]?$escapedVersion\]?(?=[\s(]|[\r\n]|$)[^\r\n]*"
    $heading = [regex]::Match($changelog, $headingPattern)
    if ($heading.Success) {
        $tail = $changelog.Substring($heading.Index + $heading.Length)
        $nextHeading = [regex]::Match($tail, '(?m)^##\s')
        $body = if ($nextHeading.Success) { $tail.Substring(0, $nextHeading.Index) } else { $tail }
        $body = $body.Trim()
        if ($body.Length -gt 0) {
            [IO.File]::WriteAllText($notesPath, $body, (New-Object System.Text.UTF8Encoding($false)))
            $hasNotes = $true
        }
    }
}
if ($hasNotes) {
    Write-Step "[8] 已从 CHANGELOG.md 提取 $AppVersion 段落"
} else {
    Write-Step '[8] CHANGELOG.md 未找到该版本段落，将使用 GitHub 自动生成说明'
}

# ----------------------------------------------------------------------------
# [9] 创建 Release 并上传资产
# ----------------------------------------------------------------------------
Write-Step '[9/9] 创建 GitHub Release …'
$releaseArgs = @(
    'release', 'create', $Tag, $ZipPath,
    '--title', "tGo $Tag",
    '--verify-tag'
)
if ($hasNotes) {
    $releaseArgs += @('--notes-file', $notesPath)
} else {
    $releaseArgs += '--generate-notes'
}
if ($Draft) { $releaseArgs += '--draft' }
if ($Prerelease) { $releaseArgs += '--prerelease' }

Invoke-Native $GhExe $releaseArgs
Assert-ExitCode $LASTEXITCODE '[9] gh release create 失败（tag 已推送；修复后可在 GitHub 手动补建 Release）'

$releaseUrl = ''
try {
    $releaseUrl = (Invoke-Native $GhExe @('release', 'view', $Tag, '--json', 'url', '--jq', '.url') 2>$null | Out-String).Trim()
} catch {
    # 地址仅用于汇总展示；查询失败不影响发布结果
}

Write-Step $BannerLine
Write-Step '  tGo 发布完成'
Write-Step $BannerLine
Write-Step "  - 版本 : $Tag"
Write-Step "  - 提交 : $((Invoke-Native 'git' @('rev-parse', '--short', 'HEAD') | Out-String).Trim())"
Write-Step "  - 资产 : $ZipPath（$zipSizeMb MB）"
if ($Docker) {
    Write-Step "  - 镜像 : ${DockerImage}:$DockerImageTag → $DockerTarPath（$dockerTarSizeMb MB）"
}
if ($releaseUrl) { Write-Step "  - 地址 : $releaseUrl" }
Write-Step $BannerLine
Wait-KeepOpen
