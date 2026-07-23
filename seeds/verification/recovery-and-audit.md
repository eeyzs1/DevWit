# 3-Strike Recovery + Final Audit Protocol

吸收自：union 框架 `engine/executor.md` 和 `engine/auditor.md`
用途：关闭 Phase 自报告和真实状态之间的漏洞

---

## Part 1: 3-Strike 失败恢复

### 概述

当某个 Phase 的验收标准未通过时，不立即放弃。遵循三级升级策略：

### Strike 1: 自动重试 (Auto-Retry)

1. 打印 `FAILURE_PROBE` 标记
2. 注入 probe 作为前导："Previous attempt failed because: …"
3. 使用相同的 Phase spec 重新执行
4. 如果通过 → 继续下一个 Phase
5. 如果仍然失败 → 进入 Strike 2

### Strike 2: 写 Fix Spec

1. 打印 `FAILURE_ESCALATE` 标记
2. 写 `phases/phase-<N>.fix.md`：
   - **只针对失败的标准**
   - **禁止范围蔓延**
   - 包含失败原因分析和具体的修复步骤
3. 内联执行 fix spec
4. 如果通过 → 继续下一个 Phase
5. 如果仍然失败 → 进入 Strike 3

### Strike 3: 交还用户

1. 打印 `FAILURE_HANDOFF` 标记
2. 更新 STATE.md 状态为 `BLOCKED`
3. 停止执行。用户接手。

**原则**：三次机会。第三次失败说明任务本身有问题（规格不清晰、范围太大、能力不够），不是执行问题。

---

## Part 2: Final Audit Protocol

### 概述

每个 Phase 的 VERIFY 是自报告。**审计的存在是为了关闭这个漏洞**：对照**原始 ROADMAP** 重新验证，而不是相信执行过程中的自我报告。

### 审计原则

1. **不相信自报告**：Phase VERIFY 说"passed"不等于真的 passed
2. **对照原始计划**：以 ROADMAP.md 为准，不是执行过程中的 STATE.md
3. **完整工作树对比**：检查 committed + staged + unstaged + untracked，不只是 commits
4. **最多 3 轮**：第 3 轮仍有缺口 → AUDIT_HANDOFF

### Round 1

#### A1. 打印 AUDIT_START
```
AUDIT_START
Round: 1
Phases to verify: <N>
Criteria to re-check: <count>
Commands to re-run: <deduplicated list>
```

#### A2. Phase 完整性检查
扫描 transcript 中每个 Phase 1..N 的 PHASE_DONE。缺失 → AUDIT_GAP。

#### A3. 重新运行强制命令
取所有 Phase 的强制命令的并集，去重，运行一次：
- build
- typecheck
- lint
- test

每个命令：记录 exit code 和最后 10 行输出。非零退出 → AUDIT_GAP。

#### A4. 抽查验收标准
对每个 Phase 的每条验收标准：
- **可自动验证的**（"文件 X 存在"、"函数 Y 导出"、"配置 Z 已设置"）→ 重新检查
- **主观的**（"截图显示 X"、"手动冒烟通过"）→ 标记 `trust-prior-verify`

#### A5. Deliverable 检查
对 ROADMAP.md 中每个 Phase 的 `**Deliverables:**` 列表：
- 对比完整工作树（committed + staged + unstaged + untracked）
- `missing` → AUDIT_GAP（"agent 说做了但没交付"）

#### A6. 打印 AUDIT_VERIFY
```
AUDIT_VERIFY
Per-phase completeness:
- Phase 1: DONE present
- Phase 2: DONE present
...
Re-run mandatory commands:
- build: exit 0 — <last line>
- test: exit 0 — 47 passed, 0 failed
...
Acceptance criteria spot-check:
- Phase 1 / "API returns 200": pass — curl verified
- Phase 1 / "UI looks correct": trust-prior-verify
...
Deliverables (vs Baseline ref):
- Phase 1 / "src/auth/login.ts": present — changed vs baseline
- Phase 2 / "tests/auth/login.test.ts": present — untracked new file
...
Summary: <pass> pass, <fail> fail, <trust> trust-prior, <missing> deliverable-gaps
```

### Round 2（如果 Round 1 有缺口）

1. 打印 `AUDIT_GAPS` 标记
2. 写 `audit-fix-<round>.md`：
   - 只针对失败的标准
   - 禁止范围蔓延
   - 用受影响 Phase 的原始 VERIFY 作为成功门
3. 内联执行 fix spec
4. 回到 Round 1（Round + 1）

### Round 3（如果 Round 2 仍有缺口）

同上。如果第 3 轮仍然失败 → `AUDIT_HANDOFF`，STATE.md 标记为 BLOCKED。

### 审计完成

如果某轮零缺口：
```
AUDIT_COMPLETE
Rounds: <N>
Phases re-verified: <count>
Commands re-run clean: <count>
Acceptance criteria: <pass> pass / 0 fail / <trust> trust-prior
Deliverables: <present> present / 0 missing
Audit coverage: <re_verified> re-verified / <trust> trust-prior (<pct>%)
```

然后打印 `RUN_COMPLETE`。

### 审计覆盖率计算

- `re_verified`：步骤 A4 中标记为 `pass` 的标准 + 步骤 A5 中标记为 `present` 的交付物
- `trust_prior`：步骤 A4 中标记为 `trust-prior-verify` 的标准
- `Audit coverage` = `re_verified / (re_verified + trust_prior)`

如果 `trust_prior / total > 30%`：在 RUN_COMPLETE 前打印警告横幅，提醒用户手动检查 UI/UX。

### Cleanliness 检查

在审计中，重新运行 cleanliness 检查（对比 Baseline ref 的完整工作树）：
- Debug prints 数量
- Session TODO/FIXME 数量
- Dead imports 数量

非零计数 → AUDIT_GAP（除非 Phase spec 声明了 `Cleanliness override:`）。

---

## 与生成模板的集成

harness-generator 在生成 Layer 5 (Verification & Guardrails) 时：
1. 从本模板复制 3-Strike Recovery 逻辑
2. 从本模板复制 Final Audit 逻辑
3. 将 transcript 标记格式引用到 `transcript-blocks.md`
4. 在 orchestrator.py 中实现 `--audit` 命令
5. 在 STATE.md 模板中添加 Failure Log 和 Audit Results 表