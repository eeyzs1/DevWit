"""Honesty regression tests (WP9): scripts must NOT trust self-reports.

Covers: judge Demo-1 (zero code + hand-written state -> INSUFFICIENT_EVIDENCE),
innovation on an empty product (stage Basic, contract-driven proposals),
guard --scan on real code, interpret --deepen, evolve --proposals.
"""

import shutil
import sys
from pathlib import Path

import pytest

HARNESS_ROOT = Path(__file__).resolve().parent.parent
SEEDS = HARNESS_ROOT / "seeds"


@pytest.fixture
def run_py():
    def _run(cwd, *args):
        import subprocess
        proc = subprocess.run([sys.executable, *args], cwd=str(cwd),
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace")
        return proc.returncode, proc.stdout + proc.stderr
    return _run


def _make_project(tmp_path, name="P", criteria=None):
    root = tmp_path / name
    (root / "memory").mkdir(parents=True)
    (root / "task.yaml").write_text(
        f"name: {name}\ngoal: G\nacceptance_criteria: {criteria or ['AC1 works']}\n",
        encoding="utf-8")
    return root


# ---------------------------------------------------------------- judge

def test_judge_zero_code_handwritten_state_is_insufficient(tmp_path, run_py):
    root = _make_project(tmp_path, criteria=["API responds correctly", "Validation works"])
    # hand-written completed_criteria, ZERO code, no orchestrator, no ledger
    (root / "memory" / "session-state.yaml").write_text(
        "status: in_progress\nprogress:\n  completed_criteria: ['API responds correctly']\n",
        encoding="utf-8")
    code, out = run_py(root.parent, str(HARNESS_ROOT / "scripts" / "judge.py"),
                       "--project-root", str(root))
    assert code != 0
    assert "INSUFFICIENT_EVIDENCE" in out  # never PROVEN from a state file alone
    assert "FAILED" in out  # verify gate failed loudly


def test_judge_contract_requires_traceable_refs(tmp_path, run_py):
    root = _make_project(tmp_path, criteria=["AC1"])
    (root / "memory" / "event-log.yaml").write_text(
        "version: 1\nevents:\n  - {seq: 1, ts: t, type: test/run, "
        "payload: {name: tests, exit: 0, passed: true}}\n", encoding="utf-8")
    # forged ref -> rejected
    (root / "memory" / "judgment-report.yaml").write_text(
        "verdict: PROVEN\ncriteria:\n  - criterion: AC1\n    verdict: PROVEN\n"
        "    evidence_refs: ['test:nonexistent']\n    rationale: forged\n",
        encoding="utf-8")
    code, out = run_py(root.parent, str(HARNESS_ROOT / "scripts" / "judge.py"),
                       "--project-root", str(root), "--no-verify")
    assert code != 0 and "INSUFFICIENT_EVIDENCE" in out  # invalid contract -> fail-closed


def test_judge_contract_valid_with_real_ref(tmp_path, run_py):
    root = _make_project(tmp_path, criteria=["AC1"])
    (root / "memory" / "event-log.yaml").write_text(
        "version: 1\nevents:\n  - {seq: 1, ts: t, type: test/run, "
        "payload: {name: tests, exit: 0, passed: true}}\n", encoding="utf-8")
    (root / "memory" / "judgment-report.yaml").write_text(
        "verdict: PROVEN\ncriteria:\n  - criterion: AC1\n    verdict: PROVEN\n"
        "    evidence_refs: ['test:tests']\n    rationale: tests passed\n",
        encoding="utf-8")
    code, out = run_py(root.parent, str(HARNESS_ROOT / "scripts" / "judge.py"),
                       "--project-root", str(root), "--no-verify")
    assert code == 0 and "VERDICT: PROVEN" in out


def test_judge_no_verify_forbidden_under_ci(tmp_path, run_py):
    """P1#4: audit/CI environments must never skip the verify gate."""
    root = _make_project(tmp_path, criteria=["AC1"])
    import os
    old = os.environ.get("CI")
    os.environ["CI"] = "true"
    try:
        code, out = run_py(root.parent, str(HARNESS_ROOT / "scripts" / "judge.py"),
                           "--project-root", str(root), "--no-verify")
    finally:
        if old is None:
            os.environ.pop("CI", None)
        else:
            os.environ["CI"] = old
    assert code == 2 and "forbidden" in out


# ---------------------------------------------------------------- innovation

def _innovation_project(tmp_path):
    root = _make_project(tmp_path, criteria=["a"])
    (root / "evolution").mkdir()
    shutil.copy2(SEEDS / "evolution" / "domain-advancements-api.yaml",
                 root / "evolution" / "domain-advancements-api.yaml")
    shutil.copy2(SEEDS / "evolution" / "product-analyzer.py",
                 root / "evolution" / "product-analyzer.py")
    # P0#1 completion oracle: the gate opens ONLY with real ledger evidence,
    # so the fixture writes a passing test/run record + the advisory state.
    (root / "memory" / "session-state.yaml").write_text(
        "status: in_progress\nprogress:\n  completed_criteria: ['a']\n", encoding="utf-8")
    (root / "memory" / "event-log.yaml").write_text(
        "version: 1\nevents:\n  - {seq: 1, ts: t, type: test/run, "
        "payload: {name: tests, exit: 0, passed: true}}\n", encoding="utf-8")
    return root


def test_innovation_empty_product_requires_evidence(tmp_path, run_py):
    """Without ledger evidence, hand-written completion must NOT open the gate."""
    root = _make_project(tmp_path, criteria=["a"])
    (root / "evolution").mkdir()
    shutil.copy2(SEEDS / "evolution" / "domain-advancements-api.yaml",
                 root / "evolution" / "domain-advancements-api.yaml")
    shutil.copy2(SEEDS / "evolution" / "product-analyzer.py",
                 root / "evolution" / "product-analyzer.py")
    (root / "memory" / "session-state.yaml").write_text(
        "status: in_progress\nprogress:\n  completed_criteria: ['a']\n", encoding="utf-8")
    code, out = run_py(root, str(SEEDS / "evolution" / "innovation-engine.py"),
                       "--project-root", str(root))
    assert "Not all acceptance criteria are met" in out  # oracle refuses


def test_innovation_empty_product_stage_is_basic_and_no_canned_dump(tmp_path, run_py):
    root = _innovation_project(tmp_path)
    code, out = run_py(root, str(SEEDS / "evolution" / "innovation-engine.py"),
                       "--project-root", str(root))
    assert "Current stage: Basic" in out  # bug fixed: empty product is NOT Solid
    assert "No innovation-proposals.yaml" in out  # no canned YAML dumping


def test_innovation_contract_proposals_validated(tmp_path, run_py):
    root = _innovation_project(tmp_path)
    (root / "src").mkdir()
    (root / "src" / "api.py").write_text("def ping(): return 'pong'", encoding="utf-8")
    (root / "evolution" / "innovation-proposals.yaml").write_text(
        "proposals:\n  - id: API-001\n    name: Add rate limiting\n"
        "    description: rate limit\n    category: performance\n"
        "    effort: medium\n    impact: high\n"
        "    evidence_refs: ['file:src/api.py']\n", encoding="utf-8")
    code, out = run_py(root, str(SEEDS / "evolution" / "innovation-engine.py"),
                       "--project-root", str(root))
    assert "Contract proposals: 1" in out
    assert "AUTO-APPROVED" in out


def test_innovation_proposal_without_refs_or_assumption_rejected(tmp_path, run_py):
    root = _innovation_project(tmp_path)
    (root / "evolution" / "innovation-proposals.yaml").write_text(
        "proposals:\n  - id: X\n    name: Y\n    description: Z\n"
        "    effort: low\n    impact: low\n", encoding="utf-8")
    code, out = run_py(root, str(SEEDS / "evolution" / "innovation-engine.py"),
                       "--project-root", str(root))
    assert "INVALID" in out and "evidence_ref" in out


# ---------------------------------------------------------------- guard scan

def test_guard_scan_catches_mock_in_real_code(tmp_path, run_py):
    root = tmp_path / "scan"
    (root / "verification").mkdir(parents=True)
    (root / "src").mkdir()
    shutil.copy2(SEEDS / "guard.py", root / "guard.py")
    shutil.copy2(SEEDS / "verification" / "anti-mock-check.py", root / "verification" / "anti-mock-check.py")
    shutil.copy2(SEEDS / "verification" / "quality-gate.py", root / "verification" / "quality-gate.py")
    (root / "src" / "payments.py").write_text(
        "class MockPaymentClient:\n    def charge(self, amount):\n"
        "        return {'mock': 'success'}\n", encoding="utf-8")
    code, out = run_py(root, "guard.py", "--scan", ".")
    assert code != 0 and "BLOCKED" in out
    assert "MockPaymentClient" in out or "mock" in out.lower()


# ---------------------------------------------------------------- deepen

def test_interpret_deepen_corrects_and_validates(tmp_path, run_py):
    task = tmp_path / "task.yaml"
    code, out = run_py(tmp_path, str(HARNESS_ROOT / "scripts" / "interpret.py"),
                       "--intent", "Build a bot that monitors APIs and alerts",
                       "--output", str(task))
    assert code == 0
    corr = tmp_path / "corrections.yaml"
    corr.write_text(
        "domain: automation\nscale: team\n"
        "acceptance_criteria: ['Bot polls health endpoints', 'Alert fires on failure']\n"
        "rationale: monitoring bot\n", encoding="utf-8")
    code, out = run_py(tmp_path, str(HARNESS_ROOT / "scripts" / "interpret.py"),
                       "--deepen", str(corr), "--task", str(task))
    assert code == 0 and "Deepened" in out
    import yaml
    merged = yaml.safe_load(task.read_text(encoding="utf-8"))
    assert merged["domain"] == "automation" and merged["scale"] == "team"
    # invalid domain + empty criteria -> fail
    bad = tmp_path / "bad.yaml"
    bad.write_text("domain: quantum\nacceptance_criteria: []\n", encoding="utf-8")
    code, out = run_py(tmp_path, str(HARNESS_ROOT / "scripts" / "interpret.py"),
                       "--deepen", str(bad), "--task", str(task))
    assert code == 1 and "DEEPEN FAIL" in out


# ---------------------------------------------------------------- evolve proposals

def test_evolve_proposals_contract(tmp_path, run_py):
    root = tmp_path / "evo"
    (root / "evolution").mkdir(parents=True)
    (root / "memory").mkdir()
    (root / "evolution" / "genome.yaml").write_text(
        "version: 1\ntotal_mutations: 0\nharness_genome:\n  constraints:\n"
        "    - {id: C001, rule: r1, trigger_count: 0}\n    - {id: C002, rule: r2, trigger_count: 0}\n"
        "  skills: []\n  workflows: []\n", encoding="utf-8")
    (root / "memory" / "event-log.yaml").write_text(
        "version: 1\nevents:\n  - {seq: 1, ts: t, type: test/run, "
        "payload: {name: tests, exit: 0, passed: true}}\n", encoding="utf-8")
    props = root / "evolution" / "mutation-proposals.yaml"
    props.write_text(
        "mutations:\n  - type: ADD_CONSTRAINT\n    target: harness_genome.constraints\n"
        "    rationale: add validation gate\n    evidence_refs: ['test:tests']\n", encoding="utf-8")
    code, out = run_py(root, str(HARNESS_ROOT / "scripts" / "evolve.py"),
                       "--project-root", str(root), "--proposals", str(props))
    assert code == 0 and "ACCEPTED" in out
    # forged ref -> rejected
    props.write_text(
        "mutations:\n  - type: ADD_CONSTRAINT\n    target: x\n    rationale: x\n"
        "    evidence_refs: ['test:nonexistent']\n", encoding="utf-8")
    code, out = run_py(root, str(HARNESS_ROOT / "scripts" / "evolve.py"),
                       "--project-root", str(root), "--proposals", str(props))
    assert code == 1 and "PROPOSALS FAIL" in out


def test_evolve_fitness_ignores_self_reported_completion_without_evidence(tmp_path):
    """P0#1: completed_criteria without ledger evidence must not reward fitness."""
    import sys
    sys.path.insert(0, str(HARNESS_ROOT / "scripts"))
    import evolve as ev
    root = tmp_path / "evo"
    (root / "memory").mkdir(parents=True)
    (root / "task.yaml").write_text(
        "name: P\ngoal: G\nacceptance_criteria: ['AC1', 'AC2']\n", encoding="utf-8")
    (root / "memory" / "session-state.yaml").write_text(
        "status: in_progress\nprogress:\n  completed_criteria: ['AC1', 'AC2']\n",
        encoding="utf-8")
    # no event-log at all -> self-report must be ignored
    evidence = ev.collect_evidence(root)
    assert evidence["pipeline_state"]["verified_count"] == 0
    # with passing ledger evidence -> self-report is admissible again
    (root / "memory" / "event-log.yaml").write_text(
        "version: 1\nevents:\n  - {seq: 1, ts: t, type: test/run, "
        "payload: {name: tests, exit: 0, passed: true}}\n", encoding="utf-8")
    evidence = ev.collect_evidence(root)
    assert evidence["pipeline_state"]["verified_count"] == 2
