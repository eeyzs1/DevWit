#!/usr/bin/env python3
"""
Pre-task checks: task card completeness, git status, blockers.

Cross-platform replacement for pre-task.sh — works on Windows, macOS, and Linux.

Usage:
    python scripts/pre-task.py [--task <task-file>] [--project-root <dir>]
"""

import argparse
import subprocess
import sys
from pathlib import Path

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def check_task_card(task_file: Path) -> list:
    errors = []
    if not task_file or not task_file.exists():
        if task_file:
            errors.append(f"FAIL: Task file not found: {task_file}")
        return errors

    content = task_file.read_text(encoding="utf-8")

    required_sections = [
        ("Acceptance Criteria", "Task card missing 'Acceptance Criteria' section"),
        ("Scope", "Task card missing 'Scope' section"),
        ("Verification Method", "Task card missing 'Verification Method' section"),
    ]

    for section, error_msg in required_sections:
        if section.lower() not in content.lower():
            errors.append(f"FAIL: {error_msg}")

    return errors


def check_git_status(project_root: Path) -> list:
    errors = []
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=project_root,
        )
        if result.stdout.strip():
            errors.append("FAIL: Working tree has uncommitted changes. Commit or stash before starting.")
    except FileNotFoundError:
        pass
    return errors


def check_blockers(project_root: Path) -> list:
    errors = []
    mistakes_file = project_root / "memory" / "meta-mistakes.md"
    if mistakes_file.exists():
        content = mistakes_file.read_text(encoding="utf-8")
        if "BLOCKER:" in content:
            errors.append("FAIL: Unresolved blockers in memory/meta-mistakes.md. Resolve before proceeding.")
    return errors


def main():
    parser = argparse.ArgumentParser(description="Pre-Task Checks")
    parser.add_argument("--task", default=None, help="Path to task card file")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    errors = []

    if args.task:
        errors.extend(check_task_card(Path(args.task)))

    errors.extend(check_git_status(project_root))
    errors.extend(check_blockers(project_root))

    if not errors:
        print("PASS: All pre-task checks passed")
        sys.exit(0)
    else:
        print("FAIL: Pre-task checks failed:")
        for err in errors:
            print(f"  {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
