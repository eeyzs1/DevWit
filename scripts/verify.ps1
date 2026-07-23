# verify.ps1 — Windows PowerShell meta-harness 安装健康检查
# 用法：powershell meta-harness/scripts/verify.ps1

param()
$ErrorActionPreference = "Continue"

Write-Host "=== Meta-Harness Health Check ===" -ForegroundColor Cyan
Write-Host ""

$Pass = 0; $Fail = 0; $Warn = 0

function Check {
    param($Desc, $Result)
    switch ($Result) {
        "pass" { Write-Host "  ✓ $Desc" -ForegroundColor Green; $script:Pass++ }
        "warn" { Write-Host "  ⚠ $Desc" -ForegroundColor Yellow; $script:Warn++ }
        "fail" { Write-Host "  ✗ $Desc" -ForegroundColor Red; $script:Fail++ }
    }
}

# 1. Submodule（用 scripts/check-version.py 存在性作为 harness 项目标志）
if ((Test-Path "meta-harness") -and (Test-Path "meta-harness/scripts/check-version.py")) {
    Check "Submodule meta-harness/ exists (with check-version.py)" "pass"
} else {
    Check "Submodule meta-harness/ exists (with check-version.py)" "fail"
}

# 2. .gitmodules
if ((Test-Path ".gitmodules") -and ((Get-Content ".gitmodules" -Raw) -match "meta-harness")) {
    Check ".gitmodules references meta-harness" "pass"
} else {
    Check ".gitmodules references meta-harness" "fail"
}

# 3. 框架版本（基于 git tag）
$verOut = git -C "meta-harness" describe --tags --abbrev=0 2>&1
if ($LASTEXITCODE -eq 0 -and $verOut) {
    $fwVer = "$verOut".Trim()
    Check "Framework version via git tag: $fwVer" "pass"
} else {
    Check "Framework version via git tag" "fail"
}

# 4. project.yaml
if (Test-Path ".meta-harness/project.yaml") {
    Check ".meta-harness/project.yaml exists" "pass"
} else {
    Check ".meta-harness/project.yaml exists" "fail"
}

# 5. project.yaml content
if (Test-Path ".meta-harness/project.yaml") {
    $content = Get-Content ".meta-harness/project.yaml" -Raw
    if ($content -match "project:") {
        Check "project.yaml has 'project:' key" "pass"
    } else {
        Check "project.yaml has 'project:' key" "fail"
    }
}

# 6. AGENTS.md
if (Test-Path "AGENTS.md") {
    $content = Get-Content "AGENTS.md" -Raw
    if ($content -match "meta-harness/") {
        Check "AGENTS.md references meta-harness/ submodule" "pass"
    } else {
        Check "AGENTS.md references meta-harness/ submodule" "warn"
    }
} else {
    Check "AGENTS.md exists" "fail"
}

# 7. Key scripts
$Scripts = @(
    "meta-harness/scripts/check-version.ps1",
    "meta-harness/scripts/update-harness.ps1",
    "meta-harness/scripts/migrate.ps1",
    "meta-harness/scripts/init-harness-submodule.ps1"
)
foreach ($s in $Scripts) {
    if (Test-Path $s) { Check "Script exists: $s" "pass" }
    else { Check "Script exists: $s" "fail" }
}

# 8. Key meta files
$MetaFiles = @(
    "meta-harness/meta/interpreter.md",
    "meta-harness/meta/harness-generator.md",
    "meta-harness/meta/phase-loader.md",
    "meta-harness/meta/agent-factory.md"
)
foreach ($f in $MetaFiles) {
    if (Test-Path $f) { Check "Meta file exists: $f" "pass" }
    else { Check "Meta file exists: $f" "fail" }
}

# 9. Rule files
$Rules = @(
    "meta-harness/meta/rules/absolute-rules.md"
)
foreach ($r in $Rules) {
    if (Test-Path $r) { Check "Rule exists: $r" "pass" }
    else { Check "Rule exists: $r" "fail" }
}

# 10. Directories
if (Test-Path ".meta-harness/runs") { Check ".meta-harness/runs/ directory exists" "pass" }
else { Check ".meta-harness/runs/ directory exists" "warn" }

if (Test-Path ".meta-harness/memory") { Check ".meta-harness/memory/ directory exists" "pass" }
else { Check ".meta-harness/memory/ directory exists" "warn" }

Write-Host ""
Write-Host "=== Results ===" -ForegroundColor Cyan
Write-Host "  Pass: $Pass" -ForegroundColor Green
Write-Host "  Warn: $Warn" -ForegroundColor Yellow
Write-Host "  Fail: $Fail" -ForegroundColor Red

if ($Fail -gt 0) {
    Write-Host ""
    Write-Host "Health check failed. See above for details." -ForegroundColor Red
    exit 1
} else {
    Write-Host ""
    Write-Host "Health check passed." -ForegroundColor Green
    exit 0
}