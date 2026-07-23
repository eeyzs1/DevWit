# Subagent-Driven Development (Phase-Aware)

吸收自：union 框架 `skills/subagent-driven-dev/SKILL.md`
默认 Phase：IMPLEMENT（以 `project.yaml` → `phase_skills` 为准）

## 核心原则

**每个任务一个全新的子代理 + 两阶段审查（spec 然后 quality）= 高质量，快速迭代。**

## 何时使用

- 实现计划有多个独立任务
- 任务不共享状态或不需要顺序执行
- 每个任务是有边界的、良好规格的工作单元

**vs. 手动执行：** 子代理自然地遵循 TDD，拥有全新的上下文，可以在工作前后提问。

## 流程

### 每个任务：
1. **派发 implementer** — 完整任务文本 + 上下文，与其他任务隔离
2. **Implementer 工作** — 实现、测试、提交、自我审查
3. **派发 spec reviewer** — 确认代码匹配 spec，不多不少
4. **派发 code quality reviewer** — 检查模式、性能、边界情况
5. **修复循环** — 如果任一审查者发现问题，implementer 修复，审查者重新检查
6. **标记完成** — 仅在两次审查都通过后

### Implementer 状态：
- **DONE** → 进入审查
- **DONE_WITH_CONCERNS** → 阅读疑虑，如有需要处理
- **NEEDS_CONTEXT** → 提供缺失信息，重新派发
- **BLOCKED** → 评估：更多上下文？更强模型？拆分任务？升级？

## 红线

**绝不：**
- 跳过审查（spec 或 quality）
- 并行派发多个实现子代理（会冲突）
- 让子代理读计划文件（提供完整文本）
- 跳过审查循环（审查者发现问题 = 修复 + 重新审查）
- 在 spec 合规通过前开始代码质量审查

## Implementer Prompt 模板

```
Task tool (general-purpose):
  description: "Implement Task N: [task name]"
  prompt: |
    You are implementing Task N: [task name]

    ## Task Description
    [FULL TEXT of task from phase spec — paste it here]

    ## Context
    [Scene-setting: where this fits in the Phase DAG]

    ## Before You Begin
    If you have questions about requirements, approach, dependencies, or anything unclear — **ask them now.**

    ## Your Job
    1. Implement exactly what the task specifies
    2. Write tests (following TDD)
    3. Verify implementation works
    4. Commit your work
    5. Self-review
    6. Report back

    ## When You're in Over Your Head
    It is always OK to stop and say "this is too hard for me."
    Report with BLOCKED or NEEDS_CONTEXT.

    ## Before Reporting Back: Self-Review
    - Completeness: Did I implement everything in the spec?
    - Quality: Is this my best work? Are names clear?
    - Discipline: Did I avoid overbuilding (YAGNI)?
    - Testing: Do tests verify behavior (not mocks)?

    ## Report Format
    - Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
    - What you implemented
    - What you tested and test results
    - Files changed
    - Self-review findings
    - Any issues or concerns
```

## Spec Compliance Reviewer Prompt

```
Task tool (general-purpose):
  description: "Review spec compliance for Task N"
  prompt: |
    You are reviewing whether an implementation matches its specification.

    ## What Was Requested
    [FULL TEXT of task requirements from the phase spec]

    ## CRITICAL: Do Not Trust the Report
    Verify everything independently. Read the actual code.

    **DO NOT:** Take their word, trust their claims, accept their interpretation
    **DO:** Read the code, compare to requirements line by line, check for missing pieces

    Report:
    - ✅ Spec compliant
    - ❌ Issues found: [list with file:line references]
```

## Code Quality Reviewer Prompt

```
Task tool (general-purpose):
  description: "Review code quality for Task N"
  prompt: |
    Review the implementation for code quality:
    - Correctness: edge cases, error states
    - Patterns: follows existing conventions
    - Performance: no N+1 queries, no unnecessary work
    - Security: input validation, no secrets, no injection
    - Testing: real behavior tests, edge case coverage
    - File organization: clear responsibilities, well-defined interfaces

    Report: Strengths, Issues (Critical/Important/Minor), Assessment
```

## 在 Meta-Harness 中的上下文

- 在 IMPLEMENT Phase 中使用，当 Phase spec 包含多个独立任务卡片时
- leaf-protocol（`task.json` / `result.json`）提供标准化接口
- 审查结果记录为运行的审计日志中的事件
- 这是复杂 IMPLEMENT Phase 的主要执行策略