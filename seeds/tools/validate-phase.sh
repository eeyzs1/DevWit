#!/usr/bin/env bash
# validate-phase.sh — 验证 Phase spec 结构完整性
# 用法: validate-phase.sh <phase-spec-file>
# 退出码: 0 = 有效, 1 = 发现问题

set -euo pipefail

SPEC_FILE="${1:-}"
if [ -z "$SPEC_FILE" ]; then
  echo "Usage: validate-phase.sh <phase-spec-file>"
  exit 1
fi

if [ ! -f "$SPEC_FILE" ]; then
  echo "ERROR: $SPEC_FILE not found"
  exit 1
fi

ERRORS=()
WARNINGS=()

# 检查必需标记: PHASE_START 块
if ! grep -q 'PHASE_START' "$SPEC_FILE"; then
  ERRORS+=("Missing PHASE_START marker")
fi

# 检查必需段落
for section in "Work" "Acceptance criteria" "Mandatory commands" "Evidence required"; do
  if ! grep -qi "$section" "$SPEC_FILE"; then
    ERRORS+=("Missing required section: $section")
  done
done

# 健全性检查: 至少 3 个要点（验收标准可能太薄）
bullet_count=$(grep -cE '^\s*[-*]' "$SPEC_FILE" || true)
if [ "$bullet_count" -lt 3 ]; then
  WARNINGS+=("Only $bullet_count bullet points found — acceptance criteria may be too thin")
fi

# 报告
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "VALIDATION FAILED"
  for e in "${ERRORS[@]}"; do
    echo "  ✗ $e"
  done
  for w in "${WARNINGS[@]}"; do
    echo "  ⚠ $w"
  done
  exit 1
fi

line_count=$(wc -l < "$SPEC_FILE")
echo "structure ok ($line_count lines, $bullet_count bullets)"
for w in "${WARNINGS[@]}"; do
  echo "  ⚠ $w"
done
exit 0