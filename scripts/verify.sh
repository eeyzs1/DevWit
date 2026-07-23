#!/usr/bin/env bash
# verify.sh — 检查 meta-harness 安装是否健康
# 用法：bash meta-harness/scripts/verify.sh
# 检查项：submodule 存在、git tag 可读、project.yaml 存在、AGENTS.md 正确、.gitmodules 正确

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo -e "${BOLD}=== Meta-Harness Health Check ===${RESET}"
echo ""

PASS=0
FAIL=0
WARN=0

check() {
    local desc="$1"
    local result="$2"
    if [ "$result" = "pass" ]; then
        echo -e "  ${GREEN}✓${RESET} $desc"
        PASS=$((PASS + 1))
    elif [ "$result" = "warn" ]; then
        echo -e "  ${YELLOW}⚠${RESET} $desc"
        WARN=$((WARN + 1))
    else
        echo -e "  ${RED}✗${RESET} $desc"
        FAIL=$((FAIL + 1))
    fi
}

# 1. Submodule 存在（用 scripts/check-version.py 存在性作为 harness 项目标志）
if [ -d "meta-harness" ] && [ -f "meta-harness/scripts/check-version.py" ]; then
    check "Submodule meta-harness/ exists (with check-version.py)" "pass"
else
    check "Submodule meta-harness/ exists (with check-version.py)" "fail"
fi

# 2. .gitmodules 包含 meta-harness
if [ -f ".gitmodules" ] && grep -q "meta-harness" .gitmodules 2>/dev/null; then
    check ".gitmodules references meta-harness" "pass"
else
    check ".gitmodules references meta-harness" "fail"
fi

# 3. 框架版本（基于 git tag）
VER=$(git -C "meta-harness" describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$VER" ]; then
    check "Framework version via git tag: $VER" "pass"
else
    check "Framework version via git tag" "fail"
fi

# 4. project.yaml 存在
if [ -f ".meta-harness/project.yaml" ]; then
    check ".meta-harness/project.yaml exists" "pass"
else
    check ".meta-harness/project.yaml exists" "fail"
fi

# 5. project.yaml 可解析
if [ -f ".meta-harness/project.yaml" ]; then
    if grep -q "project:" .meta-harness/project.yaml 2>/dev/null; then
        check "project.yaml has 'project:' key" "pass"
    else
        check "project.yaml has 'project:' key" "fail"
    fi
fi

# 6. AGENTS.md 存在并引用 submodule
if [ -f "AGENTS.md" ]; then
    if grep -q "meta-harness/" AGENTS.md 2>/dev/null; then
        check "AGENTS.md references meta-harness/ submodule" "pass"
    else
        check "AGENTS.md references meta-harness/ submodule" "warn"
    fi
else
    check "AGENTS.md exists" "fail"
fi

# 7. 关键脚本存在
SCRIPTS=(
    "meta-harness/scripts/check-version.sh"
    "meta-harness/scripts/update-harness.sh"
    "meta-harness/scripts/migrate.sh"
    "meta-harness/scripts/init-harness-submodule.sh"
)
for s in "${SCRIPTS[@]}"; do
    if [ -f "$s" ]; then
        check "Script exists: $s" "pass"
    else
        check "Script exists: $s" "fail"
    fi
done

# 8. 关键 meta 文件存在
META_FILES=(
    "meta-harness/meta/interpreter.md"
    "meta-harness/meta/harness-generator.md"
    "meta-harness/meta/phase-loader.md"
    "meta-harness/meta/agent-factory.md"
)
for f in "${META_FILES[@]}"; do
    if [ -f "$f" ]; then
        check "Meta file exists: $f" "pass"
    else
        check "Meta file exists: $f" "fail"
    fi
done

# 9. 规则文件存在
RULES=(
    "meta-harness/meta/rules/absolute-rules.md"
)
for r in "${RULES[@]}"; do
    if [ -f "$r" ]; then
        check "Rule exists: $r" "pass"
    else
        check "Rule exists: $r" "fail"
    fi
done

# 10. runs/ 和 memory/ 目录存在
if [ -d ".meta-harness/runs" ]; then
    check ".meta-harness/runs/ directory exists" "pass"
else
    check ".meta-harness/runs/ directory exists" "warn"
fi

if [ -d ".meta-harness/memory" ]; then
    check ".meta-harness/memory/ directory exists" "pass"
else
    check ".meta-harness/memory/ directory exists" "warn"
fi

echo ""
echo -e "${BOLD}=== Results ===${RESET}"
echo -e "  ${GREEN}Pass: $PASS${RESET}"
echo -e "  ${YELLOW}Warn: $WARN${RESET}"
echo -e "  ${RED}Fail: $FAIL${RESET}"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo -e "${RED}Health check failed. See above for details.${RESET}"
    exit 1
else
    echo ""
    echo -e "${GREEN}Health check passed.${RESET}"
    exit 0
fi