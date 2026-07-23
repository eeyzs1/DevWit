# install.ps1 — Windows PowerShell 安装 meta-harness
# 用法：powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/install.ps1 | iex"
#      或：在已有 submodule 的项目中：powershell meta-harness/scripts/install.ps1 [repo-url]
# 可选参数：$args[0] 显式指定要 add 的仓库 URL（覆盖自动探测）

param()
$ErrorActionPreference = "Stop"

Write-Host "=== Meta-Harness Install ===" -ForegroundColor Cyan
Write-Host ""

# === 检测 ===

# 是否已经在 submodule 中？（用 scripts/check-version.py 存在性作为 harness 项目标志）
if ((Test-Path "meta-harness/scripts/check-version.py") -and (Test-Path ".gitmodules")) {
    Write-Host "Detected: submodule already present" -ForegroundColor Green
    Write-Host "Running init..."
    & "meta-harness/scripts/init-harness-submodule.ps1"
    exit 0
}

# 是否在 meta-harness 仓库自身中？
if (Test-Path "AGENTS.md") {
    $Content = Get-Content "AGENTS.md" -Raw
    if ($Content -match "META-HARNESS: you GENERATE") {
        Write-Host "This is the meta-harness repository itself." -ForegroundColor Yellow
        Write-Host "install.ps1 is for APPLICATION projects that want to USE meta-harness."
        Write-Host "To install in another project, use the iwr command:"
        Write-Host ""
        Write-Host "  powershell -ExecutionPolicy Bypass -Command `"iwr <url>/install.ps1 | iex`""
        exit 1
    }
}

# 检查 git
try {
    git rev-parse --git-dir 2>$null | Out-Null
} catch {
    Write-Host "ERROR: Not in a git repository." -ForegroundColor Red
    Write-Host "Initialize git first:"
    Write-Host "  git init"
    Write-Host "  git remote add origin <your-repo-url>"
    exit 1
}

# 检查是否已有 meta-harness 目录
if (Test-Path "meta-harness") {
    Write-Host "meta-harness/ directory already exists." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "If this is an old copy-paste install, use migrate instead:"
    Write-Host "  powershell -ExecutionPolicy Bypass -Command `"iwr <url>/bootstrap-update.ps1 | iex`""
    Write-Host ""
    $Confirm = Read-Host "Overwrite with submodule? [y/N]"
    if ($Confirm -ne "y" -and $Confirm -ne "Y") { Write-Host "Aborted."; exit 0 }
    Remove-Item -Recurse -Force meta-harness
}

# === 探测可用的 git 协议 ===
# 默认优先 SSH（推送/认证更顺），允许通过 $env:MH_REPO_URL 或第一个参数覆盖。
# 探测策略：在 Job 里跑带超时的 git ls-remote，避免 SSH 弹密码卡住终端。
$MH_REPO_SSH = "git@github.com:eeyzs1/meta_harness.git"
$MH_REPO_HTTPS = "https://github.com/eeyzs1/meta_harness.git"
$MH_REPO_URL = $env:MH_REPO_URL
if (-not $MH_REPO_URL -and $args.Count -gt 0) { $MH_REPO_URL = $args[0] }

if (-not $MH_REPO_URL) {
    Write-Host "Detecting git protocol..." -ForegroundColor Cyan

    function Test-GitRemote {
        param([string]$Url)
        $job = Start-Job -ScriptBlock {
            param($u)
            $output = git ls-remote --heads $u 2>&1
            return $LASTEXITCODE
        } -ArgumentList $Url

        $completed = Wait-Job $job -Timeout 5
        if ($completed) {
            $code = Receive-Job $job
            Remove-Job $job -Force
            return ($code -eq 0)
        } else {
            Stop-Job $job
            Remove-Job $job -Force
            return $false
        }
    }

    if (Test-GitRemote -Url $MH_REPO_SSH) {
        $MH_REPO_URL = $MH_REPO_SSH
        Write-Host "  ✓ SSH reachable — using $MH_REPO_URL" -ForegroundColor Green
    } elseif (Test-GitRemote -Url $MH_REPO_HTTPS) {
        $MH_REPO_URL = $MH_REPO_HTTPS
        Write-Host "  ⚠ SSH unreachable — falling back to $MH_REPO_URL" -ForegroundColor Yellow
    } else {
        Write-Host "  ERROR: Cannot reach GitHub via SSH or HTTPS." -ForegroundColor Red
        Write-Host "  Check your network and SSH key configuration, then retry."
        Write-Host "  You can also pass a URL explicitly: install.ps1 <git-url>"
        exit 1
    }
    Write-Host ""
}

# === 安装 ===

Write-Host "Adding meta-harness as submodule..." -ForegroundColor Green
git submodule add $MH_REPO_URL meta-harness
Write-Host ""

Write-Host "Initializing project structure..." -ForegroundColor Green
& "meta-harness/scripts/init-harness-submodule.ps1"
Write-Host ""

Write-Host "=== Install Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit .meta-harness/project.yaml — set your project name and settings"
Write-Host "  2. Commit: git add meta-harness .meta-harness AGENTS.md .gitmodules"
Write-Host '     git commit -m "Add meta-harness framework"'
Write-Host ""
Write-Host "Framework update:"
Write-Host "  powershell meta-harness/scripts/update-harness.ps1"