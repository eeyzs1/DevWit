#!/usr/bin/env bash
# migrate.sh — project.yaml schema 迁移脚本
# 用法：bash migrate.sh <path-to-project.yaml>
#
# 框架更新时，project.yaml 的 schema 可能变化（新增字段、废弃字段）。
# 此脚本检测 schema 版本并自动迁移，不破坏用户已有配置。

set -euo pipefail

PROJECT_YAML="${1:-.meta-harness/project.yaml}"

if [ ! -f "$PROJECT_YAML" ]; then
  echo "ERROR: $PROJECT_YAML not found" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MH_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# schema 版本与框架版本解耦：project.yaml 结构版本独立追踪，仅在 breaking change 时递增
TARGET_SCHEMA="2.0"

echo "=== project.yaml Migration ==="
echo ""

# 检测 project.yaml 的当前 schema 版本
# 检查 project.yaml 中是否有 schema_version 字段
SCHEMA_VERSION=$(grep -m1 'schema_version' "$PROJECT_YAML" 2>/dev/null | awk '{print $2}' | tr -d '"' || echo "")

if [ -z "$SCHEMA_VERSION" ]; then
  # 没有 schema_version → 旧版（v1.x），需要迁移
  SCHEMA_VERSION="1.0.0"
  echo "Detected schema: $SCHEMA_VERSION (legacy, no schema_version field)"
else
  echo "Detected schema: $SCHEMA_VERSION"
fi

echo "Target schema:  $TARGET_SCHEMA"
echo ""

# === 迁移规则 ===
# 每个规则：{from_version, to_version, description, action}

NEEDS_MIGRATION=false

# --- v1.0.0 → v2.0.0 ---
if [ "$SCHEMA_VERSION" = "1.0.0" ]; then
  echo "--- Migrating 1.0.0 → 2.0.0 ---"
  
  MIGRATIONS=()
  
  # 检查缺失的字段
  if ! grep -q "run_mode" "$PROJECT_YAML" 2>/dev/null; then
    MIGRATIONS+=("run_mode: fast|full|deep")
    NEEDS_MIGRATION=true
  fi
  
  if ! grep -q "schema_version" "$PROJECT_YAML" 2>/dev/null; then
    MIGRATIONS+=("schema_version: $TARGET_SCHEMA")
    NEEDS_MIGRATION=true
  fi
  
  if ! grep -q "phase_skills" "$PROJECT_YAML" 2>/dev/null; then
    # 添加默认 phase_skills 映射
    cat >> "$PROJECT_YAML" <<'PHASE_SKILLS'

# === 技能-Phase 映射 === (migrated from template)
phase_skills:
  plan:
    - brainstorming
    - writing-plans
  implement:
    - tdd
    - subagent-driven-dev
    - executing-plans
  test:
    - code-review
    - verification
    - systematic-debugging
  post-audit:
    - finishing-a-development-branch

cross_phase_skills:
  - dispatching-parallel-agents
PHASE_SKILLS
    MIGRATIONS+=("phase_skills: defaults added")
    NEEDS_MIGRATION=true
  fi
  
  # 添加 schema_version（在 project 块之后）
  if ! grep -q "schema_version" "$PROJECT_YAML" 2>/dev/null; then
    # 在 project.name 之后插入
    sed -i '/^project:/,/^[a-z]/{
      /^  name:/a\  schema_version: "'"$TARGET_SCHEMA"'"
    }' "$PROJECT_YAML" 2>/dev/null || true
  fi
  
  # 添加 run_mode（在 evidence 块之后）
  if ! grep -q "run_mode" "$PROJECT_YAML" 2>/dev/null; then
    echo "" >> "$PROJECT_YAML"
    echo "# === 运行模式 === (migrated)" >> "$PROJECT_YAML"
    echo "run_mode: \"full\"  # fast | full | deep" >> "$PROJECT_YAML"
  fi
  
  for m in "${MIGRATIONS[@]}"; do
    echo "  + $m"
  done
  echo ""
fi

# --- 未来的迁移在此添加 ---
# if [ "$SCHEMA_VERSION" = "2.0.0" ]; then
#   echo "--- Migrating 2.0.0 → 2.1.0 ---"
#   ...
# fi

if [ "$NEEDS_MIGRATION" = true ]; then
  echo "Migration complete. Review $PROJECT_YAML for accuracy."
else
  echo "Already at target schema. No migration needed."
fi