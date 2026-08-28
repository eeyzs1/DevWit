#!/usr/bin/env python3
"""Regression tests for the append-only event log (Fusion Plan v3 — A-WU1/A-WU2).

Run:  python -m pytest runtime/tests/test_event_log.py -q
"""

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import event_log  # noqa: E402


def _legacy_session_state() -> dict:
    return {
        "status": "complete",
        "phase": "EVOLVE",
        "blockers": [],
        "guard_log": [
            {"action": "mark_complete", "criterion": "AC1", "verdict": "VERIFIED",
             "timestamp": "2026-07-21T07:25:45.210431"},
        ],
        "progress": {
            "acceptance_criteria": [
                {"id": "AC1", "description": "criterion one", "status": "completed",
                 "traces_to": ["WU001"], "verifier": "tests/e2e/ac1.spec.ts"},
            ],
            "completed_criteria": ["criterion one"],
            "failed_criteria": [],
        },
    }


def _write_legacy(tmp_path: Path) -> Path:
    (tmp_path / "memory").mkdir(parents=True, exist_ok=True)
    (tmp_path / "memory" / "session-state.yaml").write_text(
        yaml.safe_dump(_legacy_session_state(), allow_unicode=True, sort_keys=False),
        encoding="utf-8")
    (tmp_path / "task.yaml").write_text(
        yaml.safe_dump({"acceptance_criteria": ["criterion one"]},
                       allow_unicode=True, sort_keys=False),
        encoding="utf-8")
    return tmp_path


def test_migration_equivalence(tmp_path):
    """Legacy session-state is imported via seed/import; the projection preserves
    the full schema (phase/blockers/guard_log/AC detail) plus the watermark."""
    root = _write_legacy(tmp_path)
    state = event_log.load_session_state(root)
    event_log.save_session_state(state, root)

    events = event_log.load_events(root)
    assert len(events) == 1
    assert events[0]["type"] == "seed/import"
    assert events[0]["seq"] == 1

    assert state["phase"] == "EVOLVE"
    assert state["status"] == "complete"
    assert state["blockers"] == []
    assert len(state["guard_log"]) == 1
    assert state["revision"] == 1 and state["asOfSeq"] == 1
    ac = state["progress"]["acceptance_criteria"][0]
    assert ac["id"] == "AC1" and ac["traces_to"] == ["WU001"]
    assert ac["verifier"] == "tests/e2e/ac1.spec.ts"

    problems, warnings = event_log.check_invariants(root)
    assert problems == []
    assert warnings == []


def test_fail_closed_seq_gap(tmp_path):
    root = _write_legacy(tmp_path)
    event_log.load_session_state(root)
    event_log.save_session_state(event_log.load_session_state(root), root)

    log_path = root / "memory" / "event-log.yaml"
    doc = yaml.safe_load(log_path.read_text(encoding="utf-8"))
    doc["events"] = [doc["events"][0], {"seq": 3, "ts": "now", "type": "project/init",
                                        "payload": {}}]
    log_path.write_text(yaml.safe_dump(doc, allow_unicode=True), encoding="utf-8")

    problems, _ = event_log.check_invariants(root)
    assert any("INVARIANT_LOG_CORRUPT" in p for p in problems)
    with pytest.raises(ValueError):
        event_log.load_events(root)


def test_fail_closed_unknown_type(tmp_path):
    root = _write_legacy(tmp_path)
    event_log.load_session_state(root)

    log_path = root / "memory" / "event-log.yaml"
    doc = yaml.safe_load(log_path.read_text(encoding="utf-8"))
    doc["events"][0]["type"] = "mystery/event"
    log_path.write_text(yaml.safe_dump(doc, allow_unicode=True), encoding="utf-8")

    problems, _ = event_log.check_invariants(root)
    assert any("INVARIANT_LOG_CORRUPT" in p for p in problems)


def test_fail_closed_unknown_log_version(tmp_path):
    root = _write_legacy(tmp_path)
    event_log.load_session_state(root)

    log_path = root / "memory" / "event-log.yaml"
    doc = yaml.safe_load(log_path.read_text(encoding="utf-8"))
    doc["version"] = 99
    log_path.write_text(yaml.safe_dump(doc, allow_unicode=True), encoding="utf-8")

    problems, _ = event_log.check_invariants(root)
    assert any("INVARIANT_LOG_CORRUPT" in p for p in problems)


def test_stale_watermark_fails(tmp_path):
    root = _write_legacy(tmp_path)
    event_log.load_session_state(root)
    event_log.save_session_state(event_log.load_session_state(root), root)

    # append a second event directly; projection watermark (1) now lags
    event_log.append_events([{"type": "error/recorded", "payload": {"message": "x"}}],
                            expected_len=1, project_root=root)
    problems, _ = event_log.check_invariants(root)
    assert any("INVARIANT_STALE_STATE" in p for p in problems)


def test_projection_not_log_derived_warns(tmp_path):
    root = _write_legacy(tmp_path)
    event_log.load_session_state(root)
    event_log.save_session_state(event_log.load_session_state(root), root)
    state_path = root / "memory" / "session-state.yaml"
    doc = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    doc.pop("asOfSeq")
    state_path.write_text(yaml.safe_dump(doc, allow_unicode=True), encoding="utf-8")

    problems, warnings = event_log.check_invariants(root)
    assert problems == []
    assert any("INVARIANT_PROJECTION_NOT_LOG_DERIVED" in w for w in warnings)


def test_append_cas_rejects_stale_writer(tmp_path):
    root = _write_legacy(tmp_path)
    event_log.load_session_state(root)

    with pytest.raises(ValueError):
        event_log.append_events([{"type": "project/init", "payload": {}}],
                                expected_len=5, project_root=root)

    new_len = event_log.append_events([{"type": "project/init", "payload": {}}],
                                      expected_len=1, project_root=root)
    assert new_len == 2
    events = event_log.load_events(root)
    assert events[1]["seq"] == 2 and events[1]["type"] == "project/init"
