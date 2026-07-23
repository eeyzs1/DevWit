#!/usr/bin/env python3
"""
PRE-ACTION GUARD: Validates planned actions against project constraints.

This script is THE enforcement mechanism. Before writing ANY code, the AI agent
MUST run this guard. It checks the planned action against architecture rules,
domain constraints, and workflow requirements.

The guard BLOCKS actions that violate constraints and explains exactly why.
No guard pass = NO code changes allowed.

Usage:
    python guard.py --check "I plan to add a new API endpoint for user login"
    python guard.py --check "I plan to modify the database schema directly from frontend"
    python guard.py --status           Check if guard system is active
    python guard.py --report           Generate compliance report
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parent

VIOLATION_PATTERNS = {
    "frontend_db_access": {
        "patterns": [
            r"(?:import|from).*(?:sql|database|db|prisma|sequelize|typeorm|mongoose|pymongo|sqlite)",
            r"(?:connect|query|execute|cursor).*(?:database|db|sql)",
        ],
        "frontend_dirs": ["components", "views", "pages", "frontend", "ui", "client"],
        "message": "Direct database access from frontend/presentation layer is FORBIDDEN. Use the API layer.",
        "severity": "BLOCKED",
    },
    "business_logic_in_routes": {
        "patterns": [
            r"(?:def|function|class).*(?:calculate|process_payment|business_logic|validate_business|transform_data)",
        ],
        "target_dirs": ["routes", "controllers", "handlers"],
        "message": "Business logic in route handlers is FORBIDDEN. Move logic to services/ layer.",
        "severity": "BLOCKED",
    },
    "missing_validation": {
        "patterns": [],
        "check_hint": "If creating an API endpoint, input validation is REQUIRED.",
        "message": "API endpoints without input validation are FORBIDDEN. Add validation before processing.",
        "severity": "WARNING",
    },
    "circular_dependency": {
        "patterns": [],
        "check_hint": "Import graph must be a DAG. Check for A→B and B→A patterns.",
        "message": "Circular dependencies between modules are FORBIDDEN. Restructure your imports.",
        "severity": "BLOCKED",
    },
    "multiple_criteria_at_once": {
        "patterns": [],
        "check_hint": "Are you implementing more than one acceptance criterion?",
        "message": "Implementing multiple criteria at once is FORBIDDEN. Focus on ONE criterion at a time.",
        "severity": "BLOCKED",
    },
    "self_certification": {
        "patterns": [],
        "check_hint": "Are you trying to mark a criterion as complete without running verification?",
        "message": "Self-certification is FORBIDDEN. Only orchestrator.py --verify + --mark-complete can certify.",
        "severity": "BLOCKED",
    },
    "mock_external_service": {
        "patterns": [
            r"\b(?:mock|fake|stub|dummy|simulated)\s+(?:AI|LLM|api|service|client|integration|provider|response)",
            r"(?:return|yield)\s+(?:mock|fake|simulated|dummy|placeholder|hardcoded)\s+(?:data|response|result|output)",
            r"class\s+(?:Mock|Fake|Stub|Dummy|Simulated)",
            r"(?:simulate|mock out|fake|stub)\s+(?:the|an?)\s+(?:AI|LLM|API|service|payment|email|notification)",
            r"#\s*(?:this would normally call|replace with real|placeholder for real|simulated)",
        ],
        "message": "MOCK DETECTED: Your plan involves simulating/mocking an external service. If the user asked for real integration, you MUST use the actual service API/SDK. Mock is FORBIDDEN in production code. If you cannot access the real service, STOP and tell the user what's missing.",
        "severity": "BLOCKED",
    },
    "oversimplification": {
        "patterns": [
            r"(?:just|simply|quickly)\s+(?:hardcode|fake|mock|stub|skip|ignore)",
            r"(?:skip|omit|ignore)\s+(?:error handling|validation|testing|edge cases|logging)",
            r"(?:add|write|implement)\s+(?:later|afterwards|in the future)",
            r"TODO.*(?:error handling|validation|tests|logging|docs)",
            r"(?:no need|don't need|won't need)\s+(?:validation|error handling|tests|logging|docs|config)",
        ],
        "message": "OVERSIMPLIFICATION DETECTED: Your plan takes shortcuts that compromise engineering quality. Do NOT defer error handling, validation, testing, or logging. Do NOT hardcode configuration. Do NOT skip edge cases. Engineering-grade code required.",
        "severity": "BLOCKED",
    },
    "tool_path_dependency": {
        "patterns": [],
        "check_hint": "Are you using the same tool/library you've used repeatedly without evaluating alternatives? Have you considered at least 2 alternatives?",
        "message": "TOOL PATH DEPENDENCY: You appear to be defaulting to a familiar tool without evaluation. Run tool-discovery.py or actively search for alternatives before proceeding.",
        "severity": "WARNING",
    },
    "passive_waiting": {
        "patterns": [
            r"(?:let me know|tell me|what should I|what do you want|how would you like|shall I) (?:do|proceed|continue|next|start)",
            r"Ready to (?:proceed|continue|start|go)",
            r"Let me know if (?:you|I) (?:should|need to|want)",
        ],
        "message": "PASSIVE WAITING DETECTED: Do NOT wait for the user to tell you the next step. You know the pipeline. Proactively advance.",
        "severity": "WARNING",
    },
}


def load_architecture_rules() -> dict:
    rules_file = PROJECT_ROOT / "constraints" / "architecture-rules.yaml"
    if not rules_file.exists():
        return {}
    with open(rules_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_domain_constraints() -> list:
    agents_file = PROJECT_ROOT / "AGENTS.md"
    if not agents_file.exists():
        return []
    content = agents_file.read_text(encoding="utf-8")
    constraints = []
    in_section = False
    for line in content.split("\n"):
        if "Domain Constraints" in line:
            in_section = True
            continue
        if in_section:
            if line.strip().startswith("- "):
                constraints.append(line.strip()[2:])
            elif line.strip().startswith("###") or line.strip().startswith("##"):
                break
    return constraints


def load_session_state() -> dict:
    state_file = PROJECT_ROOT / "memory" / "session-state.yaml"
    if not state_file.exists():
        return {"status": "not_started"}
    with open(state_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def check_orchestrator_ran() -> tuple:
    state = load_session_state()
    if state.get("status") == "not_started":
        return False, "You have NOT run `python orchestrator.py --status` yet. Run it FIRST."
    if not state.get("progress", {}).get("acceptance_criteria"):
        return False, "No acceptance criteria loaded. Run `python orchestrator.py --status` FIRST."
    return True, "Orchestrator status loaded."


def analyze_plan(plan_description: str) -> list:
    violations = []
    plan_lower = plan_description.lower()
    arch_rules = load_architecture_rules()

    has_frontend_indicator = any(
        kw in plan_lower
        for kw in ["frontend", "component", "page", "view", "ui", "client", "browser", "react", "vue", "angular"]
    )
    has_db_indicator = any(
        kw in plan_lower
        for kw in ["database", "db", "sql", "query", "table", "schema", "migrate", "prisma", "orm", "mongoose", "model"]
    )
    has_route_indicator = any(
        kw in plan_lower
        for kw in ["route", "endpoint", "api", "controller", "handler", "rest"]
    )
    has_business_indicator = any(
        kw in plan_lower
        for kw in ["business logic", "process", "calculate", "transform", "workflow logic"]
    )
    has_multiple_indicator = len(re.findall(r"(?:and also|additionally|furthermore|second,|third,|also)", plan_lower)) > 0
    has_mock_indicator = any(
        kw in plan_lower
        for kw in ["mock", "fake", "stub", "dummy", "simulated", "simulate", "placeholder", "hardcoded response", "mock response"]
    )
    has_real_integration_indicator = any(
        kw in plan_lower
        for kw in ["integrate", "connect to", "use the", "call the", "api of", "sdk", "real api", "actual api", "openai", "claude", "gpt", "llm"]
    )
    has_simplification_indicator = any(
        kw in plan_lower
        for kw in ["skip", "ignore", "defer", "later", "quick", "simple", "just", "hardcode", "placeholder", "todo", "fixme"]
    )
    has_error_handling_indicator = any(
        kw in plan_lower
        for kw in ["error handling", "validation", "edge case", "retry", "exception", "try/catch", "try-except"]
    )
    has_config_indicator = any(
        kw in plan_lower
        for kw in ["config", ".env", "environment variable", "cli arg", "settings file"]
    )
    has_passive_indicator = any(
        kw in plan_lower
        for kw in ["let me know", "tell me what", "should i", "shall i", "do you want", "ready to proceed"]
    )

    if has_mock_indicator and has_real_integration_indicator:
        violations.append({
            "rule": "MOCK_REAL_INTEGRATION",
            "severity": "BLOCKED",
            "message": "MOCK + REAL INTEGRATION conflict: Your plan mentions both mocking/simulating AND real integration. If the user asked for real integration, mocking is FORBIDDEN. Use the real API/SDK. If the real service is unavailable, STOP and tell the user what's missing.",
        })

    if has_mock_indicator and not has_real_integration_indicator:
        violations.append({
            "rule": "MOCK_DETECTED",
            "severity": "WARNING",
            "message": "Your plan mentions mock/fake/simulated/dummy patterns. If the user needs real integration, these are FORBIDDEN. Confirm with the user whether they need REAL or TEST integration.",
        })

    if has_simplification_indicator and not has_error_handling_indicator:
        if "skip" in plan_lower or "ignore" in plan_lower or "later" in plan_lower:
            violations.append({
                "rule": "OVERSIMPLIFICATION",
                "severity": "BLOCKED",
                "message": "Your plan appears to skip/defer error handling or validation. Engineering-grade code MUST include proper error handling, input validation, and config management. Do not defer these to 'later'.",
            })

    if has_simplification_indicator and not has_config_indicator and ("hardcode" in plan_lower or "hard-code" in plan_lower):
        violations.append({
            "rule": "HARDCODED_CONFIG",
            "severity": "WARNING",
            "message": "Your plan mentions hardcoding values. Use config files, environment variables, or CLI arguments instead of hardcoding URLs, keys, or thresholds in source code.",
        })

    if has_passive_indicator:
        violations.append({
            "rule": "PASSIVE_WAITING",
            "severity": "WARNING",
            "message": "Your response shows passive waiting patterns. Do NOT wait for the user to confirm each step. Proactively advance through the pipeline. Only stop for blockers or assumption confirmations.",
        })

    if has_frontend_indicator and has_db_indicator:
        violations.append({
            "rule": "NO_DIRECT_DB_FROM_FRONTEND",
            "severity": "BLOCKED",
            "message": "Your plan mentions both frontend and database. Direct database access from frontend is FORBIDDEN. All data access MUST go through the API layer: frontend → API → service → repository → database.",
        })

    if has_route_indicator and has_business_indicator:
        violations.append({
            "rule": "NO_BUSINESS_LOGIC_IN_ROUTES",
            "severity": "BLOCKED",
            "message": "Your plan suggests business logic in route/endpoint handlers. Business logic belongs in the service layer. Routes should ONLY handle request/response formatting.",
        })

    if has_multiple_indicator:
        violations.append({
            "rule": "ONE_CRITERION_AT_A_TIME",
            "severity": "WARNING",
            "message": "Your plan seems to cover multiple concerns. Implement ONE acceptance criterion at a time. Break your plan into smaller, sequential steps.",
        })

    if has_route_indicator and "validation" not in plan_lower and "validate" not in plan_lower:
        violations.append({
            "rule": "INPUT_VALIDATION_REQUIRED",
            "severity": "WARNING",
            "message": "You're creating an API endpoint but your plan doesn't mention input validation. Every API endpoint MUST have input validation.",
        })

    domain_constraints = load_domain_constraints()
    for dc in domain_constraints:
        dc_lower = dc.lower()
        for keyword in ["no ", "never ", "must not", "forbidden", "cannot", "should not"]:
            if keyword in dc_lower:
                constraint_subject = dc_lower.replace(keyword, "").strip()
                if constraint_subject and constraint_subject in plan_lower:
                    violations.append({
                        "rule": "DOMAIN_CONSTRAINT_VIOLATION",
                        "severity": "BLOCKED",
                        "message": f"Your plan violates the domain constraint: '{dc}'",
                    })
                    break

    if arch_rules:
        dep_direction = arch_rules.get("dependency_direction", {})
        forbidden = dep_direction.get("forbidden", [])
        for fb in forbidden:
            parts = fb.replace(" ", "").split("→")
            if len(parts) == 2:
                source, target = parts
                source_in_plan = source.lower() in plan_lower
                target_in_plan = target.lower() in plan_lower
                if source_in_plan and target_in_plan:
                    violations.append({
                        "rule": "DEPENDENCY_DIRECTION_VIOLATION",
                        "severity": "BLOCKED",
                        "message": f"Forbidden dependency direction: {fb}. Architecture rules require: {', '.join(dep_direction.get('allowed', []))}",
                    })

    return violations


def run_guard(plan_description: str) -> dict:
    result = {
        "timestamp": datetime.now().isoformat(),
        "plan": plan_description,
        "checks": [],
        "verdict": "PASS",
        "blockers": [],
        "warnings": [],
    }

    orch_ok, orch_msg = check_orchestrator_ran()
    result["checks"].append({"check": "orchestrator_status", "passed": orch_ok, "message": orch_msg})
    if not orch_ok:
        result["verdict"] = "BLOCKED"
        result["blockers"].append(orch_msg)

    violations = analyze_plan(plan_description)
    for v in violations:
        check_result = {"check": v["rule"], "passed": v["severity"] != "BLOCKED", "message": v["message"]}
        result["checks"].append(check_result)
        if v["severity"] == "BLOCKED":
            result["verdict"] = "BLOCKED"
            result["blockers"].append(v["message"])
        else:
            result["warnings"].append(v["message"])

    return result


def print_guard_result(result: dict) -> None:
    print("\n" + "=" * 70)
    print("GUARD CHECK RESULT")
    print("=" * 70)
    print(f"Plan: {result['plan'][:100]}...")
    print(f"Verdict: {result['verdict']}")
    print(f"Timestamp: {result['timestamp']}")

    print(f"\n--- Checks ({len(result['checks'])}) ---")
    for check in result["checks"]:
        status = "✅" if check["passed"] else "❌"
        print(f"  {status} {check['check']}: {check['message']}")

    if result["warnings"]:
        print(f"\n--- Warnings ({len(result['warnings'])}) ---")
        for w in result["warnings"]:
            print(f"  ⚠️  {w}")

    if result["blockers"]:
        print(f"\n--- BLOCKERS ({len(result['blockers'])}) ---")
        for b in result["blockers"]:
            print(f"  🛑 {b}")

    print("\n" + "=" * 70)
    if result["verdict"] == "PASS":
        print("✅ GUARD PASSED — You may proceed with implementation.")
        print("   Remember: Run `python orchestrator.py --verify` after coding.")
    else:
        print("🛑 GUARD BLOCKED — Fix the blockers above before writing any code.")
        print("   Rethink your approach and run guard.py again.")
    print("=" * 70)


def compliance_report() -> None:
    state = load_session_state()
    arch_rules = load_architecture_rules()
    domain_constraints = load_domain_constraints()

    print("\n" + "=" * 70)
    print("COMPLIANCE REPORT")
    print("=" * 70)
    print(f"Project Status: {state.get('status', 'unknown')}")
    print(f"Completed Criteria: {len(state.get('progress', {}).get('completed_criteria', []))}")
    print(f"Total Criteria: {len(state.get('progress', {}).get('acceptance_criteria', []))}")
    print(f"Architecture Rules: {len(arch_rules.get('rules', []))} defined")
    print(f"Domain Constraints: {len(domain_constraints)} active")
    print(f"Allowed Dependencies: {len(arch_rules.get('dependency_direction', {}).get('allowed', []))}")
    print(f"Forbidden Dependencies: {len(arch_rules.get('dependency_direction', {}).get('forbidden', []))}")
    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Pre-Action Guard — Validates AI actions against constraints")
    parser.add_argument("--check", default=None, help="Description of what you plan to do")
    parser.add_argument("--status", action="store_true", help="Check if guard system is active")
    parser.add_argument("--report", action="store_true", help="Generate compliance report")
    args = parser.parse_args()

    if args.report:
        compliance_report()
        return

    if args.status:
        state = load_session_state()
        arch_rules = load_architecture_rules()
        print(f"Guard system: ACTIVE")
        print(f"Project status: {state.get('status', 'unknown')}")
        print(f"Architecture rules: {len(arch_rules.get('rules', []))} defined")
        return

    if not args.check:
        print("ERROR: Must provide --check with a description of your planned action.")
        print("Example: python guard.py --check \"I plan to add a new API endpoint for login\"")
        sys.exit(1)

    result = run_guard(args.check)
    print_guard_result(result)

    if result["verdict"] == "BLOCKED":
        sys.exit(1)


if __name__ == "__main__":
    main()
