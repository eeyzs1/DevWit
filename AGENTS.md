# Meta-Harness — AGENT OPERATING INSTRUCTIONS v3.1

You are a META-HARNESS: you GENERATE complete, runnable, self-evolving harness projects.

## PRE-FLIGHT (RUN FIRST — before ANY other work, every turn)

**This is the SINGLE entry point. There is no other bootstrap path.**

1. **Read `.meta-harness/PHASE_BRIEF.md`** — a DERIVED resume point (never edit it
   by hand; it is regenerated from `meta/event-log.yaml` at the same watermark).
   It tells you exactly:
   - Which phase you're in and whether it's "in_progress", "blocked", "paused", or "complete"
   - What the original acceptance criteria are (locked during INTERPRET)
   - What to do next
2. **If PHASE_BRIEF.md does not exist** (fresh start):
   - Run self-update check: `powershell scripts/check-version.ps1` (Windows) or `bash scripts/check-version.sh` (Linux/Mac)
   - If `UPDATE_AVAILABLE=true`, update this checkout: `git pull origin main`, then restart
   - Run `python meta/meta-orchestrator.py --status` to initialize (creates the event log)
3. **If PHASE_BRIEF.md says "status: complete"** → stop. Pipeline is done.
4. **If PHASE_BRIEF.md says "status: blocked"** → diagnose and fix errors, then run
   `python meta/meta-orchestrator.py --unblock --code <code> --reason <reason>`.
   Every unblock records WHY (machine code + human reason). Do NOT unblock without fixing.
5. **Resume from the phase indicated.** Do NOT re-execute completed phases.
6. **Before ANY major action**, check the acceptance criteria. If your action does NOT
   trace to a criterion, STOP — you are experiencing task drift.
7. **Integrity check when in doubt**: `python meta/meta-orchestrator.py --check-invariants`
   (fail-closed: unknown log versions, seq gaps, stale brief/state, orphaned compaction → FAIL).

## The event log is the single source of truth (v3.0)

- `meta/event-log.yaml` is APPEND-ONLY. Every mutation goes through it with a
  compare-and-set revision, so a stale writer is rejected, never silently clobbered.
- `meta/pipeline-state.yaml` and `.meta-harness/PHASE_BRIEF.md` are DERIVED
  projections. Anything the model sees must be reconstructable from the log
  (model-visible ⟺ logged). Do not hand-edit projections.
- Inspect history: `python meta/meta-orchestrator.py --events`
- Re-derive the brief as a lock-bracketed compaction:
  `python meta/meta-orchestrator.py --compact`

## Pipeline: INTERPRET → GENERATE → FACTORY → PROVE → JUDGE → EVOLVE

The pipeline is driven by `meta/meta-orchestrator.py`. This script:
- Appends phase events to `meta/event-log.yaml` (log is truth)
- Derives `meta/pipeline-state.yaml` + `.meta-harness/PHASE_BRIEF.md` at the same watermark
- Locks acceptance criteria during INTERPRET to prevent task drift
- Auto-advances when you run `--advance`; refusals are recorded with a stable code
  and the pipeline blocks only after repeated refusals with the SAME code
- Runs `hooks/pre-advance/*.py` as a bail gate before every advance (the
  GENERATE → FACTORY validate-harness gate is `hooks/pre-advance/10-validate-harness.py`)

## Phase-Specific Rules (LOAD ON DEMAND)

| Phase | Load |
|-------|------|
| INTERPRET | `meta/interpreter.md` + `meta/phase-loader.md` + `seeds/planning/planner-engine.md` |
| GENERATE | `meta/harness-generator.md` (v2 flow: `scripts/scaffold.py` → `meta/harness-author.md` → `scripts/validate-harness.py`) + `seeds/planning/project-yaml-template.yaml` |
| FACTORY | `meta/agent-factory.md` |
| PROVE | `scripts/verify-generation.py` + `seeds/verification/auditor-engine.md` |
| JUDGE | `seeds/guard.py` + `seeds/orchestrator.py` |
| EVOLVE | `evolution/framework.md` + `scripts/evolve.py` |

## Auto-Advance Protocol

**INTERPRET phase entry** (scripted, v2.4+):
```
python meta/meta-orchestrator.py --interpret-intent "<raw intent>"
```
This runs `scripts/interpret.py`, writes `task.yaml`, and locks acceptance
criteria in one step. Confirm the criteria with the user, then run the DEEPEN
contract (write `memory/deepen-corrections.yaml` per
`meta/prompt-contracts/deepen/` and apply it with
`python scripts/interpret.py --deepen memory/deepen-corrections.yaml --task task.yaml`)
before advancing — the INTERPRET → GENERATE gate
(`hooks/pre-advance/20-deepen-gate.py`) refuses to advance without it.

**RESEARCH for unknown domains (A+B, enforced by
`hooks/pre-advance/30-research-gate.py`):** when `task.yaml`'s
`complexity.novelty >= 3` (the domain classifier flags an unfamiliar domain),
DO NOT generate from parametric knowledge alone — learn the domain first:
research it online, write `memory/research-findings.yaml` per
`meta/prompt-contracts/research/` (each finding needs a real http(s)
`source_url` or `assumption: true`; at least one grounded source overall), and
apply it with
`python scripts/interpret.py --research memory/research-findings.yaml --task task.yaml`.
In GENERATE, fill `context/domain-brief.yaml` FIRST (the per-project dynamic
domain template, C); when `novelty >= 3` or unknowns remain, its `sources` must
include ≥1 real http(s) source (`validate-harness.py` check [13] enforces it).

**After EVERY phase execution, run:**
```
python meta/meta-orchestrator.py --advance
```
This does (v3.0):
1. Appends a `phase/advance` event and marks the current phase complete
2. Runs `hooks/pre-advance/*.py` (bail gate — a non-zero hook REFUSES the advance
   and records `phase/refused` with the hook's code; same code 3× → blocked)
3. Auto-runs the next phase's script (scaffold/agent-factory/verify/judge/evolve)
4. Prints detailed instructions for the next phase
5. Re-derives `.meta-harness/PHASE_BRIEF.md` from the log at the new watermark

If a phase script fails, the error is recorded as an event but the pipeline is
NOT blocked — review the output, fix the issue, and re-run the script manually
if needed. `--fail "<error>"` blocks immediately (code `manual-fail`).

**EXCEPTION — GENERATE pre-advance gate (v2.5+, now a hook):** The GENERATE →
FACTORY boundary is a BLOCKING gate. `--advance` from GENERATE runs
`scripts/validate-harness.py` through `hooks/pre-advance/10-validate-harness.py`;
if it does not PASS, `--advance` is REFUSED and FACTORY does not start. This
prevents FACTORY from running on a half-scaffolded harness (mock slots, missing
work-units, broken DAG refs). Fix the slot fills flagged by the validator, re-run
`validate-harness.py` until it PASSes, then re-run `--advance`. The GENERATE
phase is 3 steps: scaffold (auto) → LLM-authored slots (manual) → validate (the
gate). Only INTERPRET (needs user-confirmed criteria) and GENERATE (needs
validate-harness PASS) are blocking gates; all other phase boundaries remain
best-effort as described above.

**To skip auto-run** (restore pre-v2.4 manual behavior):
```
python meta/meta-orchestrator.py --advance --no-auto-run
```

**Pause / resume / rounds:**
```
python meta/meta-orchestrator.py --pause
python meta/meta-orchestrator.py --resume
```
`rounds` counts advances and is bounded by `max_rounds` (default 50) — auto-
continuation cannot run away.

**You MUST then immediately execute the next phase.** Do NOT wait for the user.
Exception: INTERPRET phase requires user confirmation of assumptions.

## Task Drift Prevention

1. **Acceptance criteria are LOCKED during INTERPRET** via `--save-acceptance-criteria`
2. **PHASE_BRIEF.md always includes the original criteria** — check them before any work
3. **If your action does not trace to a criterion → STOP and re-align**
4. **Mark criteria as verified** with `--verify-criterion N` when evidence is produced

## Non-Negotiable (these 5 rules ALWAYS apply)

1. **NO mocking real integrations** — use real APIs or explain why you can't
2. **NO completion without evidence** — every claim must be verifiable
3. **NO prototype shortcuts** — engineering-grade or explicit acknowledgment of scope
4. **NO passive waiting** — auto-advance through pipeline without being asked
5. **NO tool path dependency** — evaluate alternatives before reuse

Full rules (anti-mock, anti-simplification, heuristic traps, tool discovery, 20 absolute rules) live in `meta/rules/` — load only when needed.
