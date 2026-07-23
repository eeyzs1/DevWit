#!/usr/bin/env bash
# detect-stack.sh — 检测项目技术栈
# 用法: detect-stack.sh [repo_path]
# 输出: 技术栈、包管理器、构建/测试/lint 命令

set -euo pipefail

REPO_PATH="${1:-.}"
cd "$REPO_PATH"

echo "=== Stack Detection ==="

# 检测语言和包管理器
if [ -f "package.json" ]; then
    echo "Language: typescript/javascript"
    if [ -f "pnpm-lock.yaml" ]; then
        echo "Package manager: pnpm"
        PM="pnpm"
    elif [ -f "yarn.lock" ]; then
        echo "Package manager: yarn"
        PM="yarn"
    elif [ -f "bun.lockb" ]; then
        echo "Package manager: bun"
        PM="bun"
    else
        echo "Package manager: npm"
        PM="npm"
    fi

    # 检测框架
    if grep -q '"next"' package.json 2>/dev/null; then
        echo "Framework: Next.js"
    elif grep -q '"react"' package.json 2>/dev/null; then
        echo "Framework: React"
    elif grep -q '"vue"' package.json 2>/dev/null; then
        echo "Framework: Vue"
    elif grep -q '"express"' package.json 2>/dev/null; then
        echo "Framework: Express"
    elif grep -q '"fastify"' package.json 2>/dev/null; then
        echo "Framework: Fastify"
    fi

    # 检测测试框架
    if grep -q '"jest"' package.json 2>/dev/null; then
        echo "Test framework: Jest"
    elif grep -q '"vitest"' package.json 2>/dev/null; then
        echo "Test framework: Vitest"
    elif grep -q '"mocha"' package.json 2>/dev/null; then
        echo "Test framework: Mocha"
    fi

elif [ -f "requirements.txt" ] || [ -f "pyproject.toml" ] || [ -f "setup.py" ]; then
    echo "Language: python"
    if [ -f "pyproject.toml" ]; then
        echo "Package manager: pip/poetry"
    else
        echo "Package manager: pip"
    fi

    if grep -q 'pytest' requirements.txt 2>/dev/null || grep -q 'pytest' pyproject.toml 2>/dev/null; then
        echo "Test framework: pytest"
    elif grep -q 'unittest' requirements.txt 2>/dev/null; then
        echo "Test framework: unittest"
    fi

elif [ -f "go.mod" ]; then
    echo "Language: go"
    echo "Package manager: go modules"
    echo "Test framework: go test"

elif [ -f "pom.xml" ]; then
    echo "Language: java"
    echo "Package manager: maven"
    echo "Test framework: JUnit"

elif [ -f "Cargo.toml" ]; then
    echo "Language: rust"
    echo "Package manager: cargo"
    echo "Test framework: cargo test"

elif [ -f "Package.swift" ]; then
    echo "Language: swift"
    echo "Package manager: swift package manager"
    echo "Test framework: XCTest"

else
    echo "Language: unknown"
    echo "Package manager: unknown"
fi

echo "=== Detection Complete ==="