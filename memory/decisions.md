# Architecture Decision Records

## Purpose
Document WHY architectural decisions were made.
Agents need to understand context to make consistent decisions.

## Decisions

### ADR-001: Seven-Layer + Two Cross-Cutting Harness Architecture
- Date: 2026-04-14 (updated 2026-05-01)
- Context: Need agent-agnostic quality infrastructure that generates EXECUTABLE systems, not just documents
- Decision: Organize harness into 7 layers + 2 cross-cutting systems + self-evolution:
  - Layer 1: Context Engineering (AGENTS.md, context loader, knowledge index)
  - Layer 2: Tool Integration (schemas, sandbox, permissions, MCP)
  - Layer 3: Memory & State (session state, long-term memory, snapshots, compression)
  - Layer 4: Planning & Orchestration (DAG, flow control, sub-agents, budgets)
  - Layer 5: Verification & Guardrails (format validators, consistency, security, self-check)
  - Layer 6: Feedback & Self-Healing (error capture, retry, optimization loop, human interface)
  - Layer 7: Constraints & Entropy (architecture rules, enforcement, entropy reduction, cost)
  - Cross-cutting A: Security & Isolation (sandbox, encryption, audit)
  - Cross-cutting B: Observability & Governance (tracing, metrics, replay, versioning)
  - Self-Evolution: evidence-driven evolution with genome, fitness, mutations
- Alternatives: Single config file; prompt-only approach; 5-layer architecture (Identity, Constraints, Workflows, Verification, Memory); tool-specific setup
- Why: 5 layers were insufficient — they produced documentation, not executable systems. The 7+2+evolution architecture ensures every layer has concrete executable artifacts, not just markdown descriptions. Cross-cutting concerns (security, observability) span all layers and must be first-class.
- Consequences: More files and complexity, but each layer produces runnable artifacts. Generation pipeline must verify all layers have executable output.

### ADR-002: Mistake-Driven Constraint Evolution
- Date: 2026-04-14
- Context: Agents repeat the same mistakes across sessions
- Decision: Every mistake must produce a new or strengthened constraint
- Alternatives: Manual rule curation; ignoring mistakes; hoping agents learn
- Why: Without feedback loops, the harness degrades. With them, it compounds value over time.
- Consequences: Constraint set grows. Requires periodic pruning.

### ADR-003: Meta-Harness Self-Bootstrapping Architecture
- Date: 2026-04-14
- Context: Static harnesses require human setup for each new project/task type
- Decision: Build a meta-harness that generates task-specific harnesses from vague intent
- Alternatives: Manual harness creation per project; prompt-only approach; single generic harness
- Why: The real bottleneck isn't agent quality — it's harness setup time and expertise. A meta-harness eliminates both by compiling intent into infrastructure.
- Consequences: More complex system, but eliminates the human bottleneck. The meta-harness must be stable and self-improving.

### ADR-004: Compilation Pipeline (Interpreter → Generator → Factory → Orchestrator)
- Date: 2026-04-14
- Context: Need a deterministic process for turning vague intent into execution
- Decision: Four-stage compilation pipeline with clear inputs/outputs at each stage
- Alternatives: Single monolithic generation step; iterative refinement only
- Why: Each stage has a distinct responsibility. Separation enables independent improvement. Clear interfaces between stages enable debugging when generation fails.
- Consequences: More files to read, but each is focused. Pipeline can be extended at any stage.

### ADR-005: Template-Based Generation with Override
- Date: 2026-04-14
- Context: Generating from scratch every time is slow and error-prone
- Decision: Use domain templates as base, adapt to specific task requirements
- Alternatives: Always generate from scratch; rigid templates with no adaptation
- Why: Templates encode accumulated knowledge. Starting from a template is faster and more reliable than starting from zero. Adaptation ensures the harness fits the specific task.
- Consequences: Templates must be maintained. Bad templates produce bad harnesses. Template quality is a meta-concern that must be tracked.

### ADR-006: Self-Evolving Architecture with Meta-Evolution
- Date: 2026-04-14
- Context: Passive mistake-driven feedback is insufficient — the system only improves when it fails. No mechanism for proactive optimization.
- Decision: Add an evolution layer with three-tier genome (harness, agent, evolution rules) and A/B testing selection. The evolution genome itself can evolve (meta-evolution).
- Alternatives: Passive mistake-driven only; manual optimization; genetic algorithm without meta-evolution
- Why: Passive feedback is reactive. Evolution is proactive. Meta-evolution ensures the optimization process itself improves over time, preventing stagnation.
- Consequences: More complex system. Risk of destabilizing mutations. Mitigated by safety constraints (no removing verification, no removing evolution, mutation rate cap, reversibility).
