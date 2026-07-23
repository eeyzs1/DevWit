# Meta-Harness Author: LLM 填充 Harness Slot 的指令

## 你的角色

scaffold.py 已经建好了 harness 骨架（目录 + 通用原语 + slot 种子基线）。
你的任务是：**分析 task.yaml，为每个 slot 改写出项目特定的内容**。

你不是在选模板，不是在套公式。你在**为这个具体项目合成它需要的约束/工具/验证**。

## 第一性原理

harness 回答一个问题："在这个具体项目上，agent 怎样才算可靠地干对了？"

答案的项目特定部分由你合成：
- 组件依赖图 → `constraints/architecture-rules.yaml` 的真实规则
- 数据流与敏感面 → `verification/security-guardrails.yaml` 的真实检查
- 工作单元与风险 → `planning/sub-agent-dispatch.yaml` 的真实拓扑
- 验收标准 → 每条都有对应验证器（traceability）

## 执行步骤

### Step 1: 读输入
1. 读 `task.yaml` —— 项目名、domain、real_need、goal、hard_constraints、acceptance_criteria、unknowns、assumptions、complexity
2. 读 `harness-scaffold.yaml` —— 列出所有待填充 slot + 每个 slot 的 guidance

### Step 2: 建立项目心智模型（先想清楚再写）
在脑中/草稿里回答：
- 这个项目有哪些组件/模块？（从 goal、hard_constraints、real_need 推断）
- 组件间依赖关系是什么？（谁调谁、数据怎么流）
- 哪些数据是敏感的？哪些操作是不可逆的？
- 验收标准如何可验证？每条对应什么检查？
- 这个 domain 有什么典型不变量？（如工业控制：安全联锁必须本地执行）

### Step 3: 逐个 slot 改写
对 `harness-scaffold.yaml` 的 `llm_slots` 列表里每个 slot：

1. 读 slot 文件的 seed 基线（scaffold 已复制，含通用结构）
2. 按 slot 的 `guidance` 字段 + 你的项目心智模型，改写文件内容
3. 保留文件的结构 schema（如 `rules: [{id, description, ...}]` 的字段名不变），替换内容
4. 内容必须引用 task 里真实的组件/模块/数据/约束——不能是通用占位

### Step 4: 自检（在交给 validate-harness.py 之前）
- 每个 acceptance_criteria 是否在某处有对应验证器？
- 是否引入了 mock/fake/stub/simulated 模式？（禁止）
- architecture-rules 的 dependency_direction 是否反映真实组件依赖？
- 是否所有引用的组件在 task.yaml 里存在？

## Slot 填充规范（按文件）

### context/knowledge-index.yaml
- `mappings`: 改为该项目的真实源码路径 → 知识域映射
- 每条带 `description` + `tags`（受控词汇）
- 例：工业控制项目可能有 `src/control/`、`src/edge/`、`src/cloud/`

### constraints/architecture-rules.yaml
- `rules`: 写该项目真实的架构约束（不是通用 web 规则）
  - 每条 `description` 必须引用 task 里真实的层/模块
  - `pattern`/`file_pattern` 针对该项目实际目录结构
- `dependency_direction`: allowed/forbidden 必须反映该项目的真实依赖图
  - 例：工业控制可能是 `edge → cloud`（允许）、`cloud → edge_control`（禁止——控制指令不能从云端下发到安全联锁）

### verification/security-guardrails.yaml
- `sensitive_data_filters`: 该项目实际敏感数据模式
  - 工业控制可能不是 email/credit_card，而是工艺参数、配方、安全阈值
- `dangerous_operations`: 该项目实际危险操作
  - 工业控制可能是 `控制指令从云端下发到安全联锁`、`绕过本地 interlock`

### planning/sub-agent-dispatch.yaml
- `prototypes`: 按 task 的工作单元合成 agent 角色
  - 不要套 `ceil(S/2)` 公式
  - 每个 role 的 responsibilities/receives/produces 针对该项目
  - 例：工业控制可能有 `control-engineer`、`safety-reviewer`、`protocol-validator` 而不是通用 planner
- **每个 prototype 必须含完整字段**：
  - `responsibilities`（语义角色描述）
  - `receives`（输入工件清单——subagent 可读的文件/资源）
  - `produces`（输出工件清单——subagent 写出的产物，下游 receives 必须能对上）
  - `count`（整数或公式如 `ceil(S/2)`，由 agent-factory.py 评估）
  - `condition`（可选，因子谓词如 `C>=4`，决定 prototype 是否启用）
  - `boundaries.cannot`（不得越界的操作清单）
  - `boundaries.max_context_lines`（上下文预算——dispatcher 会把它写入 task card）
  - `requires_human_review`（可选，true 时 dispatcher 在该 work unit 后暂停，runtime 必须等人工）

### planning/work-units.yaml（**新增**）
- `work_units`: 把 task 分解为可独立派发的工作单元
- **不要在这里硬塞顺序**——只声明 `depends_on`，让 dispatcher + dag-builder.py
  做拓扑排序与并行分组（脚本负责算法，你负责语义切分）
- 每条字段：
  - `id`：唯一标识（如 `WU001`）
  - `name`：人类可读的目标（如 "实现 edge PID 闭环控制"）
  - `assigned_to`：必须引用 sub-agent-dispatch.yaml 里某个 prototype 名（dispatcher 校验一致性）
  - `workflow`（**重要**）：本 work_unit 所属的 workflow 名（必须与 flow-control.yaml
    的 `workflows` key 一致）。agent-factory.py 用此字段派生每个 role 的 assigned_workflows
    —— **不要靠关键词匹配推断 workflow→role**，要在这里显式声明。
  - `depends_on`：依赖的其他 work_unit id 列表（**必须基于真实依赖**——如下游用上游的产物；不是凭感觉排序）
  - `success_criteria`：本 work_unit 完成的可验证证据（每条应 trace 到 task.acceptance_criteria）
  - `traces_to`（**重要**）：本 work_unit 验收的 AC id 列表（如 `[AC1, AC4]`）。
    agent-factory.py 用此字段派生每个 role 的 assigned_criteria——**不要靠关键词匹配推断 AC→role**，
    要在这里显式声明。
  - `constraints`（可选）：本 work_unit 必须遵守的 architecture-rules id 列表（dispatcher 写入 task card）
  - `requires_human_review`（可选）：本 work_unit 完成后必须人工 review（与 prototype 同字段并集）
- **分解决策**：acceptance_criteria 不是 work_unit（一个 AC 可能要多个 WU，多个 WU 也可能共享一个 AC）；
  按"可独立派发 + 可独立验证"的粒度切分

### planning/budget.yaml
- 按该项目实际复杂度设置 step/token/retry 预算
- 不是 web-app 默认值
- 可选 `per_role_budget`：按 agent prototype 设置不同预算（如 safety-engineer 预算更紧）

### feedback/fixer-registry.yaml（**定向修复器注册表**）
- 把 `feedback/retry-config.yaml` 里每个"可机械修复"的 strategy 绑定到可执行 fixer。
- **通用 `ruff_autofix` 条目保留不动**（scaffold 已复制 ruff-fixer.py）。
- 项目特定 fixer 据 task.yaml + work-units + retry-config 推演追加：
  - 读 retry-config 的每个 strategy 条目，判断其 error_types 是否"可机械修复"
  - 可机械修复的（如 schema 字段缺失、配置漂移、哈希重算）→ 绑定 fixer，`handler` 指向 `feedback/fixers/<name>.py`
  - 不可机械修复的（如认证失败、安全联锁拒绝、人工决策类）→ **不绑 fixer**，让 apply_fixes 走 pending 转人工
- 每条 fixer 字段：`match.strategy`(按 retry strategy 值) + `match.error_types`(按 error-capture type) + `handler` + `entry`(="fix") + `safe`(true 才自动执行，false 只写 pending) + `description`
- 每条 fixer 必须同时在 `feedback/fixers/<name>.py` 生成实现（统一 `fix(error, context, project_root)` 接口）
- 例：工业控制项目，retry-config 有 `audit_write_failed`(strategy=no_retry)，可绑 `audit_hash_repair` fixer（重算哈希链），但 `safe: false`（审计修复需人工确认）
- validate-harness.py check #8 校验每条 `handler` 路径存在，缺失 = ERROR 阻断 GENERATE→FACTORY

### memory/session-state.yaml（**schema 强制**）
- **必须用以下 schema**（guard.py / orchestrator.py 强制读这个结构）：
  ```yaml
  status: initialized          # initialized | in_progress | completed | blocked
  phase: GENERATE              # 当前 pipeline phase
  progress:
    acceptance_criteria:       # 必须在 progress 下，不是顶层
      - id: AC1
        description: "..."
        status: pending       # pending | in_progress | completed | failed
        verifier: "tests/..."
        traces_to: "..."
    completed_criteria: []    # 已完成的 AC id 列表
    failed_criteria: []        # 失败的 AC id 列表
  guard_log: []
  blockers: []
  ```
- **不要**把 `acceptance_criteria` 放在顶层（guard.py 读 `state.progress.acceptance_criteria`，找不到会 FAIL 报"No acceptance criteria loaded"）
- 每条 AC 的 `id` / `description` / `verifier` / `traces_to` 从 task.yaml 派生
- guard.py 在 hook-executor HOOK_PHASE_GATE 跑时读本文件，schema 不一致会让 hook 永远 FAIL

### evolution/genome.yaml
- `constraints`: 把 task 的 hard_constraints 作为种子约束写入（每条带 id/rule/source）
- `workflows`: 从 task 派生

### evolution/domain-advancements.yaml
- 按该项目领域写四阶段进阶（Basic/Solid/Advanced/Excellent）
- 例：工业控制的 Advanced 可能是"预测性维护"、"数字孪生"，不是 web-app 的"离线支持"

### 项目特定脚本生成（非 slot，但必须做）

flow-control.yaml 与 runtime-hooks.yaml 的 `command` 字段会引用 `python verification/xxx.py`。
其中通用原语（audit-append / lint-check / dispatch-verifier / hook-executor / self-check /
consistency-check / anti-mock-check / quality-gate 等）由 scaffold.py 自动复制；
但**项目特定的验证脚本**（如 scan-plaintext / scan-log-masking）必须由你基于
architecture-rules / security-guardrails 生成。

执行步骤：
1. 扫描 `planning/flow-control.yaml` 的 `workflows.*.steps[].command` 与 `mandatory_pre_steps[].command`
2. 扫描 `verification/runtime-hooks.yaml` 的 `events.*.checks[].command`
3. 提取所有 `python verification/<name>.py` 里的 `<name>.py`
4. 对每个不在通用原语列表里的脚本（即你首次见到的名字），生成实现：
   - 读 `constraints/architecture-rules.yaml` / `verification/security-guardrails.yaml`，
     理解它要检查的规则（如 AR005 明文配方）
   - 实现 CLI：`argparse` + `--project-root`（+ 需要的标志如 `--recipe` / `--pii`）
   - exit 0 = PASS，exit 1 = FAIL（发现违规）
   - 写到 `verification/<name>.py`

validate-harness.py 的 check #7 会校验所有引用的脚本存在——缺失报 WARNING。
不生成 = harness 不自洽（runtime 调用时会 FileNotFoundError）。

### 项目特定 fixer 生成（非 slot，但必须做）

`feedback/fixer-registry.yaml` 的每条 `handler` 字段指向 `feedback/fixers/<name>.py`。
通用 `ruff-fixer.py` 由 scaffold 自动复制；**项目特定 fixer 必须由你生成**。

执行步骤：
1. 读 `feedback/fixer-registry.yaml`，对每条 `handler` 指向的 `feedback/fixers/<name>.py`
2. 若该 .py 不存在（非 ruff-fixer.py 通用原语），生成实现：
   - 读该 fixer 的 `match`（strategy/error_types）+ `description`，理解它要修的错误
   - 读 `feedback/retry-config.yaml` 对应 strategy 条目 + `feedback/error-capture.py` 的 ERROR_PATTERNS，理解错误语义
   - 实现统一接口：`def fix(error, context, project_root) -> {"applied", "method", "output", "deferred"}`
   - `safe: false` 的 fixer 只需返回建议性输出（`applied=False, deferred=True`），不实际改代码——由 apply_fixes 写 pending 转人工
   - `safe: true` 的 fixer 才真正执行修复（如调真实工具/重算/补字段）
   - 同时支持独立 CLI（`--project-root` + `--error-json`，exit 0=applied/1=未applied，输出 YAML）
3. 写到 `feedback/fixers/<name>.py`

validate-harness.py 的 check #8 校验每条 `handler` 路径存在——缺失报 **ERROR**（阻断 GENERATE→FACTORY）。
不生成 = apply_fixes 运行时 importlib 会 FileNotFoundError。

### Runtime Layer slot 填充规范（v2.6+ 新增）

meta-harness v2.6+ 引入 runtime layer：生成的 harness 支持 **多 worktree 并发** +
**文档双重产物**。8 个通用原语（supervisor.py / worktree_lifecycle.py / leaf_protocol.py /
leaf_prepare.py / leaf_record.py / event_stream.py / rebase_sync.py / workitem_source.py）
由 scaffold 原样复制；**6 个 LLM slot 由你合成**。

**因地制宜决策矩阵**（task.complexity 驱动）：

| S/C/K | supervisor.enabled | dispatch_mode | merge_policy | worktree_pool | push_after_rebase |
|-------|-------------------|---------------|-------------|---------------|-------------------|
| S<=2  | false             | subprocess    | squash      | 0             | false             |
| S>=3 + team=1 | true       | subprocess    | rebase_only | 0             | false             |
| S>=3 + team>1 | true       | mavis/ide-adapter | rebase_only | 3-5        | true              |
| C>=4  | true              | subprocess    | rebase_only | 0             | false             |

**填 slot 步骤**：

1. 读 task.yaml 的 `complexity` (scope/criticality/novelty/coupling) + `team_size`
2. 按决策矩阵定 supervisor 形态
3. 逐个 slot 改写：
   - `planning/runtime-config.yaml`：填 max_items / stop_conditions / dispatch_mode 等
   - `planning/workitem-source.yaml`：选 adapter + 生成 runtime/sources/<adapter>_source.py
   - `planning/merge-policy.yaml`：填 policy + dual_approval（C>=4 启用）
   - `planning/agent-protocol.yaml`：从 sub-agent-dispatch.yaml 的 prototypes 派生 role 配置
   - `docs/harness-doc-contract.yaml`：填文档 schema + 演进约束
   - `docs/project-doc-contract.yaml`：填项目文档 schema + PROVE 验证规则

**关键：workitem source adapter 必须由你合成**

scaffold 复制的是 `runtime/workitem_source.py` 的 **抽象基类**——它定义了 4 个抽象方法
但不含具体实现。你必须在 `runtime/sources/<adapter>_source.py` 生成具体实现：

```python
# runtime/sources/<adapter>_source.py 示例（local_file）
from runtime.workitem_source import WorkitemSource

class LocalFileSource(WorkitemSource):
    def __init__(self, config: dict):
        self.config = config
        self.source_dir = Path(config["config"]["source_dir"])
        # ...

    def claim_next(self, policy: str = "any") -> Optional[str]:
        # 扫 source_dir/pending/*.yaml，按 policy 选一个，移到 in_progress/
        ...

    def fetch_brief(self, workitem_id: str) -> dict:
        # 读 yaml 返回 title/description/acceptance_criteria/effort/priority
        ...

    def update_status(self, workitem_id: str, status: str) -> None:
        # 移文件到对应目录（pending/in_progress/done/blocked）
        ...

    def archive(self, workitem_id: str, result: str, summary: str) -> None:
        # 移到 done/，写 events 流
        ...
```

可选 adapter（据 `task.work_source` 选）：
- `local_file`：本地 file watcher（最简，不依赖外部系统；scope<=2 或开发期默认）
- `yunxiao`：云效 API（中国团队常用）
- `github_issues`：GitHub Issues（开源项目）
- `jira`：Jira REST API（企业项目）
- `azure_boards`：Azure DevOps
- `manual`：人工指定（无 source 系统，每次手动跑）

**不要预设 adapter**——meta-harness 不预设任何平台。你据 task 实际选。

**为什么 workitem source 是抽象基类而非具体实现**：
1. work source 高度项目特定——某团队用云效，某团队用 GitHub，某团队本地文件
2. 接口契约稳定（claim/fetch/update/archive），实现可换
3. 与 fixer-registry 模式一致：通用接口 + 项目特定实现

**文档双重产物（硬约束）**

文档不是"事后补充"——是流水线产物，纳入 evolution loop：
- `docs/harness-doc-contract.yaml` 管 harness 自身文档（README/AGENTS.md/CHANGELOG/DESIGN-DECISIONS）
- `docs/project-doc-contract.yaml` 管项目代码文档（README/API.md/CHANGELOG/DEPLOYMENT.md/SECURITY.md）
- PROVE 阶段验证文档与代码一致（如 API.md endpoints == 代码 routes）
- innovation-engine 把"文档过时"（>max_age_days）作为创新提案类别

**为什么 rebase-only 不需要 merge sub-agent**：

merge 冲突是设计缺陷的 symptom。rebase-only 策略下：
- workitem 分支只 rebase 到 base，从不 merge base 到 feature
- rebase 冲突 → supervisor 标 workitem 为 blocked → 人工 triage
- 这比"自动 merge"更安全：让冲突显式化，而非自动解决（自动解决可能丢语义）

`merge-policy.yaml` 的 `policy: rebase_only` 时，不需要在 sub-agent-dispatch.yaml 加
merge-coordinator prototype。只有 `merge_allowed` 才需要——而 C>=4 项目强制 rebase_only，
所以 merge sub-agent **可选**，不是必须。

## 硬约束（不可违反）

1. **NO mock/fake/stub/simulated** —— 不能在 slot 内容里写 mock 实现
2. **NO 通用占位** —— 内容必须引用 task 真实实体；不能留 "TODO" 或 "example"
3. **保留 schema 结构** —— 文件的字段名/层级不变，只换内容
4. **acceptance_criteria traceability** —— 每条验收标准必须在某 slot 里有对应验证手段
5. **不删通用原语** —— scaffold 复制的 anti-mock/self-check/evolution 等不动
6. **domain 由 task 决定** —— 不从 5 个固定桶选；按 task 实际领域合成
7. **workitem source adapter 必须合成** —— 不预设 adapter；据 task.work_source 在 runtime/sources/ 生成实现
8. **文档双重产物** —— harness-doc + project-doc 两个 contract 都要填，纳入 evolution loop

## 完成后

```
python scripts/validate-harness.py <output_dir>
```

校验通过 = harness 可用。校验失败 = 按 report 修正对应 slot。
