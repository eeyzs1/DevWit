#!/usr/bin/env python3
"""
STATE-FOLD: Append-only phase event log -> pipeline-state projection (WP1/WP3).

Borrowed from DeepSeek Harness' "session log is the single source of truth"
idea: the event log is the ONLY truth, and pipeline-state.yaml / PHASE_BRIEF.md
are derived projections. Nothing the model sees may exist without a logged event
(model-visible <-> logged).

Events are appended, never rewritten. Every mutation goes through
append_events() with an expected_revision (compare-and-set), so a stale writer
is rejected instead of silently clobbering a concurrent writer.

Event vocabulary (type -> fold handler):
    seed/import        {snapshot}                  start fold from a legacy state file
    phase/start        {phase}                     bootstrap / enter phase
    phase/advance      {from, to}                  mark phase complete, move on
    phase/refused      {from, code, reason}        a gate/hook refused the advance
    phase/force        {phase}                     admin jump (auditable escape hatch)
    phase/interrupted  {phase, reason}             crash recovery marker
    criteria/locked    {criteria, ...}             lock acceptance criteria (INTERPRET)
    criterion/verified {index, criterion}          mark one criterion verified
    meta/set           {key, value}                scalar state field (whitelist)
    guard/check        {verdict, code?, scope?}    guard/verification verdict
    pipeline/block     {code, reason}              explicit --fail
    error/recorded     {message}                   non-blocking --add-error
    mistake/recorded   {message, code?}            postmortem feedback loop record

Derived fields (never event-backed): revision, stateVersion, status,
completed_phases, phase_history, verified_criteria, errors, rounds,
consecutive_blocked, updated_at. Everything else is event-backed.

Usage:
    python scripts/state-fold.py --log <path> --fold          # print projection
    python scripts/state-fold.py --log <path> --dump          # print events
"""

import argparse
import json
import os
import sys
import tempfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

LOG_VERSION = 1

PIPELINE_PHASES = ["INTERPRET", "GENERATE", "FACTORY", "PROVE", "JUDGE", "EVOLVE"]

# meta/set is restricted to these scalar state keys.
SCALAR_KEYS = {
    "project_name", "generated_project_dir", "domain", "scale",
    "quality_attributes", "blocked_code", "blocked_reason", "paused",
    "max_rounds", "auto_advance", "consecutive_blocked",
}

EVENT_TYPES = {
    "seed/import", "phase/start", "phase/advance", "phase/refused",
    "phase/force", "phase/interrupted", "criteria/locked",
    "criterion/verified", "meta/set", "guard/check", "pipeline/block",
    "error/recorded", "mistake/recorded",
    "compaction/start", "compaction/summary", "compaction/end",
    "artifact/spilled",
}

# After this many consecutive refusals with the same code the pipeline blocks.
BLOCK_AFTER_ROUNDS = 3
DEFAULT_MAX_ROUNDS = 50


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_state() -> dict:
    return {
        "pipeline_version": "3.0.0",
        "current_phase": PIPELINE_PHASES[0],
        "phase_order": list(PIPELINE_PHASES),
        "completed_phases": [],
        "phase_history": [],
        "status": "in_progress",
        "created_at": None,
        "updated_at": None,
        "project_name": None,
        "generated_project_dir": None,
        "acceptance_criteria": [],
        "verified_criteria": [],
        "errors": [],
        "revision": 0,
        "stateVersion": 0,
        "blocked_code": None,
        "blocked_reason": None,
        "paused": False,
        "rounds": 0,
        "max_rounds": DEFAULT_MAX_ROUNDS,
        "auto_advance": True,
        "consecutive_blocked": 0,
    }


# ---------------------------------------------------------------- load/save

def load_events(log_path) -> list:
    """Load events, validating version and contiguous seq. Fail-closed."""
    log_path = Path(log_path)
    if not log_path.exists():
        return []
    with open(log_path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    if not isinstance(doc, dict):
        raise ValueError(f"{log_path}: log is not a mapping")
    if doc.get("version") != LOG_VERSION:
        raise ValueError(
            f"{log_path}: unknown log version {doc.get('version')!r} "
            f"(expected {LOG_VERSION}) -- fail-closed, refusing to guess")
    events = doc.get("events", [])
    if not isinstance(events, list):
        raise ValueError(f"{log_path}: 'events' is not a list")
    for i, ev in enumerate(events, start=1):
        if not isinstance(ev, dict):
            raise ValueError(f"{log_path}: event {i} is not a mapping")
        if ev.get("seq") != i:
            raise ValueError(
                f"{log_path}: event seq gap/duplicate at position {i}: "
                f"found {ev.get('seq')!r} -- fail-closed")
        if ev.get("type") not in EVENT_TYPES:
            raise ValueError(f"{log_path}: unknown event type {ev.get('type')!r} at seq {i}")
    return events


def save_events(log_path, events: list) -> None:
    """Write events atomically (temp file + os.replace)."""
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"version": LOG_VERSION, "events": events}
    fd, tmp = tempfile.mkstemp(dir=str(log_path.parent), prefix=".event-log-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            yaml.dump(doc, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        os.replace(tmp, log_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def append_events(log_path, new_events: list, expected_revision: int = None) -> int:
    """Append events with compare-and-set on the log length.

    Raises RevisionConflict when expected_revision does not match the current
    log length (a concurrent writer won). Returns the new revision.
    """
    log_path = Path(log_path)
    events = load_events(log_path)
    if expected_revision is not None and len(events) != expected_revision:
        raise RevisionConflict(expected_revision, len(events))
    base = len(events)
    now = _now_iso()
    for i, ev in enumerate(new_events, start=base + 1):
        if "seq" in ev:
            raise ValueError("callers must not set seq; it is assigned here")
        if ev.get("type") not in EVENT_TYPES:
            raise ValueError(f"unknown event type {ev.get('type')!r}")
        if ev.get("type") == "meta/set" and ev.get("payload", {}).get("key") not in SCALAR_KEYS:
            raise ValueError(
                f"meta/set key {ev.get('payload', {}).get('key')!r} not in whitelist "
                f"{sorted(SCALAR_KEYS)}")
        events.append({"seq": i, "ts": now, "type": ev["type"], "phase": ev.get("phase"),
                       "payload": ev.get("payload", {})})
    save_events(log_path, events)
    return len(events)


class RevisionConflict(Exception):
    """A concurrent writer changed the log between read and write."""

    def __init__(self, expected: int, actual: int):
        super().__init__(
            f"stale writer rejected: expected revision {expected}, log is at {actual} "
            f"-- re-read and retry")
        self.expected = expected
        self.actual = actual


# ---------------------------------------------------------------- fold

def fold(events: list, defaults: dict = None) -> dict:
    """Pure function: events -> state projection. Same input, same output."""
    state = deepcopy(defaults) if defaults is not None else _default_state()
    for ev in events:
        typ = ev["type"]
        payload = ev.get("payload", {})
        ts = ev.get("ts")
        if typ == "seed/import":
            snapshot = payload.get("snapshot") or {}
            merged = deepcopy(state)
            merged.update({k: v for k, v in snapshot.items()
                           if k in _default_state() or k in ("status",)})
            state = merged
        elif typ == "phase/start":
            phase = payload.get("phase")
            if phase:
                state["current_phase"] = phase
                state["phase_history"].append({
                    "phase": phase, "action": "started", "timestamp": ts,
                    "seq": ev["seq"],
                })
        elif typ == "phase/advance":
            frm, to = payload.get("from"), payload.get("to")
            if frm and frm not in state["completed_phases"]:
                state["completed_phases"].append(frm)
            if to:
                state["current_phase"] = to
            state["rounds"] = state.get("rounds", 0) + 1
            state["phase_history"].append({
                "phase": frm, "action": "completed", "to": to, "timestamp": ts,
                "seq": ev["seq"],
            })
        elif typ == "phase/refused":
            code = payload.get("code", "gate")
            if code == state.get("blocked_code"):
                state["consecutive_blocked"] = state.get("consecutive_blocked", 0) + 1
            else:
                state["blocked_code"] = code
                state["consecutive_blocked"] = 1
            state["blocked_reason"] = payload.get("reason", "")
            state["phase_history"].append({
                "phase": payload.get("from"), "action": "refused", "code": code,
                "reason": payload.get("reason", ""), "timestamp": ts, "seq": ev["seq"],
            })
            state["errors"].append(
                f"[{payload.get('from')}] {ts}: advance refused ({code}): "
                f"{payload.get('reason', '')}")
        elif typ == "phase/force":
            phase = payload.get("phase")
            state["current_phase"] = phase
            if phase in PIPELINE_PHASES:
                state["completed_phases"] = PIPELINE_PHASES[:PIPELINE_PHASES.index(phase)]
            state["verified_criteria"] = []
            state["phase_history"].append({
                "phase": phase, "action": "force_jump", "timestamp": ts, "seq": ev["seq"],
            })
        elif typ == "phase/interrupted":
            state["phase_history"].append({
                "phase": payload.get("phase"), "action": "interrupted",
                "reason": payload.get("reason", "interrupted"), "timestamp": ts,
                "seq": ev["seq"],
            })
        elif typ == "criteria/locked":
            criteria = payload.get("criteria", [])
            if criteria:
                state["acceptance_criteria"] = list(criteria)
                state["verified_criteria"] = []
            for key in ("project_name", "domain", "scale", "quality_attributes"):
                if key in payload:
                    state[key] = payload[key]
            state["phase_history"].append({
                "phase": "INTERPRET", "action": "criteria_locked",
                "count": len(criteria), "timestamp": ts, "seq": ev["seq"],
            })
        elif typ == "criterion/verified":
            criterion = payload.get("criterion")
            if criterion and criterion not in state["verified_criteria"]:
                state["verified_criteria"].append(criterion)
            state["phase_history"].append({
                "phase": payload.get("phase"), "action": "criterion_verified",
                "index": payload.get("index"), "timestamp": ts, "seq": ev["seq"],
            })
        elif typ == "meta/set":
            key, value = payload.get("key"), payload.get("value")
            if key in SCALAR_KEYS:
                state[key] = value
        elif typ == "guard/check":
            state.setdefault("guard_log", []).append({
                "timestamp": ts, "seq": ev["seq"], "scope": payload.get("scope"),
                "verdict": payload.get("verdict"), "code": payload.get("code"),
            })
            state["guard_log"] = state["guard_log"][-20:]
        elif typ == "pipeline/block":
            state["blocked_code"] = payload.get("code", "blocked")
            state["blocked_reason"] = payload.get("reason", "")
            state["consecutive_blocked"] = BLOCK_AFTER_ROUNDS
            state["phase_history"].append({
                "phase": payload.get("phase"), "action": "blocked",
                "code": payload.get("code"), "reason": payload.get("reason", ""),
                "timestamp": ts, "seq": ev["seq"],
            })
        elif typ == "error/recorded":
            state["errors"].append(f"[{payload.get('phase', '?')}] {ts}: {payload.get('message', '')}")
        elif typ == "mistake/recorded":
            state["phase_history"].append({
                "phase": payload.get("phase"), "action": "mistake_recorded",
                "code": payload.get("code"), "message": payload.get("message", ""),
                "timestamp": ts, "seq": ev["seq"],
            })
            state["errors"].append(f"[mistake] {payload.get('message', '')}")
        elif typ in ("compaction/start", "compaction/summary", "compaction/end"):
            state.setdefault("compactions", []).append({
                "seq": ev["seq"], "ts": ts,
                "action": typ.split("/")[1],
                "payload": payload,
            })
        elif typ == "artifact/spilled":
            state.setdefault("artifacts", {})[payload.get("key")] = {
                "locator": payload.get("locator"),
                "bytes": payload.get("bytes"),
                "retrievalHint": payload.get("retrievalHint", ""),
            }
        state["updated_at"] = ts

    # ---- derived fields (pure functions of the log) ----
    state["revision"] = len(events)
    state["stateVersion"] = len(events)
    if events:
        state["created_at"] = state.get("created_at") or events[0].get("ts")
    # status derivation: paused > complete > blocked > in_progress
    all_phases = set(PIPELINE_PHASES)
    if state.get("paused"):
        state["status"] = "paused"
    elif all_phases.issubset(set(state.get("completed_phases", []))):
        state["status"] = "complete"
    elif state.get("consecutive_blocked", 0) >= BLOCK_AFTER_ROUNDS:
        state["status"] = "blocked"
    else:
        state["status"] = "in_progress"
    return state


# ---------------------------------------------------------------- bootstrap

def ensure_log(log_path, state_path, defaults: dict = None) -> tuple:
    """Bootstrap or migrate the event log.

    Returns (events, migrated). migrated=True means a legacy pipeline-state.yaml
    was imported through a seed/import event.
    """
    log_path = Path(log_path)
    state_path = Path(state_path)
    if log_path.exists():
        return load_events(log_path), False
    if state_path.exists():
        with open(state_path, "r", encoding="utf-8") as f:
            legacy = yaml.safe_load(f) or {}
        events = [{
            "seq": 1, "ts": _now_iso(), "type": "seed/import",
            "phase": None, "payload": {"snapshot": legacy},
        }]
        save_events(log_path, events)
        return events, True
    # Fresh bootstrap: log a phase/start for the first phase.
    events = [{
        "seq": 1, "ts": _now_iso(), "type": "phase/start",
        "phase": "INTERPRET", "payload": {"phase": "INTERPRET"},
    }]
    save_events(log_path, events)
    return events, False


def write_projection(state: dict, state_path) -> None:
    """Write pipeline-state.yaml as a derived projection (atomic)."""
    state_path = Path(state_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(state_path.parent), prefix=".pipeline-state-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            yaml.dump(state, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        os.replace(tmp, state_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- CLI

def main():
    parser = argparse.ArgumentParser(description="Append-only event log -> state projection")
    parser.add_argument("--log", required=True, help="path to event-log.yaml")
    parser.add_argument("--fold", action="store_true", help="print the projected state")
    parser.add_argument("--dump", action="store_true", help="print the raw events")
    parser.add_argument("--append", default=None, metavar="JSON",
                        help="append one event given as JSON {type, phase?, payload?}")
    args = parser.parse_args()

    log_path = Path(args.log)
    if args.append:
        ev = json.loads(args.append)
        rev = append_events(log_path, [ev])
        print(f"appended -> revision {rev}")
        return
    events = load_events(log_path)
    if args.dump:
        for ev in events:
            print(json.dumps(ev, ensure_ascii=False))
        return
    if args.fold:
        state = fold(events)
        print(yaml.dump(state, default_flow_style=False, allow_unicode=True, sort_keys=False))
        return
    print(f"{log_path}: {len(events)} events, version {LOG_VERSION}")


if __name__ == "__main__":
    main()
