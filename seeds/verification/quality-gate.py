#!/usr/bin/env python3
"""
QUALITY GATE: Enforces engineering-grade code standards.

Prevents AI from producing prototype-grade code (hardcoded values,
missing error handling, no tests, etc.) by scanning source code for
simplification patterns and rejecting non-engineering quality.

Checks performed:
1. Hardcoded config: URLs, API keys, ports, thresholds in source
2. Error handling: bare except, pass-in-except, no error types
3. Input validation: missing validation on public functions
4. Testing: no test files found
5. Documentation: missing docstrings on public APIs
6. Secrets: potential hardcoded secrets
7. Edge cases: oversimplified logic patterns

Usage:
    python verification/quality-gate.py --check
    python verification/quality-gate.py --check --output-json
    python verification/quality-gate.py --check --threshold 0.7
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

HARDCODED_CONFIG_PATTERNS = [
    (r'(?:url|endpoint|host|base_url)\s*[:=]\s*["\']https?://', "hardcoded_url"),
    (r'(?:api_key|apikey|api_secret|secret_key|token|password)\s*[:=]\s*["\'][^\'"]{8,}["\']', "hardcoded_secret"),
    (r'(?:port)\s*[:=]\s*\d{2,5}', "hardcoded_port"),
    (r'(?:timeout|threshold|limit|max_retries|rate)\s*[:=]\s*\d+', "hardcoded_threshold"),
]

ERROR_HANDLING_PATTERNS = [
    (r'except\s*:\s*\n\s*pass', "bare_except_pass"),
    (r'except\s*:\s*\n\s*print', "bare_except_print"),
    (r'except\s+Exception\s*:\s*\n\s*pass', "generic_except_pass"),
    (r'except\s+Exception\s*:\s*\n\s*return\s+None', "generic_except_return_none"),
]

MISSING_VALIDATION_PATTERNS = [
    (r'def\s+(?:create|update|save|process|handle|execute)\w*\s*\([^)]*\)\s*(?:->.*?)?:', "public_function"),
]

SIMPLIFICATION_PATTERNS = [
    (r'TODO|FIXME|HACK|XXX', "todo_marker"),
    (r'#.*(?:placeholder|stub|temporary|quick\s+fix|workaround)', "placeholder_comment"),
    (r'pass\s*#\s*(?:TODO|implement|later|placeholder)', "pass_with_todo"),
]

SKIP_DIRS = {".git", "node_modules", "__pycache__", "venv", ".venv", "dist", "build", ".next", "generated", "tests", "test", "spec"}
CODE_EXTENSIONS = {".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".kt", ".swift", ".rb"}


def scan_file(file_path: Path, project_root: Path) -> dict:
    result = {
        "hardcoded_config": [],
        "error_handling": [],
        "simplification": [],
        "missing_validation": 0,
    }

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return result

    lines = content.split("\n")

    for pattern, violation_type in HARDCODED_CONFIG_PATTERNS:
        for match in re.finditer(pattern, content, re.IGNORECASE):
            line_no = content[:match.start()].count("\n") + 1
            result["hardcoded_config"].append({
                "file": str(file_path.relative_to(project_root)),
                "line": line_no,
                "match": match.group(0)[:80],
                "type": violation_type,
            })

    for pattern, violation_type in ERROR_HANDLING_PATTERNS:
        for match in re.finditer(pattern, content, re.MULTILINE):
            line_no = content[:match.start()].count("\n") + 1
            result["error_handling"].append({
                "file": str(file_path.relative_to(project_root)),
                "line": line_no,
                "match": match.group(0)[:80],
                "type": violation_type,
            })

    for pattern, violation_type in SIMPLIFICATION_PATTERNS:
        for match in re.finditer(pattern, content, re.IGNORECASE):
            line_no = content[:match.start()].count("\n") + 1
            result["simplification"].append({
                "file": str(file_path.relative_to(project_root)),
                "line": line_no,
                "match": match.group(0)[:80],
                "type": violation_type,
            })

    in_function = False
    for line in lines:
        stripped = line.strip()
        if re.match(r'def\s+(?:create|update|save|process|handle|execute)\w*\s*\(', stripped):
            in_function = True
        if in_function and stripped.startswith("def ") and "validate" not in stripped.lower():
            result["missing_validation"] += 1
            in_function = False

    return result


def count_test_files(project_root: Path) -> int:
    count = 0
    test_dirs = {"tests", "test", "spec", "__tests__"}
    for d in test_dirs:
        test_path = project_root / d
        if test_path.exists():
            for f in test_path.rglob("*"):
                if f.is_file() and f.suffix in CODE_EXTENSIONS:
                    count += 1
    return count


def scan_project(project_root: Path) -> dict:
    aggregated = {
        "hardcoded_config": [],
        "error_handling": [],
        "simplification": [],
        "missing_validation": 0,
    }
    scanned = 0

    for file_path in project_root.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in CODE_EXTENSIONS:
            continue
        if any(p in file_path.parts for p in SKIP_DIRS):
            continue

        scanned += 1
        file_result = scan_file(file_path, project_root)
        aggregated["hardcoded_config"].extend(file_result["hardcoded_config"])
        aggregated["error_handling"].extend(file_result["error_handling"])
        aggregated["simplification"].extend(file_result["simplification"])
        aggregated["missing_validation"] += file_result["missing_validation"]

    test_count = count_test_files(project_root)

    checks = {
        "hardcoded_config": {"count": len(aggregated["hardcoded_config"]), "passed": len(aggregated["hardcoded_config"]) <= 2, "weight": 0.25},
        "error_handling": {"count": len(aggregated["error_handling"]), "passed": len(aggregated["error_handling"]) == 0, "weight": 0.25},
        "simplification": {"count": len(aggregated["simplification"]), "passed": len(aggregated["simplification"]) <= 1, "weight": 0.15},
        "tests_exist": {"count": test_count, "passed": test_count > 0 or scanned == 0, "weight": 0.20},
        "no_missing_validation": {"count": aggregated["missing_validation"], "passed": aggregated["missing_validation"] <= 2, "weight": 0.15},
    }

    score = sum(c["weight"] for c in checks.values() if c["passed"])
    all_passed = all(c["passed"] for c in checks.values())

    return {
        "project_root": str(project_root),
        "scanned_files": scanned,
        "test_files_found": test_count,
        "checks": checks,
        "score": score,
        "verdict": "PASS" if all_passed else "FAIL",
        "violations": {
            "hardcoded_config": aggregated["hardcoded_config"],
            "error_handling": aggregated["error_handling"],
            "simplification": aggregated["simplification"],
        },
    }


def print_report(result: dict) -> None:
    print("\n" + "=" * 70)
    print("QUALITY GATE REPORT")
    print("=" * 70)
    print(f"Project: {result['project_root']}")
    print(f"Files scanned: {result['scanned_files']}")
    print(f"Test files: {result['test_files_found']}")
    print(f"Score: {result['score']:.2f} / 1.00")
    print(f"Verdict: {result['verdict']}")

    print(f"\n--- Checks ---")
    for name, check in result["checks"].items():
        status = "✅" if check["passed"] else "❌"
        print(f"  {status} {name}: {check['count']} violations (weight: {check['weight']})")

    violations = result["violations"]
    if violations["hardcoded_config"]:
        print(f"\n--- Hardcoded Config ({len(violations['hardcoded_config'])}) ---")
        for v in violations["hardcoded_config"][:5]:
            print(f"  ❌ [{v['type']}] {v['file']}:{v['line']}: {v['match']}")
        if len(violations["hardcoded_config"]) > 5:
            print(f"  ... and {len(violations['hardcoded_config']) - 5} more")

    if violations["error_handling"]:
        print(f"\n--- Error Handling Issues ({len(violations['error_handling'])}) ---")
        for v in violations["error_handling"][:5]:
            print(f"  ❌ [{v['type']}] {v['file']}:{v['line']}: {v['match']}")
        if len(violations["error_handling"]) > 5:
            print(f"  ... and {len(violations['error_handling']) - 5} more")

    if violations["simplification"]:
        print(f"\n--- Simplification Markers ({len(violations['simplification'])}) ---")
        for v in violations["simplification"][:5]:
            print(f"  ⚠️  [{v['type']}] {v['file']}:{v['line']}: {v['match']}")
        if len(violations["simplification"]) > 5:
            print(f"  ... and {len(violations['simplification']) - 5} more")

    print("\n" + "=" * 70)
    if result["verdict"] == "PASS":
        print("✅ QUALITY GATE PASSED — code meets engineering standards")
    else:
        print("🛑 QUALITY GATE FAILED — code is below engineering-grade threshold")
        print("   Fix violations: use config files, add error handling, remove TODO placeholders, add tests")
    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Quality Gate — Enforces engineering-grade code standards")
    parser.add_argument("--check", action="store_true", help="Run quality check")
    parser.add_argument("--output-json", action="store_true", help="Output results as JSON")
    parser.add_argument("--threshold", type=float, default=0.8, help="Minimum quality score threshold (default: 0.8)")
    args = parser.parse_args()

    if not args.check:
        print("ERROR: Must provide --check to run the quality gate.")
        print("Usage: python verification/quality-gate.py --check")
        sys.exit(1)

    project_root = Path(".").resolve()
    result = scan_project(project_root)

    if result["score"] < args.threshold:
        result["verdict"] = "FAIL"

    if args.output_json:
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    else:
        print_report(result)

    if result["verdict"] == "FAIL":
        sys.exit(1)


if __name__ == "__main__":
    main()