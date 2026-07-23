# {{PROJECT_NAME}} — {{RUN_NAME}}

**Run ID:** {{RUN_ID}}  
**Created:** {{TIMESTAMP}}  
**Baseline ref:** {{BASELINE_REF}}  
**Task type:** {{TASK_TYPE}}

---

## Goal

{{ONE_SENTENCE_GOAL}}

## Stack

{{STACK_SUMMARY}}

## Phases

| # | Phase | Depends on | Deliverables | Criteria |
|---|---|---|---|---|---|
| 1 | {{PHASE_1_NAME}} | none | {{PHASE_1_DELIVERABLES}} | {{PHASE_1_CRITERIA_COUNT}} |
| 2 | {{PHASE_2_NAME}} | 1 | {{PHASE_2_DELIVERABLES}} | {{PHASE_2_CRITERIA_COUNT}} |
| ... | ... | ... | ... | ... |

## Assumptions

{{ASSUMPTIONS_LIST}}

## Risks

1. **{{RISK_1}}** — Likelihood: {{LIKELIHOOD}}. Mitigation: {{MITIGATION}}
2. **{{RISK_2}}** — Likelihood: {{LIKELIHOOD}}. Mitigation: {{MITIGATION}}
3. **{{RISK_3}}** — Likelihood: {{LIKELIHOOD}}. Mitigation: {{MITIGATION}}

## Memory Applied

{{MEMORY_HITS}}

## Tools Required

{{TOOLS_REQUIRED}}

---

## Phase Details

### Phase 1: {{PHASE_1_NAME}}
**Why:** {{PHASE_1_WHY}}  
**Depends on:** none  

**Deliverables:**
- {{DELIVERABLE_1}}
- {{DELIVERABLE_2}}

**Acceptance Criteria:**
1. {{CRITERION_1}}
2. {{CRITERION_2}}
...

**Mandatory Commands:**
- `{{BUILD_COMMAND}}`
- `{{TYPECHECK_COMMAND}}`
- `{{LINT_COMMAND}}`
- `{{TEST_COMMAND}}`

**Skills:** brainstorming

### Phase 2: {{PHASE_2_NAME}}
**Why:** {{PHASE_2_WHY}}  
**Depends on:** Phase 1  

**Deliverables:**
- {{DELIVERABLE_1}}

**Acceptance Criteria:**
1. {{CRITERION_1}}
...

**Mandatory Commands:**
- `{{BUILD_COMMAND}}`
- `{{TEST_COMMAND}}`

**Skills:** tdd, subagent-driven-dev

... (repeat for each phase) ...

---

## Polish & Harden (always the last phase)

**Required sub-passes:**
1. UX & copy — every visible string, no debug placeholders
2. States — empty, loading, error, unauthorized for every new surface
3. Edges — empty inputs, very long inputs, special characters
4. Security — input validation, auth checks, no secrets in client bundles
5. A11y — keyboard navigation, focus states, screen reader labels, contrast
6. Perf — no N+1 queries, no megabyte bundles
7. Diff review — final git diff for stray debug logs, TODOs
8. Regression sweep — re-run full test suite