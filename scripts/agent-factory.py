#!/usr/bin/env python3
"""
Meta-Agent-Factory: Generated Harness → Specialized Agent Configurations

Reads a generated harness project (task.yaml, planning/sub-agent-dispatch.yaml,
planning/flow-control.yaml) and emits one YAML configuration per role plus a
topology summary. This implements the FACTORY phase of the meta-harness pipeline.

Each agent is a specialist with a specific ROLE, TOOLS, SCOPE, and BOUNDARIES.
Agents are wired together by their produces/receives handoffs into a parallel
and sequential topology.

Usage:
    python scripts/agent-factory.py --project-root <generated-project-dir>
    python scripts/agent-factory.py --project-root generated/my-project --dry-run
"""

import argparse
import math
import re
import sys
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HARNESS_ROOT = Path(__file__).resolve().parent.parent

# Category keyword sets used to classify roles (by responsibilities) and
# workflows (by step names) so they can be matched to each other.
CATEGORY_KEYWORDS = {
    "planning": {
        "design", "define", "plan", "decompose", "architect", "specify",
        "spec", "specs", "contract", "contracts", "structure",
    },
    "execution": {
        "implement", "build", "write", "code", "fix", "develop",
        "construct",
    },
    "verification": {
        "test", "verify", "review", "check", "validate", "audit",
        "inspect", "consistency",
    },
}

STOP_WORDS = {
    "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "is",
    "are", "be", "with", "by", "from", "into", "that", "this", "it",
}

# Fixed scope/boundary defaults shared by every generated agent.
DEFAULT_CAN_EXECUTE = ["python orchestrator.py --verify", "python guard.py --check"]
DEFAULT_CANNOT = ["access other agents' internal state", "skip verification", "self-certify"]
DEFAULT_MAX_CONTEXT_LINES = 500
SELF_CHECK = "Run verification before marking complete"
EXTERNAL_CHECK = "orchestrator.py --verify must pass"


def tokenize(text):
    """Lowercase a string into a set of meaningful word tokens."""
    if not text:
        return set()
    tokens = re.findall(r"[a-z]+", text.lower())
    return {t for t in tokens if len(t) > 2 and t not in STOP_WORDS}


def classify_categories(tokens):
    """Return the set of categories whose keywords overlap with the tokens."""
    return {cat for cat, kws in CATEGORY_KEYWORDS.items() if tokens & kws}


def criterion_text(criterion):
    """Normalize an acceptance criterion entry to a string for matching."""
    if isinstance(criterion, dict):
        return criterion.get("description") or criterion.get("text") or str(criterion)
    return str(criterion)


def sanitize_filename(name):
    """Make a role name safe to use as a file name."""
    cleaned = re.sub(r"[^a-zA-Z0-9._-]", "-", str(name)).strip("-")
    return cleaned or "agent"


def load_yaml(path, required=True):
    """Load a YAML file, exiting on missing required files."""
    if not path.exists():
        if required:
            print(f"ERROR: Required file not found: {path}")
            sys.exit(1)
        print(f"WARNING: Optional file not found: {path} (continuing with defaults)")
        return None
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


# --- 复杂度驱动的 agent 拓扑（第一性原理：agent 数来自 S，非 seed 复制）---

def _eval_factor_expr(expr, profile):
    """评估因子谓词（condition）或公式（count）。expr 是配置内常量，eval 可接受。

    返回 bool（condition）或 int/数值（count）。
    """
    if isinstance(expr, int):
        return expr
    env = {
        "tier": profile.get("tier", "standard"),
        "S": profile.get("scope", 3),
        "C": profile.get("criticality", 3),
        "N": profile.get("novelty", 3),
        "K": profile.get("coupling", 3),
        "ceil": math.ceil, "max": max, "min": min,
    }
    try:
        return eval(str(expr), {"__builtins__": {}}, env)
    except Exception:
        # 谓词（含比较符）解析失败默认 False；公式默认 1
        return False if any(c in str(expr) for c in "><=") else 1


def load_profile(project_root: Path) -> dict:
    """读 harness-profile.yaml 的 factors；回退 task.yaml 的 complexity；再回退默认。"""
    profile_file = project_root / "harness-profile.yaml"
    if profile_file.exists():
        with open(profile_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        factors = data.get("factors", {}) or {}
        return {
            "tier": data.get("tier", "standard"),
            "scope": factors.get("scope", 3),
            "criticality": factors.get("criticality", 3),
            "novelty": factors.get("novelty", 3),
            "coupling": factors.get("coupling", 3),
        }
    task = load_yaml(project_root / "task.yaml", required=False) or {}
    cx = task.get("complexity") or {}
    return {
        "tier": cx.get("tier", "standard"),
        "scope": cx.get("scope", 3),
        "criticality": cx.get("criticality", 3),
        "novelty": cx.get("novelty", 3),
        "coupling": cx.get("coupling", 3),
    }


def derive_roles(dispatch: dict, profile: dict) -> list:
    """从 prototypes + profile 实例化 roles。无 prototypes 时回退 roles（向后兼容）。

    第一性原理：agent 数应从 Scope 推导（planner×1 + executor×⌈S/2⌉ + verifier×1），
    附加角色由 C/K/N 门控，而非 seed 复制的固定 3 角色。
    """
    prototypes = (dispatch or {}).get("prototypes")
    if not prototypes:
        # 回退旧格式：直接返回 roles
        return list((dispatch or {}).get("roles", []) or [])

    roles = []
    for proto_name, proto in prototypes.items():
        # 评估 condition 门控
        condition = proto.get("condition")
        if condition and not _eval_factor_expr(condition, profile):
            continue
        # 求值 count（整数或公式字符串如 "ceil(S/2)"）
        count = proto.get("count", 1)
        if isinstance(count, str):
            count = _eval_factor_expr(count, profile)
        count = max(1, int(count))
        # 保留 LLM 在 prototype 里声明的 boundaries / requires_human_review
        # （不要丢给硬编码默认——dispatcher 与 task card 需要这些）
        boundaries = dict(proto.get("boundaries") or {})
        for i in range(count):
            name = proto_name if count == 1 else f"{proto_name}-{i}"
            roles.append({
                "name": name,
                "prototype_name": proto_name,  # 用于匹配 work-units.assigned_to
                "responsibilities": list(proto.get("responsibilities", []) or []),
                "receives": list(proto.get("receives", []) or []),
                "produces": list(proto.get("produces", []) or []),
                "boundaries": dict(boundaries),  # LLM-authored
                "requires_human_review": bool(proto.get("requires_human_review", False)),
            })
    return roles


def compute_context_budget(profile: dict) -> int:
    """上下文预算 = 500 + 100×max(0,S-2) + 150×max(0,N-2)。

    S 驱动（更多关注点需更多上下文）+ N 驱动（更高新颖需更多领域上下文）。
    """
    S = profile.get("scope", 3)
    N = profile.get("novelty", 3)
    return 500 + 100 * max(0, S - 2) + 150 * max(0, N - 2)


def extract_workflow_step_names(workflow):
    """Pull step names out of a workflow definition (list of dicts or strings)."""
    if not isinstance(workflow, dict):
        return []
    steps = workflow.get("steps", []) or []
    names = []
    for step in steps:
        if isinstance(step, dict):
            name = step.get("name", "")
        else:
            name = str(step)
        if name:
            names.append(name)
    return names


def role_tokens(role):
    """Tokenize a role's responsibilities into a single token set."""
    tokens = set()
    for resp in role.get("responsibilities", []) or []:
        tokens |= tokenize(resp)
    return tokens


def assign_workflows(roles, workflows):
    """Match roles to workflows by shared category or direct keyword overlap.

    A planner role gets workflows with design/define/plan steps; an executor
    gets implement/build steps; a verifier gets test/verify/review steps.
    """
    role_entries = []
    for role in roles:
        tokens = role_tokens(role)
        role_entries.append({
            "name": role.get("name", ""),
            "tokens": tokens,
            "cats": classify_categories(tokens),
        })

    wf_entries = {}
    for wf_name, wf in (workflows or {}).items():
        step_names = extract_workflow_step_names(wf)
        step_tokens = set()
        for s in step_names:
            step_tokens |= tokenize(s)
        wf_entries[wf_name] = {
            "tokens": step_tokens,
            "cats": classify_categories(step_tokens),
        }

    assignments = {e["name"]: [] for e in role_entries}
    for entry in role_entries:
        for wf_name, wf_entry in wf_entries.items():
            matched = bool(entry["cats"] & wf_entry["cats"]) or bool(entry["tokens"] & wf_entry["tokens"])
            if matched:
                assignments[entry["name"]].append(wf_name)
    return assignments


def assign_criteria(roles, acceptance_criteria):
    """Distribute acceptance criteria across executor roles.

    One executor → it gets all criteria. Multiple executors → distribute by
    keyword matching between criteria text and role responsibilities. If no
    executor is detected, fall back to assigning all criteria to every role.

    Deprecated when work-units.yaml exists——优先用 derive_criteria_from_work_units
    （LLM 显式声明的 traces_to 比关键词匹配可靠）。
    """
    assignments = {role.get("name", ""): [] for role in roles}
    if not acceptance_criteria:
        return assignments

    executor_entries = []
    for role in roles:
        tokens = role_tokens(role)
        if "execution" in classify_categories(tokens):
            executor_entries.append({"name": role.get("name", ""), "tokens": tokens})

    if not executor_entries:
        # No executor detected: don't lose criteria — assign to all roles.
        for role in roles:
            assignments[role.get("name", "")] = list(acceptance_criteria)
        return assignments

    if len(executor_entries) == 1:
        assignments[executor_entries[0]["name"]] = list(acceptance_criteria)
        return assignments

    # Multiple executors: distribute each criterion to the best-matching one.
    for criterion in acceptance_criteria:
        crit_tokens = tokenize(criterion_text(criterion))
        best_name = None
        best_score = 0
        for entry in executor_entries:
            score = len(crit_tokens & entry["tokens"])
            if score > best_score:
                best_score = score
                best_name = entry["name"]
        if best_name is not None and best_score > 0:
            assignments[best_name].append(criterion)
        else:
            # No keyword match: assign to all executors so nothing is lost.
            for entry in executor_entries:
                assignments[entry["name"]].append(criterion)
    return assignments


def derive_criteria_from_work_units(roles, acceptance_criteria, project_root):
    """从 work-units.yaml 的 traces_to 派生每个 role 的 assigned_criteria。

    第一性原理：哪些 AC 分给哪个 agent 是语义决策 → LLM 在 work-units.yaml
    通过 traces_to 显式声明；agent-factory 只读，不推断。

    匹配规则：role.prototype_name == work_unit.assigned_to 时，把
    work_unit.traces_to 里的 AC id 映射到 task.acceptance_criteria 的 criterion。

    返回 (assignments, source)。source="work-units.yaml" 或 "fallback:keyword"。
    """
    import yaml as _yaml
    from pathlib import Path as _Path

    wu_file = project_root / "planning" / "work-units.yaml"
    if not wu_file.exists():
        # 没有 work-units.yaml → 调用方回退关键词匹配
        return None, "fallback:keyword"

    with open(wu_file, "r", encoding="utf-8") as f:
        wu_data = _yaml.safe_load(f) or {}
    units = wu_data.get("work_units") or wu_data.get("units") or []
    if not units:
        return None, "fallback:keyword"

    # 建 AC id → criterion 文本 的索引
    # task.acceptance_criteria 可能是字符串列表或 dict 列表（含 id/criterion 字段）
    ac_by_id = {}
    ac_list = []
    for i, c in enumerate(acceptance_criteria):
        if isinstance(c, dict):
            cid = c.get("id") or c.get("ac_id") or f"AC{i+1}"
            text = c.get("criterion") or c.get("text") or c.get("description") or ""
        else:
            cid = f"AC{i+1}"
            text = str(c)
        ac_by_id[cid] = c
        ac_list.append((cid, c))

    # 收集每个 prototype 的 traces_to AC 集合
    proto_to_ac_ids = {}
    invalid_traces = []  # traces_to 引用了非 AC id（如误用 AR id）的告警
    valid_ac_ids = set(ac_by_id.keys())
    for u in units:
        if not isinstance(u, dict):
            continue
        proto = u.get("assigned_to")
        if not proto:
            continue
        traces = u.get("traces_to") or []
        # 兼容字符串与列表
        if isinstance(traces, str):
            traces = [traces]
        # 校验 traces_to 引用合法性：必须是 AC id（AC1..ACn）
        for tid in traces:
            if tid not in valid_ac_ids:
                invalid_traces.append(
                    f"  work_unit {u.get('id','?')} (assigned_to={proto}) "
                    f"traces_to contains '{tid}' which is not a valid AC id "
                    f"(valid: {sorted(valid_ac_ids) or 'none'}); "
                    f"this trace will be silently dropped"
                )
        proto_to_ac_ids.setdefault(proto, set()).update(traces)

    if invalid_traces:
        print(f"WARNING: traces_to 引用了非 AC id（agent-factory.py 会静默丢弃）:")
        for msg in invalid_traces:
            print(msg)
        print("  提示：traces_to 应填 AC id（如 AC1, AC2...），不是 AR id；")
        print("        若 work_unit 实现架构约束但不直接 trace 到 AC，用空列表 []")

    assignments = {role.get("name", ""): [] for role in roles}
    for role in roles:
        rname = role.get("name", "")
        proto = role.get("prototype_name") or rname
        ac_ids = proto_to_ac_ids.get(proto, set())
        # 把 ac id 映射回原始 criterion 对象
        for cid, c in ac_list:
            if cid in ac_ids:
                assignments[rname].append(c)

    return assignments, "work-units.yaml"


def derive_workflows_from_work_units(roles, project_root):
    """从 work-units.yaml 的 workflow 字段派生每个 role 的 assigned_workflows。

    同 derive_criteria_from_work_units 模式：workflow→role 是 LLM 在 work-units
    显式声明的，agent-factory 不做关键词推断。

    返回 (assignments, source)。source="work-units.yaml" 或 "fallback:keyword"。
    """
    import yaml as _yaml
    from pathlib import Path as _Path

    wu_file = project_root / "planning" / "work-units.yaml"
    if not wu_file.exists():
        return None, "fallback:keyword"

    with open(wu_file, "r", encoding="utf-8") as f:
        wu_data = _yaml.safe_load(f) or {}
    units = wu_data.get("work_units") or wu_data.get("units") or []
    if not units:
        return None, "fallback:keyword"

    proto_to_workflows = {}
    for u in units:
        if not isinstance(u, dict):
            continue
        proto = u.get("assigned_to")
        wf = u.get("workflow")
        if not proto or not wf:
            continue
        proto_to_workflows.setdefault(proto, set()).add(wf)

    assignments = {role.get("name", ""): [] for role in roles}
    for role in roles:
        rname = role.get("name", "")
        proto = role.get("prototype_name") or rname
        wfs = proto_to_workflows.get(proto, set())
        assignments[rname] = sorted(wfs)

    return assignments, "work-units.yaml"


def build_agent_config(role, assigned_workflows, assigned_criteria, context_budget=None):
    """Build the per-role agent configuration dict."""
    responsibilities = list(role.get("responsibilities", []) or [])
    receives = list(role.get("receives", []) or [])
    produces = list(role.get("produces", []) or [])
    name = role.get("name", "unknown")

    # LLM-authored boundaries 优先；缺失时回退硬编码默认
    proto_boundaries = role.get("boundaries") or {}
    cannot = list(proto_boundaries.get("cannot") or DEFAULT_CANNOT)
    proto_max_ctx = proto_boundaries.get("max_context_lines")
    # prototype 显式声明 max_context_lines 时优先（LLM 知道该角色预算）；
    # 否则回退 compute_context_budget(S,N) 或 DEFAULT
    if proto_max_ctx is not None:
        budget = int(proto_max_ctx)
    elif context_budget is not None:
        budget = context_budget
    else:
        budget = DEFAULT_MAX_CONTEXT_LINES
    requires_human_review = bool(role.get("requires_human_review", False))

    role_desc = "; ".join(responsibilities) if responsibilities else f"{name} role"

    tools = [{"name": item, "access": "read"} for item in receives]
    tools += [{"name": item, "access": "write"} for item in produces]

    # Fresh list copies per field so PyYAML does not emit shared anchors/aliases
    # between scope and handoff (keeps the output flat and readable).
    return {
        "agent": {
            "name": name,
            "role": role_desc,
            "capabilities": list(responsibilities),
            "tools": tools,
            "scope": {
                "can_read": list(receives),
                "can_write": list(produces),
                "can_execute": list(DEFAULT_CAN_EXECUTE),
            },
            "boundaries": {
                "cannot": cannot,
                "max_context_lines": budget,
                "requires_human_review": requires_human_review,
            },
            "handoff": {
                "input_format": list(receives),
                "output_format": list(produces),
            },
            "verification": {
                "self_check": SELF_CHECK,
                "external_check": EXTERNAL_CHECK,
            },
            "assigned_workflows": list(assigned_workflows),
            "assigned_criteria": list(assigned_criteria),
        }
    }


def handoff_matches(produces_item, receives_item):
    """True if a produces item satisfies a receives item (exact then token overlap)."""
    if produces_item.strip().lower() == receives_item.strip().lower():
        return True
    return bool(tokenize(produces_item) & tokenize(receives_item))


def compute_topology(roles):
    """Derive parallel groups, sequential chain, and handoff points from produces/receives."""
    names = [role.get("name", f"agent{i}") for i, role in enumerate(roles)]

    # Dependency edges: B depends on A when A.produces matches B.receives.
    deps = {n: set() for n in names}
    handoff_points = []
    seen_handoffs = set()
    for a in roles:
        a_name = a.get("name", "")
        a_produces = a.get("produces", []) or []
        for b in roles:
            if a is b:
                continue
            b_name = b.get("name", "")
            b_receives = b.get("receives", []) or []
            for p in a_produces:
                for r in b_receives:
                    if handoff_matches(p, r):
                        key = (a_name, b_name, p)
                        if key not in seen_handoffs:
                            seen_handoffs.add(key)
                            handoff_points.append({"from": a_name, "to": b_name, "format": p})
                        deps[b_name].add(a_name)
                        break

    # Level-based topological sort: same-level roles have no mutual dependency
    # and can run in parallel.
    levels = {}
    remaining = set(names)
    current_level = 0
    while remaining:
        ready = [n for n in names if n in remaining and deps[n].isdisjoint(remaining)]
        if not ready:
            # Cycle: force the node with the fewest unresolved dependencies.
            ready = sorted(remaining, key=lambda n: len(deps[n] & remaining))[:1]
        for n in ready:
            levels[n] = current_level
            remaining.discard(n)
        current_level += 1

    max_level = max(levels.values()) if levels else -1
    parallel_groups = []
    sequential_chain = []
    for lvl in range(max_level + 1):
        group = [n for n in names if levels.get(n) == lvl]
        if group:
            parallel_groups.append(group)
            sequential_chain.extend(group)

    return {
        "topology": {
            "total_agents": len(roles),
            "roles": names,
            "parallel_groups": parallel_groups,
            "sequential_chain": sequential_chain,
            "handoff_points": handoff_points,
        }
    }


def print_summary(configs, project_root, dry_run):
    """Print the factory summary to stdout."""
    print()
    print("=" * 60)
    print(f"AGENT FACTORY — Generated {len(configs)} agent configurations")
    print("=" * 60)
    for rname, cfg in configs:
        agent = cfg.get("agent", {})
        n_wf = len(agent.get("assigned_workflows", []) or [])
        n_cr = len(agent.get("assigned_criteria", []) or [])
        print(f"  - {rname}: {n_wf} workflows, {n_cr} criteria assigned")
    configs_dir = project_root / "planning" / "agent-configs"
    topology_path = project_root / "planning" / "agent-topology.yaml"
    verb = "would be written to" if dry_run else "Configurations written to"
    print(f"{verb}: {configs_dir}")
    print(f"{'Would be written to' if dry_run else 'Topology written to'}: {topology_path}")
    print("=" * 60)


def run_factory(project_root, dry_run):
    """Read inputs, compute configs + topology, write outputs (unless dry-run)."""
    if not project_root.is_dir():
        print(f"ERROR: Project root does not exist or is not a directory: {project_root}")
        sys.exit(1)

    task = load_yaml(project_root / "task.yaml", required=True)
    dispatch = load_yaml(project_root / "planning" / "sub-agent-dispatch.yaml", required=True)
    flow = load_yaml(project_root / "planning" / "flow-control.yaml", required=False) or {}

    # 复杂度驱动：从 harness-profile/task.yaml 加载 profile，推导 roles 与上下文预算
    profile = load_profile(project_root)
    roles = derive_roles(dispatch, profile)
    context_budget = compute_context_budget(profile)
    if not roles:
        print("ERROR: No roles derived from sub-agent-dispatch.yaml (neither prototypes nor roles)")
        sys.exit(1)

    print(f"Complexity profile: tier={profile['tier']} S={profile['scope']} "
          f"C={profile['criticality']} N={profile['novelty']} K={profile['coupling']}")
    print(f"Derived {len(roles)} agent role(s); context_budget={context_budget}")

    workflows = flow.get("workflows", {}) or {}
    acceptance_criteria = task.get("acceptance_criteria", []) or []

    workflow_assignments = assign_workflows(roles, workflows)
    # 优先用 work-units.yaml 的显式 workflow 字段派生（LLM 声明的，不推断）
    wu_wf_result, wf_source = derive_workflows_from_work_units(roles, project_root)
    if wu_wf_result is not None:
        workflow_assignments = wu_wf_result
        print(f"Workflow assignment: source=work-units.yaml (LLM-declared workflow field)")
    else:
        print(f"Workflow assignment: source=keyword-match (fallback, no work-units.yaml)")
    # 优先用 work-units.yaml 的显式 traces_to 派生 criteria（LLM 声明的，不推断）
    # 没有 work-units.yaml 才回退到关键词匹配
    wu_result, criteria_source = derive_criteria_from_work_units(
        roles, acceptance_criteria, project_root)
    if wu_result is not None:
        criteria_assignments = wu_result
        print(f"Criteria assignment: source=work-units.yaml (LLM-declared traces_to)")
    else:
        criteria_assignments = assign_criteria(roles, acceptance_criteria)
        print(f"Criteria assignment: source=keyword-match (fallback, no work-units.yaml)")

    configs = []
    for role in roles:
        rname = role.get("name", "unknown")
        cfg = build_agent_config(
            role,
            workflow_assignments.get(rname, []),
            criteria_assignments.get(rname, []),
            context_budget=context_budget,
        )
        configs.append((rname, cfg))

    topology = compute_topology(roles)
    # 把 context_budget 写入 topology 供运行时读取
    topology["topology"]["context_budget"] = context_budget
    topology["topology"]["complexity_profile"] = profile

    print_summary(configs, project_root, dry_run)

    if dry_run:
        print("(dry-run: no files written)")
        return

    configs_dir = project_root / "planning" / "agent-configs"
    configs_dir.mkdir(parents=True, exist_ok=True)
    for rname, cfg in configs:
        out_path = configs_dir / f"{sanitize_filename(rname)}.yaml"
        with open(out_path, "w", encoding="utf-8") as f:
            yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    topology_path = project_root / "planning" / "agent-topology.yaml"
    with open(topology_path, "w", encoding="utf-8") as f:
        yaml.dump(topology, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def main():
    parser = argparse.ArgumentParser(
        description="Meta-Agent-Factory: generate specialized agent configs from a harness project"
    )
    parser.add_argument("--project-root", required=True, help="Path to a generated harness project")
    parser.add_argument("--dry-run", action="store_true", help="Propose configs without writing files")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    run_factory(project_root, args.dry_run)


if __name__ == "__main__":
    main()
