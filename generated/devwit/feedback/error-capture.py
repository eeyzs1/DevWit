#!/usr/bin/env python3
"""
Error Capture: Structured error parser.

Extracts error type, context, and root cause hints from
stderr, stack traces, and command output.

Usage:
    python feedback/error-capture.py --error-output <file> [--source <command>]
"""

import argparse
import re
import sys
from pathlib import Path

import yaml

ERROR_PATTERNS = {
    "import_error": {
        "pattern": r"(ImportError|ModuleNotFoundError):\s+No module named\s+['\"]?(\w+)",
        "root_cause_hint": "missing_dependency",
        "fix_hint": "Install the missing module or check import path",
    },
    "type_error": {
        "pattern": r"TypeError:\s+(.+)",
        "root_cause_hint": "type_mismatch",
        "fix_hint": "Check argument types and function signatures",
    },
    "attribute_error": {
        "pattern": r"AttributeError:\s+'(\w+)'\s+object\s+has\s+no\s+attribute\s+'(\w+)'",
        "root_cause_hint": "missing_attribute",
        "fix_hint": "Check if the object has the expected attribute or if the class is correct",
    },
    "file_not_found": {
        "pattern": r"(FileNotFoundError|ENOENT):.*['\"](.+?)['\"]",
        "root_cause_hint": "missing_file",
        "fix_hint": "Check if the file path is correct and the file exists",
    },
    "permission_denied": {
        "pattern": r"(PermissionError|EACCES):",
        "root_cause_hint": "insufficient_permissions",
        "fix_hint": "Check file/directory permissions",
    },
    "timeout": {
        "pattern": r"(TimeoutError|timed out|deadline exceeded)",
        "root_cause_hint": "operation_too_slow",
        "fix_hint": "Increase timeout or optimize the operation",
    },
    "syntax_error": {
        "pattern": r"SyntaxError:\s+(.+)",
        "root_cause_hint": "invalid_syntax",
        "fix_hint": "Fix the syntax error in the indicated file and line",
    },
    "http_error": {
        "pattern": r"(HTTP\s+\d{3}|status.*?(\d{3}))",
        "root_cause_hint": "http_error",
        "fix_hint": "Check the HTTP status code and adjust the request",
    },
}


def parse_errors(error_output: str, source: str = "") -> list:
    errors = []
    for error_type, config in ERROR_PATTERNS.items():
        matches = re.finditer(config["pattern"], error_output, re.IGNORECASE)
        for match in matches:
            errors.append({
                "type": error_type,
                "matched_text": match.group(0),
                "root_cause_hint": config["root_cause_hint"],
                "fix_hint": config["fix_hint"],
                "source": source,
            })
    return errors


def main():
    parser = argparse.ArgumentParser(description="Error Capture")
    parser.add_argument("--error-output", required=True, help="File containing error output")
    parser.add_argument("--source", default="", help="Source command that produced the error")
    args = parser.parse_args()

    error_file = Path(args.error_output)
    if not error_file.exists():
        print(f"ERROR: Error output file not found: {error_file}")
        sys.exit(1)

    error_output = error_file.read_text(encoding="utf-8")
    errors = parse_errors(error_output, args.source)

    result = {
        "source": args.source,
        "error_count": len(errors),
        "errors": errors,
        "unparsed_output": error_output if not errors else "",
    }

    print(yaml.dump(result, default_flow_style=False, allow_unicode=True))


if __name__ == "__main__":
    main()
