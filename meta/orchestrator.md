# Meta-Orchestrator: Loop Execution + Evidence Traceability

## Purpose
Execute work in a LOOP, not a single pass. After execution, PROVE the output
satisfies the original need. If not proven, diagnose root cause and loop back.

Orchestrates execution across all 7 layers + 2 cross-cutting systems of the
generated harness project.

## The Execution Loop

```
EXECUTE → PROVE → JUDGE ──→ NOT PROVEN → diagnose root cause → loop back
                  ↓
                PROVEN → EVOLVE → STOP
```

## Process

1. **Build Dependency Graph**: Map task dependencies using `planning/dag-builder.py`
2. **Assign Agents**: One primary agent per task via `planning/sub-agent-dispatch.yaml`
3. **Load Context**: Assemble relevant context via `context/loader.py`
4. **Define Checkpoints**: Verify between every dependency boundary using `verification/self-check.py`
5. **Execute**: Run the plan within generated harness, respecting `planning/budget.yaml`
6. **Prove**: For EACH acceptance criterion, produce evidence
7. **Judge**: Does evidence prove the need is satisfied?
8. **Loop or Stop**: If not proven → root cause → loop. If proven → evolve.

## Layer Integration

The orchestrator coordinates all layers during execution:

| Layer | Role in Orchestration | Key Artifact |
|---|---|---|
| 1. Context | Loads relevant context per task | `context/loader.py` |
| 2. Tools | Provides tool access per permissions | `tools/permissions.yaml` |
| 3. Memory | Tracks progress, checkpoints, snapshots | `memory/session-state.yaml`, `memory/snapshot.py` |
| 4. Planning | Builds DAG, dispatches agents, controls flow | `planning/dag-builder.py`, `planning/flow-control.yaml` |
| 5. Verification | Validates outputs, runs self-check loop | `verification/self-check.py`, `verification/consistency-check.py` |
| 6. Feedback | Captures errors, retries, escalates | `feedback/error-capture.py`, `feedback/retry-config.yaml` |
| 7. Constraints | Enforces architecture rules, budgets | `constraints/architecture-rules.yaml`, `constraints/cost-budget.yaml` |
| Security | Isolates execution, audits actions | `security/sandbox-config.yaml`, `security/audit-log.yaml` |
| Observability | Traces execution, records metrics | `observability/tracing.yaml`, `observability/session-replay.yaml` |

## Evidence Traceability (Critical)

Every output must trace back to a specific acceptance criterion with evidence.

### Evidence Format
```yaml
criterion: [from interpreter's acceptance_criteria]
evidence:
  type: [test_result|working_output|measurable_metric|demonstration]
  description: [what proves this criterion is met]
  location: [where to find the evidence]
  verdict: SATISFIED | NOT_SATISFIED
```

### Evidence Must Be:
- **Specific**: Not "it works" but "test X passes with output Y"
- **Verifiable**: Someone else could check the same evidence
- **Traceable**: Directly linked to an acceptance criterion

### If Evidence Cannot Be Produced:
The criterion is NOT met. Do NOT mark it as satisfied.
Diagnose root cause and loop back.

## Error Handling (Root Cause, Not Symptoms)

- **Timeout**: Why did it timeout? → scope too large? → split task
- **Verification Failure**: Why did it fail? → wrong approach? → redesign
- **Hallucination**: Why did agent go off-scope? → constraint gap? → add constraint
- **Goal Drift**: Why did output diverge from need? → unclear criteria? → re-interpret

Every error must answer "WHY did this happen at the root level?"
Never patch symptoms. Never add try/catch to hide errors.

## Error → Constraint Loop

When an error occurs:
1. Capture with `feedback/error-capture.py`
2. Classify error type and root cause
3. Apply retry strategy from `feedback/retry-config.yaml`
4. If retry fails, run `feedback/mistake-to-constraint.py` to propose new constraint
5. Add constraint to `constraints/architecture-rules.yaml`
6. Log to `memory/meta-mistakes.md`
7. If human approval needed, use `feedback/human-interface.yaml`

## Anti-Patterns
- No single-pass execution — always loop until proven
- No "I think it's done" — only evidence proves completion
- No symptom patching — always chase root causes
- No skipping the PROVE step — it's not optional
- No layer bypass — every layer participates in orchestration
