# Meta-Harness Execution Protocol

吸收自：union 框架 `templates/PROTOCOL.md`
用途：生成项目中 agent 执行时的核心操作指南

此文件由执行 agent 在运行开始时读取，并在整个过程中遵循。它是自主会话的操作手册。

所有路径以 `{{RUN_ROOT}}` 为根——具体的命名空间产物目录（如 `.meta-harness/runs/add-login-Ab3Kx9`）。

---

## The Loop

重复直到 `RUN_COMPLETE` 打印：

1. 读取 `{{RUN_ROOT}}/STATE.md`。找到 `Current phase: N`。
2. 读取 `{{RUN_ROOT}}/phases/phase-N/spec.md`。这是你的完整工作规格。
3. 打印 `PHASE_START`，含 spec 的元数据（格式：参见 `engine/transcript-blocks.md`）。
4. 加载 spec 中声明的技能。
5. 执行 spec 中描述的工作。运行强制命令。呈现证据。
6. 打印 `PHASE_VERIFY`（格式：参见 `engine/transcript-blocks.md`）。
7. 记忆写回：本 Phase 有什么非显而易见的收获？保存到 memory。
8. 打印 `PHASE_DONE`。更新 STATE.md。
9. 如果 N < total：继续 Phase N+1。
10. 如果 N == total：按照 `engine/auditor.md` 运行 Final Audit。

---

## Failure Recovery (3-Strike)

### Strike 1: Auto-Retry
- 打印 `FAILURE_PROBE`
- 用 "Previous attempt failed because: …" 前导重新运行同一 Phase
- 不推进

### Strike 2: Fix Spec
- 打印 `FAILURE_ESCALATE`
- 写 `phases/phase-N.fix.md`（只针对失败的标准，无范围蔓延）
- 内联执行 fix spec
- 成功后：重新运行 VERIFY，推进

### Strike 3: Handoff
- 打印 `FAILURE_HANDOFF`
- 更新 STATE.md 为 `BLOCKED`
- 停止。用户接手。

---

## Final Audit

最后一个 Phase 之后，RUN_COMPLETE 之前。完整规格：`engine/auditor.md`。

快速参考：
1. 打印 `AUDIT_START`
2. 重新读取 ROADMAP.md，提取所有标准
3. Phase 完整性：检查每个 Phase 的 PHASE_DONE
4. 重新运行强制命令（去重）
5. 抽查可验证标准
6. Deliverable 检查：对每个 deliverable 运行 `repo-state.sh deliverable <baseline> <path>`
7. 打印 `AUDIT_VERIFY`

如有缺口：`AUDIT_GAPS` → 写 fix spec → 内联执行 → 循环（最多 3 轮）。
如零缺口：`AUDIT_COMPLETE` → `RUN_COMPLETE`。

---

## Supervisor/Leaf Dispatch

当 Phase 包含多个独立任务时，使用 Supervisor/Leaf 模式：

1. 读取 Phase spec，提取独立任务
2. 为每个任务生成 `task.json`（参见 `engine/leaf-protocol.md`）
3. 通过 executor adapter 派发 leaf agent
4. 等待所有 leaf 完成
5. 从每个 leaf 收集 `result.json`
6. 汇总到 Phase 的结果中

Leaf agent 禁止：编辑 master/main、触发 CI、创建更多 agent、修改工作项状态。

---

## Anti-Patterns

- 不要把长任务内容塞进派发命令。把工作放在文件里。
- 不要把完成条件设为评估者无法验证的。"测试通过"是错的；"PHASE_DONE 已打印"是对的。
- 不要为省空间跳过证据。文件没有字符预算。
- 不要跳过最终审计。审计是关闭自报告漏洞的关键。

---

## Transcript Blocks

所有 transcript 标记格式在 `engine/transcript-blocks.md` 中唯一定义一次。引用该文件——不要内联重复格式。

关键块：PHASE_START, PHASE_VERIFY, MEMORY_SAVED, PHASE_DONE,
FAILURE_PROBE, FAILURE_ESCALATE, FAILURE_HANDOFF,
AUDIT_START, AUDIT_VERIFY, AUDIT_GAPS, AUDIT_COMPLETE, AUDIT_HANDOFF,
RUN_COMPLETE。