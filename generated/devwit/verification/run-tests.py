#!/usr/bin/env python3
"""
RUN-TESTS (v3.1): execute the declared test command and record test/run evidence.

"Verify the world, not the self-report": the ONLY thing that counts as test
evidence is an actual test command that ran and returned an exit code. This
script appends a `test/run` event to memory/event-log.yaml (hash-chained);
judge / contract validation read that ledger, never a prose claim.

Command resolution: --command > harness-profile.yaml verification.command >
probe (package.json -> npm test, pyproject/pytest.ini -> pytest). No shell=True.

Exit: 0 = tests passed, 1 = tests failed, 2 = no test command found (fail-closed).

Usage:
    python verification/run-tests.py [--project-root .] [--command "npm test"]
"""

import argparse
import subprocess
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "runtime"))
import event_log  # noqa: E402


def resolve_command(project_root: Path, explicit=None):
    if explicit:
        return explicit
    profile_file = project_root / "harness-profile.yaml"
    if profile_file.exists():
        try:
            import yaml
            with open(profile_file, "r", encoding="utf-8") as f:
                profile = yaml.safe_load(f) or {}
            cmd = ((profile.get("verification") or {}) or {}).get("command")
            if cmd:
                return str(cmd)
        except Exception:
            pass
    for probe, cmd in (("package.json", "npm test"),
                       ("pyproject.toml", "python -m pytest -q"),
                       ("pytest.ini", "python -m pytest -q")):
        if (project_root / probe).is_file():
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

    print(f"Running: {cmd}")
    import shlex
    cmd_parts = shlex.split(cmd)
    try:
        # win32 下接 .cmd（npm/vitest 等）需经 shell；命令来自配置（可信），非用户输入。
        use_shell = sys.platform == "win32"
        proc = subprocess.run(cmd if use_shell else cmd_parts, cwd=str(root),
                              capture_output=True, text=True,
                              encoding="utf-8", errors="replace", shell=use_shell)
        exit_code = proc.returncode
        summary = ((proc.stdout or "")[-300:] + (proc.stderr or "")[-200:]).strip()
    except Exception as e:
        exit_code = -1
        summary = f"could not run tests: {e}"

    try:
        event_log.append_events([{"type": "test/run", "payload": {
            "name": "tests", "command": cmd, "exit": exit_code,
            "passed": exit_code == 0, "summary": summary}}], project_root=root)
        # log 是真相源：追加证据后重折叠派生投影，保持 asOfSeq 同步（不变量要求）
        state = event_log.load_session_state(root)
        event_log.save_session_state(state, root)
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
