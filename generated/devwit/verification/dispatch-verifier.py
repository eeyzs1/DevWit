#!/usr/bin/env python3
"""
Dispatch Verifier v1: 校验 dispatch-plan + dispatch-results 的一致性与真实性。

第一性原理分工：
- "subagent 自报 status=completed 是否真实" 是硬约束问题 → 本脚本（meta harness 自己）
- "task card input 是什么" 是 dispatcher.py 生成的（硬约束）
- "task card output 是什么" 是 subagent 写的（runtime 层）

校验项：
1. 每个 input task_card 都有对应 output card 文件（除非显式 pending）
2. output.status ∈ {completed, blocked, failed, needs_human_review}
3. 若 input.requires_human_review=true 且 output.status=completed → 错误（必须 needs_human_review）
4. output.self_check_evidence 每条 passed=true（否则 status 应该不是 completed）
5. output.self_check_evidence 覆盖 input.success_criteria 每一条
6. output.artifacts[].sha256 与实际文件 sha256 一致（防篡改）
7. output.task_id 与 input.task_id 对账

退出码：0=PASS，1=FAIL，2=NO_RESULTS_YET（dispatch-results/ 不存在或为空——
        表示 subagent 还没运行，不算错误）

Usage:
    python verification/dispatch-verifier.py --project-root <generated-project>
    python verification/dispatch-verifier.py --project-root generated/my-project --strict
"""

import argparse
import hashlib
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_yaml(path: Path):
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_card(input_card: dict, output_card: dict, project_root: Path,
                errors: list, warnings: list):
    """校验单张 task card 的 input↔output 一致性。"""
    tid = input_card.get("task_id", "?")

    # 1. task_id 对账
    if output_card.get("task_id") != tid:
        errors.append(f"  {tid}: output.task_id mismatch "
                      f"(expected {tid}, got {output_card.get('task_id')})")
        return

    # 2. status enum
    status = output_card.get("status")
    valid_statuses = {"completed", "blocked", "failed", "needs_human_review"}
    if status not in valid_statuses:
        errors.append(f"  {tid}: invalid status '{status}', must be one of {valid_statuses}")
        return

    # 3. requires_human_review gate
    if input_card.get("requires_human_review") and status == "completed":
        errors.append(
            f"  {tid}: input.requires_human_review=true but output.status=completed — "
            f"runtime must pause for human review, subagent cannot self-declare completed"
        )

    # 4. self_check_evidence passed consistency
    evidence = output_card.get("self_check_evidence") or []
    if status == "completed":
        for ev in evidence:
            if not ev.get("passed"):
                errors.append(
                    f"  {tid}: status=completed but self_check_evidence "
                    f"'{ev.get('criterion','?')}' passed={ev.get('passed')} — "
                    f"cannot declare completed with failing evidence"
                )

    # 5. success_criteria coverage
    expected_criteria = set(input_card.get("success_criteria") or [])
    actual_criteria = {ev.get("criterion") for ev in evidence if ev.get("criterion")}
    missing = expected_criteria - actual_criteria
    if missing and status == "completed":
        errors.append(
            f"  {tid}: status=completed but missing self_check_evidence for criteria: "
            f"{sorted(missing)}"
        )

    # 6. artifacts sha256 verify（防篡改）
    artifacts = output_card.get("artifacts") or []
    for art in artifacts:
        path_str = art.get("path")
        claimed_sha = art.get("sha256")
        if not path_str or not claimed_sha:
            warnings.append(f"  {tid}: artifact missing path or sha256: {art}")
            continue
        # 相对路径解析（相对 project_root）
        artifact_path = (project_root / path_str) if not Path(path_str).is_absolute() else Path(path_str)
        if not artifact_path.exists():
            errors.append(f"  {tid}: artifact file not found: {path_str}")
            continue
        actual_sha = file_sha256(artifact_path)
        if actual_sha != claimed_sha:
            errors.append(
                f"  {tid}: artifact sha256 mismatch for {path_str}: "
                f"claimed={claimed_sha[:16]}... actual={actual_sha[:16]}... — "
                f"file may have been tampered after subagent declaration"
            )

    # 7. status=needs_human_review 时检查是否真的有暂停记录
    if status == "needs_human_review":
        review_record = output_card.get("human_review_record") or {}
        if not review_record.get("reviewer"):
            warnings.append(
                f"  {tid}: status=needs_human_review but no reviewer recorded — "
                f"runtime must capture human reviewer identity"
            )


def main():
    parser = argparse.ArgumentParser(description="Dispatch Verifier")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--strict", action="store_true",
                        help="Treat warnings as errors (CI mode)")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    plan_file = project_root / "planning" / "dispatch-plan.yaml"
    results_dir = project_root / "planning" / "dispatch-results"

    if not plan_file.exists():
        print(f"ERROR: dispatch-plan.yaml not found at {plan_file}")
        print("       Run dispatcher.py first to generate the plan.")
        sys.exit(1)

    plan = load_yaml(plan_file) or {}
    input_cards = plan.get("task_cards") or []

    if not input_cards:
        print("ERROR: dispatch-plan.yaml has no task_cards")
        sys.exit(1)

    print(f"Dispatch plan: {len(input_cards)} task cards")
    print(f"Results dir:   {results_dir}")
    print()

    if not results_dir.exists() or not any(results_dir.iterdir()):
        print(f"NO_RESULTS_YET: dispatch-results/ is empty or missing")
        print(f"                This means subagents have not run yet.")
        print(f"                Run dispatcher.py output cards as subagents complete.")
        sys.exit(2)

    errors = []
    warnings = []
    completed = 0
    pending = 0
    needs_review = 0
    failed = 0
    blocked = 0

    for input_card in input_cards:
        tid = input_card.get("task_id", "?")
        output_file = results_dir / f"{tid}.yaml"
        output_card = load_yaml(output_file)
        if output_card is None:
            pending += 1
            print(f"  PENDING  {tid}  (no output card yet)")
            continue
        status = output_card.get("status", "?")
        if status == "completed":
            completed += 1
        elif status == "needs_human_review":
            needs_review += 1
        elif status == "failed":
            failed += 1
        elif status == "blocked":
            blocked += 1
        verify_card(input_card, output_card, project_root, errors, warnings)
        marker = "PASS" if not errors else "FAIL"
        print(f"  {marker}    {tid}  status={status}")

    print()
    print("=" * 60)
    print("DISPATCH VERIFICATION REPORT")
    print("=" * 60)
    print(f"  Total task cards:  {len(input_cards)}")
    print(f"  Completed:          {completed}")
    print(f"  Needs human review: {needs_review}")
    print(f"  Pending (no output): {pending}")
    print(f"  Failed:             {failed}")
    print(f"  Blocked:            {blocked}")
    print(f"  Errors:             {len(errors)}")
    print(f"  Warnings:           {len(warnings)}")
    print()

    if errors:
        print("--- ERRORS ---")
        for e in errors:
            print(e)
        print()

    if warnings:
        print("--- WARNINGS ---")
        for w in warnings:
            print(w)
        print()

    if pending > 0:
        print(f"NOTE: {pending} task cards still pending (subagents not finished)")
        print("      Re-run dispatch-verifier.py after subagents complete.")
        print()

    if errors or (args.strict and warnings):
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
