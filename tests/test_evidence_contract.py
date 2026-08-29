"""Unit tests for the evidence ledger events (WP1) and contract validator (WP2)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import log_invariant  # noqa: E402
import state_fold  # noqa: E402
import validate_contract  # noqa: E402


@pytest.fixture
def log_path(tmp_path):
    return tmp_path / "event-log.yaml"


def test_verify_and_test_events_fold_into_evidence(log_path):
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    rev = state_fold.append_events(log_path, [
        {"type": "verify/run", "phase": None,
         "payload": {"name": "guard.py", "command": "python guard.py --report",
                     "exit": 0, "passed": True, "summary": "ok"}},
        {"type": "test/run", "phase": None,
         "payload": {"name": "tests", "command": "pytest -q", "exit": 1,
                     "passed": False, "summary": "2 failed"}},
        {"type": "audit/round", "phase": None,
         "payload": {"name": "round-1", "exit": 0, "passed": True,
                     "summary": "no gaps"}},
    ], expected_revision=1)
    assert rev == 4
    state = state_fold.fold(state_fold.load_events(log_path))
    kinds = [(e["kind"], e["name"], e["passed"]) for e in state["evidence"]]
    assert ("verify", "guard.py", True) in kinds
    assert ("test", "tests", False) in kinds
    assert ("audit", "round-1", True) in kinds


# ---------------------------------------------------------------- contract validator

def test_contract_schema_pass():
    output = {"verdict": "NOT_PROVEN", "criteria": []}
    schema = {"version": 1, "required": ["verdict"], "properties": {
        "verdict": {"type": "string", "enum": ["PROVEN", "NOT_PROVEN", "INSUFFICIENT_EVIDENCE"]}}}
    errors = []
    validate_contract.validate_value(output, schema, "output", errors)
    assert errors == []


def test_contract_schema_rejects_missing_required():
    output = {"criteria": []}
    schema = {"version": 1, "required": ["verdict"], "properties": {
        "verdict": {"type": "string"}}}
    errors = []
    validate_contract.validate_value(output, schema, "output", errors)
    assert any("missing required" in e for e in errors)


def test_proven_requires_refs_cross_field():
    errors = []
    validate_contract.enforce_verdict_refs(
        {"verdict": "PROVEN", "criteria": [
            {"criterion": "a", "verdict": "PROVEN", "rationale": "trust me"}]}, errors)
    assert any("verdict PROVEN requires at least one evidence_ref" in e for e in errors)
    errors = []
    validate_contract.enforce_verdict_refs(
        {"verdict": "PROVEN", "criteria": [
            {"criterion": "a", "verdict": "PROVEN", "evidence_refs": ["test:tests"]}]}, errors)
    assert errors == []


def test_check_refs_forged_rejected(tmp_path):
    log_file = tmp_path / "event-log.yaml"
    log_file.write_text(
        "version: 1\nevents:\n  - {seq: 1, ts: t, type: test/run, "
        "payload: {name: tests, exit: 0, passed: true}}\n", encoding="utf-8")
    with open(log_file, "r", encoding="utf-8") as f:
        doc = __import__("yaml").safe_load(f)
    evidence = validate_contract.collect_evidence(doc["events"])
    errors = []
    validate_contract.check_refs(["test:tests", "event:1", "test:nope", "file:missing.py"],
                                 evidence, tmp_path, errors)
    assert any("test:nope" in e for e in errors)
    assert any("missing.py" in e for e in errors)
    assert not any("tests" in e and "nope" not in e for e in errors)


def test_evidence_ref_file_resolves(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "api.py").write_text("x", encoding="utf-8")
    evidence = validate_contract.collect_evidence([])
    errors = []
    validate_contract.check_refs(["file:src/api.py", "file:src/nope.py"],
                                 evidence, tmp_path, errors)
    assert errors and "nope.py" in errors[0]


def test_event_ref_to_non_evidence_event_rejected(tmp_path):
    """P0#3: citing an error/recorded event as evidence must be rejected."""
    log_file = tmp_path / "event-log.yaml"
    log_file.write_text(
        "version: 1\nevents:\n  - {seq: 1, ts: t, type: error/recorded, "
        "payload: {message: broke}}\n", encoding="utf-8")
    import yaml
    doc = yaml.safe_load(log_file.read_text(encoding="utf-8"))
    evidence = validate_contract.collect_evidence(doc["events"])
    errors = []
    validate_contract.check_refs(["event:1"], evidence, tmp_path, errors)
    assert errors and "not an evidence event" in errors[0]


def test_checkpoint_compaction_preserves_state(log_path):
    """P2#9: compact_log folds + truncates, checkpoint is seq 1, state identical."""
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    rev = 1
    for i in range(30):
        rev = state_fold.append_events(log_path, [
            {"type": "meta/set", "phase": None,
             "payload": {"key": "project_name", "value": f"p{i}"}},
        ], expected_revision=rev)
    before = state_fold.fold(state_fold.load_events(log_path))
    new_len = state_fold.compact_log(log_path, keep_last=5)
    assert new_len == 6  # checkpoint + 5 tail
    after = state_fold.fold(state_fold.load_events(log_path))
    events = state_fold.load_events(log_path)
    assert events[0]["type"] == "checkpoint" and events[0]["seq"] == 1
    # key derived fields survive the compaction
    assert after["project_name"] == before["project_name"]
    assert after["revision"] == len(events)
    # named evidence survives inside the checkpoint snapshot
    state_fold.append_events(log_path, [
        {"type": "verify/run", "phase": None,
         "payload": {"name": "guard.py", "exit": 0, "passed": True}},
    ], expected_revision=new_len)
    state_fold.compact_log(log_path, keep_last=3)
    folded = state_fold.fold(state_fold.load_events(log_path))
    assert any(e["name"] == "guard.py" and e["passed"] for e in folded["evidence"])


def test_additional_properties_rejected():
    """P2#13: unknown fields fail when the schema forbids them."""
    output = {"verdict": "PROVEN", "criteria": [], "sneaky": "extra"}
    schema = {"version": 1, "required": ["verdict"], "additionalProperties": False,
              "properties": {"verdict": {"type": "string"}}}
    errors = []
    validate_contract.validate_value(output, schema, "output", errors)
    assert any("unexpected fields" in e for e in errors)


def test_hash_chain_detects_tampered_yaml_log(log_path, tmp_path):
    """P2#12: the YAML event log is hash-chained; tampering is detected."""
    state_path = log_path.parent / "pipeline-state.yaml"
    state_fold.ensure_log(log_path, state_path)
    rev = state_fold.append_events(log_path, [
        {"type": "verify/run", "phase": None,
         "payload": {"name": "guard.py", "exit": 0, "passed": True}},
        {"type": "test/run", "phase": None,
         "payload": {"name": "tests", "exit": 0, "passed": True}},
    ], expected_revision=1)
    assert rev == 3
    events = state_fold.load_events(log_path)
    assert all("hash" in ev for ev in events)  # writers chain every event
    assert state_fold.verify_chain(events) == []

    # tamper the first event's payload in the file (YAML format: `name: guard.py`)
    text = log_path.read_text(encoding="utf-8")
    tampered = text.replace("name: guard.py", "name: TAMPERED", 1)
    assert tampered != text, "tamper pattern did not match the YAML"
    log_path.write_text(tampered, encoding="utf-8")
    broken = state_fold.verify_chain(state_fold.load_events(log_path))
    assert broken  # chain must break

    # log_invariant surfaces it as INVARIANT_LOG_CHAIN
    failures = log_invariant.check(log_path, None, None)
    assert any(c == "INVARIANT_LOG_CHAIN" for c, _ in failures)
