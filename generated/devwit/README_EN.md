# DevWit — Minimal-Context AI-Native Desktop IDE

[中文版](README.md)

[![Release](https://img.shields.io/github/v/release/eeyzs1/DevWit)](https://github.com/eeyzs1/DevWit/releases)
[![Downloads](https://img.shields.io/github/downloads/eeyzs1/DevWit/total)](https://github.com/eeyzs1/DevWit/releases)
[![Stars](https://img.shields.io/github/stars/eeyzs1/DevWit)](https://github.com/eeyzs1/DevWit/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

DevWit is a self-built AI-native desktop IDE. It combines VSCode-grade editing, Cursor-style conversational coding, Claude Code-style agent execution, and a pi-agent-inspired minimal context design that avoids long-context bloat — delivering an efficient, transparent, and auditable AI development experience.

## Download & Install

**Latest v0.3.0 · Free software · MIT license** (all build artifacts on the [Releases](https://github.com/eeyzs1/DevWit/releases) page)

### Windows (x64)

Direct download: [DevWit.Setup.0.3.0.exe](https://github.com/eeyzs1/DevWit/releases/download/v0.3.0/DevWit.Setup.0.3.0.exe) (NSIS installer, custom install directory, supports `/S` silent install).

winget (submitted as microsoft/winget-pkgs#407506; available once community review completes):

```powershell
winget install eeyzs1.DevWit
```

### macOS (Apple Silicon)

Homebrew (recommended, available now):

```bash
brew install --cask eeyzs1/tap/devwit
xattr -dr com.apple.quarantine /Applications/DevWit.app   # unsigned distribution; de-quarantine once
```

Or download directly: [DevWit-0.3.0-arm64.dmg](https://github.com/eeyzs1/DevWit/releases/download/v0.3.0/DevWit-0.3.0-arm64.dmg) (no Intel Mac build yet).

### Linux (x64)

- AppImage (in-app auto-update): [DevWit-0.3.0.AppImage](https://github.com/eeyzs1/DevWit/releases/download/v0.3.0/DevWit-0.3.0.AppImage) — `chmod +x` and run
- Debian/Ubuntu: [devwit_0.3.0_amd64.deb](https://github.com/eeyzs1/DevWit/releases/download/v0.3.0/devwit_0.3.0_amd64.deb) — install with `sudo dpkg -i`

### Auto-Update

| Platform | How updates work |
|----------|------------------|
| Windows | In-app auto-update (electron-updater; manual check under Settings → General) |
| macOS | Unsigned builds skip auto-update: `brew upgrade --cask eeyzs1/tap/devwit`, or overwrite manually with the new dmg |
| Linux AppImage | In-app auto-update |
| Linux deb | Manually install the newer deb |

## Key Features

| Feature | Description |
|---------|-------------|
| Custom editor kernel | Piece-table text buffer + Canvas rendering + tree-sitter highlighting, with IME (CJK) input, multi-cursor, undo/redo |
| Minimal context engine | The full context composition of every LLM request (system prompt, tool list, injected items, per-item token cost) is visible item-by-item and can be toggled individually; manifests are persisted for audit |
| Conversational coding | Request code changes in chat; edits are presented as an in-editor diff with per-hunk accept/reject |
| Agent mode | Authorization gate: file writes and terminal commands require explicit user approval; multi-step tasks with fully visible execution traces |
| Multi-agent orchestration | Orchestrator mode decomposes a task into parallel sub-agents; plan, per-subtask progress, and authorization decisions are visible in the activity stream, with automatic fallback to single-task execution |
| Transparent RAG | Once the codebase index (chunks + embeddings) is ready, retrieval hits are shown with similarity scores and token costs, each individually excludable; index status and manual rebuild live in Settings |
| Zero-cost model access | One-click presets for local Ollama (keyless), DeepSeek, and OpenRouter free tier; the keyless channel covers both chat and embeddings |
| Multi-model support | Anthropic API and OpenAI-compatible API, custom base URL and API key (encrypted via safeStorage), switch models mid-session |
| Custom modes | Create/edit/delete modes — each mode defines its own system prompt, toolset, model, and context injection policy; changes take effect hot, no restart |
| Community mode ecosystem | Account-free sharing: modes export/import as JSON files; a built-in community index (eeyzs1/devwit-modes) offers one-click import, after which modes are editable and re-bindable |
| MCP servers | Manage MCP servers in Settings (CRUD + status badges + tool counts); MCP tools join the agent toolset behind the authorization gate |
| i18n | Chinese/English UI with hot language switching; the main process emits ASCII error codes, localized in the renderer |
| Cross-platform distribution | Windows NSIS / macOS dmg / Linux AppImage+deb built by GitHub Actions; in-app auto-update on Windows and AppImage |

## Screenshots

| Transparent context + RAG | Chat diff review |
|---|---|
| ![Context panel](docs/screenshots/context-panel-rag.png) | ![Diff review](docs/screenshots/chat-diff-review.png) |

| Agent authorization gate | Multi-agent orchestration |
|---|---|
| ![Authorization gate](docs/screenshots/agent-authorization-gate.png) | ![Multi-agent orchestration](docs/screenshots/multi-agent-orchestration.png) |

| Unified settings | Community modes |
|---|---|
| ![Settings](docs/screenshots/settings-unified.png) | ![Community modes](docs/screenshots/community-modes.png) |

## Tech Stack

- Electron 37 + TypeScript 5.8 (monorepo, npm workspaces)
- esbuild for bundling, vitest for unit tests, Playwright over CDP for E2E
- electron-builder produces Windows NSIS, macOS dmg, and Linux AppImage/deb; electron-updater for in-app auto-update

## Repository Layout

```
apps/desktop        Electron app (main / preload / renderer / E2E)
packages/
  contracts         Cross-process contract types (IPC whitelist)
  editor-core       Piece-table document kernel (DOM-free)
  editor-render     Canvas rendering view + IME input capture
  syntax            tree-sitter highlight engine
  llm-providers     Anthropic / OpenAI-compatible clients (SSE streaming) + preset catalog + keyless channel
  context-engine    Minimal context engine (manifest + token metering + per-item policy)
  agent-runtime     Agent loop, tool execution, authorization gate, tracing, multi-agent orchestration
  chat-ui           Chat/context/diff panels + task center + activity stream (headless controllers + DOM views)
  modes             Mode definition store (hot reload) + export/import + community index client
  rag               Codebase index (chunking / embeddings / retrieval-hit injection)
  mcp               MCP client and server manager
  i18n              UI internationalization (zh/en, hot switch)
  settings          Settings and credentials (safeStorage encryption)
  workspace         File tree, git status, workspace service
  terminal          Terminal service (pipe / node-pty backends)
verification/       Acceptance check scripts (context audit, anti-mock, architecture boundaries, secret scan, ...)
evidence/           AC1–AC25 acceptance evidence (screenshots, manifests, traces, build logs)
distribution/       Distribution infrastructure (winget manifests / Homebrew cask / community mode seeds)
docs/screenshots/   Real UI screenshots for the READMEs
```

## Quick Start

```powershell
npm install
npm run rebuild-native   # Build node-pty native module (Electron ABI)
npm run dev              # Build and launch
```

> Startup requirement: the OS must support safeStorage encryption (Windows DPAPI / macOS Keychain / Linux Secret Service). The app refuses to fall back to plaintext credential storage.

## Testing & Verification

```powershell
npm test                 # 362 unit tests across 44 test files
npm run lint             # ESLint, zero violations
npm run test:e2e         # E2E smoke: launch → edit/save → context toggles → diff review → agent authorization → model switch → mode hot-reload
```

Ten more iteration-level E2E suites (`npm run test:e2e2` … `test:e2e14`) cover the authorization gate, crash recovery, auto-update, MCP, transparent RAG, multi-agent orchestration, zero-cost models, mode export/import, and the community mode ecosystem — with evidence persisted under `evidence/AC*`.

Acceptance gate scripts:

```powershell
python verification/self-check.py --project-root .
python verification/consistency-check.py --project-root .
python verification/check-context-audit.py --project-root .
```

## Packaging & Release

```powershell
npm run pack   # electron-builder --dir → release/win-unpacked
npm run dist   # NSIS installer → release/DevWit Setup x.y.z.exe
```

Pushing a `v*` tag triggers CD (GitHub Actions builds and publishes a Release).

## Security Design

- Credentials are encrypted via safeStorage before persisting — never stored in plaintext
- Renderer CSP is locked down; IPC surface is a minimal whitelist
- All destructive agent operations pass through the authorization gate; decisions are recorded in the trace
