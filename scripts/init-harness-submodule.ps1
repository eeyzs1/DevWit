# init-harness-submodule.ps1 — Windows PowerShell 初始化脚本
# 前提：已在项目中运行 git submodule add ... meta-harness
# 用法：cd ~/my-project && powershell meta-harness/scripts/init-harness-submodule.ps1

param()

$ErrorActionPreference = "Stop"

# 检查 submodule 是否存在
if (-not (Test-Path "meta-harness/AGENTS.md")) {
    Write-Error "meta-harness submodule not found."
    Write-Host "Run first: git submodule add <url> meta-harness"
    exit 1
}

Write-Host "=== Meta-Harness Submodule Init ==="
Write-Host ""

# 1. 创建项目根 AGENTS.md（引导文件）
if (-not (Test-Path "AGENTS.md")) {
    @'
# Project AI Instructions

This project uses **Meta-Harness** framework as a git submodule at `meta-harness/`.

## Bootstrap (ALWAYS — 4 steps)

1. **Self-update check** — run the platform-appropriate version check script. If an update is available, run the update script immediately, then restart the pipeline.
   - Linux/Mac: `bash meta-harness/scripts/check-version.sh` -> if `UPDATE_AVAILABLE=true`, run `bash meta-harness/scripts/update-harness.sh`
   - Windows: `powershell meta-harness/scripts/check-version.ps1` -> if `UPDATE_AVAILABLE=true`, run `powershell meta-harness/scripts/update-harness.ps1`
2. **Read `meta-harness/meta/interpreter.md`** — extract measurable acceptance criteria
3. **Read `meta-harness/meta/phase-loader.md`** — load ONLY the files needed for the current phase
4. **Follow the pipeline:** INTERPRET -> GENERATE -> FACTORY -> PROVE -> JUDGE -> EVOLVE

## Phase-Specific Files (LOAD ON DEMAND)

| Phase | Load |
|-------|------|
| INTERPRET | `meta-harness/meta/interpreter.md` + `meta-harness/meta/phase-loader.md` |
| GENERATE | `meta-harness/meta/harness-generator.md` + `meta-harness/seeds/planning/project-yaml-template.yaml` |
| FACTORY | `meta-harness/meta/agent-factory.md` |
| PROVE | `meta-harness/scripts/verify-generation.py` + `meta-harness/seeds/verification/auditor-engine.md` |
| JUDGE | `meta-harness/seeds/guard.py` + `meta-harness/seeds/planning/orchestrator.py` |
| EVOLVE | `meta-harness/evolution/framework.md` + `meta-harness/scripts/evolve.py` |

## Legacy Migration

If this project was migrated from an old copy-paste installation:
- Linux/Mac: `bash meta-harness/scripts/migrate-legacy.sh`
- Windows: `powershell meta-harness/scripts/migrate-legacy.ps1`

## Configuration

Edit `.meta-harness/project.yaml` for project-specific settings.

## Framework Update

```bash
# Linux/Mac
bash meta-harness/scripts/update-harness.sh

# Windows
powershell meta-harness/scripts/update-harness.ps1
```

Full rules live at `meta-harness/meta/rules/` — load only when needed.
'@ | Set-Content -Path "AGENTS.md" -Encoding UTF8
    Write-Host "  ✓ AGENTS.md created (project-level bootstrap)"
} else {
    Write-Host "  ⚠ AGENTS.md exists — not overwritten"
}

# 2. 创建 .meta-harness 目录（本地专属）
New-Item -ItemType Directory -Force -Path ".meta-harness" | Out-Null
Write-Host "  ✓ .meta-harness/ directory created"

# 3. 复制 project.yaml 模板（schema_version 已硬编码在模板中，无需替换）
if (-not (Test-Path ".meta-harness/project.yaml")) {
    Copy-Item "meta-harness/seeds/planning/project-yaml-template.yaml" ".meta-harness/project.yaml"
    Write-Host "  ✓ .meta-harness/project.yaml created"
} else {
    Write-Host "  ⚠ .meta-harness/project.yaml exists — not overwritten"
}

# 4. 创建运行时目录
New-Item -ItemType Directory -Force -Path ".meta-harness/runs" | Out-Null
New-Item -ItemType Directory -Force -Path ".meta-harness/memory" | Out-Null
Write-Host "  ✓ runs/ and memory/ directories created"

# 5. 创建 .gitignore
if (-not (Test-Path ".meta-harness/.gitignore")) {
    @'
runs/
*.log
'@ | Set-Content -Path ".meta-harness/.gitignore" -Encoding UTF8
    Write-Host "  ✓ .meta-harness/.gitignore created"
}

Write-Host ""
Write-Host "=== Done ==="
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit .meta-harness/project.yaml — set your project name and repos"
Write-Host "  2. Commit: git add meta-harness .meta-harness AGENTS.md .gitmodules"
Write-Host '     git commit -m "Add meta-harness framework"'
Write-Host "  3. Start a task: just ask your AI agent to build something"
Write-Host ""
Write-Host "Framework update:"
Write-Host "  Linux/Mac: bash meta-harness/scripts/update-harness.sh"
Write-Host "  Windows:   powershell meta-harness/scripts/update-harness.ps1"