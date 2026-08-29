"""Regression tests for the RESEARCH contract (A+B) and the dynamic domain
template (C): unknown-domain learning before criteria lock and before slot
authoring.

- B: `scripts/interpret.py --research` validates findings (schema + evidence
  grounding) and merges them over the baseline task.yaml.
- A: `hooks/pre-advance/30-research-gate.py` refuses INTERPRET -> GENERATE when
  the domain is unfamiliar (novelty >= 3) without grounded research findings;
  `scripts/validate-harness.py` check [13] refuses a harness whose
  context/domain-brief.yaml lacks a real http(s) source when research is needed.
- C: every scaffold emits `context/domain-brief.yaml` as an LLM slot — the
  per-project dynamic domain template.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

HARNESS_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = HARNESS_ROOT / "scripts"

NOVEL_INTENT = ("Build a distributed robot fleet controller with edge failover; "
                "must use kubernetes; must use postgres; must use kafka")
FAMILIAR_INTENT = "Build an API for orders"


def _run(cwd, *args):
    proc = subprocess.run([sys.executable, *args], cwd=str(cwd),
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    return proc.returncode, proc.stdout + proc.stderr


def _write_findings(root: Path, domain="robot_fleet_control", **extra) -> Path:
    findings = {
        "domain": domain,
        "findings": [
            {"claim": "Robot fleets need leader election + failover protocol",
             "source_url": "https://example.org/fleet-control"},
            {"claim": "Kubernetes is the de facto orchestration standard",
             "source_url": "https://kubernetes.io/docs/"},
        ],
        "resolved_unknowns": [
            "Exact technical stack preference -> kubernetes+postgres+kafka"],
        "rationale": "learned the domain",
    }
    findings.update(extra)
    p = root / "memory" / "research-findings.yaml"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.dump(findings), encoding="utf-8")
    return p


def _satisfy_deepen(meta_root, domain="api_service"):
    (meta_root / "memory").mkdir(exist_ok=True)
    (meta_root / "memory" / "deepen-corrections.yaml").write_text(
        f"domain: {domain}\nscale: team\n"
        "acceptance_criteria: ['It works']\nrationale: deepened\n",
        encoding="utf-8")
    _run(meta_root, "scripts/interpret.py", "--deepen",
         "memory/deepen-corrections.yaml", "--task", "task.yaml")


# ---------------------------------------------------------------- B: interpret

def test_interpret_intent_flags_novel_domain():
    sys.path.insert(0, str(SCRIPTS))
    import interpret as it
    task = it.interpret_intent(NOVEL_INTENT)
    assert task["complexity"]["novelty"] >= 3
    assert "kubernetes" in " ".join(task["hard_constraints"])


def test_research_applies_domain_correction_and_resolves_unknowns(tmp_path):
    sys.path.insert(0, str(SCRIPTS))
    import interpret as it
    task = it.interpret_intent(NOVEL_INTENT)
    findings = {
        "domain": "robot_fleet_control",
        "findings": [{"claim": "Fleet control needs leader election",
                      "source_url": "https://example.org/fleet"}],
        "resolved_unknowns": ["Exact technical stack preference -> kubernetes"],
        "acceptance_criteria": ["Fleet survives node loss within 5s"],
    }
    out = it.apply_research(task, findings)
    assert out is not None
    assert out["domain"] == "robot_fleet_control"
    assert out["acceptance_criteria"] == ["Fleet survives node loss within 5s"]
    assert "Exact technical stack preference" not in out["unknowns"]


def test_research_rejects_ungrounded_findings():
    sys.path.insert(0, str(SCRIPTS))
    import interpret as it
    task = it.interpret_intent(NOVEL_INTENT)
    # assumption-only: no real source anywhere
    assert it.apply_research(task, {"domain": "robot_fleet_control",
                                    "findings": [{"claim": "x", "assumption": True}]}) is None
    # neither source nor assumption
    assert it.apply_research(task, {"domain": "robot_fleet_control",
                                    "findings": [{"claim": "x"}]}) is None
    # missing required 'findings'
    assert it.apply_research(task, {"domain": "robot_fleet_control"}) is None


def test_research_domain_change_allowed_when_grounded():
    sys.path.insert(0, str(SCRIPTS))
    import interpret as it
    task = it.interpret_intent(NOVEL_INTENT)
    ok = {"domain": "quantum_error_correction",
          "findings": [{"claim": "Surface codes are QEC's leading candidate",
                        "source_url": "https://arxiv.org/abs/2305.12345"}]}
    out = it.apply_research(task, ok)
    assert out is not None and out["domain"] == "quantum_error_correction"


# ---------------------------------------------------------------- A: gates

def test_research_gate_refuses_then_passes(meta_root, run_py):
    code, out = run_py(meta_root, "meta/meta-orchestrator.py",
                       "--interpret-intent", NOVEL_INTENT)
    assert code == 0 and "Acceptance criteria LOCKED" in out
    _satisfy_deepen(meta_root)
    # advance: refused by 30-research-gate (novelty>=3, no findings yet)
    code, out = run_py(meta_root, "meta/meta-orchestrator.py",
                       "--advance", "--no-auto-run")
    assert "ADVANCE REFUSED" in out and "30-research-gate" in out
    # invalid findings (assumption-only) -> still refused
    _write_findings(meta_root, findings=[{"claim": "x", "assumption": True}])
    code, out = run_py(meta_root, "meta/meta-orchestrator.py",
                       "--advance", "--no-auto-run")
    assert "30-research-gate" in out and "INVALID" in out
    # valid findings applied -> advance passes
    _write_findings(meta_root)
    code, out = run_py(meta_root, "scripts/interpret.py", "--research",
                       "memory/research-findings.yaml", "--task", "task.yaml")
    assert code == 0
    code, out = run_py(meta_root, "meta/meta-orchestrator.py",
                       "--advance", "--no-auto-run")
    assert "PHASE COMPLETE: INTERPRET" in out
    assert "ADVANCE REFUSED" not in out


def test_research_gate_noop_for_familiar_domain(meta_root, run_py):
    code, out = run_py(meta_root, "meta/meta-orchestrator.py",
                       "--interpret-intent", FAMILIAR_INTENT)
    assert code == 0
    _satisfy_deepen(meta_root)
    code, out = run_py(meta_root, "meta/meta-orchestrator.py",
                       "--advance", "--no-auto-run")
    assert "PHASE COMPLETE: INTERPRET" in out
    assert "30-research-gate" not in out


# ---------------------------------------------------------------- C: scaffold + validate

def test_scaffold_emits_domain_brief_slot(meta_root, run_py):
    task = meta_root / "task.yaml"
    task.write_text(
        "name: T\ndomain: industrial_control\ngoal: G\n"
        "acceptance_criteria: [a]\nunknowns: ['X']\n"
        "complexity: {scope: 4, criticality: 5, novelty: 4, coupling: 4, tier: full}\n",
        encoding="utf-8")
    code, out = run_py(meta_root, str(SCRIPTS / "scaffold.py"),
                       "--task", str(task), "--output", str(meta_root / "gen"))
    assert code == 0
    brief = meta_root / "gen" / "context" / "domain-brief.yaml"
    assert brief.exists()
    manifest = yaml.safe_load(
        (meta_root / "gen" / "harness-scaffold.yaml").read_text(encoding="utf-8"))
    files = [s["file"] for s in manifest["llm_slots"]]
    assert "context/domain-brief.yaml" in files


def test_validate_harness_research_grounding(meta_root, run_py):
    task = meta_root / "task.yaml"
    shutil.copy2(HARNESS_ROOT / "tests" / "task-industrial-control.yaml", task)
    code, out = run_py(meta_root, str(SCRIPTS / "scaffold.py"),
                       "--task", str(task), "--output", str(meta_root / "gen"))
    assert code == 0
    brief = meta_root / "gen" / "context" / "domain-brief.yaml"
    base = ("domain: industrial_control\nrationale: x\ninvariants: []\n"
            "component_map: {}\nworkflows: []\nadvancement_roadmap: "
            "{Basic: [], Solid: [], Advanced: [], Excellent: []}\n")
    # enriched WITHOUT sources -> research check FAILS (novelty=4 + unknowns)
    brief.write_text(base + "sources: []\n", encoding="utf-8")
    code, out = run_py(meta_root, str(SCRIPTS / "validate-harness.py"),
                       str(meta_root / "gen"))
    assert "no http(s) source" in out and "research is required" in out
    # enriched WITH a real source -> research check PASSES
    brief.write_text(base + "sources: ['https://opcfoundation.org/specifications/']\n",
                     encoding="utf-8")
    code, out = run_py(meta_root, str(SCRIPTS / "validate-harness.py"),
                       str(meta_root / "gen"))
    assert "grounded in 1 source(s)" in out


def test_validate_harness_placeholder_brief_rejected(meta_root, run_py):
    task = meta_root / "task.yaml"
    task.write_text(
        "name: T\ndomain: api_service\ngoal: G\nacceptance_criteria: [a]\n"
        "complexity: {scope: 2, criticality: 2, novelty: 2, coupling: 2, tier: minimal}\n",
        encoding="utf-8")
    code, out = run_py(meta_root, str(SCRIPTS / "scaffold.py"),
                       "--task", str(task), "--output", str(meta_root / "gen"))
    assert code == 0
    # leave the placeholder baseline (no research needed, but domain must be real)
    code, out = run_py(meta_root, str(SCRIPTS / "validate-harness.py"),
                       str(meta_root / "gen"))
    assert "non-placeholder 'domain'" in out
