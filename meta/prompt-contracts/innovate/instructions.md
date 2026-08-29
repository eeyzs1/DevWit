# INNOVATE 契约：推陈出新（语义步骤）

## 你的职责
基于**机械事实**提出下一阶段的创新提案。你不是从预写清单里翻页——`domain-advancements.yaml`
只是**示例库**（参考方向），不是真相源；真相是 `evolution/product-analyzer.py` 输出的
`kind: fact` 事实。

## 输入
1. `python evolution/product-analyzer.py --project-root .` 的机械事实输出（结构/端点/
   模型/测试数/覆盖率——这些是"事实"，不是"结论"）
2. 当前阶段（由事实推导：空产品 = Basic；有测试且文件多 → Solid/Advanced）
3. `evolution/domain-advancements.yaml`（示例库，仅参考措辞/分类）

## 输出
写 `evolution/innovation-proposals.yaml`（schema 见 `schema.yaml`）。每条提案：
- 必须能引用至少一个事实：`file:<path>`（源码文件）或 `event:<seq>`；无法引用任何
  事实的必须显式 `assumption: true`（标注为假设，否则引擎拒收）。
- `effort`/`impact` 如实评估；`effort: high` 或 `category: security` 的提案会被标记
  `requires_approval`（引擎处理），你不需要自行过滤。

## 完成后
```
python scripts/validate_contract.py --schema meta/prompt-contracts/innovate/schema.yaml \
    --output evolution/innovation-proposals.yaml --log memory/event-log.yaml --project-root .
```
然后由 `evolution/innovation-engine.py` 校验、分级、记录。没有契约输出 = 没有创新提案。
