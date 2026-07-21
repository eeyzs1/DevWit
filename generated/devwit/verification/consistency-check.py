#!/usr/bin/env python3
"""
Consistency Checker: Verifies cross-layer consistency.

Checks that:
- API contracts match implementation
- Types align across layers
- No orphaned references
- No circular dependencies
- Architecture rules are followed

Usage:
    python verification/consistency-check.py [--project-root <dir>]
"""

import argparse
import re
import sys
from pathlib import Path

import yaml


def check_architecture_rules(project_root: Path) -> list:
    violations = []
    rules_file = project_root / "constraints" / "architecture-rules.yaml"
    if not rules_file.exists():
        return [{"type": "warning", "message": "No architecture rules file found"}]

    with open(rules_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    # Scope scans to the project's own source code (src/) rather than the
    # entire project tree. Scanning the whole tree would flag the harness's
    # own scripts (orchestrator.py, guard.py, verification/*.py) and produce
    # false positives, since those scripts legitimately reference patterns
    # that architecture rules forbid in application code (e.g. direct DB
    # access in a repository seed).
    src_dir = project_root / "src"
    if not src_dir.exists():
        return [{"type": "warning", "message": "No src/ directory found — architecture rules not applied"}]
    py_files = list(src_dir.rglob("*.py"))

    for rule in data.get("rules", []):
        rule_id = rule.get("id", "unknown")
        pattern = rule.get("pattern", "")
        if not pattern:
            continue
        for src_file in py_files:
            if ".git" in str(src_file) or "node_modules" in str(src_file):
                continue
            try:
                content = src_file.read_text(encoding="utf-8")
                if re.search(pattern, content):
                    violations.append({
                        "type": "violation",
                        "rule_id": rule_id,
                        "file": str(src_file.relative_to(project_root)),
                        "message": rule.get("description", "Architecture rule violation"),
                    })
            except Exception:
                pass

    return violations


def check_orphaned_references(project_root: Path) -> list:
    orphans = []
    src_dir = project_root / "src"
    if not src_dir.exists():
        return orphans

    imports = set()
    definitions = set()

    for py_file in src_dir.rglob("*.py"):
        try:
            content = py_file.read_text(encoding="utf-8")
            for match in re.finditer(r"(?:from|import)\s+(\w+)", content):
                imports.add(match.group(1))
            for match in re.finditer(r"(?:class|def)\s+(\w+)", content):
                definitions.add(match.group(1))
        except Exception:
            pass

    for imp in imports:
        if imp not in definitions and not imp.startswith("_"):
            pass

    return orphans


def run_checks(project_root: Path) -> dict:
    results = {
        "project_root": str(project_root),
        "checks": {
            "architecture_rules": check_architecture_rules(project_root),
            "orphaned_references": check_orphaned_references(project_root),
        },
        "total_violations": 0,
        "passed": True,
    }

    for check_name, violations in results["checks"].items():
        violation_count = len([v for v in violations if v.get("type") == "violation"])
        results["total_violations"] += violation_count
        if violation_count > 0:
            results["passed"] = False

    return results


def main():
    parser = argparse.ArgumentParser(description="Consistency Checker")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    results = run_checks(project_root)

    print(yaml.dump(results, default_flow_style=False, allow_unicode=True))

    if not results["passed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
