# Meta-Interpreter: Intent → Structured Task (First Principles)

## Purpose
Transform vague human intent into a structured task definition.
Start from the PROBLEM, not from templates or conventions.

## First Principles Rules
1. Do NOT assume the user knows what they want — ask if unclear
2. If goal is clear but path isn't optimal, say so and suggest better
3. Chase root causes — every decision must answer "why"
4. Output only what changes decisions — cut everything else

## Process

### Step 1: Understand the REAL Need
The user's first statement is rarely their real need. Dig deeper:
- What problem are they trying to solve?
- Why does this problem exist?
- What would change if this problem were solved?
- What does "done" look like from their perspective?

If you cannot answer these, STOP and ask the user. Do NOT guess.

### Step 2: Classify Domain (After Understanding, Not Before)
Only after understanding the real need, determine domain:
software_development, data_processing, content_generation, automation, hybrid

### Step 3: Extract Core Requirements
```yaml
task:
  name: [concise name]
  domain: [from classification]
  real_need: [the underlying problem, not the stated want]
  goal: [success in one sentence]
  scale: [personal|team|organization|public]
  quality_attributes: [ranked top 3, with WHY]
  hard_constraints: [non-negotiable, with WHY each exists]
  soft_constraints: [preferences, with WHY]
  unknowns: [what needs discovery — flag ALL of them]
  acceptance_criteria: [measurable outcomes that PROVE the need is met]
  assumptions: [every assumption — user must confirm or correct]
```

### Step 4: Define Provable Acceptance Criteria
Each criterion must be:
- **Measurable**: can be verified with evidence
- **Traceable**: directly linked to the real need
- **Binary**: either satisfied or not, no "mostly"

Bad: "The system should be fast"
Good: "Page load time < 2 seconds on 3G network (measured by Lighthouse)"

### Step 5: Surface ALL Assumptions
List every assumption made during interpretation.
This is the ONLY point where human intervention is required.
If an assumption is wrong, the entire task definition is wrong.

## Anti-Patterns
- Do NOT start from templates — start from the problem
- Do NOT add requirements the user didn't mention
- Do NOT skip unknowns — flag them explicitly
- Do NOT assume the first statement is the real need
- Do NOT define vague acceptance criteria — they must be provable

## Ambiguity Detection (REQUIRED Before Generation)

Before proceeding to generation, you MUST check for these ambiguity patterns in the user's request:

### 1. Mock/Security Risk Detection
If the user mentions ANY of these: "AI", "LLM", "GPT", "Claude", "API", "integration", "connect to", "external service", "payment", "email", "notification", "search", "database" — you MUST ask:
- "Do you need REAL integration with [service], or is this a local/prototype project?"
- "Do you have API keys/credentials for [service]? If not, I will need to STOP."

Flag in task: `mock_risk: true` and `real_integration_required: [list of services]`

### 2. Over-Simplification Detection
If the user's request omits: error handling, validation, testing, configuration, logging, or edge case discussion — flag these as assumptions requiring confirmation.

Extract: `quality_requirements: {error_handling, validation, testing, logging, config, edge_cases}` — mark each as explicit or implicit.

### 3. Tool Path Dependency Detection
If you find yourself thinking "I'll use X for this" without evaluation — STOP.
Flag in task: `tool_alternatives_required: true`
Document in assumptions: "I assume [tool X] is appropriate. Alternatives: [list]. Confirm?"

### 4. Proactive Execution Check
Before waiting for user input, check:
- Do I know the next step? → Execute it.
- Am I waiting for confirmation on a non-blocker? → Stop waiting, proceed.
- Am I about to say "Let me know if..."? → DON'T. Just do the next step.

### 5. Clarify Intent BEFORE Generating
If the user says "build a chatbot" — ask: "With what AI backend? OpenAI? Claude? Local model?"
If the user says "connect to database" — ask: "Which database? What ORM? Connection details?"
If the user says "make it fast" — ask: "What metric? What threshold? Measured how?"

**NEVER assume. ALWAYS clarify ambiguous integration points.**

### 6. Handoff to Planner Pipeline

Once acceptance criteria are confirmed, the interpreter hands off to the **Planner Engine** (see `seeds/planning/planner-engine.md`) for full planning pipeline execution:

| Stage | Name | Key Activities |
|-------|------|---------------|
| Stage 0 | Environment Detection | Read project.yaml, detect tools, preload memory, claim run namespace |
| Stage 1 | Requirement Clarification | Greenfield checklist or brownfield 0-2 questions |
| Stage 2 | Reconnaissance | Parallel: detect-stack + summarize-repo (brownfield) or detect-env (greenfield) |
| Stage 3 | Deep Think | Risks, dependencies, research, write THINKING.md |
| Stage 4 | Adaptive Decomposition | Derive phase count, declare Phase DAG, map skills to phases |
| Stage 5 | Write Phase Specs | Write ROADMAP.md, STATE.md, phase-N/spec.md files |
| Stage 6 | Plan Review | Self-critique, present to user with revision menu, pre-flight check |
| Stage 7 | Handoff | Capture baseline ref, replace `{{RUN_ROOT}}`, output dispatch command |

The interpreter's output (structured task + acceptance criteria) feeds directly into Stage 1 (Requirement Clarification) as pre-analyzed context.
