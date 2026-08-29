#!/usr/bin/env python3
"""
META-ORCHESTRATOR v3.0: Drives the meta-harness pipeline with context-loss
resilience, an append-only event log, and goal semantics.

Inspired by DeepSeek Harness core concepts (see docs of this repo):
  - Event log is the SINGLE source of truth: meta/event-log.yaml is append-only;
    meta/pipeline-state.yaml and .meta-harness/PHASE_BRIEF.md are DERIVED
    projections (model-visible <-> logged). scripts/state-fold.py owns the pure
    fold; scripts/brief-gen.py derives the resume brief at the same watermark.
  - Fail-closed: unknown log versions, unknown event types, seq gaps, and
    untraceable state are REFUSED (scripts/log_invariant.py).
  - Compare-and-set: every mutation appends events with expected_revision, so a
    stale writer is rejected instead of clobbering a concurrent one.
  - Goal semantics: durable `phase` is separate from the `auto_advance` armed
    flag; blocked carries a machine `blocked_code` + human `blocked_reason`;
    `rounds`/`max_rounds` bound auto-continuation; a phase blocks only after
    repeated refusals with the SAME code; --pause/--resume pause the pipeline.
  - Hooks: phase transitions dispatch through hooks/pre-advance (bail gate,
    may reject with a stable code) and hooks/phase-complete, hooks/phase-enter
    (emit-style observers; failures are contained).

Pipeline: INTERPRET -> GENERATE -> FACTORY -> PROVE -> JUDGE -> EVOLVE

Usage:
    python meta/meta-orchestrator.py --status
    python meta/meta-orchestrator.py --interpret-intent "I need a REST API for orders"
    python meta/meta-orchestrator.py --next
    python meta/meta-orchestrator.py --advance            # auto-runs next phase script
    python meta/meta-orchestrator.py --advance --no-auto-run
    python meta/meta-orchestrator.py --save-acceptance-criteria "<criteria>"
    python meta/meta-orchestrator.py --verify-criterion 1
    python meta/meta-orchestrator.py --fail "<error>"     # block immediately (code manual-fail)
    python meta/meta-orchestrator.py --unblock --code <code> --reason <reason>
    python meta/meta-orchestrator.py --pause | --resume
    python meta/meta-orchestrator.py --force-phase GENERATE
    python meta/meta-orchestrator.py --events            # dump the event log
    python meta/meta-orchestrator.py --check-invariants  # run scripts/log_invariant.py
    python meta/meta-orchestrator.py --reset
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml

# Import the event-log machinery from scripts/.
SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
import brief_gen  # noqa: E402
import state_fold  # noqa: E402
from state_fold import (RevisionConflict, append_events, ensure_log,  # noqa: E402
                        fold, load_events, write_projection)

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

META_ROOT = Path(__file__).resolve().parent.parent
LOG_FILE = META_ROOT / "meta" / "event-log.yaml"
STATE_FILE = META_ROOT / "meta" / "pipeline-state.yaml"
BRIEF_FILE = META_ROOT / ".meta-harness" / "PHASE_BRIEF.md"
TASK_FILE = META_ROOT / "task.yaml"

PIPELINE_PHASES = [
    {
        "id": "INTERPRET",
        "order": 1,
        "description": "Transform intent into structured task definition",
        "required_files": ["meta/interpreter.md", "meta/phase-loader.md", "seeds/planning/planner-engine.md"],
        "verification": None,
        "output": "Task definition with measurable acceptance criteria",
    },
    {
        "id": "GENERATE",
        "order": 2,
        "description": "Generate executable harness project from task definition",
        "required_files": ["meta/harness-generator.md", "meta/harness-author.md",
                            "seeds/planning/project-yaml-template.yaml"],
        "verification": "scripts/validate-harness.py",
        "output": "Complete harness project in generated/[project-name]/ "
                  "(scaffold + LLM-authored slots + validated)",
    },
    {
        "id": "FACTORY",
        "order": 3,
        "description": "Generate specialized agent configurations from harness",
        "required_files": ["meta/agent-factory.md"],
        "verification": None,
        "output": "Agent topology and configurations",
    },
    {
        "id": "PROVE",
        "order": 4,
        "description": "Produce evidence that every acceptance criterion is satisfied",
        "required_files": ["scripts/verify-generation.py", "seeds/verification/auditor-engine.md"],
        "verification": "scripts/verify-generation.py",
        "output": "Evidence traceability matrix",
    },
    {
        "id": "JUDGE",
        "order": 5,
        "description": "Judge whether evidence proves the need is satisfied",
        "required_files": ["seeds/guard.py", "seeds/orchestrator.py"],
        "verification": "seeds/guard.py",
        "output": "Verdict: PROVEN or NOT_PROVEN",
    },
    {
        "id": "EVOLVE",
        "order": 6,
        "description": "Self-evolve based on evidence and fitness metrics",
        "required_files": ["evolution/framework.md", "scripts/evolve.py"],
        "verification": "scripts/evolve.py",
        "output": "Evolution log and genome updates",
    },
]

PHASE_INSTRUCTIONS = {
    "INTERPRET": """
PHASE: INTERPRET -- Intent -> Structured Task
=============================================
1. Read meta/interpreter.md for the interpretation process
2. Read the user's intent/request
3. Apply first principles: understand the REAL need, not the stated want
4. Output structured task definition with:
   - Measurable acceptance criteria
   - Surfaced assumptions
   - Domain classification
5. Confirm with user before proceeding (this is the only mandatory human gate)
6. Lock criteria: python meta/meta-orchestrator.py --save-acceptance-criteria "<criteria>"
7. DEEPEN (enforced by hooks/pre-advance/20-deepen-gate.py): write
   memory/deepen-corrections.yaml per meta/prompt-contracts/deepen/, then:
   python scripts/interpret.py --deepen memory/deepen-corrections.yaml --task task.yaml
8. RESEARCH for unknown domains (enforced by hooks/pre-advance/30-research-gate.py
   when complexity.novelty >= 3): learn the domain online, write
   memory/research-findings.yaml per meta/prompt-contracts/research/, then:
   python scripts/interpret.py --research memory/research-findings.yaml --task task.yaml
9. When confirmed, deepened and researched, run: python meta/meta-orchestrator.py --advance
""",
    "GENERATE": """
PHASE: GENERATE -- Task -> Executable Harness Project (v2 LLM-driven flow)
=========================================================================
3-step flow (scaffold + LLM author + validate). --advance only auto-runs step 1.

STEP 1 (auto-run by --advance): scaffold.py
  - python scripts/scaffold.py --task task.yaml --output generated/[project-name]

STEP 2 (LLM must execute manually -- script cannot do this):
  - Read meta/harness-author.md and generated/[project-name]/harness-scaffold.yaml
  - Fill every LLM slot with project-specific content (NO mock, NO placeholders)
  - Fill context/domain-brief.yaml FIRST (dynamic domain template, C); when
    novelty>=3 or unknowns remain, ground its sources in real research (A)

STEP 3 (manual before --advance to FACTORY): validate-harness.py
  - python scripts/validate-harness.py generated/[project-name]
  - Enforced automatically by hooks/pre-advance/10-validate-harness.py
""",
    "FACTORY": """
PHASE: FACTORY -- Harness -> Agent Configurations
==================================================
1. Read meta/agent-factory.md for agent generation rules
2. Analyze the generated harness for work units
3. Generate specialized agent configurations (roles, tools, scope, boundaries)
4. Define agent topology and handoff protocols
5. When complete, run: python meta/meta-orchestrator.py --advance
""",
    "PROVE": """
PHASE: PROVE -- Evidence Collection
===================================
1. For EACH acceptance criterion from INTERPRET, produce evidence
2. Evidence must be: specific, verifiable, traceable
3. Run: python scripts/verify-generation.py generated/[project-name]/
4. Format evidence as YAML with criterion -> evidence -> verdict
5. When all evidence collected, run: python meta/meta-orchestrator.py --advance
""",
    "JUDGE": """
PHASE: JUDGE -- Evidence -> Verdict
===================================
1. Review all evidence from PROVE phase
2. For each criterion: does evidence prove satisfaction?
3. Run: python seeds/guard.py (if available)
4. Output verdict: PROVEN or NOT_PROVEN
5. If NOT_PROVEN: diagnose root cause, loop back to GENERATE
6. If PROVEN, run: python meta/meta-orchestrator.py --advance
""",
    "EVOLVE": """
PHASE: EVOLVE -- Self-Improvement
=================================
1. Read evolution/framework.md for evolution rules
2. Collect evidence from all previous phases
3. Measure fitness score
4. Propose mutations (max 30% change rate)
5. Run: python scripts/evolve.py
6. Apply accepted mutations, log to evolution/log.yaml
7. When complete, run: python meta/meta-orchestrator.py --advance
   (This marks the pipeline as COMPLETE)
""",
}

PHASE_SCRIPTS = {
    "GENERATE": {
        "script": "scripts/scaffold.py",
        "args": lambda state: ["--task", str(TASK_FILE),
                                "--output", _infer_output_dir(state)],
        "sets_state": "generated_project_dir",
    },
    "FACTORY": {
        "script": "scripts/agent-factory.py",
        "args": lambda state: ["--project-root", state.get("generated_project_dir") or "."],
    },
    "PROVE": {
        "script": "scripts/verify-generation.py",
        "args": lambda state: [state.get("generated_project_dir") or ".",
                               "--run-checks"],  # P1#6: really run the checks
    },
    "JUDGE": {
        "script": "scripts/judge.py",
        "args": lambda state: ["--project-root", state.get("generated_project_dir") or "."],
    },
    "EVOLVE": {
        "script": "scripts/evolve.py",
        "args": lambda state: ["--project-root", str(META_ROOT)],
    },
}


# ============================================================
# Event log: load / commit (CAS) / refresh projections
# ============================================================

def _refresh(state: dict) -> None:
    """Write the derived artifacts: pipeline-state.yaml + PHASE_BRIEF.md."""
    write_projection(state, STATE_FILE)
    BRIEF_FILE.parent.mkdir(parents=True, exist_ok=True)
    BRIEF_FILE.write_text(brief_gen.render_brief(state), encoding="utf-8")


def load_state() -> dict:
    """Bootstrap/migrate the log, fold it, refresh projections, return state."""
    ensure_log(LOG_FILE, STATE_FILE)
    state = fold(load_events(LOG_FILE))
    _refresh(state)
    return state


def commit(new_events: list) -> dict:
    """CAS-append events to the log; re-fold; refresh projections.

    Bootstraps the log first (phase/start) so every mutation lands on a
    well-formed log. Exits with a stale-writer error if the log moved between
    read and write.
    """
    ensure_log(LOG_FILE, STATE_FILE)
    rev = len(load_events(LOG_FILE))
    try:
        append_events(LOG_FILE, new_events, expected_revision=rev)
    except RevisionConflict as e:
        print(f"  鉂?{e}")
        print("  Re-run the command after re-reading the current state.")
        sys.exit(1)
    state = fold(load_events(LOG_FILE))
    _refresh(state)
    return state


# ============================================================
# Hooks (WP2): pre-advance = bail gate; complete/enter = observers
# ============================================================

def _hook_context(state: dict, event: str, frm, to) -> dict:
    return {
        "event": event, "phase": frm, "to": to,
        "project_name": state.get("project_name"),
        "generated_project_dir": state.get("generated_project_dir"),
        "rounds": state.get("rounds"),
        "max_rounds": state.get("max_rounds"),
    }


def run_pre_advance_hooks(state: dict, frm: str, to: str) -> tuple:
    """Bail dispatch over hooks/pre-advance/*.py.

    A hook exits 0 to pass; a non-zero exit refuses the advance. The refusal
    code is the hook filename stem; the reason is the hook's stderr/stdout.
    Returns (ok, code, reason).
    """
    hooks_dir = META_ROOT / "hooks" / "pre-advance"
    if not hooks_dir.exists():
        # Fail-closed: GENERATE must always carry its validate-harness gate.
        if frm == "GENERATE":
            return False, "missing-hook", ("hooks/pre-advance/ missing: the "
                                           "validate-harness gate would be silently disabled")
        return True, None, None
    hooks = sorted(h for h in hooks_dir.glob("*.py") if h.name != "__init__.py")
    env = dict(os.environ, MH_CONTEXT=json.dumps(_hook_context(state, "pre-advance", frm, to)))
    for hook in hooks:
        proc = subprocess.run([sys.executable, str(hook)], cwd=str(META_ROOT), env=env,
                              capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            reason = (proc.stderr.strip() or proc.stdout.strip()
                      or f"hook {hook.name} exited {proc.returncode}")[-500:]
            return False, hook.stem, reason
    return True, None, None


def run_observer_hooks(state: dict, group: str, event: str, frm, to) -> None:
    """Emit-style observers (hooks/phase-complete, hooks/phase-enter).

    Failures are contained: an observer never blocks or breaks the pipeline.
    """
    hooks_dir = META_ROOT / "hooks" / group
    if not hooks_dir.exists():
        return
    hooks = sorted(h for h in hooks_dir.glob("*.py") if h.name != "__init__.py")
    env = dict(os.environ, MH_CONTEXT=json.dumps(_hook_context(state, event, frm, to)))
    for hook in hooks:
        try:
            subprocess.run([sys.executable, str(hook)], cwd=str(META_ROOT), env=env,
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        except Exception as e:
            print(f"  鈿狅笍  observer hook {hook.name} failed (contained): {e}")


# ============================================================
# Phase scripts (unchanged best-effort auto-run, event-backed state)
# ============================================================

def run_phase_script(state: dict, phase_id: str) -> dict:
    spec = PHASE_SCRIPTS.get(phase_id)
    if not spec:
        return state

    script_path = META_ROOT / spec["script"]
    if not script_path.exists():
        msg = f"Phase script not found: {spec['script']}"
        print(f"  鈿狅笍  {msg}")
        return commit([{"type": "error/recorded", "phase": phase_id,
                        "payload": {"phase": phase_id, "message": msg}}])

    try:
        args = spec["args"](state)
    except Exception as e:
        msg = f"Could not build args for {phase_id}: {e}"
        print(f"  鈿狅笍  {msg}")
        return commit([{"type": "error/recorded", "phase": phase_id,
                        "payload": {"phase": phase_id, "message": msg}}])

    if phase_id in ("FACTORY", "PROVE", "JUDGE") and not state.get("generated_project_dir"):
        msg = f"Cannot run {phase_id}: generated_project_dir not set (run GENERATE first)"
        print(f"  鈿狅笍  {msg}")
        return commit([{"type": "error/recorded", "phase": phase_id,
                        "payload": {"phase": phase_id, "message": msg}}])

    cmd = [sys.executable, str(script_path)] + args
    print(f"\n  鈻讹笍  Auto-running {phase_id}: {' '.join(cmd)}")
    print("  " + "-" * 60)
    try:
        result = subprocess.run(cmd, cwd=str(META_ROOT), capture_output=False)
        exit_code = result.returncode
    except Exception as e:
        msg = f"Phase script crashed: {e}"
        print(f"  鉂?{msg}")
        return commit([{"type": "error/recorded", "phase": phase_id,
                        "payload": {"phase": phase_id, "message": msg}}])

    print("  " + "-" * 60)
    if exit_code != 0:
        msg = f"Phase script exited with code {exit_code}"
        print(f"  鈿狅笍  {msg} 鈥?review output above, fix, and re-run manually if needed.")
        return commit([{"type": "error/recorded", "phase": phase_id,
                        "payload": {"phase": phase_id, "message": msg}}])

    print(f"  鉁?{phase_id} script completed successfully.")
    if spec.get("sets_state") == "generated_project_dir":
        generated_dir = _detect_generated_dir()
        if generated_dir and state.get("generated_project_dir") != str(generated_dir):
            state = commit([{"type": "meta/set", "phase": phase_id,
                             "payload": {"key": "generated_project_dir",
                                         "value": str(generated_dir)}}])
            print(f"  馃搧 Generated project dir: {generated_dir}")
    return state


def _detect_generated_dir():
    generated_root = META_ROOT / "generated"
    if not generated_root.exists():
        return None
    candidates = [d for d in generated_root.iterdir()
                  if d.is_dir() and (d / ".harness-generated").exists()]
    if not candidates:
        return None
    return max(candidates, key=lambda d: d.stat().st_mtime)


def _infer_output_dir(state: dict) -> str:
    if not TASK_FILE.exists():
        raise RuntimeError("task.yaml not found -- run INTERPRET first")
    with open(TASK_FILE, "r", encoding="utf-8") as f:
        task = yaml.safe_load(f) or {}
    name = task.get("name") or state.get("project_name") or "unnamed"
    sanitized = re.sub(r"[^a-zA-Z0-9._-]", "-", str(name)).strip("-").lower() or "unnamed"
    return str(META_ROOT / "generated" / sanitized)


# ============================================================
# Command implementations
# ============================================================

def interpret_intent(intent: str) -> dict:
    script_path = META_ROOT / "scripts" / "interpret.py"
    if not script_path.exists():
        print(f"ERROR: interpret.py not found at {script_path}")
        return load_state()

    cmd = [sys.executable, str(script_path), "--intent", intent, "--output", str(TASK_FILE)]
    print(f"\n  鈻讹笍  Running interpreter: {intent[:80]}...")
    print("  " + "-" * 60)
    try:
        result = subprocess.run(cmd, cwd=str(META_ROOT), capture_output=False)
    except Exception as e:
        print(f"  鉂?Interpreter crashed: {e}")
        return load_state()
    print("  " + "-" * 60)

    if result.returncode != 0:
        print(f"  鉂?Interpreter exited with code {result.returncode}")
        return load_state()

    if not TASK_FILE.exists():
        print(f"  鉂?Interpreter did not produce {TASK_FILE}")
        return load_state()

    with open(TASK_FILE, "r", encoding="utf-8") as f:
        task = yaml.safe_load(f) or {}

    criteria = task.get("acceptance_criteria", [])
    if not criteria:
        print("  鈿狅笍  Interpreter produced no acceptance criteria.")
        return load_state()

    payload = {
        "criteria": criteria,
        "project_name": task.get("name", "unnamed"),
        "domain": task.get("domain"),
        "scale": task.get("scale"),
        "quality_attributes": task.get("quality_attributes", []),
    }
    state = commit([{"type": "criteria/locked", "phase": "INTERPRET", "payload": payload}])

    print(f"\n  鉁?Interpretation complete.")
    print(f"  Project: {state['project_name']}")
    print(f"  Domain: {state.get('domain', 'unknown')}")
    print(f"  Scale: {state.get('scale', 'unknown')}")
    print(f"  Quality attributes: {state.get('quality_attributes', [])}")
    print(f"  Acceptance criteria LOCKED ({len(criteria)} total):")
    for i, c in enumerate(criteria, 1):
        print(f"    {i}. {c}")
    print(f"\n  Task definition written to: {TASK_FILE}")
    print(f"  Confirm criteria with the user, then run: --advance")
    return state


def save_acceptance_criteria(criteria_text: str) -> dict:
    criteria = [c.strip() for c in criteria_text.split(";") if c.strip()]
    if not criteria:
        criteria = [criteria_text.strip()]
    state = commit([{"type": "criteria/locked", "phase": "INTERPRET",
                     "payload": {"criteria": criteria}}])
    print()
    print(f"  Acceptance criteria LOCKED ({len(criteria)} total):")
    for i, c in enumerate(criteria, 1):
        print(f"    {i}. {c}")
    print()
    print("  These criteria will be checked at every phase boundary.")
    print("  The agent CANNOT drift from these criteria.")
    print()
    return state


def verify_criterion(criterion_index: int) -> dict:
    state = load_state()
    criteria = state.get("acceptance_criteria", [])
    if criterion_index < 1 or criterion_index > len(criteria):
        print(f"ERROR: Invalid criterion index {criterion_index}. Valid: 1-{len(criteria)}")
        return state
    criterion = criteria[criterion_index - 1]
    if criterion in state.get("verified_criteria", []):
        print(f"  Criterion {criterion_index} already verified: {criterion}")
        return state
    state = commit([{"type": "criterion/verified", "phase": state["current_phase"],
                     "payload": {"index": criterion_index, "criterion": criterion}}])
    print(f"  Criterion {criterion_index} VERIFIED: {criterion}")
    return state


def force_phase(phase_id: str) -> dict:
    valid_ids = [p["id"] for p in PIPELINE_PHASES]
    if phase_id not in valid_ids:
        print(f"ERROR: Invalid phase '{phase_id}'. Valid: {', '.join(valid_ids)}")
        return load_state()
    state = commit([{"type": "phase/force", "phase": phase_id,
                     "payload": {"phase": phase_id}}])
    print(f"Forced jump to phase: {phase_id} (auditable: phase/force event)")
    return state


def fail_phase(error_message: str) -> dict:
    current = load_state().get("current_phase", "INTERPRET")
    state = commit([{"type": "pipeline/block", "phase": current,
                     "payload": {"phase": current, "code": "manual-fail",
                                 "reason": error_message}}])
    print()
    print("=" * 65)
    print(f"  PHASE FAILED: {current}")
    print(f"  Error: {error_message}")
    print("  Pipeline is now BLOCKED (manual-fail).")
    print("  Fix the issue, then run:")
    print("    python meta/meta-orchestrator.py --unblock --code <code> --reason <reason>")
    print("=" * 65)
    print()
    return state


def add_error(error_message: str) -> dict:
    current = load_state().get("current_phase", "INTERPRET")
    state = commit([{"type": "error/recorded", "phase": current,
                     "payload": {"phase": current, "message": error_message}}])
    print(f"  Error recorded for {current}: {error_message}")
    return state


def unblock_pipeline(code: str, reason: str) -> dict:
    state = commit([
        {"type": "meta/set", "phase": None,
         "payload": {"key": "blocked_code", "value": None}},
        {"type": "meta/set", "phase": None,
         "payload": {"key": "blocked_reason", "value": None}},
        {"type": "meta/set", "phase": None,
         "payload": {"key": "consecutive_blocked", "value": 0}},
    ])
    print(f"Pipeline unblocked ({code}: {reason}). Current phase: {state['current_phase']}")
    return state


def pause_pipeline() -> dict:
    state = commit([{"type": "meta/set", "phase": None,
                     "payload": {"key": "paused", "value": True}}])
    print("Pipeline PAUSED. Resume with: python meta/meta-orchestrator.py --resume")
    return state


def resume_pipeline() -> dict:
    state = commit([{"type": "meta/set", "phase": None,
                     "payload": {"key": "paused", "value": False}}])
    print(f"Pipeline resumed. Current phase: {state['current_phase']}")
    return state


def refuse_advance(state: dict, phase: str, code: str, reason: str) -> dict:
    state = commit([{"type": "phase/refused", "phase": phase,
                     "payload": {"from": phase, "code": code, "reason": reason}}])
    n = state.get("consecutive_blocked", 0)
    print()
    print("=" * 65)
    print(f"  ADVANCE REFUSED: {phase} -> next")
    print(f"  Code: {code}")
    print(f"  Reason: {reason}")
    print(f"  Consecutive refusals with this code: {n}/{state_fold.BLOCK_AFTER_ROUNDS}")
    if state.get("status") == "blocked":
        print("  PIPELINE IS NOW BLOCKED.")
    print("  Fix the issue, then re-run: python meta/meta-orchestrator.py --advance")
    print("=" * 65)
    print()
    return state


def advance_phase(auto_run: bool = True) -> dict:
    state = load_state()
    current = state.get("current_phase", "INTERPRET")
    idx = get_current_phase_index(state)

    if state.get("status") == "blocked":
        print()
        print("=" * 65)
        print(f"  PIPELINE IS BLOCKED ({state.get('blocked_code')}).")
        print(f"  {state.get('blocked_reason', '')}")
        print("  Diagnose and fix the issue, then:")
        print("    python meta/meta-orchestrator.py --unblock --code <code> --reason <reason>")
        print("=" * 65)
        print()
        return state

    if current == "INTERPRET" and not state.get("acceptance_criteria"):
        print()
        print("=" * 65)
        print("  BLOCKED: Cannot advance from INTERPRET without acceptance criteria.")
        print("  Run: python meta/meta-orchestrator.py --save-acceptance-criteria \"<criteria>\"")
        print("  Or:  python meta/meta-orchestrator.py --interpret-intent \"<raw intent>\"")
        print("=" * 65)
        print()
        return state

    # Goal semantics: round cap bounds auto-continuation.
    if state.get("rounds", 0) >= state.get("max_rounds", state_fold.DEFAULT_MAX_ROUNDS):
        return refuse_advance(state, current, "round-limit",
                              f"rounds {state['rounds']} reached max_rounds "
                              f"{state.get('max_rounds')}")

    if idx + 1 >= len(PIPELINE_PHASES):
        # Last phase -> complete.
        state = commit([{"type": "phase/advance", "phase": current,
                         "payload": {"from": current, "to": None}}])
        run_observer_hooks(state, "phase-complete", "phase-complete", current, None)
        print()
        print("=" * 65)
        print("  PIPELINE COMPLETE")
        print("  All phases executed.")
        print("=" * 65)
        print()
        return state

    nxt = PIPELINE_PHASES[idx + 1]["id"]

    # Pre-advance bail gate (WP2): hooks may reject with a stable code.
    ok, code, reason = run_pre_advance_hooks(state, current, nxt)
    if not ok:
        return refuse_advance(state, current, code, reason)

    state = commit([{"type": "phase/advance", "phase": current,
                     "payload": {"from": current, "to": nxt}}])

    print()
    print("=" * 65)
    print(f"  PHASE COMPLETE: {current}")
    print(f"  ADVANCING TO:   {nxt} -- {PIPELINE_PHASES[idx + 1]['description']}")
    print("=" * 65)
    print()
    print(PHASE_INSTRUCTIONS.get(nxt, f"  Execute phase: {nxt}"))
    print()
    print("=" * 65)

    run_observer_hooks(state, "phase-complete", "phase-complete", current, nxt)
    run_observer_hooks(state, "phase-enter", "phase-enter", nxt, None)

    if auto_run and nxt in PHASE_SCRIPTS:
        state = run_phase_script(state, nxt)
    return state


def show_status() -> None:
    state = load_state()
    current = state.get("current_phase", "INTERPRET")
    completed = state.get("completed_phases", [])
    total = len(PIPELINE_PHASES)
    acceptance = state.get("acceptance_criteria", [])
    verified = state.get("verified_criteria", [])

    print()
    print("=" * 65)
    print("  META-HARNESS PIPELINE STATUS")
    print("=" * 65)
    print(f"  Status:     {state.get('status', 'unknown')}")
    if state.get("blocked_code"):
        print(f"  Blocked:    {state['blocked_code']} -- {state.get('blocked_reason', '')}")
    print(f"  Project:    {state.get('project_name', '(not set)')}")
    print(f"  Generated:  {state.get('generated_project_dir', '(not yet)')}")
    print(f"  Criteria:   {len(verified)}/{len(acceptance)} verified")
    print(f"  Rounds:     {state.get('rounds', 0)}/{state.get('max_rounds', 50)}")
    print(f"  Revision:   {state.get('revision', 0)} (events: {len(load_events(LOG_FILE))})")
    print(f"  Updated:    {state.get('updated_at', 'never')}")
    print(f"  Progress:   {len(completed)}/{total} phases complete")
    print()

    for phase in PIPELINE_PHASES:
        pid = phase["id"]
        if pid in completed:
            icon = "[DONE]"
        elif pid == current:
            icon = "[HERE]"
        else:
            icon = "[    ]"
        print(f"  {icon} Phase {phase['order']}: {pid:<12} -- {phase['description']}")

    print()
    if acceptance:
        print("  Acceptance Criteria (LOCKED):")
        for i, ac in enumerate(acceptance, 1):
            check = " [V]" if ac in verified else "[ ]"
            print(f"    {check} {i}. {ac}")

    print()
    if state.get("errors"):
        print(f"  Errors: {len(state['errors'])}")
        for e in state["errors"][-3:]:
            print(f"    - {e}")

    if state.get("status") == "complete":
        print()
        print("  PIPELINE COMPLETE. All phases done.")
    elif state.get("status") == "blocked":
        print()
        print(f"  PIPELINE BLOCKED ({state.get('blocked_code')}). "
              f"Resolve errors above before continuing.")
    elif state.get("status") == "paused":
        print()
        print("  PIPELINE PAUSED. Run --resume to continue.")
    else:
        print(f"  Resume: python meta/meta-orchestrator.py --next")
    print("=" * 65)
    print()


def show_next() -> None:
    state = load_state()
    current = state.get("current_phase", "INTERPRET")
    acceptance = state.get("acceptance_criteria", [])

    print()
    print("=" * 65)
    print(f"  CURRENT PHASE: {current} ({get_current_phase_index(state) + 1}/{len(PIPELINE_PHASES)})")
    print("=" * 65)

    if acceptance:
        print()
        print("  REMINDER -- Original Acceptance Criteria (do not drift):")
        for i, ac in enumerate(acceptance, 1):
            print(f"    {i}. {ac}")
        print()

    if current in PHASE_INSTRUCTIONS:
        print(PHASE_INSTRUCTIONS[current])
    else:
        print(f"  No detailed instructions for phase: {current}")
        print(f"  Required files: {_get_phase_by_id(current).get('required_files', [])}")

    verification = _get_phase_by_id(current).get("verification")
    if verification:
        print(f"  Verification: {verification}")

    print("=" * 65)
    print()


def show_events() -> None:
    events = load_events(LOG_FILE)
    print(f"\n  EVENT LOG ({LOG_FILE}) -- {len(events)} events")
    print("=" * 65)
    for ev in events:
        payload = json.dumps(ev.get("payload", {}), ensure_ascii=False)
        print(f"  [{ev['seq']:>3}] {ev['ts']}  {ev['type']:<18} phase={ev.get('phase')} {payload}")
    print("=" * 65)
    print()


def check_invariants() -> int:
    cmd = [sys.executable, str(SCRIPTS_DIR / "log_invariant.py"),
           "--log", str(LOG_FILE), "--state", str(STATE_FILE), "--brief", str(BRIEF_FILE)]
    proc = subprocess.run(cmd, cwd=str(META_ROOT), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="")
    return proc.returncode


def compact_context() -> int:
    """Regenerate the brief as a lock-bracketed compaction (WP7)."""
    cmd = [sys.executable, str(SCRIPTS_DIR / "compact_context.py"),
           "--log", str(LOG_FILE), "--state", str(STATE_FILE), "--brief", str(BRIEF_FILE)]
    proc = subprocess.run(cmd, cwd=str(META_ROOT), capture_output=False)
    return proc.returncode


def compact_log(keep_last: int) -> int:
    """P2#9: checkpoint-compact the event log to bound its growth, then refresh
    projections at the new watermark."""
    new_len = state_fold.compact_log(LOG_FILE, keep_last=keep_last)
    if new_len:
        state = fold(load_events(LOG_FILE))
        _refresh(state)
    print(f"log compacted (keep_last={keep_last}, len={new_len or 'no-op'})")
    return 0


def reset_pipeline() -> dict:
    for p in (LOG_FILE, STATE_FILE, BRIEF_FILE):
        if p.exists():
            p.unlink()
    state = load_state()  # bootstraps a fresh phase/start INTERPRET log
    print("Pipeline reset to initial state (INTERPRET). Fresh event log created.")
    return state


def get_current_phase_index(state: dict) -> int:
    current = state.get("current_phase", "INTERPRET")
    for i, phase in enumerate(PIPELINE_PHASES):
        if phase["id"] == current:
            return i
    return 0


def _get_phase_by_id(phase_id: str) -> dict:
    for p in PIPELINE_PHASES:
        if p["id"] == phase_id:
            return p
    return {}


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="Meta-Orchestrator v3.0 -- event-log driven pipeline",
        epilog="Log is truth; state and brief are projections. Fail-closed, CAS, goal semantics.",
    )
    parser.add_argument("--status", action="store_true", help="Show current pipeline status")
    parser.add_argument("--next", action="store_true", help="Show detailed instructions for current phase")
    parser.add_argument("--advance", action="store_true", help="Mark current phase complete and advance (auto-runs next phase script)")
    parser.add_argument("--no-auto-run", action="store_true", help="With --advance: skip auto-running the next phase script")
    parser.add_argument("--interpret-intent", default=None, metavar="INTENT",
                        help="Run the interpreter on a raw intent string; locks criteria + writes task.yaml")
    parser.add_argument("--reset", action="store_true", help="Reset pipeline to initial state (new event log)")
    parser.add_argument("--force-phase", default=None, metavar="PHASE",
                        help="Force jump to a specific phase (auditable phase/force event)")
    parser.add_argument("--set-project", default=None, metavar="NAME", help="Set the project name")
    parser.add_argument("--set-generated-dir", default=None, metavar="DIR",
                        help="Set the generated project directory")
    parser.add_argument("--save-acceptance-criteria", default=None, metavar="CRITERIA",
                        help="Lock in acceptance criteria (semicolon-separated)")
    parser.add_argument("--verify-criterion", default=None, type=int, metavar="N",
                        help="Mark criterion N as verified")
    parser.add_argument("--fail", default=None, metavar="ERROR",
                        help="Mark current phase as failed with error message (blocks immediately)")
    parser.add_argument("--add-error", default=None, metavar="ERROR",
                        help="Add non-blocking error/warning record")
    parser.add_argument("--unblock", action="store_true",
                        help="Unblock pipeline after fixing errors (record --code/--reason)")
    parser.add_argument("--code", default="manual", metavar="CODE",
                        help="Stable machine code for --unblock (default: manual)")
    parser.add_argument("--reason", default="manual unblock", metavar="REASON",
                        help="Human-readable reason for --unblock")
    parser.add_argument("--pause", action="store_true", help="Pause the pipeline")
    parser.add_argument("--resume", action="store_true", help="Resume a paused pipeline")
    parser.add_argument("--events", action="store_true", help="Dump the append-only event log")
    parser.add_argument("--check-invariants", action="store_true",
                        help="Run scripts/log_invariant.py (fail-closed checks)")
    parser.add_argument("--compact", action="store_true",
                        help="Regenerate the brief as a lock-bracketed compaction (WP7)")
    parser.add_argument("--compact-log", type=int, default=0, metavar="KEEP_LAST",
                        help="Checkpoint-compact the event log keeping the last N events (P2#9)")
    args = parser.parse_args()

    if args.reset:
        reset_pipeline()
        show_status()
        return

    if args.set_project:
        commit([{"type": "meta/set", "phase": None,
                 "payload": {"key": "project_name", "value": args.set_project}}])
        print(f"Project name set to: {args.set_project}")
        return

    if args.set_generated_dir:
        commit([{"type": "meta/set", "phase": None,
                 "payload": {"key": "generated_project_dir", "value": args.set_generated_dir}}])
        print(f"Generated project dir set to: {args.set_generated_dir}")
        return

    if args.save_acceptance_criteria:
        state = save_acceptance_criteria(args.save_acceptance_criteria)
        show_status()
        return

    if args.interpret_intent:
        state = interpret_intent(args.interpret_intent)
        show_status()
        return

    if args.verify_criterion is not None:
        state = verify_criterion(args.verify_criterion)
        show_status()
        return

    if args.fail:
        state = fail_phase(args.fail)
        show_status()
        return

    if args.add_error:
        state = add_error(args.add_error)
        show_status()
        return

    if args.unblock:
        state = unblock_pipeline(args.code, args.reason)
        show_status()
        return

    if args.pause:
        pause_pipeline()
        return

    if args.resume:
        resume_pipeline()
        return

    if args.force_phase:
        state = force_phase(args.force_phase)
        show_status()
        return

    if args.check_invariants:
        sys.exit(check_invariants())

    if args.compact:
        sys.exit(compact_context())

    if args.compact_log:
        sys.exit(compact_log(args.compact_log))

    if args.events:
        show_events()
        return

    if args.status:
        show_status()
        return

    if args.next:
        show_next()
        return

    if args.advance:
        advance_phase(auto_run=not args.no_auto_run)
        return

    show_status()


if __name__ == "__main__":
    main()
