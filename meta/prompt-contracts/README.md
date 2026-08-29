# Prompt Contract Registry — 语义步骤的"脚手架 → LLM 填槽 → 机械验证"模式

每个语义阶段（需要理解能力的步骤）都必须走契约：脚本出机械脚手架，LLM（执行管道的
agent）按 `instructions.md` 的提示词契约产出结构化输出，`scripts/validate_contract.py`
做机械验证（schema + 证据溯源，fail-closed）。**没有契约输出 = 该步骤未执行 = 门禁拒绝推进。**

| 步骤 | 契约目录 | LLM 产出文件 | 消费方 |
|---|---|---|---|
| JUDGE 证据裁决 | `judge/` | `memory/judgment-report.yaml` | `scripts/judge.py` |
| AUDIT 审计 | `audit/` | `memory/audit-report.yaml` | judge / orchestrator |
| INNOVATE 推陈出新 | `innovate/` | `evolution/innovation-proposals.yaml` | `seeds/evolution/innovation-engine.py` |
| DEEPEN 意图深化 | `deepen/` | `memory/deepen-corrections.yaml` | `scripts/interpret.py --deepen` |
| PLAN-REVIEW 计划评审 | `plan-review/` | `memory/plan-review.yaml` | guard（advisory） |
| EVOLVE 变异提案 | `evolve/` | `evolution/mutation-proposals.yaml` | `scripts/evolve.py --proposals` |

验证命令：
```
python scripts/validate_contract.py --schema meta/prompt-contracts/<step>/schema.yaml \
    --output <LLM产出文件> --log <event-log.yaml> --project-root <dir>
```

铁律：
1. 每条 `evidence_ref` 必须可溯源（`event:<seq>` / `verify:<name>` / `test:<name>` /
   `audit:<round>` / `artifact:<key>` / `file:<path>`），伪造引用 → 拒收。
2. 脚本永远不假装语义判断；LLM 永远不无契约自由发挥。
3. 校验失败 = agent 按提示词修复后重跑（与 GENERATE 槽位验证同构），绝不静默放过。
