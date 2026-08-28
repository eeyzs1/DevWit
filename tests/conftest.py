"""Shared fixtures for meta-harness integration tests."""

import shutil
import sys
from pathlib import Path

import pytest

HARNESS_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def meta_root(tmp_path):
    """A minimal, runnable copy of the meta-harness pipeline in tmp_path.

    Enough for `python meta/meta-orchestrator.py ...` to work: the orchestrator,
    its scripts/ helpers, and the shipped hooks.
    """
    root = tmp_path / "meta-harness"
    (root / "meta").mkdir(parents=True)
    (root / "scripts").mkdir()
    (root / "hooks" / "pre-advance").mkdir(parents=True)
    shutil.copy2(HARNESS_ROOT / "meta" / "meta-orchestrator.py", root / "meta" / "meta-orchestrator.py")
    for script in ("state_fold.py", "brief_gen.py", "log_invariant.py",
                   "compact_context.py", "spill.py", "events.py", "interpret.py"):
        shutil.copy2(HARNESS_ROOT / "scripts" / script, root / "scripts" / script)
    shutil.copy2(HARNESS_ROOT / "hooks" / "pre-advance" / "10-validate-harness.py",
                 root / "hooks" / "pre-advance" / "10-validate-harness.py")
    return root


@pytest.fixture
def run_py():
    """Run a python script in a dir, returning (returncode, stdout)."""
    def _run(cwd, *args):
        import subprocess
        proc = subprocess.run([sys.executable, *args], cwd=str(cwd),
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace")
        return proc.returncode, proc.stdout + proc.stderr
    return _run
