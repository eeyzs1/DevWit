# uninstall.ps1 — Windows PowerShell 移除 meta-harness
# 用法：powershell meta-harness/scripts/uninstall.ps1
# 注意：会删除 submodule、.gitmodules 中的 meta-harness 条目、AGENTS.md
#       .meta-harness/ 目录不会被删除

param()
$ErrorActionPreference = "Continue"

Write-Host "=== Meta-Harness Uninstall ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "This will remove:" -ForegroundColor Yellow
Write-Host "  - meta-harness/ submodule"
Write-Host "  - .gitmodules meta-harness entry"
Write-Host "  - AGENTS.md (if it's the meta-harness bootstrap)"
Write-Host ""
Write-Host "This will KEEP:" -ForegroundColor Yellow
Write-Host "  - .meta-harness/ (your project.yaml, memory, runs)"
Write-Host ""

$Confirm = Read-Host "Continue? [y/N]"
if ($Confirm -ne "y" -and $Confirm -ne "Y") { Write-Host "Aborted."; exit 0 }

Write-Host ""

# 1. Deinit and remove submodule
if ((Test-Path ".gitmodules") -and ((Get-Content ".gitmodules" -Raw) -match "meta-harness")) {
    Write-Host "--- Removing submodule ---"
    git submodule deinit -f meta-harness 2>$null
    git rm -f meta-harness 2>$null
    if (Test-Path "meta-harness") { Remove-Item -Recurse -Force meta-harness }
    if (Test-Path ".git/modules/meta-harness") { Remove-Item -Recurse -Force ".git/modules/meta-harness" }
    Write-Host "  ✓ submodule removed"
}

# 2. Remove meta-harness entry from .gitmodules
if (Test-Path ".gitmodules") {
    $Content = Get-Content ".gitmodules" -Raw
    $SubmoduleCount = ([regex]::Matches($Content, '\[submodule')).Count
    if ($SubmoduleCount -eq 1 -and $Content -match "meta-harness") {
        Remove-Item ".gitmodules"
        Write-Host "  ✓ .gitmodules removed (only had meta-harness)"
    } elseif ($Content -match "meta-harness") {
        Write-Host "  ⚠ .gitmodules has other submodules — manually remove [submodule `"meta-harness`"] section" -ForegroundColor Yellow
    }
}

# 3. Remove AGENTS.md if bootstrap
if (Test-Path "AGENTS.md") {
    $Content = Get-Content "AGENTS.md" -Raw
    if ($Content -match "meta-harness") {
        Remove-Item "AGENTS.md"
        Write-Host "  ✓ AGENTS.md removed"
    } else {
        Write-Host "  ⚠ AGENTS.md present but doesn't seem meta-harness — keeping it"
    }
}

Write-Host ""
Write-Host "=== Uninstall Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Remaining:"
Write-Host "  .meta-harness/ — your project config and memory (not deleted)"
Write-Host ""
Write-Host "To fully remove: Remove-Item -Recurse .meta-harness/"
Write-Host ""
Write-Host "To reinstall:"
Write-Host "  powershell -ExecutionPolicy Bypass -Command `"iwr <url>/install.ps1 | iex`""