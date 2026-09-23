Two months ago I posted [DevWit here](https://dev.to/eeyzs1/i-built-an-ai-ide-that-shows-you-exactly-what-it-sends-to-the-model-3jh8) — an open-source AI IDE where every LLM request shows its full context manifest (per-item token costs, toggleable) and every agent file-write/shell-command goes through an authorization gate.

Since then it grew quietly. v0.7.30 shipped this week, and two of the new things are boring in the best way: **a real terminal** and **a command palette**.

## Terminal panel (yes, it took this long)

The sidebar now has a fifth tab: a real shell session.

- **Real PTY** (node-pty, with a pipe fallback), not a fake output pane
- **ANSI streaming** — colors, bold/underline, the usual SGR set, rendered as you'd expect
- **Full keyboard passthrough** — arrows, Ctrl+C, Tab-completion, IME input for CJK
- **Process-tree kill** — closing a session takes down `npm run dev` and its children, not just the shell process
- Sessions restart in one click; output is capped at 5000 lines so a chatty build can't eat memory

The honest limitation: it's a streaming renderer, not a screen buffer. Full-screen TUI apps (vim, htop) aren't supported — command output and REPL interaction are the target.

## Command palette

`Ctrl+Shift+P` for commands, `Ctrl+P` for files — VS Code conventions. Fuzzy matching (subsequence + consecutive/word-start scoring), full keyboard loop (↑↓, Enter, Escape). It reaches the panels, the form toggle, settings, search, save, open-folder — the ten things you actually do all day.

## The unglamorous part: eight rounds of adversarial review

Between v0.5.0 and v0.7.30, the entire codebase went through **8 rounds of adversarial code review** (each round a fresh reviewer attacking a specific area: renderer, editor kernel, agent runtime, LSP/DAP/workspace, chat UI, MCP, first-run UX, terminal).

- **147 findings, all fixed** — including 5 criticals (a renderer-controlled path re-rooting bug that would have defeated the workspace containment, a debug-stop bug that could kill user processes)
- Every fix got a regression test where feasible
- The interesting ones are in the [CHANGELOG](https://github.com/eeyzs1/DevWit/blob/main/CHANGELOG.md): CSV formula injection in cost exports, a case-sensitivity escape in path containment on Linux, an opt-out beacon that briefly went to the wrong endpoint

This is the part nobody demos, but it's the part that decides whether an AI IDE touching your files deserves trust.

## Numbers

- **975 unit tests / 37 E2E suites** (E2E drives the real packaged Electron app — real shell, real LSP, real git)
- CI gates on lint + types + tests + quality checks for every push
- Windows / macOS / Linux builds from public GitHub Actions

## Install

- **winget**: `winget install eeyzs1.DevWit` (0.7.28 live in the community repo, 0.7.30 in review)
- **Homebrew**: `brew install --cask eeyzs1/tap/devwit` (0.7.30)
- Or grab binaries from [GitHub Releases](https://github.com/eeyzs1/DevWit/releases/latest)

Still free, MIT, no accounts, telemetry opt-in and off by default.

If you care about context hygiene or compliance-friendly agent workflows, feedback is genuinely welcome. And if the direction resonates, a ⭐ on [GitHub](https://github.com/eeyzs1/DevWit) helps more than you'd think — it's the public signal needed to get free code-signing for Windows builds.
