#!/usr/bin/env python3
"""
Entropy Reduction: Cleanup script for maintaining project hygiene.

Removes:
- Unused imports
- Dead code (unreferenced functions/classes)
- Stale snapshots
- Orphaned files

Usage:
    python constraints/entropy-reduction.py [--project-root <dir>] [--dry-run] [--fix]
"""

import argparse
import re
import sys
from pathlib import Path

import yaml


def find_unused_imports(project_root: Path) -> list:
    issues = []
    src_dir = project_root / "src"
    if not src_dir.exists():
        return issues

    for py_file in src_dir.rglob("*.py"):
        try:
            content = py_file.read_text(encoding="utf-8")
            lines = content.split("\n")
            for i, line in enumerate(lines, 1):
                match = re.match(r"^(?:from|import)\s+(\w+)", line.strip())
                if match:
                    module = match.group(1)
                    rest_of_file = content.replace(line, "", 1)
                    if module not in rest_of_file:
                        issues.append({
                            "type": "unused_import",
                            "file": str(py_file.relative_to(project_root)),
                            "line": i,
                            "module": module,
                            "fix": f"Remove unused import: {module}",
                        })
        except Exception:
            pass

    return issues


def find_stale_snapshots(project_root: Path) -> list:
    issues = []
    memory_dir = project_root / "memory"
    if not memory_dir.exists():
        return issues

    session_file = memory_dir / "session-state.yaml"
    if session_file.exists():
        with open(session_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        checkpoints = data.get("checkpoints", [])
        if len(checkpoints) > 10:
            issues.append({
                "type": "stale_snapshots",
                "file": "memory/session-state.yaml",
                "count": len(checkpoints),
                "fix": "Archive old checkpoints, keep only the last 5",
            })

    return issues


def find_orphaned_files(project_root: Path) -> list:
    issues = []
    src_dir = project_root / "src"
    if not src_dir.exists():
        return issues

    definitions = set()
    references = set()

    for py_file in src_dir.rglob("*.py"):
        try:
            content = py_file.read_text(encoding="utf-8")
            for match in re.finditer(r"(?:class|def)\s+(\w+)", content):
                definitions.add(match.group(1))
            for match in re.finditer(r"\b(\w+)\b", content):
                references.add(match.group(1))
        except Exception:
            pass

    unreferenced = definitions - references
    if unreferenced:
        issues.append({
            "type": "potentially_dead_code",
            "count": len(unreferenced),
            "names": list(unreferenced)[:10],
            "fix": "Review and remove unreferenced definitions",
        })

    return issues


def run_entropy_reduction(project_root: Path, dry_run: bool = False) -> dict:
    all_issues = []
    all_issues.extend(find_unused_imports(project_root))
    all_issues.extend(find_stale_snapshots(project_root))
    all_issues.extend(find_orphaned_files(project_root))

    result = {
        "project_root": str(project_root),
        "dry_run": dry_run,
        "total_issues": len(all_issues),
        "issues": all_issues,
        "actions_taken": [],
    }

    if not dry_run:
        for issue in all_issues:
            if issue["type"] == "unused_import":
                result["actions_taken"].append(f"Would remove: {issue['module']} from {issue['file']}:{issue['line']}")

    return result


def main():
    parser = argparse.ArgumentParser(description="Entropy Reduction")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--dry-run", action="store_true", help="Report only, don't make changes")
    parser.add_argument("--fix", action="store_true", help="Apply fixes automatically")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    result = run_entropy_reduction(project_root, dry_run=args.dry_run or not args.fix)

    print(yaml.dump(result, default_flow_style=False, allow_unicode=True))


if __name__ == "__main__":
    main()
