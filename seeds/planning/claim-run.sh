#!/usr/bin/env bash
# claim-run.sh — 原子声明运行命名空间
# 吸收自：union 框架 scripts/claim-run.sh
# 用法：bash claim-run.sh
# 输出：RUN_ID（如 "add-login-Ab3Kx9"）和 RUN_ROOT 路径

set -euo pipefail

RUNS_DIR=".meta-harness/runs"

# 确保 runs 目录存在
mkdir -p "$RUNS_DIR"

# 生成唯一的 run ID：基于时间戳 + 随机后缀
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RANDOM_SUFFIX=$(cat /dev/urandom 2>/dev/null | tr -dc 'a-zA-Z0-9' | head -c6 || echo "$RANDOM")
RUN_ID="${TIMESTAMP}-${RANDOM_SUFFIX}"
RUN_ROOT="$RUNS_DIR/$RUN_ID"

# 原子创建目录
if ! mkdir "$RUN_ROOT" 2>/dev/null; then
  echo "ERROR: Could not create run directory $RUN_ROOT" >&2
  exit 1
fi

# 创建子目录
mkdir -p "$RUN_ROOT/phases"

# 检查其他活跃运行
ACTIVE_RUNS=$(find "$RUNS_DIR" -maxdepth 2 -name "STATE.md" 2>/dev/null | while read -r f; do
  STATUS=$(grep -m1 '^Status:' "$f" 2>/dev/null | awk '{print $2}' || echo "")
  if [ "$STATUS" = "IN_PROGRESS" ] || [ "$STATUS" = "READY" ]; then
    dirname "$(dirname "$f")"
  fi
done)

# 过滤掉当前 run
ACTIVE_RUNS=$(echo "$ACTIVE_RUNS" | grep -v "$RUN_ID" || true)

if [ -n "$ACTIVE_RUNS" ]; then
  echo "⚠ Another Meta-Harness run is active in this working tree:" >&2
  echo "$ACTIVE_RUNS" | while read -r r; do echo "  - $r" >&2; done
  echo "Namespacing protects the plan, not the build. Two simultaneous runs in the same working tree will clobber each other's code." >&2
  echo "For true parallel execution, use separate git worktrees." >&2
  echo ""
fi

# 输出 run ID 和 root 路径
echo "RUN_ID=$RUN_ID"
echo "RUN_ROOT=$RUN_ROOT"