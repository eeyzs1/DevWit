# Meta-Mistake Log

## Purpose
Log mistakes in the META-HARNESS itself — not in generated projects.
When the meta-harness generates a bad harness, that's a meta-mistake.
Meta-mistakes improve the generation pipeline, not individual projects.

## Format
```
## Meta-Mistake [N]
- Date: [when]
- Trigger: [what intent caused the bad generation]
- What went wrong: [what the generated harness got wrong]
- Root cause: [WHY the meta-harness made this mistake]
- Fix: [what changed in meta/ or templates/]
- Status: Resolved / Recurring / BLOCKER
```

## Meta-Mistakes

### Meta-Mistake 1
- Date: 2026-04-14
- Trigger: Initial project setup
- What went wrong: Templates generated only markdown descriptions, not executable artifacts
- Root cause: Template format was "description framework" instead of "generation factory" — templates listed what should exist but didn't specify executable artifacts per layer
- Fix: Upgraded all 5 templates to "Generation Factory" format with explicit per-layer executable artifact lists; created seeds/ directory with concrete template files (Python scripts, YAML configs, JSON schemas)
- Status: Resolved

### Meta-Mistake 2
- Date: 2026-04-14
- Trigger: Initial project setup
- What went wrong: ADR-001 documented 5-layer architecture but actual design had evolved to 7+2
- Root cause: ADR was written before architecture evolved and never updated
- Fix: Updated ADR-001 to reflect 7 layers + 2 cross-cutting + self-evolution architecture
- Status: Resolved

### Meta-Mistake 3
- Date: 2026-04-14
- Trigger: Running scripts on Windows
- What went wrong: All utility scripts were bash-only, couldn't run on Windows
- Root cause: Original scripts written for Unix without cross-platform consideration
- Fix: Created Python equivalents (verify.py, pre-task.py, quality-score.py) that work on Windows/macOS/Linux
- Status: Resolved

### Meta-Mistake 4
- Date: 2026-05-17
- Trigger: User reported 5 systemic failures in generated projects
- What went wrong: AI IDE systematically ignored project rules, used mock AI instead of real integration, produced prototype-grade code instead of engineering-grade, developed tool path dependency, required excessive manual guidance
- Root cause: (1) Rules were passive prose with no active enforcement — AI could bypass guard.py and orchestrator.py entirely. (2) No anti-mock mechanism existed — AI defaulted to simulating services rather than integrating them. (3) No quality gate distinguished prototype from engineering code. (4) No tool discovery mechanism encouraged exploring alternatives. (5) No proactive execution rules forced the AI to self-advance.
- Fix: Five-pronged solution:
  1. **ANTI-MOCK PROTOCOL**: Added to AGENTS.md/CLAUDE.md, guard.py, and new anti-mock-check.py seed that scans all source code for mock patterns. Zero tolerance for fake implementations.
  2. **ANTI-SIMPLIFICATION STANDARD**: Added engineering-grade vs prototype comparison table to AGENTS.md, new quality-gate.py seed enforcing config-driven, error-handled, validated, tested code.
  3. **TOOL DISCOVERY PROTOCOL**: Added to AGENTS.md, new tool-discovery.py seed with structured evaluation framework, tool diversity audit, overuse detection.
  4. **PROACTIVE EXECUTION**: Added auto-advance rules to AGENTS.md, passive-waiting detection in guard.py, explicit "don't wait" instructions.
  5. **HEURISTIC TRAPS**: Added known AI failure patterns catalog (Mock Creep, Complexity Collapse, Tool Tunnel Vision, Happy Path Only, etc.) with self-check questions.
  6. **STRONGER ENFORCEMENT**: Enhanced guard.py with 4 new violation patterns, upgraded verification chain to include anti-mock + quality-gate, added 5 new absolute rules (17-21) to META.md.
  7. **CLARITY EXTRACTION**: Added Ambiguity Detection section to interpreter.md forcing clarification before generation.
  - Files changed: AGENTS.md, CLAUDE.md, .cursorrules, META.md, guards.py (+80 lines), interpreter.md (+30 lines), harness-generator.md (+8 lines), all 5 templates, generate.py, verify-generation.py
  - Files created: seeds/verification/anti-mock-check.py (219 lines), seeds/verification/quality-gate.py (199 lines), seeds/tools/tool-discovery.py (226 lines)
- Status: Resolved
