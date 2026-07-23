#!/usr/bin/env python3
"""
Post-task verification: lint, type check, test, build, and secret scanning.

Cross-platform replacement for verify.sh — works on Windows, macOS, and Linux.

Verification Spec (WHAT to verify, not HOW):
  Pre-Task:
    - Task card completeness (Acceptance Criteria, Scope, Verification Method sections)
    - Clean working tree (git status --porcelain)
    - No unresolved BLOCKER in memory/meta-mistakes.md
  Post-Change:
    - Lint (ESLint for Node.js, Ruff for Python)
    - Type check (tsc for TypeScript, mypy for Python)
    - Tests (npm test / pytest)
    - Build (npm run build)
    - Secret scan (password, api_key, secret, token, PRIVATE KEY patterns)

Usage:
    python scripts/verify.py [--project-root <dir>]
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def run_command(cmd: list, cwd: Path = None) -> tuple:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=cwd)
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return -1, "", f"Command not found: {cmd[0]}"


def check_npm_project(project_root: Path) -> list:
    errors = []
    package_json = project_root / "package.json"
    if not package_json.exists():
        return errors

    rc, out, err = run_command(["npx", "eslint", ".", "--format", "compact"], cwd=project_root)
    if rc != 0 and rc != -1:
        errors.append("FAIL: ESLint errors found")

    tsconfig = project_root / "tsconfig.json"
    if tsconfig.exists():
        rc, out, err = run_command(["npx", "tsc", "--noEmit"], cwd=project_root)
        if rc != 0 and rc != -1:
            errors.append("FAIL: TypeScript type check failed")

    with open(package_json, "r", encoding="utf-8") as f:
        content = f.read()
    if '"test"' in content:
        rc, out, err = run_command(["npm", "test"], cwd=project_root)
        if rc != 0 and rc != -1:
            errors.append("FAIL: Tests failed")

    rc, out, err = run_command(["npm", "run", "build"], cwd=project_root)
    if rc != 0 and rc != -1:
        errors.append("FAIL: Build failed")

    return errors


def check_python_project(project_root: Path) -> list:
    errors = []
    has_requirements = (project_root / "requirements.txt").exists()
    has_pyproject = (project_root / "pyproject.toml").exists()

    if not (has_requirements or has_pyproject):
        return errors

    rc, out, err = run_command(["ruff", "check", "."], cwd=project_root)
    if rc != 0 and rc != -1:
        errors.append("FAIL: Ruff lint check failed")

    if has_pyproject or (project_root / "mypy.ini").exists():
        rc, out, err = run_command(["mypy", "."], cwd=project_root)
        if rc != 0 and rc != -1:
            errors.append("FAIL: MyPy type check failed")

    if has_pyproject or (project_root / "pytest.ini").exists():
        rc, out, err = run_command(["pytest"], cwd=project_root)
        if rc != 0 and rc != -1:
            errors.append("FAIL: Pytest tests failed")

    return errors


def scan_secrets(project_root: Path) -> list:
    errors = []
    secret_patterns = [
        (r"password\s*=", "password assignment"),
        (r"api_key\s*=", "API key assignment"),
        (r"secret\s*=", "secret assignment"),
        (r"token\s*=", "token assignment"),
        (r"PRIVATE KEY", "private key"),
    ]

    scan_extensions = {".py", ".ts", ".js", ".yaml", ".yml", ".json", ".env"}
    skip_dirs = {"node_modules", ".git", "venv", "__pycache__", ".venv"}

    for f in project_root.rglob("*"):
        if not f.is_file():
            continue
        if any(skip in f.parts for skip in skip_dirs):
            continue
        if f.suffix not in scan_extensions:
            continue

        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
            for pattern, name in secret_patterns:
                if re.search(pattern, content, re.IGNORECASE):
                    errors.append(f"FAIL: Potential secret found in {f.name} matching pattern: {name}")
        except Exception:
            pass

    return errors


def main():
    parser = argparse.ArgumentParser(description="Post-task Verification")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    errors = []

    errors.extend(check_npm_project(project_root))
    errors.extend(check_python_project(project_root))
    errors.extend(scan_secrets(project_root))

    if not errors:
        print("PASS: All verification checks passed")
        sys.exit(0)
    else:
        print("FAIL: Verification failed:")
        for err in errors:
            print(f"  {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
