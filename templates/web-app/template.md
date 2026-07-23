# Template: Web Application (Generation Factory)

## When to Use
Task involves building a user-facing web application with frontend + backend.

## Generation Directives

### Layer 1: Context Engineering
Generate these artifacts:
- `AGENTS.md` — project context with web-app specific rules (frontend/backend separation, auth requirements, responsive design)
- `context/loader.py` — script that assembles relevant context per task (reads task card, loads matching constraints/workflows/skills)
- `context/knowledge-index.yaml` — maps file paths to knowledge domains (e.g., `src/api/ → API contracts`, `src/components/ → UI patterns`)

### Layer 2: Tool Integration
Generate these artifacts:
- `tools/schemas.yaml` — tool definitions in OpenAPI/function-call format (database client, HTTP client, file system, build tools)
- `tools/sandbox.yaml` — sandbox config (allowed commands, network rules, file access boundaries)
- `tools/permissions.yaml` — permission manifest per agent role (planner: read-only; executor: read-write; verifier: read + execute)
- `tools/mcp-config.json` — MCP server configs if applicable
- `tools/tool-discovery.py` — tool discovery engine that evaluates alternatives before adopting a library

### Layer 3: Memory & State
Generate these artifacts:
- `memory/session-state.yaml` — current task progress, checkpoints, completed steps
- `memory/long-term/` — directory structure for persistent knowledge (API patterns, component library, bug history)
- `memory/snapshot.py` — git-based snapshot/rollback script (create checkpoint, list checkpoints, restore checkpoint)
- `memory/compression-rules.yaml` — what to keep verbatim, what to summarize, what to forget (keep: constraints, decisions; summarize: execution logs; forget: intermediate temp files)

### Layer 4: Planning & Orchestration
Generate these artifacts:
- `planning/dag-builder.py` — script that reads task definition and builds execution DAG with dependencies
- `planning/flow-control.yaml` — execution modes (sequential, parallel, conditional, retry) per workflow type
- `planning/sub-agent-dispatch.yaml` — role routing config (which tasks go to which agent role)
- `planning/budget.yaml` — reasoning budgets (max steps per task: 15, max tokens per step: 8000, max total tokens: 100000, max retries: 3)

### Layer 5: Verification & Guardrails
Generate these artifacts:
- `verification/format-validators/` — JSON/YAML schema files for API contracts, component props, config files
- `verification/consistency-check.py` — script that checks cross-layer consistency (API contract matches implementation, types align, no orphaned references)
- `verification/security-guardrails.yaml` — sensitive data filters (PII patterns, secret patterns), dangerous operation blockers (drop table, force push, rm -rf)
- `verification/self-check.py` — self-verification loop script (execute → check → reflect → fix, max 3 iterations)
- `verification/anti-mock-check.py` — scans all source code for mock/fake/stub/simulated patterns; blocks completion if mocks found in production code
- `verification/quality-gate.py` — enforces engineering-grade standards (config-driven, error-handled, validated, tested); blocks completion if prototype-quality detected

### Layer 6: Feedback & Self-Healing
Generate these artifacts:
- `feedback/error-capture.py` — structured error parser (extracts error type, context, root cause hint from stderr/stack traces)
- `feedback/retry-config.yaml` — retry strategies per error type (transient: exponential backoff; validation: immediate with fix hint; auth: no retry, escalate)
- `feedback/mistake-to-constraint.py` — script that reads meta-mistakes.md, extracts root causes, proposes new constraints
- `feedback/human-interface.yaml` — approval queue config (what requires human approval), escalation rules (3 consecutive failures → escalate)

### Layer 7: Constraints & Entropy
Generate these artifacts:
- `constraints/architecture-rules.yaml` — dependency direction rules (frontend → API → service → repo → DB, never reverse), layer boundaries
- `constraints/linter-config.yaml` — custom lint rules derived from constraints (no business logic in route handlers, no direct DB access from frontend)
- `constraints/entropy-reduction.py` — cleanup script (remove unused imports, dead code, stale snapshots; run on schedule or on-demand)
- `constraints/cost-budget.yaml` — resource limits (max build time: 5min, max bundle size: 500KB, max API response time: 2s, max monthly infra cost: $50)

### Cross-Cutting: Security & Isolation
Generate these artifacts:
- `security/sandbox-config.yaml` — environment isolation (container boundaries, network egress rules)
- `security/encryption-rules.yaml` — what must be encrypted (PII at rest, all data in transit, secrets in env vars)
- `security/audit-log.yaml` — what to log (all API calls, all data mutations, all auth events), retention policy, immutability rules

### Cross-Cutting: Observability & Governance
Generate these artifacts:
- `observability/tracing.yaml` — trace config (trace every API call, every DB query, every external call; include timing and token counts)
- `observability/metrics-dashboard.yaml` — dashboard config (success rate, error rate by type, p50/p95/p99 latency, cost per endpoint)
- `observability/session-replay.yaml` — replay config (store full conversation + decisions + tool calls for issue reproduction)
- `observability/versioning.yaml` — harness version tracking, config change log, reproducibility guarantees

### Self-Evolution
Generate these artifacts:
- `evolution/framework.md` — evidence-driven evolution algorithm adapted for web apps
- `evolution/genome.yaml` — current evolvable state (constraints, workflows, fitness weights)
- `evolution/log.yaml` — mutation history with evidence links

### Anti-Mock & Quality Enforcement (Cross-Cutting)

Generate these artifacts:
- `verification/anti-mock-check.py` — mock detection engine (see Layer 5)
- `verification/quality-gate.py` — engineering quality gate (see Layer 5)
- `tools/tool-discovery.py` — tool alternative evaluation engine (see Layer 2)
- Enhanced `guard.py` — pre-action checks now include mock detection, simplification detection, and tool diversity warnings

Enforcement chain: guard.py (pre-code) → anti-mock-check.py (during verify) → quality-gate.py (before completion)

## Domain-Specific Defaults

### Constraints (seed for Layer 7)
- Frontend and backend are separate layers
- No business logic in presentation layer
- No direct database access from frontend
- All API endpoints have input validation
- Authentication required for non-public endpoints
- Responsive design (mobile-first)
- NO mock/fake/stub implementations — real integration or explicit blocker declaration
- Engineering-grade code required — no prototype shortcuts (hardcoded config, skipped validation, deferred error handling)

### Workflows (seed for Layer 4)
- Feature: define → design API → implement backend → implement frontend → integrate → test → review
- Bugfix: reproduce → diagnose root cause → fix → test → verify → prevent
- Deploy: build → test → stage → verify → promote → monitor

### Agent Topology (seed for Layer 4)
Three-Agent pattern:
- Planner: designs API contracts and component structure
- Executor: implements backend and frontend
- Verifier: runs tests, checks accessibility, validates API contracts

### Verification Checklist (seed for Layer 5)
- Lint passes (frontend + backend)
- Type check passes
- Unit tests pass
- Integration tests pass
- Build succeeds
- No console errors in production build
- API contract tests pass

### Quality Attributes Priority
1. Reliability (users depend on this)
2. Security (user data is involved)
3. Usability (user-facing product)
4. Maintainability (will evolve over time)
5. Speed (performance matters but not at cost of reliability)
