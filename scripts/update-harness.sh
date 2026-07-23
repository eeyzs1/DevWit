#!/usr/bin/env bash
# update-harness.sh — 一键更新 meta-harness submodule
# 用法：bash meta-harness/scripts/update-harness.sh
# 做三件事：git pull → migrate project.yaml → git commit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$MH_ROOT/.." && pwd)"

# === 协议回退：当前 remote pull 失败时，自动切到另一种协议重试 ===
MH_REPO_SSH="git@github.com:eeyzs1/meta_harness.git"
MH_REPO_HTTPS="https://github.com/eeyzs1/meta_harness.git"

pull_with_fallback() {
    local repo_dir="$1"
    local current remote alternate
    current=$(git -C "$repo_dir" config --get remote.origin.url 2>/dev/null || echo "")
    remote="$current"

    if [ -n "$current" ]; then
        if echo "$current" | grep -q "^git@github.com:"; then
            alternate="$MH_REPO_HTTPS"
        else
            alternate="$MH_REPO_SSH"
        fi
    else
        alternate="$MH_REPO_SSH"
    fi

    # 第一次尝试：沿用已配置的 remote
    if git -C "$repo_dir" pull origin main; then
        return 0
    fi

    echo ""
    echo "  Pull from current remote ($remote) failed."
    echo "  Retrying with alternate protocol: $alternate"

    # 第二次尝试：临时把 remote 切到 alternate
    if [ -n "$current" ]; then
        git -C "$repo_dir" remote set-url origin "$alternate"
    else
        git -C "$repo_dir" remote add origin "$alternate"
    fi

    if ! git -C "$repo_dir" pull origin main; then
        echo "  ERROR: Both SSH and HTTPS failed for meta-harness repo." >&2
        echo "  Check network/credentials, then restore the original remote if needed:" >&2
        if [ -n "$current" ]; then
            echo "    git -C \"$repo_dir\" remote set-url origin $current" >&2
        fi
        return 1
    fi

    # 拉成功：把 remote 改回原值（保留用户原来的协议偏好）
    if [ -n "$current" ]; then
        git -C "$repo_dir" remote set-url origin "$current"
    fi
    return 0
}

echo "=== Meta-Harness Update ==="
echo ""

# Step 1: 检查是否 submodule
if [ ! -f "$PROJECT_ROOT/.gitmodules" ]; then
  echo "ERROR: No .gitmodules found. Is meta-harness installed as a submodule?" >&2
  echo "Run: git submodule add <url> meta-harness" >&2
  exit 1
fi

if ! grep -q "meta-harness" "$PROJECT_ROOT/.gitmodules" 2>/dev/null; then
  echo "ERROR: meta-harness not found in .gitmodules." >&2
  exit 1
fi

# Step 2: 记录当前版本（基于 git tag，不依赖 VERSION 文件）
CURRENT_VERSION=$(git -C "$MH_ROOT" describe --tags --abbrev=0 2>/dev/null || echo "unknown")
echo "Current version: $CURRENT_VERSION"

# Step 3: Git pull
echo ""
echo "--- Pulling latest framework ---"
pull_with_fallback "$MH_ROOT"

# 拉取后获取最新 tag（需要 fetch tags 才能 describe 到刚 pull 下来的新 tag）
git -C "$MH_ROOT" fetch --tags --quiet 2>/dev/null || true
NEW_VERSION=$(git -C "$MH_ROOT" describe --tags --abbrev=0 2>/dev/null || echo "unknown")
echo "Updated to: $NEW_VERSION"

# Step 4: 迁移 project.yaml（如果 schema 版本变化）
if [ -f "$MH_ROOT/scripts/migrate.sh" ]; then
  echo ""
  echo "--- Migrating project configuration ---"
  bash "$MH_ROOT/scripts/migrate.sh" "$PROJECT_ROOT/.meta-harness/project.yaml" || true
fi

# Step 5: 提交更新
echo ""
echo "--- Committing update ---"
cd "$PROJECT_ROOT"
git add meta-harness
if [ -f ".meta-harness/project.yaml" ]; then
  git add .meta-harness/project.yaml
fi

# 检查是否有变更
if git diff --cached --quiet; then
  echo "No changes to commit (already up to date)."
else
  git commit -m "chore: update meta-harness $CURRENT_VERSION -> $NEW_VERSION"
  echo ""
  echo "=== Committed: meta-harness $CURRENT_VERSION -> $NEW_VERSION ==="
fi

echo ""
echo "Done. Framework is now at $NEW_VERSION."