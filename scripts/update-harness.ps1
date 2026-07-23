# update-harness.ps1 — Windows PowerShell 一键更新脚本
# 用法：powershell meta-harness/scripts/update-harness.ps1
# 做三件事：git pull → migrate project.yaml → git commit

param()

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MHRoot = Split-Path -Parent $ScriptDir
$ProjectRoot = Split-Path -Parent $MHRoot

# === 协议回退：当前 remote pull 失败时，自动切到另一种协议重试 ===
$MH_REPO_SSH = "git@github.com:eeyzs1/meta_harness.git"
$MH_REPO_HTTPS = "https://github.com/eeyzs1/meta_harness.git"

function Invoke-PullWithFallback {
    param([string]$RepoDir)

    Push-Location $RepoDir
    try {
        $current = git config --get remote.origin.url 2>$null
    } finally {
        Pop-Location
    }

    if (-not $current) {
        $alternate = $MH_REPO_SSH
    } elseif ($current -match "^git@github.com:") {
        $alternate = $MH_REPO_HTTPS
    } else {
        $alternate = $MH_REPO_SSH
    }

    # 第一次尝试：沿用已配置的 remote
    Push-Location $RepoDir
    try {
        $output = git pull origin main 2>&1
        if ($LASTEXITCODE -eq 0) { return }
    } finally {
        Pop-Location
    }

    Write-Host ""
    Write-Host "  Pull from current remote ($current) failed."
    Write-Host "  Retrying with alternate protocol: $alternate"

    Push-Location $RepoDir
    try {
        if ($current) {
            git remote set-url origin $alternate | Out-Null
        } else {
            git remote add origin $alternate | Out-Null
        }
        $output = git pull origin main 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ERROR: Both SSH and HTTPS failed for meta-harness repo." -ForegroundColor Red
            Write-Host "  Check network/credentials, then restore the original remote if needed:" -ForegroundColor Red
            if ($current) {
                Write-Host "    git -C `"$RepoDir`" remote set-url origin $current" -ForegroundColor Red
            }
            throw "Pull failed for both protocols"
        }
    } finally {
        # 拉成功：把 remote 改回原值（保留用户原来的协议偏好）
        if ($current) {
            git remote set-url origin $current | Out-Null
        }
        Pop-Location
    }
}

Write-Host "=== Meta-Harness Update ==="
Write-Host ""

# Step 1: 检查是否 submodule
$Gitmodules = Join-Path $ProjectRoot ".gitmodules"
if (-not (Test-Path $Gitmodules)) {
    Write-Error "No .gitmodules found. Is meta-harness installed as a submodule?"
    Write-Host "Run: git submodule add <url> meta-harness"
    exit 1
}

$Content = Get-Content $Gitmodules -Raw
if ($Content -notmatch "meta-harness") {
    Write-Error "meta-harness not found in .gitmodules."
    exit 1
}

# Step 2: 记录当前版本（基于 git tag，不依赖 VERSION 文件）
$describeOut = git -C $MHRoot describe --tags --abbrev=0 2>&1
if ($LASTEXITCODE -eq 0 -and $describeOut) {
    $CurrentVersion = "$describeOut".Trim()
} else {
    $CurrentVersion = "unknown"
}
Write-Host "Current version: $CurrentVersion"

# Step 3: Git pull
Write-Host ""
Write-Host "--- Pulling latest framework ---"
Invoke-PullWithFallback -RepoDir $MHRoot

# 拉取后获取最新 tag（需要 fetch tags 才能 describe 到刚 pull 下来的新 tag）
git -C $MHRoot fetch --tags --quiet 2>&1 | Out-Null
$describeOut = git -C $MHRoot describe --tags --abbrev=0 2>&1
if ($LASTEXITCODE -eq 0 -and $describeOut) {
    $NewVersion = "$describeOut".Trim()
} else {
    $NewVersion = "unknown"
}
Write-Host "Updated to: $NewVersion"

# Step 4: 迁移 project.yaml
$MigrateScript = Join-Path $MHRoot "scripts/migrate.ps1"
if (Test-Path $MigrateScript) {
    Write-Host ""
    Write-Host "--- Migrating project configuration ---"
    $ProjectYaml = Join-Path $ProjectRoot ".meta-harness/project.yaml"
    if (Test-Path $ProjectYaml) {
        & $MigrateScript -ProjectYamlPath $ProjectYaml
    } else {
        Write-Host "  (no project.yaml found, skipping)"
    }
}

# Step 5: 提交更新
Write-Host ""
Write-Host "--- Committing update ---"
Push-Location $ProjectRoot
try {
    git add meta-harness
    $ProjectYaml = Join-Path $ProjectRoot ".meta-harness/project.yaml"
    if (Test-Path $ProjectYaml) {
        git add $ProjectYaml
    }

    $Diff = git diff --cached --quiet 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "No changes to commit (already up to date)."
    } else {
        git commit -m "chore: update meta-harness $CurrentVersion -> $NewVersion"
        Write-Host ""
        Write-Host "=== Committed: meta-harness $CurrentVersion -> $NewVersion ==="
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Done. Framework is now at $NewVersion."