#!/usr/bin/env python3
"""
ENFORCE-PERMISSION: confine a command under the active sandbox mode (WP9).

Separates two failure classes so a denial is never reported as a task failure:
  - exit 126  -> PERMISSION DENIED by the permission chain (mode mismatch)
  - otherwise -> the runner's own exit code (the task itself failed)

Mode resolution: --mode arg > $MH_PERMISSION env > tools/permissions.yaml
default_mode. Escalation is a NEW call with a wider mode + approval, never a
mutation of this call.

Usage:
    python tools/enforce-permission.py [--mode workspace-write] -- <command> [args...]
    python tools/enforce-permission.py --mode read-only -- pip install x   # -> 126
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXIT_DENIED = 126  # distinct from any real runner exit code

MODES = ("read-only", "workspace-write", "full")


def resolve_mode(requested: str = None) -> str:
    if requested:
        return requested
    env_mode = os.environ.get("MH_PERMISSION")
    if env_mode in MODES:
        return env_mode
    perms_file = PROJECT_ROOT / "tools" / "permissions.yaml"
    if perms_file.exists():
        with open(perms_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        default = data.get("default_mode", "workspace-write")
        if default in MODES:
            return default
    return "workspace-write"


def deny(code: str, reason: str) -> int:
    print(f"PERMISSION DENIED [{code}] {reason}", file=sys.stderr)
    return EXIT_DENIED


def main() -> int:
    parser = argparse.ArgumentParser(description="Confine a command under the active sandbox mode")
    parser.add_argument("--mode", default=None, choices=list(MODES),
                        help="sandbox mode (default: env MH_PERMISSION or permissions.yaml)")
    parser.add_argument("cmd", nargs=argparse.REMAINDER, help="-- <command> [args...]")
    args = parser.parse_args()

    if not args.cmd:
        print("ERROR: provide a command after --", file=sys.stderr)
        return 2
    cmd = args.cmd[1:] if args.cmd[0] == "--" else args.cmd
    if not cmd:
        print("ERROR: provide a command after --", file=sys.stderr)
        return 2

    mode = resolve_mode(args.mode)
    if mode not in MODES:
        return deny("PERMISSION_UNKNOWN_MODE", f"unknown mode {mode!r} -- fail-closed")

    perms_file = PROJECT_ROOT / "tools" / "permissions.yaml"
    if not perms_file.exists():
        return deny("PERMISSION_MODEL_MISSING", "tools/permissions.yaml not found")
    with open(perms_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    m = (data.get("modes") or {}).get(mode)
    if m is None:
        return deny("PERMISSION_MODE_UNCONFIGURED", f"mode {mode!r} not configured")

    command_line = " ".join(cmd)
    lower = command_line.lower()
    for pat in (m.get("forbidden_execute") or []):
        if re.search(pat, lower):
            return deny("PERMISSION_DENIED",
                        f"command matches forbidden pattern {pat!r} under mode {mode!r}; "
                        f"denial is FINAL -- escalate with a NEW call and approval")

    try:
        proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT))
    except FileNotFoundError:
        return deny("PERMISSION_RUNNER_MISSING", f"command not found: {cmd[0]}")
    # The runner's own exit code: a task failure is NOT a permission denial.
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
