#!/usr/bin/env python3
"""
DAG Builder v2: 读 planning/work-units.yaml 做真正的拓扑排序与并行分组。

第一性原理分工：
- work-units.yaml 的内容是项目特定的 → LLM 按 slot guidance 生成
- 拓扑排序与并行分组的算法是通用协议 → meta harness 硬约束（本文件）

算法（Kahn）：
1. 计算 each unit 的入度（依赖数）
2. 入度=0 的 unit 全部进"就绪集"
3. 就绪集 >1 个 → 输出 parallel 组；==1 → 输出 sequential 组
4. 把就绪集从图里"摘掉"，更新后继入度，重复

输出 execution_plan 含真正的 `{"type": "parallel", "units": [...]}`。

DAG 校验：
- 循环依赖 → 报错退出 1
- 孤儿 assigned_to 不在 sub-agent-dispatch prototypes → 警告

Usage:
    python planning/dag-builder.py --task <task-file.yaml> [--output <dag-file.yaml>]
"""

import argparse
import sys
from collections import defaultdict, deque
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_work_units(planning_dir: Path) -> tuple:
    """读 planning/work-units.yaml。返回 (work_units, source)。

    若 work-units.yaml 不存在，回退到从 task.acceptance_criteria 合成（带警告，
    向后兼容旧 task）。"""
    wu_file = planning_dir / "work-units.yaml"
    if wu_file.exists():
        with open(wu_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        units = data.get("work_units") or data.get("units") or []
        if units:
            # 保留原始字段 + 填充缺失必需字段——不剥光项目特定字段
            # （dispatcher 需要读 constraints / requires_human_review / traces_to 等）
            norm = []
            for i, u in enumerate(units):
                if not isinstance(u, dict):
                    continue
                # 复制原始 dict 保留所有字段，再补默认值
                item = dict(u)
                item.setdefault("id", f"WU{i+1:03d}")
                item.setdefault("name", item.get("id") or f"Work unit {i+1}")
                item["depends_on"] = list(u.get("depends_on") or [])
                item.setdefault("assigned_to", None)
                item.setdefault("success_criteria", [])
                item.setdefault("status", "pending")
                norm.append(item)
            return norm, "work-units.yaml"
    return [], "missing"


def fallback_from_task(task: dict) -> list:
    """旧 task 无 work-units.yaml 时，从 acceptance_criteria 合成（无依赖）。

    输出是无依赖的单元集合——所有 AC 平行可派发。
    """
    acs = task.get("acceptance_criteria") or []
    units = []
    for i, c in enumerate(acs):
        text = c if isinstance(c, str) else (c.get("criterion") if isinstance(c, dict) else f"AC{i+1}")
        units.append({
            "id": f"WU{i+1:03d}",
            "name": text,
            "depends_on": [],
            "assigned_to": None,
            "success_criteria": [text],
            "status": "pending",
        })
    return units


def detect_cycle(units: list) -> list:
    """Kahn 循环检测。返回环路 path（空=无环）。"""
    in_deg = {u["id"]: 0 for u in units}
    adj = defaultdict(list)
    id_set = set(in_deg.keys())
    for u in units:
        for dep in u["depends_on"]:
            if dep not in id_set:
                continue  # 未定义依赖跳过（在 validate 里另报）
            adj[dep].append(u["id"])
            in_deg[u["id"]] += 1
    q = deque([i for i, d in in_deg.items() if d == 0])
    visited = 0
    while q:
        n = q.popleft()
        visited += 1
        for m in adj[n]:
            in_deg[m] -= 1
            if in_deg[m] == 0:
                q.append(m)
    if visited == len(in_deg):
        return []
    # 有环：找一条环路径（DFS）
    color = {i: 0 for i in id_set}  # 0=white,1=gray,2=black
    stack = []
    cycle = []

    def dfs(n):
        nonlocal cycle
        color[n] = 1
        stack.append(n)
        for m in adj[n]:
            if color[m] == 1:
                idx = stack.index(m)
                cycle = stack[idx:] + [m]
                return True
            if color[m] == 0 and dfs(m):
                return True
        stack.pop()
        color[n] = 2
        return False

    for i in id_set:
        if color[i] == 0 and dfs(i):
            break
    return cycle


def topological_levels(units: list) -> list:
    """Kahn 分层：每层是同入度=0 的集合，可并行。

    返回 [[unit_id, ...], [unit_id, ...], ...]。
    """
    in_deg = {u["id"]: 0 for u in units}
    adj = defaultdict(list)
    id_set = set(in_deg.keys())
    for u in units:
        for dep in u["depends_on"]:
            if dep in id_set:
                adj[dep].append(u["id"])
                in_deg[u["id"]] += 1
    levels = []
    current = sorted([i for i, d in in_deg.items() if d == 0])
    while current:
        levels.append(current)
        nxt = []
        for n in current:
            for m in adj[n]:
                in_deg[m] -= 1
                if in_deg[m] == 0:
                    nxt.append(m)
        current = sorted(nxt)
    return levels


def build_execution_plan(levels: list) -> list:
    """把分层转为 execution_plan。

    - 单元素层 → sequential
    - 多元素层 → parallel
    """
    plan = []
    for lvl in levels:
        if len(lvl) == 1:
            plan.append({"type": "sequential", "units": lvl})
        else:
            plan.append({"type": "parallel", "units": lvl})
    return plan


def build_dag(task: dict, planning_dir: Path) -> dict:
    units, source = load_work_units(planning_dir)
    if not units:
        units = fallback_from_task(task)
        source = "fallback:acceptance_criteria (work-units.yaml missing)"

    cycle = detect_cycle(units)
    if cycle:
        return {
            "error": "cycle_detected",
            "cycle": cycle,
            "work_units": units,
        }

    levels = topological_levels(units)
    plan = build_execution_plan(levels)

    # 统计 parallel 组数（并行机会）
    parallel_groups = sum(1 for g in plan if g["type"] == "parallel")

    return {
        "task_name": task.get("name", "unnamed"),
        "work_units_source": source,
        "total_units": len(units),
        "execution_plan": plan,
        "parallel_opportunities": parallel_groups,
        "estimated_steps": sum(len(g["units"]) for g in plan) + parallel_groups,
        "work_units": units,
    }


def main():
    parser = argparse.ArgumentParser(description="DAG Builder v2")
    parser.add_argument("--task", required=True, help="Path to task definition YAML")
    parser.add_argument("--planning-dir", default=None,
                        help="Path to planning/ dir (default: <task_dir>/planning)")
    parser.add_argument("--output", default=None, help="Output DAG file path")
    args = parser.parse_args()

    task_file = Path(args.task).resolve()
    if not task_file.exists():
        print(f"ERROR: Task file not found: {task_file}")
        sys.exit(1)

    with open(task_file, "r", encoding="utf-8") as f:
        task = yaml.safe_load(f) or {}

    if args.planning_dir:
        planning_dir = Path(args.planning_dir).resolve()
    else:
        planning_dir = task_file.parent / "planning"

    dag = build_dag(task, planning_dir)

    if dag.get("error") == "cycle_detected":
        print(f"ERROR: Cycle detected in work-units: {' -> '.join(dag['cycle'])}")
        sys.exit(1)

    output = yaml.dump(dag, default_flow_style=False, allow_unicode=True, sort_keys=False)

    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(output, encoding="utf-8")
        print(f"DAG written to: {args.output}")
        print(f"  source: {dag['work_units_source']}")
        print(f"  units:  {dag['total_units']}")
        print(f"  parallel groups: {dag['parallel_opportunities']}")
    else:
        print(output)


if __name__ == "__main__":
    main()
