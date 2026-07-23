#!/usr/bin/env bash
# repo-state.sh — 检查仓库状态（对比 baseline ref）
# 用法: repo-state.sh deliverable <baseline-ref> "<path>"
#       repo-state.sh cleanliness <baseline-ref>
# 退出码: 0 = 存在/干净, 1 = 缺失/有新增

set -euo pipefail

MODE="${1:-}"
BASELINE="${2:-HEAD}"

case "$MODE" in
  deliverable)
    TARGET="${3:-}"
    if [ -z "$TARGET" ]; then
      echo "Usage: repo-state.sh deliverable <baseline-ref> <path>"
      exit 1
    fi

    # 检查完整工作树（committed + staged + unstaged + untracked）
    if [ -e "$TARGET" ]; then
      # 检查是否相对于 baseline 有变更
      if git diff --name-only "$BASELINE" -- "$TARGET" 2>/dev/null | grep -q .; then
        echo "present — changed vs baseline"
      elif git ls-files --others --exclude-standard "$TARGET" 2>/dev/null | grep -q .; then
        echo "present — untracked new file"
      else
        echo "present — unchanged from baseline"
      fi
      exit 0
    else
      echo "missing"
      exit 1
    fi
    ;;

  cleanliness)
    echo "=== Cleanliness Check (vs $BASELINE) ==="

    # Debug prints (新增行中的 console.log / print / fmt.Println)
    added_debug=$(git diff "$BASELINE" -- . | grep -cE '^\+\s*(console\.log|console\.error|print\(|fmt\.Println|System\.out\.println)' || true)
    echo "debug prints added: $added_debug"

    # Session TODO/FIXME (新增行中)
    added_todos=$(git diff "$BASELINE" -- . | grep -cE '^\+\s*.*\b(TODO|FIXME|XXX|HACK)\b' || true)
    echo "session TODO/FIXME added: $added_todos"

    # Dead imports (新增的 import 语句)
    added_imports=$(git diff "$BASELINE" -- . | grep -cE '^\+\s*(import|from)\s' || true)
    echo "new imports added: $added_imports"

    # Files changed
    changed_files=$(git diff --name-only "$BASELINE" -- . | wc -l)
    echo "files changed: $changed_files"

    if [ "$added_debug" -gt 0 ] || [ "$added_todos" -gt 0 ]; then
      echo "cleanliness: WARNING — non-zero debug/TODO counts"
      exit 1
    else
      echo "cleanliness: CLEAN"
      exit 0
    fi
    ;;

  *)
    echo "Usage: repo-state.sh <deliverable|cleanliness> <baseline-ref> [path]"
    exit 1
    ;;
esac