# Test-Driven Development (Phase-Aware)

吸收自：union 框架 `skills/tdd/SKILL.md`
默认 Phase：IMPLEMENT（以 `project.yaml` → `phase_skills` 为准）

## 核心原则

**先写测试。看它失败。写最小代码通过。**

<IRON-LAW>
没有失败的测试前，不写任何生产代码
</IRON-LAW>

## 何时激活

- 在任何 Meta-Harness 运行的 **IMPLEMENT** Phase 自动加载
- 可手动触发："use TDD", "write tests first"

## Red-Green-Refactor 循环

### RED — 写失败的测试
- 一个最小测试展示应该发生什么
- 清晰描述行为的名称
- 真实代码，最小 mock
- 必须在写代码前看到它 FAIL（不是 error）

### GREEN — 最小代码
- 写最简单的代码使测试通过
- 没有额外功能，没有"顺便"改进
- 运行测试：必须通过，所有其他测试必须仍然通过

### REFACTOR — 清理
- 仅在 green 之后：消除重复，改进命名，提取辅助函数
- 保持测试全程 green
- 不要添加行为

## 测试质量

| 好 | 坏 |
|---|---|
| `test('rejects empty email')` | `test('test1')` |
| 测试真实行为 | 测试 mock |
| 每个测试一个行为 | 名称中有"and" = 拆分 |
| 展示期望的 API | 模糊意图 |

## 常见合理化（及为什么错）

| 借口 | 现实 |
|---|---|
| "太简单，不需要测试" | 简单代码也会坏。测试只需 30 秒。 |
| "我之后再测试" | 事后测试立即通过 → 证明不了任何事。 |
| "已经手动测试过了" | 临时 ≠ 系统化。没有记录，无法重跑。 |
| "TDD 会拖慢我" | TDD 比在生产中调试更快。 |

## 在 Meta-Harness 中的上下文

- TDD 是所有 IMPLEMENT Phase 的默认实现方法
- 测试结果记录在 `phase-N/result.json` 作为证据
- 引擎的 cleanliness 检查会捕获未测试的代码（debug prints, dead imports）
- 如果 Phase 确实无法 TDD（如配置变更），在 Phase spec 中声明 `Skill override: no-tdd`