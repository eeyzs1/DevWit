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
import io
import json
import re
import sys
import tokenize
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

# 仅在注释中匹配（字符串/正则字面量中的同名文本不算，见 extract_comments）。
# 词边界防止 "ARxxx"/"xxxx" 等标识符误命中。
SIMPLIFICATION_PATTERNS = [
    (r'\b(?:TODO|FIXME|HACK|XXX)\b', "todo_marker"),
    (r'(?:placeholder|stub|temporary|quick\s+fix|workaround)', "placeholder_comment"),
]

# 显式豁免标记：经人工评审确认合理的行，加 "qg-allow: <原因>" 注释后不计入
# 违规，但在报告的 waived 清单中单独列出（可审计，不同于静默跳过）。
WAIVER_MARKER = "qg-allow"
# 配置文件（*.config.*）是此类字面量的正当归宿，不做 hardcoded_config 检查
CONFIG_FILE_RE = re.compile(r'\.config\.[a-z]+$', re.IGNORECASE)

# vendor/ 为钉版第三方发行代码（js-debug 等，字节级固定不可改），与 node_modules 同口径排除
SKIP_DIRS = {".git", "node_modules", "__pycache__", "venv", ".venv", "dist", "build", ".next", "generated", "tests", "test", "spec", "release", "vendor"}
# 统计测试文件时不能跳过测试目录本身，只跳过依赖/产物目录
COUNT_SKIP_DIRS = SKIP_DIRS - {"tests", "test", "spec"}
CODE_EXTENSIONS = {".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".kt", ".swift", ".rb"}
TEST_DIR_NAMES = {"tests", "test", "spec", "__tests__"}
TEST_FILE_MARKERS = (".test.", ".spec.")


def _rel_parts(file_path: Path, project_root: Path) -> tuple | None:
    """项目内部相对路径组件；越界返回 None。"""
    try:
        return file_path.relative_to(project_root).parts
    except ValueError:
        return None


def is_skipped(file_path: Path, project_root: Path, skip_dirs=SKIP_DIRS) -> bool:
    """按相对 project_root 的路径组件匹配 skip_dirs。

    历史 bug：曾用绝对路径 file_path.parts 匹配——若项目位于名为
    generated/build/test 的父目录下，所有文件都被跳过，扫描 0 个文件
    却得出 PASS（空虚通过）。必须只匹配项目内部相对路径。
    """
    rel_parts = _rel_parts(file_path, project_root)
    if rel_parts is None:
        return True
    return any(part in skip_dirs for part in rel_parts)


def extract_comments(content: str, suffix: str) -> list:
    """提取 [(line_no, comment_text)]。只扫描注释，避免把字符串/正则
    字面量（如检查器自身的违规模式定义）误判为 TODO/placeholder。"""
    if suffix == ".py":
        try:
            return [
                (tok.start[0], tok.string)
                for tok in tokenize.generate_tokens(io.StringIO(content).readline)
                if tok.type == tokenize.COMMENT
            ]
        except (tokenize.TokenError, IndentationError, SyntaxError):
            return []  # 语法无法解析时不猜，宁可漏报
    if suffix in {".js", ".ts", ".jsx", ".tsx"}:
        # 先抹掉字符串/模板字面量，再取 // 与 /* */ 注释
        stripped = re.sub(
            r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"|`(?:\\.|[^`\\])*`",
            '""', content, flags=re.DOTALL,
        )
        comments = []
        for i, line in enumerate(stripped.split("\n"), 1):
            idx = line.find("//")
            if idx >= 0:
                comments.append((i, line[idx:]))
        for m in re.finditer(r"/\*[\s\S]*?\*/", stripped):
            comments.append((stripped[:m.start()].count("\n") + 1, m.group(0)))
        return comments
    # 其他语言退化为全文本行（无字符串感知，接受噪声）
    return [(i + 1, line) for i, line in enumerate(content.split("\n"))]


# 校验类语句标记：函数体内出现其一即视为有输入校验/防御
VALIDATION_MARKERS = (
    "raise ", "isinstance(", "assert ", "ValueError", "TypeError",
    "if not ", "if len(", "validate", "check_",
)
PUBLIC_FN_RE = re.compile(
    r'^(\s*)def\s+((?:create|update|save|process|handle|execute)\w*)\s*\(')


def count_missing_validation_py(lines: list) -> int:
    """统计 Python 中名为 create/update/save/process/handle/execute* 的公开
    函数、且函数体内无任何校验类语句的数量（比旧的纯命名启发式更接近
    "缺输入校验"的真实含义）。"""
    count = 0
    i = 0
    while i < len(lines):
        m = PUBLIC_FN_RE.match(lines[i])
        if not m:
            i += 1
            continue
        indent, name = len(m.group(1)), m.group(2)
        if name.startswith("_"):
            i += 1
            continue
        # 函数体 = 后续首个缩进 <= def 缩进的非空非注释行之前的所有行
        body_lines = []
        j = i + 1
        while j < len(lines):
            line = lines[j]
            if line.strip() and not line.lstrip().startswith("#"):
                if len(line) - len(line.lstrip()) <= indent:
                    break
                body_lines.append(line)
            j += 1
        body = "\n".join(body_lines)
        if not any(marker in body for marker in VALIDATION_MARKERS):
            count += 1
        i = j if j > i else i + 1
    return count


def scan_file(file_path: Path, project_root: Path) -> dict:
    result = {
        "hardcoded_config": [],
        "error_handling": [],
        "simplification": [],
        "missing_validation": 0,
        "waived": [],
    }

    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return result

    rel = str(file_path.relative_to(project_root))
    lines = content.split("\n")

    def line_has_waiver(line_no: int) -> bool:
        return WAIVER_MARKER in lines[line_no - 1] if 0 < line_no <= len(lines) else False

    if not CONFIG_FILE_RE.search(file_path.name):
        for pattern, violation_type in HARDCODED_CONFIG_PATTERNS:
            for match in re.finditer(pattern, content, re.IGNORECASE):
                line_no = content[:match.start()].count("\n") + 1
                entry = {
                    "file": rel,
                    "line": line_no,
                    "match": match.group(0)[:80],
                    "type": violation_type,
                }
                if line_has_waiver(line_no):
                    result["waived"].append(entry)
                else:
                    result["hardcoded_config"].append(entry)

    for pattern, violation_type in ERROR_HANDLING_PATTERNS:
        for match in re.finditer(pattern, content, re.MULTILINE):
            line_no = content[:match.start()].count("\n") + 1
            result["error_handling"].append({
                "file": rel,
                "line": line_no,
                "match": match.group(0)[:80],
                "type": violation_type,
            })

    comment_sources = extract_comments(content, file_path.suffix.lower())
    for pattern, violation_type in SIMPLIFICATION_PATTERNS:
        for line_no, comment in comment_sources:
            match = re.search(pattern, comment, re.IGNORECASE)
            if match:
                result["simplification"].append({
                    "file": rel,
                    "line": line_no,
                    "match": match.group(0)[:80],
                    "type": violation_type,
                })

    if file_path.suffix.lower() == ".py":
        result["missing_validation"] = count_missing_validation_py(lines)

    return result


def count_test_files(project_root: Path) -> int:
    """统计全项目测试文件：位于 tests/test/spec/__tests__ 目录，
    或文件名含 .test. / .spec. 标记（支持 monorepo 的 packages/*/tests 布局）。"""
    count = 0
    for f in project_root.rglob("*"):
        if not f.is_file() or f.suffix not in CODE_EXTENSIONS:
            continue
        rel_parts = _rel_parts(f, project_root)
        if rel_parts is None or any(part in COUNT_SKIP_DIRS for part in rel_parts):
            continue
        if any(part in TEST_DIR_NAMES for part in rel_parts[:-1]):
            count += 1
        elif any(marker in f.name for marker in TEST_FILE_MARKERS):
            count += 1
    return count


def scan_project(project_root: Path) -> dict:
    aggregated = {
        "hardcoded_config": [],
        "error_handling": [],
        "simplification": [],
        "missing_validation": 0,
        "waived": [],
    }
    scanned = 0

    for file_path in project_root.rglob("*"):
        if not file_path.is_file():
            continue
        if file_path.suffix.lower() not in CODE_EXTENSIONS:
            continue
        if is_skipped(file_path, project_root):
            continue

        scanned += 1
        file_result = scan_file(file_path, project_root)
        aggregated["hardcoded_config"].extend(file_result["hardcoded_config"])
        aggregated["error_handling"].extend(file_result["error_handling"])
        aggregated["simplification"].extend(file_result["simplification"])
        aggregated["missing_validation"] += file_result["missing_validation"]
        aggregated["waived"].extend(file_result["waived"])

    test_count = count_test_files(project_root)

    checks = {
        "hardcoded_config": {"count": len(aggregated["hardcoded_config"]), "passed": len(aggregated["hardcoded_config"]) <= 2, "weight": 0.25},
        "error_handling": {"count": len(aggregated["error_handling"]), "passed": len(aggregated["error_handling"]) == 0, "weight": 0.25},
        "simplification": {"count": len(aggregated["simplification"]), "passed": len(aggregated["simplification"]) <= 1, "weight": 0.15},
        "tests_exist": {"count": test_count, "passed": test_count > 0, "weight": 0.20},
        "no_missing_validation": {"count": aggregated["missing_validation"], "passed": aggregated["missing_validation"] <= 2, "weight": 0.15},
    }

    score = sum(c["weight"] for c in checks.values() if c["passed"])
    all_passed = all(c["passed"] for c in checks.values())
    # 反空虚扫描硬约束：扫到 0 个源文件绝不判 PASS（防止 SKIP_DIRS
    # 误配置导致的"什么都没检查却通过"，本项目曾实际发生）
    if scanned == 0:
        all_passed = False

    return {
        "project_root": str(project_root),
        "scanned_files": scanned,
        "test_files_found": test_count,
        "checks": checks,
        "score": score,
        "verdict": "PASS" if all_passed else "FAIL",
        "vacuous_scan": scanned == 0,
        "violations": {
            "hardcoded_config": aggregated["hardcoded_config"],
            "error_handling": aggregated["error_handling"],
            "simplification": aggregated["simplification"],
        },
        "waived": aggregated["waived"],
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
    if result.get("vacuous_scan"):
        print("⚠️  VACUOUS SCAN: 0 files scanned — verdict forced to FAIL")

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

    waived = result.get("waived", [])
    if waived:
        print(f"\n--- Waived ({len(waived)}, 人工评审豁免，仅公示不计入违规) ---")
        for v in waived:
            print(f"  🔎 [{v['type']}] {v['file']}:{v['line']}: {v['match']}")

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