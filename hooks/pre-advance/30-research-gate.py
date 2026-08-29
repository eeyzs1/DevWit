#!/usr/bin/env python3
"""
Pre-advance bail gate: INTERPRET -> GENERATE requires the RESEARCH contract
output for unknown domains (A+B).

First principles: when the domain classifier flags the task as likely unfamiliar
(complexity.novelty >= 3), the agent must LEARN the domain before locking
criteria and generating. `memory/research-findings.yaml` must exist AND satisfy
the research schema (meta/prompt-contracts/research/schema.yaml) with at least
one grounded http(s) source_url per findings (pure assumption is not research).

Familiar tasks (novelty < 3) are a no-op: research is a conditional cost, not a
mandatory tax on every task.

Contract:
  - Runs for every --advance; exit 0 = pass, non-zero = refuse the advance.
  - Context via MH_CONTEXT (JSON), never positional args.
  - Refusal code = this hook's filename stem (30-research-gate); reason = stderr.
  - For non-INTERPRET phases or familiar domains this hook is a no-op (pass).
"""

import json
import os
import sys
from pathlib import Path

META_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = META_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

try:
    ctx = json.loads(os.environ.get("MH_CONTEXT", "{}"))
except Exception:
    ctx = {}

if ctx.get("phase") != "INTERPRET":
    sys.exit(0)

task_file = META_ROOT / "task.yaml"
if not task_file.exists():
    # Nothing interpreted yet -> nothing to research.
    sys.exit(0)

import yaml  # noqa: E402

with open(task_file, "r", encoding="utf-8") as f:
    task = yaml.safe_load(f) or {}

cx = task.get("complexity") or {}
try:
    novelty = int(cx.get("novelty", 3) or 3)
except (TypeError, ValueError):
    novelty = 3

if novelty < 3:
    print(f"research gate: domain familiar (novelty={novelty}) — research not required")
    sys.exit(0)

findings_file = META_ROOT / "memory" / "research-findings.yaml"
if not findings_file.exists():
    print("memory/research-findings.yaml missing — run the RESEARCH contract "
          "(`scripts/interpret.py --research memory/research-findings.yaml "
          "--task task.yaml --output task.yaml`) before advancing from INTERPRET "
          f"(domain novelty={novelty} >= 3)", file=sys.stderr)
    sys.exit(1)

try:
    import interpret as it  # noqa: E402
    errors = it.validate_research(findings_file, task)
    if errors:
        print("research-findings.yaml INVALID:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    print("research gate: findings present and schema-valid")
    sys.exit(0)
except Exception as e:
    print(f"research gate error: {e}", file=sys.stderr)
    sys.exit(1)
