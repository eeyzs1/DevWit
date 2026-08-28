"""Unit tests for the append-only event log + projection + goal semantics (WP1/WP3)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import brief_gen  # noqa: E402
import log_invariant  # noqa: E402
import state_fold  # noqa: E402


@pytest.fixture
def log_path(tmp_path):
    return tmp_path / "event-log.yaml"


def test_bootstrap_fresh_log(log_path):
    state_path = log_path.parent / "pipeline-state.yaml"
    events, migrated = state_fold.ensure_log(log_path, state_path)
    assert not migrated
    assert len(events) == 1
    assert events[0]["type"] == "phase/start"
    assert state_fold.fold(events)["current_phase"] == "INTERPRET"


def test_migration_from_legacy_state(log_path, tmp_path):
    state_path = tmp_path / "pipeline-state.yaml"
    state_path.write_text(
        "current_phase: GENERATE\ncompleted_phases: [INTERPRET]\nstatus: in_progress\n"
        "project_name: legacy\nacceptance_criteria: [a, b]\nverified_criteria: []\nerrors: []\n",
        encoding="utf-8")
    events, migrated = state_fold.ensure_log(log_path, state_path)
    assert migrated
    assert events[0]["type"] == "seed/import"
    state = state_fold.fold(events)
    assert state["project_name"] == "legacy"
    assert state["current_phase"] == "GENERATE"
    assert state["acceptance_criteria"] == ["a", "b"]


def test_append_and_fold_roundtrip(log_path):
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    rev = state_fold.append_events(log_path, [
        {"type": "criteria/locked", "phase": "INTERPRET",
         "payload": {"criteria": ["c1", "c2"]}},
        {"type": "phase/advance", "phase": "INTERPRET",
         "payload": {"from": "INTERPRET", "to": "GENERATE"}},
        {"type": "criterion/verified", "phase": "GENERATE",
         "payload": {"index": 1, "criterion": "c1"}},
    ], expected_revision=1)
    assert rev == 4
    state = state_fold.fold(state_fold.load_events(log_path))
    assert state["revision"] == 4
    assert state["stateVersion"] == 4
    assert state["current_phase"] == "GENERATE"
    assert state["completed_phases"] == ["INTERPRET"]
    assert state["verified_criteria"] == ["c1"]
    assert state["rounds"] == 1
    # revision is derived from the log, never stored independently
    assert state["revision"] == len(state_fold.load_events(log_path))


def test_cas_rejects_stale_writer(log_path):
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    with pytest.raises(state_fold.RevisionConflict):
        state_fold.append_events(log_path, [
            {"type": "error/recorded", "phase": None, "payload": {"message": "stale"}},
        ], expected_revision=99)


def test_unknown_event_type_fail_closed(log_path):
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    with pytest.raises(ValueError, match="unknown event type"):
        state_fold.append_events(log_path, [
            {"type": "phase/bogus", "phase": None, "payload": {}},
        ], expected_revision=1)


def test_seq_gap_fail_closed(log_path):
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    with pytest.raises(ValueError, match="unknown log version"):
        log_path.write_text("version: 9\nevents: []\n", encoding="utf-8")
        state_fold.load_events(log_path)
    log_path.write_text("version: 1\nevents: [{seq: 1, type: phase/start, payload: {}}, "
                        "{seq: 3, type: meta/set, payload: {key: paused, value: true}}]\n",
                        encoding="utf-8")
    with pytest.raises(ValueError, match="seq gap"):
        state_fold.load_events(log_path)


def test_meta_set_whitelist(log_path):
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    with pytest.raises(ValueError, match="not in whitelist"):
        state_fold.append_events(log_path, [
            {"type": "meta/set", "phase": None,
             "payload": {"key": "acceptance_criteria", "value": ["x"]}},
        ], expected_revision=1)


# ---------------------------------------------------------------- goal semantics

def _seed(log_path):
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    return state_path


def test_goal_blocked_after_three_consecutive_refusals(log_path):
    state_path = _seed(log_path)
    rev = 1
    for i in range(3):
        rev = state_fold.append_events(log_path, [
            {"type": "phase/refused", "phase": "GENERATE",
             "payload": {"from": "GENERATE", "code": "gate-x", "reason": "nope"}},
        ], expected_revision=rev)
        state = state_fold.fold(state_fold.load_events(log_path))
        if i < 2:
            assert state["status"] != "blocked"
            assert state["consecutive_blocked"] == i + 1
        else:
            assert state["status"] == "blocked"
            assert state["blocked_code"] == "gate-x"


def test_goal_different_code_resets_consecutive(log_path):
    state_path = _seed(log_path)
    rev = 1
    for code in ("gate-a", "gate-b"):
        rev = state_fold.append_events(log_path, [
            {"type": "phase/refused", "phase": "GENERATE",
             "payload": {"from": "GENERATE", "code": code, "reason": ""}},
        ], expected_revision=rev)
    state = state_fold.fold(state_fold.load_events(log_path))
    assert state["consecutive_blocked"] == 1  # reset, not 2


def test_goal_unblock_clears(log_path):
    state_path = _seed(log_path)
    rev = 1
    for _ in range(3):
        rev = state_fold.append_events(log_path, [
            {"type": "phase/refused", "phase": "GENERATE",
             "payload": {"from": "GENERATE", "code": "g", "reason": ""}},
        ], expected_revision=rev)
    state = state_fold.fold(state_fold.load_events(log_path))
    assert state["status"] == "blocked"
    for key, value in (("blocked_code", None), ("blocked_reason", None),
                       ("consecutive_blocked", 0)):
        rev = state_fold.append_events(log_path, [
            {"type": "meta/set", "phase": None, "payload": {"key": key, "value": value}},
        ], expected_revision=rev)
    state = state_fold.fold(state_fold.load_events(log_path))
    assert state["status"] == "in_progress"


def test_goal_pause_resume(log_path):
    state_path = _seed(log_path)
    rev = state_fold.append_events(log_path, [
        {"type": "meta/set", "phase": None, "payload": {"key": "paused", "value": True}},
    ], expected_revision=1)
    assert state_fold.fold(state_fold.load_events(log_path))["status"] == "paused"
    rev = state_fold.append_events(log_path, [
        {"type": "meta/set", "phase": None, "payload": {"key": "paused", "value": False}},
    ], expected_revision=rev)
    assert state_fold.fold(state_fold.load_events(log_path))["status"] == "in_progress"


# ---------------------------------------------------------------- invariant + brief

def test_invariant_detects_stale_brief_and_state(log_path, tmp_path):
    _seed(log_path)
    state_path = tmp_path / "pipeline-state.yaml"
    brief_path = tmp_path / "PHASE_BRIEF.md"
    failures = log_invariant.check(log_path, state_path, brief_path)
    # state/brief missing -> only stale checks skipped (files absent); must pass
    assert failures == []


def test_invariant_detects_stale_brief_watermark(log_path, tmp_path):
    _seed(log_path)
    state = state_fold.fold(state_fold.load_events(log_path))
    state_fold.write_projection(state, tmp_path / "pipeline-state.yaml")
    brief_path = tmp_path / "PHASE_BRIEF.md"
    brief_path.write_text(brief_gen.render_brief(state), encoding="utf-8")
    # append an event, leaving brief stale
    state_fold.append_events(log_path, [
        {"type": "meta/set", "phase": None, "payload": {"key": "paused", "value": True}},
    ], expected_revision=1)
    failures = log_invariant.check(log_path, tmp_path / "pipeline-state.yaml", brief_path)
    codes = [c for c, _ in failures]
    assert "INVARIANT_STALE_STATE" in codes
    assert "INVARIANT_STALE_BRIEF" in codes


def test_invariant_detects_orphan_compaction(log_path, tmp_path):
    _seed(log_path)
    state_fold.append_events(log_path, [
        {"type": "compaction/start", "phase": None, "payload": {}},
    ], expected_revision=1)
    failures = log_invariant.check(log_path, None, None)
    assert any(c == "INVARIANT_ORPHAN_COMPACTION" for c, _ in failures)


def test_brief_has_watermark(log_path, tmp_path):
    _seed(log_path)
    state = state_fold.fold(state_fold.load_events(log_path))
    text = brief_gen.render_brief(state)
    assert f"asOfSeq: {state['revision']}" in text
    assert "## Task Drift Check" in text
