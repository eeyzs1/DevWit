#!/usr/bin/env bash
# init-harness-submodule.sh — 使用 submodule 方式初始化 Meta-Harness
# 前提：已在项目中运行 git submodule add ... meta-harness
# 用法：cd ~/my-project && bash meta-harness/scripts/init-harness-submodule.sh

set -euo pipefail

# 检查 submodule 是否存在
if [ ! -f "meta-harness/AGENTS.md" ]; then
  echo "ERROR: meta-harness submodule not found." >&2
  echo "Run first: git submodule add <url> meta-harness" >&2
  exit 1
fi

echo "=== Meta-Harness Submodule Init ==="
echo ""

# 1. 创建项目根 AGENTS.md（引导文件）
if [ ! -f "AGENTS.md" ]; then
  cat > AGENTS.md <<'BOOTSTRAP'
# Project AI Instructions

This project uses **Meta-Harness** framework as a git submodule at `meta-harness/`.

## Bootstrap (ALWAYS — 4 steps)

1. **Self-update check** — run the platform-appropriate version check script. If an update is available, run the update script immediately, then restart the pipeline.
   - Linux/Mac: `bash meta-harness/scripts/check-version.sh` → if `UPDATE_AVAILABLE=true`, run `bash meta-harness/scripts/update-harness.sh`
   - Windows: `powershell meta-harness/scripts/check-version.ps1` → if `UPDATE_AVAILABLE=true`, run `powershell meta-harness/scripts/update-harness.ps1`
2. **Read `meta-harness/meta/interpreter.md`** — extract measurable acceptance criteria
3. **Read `meta-harness/meta/phase-loader.md`** — load ONLY the files needed for the current phase
4. **Follow the pipeline:** INTERPRET → GENERATE → FACTORY → PROVE → JUDGE → EVOLVE

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
BOOTSTRAP
  echo "  ✓ AGENTS.md created (project-level bootstrap)"
else
  echo "  ⚠ AGENTS.md exists — not overwritten"
fi

# 2. 创建 .meta-harness 目录（本地专属）
mkdir -p .meta-harness
echo "  ✓ .meta-harness/ directory created"

# 3. 复制 project.yaml 模板（schema_version 已硬编码在模板中，无需替换）
if [ ! -f ".meta-harness/project.yaml" ]; then
  cp meta-harness/seeds/planning/project-yaml-template.yaml .meta-harness/project.yaml
  echo "  ✓ .meta-harness/project.yaml created"
else
  echo "  ⚠ .meta-harness/project.yaml exists — not overwritten"
fi

# 4. 创建运行时目录
mkdir -p .meta-harness/runs
mkdir -p .meta-harness/memory
echo "  ✓ runs/ and memory/ directories created"

# 5. 创建 .gitignore
if [ ! -f ".meta-harness/.gitignore" ]; then
  cat > .meta-harness/.gitignore <<'GITIGNORE'
runs/
*.log
GITIGNORE
  echo "  ✓ .meta-harness/.gitignore created"
fi

# 6. 确保项目根 .gitignore 忽略运行时产物
if [ -f ".gitignore" ]; then
  if ! grep -q '.meta-harness/runs/' .gitignore 2>/dev/null; then
    echo "" >> .gitignore
    echo "# Meta-Harness runtime" >> .gitignore
    echo ".meta-harness/runs/" >> .gitignore
    echo ".meta-harness/*.log" >> .gitignore
  fi
fi

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. Edit .meta-harness/project.yaml — set your project name and repos"
echo "  2. Commit: git add meta-harness .meta-harness AGENTS.md .gitmodules"
echo "     git commit -m 'Add meta-harness framework'"
echo "  3. Start a task: just ask your AI agent to build something"
echo ""
echo "Framework update: cd meta-harness && git pull origin main"