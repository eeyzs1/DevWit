# Example Generated Topologies

These are NOT templates to select. They illustrate what the generation algorithm
might produce for specific task types.

## Example A: Simple CRUD API
```
[Planner+Executor] → [Verifier]
Reasoning: Single domain, moderate complexity, reliability needed.
Planner and Executor merged (tight coupling, small context).
Verifier separate (independent assessment).
```

## Example B: Multi-Domain Data Platform
```
[Planner] → [Data Engineer] ──┐
           → [API Developer] ──┤→ [Integration Verifier] → [Deployer]
           → [Frontend Dev]  ──┘
Reasoning: Three independent domains, can parallelize.
Planner decomposes. Three specialists execute in parallel.
Integration Verifier checks cross-domain consistency.
```

## Example C: Content Generation Pipeline
```
[Researcher] → [Writer] → [Fact-Checker] → [Editor] → [Publisher]
Reasoning: Sequential stages, each transforms previous output.
Each stage is independent. Each stage validates previous stage.
```

## Example D: Monitoring System
```
[Planner] → [Rule Builder] → [Verifier]
           → [Alert Designer] → [Verifier]
                                              → [Integration Tester]
Reasoning: Two parallel work streams (rules + alerts).
Each stream has its own verifier.
Integration Tester validates the combined system.
```

## Example E: Solo Agent (rare)
```
[Planner+Executor+Verifier]
Reasoning: Task is small, low risk, single domain.
One agent does everything. Only used when quality requirements are low
and the task fits comfortably in a single session.
```
