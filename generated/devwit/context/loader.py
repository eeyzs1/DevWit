#!/usr/bin/env python3
"""
Context Loader: Assembles relevant context per task (v2: four-function model).

第一性原理：知识库有四个正交职能，分别承载：
  - inject(task, profile):     主动注入 — 已知必需，静态预载
  - retrieve(task, profile):   被动检索 — 可能必需，多信号排序加载
  - active_constraints(profile): 约束    — gate 校验
  - recall(task, profile):     记忆     — 本项目过往

retrieve 用三信号加权排序（path-prefix + domain-tag + keyword overlap），
替代旧的布尔关键词匹配。零依赖、确定性、可单测。

Usage:
    python context/loader.py --task <task-card.yaml>
"""

import argparse
import re
import sys
from pathlib import Path

import yaml


def load_knowledge_index(project_root: Path) -> dict:
    """加载 knowledge-index.yaml，返回 mappings 字典（path → {description, tags}）。

    v1 兼容：若值为字符串（旧格式），自动包装为 {description: <str>, tags: []}。
    """
    index_file = project_root / "context" / "knowledge-index.yaml"
    if not index_file.exists():
        return {}
    with open(index_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    mappings = data.get("mappings", {}) or {}
    # v1 兼容：字符串值 → dict
    normalized = {}
    for path, val in mappings.items():
        if isinstance(val, str):
            normalized[path] = {"description": val, "tags": []}
        elif isinstance(val, dict):
            normalized[path] = {
                "description": val.get("description", ""),
                "tags": val.get("tags", []) or [],
            }
        else:
            normalized[path] = {"description": str(val), "tags": []}
    return normalized


def load_constraints(project_root: Path) -> list:
    rules_file = project_root / "constraints" / "architecture-rules.yaml"
    if not rules_file.exists():
        return []
    with open(rules_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return data.get("rules", [])


def load_workflows(project_root: Path) -> list:
    flow_file = project_root / "planning" / "flow-control.yaml"
    if not flow_file.exists():
        return []
    with open(flow_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return data.get("workflows", [])


def load_roles(project_root: Path) -> list:
    """加载 sub-agent-dispatch.yaml 的 roles（v2 优先 prototypes 实例化，回退 roles）。

    注意：完整的 prototype 实例化在 agent-factory.py 中完成。此处仅返回
    原型/角色清单供上下文展示，不做 count 求值。
    """
    dispatch_file = project_root / "planning" / "sub-agent-dispatch.yaml"
    if not dispatch_file.exists():
        return []
    with open(dispatch_file, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if data.get("prototypes"):
        return [{"name": k, **{kk: vv for kk, vv in v.items() if kk != "count"}}
                for k, v in data["prototypes"].items()]
    return data.get("roles", []) or []


def load_profile(project_root: Path) -> dict:
    """读 harness-profile.yaml 的 factors；回退默认（向后兼容旧项目）。"""
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
    return {"tier": "standard", "scope": 3, "criticality": 3, "novelty": 3, "coupling": 3}


# 停用词表：过滤虚词/常见动词，避免 keyword overlap 信号被无意义词污染。
STOP_WORDS = {
    # 英文虚词/代词/助动词
    "a", "an", "the", "and", "or", "but", "for", "to", "of", "in", "on", "with",
    "from", "by", "at", "is", "are", "was", "were", "be", "been", "being",
    "i", "we", "you", "they", "my", "our", "your", "this", "that", "it", "its",
    "as", "so", "do", "does", "did", "will", "would", "can", "could", "should",
    "must", "need", "needs", "build", "building", "using", "use", "used",
    "into", "via", "per", "than", "then", "when", "where", "which", "who",
    # 中文虚词
    "的", "了", "和", "与", "及", "或", "在", "为", "是", "我", "我们",
    "你", "你们", "他", "她", "它", "这", "那", "个", "些", "等", "以及",
}


def _task_keywords(task: dict) -> set:
    """提取 task 卡片的关键词集合（已过滤停用词与标点）。"""
    keywords = set()
    for field in ["name", "domain", "real_need", "goal"]:
        val = task.get(field, "")
        if val:
            tokens = re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]+", str(val).lower())
            keywords.update(t for t in tokens if t not in STOP_WORDS)
    return keywords


def _task_paths(task: dict) -> list:
    """提取 task 涉及的路径前缀线索（从 real_need/goal 中识别 src/ 等前缀）。"""
    text = " ".join(str(task.get(f, "")) for f in ["real_need", "goal", "name"]).lower()
    # 识别常见路径前缀模式
    return re.findall(r"(src/\w+|tests?/|config/|schemas?/|api/|components/|services?/)", text)


# --- 四职能 ---

def inject(task: dict, project_root: Path, profile: dict) -> list:
    """主动注入：已知必需的上下文，静态预载。

    高 C 项目注入安全/验证约束；高 N 项目注入 long-term 已知模式。
    返回注入项列表。
    """
    injected = []
    # 高 Novelty：注入 long-term 已知模式（预填的 known-patterns）
    if profile.get("novelty", 3) >= 3:
        for fname in ["known-patterns.yaml", "anti-patterns.yaml"]:
            f = project_root / "memory" / "long-term" / fname
            if f.exists():
                with open(f, "r", encoding="utf-8") as fh:
                    injected.append({"source": f"memory/long-term/{fname}",
                                     "kind": "preseeded_knowledge",
                                     "data": yaml.safe_load(fh) or {}})
    return injected


def retrieve(task: dict, knowledge_index: dict, profile: dict) -> list:
    """被动检索：可能必需的知识，多信号加权排序加载。

    三信号（从强到弱）：
      1. path-prefix（确定性最强）：task 涉及路径前缀匹配 mapping 的 path
      2. domain-tag（受控词表）：task 关键词命中 mapping 的 tags
      3. keyword overlap（最弱）：task 关键词与 description 词重叠
    返回按分排序的列表，非布尔过滤。
    """
    task_kws = _task_keywords(task)
    task_paths = _task_paths(task)
    results = []

    for path, info in knowledge_index.items():
        description = info.get("description", "")
        tags = set(t.lower() for t in info.get("tags", []) or [])
        desc_words = set(description.lower().split())

        score = 0
        # 信号1: path-prefix 匹配（+3，最强）
        for tp in task_paths:
            if tp in path or path.startswith(tp):
                score += 3
                break
        # 信号2: domain-tag 匹配（+2，受控词表）
        if task_kws & tags:
            score += 2
        # 信号3: keyword overlap（+1/命中词，最弱）
        overlap = task_kws & desc_words
        score += min(2, len(overlap))

        if score > 0:
            results.append({"path": path, "description": description,
                            "tags": sorted(tags), "score": score})

    # 按分降序排序
    results.sort(key=lambda r: r["score"], reverse=True)
    return results


def active_constraints(project_root: Path, profile: dict) -> list:
    """约束职能：加载 gate 校验用的规则。"""
    return load_constraints(project_root)


def recall(task: dict, project_root: Path, profile: dict) -> list:
    """记忆职能：本项目过往的 session-state 与 evolution log。"""
    recalled = []
    state_file = project_root / "memory" / "session-state.yaml"
    if state_file.exists():
        with open(state_file, "r", encoding="utf-8") as f:
            recalled.append({"source": "memory/session-state.yaml",
                             "kind": "session_state",
                             "data": yaml.safe_load(f) or {}})
    log_file = project_root / "evolution" / "log.yaml"
    if log_file.exists():
        with open(log_file, "r", encoding="utf-8") as f:
            recalled.append({"source": "evolution/log.yaml",
                             "kind": "evolution_history",
                             "data": yaml.safe_load(f) or {}})
    return recalled


def assemble_context(task: dict, project_root: Path) -> dict:
    """组装完整上下文：调用四职能，显式标注来源。"""
    profile = load_profile(project_root)
    knowledge_index = load_knowledge_index(project_root)
    workflows = load_workflows(project_root)
    roles = load_roles(project_root)

    return {
        "task_name": task.get("name", "unknown"),
        "complexity_profile": profile,
        "injected": inject(task, project_root, profile),
        "retrieved": retrieve(task, knowledge_index, profile),
        "active_constraints": active_constraints(project_root, profile),
        "recalled": recall(task, project_root, profile),
        "active_workflows": workflows,
        "available_roles": roles,
        "project_root": str(project_root),
    }


def main():
    parser = argparse.ArgumentParser(description="Context Loader (v2: four-function)")
    parser.add_argument("--task", required=True, help="Path to task card YAML")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    args = parser.parse_args()

    task_file = Path(args.task)
    if not task_file.exists():
        print(f"ERROR: Task file not found: {task_file}")
        sys.exit(1)

    with open(task_file, "r", encoding="utf-8") as f:
        task = yaml.safe_load(f) or {}

    project_root = Path(args.project_root).resolve()
    context = assemble_context(task, project_root)

    print(yaml.dump(context, default_flow_style=False, allow_unicode=True, sort_keys=False))


if __name__ == "__main__":
    main()
