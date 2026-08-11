# Contributing to DevWit

Thanks for helping make DevWit better. This repo hosts the product under `generated/devwit/` (Electron + TypeScript monorepo). Meta-harness files at the repo root are generation scaffolding — product work happens in `generated/devwit/`.

## Quick start

```powershell
cd generated/devwit
npm install
npm run rebuild-native   # optional: node-pty for the integrated terminal
npx tsc -b
npm test
npm run build
npm run dev
```

Requirements: Node.js 20+, Windows / macOS / Linux.

## What to work on

Good first contributions:

- Bug fixes with a failing test (or e2e script under `apps/desktop/tests/e2e/`)
- Docs / README / localization (`packages/i18n` — all UI strings go through `t()`)
- Packaging / distribution hygiene (winget, Homebrew, release notes)
- Accessibility and onboarding clarity

Please open an issue before large features so we can align with the product constraints below.

## Hard constraints (do not break)

1. **i18n** — no hard-coded Chinese/English UI strings; use `t("…")`
2. **ASCII error codes** — main-process stderr uses `DW_*` codes only
3. **Free software** — no accounts, paywalls, cloud sync, or mode marketplace
4. **Telemetry opt-in** — default off; anonymous; no content collection
5. **Hot config** — settings (including credentials) must apply without restart
6. **No mocks for real integrations** — use real APIs/CLIs in tests or document why not

## Pull request checklist

- [ ] `npx tsc -b` passes
- [ ] `npm test` passes
- [ ] New UI strings added to both `zh-CN` and `en-US` dictionaries
- [ ] No secrets committed (`launch-credentials.env`, API keys, cookies)
- [ ] Commit messages follow `type(scope): 中文描述` (e.g. `fix(editor): …`)

## Reporting bugs / feedback

Use GitHub Issues with the templates under `.github/ISSUE_TEMPLATE/`. Include:

- OS + DevWit version (from Settings → General)
- Steps to reproduce
- Expected vs actual
- Logs / screenshots if relevant (strip secrets)

Product Hunt and other review comments are also treated as feedback — maintainers triage them into issues.

## Code of conduct

Be respectful. Assume good faith. No harassment, spam, or malware PRs. Maintainers may close off-topic or abusive threads.
