# Postmortem NNNN: <short-slug>

> Written by `feedback/mistake-to-constraint.py` when a failure is recorded.
> The interesting part is WHY THE PROCESS LET IT THROUGH, not the one-line fix.

## Executive Summary

- **What broke**: <what failed, one paragraph in plain terms>
- **Root cause**: <the actual root cause, not the symptom>
- **Why it escaped the gates**: <which gate should have caught it and why it did not
  — if no gate covered this class of failure, say so explicitly>
- **Durable lesson**: <one sentence a future run can act on>

## Timeline

- <when> <what happened>

## Root Cause

<detailed root cause analysis>

## Guardrails

- [ ] <constraint that will make this class of failure fail loudly next time>
      (linked constraint: `constraints/architecture-rules.yaml` rule C00N)

## Evidence

- `memory/event-log.yaml` mistake/recorded event seq: <N>
- Evidence reference: <file/log/run>
