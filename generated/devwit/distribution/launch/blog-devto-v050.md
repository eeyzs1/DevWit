DevWit is a free, MIT-licensed AI-native desktop IDE built around one principle: **you should see exactly what the AI sees and does**.

Every LLM request shows its full context — system prompt, tools, injected code / RAG hits / terminal output — with **per-item token costs you can toggle off**. Agent file writes and shell commands go through an **authorization gate** before they run.

## What's new in v0.5.0

Editor productivity milestone (9 items):

- Bracket pair highlighting + indent guides
- Auto-pair brackets
- Auto-indent / selection indent-outdent
- Move lines, toggle line comment, duplicate line
- Code folding + **minimap**

Built on top of v0.4.0 retention features: TypeScript + Python LSP, Git, DAP debugging, MCP servers, multi-agent orchestration, transparent RAG.

## Why this exists

Most AI coding tools are black boxes. You don't see what got stuffed into the prompt, and agents can touch your files before you notice. DevWit makes both visible and enforceable — including a context manifest you can export as JSON for audit.

It's a **standalone IDE** (not a VS Code plugin) with a self-built editor kernel: piece-table buffer + Canvas rendering + tree-sitter.

## Free, local-first

- No accounts, no cloud sync, no paywall
- Telemetry opt-in, off by default, zero content collected
- Ollama keyless local models supported
- Windows / macOS / Linux builds from public GitHub Actions

**Links**

- GitHub: https://github.com/eeyzs1/DevWit
- Release v0.5.0: https://github.com/eeyzs1/DevWit/releases/tag/v0.5.0

Feedback welcome — especially if you care about context hygiene or compliance-friendly agent workflows.
