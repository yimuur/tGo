# ============================================================================
# tGo Windows 一键启动（T7.2）
#
#   - 幂等：重复运行不重复创建 venv / 不重复安装依赖（requirements.txt 哈希记账）；
#   - 中文编码：本文件保存为 UTF-8 with BOM（Windows PowerShell 5.1 依赖 BOM 正确
#     读取中文），并设置控制台 UTF-8 + PYTHONUTF8，避免中文乱码；
#   - 首次运行：创建 backend/.venv → 安装依赖 → 启动服务并打开浏览器；
#   - 端口：默认 8090（config.yaml 的 server.port 可覆盖）；被其它程序占用时由
#     launcher 自动 +1（最多 +10）；若端口上已是运行中的 tGo 则幂等复用；
#   - 用户数据保护：不修改 /不覆盖 config.yaml、data/、logs/、engine/（升级重跑本脚本即可）。
#   - 引擎路径：优先取用户 config.yaml 的 engine.executable_dir / engine.model_dir（配置文件位置
#     可用环境变量 TGO_CONFIG 覆盖），未声明才用默认路径（engine/katago、engine/models）兜底。
#
# 用法：start.bat（或本脚本）｜start.bat -New（忽略“运行中的 tGo 复用”，强制在 +1 端口新起实例，调试用）
# ============================================================================

param([switch]$New)

$ErrorActionPreference = 'Stop'

# ---- 控制台中文编码（UTF-8；PS 5.1 下 [Console]::OutputEncoding 解码子进程输出）----
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { & chcp.com 65001 | Out-Null } catch { }
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$Root = $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Venv = Join-Path $Backend '.venv'
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
$Requirements = Join-Path $Backend 'requirements.txt'
$Stamp = Join-Path $Venv '.tgo-deps-stamp.json'

function Write-Step([string]$Message) { Write-Host "[tGo] $Message" }
function Write-Err([string]$Message) {
    # 错误行红色高亮；NO_COLOR 置位时无色（与 Linux 版 err 同语义）
    if ($env:NO_COLOR) { Write-Host "[tGo] $Message" } else { Write-Host "[tGo] $Message" -ForegroundColor Red }
}
function Fail([string]$Message) {
    Write-Err $Message
    exit 1
}

# 探测 Python 命令（@('py','-3') / @('python')）：可用 = 能启动且版本 >= 3.10
function Test-PythonUsable([string[]]$Command) {
    try {
        $Extra = @()
        if ($Command.Count -gt 1) { $Extra = $Command[1..($Command.Count - 1)] }
        $null = & $Command[0] @Extra -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# ---- [1] 文件与环境预检（按 required-files.txt 全量检查：存在性 + 非零字节）----
$BannerLine = '=' * 60
Write-Step $BannerLine
Write-Step "  tGo 一键启动（Windows · start.ps1）"
Write-Step $BannerLine
Write-Step "[1] 文件与环境预检（required-files.txt 全量清单）…"
$Manifest = Join-Path $Root 'required-files.txt'
if (-not (Test-Path $Manifest -PathType Leaf)) {
    Fail "文件缺失：required-files.txt（部署包不完整，请重新获取完整项目文件）"
}
$ManifestEntries = @(Get-Content $Manifest -Encoding UTF8 | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') })
$MissingFiles = [System.Collections.Generic.List[string]]::new()
$DamagedFiles = [System.Collections.Generic.List[string]]::new()
foreach ($Entry in $ManifestEntries) {
    $Relative = $Entry.Trim()
    $Candidate = Join-Path $Root ($Relative -replace '/', '\')
    if (-not (Test-Path $Candidate -PathType Leaf)) {
        $MissingFiles.Add($Relative)
    }
    elseif ((Get-Item $Candidate).Length -eq 0) {
        $DamagedFiles.Add($Relative)
    }
}
if ($MissingFiles.Count -gt 0 -or $DamagedFiles.Count -gt 0) {
    if ($MissingFiles.Count -gt 0) {
        Write-Err "[1] 文件缺失（$($MissingFiles.Count) 项）："
        foreach ($Item in $MissingFiles) { Write-Host "  - $Item" }
    }
    if ($DamagedFiles.Count -gt 0) {
        Write-Err "[1] 文件损坏（0 字节，$($DamagedFiles.Count) 项）："
        foreach ($Item in $DamagedFiles) { Write-Host "  - $Item" }
    }
    Fail "[1] 部署包不完整（共校验 $($ManifestEntries.Count) 项运行文件），请重新获取完整项目文件"
}
Write-Step "[1] 通过：共校验 $($ManifestEntries.Count) 项运行文件"

# ---- ② 引擎/模型预检（仅提示，不阻断：人人对弈与复盘不受引擎影响）----
# 路径/模型口径与应用侧一致（backend/app/config.py::resolve_config_path + engine_path、
# backend/app/engine/models.py::resolve_models）：
#   配置文件 = 环境变量 TGO_CONFIG > 项目根 config.yaml；engine.executable_dir /
#   engine.model_dir 相对路径锚定项目根，未声明 → 默认路径兜底（绝不硬编码为唯一来源）；
#   可执行文件名按平台识别（Windows 优先 katago.exe，Linux 见 deploy.sh）；
#   engine.standard_model / engine.human_model 声明时按**文件名精确校验**（不回落自动
#   扫描，与后端一致）；未声明 → 标准模型扫 *.bin.gz（排除人类模型）、人类模型扫 *human*。
# 配置只做声明式标量的最小子集解析（与产品自写的 yaml.safe_dump 输出一致）；解析不到即回退
# 默认，提示信息回显「来源 + 最终路径」——解析差异一眼可见，不因格式差异误报「文件缺失」。

# 解析 YAML 标量：去引号 / 去行内注释（YAML 要求 '#' 前有空白，路径中的 '#' 原样保留）
function Get-TgoConfigScalar([string]$Raw) {
    $Value = $Raw.Trim()
    if ($Value -match '^"(?<Quoted>[^"]*)"') { return $matches['Quoted'] }
    if ($Value -match "^'(?<Quoted>[^']*)'") { return $matches['Quoted'] }
    return ($Value -replace '\s+#.*$', '').Trim()
}

# 解析引擎/模型路径：用户 config.yaml 优先，默认兜底（返回目录/可执行文件/来源）
function Get-TgoEnginePaths([string]$Root) {
    $ExeDir = 'engine/katago'
    $ModelDir = 'engine/models'
    $StandardModel = ''
    $HumanModel = ''
    $ExeFromConfig = $false
    $ModelFromConfig = $false
    $ConfigPath = if ($env:TGO_CONFIG) { $env:TGO_CONFIG } else { Join-Path $Root 'config.yaml' }
    if (Test-Path $ConfigPath -PathType Leaf) {
        $InEngineSection = $false
        foreach ($Line in @(Get-Content $ConfigPath -Encoding UTF8)) {
            if ($Line -match '^\s*$' -or $Line -match '^\s*#') { continue }    # 空行/注释：不分段
            if ($Line -match '^engine\s*:') { $InEngineSection = $true; continue }
            if ($Line -match '^\S') { $InEngineSection = $false; continue }   # 顶层下一个键 → engine 段结束
            if (-not $InEngineSection) { continue }
            if ($Line -match '^\s+executable_dir\s*:\s*(?<Raw>.*)$') {
                $Value = Get-TgoConfigScalar $matches['Raw']
                if ($Value) { $ExeDir = $Value; $ExeFromConfig = $true }
            }
            elseif ($Line -match '^\s+model_dir\s*:\s*(?<Raw>.*)$') {
                $Value = Get-TgoConfigScalar $matches['Raw']
                if ($Value) { $ModelDir = $Value; $ModelFromConfig = $true }
            }
            elseif ($Line -match '^\s+standard_model\s*:\s*(?<Raw>.*)$') {
                $StandardModel = Get-TgoConfigScalar $matches['Raw']
            }
            elseif ($Line -match '^\s+human_model\s*:\s*(?<Raw>.*)$') {
                $HumanModel = Get-TgoConfigScalar $matches['Raw']
            }
        }
    }
    # 相对路径锚定项目根（绝对路径原样使用）
    if (-not [System.IO.Path]::IsPathRooted($ExeDir)) { $ExeDir = Join-Path $Root ($ExeDir -replace '/', '\') }
    if (-not [System.IO.Path]::IsPathRooted($ModelDir)) { $ModelDir = Join-Path $Root ($ModelDir -replace '/', '\') }
    $Executable = $null
    foreach ($Name in @('katago.exe', 'katago')) {
        $Candidate = Join-Path $ExeDir $Name
        if (Test-Path $Candidate -PathType Leaf) { $Executable = $Candidate; break }
    }
    return [pscustomobject]@{
        ExecutableDir = $ExeDir
        Executable    = $Executable
        ModelDir      = $ModelDir
        StandardModel = $StandardModel
        HumanModel    = $HumanModel
        ExeSource     = if ($ExeFromConfig) { 'config.yaml' } else { '默认兜底' }
        ModelSource   = if ($ModelFromConfig) { 'config.yaml' } else { '默认兜底' }
    }
}

# 模型可用性判定（口径同后端 resolve_models）：声明 → 文件名精确校验（不回落扫描）；
# 未声明 → 标准模型扫 *.bin.gz（排除人类模型）、人类模型扫 *human*（忽略大小写）
function Get-TgoModelStatus([pscustomobject]$Paths) {
    $ModelFiles = @(Get-ChildItem $Paths.ModelDir -Filter '*.bin.gz' -File -ErrorAction SilentlyContinue |
        Sort-Object Name)
    if ($Paths.StandardModel) {
        $StandardStatus = if (Test-Path (Join-Path $Paths.ModelDir $Paths.StandardModel) -PathType Leaf) { 'ok' } else { 'missing_declared' }
    }
    else {
        $StandardStatus = if (@($ModelFiles | Where-Object { $_.Name -notmatch 'human' }).Count -gt 0) { 'ok' } else { 'missing_auto' }
    }
    if ($Paths.HumanModel) {
        $HumanStatus = if (Test-Path (Join-Path $Paths.ModelDir $Paths.HumanModel) -PathType Leaf) { 'ok' } else { 'missing_declared' }
    }
    else {
        $HumanStatus = if (@($ModelFiles | Where-Object { $_.Name -match 'human' }).Count -gt 0) { 'ok' } else { 'missing_auto' }
    }
    return [pscustomobject]@{ Standard = $StandardStatus; Human = $HumanStatus }
}

$EnginePaths = Get-TgoEnginePaths -Root $Root
$ModelStatus = Get-TgoModelStatus -Paths $EnginePaths
$Declared = @()
if ($EnginePaths.ExeSource -eq 'config.yaml') { $Declared += "executable_dir=$($EnginePaths.ExecutableDir)" }
if ($EnginePaths.ModelSource -eq 'config.yaml') { $Declared += "model_dir=$($EnginePaths.ModelDir)" }
if ($EnginePaths.StandardModel) { $Declared += "standard_model=$($EnginePaths.StandardModel)" }
if ($EnginePaths.HumanModel) { $Declared += "human_model=$($EnginePaths.HumanModel)" }
if ($Declared.Count -gt 0) {
    # 逐项换行显示：路径较长，挤在一行不便阅读（列表样式同文件缺失清单）
    Write-Step "[1] 引擎配置取自用户 config.yaml："
    foreach ($Item in $Declared) { Write-Host "  - $Item" }
}
# 提示口径同 BUG-090：缺失项＝**引擎**不可用降级，不阻碍进入（人人对弈与复盘照常可用）
if (-not $EnginePaths.Executable) {
    Write-Step "[1] 提示：未找到引擎可执行文件（executable_dir=$($EnginePaths.ExecutableDir)，来源：$($EnginePaths.ExeSource)）—— 引擎不可用（引擎可执行文件缺失）；人人对弈与复盘不受影响"
}
switch ($ModelStatus.Standard) {
    'missing_declared' {
        Write-Step "[1] 提示：未找到标准模型 $($EnginePaths.StandardModel)（model_dir=$($EnginePaths.ModelDir)）—— 引擎不可用（标准模型缺失）；人人对弈与复盘不受影响"
    }
    'missing_auto' {
        Write-Step "[1] 提示：未找到模型文件（model_dir=$($EnginePaths.ModelDir)，来源：$($EnginePaths.ModelSource)）—— 引擎不可用（标准模型缺失）；人人对弈与复盘不受影响"
    }
}
switch ($ModelStatus.Human) {
    'missing_declared' {
        Write-Step "[1] 提示：未找到人类模型 $($EnginePaths.HumanModel)（model_dir=$($EnginePaths.ModelDir)）—— 仅标准风格可用（人类模型缺失降级）"
    }
    'missing_auto' {
        Write-Step "[1] 提示：未找到人类模型（*human*.bin.gz）—— 仅标准风格可用（人类模型缺失降级）"
    }
}

# ---- [2] 运行环境（venv 幂等；缺失/损坏时用基 Python 创建）----
if (-not (Test-PythonUsable @($VenvPython))) {
    $BaseCmd = $null
    $Candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) { $Candidates += , @('py', '-3') }
    if (Get-Command python -ErrorAction SilentlyContinue) { $Candidates += , @('python') }
    foreach ($Candidate in $Candidates) {
        if (Test-PythonUsable $Candidate) { $BaseCmd = $Candidate; break }
    }
    if (-not $BaseCmd) {
        Fail "未找到 Python 3.10+（请安装 Python 并勾选加入 PATH：https://www.python.org/downloads/）"
    }
    Write-Step "[2] 首次启动：创建虚拟环境 backend/.venv …"
    $BaseExtra = @()
    if ($BaseCmd.Count -gt 1) { $BaseExtra = $BaseCmd[1..($BaseCmd.Count - 1)] }
    & $BaseCmd[0] @BaseExtra -m venv $Venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPython)) { Fail "虚拟环境创建失败（backend/.venv）" }
}

# ---- [2] 依赖安装幂等（requirements.txt 哈希记账：未变跳过 pip，变更自动重装）----
$ReqHash = (Get-FileHash $Requirements -Algorithm SHA256).Hash
$PythonVersion = (& $VenvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
$SkipInstall = $false
if (Test-Path $Stamp) {
    try {
        $StampData = Get-Content $Stamp -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($StampData.requirements_sha256 -eq $ReqHash -and $StampData.python -eq $PythonVersion) { $SkipInstall = $true }
    } catch { $SkipInstall = $false }
}
if ($SkipInstall) {
    Write-Step "[2] 依赖已是最新（跳过安装）：Python $PythonVersion @ backend/.venv"
} else {
    Write-Step "[2] 安装/校验 Python 依赖（首次安装或 requirements.txt 已变更）…"
    & $VenvPython -m pip install --disable-pip-version-check -r $Requirements
    if ($LASTEXITCODE -ne 0) { Fail "依赖安装失败（pip install -r requirements.txt），请检查网络后重试" }
    Write-Step "[2] 依赖与应用模块导入冒烟校验…"
    Push-Location $Backend
    try {
        & $VenvPython -c "import fastapi, uvicorn, pydantic, aiosqlite, psutil, yaml, multipart; import app.main"
    } finally {
        Pop-Location
    }
    if ($LASTEXITCODE -ne 0) { Fail "依赖/应用模块导入校验失败（安装不完整或后端文件缺失），请删除 backend/.venv 后重试" }
    @{
        requirements_sha256 = $ReqHash
        python              = $PythonVersion
        installed_at        = (Get-Date -Format o)
    } | ConvertTo-Json | Set-Content -Path $Stamp -Encoding UTF8
}

# ---- [3] 启动服务（端口探测/复用/+1 与浏览器打开由 launcher 统一实现）----
Write-Step "[3] 启动服务（Ctrl+C 停止）…"
$LauncherArgs = @('--open')
if ($New) { $LauncherArgs += '--new' }
$ExitCode = 0
Push-Location $Backend
try {
    & $VenvPython -m app.launcher @LauncherArgs
    if ($null -ne $LASTEXITCODE) { $ExitCode = $LASTEXITCODE }
} catch [System.Management.Automation.PipelineStoppedException] {
    # Ctrl+C 中断前台服务：视为正常停止
    $ExitCode = 0
} finally {
    Pop-Location
}
if ($ExitCode -ne 0) { Fail "服务异常退出（退出码 $ExitCode）" }
