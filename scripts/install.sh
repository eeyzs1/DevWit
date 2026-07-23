#!/usr/bin/env bash
# install.sh — 在新项目中安装 meta-harness（submodule 方式）
# 用法：bash <(curl -sSL https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/install.sh)
#      或：bash meta-harness/scripts/install.sh（已 submodule clone 后）
# 自动检测：有 git remote → submodule add → init → 完成

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo -e "${BOLD}=== Meta-Harness Install ===${RESET}"
echo ""

# === 检测 ===

# 是否已经在 submodule 中运行？（用 scripts/check-version.py 存在性作为 harness 项目标志）
if [ -f "meta-harness/scripts/check-version.py" ] && [ -f ".gitmodules" ]; then
    echo -e "${GREEN}Detected: submodule already present${RESET}"
    echo "Running init..."
    bash meta-harness/scripts/init-harness-submodule.sh
    exit 0
fi

# 是否在 meta-harness 仓库自身中？
if [ -f "AGENTS.md" ] && grep -q "META-HARNESS: you GENERATE" AGENTS.md 2>/dev/null; then
    echo -e "${YELLOW}This is the meta-harness repository itself.${RESET}"
    echo "install.sh is for APPLICATION projects that want to USE meta-harness."
    echo "To install in another project, copy this script there or use the curl command:"
    echo ""
    echo "  bash <(curl -sSL https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/install.sh)"
    exit 1
fi

# 检查 git
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo -e "${RED}ERROR: Not in a git repository.${RESET}"
    echo "Initialize git first:"
    echo "  git init"
    echo "  git remote add origin <your-repo-url>"
    exit 1
fi

# 检查是否已有 meta-harness 目录
if [ -d "meta-harness" ]; then
    echo -e "${YELLOW}meta-harness/ directory already exists.${RESET}"
    echo ""
    echo "If this is an old copy-paste install, use migrate instead:"
    echo "  bash <(curl -sSL https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/bootstrap-update.sh)"
    echo ""
    read -p "Overwrite with submodule? [y/N] " -r CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        echo "Aborted."
        exit 0
    fi
    rm -rf meta-harness
fi

# === 探测可用的 git 协议 ===
# 默认优先 SSH（推送/认证更顺），但允许通过环境变量或参数覆盖。
# 探测策略：用 timeout 限制的 git ls-remote 验证远端可达。
MH_REPO_SSH="git@github.com:eeyzs1/meta_harness.git"
MH_REPO_HTTPS="https://github.com/eeyzs1/meta_harness.git"
MH_REPO_URL="${MH_REPO_URL:-${1:-}}"

if [ -z "$MH_REPO_URL" ]; then
    echo -e "${BOLD}Detecting git protocol...${RESET}"
    if command -v timeout >/dev/null 2>&1; then
        PROBE_TIMEOUT() { timeout 5 git ls-remote --heads "$1" >/dev/null 2>&1; }
    else
        # macOS 默认无 timeout 命令，用 (sleep + kill) 兜底
        PROBE_TIMEOUT() {
            git ls-remote --heads "$1" >/dev/null 2>&1 &
            local pid=$!
            ( sleep 5; kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null ) &
            local watchdog=$!
            wait "$pid" 2>/dev/null
            local rc=$?
            kill -0 "$watchdog" 2>/dev/null && kill "$watchdog" 2>/dev/null
            wait "$watchdog" 2>/dev/null
            return $rc
        }
    fi

    if PROBE_TIMEOUT "$MH_REPO_SSH"; then
        MH_REPO_URL="$MH_REPO_SSH"
        echo -e "  ${GREEN}✓ SSH reachable — using $MH_REPO_URL${RESET}"
    elif PROBE_TIMEOUT "$MH_REPO_HTTPS"; then
        MH_REPO_URL="$MH_REPO_HTTPS"
        echo -e "  ${YELLOW}⚠ SSH unreachable — falling back to $MH_REPO_URL${RESET}"
    else
        echo -e "  ${RED}ERROR: Cannot reach GitHub via SSH or HTTPS.${RESET}"
        echo "  Check your network and SSH key configuration, then retry."
        echo "  You can also pass a URL explicitly: $0 <git-url>"
        exit 1
    fi
    echo ""
fi

# === 安装 ===

echo -e "${GREEN}Adding meta-harness as submodule...${RESET}"
git submodule add "$MH_REPO_URL" meta-harness
echo ""

echo -e "${GREEN}Initializing project structure...${RESET}"
bash meta-harness/scripts/init-harness-submodule.sh
echo ""

echo -e "${GREEN}${BOLD}=== Install Complete ===${RESET}"
echo ""
echo "Next steps:"
echo "  1. Edit .meta-harness/project.yaml — set your project name and settings"
echo "  2. Commit: git add meta-harness .meta-harness AGENTS.md .gitmodules"
echo '     git commit -m "Add meta-harness framework"'
echo ""
echo "Framework update:"
echo "  bash meta-harness/scripts/update-harness.sh"
echo ""
echo "Or auto-update: the agent will check for updates on every startup."