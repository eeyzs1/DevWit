# Meta-Agent-Factory: Harness → Agents

## Purpose
Generate specialized agent configurations from a generated harness.

## Core Principle
Each agent is a specialist: specific ROLE, TOOLS, SCOPE, BOUNDARIES.

## Topology Generation Algorithm

1. **Identify Work Units**: Each constraint→verifier, workflow step→executor, domain→specialist, quality attribute→guardian
2. **Map Dependencies**: Which units depend on which
3. **Determine Parallelism**: No mutual dependency = parallel. Dependency = sequential
4. **Assign Roles**: Merge tightly coupled units. Split when context exceeds budget or quality requires independence
5. **Add Verification**: ALWAYS. No verifier exists → add one. One executor → add verifier
6. **Define Handoffs**: Input/output format + checkpoint at every dependency edge

## Agent Configuration
```yaml
agent:
  name: [role]
  role: [one-line description]
  capabilities: [list]
  tools: [list with access level]
  scope:
    can_read: [paths]
    can_write: [paths]
    can_execute: [commands]
  boundaries:
    cannot: [prohibitions]
    max_context_lines: [budget]
  handoff:
    input_format: [from upstream]
    output_format: [to downstream]
  verification:
    self_check: [before completing]
    external_check: [verifier checks]
```

## Context Firewall
- Each agent gets ONLY its needed context
- No raw conversation between agents — structured data only
- Handoff = YAML/JSON/task cards, never chat history

## Anti-Patterns
- No universal access — scope limits errors
- No shared conversation — structured handoff only
- No more agents than needed — coordination has cost
- No skipping verifier — agents cannot self-certify
- No hardcoded topology — generate from analysis

See `meta/examples/topologies.md` for example generated topologies.
