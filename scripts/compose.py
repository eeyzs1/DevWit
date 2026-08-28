#!/usr/bin/env python3
"""
COMPOSE: merge harness-patch.yaml over harness-composition.yaml (WP4).

Borrowed from DSH's profile/patch model: a generated harness is a set of named
rows (universal primitives, LLM slots, checks), and a user patch overrides rows
BY ID without editing the generated files. Unknown patch ids are REFUSED
(fail-closed) -- a patch that names a row that does not exist cannot silently
no-op.

Row schema (harness-composition.yaml):
    version: 1
    rows:
      - id: verification/self-check.py   # unique, project-relative
        layer: verification
        kind: universal | slot | check
        source: seeds/verification/self-check.py
        runner: orchestrator | validate  # only for kind: check
        enabled: true
        config: {}

Patch schema (harness-patch.yaml):
    version: 1
    rows:
      - id: verification/self-check.py
        enabled: false
        config: {key: value}            # deep-merged into the row config

Usage:
    python scripts/compose.py --composition <harness-composition.yaml> \
        [--patch <harness-patch.yaml>] [--output <merged.yaml>]
Exit 0 = valid merged composition written; 1 = invalid (report on stderr).
"""

import argparse
import sys
from copy import deepcopy
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

KINDS = {"universal", "slot", "check"}
RUNNERS = {"orchestrator", "validate"}


def load_composition(path: Path) -> dict:
    if not path.exists():
        raise ValueError(f"composition not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    if not isinstance(doc, dict) or doc.get("version") != 1:
        raise ValueError(f"{path}: unknown composition version (expected 1)")
    rows = doc.get("rows")
    if not isinstance(rows, list):
        raise ValueError(f"{path}: 'rows' is not a list")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not row.get("id"):
            raise ValueError(f"{path}: row without an id")
        rid = row["id"]
        if rid in seen:
            raise ValueError(f"{path}: duplicate row id {rid!r}")
        seen.add(rid)
        if row.get("kind") not in KINDS:
            raise ValueError(f"{path}: row {rid!r} has unknown kind {row.get('kind')!r}")
        if row.get("kind") == "check" and row.get("runner") not in RUNNERS:
            raise ValueError(f"{path}: check row {rid!r} has unknown runner "
                             f"{row.get('runner')!r} (expected orchestrator|validate)")
    return doc


def load_patch(path: Path) -> list:
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    if not isinstance(doc, dict) or doc.get("version") != 1:
        raise ValueError(f"{path}: unknown patch version (expected 1)")
    rows = doc.get("rows")
    if not isinstance(rows, list):
        raise ValueError(f"{path}: 'rows' is not a list")
    return rows


def deep_merge(base: dict, overlay: dict) -> dict:
    result = deepcopy(base)
    for k, v in overlay.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = deep_merge(result[k], v)
        else:
            result[k] = deepcopy(v)
    return result


def compose(composition_path: Path, patch_path: Path = None) -> list:
    """Return the merged rows. Raises ValueError on any invalid input."""
    doc = load_composition(composition_path)
    by_id = {row["id"]: row for row in doc["rows"]}
    if patch_path is not None:
        for patch_row in load_patch(patch_path):
            rid = patch_row.get("id")
            if not rid:
                raise ValueError(f"{patch_path}: patch row without an id")
            if rid not in by_id:
                raise ValueError(
                    f"{patch_path}: patch references unknown row id {rid!r} "
                    f"-- fail-closed, refusing to apply")
            target = by_id[rid]
            if "enabled" in patch_row:
                target["enabled"] = bool(patch_row["enabled"])
            if "config" in patch_row:
                target["config"] = deep_merge(target.get("config") or {}, patch_row["config"])
    return doc["rows"]


def main():
    ap = argparse.ArgumentParser(description="Merge harness patches over the composition manifest")
    ap.add_argument("--composition", required=True, help="harness-composition.yaml")
    ap.add_argument("--patch", default=None, help="harness-patch.yaml (optional)")
    ap.add_argument("--output", default=None, help="merged composition output (default: stdout)")
    args = ap.parse_args()

    try:
        rows = compose(Path(args.composition), Path(args.patch) if args.patch else None)
    except ValueError as e:
        print(f"COMPOSE FAIL: {e}", file=sys.stderr)
        sys.exit(1)

    merged = {"version": 1, "rows": rows}
    text = yaml.dump(merged, default_flow_style=False, allow_unicode=True, sort_keys=False)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        print(f"compose OK -> {args.output}")
    else:
        sys.stdout.write(text)
    sys.exit(0)


if __name__ == "__main__":
    main()
