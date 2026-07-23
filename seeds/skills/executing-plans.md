# Executing Plans (Phase-Aware)

吸收自：union 框架 `skills/executing-plans/SKILL.md`
触发：IMPLEMENT Phase（当 subagent-driven-dev 不可用时）

## 核心原则

**加载计划，批判性审查，执行所有任务，完成后报告。**

**开始时宣布：** "我正在使用 executing-plans 技能实现此计划。"

**注意：** 告知用户 Meta-Harness 在支持子代理的平台上工作效果更好。如果子代理可用，优先使用 subagent-driven-dev。

## 流程

### Step 1: 加载并审查计划
1. 从 `.meta-harness/runs/<id>/phases/phase-N/plan.md` 读取计划文件
2. 批判性审查——识别关于计划的任何问题或疑虑
3. 如有疑虑：在开始前向用户提出
4. 如无疑虑：创建 TodoWrite 并继续

### Step 2: 执行任务

对每个任务：
1. 标记为 in_progress
2. 严格按照每个步骤执行（计划有分块步骤）
3. 按指定运行验证
4. 标记为 completed

### Step 3: 完成开发

所有任务完成并验证后：
- 宣布："我正在使用 finishing-a-development-branch 技能完成此工作。"
- **REQUIRED SUB-SKILL:** 使用 Meta-Harness:finishing-a-development-branch

## 何时停止并求助

**立即停止执行当：**
- 遇到阻塞（缺少依赖、测试失败、指令不清晰）
- 计划有关键缺口阻止开始
- 不理解某个指令
- 验证反复失败

**请求澄清而非猜测。**

## 在 Meta-Harness 中的上下文

- 这是 IMPLEMENT Phase 的**回退执行策略**，当 `subagent-driven-dev` 不可用时使用（如当前平台不支持子代理）
- 计划从 `.meta-harness/runs/<id>/phases/phase-N/plan.md` 加载，由 `writing-plans` 在 PLAN Phase 产出
- 任务进度通过 TodoWrite 跟踪，反映在引擎的运行状态中
- 所有任务通过验证后，引擎转换到 TEST Phase
- 如果执行遇到阻塞，引擎记录为 `BLOCKED` 事件
- 此技能**不**派发并行代理——对于独立多领域工作，改用 `dispatching-parallel-agents`