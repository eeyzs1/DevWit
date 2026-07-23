#!/usr/bin/env bash
# uninstall.sh — 从项目中移除 meta-harness
# 用法：bash meta-harness/scripts/uninstall.sh
# 注意：会删除 submodule、.gitmodules 中的 meta-harness 条目、AGENTS.md
#       .meta-harness/ 目录不会被删除（包含你的 project.yaml 和记忆）

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo -e "${BOLD}=== Meta-Harness Uninstall ===${RESET}"
echo ""

echo -e "${YELLOW}This will remove:${RESET}"
echo "  - meta-harness/ submodule"
echo "  - .gitmodules meta-harness entry"
echo "  - AGENTS.md (if it's the meta-harness bootstrap)"
echo ""
echo -e "${YELLOW}This will KEEP:${RESET}"
echo "  - .meta-harness/ (your project.yaml, memory, runs)"
echo ""

read -p "Continue? [y/N] " -r CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 0
fi

echo ""

# 1. Deinit and remove submodule
if [ -f ".gitmodules" ] && grep -q "meta-harness" .gitmodules 2>/dev/null; then
    echo "--- Removing submodule ---"
    git submodule deinit -f meta-harness 2>/dev/null || true
    git rm -f meta-harness 2>/dev/null || true
    rm -rf meta-harness 2>/dev/null || true
    rm -rf .git/modules/meta-harness 2>/dev/null || true
    echo "  ✓ submodule removed"
fi

# 2. Remove meta-harness entry from .gitmodules
if [ -f ".gitmodules" ]; then
    # 检查 .gitmodules 是否只剩 meta-harness
    if [ "$(grep -c 'submodule' .gitmodules 2>/dev/null || echo 0)" -eq 1 ] && grep -q "meta-harness" .gitmodules 2>/dev/null; then
        rm .gitmodules
        echo "  ✓ .gitmodules removed (only had meta-harness)"
    elif grep -q "meta-harness" .gitmodules 2>/dev/null; then
        echo -e "  ${YELLOW}⚠ .gitmodules has other submodules — manually remove [submodule \"meta-harness\"] section${RESET}"
    fi
fi

# 3. Remove AGENTS.md if it's the bootstrap
if [ -f "AGENTS.md" ]; then
    if grep -q "meta-harness" AGENTS.md 2>/dev/null; then
        rm AGENTS.md
        echo "  ✓ AGENTS.md removed"
    else
        echo "  ⚠ AGENTS.md present but doesn't seem to be meta-harness — keeping it"
    fi
fi

echo ""
echo -e "${GREEN}${BOLD}=== Uninstall Complete ===${RESET}"
echo ""
echo "Remaining:"
echo "  .meta-harness/ — your project config and memory (not deleted)"
echo ""
echo "To fully remove: rm -rf .meta-harness/"
echo ""
echo "To reinstall:"
echo "  bash <(curl -sSL https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/install.sh)"