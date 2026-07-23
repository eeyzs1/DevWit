#!/usr/bin/env python3
"""
META-ORCHESTRATOR v2.5: Drives the meta-harness pipeline with context-loss resilience.

This is THE entry point for the meta-harness. It drives the pipeline:
  INTERPRET -> GENERATE -> FACTORY -> PROVE -> JUDGE -> EVOLVE

Key features (v2.5):
- Stateful pipeline tracking (reads/writes meta/pipeline-state.yaml)
- PHASE_BRIEF.md: ultra-compact resume file survives context compression
- Acceptance criteria anchoring: prevents task drift across turns
- Auto-advance: phase N completes -> automatically starts phase N+1
- Checkpoint enforcement: no phase can be skipped
- force_phase resets verified_criteria to prevent stale evidence
- --interpret-intent: scripted INTERPRET entry (runs interpret.py, locks criteria)
- --advance auto-runs the next phase's script (generate/agent-factory/verify/judge/evolve)

Usage:
    python meta/meta-orchestrator.py --status
    python meta/meta-orchestrator.py --interpret-intent "I need a REST API for orders"
    python meta/meta-orchestrator.py --next
    python meta/meta-orchestrator.py --advance            # auto-runs next phase script
    python meta/meta-orchestrator.py --advance --no-auto-run  # advance without auto-run
    python meta/meta-orchestrator.py --save-acceptance-criteria "<criteria>"
    python meta/meta-orchestrator.py --reset
    python meta/meta-orchestrator.py --force-phase GENERATE
"""

import argparse
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

META_ROOT = Path(__file__).resolve().parent.parent
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
7. When confirmed, run: python meta/meta-orchestrator.py --advance
""",
    "GENERATE": """
PHASE: GENERATE -- Task -> Executable Harness Project (v2 LLM-driven flow)
=========================================================================
3-step flow (scaffold + LLM author + validate). --advance only auto-runs step 1.

STEP 1 (auto-run by --advance): scaffold.py
  - python scripts/scaffold.py --task task.yaml --output generated/[project-name]
  - 输出：通用原语 + 25 个 LLM slot 基线 + harness-scaffold.yaml manifest

STEP 2 (LLM must execute manually — script cannot do this):
  - 读 meta/harness-author.md 的填充规范
  - 读 generated/[project-name]/harness-scaffold.yaml 的 slot guidance
  - 为每个 slot 改写出项目特定内容（NO mock，NO 通用占位）
  - 重点 slot：planning/work-units.yaml, planning/sub-agent-dispatch.yaml,
    constraints/architecture-rules.yaml, verification/security-guardrails.yaml

STEP 3 (manual before --advance to FACTORY): validate-harness.py
  - python scripts/validate-harness.py generated/[project-name]
  - 必须 PASS 才能进入 FACTORY 阶段（pre-advance gate 会强制检查）
  - 若 FAIL：按 errors 修复 slot，重跑校验

When all 3 steps pass:
  python meta/meta-orchestrator.py --advance
""",
    "FACTORY": """
PHASE: FACTORY -- Harness -> Agent Configurations
=================================================
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
4. Run: python seeds/verification/quality-gate.py (if available)
5. Format evidence as YAML with criterion -> evidence -> verdict
6. When all evidence collected, run: python meta/meta-orchestrator.py --advance
""",
    "JUDGE": """
PHASE: JUDGE -- Evidence -> Verdict
==================================
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


# ============================================================
# Phase script automation (Design 6)
# ============================================================
# Maps each phase to the script that automates it. --advance runs the
# NEXT phase's script after advancing, so the pipeline can progress
# without manual script invocation. INTERPRET is special: it needs an
# intent string (use --interpret-intent instead of --advance to start).

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
        "args": lambda state: [state.get("generated_project_dir") or "."],
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


def run_phase_script(state: dict, phase_id: str) -> dict:
    """Run the automation script for the given phase.

    Best-effort: on failure, records an error in state but does NOT block
    the advance. The agent can review output, fix issues, and re-run the
    script manually. Returns the updated state.
    """
    spec = PHASE_SCRIPTS.get(phase_id)
    if not spec:
        # INTERPRET has no auto-script (needs human intent input);
        # unknown phases have nothing to run.
        return state

    script_path = META_ROOT / spec["script"]
    if not script_path.exists():
        msg = f"Phase script not found: {spec['script']}"
        state["errors"].append(f"[{phase_id}] {datetime.now().isoformat()}: {msg}")
        print(f"  ⚠️  {msg}")
        save_state(state)
        return state

    # Build args; skip if a required arg (e.g. generated_project_dir) is missing.
    try:
        args = spec["args"](state)
    except Exception as e:
        msg = f"Could not build args for {phase_id}: {e}"
        state["errors"].append(f"[{phase_id}] {datetime.now().isoformat()}: {msg}")
        print(f"  ⚠️  {msg}")
        save_state(state)
        return state

    if phase_id in ("FACTORY", "PROVE", "JUDGE") and not state.get("generated_project_dir"):
        msg = f"Cannot run {phase_id}: generated_project_dir not set (run GENERATE first)"
        state["errors"].append(f"[{phase_id}] {datetime.now().isoformat()}: {msg}")
        print(f"  ⚠️  {msg}")
        save_state(state)
        return state

    cmd = [sys.executable, str(script_path)] + args
    print(f"\n  ▶️  Auto-running {phase_id}: {' '.join(cmd)}")
    print("  " + "-" * 60)
    try:
        result = subprocess.run(cmd, cwd=str(META_ROOT), capture_output=False)
        exit_code = result.returncode
    except Exception as e:
        msg = f"Phase script crashed: {e}"
        state["errors"].append(f"[{phase_id}] {datetime.now().isoformat()}: {msg}")
        print(f"  ❌ {msg}")
        save_state(state)
        return state

    print("  " + "-" * 60)
    if exit_code != 0:
        msg = f"Phase script exited with code {exit_code}"
        state["errors"].append(f"[{phase_id}] {datetime.now().isoformat()}: {msg}")
        print(f"  ⚠️  {msg} — review output above, fix, and re-run manually if needed.")
        save_state(state)
        return state

    # Post-run state updates.
    print(f"  ✅ {phase_id} script completed successfully.")
    if spec.get("sets_state") == "generated_project_dir":
        # Detect the generated project dir from task.yaml name.
        generated_dir = _detect_generated_dir()
        if generated_dir:
            state["generated_project_dir"] = str(generated_dir)
            print(f"  📁 Generated project dir: {generated_dir}")

    state["phase_history"].append({
        "phase": phase_id,
        "action": "script_executed",
        "timestamp": datetime.now().isoformat(),
    })
    save_state(state)
    return state


def _detect_generated_dir() -> Path:
    """Find the most recently created generated/<project-name>/ directory."""
    generated_root = META_ROOT / "generated"
    if not generated_root.exists():
        return None
    candidates = [d for d in generated_root.iterdir() if d.is_dir() and (d / ".harness-generated").exists()]
    if not candidates:
        return None
    # Return the most recently modified one.
    return max(candidates, key=lambda d: d.stat().st_mtime)


def _infer_output_dir(state: dict) -> str:
    """Infer the GENERATE output dir from task.yaml BEFORE scaffold runs.

    Reads task.yaml's `name` field (or falls back to state.project_name),
    sanitizes it for use as a directory name, and returns
    generated/<sanitized-name>. This is what --advance passes to
    scaffold.py's --output arg. Post-run, _detect_generated_dir() re-detects
    the actual dir from the .harness-generated marker (robust to renames).
    """
    if not TASK_FILE.exists():
        raise RuntimeError("task.yaml not found -- run INTERPRET first")
    with open(TASK_FILE, "r", encoding="utf-8") as f:
        task = yaml.safe_load(f) or {}
    name = task.get("name") or state.get("project_name") or "unnamed"
    # Mirror scaffold.py's filename sanitization intent: keep it a valid
    # directory name across platforms.
    sanitized = re.sub(r"[^a-zA-Z0-9._-]", "-", str(name)).strip("-").lower() or "unnamed"
    return str(META_ROOT / "generated" / sanitized)


def _run_generate_advance_gate(state: dict) -> dict:
    """Run validate-harness.py as the GENERATE -> FACTORY pre-advance gate.

    Returns {"passed": bool, "reason": str}. The gate enforces that Step 2
    (LLM-authored slot fills) and Step 3 (validate-harness.py PASS) are
    complete before the pipeline advances. Without this, FACTORY would run
    on a half-scaffolded harness (mock placeholders, missing work-units,
    broken DAG refs) and produce garbage agent configs.

    Failures here are blocking (unlike run_phase_script best-effort), because
    advancing past GENERATE with a non-validating harness is task drift.
    """
    gen_dir = state.get("generated_project_dir")
    if not gen_dir:
        return {"passed": False,
                "reason": "generated_project_dir not set (run scaffold.py Step 1 first)"}
    gen_path = Path(gen_dir)
    if not gen_path.exists():
        return {"passed": False, "reason": f"directory does not exist: {gen_dir}"}

    validate_script = META_ROOT / "scripts" / "validate-harness.py"
    if not validate_script.exists():
        return {"passed": False,
                "reason": f"validate-harness.py not found at {validate_script}"}

    cmd = [sys.executable, str(validate_script), str(gen_path)]
    print("\n  🚦 Pre-advance gate: running validate-harness.py (GENERATE Step 3)")
    print("  " + "-" * 60)
    try:
        result = subprocess.run(cmd, cwd=str(META_ROOT), capture_output=False)
    except Exception as e:
        return {"passed": False, "reason": f"validate-harness.py crashed: {e}"}
    print("  " + "-" * 60)

    if result.returncode != 0:
        return {"passed": False,
                "reason": f"validate-harness.py exited with code {result.returncode} -- see output above"}
    return {"passed": True, "reason": "validate-harness.py PASSed"}


def interpret_intent(state: dict, intent: str) -> dict:
    """Run the interpreter on a raw intent string.

    Calls scripts/interpret.py to produce a structured task definition,
    writes it to task.yaml, locks the acceptance criteria, and sets the
    project name. This is the scripted entry point for the INTERPRET phase.
    """
    script_path = META_ROOT / "scripts" / "interpret.py"
    if not script_path.exists():
        print(f"ERROR: interpret.py not found at {script_path}")
        return state

    cmd = [sys.executable, str(script_path), "--intent", intent, "--output", str(TASK_FILE)]
    print(f"\n  ▶️  Running interpreter: {intent[:80]}...")
    print("  " + "-" * 60)
    try:
        result = subprocess.run(cmd, cwd=str(META_ROOT), capture_output=False)
    except Exception as e:
        print(f"  ❌ Interpreter crashed: {e}")
        return state
    print("  " + "-" * 60)

    if result.returncode != 0:
        print(f"  ❌ Interpreter exited with code {result.returncode}")
        return state

    # Read the generated task.yaml to lock criteria + set project name.
    if not TASK_FILE.exists():
        print(f"  ❌ Interpreter did not produce {TASK_FILE}")
        return state

    with open(TASK_FILE, "r", encoding="utf-8") as f:
        task = yaml.safe_load(f) or {}

    criteria = task.get("acceptance_criteria", [])
    if not criteria:
        print("  ⚠️  Interpreter produced no acceptance criteria.")
        return state

    state["acceptance_criteria"] = criteria
    state["verified_criteria"] = []
    state["project_name"] = task.get("name", "unnamed")
    state["phase_history"].append({
        "phase": "INTERPRET",
        "action": "interpreted",
        "timestamp": datetime.now().isoformat(),
    })
    save_state(state)

    print(f"\n  ✅ Interpretation complete.")
    print(f"  Project: {state['project_name']}")
    print(f"  Domain: {task.get('domain', 'unknown')}")
    print(f"  Scale: {task.get('scale', 'unknown')}")
    print(f"  Quality attributes: {task.get('quality_attributes', [])}")
    print(f"  Acceptance criteria LOCKED ({len(criteria)} total):")
    for i, c in enumerate(criteria, 1):
        print(f"    {i}. {c}")
    print(f"\n  Task definition written to: {TASK_FILE}")
    print(f"  Confirm criteria with the user, then run: --advance")
    return state


# ============================================================
# PHASE_BRIEF.md -- the context-loss survival mechanism
# ============================================================
# This file is written on every state change. It is designed to be
# SHORT (under 10 lines) so that even if the agent's context window
# is compressed to just AGENTS.md + a few lines, this file can still
# be read and the agent can resume from exactly where it left off.
#
# The file also includes the ORIGINAL acceptance criteria (locked
# during INTERPRET) so the agent can always check for task drift.

def write_phase_brief(state: dict) -> None:
    """Write the ultra-compact resume file for context-loss recovery."""
    current = state.get("current_phase", "INTERPRET")
    completed = state.get("completed_phases", [])
    total = len(PIPELINE_PHASES)
    current_idx = get_current_phase_index(state)
    status = state.get("status", "ready")
    project = state.get("project_name") or "(not set)"
    gen_dir = state.get("generated_project_dir") or "(not yet)"
    acceptance = state.get("acceptance_criteria", [])
    verified = state.get("verified_criteria", [])
    phase_info = _get_phase_by_id(current)

    lines = [
        "# Meta-Harness Resume Point",
        f"Phase: {current} ({current_idx + 1}/{total})",
        f"Status: {status}",
        f"Project: {project}",
        f"Generated: {gen_dir}",
        f"Acceptance criteria: {len(acceptance)} total, {len(verified)} verified",
    ]

    if acceptance:
        lines.append("")
        lines.append("## Original Acceptance Criteria (LOCKED -- do not drift)")
        for i, ac in enumerate(acceptance, 1):
            checked = " [VERIFIED]" if ac in verified else ""
            lines.append(f"{i}. {ac}{checked}")

    lines.append("")
    lines.append("## Next Action")
    if status == "complete":
        lines.append("PIPELINE COMPLETE. All phases done. Stop.")
    elif status == "blocked":
        lines.append("PIPELINE BLOCKED. Check meta/pipeline-state.yaml for errors.")
    else:
        lines.append(f"Execute phase: {current}")
        lines.append(f"Required files: {', '.join(phase_info.get('required_files', []))}")
        if phase_info.get("verification"):
            lines.append(f"Verification: {phase_info['verification']}")
        lines.append(f"After completion: python meta/meta-orchestrator.py --advance")

    lines.append("")
    lines.append("## Task Drift Check")
    lines.append("Before ANY work, re-read the acceptance criteria above.")
    lines.append("If your current action does NOT trace to a criterion, STOP and re-align.")

    BRIEF_FILE.parent.mkdir(parents=True, exist_ok=True)
    BRIEF_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ============================================================
# Core state management
# ============================================================

def load_state() -> dict:
    """Load pipeline state from meta/pipeline-state.yaml"""
    if not STATE_FILE.exists():
        return _default_state()
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        state = yaml.safe_load(f) or {}
    defaults = _default_state()
    for key in defaults:
        if key not in state:
            state[key] = defaults[key]
    return state


def save_state(state: dict) -> None:
    """Save pipeline state to meta/pipeline-state.yaml + write PHASE_BRIEF.md"""
    state["updated_at"] = datetime.now().isoformat()
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        yaml.dump(state, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    write_phase_brief(state)


def _default_state() -> dict:
    return {
        "pipeline_version": "2.5.0",
        "current_phase": "INTERPRET",
        "phase_order": [p["id"] for p in PIPELINE_PHASES],
        "completed_phases": [],
        "phase_history": [],
        "status": "ready",
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "project_name": None,
        "generated_project_dir": None,
        "acceptance_criteria": [],
        "verified_criteria": [],
        "errors": [],
    }


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
# Commands
# ============================================================

def show_status(state: dict) -> None:
    current = state.get("current_phase", "INTERPRET")
    completed = state.get("completed_phases", [])
    total = len(PIPELINE_PHASES)
    done_count = len(completed)
    acceptance = state.get("acceptance_criteria", [])
    verified = state.get("verified_criteria", [])

    print()
    print("=" * 65)
    print("  META-HARNESS PIPELINE STATUS")
    print("=" * 65)
    print(f"  Status:     {state.get('status', 'unknown')}")
    print(f"  Project:    {state.get('project_name', '(not set)')}")
    print(f"  Generated:  {state.get('generated_project_dir', '(not yet)')}")
    print(f"  Criteria:   {len(verified)}/{len(acceptance)} verified")
    print(f"  Updated:    {state.get('updated_at', 'never')}")
    print(f"  Progress:   {done_count}/{total} phases complete")
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
        print("  PIPELINE BLOCKED. Resolve errors above before continuing.")
    else:
        print(f"  Resume: python meta/meta-orchestrator.py --next")
    print("=" * 65)
    print()

    write_phase_brief(state)


def show_next(state: dict) -> None:
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

    write_phase_brief(state)


def advance_phase(state: dict, auto_run: bool = True) -> dict:
    current = state.get("current_phase", "INTERPRET")
    completed = state.get("completed_phases", [])
    current_idx = get_current_phase_index(state)

    # Guard: INTERPRET must have locked acceptance criteria before advancing
    if current == "INTERPRET" and not state.get("acceptance_criteria"):
        print()
        print("=" * 65)
        print("  BLOCKED: Cannot advance from INTERPRET without acceptance criteria.")
        print("  Run: python meta/meta-orchestrator.py --save-acceptance-criteria \"<criteria>\"")
        print("  Or:  python meta/meta-orchestrator.py --interpret-intent \"<raw intent>\"")
        print("=" * 65)
        print()
        return state

    # PRE-ADVANCE GATE: GENERATE -> FACTORY requires validate-harness.py PASS.
    # The GENERATE phase is 3 steps (scaffold + LLM-author + validate). Step 1
    # is auto-run; Step 2 (LLM slot fills) is manual; Step 3 is the gate.
    # Without this gate, --advance from GENERATE would let FACTORY run on a
    # half-filled harness (mock placeholders, missing work-units.yaml, etc.).
    if current == "GENERATE":
        gate = _run_generate_advance_gate(state)
        if not gate["passed"]:
            print()
            print("=" * 65)
            print("  BLOCKED: GENERATE pre-advance gate failed.")
            print(f"  Reason: {gate['reason']}")
            print("  The harness must PASS validate-harness.py before FACTORY.")
            print("  Fix the slot fills above, then re-run:")
            print("    python scripts/validate-harness.py <generated-project-dir>")
            print("  Once it PASSes, re-run:")
            print("    python meta/meta-orchestrator.py --advance")
            print("=" * 65)
            print()
            state["errors"].append(
                f"[GENERATE] {datetime.now().isoformat()}: pre-advance gate failed: {gate['reason']}"
            )
            save_state(state)
            return state

    timestamp = datetime.now().isoformat()
    if current not in completed:
        completed.append(current)

    state["phase_history"].append({
        "phase": current,
        "action": "completed",
        "timestamp": timestamp,
    })

    state["completed_phases"] = completed
    state["status"] = "in_progress"

    if current_idx + 1 >= len(PIPELINE_PHASES):
        state["current_phase"] = current
        state["status"] = "complete"
        state["completed_phases"] = [p["id"] for p in PIPELINE_PHASES]
        print()
        print("=" * 65)
        print("  PIPELINE COMPLETE")
        print("  All 6 phases executed.")
        print("=" * 65)
        print()
        save_state(state)
        return state

    next_phase = PIPELINE_PHASES[current_idx + 1]
    state["current_phase"] = next_phase["id"]

    print()
    print("=" * 65)
    print(f"  PHASE COMPLETE: {current}")
    print(f"  ADVANCING TO:   {next_phase['id']} -- {next_phase['description']}")
    print("=" * 65)
    print()
    print(PHASE_INSTRUCTIONS.get(next_phase["id"], f"  Execute phase: {next_phase['id']}"))
    print()
    print("=" * 65)

    save_state(state)

    # Auto-run the next phase's script (Design 6). Best-effort: failures
    # are recorded in state["errors"] but do not block the advance. The
    # agent can review output and re-run manually. Use --no-auto-run to skip.
    if auto_run and next_phase["id"] in PHASE_SCRIPTS:
        state = run_phase_script(state, next_phase["id"])

    return state


def save_acceptance_criteria(state: dict, criteria_text: str) -> dict:
    """Lock in the original acceptance criteria to prevent task drift."""
    criteria = [c.strip() for c in criteria_text.split(";") if c.strip()]
    if not criteria:
        criteria = [criteria_text.strip()]

    state["acceptance_criteria"] = criteria
    state["verified_criteria"] = []
    save_state(state)

    print()
    print(f"  Acceptance criteria LOCKED ({len(criteria)} total):")
    for i, c in enumerate(criteria, 1):
        print(f"    {i}. {c}")
    print()
    print("  These criteria will be checked at every phase boundary.")
    print("  The agent CANNOT drift from these criteria.")
    print()
    return state


def verify_criterion(state: dict, criterion_index: int) -> dict:
    """Mark a specific criterion as verified."""
    criteria = state.get("acceptance_criteria", [])
    verified = state.get("verified_criteria", [])

    if criterion_index < 1 or criterion_index > len(criteria):
        print(f"ERROR: Invalid criterion index {criterion_index}. Valid: 1-{len(criteria)}")
        return state

    criterion = criteria[criterion_index - 1]
    # Compare on stripped values so trailing whitespace / line-ending
    # differences from YAML round-trips do not break matching.
    normalized = criterion.strip()
    normalized_verified = [v.strip() for v in verified]
    if normalized not in normalized_verified:
        verified.append(criterion)
        state["verified_criteria"] = verified
        print(f"  Criterion {criterion_index} VERIFIED: {criterion}")
    else:
        print(f"  Criterion {criterion_index} already verified: {criterion}")

    save_state(state)
    return state


def force_phase(state: dict, phase_id: str) -> dict:
    valid_ids = [p["id"] for p in PIPELINE_PHASES]
    if phase_id not in valid_ids:
        print(f"ERROR: Invalid phase '{phase_id}'. Valid: {', '.join(valid_ids)}")
        return state

    target_idx = next(i for i, p in enumerate(PIPELINE_PHASES) if p["id"] == phase_id)
    state["current_phase"] = phase_id
    state["completed_phases"] = [p["id"] for p in PIPELINE_PHASES[:target_idx]]
    state["status"] = "in_progress"
    # Reset verified criteria so stale evidence from a prior run does not
    # mislead the agent into thinking criteria are already satisfied.
    state["verified_criteria"] = []
    state["phase_history"].append({
        "phase": phase_id,
        "action": "force_jump",
        "timestamp": datetime.now().isoformat(),
    })

    print(f"Forced jump to phase: {phase_id}")
    save_state(state)
    return state


def fail_phase(state: dict, error_message: str) -> dict:
    """Mark the current phase as failed and block the pipeline."""
    current = state.get("current_phase", "INTERPRET")
    state["status"] = "blocked"
    timestamp = datetime.now().isoformat()
    state["errors"].append(f"[{current}] {timestamp}: {error_message}")
    state["phase_history"].append({
        "phase": current,
        "action": "failed",
        "error": error_message,
        "timestamp": timestamp,
    })
    save_state(state)
    print()
    print("=" * 65)
    print(f"  PHASE FAILED: {current}")
    print(f"  Error: {error_message}")
    print(f"  Pipeline is now BLOCKED.")
    print(f"  Fix the issue, then run: python meta/meta-orchestrator.py --unblock")
    print("=" * 65)
    print()
    return state


def add_error(state: dict, error_message: str) -> dict:
    """Add a non-blocking error/warning to the current phase."""
    current = state.get("current_phase", "INTERPRET")
    timestamp = datetime.now().isoformat()
    state["errors"].append(f"[{current}] {timestamp}: {error_message}")
    save_state(state)
    print(f"  Error recorded for {current}: {error_message}")
    return state


def unblock_pipeline(state: dict) -> dict:
    """Unblock pipeline after fixing errors."""
    state["status"] = "in_progress"
    state["phase_history"].append({
        "phase": state.get("current_phase", "INTERPRET"),
        "action": "unblocked",
        "timestamp": datetime.now().isoformat(),
    })
    save_state(state)
    print(f"Pipeline unblocked. Current phase: {state['current_phase']}")
    return state


def reset_pipeline() -> dict:
    state = _default_state()
    # Also clear the brief file
    if BRIEF_FILE.exists():
        BRIEF_FILE.unlink()
    save_state(state)
    print("Pipeline reset to initial state (INTERPRET).")
    return state


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="Meta-Orchestrator v2.5 -- Drives the meta-harness pipeline",
        epilog="Context-loss resilient. PHASE_BRIEF.md survives compression.",
    )
    parser.add_argument("--status", action="store_true", help="Show current pipeline status")
    parser.add_argument("--next", action="store_true", help="Show detailed instructions for current phase")
    parser.add_argument("--advance", action="store_true", help="Mark current phase complete and advance (auto-runs next phase script)")
    parser.add_argument("--no-auto-run", action="store_true", help="With --advance: skip auto-running the next phase script")
    parser.add_argument("--interpret-intent", default=None, metavar="INTENT",
                        help="Run the interpreter on a raw intent string; locks criteria + writes task.yaml")
    parser.add_argument("--reset", action="store_true", help="Reset pipeline to initial state")
    parser.add_argument("--force-phase", default=None, metavar="PHASE",
                        help="Force jump to a specific phase")
    parser.add_argument("--set-project", default=None, metavar="NAME",
                        help="Set the project name in pipeline state")
    parser.add_argument("--set-generated-dir", default=None, metavar="DIR",
                        help="Set the generated project directory")
    parser.add_argument("--save-acceptance-criteria", default=None, metavar="CRITERIA",
                        help="Lock in acceptance criteria (semicolon-separated)")
    parser.add_argument("--verify-criterion", default=None, type=int, metavar="N",
                        help="Mark criterion N as verified")
    parser.add_argument("--fail", default=None, metavar="ERROR",
                        help="Mark current phase as failed with error message")
    parser.add_argument("--add-error", default=None, metavar="ERROR",
                        help="Add non-blocking error/warning record")
    parser.add_argument("--unblock", action="store_true",
                        help="Unblock pipeline after fixing errors")
    args = parser.parse_args()

    state = load_state()

    if args.reset:
        state = reset_pipeline()
        show_status(state)
        return

    if args.set_project:
        state["project_name"] = args.set_project
        save_state(state)
        print(f"Project name set to: {args.set_project}")
        return

    if args.set_generated_dir:
        state["generated_project_dir"] = args.set_generated_dir
        save_state(state)
        print(f"Generated project dir set to: {args.set_generated_dir}")
        return

    if args.save_acceptance_criteria:
        state = save_acceptance_criteria(state, args.save_acceptance_criteria)
        show_status(state)
        return

    if args.interpret_intent:
        state = interpret_intent(state, args.interpret_intent)
        show_status(state)
        return

    if args.verify_criterion is not None:
        state = verify_criterion(state, args.verify_criterion)
        show_status(state)
        return

    if args.fail:
        state = fail_phase(state, args.fail)
        show_status(state)
        return

    if args.add_error:
        state = add_error(state, args.add_error)
        show_status(state)
        return

    if args.unblock:
        state = unblock_pipeline(state)
        show_status(state)
        return

    if args.force_phase:
        state = force_phase(state, args.force_phase)
        show_status(state)
        return

    if args.status:
        show_status(state)
        return

    if args.next:
        show_next(state)
        return

    if args.advance:
        state = advance_phase(state, auto_run=not args.no_auto_run)
        return

    show_status(state)


if __name__ == "__main__":
    main()