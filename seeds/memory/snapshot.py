#!/usr/bin/env python3
"""
Snapshot Manager: Git-based snapshot/rollback mechanism.

Creates checkpoints of the current project state using git tags,
lists available checkpoints, and restores to a previous checkpoint.

Usage:
    python memory/snapshot.py create <name>   — Create a checkpoint
    python memory/snapshot.py list            — List all checkpoints
    python memory/snapshot.py restore <name>  — Restore to a checkpoint
"""

import argparse
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def git_run(args: list, cwd: Path = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git"] + args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=cwd or Path.cwd(),
    )


def create_snapshot(name: str) -> None:
    tag_name = f"harness-snapshot-{name}"
    result = git_run(["tag", "-a", tag_name, "-m", f"Harness snapshot: {name} at {datetime.now().isoformat()}"])
    if result.returncode != 0:
        print(f"ERROR: Failed to create snapshot: {result.stderr.strip()}")
        sys.exit(1)
    print(f"✅ Snapshot created: {tag_name}")


def list_snapshots() -> None:
    result = git_run(["tag", "-l", "harness-snapshot-*"])
    if result.returncode != 0:
        print(f"ERROR: Failed to list snapshots: {result.stderr.strip()}")
        sys.exit(1)
    tags = result.stdout.strip().split("\n") if result.stdout.strip() else []
    if not tags:
        print("No snapshots found.")
        return
    print(f"Found {len(tags)} snapshot(s):")
    for tag in tags:
        msg_result = git_run(["tag", "-n1", tag])
        print(f"  {tag}: {msg_result.stdout.strip()}")


def restore_snapshot(name: str) -> None:
    tag_name = f"harness-snapshot-{name}"
    result = git_run(["rev-parse", tag_name])
    if result.returncode != 0:
        print(f"ERROR: Snapshot not found: {tag_name}")
        sys.exit(1)

    print(f"⚠️  WARNING: This will restore to snapshot '{tag_name}'.")
    print(f"   Uncommitted changes will be lost.")
    confirm = input("Continue? (y/N): ").strip().lower()
    if confirm != "y":
        print("Aborted.")
        return

    git_run(["checkout", tag_name])
    print(f"✅ Restored to snapshot: {tag_name}")


def main():
    parser = argparse.ArgumentParser(description="Harness Snapshot Manager")
    subparsers = parser.add_subparsers(dest="command")

    create_parser = subparsers.add_parser("create", help="Create a snapshot")
    create_parser.add_argument("name", help="Snapshot name")

    subparsers.add_parser("list", help="List all snapshots")

    restore_parser = subparsers.add_parser("restore", help="Restore to a snapshot")
    restore_parser.add_argument("name", help="Snapshot name to restore")

    args = parser.parse_args()

    if args.command == "create":
        create_snapshot(args.name)
    elif args.command == "list":
        list_snapshots()
    elif args.command == "restore":
        restore_snapshot(args.name)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
