# DevWit — Minimal-Context AI-Native Desktop IDE

[中文版](README.md)

DevWit is a self-built AI-native desktop IDE. It combines VSCode-grade editing, Cursor-style conversational coding, Claude Code-style agent execution, and a pi-agent-inspired minimal context design that avoids long-context bloat — delivering an efficient, transparent, and auditable AI development experience.

## Key Features

| Feature | Description |
|---------|-------------|
| Custom editor kernel | Piece-table text buffer + Canvas rendering + tree-sitter highlighting, with IME (CJK) input, multi-cursor, undo/redo |
| Minimal context engine | The full context composition of every LLM request (system prompt, tool list, injected items, per-item token cost) is visible item-by-item and can be toggled individually; manifests are persisted for audit |
| Conversational coding | Request code changes in chat; edits are presented as an in-editor diff with per-hunk accept/reject |
| Agent mode | Authorization gate: file writes and terminal commands require explicit user approval; multi-step tasks with fully visible execution traces |
| Multi-model support | Anthropic API and OpenAI-compatible API, custom base URL and API key (encrypted via safeStorage), switch models mid-session |
| Custom modes | Create/edit/delete modes — each mode defines its own system prompt, toolset, model, and context injection policy; changes take effect hot, no restart |

## Tech Stack

- Electron 37 + TypeScript 5.8 (monorepo, npm workspaces)
- esbuild for bundling, vitest for unit tests, Playwright over CDP for E2E
- electron-builder produces the Windows NSIS installer and portable build

## Repository Layout

```
apps/desktop        Electron app (main / preload / renderer / E2E)
packages/
  contracts         Cross-process contract types (IPC whitelist)
  editor-core       Piece-table document kernel (DOM-free)
  editor-render     Canvas rendering view + IME input capture
  syntax            tree-sitter highlight engine
  llm-providers     Anthropic / OpenAI-compatible clients (SSE streaming)
  context-engine    Minimal context engine (manifest + token metering + per-item policy)
  agent-runtime     Agent loop, tool execution, authorization gate, tracing
  chat-ui           Chat/context/diff panels (headless controllers + DOM views)
  modes             Mode definition store (hot-reload events)
  settings          Settings and credentials (safeStorage encryption)
  workspace         File tree, git status, workspace service
  terminal          Terminal service (pipe / node-pty backends)
verification/       Acceptance check scripts (context audit, anti-mock, architecture boundaries, secret scan, ...)
evidence/           AC1–AC7 acceptance evidence (screenshots, manifests, traces, build logs)
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
npm test                 # 216 unit tests across 27 test files
npm run lint             # ESLint, zero violations
npm run test:e2e         # E2E smoke: launch → edit/save → context toggles → diff review → agent authorization → model switch → mode hot-reload
```

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
