# RESEARCH 契约：领域自学习（语义步骤，"先学习再生成"由你承担）

## 你的职责
当领域分类器把任务判为**陌生领域**（`complexity.novelty >= 3`）时，你不能只靠
参数化知识生成——必须先**上网学习该领域**，把学习结论写成本文件，用于修正
task.yaml（纠正 domain、解决 unknowns、校准验收标准）后再锁定标准与生成。

脚本保证结构（schema + 证据接地校验），你保证理解（真实研究，非幻觉）。

## 输入
1. 原始意图（`task.yaml` 的 `real_need` / `goal`）
2. 基线 `task.yaml`（domain / scale / complexity / unknowns / acceptance_criteria 等）

## 检查点
1. **领域确认/纠正**：核实基线 `domain` 是否准确。陌生领域给出准确的领域名——
   **不限于 5 个已知桶**（web_app/api_service/automation/data_pipeline/content_system），
   RESEARCH 正是未知领域离开桶词汇表的出口。
2. **学习领域知识**：检索该领域的标准、不变量、主流技术栈、常见失败模式、安全/合规
   要求。每条结论附真实来源（`source_url`）。
3. **解决 unknowns**：能把 task 里列的 unknowns 解决的，写进 `resolved_unknowns`
   （格式 `"Unknown -> Resolution"`）。
4. **验收标准校准**：必要时覆盖 `acceptance_criteria`，使其符合该领域真实可验证手段。

## 输出
写 `memory/research-findings.yaml`（schema 见 `schema.yaml`）：
- `domain` 必填（可纠正为任意领域名）
- `findings` 至少一条，且**至少一条带真实 http(s) `source_url`**（纯 assumption 不是研究）
- 每条 finding 要么带 `source_url` 要么 `assumption: true`
- `resolved_unknowns` 可选：`"Unknown -> Resolution"`
- `rationale` 说明每条改动的理由

## 完成后
```
python scripts/interpret.py --research memory/research-findings.yaml \
    --task task.yaml --output task.yaml
```
interpret.py 会做 schema 校验 + 证据接地校验后合并回写。校验失败 = 你的输出不合格。
