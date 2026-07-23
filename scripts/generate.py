#!/usr/bin/env python3
"""
Meta-Harness Generator: Task → Complete Executable Harness Project

Reads a task definition (from interpreter output) and generates a complete
7-layer + 2 cross-cutting + evolution harness project with executable artifacts
in every layer. Output is customized per domain template.

Usage:
    python scripts/generate.py --task <task-file.yaml> [--template <domain>] [--output <dir>]
    python scripts/generate.py --task task.yaml --template api-service --output generated/my-project
"""

import argparse
import json
import os
import re
import shutil
import sys
import yaml
from datetime import datetime
from pathlib import Path

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

META_DIR = Path(__file__).resolve().parent.parent / "meta"
TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"
SEEDS_DIR = Path(__file__).resolve().parent.parent / "seeds"
HARNESS_ROOT = Path(__file__).resolve().parent.parent

TASK_SCHEMA = {
    "type": "object",
    "required": ["name", "domain", "goal"],
    "properties": {
        "name": {"type": "string", "minLength": 1},
        "domain": {"type": "string", "minLength": 1},
        "real_need": {"type": "string"},
        "goal": {"type": "string", "minLength": 1},
        "scale": {"type": "string"},
        "quality_attributes": {"type": "array"},
        "hard_constraints": {"type": "array"},
        "soft_constraints": {"type": "array"},
        "acceptance_criteria": {"type": "array"},
        "unknowns": {"type": "array"},
        "assumptions": {"type": "array"},
    },
}

LAYER_DIRS = {
    "context": "Layer 1: Context Engineering",
    "tools": "Layer 2: Tool Integration",
    "memory": "Layer 3: Memory & State",
    "planning": "Layer 4: Planning & Orchestration",
    "verification": "Layer 5: Verification & Guardrails",
    "feedback": "Layer 6: Feedback & Self-Healing",
    "constraints": "Layer 7: Constraints & Entropy",
    "security": "Cross-Cutting: Security & Isolation",
    "observability": "Cross-Cutting: Observability & Governance",
    "evolution": "Self-Evolution",
}

LAYER_ARTIFACTS = {
    "context": ["loader.py", "knowledge-index.yaml"],
    "tools": ["schemas.yaml", "sandbox.yaml", "permissions.yaml", "mcp-config.json", "tool-discovery.py"],
    "memory": ["session-state.yaml", "compression-rules.yaml", "snapshot.py"],
    "planning": ["dag-builder.py", "flow-control.yaml", "sub-agent-dispatch.yaml", "budget.yaml"],
    "verification": ["consistency-check.py", "security-guardrails.yaml", "self-check.py", "anti-mock-check.py", "quality-gate.py"],
    "feedback": ["error-capture.py", "retry-config.yaml", "mistake-to-constraint.py", "human-interface.yaml"],
    "constraints": ["architecture-rules.yaml", "linter-config.yaml", "entropy-reduction.py", "cost-budget.yaml"],
    "security": ["sandbox-config.yaml", "encryption-rules.yaml", "audit-log.yaml"],
    "observability": ["tracing.yaml", "metrics-dashboard.yaml", "session-replay.yaml", "versioning.yaml"],
    "evolution": ["framework.md", "genome.yaml", "log.yaml"],
}

# Marker file written into every generated project so that future regenerations
# can safely distinguish a harness-generated directory from an unrelated one
# before deleting it (prevents accidental data loss via shutil.rmtree).
HARNESS_MARKER = ".harness-generated"

# ARTIFACT_GATE: 按复杂度因子 (S/C/N/K) + tier 谓词裁剪每层 artifact。
# 第一性原理：每多一个 artifact 都付出上下文成本，应仅在因果因子需要时复制。
# 未列出的文件默认 always（保守，避免意外丢失）。核心层 (context/memory/planning/
# constraints/evolution/tools) 全部 always，仅可选层 (verification/feedback/
# security/observability) 按因子裁剪。最小可行 harness 边界在 gate 内保证。
ARTIFACT_GATE = {
    "verification": {
        "self-check.py":            "always",              # 最小边界：无验证非 harness
        "consistency-check.py":     "K>=3",                # 高耦合才需一致性检查
        "security-guardrails.yaml": "C>=3",                # 高代价才需安全护栏
        "anti-mock-check.py":       "C>=3 or N>=3",        # 高代价或高新颖才需反 mock
        "quality-gate.py":          "C>=3",                # 高代价才需质量门
    },
    "observability": {
        "tracing.yaml":             "tier!='minimal'",
        "metrics-dashboard.yaml":   "tier!='minimal'",
        "session-replay.yaml":      "tier=='full'",
        "versioning.yaml":          "always",
    },
    "feedback": {
        "error-capture.py":         "always",
        "retry-config.yaml":        "always",
        "mistake-to-constraint.py": "tier!='minimal'",       # minimal 不做 mistake→constraint 复利
        "human-interface.yaml":     "C>=4",                # 仅高代价才需人工 gate
    },
    "security": {
        "sandbox-config.yaml":      "tier!='minimal'",
        "encryption-rules.yaml":    "C>=3",
        "audit-log.yaml":           "C>=4",
    },
}

# 默认复杂度（向后兼容：旧 task.yaml 无 complexity 字段时用此值，≈ 当前全量复制行为）
DEFAULT_COMPLEXITY = {"scope": 3, "criticality": 3, "novelty": 3, "coupling": 3, "tier": "standard"}


def compute_profile(task: dict) -> dict:
    """从 task 提取复杂度 profile，缺省回退 DEFAULT_COMPLEXITY（向后兼容）。"""
    cx = task.get("complexity") or {}
    profile = {
        "tier": cx.get("tier", DEFAULT_COMPLEXITY["tier"]),
        "scope": cx.get("scope", DEFAULT_COMPLEXITY["scope"]),
        "criticality": cx.get("criticality", DEFAULT_COMPLEXITY["criticality"]),
        "novelty": cx.get("novelty", DEFAULT_COMPLEXITY["novelty"]),
        "coupling": cx.get("coupling", DEFAULT_COMPLEXITY["coupling"]),
    }
    return profile


def _eval_gate(predicate: str, profile: dict) -> bool:
    """安全评估 ARTIFACT_GATE 谓词。谓词是代码内常量（非用户输入），故 eval 可接受。"""
    if predicate == "always":
        return True
    env = {
        "tier": profile["tier"],
        "S": profile["scope"],
        "C": profile["criticality"],
        "N": profile["novelty"],
        "K": profile["coupling"],
    }
    try:
        return bool(eval(predicate, {"__builtins__": {}}, env))
    except Exception:
        return True  # 谓词解析失败默认复制（保守，避免意外丢失 artifact）


def should_copy_artifact(layer: str, filename: str, profile: dict) -> bool:
    """判断某 seed artifact 是否应按 profile 复制。未列入 gate 的默认 always。"""
    gate = ARTIFACT_GATE.get(layer, {})
    if filename not in gate:
        return True
    return _eval_gate(gate[filename], profile)


def _get_src_dirs(template_name: str) -> list:
    src_layouts = {
        "web-app": ["src/api", "src/components", "src/services", "src/repositories", "src/models", "src/utils", "tests"],
        "api-service": ["src/routes", "src/services", "src/repositories", "src/models", "src/utils", "schemas", "tests"],
        "automation": ["src/triggers", "src/actions", "src/conditions", "src/monitors", "src/utils", "tests"],
        "data-pipeline": ["src/ingest", "src/transforms", "src/validate", "src/output", "src/utils", "schemas", "tests"],
        "content-system": ["src/research", "src/drafts", "src/reviews", "src/templates", "src/utils", "tests"],
    }
    return src_layouts.get(template_name, ["src", "tests"])


def validate_task(task: dict) -> list:
    errors = []
    for field in TASK_SCHEMA.get("required", []):
        if field not in task or not task[field]:
            errors.append(f"Missing required field: {field}")
    props = TASK_SCHEMA.get("properties", {})
    for key, value in task.items():
        if key in props:
            expected_type = props[key].get("type")
            if expected_type == "string" and not isinstance(value, str):
                errors.append(f"Field '{key}' must be a string")
            elif expected_type == "array" and not isinstance(value, list):
                errors.append(f"Field '{key}' must be an array")
    if "acceptance_criteria" in task and isinstance(task["acceptance_criteria"], list):
        if len(task["acceptance_criteria"]) == 0:
            errors.append("acceptance_criteria should not be empty (tasks need measurable outcomes)")
    return errors


def load_task(task_file: Path) -> dict:
    if not task_file.exists():
        print(f"ERROR: Task file not found: {task_file}")
        sys.exit(1)
    with open(task_file, "r", encoding="utf-8") as f:
        if task_file.suffix in (".yaml", ".yml"):
            task = yaml.safe_load(f)
        elif task_file.suffix == ".json":
            task = json.load(f)
        else:
            print(f"ERROR: Unsupported task file format: {task_file.suffix}")
            sys.exit(1)

    if not task or not isinstance(task, dict):
        print("ERROR: Task file is empty or not a valid object")
        sys.exit(1)

    errors = validate_task(task)
    if errors:
        print("ERROR: Task definition validation failed:")
        for err in errors:
            print(f"  - {err}")
        sys.exit(1)

    return task


def detect_template(task: dict) -> str:
    domain = task.get("domain", "").lower()
    domain_map = {
        "software_development": "web-app",
        "web_app": "web-app",
        "web_application": "web-app",
        "api_service": "api-service",
        "api": "api-service",
        "automation": "automation",
        "data_processing": "data-pipeline",
        "data_pipeline": "data-pipeline",
        "etl": "data-pipeline",
        "content_generation": "content-system",
        "content_system": "content-system",
    }
    return domain_map.get(domain, "web-app")


def parse_template(template_file: Path) -> dict:
    if not template_file.exists():
        return {"constraints": [], "workflows": [], "agent_topology": [], "verification_checklist": [], "quality_attributes": []}
    content = template_file.read_text(encoding="utf-8")
    result = {"constraints": [], "workflows": [], "agent_topology": [], "verification_checklist": [], "quality_attributes": []}

    sections = re.split(r"^### ", content, flags=re.MULTILINE)
    for section in sections:
        if section.startswith("Constraints (seed"):
            items = re.findall(r"^- (.+)$", section, re.MULTILINE)
            result["constraints"] = [item.strip() for item in items]
        elif section.startswith("Workflows (seed"):
            blocks = re.split(r"^- ", section, flags=re.MULTILINE)
            for block in blocks:
                if ":" in block:
                    name = block.split(":", 1)[0].strip()
                    # Take everything after the colon and split on → to preserve
                    # the FIRST step (the old regex `→\s*(.+)$` dropped it).
                    steps_part = block.split(":", 1)[1].strip()
                    steps = [s.strip() for s in steps_part.split("→")] if "→" in steps_part else []
                    result["workflows"].append({"name": name, "steps": steps})
        elif section.startswith("Agent Topology (seed"):
            lines = section.strip().split("\n")
            current_pattern = None
            for line in lines:
                line = line.strip()
                if "pattern:" in line.lower() or "Three-Agent" in line or "Planner-Executor" in line or "Pipeline" in line:
                    current_pattern = line.rstrip(":")
                elif line.startswith("- ") and current_pattern:
                    result["agent_topology"].append({"role": line[2:].strip(), "pattern": current_pattern})
        elif section.startswith("Verification Checklist (seed"):
            items = re.findall(r"^- (.+)$", section, re.MULTILINE)
            result["verification_checklist"] = [item.strip() for item in items]
        elif section.startswith("Quality Attributes Priority"):
            items = re.findall(r"^\d+\.\s+(\w+)", section, re.MULTILINE)
            result["quality_attributes"] = items

    return result


def load_template(template_name: str) -> dict:
    template_file = TEMPLATES_DIR / template_name / "template.md"
    if not template_file.exists():
        print(f"WARNING: Template not found: {template_file}, using web-app")
        template_file = TEMPLATES_DIR / "web-app" / "template.md"
    parsed = parse_template(template_file)
    return {"path": template_file, "name": template_name, "parsed": parsed}


def copy_seed_artifacts(output_dir: Path, layer: str, profile: dict = None) -> list:
    """复制 seeds/<layer>/ 下的 artifact 到 output_dir/<layer>/。

    若提供 profile，则按 ARTIFACT_GATE 谓词过滤（自适应规模）。
    profile=None 时全量复制（向后兼容）。
    """
    seed_dir = SEEDS_DIR / layer
    layer_dir = output_dir / layer
    layer_dir.mkdir(parents=True, exist_ok=True)
    copied = []

    if seed_dir.exists():
        for item in seed_dir.iterdir():
            # profile 过滤：仅作用于文件，子目录（如 tools/adapters/）默认全量复制
            if profile is not None and item.is_file():
                if not should_copy_artifact(layer, item.name, profile):
                    continue
            dest = layer_dir / item.name
            if item.is_file():
                shutil.copy2(item, dest)
                copied.append(dest.relative_to(output_dir))
            elif item.is_dir():
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(item, dest)
                for f in dest.rglob("*"):
                    if f.is_file():
                        copied.append(f.relative_to(output_dir))
    return copied


def customize_knowledge_index(output_dir: Path, template: dict) -> None:
    ki_file = output_dir / "context" / "knowledge-index.yaml"
    if not ki_file.exists():
        return
    with open(ki_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    template_name = template.get("name", "web-app")
    # v2: 每条映射为 {description, tags} dict，支持 loader.py 多信号排序检索
    domain_mappings = {
        "web-app": {
            "src/api/": {"description": "API endpoints and contracts", "tags": ["api", "contract", "endpoint", "route"]},
            "src/components/": {"description": "UI components", "tags": ["ui", "component", "frontend", "view"]},
            "src/services/": {"description": "Business logic", "tags": ["service", "business", "logic"]},
            "src/repositories/": {"description": "Data access", "tags": ["data", "persistence", "db", "repository"]},
        },
        "api-service": {
            "src/routes/": {"description": "API route handlers", "tags": ["api", "route", "endpoint", "handler"]},
            "src/services/": {"description": "Business logic layer", "tags": ["service", "business", "logic"]},
            "src/repositories/": {"description": "Data access layer", "tags": ["data", "persistence", "db", "repository"]},
            "src/models/": {"description": "Data models and types", "tags": ["model", "type", "entity", "dto"]},
            "schemas/": {"description": "API schema definitions", "tags": ["schema", "definition", "validation"]},
        },
        "automation": {
            "triggers/": {"description": "Event trigger definitions", "tags": ["trigger", "event", "automation"]},
            "actions/": {"description": "Automation action handlers", "tags": ["action", "handler", "automation"]},
            "monitors/": {"description": "Health check monitors", "tags": ["monitor", "health", "check"]},
            "workflows/": {"description": "Automation workflow configs", "tags": ["workflow", "config", "automation"]},
        },
        "data-pipeline": {
            "schemas/": {"description": "Data schema definitions", "tags": ["schema", "definition", "data"]},
            "transforms/": {"description": "Data transformation logic", "tags": ["transform", "data", "logic"]},
            "quality/": {"description": "Data validation rules", "tags": ["quality", "validation", "rule"]},
            "pipelines/": {"description": "Pipeline configurations", "tags": ["pipeline", "config", "etl"]},
        },
        "content-system": {
            "templates/": {"description": "Content structure templates", "tags": ["template", "content", "structure"]},
            "style-guide/": {"description": "Writing rules and style", "tags": ["style", "guide", "rule", "writing"]},
            "topics/": {"description": "Subject matter knowledge", "tags": ["topic", "knowledge", "domain"]},
            "reviews/": {"description": "Content review records", "tags": ["review", "content", "qa"]},
        },
    }
    if template_name in domain_mappings:
        data["mappings"] = domain_mappings[template_name]

    with open(ki_file, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)


def customize_architecture_rules(output_dir: Path, template: dict) -> None:
    rules_file = output_dir / "constraints" / "architecture-rules.yaml"
    if not rules_file.exists():
        return
    with open(rules_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    parsed = template.get("parsed", {})
    domain_constraints = parsed.get("constraints", [])
    if domain_constraints:
        existing_ids = {r.get("id", "") for r in data.get("rules", [])}
        next_id = len(data.get("rules", [])) + 1
        for constraint in domain_constraints:
            rule_id = f"DC{next_id:03d}"
            if rule_id not in existing_ids:
                data.setdefault("rules", []).append({
                    "id": rule_id,
                    "description": constraint,
                    "pattern": "",
                    "severity": "warning",
                    "source": f"domain template: {template.get('name', 'unknown')}",
                })
                next_id += 1

    template_name = template.get("name", "web-app")
    dep_directions = {
        "web-app": {"allowed": ["frontend → api", "api → service", "service → repo", "repo → DB"], "forbidden": ["DB → repo", "repo → service", "service → api", "frontend → DB"]},
        "api-service": {"allowed": ["route → service", "service → repository", "repository → database"], "forbidden": ["database → repository", "repository → service", "service → route"]},
        "automation": {"allowed": ["trigger → condition → action", "action → verify → log"], "forbidden": ["action → trigger", "log → action"]},
        "data-pipeline": {"allowed": ["ingest → validate → transform → output", "output → audit"], "forbidden": ["output → ingest", "transform → ingest"]},
        "content-system": {"allowed": ["research → draft → review → publish"], "forbidden": ["publish → draft", "review → research"]},
    }
    if template_name in dep_directions:
        data["dependency_direction"] = dep_directions[template_name]

    with open(rules_file, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)


def customize_flow_control(output_dir: Path, template: dict) -> None:
    flow_file = output_dir / "planning" / "flow-control.yaml"
    if not flow_file.exists():
        return
    with open(flow_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    parsed = template.get("parsed", {})
    domain_workflows = parsed.get("workflows", [])
    if domain_workflows:
        data.setdefault("workflows", {})
        for wf in domain_workflows:
            wf_name = wf.get("name", "custom").lower().replace(" ", "_")
            steps = wf.get("steps", [])
            if steps:
                flow_steps = []
                for i, step in enumerate(steps):
                    flow_step = {"name": step.lower().replace(" ", "_"), "next": []}
                    if i < len(steps) - 1:
                        flow_step["next"] = [steps[i + 1].lower().replace(" ", "_")]
                    flow_steps.append(flow_step)
                data["workflows"][wf_name] = {"type": "sequential", "steps": flow_steps}

    with open(flow_file, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)


def customize_sub_agent_dispatch(output_dir: Path, template: dict) -> None:
    dispatch_file = output_dir / "planning" / "sub-agent-dispatch.yaml"
    if not dispatch_file.exists():
        return
    with open(dispatch_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    parsed = template.get("parsed", {})
    agent_topology = parsed.get("agent_topology", [])
    if agent_topology:
        # Merge with seed-defined roles instead of overwriting them.
        # The seed sub-agent-dispatch.yaml defines planner/executor/verifier
        # with full responsibilities/receives/produces — preserve those.
        existing_roles = data.get("roles", [])
        existing_names = {r.get("name", "").lower() for r in existing_roles}
        for agent in agent_topology:
            role_name = agent.get("role", "unknown").lower().split(":")[0].strip()
            if role_name in existing_names:
                continue
            existing_roles.append({
                "name": role_name,
                "responsibilities": [agent.get("role", "")],
                "receives": [],
                "produces": [],
            })
            existing_names.add(role_name)
        data["roles"] = existing_roles

    with open(dispatch_file, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)


def customize_cost_budget(output_dir: Path, template: dict) -> None:
    budget_file = output_dir / "constraints" / "cost-budget.yaml"
    if not budget_file.exists():
        return

    template_name = template.get("name", "web-app")
    domain_budgets = {
        "web-app": {"api": {"max_response_time_seconds": 2}, "build": {"max_bundle_size_kb": 500}, "cost": {"max_monthly_infra_cost_usd": 50}},
        "api-service": {"api": {"max_response_time_seconds": 0.5}, "database": {"max_query_time_seconds": 0.1}, "cost": {"max_monthly_infra_cost_usd": 30}},
        "automation": {"runtime": {"max_automation_runtime_seconds": 1800}, "cost": {"max_monthly_compute_cost_usd": 20}},
        "data-pipeline": {"runtime": {"max_pipeline_runtime_seconds": 3600}, "storage": {"max_data_storage_gb": 10}, "cost": {"max_monthly_compute_cost_usd": 40}},
        "content-system": {"content": {"max_content_pieces_per_day": 20}, "cost": {"max_monthly_api_cost_usd": 15}},
    }

    with open(budget_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    if template_name in domain_budgets:
        for category, limits in domain_budgets[template_name].items():
            if category in data.get("limits", {}):
                data["limits"][category].update(limits)
            else:
                data.setdefault("limits", {})[category] = limits

    with open(budget_file, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)


def generate_agents_md(output_dir: Path, task: dict, template: dict) -> None:
    name = task.get("name", "Generated Project")
    real_need = task.get("real_need", "See task definition")
    goal = task.get("goal", "Complete the task successfully")
    template_name = template.get("name", "web-app")
    parsed = template.get("parsed", {})

    constraints_section = ""
    domain_constraints = parsed.get("constraints", [])
    if domain_constraints:
        constraints_lines = [f"- {c}" for c in domain_constraints]
        constraints_section = "\n### Domain Constraints (YOU MUST FOLLOW)\n" + "\n".join(constraints_lines)

    workflows_section = ""
    domain_workflows = parsed.get("workflows", [])
    if domain_workflows:
        workflow_lines = []
        for wf in domain_workflows:
            steps = " → ".join(wf.get("steps", []))
            workflow_lines.append(f"- **{wf.get('name', 'custom')}**: {steps}")
        workflows_section = "\n### Domain Workflows\n" + "\n".join(workflow_lines)

    topology_section = ""
    agent_topology = parsed.get("agent_topology", [])
    if agent_topology:
        topology_lines = []
        for agent in agent_topology:
            topology_lines.append(f"- {agent.get('role', 'unknown')}")
        topology_section = "\n### Agent Topology (Your Role Assignment)\n" + "\n".join(topology_lines)

    checklist_section = ""
    verification_checklist = parsed.get("verification_checklist", [])
    if verification_checklist:
        checklist_section = "\n### Mandatory Verification Checklist\n" + "\n".join(f"- [ ] {c}" for c in verification_checklist)

    acceptance_section = ""
    criteria = task.get("acceptance_criteria", [])
    if criteria:
        acceptance_section = "\n### Acceptance Criteria (Implement One At A Time)\n" + "\n".join(f"- [ ] {c}" for c in criteria)

    content = f"""# {name} — EXECUTION PROTOCOL

## ⚠️ THIS FILE IS YOUR OPERATING SYSTEM. YOU CANNOT DEVIATE.

This project is governed by an automated harness. Every action goes through orchestrator.py.

---

## 🔴 Startup: Run `python orchestrator.py --status` FIRST

---

## 🔵 Execution Loop (Follow for EVERY criterion)

```
PLAN  → Read constraints/, plan your implementation
GUARD → python guard.py --check "describe your plan"
          If BLOCKED: fix plan, re-run guard
CODE  → Implement following domain constraints below
VERIFY→ python orchestrator.py --verify
          If FAIL: python feedback/error-capture.py, fix root cause, re-verify
MARK  → python orchestrator.py --mark-complete "criterion text"
NEXT  → Repeat for next pending criterion
```

When ALL criteria done: `python orchestrator.py --evolve && python orchestrator.py --innovate`

---

## 📋 Project Definition

### Real Need
{real_need}

### Goal
{goal}

### Domain Template
{template_name}

{constraints_section}
{workflows_section}
{topology_section}
{checklist_section}
{acceptance_section}

## 🚫 ANTI-MOCK PROTOCOL (ZERO TOLERANCE)

**NEVER simulate, mock, stub, or fake an external dependency when the user requests real integration.**

1. STOP and CONFIRM before any external integration
2. NEVER return hardcoded responses pretending to be from a real service
3. NEVER create Mock/Fake/Stub/Dummy classes in production code
4. ALWAYS use real API keys, real endpoints, real SDKs
5. If you cannot access the real service: STOP and tell the user what's missing

Run `python verification/anti-mock-check.py --project-root .` before marking ANY task complete.

## 🔧 ENGINEERING STANDARDS (MUST FOLLOW)

| Aspect | ❌ FORBIDDEN | ✅ REQUIRED |
|--------|-------------|-------------|
| Config | Hardcoded values | Config files, env vars, CLI args |
| Error handling | `try/catch` with pass | Typed errors, retry logic |
| Validation | None or trivial | Schema validation, boundary checks |
| Logging | `print()` statements | Structured logging |
| Testing | None | Tests before claiming completion |
| Secrets | Hardcoded in source | `.env`, never committed |
| Edge cases | Ignored | Explicitly handled |

Run `python verification/quality-gate.py --check` before marking ANY task complete.

### Architecture (Reference)
7 layers + 4 cross-cutting:
- Layer 1-7: context/ tools/ memory/ planning/ verification/ feedback/ constraints/
- Cross-cutting: security/ observability/ anti-mock-check.py/ quality-gate.py
- Self-Evolution: evolution/

---

## 🔴 ABSOLUTE RULES

1. NO code without `python guard.py --check`
2. NO completion without `python orchestrator.py --verify`
3. ONE criterion at a time — no multi-tasking
4. NO self-certification — only orchestrator marks complete
5. NO symptom patching — chase root causes
6. NO mocking real integrations — real API/SDK or explain why you can't
7. NO prototype shortcuts — engineering-grade code required
8. NO tool path dependency — evaluate alternatives
9. NO passive waiting — proactively advance
10. Evolution never removes verification or itself

---

## 🛠️ Quick Reference

```bash
python orchestrator.py --status                              # MUST run first
python guard.py --check "your plan"                          # MUST run before code
python orchestrator.py --verify                              # MUST run after code
python orchestrator.py --mark-complete "criterion"           # Mark done
python orchestrator.py --evolve                              # Self-improvement
python verification/anti-mock-check.py --project-root .
python verification/quality-gate.py --check
python tools/tool-discovery.py --need "capability"
```
"""
    (output_dir / "AGENTS.md").write_text(content, encoding="utf-8")
    (output_dir / "CLAUDE.md").write_text(f"# Redirect to AGENTS.md\n\nAll operating instructions are in AGENTS.md. Read that file.\n", encoding="utf-8")
    # .cursorrules: Cursor reads this as its rules file. Redirect to AGENTS.md
    # so the project works out-of-the-box for Cursor users (no manual copy needed).
    (output_dir / ".cursorrules").write_text(f"# Redirect to AGENTS.md\n\nAll operating instructions are in AGENTS.md. Read that file.\n", encoding="utf-8")


def generate_session_state(output_dir: Path, task: dict) -> None:
    state = {
        "task_name": task.get("name", "unknown"),
        "created_at": datetime.now().isoformat(),
        "status": "initialized",
        "progress": {
            "layers_generated": list(LAYER_DIRS.keys()),
            "acceptance_criteria": task.get("acceptance_criteria", []),
            "completed_criteria": [],
            "failed_criteria": [],
        },
        "checkpoints": [],
    }
    memory_dir = output_dir / "memory"
    memory_dir.mkdir(parents=True, exist_ok=True)
    with open(memory_dir / "session-state.yaml", "w", encoding="utf-8") as f:
        yaml.dump(state, f, default_flow_style=False, allow_unicode=True)

    long_term_dir = memory_dir / "long-term"
    long_term_dir.mkdir(parents=True, exist_ok=True)
    (long_term_dir / ".gitkeep").write_text("", encoding="utf-8")


def preseed_long_term(output_dir: Path, profile: dict, template_name: str) -> None:
    """按 Novelty 因子差异化预填 memory/long-term/（问题2核心落地）。

    第一性原理：KB 质量必须等于新颖性曲面（N 因子）。
      - N<=2（熟悉）: 不预填（.gitkeep 保留，多了是上下文污染）
      - N==3（较新）: 预填 domain-advancements 的 Solid 阶段 innovations
      - N>=4（陌生）: 预填 Solid + Advanced，并从 trigger 字段生成 anti-patterns
    """
    novelty = profile.get("novelty", 3)
    if novelty < 3:
        return  # 熟悉领域不预填

    # 定位 domain-advancements 源文件
    adv_file = SEEDS_DIR / "evolution" / f"domain-advancements-{template_name}.yaml"
    if not adv_file.exists():
        adv_file = SEEDS_DIR / "evolution" / "domain-advancements.yaml"
    if not adv_file.exists():
        return

    with open(adv_file, "r", encoding="utf-8") as f:
        adv_data = yaml.safe_load(f) or {}
    stages = adv_data.get("stages", []) or []

    # 按 N 收集对应阶段的 innovations
    # N==3 → Solid；N==4 → Solid+Advanced；N==5 → Solid+Advanced+Excellent
    stage_names_by_n = {
        3: ["Solid"],
        4: ["Solid", "Advanced"],
        5: ["Solid", "Advanced", "Excellent"],
    }
    target_stages = stage_names_by_n.get(novelty, ["Solid", "Advanced"])

    known_patterns = []
    anti_patterns = []
    for stage in stages:
        stage_name = stage.get("name", "")
        if stage_name not in target_stages:
            continue
        for inn in stage.get("innovations", []) or []:
            known_patterns.append({
                "id": inn.get("id"),
                "name": inn.get("name"),
                "description": inn.get("description"),
                "category": inn.get("category"),
                "effort": inn.get("effort"),
                "impact": inn.get("impact"),
                "source_stage": stage_name,
            })
            # trigger 字段描述"何时需要此创新"，转化为"缺失时的反模式"
            trigger = inn.get("trigger")
            if trigger:
                anti_patterns.append({
                    "id": inn.get("id"),
                    "anti_pattern": f"Missing: {inn.get('name')}",
                    "trigger": trigger,
                    "source_stage": stage_name,
                })

    long_term_dir = output_dir / "memory" / "long-term"
    long_term_dir.mkdir(parents=True, exist_ok=True)

    if known_patterns:
        with open(long_term_dir / "known-patterns.yaml", "w", encoding="utf-8") as f:
            yaml.dump({"version": 1, "novelty_at_seed": novelty,
                       "patterns": known_patterns}, f, default_flow_style=False, allow_unicode=True)
    if anti_patterns:
        with open(long_term_dir / "anti-patterns.yaml", "w", encoding="utf-8") as f:
            yaml.dump({"version": 1, "novelty_at_seed": novelty,
                       "anti_patterns": anti_patterns}, f, default_flow_style=False, allow_unicode=True)


def write_harness_profile(output_dir: Path, task: dict, profile: dict,
                          active_artifacts: list) -> None:
    """写 harness-profile.yaml：运行时契约 + 向后兼容标记（问题1与问题2的统一锚点）。

    结构生成时定（tier/factors/active_artifacts/context_budget），
    激活运行时调（phase-activation 读此文件），EVOLVE 在此基础上复利。
    """
    import math
    S, C, N, K = profile["scope"], profile["criticality"], profile["novelty"], profile["coupling"]
    # 上下文预算公式：base 500 + S/N 增量
    context_budget = 500 + 100 * max(0, S - 2) + 150 * max(0, N - 2)
    # agent 拓扑估算（agent-factory 会写详细 topology，此处为概览）
    agent_count = 1 + math.ceil(S / 2) + 1  # planner + executors + verifier
    if C >= 4:
        agent_count += 1
    if K >= 3:
        agent_count += 1
    if N >= 3:
        agent_count += 1

    active_layers = sorted({str(a).split("/")[0] for a in active_artifacts})
    profile_data = {
        "version": 1,
        "generated_at": datetime.now().isoformat(),
        "tier": profile["tier"],
        "factors": {
            "scope": S, "criticality": C, "novelty": N, "coupling": K,
        },
        "active_layers": active_layers,
        "active_artifacts": [str(a) for a in active_artifacts],
        "context_budget": context_budget,
        "agent_topology": {"estimated_count": agent_count},
        "note": "Structure fixed at generation; activation tuned at runtime via phase-activation.",
    }
    with open(output_dir / "harness-profile.yaml", "w", encoding="utf-8") as f:
        yaml.dump(profile_data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def generate_evolution_genome(output_dir: Path, task: dict, template: dict) -> None:
    parsed = template.get("parsed", {})
    domain_constraints = parsed.get("constraints", [])

    constraints = [
        {"id": "C001", "rule": "every task must have acceptance criteria", "source": "initial design", "last_triggered": None, "trigger_count": 0},
        {"id": "C002", "rule": "no agent self-certifies", "source": "initial design", "last_triggered": None, "trigger_count": 0},
        {"id": "C003", "rule": "every mistake produces a new constraint", "source": "initial design", "last_triggered": None, "trigger_count": 0},
    ]
    for i, dc in enumerate(domain_constraints, 4):
        constraints.append({"id": f"C{i:03d}", "rule": dc, "source": f"domain template: {template.get('name', 'unknown')}", "last_triggered": None, "trigger_count": 0})

    domain_workflows = parsed.get("workflows", [])
    workflows = [{"id": "W001", "name": "base flow", "steps": ["define", "plan", "execute", "verify", "record"], "source": "initial design"}]
    for i, wf in enumerate(domain_workflows, 2):
        workflows.append({"id": f"W{i:03d}", "name": wf.get("name", "custom"), "steps": wf.get("steps", []), "source": f"domain template: {template.get('name', 'unknown')}"})

    genome = {
        "version": 1,
        "created_at": datetime.now().isoformat(),
        "last_evolved": None,
        "total_mutations": 0,
        "harness_genome": {
            "constraints": constraints,
            "workflows": workflows,
            "skills": [
                {"id": "S001", "name": "self-verify", "source": "initial design"},
                {"id": "S002", "name": "task-decompose", "source": "initial design"},
            ],
        },
        "agent_genome": {
            "topology_rules": ["always add verifier", "merge tightly coupled roles", "split when context exceeds budget"],
            "default_scope": {"max_context_lines": 60, "handoff_format": "structured YAML"},
        },
        "evolution_genome": {
            "fitness_weights": {
                "evidence_satisfaction_rate": 0.35,
                "loop_efficiency": 0.25,
                "root_cause_hit_rate": 0.2,
                "goal_drift_rate": 0.2,
            },
            "mutation_rate": 0.1,
            "selection_threshold": "fitness must improve or complexity must decrease",
            "safety_constraints": [
                "never remove verification layer",
                "never remove evolution system",
                "mutation rate <= 30%",
                "all mutations reversible",
            ],
        },
    }
    evo_dir = output_dir / "evolution"
    evo_dir.mkdir(parents=True, exist_ok=True)
    with open(evo_dir / "genome.yaml", "w", encoding="utf-8") as f:
        yaml.dump(genome, f, default_flow_style=False, allow_unicode=True)

    log = {"version": 1, "mutations": []}
    with open(evo_dir / "log.yaml", "w", encoding="utf-8") as f:
        yaml.dump(log, f, default_flow_style=False, allow_unicode=True)


def generate_format_validators(output_dir: Path) -> None:
    validators_dir = output_dir / "verification" / "format-validators"
    validators_dir.mkdir(parents=True, exist_ok=True)

    api_contract_schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "API Contract",
        "type": "object",
        "required": ["endpoint", "method", "request", "response"],
        "properties": {
            "endpoint": {"type": "string", "pattern": "^/"},
            "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH"]},
            "request": {"type": "object"},
            "response": {"type": "object", "required": ["status", "body"]},
            "auth_required": {"type": "boolean", "default": True},
        },
    }
    with open(validators_dir / "api-contract.schema.json", "w", encoding="utf-8") as f:
        json.dump(api_contract_schema, f, indent=2, ensure_ascii=False)

    config_schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "Config File",
        "type": "object",
        "required": ["version", "type"],
        "properties": {
            "version": {"type": "integer", "minimum": 1},
            "type": {"type": "string"},
            "description": {"type": "string"},
        },
    }
    with open(validators_dir / "config.schema.json", "w", encoding="utf-8") as f:
        json.dump(config_schema, f, indent=2, ensure_ascii=False)


def verify_completeness(output_dir: Path, profile: dict = None) -> dict:
    """检查每层 artifact 是否齐全。profile 提供时，被 gate 裁剪的文件不计为 missing。"""
    results = {}
    for layer, artifacts in LAYER_ARTIFACTS.items():
        layer_dir = output_dir / layer
        found = []
        missing = []
        for artifact in artifacts:
            # 被 gate 裁剪的文件不计为 missing（自适应规模，非缺陷）
            if profile is not None and not should_copy_artifact(layer, artifact, profile):
                continue
            if (layer_dir / artifact).exists():
                found.append(artifact)
            else:
                missing.append(artifact)
        results[layer] = {
            "description": LAYER_DIRS[layer],
            "found": found,
            "missing": missing,
            "complete": len(missing) == 0,
        }
    return results


def print_verification(results: dict) -> bool:
    all_complete = True
    print("\n" + "=" * 60)
    print("GENERATION COMPLETENESS VERIFICATION")
    print("=" * 60)

    for layer, info in results.items():
        status = "✅ COMPLETE" if info["complete"] else "❌ INCOMPLETE"
        print(f"\n{info['description']} ({layer}/)")
        print(f"  Status: {status}")
        if info["found"]:
            print(f"  Found: {', '.join(info['found'])}")
        if info["missing"]:
            print(f"  Missing: {', '.join(info['missing'])}")
            all_complete = False

    print("\n" + "=" * 60)
    if all_complete:
        print("✅ ALL LAYERS COMPLETE — every layer has concrete artifacts")
    else:
        print("❌ SOME LAYERS INCOMPLETE — missing executable artifacts")
    print("=" * 60)
    return all_complete


def generate(task: dict, template_name: str, output_dir: Path) -> None:
    template = load_template(template_name)
    profile = compute_profile(task)
    print(f"Generating harness project: {output_dir}")
    print(f"Task: {task.get('name', 'unnamed')}")
    print(f"Template: {template_name}")
    print(f"Complexity: tier={profile['tier']} S={profile['scope']} "
          f"C={profile['criticality']} N={profile['novelty']} K={profile['coupling']}")
    print(f"Domain constraints from template: {len(template.get('parsed', {}).get('constraints', []))}")
    print(f"Domain workflows from template: {len(template.get('parsed', {}).get('workflows', []))}")

    if output_dir.exists():
        marker = output_dir / HARNESS_MARKER
        has_content = any(output_dir.iterdir())
        if has_content and not marker.exists():
            print(f"ERROR: Output directory exists but is not a harness-generated project: {output_dir}")
            print(f"       (no '{HARNESS_MARKER}' marker found). Refusing to delete a non-harness directory.")
            print(f"       To proceed, manually delete or move '{output_dir}' and re-run.")
            sys.exit(1)
        print(f"WARNING: Output directory exists, overwriting: {output_dir}")
        shutil.rmtree(output_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    # Write marker so future regenerations can safely identify this as a harness project.
    (output_dir / HARNESS_MARKER).write_text(
        "This directory was generated by meta-harness generate.py.\n", encoding="utf-8"
    )

    scripts_dir = output_dir / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)

    with open(output_dir / "task.yaml", "w", encoding="utf-8") as f:
        yaml.dump(task, f, default_flow_style=False, allow_unicode=True)

    src_dirs = _get_src_dirs(template_name)
    for src_dir in src_dirs:
        (output_dir / src_dir).mkdir(parents=True, exist_ok=True)
        (output_dir / src_dir / "__init__.py").write_text("", encoding="utf-8")

    orchestrator_seed = SEEDS_DIR / "orchestrator.py"
    if orchestrator_seed.exists():
        shutil.copy2(orchestrator_seed, output_dir / "orchestrator.py")

    guard_seed = SEEDS_DIR / "guard.py"
    if guard_seed.exists():
        shutil.copy2(guard_seed, output_dir / "guard.py")

    evolve_script = HARNESS_ROOT / "scripts" / "evolve.py"
    if evolve_script.exists():
        shutil.copy2(evolve_script, scripts_dir / "evolve.py")

    all_copied = []
    for layer in LAYER_DIRS:
        layer_dir = output_dir / layer
        layer_dir.mkdir(parents=True, exist_ok=True)
        copied = copy_seed_artifacts(output_dir, layer, profile)
        all_copied.extend(copied)
        if copied:
            print(f"  Copied {len(copied)} seed artifacts to {layer}/")

    customize_knowledge_index(output_dir, template)
    customize_architecture_rules(output_dir, template)
    customize_flow_control(output_dir, template)
    customize_sub_agent_dispatch(output_dir, template)
    customize_cost_budget(output_dir, template)

    generate_agents_md(output_dir, task, template)
    generate_session_state(output_dir, task)
    preseed_long_term(output_dir, profile, template_name)
    generate_evolution_genome(output_dir, task, template)
    generate_format_validators(output_dir)
    write_harness_profile(output_dir, task, profile, all_copied)

    meta_framework = HARNESS_ROOT / "evolution" / "framework.md"
    if meta_framework.exists():
        evo_dir = output_dir / "evolution"
        evo_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(meta_framework, evo_dir / "framework.md")

    innovation_seeds = SEEDS_DIR / "evolution"
    evo_output = output_dir / "evolution"
    evo_output.mkdir(parents=True, exist_ok=True)
    for seed_file in ["product-analyzer.py", "innovation-engine.py"]:
        src = innovation_seeds / seed_file
        if src.exists():
            shutil.copy2(src, evo_output / seed_file)

    domain_adv = SEEDS_DIR / "evolution" / f"domain-advancements-{template_name}.yaml"
    generic_adv = SEEDS_DIR / "evolution" / "domain-advancements.yaml"
    if domain_adv.exists():
        shutil.copy2(domain_adv, evo_output / "domain-advancements.yaml")
    elif generic_adv.exists():
        shutil.copy2(generic_adv, evo_output / "domain-advancements.yaml")

    results = verify_completeness(output_dir, profile)
    all_complete = print_verification(results)

    generation_log = {
        "timestamp": datetime.now().isoformat(),
        "task_name": task.get("name", "unnamed"),
        "template": template_name,
        "domain_constraints_applied": len(template.get("parsed", {}).get("constraints", [])),
        "domain_workflows_applied": len(template.get("parsed", {}).get("workflows", [])),
        "output_dir": str(output_dir),
        "completeness": {k: v["complete"] for k, v in results.items()},
        "all_complete": all_complete,
    }

    meta_log_dir = HARNESS_ROOT / "memory"
    meta_log_dir.mkdir(parents=True, exist_ok=True)
    log_file = meta_log_dir / "generation-log.yaml"
    existing_logs = []
    if log_file.exists():
        with open(log_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
            if data and "entries" in data:
                existing_logs = data["entries"]

    existing_logs.append(generation_log)
    with open(log_file, "w", encoding="utf-8") as f:
        yaml.dump({"entries": existing_logs}, f, default_flow_style=False, allow_unicode=True)

    if not all_complete:
        print("\n⚠️  Generation incomplete. Some layers are missing artifacts.")
        sys.exit(1)
    else:
        print(f"\n✅ Generation complete: {output_dir}")


def main():
    parser = argparse.ArgumentParser(description="Meta-Harness Generator")
    parser.add_argument("--task", required=True, help="Path to task definition file (YAML/JSON)")
    parser.add_argument("--template", default=None, help="Domain template name (auto-detected if not specified)")
    parser.add_argument("--output", default=None, help="Output directory (default: generated/<task-name>)")

    args = parser.parse_args()

    task_file = Path(args.task)
    task = load_task(task_file)

    template_name = args.template or detect_template(task)
    task_name = task.get("name", "unnamed").lower().replace(" ", "-")
    output_dir = Path(args.output) if args.output else HARNESS_ROOT / "generated" / task_name

    generate(task, template_name, output_dir)


if __name__ == "__main__":
    main()
