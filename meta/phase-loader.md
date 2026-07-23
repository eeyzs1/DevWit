# Phase Loader — 惰性加载机制

## 原则

**绝不一次性加载所有规则文件。** 每个 Phase 只加载该 Phase 需要的文件。这直接减少 token 消耗，同时保持上下文聚焦。

## 加载策略

### 核心机制

1. 所有启动时：加载 `meta/phase-loader.md`（本文件）→ 确定当前 Phase
2. 每个 Phase 开始时：加载该 Phase 的强制文件列表
3. Phase 内按需：跨 Phase 技能（如 `dispatching-parallel-agents`）仅在触发时加载
4. 规则文件：仅在违反风险出现时加载（如检测到 mock 模式 → 加载 `meta/rules/absolute-rules.md` 附录 A）

## Phase → 文件映射

### INTERPRET Phase
```
强制: meta/interpreter.md
     seeds/planning/planner-engine.md
按需: meta/rules/absolute-rules.md（附录 D — 怀疑上下文漂移时）
```

### GENERATE Phase
```
强制: meta/harness-generator.md
     seeds/planning/project-yaml-template.yaml
     seeds/planning/planner-engine.md
按需: seeds/tools/adapters/（仅选择的 adapter 类型）
     seeds/skills/（仅被任务引用的技能）
     meta/rules/absolute-rules.md（附录 B — 生成代码时）
```

### FACTORY Phase
```
强制: meta/agent-factory.md
     seeds/planning/leaf-protocol.md
按需: meta/examples/（仅需要的拓扑示例）
```

### PROVE Phase
```
强制: seeds/verification/auditor-engine.md
     seeds/verification/recovery-and-audit.md
     seeds/verification/quality-gate.py
按需: seeds/skills/verification.md
     seeds/skills/systematic-debugging.md（仅验证失败时）
     meta/rules/absolute-rules.md（附录 A — 扫描到 mock 模式时）
```

### JUDGE Phase
```
强制: seeds/guard.py
     seeds/planning/orchestrator.py
按需: seeds/planning/executor-engine.md（需要重新执行时）
```

### EVOLVE Phase
```
强制: evolution/framework.md
     scripts/evolve.py
按需: memory/generation-log.yaml（读历史）
     memory/meta-mistakes.md（分析失败模式）
```

## 规则文件（按需加载）

所有规则已统一到 `meta/rules/absolute-rules.md`。按需加载对应附录：

| 触发条件 | 加载 |
|----------|------|
| 检测到 mock/fake/stub 模式 | `meta/rules/absolute-rules.md` 附录 A |
| 代码生成阶段 | `meta/rules/absolute-rules.md` 附录 B |
| 引入新依赖时 | `meta/rules/absolute-rules.md` 附录 C |
| 自我检查（怀疑踩坑时） | `meta/rules/absolute-rules.md` 附录 D |
| 任何规则冲突或不确定时 | `meta/rules/absolute-rules.md` 全文 |

## 运行模式

从 `project.yaml` → `run_mode` 读取。

| 模式 | 加载策略 |
|------|----------|
| `fast` | 只加载强制文件，跳过 brainstorm + code-review |
| `full` | 默认模式，按 Phase 惰性加载 |
| `deep` | 额外 research + pair-review + 更多规则文件 |