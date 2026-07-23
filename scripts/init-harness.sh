#!/usr/bin/env bash
# init-harness.sh — 初始化 Meta-Harness 到现有项目
# 吸收自：union 框架 scripts/init.sh
# 用法：cd ~/my-project && bash /path/to/meta-harness/scripts/init-harness.sh /path/to/meta-harness

set -euo pipefail

META_HARNESS_SRC="${1:-}"
if [ -z "$META_HARNESS_SRC" ]; then
  echo "Usage: init-harness.sh <path-to-meta-harness-framework>"
  echo ""
  echo "Example:"
  echo "  cd ~/my-project"
  echo "  bash ~/meta-harness/scripts/init-harness.sh ~/meta-harness"
  exit 1
fi

if [ ! -f "$META_HARNESS_SRC/AGENTS.md" ]; then
  echo "ERROR: $META_HARNESS_SRC/AGENTS.md not found. Please provide the path to the Meta-Harness framework root." >&2
  exit 1
fi

TARGET_DIR=".meta-harness"

echo "=== Meta-Harness Init ==="
echo ""

# 检查是否已有 .meta-harness
if [ -d "$TARGET_DIR" ]; then
  echo "⚠ $TARGET_DIR already exists."
  echo "  Existing files will be preserved. New files will be added."
  echo ""
fi

# 复制框架文件
echo "Copying framework files..."
mkdir -p "$TARGET_DIR"

# 核心文件
cp "$META_HARNESS_SRC/AGENTS.md" "$TARGET_DIR/AGENTS.md"

# 配置模板（如果不存在）
if [ ! -f "$TARGET_DIR/project.yaml" ]; then
  cp "$META_HARNESS_SRC/seeds/planning/project-yaml-template.yaml" "$TARGET_DIR/project.yaml"
  echo "  ✓ project.yaml created"
else
  echo "  ⚠ project.yaml exists — not overwritten"
fi

# Scripts
mkdir -p "$TARGET_DIR/scripts"
cp "$META_HARNESS_SRC/seeds/tools/repo-state.sh" "$TARGET_DIR/scripts/" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/planning/claim-run.sh" "$TARGET_DIR/scripts/" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/tools/detect-stack.sh" "$TARGET_DIR/scripts/" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/tools/detect-env.sh" "$TARGET_DIR/scripts/" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/tools/summarize-repo.sh" "$TARGET_DIR/scripts/" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/tools/validate-phase.sh" "$TARGET_DIR/scripts/" 2>/dev/null || true
echo "  ✓ scripts/ copied"

# Skills
mkdir -p "$TARGET_DIR/skills"
cp "$META_HARNESS_SRC/seeds/skills/"*.md "$TARGET_DIR/skills/" 2>/dev/null || true
echo "  ✓ skills/ copied"

# Templates
mkdir -p "$TARGET_DIR/templates"
cp "$META_HARNESS_SRC/seeds/planning/protocol-template.md" "$TARGET_DIR/templates/PROTOCOL.md" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/planning/phase-spec-template.md" "$TARGET_DIR/templates/phase-spec.md" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/memory/state-template.md" "$TARGET_DIR/templates/STATE.md" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/memory/roadmap-template.md" "$TARGET_DIR/templates/ROADMAP.md" 2>/dev/null || true
echo "  ✓ templates/ copied"

# Engine
mkdir -p "$TARGET_DIR/engine"
cp "$META_HARNESS_SRC/seeds/planning/planner-engine.md" "$TARGET_DIR/engine/planner.md" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/planning/executor-engine.md" "$TARGET_DIR/engine/executor.md" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/verification/auditor-engine.md" "$TARGET_DIR/engine/auditor.md" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/planning/leaf-protocol.md" "$TARGET_DIR/engine/leaf-protocol.md" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/observability/transcript-blocks.md" "$TARGET_DIR/engine/transcript-blocks.md" 2>/dev/null || true
cp "$META_HARNESS_SRC/seeds/verification/recovery-and-audit.md" "$TARGET_DIR/engine/recovery-and-audit.md" 2>/dev/null || true
echo "  ✓ engine/ copied"

# Adapter refs
mkdir -p "$TARGET_DIR/adapters"
if [ -d "$META_HARNESS_SRC/seeds/tools/adapters" ]; then
  cp -r "$META_HARNESS_SRC/seeds/tools/adapters/"* "$TARGET_DIR/adapters/" 2>/dev/null || true
fi
echo "  ✓ adapters/ copied"

# Gitignore
if [ ! -f "$TARGET_DIR/.gitignore" ]; then
  cat > "$TARGET_DIR/.gitignore" <<'GITIGNORE'
# Meta-Harness runtime artifacts
runs/
memory/*.md
!memory/MEMORY.md
*.log
GITIGNORE
  echo "  ✓ .gitignore created"
fi

# 确保项目根目录的 .gitignore 也忽略 .meta-harness/runs/
if [ -f ".gitignore" ]; then
  if ! grep -q '.meta-harness/runs/' .gitignore 2>/dev/null; then
    echo "" >> .gitignore
    echo "# Meta-Harness" >> .gitignore
    echo ".meta-harness/runs/" >> .gitignore
  fi
fi

# Runs directory
mkdir -p "$TARGET_DIR/runs"
mkdir -p "$TARGET_DIR/memory"
if [ ! -f "$TARGET_DIR/memory/MEMORY.md" ]; then
  echo "# Memory Index" > "$TARGET_DIR/memory/MEMORY.md"
  echo "" >> "$TARGET_DIR/memory/MEMORY.md"
  echo "This file indexes all saved memories. Each entry links to a memory file." >> "$TARGET_DIR/memory/MEMORY.md"
fi

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. Edit $TARGET_DIR/project.yaml — set your project name and repos"
echo "  2. Start a task: just ask your AI agent to build something"
echo "     e.g. 'Build a user login feature'"
echo ""
echo "The agent will automatically detect .meta-harness/ and follow the framework."