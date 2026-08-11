// Soft Reddit re-post to r/opensource — human-paced, TEXT type, no force-disable strip
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const TITLE = "Show: DevWit — open-source AI IDE with transparent per-item LLM context + approval gate";
const BODY = `I built a free MIT desktop IDE because most AI coding tools are black boxes.

Two things I cared about:

1) Context transparency — every LLM request shows the system prompt, tools, RAG hits, and terminal output with per-item token costs. You can toggle any item off and the request shrinks.

2) Authorization gate — file writes and shell commands need one-click approval before they run (on by default).

It's a standalone IDE (not a VS Code plugin): self-built editor, TS+Python LSP, Git, DAP, MCP, multi-agent orchestration. Ollama works without an API key.

GitHub: https://github.com/eeyzs1/DevWit
Latest: https://github.com/eeyzs1/DevWit/releases/tag/v0.5.0

Happy to answer architecture questions — especially around context manifests / audit traces.`;

const log = (m) => console.log(`[reddit-os ${new Date().toISOString()}] ${m}`);

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(45000);

  await page.goto("https://www.reddit.com/r/opensource/submit/?type=TEXT", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(5000);

  const title = page.getByPlaceholder(/Title/i).first();
  await title.waitFor({ state: "visible", timeout: 20000 });
  await title.click();
  await title.fill(TITLE);
  log("title ok");

  const bodyBox = page.locator("shreddit-composer div[role='textbox'][contenteditable='true']").first();
  await bodyBox.waitFor({ state: "visible", timeout: 15000 });
  await bodyBox.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(BODY);
  log("body ok");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(EVIDENCE, "reddit-opensource-filled.png"), fullPage: true });

  const postBtn = page.getByRole("button", { name: /^Post$/i }).last();
  await postBtn.waitFor({ state: "visible", timeout: 15000 });
  for (let i = 0; i < 20; i++) {
    if (!(await postBtn.isDisabled().catch(() => false))) break;
    await page.waitForTimeout(400);
  }
  await postBtn.click({ force: true });
  log("posted click");

  for (let i = 0; i < 35; i++) {
    await page.waitForTimeout(1000);
    if (/\/comments\//.test(page.url())) break;
  }
  await page.screenshot({ path: path.join(EVIDENCE, "reddit-opensource-after.png"), fullPage: true });
  const text = (await page.locator("body").innerText()).slice(0, 1200);
  const result = {
    url: page.url(),
    ok: /\/comments\//.test(page.url()),
    removed: /removed by Reddit/i.test(text),
    head: text.replace(/\s+/g, " ").slice(0, 500),
  };
  fs.writeFileSync(path.join(EVIDENCE, "reddit-opensource-result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify(result));
  process.exit(result.ok && !result.removed ? 0 : 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
