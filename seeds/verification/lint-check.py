#!/usr/bin/env python3
"""
Lint Check —— 对修改文件跑 linter-config.yaml 的规则。

被 runtime-hooks.yaml 的 HOOK_LINT 调用（severity=warn，不阻止，只警告）。
读 constraints/linter-config.yaml 的 rules，对 --files 传入的文件逐条检查。

linter-config.yaml 规则格式（LLM slot，项目特定）：
    rules:
      <rule_name>:
        severity: error | warning
        message: "<人类可读>"
        patterns:                     # 每条 pattern 形如 "<file_glob> 中 <regex>"
          - "src/cloud/** 中 import.*interlock"
          - "except Exception"        # 无 " 中 " 时，对全部 --files 应用 regex
        traces_to: "AR001"           # 可选，关联架构规则

第一性原理分工：
- lint 的"运行机制" = 硬约束（本脚本，所有项目共享）
- lint 的"规则内容与 pattern 语法" = LLM 在 linter-config.yaml 声明（项目特定）
- 本脚本解析 "X 中 Y" 格式（当前项目约定），无 " 中 " 时整条当 regex

exit codes: 0 = 无 error-severity violation；1 = 有 error violation 或规则缺失

Usage:
    python verification/lint-check.py --project-root <dir> --files f1.py,f2.py
    python verification/lint-check.py --project-root . --files src/x.py --strict
"""

import argparse
import fnmatch
import re
import sys
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SEP = " 中 "  # 项目约定的 file-glob 与 regex 分隔符


def load_linter_config(project_root: Path) -> dict:
    """Load constraints/linter-config.yaml. Returns {} if missing."""
    cfg = project_root / "constraints" / "linter-config.yaml"
    if not cfg.exists():
        return {}
    with open(cfg, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def split_pattern(pattern: str) -> tuple:
    """Split 'file_glob 中 regex' into (file_glob, regex).

    If no ' 中 ' separator, apply regex to all --files (file_glob = '**').
    """
    if SEP in pattern:
        file_glob, regex = pattern.split(SEP, 1)
        return file_glob.strip(), regex.strip()
    return "**", pattern.strip()


def file_matches_glob(file_rel: str, file_glob: str) -> bool:
    """Check if a relative file path matches a glob (supports **)."""
    # Normalize: treat ** as wildcard matching any path segment sequence.
    # fnmatch doesn't handle ** across dirs, so do a two-step check.
    norm_glob = file_glob.replace("\\", "/")
    norm_file = file_rel.replace("\\", "/")
    if "**" in norm_glob:
        # Convert ** to * for fnmatch (single-level), then also accept any prefix.
        prefix = norm_glob.split("**")[0].rstrip("/")
        if prefix and not norm_file.startswith(prefix):
            return False
        suffix = norm_glob.split("**", 1)[1].lstrip("/")
        if suffix:
            return fnmatch.fnmatch(norm_file.split("/")[-1], suffix) or norm_file.endswith(suffix)
        return True
    return fnmatch.fnmatch(norm_file, norm_glob)


def check_file(file_path: Path, file_rel: str, rules: dict) -> list:
    """Run all rules against one file. Returns list of violation dicts."""
    violations = []
    try:
        content = file_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return [{"rule": "_read_error", "file": file_rel, "message": f"cannot read: {e}",
                 "severity": "warning", "line": 0}]
    for rule_name, rule in (rules or {}).items():
        if not isinstance(rule, dict):
            continue
        severity = rule.get("severity", "warning")
        message = rule.get("message", "")
        traces_to = rule.get("traces_to", "")
        for pattern in rule.get("patterns", []) or []:
            file_glob, regex_str = split_pattern(pattern)
            if not file_matches_glob(file_rel, file_glob):
                continue
            try:
                rx = re.compile(regex_str)
            except re.error as e:
                violations.append({"rule": rule_name, "file": file_rel,
                                   "message": f"invalid regex '{regex_str}': {e}",
                                   "severity": "warning", "line": 0, "traces_to": traces_to})
                continue
            for i, line in enumerate(content.splitlines(), 1):
                if rx.search(line):
                    violations.append({
                        "rule": rule_name, "file": file_rel, "line": i,
                        "severity": severity, "message": message,
                        "matched": line.strip()[:120], "traces_to": traces_to,
                    })
    return violations


def main():
    parser = argparse.ArgumentParser(description="Run linter-config.yaml rules against modified files")
    parser.add_argument("--project-root", default=".", help="Generated project root")
    parser.add_argument("--files", required=True, help="Comma-separated file paths (relative to project root)")
    parser.add_argument("--strict", action="store_true",
                        help="Treat warnings as errors (exit 1 on any violation)")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    cfg = load_linter_config(project_root)
    rules = cfg.get("rules") or {}

    if not rules:
        print("  ⚠️  No linter-config.yaml rules found — skipping lint.")
        sys.exit(0)

    files = [f.strip() for f in args.files.split(",") if f.strip()]
    all_violations = []
    for f in files:
        fp = project_root / f
        if not fp.exists():
            print(f"  ⚠️  File not found, skipping: {f}")
            continue
        rel = str(fp.relative_to(project_root)).replace("\\", "/")
        all_violations.extend(check_file(fp, rel, rules))

    errors = [v for v in all_violations if v["severity"] == "error"]
    warnings = [v for v in all_violations if v["severity"] == "warning"]

    print(f"\n=== Lint Report ({len(files)} files, {len(rules)} rules) ===")
    if all_violations:
        for v in all_violations:
            tag = "ERROR" if v["severity"] == "error" else "WARN"
            line = v.get("line", 0)
            print(f"  [{tag}] {v['file']}:{line} rule={v['rule']} "
                  f"traces_to={v.get('traces_to', '-')}")
            print(f"         {v['message']}")
            if v.get("matched"):
                print(f"         matched: {v['matched']}")
    else:
        print("  PASS — no lint violations")

    print(f"\n  Errors:   {len(errors)}")
    print(f"  Warnings: {len(warnings)}")

    if errors or (args.strict and warnings):
        print("  Result: FAIL")
        sys.exit(1)
    print("  Result: PASS (warnings do not block)")
    sys.exit(0)


if __name__ == "__main__":
    main()
