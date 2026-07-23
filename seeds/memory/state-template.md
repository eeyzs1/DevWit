# {{RUN_ID}} — State

**Run ID:** {{RUN_ID}}  
**Created:** {{TIMESTAMP}}  
**Last update:** {{TIMESTAMP}}  
**Status:** {{STATUS}}  
**Baseline ref:** {{BASELINE_REF}}  

---

## Phase Progress

| # | Phase | Status | Started | Completed | Verdict |
|---|---|---|---|---|---|
| 1 | {{PHASE_1_NAME}} | {{pending\|in_progress\|completed\|blocked}} | — | — | — |
| 2 | {{PHASE_2_NAME}} | pending | — | — | — |
| ... | ... | ... | ... | ... | ... |

**Current phase:** {{CURRENT_PHASE}}  
**Total phases:** {{TOTAL_PHASES}}

---

## Failure Log

| Phase | Attempt | Criterion | Probe | Resolution |
|---|---|---|---|---|
| — | — | — | — | — |

---

## Audit Results

| Round | Gaps | Fix Spec | Outcome |
|---|---|---|---|
| — | — | — | — |

---

## Events

- {{TIMESTAMP}}: Run created. Baseline ref captured.
- {{TIMESTAMP}}: Phase 1 started.
- {{TIMESTAMP}}: Phase 1 complete. Verdict: PASS.
- ...

---

## Status Values

- `READY` — planning complete, awaiting dispatch
- `IN_PROGRESS` — phases are executing
- `BLOCKED` — a phase has hit FAILURE_HANDOFF or AUDIT_HANDOFF
- `COMPLETE` — RUN_COMPLETE printed, audit passed
- `ABANDONED` — user explicitly stopped