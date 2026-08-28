#!/usr/bin/env python3
"""
Pre-advance bail gate: GENERATE -> FACTORY requires validate-harness.py PASS.

Contract (see hooks/README.md):
  - Runs for every --advance; exit 0 = pass, non-zero = refuse the advance.
  - Context arrives via the MH_CONTEXT env var (JSON), never via arguments.
  - The refusal code is this hook's filename stem (10-validate-harness); the
    reason is this hook's stderr/stdout.
  - For non-GENERATE phases this hook is a no-op (pass).
"""

import json
import os
import subprocess
import sys
from pathlib import Path

META_ROOT = Path(__file__).resolve().parent.parent.parent

try:
    ctx = json.loads(os.environ.get("MH_CONTEXT", "{}"))
except Exception:
    ctx = {}

if ctx.get("phase") != "GENERATE":
    sys.exit(0)

gen_dir = ctx.get("generated_project_dir")
if not gen_dir:
    print("generated_project_dir not set (run scaffold.py Step 1 first)", file=sys.stderr)
    sys.exit(1)
if not Path(gen_dir).exists():
    print(f"generated directory does not exist: {gen_dir}", file=sys.stderr)
    sys.exit(1)

validate = META_ROOT / "scripts" / "validate-harness.py"
if not validate.exists():
    print(f"validate-harness.py not found at {validate}", file=sys.stderr)
    sys.exit(1)

proc = subprocess.run([sys.executable, str(validate), gen_dir], cwd=str(META_ROOT),
                      capture_output=True, text=True, encoding="utf-8", errors="replace")
sys.stdout.write(proc.stdout)
sys.stderr.write(proc.stderr)
sys.exit(proc.returncode)
