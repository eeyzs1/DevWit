# Template: API Service (Generation Factory)

## When to Use
Task involves building a backend API service (REST, GraphQL, gRPC).

## Generation Directives

### Layer 1: Context Engineering
Generate these artifacts:
- `AGENTS.md` — project context with API-service specific rules (versioning, rate limiting, layered architecture)
- `context/loader.py` — script that assembles relevant context per task (reads task card, loads matching API schemas/repo patterns/error catalog)
- `context/knowledge-index.yaml` — maps file paths to knowledge domains (e.g., `src/routes/ → API endpoints`, `src/repositories/ → data access`, `src/services/ → business logic`)

### Layer 2: Tool Integration
Generate these artifacts:
- `tools/schemas.yaml` — tool definitions (database client, HTTP client, schema validator, API test runner)
- `tools/sandbox.yaml` — sandbox config (allowed: npm/pip, test runners, linters; blocked: production DB, external APIs without mock)
- `tools/permissions.yaml` — permission manifest per agent role (planner: read schemas/models; executor: read-write routes/services/repos; verifier: read + execute tests)
- `tools/mcp-config.json` — MCP server configs if applicable
- `tools/tool-discovery.py` — tool discovery engine that evaluates alternatives before adopting a library

### Layer 3: Memory & State
Generate these artifacts:
- `memory/session-state.yaml` — current task progress, API endpoints implemented, tests status
- `memory/long-term/` — directory for persistent knowledge (API version history, deprecation log, performance baselines)
- `memory/snapshot.py` — git-based snapshot/rollback script
- `memory/compression-rules.yaml` — keep: API contracts, schema migrations, ADRs; summarize: test runs; forget: temp mock data

### Layer 4: Planning & Orchestration
Generate these artifacts:
- `planning/dag-builder.py` — builds execution DAG (contract → repo → service → route → test → document)
- `planning/flow-control.yaml` — sequential for contract changes, parallel for independent endpoints, conditional for versioning
- `planning/sub-agent-dispatch.yaml` — role routing (contract design → planner, implementation → executor, testing → verifier)
- `planning/budget.yaml` — max steps per task: 12, max tokens per step: 6000, max total tokens: 80000, max retries: 3

### Layer 5: Verification & Guardrails
Generate these artifacts:
- `verification/format-validators/` — OpenAPI/GraphQL schema validators, request/response JSON schemas
- `verification/consistency-check.py` — checks route→service→repo layer consistency, no skipped layers, no circular deps
- `verification/security-guardrails.yaml` — SQL injection patterns, auth bypass patterns, rate limit enforcement, PII exposure checks
- `verification/self-check.py` — self-verification loop (run tests → check coverage → fix failures → re-run, max 3 iterations)
- `verification/anti-mock-check.py` — scans all source code for mock/fake/stub/simulated patterns; blocks completion if mocks found in production code
- `verification/quality-gate.py` — enforces engineering-grade standards (config-driven, error-handled, validated, tested); blocks completion if prototype-quality detected

### Layer 6: Feedback & Self-Healing
Generate these artifacts:
- `feedback/error-capture.py` — structured error parser (HTTP errors, DB errors, validation errors, timeout errors)
- `feedback/retry-config.yaml` — transient DB errors: backoff; validation errors: fix hint; auth errors: no retry
- `feedback/mistake-to-constraint.py` — reads meta-mistakes, proposes new constraints (e.g., "always validate request body before processing")
- `feedback/human-interface.yaml` — approval for: schema-breaking changes, auth changes, production config changes

### Layer 7: Constraints & Entropy
Generate these artifacts:
- `constraints/architecture-rules.yaml` — route → service → repo → DB, no business logic in routes, no DB access outside repos
- `constraints/linter-config.yaml` — enforce layered architecture, explicit error types, no bare catches
- `constraints/entropy-reduction.py` — cleanup unused routes, stale migrations, orphaned types
- `constraints/cost-budget.yaml` — max API response time: 500ms, max DB query time: 100ms, max monthly infra cost: $30

### Cross-Cutting: Security & Isolation
Generate these artifacts:
- `security/sandbox-config.yaml` — test DB isolation, mock external services, no production access
- `security/encryption-rules.yaml` — TLS for all endpoints, hash passwords, encrypt PII at rest
- `security/audit-log.yaml` — log all API calls with method/path/status/user, retain 90 days

### Cross-Cutting: Observability & Governance
Generate these artifacts:
- `observability/tracing.yaml` — trace every request end-to-end, include DB query timing
- `observability/metrics-dashboard.yaml` — request rate, error rate by code, p50/p95/p99 latency, DB connection pool usage
- `observability/session-replay.yaml` — store request/response pairs for debugging
- `observability/versioning.yaml` — API version tracking, schema evolution log

### Self-Evolution
Generate these artifacts:
- `evolution/framework.md` — evidence-driven evolution algorithm adapted for API services
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
- API versioning from day one
- All endpoints have rate limiting
- Request/response schemas are explicit and validated
- No business logic in route handlers
- Database access only through repository layer
- Structured error responses with error codes
- API documentation auto-generated from code
- NO mock/fake/stub implementations — real integration or explicit blocker declaration
- Engineering-grade code required — no prototype shortcuts (hardcoded config, skipped validation, deferred error handling)

### Workflows (seed for Layer 4)
- Feature: define contract → implement repository → implement service → implement route → test → document
- Bugfix: reproduce via API call → trace through layers → fix at correct layer → test → verify
- Performance: profile → identify bottleneck → optimize → benchmark → verify no regression

### Agent Topology (seed for Layer 4)
Planner-Executor pattern:
- Planner: designs API contracts, data models, and service interfaces
- Executor: implements each endpoint with repository pattern

### Verification Checklist (seed for Layer 5)
- API contract tests pass
- Unit tests for each layer
- Integration tests for endpoints
- Lint and type check pass
- No unhandled error paths
- Response times within budget

### Quality Attributes Priority
1. Reliability (other services depend on this)
2. Maintainability (APIs live long)
3. Speed (latency matters)
4. Security (data exposure risk)
