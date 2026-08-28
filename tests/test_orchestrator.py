"""End-to-end tests of the event-log driven orchestrator (WP1/WP2/WP3/WP7)."""

import json


def _oc(meta_root, *args):
    import subprocess
    import sys
    proc = subprocess.run([sys.executable, "meta/meta-orchestrator.py", *args],
                          cwd=str(meta_root), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    return proc.returncode, proc.stdout + proc.stderr


def test_bootstrap_and_interpret(meta_root):
    code, out = _oc(meta_root, "--status")
    assert code == 0
    assert "Revision:   1" in out
    code, out = _oc(meta_root, "--interpret-intent", "I need a REST API for orders")
    assert code == 0
    assert "Acceptance criteria LOCKED" in out
    code, out = _oc(meta_root, "--events")
    assert "phase/start" in out
    assert "criteria/locked" in out


def test_advance_refused_by_validate_hook_and_blocks_after_three(meta_root):
    _oc(meta_root, "--interpret-intent", "Build an API")
    # INTERPRET -> GENERATE passes the hook (no-op for non-GENERATE phases)
    code, out = _oc(meta_root, "--advance", "--no-auto-run")
    assert "PHASE COMPLETE: INTERPRET" in out
    # GENERATE -> FACTORY is refused by the validate-harness bail hook
    code, out = _oc(meta_root, "--advance", "--no-auto-run")
    assert "ADVANCE REFUSED" in out
    assert "10-validate-harness" in out
    # First refusal: not blocked yet
    code, out = _oc(meta_root, "--status")
    assert "Status:     in_progress" in out
    # Two more refusals with the same code -> blocked (goal semantics)
    for _ in range(2):
        _oc(meta_root, "--advance", "--no-auto-run")
    code, out = _oc(meta_root, "--status")
    assert "Status:     blocked" in out
    assert "10-validate-harness" in out
    # Advancing while blocked is a no-op guard
    code, out = _oc(meta_root, "--advance", "--no-auto-run")
    assert "PIPELINE IS BLOCKED" in out


def test_unblock_pause_resume(meta_root):
    _oc(meta_root, "--interpret-intent", "Build an API")
    _oc(meta_root, "--fail", "boom")
    code, out = _oc(meta_root, "--status")
    assert "Status:     blocked" in out
    _oc(meta_root, "--unblock", "--code", "fixed", "--reason", "found it")
    code, out = _oc(meta_root, "--status")
    assert "Status:     in_progress" in out
    _oc(meta_root, "--pause")
    code, out = _oc(meta_root, "--status")
    assert "Status:     paused" in out
    _oc(meta_root, "--resume")
    code, out = _oc(meta_root, "--status")
    assert "Status:     in_progress" in out


def test_invariants_pass_end_to_end(meta_root):
    _oc(meta_root, "--interpret-intent", "Build an API")
    _oc(meta_root, "--advance", "--no-auto-run")
    _oc(meta_root, "--compact")
    code, out = _oc(meta_root, "--check-invariants")
    assert code == 0
    assert "INVARIANTS PASS" in out


def test_stale_brief_fails_invariant(meta_root):
    _oc(meta_root, "--interpret-intent", "Build an API")
    brief = meta_root / ".meta-harness" / "PHASE_BRIEF.md"
    brief.write_text("# tampered\n<!-- asOfSeq: 0 -->\n", encoding="utf-8")
    code, out = _oc(meta_root, "--check-invariants")
    assert code == 1
    assert "INVARIANT_STALE_BRIEF" in out


def test_spill_records_artifact_locator(meta_root):
    _oc(meta_root, "--interpret-intent", "Build an API")
    import subprocess
    import sys
    proc = subprocess.run(
        [sys.executable, "scripts/spill.py", "--log", "meta/event-log.yaml",
         "--key", "dump", "--text", "x" * 20000, "--root", "."],
        cwd=str(meta_root), capture_output=True, text=True, encoding="utf-8",
        errors="replace")
    assert proc.returncode == 0
    assert "SPILLED" in proc.stdout
    state = (meta_root / "meta" / "pipeline-state.yaml").read_text(encoding="utf-8")
    assert "dump" in state and "artifacts" in state
    code, out = _oc(meta_root, "--check-invariants")
    assert code == 0
