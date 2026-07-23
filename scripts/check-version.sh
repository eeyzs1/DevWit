#!/usr/bin/env bash
# check-version.sh — Linux/Mac 入口（调用 check-version.py）
# 版本检查逻辑由 Python 实现（跨平台）
# 用法：bash scripts/check-version.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python "$SCRIPT_DIR/check-version.py"
