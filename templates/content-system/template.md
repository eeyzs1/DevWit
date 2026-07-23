# Template: Content System (Generation Factory)

## When to Use
Task involves generating, managing, or publishing content (text, media, documents).

## Generation Directives

### Layer 1: Context Engineering
Generate these artifacts:
- `AGENTS.md` — project context with content-system specific rules (review steps, style guides, version history)
- `context/loader.py` — script that assembles relevant context per task (reads task card, loads matching style guides/templates/topic knowledge)
- `context/knowledge-index.yaml` — maps file paths to knowledge domains (e.g., `templates/ → content structures`, `style-guide/ → writing rules`, `topics/ → subject matter`)

### Layer 2: Tool Integration
Generate these artifacts:
- `tools/schemas.yaml` — tool definitions (content renderer, grammar checker, plagiarism detector, SEO analyzer, media processor)
- `tools/sandbox.yaml` — sandbox config (allowed: read content sources, write drafts; blocked: publish without approval, modify published content directly)
- `tools/permissions.yaml` — permission manifest (researcher: read sources; writer: write drafts; editor: review + approve/reject)
- `tools/mcp-config.json` — MCP server configs if applicable
- `tools/tool-discovery.py` — tool discovery engine that evaluates alternatives before adopting a library

### Layer 3: Memory & State
Generate these artifacts:
- `memory/session-state.yaml` — content progress, drafts created, reviews pending, publications completed
- `memory/long-term/` — directory for persistent knowledge (style guide, topic expertise, audience insights, content performance)
- `memory/snapshot.py` — git-based snapshot/rollback script
- `memory/compression-rules.yaml` — keep: published content, style rules, performance data; summarize: draft iterations; forget: rejected draft details

### Layer 4: Planning & Orchestration
Generate these artifacts:
- `planning/dag-builder.py` — builds content pipeline DAG (research → draft → review → refine → approve → publish)
- `planning/flow-control.yaml` — sequential for content creation, parallel for independent pieces, conditional for review outcomes
- `planning/sub-agent-dispatch.yaml` — role routing (research → researcher, writing → writer, review → editor)
- `planning/budget.yaml` — max steps per task: 8, max tokens per step: 10000, max total tokens: 100000, max retries: 2

### Layer 5: Verification & Guardrails
Generate these artifacts:
- `verification/format-validators/` — content structure validators, metadata completeness schemas, template compliance schemas
- `verification/consistency-check.py` — checks: style guide compliance, factual consistency, metadata completeness, no broken references
- `verification/security-guardrails.yaml` — plagiarism detection thresholds, factual claim verification, no unpublished content in production
- `verification/self-check.py` — self-verification loop (check style → check facts → check metadata → fix → re-check, max 3 iterations)
- `verification/anti-mock-check.py` — scans all source code for mock/fake/stub/simulated patterns; blocks completion if mocks found in production code
- `verification/quality-gate.py` — enforces engineering-grade standards (config-driven, error-handled, validated, tested); blocks completion if prototype-quality detected

### Layer 6: Feedback & Self-Healing
Generate these artifacts:
- `feedback/error-capture.py` — structured error parser (style violation, factual error, missing metadata, template mismatch)
- `feedback/retry-config.yaml` — style violation: fix and re-check; factual error: re-research and rewrite; metadata: auto-fill if possible
- `feedback/mistake-to-constraint.py` — reads meta-mistakes, proposes constraints (e.g., "always fact-check claims before publishing")
- `feedback/human-interface.yaml` — approval for: publication, content retraction, style guide changes, controversial topics

### Layer 7: Constraints & Entropy
Generate these artifacts:
- `constraints/architecture-rules.yaml` — research → draft → review → publish, no skipping review, no publishing without metadata
- `constraints/linter-config.yaml` — enforce: metadata on all content, style guide rules, template compliance
- `constraints/entropy-reduction.py` — cleanup: outdated drafts, unused templates, stale topic knowledge
- `constraints/cost-budget.yaml` — max content pieces per day: 20, max research time per piece: 30min, max monthly API cost: $15

### Cross-Cutting: Security & Isolation
Generate these artifacts:
- `security/sandbox-config.yaml` — draft environment isolated from published content, no direct production access
- `security/encryption-rules.yaml` — encrypt unpublished content, protect source credentials
- `security/audit-log.yaml` — log all content changes with author, timestamp, and change type

### Cross-Cutting: Observability & Governance
Generate these artifacts:
- `observability/tracing.yaml` — trace content from research to publication, track review cycles
- `observability/metrics-dashboard.yaml` — content output rate, review turnaround time, rejection rate, plagiarism check pass rate
- `observability/session-replay.yaml` — store content creation process for quality analysis
- `observability/versioning.yaml` — content version history, template version tracking, style guide changelog

### Self-Evolution
Generate these artifacts:
- `evolution/framework.md` — evidence-driven evolution algorithm adapted for content systems
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
- All content has a review step before publication
- Content templates enforce consistent structure
- Version history is maintained for all content
- No content is published without metadata (author, date, tags)
- Style guide compliance is checked automatically
- Plagiarism/originality check for generated content
- NO mock/fake/stub implementations — real integration or explicit blocker declaration
- Engineering-grade code required — no prototype shortcuts (hardcoded config, skipped validation, deferred error handling)

### Workflows (seed for Layer 4)
- Create: research → draft → review → refine → approve → publish
- Update: identify change need → edit → review → approve → republish
- Archive: review usage → decide → remove or redirect → update indexes

### Agent Topology (seed for Layer 4)
Three-Agent pattern:
- Researcher: gathers information, fact-checks, creates brief
- Writer: produces content following brief and style guide
- Editor: reviews for quality, accuracy, style compliance

### Verification Checklist (seed for Layer 5)
- Style guide compliance check
- Factual accuracy review
- Grammar and spelling check
- Metadata completeness
- No plagiarism detected
- Content matches the brief/requirements

### Quality Attributes Priority
1. Reliability (accuracy of information)
2. Usability (readability and clarity)
3. Maintainability (content needs updating)
4. Speed (timeliness matters)
