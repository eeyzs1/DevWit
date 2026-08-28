#!/usr/bin/env python3
"""
LOG-INVARIANT: fail-closed invariant checks on the phase event log (WP1).

Mirrors DSH's runtime invariant companions: one mechanical checker per owning
stage, failing with a stable `code`, never silently passing. Unknown shapes are
REFUSED, never guessed.

Checks:
  INVARIANT_LOG_VERSION   unknown log version
  INVARIANT_SEQ_GAP       seq not contiguous / duplicate / out of order
  INVARIANT_UNKNOWN_EVENT unknown event type
  INVARIANT_UNKNOWN_PHASE fold produced a phase outside the pipeline
  INVARIANT_STALE_STATE   pipeline-state.yaml revision != log length
  INVARIANT_STALE_BRIEF   PHASE_BRIEF.md asOfSeq != log length
  INVARIANT_CRITERIA      verified criterion not in locked criteria
  INVARIANT_ROUNDS        rounds exceeds max_rounds
  INVARIANT_BLOCKED       status says blocked but no blocked_code, or vice versa

Exit: 0 = PASS, 1 = FAIL (report). Usage:
    python scripts/log-invariant.py --log <event-log.yaml> [--state <pipeline-state.yaml>] [--brief <PHASE_BRIEF.md>]
"""

import argparse
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import state_fold  # noqa: E402


def check(log_path: Path, state_path: Path = None, brief_path: Path = None) -> list:
    """Return a list of (code, message) failures; empty list == PASS."""
    failures = []

    # -- log shape (fail-closed: load_events raises on bad shape)
    try:
        events = state_fold.load_events(log_path)
    except Exception as e:
        return [("INVARIANT_LOG_LOAD", str(e))]

    # -- fold and cross-checks
    state = state_fold.fold(events)

    current = state.get("current_phase")
    if current not in state_fold.PIPELINE_PHASES:
        failures.append(("INVARIANT_UNKNOWN_PHASE",
                         f"current_phase {current!r} not in {state_fold.PIPELINE_PHASES}"))

    for p in state.get("completed_phases", []):
        if p not in state_fold.PIPELINE_PHASES:
            failures.append(("INVARIANT_UNKNOWN_PHASE", f"completed phase {p!r} unknown"))

    verified = set(state.get("verified_criteria", []))
    locked = set(state.get("acceptance_criteria", []))
    if verified - locked:
        failures.append(("INVARIANT_CRITERIA",
                         f"verified criteria not in locked criteria: "
                         f"{sorted(verified - locked)}"))

    rounds = state.get("rounds", 0)
    max_rounds = state.get("max_rounds", state_fold.DEFAULT_MAX_ROUNDS)
    if rounds > max_rounds:
        failures.append(("INVARIANT_ROUNDS",
                         f"rounds {rounds} exceeds max_rounds {max_rounds}"))

    status = state.get("status")
    blocked_code = state.get("blocked_code")
    if status == "blocked" and not blocked_code:
        failures.append(("INVARIANT_BLOCKED", "status=blocked but no blocked_code"))
    if blocked_code and status != "blocked" and \
            state.get("consecutive_blocked", 0) >= state_fold.BLOCK_AFTER_ROUNDS:
        failures.append(("INVARIANT_BLOCKED",
                         f"blocked_code set ({blocked_code}) but status is {status}"))

    # -- projection file agrees with the log (state is derived, log is truth)
    if state_path is not None and state_path.exists():
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                projected = yaml.safe_load(f) or {}
            if projected.get("revision") != len(events):
                failures.append(("INVARIANT_STALE_STATE",
                                 f"{state_path} revision {projected.get('revision')} "
                                 f"!= log length {len(events)}"))
        except Exception as e:
            failures.append(("INVARIANT_STALE_STATE", f"cannot read {state_path}: {e}"))

    # -- brief watermark (model-visible <-> logged)
    if brief_path is not None and brief_path.exists():
        try:
            text = brief_path.read_text(encoding="utf-8")
            m = re.search(r"<!-- asOfSeq: (\d+) -->", text)
            if not m:
                failures.append(("INVARIANT_STALE_BRIEF",
                                 f"{brief_path} has no asOfSeq watermark"))
            elif int(m.group(1)) != len(events):
                failures.append(("INVARIANT_STALE_BRIEF",
                                 f"{brief_path} asOfSeq {m.group(1)} != log length "
                                 f"{len(events)} -- re-derive with brief-gen.py"))
        except Exception as e:
            failures.append(("INVARIANT_STALE_BRIEF", f"cannot read {brief_path}: {e}"))

    # -- orphaned compaction lock (WP7: a crash mid-summarize must be visible)
    starts = sum(1 for e in events if e["type"] == "compaction/start")
    ends = sum(1 for e in events if e["type"] == "compaction/end")
    if starts > ends:
        failures.append(("INVARIANT_ORPHAN_COMPACTION",
                         f"{starts} compaction/start but only {ends} compaction/end "
                         f"-- previous summarization crashed mid-way"))

    return failures


def main():
    parser = argparse.ArgumentParser(description="Fail-closed invariant checks on the event log")
    parser.add_argument("--log", required=True)
    parser.add_argument("--state", default=None)
    parser.add_argument("--brief", default=None)
    args = parser.parse_args()

    failures = check(Path(args.log),
                     Path(args.state) if args.state else None,
                     Path(args.brief) if args.brief else None)
    if not failures:
        print("INVARIANTS PASS")
        sys.exit(0)
    for code, msg in failures:
        print(f"FAIL [{code}] {msg}")
    sys.exit(1)


if __name__ == "__main__":
    main()
