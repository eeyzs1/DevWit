#!/usr/bin/env bash
# bootstrap-update.sh — 泛化入口：在任何项目中更新/安装 meta-harness
# 
# 用法一（从网络加载）：
#   bash <(curl -sSL https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/bootstrap-update.sh)
#
# 用法二（本地已有 submodule）：
#   bash meta-harness/scripts/bootstrap-update.sh
#
# 自动检测项目状态：
#   A. 已是 submodule → 运行 update-harness.sh 更新框架
#   B. 旧复制粘贴在根目录 (meta/seeds/scripts 在根) → 运行 migrate-legacy.sh 迁移
#   C. 旧复制粘贴在 .meta-harness/ → 运行 migrate-legacy.sh 迁移
#   D. 未安装 → 提供安装指引

set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

# === 共享：探测可用的 git 协议 ===
MH_REPO_SSH="git@github.com:eeyzs1/meta_harness.git"
MH_REPO_HTTPS="https://github.com/eeyzs1/meta_harness.git"

detect_mh_repo_url() {
    local override="${1:-}"
    if [ -n "$override" ]; then
        echo "$override"
        return 0
    fi
    if [ -n "${MH_REPO_URL:-}" ]; then
        echo "$MH_REPO_URL"
        return 0
    fi

    local probe
    if command -v timeout >/dev/null 2>&1; then
        probe() { timeout 5 git ls-remote --heads "$1" >/dev/null 2>&1; }
    else
        # macOS / 其它无 timeout 的平台：靠 sleep + kill 兜底
        probe() {
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

    if probe "$MH_REPO_SSH"; then
        echo -e "  ${GREEN}✓ SSH reachable${RESET}" >&2
        echo "$MH_REPO_SSH"
    elif probe "$MH_REPO_HTTPS"; then
        echo -e "  ${YELLOW}⚠ SSH unreachable — falling back to HTTPS${RESET}" >&2
        echo "$MH_REPO_HTTPS"
    else
        echo -e "  ${RED}ERROR: Cannot reach GitHub via SSH or HTTPS.${RESET}" >&2
        echo "  Check your network and SSH key configuration, then retry." >&2
        return 1
    fi
}

echo -e "${BOLD}=== Meta-Harness Bootstrap ===${RESET}"
echo ""

# === 检测状态 ===

detect_type() {
    # Type A: submodule
    if [ -f ".gitmodules" ] && grep -q "meta-harness" .gitmodules 2>/dev/null; then
        # 用 scripts/check-version.py 存在性作为"是否是 harness 项目"的标志
        if [ -f "meta-harness/scripts/check-version.py" ]; then
            echo "A"
            return
        fi
    fi
    
    # Type B: 旧版复制粘贴在根目录（框架文件散落在根）
    if [ -f "meta/interpreter.md" ] && [ -f "seeds/guard.py" ]; then
        echo "B"
        return
    fi
    
    # Type C: 旧版复制粘贴在 .meta-harness/
    if [ -f ".meta-harness/meta/interpreter.md" ] || [ -f ".meta-harness/seeds/guard.py" ]; then
        echo "C"
        return
    fi
    
    # Type D: 未安装
    echo "D"
}

TYPE=$(detect_type)

case "$TYPE" in
    A)
        echo -e "${GREEN}Detected: submodule installation${RESET}"
        echo ""
        if [ -f "meta-harness/scripts/update-harness.sh" ]; then
            echo "Updating framework..."
            bash meta-harness/scripts/update-harness.sh
        else
            echo -e "${RED}ERROR: update-harness.sh not found in submodule.${RESET}"
            echo "Try: cd meta-harness && git pull origin main"
            exit 1
        fi
        ;;
        
    B)
        echo -e "${YELLOW}Detected: old copy-paste (framework files at root)${RESET}"
        echo "This project was installed the old way — framework files are scattered in the project root."
        echo ""
        echo "Migration needed. I will guide you through it."
        echo ""
        
        read -p "Start migration? [y/N] " -r CONFIRM
        if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
            echo "Aborted. You can run this script again anytime."
            exit 0
        fi
        echo ""
        
        # 从 GitHub 下载 migrate-legacy.sh
        MIGRATE_URL="https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/migrate-legacy.sh"
        MIGRATE_SCRIPT=$(mktemp /tmp/mh-migrate-legacy.XXXXXX.sh)
        
        echo "Downloading migration script..."
        if command -v curl &>/dev/null; then
            curl -sSL "$MIGRATE_URL" -o "$MIGRATE_SCRIPT"
        elif command -v wget &>/dev/null; then
            wget -q "$MIGRATE_URL" -O "$MIGRATE_SCRIPT"
        else
            echo -e "${RED}ERROR: curl or wget required.${RESET}"
            exit 1
        fi
        
        bash "$MIGRATE_SCRIPT"
        rm -f "$MIGRATE_SCRIPT"
        ;;
        
    C)
        echo -e "${YELLOW}Detected: old copy-paste (framework files in .meta-harness/)${RESET}"
        echo "This project was installed the old way — framework files are inside .meta-harness/."
        echo ""
        echo "Migration needed. I will guide you through it."
        echo ""
        
        read -p "Start migration? [y/N] " -r CONFIRM
        if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
            echo "Aborted. You can run this script again anytime."
            exit 0
        fi
        echo ""
        
        MIGRATE_URL="https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/migrate-legacy.sh"
        MIGRATE_SCRIPT=$(mktemp /tmp/mh-migrate-legacy.XXXXXX.sh)
        
        echo "Downloading migration script..."
        if command -v curl &>/dev/null; then
            curl -sSL "$MIGRATE_URL" -o "$MIGRATE_SCRIPT"
        elif command -v wget &>/dev/null; then
            wget -q "$MIGRATE_URL" -O "$MIGRATE_SCRIPT"
        else
            echo -e "${RED}ERROR: curl or wget required.${RESET}"
            exit 1
        fi
        
        bash "$MIGRATE_SCRIPT"
        rm -f "$MIGRATE_SCRIPT"
        ;;
        
    D)
        echo -e "${YELLOW}Detected: no meta-harness installation${RESET}"
        echo ""
        echo "To install meta-harness in this project:"
        echo ""
        echo "  1. Add as submodule (auto-detects SSH vs HTTPS):"
        echo "     git submodule add <ssh-or-https-url> meta-harness"
        echo ""
        echo "  2. Run init script:"
        echo "     bash meta-harness/scripts/init-harness-submodule.sh"
        echo ""
        echo "Or use the one-liner (auto-detects protocol):"
        echo "  bash <(curl -sSL https://raw.githubusercontent.com/eeyzs1/meta_harness/main/scripts/install.sh)"
        echo ""
        read -p "Install now? [y/N] " -r CONFIRM
        if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
            echo "Aborted."
            exit 0
        fi
        echo ""

        MH_REPO_URL=$(detect_mh_repo_url) || exit 1
        echo ""
        
        echo "Adding submodule..."
        git submodule add "$MH_REPO_URL" meta-harness
        echo ""
        
        echo "Initializing..."
        bash meta-harness/scripts/init-harness-submodule.sh
        ;;
esac

echo ""
echo -e "${GREEN}${BOLD}=== Done ===${RESET}"
echo ""
echo "Next time an AI agent works on this project, it will auto-check for updates."