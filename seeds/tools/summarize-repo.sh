#!/usr/bin/env bash
# summarize-repo.sh — 生成仓库结构摘要
# 吸收自：union 框架的侦察阶段需求
# 用法：bash summarize-repo.sh [directory]
# 输出：目录结构、关键模块、风险区域

set -euo pipefail

TARGET="${1:-.}"

echo "=== Repository Summary ==="
echo "Directory: $(cd "$TARGET" && pwd)"
echo ""

# Git 信息
if [ -d "$TARGET/.git" ]; then
  echo "--- Git Info ---"
  echo "Branch: $(cd "$TARGET" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'N/A')"
  echo "Last commit: $(cd "$TARGET" && git log -1 --format='%h - %s (%cr)' 2>/dev/null || echo 'N/A')"
  echo "Total commits: $(cd "$TARGET" && git rev-list --count HEAD 2>/dev/null || echo 'N/A')"
  echo ""
fi

# 顶级目录结构
echo "--- Top-Level Structure ---"
if command -v tree &>/dev/null; then
  tree -L 2 -I 'node_modules|.git|__pycache__|*.pyc|dist|build|.next|coverage' "$TARGET" 2>/dev/null || ls -la "$TARGET"
else
  ls -la "$TARGET"
fi
echo ""

# 按扩展名统计文件
echo "--- File Count by Extension ---"
find "$TARGET" -type f \
  ! -path '*/node_modules/*' \
  ! -path '*/.git/*' \
  ! -path '*/__pycache__/*' \
  ! -path '*/dist/*' \
  ! -path '*/build/*' \
  ! -path '*/.next/*' \
  ! -path '*/coverage/*' \
  2>/dev/null | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -20
echo ""

# 关键模块识别
echo "--- Key Modules ---"
# 检测常见框架文件
if [ -f "$TARGET/package.json" ]; then echo "  - Node.js/TypeScript project (package.json)"; fi
if [ -f "$TARGET/tsconfig.json" ]; then echo "  - TypeScript configured"; fi
if [ -f "$TARGET/pyproject.toml" ] || [ -f "$TARGET/setup.py" ]; then echo "  - Python project"; fi
if [ -f "$TARGET/go.mod" ]; then echo "  - Go module"; fi
if [ -f "$TARGET/Cargo.toml" ]; then echo "  - Rust project"; fi
if [ -f "$TARGET/Dockerfile" ]; then echo "  - Docker container"; fi
if [ -f "$TARGET/docker-compose.yml" ] || [ -f "$TARGET/docker-compose.yaml" ]; then echo "  - Docker Compose"; fi
if [ -d "$TARGET/src" ]; then echo "  - Source directory: src/"; fi
if [ -d "$TARGET/tests" ] || [ -d "$TARGET/__tests__" ]; then echo "  - Test directory present"; fi
echo ""

# 风险区域
echo "--- Risk Areas ---"
# 检查大文件
LARGE_FILES=$(find "$TARGET" -type f -size +500k \
  ! -path '*/node_modules/*' ! -path '*/.git/*' \
  ! -name '*.png' ! -name '*.jpg' ! -name '*.svg' \
  ! -name '*.lock' ! -name '*.json' \
  2>/dev/null | head -5)
if [ -n "$LARGE_FILES" ]; then
  echo "⚠ Large files (>500KB):"
  echo "$LARGE_FILES" | while read -r f; do echo "  - $f"; done
fi

# 检查深度嵌套
DEEP_DIRS=$(find "$TARGET" -type d -path '*/*/*/*/*/*/*' \
  ! -path '*/node_modules/*' ! -path '*/.git/*' \
  2>/dev/null | head -5)
if [ -n "$DEEP_DIRS" ]; then
  echo "⚠ Deeply nested directories:"
  echo "$DEEP_DIRS" | while read -r d; do echo "  - $d"; done
fi

echo ""
echo "=== Summary Complete ==="