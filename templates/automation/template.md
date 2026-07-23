# Template: Automation (Generation Factory)

## When to Use
Task involves automating workflows, scheduling tasks, monitoring systems, or creating event-driven processes.

## Generation Directives

### Layer 1: Context Engineering
Generate these artifacts:
- `AGENTS.md` — project context with automation-specific rules (idempotency, manual overrides, audit trails)
- `context/loader.py` — script that assembles relevant context per task (reads task card, loads matching trigger/action patterns/error catalog)
- `context/knowledge-index.yaml` — maps file paths to knowledge domains (e.g., `triggers/ → event definitions`, `actions/ → automation steps`, `monitors/ → health checks`)

### Layer 2: Tool Integration
Generate these artifacts:
- `tools/schemas.yaml` — tool definitions (scheduler, message queue, HTTP client, file watcher, process manager)
- `tools/sandbox.yaml` — sandbox config (allowed: cron, queue operations; blocked: production system changes without approval)
- `tools/permissions.yaml` — permission manifest (planner: read triggers/actions; executor: write automation code; verifier: execute dry-runs)
- `tools/mcp-config.json` — MCP server configs if applicable
- `tools/tool-discovery.py` — tool discovery engine that evaluates alternatives before adopting a library

### Layer 3: Memory & State
Generate these artifacts:
- `memory/session-state.yaml` — current automation progress, triggers defined, actions implemented
- `memory/long-term/` — directory for persistent knowledge (automation run history, failure patterns, SLA baselines)
- `memory/snapshot.py` — git-based snapshot/rollback script
- `memory/compression-rules.yaml` — keep: automation definitions, failure patterns; summarize: run logs older than 7 days; forget: successful run details older than 30 days

### Layer 4: Planning & Orchestration
Generate these artifacts:
- `planning/dag-builder.py` — builds execution DAG (trigger → condition → action → verify → log)
- `planning/flow-control.yaml` — sequential for dependent actions, parallel for independent monitors, conditional branching for error paths
- `planning/sub-agent-dispatch.yaml` — role routing (flow design → planner, implementation → executor, dry-run → verifier)
- `planning/budget.yaml` — max steps per task: 10, max tokens per step: 6000, max total tokens: 70000, max retries: 3

### Layer 5: Verification & Guardrails
Generate these artifacts:
- `verification/format-validators/` — trigger config schemas, action config schemas, condition expression schemas
- `verification/consistency-check.py` — checks trigger→action chain completeness, no orphaned actions, no missing error handlers
- `verification/security-guardrails.yaml` — block: infinite loops, unbounded retries, production deletions without approval, privilege escalation
- `verification/self-check.py` — self-verification loop (dry-run → check results → fix → re-run, max 3 iterations)
- `verification/anti-mock-check.py` — scans all source code for mock/fake/stub/simulated patterns; blocks completion if mocks found in production code
- `verification/quality-gate.py` — enforces engineering-grade standards (config-driven, error-handled, validated, tested); blocks completion if prototype-quality detected

### Layer 6: Feedback & Self-Healing
Generate these artifacts:
- `feedback/error-capture.py` — structured error parser (timeout, permission denied, resource not found, rate limit exceeded)
- `feedback/retry-config.yaml` — transient: exponential backoff max 3; permission: no retry, alert; resource: retry with different params
- `feedback/mistake-to-constraint.py` — reads meta-mistakes, proposes constraints (e.g., "always add timeout to external calls")
- `feedback/human-interface.yaml` — approval for: new production automations, changes to existing automations, escalation after 3 consecutive failures

### Layer 7: Constraints & Entropy
Generate these artifacts:
- `constraints/architecture-rules.yaml` — trigger → condition → action pattern, no side effects in conditions, idempotent actions only
- `constraints/linter-config.yaml` — enforce: idempotency annotations, timeout on all external calls, circuit breaker on all dependencies
- `constraints/entropy-reduction.py` — cleanup: disabled automations, stale trigger configs, unused action templates
- `constraints/cost-budget.yaml` — max automation runtime: 30min, max concurrent automations: 10, max monthly compute cost: $20

### Cross-Cutting: Security & Isolation
Generate these artifacts:
- `security/sandbox-config.yaml` — dry-run mode for all new automations, isolated execution environment
- `security/encryption-rules.yaml` — encrypt credentials in trigger configs, mask sensitive data in logs
- `security/audit-log.yaml` — log every automation trigger, action, and result with who/what/when/why

### Cross-Cutting: Observability & Governance
Generate these artifacts:
- `observability/tracing.yaml` — trace every automation from trigger to completion, include timing per step
- `observability/metrics-dashboard.yaml` — trigger rate, success rate, failure rate by type, average execution time, queue depth
- `observability/session-replay.yaml` — store full automation execution for debugging failed runs
- `observability/versioning.yaml` — automation version tracking, change history, rollback capability

### Self-Evolution
Generate these artifacts:
- `evolution/framework.md` — evidence-driven evolution algorithm adapted for automation
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
- Every automation has a manual override
- Every action is logged with who/what/when/why
- Failed automations alert a human, not silently retry forever
- Automations are idempotent — safe to trigger multiple times
- Rate limits on all external interactions
- Circuit breakers on all external dependencies
- NO mock/fake/stub implementations — real integration or explicit blocker declaration
- Engineering-grade code required — no prototype shortcuts (hardcoded config, skipped validation, deferred error handling)

### Workflows (seed for Layer 4)
- Create: define trigger → define conditions → define actions → add safety → test → deploy
- Debug: reproduce trigger → trace execution path → identify failure → fix → verify
- Scale: identify bottleneck → optimize or parallelize → load test → verify

### Agent Topology (seed for Layer 4)
Planner-Executor pattern:
- Planner: designs the automation flow, defines triggers, conditions, and actions
- Executor: implements each automation step with safety measures

### Verification Checklist (seed for Layer 5)
- Automation triggers correctly
- Conditions are evaluated accurately
- Actions produce expected results
- Error handling works (simulate failures)
- Idempotency verified (trigger twice, same result)
- Manual override works
- Logging captures all relevant information

### Quality Attributes Priority
1. Reliability (automations run unattended)
2. Maintainability (automations change frequently)
3. Security (automations have system access)
4. Cost (failed automations waste resources)
