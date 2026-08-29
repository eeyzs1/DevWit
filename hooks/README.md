# Hooks (WP2): phase-transition dispatch

Borrowed from DSH's event dispatch model: transitions dispatch through
registered listeners, and policy can reject a transition without editing the
orchestrator.

## Groups

| Directory | Dispatch | Contract |
|---|---|---|
| `hooks/pre-advance/*.py` | **bail** | Runs before every `--advance`. Exit 0 = pass; any non-zero exit REFUSES the advance. Refusal code = hook filename stem; refusal reason = hook stderr/stdout. First refusal stops the chain. |
| `hooks/phase-complete/*.py` | **emit** | Runs after a phase completes. Observer only: failures are contained, never block. |
| `hooks/phase-enter/*.py` | **emit** | Runs after entering a phase. Observer only: failures are contained, never block. |

## Hook context

Every hook receives one JSON object in the `MH_CONTEXT` environment variable
(never positional arguments):

```json
{
  "event": "pre-advance",
  "phase": "GENERATE",
  "to": "FACTORY",
  "project_name": "...",
  "generated_project_dir": "...",
  "rounds": 2,
  "max_rounds": 50
}
```

## Fail-closed rules

- `hooks/pre-advance/` must exist when advancing from GENERATE; if it is
  missing, the advance is REFUSED with code `missing-hook` (the
  validate-harness gate would otherwise be silently disabled).
- Observer hooks may never veto; they are fire-and-forget.
- Hooks are executed with the meta-harness root as cwd and must be
  self-contained (read everything they need from `MH_CONTEXT`).

## Shipped hooks

- `pre-advance/10-validate-harness.py` — the GENERATE -> FACTORY gate
  (runs `scripts/validate-harness.py` on the generated project). Do not delete.
- `pre-advance/20-deepen-gate.py` — the INTERPRET -> GENERATE gate (B):
  advancing from INTERPRET requires `memory/deepen-corrections.yaml` that
  satisfies the DEEPEN contract schema. Do not delete.
- `pre-advance/30-research-gate.py` — the INTERPRET -> GENERATE research gate
  (A+B): advancing from INTERPRET when `complexity.novelty >= 3` (unknown
  domain) requires `memory/research-findings.yaml` satisfying the RESEARCH
  contract schema with at least one grounded http(s) source. Familiar domains
  are a no-op. Do not delete.
