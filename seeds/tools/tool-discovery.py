#!/usr/bin/env python3
"""
TOOL DISCOVERY ENGINE: Breaks AI path dependency by evaluating tool alternatives.

When the AI repeatedly uses the same tools without considering alternatives,
this engine enforces a structured evaluation process.

It does NOT actually search the internet — it provides a structured framework
that FORCES the AI to document its tool selection reasoning, compare alternatives,
and justify choices with concrete criteria.

Usage:
    python tools/tool-discovery.py --need "HTTP client for async Python"
    python tools/tool-discovery.py --need "ORM for Node.js" --known-tool "sequelize"
    python tools/tool-discovery.py --audit  # Check for tool overuse patterns
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

try:
    import yaml
except ImportError:
    yaml = None

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

TOOL_EVALUATION_CRITERIA = [
    {
        "name": "fit_for_purpose",
        "question": "Does this tool solve the EXACT need (not a superset of the need)?",
        "weight": 0.30,
    },
    {
        "name": "maintenance",
        "question": "Is the project actively maintained? (commits in last 6 months, responsive issues)",
        "weight": 0.20,
    },
    {
        "name": "ecosystem",
        "question": "Is there sufficient community support, documentation, and examples?",
        "weight": 0.15,
    },
    {
        "name": "license",
        "question": "Is the license compatible with the project?",
        "weight": 0.10,
    },
    {
        "name": "weight",
        "question": "Is the dependency weight acceptable? (bundle size, transitive dependencies)",
        "weight": 0.10,
    },
    {
        "name": "learning_curve",
        "question": "Can the team adopt this tool quickly?",
        "weight": 0.10,
    },
    {
        "name": "diversity",
        "question": "Is this a different approach from tools already in use?",
        "weight": 0.05,
    },
]

COMMON_TOOL_CATEGORIES = {
    "http_client": {
        "python": ["httpx", "aiohttp", "requests", "urllib3", "treq"],
        "javascript": ["axios", "got", "node-fetch", "undici", "superagent"],
        "go": ["net/http", "resty", "req", "gentleman", "sling"],
    },
    "orm": {
        "python": ["sqlalchemy", "peewee", "tortoise-orm", "pony", "ormar"],
        "javascript": ["prisma", "drizzle-orm", "typeorm", "knex", "mikro-orm"],
        "go": ["gorm", "ent", "sqlc", "bun", "sqlboiler"],
    },
    "web_framework": {
        "python": ["fastapi", "litestar", "django-ninja", "flask", "sanic"],
        "javascript": ["hono", "fastify", "express", "koa", "elysia"],
        "go": ["chi", "fiber", "echo", "gin", "net/http"],
    },
    "testing": {
        "python": ["pytest", "nose2", "ward", "behave"],
        "javascript": ["vitest", "jest", "mocha", "ava", "uvu"],
        "go": ["testing", "testify", "ginkgo", "go-vcr", "httpexpect"],
    },
    "logging": {
        "python": ["loguru", "structlog", "logbook", "logging"],
        "javascript": ["pino", "winston", "bunyan", "loglevel"],
        "go": ["slog", "zerolog", "zap", "logrus"],
    },
    "validation": {
        "python": ["pydantic", "marshmallow", "cerberus", "attrs+cattrs"],
        "javascript": ["zod", "yup", "joi", "valibot"],
        "go": ["go-playground/validator", "ozzo-validation", "govalidator"],
    },
}


def detect_language(project_root: Path) -> str:
    indicators = {
        "python": ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "poetry.lock", "*.py"],
        "javascript": ["package.json", "yarn.lock", "pnpm-lock.yaml", "*.js", "*.ts"],
        "go": ["go.mod", "go.sum", "*.go"],
    }
    scores = {}
    for lang, files in indicators.items():
        scores[lang] = 0
        for f in files:
            if f.startswith("*."):
                ext = f[1:]
                found = any(p.suffix == ext for p in project_root.rglob("*") if p.is_file())
                if found:
                    scores[lang] += 10
            elif (project_root / f).exists():
                scores[lang] += 20

    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "python"


def detect_used_tools(project_root: Path, language: str) -> list:
    used = []
    if language == "python":
        req_file = project_root / "requirements.txt"
        if req_file.exists():
            for line in req_file.read_text(encoding="utf-8").split("\n"):
                line = line.strip()
                if line and not line.startswith("#"):
                    pkg = re.split(r'[=<>~!]', line)[0].strip()
                    used.append(pkg)
        pyproject = project_root / "pyproject.toml"
        if pyproject.exists():
            content = pyproject.read_text(encoding="utf-8")
            for match in re.finditer(r'(?:requires\s*=\s*\[|dependencies\s*=\s*\[)(.*?)\]', content, re.DOTALL):
                for dep in re.findall(r'"([^"]+)"', match.group(1)):
                    pkg = re.split(r'[=<>~!]', dep)[0].strip()
                    used.append(pkg)

    elif language == "javascript":
        pkg_file = project_root / "package.json"
        if pkg_file.exists():
            data = json.loads(pkg_file.read_text(encoding="utf-8"))
            for dep_type in ("dependencies", "devDependencies"):
                for pkg in data.get(dep_type, {}):
                    used.append(pkg)

    elif language == "go":
        mod_file = project_root / "go.mod"
        if mod_file.exists():
            for line in mod_file.read_text(encoding="utf-8").split("\n"):
                if line.strip() and not line.startswith("module") and not line.startswith("go "):
                    parts = line.strip().split()
                    if parts:
                        used.append(parts[0])

    return list(set(used))


def get_tool_history(project_root: Path) -> list:
    history = []
    tool_log = project_root / "evolution" / "log.yaml"
    if tool_log.exists() and yaml:
        data = yaml.safe_load(tool_log.read_text(encoding="utf-8"))
        if data and "tool_decisions" in data:
            history = data["tool_decisions"]
    elif tool_log.exists():
        try:
            data = json.loads(tool_log.read_text(encoding="utf-8"))
            history = data.get("tool_decisions", [])
        except Exception:
            pass
    return history


def evaluate_alternatives(need: str, known_tool: str, language: str) -> dict:
    matched_category = None
    for category, lang_map in COMMON_TOOL_CATEGORIES.items():
        if language in lang_map:
            alternatives = lang_map[language]
            if known_tool and known_tool in alternatives:
                matched_category = category
                break
            for alt in alternatives:
                if alt.lower() in need.lower() or need.lower() in alt.lower():
                    matched_category = category
                    break

    if not matched_category:
        words = re.findall(r'\w+', need.lower())
        for category, lang_map in COMMON_TOOL_CATEGORIES.items():
            if language in lang_map:
                for word in words:
                    if word in category or category in word:
                        matched_category = category
                        break
                if matched_category:
                    break

    alternatives = []
    if matched_category and language in COMMON_TOOL_CATEGORIES.get(matched_category, {}):
        alternatives = COMMON_TOOL_CATEGORIES[matched_category][language]
        if known_tool:
            alternatives = [a for a in alternatives if a != known_tool]
            alternatives.insert(0, f"KEEP: {known_tool}")

    return {
        "need": need,
        "known_tool": known_tool,
        "language": language,
        "category": matched_category or "unknown",
        "candidates": alternatives or ["No alternatives found — search package registry"],
        "evaluation_prompt": f"""
TOOL DISCOVERY: Evaluate alternatives for '{need}'

You MUST evaluate at least 3 alternatives before making a choice.
For each candidate, score 1-5 on:

{chr(10).join(f'- {c["name"]}: {c["question"]}' for c in TOOL_EVALUATION_CRITERIA)}

Current known tool: {known_tool or 'None'}
Candidates to evaluate: {', '.join(alternatives) if alternatives else 'Search for alternatives'}

Your task:
1. Search for each candidate (web search, docs, package registry)
2. Score each candidate on all 7 criteria
3. Write your decision in evolution/tool_decisions.yaml
4. Proceed with the BEST tool (not necessarily the one you know)
""",
    }


def generate_tool_audit(project_root: Path) -> dict:
    language = detect_language(project_root)
    used = detect_used_tools(project_root, language)
    history = get_tool_history(project_root)

    overused = []
    for tool in used:
        count = sum(1 for h in history if tool in h.get("tool", ""))
        if count >= 3:
            overused.append({"tool": tool, "usage_count": count, "risk": "path_dependency"})

    return {
        "project_root": str(project_root),
        "language": language,
        "tools_in_use": used,
        "total_tools": len(used),
        "overused_tools": overused,
        "tool_decisions_logged": len(history),
        "recommendation": "Run --need for each overused tool to discover alternatives" if overused else "Tool diversity looks healthy",
    }


def print_discovery(result: dict) -> None:
    print("\n" + "=" * 70)
    print("TOOL DISCOVERY REPORT")
    print("=" * 70)
    print(f"Need: {result['need']}")
    print(f"Known tool: {result['known_tool'] or 'None'}")
    print(f"Language: {result['language']}")
    print(f"Category: {result['category']}")
    print(f"\nCandidates:")
    for i, c in enumerate(result["candidates"], 1):
        print(f"  {i}. {c}")
    print("\n" + "=" * 70)
    print(result["evaluation_prompt"])
    print("=" * 70)


def print_audit(result: dict) -> None:
    print("\n" + "=" * 70)
    print("TOOL DIVERSITY AUDIT")
    print("=" * 70)
    print(f"Project: {result['project_root']}")
    print(f"Language: {result['language']}")
    print(f"Tools in use: {result['total_tools']}")
    print(f"Tool decisions logged: {result['tool_decisions_logged']}")

    if result["overused_tools"]:
        print(f"\n⚠️  OVERUSED TOOLS (risk of path dependency):")
        for t in result["overused_tools"]:
            print(f"  - {t['tool']}: used {t['usage_count']} times")
    else:
        print(f"\n✅ Tool diversity looks healthy")

    print(f"\n{result['recommendation']}")
    print("=" * 70)


def main():
    parser = argparse.ArgumentParser(description="Tool Discovery Engine — Break path dependency by evaluating alternatives")
    parser.add_argument("--need", default=None, help="Description of the capability you need")
    parser.add_argument("--known-tool", default=None, help="The tool you would default to using")
    parser.add_argument("--language", default=None, help="Programming language (auto-detected if not specified)")
    parser.add_argument("--audit", action="store_true", help="Audit current project for tool overuse patterns")
    parser.add_argument("--output-json", action="store_true", help="Output results as JSON")
    args = parser.parse_args()

    project_root = Path(".").resolve()

    if args.audit:
        result = generate_tool_audit(project_root)
        if args.output_json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print_audit(result)
        return

    if not args.need:
        print("ERROR: Must provide --need with a description of the capability needed.")
        print("Example: python tools/tool-discovery.py --need \"async HTTP client\" --known-tool requests")
        sys.exit(1)

    language = args.language or detect_language(project_root)
    result = evaluate_alternatives(args.need, args.known_tool, language)

    if args.output_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print_discovery(result)


if __name__ == "__main__":
    main()