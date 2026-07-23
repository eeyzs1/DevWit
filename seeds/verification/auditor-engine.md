# Auditor Engine — 审计引擎种子

吸收自：union 框架 `engine/auditor.md`
用途：最终审计协议 — 关闭 Phase 自报告和真实状态之间的漏洞

---

## 概述

每个 Phase 的 VERIFY 是自报告。审计的存在是为了关闭这个漏洞：对照**原始 ROADMAP** 重新验证，而不是相信执行过程中的自我报告。

---

## 审计原则

1. **不相信自报告**：Phase VERIFY 说"passed"不等于真的 passed
2. **对照原始计划**：以 ROADMAP.md 为准，不是执行过程中的 STATE.md
3. **完整工作树对比**：检查 committed + staged + unstaged + untracked，不只是 commits
4. **最多 3 轮**：第 3 轮仍有缺口 → AUDIT_HANDOFF

---

## 审计步骤

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
- build / typecheck / lint / test
每个命令记录 exit code 和最后 10 行输出。非零退出 → AUDIT_GAP。

#### A4. 抽查验收标准
对每个 Phase 的每条验收标准：
- 可自动验证的 → 重新检查
- 主观的（"截图显示 X"、"手动冒烟通过"）→ 标记 `trust-prior-verify`

#### A5. Deliverable + Baseline Diff 检查
对 ROADMAP.md 中每个 Phase 的 Deliverables 列表：
- 运行 `repo-state.sh deliverable <baseline-ref> "<path>"`
- 对比完整工作树（committed + staged + unstaged + untracked）
- `missing` → AUDIT_GAP

**Baseline Diff 检查**（见 `seeds/verification/baseline-diff-check.md`）：
- 运行 `git diff --name-status <baseline-ref> HEAD`
- 交叉对比所有 Phase spec 的 `deliverables` 列表
- 标记 expected vs unexpected 变更
- Unexpected 变更（不在任何 Phase spec 中）→ AUDIT_GAP

#### A6. 打印 AUDIT_VERIFY
```
AUDIT_VERIFY
Per-phase completeness:
- Phase 1: DONE present
...
Re-run mandatory commands:
- build: exit 0 — <last line>
...
Acceptance criteria spot-check:
- Phase 1 / "API returns 200": pass — curl verified
- Phase 1 / "UI looks correct": trust-prior-verify
...
Deliverables (vs Baseline ref):
- Phase 1 / "src/auth/login.ts": present — changed vs baseline
...
Summary: <pass> pass, <fail> fail, <trust> trust-prior, <missing> deliverable-gaps
```

### Round 2（如果 Round 1 有缺口）

#### B1. 打印 AUDIT_GAPS
```
AUDIT_GAPS
Round: 1
Gaps:
- Phase 2 / "API returns 200": curl returned 500
- Phase 3 / "src/ui/Modal.tsx": missing from working tree
Writing fix spec at phases/audit-fix-1.md, executing inline.
```

#### B2. 写 Fix Spec
`audit-fix-<round>.md`：只针对失败的标准，禁止范围蔓延，用受影响 Phase 的原始 VERIFY 作为成功门。

#### B3. 执行 Fix Spec
内联执行（同一 agent，同一 session）。

#### B4. 回到 A1（Round + 1）

### Round 3（如果 Round 2 仍有缺口）
同上。如果第 3 轮仍然失败：
```
AUDIT_HANDOFF
Round: 3
Persistent gaps: <list>
Three audit rounds attempted. STATE.md updated to BLOCKED.
```

---

## 审计完成

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

然后打印 RUN_COMPLETE：
```
RUN_COMPLETE
[⚠ Audit coverage: ... if trust-prior > 30%]
All <N> phases complete. Audit passed in <rounds> round(s).
Summary: <what shipped, what changed, what to verify manually>
```

---

## 审计覆盖率

- `re_verified`：步骤 A4 中标记为 `pass` 的标准 + 步骤 A5 中标记为 `present` 的交付物
- `trust_prior`：步骤 A4 中标记为 `trust-prior-verify` 的标准
- `Audit coverage` = `re_verified / (re_verified + trust_prior)`
- 如果 `trust_prior / total > 30%`：在 RUN_COMPLETE 前打印警告横幅

---

## Cleanliness 检查

在审计中重新运行 cleanliness 检查（对比 Baseline ref 的完整工作树）：
- Debug prints 数量
- Session TODO/FIXME 数量
- Dead imports 数量
非零计数 → AUDIT_GAP（除非 Phase spec 声明了 `Cleanliness override:`）。

---

## 与其他组件的关系

- **Executor**：审计在 Executor 的最后一个 Phase 完成后运行
- **Planner**：审计以 Planner 产出的 ROADMAP.md 为准
- **Skills**：审计中的 fix spec 执行可以使用 systematic-debugging 技能
- **Adapters**：审计可以触发 CI adapter 的运行（如果配置了）