#!/usr/bin/env python3
"""
JUDGE phase: Evaluate whether evidence proves acceptance criteria are satisfied.

Reads a generated harness project's task.yaml and memory/session-state.yaml,
optionally runs orchestrator.py --verify, and emits a PROVEN/NOT_PROVEN verdict
per criterion and overall. Writes a structured judgment report to
memory/judgment-report.yaml (unless --dry-run).

Usage:
    python scripts/judge.py --project-root <generated-project-dir>
    python scripts/judge.py --project-root <dir> --run-verify   # run verification first
    python scripts/judge.py --project-root <dir> --dry-run      # report without writing
"""

import argparse
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_yaml(path: Path) -> dict:
    """Load a YAML file, returning {} if missing or empty."""
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def is_criterion_completed(criterion: str, completed_criteria: list) -> bool:
    """Check if a criterion is in the completed list using string containment.

    Mirrors orchestrator.py's mark_complete matching logic, which accepts a
    match when either string contains the other. This tolerates minor textual
    variation between the task definition and the recorded completion entry.
    """
    for completed in completed_criteria:
        if not isinstance(completed, str):
            continue
        if criterion in completed or completed in criterion:
            return True
    return False


def run_verification(project_root: Path) -> tuple:
    """Run orchestrator.py --verify as a subprocess.

    Returns (passed: bool, output: str). If orchestrator.py is missing or the
    subprocess cannot be launched, returns (False, error_message).
    """
    orchestrator = project_root / "orchestrator.py"
    if not orchestrator.exists():
        return False, "orchestrator.py not found in project root"

    try:
        proc = subprocess.run(
            [sys.executable, str(orchestrator), "--verify"],
            capture_output=True,
            text=True,
            cwd=str(project_root),
            encoding="utf-8",
            errors="replace",
        )
    except Exception as exc:
        return False, f"Failed to run orchestrator.py --verify: {exc}"

    output = (proc.stdout or "") + (proc.stderr or "")

    # orchestrator.py prints these markers on success/failure.
    if "ALL VERIFICATIONS PASSED" in output:
        return True, output
    if "SOME VERIFICATIONS FAILED" in output:
        return False, output

    # Fall back to exit code if the textual markers are absent.
    return proc.returncode == 0, output


def judge_criteria(task: dict, state: dict, verification_run: bool, verification_passed) -> list:
    """Judge each acceptance criterion from task.yaml.

    Returns a list of dicts with keys: criterion, verdict, evidence.
    Verdicts:
      - PROVEN: in completed_criteria AND (verification passed OR not run)
      - INSUFFICIENT_EVIDENCE: in completed_criteria but verification failed
      - NOT_PROVEN: not in completed_criteria
    """
    criteria = task.get("acceptance_criteria", []) or []
    progress = state.get("progress", {}) or {}
    completed_criteria = progress.get("completed_criteria", []) or []

    results = []
    for criterion in criteria:
        if not isinstance(criterion, str):
            criterion = str(criterion)
        in_completed = is_criterion_completed(criterion, completed_criteria)

        if in_completed:
            if verification_run and not verification_passed:
                verdict = "INSUFFICIENT_EVIDENCE"
                evidence = "Found in completed_criteria but verification failed"
            else:
                verdict = "PROVEN"
                if verification_run:
                    evidence = "Found in completed_criteria and verification passed"
                else:
                    evidence = "Found in completed_criteria"
        else:
            verdict = "NOT_PROVEN"
            evidence = "Not found in completed_criteria"

        results.append({
            "criterion": criterion,
            "verdict": verdict,
            "evidence": evidence,
        })
    return results


def build_report(task: dict, results: list, verification_run: bool, verification_passed) -> dict:
    """Build the structured judgment report dict."""
    proven = sum(1 for r in results if r["verdict"] == "PROVEN")
    not_proven = sum(1 for r in results if r["verdict"] == "NOT_PROVEN")
    insufficient = sum(1 for r in results if r["verdict"] == "INSUFFICIENT_EVIDENCE")
    # Overall verdict is PROVEN only if there is at least one criterion and
    # every criterion is PROVEN.
    overall = "PROVEN" if (results and proven == len(results)) else "NOT_PROVEN"

    return {
        "verdict": overall,
        "timestamp": datetime.now().isoformat(),
        "project": task.get("name", "unknown"),
        "goal": task.get("goal", ""),
        "total_criteria": len(results),
        "proven": proven,
        "not_proven": not_proven,
        "insufficient_evidence": insufficient,
        "verification_run": verification_run,
        "verification_passed": verification_passed if verification_run else None,
        "criteria": results,
    }


def print_report(task: dict, results: list, verification_run: bool, verification_passed) -> None:
    """Print the human-readable verdict to stdout."""
    name = task.get("name", "unknown")
    goal = task.get("goal", "")
    proven = sum(1 for r in results if r["verdict"] == "PROVEN")
    overall = "PROVEN" if (results and proven == len(results)) else "NOT_PROVEN"

    if verification_run:
        verification_str = "PASSED" if verification_passed else "FAILED"
    else:
        verification_str = "NOT_RUN"

    print("=" * 60)
    print("JUDGE — Evidence Evaluation")
    print("=" * 60)
    print(f"  Project: {name}")
    print(f"  Goal: {goal}")
    print()
    for i, r in enumerate(results, 1):
        print(f"  Criterion {i}: {r['verdict']}")
        print(f"    → {r['criterion']}")
    print()
    print(f"  Verification: {verification_str}")
    print()
    print("=" * 60)
    print(f"  VERDICT: {overall}")
    print(f"  {proven}/{len(results)} criteria proven")
    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(description="JUDGE phase — evidence evaluation")
    parser.add_argument("--project-root", required=True, help="Path to a generated harness project")
    parser.add_argument("--run-verify", action="store_true", help="Run orchestrator.py --verify before judging")
    parser.add_argument("--dry-run", action="store_true", help="Print verdict without writing report file")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    if not project_root.exists() or not project_root.is_dir():
        print(f"ERROR: Project root not found or not a directory: {project_root}")
        sys.exit(2)

    task_file = project_root / "task.yaml"
    if not task_file.exists():
        print(f"ERROR: task.yaml not found in project root: {project_root}")
        sys.exit(2)

    task = load_yaml(task_file)
    if not task:
        print(f"ERROR: task.yaml is empty or invalid: {task_file}")
        sys.exit(2)

    # Missing session-state is not fatal — treat as fresh state with no
    # completed criteria (everything will be NOT_PROVEN).
    state_file = project_root / "memory" / "session-state.yaml"
    state = load_yaml(state_file)

    verification_run = args.run_verify
    verification_passed = None
    if verification_run:
        verification_passed, _ = run_verification(project_root)

    results = judge_criteria(task, state, verification_run, verification_passed)
    report = build_report(task, results, verification_run, verification_passed)
    print_report(task, results, verification_run, verification_passed)

    if not args.dry_run:
        report_path = project_root / "memory" / "judgment-report.yaml"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            yaml.dump(report, f, default_flow_style=False, allow_unicode=True)

    sys.exit(0 if report["verdict"] == "PROVEN" else 1)


if __name__ == "__main__":
    main()
