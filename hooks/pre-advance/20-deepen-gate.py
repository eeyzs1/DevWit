#!/usr/bin/env python3
"""
Pre-advance gate: INTERPRET -> GENERATE requires the DEEPEN contract output.

B (pipeline closure): the "first principles" interpretation is no longer
voluntary. Advancing from INTERPRET requires memory/deepen-corrections.yaml to
exist AND to satisfy the deepen schema (meta/prompt-contracts/deepen/schema.yaml).
The agent runs `python scripts/interpret.py --deepen memory/deepen-corrections.yaml
--task task.yaml` after the baseline `--interpret-intent`.

Contract:
  - Runs for every --advance; exit 0 = pass, non-zero = refuse the advance.
  - Context via MH_CONTEXT (JSON), never positional args.
  - Refusal code = this hook's filename stem (20-deepen-gate); reason = stderr.
  - For non-INTERPRET phases this hook is a no-op.
"""

import json
import os
import subprocess
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

corrections = META_ROOT / "memory" / "deepen-corrections.yaml"
if not corrections.exists():
    print("memory/deepen-corrections.yaml missing -- run the DEEPEN contract "
          "(`scripts/interpret.py --deepen memory/deepen-corrections.yaml "
          "--task task.yaml`) before advancing from INTERPRET", file=sys.stderr)
    sys.exit(1)

schema = META_ROOT / "meta" / "prompt-contracts" / "deepen" / "schema.yaml"
try:
    import validate_contract as vc
    errors = []
    output = vc.load_output(corrections)
    vc.validate_value(output, vc.load_schema(schema), "corrections", errors)
    if errors:
        print("deepen-corrections.yaml INVALID:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    print("deepen gate: corrections present and schema-valid")
    sys.exit(0)
except Exception as e:
    print(f"deepen gate error: {e}", file=sys.stderr)
    sys.exit(1)
