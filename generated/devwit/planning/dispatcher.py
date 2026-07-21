#!/usr/bin/env python3
"""
Dispatcher v1: 读 DAG + sub-agent-dispatch.yaml + work-units.yaml + task-card-schema，
按拓扑顺序生成派发指令（task card）给 runtime。

第一性原理分工：
- 算法（拓扑驱动派发 + task card 实例化）= 硬约束（本文件，所有项目共享）
- 派发的内容（哪些 work unit / agent / 边界）= LLM 在 work-units.yaml 与
  sub-agent-dispatch.yaml 里声明

不真的"调用" subagent：本 dispatcher 只输出 task card 列表（dispatch-plan.yaml），
由外层 runtime（Trae Task tool / Claude Code subagent / Cursor composer）按 plan 真正派发。
这样保持 harness 与具体 runtime 解耦——harness 给"剧本"，runtime 演"戏"。

Usage:
    python planning/dispatcher.py --project-root <generated-project>
    python planning/dispatcher.py --project-root generated/my-project --dry-run
"""

import argparse
import hashlib
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_yaml(path: Path, required: bool = True):
    if not path.exists():
        if required:
            print(f"ERROR: required file not found: {path}")
            sys.exit(1)
        return None
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_dag(project_root: Path) -> dict:
    """读 planning/dag.yaml（由 dag-builder.py 生成）。

    若不存在，调用 dag-builder 生成它。
    """
    dag_file = project_root / "planning" / "dag.yaml"
    if not dag_file.exists():
        # 内联调用 dag-builder
        import importlib.util
        dag_builder_path = project_root / "planning" / "dag-builder.py"
        if not dag_builder_path.exists():
            print(f"ERROR: dag-builder.py not found at {dag_builder_path}")
            sys.exit(1)
        spec = importlib.util.spec_from_file_location("dag_builder", dag_builder_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        task = load_yaml(project_root / "task.yaml")
        dag = mod.build_dag(task, project_root / "planning")
        if dag.get("error") == "cycle_detected":
            print(f"ERROR: cycle in work-units: {' -> '.join(dag['cycle'])}")
            sys.exit(1)
        return dag
    return load_yaml(dag_file)


def load_prototypes(project_root: Path) -> dict:
    """读 sub-agent-dispatch.yaml 的 prototypes dict。"""
    dispatch = load_yaml(project_root / "planning" / "sub-agent-dispatch.yaml")
    protos = dispatch.get("prototypes") or {}
    if not protos:
        print("ERROR: sub-agent-dispatch.yaml has no prototypes (v2 format required)")
        sys.exit(1)
    return protos


def load_budget(project_root: Path) -> dict:
    """读 planning/budget.yaml。"""
    return load_yaml(project_root / "planning" / "budget.yaml", required=False) or {}


def load_constraints_index(project_root: Path) -> dict:
    """读 constraints/architecture-rules.yaml，建 rule_id → rule_text 索引。"""
    ar = load_yaml(project_root / "constraints" / "architecture-rules.yaml",
                   required=False) or {}
    rules = {}
    for r in ar.get("rules", []) or []:
        rid = r.get("id")
        if rid:
            rules[rid] = {
                "rule_text": r.get("description") or "",
                # traces_to 已移除：architecture-rules 的 rule 项是约束（ARxxx），
                # 不直接 trace 到验收标准（ACx）；约束→AC 的追溯由 work-units.yaml
                # 的 traces_to 字段负责（每个 WU 声明它 trace 到哪些 AC）。
            }
    return rules


def find_work_unit(work_units: list, wu_id: str) -> dict:
    for u in work_units:
        if u.get("id") == wu_id:
            return u
    return {}


def build_task_card(wu: dict, proto: dict, constraints_index: dict,
                    budget: dict, task: dict, instance_seq: int = 1) -> dict:
    """按 task-card-schema.yaml 实例化一个 task card。

    LLM-authored 内容（wu / proto）→ 卡片字段；
    硬约束（schema 字段集）→ 不变。
    """
    wu_id = wu.get("id", "WU???")
    proto_name = wu.get("assigned_to") or "unknown"
    boundaries = proto.get("boundaries") or {}
    per_role_budget = (budget.get("per_role_budget") or {}).get(proto_name) or {}

    # 收集本 work_unit 关联的约束（按 wu.constraints 字段或 success_criteria 推导）
    wu_constraint_ids = wu.get("constraints") or []
    constraints_list = []
    for cid in wu_constraint_ids:
        if cid in constraints_index:
            constraints_list.append({
                "rule_id": cid,
                "rule_text": constraints_index[cid]["rule_text"],
                # traces_to 已移除（见 load_constraints_index 注释）
            })

    # 输入工件：从 prototype.receives + 上游 work_unit 标注
    inputs = []
    for r in proto.get("receives") or []:
        inputs.append({
            "path": r,
            "description": f"prototype.receives: {r}",
            "from_work_unit": None,  # dispatcher 不知道上游时为 None
        })

    # budget：per_role_budget 覆盖全局 budget
    merged_budget = {
        "max_steps": per_role_budget.get("max_steps") or budget.get("limits", {}).get("max_steps_per_task", 20),
        "max_tokens": per_role_budget.get("max_reasoning_tokens") or budget.get("limits", {}).get("max_tokens_per_step", 10000),
        "max_retries": budget.get("limits", {}).get("max_retries", 3),
    }

    return {
        "task_id": f"{wu_id}-{instance_seq:02d}",
        "work_unit_id": wu_id,
        "assigned_to": proto_name,
        "agent_role_description": "; ".join(proto.get("responsibilities") or []),
        "objective": wu.get("name") or wu_id,
        "context": {
            "can_read": list(proto.get("receives") or []),
            "can_write": list(proto.get("produces") or []),
            "cannot": list(boundaries.get("cannot") or []),
            "max_context_lines": boundaries.get("max_context_lines", 500),
        },
        "inputs": inputs,
        "success_criteria": wu.get("success_criteria") or [],
        "constraints": constraints_list,
        "requires_human_review": bool(proto.get("requires_human_review") or wu.get("requires_human_review")),
        "budget": merged_budget,
    }


def validate_card_against_prototype(card: dict, proto: dict, wu: dict) -> list:
    """硬约束校验：task card 是否忠实于 prototype + work_unit 声明。"""
    errs = []
    proto_name = card["assigned_to"]
    if not proto:
        errs.append(f"work_unit {wu['id']} assigned_to='{proto_name}' but no such prototype")
        return errs
    # success_criteria 必须非空
    if not card["success_criteria"]:
        errs.append(f"work_unit {wu['id']} has empty success_criteria——无法验证完成")
    # requires_human_review 一致性
    if wu.get("requires_human_review") and not proto.get("requires_human_review"):
        errs.append(f"work_unit {wu['id']} requires_human_review=true but prototype {proto_name} doesn't declare it")
    return errs


def build_dispatch_plan(project_root: Path) -> tuple:
    """返回 (dispatch_plan, errors)。"""
    dag = load_dag(project_root)
    protos = load_prototypes(project_root)
    budget = load_budget(project_root)
    constraints_index = load_constraints_index(project_root)
    task = load_yaml(project_root / "task.yaml")

    work_units = dag.get("work_units") or []
    execution_plan = dag.get("execution_plan") or []
    wu_by_id = {u["id"]: u for u in work_units}

    cards = []
    errors = []
    for group in execution_plan:
        for wu_id in group.get("units", []):
            wu = wu_by_id.get(wu_id, {})
            proto_name = wu.get("assigned_to")
            proto = protos.get(proto_name, {}) if proto_name else {}
            if not proto_name:
                errors.append(f"work_unit {wu_id} has no assigned_to——cannot dispatch")
                continue
            card = build_task_card(wu, proto, constraints_index, budget, task)
            errors.extend(validate_card_against_prototype(card, proto, wu))
            cards.append(card)

    plan = {
        "schema_version": 1,
        "task_name": dag.get("task_name") or task.get("name"),
        "work_units_source": dag.get("work_units_source"),
        "total_cards": len(cards),
        "parallel_opportunities": dag.get("parallel_opportunities", 0),
        "execution_plan": execution_plan,
        "task_cards": cards,
        # 卡片按 task_card-schema.yaml 的 input/output 协议——subagent 完成后
        # 写对应 output card 到 planning/dispatch-results/<task_id>.yaml，
        # 由 verifier 复核 status + self_check_evidence
        "output_dir": "planning/dispatch-results/",
    }
    return plan, errors


def main():
    parser = argparse.ArgumentParser(description="Dispatcher v1")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--output", default=None,
                        help="Output dispatch-plan.yaml path (default: <project>/planning/dispatch-plan.yaml)")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    plan, errors = build_dispatch_plan(project_root)

    print()
    print("=" * 60)
    print(f"DISPATCHER — Generated {plan['total_cards']} task cards")
    print(f"  source: {plan['work_units_source']}")
    print(f"  parallel groups: {plan['parallel_opportunities']}")
    print(f"  errors: {len(errors)}")
    print("=" * 60)

    # 按 execution_plan 顺序打印
    plan_summary = plan["execution_plan"]
    for i, group in enumerate(plan_summary):
        gtype = group.get("type", "?")
        units = group.get("units", [])
        marker = "||" if gtype == "parallel" else "->"
        print(f"  [{i+1}] {gtype}: {' '.join(marker)} {units}")

    if errors:
        print()
        for e in errors:
            print(f"  ERROR: {e}")

    if args.dry_run:
        print("\n(dry-run: no files written)")
        if errors:
            sys.exit(1)
        return

    out_path = Path(args.output) if args.output else (project_root / "planning" / "dispatch-plan.yaml")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        yaml.dump(plan, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    print(f"\nDispatch plan written to: {out_path}")
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
