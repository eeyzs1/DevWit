---
title: "I built an AI IDE that shows you exactly what it sends to the model"
published: false
tags: ai, opensource, electron, productivity
---

Every AI coding tool asks for the same leap of faith: trust that the context it
sends is reasonable, and trust that the agent won't touch anything it
shouldn't. I got tired of leaps of faith, so I built
[DevWit](https://github.com/eeyzs1/DevWit) — a free, open-source AI IDE where
both are fully visible and enforceable.

## The two walls I kept hitting

**Wall 1: opaque context.** The model's answer degrades, and you can't tell
why. Was a 40k-token file silently injected? Did a stale RAG chunk crowd out
the file you actually care about? Most tools treat the prompt as a black box.

**Wall 2: ambient authority.** Agents that can write files and run shell
commands are genuinely useful — right up until one does something you didn't
expect. "It mostly asks first" is not a permission model.

DevWit's answers to these two walls are its core features.

## Feature 1: The Context Panel

Every LLM request in DevWit renders a complete manifest before it's sent:

- The system prompt (per-mode, editable)
- The tool list
- Every injected item — files, RAG chunks, terminal output, diagnostics —
  each with its own token count

Any item can be toggled off, per request. Cut a noisy retrieval result and you
watch the token total drop in real time. After the request, the manifest is
written to disk, so "what exactly did the model see when it produced this
diff?" is an answerable question — weeks later, in an audit, if needed.

The codebase index (RAG) follows the same rule: retrieval hits appear as
individual, labeled items in the manifest, and if nothing was injected, the
panel says *why* (index disabled / still building / no hits / provider
doesn't support embeddings). No silent failures.

## Feature 2: The Authorization Gate

The agent runtime physically cannot write a file or execute a shell command
without a per-action approval. The gate shows the exact operation — file path
or full command line — and you approve, reject, or remember the decision for
the project.

This isn't a system-prompt promise. The tool execution path routes through an
authorizer; without a recorded approval the call doesn't happen. MCP tool
servers get the same treatment: every external tool call goes through the gate
under its fully-qualified name.

## Feature 3: Lean context by routing

More context isn't better context. DevWit includes a task router that
classifies each request: simple ones (typo fixes, small questions) go to a
local model via Ollama — free, private, offline-capable — while complex
multi-file work goes to your configured cloud model (Anthropic or any
OpenAI-compatible API). A per-session usage ledger tracks tokens and estimated
cost, so the routing decision is auditable too.

## It's a real IDE, not a chat wrapper

Under the AI features is a daily-driver editor:

- **TypeScript language server** — live diagnostics, hover, go-to-definition
- **Integrated Git** — status badges in the file tree, stage/commit, inline diff
- **Breakpoint debugging** — DAP via js-debug: breakpoints, stepping, variable
  inspection
- **Multi-agent orchestration** — a planner mode decomposes intent into
  parallel sub-agents with per-agent activity streams
- **Custom modes** — define your own system prompt / tool set / model /
  context policy per mode, hot-reloaded, shareable as JSON
- **MCP tool servers** — stdio servers managed from settings, lifecycle
  handled on quit

## Engineering honesty

v0.3.0 is verified by **614 unit tests and 28 end-to-end suites** that drive
the real packaged app (not mocks). Ships for Windows (NSIS), macOS (dmg/zip),
and Linux (AppImage/deb), with auto-update from GitHub Releases.

What it deliberately does **not** have: accounts, cloud sync, a marketplace,
or any paywall. Telemetry is opt-in, off by default, anonymous, and collects
zero content — the endpoint is configurable if you'd rather self-host
[PostHog](https://posthog.com). It's free software, and it will stay that way.

## What's next

The near-term roadmap is trust and reach: Azure Trusted Signing for Windows
builds (infrastructure is already in CI, waiting on my account), winget
distribution (PR under review), then deeper LSP language coverage.

If you work on a team with compliance requirements — or you simply want to
know what your AI tools are doing — I'd genuinely love your feedback.

**Links**: [GitHub](https://github.com/eeyzs1/DevWit) ·
[Releases](https://github.com/eeyzs1/DevWit/releases/latest)
