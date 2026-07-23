#!/usr/bin/env python3
"""
Verify that a generated harness project has all 7+2 layers with concrete artifacts.

Checks:
1. Every layer directory exists
2. Every layer has at least one executable artifact (not just .md files)
3. AGENTS.md / CLAUDE.md exist at project root
4. Evidence traceability exists (evolution/genome.yaml)
5. No layer is documentation-only

Usage:
    python scripts/verify-generation.py <generated-project-dir>
"""

import json
import py_compile
import sys
from pathlib import Path

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

LAYER_REQUIREMENTS = {
    "context": {
        "description": "Layer 1: Context Engineering",
        "required_files": ["knowledge-index.yaml"],
        "required_scripts": ["loader.py"],
        "min_executable": 1,
    },
    "tools": {
        "description": "Layer 2: Tool Integration",
        "required_files": ["schemas.yaml", "sandbox.yaml", "permissions.yaml"],
        "required_scripts": ["tool-discovery.py"],
        "min_executable": 1,
    },
    "memory": {
        "description": "Layer 3: Memory & State",
        "required_files": ["session-state.yaml", "compression-rules.yaml"],
        "required_scripts": ["snapshot.py"],
        "min_executable": 1,
    },
    "planning": {
        "description": "Layer 4: Planning & Orchestration",
        "required_files": ["flow-control.yaml", "sub-agent-dispatch.yaml", "budget.yaml"],
        "required_scripts": ["dag-builder.py"],
        "min_executable": 1,
    },
    "verification": {
        "description": "Layer 5: Verification & Guardrails",
        "required_files": ["security-guardrails.yaml"],
        "required_scripts": ["consistency-check.py", "self-check.py", "anti-mock-check.py", "quality-gate.py"],
        "min_executable": 2,
    },
    "feedback": {
        "description": "Layer 6: Feedback & Self-Healing",
        "required_files": ["retry-config.yaml", "human-interface.yaml"],
        "required_scripts": ["error-capture.py", "mistake-to-constraint.py"],
        "min_executable": 1,
    },
    "constraints": {
        "description": "Layer 7: Constraints & Entropy",
        "required_files": ["architecture-rules.yaml", "linter-config.yaml", "cost-budget.yaml"],
        "required_scripts": ["entropy-reduction.py"],
        "min_executable": 1,
    },
    "security": {
        "description": "Cross-Cutting: Security & Isolation",
        "required_files": ["sandbox-config.yaml", "encryption-rules.yaml", "audit-log.yaml"],
        "min_executable": 0,
    },
    "observability": {
        "description": "Cross-Cutting: Observability & Governance",
        "required_files": ["tracing.yaml", "metrics-dashboard.yaml", "session-replay.yaml", "versioning.yaml"],
        "min_executable": 0,
    },
    "evolution": {
        "description": "Self-Evolution",
        "required_files": ["framework.md", "genome.yaml", "log.yaml"],
        "min_executable": 0,
    },
}

EXECUTABLE_EXTENSIONS = {".py", ".sh", ".js", ".ts", ".ps1"}
CONFIG_EXTENSIONS = {".yaml", ".yml", ".json", ".toml"}
DOC_EXTENSIONS = {".md", ".txt", ".rst"}


def count_artifacts(layer_dir: Path) -> dict:
    counts = {"executable": 0, "config": 0, "doc": 0, "other": 0, "total": 0}
    if not layer_dir.exists():
        return counts
    for f in layer_dir.rglob("*"):
        if f.is_file():
            counts["total"] += 1
            ext = f.suffix.lower()
            if ext in EXECUTABLE_EXTENSIONS:
                counts["executable"] += 1
            elif ext in CONFIG_EXTENSIONS:
                counts["config"] += 1
            elif ext in DOC_EXTENSIONS:
                counts["doc"] += 1
            else:
                counts["other"] += 1
    return counts


def check_python_syntax(layer_dir: Path) -> list:
    """Compile-check every .py file in the layer. Returns list of syntax errors.

    An empty .py file passes extension counting but is not truly executable;
    this validates that .py artifacts at least parse correctly.
    """
    errors = []
    if not layer_dir.exists():
        return errors
    for f in layer_dir.rglob("*.py"):
        try:
            py_compile.compile(str(f), doraise=True)
        except py_compile.PyCompileError as e:
            errors.append({"file": str(f.relative_to(layer_dir)), "error": str(e)})
    return errors


def verify_layer(project_dir: Path, layer: str, requirements: dict) -> dict:
    layer_dir = project_dir / layer
    result = {
        "layer": layer,
        "description": requirements["description"],
        "dir_exists": layer_dir.exists(),
        "missing_files": [],
        "missing_scripts": [],
        "artifact_counts": count_artifacts(layer_dir),
        "syntax_errors": [],
        "has_executable": False,
        "is_doc_only": True,
        "passed": False,
    }

    if not layer_dir.exists():
        result["missing_files"] = requirements.get("required_files", [])
        result["missing_scripts"] = requirements.get("required_scripts", [])
        return result

    for f in requirements.get("required_files", []):
        if not (layer_dir / f).exists():
            result["missing_files"].append(f)

    for s in requirements.get("required_scripts", []):
        if not (layer_dir / s).exists():
            result["missing_scripts"].append(s)

    counts = result["artifact_counts"]
    result["has_executable"] = counts["executable"] > 0
    result["is_doc_only"] = counts["total"] > 0 and counts["executable"] == 0 and counts["config"] == 0
    result["syntax_errors"] = check_python_syntax(layer_dir)

    min_exec = requirements.get("min_executable", 0)
    has_required = len(result["missing_files"]) == 0 and len(result["missing_scripts"]) == 0
    meets_min_exec = counts["executable"] >= min_exec
    not_doc_only = not result["is_doc_only"]
    no_syntax_errors = len(result["syntax_errors"]) == 0

    result["passed"] = has_required and meets_min_exec and not_doc_only and no_syntax_errors
    return result


def verify_project(project_dir: Path) -> dict:
    if not project_dir.exists():
        print(f"ERROR: Project directory does not exist: {project_dir}")
        sys.exit(1)

    results = {"project_dir": str(project_dir), "layers": {}, "root_files": {}, "overall_passed": True}

    for name in ["AGENTS.md", "CLAUDE.md", ".cursorrules", "orchestrator.py", "guard.py"]:
        results["root_files"][name] = (project_dir / name).exists()

    for layer, requirements in LAYER_REQUIREMENTS.items():
        layer_result = verify_layer(project_dir, layer, requirements)
        results["layers"][layer] = layer_result
        if not layer_result["passed"]:
            results["overall_passed"] = False

    if not all(results["root_files"].values()):
        results["overall_passed"] = False

    return results


def print_results(results: dict) -> None:
    print("\n" + "=" * 70)
    print("HARNESS GENERATION VERIFICATION REPORT")
    print("=" * 70)
    print(f"\nProject: {results['project_dir']}")

    print("\n--- Root Files ---")
    for name, exists in results["root_files"].items():
        status = "✅" if exists else "❌"
        print(f"  {status} {name}")

    print("\n--- Layer Verification ---")
    for layer, info in results["layers"].items():
        status = "✅ PASS" if info["passed"] else "❌ FAIL"
        print(f"\n  {status} — {info['description']} ({layer}/)")

        if not info["dir_exists"]:
            print(f"      ⚠️  Directory does not exist")
            continue

        counts = info["artifact_counts"]
        print(f"      Artifacts: {counts['executable']} executable, {counts['config']} config, {counts['doc']} doc, {counts['other']} other")

        if info["is_doc_only"]:
            print(f"      ⚠️  Layer is DOCUMENTATION-ONLY (no executable or config artifacts)")

        if info["missing_files"]:
            print(f"      Missing files: {', '.join(info['missing_files'])}")
        if info["missing_scripts"]:
            print(f"      Missing scripts: {', '.join(info['missing_scripts'])}")
        if info.get("syntax_errors"):
            print(f"      Syntax errors: {len(info['syntax_errors'])}")
            for se in info["syntax_errors"]:
                first_line = se["error"].splitlines()[0] if se["error"] else ""
                print(f"        - {se['file']}: {first_line}")

    print("\n" + "=" * 70)
    if results["overall_passed"]:
        print("✅ VERIFICATION PASSED — all layers have concrete artifacts")
    else:
        print("❌ VERIFICATION FAILED — some layers are incomplete or doc-only")
    print("=" * 70)


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/verify-generation.py <generated-project-dir>")
        sys.exit(1)

    project_dir = Path(sys.argv[1])
    results = verify_project(project_dir)
    print_results(results)

    if not results["overall_passed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
