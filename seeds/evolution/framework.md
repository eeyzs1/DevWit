# Evolution Framework (Evidence-Driven)

## Purpose
Self-evolve based on EVIDENCE, not guesses. The evolution system itself also evolves.

## The Evolution Loop
```
Collect evidence → Measure fitness → Propose mutation → Test with evidence → Select or reject
                                                                                    ↓
                                                          Meta-evolution: evolve the evolution rules
```

## First Principle: No Evolution Without Evidence
Every mutation must be justified by evidence from the execution loop.
- Evidence = proof that something is broken or suboptimal
- No "I think this might be better" — only "evidence shows X is failing"

## Fitness Function (Evidence-Based)
```yaml
fitness:
  dimensions:
    - name: evidence_satisfaction_rate
      weight: 0.35
      measure: percentage of acceptance criteria with SATISFIED evidence
      evidence: traceability records from orchestrator

    - name: loop_efficiency
      weight: 0.25
      measure: average loops needed before all criteria are proven
      evidence: loop count from execution records

    - name: root_cause_hit_rate
      weight: 0.2
      measure: percentage of failures where root cause was correctly identified
      evidence: meta-mistakes with verified root causes

    - name: goal_drift_rate
      weight: 0.2
      measure: percentage of outputs that diverged from original need
      evidence: judge verdicts from execution loop
```

## Mutation Operators

### Constraint Mutations
- ADD: from mistake root cause analysis (evidence required)
- REMOVE: constraint that hasn't triggered AND has no evidence of preventing failures
- STRENGTHEN: when evidence shows constraint is too loose
- WEAKEN: when evidence shows constraint is too restrictive
- MERGE/SPLIT: when evidence shows redundancy or over-breadth

### Workflow Mutations
- INSERT_STEP: when evidence shows a gap causing failures
- REMOVE_STEP: when evidence shows step adds no value
- REORDER/PARALLELIZE: when evidence shows bottleneck

### Agent Mutations
- ADD_ROLE: when evidence shows one agent is overloaded
- REMOVE_ROLE: when evidence shows agent is underutilized
- MERGE/SPLIT/RESCOPE: when evidence shows scope misalignment

### Meta-Mutations (evolve the evolution system)
- ADJUST_FITNESS_WEIGHTS: when evidence shows wrong priorities
- ADJUST_MUTATION_RATE: when evidence shows too aggressive or too conservative
- ADD/REMOVE_MUTATION_OPERATOR: when evidence shows operator is needed or useless

## Selection: Evidence Required
Every mutation proposal must include:
1. What evidence triggered this mutation
2. What outcome the mutation is expected to produce
3. How to measure whether the mutation worked

Without all three, the mutation is REJECTED.

## Safety Constraints
- Never remove verification (cancer prevention)
- Never remove evolution itself (suicide prevention)
- Mutation rate ≤ 30% per generation (chaos prevention)
- All mutations reversible (previous genome preserved)
- Human can veto any mutation
