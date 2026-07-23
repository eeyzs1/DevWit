#!/usr/bin/env python3
"""
Leaf Protocol — task.json / result.json 契约（domain-agnostic 通用原语）

参考 autodev 的 leaf-protocol.md，定义 leaf helper（有界子任务 agent）的输入输出契约。

为什么需要 leaf 协议：
  - leaf helper 是底层 agent（explorer/worker/tester/reviewer），不直接读 session-state
  - 通过 task.json 把"做什么 / 边界 / 期望输出"塞给 leaf，让它独立工作
  - 通过 result.json 把"做了什么 / 证据 / 改了哪些文件"返回给 dispatcher
  - 协议是 IDE 中性的：adapter（Codex/Cursor/Claude）只负责把 task.json 喂给 agent + 收 result.json

task.json schema：
  {
    "role": "explorer",           # leaf role（来自 agent-protocol.yaml 的 role 枚举）
    "gate": "pre-implement",      # 触发此 leaf 的 gate（PLAN/IMPLEMENT/TEST/DEPLOY/REPORT）
    "objective": "Identify all files needing change for AC2",
    "scope": {
      "workitem_id": "CCTT-123",
      "branch": "feature/cctt-123",
      "worktree_path": "/abs/path",
      "allowed_files": ["src/api/orders.py", "src/middleware/..."],
      "forbidden_files": ["audit_log.yaml", "secrets.env"]
    },
    "constraints": {
      "forbidden_side_effects": ["write to audit_log", "ALTER TABLE", "DROP TABLE"],
      "max_context_lines": 5000,
      "timeout_seconds": 600
    },
    "expected_output": {
      "format": "result.json",
      "required_fields": ["verdict", "findings", "evidence", "changed_files"]
    },
    "task_card_ref": "dispatch-plan.yaml#WU001.task_card"  # 指回 dispatcher 的 task card
  }

result.json schema：
  {
    "verdict": "pass|fail|blocked|deferred",
    "findings": [...],            # 结构化发现（role 特定）
    "evidence": [...],            # 证据清单（文件路径 + sha256 + 行范围）
    "changed_files": [...],       # 改动文件列表（路径 + 行数变化）
    "next_required_action": "human_review|auto_retry|escalate|continue",
    "error": {                    # verdict != pass 时必填
      "type": "...",
      "message": "...",
      "retry_strategy": "..."
    }
  }

退出码：0=ok（不论 verdict）；1=协议违规（schema 不对）

Usage:
  # 写 task.json
  python runtime/leaf_protocol.py write-task --out task.json --role explorer ...

  # 校验 result.json
  python runtime/leaf_protocol.py validate-result --result result.json
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# ============================================================================
# Schema（用于校验 + 文档）
# ============================================================================

TASK_REQUIRED_FIELDS = {"role", "gate", "objective", "scope", "expected_output"}
RESULT_REQUIRED_FIELDS = {"verdict", "changed_files"}
VERDICT_VALUES = {"pass", "fail", "blocked", "deferred"}
NEXT_ACTION_VALUES = {"human_review", "auto_retry", "escalate", "continue"}


def validate_task(task: dict) -> list:
    """校验 task.json schema。返回错误列表（空 = ok）。"""
    errs = []
    if not isinstance(task, dict):
        return ["task is not a dict"]
    missing = TASK_REQUIRED_FIELDS - task.keys()
    if missing:
        errs.append(f"missing required fields: {missing}")
    scope = task.get("scope", {})
    if not isinstance(scope, dict):
        errs.append("scope must be a dict")
    else:
        if "workitem_id" not in scope:
            errs.append("scope.workitem_id missing")
        if "allowed_files" not in scope:
            errs.append("scope.allowed_files missing (can be empty list)")
    return errs


def validate_result(result: dict) -> list:
    """校验 result.json schema。返回错误列表（空 = ok）。"""
    errs = []
    if not isinstance(result, dict):
        return ["result is not a dict"]
    missing = RESULT_REQUIRED_FIELDS - result.keys()
    if missing:
        errs.append(f"missing required fields: {missing}")
    verdict = result.get("verdict")
    if verdict not in VERDICT_VALUES:
        errs.append(f"verdict must be one of {VERDICT_VALUES}, got: {verdict!r}")
    if verdict != "pass":
        if "error" not in result or not result.get("error"):
            errs.append(f"verdict={verdict} requires non-empty 'error' field")
    nra = result.get("next_required_action")
    if nra and nra not in NEXT_ACTION_VALUES:
        errs.append(f"next_required_action must be one of {NEXT_ACTION_VALUES}, got: {nra!r}")
    return errs


# ============================================================================
# 读写工具
# ============================================================================

def write_task(out_path: Path, **fields: Any) -> dict:
    """写 task.json。补默认值 + 校验。"""
    task = {
        "role": fields.get("role"),
        "gate": fields.get("gate"),
        "objective": fields.get("objective"),
        "scope": fields.get("scope", {}),
        "constraints": fields.get("constraints", {}),
        "expected_output": fields.get("expected_output", {
            "format": "result.json",
            "required_fields": list(RESULT_REQUIRED_FIELDS),
        }),
        "task_card_ref": fields.get("task_card_ref"),
    }
    errs = validate_task(task)
    if errs:
        raise ValueError(f"invalid task: {errs}")
    out_path.write_text(json.dumps(task, indent=2, ensure_ascii=False), encoding="utf-8")
    return task


def read_result(path: Path) -> dict:
    """读 result.json + 校验。"""
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return {"_parse_error": str(e), "_path": str(path)}
    errs = validate_result(result)
    if errs:
        return {"_schema_errors": errs, "_raw": result}
    return result


# ============================================================================
# CLI
# ============================================================================

def main():
    ap = argparse.ArgumentParser(description="Leaf protocol (task.json/result.json contract)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_w = sub.add_parser("write-task", help="Write task.json")
    p_w.add_argument("--out", required=True)
    p_w.add_argument("--role", required=True)
    p_w.add_argument("--gate", required=True)
    p_w.add_argument("--objective", required=True)
    p_w.add_argument("--workitem-id", required=True)
    p_w.add_argument("--branch", required=True)
    p_w.add_argument("--worktree-path", required=True)
    p_w.add_argument("--allowed-files", nargs="*", default=[])
    p_w.add_argument("--forbidden-files", nargs="*", default=[])
    p_w.add_argument("--forbidden-side-effects", nargs="*", default=[])
    p_w.add_argument("--max-context-lines", type=int, default=5000)
    p_w.add_argument("--timeout-seconds", type=int, default=600)
    p_w.add_argument("--task-card-ref", default=None)

    p_v = sub.add_parser("validate-result", help="Validate result.json")
    p_v.add_argument("--result", required=True)

    args = ap.parse_args()
    if args.cmd == "write-task":
        task = write_task(
            Path(args.out), role=args.role, gate=args.gate, objective=args.objective,
            scope={
                "workitem_id": args.workitem_id,
                "branch": args.branch,
                "worktree_path": args.worktree_path,
                "allowed_files": args.allowed_files,
                "forbidden_files": args.forbidden_files,
            },
            constraints={
                "forbidden_side_effects": args.forbidden_side_effects,
                "max_context_lines": args.max_context_lines,
                "timeout_seconds": args.timeout_seconds,
            },
            task_card_ref=args.task_card_ref,
        )
        print(yaml.dump(task, default_flow_style=False, allow_unicode=True))
    elif args.cmd == "validate-result":
        result = read_result(Path(args.result))
        if "_parse_error" in result or "_schema_errors" in result:
            print(f"INVALID: {result}")
            sys.exit(1)
        print(f"VALID: verdict={result.get('verdict')}, "
              f"changed_files={len(result.get('changed_files', []))}")


if __name__ == "__main__":
    main()
