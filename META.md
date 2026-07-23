# META-HARNESS: Self-Bootstrapping Agent Infrastructure

## What This Is
A meta-harness that GENERATES complete, runnable, self-evolving harness engineering projects.
It does NOT do the work itself — it produces executable systems that do the work.
First principles driven. Evidence based. Never stops at one pass.

See AGENTS.md for the execution pipeline.

## Architecture: 7 Layers + 2 Cross-Cutting + Self-Evolution + Innovation

Every generated harness project MUST have all of these layers with executable artifacts:

| Layer | Directory | Purpose | Key Artifacts |
|---|---|---|---|
| 1. Context Engineering | `context/` | Project context, knowledge index, dynamic loading | `loader.py`, `knowledge-index.yaml` |
| 2. Tool Integration | `tools/` | Tool schemas, sandbox, permissions, MCP, tool discovery | `schemas.yaml`, `sandbox.yaml`, `permissions.yaml`, `tool-discovery.py` |
| 3. Memory & State | `memory/` | Session state, long-term memory, snapshots, compression | `snapshot.py`, `session-state.yaml`, `compression-rules.yaml` |
| 4. Planning & Orchestration | `planning/` | DAG builder, flow control, sub-agent dispatch, budgets | `dag-builder.py`, `flow-control.yaml`, `sub-agent-dispatch.yaml`, `budget.yaml` |
| 5. Verification & Guardrails | `verification/` | Format validators, consistency checks, anti-mock, quality gate, self-check | `consistency-check.py`, `self-check.py`, `anti-mock-check.py`, `quality-gate.py`, `security-guardrails.yaml` |
| 6. Feedback & Self-Healing | `feedback/` | Error capture, retry, mistake→constraint, human interface | `error-capture.py`, `mistake-to-constraint.py`, `retry-config.yaml` |
| 7. Constraints & Entropy | `constraints/` | Architecture rules, linter config, entropy reduction, cost | `entropy-reduction.py`, `architecture-rules.yaml`, `cost-budget.yaml` |
| Cross-cutting A: Security | `security/` | Sandbox, encryption, audit | `sandbox-config.yaml`, `encryption-rules.yaml`, `audit-log.yaml` |
| Cross-cutting B: Observability | `observability/` | Tracing, metrics, replay, versioning | `tracing.yaml`, `metrics-dashboard.yaml`, `session-replay.yaml`, `versioning.yaml` |
| Cross-cutting C: Anti-Mock | `verification/` | Mock detection, simulation prevention, real integration enforcement | `anti-mock-check.py`, mock patterns in guard.py |
| Cross-cutting D: Quality Gate | `verification/` | Engineering-grade vs prototype enforcement, code quality standards | `quality-gate.py`, simplification patterns in guard.py |
| Self-Evolution | `evolution/` | Evidence-driven evolution with genome and fitness | `framework.md`, `genome.yaml`, `log.yaml` |
| Innovation | `evolution/` | Post-requirement innovation engine (推陈出新) including tool diversity | `innovation-engine.py`, `product-analyzer.py`, `domain-advancements.yaml` |
| Enforcement (Root) | `./` | Entry points and mandatory pre-action guard | `orchestrator.py`, `guard.py`, `AGENTS.md`, `CLAUDE.md` |

## Enforcement System

Every generated project MUST have these root-level enforcement scripts:

### guard.py — Pre-Action Constraint Guard
Runs BEFORE any code change. Validates planned actions against architecture rules (layer access, dependency direction), detects mock patterns (mock, fake, stub, simulated, placeholder) and simplification patterns (hardcode, skip validation, no error handling). Returns PASS or BLOCKED. Must verify orchestrator has been run first.

### orchestrator.py — Active Execution Engine
THE entry point. Tracks progress against criteria. `--status` shows current state. `--verify` runs full suite (anti-mock + quality-gate + self-check + consistency). `--mark-complete` requires verification pass before allowing. `--evolve` and `--innovate` activate after all criteria met.

### quality-gate.py — Engineering Quality Gate
Runs BEFORE marking any task complete. Enforces config-vs-hardcode, error handling, input validation, tests, docs, secrets, edge cases. Returns PASS or FAIL.

### anti-mock-check.py — Mock Detection Engine
Runs during verification. Scans source for mock patterns (`Mock*`, `Fake*`, `Stub*`, `Dummy*`, simulated returns, placeholder data). Returns PASS or FAIL with file paths and line numbers.

## Innovation Engine: 推陈出新

After all acceptance criteria are met, the innovation engine activates:

1. **Product State Analyzer** scans `src/` for implemented features, endpoints, models, tests
2. **Domain Advancement Patterns** define four stages per domain: Basic → Solid → Advanced → Excellent
3. **Innovation Engine** proposes next-stage innovations, prioritized by impact/effort
4. High-effort or security innovations require human approval

## Four-Stage Advancement Model

| Stage | Meaning | Web App Examples | API Service Examples |
|-------|---------|-----------------|---------------------|
| Basic | Meets requirements | Core features, basic tests | CRUD endpoints, validation |
| Solid | Production-ready | Error boundaries, loading states, pagination | Rate limiting, health checks, logging |
| Advanced | Competitive quality | Offline support, dark mode, search | Cursor pagination, webhooks, caching |
| Excellent | Market-leading | Real-time collaboration, a11y, i18n | GraphQL, event sourcing, circuit breakers |

## Directory Structure
```
AGENTS.md                  ← Auto-loaded by Trae (primary entry point)
CLAUDE.md                  ← Auto-loaded by Claude Code
META.md                    ← You are here. Full specification.
meta/
  interpreter.md           ← Intent → Structured Task (first principles)
  harness-generator.md     ← Task → Executable Harness Project (7+2+evolution)
  agent-factory.md         ← Harness → Agent Topology (generated, not selected)
  orchestrator.md          ← Loop execution + evidence traceability across all layers
  examples/
    topologies.md          ← Example generated topologies
evolution/                 ← Meta-level evidence-driven self-evolution
  framework.md             ← Evolution algorithm (evidence-based)
                             (genome.yaml / log.yaml live in seeds/evolution/ as generation seeds)
templates/                 ← Domain templates (Generation Factory format)
  web-app/template.md      ← Each template specifies per-layer executable artifacts
  api-service/template.md
  automation/template.md
  data-pipeline/template.md
  content-system/template.md
seeds/                     ← Seed artifacts for each layer (copied by generate.py)
  context/                 ← loader.py, knowledge-index.yaml
  tools/                   ← schemas.yaml, sandbox.yaml, permissions.yaml, mcp-config.json, tool-discovery.py
  memory/                  ← snapshot.py, compression-rules.yaml
  planning/                ← dag-builder.py, flow-control.yaml, sub-agent-dispatch.yaml, budget.yaml
  verification/            ← consistency-check.py, security-guardrails.yaml, self-check.py, anti-mock-check.py, quality-gate.py
  feedback/                ← error-capture.py, retry-config.yaml, mistake-to-constraint.py, human-interface.yaml
  constraints/             ← architecture-rules.yaml, linter-config.yaml, entropy-reduction.py, cost-budget.yaml
  security/                ← sandbox-config.yaml, encryption-rules.yaml, audit-log.yaml
  observability/           ← tracing.yaml, metrics-dashboard.yaml, session-replay.yaml, versioning.yaml
  evolution/               ← framework.md, genome.yaml, log.yaml, innovation-engine.py, product-analyzer.py, domain-advancements.yaml
  orchestrator.py          ← Entry point for generated projects
  guard.py                 ← Pre-action constraint guard (mock + simplification + tool diversity checks)
scripts/                   ← Executable scripts (cross-platform Python)
  generate.py              ← Core generation pipeline: task → complete harness project
  verify-generation.py     ← Verify 7+2+evolution layer completeness of generated projects
  evolve.py                ← Evidence-driven evolution engine
  verify.py                ← Post-task verification (lint, typecheck, test, secrets)
  pre-task.py              ← Pre-task checks (task card, git status, blockers)
  quality-score.py         ← Harness quality metrics
generated/                 ← Output: generated harness projects (git-ignored)
memory/                    ← Meta-level memory (compounds over time)
  decisions.md             ← Architecture Decision Records
  generation-log.yaml      ← Generation history (maintained by generate.py, human & machine readable)
  meta-mistakes.md         ← Meta-harness mistake log
  progress.md              ← Cross-session progress tracking
  task-patterns.md         ← Known task pattern catalog
```

## Meta-Rules (Architecture-Level)
1. No execution without interpretation
2. No agent without a harness
3. No constraint without a reason
4. No completion without EVIDENCE — output must prove it satisfies the original need
5. No single-pass execution — the loop continues until evidence proves success
6. No patching symptoms — always chase root causes
7. Generate EXECUTABLE systems, not just documents — every layer must have concrete artifacts
8. Every generated layer must have concrete artifacts — no empty or doc-only layers
9. Every generation is logged (memory/generation-log.yaml)
10. Every failure improves the meta (with root cause analysis)
11. The meta-harness follows its own rules (do as I say AND as I do)
12. Evolution never removes verification (cancer prevention)
13. Evolution never removes itself (suicide prevention)
14. All mutations are reversible — keep previous genome version
15. After requirements are met, innovation engine MUST run (推陈出新)
16. Innovation proposals require human approval for high-effort or security changes