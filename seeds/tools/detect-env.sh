#!/usr/bin/env bash
# detect-env.sh — 检测开发环境信息
# 用法: detect-env.sh
# 输出: 操作系统、可用工具、Git 状态

set -euo pipefail

echo "=== Environment Detection ==="

# OS
echo "OS: $(uname -s)"
echo "Architecture: $(uname -m)"

# Shell
echo "Shell: ${SHELL:-unknown}"

# Git
if command -v git &> /dev/null; then
    echo "Git: $(git --version | head -1)"
    if git rev-parse --git-dir &> /dev/null 2>&1; then
        echo "Git repo: yes"
        echo "Current branch: $(git branch --show-current 2>/dev/null || echo 'detached')"
        echo "Latest commit: $(git log -1 --format='%h %s' 2>/dev/null || echo 'none')"
    else
        echo "Git repo: no"
    fi
else
    echo "Git: not found"
fi

# Node.js
if command -v node &> /dev/null; then
    echo "Node.js: $(node --version)"
else
    echo "Node.js: not found"
fi

# Python
if command -v python3 &> /dev/null; then
    echo "Python: $(python3 --version)"
elif command -v python &> /dev/null; then
    echo "Python: $(python --version)"
else
    echo "Python: not found"
fi

# Go
if command -v go &> /dev/null; then
    echo "Go: $(go version)"
else
    echo "Go: not found"
fi

# Docker
if command -v docker &> /dev/null; then
    echo "Docker: $(docker --version)"
else
    echo "Docker: not found"
fi

# Available package managers
for pm in npm pnpm yarn bun pip pip3 poetry cargo go mvn gradle; do
    if command -v "$pm" &> /dev/null; then
        echo "Package manager: $pm ($($pm --version 2>/dev/null || echo 'unknown'))"
    fi
done

echo "=== Detection Complete ==="