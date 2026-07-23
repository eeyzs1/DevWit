# Transcript Blocks — 标准化执行标记

吸收自：union 框架 `engine/transcript-blocks.md`
用途：所有生成 harness 项目的统一执行日志格式。Executor、Auditor、PROTOCOL.md 均引用此文件，不重复定义。

---

## Phase Execution Blocks

### PHASE_START (每个 Phase 开始时打印一次)

```
PHASE_START
Phase: <N> of <total> — <name>
Task: <one-line from spec>
Type: <greenfield|brownfield|bugfix|refactor|ui>
Mandatory commands: <comma-separated list>
Acceptance criteria: <count>
Skills loaded: <comma-separated list>
Depends on phases: <list, or "none">
```

### PHASE_VERIFY (每个 Phase 完成前、PHASE_DONE 之前打印)

```
PHASE_VERIFY
Acceptance:
- <criterion 1>: <pass|fail> — <evidence>
- <criterion 2>: <pass|fail> — <evidence>
...
Engineering:
- build: <pass|fail>
- typecheck: <pass|fail>
- lint: <pass|fail|pre-existing>
- tests: <pass|fail|N pre-existing>
Cleanliness (vs Baseline ref):
- debug prints added: <count>
- session TODO/FIXME added: <count>
- dead imports added: <count>
Files changed: <count>
Notable diffs:
- <file>: <one-line summary>
```

### MEMORY_SAVED (Phase 验证后、DONE 之前打印)

```
MEMORY_SAVED: <memory-name>     (or "none — nothing non-obvious this phase")
```

### PHASE_DONE (每个 Phase 结束时打印)

```
PHASE_DONE
Phase <N> complete. STATE.md updated.
```

---

## Failure Blocks (3-Strike Recovery)

### FAILURE_PROBE (Strike 1)

```
FAILURE_PROBE
Phase: <N> — <name>
Failed criterion: <text>
Tried: <what was attempted>
Hypothesis: <root cause guess>
Next: auto-retry with probe injected
```

### FAILURE_ESCALATE (Strike 2)

```
FAILURE_ESCALATE
Phase: <N> — <name>
Failed criterion: <text>
Retry probe history:
  attempt 1: <summary>
  attempt 2: <summary>
Writing fix spec at phases/phase-<N>.fix.md
```

### FAILURE_HANDOFF (Strike 3)

```
FAILURE_HANDOFF
Phase: <N> — <name>
Failed criterion: <text>
Three attempts tried:
  1. <summary>
  2. <summary>
  3. <fix spec summary>
Suggested next move: <one line>
STATE.md updated to BLOCKED. User intervention required.
```

---

## Audit Blocks

### AUDIT_START (每次审计轮次开始时打印)

```
AUDIT_START
Round: <1|2|3>
Phases to verify: <N>
Criteria to re-check: <count>
Commands to re-run: <comma-separated, deduplicated set>
```

### AUDIT_VERIFY (每次审计轮次结束时打印)

```
AUDIT_VERIFY
Per-phase completeness:
- Phase 1: <DONE present | DONE missing>
- Phase 2: ...
Re-run mandatory commands:
- <cmd>: exit <code> — <last line>
- ...
Acceptance criteria spot-check:
- Phase 1 / "<criterion>": <pass | fail | trust-prior-verify> — <evidence>
- ...
Deliverables (vs Baseline ref):
- Phase 1 / "<deliverable>": <present | missing> — <evidence>
- ...
Summary: <pass count> pass, <fail count> fail, <trust count> trust-prior, <missing count> deliverable-gaps
```

### AUDIT_GAPS (仅当发现缺口时打印)

```
AUDIT_GAPS
Round: <N>
Gaps:
- <gap 1>: <details>
- <gap 2>: <details>
Writing fix spec at phases/audit-fix-<N>.md, executing inline.
```

### AUDIT_COMPLETE (零缺口时打印)

```
AUDIT_COMPLETE
Rounds: <N>
Phases re-verified: <count>
Commands re-run clean: <count>
Acceptance criteria: <pass count> pass / 0 fail / <trust count> trust-prior
Deliverables: <present count> present / 0 missing
Audit coverage: <re_verified> re-verified / <trust> trust-prior (<pct>%)
```

### AUDIT_HANDOFF (3 轮审计全部失败时打印)

```
AUDIT_HANDOFF
Round: 3
Persistent gaps:
- <gap>
- ...
Three audit rounds attempted; fix specs at phases/audit-fix-{1,2,3}.md
Suggested next move: <one line>
STATE.md updated to BLOCKED.
```

---

## Run Completion

### RUN_COMPLETE (整个运行成功完成后打印)

```
RUN_COMPLETE
[⚠ Audit coverage: <re_verified> re-verified, <trust_prior> trust-prior (<pct>%). Eyeball UI/UX before merging.]   ← only when trust-prior fraction > 30%
Audit coverage: <re_verified> re-verified, <trust_prior> trust-prior (<pct>%).
All <N> phases complete. Audit passed in <rounds> round(s).
Summary: <5 lines max — what shipped, what changed, what to verify manually>
```

---

## Anti-Patterns

- Don't stuff long task content into the dispatch command. Put work in files.
- Don't make conditions the evaluator can't verify. "Tests pass" is wrong; "PHASE_DONE printed" is right.
- Don't skip evidence to save space. Files have no char budget.
- Don't skip the final audit. The audit closes the self-report loophole.