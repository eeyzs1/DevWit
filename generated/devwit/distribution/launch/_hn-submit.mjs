// HN Show HN 提交（v0.7.30 版文案）——需已登录（_hn-account.mjs 创建）
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.join(__dirname, "evidence");
const log = (m) => console.log(`[hn ${new Date().toISOString()}] ${m}`);

const TITLE = "Show HN: DevWit – an AI IDE that shows every token it sends to the model";
const TEXT = `I built a desktop AI IDE where every LLM request is fully transparent: the system prompt, the tool list, and each injected item (code files, RAG hits, terminal output, diagnostics) appear in a manifest with its own token cost — and any item can be toggled off before sending. Manifests persist to disk, so "what did the model actually see when it produced this diff" is answerable weeks later.

The agent mode has an authorization gate: file writes and shell commands require one-click approval before they run, and every decision is logged in an auditable execution trace. Not a system-prompt promise — the tool execution path physically routes through the authorizer.

It's a standalone IDE (not a VS Code plugin) with a self-built editor kernel (piece-table buffer + Canvas rendering + tree-sitter), built-in terminal with ANSI streaming, command palette, TypeScript + Python LSP, Git, DAP debugging, MCP server support, and multi-agent orchestration.

Engineering notes: the codebase went through 8 rounds of adversarial review (147 findings fixed, including 5 criticals — details in the CHANGELOG), verified by 975 unit tests and 37 E2E suites that drive the real packaged app.

MIT licensed, free, no accounts, no cloud sync, telemetry opt-in and off by default. Windows / macOS / Linux.

Install: winget install eeyzs1.DevWit · brew install --cask eeyzs1/tap/devwit

GitHub: https://github.com/eeyzs1/DevWit

I built it because I was uncomfortable not knowing what AI coding tools send on my behalf, and wanted per-item cost control and pre-approval of agent actions. Happy to answer questions about the architecture, the context engine, or the review process.`;

const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = await browser.contexts()[0].newPage();
page.setDefaultTimeout(45000);

await page.goto("https://news.ycombinator.com/submit", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

// 登录检查：/submit 顶栏无 logout 链接——以「title 输入框存在 + 未被踢到 /login」判定
//（若会话丢失，HN 会把 /submit 重定向到 /login?goto=submit）
if (/\/login/.test(page.url()) || !(await page.locator("input[name='title']").count())) {
  console.error("❌ 未登录（会话丢失）——需重跑 _hn-login.mjs");
  await page.close();
  process.exit(4);
}

await page.locator("input[name='title']").fill(TITLE);
const urlInput = page.locator("input[name='url']");
if (await urlInput.count()) await urlInput.fill("");
await page.locator("textarea[name='text']").fill(TEXT);
await page.screenshot({ path: path.join(EVIDENCE, "hn-v730-01-filled.png"), fullPage: true });
log("filled, submitting");

await page.locator("input[type='submit']").first().click();
await page.waitForTimeout(4000);
await page.screenshot({ path: path.join(EVIDENCE, "hn-v730-02-after.png"), fullPage: true });

const result = { url: page.url(), title: await page.title() };
const itemHref = await page.locator("a[href*='item?id=']").first().getAttribute("href").catch(() => null);
if (itemHref) result.itemUrl = new URL(itemHref, "https://news.ycombinator.com").href;
fs.writeFileSync(path.join(EVIDENCE, "hn-v730-result.json"), JSON.stringify(result, null, 2));
log(JSON.stringify(result));
await page.close();
const ok = !/submit$/.test(result.url) || !!result.itemUrl;
console.log(ok ? `✅ Show HN 已提交: ${result.itemUrl || result.url}` : `❌ 提交未成功: ${result.url}`);
process.exit(ok ? 0 : 2);
