#!/usr/bin/env python3
"""
Product State Analyzer: Reads src/ and understands what currently exists.

Analyzes the current product state by scanning source code, identifying
implemented features, missing components, and quality gaps.

Usage:
    python evolution/product-analyzer.py [--project-root <dir>]
"""

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

import yaml


def scan_directory_structure(project_root: Path) -> dict:
    src_dir = project_root / "src"
    if not src_dir.exists():
        return {"has_src": False, "directories": [], "files": []}

    dirs = []
    files = []
    for item in src_dir.rglob("*"):
        rel = item.relative_to(src_dir)
        if item.is_dir():
            dirs.append(str(rel))
        elif item.is_file() and item.suffix in (".py", ".ts", ".js", ".tsx", ".jsx"):
            has_content = item.stat().st_size > 10
            files.append({"path": str(rel), "size": item.stat().st_size, "has_content": has_content})

    return {"has_src": True, "directories": dirs, "files": files, "total_files": len(files), "files_with_content": sum(1 for f in files if f["has_content"])}


def scan_endpoints(project_root: Path) -> list:
    endpoints = []
    src_dir = project_root / "src"
    if not src_dir.exists():
        return endpoints

    for py_file in src_dir.rglob("*.py"):
        try:
            content = py_file.read_text(encoding="utf-8")
            for match in re.finditer(r"@(?:app|router)\.(get|post|put|delete|patch)\([\"']([^\"']+)[\"']", content, re.IGNORECASE):
                endpoints.append({"method": match.group(1).upper(), "path": match.group(2), "file": str(py_file.relative_to(project_root))})
            for match in re.finditer(r"(?:GET|POST|PUT|DELETE|PATCH)\s+[\"']?(/[^\s\"']+)", content):
                endpoints.append({"method": match.group(0).split()[0], "path": match.group(1), "file": str(py_file.relative_to(project_root))})
        except Exception:
            pass

    return endpoints


def scan_models(project_root: Path) -> list:
    models = []
    src_dir = project_root / "src"
    if not src_dir.exists():
        return models

    for py_file in src_dir.rglob("*.py"):
        try:
            content = py_file.read_text(encoding="utf-8")
            for match in re.finditer(r"class\s+(\w+)(?:\((\w+)\))?:", content):
                parent = match.group(2) or ""
                if parent in ("BaseModel", "Model", "Schema", "Entity", "Document") or "models" in str(py_file):
                    models.append({"name": match.group(1), "parent": parent, "file": str(py_file.relative_to(project_root))})
        except Exception:
            pass

    return models


def scan_tests(project_root: Path) -> dict:
    test_dir = project_root / "tests"
    test_files = []
    if test_dir.exists():
        for f in test_dir.rglob("*.py"):
            if f.name.startswith("test_") or f.name.endswith("_test.py"):
                try:
                    content = f.read_text(encoding="utf-8")
                    test_count = content.count("def test_") + content.count("async def test_")
                    test_files.append({"path": str(f.relative_to(project_root)), "test_count": test_count})
                except Exception:
                    pass

    return {"has_tests": len(test_files) > 0, "test_files": test_files, "total_tests": sum(t["test_count"] for t in test_files)}


def analyze_product_state(project_root: Path) -> dict:
    structure = scan_directory_structure(project_root)
    endpoints = scan_endpoints(project_root)
    models = scan_models(project_root)
    tests = scan_tests(project_root)

    task_file = project_root / "task.yaml"
    task = {}
    if task_file.exists():
        with open(task_file, "r", encoding="utf-8") as f:
            task = yaml.safe_load(f) or {}

    state_file = project_root / "memory" / "session-state.yaml"
    state = {}
    if state_file.exists():
        with open(state_file, "r", encoding="utf-8") as f:
            state = yaml.safe_load(f) or {}

    completed = state.get("progress", {}).get("completed_criteria", [])
    total_criteria = task.get("acceptance_criteria", [])

    return {
        "project_root": str(project_root),
        "task_name": task.get("name", "unknown"),
        "domain": task.get("domain", "unknown"),
        "structure": structure,
        "endpoints": endpoints,
        "models": models,
        "tests": tests,
        "criteria_progress": {
            "total": len(total_criteria),
            "completed": len(completed),
            "completion_rate": len(completed) / len(total_criteria) if total_criteria else 0,
        },
        "all_criteria_met": len(completed) >= len(total_criteria) and len(total_criteria) > 0,
    }


def main():
    parser = argparse.ArgumentParser(description="Product State Analyzer")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    state = analyze_product_state(project_root)
    print(yaml.dump(state, default_flow_style=False, allow_unicode=True))


if __name__ == "__main__":
    main()
