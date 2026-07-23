#!/usr/bin/env python3
"""
Meta-Harness Scaffold Generator: Task → Empty Harness Skeleton + Slot Manifest

第一性原理：脚本只做确定性的事（建目录、复制通用原语、写 manifest），
项目特定的内容由 LLM 生成（见 meta/harness-author.md）。

脚本不再编码 domain 知识（旧的 customize_* 函数已移除）。
脚本的职责：
  1. 创建 7+2+evolution 目录结构
  2. 复制通用原语（与 domain 无关的可执行机器）
  3. 复制 slot 种子文件作为结构基线
  4. 计算 slot 基线哈希，写 harness-scaffold.yaml manifest
  5. LLM 按 manifest 填充 slot，validate-harness.py 校验

通用原语（domain-agnostic 可执行机器，原样复制）：
  context/loader.py, tools/tool-discovery.py, memory/snapshot.py,
  planning/dag-builder.py, verification/{self-check,consistency-check,
  anti-mock-check,quality-gate}.py, feedback/{error-capture,
  mistake-to-constraint}.py, constraints/entropy-reduction.py,
  evolution/{framework.md,innovation-engine.py,product-analyzer.py},
  guard.py, orchestrator.py

LLM 填充 slot（含项目特定内容，从 seed 基线改写）：
  context/knowledge-index.yaml, tools/{schemas,sandbox,permissions}.yaml,
  planning/{flow-control,sub-agent-dispatch,budget}.yaml,
  verification/security-guardrails.yaml,
  constraints/{architecture-rules,linter-config,cost-budget}.yaml,
  security/{sandbox-config,encryption-rules,audit-log}.yaml,
  observability/{tracing,metrics-dashboard,session-replay,versioning}.yaml,
  evolution/{genome,log,domain-advancements}.yaml

Usage:
    python scripts/scaffold.py --task <task.yaml> --output <dir>
"""

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SEEDS_DIR = Path(__file__).resolve().parent.parent / "seeds"
HARNESS_MARKER = ".harness-generated"

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
    "runtime": "Runtime: Multi-Worktree Orchestration",
    "docs": "Runtime: Documentation Contracts",
}

# 通用原语：domain-agnostic 可执行机器，原样复制，LLM 不改
UNIVERSAL_PRIMITIVES = {
    "context": ["loader.py"],
    "tools": ["tool-discovery.py"],
    "memory": ["snapshot.py"],
    "planning": ["dag-builder.py", "dispatcher.py", "task-card-schema.yaml"],
    "verification": ["self-check.py", "consistency-check.py", "anti-mock-check.py", "quality-gate.py",
                      "dispatch-verifier.py", "hook-executor.py", "runtime-hooks.yaml",
                      "audit-append.py", "lint-check.py"],
    "feedback": ["error-capture.py", "mistake-to-constraint.py"],
    "constraints": ["entropy-reduction.py"],
    "evolution": ["framework.md", "innovation-engine.py", "product-analyzer.py"],
    # Runtime layer: multi-worktree orchestration（v2.6+ 新增）
    # supervisor 调度多 worktree；worktree_lifecycle 管 worktree 资源；
    # leaf_protocol/prepare/record 是 leaf helper 的输入输出契约；
    # event_stream 是真相源；rebase_sync 是合并策略（rebase-only 默认）；
    # workitem_source 是抽象基类——具体 adapter 由 LLM 在 GENERATE 合成。
    "runtime": ["supervisor.py", "worktree_lifecycle.py", "leaf_protocol.py",
                "leaf_prepare.py", "leaf_record.py", "event_stream.py",
                "rebase_sync.py", "workitem_source.py"],
}

# 根级通用原语
ROOT_UNIVERSAL = ["guard.py", "orchestrator.py"]

# LLM 填充 slot：含项目特定内容，从 seed 基线改写
# 每条: (layer, filename, guidance)
LLM_SLOTS = [
    ("context", "knowledge-index.yaml",
     "分析 task 的组件结构，把 mappings 改为该项目的真实路径到知识域映射。每条带 description + tags。"),
    ("tools", "schemas.yaml",
     "分析 task 实际需要调用的工具（DB/HTTP/外部 API/协议），写出该项目的工具 schema 定义。"),
    ("tools", "sandbox.yaml",
     "按该项目实际执行的命令与网络访问需求，写沙箱配置。"),
    ("tools", "permissions.yaml",
     "按该项目 agent 角色（planner/executor/verifier 等），写每个角色的读写执行权限。"),
    ("memory", "session-state.yaml",
     "初始化会话状态：当前阶段、已完成/待办验收标准（从 task.acceptance_criteria 派生）。"),
    ("memory", "compression-rules.yaml",
     "按该项目该保留/压缩/遗忘的内容，写压缩规则。"),
    ("planning", "flow-control.yaml",
     "按该项目工作流（顺序/并行/条件/重试），写流控配置。"),
    ("planning", "work-units.yaml",
     "把 task 分解为可独立派发的工作单元。每条含 id/name/depends_on/assigned_to/success_constraints/success_criteria。depends_on 必须基于真实依赖（如下游用上游的产物）。assigned_to 必须引用 sub-agent-dispatch.yaml 里某个 prototype 名。dispatcher.py 读本文件做拓扑排序与并行分组，不要在这里硬塞顺序——只声明依赖关系即可。"),
    ("planning", "sub-agent-dispatch.yaml",
     "分析 task 的工作单元与依赖，合成 agent 拓扑（不要套用固定公式 ceil(S/2)）。每个 prototype 必须含 responsibilities/receives/produces/count/boundaries.cannot/boundaries.max_context_lines。需人工 review 的角色必须显式 requires_human_review: true。"),
    ("planning", "budget.yaml",
     "按该项目复杂度与风险，设置 reasoning step/token/retry 预算。"),
    ("verification", "security-guardrails.yaml",
     "分析 task 的数据流与敏感数据面，写 PII/secret 模式与危险操作拦截（针对该项目领域）。"),
    ("feedback", "retry-config.yaml",
     "按该项目可能的错误类型，写重试策略。"),
    ("feedback", "fixer-registry.yaml",
     "按该项目 retry-config 的 strategy，为可机械修复的错误类型绑定定向 fixer（match/handler/entry/safe）。通用 ruff_autofix 条目保留，项目特定 fixer 据 task.yaml + work-units + retry-config 推演追加，并在 feedback/fixers/ 生成实现。"),
    ("feedback", "human-interface.yaml",
     "按该项目人工 review 需求，写人机界面配置（何时暂停、如何呈现、谁 review）。仅在 C>=4 时生成。"),
    ("constraints", "architecture-rules.yaml",
     "分析 task 的组件依赖图，写依赖方向规则（allowed/forbidden）与架构约束——必须引用 task 里真实的组件/模块。"),
    ("constraints", "linter-config.yaml",
     "按该项目架构规则派生 lint 规则。"),
    ("constraints", "cost-budget.yaml",
     "按该项目实际资源约束（不是 web-app 默认值），写预算阈值。"),
    ("security", "sandbox-config.yaml",
     "按该项目隔离需求，写沙箱配置。"),
    ("security", "encryption-rules.yaml",
     "按该项目数据分类，写加密规则。"),
    ("security", "audit-log.yaml",
     "按该项目审计需求，写审计日志配置。"),
    ("observability", "tracing.yaml",
     "按该项目可观测需求，写追踪配置。"),
    ("observability", "metrics-dashboard.yaml",
     "按该项目质量指标，写监控面板配置。"),
    ("observability", "session-replay.yaml",
     "按该项目回放需求，写会话回放配置。"),
    ("observability", "versioning.yaml",
     "版本管理配置（结构通用，可按项目调整）。"),
    ("evolution", "genome.yaml",
     "初始化进化基因组：把 task 的 hard_constraints 与 acceptance_criteria 作为种子约束写入。"),
    ("evolution", "log.yaml",
     "初始化为空进化日志。"),
    ("evolution", "domain-advancements.yaml",
     "按该项目领域写四阶段进阶模式（Basic/Solid/Advanced/Excellent），供创新引擎使用。"),
    # Runtime layer slots（v2.6+ 新增）——多 worktree 并发 + 文档产物
    ("planning", "runtime-config.yaml",
     "supervisor 运行时配置：max_items / stop_conditions / dispatch_mode / claim_policy / worktree_pool / branch_prefix / base_branch。从 task.complexity (S/C/N/K) + team_size 派生。scope<=2 时 supervisor.enabled=false。"),
    ("planning", "workitem-source.yaml",
     "声明 workitem source adapter（adapter + class_name + config）。LLM 据 task.work_source 决定用 yunxiao/github_issues/local_file/jira 等，并在 runtime/sources/<adapter>_source.py 生成实现（继承 runtime/workitem_source.py 的 WorkitemSource 基类，实现 4 个抽象方法）。meta-harness 不预设 adapter。"),
    ("planning", "merge-policy.yaml",
     "分支合并策略：rebase_only / rebase_preferred / merge_allowed / squash。从 criticality 派生（C>=4 → rebase_only）。rebase-only 下不需要 merge sub-agent，冲突由 supervisor 标 blocked 转人工。"),
    ("planning", "agent-protocol.yaml",
     "leaf agent 协议配置：role 枚举（explorer/worker/tester/reviewer 等）+ 每 role 的 gate / forbidden_side_effects / timeout / effort→budget 映射。从 sub-agent-dispatch.yaml 的 prototypes 派生。被 runtime/leaf_prepare.py 读取。"),
    ("docs", "harness-doc-contract.yaml",
     "harness 自身文档契约：README/AGENTS.md/CHANGELOG/DESIGN-DECISIONS 的 schema、生成时机、版本化策略。纳入 evolution loop（genome 含 doc 演进约束，innovation 把'文档过时'作为创新提案）。"),
    ("docs", "project-doc-contract.yaml",
     "项目代码文档契约：README/API.md/CHANGELOG/DEPLOYMENT.md/SECURITY.md 的 schema、生成时机、版本化策略。PROVE 阶段验证文档与代码一致（API endpoints 与 routes 对齐等）。纳入 evolution loop。"),
]

# ARTIFACT_GATE 保留：按 S/C/N/K 裁剪可选层 slot（核心层 slot 总在）
ARTIFACT_GATE = {
    "verification": {"security-guardrails.yaml": "C>=3"},
    "observability": {
        "tracing.yaml": "tier!='minimal'",
        "metrics-dashboard.yaml": "tier!='minimal'",
        "session-replay.yaml": "tier=='full'",
        "versioning.yaml": "always",
    },
    "feedback": {"retry-config.yaml": "always", "fixer-registry.yaml": "always", "human-interface.yaml": "C>=4"},
    "security": {
        "sandbox-config.yaml": "tier!='minimal'",
        "encryption-rules.yaml": "C>=3",
        "audit-log.yaml": "C>=4",
    },
    # Runtime layer gate（v2.6+）：
    #   - runtime-config / merge-policy / agent-protocol: scope>=3 才需要 supervisor（小项目单线程）
    #   - workitem-source: 总在（即使 scope<3 也用 local_file source）
    #   - doc contracts: 总在（文档双重产物是硬约束）
    "planning": {
        "runtime-config.yaml": "S>=3",
        "merge-policy.yaml": "S>=3",
        "agent-protocol.yaml": "S>=3",
        "workitem-source.yaml": "always",
    },
    "docs": {
        "harness-doc-contract.yaml": "always",
        "project-doc-contract.yaml": "always",
    },
}

DEFAULT_COMPLEXITY = {"scope": 3, "criticality": 3, "novelty": 3, "coupling": 3, "tier": "standard"}


def compute_profile(task: dict) -> dict:
    cx = task.get("complexity") or {}
    return {
        "tier": cx.get("tier", DEFAULT_COMPLEXITY["tier"]),
        "scope": cx.get("scope", DEFAULT_COMPLEXITY["scope"]),
        "criticality": cx.get("criticality", DEFAULT_COMPLEXITY["criticality"]),
        "novelty": cx.get("novelty", DEFAULT_COMPLEXITY["novelty"]),
        "coupling": cx.get("coupling", DEFAULT_COMPLEXITY["coupling"]),
    }


def _eval_gate(predicate: str, profile: dict) -> bool:
    if predicate == "always":
        return True
    env = {"tier": profile["tier"], "S": profile["scope"], "C": profile["criticality"],
           "N": profile["novelty"], "K": profile["coupling"]}
    try:
        return bool(eval(predicate, {"__builtins__": {}}, env))
    except Exception:
        return True


def slot_included(layer: str, filename: str, profile: dict) -> bool:
    gate = ARTIFACT_GATE.get(layer, {})
    if filename not in gate:
        return True
    return _eval_gate(gate[filename], profile)


def load_task(task_file: Path) -> dict:
    if not task_file.exists():
        print(f"ERROR: Task file not found: {task_file}")
        sys.exit(1)
    with open(task_file, "r", encoding="utf-8") as f:
        task = yaml.safe_load(f)
    if not task or not isinstance(task, dict):
        print("ERROR: Task file is empty or not a valid object")
        sys.exit(1)
    for field in ("name", "domain", "goal"):
        if not task.get(field):
            print(f"ERROR: Missing required field: {field}")
            sys.exit(1)
    return task


def file_hash(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def _copy_fixer_primitives(output_dir: Path) -> list:
    """复制通用 fixer 原语（seeds/feedback/fixers/*.py → output/feedback/fixers/）。

    通用 fixer 是 domain-agnostic 的（如 ruff-fixer），所有项目共享，scaffold 原样复制。
    项目特定 fixer 由 LLM 在 GENERATE 阶段生成，不在此处复制。
    返回已复制的相对路径列表（供日志）。
    """
    fixers_src = SEEDS_DIR / "feedback" / "fixers"
    copied = []
    if not fixers_src.exists():
        return copied
    dest_dir = output_dir / "feedback" / "fixers"
    dest_dir.mkdir(parents=True, exist_ok=True)
    for f in fixers_src.glob("*.py"):
        shutil.copy2(f, dest_dir / f.name)
        copied.append(f"feedback/fixers/{f.name}")
    return copied


def scaffold(task: dict, output_dir: Path) -> None:
    profile = compute_profile(task)
    output_dir = output_dir.resolve()
    if output_dir.exists():
        if not (output_dir / HARNESS_MARKER).exists():
            print(f"ERROR: {output_dir} exists but is not a harness dir (no {HARNESS_MARKER}). "
                  f"Refusing to overwrite.")
            sys.exit(1)
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / HARNESS_MARKER).write_text("scaffolded\n", encoding="utf-8")

    print(f"Task: {task.get('name')}")
    print(f"Domain: {task.get('domain')}")
    print(f"Profile: tier={profile['tier']} S={profile['scope']} C={profile['criticality']} "
          f"N={profile['novelty']} K={profile['coupling']}")
    print()

    # 1. 创建所有层目录
    for layer in LAYER_DIRS:
        (output_dir / layer).mkdir(exist_ok=True)

    # 1b. 复制通用 fixer 原语（feedback/fixers/ 子目录，scaffold 原样复制）
    copied_fixers = _copy_fixer_primitives(output_dir)

    # 2. 复制通用原语（domain-agnostic，原样）
    copied_universal = []
    for layer, files in UNIVERSAL_PRIMITIVES.items():
        for fn in files:
            src = SEEDS_DIR / layer / fn
            if src.exists():
                shutil.copy2(src, output_dir / layer / fn)
                copied_universal.append(f"{layer}/{fn}")
    for fn in ROOT_UNIVERSAL:
        src = SEEDS_DIR / fn
        if src.exists():
            shutil.copy2(src, output_dir / fn)
            copied_universal.append(fn)

    # 复制 skills 目录（通用技能，按需加载）
    skills_src = SEEDS_DIR / "skills"
    if skills_src.exists():
        shutil.copytree(skills_src, output_dir / "skills")

    # 复制 planning 的 leaf-protocol / executor-engine 等通用文档
    for doc in ("leaf-protocol.md", "executor-engine.md", "planner-engine.md",
                "phase-spec-template.md", "protocol-template.md"):
        src = SEEDS_DIR / "planning" / doc
        if src.exists():
            shutil.copy2(src, output_dir / "planning" / doc)

    # 3. 复制 LLM slot 的 seed 基线 + 记录哈希
    slot_manifest = []
    for layer, fn, guidance in LLM_SLOTS:
        if not slot_included(layer, fn, profile):
            continue
        src = SEEDS_DIR / layer / fn
        dest = output_dir / layer / fn
        if src.exists():
            shutil.copy2(src, dest)
            baseline_hash = file_hash(dest)
        else:
            dest.write_text("", encoding="utf-8")
            baseline_hash = file_hash(dest)
        slot_manifest.append({
            "layer": layer,
            "file": f"{layer}/{fn}",
            "baseline_hash": baseline_hash,
            "guidance": guidance,
        })

    # 4. 复制 mcp-config.json（如有）
    mcp_src = SEEDS_DIR / "tools" / "mcp-config.json"
    if mcp_src.exists():
        shutil.copy2(mcp_src, output_dir / "tools" / "mcp-config.json")

    # 5. 写 task.yaml 到输出（LLM 填 slot 时需要读）
    with open(output_dir / "task.yaml", "w", encoding="utf-8") as f:
        yaml.dump(task, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    # 5b. 写 root agent 指令文件（AGENTS.md / CLAUDE.md / .cursorrules）
    #     verify-generation.py 期望这 3 个文件存在；不同 IDE 读不同文件名
    runtime_enabled = profile["scope"] >= 3
    runtime_section = ""
    if runtime_enabled:
        runtime_section = f"""
## Multi-Worktree Runtime（v2.6+）

本项目 scope={profile['scope']}（>=3），supervisor 已启用。多 worktree 并发调度：

### 启动 supervisor
```bash
# 单 session 模式（不调 supervisor，直接 orchestrator）
python orchestrator.py --next

# 多 worktree 模式（supervisor 调度多 workitem）
python runtime/supervisor.py run --project-root .

# 查看状态
python runtime/supervisor.py status --project-root .

# 优雅停止（写 STOP 文件，下轮停）
python runtime/supervisor.py stop --project-root .
```

### workitem source
workitem source adapter 在 `runtime/sources/<adapter>_source.py`（由 LLM 在 GENERATE 合成）。
配置在 `planning/workitem-source.yaml`。修改 source 不需重启 supervisor（热更新）。

### 合并策略
`planning/merge-policy.yaml` 决定合并策略：
- `rebase_only`（criticality>=4 默认）：workitem 分支 rebase 到 base，冲突标 blocked 转人工
- `merge_allowed`：需在 sub-agent-dispatch.yaml 加 merge-coordinator prototype

### 事件流（真相源）
所有 runtime 事件写 `.meta-harness/events/events.jsonl`（append-only + 哈希链）。
任何状态可从 events 重放重建。
```bash
python runtime/event_stream.py tail --project-root . --n 10
python runtime/event_stream.py verify --project-root .
```
"""

    root_agents_content = f"""# {task.get('name', 'Project')} — AGENT OPERATING INSTRUCTIONS

你是这个项目的执行 agent。本项目由 meta-harness 生成，harness 配置在当前目录。

## 启动前

1. 读 `task.yaml` —— 项目目标、domain、acceptance_criteria、hard_constraints
2. 读 `harness-scaffold.yaml` —— harness 结构 manifest（哪些 slot 已填充、哪些待填）
3. 读 `memory/session-state.yaml` —— 当前阶段、acceptance_criteria 进度

## 工作流

- 每个 work unit 从 `planning/work-units.yaml` 派发，由 `planning/dispatcher.py` 实例化 task card
- 每个 work unit 完成后跑 `python verification/self-check.py --verify-ac <task_id>` 校验
- 推进 phase 前跑 `python verification/hook-executor.py --event pre_advance_phase ...` 校验 gate
- 任何控制指令/状态变更必须经 `verification/audit-append.py` 写 audit_log（不可篡改）

## 硬约束（来自 task.yaml）

- 不得 mock/fake/stub 真实集成
- 不得绕过 audit_log
- 每条 acceptance_criteria 必须有可验证证据
- 配置支持热更新（不重启）
{runtime_section}
## 完成判定

`python orchestrator.py --verify` 返回 PASS = 所有 acceptance_criteria 已验证完成。
"""
    for fname in ("AGENTS.md", "CLAUDE.md", ".cursorrules"):
        (output_dir / fname).write_text(root_agents_content, encoding="utf-8")

    # 6. 写 harness-scaffold.yaml manifest（LLM 与 validator 共同读取）
    manifest = {
        "version": 1,
        "scaffolded_at": datetime.now().isoformat(),
        "task_file": "task.yaml",
        "task_name": task.get("name"),
        "task_domain": task.get("domain"),
        "profile": profile,
        "universal_primitives": copied_universal,
        "llm_slots": slot_manifest,
        "next_step": (
            "LLM 读 meta/harness-author.md，对每个 llm_slots 条目分析 task.yaml 并改写文件。"
            "完成后运行 python scripts/validate-harness.py <output_dir> 校验。"
        ),
    }
    with open(output_dir / "harness-scaffold.yaml", "w", encoding="utf-8") as f:
        yaml.dump(manifest, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    # 7. 写 harness-profile.yaml（运行时契约）
    hp = {
        "version": 1,
        "generated_at": datetime.now().isoformat(),
        "tier": profile["tier"],
        "factors": {k: profile[k] for k in ("scope", "criticality", "novelty", "coupling")},
        "generation_mode": "scaffold+llm",
        "note": "Structure scaffolded by script; content authored by LLM per harness-scaffold.yaml.",
    }
    with open(output_dir / "harness-profile.yaml", "w", encoding="utf-8") as f:
        yaml.dump(hp, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

    print(f"Scaffold created at: {output_dir}")
    print(f"  Universal primitives copied: {len(copied_universal)}")
    print(f"  LLM slots awaiting enrichment: {len(slot_manifest)}")
    print()
    print("Next: LLM reads meta/harness-author.md and enriches each slot listed in")
    print(f"      {output_dir / 'harness-scaffold.yaml'}")
    print(f"Then: python scripts/validate-harness.py {output_dir}")


def main():
    ap = argparse.ArgumentParser(description="Scaffold an empty harness skeleton for LLM enrichment")
    ap.add_argument("--task", required=True, help="Path to task.yaml")
    ap.add_argument("--output", required=True, help="Output directory")
    args = ap.parse_args()
    task = load_task(Path(args.task))
    scaffold(task, Path(args.output))


if __name__ == "__main__":
    main()
