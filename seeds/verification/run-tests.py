#!/usr/bin/env python3
"""
RUN-TESTS: execute the declared test command and record test/run evidence (WP1).

"Verify the world, not the self-report": the ONLY thing that counts as test
evidence is an actual test command that ran and returned an exit code. This
script appends a `test/run` event to memory/event-log.yaml; judge.py and the
audit contract read that ledger, never a prose claim.

Command resolution: --command > task.yaml `verification.command` > probe
(pyproject.toml -> pytest, package.json -> npm test, pytest.ini -> pytest).

Exit: 0 = tests passed, 1 = tests failed, 2 = no test command found (fail-closed:
absence of test evidence must be visible, not silently skipped).

Usage:
    python verification/run-tests.py [--project-root .] [--command "pytest -q"]
"""

import argparse
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

GEN_EVENT_TYPES = {"test/run", "error/recorded"}


def _chain_events(events: list) -> list:
    """P2#12 hash-chain integrity (kept in sync with orchestrator.py)."""
    import hashlib
    import json
    prev = ""
    chained = []
    for ev in events:
        ev = dict(ev)
        ev.pop("hash", None)
        canonical = json.dumps({k: v for k, v in ev.items() if k != "hash"},
                               sort_keys=True, ensure_ascii=False, default=str)
        ev["prev_hash"] = prev
        ev["hash"] = hashlib.sha256((prev + canonical).encode("utf-8")).hexdigest()
        prev = ev["hash"]
        chained.append(ev)
    return chained


def append_event(log_file: Path, event: dict) -> None:
    events = []
    if log_file.exists():
        with open(log_file, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f) or {}
        events = doc.get("events", []) or []
    base = len(events)
    now = datetime.now().isoformat()
    events.append({"seq": base + 1, "ts": now, "type": event["type"],
                   "payload": event.get("payload", {})})
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with open(log_file, "w", encoding="utf-8") as f:
        yaml.dump({"version": 1, "events": _chain_events(events)}, f,
                  default_flow_style=False, allow_unicode=True, sort_keys=False)


def resolve_command(project_root: Path, explicit: str = None) -> str:
    if explicit:
        return explicit
    # P0#2: the test command is LOCKED at generation time in
    # harness-profile.yaml; task.yaml edits are ignored at runtime.
    profile_file = project_root / "harness-profile.yaml"
    if profile_file.exists():
        try:
            with open(profile_file, "r", encoding="utf-8") as f:
                profile = yaml.safe_load(f) or {}
            cmd = ((profile.get("verification") or {}) or {}).get("command")
            if cmd:
                return str(cmd)
        except Exception:
            pass
    for probe, cmd in (("pyproject.toml", "python -m pytest -q"),
                       ("pytest.ini", "python -m pytest -q"),
                       ("package.json", "npm test")):
        if (project_root / probe).exists():
            return cmd
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Run declared tests and record evidence")
    ap.add_argument("--project-root", default=".", help="project root")
    ap.add_argument("--command", default=None, help="test command override")
    args = ap.parse_args()

    root = Path(args.project_root).resolve()
    cmd = resolve_command(root, args.command)
    if not cmd:
        print("NO TEST COMMAND: none declared and no test project detected "
              "-- fail-closed: no test evidence can exist", file=sys.stderr)
        return 2

    log_file = root / "memory" / "event-log.yaml"
    print(f"Running: {cmd}")
    try:
        import shlex
        cmd_parts = shlex.split(cmd)  # P1#5: no shell=True
        proc = subprocess.run(cmd_parts, cwd=str(root), capture_output=True,
                              text=True, encoding="utf-8", errors="replace")
        exit_code = proc.returncode
        summary = ((proc.stdout or "")[-300:] + (proc.stderr or "")[-200:]).strip()
    except Exception as e:
        exit_code = -1
        summary = f"could not run tests: {e}"

    try:
        append_event(log_file, {"type": "test/run", "payload": {
            "name": "tests", "command": cmd, "exit": exit_code,
            "passed": exit_code == 0, "summary": summary}})
        print(f"recorded test/run evidence (exit={exit_code})")
    except Exception as e:
        print(f"WARN: evidence not recorded: {e}", file=sys.stderr)

    if exit_code == 0:
        print("TESTS PASSED")
        return 0
    print("TESTS FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
