#!/usr/bin/env python3
"""
Leaf Prepare — 从 work-unit + prototype 生成 task.json（domain-agnostic 通用原语）

supervisor 在派发 leaf helper 前调用本脚本，把：
  - planning/work-units.yaml 里的 work_unit（id/name/success_criteria）
  - planning/sub-agent-dispatch.yaml 里的 prototype（responsibilities/boundaries）
  - planning/agent-protocol.yaml 里的 role/gate 配置
合成一份 leaf protocol task.json，给 leaf helper 读。

为什么需要单独的 prepare 脚本：
  - leaf helper 不直接读 session-state/work-units——它只读 task.json（最小上下文）
  - prepare 把 dispatcher 的 task card + prototype 边界合并成 leaf 可执行的指令
  - 与 leaf_record.py 配对：prepare = 输入合成，record = 输出转 events

工作流：
  supervisor → leaf_prepare → task.json → adapter(Codex/Cursor) → result.json → leaf_record → events

退出码：0 = task.json 写好；1 = 输入缺失 / schema 错

Usage:
  python runtime/leaf_prepare.py \\
      --project-root . \\
      --workitem-id CCTT-123 \\
      --work-unit-id WU001 \\
      --prototype explorer \\
      --gate pre-implement \\
      --worktree-path /path/to/wt \\
      --out task.json
"""

import argparse
import json
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 复用 leaf_protocol 的 schema 与 write_task
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from leaf_protocol import write_task, validate_task
except ImportError:
    # 兜底：相对路径
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "leaf_protocol", Path(__file__).resolve().parent / "leaf_protocol.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    write_task = mod.write_task
    validate_task = mod.validate_task


def load_yaml(path: Path):
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"_parse_error": str(e)}


def find_work_unit(wu_data: dict, wu_id: str) -> dict:
    units = (wu_data or {}).get("work_units") or (wu_data or {}).get("units") or []
    for u in units:
        if isinstance(u, dict) and u.get("id") == wu_id:
            return u
    return {}


def find_prototype(proto_data: dict, proto_name: str) -> dict:
    protos = (proto_data or {}).get("prototypes") or {}
    return protos.get(proto_name, {})


def find_protocol_config(proto_cfg: dict, role: str) -> dict:
    """从 agent-protocol.yaml 找 role 的 gate/forbidden_side_effects 配置。"""
    roles = (proto_cfg or {}).get("roles") or {}
    return roles.get(role, {})


def prepare_task(project_root: Path, workitem_id: str, work_unit_id: str,
                 prototype: str, gate: str, worktree_path: str,
                 out_path: Path) -> dict:
    """从 work-unit + prototype + protocol-config 合成 task.json。"""
    wu_file = project_root / "planning" / "work-units.yaml"
    proto_file = project_root / "planning" / "sub-agent-dispatch.yaml"
    protocol_file = project_root / "planning" / "agent-protocol.yaml"

    wu_data = load_yaml(wu_file)
    proto_data = load_yaml(proto_file)
    protocol_data = load_yaml(protocol_file)

    wu = find_work_unit(wu_data, work_unit_id)
    proto = find_prototype(proto_data, prototype)
    proto_cfg = find_protocol_config(protocol_data, prototype)

    if not wu:
        raise ValueError(f"work_unit {work_unit_id} not in work-units.yaml")
    if not proto:
        raise ValueError(f"prototype {prototype} not in sub-agent-dispatch.yaml")

    # 合成 objective：work_unit.name + success_criteria
    obj_parts = [f"[{work_unit_id}] {wu.get('name', '')}"]
    sc = wu.get("success_criteria") or []
    if sc:
        obj_parts.append("Success criteria:")
        for s in sc:
            obj_parts.append(f"  - {s}")
    objective = "\n".join(obj_parts)

    # 合成 allowed_files / forbidden_files：prototype.receives / boundaries.cannot
    receives = proto.get("receives") or []
    cannot = proto.get("boundaries", {}).get("cannot") or []
    protocol_forbidden = proto_cfg.get("forbidden_side_effects") or []

    # 合成 forbidden_side_effects：prototype.cannot + protocol_config + work_unit.constraints
    wu_constraints = wu.get("constraints") or []
    forbidden_side_effects = list(set(cannot + protocol_forbidden))

    task = write_task(
        out_path=out_path,
        role=prototype,
        gate=gate,
        objective=objective,
        scope={
            "workitem_id": workitem_id,
            "branch": f"feature/{workitem_id}",
            "worktree_path": worktree_path,
            "allowed_files": receives,
            "forbidden_files": [],  # 由 protocol_config 派生（如 audit_log.yaml）
        },
        constraints={
            "forbidden_side_effects": forbidden_side_effects,
            "max_context_lines": proto.get("boundaries", {}).get("max_context_lines", 5000),
            "timeout_seconds": proto_cfg.get("timeout_seconds", 600),
            "architecture_rules": wu_constraints,
        },
        expected_output={
            "format": "result.json",
            "required_fields": ["verdict", "findings", "evidence", "changed_files"],
        },
        task_card_ref=f"planning/dispatch-plan.yaml#{work_unit_id}",
    )
    return task


def main():
    ap = argparse.ArgumentParser(description="Prepare leaf task.json from work-unit + prototype")
    ap.add_argument("--project-root", required=True)
    ap.add_argument("--workitem-id", required=True)
    ap.add_argument("--work-unit-id", required=True)
    ap.add_argument("--prototype", required=True)
    ap.add_argument("--gate", required=True)
    ap.add_argument("--worktree-path", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    task = prepare_task(
        Path(args.project_root), args.workitem_id, args.work_unit_id,
        args.prototype, args.gate, args.worktree_path, Path(args.out),
    )
    print(yaml.dump(task, default_flow_style=False, allow_unicode=True))


if __name__ == "__main__":
    main()
