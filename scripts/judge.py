#!/usr/bin/env python3
"""
JUDGE phase: PROVEN requires REAL evidence (WP3 hybrid rework).

"Verify the world, not the self-report." The old judge trusted
memory/session-state.yaml's completed_criteria — a hand-written state file could
certify anything. Now:

  GATE 1 (mechanical): orchestrator.py --verify must run and PASS. No verify,
                       no verdict. (--no-verify opts out for inspection only.)
  GATE 2 (evidence):   the evidence ledger (memory/event-log.yaml) must contain
                       passed test/run or verify/run records. A criterion in
                       completed_criteria with NO ledger evidence is
                       INSUFFICIENT_EVIDENCE, never PROVEN.
  CONTRACT (semantic): if the agent produced memory/judgment-report.yaml (the
                       judge prompt contract), it is validated against the
                       schema AND every evidence_ref must be traceable to the
                       log/artifacts/files. Contract verdicts are authoritative;
                       a PROVEN without a traceable ref is demoted.

Usage:
    python scripts/judge.py --project-root <generated-project-dir>
    python scripts/judge.py --project-root <dir> --no-verify   # inspection only
    python scripts/judge.py --project-root <dir> --dry-run
"""

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import yaml

# Import the contract machinery (schema validation + evidence traceability).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_contract  # noqa: E402

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_yaml(path: Path):
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def run_verification(project_root: Path) -> tuple:
    """Really run orchestrator.py --verify; return (passed, output)."""
    orchestrator = project_root / "orchestrator.py"
    if not orchestrator.exists():
        return False, "orchestrator.py not found in project root"
    try:
        proc = subprocess.run([sys.executable, str(orchestrator), "--verify"],
                              capture_output=True, text=True, cwd=str(project_root),
                              encoding="utf-8", errors="replace")
    except Exception as exc:
        return False, f"Failed to run orchestrator.py --verify: {exc}"
    output = (proc.stdout or "") + (proc.stderr or "")
    if "ALL VERIFICATIONS PASSED" in output:
        return True, output
    if "SOME VERIFICATIONS FAILED" in output:
        return False, output
    return proc.returncode == 0, output


def load_ledger(project_root: Path) -> dict:
    """Fold memory/event-log.yaml into evidence lookups (verify/test/audit)."""
    log_file = project_root / "memory" / "event-log.yaml"
    if not log_file.exists():
        return {"verify": {}, "test": {}, "audit": {}, "artifacts": {}, "events": set()}
    with open(log_file, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    return validate_contract.collect_evidence(doc.get("events", []) or [])


def ledger_has_passing_evidence(ledger: dict) -> bool:
    return any(ledger["verify"].values()) or any(ledger["test"].values())


def judge_mechanical(task: dict, state: dict, ledger: dict) -> list:
    """Fallback judgment when no contract report exists.

    A criterion is PROVEN only when it is recorded completed AND the ledger
    contains passing verify/test evidence. Anything else is NOT_PROVEN or
    INSUFFICIENT_EVIDENCE.
    """
    criteria = task.get("acceptance_criteria", []) or []
    completed = (state.get("progress", {}) or {}).get("completed_criteria", []) or []
    has_evidence = ledger_has_passing_evidence(ledger)
    results = []
    for criterion in criteria:
        criterion = str(criterion)
        in_completed = any(c in criterion or criterion in c
                           for c in completed if isinstance(c, str))
        if in_completed and has_evidence:
            verdict = "PROVEN"
            evidence = "recorded completed AND ledger has passing verify/test evidence"
        elif in_completed:
            verdict = "INSUFFICIENT_EVIDENCE"
            evidence = "recorded completed but NO passing evidence in the ledger"
        else:
            verdict = "NOT_PROVEN"
            evidence = "not recorded as completed"
        results.append({"criterion": criterion, "verdict": verdict, "evidence": evidence})
    return results


def judge_contract(project_root: Path, ledger: dict) -> tuple:
    """Validate memory/judgment-report.yaml.

    Returns (output, ok) where ok is True (valid), or a message string
    (absent/invalid). Absent -> (None, 'absent') -> mechanical fallback.
    """
    report_path = project_root / "memory" / "judgment-report.yaml"
    if not report_path.exists():
        return None, "absent"
    schema_path = (Path(__file__).resolve().parent.parent / "meta" / "prompt-contracts"
                   / "judge" / "schema.yaml")
    errors = []
    try:
        schema = validate_contract.load_schema(schema_path)
        output = validate_contract.load_output(report_path)
    except ValueError as e:
        return None, f"invalid: {e}"
    validate_contract.validate_value(output, schema, "output", errors)
    validate_contract.enforce_verdict_refs(output, errors)
    refs = []
    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "evidence_refs":
                    refs.extend(v if isinstance(v, list) else [v])
                else:
                    walk(v)
        elif isinstance(node, list):
            for item in node:
                walk(item)
    walk(output)
    validate_contract.check_refs(refs, ledger, project_root, errors)
    if errors:
        return None, "invalid: " + "; ".join(errors)
    return output, True


def build_report(task: dict, results: list, gates: dict) -> dict:
    proven = sum(1 for r in results if r["verdict"] == "PROVEN")
    not_proven = sum(1 for r in results if r["verdict"] == "NOT_PROVEN")
    insufficient = sum(1 for r in results if r["verdict"] == "INSUFFICIENT_EVIDENCE")
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
        "gates": gates,
        "criteria": results,
    }


def print_report(report: dict) -> None:
    print("=" * 60)
    print("JUDGE — Evidence Evaluation")
    print("=" * 60)
    g = report.get("gates", {})
    print(f"  Gate1 verify: {g.get('verify', 'N/A')}")
    print(f"  Gate2 evidence-ledger: {g.get('evidence', 'N/A')}")
    print(f"  Contract report: {g.get('contract', 'N/A')}")
    print()
    for i, r in enumerate(report["criteria"], 1):
        print(f"  Criterion {i}: {r['verdict']}")
        print(f"    → {r['criterion'][:90]}")
        if r.get("evidence"):
            print(f"      ({r['evidence'][:110]})")
    print()
    print("=" * 60)
    print(f"  VERDICT: {report['verdict']}")
    print(f"  {report['proven']}/{report['total_criteria']} criteria proven")
    print("=" * 60)


def main():
    parser = argparse.ArgumentParser(description="JUDGE phase — PROVEN requires real evidence")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--no-verify", action="store_true",
                        help="skip the verify gate (inspection only; verdicts are advisory)")
    parser.add_argument("--dry-run", action="store_true", help="print without writing report")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    task = load_yaml(project_root / "task.yaml")
    if not task:
        print("ERROR: task.yaml missing or empty")
        sys.exit(2)

    # P1#4: --no-verify is an inspection-only bypass; audit/CI environments
    # must never skip the verify gate.
    if args.no_verify and (os.environ.get("MH_STRICT") or os.environ.get("CI")):
        print("ERROR: --no-verify is forbidden under MH_STRICT/CI — the verify "
              "gate is mandatory in audit environments", file=sys.stderr)
        sys.exit(2)

    gates = {"verify": "SKIPPED" if args.no_verify else "not run", "evidence": "?", "contract": "absent"}

    # GATE 1: really run verification.
    if args.no_verify:
        verify_passed = True
        gates["verify"] = "SKIPPED (--no-verify)"
    else:
        verify_passed, verify_output = run_verification(project_root)
        gates["verify"] = "PASSED" if verify_passed else f"FAILED: {verify_output[:80]}"

    # GATE 2: ledger evidence (+ optional audit report).
    ledger = load_ledger(project_root)
    has_evidence = ledger_has_passing_evidence(ledger)
    gates["evidence"] = "passing verify/test records" if has_evidence else "NO passing records"

    # WP5: an audit report is additional evidence when present, valid and passed.
    audit_path = project_root / "memory" / "audit-report.yaml"
    audit_ok = None
    if audit_path.exists():
        audit_schema = (Path(__file__).resolve().parent.parent / "meta" / "prompt-contracts"
                        / "audit" / "schema.yaml")
        aerrors = []
        try:
            aout = validate_contract.load_output(audit_path)
            validate_contract.validate_value(aout, validate_contract.load_schema(audit_schema),
                                             "audit", aerrors)
        except ValueError as e:
            aerrors.append(str(e))
        if aerrors:
            audit_ok = False
            gates["audit"] = "INVALID (fail-closed)"
        elif aout.get("passed") is True:
            audit_ok = True
            has_evidence = True
            gates["audit"] = f"PASSED ({aout.get('rounds', '?')} rounds)"
        else:
            audit_ok = False
            gates["audit"] = "NOT PASSED (gaps or trust_prior>30%)"
    else:
        gates["audit"] = "absent"

    state = load_yaml(project_root / "memory" / "session-state.yaml")

    # CONTRACT: agent-written judgment-report (if any) is authoritative when valid.
    contract, ok = judge_contract(project_root, ledger)
    if contract is None and ok != "absent":
        # Invalid contract output: fail-closed, everything insufficient.
        print(f"ERROR: judgment-report.yaml exists but is invalid: {ok}")
        gates["contract"] = "INVALID (fail-closed)"
        results = [{"criterion": str(c), "verdict": "INSUFFICIENT_EVIDENCE",
                    "evidence": "contract report invalid"} for c in task.get("acceptance_criteria", [])]
    elif contract is not None:
        gates["contract"] = "VALID"
        # Contract verdicts win; a PROVEN without traceable refs was already
        # rejected by the validator (check_refs), so trust the validated report.
        results = [{"criterion": r.get("criterion", "?"), "verdict": r.get("verdict", "NOT_PROVEN"),
                    "evidence": f"contract: {r.get('rationale', '')[:110]}"}
                   for r in contract.get("criteria", [])]
        if not results:
            results = [{"criterion": str(c), "verdict": "INSUFFICIENT_EVIDENCE",
                        "evidence": "contract report empty"} for c in task.get("acceptance_criteria", [])]
    else:
        # No contract: mechanical judgment only, and the verify gate is a HARD
        # precondition — without a passing verify, nothing can be PROVEN.
        results = judge_mechanical(task, state, ledger)
        if not verify_passed and not args.no_verify:
            results = [{**r, "verdict": "INSUFFICIENT_EVIDENCE",
                        "evidence": f"verify gate failed: {r['evidence']}"}
                       for r in results]

    report = build_report(task, results, gates)
    print_report(report)

    if not args.dry_run:
        report_path = project_root / "memory" / "judgment-report.yaml"
        if contract is not None:
            report_path = project_root / "memory" / "judgment-output.yaml"  # don't clobber the agent's
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            yaml.dump(report, f, default_flow_style=False, allow_unicode=True)

    sys.exit(0 if report["verdict"] == "PROVEN" else 1)


if __name__ == "__main__":
    main()
