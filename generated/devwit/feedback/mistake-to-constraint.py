#!/usr/bin/env python3
"""
Mistake-to-Constraint: Reads meta-mistakes, extracts root causes, proposes new constraints.

This script closes the feedback loop: every mistake should produce
a new or strengthened constraint (ADR-002).

Usage:
    python feedback/mistake-to-constraint.py [--mistakes-file <path>] [--output <constraints-file>]
"""

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

import yaml


def parse_mistakes(mistakes_file: Path) -> list:
    if not mistakes_file.exists():
        return []

    content = mistakes_file.read_text(encoding="utf-8")
    mistakes = []
    current = {}

    for line in content.split("\n"):
        if line.startswith("## Meta-Mistake"):
            if current:
                mistakes.append(current)
            current = {"raw": line}
        elif line.startswith("Status:"):
            current["status"] = line.split(":", 1)[1].strip()
        elif line.startswith("Root Cause:"):
            current["root_cause"] = line.split(":", 1)[1].strip()
        elif line.startswith("Lesson:"):
            current["lesson"] = line.split(":", 1)[1].strip()

    if current:
        mistakes.append(current)

    return [m for m in mistakes if m.get("status") != "Resolved" and m.get("root_cause")]


def propose_constraints(mistakes: list, existing_constraints: list) -> list:
    existing_rules = {c.get("rule", "").lower() for c in existing_constraints}
    proposals = []
    constraint_id = len(existing_constraints) + 1

    for mistake in mistakes:
        root_cause = mistake.get("root_cause", "")
        lesson = mistake.get("lesson", root_cause)

        if not root_cause:
            continue

        rule_text = lesson if lesson else f"Prevent: {root_cause}"

        if rule_text.lower() not in existing_rules:
            proposals.append({
                "id": f"C{constraint_id:03d}",
                "rule": rule_text,
                "source": f"meta-mistake: {root_cause}",
                "last_triggered": None,
                "trigger_count": 0,
                "proposed_at": datetime.now().isoformat(),
                "evidence": mistake.get("root_cause", ""),
            })
            constraint_id += 1

    return proposals


def main():
    parser = argparse.ArgumentParser(description="Mistake-to-Constraint Converter")
    parser.add_argument("--mistakes-file", default="memory/meta-mistakes.md", help="Path to meta-mistakes file")
    parser.add_argument("--constraints-file", default="constraints/architecture-rules.yaml", help="Path to existing constraints")
    parser.add_argument("--output", default=None, help="Output file for proposed constraints")
    args = parser.parse_args()

    mistakes = parse_mistakes(Path(args.mistakes_file))
    print(f"Found {len(mistakes)} unresolved mistakes with root causes")

    existing = []
    constraints_path = Path(args.constraints_file)
    if constraints_path.exists():
        with open(constraints_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
            existing = data.get("rules", [])

    proposals = propose_constraints(mistakes, existing)

    if not proposals:
        print("No new constraints to propose.")
        return

    print(f"\nProposed {len(proposals)} new constraint(s):")
    for p in proposals:
        print(f"  [{p['id']}] {p['rule']}")
        print(f"       Evidence: {p['evidence']}")

    output = yaml.dump({"proposed_constraints": proposals}, default_flow_style=False, allow_unicode=True)

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
        print(f"\nProposals written to: {args.output}")
    else:
        print(f"\n{output}")


if __name__ == "__main__":
    main()
