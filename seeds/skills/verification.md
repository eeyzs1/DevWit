# Verification Before Completion (Phase-Aware)

吸收自：union 框架 `skills/verification/SKILL.md`
默认 Phase：TEST + 在任何 Phase DONE 之前（以 `project.yaml` → `phase_skills` 为准）

## 核心原则

**证据先于声明，始终如此。声称工作完成而没有验证是不诚实，不是效率。**

<IRON-LAW>
没有全新的验证证据，不做任何完成声明
</IRON-LAW>

## Gate Function

在声明任何状态之前：
1. **IDENTIFY**：什么命令证明这个声明？
2. **RUN**：执行完整的命令（全新，完整）
3. **READ**：完整输出，检查退出码，计数失败
4. **VERIFY**：输出是否确认声明？
5. **ONLY THEN**：做出声明

## 常见失败

| 声明 | 需要 | 不够 |
|---|---|---|
| 测试通过 | 测试命令输出：0 失败 | 之前的运行，"应该通过" |
| 构建成功 | 构建命令：exit 0 | Linter 通过，"看起来不错" |
| Bug 修复 | 测试原始症状：通过 | 代码改了，"假设已修复" |
| Agent 完成 | VCS diff 显示变更 | Agent 报告"成功" |

## 红线 — STOP

- 使用"should", "probably", "seems to"
- 在验证前表达满意（"Great!", "Done!"）
- 即将提交/推送而没有验证
- 信任 agent 成功报告而没有独立检查
- "Just this once"

## Cleanliness 检查

在声明 Phase 完成前，运行：
- `build` — 必须 exit 0
- `typecheck` — 必须 exit 0
- `lint` — 必须 exit 0（或仅有预先存在的警告）
- `test` — 必须 exit 0（或预先存在的失败已证明无关）
- Debug prints 数量：新增行上的 `console.log|print(|fmt.Println`
- Session TODO/FIXME 数量：新增行上的 `TODO|FIXME|XXX`
- Dead imports：检查新 import 语句的使用情况

## Baseline Diff 检查

在声明 Phase 完成前，对比当前工作树与 Baseline ref：
- `git diff --name-status <baseline-ref> HEAD` — 列出所有变更文件
- 交叉对比 Phase spec 的 `deliverables` 列表
- **Expected** 变更 → 通过
- **Unexpected** 变更（不在任何 spec 的 deliverables 中）→ `AUDIT_GAP`
- 详细协议见 `seeds/verification/baseline-diff-check.md`

## 在 Meta-Harness 中的上下文

- 这是每个 `PHASE_DONE` 标记之前的门
- 引擎的 `PHASE_VERIFY` 块强制执行所有这些检查
- 非零 cleanliness 计数触发 3-strike，除非声明了 `Cleanliness override:`
- 最终审计对照原始 ROADMAP 重新运行所有验证检查