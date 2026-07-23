# Meta-Harness-Generator: Task → Executable Harness Project

## Purpose
Generate a COMPLETE, RUNNABLE, SELF-EVOLVING harness engineering project.
Not documents. Not descriptions. An executable system with all seven layers.

## What Gets Generated
A full project in `generated/[project-name]/` that includes:

### Layer 1: Context Engineering
- AGENTS.md / CLAUDE.md — project-specific context files (AGENTS.md now slim: ~40 lines bootstrap)
- Dynamic context loader — `meta/phase-loader.md` (Phase-level lazy loading, never load all rules at once)
- Knowledge index — maps which files contain what knowledge (v2: 每条 mapping 为 `{description, tags}` dict，支持 loader.py 多信号排序检索)
- **运行时契约** — `harness-profile.yaml`（已实现，替换原 CONCEPTUAL 的 `run_mode` 设计）：tier (minimal/standard/full) 由 S/C/N/K 推导，驱动 ARTIFACT_GATE 裁剪与 agent 拓扑。原 fast/full/deep run_mode 概念已推翻，replaced by S/C/N/K tier

### Layer 2: Tool Integration
- Tool schema definitions (OpenAPI/function-call format)
- Sandbox config (Docker/container config if applicable)
- Permission manifests (what each agent role can access)
- MCP server configs (if applicable)
- **NEW: Tool discovery engine** (`tool-discovery.py`) — evaluates alternatives before adopting tools

### Layer 3: Memory & State
- Session state files (progress, checkpoints)
- Long-term memory structure (vector DB config or file-based index)
- Snapshot/rollback mechanism (git-based)
- Memory compression rules (what to keep, what to summarize, what to forget)
- **NEW: STATE.md template** — human-readable phase progress tracking with Failure Log and Audit Results (CONCEPTUAL — not yet emitted; use `memory/session-state.yaml`)
- **NEW: ROADMAP.md template** — full plan with phases, assumptions, risks, deliverables, acceptance criteria (CONCEPTUAL — not yet emitted; use `task.yaml`)

### Layer 3.5: Phase-Aware Skills
- **10 skills with full SKILL.md definitions** in `seeds/skills/` (loaded on demand by the phase loader; NOT copied into each generated project)
- PLAN phase: `brainstorming` (design before code) + `writing-plans` (zero-context implementation plans)
- IMPLEMENT phase: `tdd` (test-first) + `subagent-driven-dev` (parallel task dispatch + 2-stage review) or `executing-plans` (fallback)
- TEST phase: `code-review` + `verification` (evidence-before-claims) + `systematic-debugging` (root cause first, on failure)
- Cross-phase: `dispatching-parallel-agents` (multiple independent problem domains)
- Post-audit: `finishing-a-development-branch` (merge/PR/cleanup)

### Layer 4: Planning & Orchestration
- Task decomposition engine (DAG builder script)
- Execution flow controller (sequential, parallel, conditional, retry)
- Sub-agent dispatcher (role routing config)
- Reasoning budget config (step limits, time limits, token limits)
- **NEW: Leaf Protocol** (`leaf-protocol.md`) — Supervisor/Leaf two-level dispatch with standardized task.json/result.json
- **Layer Activation (已实现)** — 层裁剪在生成时由 `ARTIFACT_GATE` 按 S/C/N/K 因子驱动（替换原 CONCEPTUAL 的 per-phase `phase-activation.yaml` 设计）；运行时契约写入 `harness-profile.yaml`
- **NEW: Planner Engine** (`planner-engine.md`) — 8-stage planning pipeline (Env Detection → Handoff)
- **NEW: Executor Engine** (`executor-engine.md`) — Phase execution loop with 3-Strike recovery
- **NEW: Protocol Template** (`protocol-template.md`) — Agent execution protocol (PROTOCOL.md) for generated projects
- **NEW: Phase Spec Template** (`phase-spec-template.md`) — Standardized phase specification format

### Layer 5: Verification & Guardrails
- Output format validators (JSON/XML schema files)
- Logic consistency checks (test configs, linter rules)
- Security guardrails (sensitive data filters, dangerous operation blockers)
- Self-verification loop script (execute → check → reflect → fix)
- **NEW: Anti-mock check** (`anti-mock-check.py`) — scans all code for mock/fake/stub/simulated patterns
- **NEW: Quality gate** (`quality-gate.py`) — enforces engineering-grade standards before completion
- **NEW: 3-Strike Recovery Protocol** (`recovery-and-audit.md`) — structured failure escalation: probe → fix spec → handoff
- **NEW: Final Audit Protocol** — closes the self-report loophole: re-verify against original ROADMAP, max 3 audit rounds
- **NEW: Auditor Engine** (`auditor-engine.md`) — Independent audit engine: re-verify all phases against original ROADMAP
- **NEW: Baseline Diff Check** (`baseline-diff-check.md`) — Detect unexpected file changes outside Phase spec deliverables

### Layer 6: Feedback & Self-Healing
- Error capture and parser (structured error format)
- Auto-retry with backoff strategy config
- Error→constraint optimization loop (mistakes.md → constraints/)
- Human intervention interface (approval queue, escalation config)
- **NEW: Proactive execution driver** — auto-advance through pipeline without manual prompts

### Layer 7: Constraints & Entropy Management
- Architecture constraint rules (dependency direction, layer rules)
- Code enforcement configs (custom linter rules, pre-commit hooks)
- Entropy reduction schedule (cleanup scripts, consistency checks)
- Resource/cost constraints (budget config, rate limits, circuit breakers)

### Cross-Cutting: Security & Isolation
- Environment isolation config (sandbox, network rules)
- Data security rules (encryption, masking, access control)
- Audit log config (traceability, immutability)

### Cross-Cutting: Observability & Governance
- Tracing config (call chains, timing, token consumption)
- Metrics dashboard config (success rate, error rate, latency, cost)
- Session replay config (conversation reconstruction, issue reproduction)
- Version & config management (harness versioning, reproducibility)
- **NEW: Transcript Blocks** (`transcript-blocks.md`) — standardized execution markers (PHASE_START, PHASE_VERIFY, AUDIT_*, RUN_COMPLETE) for machine-parseable logs

### Self-Evolution System
- evolution/framework.md — evidence-driven evolution algorithm
- seeds/evolution/genome.yaml — current evolvable state (generation seed)
- seeds/evolution/log.yaml — evolution history (generation seed)
- Evolution triggers: periodic, reactive, emergency, adaptive

## Architecture (v2 — LLM-driven scaffolding)

> **本节是 GENERATE 阶段的当前实现（v2）。**
> v1 用单一脚本 `scripts/generate.py` 把所有内容（包括 domain 特化）都硬编码进脚本。
> v2 把工作切成三类：**脚本做确定性的事 / LLM 做语义分析 / 校验器守门**。
> 旧的 `generate.py` 仍保留作向后兼容与对照基线，但新项目应使用 v2 流程。

### 三类工作的分工（第一性原理）

| 工作类型 | 谁做 | 为什么 |
|---------|------|--------|
| 建目录 / 复制通用原语 / 写 manifest / 写 profile | 脚本（`scripts/scaffold.py`） | 确定性、与项目语义无关、可校验 |
| ARTIFACT_GATE 按 S/C/N/K 裁剪可选层 slot | 脚本（`scaffold.py`） | 由标量因子推导，是结构裁剪 |
| Slot 内容的项目特定改写 | LLM（按 `meta/harness-author.md` 指令） | domain 分析、约束合成是语义任务，LLM 远胜过脚本里的硬编码 dict |
| 校验：结构完整 / slot 已填充 / 反 mock / AC 可追溯 / 引用一致 | 脚本（`scripts/validate-harness.py`） | 确定性检查，必须可重复 |

### v2 Generation Steps（3 阶段）

**阶段 1：Scaffold（脚本，确定性）**

```
python scripts/scaffold.py --task <task.yaml> --output generated/<project>
```

`scripts/scaffold.py` 的 `scaffold(task, output_dir)` 执行：

1. 读 task.yaml（含 `complexity` 字段：S/C/N/K + tier，缺失回退 `{S:3,C:3,N:3,K:3,standard}`）
2. 计算 profile（tier / factors）
3. 建所有层目录
4. 复制 `UNIVERSAL_PRIMITIVES`（loader.py / self-check.py / anti-mock-check.py / quality-gate.py / guard.py / orchestrator.py / evolution 三件套等）—— 原样字节复制，**这些是项目无关的执行原语**
5. 按 `ARTIFACT_GATE` 谓词过滤可选层 slot（verification/security/observability/feedback），核心层 slot 全保留
6. 对每个保留的 LLM slot：复制 seed 基线到目标位置，计算 `baseline_hash = md5(基线内容)` 写入 manifest
7. 写 `harness-scaffold.yaml` manifest：列每个 slot 的 `(layer, file, baseline_hash, guidance)`
8. 写 `harness-profile.yaml`：tier/factors/active_layers/active_artifacts/context_budget/agent_topology
9. 不含任何 `if template == "web-app"` 风格的硬编码——脚本不知道也不需要知道 domain

**阶段 2：LLM Author（语义层）**

LLM 读 `meta/harness-author.md`，对 `harness-scaffold.yaml` 列出的每个 slot：

1. 读 task.yaml 建立项目心智模型（domain / hard_constraints / acceptance_criteria / real_need）
2. 读 slot 的 seed 基线（理解结构与 schema）
3. 按 slot 的 `guidance` 字段 + harness-author.md 的 per-slot 填充规范，改写出项目特定内容
4. 自检：每个改写引用了 task 里真实的组件名 / 约束 / AC 编号

`baseline_hash` 机制保证：LLM 改过 → 当前哈希 != baseline_hash；未改 → 校验失败。
**这是 v2 的核心反 mock 防线**：不是检查"有内容"，而是检查"内容确实被 LLM 改写并适配到本项目"。

**阶段 3：Validate（脚本，守门）**

```
python scripts/validate-harness.py generated/<project>
```

`scripts/validate-harness.py` 6 项校验（退出码 0 = PASS，1 = FAIL）：

1. **结构完整**：必填层在、通用原语在、evolution 三件套在、anti-mock 在
2. **Slot 已填充**：每个 LLM slot 的当前哈希 != baseline_hash（LLM 真的改过）
3. **YAML 语法合法**：每个 slot 可解析、非空
4. **AC 可追溯**：task 的每条 `acceptance_criteria` 在某 verification slot 里有对应验证手段（关键词启发式）
5. **反 mock**：扫描 enriched slot，无 `mock_/fake_/stub_/simulated return/# TODO/# placeholder/example_only` 模式
6. **引用一致性**：`constraints/architecture-rules.yaml` 的 `dependency_direction` 不再是 web-app 默认（frontend/api/repository）—— 证明 LLM 确实按本项目改写了

### v2 解决的 v1 局限

| v1 局限 | v2 解法 |
|--------|--------|
| `generate.py` 用 `template_name` 字符串分桶，桶内无项目差异 | scaffold 不知道 domain；LLM 按每个 task 实例改写 |
| `customize_*` 函数里硬编码 5 个 domain 的 dict（web-app/api-service/automation/data-pipeline/content-system） | 不存在硬编码 dict；LLM 在任意 domain 上都能改写 |
| 5 桶之外回退 `web-app`（`generate.py:229` 的 `domain_map.get(domain, "web-app")`） | scaffold 不分桶，所有 domain 一视同仁 |
| S/C/N/K 标量只驱动 ARTIFACT_GATE 谓词，丢失了语义 | 仍然驱动 ARTIFACT_GATE（结构裁剪），语义由 LLM 提供 |
| 项目级差异（同一 domain 不同项目）无法表达 | LLM 按 task.yaml 的 hard_constraints / acceptance_criteria 实例化 |

### 验证基线

工业控制 task（domain=`industrial_control`，旧 5 桶之外）的 v2 流程验证证据：

- `tests/task-industrial-control.yaml` — task 测试用例
- `generated/industrial-control/harness-scaffold.yaml` — scaffold manifest（24 LLM slots）
- `validate-harness.py` 输出：**24/24 slots enriched，6/6 AC 可追溯，0 mock patterns，PASS**
- 对照：旧 `generate.py` 同一 task → `Template: web-app`（silent fallback），`architecture-rules.yaml` 仍是 `frontend→api→service→repo→DB`，`security-guardrails.yaml` 仍是 `email/phone/ssn` masking



## Complexity-Driven Adaptive Generation (S/C/N/K + ARTIFACT_GATE)

> **已实现**（替换原 CONCEPTUAL 的 `phase-activation.yaml` 与 `run_mode` 设计）。
> 第一性原理：harness 规模应按任务复杂度自适应，而非固定全量复制；
> 知识库应按 Novelty 差异化预填，而非 long-term 初始为空。
> 原 per-phase `phase-activation.yaml` 概念已推翻，replaced by S/C/N/K + ARTIFACT_GATE（生成时裁剪）+ harness-profile.yaml（运行时契约）。

### 1. 复杂度模型：difficulty 拆为 S/C/N/K 四正交因子

`scripts/interpret.py` 的 `classify_complexity()` 从 intent 推导四个正交因子（每因子 1-5）：

| 因子 | 含义 | 驱动 |
|------|------|------|
| Scope (S) | 独立关注点数 | agent 数、上下文预算 |
| Criticality (C) | 失效代价（不可逆性 × 爆炸半径） | 验证严格度、人工 gate |
| Novelty (N) | 距训练分布/已积累知识 | 知识库质量 |
| Coupling (K) | 跨组件咬合度 | 一致性检查、架构规则 |

派生 tier（粗粒度层裁剪派生量）：
- `minimal`: S≤2 ∧ C≤2 ∧ N≤2 ∧ K≤2
- `standard`: 默认
- `full`: S≥4 ∨ C≥4 ∨ N≥4

`task.yaml` 新增 `complexity` 字段：`{scope, criticality, novelty, coupling, tier}`。
旧 task.yaml 无此字段时回退 `{S:3,C:3,N:3,K:3,standard}`（≈ 全量复制，向后兼容）。

### 2. ARTIFACT_GATE：按因子裁剪 artifact

`scripts/generate.py` 的 `ARTIFACT_GATE` 谓词表，`copy_seed_artifacts(output_dir, layer, profile)` 按 profile 过滤：

| 层 | artifact | 谓词 |
|----|----------|------|
| verification | self-check.py | always |
| verification | consistency-check.py | K>=3 |
| verification | security-guardrails.yaml | C>=3 |
| verification | anti-mock-check.py | C>=3 or N>=3 |
| verification | quality-gate.py | C>=3 |
| observability | tracing.yaml | tier!='minimal' |
| observability | metrics-dashboard.yaml | tier!='minimal' |
| observability | session-replay.yaml | tier=='full' |
| observability | versioning.yaml | always |
| feedback | error-capture.py | always |
| feedback | retry-config.yaml | always |
| feedback | mistake-to-constraint.py | tier!='minimal' |
| feedback | human-interface.yaml | C>=4 |
| security | sandbox-config.yaml | tier!='minimal' |
| security | encryption-rules.yaml | C>=3 |
| security | audit-log.yaml | C>=4 |

**核心层**（context / memory / planning / constraints / evolution / tools）全部 `always`，不裁剪。
未列入 gate 的文件默认 `always`（保守，避免意外丢失）。
谓词解析失败默认复制（保守，避免意外丢失 artifact）。

**最小可行 harness 边界**（gate 内保证）：
- 6 核心层 artifact 必有
- agent 最少 3（planner + executor + verifier）
- verification 最少 self-check.py
- evolution 三件套（framework.md / genome.yaml / log.yaml）必在

### 3. harness-profile.yaml：运行时契约

`scripts/generate.py` 的 `write_harness_profile()` 写入项目根 `harness-profile.yaml`：

```yaml
version: 1
generated_at: <ISO timestamp>
tier: standard              # minimal | standard | full
factors:
  scope: 3
  criticality: 3
  novelty: 3
  coupling: 3
active_layers: [context, evolution, feedback, ...]   # 实际复制了 artifact 的层
active_artifacts: [context/loader.py, ...]            # 实际复制的文件清单
context_budget: 500          # 500 + 100×max(0,S-2) + 150×max(0,N-2)
agent_topology:
  estimated_count: 5         # planner + ⌈S/2⌉ executors + verifier + (C>=4?sec) + (K>=3?integ) + (N>=3?curator)
note: Structure fixed at generation; activation tuned at runtime via phase-activation.
```

**结构生成时定**（tier/factors/active_artifacts/context_budget），**激活运行时调**（`loader.py` / `agent-factory.py` 读此文件）。
`harness-profile.yaml` 缺失时运行时视为 `standard`（向后兼容）。

### 4. preseed_long_term：按 N 预填知识库

`scripts/generate.py` 的 `preseed_long_term()` 按 Novelty 差异化预填 `memory/long-term/`：

| Novelty | 预填内容 | 输出文件 |
|---------|----------|----------|
| N≤2 | 不预填（熟悉领域，多了是上下文污染） | 仅 .gitkeep |
| N==3 | domain-advancements 的 Solid 阶段 innovations | known-patterns.yaml |
| N≥4 | Solid + Advanced 阶段，并从 trigger 字段生成反模式 | known-patterns.yaml + anti-patterns.yaml |

源数据来自 `seeds/evolution/domain-advancements-{template}.yaml`（回退 `domain-advancements.yaml`）。

### 5. agent-factory：从 S 推导 agent 拓扑

`scripts/agent-factory.py` 的 `derive_roles()` 从 `sub-agent-dispatch.yaml` 的 prototypes + profile 实例化：

| 角色 | count / condition |
|------|-------------------|
| planner | count: 1 |
| executor | count: `ceil(S/2)` |
| verifier | count: 1 |
| security-reviewer | condition: `C>=4` |
| integration-checker | condition: `K>=3` |
| knowledge-curator | condition: `N>=3` |

`compute_context_budget(S,N) = 500 + 100×max(0,S-2) + 150×max(0,N-2)`，写入每 agent 的 `boundaries.max_context_lines` 与 `agent-topology.yaml`。

`seeds/planning/sub-agent-dispatch.yaml` 为 v2 prototypes 格式（保留 `roles` 字段回退旧格式）。

### 6. loader.py：四职能分离

`seeds/context/loader.py` 重构为四职能（替代旧布尔关键词匹配）：

| 职能 | 职责 | 信号 |
|------|------|------|
| `inject(task, profile)` | 主动注入（高 N 注入 long-term 已知模式） | 静态预载 |
| `retrieve(task, index, profile)` | 被动检索 | 三信号加权：path-prefix +3 / domain-tag +2 / keyword overlap +1（封顶 +2） |
| `active_constraints(profile)` | 约束（gate 校验规则） | architecture-rules.yaml |
| `recall(task, profile)` | 记忆（session-state + evolution log） | 历史回放 |

`knowledge-index.yaml` 升级为 v2：每条 mapping 为 `{description, tags}` dict，支持多信号排序检索。旧格式（字符串值）自动包装为 `{description: <str>, tags: []}`（向后兼容）。

### 7. 向后兼容

- `task.yaml` 的 `complexity` 字段可选，旧 task 默认 `{S:3,C:3,N:3,K:3,standard}` ≈ 全量复制
- `harness-profile.yaml` 缺失时运行时（loader.py / agent-factory.py）视为 `standard`
- `sub-agent-dispatch.yaml` 旧格式（`roles`）在无 `prototypes` 时回退使用
- `knowledge-index.yaml` 旧格式（字符串值）自动包装为 v2 dict

## Single-File Configuration (project.yaml) — CONCEPTUAL

> **Note:** `project.yaml` is a design target. The current `scripts/generate.py`
> does NOT yet emit a `project.yaml`; configuration is spread across the
> per-layer YAML files copied from `seeds/`. When a future generator upgrade
> adds `project.yaml` emission, the per-layer files should be derived from it.

In addition to the layered YAML configs, the generator produces a `project.yaml` as the single source of truth. All other configs reference this file:

```yaml
# project.yaml — Single Source of Truth
# All components (AGENTS.md, orchestrator, adapters) read from here.
# Minimum: just project.name + repos to start.

project:
  name: "{{PROJECT_NAME}}"
  description: "{{PROJECT_DESCRIPTION}}"

repos:
  - name: main
    path: "."
    language: "{{LANGUAGE}}"
    build_command: "{{BUILD_COMMAND}}"
    typecheck_command: "{{TYPECHECK_COMMAND}}"
    lint_command: "{{LINT_COMMAND}}"
    test_command: "{{TEST_COMMAND}}"

adapters:
  work_item:
    type: "file"          # file | github-issues | jira
  ci:
    type: "noop"          # noop | github-actions
  executor:
    type: "sub-agent"     # sub-agent | claude-goal | codex-task

phases: [plan, implement, test]

quality_gates:
  - name: lint
    command: "lint_command"
  - name: typecheck
    command: "typecheck_command"
  - name: test
    command: "test_command"

phase_skills:
  plan:
    - brainstorming
    - writing-plans
  implement:
    - tdd
    - subagent-driven-dev
  test:
    - code-review
    - verification
    - systematic-debugging

memory:
  enabled: true
  dir: ".meta-harness/memory"
```

See `seeds/planning/project-yaml-template.yaml` for the full template with all options.

## Output Structure

> This tree reflects what `scripts/generate.py` actually emits. Items marked
> `CONCEPTUAL` are described above as design targets but are NOT yet
> auto-generated. Items gated by `ARTIFACT_GATE` are conditionally emitted
> based on the S/C/N/K complexity profile (see above).

```
generated/[project-name]/
├── .harness-generated     ← Marker file (prevents accidental rmtree on non-harness dirs)
├── AGENTS.md              ← Project context + execution protocol (auto-loaded by AI IDEs)
├── CLAUDE.md              ← Redirect to AGENTS.md (Claude Code)
├── .cursorrules           ← Redirect to AGENTS.md (Cursor)
├── task.yaml              ← The locked task definition from INTERPRET (含 complexity: S/C/N/K + tier)
├── harness-profile.yaml   ← 运行时契约：tier/factors/active_layers/active_artifacts/context_budget/agent_topology
├── orchestrator.py        ← Layer 4 entry point: --status/--verify/--mark-complete/--evolve
├── guard.py               ← Layer 5 entry point: --check pre-code guard
├── project.yaml           ← CONCEPTUAL (not yet emitted; see note above)
├── STATE.md               ← CONCEPTUAL (not yet emitted; use memory/session-state.yaml)
├── ROADMAP.md             ← CONCEPTUAL (not yet emitted; use task.yaml)
├── src/                   ← Domain-specific source layout (e.g. src/api, src/services)
├── tests/                 ← Test directory
├── context/               ← Layer 1: Context Engineering (seed artifacts, always)
├── tools/                 ← Layer 2: Tool Integration (seed artifacts, always)
├── memory/                ← Layer 3: Memory & State
│   ├── session-state.yaml ←   Progress, completed/failed criteria, guard_log
│   └── long-term/         ←   按 N 预填：.gitkeep (N≤2) / known-patterns.yaml (N==3) / +anti-patterns.yaml (N≥4)
├── planning/              ← Layer 4: Planning & Orchestration (seed artifacts, always)
├── verification/          ← Layer 5: Verification & Guardrails (ARTIFACT_GATE 裁剪；self-check.py 必在)
│   └── format-validators/ ←   JSON schemas (api-contract, config)
├── feedback/              ← Layer 6: Feedback & Self-Healing (ARTIFACT_GATE 裁剪；error-capture/retry 必在)
├── constraints/           ← Layer 7: Constraints & Entropy (seed artifacts, always)
├── security/              ← Cross-cutting: Security & Isolation (ARTIFACT_GATE 裁剪)
├── observability/         ← Cross-cutting: Observability & Governance (ARTIFACT_GATE 裁剪；versioning 必在)
├── evolution/             ← Self-Evolution System (三件套必在)
│   ├── framework.md       ←   Evolution algorithm description
│   ├── genome.yaml        ←   Current evolvable state
│   ├── log.yaml           ←   Evolution history
│   ├── innovation-engine.py ← Product analysis + innovation proposals
│   └── domain-advancements.yaml ← Domain-specific advancement seeds
└── scripts/               ← Executable scripts
    └── evolve.py          ←   Evolution engine (copied from meta-harness)
```

> **Not yet auto-generated** (referenced conceptually above): `skills/` directory
> (skills live in the meta-harness `seeds/skills/` and are loaded on demand by
> the phase loader, not copied into each generated project), and the shell
> helpers `claim-run.sh` / `detect-env.sh` / `detect-stack.sh` /
> `summarize-repo.sh` / `repo-state.sh` / `validate-phase.sh`.

## Anti-Patterns
- Do NOT generate documentation-only layers — every layer must have executable artifacts
- Do NOT generate boilerplate — only what the specific task requires
- Do NOT skip layers — even minimal implementations are required
- Do NOT generate without evidence traceability — every artifact traces to a requirement
- **NEW: Do NOT generate mock/fake/stub implementations** — if the task requires real integration, generate real API client code. If API keys are missing, flag as blocker.
- **NEW: Do NOT generate prototype-grade shortcuts** — every generated artifact must meet engineering standards (config-driven, error-handled, validated, tested)
- **NEW: Do NOT generate without tool evaluation** — for each tool/library choice, include a justification comment referencing alternatives considered
