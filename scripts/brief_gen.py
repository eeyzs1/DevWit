#!/usr/bin/env python3
"""
BRIEF-GEN: derive PHASE_BRIEF.md from the event log projection (WP1).

Implements the "model-visible <-> logged" invariant for context-loss survival:
the brief is a pure function of (event log + code), never a parallel truth.
log-invariant.py checks the watermark comment so a hand-edited or stale brief
fails the invariant instead of misleading the agent.

The brief carries `<!-- asOfSeq: N -->` where N is the log length used; the
invariant requires N == current log length.

Usage:
    python scripts/brief-gen.py --log <event-log.yaml> --state <pipeline-state.yaml> \
        --brief <PHASE_BRIEF.md> [--force]
"""

import argparse
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import state_fold  # noqa: E402

PHASE_INSTRUCTIONS = {
    "INTERPRET": "Interpret the intent, surface assumptions, lock acceptance "
                 "criteria, confirm with the user, then --advance.",
    "GENERATE": "Scaffold + LLM-authored slot fills + validate-harness.py PASS "
                "before --advance (pre-advance gate).",
    "FACTORY": "Generate agent topology from the harness, then --advance.",
    "PROVE": "Produce evidence per criterion (verify-generation.py), then --advance.",
    "JUDGE": "Judge evidence -> verdict (guard.py), then --advance.",
    "EVOLVE": "Evolve based on evidence (evolve.py), then --advance.",
}


def render_brief(state: dict) -> str:
    current = state.get("current_phase", "INTERPRET")
    completed = state.get("completed_phases", [])
    total = len(state.get("phase_order", []))
    acceptance = state.get("acceptance_criteria", [])
    verified = state.get("verified_criteria", [])
    status = state.get("status", "ready")
    project = state.get("project_name") or "(not set)"
    gen_dir = state.get("generated_project_dir") or "(not yet)"
    as_of = state.get("revision", 0)
    blocked_code = state.get("blocked_code")
    blocked_reason = state.get("blocked_reason")
    rounds = state.get("rounds", 0)
    max_rounds = state.get("max_rounds", 50)

    lines = [
        "# Meta-Harness Resume Point",
        f"<!-- asOfSeq: {as_of} -->",
        f"Phase: {current} ({len(completed) + 1}/{total})",
        f"Status: {status}",
        f"Project: {project}",
        f"Generated: {gen_dir}",
        f"Rounds: {rounds}/{max_rounds}",
        f"Acceptance criteria: {len(acceptance)} total, {len(verified)} verified",
    ]

    if blocked_code:
        lines.append(f"Blocked: {blocked_code} -- {blocked_reason}")

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
        lines.append(f"PIPELINE BLOCKED ({blocked_code}). Diagnose, fix, then "
                     f"`--unblock <code> <reason>`.")
    elif status == "paused":
        lines.append("PIPELINE PAUSED. Run `--resume` to continue.")
    else:
        lines.append(f"Execute phase: {current}")
        lines.append(PHASE_INSTRUCTIONS.get(current, ""))
        lines.append("After completion: python meta/meta-orchestrator.py --advance")

    lines.append("")
    lines.append("## Task Drift Check")
    lines.append("Before ANY work, re-read the acceptance criteria above.")
    lines.append("If your current action does NOT trace to a criterion, STOP and re-align.")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description="Derive PHASE_BRIEF.md from the event log")
    parser.add_argument("--log", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--brief", required=True)
    parser.add_argument("--force", action="store_true",
                        help="write even when the brief is already current")
    args = parser.parse_args()

    log_path, state_path, brief_path = Path(args.log), Path(args.state), Path(args.brief)
    events = state_fold.load_events(log_path)
    state = state_fold.fold(events)

    # Cross-check the projection file agrees with the fold (log is truth).
    if state_path.exists():
        with open(state_path, "r", encoding="utf-8") as f:
            projected = yaml.safe_load(f) or {}
        if projected.get("revision") != state["revision"]:
            print(f"ERROR: {state_path} is stale (revision {projected.get('revision')} "
                  f"vs log {state['revision']}) -- run state-fold to refresh")
            sys.exit(1)

    brief = render_brief(state)
    brief_path.parent.mkdir(parents=True, exist_ok=True)
    brief_path.write_text(brief, encoding="utf-8")
    print(f"brief written: {brief_path} (asOfSeq {state['revision']})")


if __name__ == "__main__":
    main()
