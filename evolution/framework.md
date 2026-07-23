# Evolution Framework v1.0

## Purpose
Self-evolve the meta-harness and generated projects based on evidence and fitness metrics.

## Process
1. Collect evidence from all previous phases (PROVE, JUDGE)
2. Measure fitness score against acceptance criteria
3. Propose mutations (max 30% change rate)
4. Apply accepted mutations
5. Log to evolution/log.yaml

## Fitness Metrics
- Criteria satisfaction rate: verified_criteria / total_criteria
- Generation quality: verification pass rate
- Pipeline efficiency: phases completed without errors
- Self-improvement delta: fitness improvement since last evolution

## Mutation Rules
- Max 30% of files changed per evolution cycle
- Mutations must be traceable to a fitness gap
- Reversible: each mutation logged with rollback path
- No mutation to AGENTS.md or meta/meta-orchestrator.py (core stability)

## Output
- evolution/log.yaml: mutation history
- evolution/genome.yaml: current configuration genome
- evolution/fitness-report.yaml: current fitness scores