# Template: Data Pipeline (Generation Factory)

## When to Use
Task involves data ingestion, transformation, analysis, or ETL workflows.

## Generation Directives

### Layer 1: Context Engineering
Generate these artifacts:
- `AGENTS.md` — project context with data-pipeline specific rules (no data loss, idempotency, lineage tracking)
- `context/loader.py` — script that assembles relevant context per task (reads task card, loads matching schemas/transform patterns/quality rules)
- `context/knowledge-index.yaml` — maps file paths to knowledge domains (e.g., `schemas/ → data definitions`, `transforms/ → business logic`, `quality/ → validation rules`)

### Layer 2: Tool Integration
Generate these artifacts:
- `tools/schemas.yaml` — tool definitions (database connectors, file readers/writers, schema validators, data quality checkers)
- `tools/sandbox.yaml` — sandbox config (allowed: read from staging sources, write to staging targets; blocked: production DB writes without approval)
- `tools/permissions.yaml` — permission manifest (ingest agent: read sources + write raw; transform agent: read raw + write output; validate agent: read output + write audit)
- `tools/mcp-config.json` — MCP server configs if applicable
- `tools/tool-discovery.py` — tool discovery engine that evaluates alternatives before adopting a library

### Layer 3: Memory & State
Generate these artifacts:
- `memory/session-state.yaml` — pipeline progress, records processed, errors encountered, checkpoints
- `memory/long-term/` — directory for persistent knowledge (schema evolution, data quality baselines, transformation catalogs)
- `memory/snapshot.py` — git-based snapshot/rollback script
- `memory/compression-rules.yaml` — keep: schemas, quality rules, lineage; summarize: batch statistics; forget: individual record details after validation

### Layer 4: Planning & Orchestration
Generate these artifacts:
- `planning/dag-builder.py` — builds pipeline DAG (ingest → validate → transform → output → audit, with error quarantine branches)
- `planning/flow-control.yaml` — sequential for dependent stages, parallel for independent data sources, conditional for error paths
- `planning/sub-agent-dispatch.yaml` — role routing (ingest → ingest agent, transform → transform agent, validate → validate agent)
- `planning/budget.yaml` — max steps per task: 8, max tokens per step: 8000, max total tokens: 80000, max retries: 2 (pipelines must be idempotent)

### Layer 5: Verification & Guardrails
Generate these artifacts:
- `verification/format-validators/` — data schema validators (JSON Schema / Avro / Protobuf), pipeline config validators
- `verification/consistency-check.py` — checks record counts (ingested = processed + errored), schema compatibility, no data leakage
- `verification/security-guardrails.yaml` — PII detection patterns, sensitive data masking rules, no unmasked PII in output
- `verification/self-check.py` — self-verification loop (run pipeline → check counts/quality → fix → re-run, max 2 iterations due to idempotency)
- `verification/anti-mock-check.py` — scans all source code for mock/fake/stub/simulated patterns; blocks completion if mocks found in production code
- `verification/quality-gate.py` — enforces engineering-grade standards (config-driven, error-handled, validated, tested); blocks completion if prototype-quality detected

### Layer 6: Feedback & Self-Healing
Generate these artifacts:
- `feedback/error-capture.py` — structured error parser (schema mismatch, data quality violation, source unavailable, write failure)
- `feedback/retry-config.yaml` — source unavailable: backoff max 3; schema mismatch: no retry, quarantine + alert; write failure: retry with backoff
- `feedback/mistake-to-constraint.py` — reads meta-mistakes, proposes constraints (e.g., "always validate schema before transformation")
- `feedback/human-interface.yaml` — approval for: schema changes, new data sources, changes to PII handling, error rate above threshold

### Layer 7: Constraints & Entropy
Generate these artifacts:
- `constraints/architecture-rules.yaml` — ingest → validate → transform → output, no skipping validation, error quarantine mandatory
- `constraints/linter-config.yaml` — enforce: idempotency annotations on transforms, lineage tracking on all data flows
- `constraints/entropy-reduction.py` — cleanup: old pipeline runs, stale schemas, orphaned quarantine records
- `constraints/cost-budget.yaml` — max pipeline runtime: 60min, max data storage: 10GB, max monthly compute cost: $40

### Cross-Cutting: Security & Isolation
Generate these artifacts:
- `security/sandbox-config.yaml` — isolated processing environment, no cross-pipeline data access
- `security/encryption-rules.yaml` — encrypt PII at rest, TLS for data in transit, key rotation schedule
- `security/audit-log.yaml` — log every data access, transformation, and output with lineage tracking

### Cross-Cutting: Observability & Governance
Generate these artifacts:
- `observability/tracing.yaml` — trace every record through the pipeline, track transformation lineage
- `observability/metrics-dashboard.yaml` — record throughput, error rate by stage, processing latency, data quality score
- `observability/session-replay.yaml` — store pipeline execution details for debugging data quality issues
- `observability/versioning.yaml` — schema version tracking, pipeline version tracking, data lineage versioning

### Self-Evolution
Generate these artifacts:
- `evolution/framework.md` — evidence-driven evolution algorithm adapted for data pipelines
- `evolution/genome.yaml` — current evolvable state
- `evolution/log.yaml` — mutation history

### Anti-Mock & Quality Enforcement (Cross-Cutting)

Generate these artifacts:
- `verification/anti-mock-check.py` — mock detection engine (see Layer 5)
- `verification/quality-gate.py` — engineering quality gate (see Layer 5)
- `tools/tool-discovery.py` — tool alternative evaluation engine (see Layer 2)
- Enhanced `guard.py` — pre-action checks now include mock detection, simplification detection, and tool diversity warnings

Enforcement chain: guard.py (pre-code) → anti-mock-check.py (during verify) → quality-gate.py (before completion)

## Domain-Specific Defaults

### Constraints (seed for Layer 7)
- No data loss — every record is accounted for (ingested = processed + errored)
- All transformations are idempotent (safe to re-run)
- Data lineage is tracked (where did this value come from?)
- Schema changes are backward-compatible
- Error records are quarantined, not silently dropped
- Processing is observable (metrics, logs, alerts)
- NO mock/fake/stub implementations — real integration or explicit blocker declaration
- Engineering-grade code required — no prototype shortcuts (hardcoded config, skipped validation, deferred error handling)

### Workflows (seed for Layer 4)
- Pipeline: define schema → ingest → validate → transform → output → audit
- Schema change: analyze impact → migrate forward → verify compatibility → deploy
- Data quality: define expectations → validate → quarantine violations → alert

### Agent Topology (seed for Layer 4)
Pipeline pattern:
- Agent 1 (Ingest): reads source data, validates schema, writes raw
- Agent 2 (Transform): reads raw, applies business logic, writes output
- Agent 3 (Validate): verifies output against expectations, generates audit report

### Verification Checklist (seed for Layer 5)
- Record count: ingested = processed + errored
- Schema validation passes
- Data quality checks pass
- No data leakage (PII/sensitive data detection)
- Transformation is idempotent (run twice, same result)
- Pipeline completes within time budget

### Quality Attributes Priority
1. Reliability (data integrity is paramount)
2. Maintainability (pipelines evolve frequently)
3. Cost (data processing can be expensive)
4. Speed (but not at cost of reliability)
