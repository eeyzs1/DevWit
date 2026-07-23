#!/usr/bin/env python3
"""
Quality Score: Measure harness quality across multiple dimensions.

Cross-platform replacement for quality-score.sh — works on Windows, macOS, and Linux.

Usage:
    python scripts/quality-score.py [--project-root <dir>]
"""

import re
import sys
from pathlib import Path

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def count_mistake_metrics(project_root: Path) -> dict:
    mistakes_file = project_root / "memory" / "meta-mistakes.md"
    if not mistakes_file.exists():
        return {"total": 0, "resolved": 0, "recurrence_rate": 0}

    content = mistakes_file.read_text(encoding="utf-8")
    total = content.count("## Meta-Mistake")
    resolved = content.count("Status: Resolved")
    recurrence_rate = ((total - resolved) * 100 // total) if total > 0 else 0

    return {"total": total, "resolved": resolved, "recurrence_rate": recurrence_rate}


def count_generated_projects(project_root: Path) -> int:
    generated_dir = project_root / "generated"
    if not generated_dir.exists():
        return 0
    return sum(1 for d in generated_dir.iterdir() if d.is_dir())


def count_templates(project_root: Path) -> int:
    templates_dir = project_root / "templates"
    if not templates_dir.exists():
        return 0
    return sum(1 for d in templates_dir.iterdir() if d.is_dir() and (d / "template.md").exists())


def count_seed_artifacts(project_root: Path) -> dict:
    seeds_dir = project_root / "seeds"
    if not seeds_dir.exists():
        return {"layers_with_seeds": 0, "total_seed_files": 0}

    layers = 0
    files = 0
    for layer_dir in seeds_dir.iterdir():
        if layer_dir.is_dir():
            layer_files = list(layer_dir.rglob("*"))
            layer_file_count = sum(1 for f in layer_files if f.is_file())
            if layer_file_count > 0:
                layers += 1
                files += layer_file_count

    return {"layers_with_seeds": layers, "total_seed_files": files}


def main(project_root: Path = None):
    if project_root is None:
        project_root = Path(".").resolve()
    elif isinstance(project_root, str):
        project_root = Path(project_root).resolve()

    print("=== Harness Quality Score ===\n")

    mistakes = count_mistake_metrics(project_root)
    if mistakes["total"] > 0:
        print(f"  Mistake Recurrence Rate: {mistakes['recurrence_rate']}% (lower is better)")
        print(f"  Total Mistakes: {mistakes['total']}, Resolved: {mistakes['resolved']}")

    gen_count = count_generated_projects(project_root)
    print(f"  Generated Projects: {gen_count}")

    template_count = count_templates(project_root)
    print(f"  Domain Templates: {template_count}")

    seeds = count_seed_artifacts(project_root)
    print(f"  Seed Layers: {seeds['layers_with_seeds']}/10")
    print(f"  Seed Artifacts: {seeds['total_seed_files']}")

    print("\n=== Recommendations ===")
    if mistakes["recurrence_rate"] > 20:
        print("  HIGH recurrence rate. Review memory/meta-mistakes.md and improve pipeline.")
    if seeds["layers_with_seeds"] < 10:
        print(f"  INCOMPLETE seeds: {10 - seeds['layers_with_seeds']} layers missing seed artifacts.")
    if gen_count == 0:
        print("  NO generated projects yet. Run: python scripts/generate.py --task <task-file>")


if __name__ == "__main__":
    main()
