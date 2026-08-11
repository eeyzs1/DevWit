// Reddit publish v5 — Playwright pierces shadow DOM; click exact Post in composer
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const TITLE = "DevWit: open-source AI IDE with transparent LLM context + approval gate";
const BODY = `Most AI coding tools are black boxes. DevWit is a free MIT desktop IDE where:

1. Context transparency — every LLM request shows system prompt, tools, RAG hits, terminal output with per-item token costs you can toggle off.
2. Authorization gate — file writes and shell commands need one-click approval before they run.

Standalone IDE (not a VS Code plugin): self-built editor, TS+Python LSP, Git, DAP, MCP, multi-agent orchestration. Ollama keyless local models supported.

GitHub: https://github.com/eeyzs1/DevWit
v0.5.0: https://github.com/eeyzs1/DevWit/releases/tag/v0.5.0

Happy to answer architecture questions.`;

const log = (m) => console.log(`[reddit ${new Date().toISOString()}] ${m}`);

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  // Reuse existing submit tab if any, else new
  let page = ctx.pages().find((p) => /reddit\.com\/r\/SideProject\/submit/.test(p.url()));
  if (!page) page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  page.on("dialog", async (d) => {
    try {
      await d.dismiss();
    } catch (_) {}
  });

  await page.goto("https://www.reddit.com/r/SideProject/submit/?type=TEXT", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(5000);

  // Title: placeholder Title*
  const title = page.getByPlaceholder(/Title/i).first();
  await title.waitFor({ state: "visible", timeout: 20000 });
  await title.click();
  await title.fill(TITLE);
  log("title ok");

  // Body inside shreddit-composer
  const bodyBox = page.locator("shreddit-composer div[role='textbox'][contenteditable='true']").first();
  await bodyBox.waitFor({ state: "visible", timeout: 15000 });
  await bodyBox.click();
  await page.keyboard.press("Control+A");
  // paste is faster / more reliable than type for long text
  await page.evaluate(async (t) => {
    await navigator.clipboard.writeText(t);
  }, BODY).catch(() => null);
  const pasted = await page.keyboard.press("Control+V").then(() => true).catch(() => false);
  if (!pasted) {
    await page.keyboard.insertText(BODY);
  }
  log("body ok");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(EVIDENCE, "reddit-v5-filled.png"), fullPage: true });

  // Post button — prefer the one next to Save Draft in composer footer
  const postBtn = page
    .locator("r-post-composer-form")
    .getByRole("button", { name: /^Post$/i })
    .or(page.getByRole("button", { name: /^Post$/i }))
    .last();

  await postBtn.waitFor({ state: "visible", timeout: 15000 });
  for (let i = 0; i < 20; i++) {
    const dis = await postBtn.isDisabled().catch(() => false);
    const aria = await postBtn.getAttribute("aria-disabled").catch(() => null);
    log(`post disabled=${dis} aria-disabled=${aria}`);
    if (!dis && aria !== "true") break;
    await page.waitForTimeout(500);
  }

  // Click and wait for navigation
  const [nav] = await Promise.all([
    page.waitForURL(/\/comments\/|\/r\/SideProject\/comments\//, { timeout: 45000 }).catch(() => null),
    postBtn.click({ force: true }),
  ]);
  log("after click url=" + page.url() + " nav=" + !!nav);

  // If still on submit, try mouse click at button box
  if (!/\/comments\//.test(page.url())) {
    const box = await postBtn.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      log("mouse click at " + JSON.stringify(box));
      await page.waitForTimeout(8000);
    }
  }

  // captcha?
  const hasCaptcha = await page.locator("iframe[src*='recaptcha'], #rc-anchor, text=/captcha/i").count();
  log("captchaHints=" + hasCaptcha);

  await page.screenshot({ path: path.join(EVIDENCE, "reddit-v5-after.png"), fullPage: true });
  const result = {
    url: page.url(),
    title: await page.title(),
    ok: /\/comments\//.test(page.url()),
    head: (await page.locator("body").innerText()).slice(0, 900).replace(/\s+/g, " "),
  };
  fs.writeFileSync(path.join(EVIDENCE, "reddit-publish-result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
