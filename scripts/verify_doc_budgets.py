#!/usr/bin/env python3
"""
VERIFY-DOC-BUDGETS: enforce documentation budgets in a generated harness (WP12).

Borrowed from DSH's doc-budget discipline: rule/context files stay within a
line budget so the agent can actually hold them, and each fact lives in ONE
home (a duplicated heading/paragraph is flagged as a single-home violation).

Budgets (adjust in the table below):
    AGENTS.md / CLAUDE.md / README.md       200 lines
    constraints/*.yaml                       300 lines
    context/*.yaml                           300 lines

Exit: 0 = PASS, 1 = FAIL (over-budget files), 2 = usage error.
Usage:
    python scripts/verify_doc_budgets.py <harness_dir>
"""

import re
import sys
from pathlib import Path

DEFAULT_BUDGET = 300
BUDGETS = {
    "AGENTS.md": 200,
    "CLAUDE.md": 200,
    "README.md": 200,
    ".cursorrules": 200,
}

# A fact has one home: identical non-trivial lines appearing in two DIFFERENT
# files are flagged (e.g. the same rule copy-pasted into AGENTS.md and README.md).
MIN_DUPLICATE_LINE = 60


def check(harness_dir: Path) -> tuple:
    """Return (passed, report_lines). Over-budget = FAIL; duplicates = WARN."""
    report = []
    errors = []
    warnings = []
    report.append("=== Doc Budgets ===")

    seen_lines = {}
    for fname, budget in BUDGETS.items():
        f = harness_dir / fname
        if not f.exists():
            continue
        lines = f.read_text(encoding="utf-8").splitlines()
        if len(lines) > budget:
            msg = f"  OVER BUDGET: {fname} has {len(lines)} lines (limit {budget})"
            report.append(msg)
            errors.append(msg)
        else:
            report.append(f"  PASS -- {fname}: {len(lines)}/{budget} lines")
        # single-home: index non-trivial lines
        for line in lines:
            stripped = line.strip()
            if len(stripped) < MIN_DUPLICATE_LINE:
                continue
            seen_lines.setdefault(stripped, []).append(fname)

    for layer in ("constraints", "context", "planning", "verification", "seams"):
        for f in sorted((harness_dir / layer).glob("*.yaml")) if (harness_dir / layer).exists() else []:
            lines = f.read_text(encoding="utf-8").splitlines()
            if len(lines) > DEFAULT_BUDGET:
                msg = f"  OVER BUDGET: {f.relative_to(harness_dir)} has {len(lines)} lines (limit {DEFAULT_BUDGET})"
                report.append(msg)
                errors.append(msg)
            for line in lines:
                stripped = line.strip()
                if len(stripped) < MIN_DUPLICATE_LINE:
                    continue
                seen_lines.setdefault(stripped, []).append(str(f.relative_to(harness_dir)))

    dupes = {text: files for text, files in seen_lines.items()
             if len(set(files)) > 1}
    if dupes:
        for text, files in list(dupes.items())[:5]:
            msg = f"  DUPLICATE FACT across files {sorted(set(files))}: {text[:70]}..."
            report.append(msg)
            warnings.append(msg)
    else:
        report.append("  PASS -- no duplicated facts across files")

    passed = len(errors) == 0
    report.append(f"  Result: {'PASS' if passed else 'FAIL'} ({len(errors)} errors, {len(warnings)} warnings)")
    return passed, report


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/verify_doc_budgets.py <harness_dir>")
        sys.exit(2)
    harness_dir = Path(sys.argv[1]).resolve()
    if not harness_dir.is_dir():
        print(f"ERROR: {harness_dir} is not a directory")
        sys.exit(2)
    passed, report = check(harness_dir)
    print("\n".join(report))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
