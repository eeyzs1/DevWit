#!/usr/bin/env python3
"""Regression tests for goal semantics + compaction + spill (Fusion Plan v3 — A-WU7).

Run:  python -m pytest runtime/tests/test_goal_compaction.py -q
"""

import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import event_log  # noqa: E402
import spill  # noqa: E402


def _init_project(tmp_path: Path) -> Path:
    (tmp_path / "memory").mkdir(parents=True, exist_ok=True)
    (tmp_path / "memory" / "session-state.yaml").write_text(
        yaml.safe_dump({"status": "in_progress", "progress": {"completed_criteria": [],
                                                              "acceptance_criteria": []}},
                       allow_unicode=True, sort_keys=False),
        encoding="utf-8")
    (tmp_path / "task.yaml").write_text(
        yaml.safe_dump({"acceptance_criteria": []}, allow_unicode=True, sort_keys=False),
        encoding="utf-8")
    state = event_log.load_session_state(tmp_path)
    event_log.save_session_state(state, tmp_path)
    return tmp_path


def test_goal_pause_resume(tmp_path):
    root = _init_project(tmp_path)
    event_log.append_events([{"type": "goal/pause", "payload": {}}], project_root=root)
    state = event_log.load_session_state(root)
    assert state["paused"] is True

    event_log.append_events([{"type": "goal/resume", "payload": {}}], project_root=root)
    state = event_log.load_session_state(root)
    assert state["paused"] is False


def test_goal_unblock_records_code_and_reason(tmp_path):
    root = _init_project(tmp_path)
    event_log.append_events([{"type": "goal/unblock",
                              "payload": {"code": "INVARIANT_STALE_STATE", "reason": "re-folded"}}],
                             project_root=root)
    state = event_log.load_session_state(root)
    assert state["blocked"] is False
    assert state["unblocks"][-1]["code"] == "INVARIANT_STALE_STATE"
    assert state["unblocks"][-1]["reason"] == "re-folded"


def test_compaction_complete_block_no_orphan(tmp_path):
    root = _init_project(tmp_path)
    rev = event_log.load_events(root)
    event_log.append_events([
        {"type": "compaction/start", "payload": {}},
        {"type": "compaction/summary", "payload": {"summary": {"status": "in_progress"}}},
        {"type": "compaction/end", "payload": {}},
    ], expected_len=len(rev), project_root=root)
    state = event_log.load_session_state(root)
    assert state["compaction"]["status"] == "closed"
    problems, _ = event_log.check_invariants(root)
    assert not any("ORPHANED_COMPACTION" in p for p in problems)


def test_compaction_orphan_detected(tmp_path):
    root = _init_project(tmp_path)
    rev = event_log.load_events(root)
    event_log.append_events([
        {"type": "compaction/start", "payload": {}},
        {"type": "compaction/summary", "payload": {"summary": {"status": "in_progress"}}},
    ], expected_len=len(rev), project_root=root)
    problems, _ = event_log.check_invariants(root)
    assert any("INVARIANT_ORPHANED_COMPACTION" in p for p in problems)


def test_spill_best_effort_inline(tmp_path):
    root = _init_project(tmp_path)
    result = spill.save_text(root, "note", "短文本", max_bytes=8192)
    assert result["status"] == "inline"
    assert result["bytes"] == 3  # len() 按字符计
    problems, _ = event_log.check_invariants(root)
    assert problems == []


def test_spill_oversized_to_artifact(tmp_path):
    root = _init_project(tmp_path)
    big = "x" * 20000
    result = spill.save_text(root, "note", big, max_bytes=8192)
    assert result["status"] == "spilled"
    assert Path(result["locator"]).exists()
    assert Path(result["locator"]).read_text(encoding="utf-8") == big

    state = event_log.load_session_state(root)
    assert state["artifacts"][-1]["key"] == "note"
    assert state["artifacts"][-1]["locator"] == result["locator"]
    problems, _ = event_log.check_invariants(root)
    assert problems == []


def test_bad_artifact_event_detected(tmp_path):
    root = _init_project(tmp_path)
    event_log.append_events([{"type": "artifact/spilled", "payload": {"locator": "x"}}],
                            project_root=root)  # missing key -> bad event
    problems, _ = event_log.check_invariants(root)
    assert any("INVARIANT_BAD_ARTIFACT" in p for p in problems)


def test_unknown_event_type_fail_closed(tmp_path):
    root = _init_project(tmp_path)
    log_path = root / "memory" / "event-log.yaml"
    doc = yaml.safe_load(log_path.read_text(encoding="utf-8"))
    doc["events"].append({"seq": len(doc["events"]) + 1, "ts": "now",
                          "type": "goal/skip", "payload": {}})
    log_path.write_text(yaml.safe_dump(doc, allow_unicode=True), encoding="utf-8")
    with pytest.raises(ValueError):
        event_log.load_events(root)
