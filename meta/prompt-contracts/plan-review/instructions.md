# PLAN-REVIEW 契约：语义计划评审（advisory，入日志）

## 你的职责
对 agent 的**实施计划**做语义评审（advisory）。机械门禁由 `guard.py --scan`（对真实代码
扫描）承担；本步骤只回答一个语义问题：**这个计划是否真的尊重架构约束与领域约束？**

## 输出
写 `memory/plan-review.yaml`（schema 见 `schema.yaml`）：`APPROVED` 或 `CONCERNS` +
`concerns[]` 清单 + 可选的 `evidence_refs`（引用架构规则文件 `file:constraints/architecture-rules.yaml`
等）。

## 性质
- 本输出是 advisory：`CONCERNS` 不机械阻塞，但会写入事件日志（`error/recorded`），
  供 JUDGE/审计追溯"计划阶段已警告"。
- 不做 → 不阻塞；做了 → 必须符合 schema（`validate_contract.py`）。
