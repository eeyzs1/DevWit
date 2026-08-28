#!/usr/bin/env python3
"""
LOG INVARIANT (Fusion Plan v3 — A-WU1/A-WU2): fail-closed integrity gate for the
append-only event log.

Borrowed from meta-harness v3.0 scripts/log_invariant.py. Refuses (exit non-zero):
  - unknown log version / unknown event types
  - seq gaps / duplicates
  - stale projection watermark (asOfSeq < log length)
  - orphaned compaction markers (added when --compact lands, A-WU7)

Warns (exit 0) when the projection is not yet log-derived (no asOfSeq).

Usage:
    python runtime/log_invariant.py --project-root <dir>
    python runtime/log_invariant.py --project-root <dir> --strict
"""

import argparse
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import event_log  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Fail-closed event log invariant gate")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--strict", action="store_true",
                        help="treat warnings as failures too")
    args = parser.parse_args()

    root = Path(args.project_root).resolve()
    problems, warnings = event_log.check_invariants(root)

    for p in problems:
        print(f"PROBLEM: {p}", file=sys.stderr)
    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)

    if problems:
        print(f"INVARIANTS FAIL ({len(problems)} problems)", file=sys.stderr)
        return 1
    if args.strict and warnings:
        print(f"INVARIANTS FAIL (strict, {len(warnings)} warnings)", file=sys.stderr)
        return 1
    print(f"INVARIANTS PASS (warnings: {len(warnings)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
