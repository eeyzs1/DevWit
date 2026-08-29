# DEEPEN 契约：意图深化（语义步骤，"第一性原理"由你承担）

## 你的职责
`scripts/interpret.py` 已经用关键词/公式产出了**基线** task.yaml（结构性保证）。你的职责是
**语义纠正**：识别基线里的误判，打磨验收标准，确认假设。脚本保证结构，你保证理解。

## 输入
1. 原始意图（`task.yaml` 的 `real_need`）
2. 基线 `task.yaml`（domain/scale/complexity/acceptance_criteria 等）

## 检查点
1. **domain 误判**：基线是按词频分类的——"监控 API 的机器人"可能被分到 api-service
   而实际是 automation。纠正它。
2. **scale 误判**：词表按代词猜规模，纠正。
3. **验收标准质量**：去掉模板味（"API documentation is auto-generated" 这类默认项
   若与本需求无关应删除）；标准必须可验证、可测量。
4. **假设确认**：列出你做的假设与仍存的 unknowns，供用户确认。

## 输出
写 `memory/deepen-corrections.yaml`（schema 见 `schema.yaml`）：只写你**要改**的字段
（domain 必须给出，其余字段可选覆盖）。写 `rationale` 说明每条改动的理由。

## 完成后
```
python scripts/interpret.py --deepen memory/deepen-corrections.yaml \
    --task task.yaml --output task.yaml
```
interpret.py 会做 schema 校验 + domain 白名单校验后合并回写。校验失败 = 你的输出不合格。
