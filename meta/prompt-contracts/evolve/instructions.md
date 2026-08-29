# EVOLVE 契约：结构化变异提案（语义步骤，脚本只执行）

## 你的职责
当证据显示系统需要调整时，提交**结构化变异提案**。脚本（`scripts/evolve.py`）负责
快照/回滚/审批分级/执行——它不发明变异；你负责"改什么、为什么"。

## 输入
1. `scripts/evolve.py --project-root . --dry-run` 输出的证据与适应度
2. `evolution/genome.yaml`（当前基因组）

## 输出
写 `evolution/mutation-proposals.yaml`（schema 见 `schema.yaml`）。每条变异必须带
`evidence_refs`（引用 `event:<seq>` / `file:<path>` 等真实证据）；`WEAKEN_CONSTRAINT`
自动归为 NEEDS_APPROVAL（脚本处理，无需你自行避免）。

## 完成后
```
python scripts/evolve.py --project-root . --proposals evolution/mutation-proposals.yaml
```
脚本校验 schema + 证据溯源后走既有审批分级与快照/回滚流程。
