# Writing Plans (Phase-Aware)

吸收自：union 框架 `skills/writing-plans/SKILL.md`
触发：PLAN Phase（brainstorming 之后）

## 核心原则

**编写全面的实现计划，假设工程师对我们的代码库零上下文且品味堪忧。** 记录他们需要知道的一切：每个任务涉及哪些文件、代码、测试、可能需要查阅的文档、如何测试。将整个计划作为小块任务提供。DRY。YAGNI。TDD。频繁提交。

假设他们是熟练的开发者，但几乎不了解我们的工具集或问题领域。假设他们不太了解良好的测试设计。

**开始时宣布：** "我正在使用 writing-plans 技能创建实现计划。"

**保存计划到：** `.meta-harness/runs/<id>/phases/phase-N/plan.md`

## Scope Check

如果 spec 覆盖多个独立子系统，应该在 brainstorming 期间拆分为子项目 spec。如果没有，建议拆分为单独的计划——每个子系统一个。每个计划应该独立产生可工作的、可测试的软件。

## 文件结构

在定义任务之前，映射哪些文件将被创建或修改以及每个文件的职责。

- 设计具有清晰边界和良好定义接口的单元。每个文件应该有一个明确的职责。
- 你最能推理你能一次性持在上下文中的代码，文件聚焦时编辑更可靠。偏好较小、聚焦的文件而非过大的文件。
- 一起变更的文件应该放在一起。按职责拆分，而非按技术层。
- 在现有代码库中，遵循既定模式。如果代码库使用大文件，不要单方面重构——但如果你正在修改的文件已经变得臃肿，在计划中包含拆分是合理的。

## 小块任务粒度

**每个步骤一个动作（2-5 分钟）：**
- "编写失败的测试" — 步骤
- "运行以确认失败" — 步骤
- "实现最小代码使测试通过" — 步骤
- "运行测试确认通过" — 步骤
- "提交" — 步骤

## 计划文档头部

**每个计划必须以这个头部开始：**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use Meta-Harness:subagent-driven-dev (recommended) or Meta-Harness:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## 任务结构

````markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## 禁止占位符

每个步骤必须包含工程师需要的实际内容。这些是**计划失败**——永远不要写：
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above"（没有实际测试代码）
- "Similar to Task N"（重复代码——工程师可能乱序阅读任务）
- 描述做什么但不展示如何做的步骤（代码步骤需要代码块）
- 引用未在任何任务中定义的类型、函数或方法

## 自我审查

写完完整计划后，以新眼光审视 spec 并对照检查计划：

1. **Spec 覆盖：** 浏览 spec 的每个部分/需求。你能指出一个实现它的任务吗？列出任何缺口。
2. **占位符扫描：** 搜索计划中的红旗——上述"禁止占位符"部分的任何模式。修复它们。
3. **类型一致性：** 后续任务中使用的类型、方法签名和属性名是否与前面任务中定义的一致？Task 3 中叫 `clearLayers()` 但 Task 7 中叫 `clearFullLayers()` 就是 bug。

如果发现问题，内联修复。无需重新审查——修完继续。

## 执行交接

保存计划后，提供执行选择：

**"计划完成，已保存到 `.meta-harness/runs/<id>/phases/phase-N/plan.md`。两种执行方式：**

**1. Subagent-Driven（推荐）** — 每任务派发一个全新的子代理，任务间审查，快速迭代

**2. Inline Execution** — 在当前会话中执行任务，使用 executing-plans，批量执行含检查点

**选择哪种方式？"**

## 在 Meta-Harness 中的上下文

- 此技能在 **PLAN** Phase 激活，在 `brainstorming` 产出 `spec.md` 之后
- 计划保存到 `.meta-harness/runs/<id>/phases/phase-N/plan.md`，成为后续 IMPLEMENT Phase 的主要输入
- 引擎的 Phase 转换逻辑读取计划来决定调用 `subagent-driven-dev`（多任务）还是 `executing-plans`（单会话回退）
- 计划中的任务复选框由引擎的进度监控器跟踪；完成所有任务触发 `PHASE_VERIFY` 门
- 计划的任务分解直接映射到派发子代理时的 `task.json` 产物
- 如果计划跨多个独立子系统，引擎可以通过 `dispatching-parallel-agents` 拆分到并行 IMPLEMENT 子 Phase