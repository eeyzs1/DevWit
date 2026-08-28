# Harness Engineering Framework

> Just say what you want. The system handles the rest.

[中文版](README.md)

## What Is This?

Imagine: you have an idea but don't know how to build it. You tell this system "I need a customer onboarding system", and it:

1. **Understands your idea** — translates vague intent into a clear task definition
2. **Generates a complete project** — auto-generates a runnable project with 7 layers + 2 cross-cutting + evolution, each layer has executable artifacts
3. **Assigns specialist roles** — creates a team of AI agents, each with a specific job
4. **Orchestrates execution** — plans who goes first, who goes next, who works in parallel
5. **Verifies results** — automatically checks if output meets the bar
6. **Gets smarter over time** — every mistake makes the system better
7. **Self-evolves** — actively optimizes its own rules, workflows, and agent configurations; the evolution rules themselves also evolve
8. **Innovates beyond requirements** — after meeting all requirements, the system proactively discovers improvement opportunities and proposes innovations that go beyond the original ask

**In one sentence**: This is an "evolving, innovating AI agent management system" — it ensures AI agents produce reliable work, keeps getting more reliable, and can exceed your expectations.

---

## How Do I Use It?

### If You're Not a Developer

You don't need to know code. Just open this project in an AI coding tool and tell it what you want.

**Supported tools and context loading:**

| Tool | Rules File | Loading | What You Need to Do |
|------|-----------|---------|-------------------|
| **Trae** | `AGENTS.md` | ✅ Auto-loaded | Just open the project |
| **Claude Code** | `CLAUDE.md` | ✅ Auto-loaded | Just open the project |
| **Cursor** | `.cursorrules` | ⚠️ Manual | Copy `AGENTS.md` contents to `.cursorrules` |
| **Other AI tools** | — | ⚠️ Manual | Paste `AGENTS.md` contents into the conversation as context |

**Critical: The AI MUST read the rules file to follow the pipeline.** If the AI doesn't read the rules, it will skip the pipeline and start working on its own — that's not what we want.

**Examples — just say:**

- "I need a customer onboarding system"
- "Build me a competitor price monitoring tool"
- "I want to automate our weekly report generation"
- "Create a SaaS for freelance invoicing"

The AI **automatically reads the project rules** (no manual action needed), then:
- Parses your requirements
- Generates a complete runnable project (7 layers + 2 cross-cutting + evolution)
- Creates specialized agents to execute
- Verifies the results meet your standards
- After requirements are met, proactively proposes innovation suggestions

**You only need to do two things:**
1. **Say what you want** (the vaguer, the better — the system will help you clarify)
2. **Confirm assumptions** (the system will list its assumptions; just confirm or correct them)

### If You're a Software Engineer

This project is a **self-bootstrapping meta-harness** — it's not a harness for a specific project, it's a **harness that generates harnesses**.

**Core formula:**
```
Agent = Model + Harness
```
- The Model provides intelligence
- The Harness makes that intelligence reliably useful
- **A better Harness often matters more than a better Model**

**Generation Factory pattern:**
```
Vague Intent → [Interpreter] → Structured Task Definition
                      ↓
               [Harness Generator] → Complete runnable project (7+2+evolution)
                      ↓                Each layer has executable artifacts (Python scripts, YAML configs, JSON schemas)
               [Agent Factory] → Specialized Agent Topology (generated, not selected)
                      ↓
               [Orchestrator] → Execution Plan (coordinates across all layers)
                      ↓
               Agents execute within generated harness → Results
                      ↓
               Failure feedback → Meta-Harness improves → Evolution engine optimizes
                      ↓
               Requirements met → Innovation Engine → Innovate beyond requirements
```

**Quick start:**

1. Open this project in Trae / Claude Code
2. Tell the AI what you want (e.g., "I need a customer onboarding system")
3. The AI auto-reads project rules and follows the pipeline
4. Confirm the assumptions the AI lists
5. The AI generates a complete harness project and executes
6. After requirements are met, the AI proactively proposes innovations

**Command-line usage:**
```bash
# Generate a complete harness project
python scripts/generate.py --task <task-file.yaml> --template <domain>

# Verify generated project completeness (7+2 layer check)
python scripts/verify-generation.py <generated-project-dir>

# Run evolution engine
python scripts/evolve.py --project-root <generated-project-dir>

# Run innovation engine (推陈出新)
python seeds/evolution/innovation-engine.py --project-root <generated-project-dir>

# Run innovation cycle in a generated project
python orchestrator.py --innovate

# View quality score
python scripts/quality-score.py
```

---

## Project Structure

```
README.md           ← Chinese version
README_EN.md        ← You are here
AGENTS.md           ← ⚡ Auto-loaded project rules (Trae entry point)
CLAUDE.md           ← ⚡ Auto-loaded project rules (Claude Code entry point)
META.md             ← The system's DNA (full pipeline specification)
.gitignore          ← Git ignore rules (generated/ etc.)
│
meta/               ← The four stages of the compilation pipeline
  interpreter.md      Step 1: Intent → Structured Task
  harness-generator.md Step 2: Task → Executable Harness Project (7+2+evolution)
  agent-factory.md    Step 3: Harness → Agent Topology
  orchestrator.md     Step 4: Agents → Execution Plan (coordinates across all layers)
  examples/           Reference examples (not preset templates)
    topologies.md       Agent topology examples
│
evolution/          ← Meta-level self-evolution system
  framework.md        Evolution algorithm (genome, fitness, mutation, selection)
  genome.md           Current evolvable state (what can mutate)
  log.md              Evolution history (fossil record)
│
templates/          ← Domain templates (Generation Factory format, each layer specifies executable artifacts)
  web-app/            Web application
  api-service/        API service
  data-pipeline/      Data pipeline
  content-system/     Content system
  automation/         Automation
│
seeds/              ← Seed artifacts (executable template files per layer, copied by generate.py)
  context/            loader.py, knowledge-index.yaml
  tools/              schemas.yaml, sandbox.yaml, permissions.yaml, mcp-config.json
  memory/             snapshot.py, compression-rules.yaml
  planning/           dag-builder.py, flow-control.yaml, sub-agent-dispatch.yaml, budget.yaml
  verification/       consistency-check.py, security-guardrails.yaml, self-check.py
  feedback/           error-capture.py, retry-config.yaml, mistake-to-constraint.py, human-interface.yaml
  constraints/        architecture-rules.yaml, linter-config.yaml, entropy-reduction.py, cost-budget.yaml
  security/           sandbox-config.yaml, encryption-rules.yaml, audit-log.yaml
  observability/      tracing.yaml, metrics-dashboard.yaml, session-replay.yaml, versioning.yaml
  evolution/          framework.md, genome.yaml, log.yaml
                       innovation-engine.py    ← Innovation engine (推陈出新)
                       product-analyzer.py     ← Product state analyzer
                       domain-advancements.yaml     ← Web app domain advancement patterns
                       domain-advancements-api.yaml ← API service domain advancement patterns
  orchestrator.py     ← Entry point for generated projects (orchestrator)
│
generated/          ← Generation output (result of each compilation, git-ignored)
memory/             ← Meta-knowledge (cross-project, compounding over time)
  generation-log.md   Every generation is tracked (human-readable)
  generation-log.yaml Every generation tracked (machine-readable, maintained by generate.py)
  meta-mistakes.md    Generation failures → pipeline improvements
  task-patterns.md    Known task patterns (faster interpretation)
  decisions.md        Architecture decision records
  progress.md         Execution progress
│
scripts/            ← Executable scripts (cross-platform Python)
  generate.py         Core generation pipeline: task → complete harness project
  verify-generation.py Verify 7+2 layer completeness of generated projects
  evolve.py           Evidence-driven evolution engine
  verify.py           Post-task verification (lint, typecheck, test, secrets)
  pre-task.py         Pre-task checks (task card, git status, blockers)
  quality-score.py    Quality metrics
```

---

## Key Concepts

### What Is a Harness?

A Harness is a **constraints + tools + verification** system built around AI agents. Just as a horse needs a harness to run in the right direction, AI agents need a harness to produce reliably.

Without a harness: the agent might get it right, might get it wrong — you won't know which.
With a harness: mistakes get caught, correct work gets verified, results are predictable.

### Generation Factory vs Description Framework

**Old pattern (Description Framework)**: Generate markdown files → AI reads markdown and follows rules
**New pattern (Generation Factory)**: Generate complete runnable project → Each layer has executable artifacts (Python scripts, YAML configs, JSON schemas)

| Layer | Generated Executable Artifacts |
|---|---|
| 1. Context Engineering | AGENTS.md + context loader script + knowledge index |
| 2. Tool Integration | Tool schemas + sandbox config + permission manifest + MCP config |
| 3. Memory & State | Session state file + long-term memory structure + snapshot script + compression rules |
| 4. Planning & Orchestration | DAG builder script + flow control config + sub-agent dispatch + budget config |
| 5. Verification & Guardrails | Format validators + consistency check script + security guardrails + self-check loop script |
| 6. Feedback & Self-Healing | Error capture script + retry strategy + mistake→constraint loop script + human intervention interface |
| 7. Constraints & Entropy | Architecture rules + code enforcement config + entropy reduction script + cost constraints |
| Security & Isolation | Sandbox config + encryption rules + audit log |
| Observability | Tracing config + metrics dashboard + session replay + versioning |
| Self-Evolution | Evolution framework + genome + evolution log + innovation engine + product analyzer |

### Why Do Mistakes Make the System Stronger?

Every generation failure gets root-cause-analyzed and logged to `memory/meta-mistakes.md`, then the generation pipeline is improved. This creates a **compounding feedback loop**:

```
Mistake → Root Cause Analysis → Constraint Improvement → Better Future Generations → Fewer Mistakes
```

The more you use it, the smarter it gets. This is the fundamental difference from a traditional template library.

### Agent Topology Is Dynamically Generated

The system synthesizes the optimal agent graph from task analysis, rather than selecting from preset patterns:

1. Identify work units (each constraint, workflow step, domain)
2. Map dependencies
3. Determine parallelism
4. Assign roles (merge tightly coupled, split when context exceeds budget)
5. Add verification layer (there must ALWAYS be an independent verifier)
6. Define handoff points

### The System Self-Evolves

This is the most radical design. The system doesn't just learn from mistakes — it **actively optimizes itself**:

**Three-layer genome (what can evolve):**
- **Harness genome**: constraints, workflows, skills, verification rules
- **Agent genome**: topology, role scope, handoff formats, context budgets
- **Evolution genome** (meta-evolution): mutation operators, selection criteria, fitness weights, mutation rate

**Evolution loop:**
```
Collect evidence → Measure fitness → Propose mutation → Test mutation → Select or reject → Update genome
                                                                                    ↓
                                                          Meta-evolution: update mutation/selection rules themselves
```

**Safety constraints (preventing "cancer" and "suicide"):**
- Never remove the verification layer (otherwise the system accepts wrong results — "cancer")
- Never remove the evolution system itself (otherwise the system stops evolving — "suicide")
- Mutation rate never exceeds 30% (otherwise the system descends into chaos)
- All mutations must be reversible (previous genome version is always preserved)

### Innovation Engine: Beyond Requirements

The system's most unique capability — **not just meeting requirements, but exceeding them**.

When all acceptance criteria are satisfied, the innovation engine automatically activates:

```
Requirements met → Product state analysis → Domain advancement matching → Innovation proposals → Priority ranking → Human confirmation
```

**Four-stage advancement model:**

| Stage | Meaning | Description |
|-------|---------|-------------|
| **Basic** | Meets requirements | Core features implemented, basic tests pass |
| **Solid** | Production-ready | Error handling, loading states, input validation, pagination, notifications |
| **Advanced** | Competitive quality | Offline support, dark mode, keyboard shortcuts, search & filter, audit trail |
| **Excellent** | Market-leading | Real-time collaboration, accessibility (WCAG), internationalization, performance monitoring |

The innovation engine automatically proposes innovations for the next stage based on the product's current stage. For example:

- After a web app completes the Basic stage, it suggests adding error boundaries, loading states, input validation, etc. (Solid stage features)
- After an API service completes the Solid stage, it suggests adding cursor pagination, webhook notifications, caching layer, etc. (Advanced stage features)

**Safety mechanisms:**
- High-effort or security-related innovations require human approval (🔒 NEEDS APPROVAL)
- Low-effort, non-security innovations can be auto-approved (🟢 AUTO-APPROVED)
- Innovation proposals are saved to `evolution/innovation-log.yaml` for full traceability

---

## Core Loop

Generated projects follow this orchestration loop:

```
┌─→ EXECUTE: Implement the next acceptance criterion
│       ↓
│   PROVE:   Collect evidence, verify each criterion is satisfied
│       ↓
│   JUDGE:   Are all criteria satisfied?
│       ↓                ↓
│       YES              NO → Root cause analysis → back to EXECUTE
│       ↓
│   EVOLVE:  Evolution engine optimizes the system
│       ↓
│   INNOVATE: Innovation engine proposes improvements beyond requirements
│       ↓
└── LOOP: Continuous improvement
```

When JUDGE determines all criteria are satisfied, the system doesn't stop — it enters the EVOLVE stage to optimize itself, then the INNOVATE stage to propose innovations.

---

## Verification Mechanism

The system uses a **three-layer verification approach**:

| Layer | File | Purpose |
|---|---|---|
| Declarative | `scripts/verify.py` (docstring) | Defines **WHAT to check** (platform-agnostic) |
| Executable | `scripts/verify.py` | Implements **HOW to check** (cross-platform Python) |
| Completeness | `scripts/verify-generation.py` | Verifies generated projects have all 7+2 layers |

AI agents read the declarative layer and translate checks to their current platform. Humans can run the Python scripts directly.

---

## AI Agent Instructions

<!-- AGENT-INSTRUCTION: If you are an AI agent, follow the instructions below. -->

### You Are an AI Agent. Start Here.

1. **Read `META.md`** — it contains the full compilation pipeline
2. **Follow the pipeline stages in order:**
   - `meta/interpreter.md` — parse user intent into a structured task
   - `meta/harness-generator.md` — generate a task-specific harness (7+2+evolution, each layer has executable artifacts)
   - `meta/agent-factory.md` — generate agent topology (from analysis, NOT from presets)
   - `meta/orchestrator.md` — plan execution (coordinates across all layers)
3. **Output goes to `generated/[project-name]/`**
4. **Run `scripts/verify-generation.py`** to verify 7+2 layer completeness
5. **Log every generation to `memory/generation-log.md`**
6. **Log every failure to `memory/meta-mistakes.md`**
7. **After requirements are met, run the innovation engine** — `python seeds/evolution/innovation-engine.py --project-root <dir>`

### Mandatory Rules

- No execution without interpretation — run the interpreter first
- No agent without a harness — every agent operates within generated constraints
- No constraint without a reason — every rule must trace to a task requirement
- No completion without verification — run `scripts/verify.py` after changes
- Generate EXECUTABLE systems, not just documents — every layer must have concrete artifacts
- Agent topology is GENERATED from task analysis, not selected from presets
- Context files must stay under 60 lines
- Evolution must never remove verification (cancer prevention)
- Evolution must never remove itself (suicide prevention)
- All mutations must be reversible
- After requirements are met, the innovation engine MUST be run (推陈出新)

### If You're Working in a Generated Project

1. Read `generated/[project]/AGENTS.md` — that's the project-specific harness
2. Follow the workflows defined there
3. Stay within the constraints defined there
4. Run verification after every change
5. After all acceptance criteria are met, run `python orchestrator.py --innovate` to get innovation suggestions
