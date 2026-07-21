#!/usr/bin/env python3
"""
ANTI-MOCK CHECK: Scans source code for mock, fake, stub, and simulation patterns.

This scanner detects when AI has produced simulated/mocked implementations
instead of real integrations. It is invoked automatically by orchestrator.py
during verification and can also be run standalone.

Detection categories:
1. Mock class names: Mock*, Fake*, Stub*, Dummy*, Simulated*
2. Mock return values: hardcoded data where API calls should be
3. Mock comments: "replace with real", "this would normally", "simulated", etc.
4. Mock imports: mock, unittest.mock, fakeredis, moto, responses, etc.
5. Placeholder patterns: return {"mock": true}, return [] with comment about "would return"

Usage:
    python verification/anti-mock-check.py --project-root <dir>
    python verification/anti-mock-check.py --project-root . --strict
    python verification/anti-mock-check.py --project-root . --output-json
"""

import argparse
import json
import re
import sys
from pathlib import Path

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MOCK_CLASS_PATTERNS = [
    (r'\bclass\s+(Mock\w+|Fake\w+|Stub\w+|Dummy\w+|Simulated\w+)', "mock_class_name"),
]

MOCK_RETURN_PATTERNS = [
    (r'return\s*\{\s*["\'](?:mock|fake|simulated|dummy|stub)["\']\s*:', "mock_return_value"),
    (r'return\s*\{\s*["\'](?:message|response|result)["\']\s*:\s*["\'][^"\']*(?:mock|fake|simulated|placeholder|dummy|test)[^"\']*["\']', "mock_return_value"),
    (r'yield\s*\{\s*["\'](?:mock|fake|simulated|dummy|stub)["\']\s*:', "mock_return_value"),
]

MOCK_COMMENT_PATTERNS = [
    (r'#.*(?:replace\s+with\s+real|this\s+would\s+normally|in\s+production\s+this\s+would|TODO.*real\s+implementation|FIXME.*mock|placeholder.*real|simulated\s+(?:response|data|result))', "mock_comment"),
    (r'"""[\s\S]*?(?:replace\s+with\s+real|simulated\s+(?:response|data|result)|placeholder\s+(?:response|data)|mock\s+(?:response|data|result))[\s\S]*?"""', "mock_docstring"),
]

MOCK_IMPORT_PATTERNS = [
    (r'(?:from|import)\s+(?:mock|unittest\.mock|faker\.providers|moto|responses|fakeredis|mongomock)', "mock_import"),
]

PRODUCTION_DIRS = {"src", "lib", "app", "api", "services", "routes", "controllers", "handlers", "repositories", "models", "utils", "core", "config", "middleware"}
TEST_DIRS = {"tests", "test", "spec", "__tests__", "testing"}

SKIP_EXTENSIONS = {".md", ".txt", ".yaml", ".yml", ".json", ".toml", ".cfg", ".ini", ".css", ".svg", ".png", ".jpg", ".ico"}
CODE_EXTENSIONS = {".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".cs", ".c", ".cpp", ".h", ".hpp"}


def is_production_file(file_path: Path, project_root: Path) -> bool:
    parts = file_path.relative_to(project_root).parts
    if not parts:
        return False
    top_dir = parts[0]
    if top_dir in TEST_DIRS:
        return False
    if top_dir in PRODUCTION_DIRS:
        return True
    if len(parts) > 1 and parts[0] == "src":
        return True
    return False


def scan_file(file_path: Path, project_root: Path, strict: bool) -> list:
    violations = []
    is_prod = is_production_file(file_path, project_root)

    if file_path.suffix.lower() in SKIP_EXTENSIONS:
        return violations

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return violations

    for pattern, violation_type in MOCK_CLASS_PATTERNS:
        for match in re.finditer(pattern, content):
            line_no = content[:match.start()].count("\n") + 1
            violations.append({
                "file": str(file_path.relative_to(project_root)),
                "line": line_no,
                "match": match.group(1),
                "type": violation_type,
                "severity": "BLOCKED" if is_prod else "WARNING",
            })

    for pattern, violation_type in MOCK_RETURN_PATTERNS:
        for match in re.finditer(pattern, content, re.IGNORECASE):
            line_no = content[:match.start()].count("\n") + 1
            if is_prod or strict:
                violations.append({
                    "file": str(file_path.relative_to(project_root)),
                    "line": line_no,
                    "match": match.group(0)[:80],
                    "type": violation_type,
                    "severity": "BLOCKED" if is_prod else "WARNING",
                })

    for pattern, violation_type in MOCK_COMMENT_PATTERNS:
        for match in re.finditer(pattern, content, re.IGNORECASE):
            line_no = content[:match.start()].count("\n") + 1
            violations.append({
                "file": str(file_path.relative_to(project_root)),
                "line": line_no,
                "match": match.group(0)[:80],
                "type": violation_type,
                "severity": "WARNING",
            })

    for pattern, violation_type in MOCK_IMPORT_PATTERNS:
        for match in re.finditer(pattern, content, re.IGNORECASE):
            line_no = content[:match.start()].count("\n") + 1
            if is_prod or not any(d in str(file_path.relative_to(project_root)).lower() for d in TEST_DIRS):
                violations.append({
                    "file": str(file_path.relative_to(project_root)),
                    "line": line_no,
                    "match": match.group(0)[:80],
                    "type": violation_type,
                    "severity": "BLOCKED" if is_prod else "WARNING",
                })

    return violations


def scan_project(project_root: Path, strict: bool = False) -> dict:
    violations = []
    scanned = 0
    production_files = 0
    test_files = 0

    for file_path in project_root.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in CODE_EXTENSIONS:
            continue
        if any(p in file_path.parts for p in [".git", "node_modules", "__pycache__", "venv", ".venv", "dist", "build", ".next", "generated"]):
            continue

        scanned += 1
        rel_parts = file_path.relative_to(project_root).parts
        if any(d in TEST_DIRS for d in rel_parts):
            test_files += 1
        elif rel_parts and rel_parts[0] in PRODUCTION_DIRS or (len(rel_parts) > 1 and rel_parts[0] == "src"):
            production_files += 1

        file_violations = scan_file(file_path, project_root, strict)
        violations.extend(file_violations)

    blockers = [v for v in violations if v["severity"] == "BLOCKED"]
    warnings = [v for v in violations if v["severity"] == "WARNING"]

    return {
        "project_root": str(project_root),
        "scanned_files": scanned,
        "production_files": production_files,
        "test_files": test_files,
        "total_violations": len(violations),
        "blockers": len(blockers),
        "warnings": len(warnings),
        "violations": violations,
        "verdict": "PASS" if len(blockers) == 0 else "FAIL",
    }


def print_report(result: dict) -> None:
    print("\n" + "=" * 70)
    print("ANTI-MOCK CHECK REPORT")
    print("=" * 70)
    print(f"Project: {result['project_root']}")
    print(f"Files scanned: {result['scanned_files']} ({result['production_files']} production, {result['test_files']} test)")
    print(f"Violations: {result['total_violations']} ({result['blockers']} BLOCKERS, {result['warnings']} warnings)")
    print(f"Verdict: {result['verdict']}")

    if result["violations"]:
        print(f"\n--- Violations ---")
        for v in result["violations"]:
            icon = "🛑" if v["severity"] == "BLOCKED" else "⚠️"
            print(f"  {icon} [{v['type']}] {v['file']}:{v['line']}")
            print(f"      {v['match']}")

    print("\n" + "=" * 70)
    if result["verdict"] == "PASS":
        print("✅ ANTI-MOCK CHECK PASSED — no mock patterns in production code")
    else:
        print("🛑 ANTI-MOCK CHECK FAILED — mock patterns found in production code")
        print("   Delete all mock implementations. Use real integrations.")
        print("   If a real service is unavailable, STOP and tell the user what's missing.")
    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Anti-Mock Check — Detects mock/fake/simulated patterns in source code")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--strict", action="store_true", help="Report all mock patterns including in test files")
    parser.add_argument("--output-json", action="store_true", help="Output results as JSON")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    if not project_root.exists():
        print(f"ERROR: Project root does not exist: {project_root}")
        sys.exit(1)

    result = scan_project(project_root, strict=args.strict)

    if args.output_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print_report(result)

    if result["verdict"] == "FAIL":
        sys.exit(1)


if __name__ == "__main__":
    main()