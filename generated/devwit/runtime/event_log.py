#!/usr/bin/env python3
"""
EVENT LOG (Fusion Plan v3 — A-WU1): append-only event log is the single source
of truth; memory/session-state.yaml is a DERIVED projection.

Borrowed from DeepSeek Harness / meta-harness v3.0 (seeds/orchestrator.py +
scripts/log_invariant.py): "model-visible <=> logged". Every mutation appends an
event; projections are re-derived from the log at the same watermark. Fail-closed:
unknown log versions, unknown event types, seq gaps/duplicates, and stale
projection watermarks are refused (or warned) — never silently tolerated.

This module is SELF-CONTAINED: the generated project must not depend on the
parent meta-harness scripts at runtime.

Usage (library):
    import event_log
    state = event_log.load_session_state()   # migrate + fold + overlay task ACs
    event_log.save_session_state(state)      # write derived projection only
    problems, warnings = event_log.check_invariants(project_root)

CLI:
    python runtime/event_log.py --migrate     # migrate legacy state, fold, write projection
    python runtime/event_log.py --fold        # print the projected state
    python runtime/event_log.py --events      # dump the raw event log
"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parent.parent

EVENT_LOG = PROJECT_ROOT / "memory" / "event-log.yaml"
SESSION_STATE = PROJECT_ROOT / "memory" / "session-state.yaml"

LOG_VERSION = 1
GEN_EVENT_TYPES = {
    "seed/import", "project/init", "criterion/completed",
    "guard/check", "error/recorded", "mistake/recorded",
    # A-WU7：goal 语义 + compaction + spill
    "goal/pause", "goal/resume", "goal/unblock",
    "compaction/start", "compaction/summary", "compaction/end",
    "artifact/spilled",
    # v3.1：证据账本（verify/test/audit 运行证据，供契约溯源）
    "verify/run", "test/run", "audit/round",
}


# ---------------------------------------------------------------- load / append
def load_events(project_root: Path = PROJECT_ROOT) -> list:
    """Load the event log with fail-closed structural checks.

    Raises ValueError on: non-dict doc, unknown version, 'events' not a list,
    seq gap/duplicate, unknown event type. Returns [] when the log is absent.
    """
    log_path = project_root / "memory" / "event-log.yaml"
    if not log_path.exists():
        return []
    with open(log_path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    if not isinstance(doc, dict):
        raise ValueError("memory/event-log.yaml: root is not a mapping -- fail-closed")
    if doc.get("version") != LOG_VERSION:
        raise ValueError(
            f"memory/event-log.yaml: unknown log version {doc.get('version')!r} "
            f"(expected {LOG_VERSION}) -- fail-closed")
    events = doc.get("events")
    if not isinstance(events, list):
        raise ValueError("memory/event-log.yaml: 'events' is not a list -- fail-closed")
    for i, ev in enumerate(events, start=1):
        if not isinstance(ev, dict) or ev.get("seq") != i:
            raise ValueError(f"memory/event-log.yaml: seq gap/duplicate at position {i}")
        if ev.get("type") not in GEN_EVENT_TYPES:
            raise ValueError(
                f"memory/event-log.yaml: unknown event type {ev.get('type')!r} at seq {i}")
    return events


def append_events(new_events: list, expected_len: int = None, project_root: Path = PROJECT_ROOT) -> int:
    """Append events with a compare-and-set on the current log length.

    A stale writer (expected_len != actual) is rejected, never silently clobbers.
    Returns the new revision (log length).
    """
    events = load_events(project_root)
    if expected_len is not None and len(events) != expected_len:
        raise ValueError(
            f"event log revision conflict: writer expected {expected_len} events, "
            f"log has {len(events)} -- CAS rejected")
    base = len(events)
    now = datetime.now().isoformat(timespec="seconds")
    for i, ev in enumerate(new_events, start=base + 1):
        if ev.get("type") not in GEN_EVENT_TYPES:
            raise ValueError(f"unknown event type {ev.get('type')!r}")
        events.append({"seq": i, "ts": now, "type": ev["type"],
                       "payload": ev.get("payload", {})})
    _chain_events(events)  # v3.1 P2#12：哈希链完整性
    log_path = project_root / "memory" / "event-log.yaml"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as f:
        yaml.dump({"version": LOG_VERSION, "events": events}, f,
                  default_flow_style=False, allow_unicode=True, sort_keys=False)
    return len(events)


def _chain_events(events: list) -> list:
    """v3.1 P2#12：给事件序列补 prev_hash/hash 哈希链（就地）。"""
    import hashlib
    import json
    prev = ""
    for ev in events:
        ev.pop("hash", None)
        canonical = json.dumps({k: v for k, v in ev.items() if k != "hash"},
                               sort_keys=True, ensure_ascii=False, default=str)
        ev["prev_hash"] = prev
        ev["hash"] = hashlib.sha256((prev + canonical).encode("utf-8")).hexdigest()
        prev = ev["hash"]
    return events


# ---------------------------------------------------------------- fold
def fold(events: list, legacy_snapshot: dict = None) -> dict:
    """Pure function: events (+ optional legacy snapshot) -> projected session state.

    Preserves the generated project's session-state schema (phase / blockers /
    guard_log / progress.acceptance_criteria with traces_to+verifier): on
    seed/import the FULL legacy snapshot is carried over (deep merge), then
    event overlays apply. revision + asOfSeq mark the projection watermark.
    """
    state = {
        "status": "initialized",
        "phase": None,
        "blockers": [],
        "guard_log": [],
        "errors": [],
        "progress": {"completed_criteria": [], "failed_criteria": [],
                     "acceptance_criteria": []},
        "revision": 0,
        "asOfSeq": 0,
        "updated_at": None,
        # A-WU7 goal 语义 + compaction + spill 派生字段
        "paused": False,
        "blocked": False,
        "unblocks": [],
        "compaction": None,
        "artifacts": [],
    }
    if legacy_snapshot:
        # seed/import: carry the ENTIRE legacy projection over (superset of the
        # v3.0 whitelist) so downstream readers (orchestrator/guard) never see a
        # schema break. Deep-merge nested dicts that exist in both.
        for k, v in legacy_snapshot.items():
            if isinstance(v, dict) and isinstance(state.get(k), dict):
                merged = {**state[k], **v}
                state[k] = merged
            elif k in state or k not in ("progress",):
                state[k] = v if k != "revision" else v
    for ev in events:
        typ, payload, ts = ev["type"], ev.get("payload", {}), ev.get("ts")
        if typ == "seed/import":
            snap = payload.get("snapshot") or {}
            for k, v in snap.items():
                if isinstance(v, dict) and isinstance(state.get(k), dict):
                    state[k] = {**state[k], **v}
                else:
                    state[k] = v
        elif typ == "criterion/completed":
            c = payload.get("criterion")
            if c and c not in state["progress"]["completed_criteria"]:
                state["progress"]["completed_criteria"].append(c)
        elif typ == "guard/check":
            state["guard_log"].append({
                "timestamp": ts, "seq": ev["seq"],
                "action": payload.get("action"), "criterion": payload.get("criterion"),
                "verdict": payload.get("verdict"),
            })
            state["guard_log"] = state["guard_log"][-20:]
        elif typ == "error/recorded":
            state["errors"].append(payload.get("message", ""))
        elif typ == "mistake/recorded":
            state["errors"].append(f"[mistake] {payload.get('message', '')}")
        elif typ == "goal/pause":
            state["paused"] = True
            state["status"] = "paused"
        elif typ == "goal/resume":
            state["paused"] = False
            if state.get("status") == "paused":
                state["status"] = "in_progress"
        elif typ == "goal/unblock":
            state["blocked"] = False
            state["unblocks"].append({
                "ts": ts, "seq": ev["seq"],
                "code": payload.get("code", "manual"),
                "reason": payload.get("reason", ""),
            })
        elif typ == "compaction/start":
            state["compaction"] = {"status": "open", "startedAt": ts}
        elif typ == "compaction/summary":
            if state["compaction"] is None:
                state["compaction"] = {"status": "open"}
            state["compaction"]["summary"] = payload.get("summary", "")
        elif typ == "compaction/end":
            if state["compaction"] is None:
                state["compaction"] = {"status": "closed"}
            state["compaction"]["status"] = "closed"
            state["compaction"]["endedAt"] = ts
        elif typ == "artifact/spilled":
            state["artifacts"].append({
                "key": payload.get("key", "?"),
                "locator": payload.get("locator", "?"),
                "bytes": payload.get("bytes", 0),
            })
        elif typ in ("verify/run", "test/run", "audit/round"):
            # v3.1 证据账本：记录可溯源运行证据（契约校验用）
            kind = typ.split("/")[0]
            name = payload.get("name") or payload.get("command") or str(ev["seq"])
            state.setdefault("evidence", {})[typ] = state.setdefault("evidence", {}).get(typ, [])
            state["evidence"][typ].append({
                "kind": kind,
                "name": name,
                "passed": bool(payload.get("passed", payload.get("exit") == 0)),
                "seq": ev["seq"],
            })
        state["updated_at"] = ts
    state["revision"] = len(events)
    state["asOfSeq"] = len(events)
    return state


def load_session_state(project_root: Path = PROJECT_ROOT) -> dict:
    """Bootstrap/migrate the event log, fold it, overlay task.yaml criteria."""
    log_path = project_root / "memory" / "event-log.yaml"
    state_path = project_root / "memory" / "session-state.yaml"

    if not log_path.exists() and state_path.exists():
        # legacy migration: snapshot the current projection as seed/import
        with open(state_path, "r", encoding="utf-8", errors="replace") as f:
            legacy = yaml.safe_load(f) or {}
        append_events([{"type": "seed/import", "payload": {"snapshot": legacy}}],
                      project_root=project_root)
    if not log_path.exists():
        append_events([{"type": "project/init", "payload": {}}], project_root=project_root)

    events = load_events(project_root)
    state = fold(events)

    task = load_task(project_root)
    ac_strings = task.get("acceptance_criteria", []) or []
    # preserve legacy per-AC detail (traces_to/verifier) when AC ids match
    legacy_acs = {
        a.get("id"): a for a in (state.get("progress", {}).get("acceptance_criteria") or [])
        if isinstance(a, dict) and a.get("id")
    }
    ac_dicts = []
    for i, ac_text in enumerate(ac_strings, 1):
        ac_id = f"AC{i}"
        old = legacy_acs.get(ac_id, {})
        status = ("completed" if ac_text in state["progress"]["completed_criteria"]
                  else "pending")
        entry = {"id": ac_id, "description": ac_text, "status": status}
        for extra in ("traces_to", "verifier"):
            if old.get(extra):
                entry[extra] = old[extra]
        ac_dicts.append(entry)
    state.setdefault("progress", {})["acceptance_criteria"] = ac_dicts
    if ac_strings and len(state["progress"]["completed_criteria"]) >= len(ac_strings):
        state["status"] = "complete"
    elif state.get("status") in (None, "initialized"):
        state["status"] = "in_progress"
    return state


def save_session_state(state: dict, project_root: Path = PROJECT_ROOT) -> None:
    """Write the derived projection only; the event log stays the truth."""
    state["updated_at"] = datetime.now().isoformat(timespec="seconds")
    state_path = project_root / "memory" / "session-state.yaml"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with open(state_path, "w", encoding="utf-8") as f:
        yaml.dump(state, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def load_task(project_root: Path = PROJECT_ROOT) -> dict:
    task_file = project_root / "task.yaml"
    if not task_file.exists():
        return {}
    with open(task_file, "r", encoding="utf-8", errors="replace") as f:
        return yaml.safe_load(f) or {}


# ---------------------------------------------------------------- invariants
def check_invariants(project_root: Path = PROJECT_ROOT) -> tuple:
    """Fail-closed invariant checks. Returns (problems, warnings).

    problems  -> hard failures (exit non-zero): log structural corruption,
                 seq gaps, unknown types, stale projection watermark.
    warnings  -> soft notices: projection not yet log-derived (asOfSeq missing).
    """
    problems = []
    warnings = []
    log_path = project_root / "memory" / "event-log.yaml"
    state_path = project_root / "memory" / "session-state.yaml"

    if not log_path.exists():
        if state_path.exists():
            problems.append("INVARIANT_LOG_MISSING: memory/session-state.yaml exists but "
                            "memory/event-log.yaml does not -- run the migration")
        return problems, warnings

    try:
        events = load_events(project_root)
    except ValueError as exc:
        problems.append(f"INVARIANT_LOG_CORRUPT: {exc}")
        return problems, warnings

    # orphaned compaction: compaction/start|summary 无 compaction/end 收尾 → 孤儿（fail-closed）
    compaction_open = False
    for ev in events:
        if ev["type"] == "compaction/start":
            compaction_open = True
        elif ev["type"] == "compaction/end":
            compaction_open = False
    if compaction_open:
        problems.append("INVARIANT_ORPHANED_COMPACTION: compaction/start without compaction/end")

    # artifact/spilled 载荷必须含 key + locator（缺失即坏事件，fail-closed）
    for ev in events:
        if ev["type"] == "artifact/spilled":
            payload = ev.get("payload", {})
            if not payload.get("key") or not payload.get("locator"):
                problems.append(
                    f"INVARIANT_BAD_ARTIFACT: seq {ev['seq']} artifact/spilled missing key/locator")

    # stale projection watermark: derived state must not lag the log
    if state_path.exists():
        try:
            with open(state_path, "r", encoding="utf-8", errors="replace") as f:
                state = yaml.safe_load(f) or {}
        except Exception as exc:
            problems.append(f"INVARIANT_STATE_UNREADABLE: {exc}")
            state = {}
        as_of = state.get("asOfSeq")
        if as_of is None:
            warnings.append("INVARIANT_PROJECTION_NOT_LOG_DERIVED: session-state.yaml has no "
                            "asOfSeq watermark -- it was written outside the event log")
        elif not isinstance(as_of, int) or as_of > len(events):
            problems.append(f"INVARIANT_BAD_WATERMARK: asOfSeq={as_of!r} vs log length "
                            f"{len(events)}")
        elif as_of < len(events):
            problems.append(f"INVARIANT_STALE_STATE: projection asOfSeq={as_of} lags log "
                            f"(len={len(events)}) -- re-fold required")

    # orphaned compaction markers are checked by log_invariant.py (A-WU7 hooks in
    # compaction support); nothing to do here until compaction exists.
    return problems, warnings


# ---------------------------------------------------------------- CLI
def _cmd_migrate(root: Path) -> int:
    state = load_session_state(root)
    save_session_state(state, root)
    problems, warnings = check_invariants(root)
    print(f"MIGRATE OK: event log revision={state.get('revision')} asOfSeq="
          f"{state.get('asOfSeq')} status={state.get('status')} "
          f"ACs={len(state.get('progress', {}).get('acceptance_criteria', []))}")
    for w in warnings:
        print(f"  WARNING: {w}")
    for p in problems:
        print(f"  PROBLEM: {p}")
    return 1 if problems else 0


def _cmd_fold(root: Path) -> int:
    state = load_session_state(root)
    print(yaml.safe_dump(state, allow_unicode=True, sort_keys=False))
    return 0


def _cmd_events(root: Path) -> int:
    events = load_events(root)
    print(f"EVENT LOG ({root / 'memory' / 'event-log.yaml'}) -- {len(events)} events")
    for ev in events:
        print(f"  [{ev['seq']}] {ev.get('ts')}  {ev['type']}  {ev.get('payload', {})}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Append-only event log -> state projection")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--pause", action="store_true", help="Append goal/pause (A-WU7)")
    parser.add_argument("--resume", action="store_true", help="Append goal/resume (A-WU7)")
    parser.add_argument("--unblock", action="store_true",
                        help="Append goal/unblock with --code/--reason (A-WU7)")
    parser.add_argument("--code", default="manual", help="Stable machine code for --unblock")
    parser.add_argument("--reason", default="", help="Human-readable reason for --unblock")
    parser.add_argument("--compact", action="store_true",
                        help="Append compaction/start->summary->end block (A-WU7)")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("migrate")
    sub.add_parser("fold")
    sub.add_parser("events")
    args = parser.parse_args()
    root = Path(args.project_root).resolve()

    if args.cmd == "migrate":
        return _cmd_migrate(root)
    if args.cmd == "fold":
        return _cmd_fold(root)
    if args.cmd == "events":
        return _cmd_events(root)

    if args.pause:
        append_events([{"type": "goal/pause", "payload": {}}], project_root=root)
        state = load_session_state(root)
        save_session_state(state, root)
        print(f"PAUSED (asOfSeq={state.get('asOfSeq')})")
        return 0
    if args.resume:
        append_events([{"type": "goal/resume", "payload": {}}], project_root=root)
        state = load_session_state(root)
        save_session_state(state, root)
        print(f"RESUMED (asOfSeq={state.get('asOfSeq')})")
        return 0
    if args.unblock:
        append_events([{"type": "goal/unblock",
                        "payload": {"code": args.code, "reason": args.reason}}],
                       project_root=root)
        state = load_session_state(root)
        save_session_state(state, root)
        print(f"UNBLOCKED code={args.code} (asOfSeq={state.get('asOfSeq')})")
        return 0
    if args.compact:
        state = load_session_state(root)
        summary = {
            "status": state.get("status"),
            "ac_completed": len(state.get("progress", {}).get("completed_criteria", [])),
            "ac_total": len(state.get("progress", {}).get("acceptance_criteria", [])),
            "guard_log": len(state.get("guard_log", [])),
            "unblocks": len(state.get("unblocks", [])),
        }
        events = [
            {"type": "compaction/start", "payload": {}},
            {"type": "compaction/summary", "payload": {"summary": summary}},
            {"type": "compaction/end", "payload": {}},
        ]
        append_events(events, expected_len=state.get("revision", 0), project_root=root)
        state = load_session_state(root)
        save_session_state(state, root)
        print(f"COMPACTED (asOfSeq={state.get('asOfSeq')}, summary={summary})")
        return 0

    # default: invariant check
    problems, warnings = check_invariants(root)
    for p in problems:
        print(f"PROBLEM: {p}", file=sys.stderr)
    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)
    if problems:
        print(f"INVARIANTS FAIL ({len(problems)} problems)", file=sys.stderr)
        return 1
    print(f"INVARIANTS PASS (warnings: {len(warnings)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
