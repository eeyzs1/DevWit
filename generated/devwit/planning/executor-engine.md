# Executor Engine — 执行引擎种子

吸收自：union 框架 `engine/executor.md`
用途：自主执行 Phase DAG，包含失败自愈和最终审计

---

## 概述

Executor 是 Meta-Harness 的执行引擎。它读取 Planner 产出的 Phase DAG，按依赖顺序执行每个 Phase，处理失败自愈，运行最终审计。

---

## 执行循环

重复直到 `RUN_COMPLETE`：

### 1. 读取 STATE.md
找到 `Current phase: N`。

### 2. 读取 Phase Spec
读取 `phases/phase-N/spec.md`。这是完整的工作规格。

### 3. 加载技能
根据 spec 中声明的技能列表，加载对应技能。

### 4. 打印 PHASE_START
```
PHASE_START
Phase: <N> of <total> — <name>
Task: <one-line from spec>
Type: <greenfield|brownfield|bugfix|refactor|ui>
Mandatory commands: <list>
Acceptance criteria: <count>
Skills loaded: <list>
Depends on: <list or "none">
```

### 5. 执行工作
- 按照 spec 中的 Work Description 执行
- 运行强制命令
- 收集证据（截图、日志、测试报告）
- 如果是 IMPLEMENT phase 且有多个独立任务 → 使用 subagent-driven-dev 并行派发

### 6. 打印 PHASE_VERIFY
```
PHASE_VERIFY
Acceptance:
- <criterion 1>: <pass|fail> — <evidence>
...
Engineering:
- build: <pass|fail>
- typecheck: <pass|fail>
- lint: <pass|fail|pre-existing>
- tests: <pass|fail|N pre-existing>
Cleanliness (vs Baseline ref):
- debug prints added: <count>
- session TODO/FIXME added: <count>
- dead imports added: <count>
Files changed: <count>
Notable diffs:
- <file>: <one-line summary>
```

### 7. 记忆写回
本 Phase 有什么非显而易见的收获？保存到 `.meta-harness/memory/`。

### 8. 打印 PHASE_DONE
```
PHASE_DONE
Phase <N> complete. STATE.md updated.
```

### 9. 续接
- 如果 N < total：继续 Phase N+1
- 如果 N == total：**委托给 Auditor** 运行 Final Audit

---

## 失败恢复 (3-Strike)

### Strike 1: 自动重试
```
FAILURE_PROBE
Phase: <N> — <name>
Failed criterion: <text>
Hypothesis: <root cause guess>
Next: auto-retry with probe injected
```
注入 probe 作为前导："Previous attempt failed because: …"，重新执行同一 Phase。

### Strike 2: 写 Fix Spec
```
FAILURE_ESCALATE
Phase: <N> — <name>
Failed criterion: <text>
Writing fix spec at phases/phase-<N>.fix.md
```
Fix spec 只针对失败的标准，禁止范围蔓延。执行 fix spec 内联。

### Strike 3: 交还用户
```
FAILURE_HANDOFF
Phase: <N> — <name>
Failed criterion: <text>
Three attempts tried. STATE.md updated to BLOCKED.
```
停止执行。用户接手。

---

## Supervisor/Leaf 两级调度

当 Phase 包含多个独立任务时，使用 Supervisor/Leaf 模式：

### Supervisor（主 Agent）
- 读取 Phase spec，提取独立任务列表
- 为每个任务生成 `task.json`
- 派发 leaf agent（通过 executor adapter）
- 等待所有 leaf 完成
- 汇总结果

### Leaf Agent（子 Agent）
- 接收 `task.json`（任务、范围、允许文件、禁止操作）
- 在隔离上下文中执行
- 写 `result.json`（结论、发现、变更文件、证据）
- **约束**：不得修改 master/main、不得创建更多 agent、不得触发 CI、不得修改 scope 外的文件、不得与其他 Leaf 通信、超时自动终止、必须写 result.json

### 中断处理
- 执行过程中用户发送消息时：在当前 Phase 的 `PHASE_DONE` 之后暂停
- 处理用户消息后再继续下一个 Phase
- 不中断正在执行的 Phase 内部工作

### 与 Auditor 的关系
Executor 完成所有 Phase 后自动委托给 Auditor 运行 Final Audit。只有 `AUDIT_COMPLETE` 之后才打印 `RUN_COMPLETE`。