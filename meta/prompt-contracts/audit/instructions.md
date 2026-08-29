# AUDIT 契约：验证世界，不信自报（语义步骤，继承 auditor-engine.md）

## 你的职责
执行最终审计：**对照原始验收标准重新验证，而不是相信执行过程中的任何自述**。

## 输入
1. `task.yaml` 的 `acceptance_criteria`（真相）
2. 完整工作树（committed + staged + unstaged + untracked）
3. `memory/event-log.yaml`（账本，可读不可改）

## 审计步骤
1. **重跑强制命令**：取验证/测试命令的并集（`verification/run-tests.py`、`--verify`），
   逐个运行，记录真实 exit code。非零 → gap。
2. **抽查验收标准**：可自动验证的 → 重新检查（curl/测试/直接读代码）；主观的
   （"截图显示 X"）→ 标 `trust_prior`。
3. **交付物对照**：`git diff --name-status <baseline>`，缺失 → gap。
4. **最多 3 轮**：有 gap 则写修复说明重跑；第 3 轮仍有缺口 → `passed: false`。

## 输出
写 `memory/audit-report.yaml`（schema 见 `schema.yaml`）：
- `commands`：每条 `{command, exit}`（真实执行，不是声称）
- `criteria`：每条 `{criterion, verdict: pass|fail|trust_prior}`
- `gaps`：缺口清单；`passed`：零缺口且 `trust_prior` 占比 ≤ 30%
- `rounds`：实际轮数

## 完成后
```
python scripts/validate_contract.py --schema meta/prompt-contracts/audit/schema.yaml \
    --output memory/audit-report.yaml --log memory/event-log.yaml --project-root .
```
校验通过后，JUDGE 才会把审计作为 PROVEN 的证据来源。
