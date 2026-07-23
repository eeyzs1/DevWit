# migrate-legacy.ps1 — Windows PowerShell 老项目迁移脚本
# 用法：cd ~/my-old-project && powershell migrate-legacy.ps1
# 注：需要在包含旧 .meta-harness/ 目录的项目根目录下运行

param()

$ErrorActionPreference = "Stop"

Write-Host "=== Meta-Harness Legacy Migration ==="
Write-Host ""
Write-Host "This script migrates an old copy-paste installation to git submodule."
Write-Host ""

# === 检测 ===

# 检测 1: 是否有旧的 .meta-harness/ 目录
if (-not (Test-Path ".meta-harness")) {
    Write-Error ".meta-harness/ directory not found."
    Write-Host "This script is for migrating OLD copy-paste installations."
    Write-Host "For new projects, use: powershell meta-harness/scripts/init-harness-submodule.ps1"
    exit 1
}

# 检测 2: 是否已经使用 submodule
if ((Test-Path ".gitmodules") -and ((Get-Content ".gitmodules" -Raw) -match "meta-harness")) {
    Write-Host "✓ meta-harness is already a git submodule. No migration needed."
    Write-Host "  To update: powershell meta-harness/scripts/update-harness.ps1"
    exit 0
}

# 检测 3: 确认是旧版安装
$HasOldFiles = $false
if (Test-Path ".meta-harness/meta/interpreter.md") { $HasOldFiles = $true }
if (Test-Path ".meta-harness/meta/harness-generator.md") { $HasOldFiles = $true }
if (Test-Path ".meta-harness/seeds/guard.py") { $HasOldFiles = $true }

if (-not $HasOldFiles) {
    Write-Host "NOTE: .meta-harness/ exists but no old framework files detected."
    Write-Host "This might already be migrated or a different structure."
    Write-Host "Proceeding anyway..."
}

# === 确认 ===
Write-Host ""
Write-Host "This will:"
Write-Host "  1. Back up .meta-harness/project.yaml, runs/, memory/"
Write-Host "  2. Remove old framework files from .meta-harness/"
Write-Host "  3. Add meta-harness as a git submodule"
Write-Host "  4. Restore local files"
Write-Host "  5. Generate project-level AGENTS.md"
Write-Host ""

$Confirm = Read-Host "Continue? [y/N]"
if ($Confirm -ne "y" -and $Confirm -ne "Y") {
    Write-Host "Aborted."
    exit 0
}

Write-Host ""

# === 步骤 1: 备份 ===
Write-Host "--- Step 1: Backup ---"
$BackupDir = Join-Path $env:TEMP "mh-legacy-backup-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
Write-Host "Backup directory: $BackupDir"

if (Test-Path ".meta-harness/project.yaml") { Copy-Item ".meta-harness/project.yaml" "$BackupDir/" -Force; Write-Host "  ✓ project.yaml backed up" }
if (Test-Path ".meta-harness/runs") { Copy-Item ".meta-harness/runs" "$BackupDir/runs" -Recurse -Force; Write-Host "  ✓ runs/ backed up" }
if (Test-Path ".meta-harness/memory") { Copy-Item ".meta-harness/memory" "$BackupDir/memory" -Recurse -Force; Write-Host "  ✓ memory/ backed up" }
if (Test-Path "AGENTS.md") { Copy-Item "AGENTS.md" "$BackupDir/" -Force; Write-Host "  ✓ AGENTS.md backed up" }

Write-Host ""

# === 步骤 2: 清理旧框架文件 ===
Write-Host "--- Step 2: Clean old framework files ---"

$Dirs = @("meta", "seeds", "scripts", "evolution", "reference", "verification")
foreach ($Dir in $Dirs) {
    $Path = ".meta-harness/$Dir"
    if (Test-Path $Path) {
        Remove-Item -Recurse -Force $Path
        Write-Host "  ✓ removed .meta-harness/$Dir/"
    }
}

$Files = @("AGENTS.md", "README.md")
foreach ($File in $Files) {
    $Path = ".meta-harness/$File"
    if (Test-Path $Path) {
        Remove-Item -Force $Path
        Write-Host "  ✓ removed .meta-harness/$File"
    }
}

Write-Host ""

# === 步骤 3: 添加 submodule ===
Write-Host "--- Step 3: Add git submodule ---"

$HasRemote = $false
try {
    git remote get-url origin 2>$null | Out-Null
    $HasRemote = $true
} catch {
    $HasRemote = $false
}

if (-not $HasRemote) {
    Write-Host "WARNING: No git remote found. Initialize git repo first."
    Write-Host "  git init"
    Write-Host "  git remote add origin <your-repo-url>"
    Write-Host "Then run this script again."
    exit 1
}

# 检查 submodule 是否已存在
$SubmoduleExists = $false
if (Test-Path ".gitmodules") {
    try {
        git config -f .gitmodules --get submodule.meta-harness.url 2>$null | Out-Null
        $SubmoduleExists = $true
    } catch {}
}

if ($SubmoduleExists) {
    Write-Host "meta-harness submodule already exists in .gitmodules — skipping add"
} else {
    Write-Host ""
    Write-Host "=== MANUAL STEP REQUIRED ==="
    Write-Host "Please provide the meta-harness repository URL."
    Write-Host "Example: https://github.com/your-org/meta-harness.git"
    Write-Host ""
    $MHRemoteUrl = Read-Host "Meta-harness repo URL"
    
    if ($MHRemoteUrl) {
        git submodule add $MHRemoteUrl meta-harness
        Write-Host "  ✓ submodule added: $MHRemoteUrl"
    } else {
        Write-Error "No URL provided. Cannot add submodule."
        Write-Host ""
        Write-Host "You can add it manually later:"
        Write-Host "  git submodule add <url> meta-harness"
        Write-Host "Then run: powershell meta-harness/scripts/init-harness-submodule.ps1"
        exit 1
    }
}

Write-Host ""

# === 步骤 4: 恢复本地文件 ===
Write-Host "--- Step 4: Restore local files ---"

if (Test-Path "$BackupDir/project.yaml") {
    Copy-Item "$BackupDir/project.yaml" ".meta-harness/project.yaml" -Force
    Write-Host "  ✓ project.yaml restored"
}

if (Test-Path "$BackupDir/runs") {
    Copy-Item "$BackupDir/runs" ".meta-harness/runs" -Recurse -Force
    Write-Host "  ✓ runs/ restored"
}

if (Test-Path "$BackupDir/memory") {
    Copy-Item "$BackupDir/memory" ".meta-harness/memory" -Recurse -Force
    Write-Host "  ✓ memory/ restored"
}

Write-Host ""

# === 步骤 5: 生成项目级 AGENTS.md ===
Write-Host "--- Step 5: Generate project AGENTS.md ---"

if (Test-Path "AGENTS.md") {
    if (Test-Path "$BackupDir/AGENTS.md") {
        $Content = Get-Content "AGENTS.md" -Raw
        if ($Content -match "submodule|bootstrap|meta-harness/") {
            Write-Host "  ✓ AGENTS.md already references submodule — keeping it"
        } else {
            Rename-Item "AGENTS.md" "AGENTS.md.old"
            Write-Host "  ✓ old AGENTS.md renamed to AGENTS.md.old"
            & (Join-Path "meta-harness/scripts" "init-harness-submodule.ps1") 2>$null
        }
    }
} else {
    & (Join-Path "meta-harness/scripts" "init-harness-submodule.ps1") 2>$null
}

Write-Host ""

# === 清理 ===
Write-Host "--- Cleanup ---"
Remove-Item -Recurse -Force $BackupDir
Write-Host "  ✓ temporary backup removed"

Write-Host ""
Write-Host "=== Migration Complete ==="
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Review .meta-harness/project.yaml"
Write-Host "  2. Review AGENTS.md (check old version at AGENTS.md.old if renamed)"
Write-Host "  3. Commit: git add meta-harness .meta-harness AGENTS.md .gitmodules"
Write-Host '     git commit -m "Migrate meta-harness to git submodule"'
Write-Host ""
Write-Host "To update the framework in the future:"
Write-Host "  powershell meta-harness/scripts/update-harness.ps1"