#!/usr/bin/env bash
# migrate-legacy.sh — 将老的复制粘贴方式安装的 meta-harness 迁移到 submodule 方式
# 用法：cd ~/my-old-project && bash <(curl -s <raw-url>/migrate-legacy.sh)
#      或：将 meta-harness 仓库的 scripts/migrate-legacy.sh 复制到项目根后运行
# 注意：需要在包含旧 .meta-harness/ 目录的项目根目录下运行

set -euo pipefail

echo "=== Meta-Harness Legacy Migration ==="
echo ""
echo "This script migrates an old copy-paste installation to git submodule."
echo ""

# === 检测 ===

# 检测 1: 是否有旧的 .meta-harness/ 目录（含框架文件）
if [ ! -d ".meta-harness" ]; then
  echo "ERROR: .meta-harness/ directory not found." >&2
  echo "This script is for migrating OLD copy-paste installations." >&2
  echo "For new projects, use: bash meta-harness/scripts/init-harness-submodule.sh" >&2
  exit 1
fi

# 检测 2: 是否已经使用 submodule
if [ -f ".gitmodules" ] && grep -q "meta-harness" .gitmodules 2>/dev/null; then
  echo "✓ meta-harness is already a git submodule. No migration needed."
  echo "  To update: bash meta-harness/scripts/update-harness.sh"
  exit 0
fi

# 检测 3: 确认是旧版（复制粘贴）安装
HAS_OLD_FILES=false
if [ -f ".meta-harness/meta/interpreter.md" ]; then HAS_OLD_FILES=true; fi
if [ -f ".meta-harness/meta/harness-generator.md" ]; then HAS_OLD_FILES=true; fi
if [ -f ".meta-harness/seeds/guard.py" ]; then HAS_OLD_FILES=true; fi

if [ "$HAS_OLD_FILES" = false ]; then
  echo "NOTE: .meta-harness/ exists but no old framework files detected."
  echo "This might already be migrated or a different structure."
  echo "Proceeding anyway..."
fi

# === 询问确认 ===
echo "This will:"
echo "  1. Back up .meta-harness/project.yaml, runs/, memory/"
echo "  2. Remove old framework files from .meta-harness/"
echo "  3. Add meta-harness as a git submodule"
echo "  4. Restore local files"
echo "  5. Generate project-level AGENTS.md"
echo ""
read -p "Continue? [y/N] " -r CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

echo ""

# === 步骤 1: 备份 ===
echo "--- Step 1: Backup ---"
BACKUP_DIR=$(mktemp -d /tmp/mh-legacy-backup.XXXXXX)
echo "Backup directory: $BACKUP_DIR"

[ -f ".meta-harness/project.yaml" ] && cp .meta-harness/project.yaml "$BACKUP_DIR/" && echo "  ✓ project.yaml backed up"
[ -d ".meta-harness/runs" ] && cp -r .meta-harness/runs "$BACKUP_DIR/" && echo "  ✓ runs/ backed up"
[ -d ".meta-harness/memory" ] && cp -r .meta-harness/memory "$BACKUP_DIR/" && echo "  ✓ memory/ backed up"

# 备份旧的 AGENTS.md（如果有）
[ -f "AGENTS.md" ] && cp AGENTS.md "$BACKUP_DIR/" && echo "  ✓ AGENTS.md backed up"

echo ""

# === 步骤 2: 清理旧框架文件 ===
echo "--- Step 2: Clean old framework files ---"

# 删除 .meta-harness/ 中的框架文件，保留 project.yaml, runs/, memory/, .gitignore
for DIR in meta seeds scripts evolution reference verification; do
  if [ -d ".meta-harness/$DIR" ]; then
    rm -rf ".meta-harness/$DIR"
    echo "  ✓ removed .meta-harness/$DIR/"
  fi
done

for FILE in AGENTS.md README.md; do
  if [ -f ".meta-harness/$FILE" ]; then
    rm ".meta-harness/$FILE"
    echo "  ✓ removed .meta-harness/$FILE"
  fi
done

echo ""

# === 步骤 3: 添加 submodule ===
echo "--- Step 3: Add git submodule ---"

# 检查仓库是否有远程 (git)
if git remote get-url origin >/dev/null 2>&1; then
  HAS_REMOTE=true
else
  HAS_REMOTE=false
fi

# 尝试获取 meta-harness 的 remote URL
# 优先从旧 AGENTS.md 或 .meta-harness 中寻找线索
MH_REMOTE_URL=""
if [ "$HAS_REMOTE" = true ]; then
  if git config -f .gitmodules --get submodule.meta-harness.url >/dev/null 2>&1; then
    echo "meta-harness submodule already exists in .gitmodules — skipping add"
  else
    # 尝试检测 meta-harness 的源 URL
    # 常见位置: 旧 AGENTS.md 中可能有克隆链接
    if [ -f "$BACKUP_DIR/AGENTS.md" ]; then
      # 不做自动检测，直接提示用户
      echo ""
    fi
    
    echo ""
    echo "=== MANUAL STEP REQUIRED ==="
    echo "Please provide the meta-harness repository URL."
    echo "Example: https://github.com/your-org/meta-harness.git"
    echo ""
    read -p "Meta-harness repo URL: " MH_REMOTE_URL
    
    if [ -n "$MH_REMOTE_URL" ]; then
      git submodule add "$MH_REMOTE_URL" meta-harness
      echo "  ✓ submodule added: $MH_REMOTE_URL"
    else
      echo "ERROR: No URL provided. Cannot add submodule." >&2
      echo ""
      echo "You can add it manually later:"
      echo "  git submodule add <url> meta-harness"
      echo "Then run: bash meta-harness/scripts/init-harness-submodule.sh"
      exit 1
    fi
  fi
else
  echo "WARNING: No git remote found. Initialize git repo first."
  echo "  git init"
  echo "  git remote add origin <your-repo-url>"
  echo "Then run this script again."
  exit 1
fi

echo ""

# === 步骤 4: 恢复本地文件 ===
echo "--- Step 4: Restore local files ---"

if [ -f "$BACKUP_DIR/project.yaml" ]; then
  cp "$BACKUP_DIR/project.yaml" .meta-harness/project.yaml
  echo "  ✓ project.yaml restored"
fi

if [ -d "$BACKUP_DIR/runs" ]; then
  cp -r "$BACKUP_DIR/runs" .meta-harness/runs
  echo "  ✓ runs/ restored"
fi

if [ -d "$BACKUP_DIR/memory" ]; then
  cp -r "$BACKUP_DIR/memory" .meta-harness/memory
  echo "  ✓ memory/ restored"
fi

echo ""

# === 步骤 5: 生成项目级 AGENTS.md ===
echo "--- Step 5: Generate project AGENTS.md ---"

if [ -f "AGENTS.md" ]; then
  if [ -f "$BACKUP_DIR/AGENTS.md" ]; then
    echo "  ⚠ AGENTS.md exists — checking if it needs update..."
    if grep -q "submodule\|bootstrap\|meta-harness/" AGENTS.md 2>/dev/null; then
      echo "  ✓ AGENTS.md already references submodule — keeping it"
    else
      # 旧版 AGENTS.md，重命名为备份，创建新的
      mv AGENTS.md "AGENTS.md.old"
      echo "  ✓ old AGENTS.md renamed to AGENTS.md.old"
      bash meta-harness/scripts/init-harness-submodule.sh 2>/dev/null || true
    fi
  fi
else
  bash meta-harness/scripts/init-harness-submodule.sh 2>/dev/null || true
fi

echo ""

# === 清理 ===
echo "--- Cleanup ---"
rm -rf "$BACKUP_DIR"
echo "  ✓ temporary backup removed"

echo ""
echo "=== Migration Complete ==="
echo ""
echo "Next steps:"
echo "  1. Review .meta-harness/project.yaml"
echo "  2. Review AGENTS.md (check old version at AGENTS.md.old if renamed)"
echo "  3. Commit: git add meta-harness .meta-harness AGENTS.md .gitmodules"
echo '     git commit -m "Migrate meta-harness to git submodule"'
echo ""
echo "To update the framework in the future:"
echo "  bash meta-harness/scripts/update-harness.sh"