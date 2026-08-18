// Fallback: regular HN link post (Show HN restricted for new accounts) + Reddit.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const log = (m) => console.log(`[post ${new Date().toISOString()}] ${m}`);

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(45000);
  const out = {};

  // --- HN regular link submission ---
  await page.goto("https://news.ycombinator.com/submit", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const hasForm = (await page.locator("input[name='title']").count()) > 0;
  log("hn form=" + hasForm + " url=" + page.url());
  if (hasForm) {
    await page.locator("input[name='title']").fill("DevWit – open-source AI IDE with per-item LLM context transparency and an authorization gate");
    await page.locator("input[name='url']").fill("https://github.com/eeyzs1/DevWit");
    // leave text empty for URL submissions
    await page.locator("textarea[name='text']").fill("");
    await page.screenshot({ path: path.join(EVIDENCE, "hn-05-link-filled.png"), fullPage: true });
    await page.locator("input[type='submit']").first().click();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(EVIDENCE, "hn-06-link-after.png"), fullPage: true });
    const itemHref = await page.locator("a[href*='item?id=']").first().getAttribute("href").catch(() => null);
    out.hn = {
      url: page.url(),
      title: await page.title(),
      itemUrl: itemHref ? new URL(itemHref, "https://news.ycombinator.com").href : null,
      body: (await page.locator("body").innerText()).slice(0, 500).replace(/\s+/g, " "),
    };
    log("hn=" + JSON.stringify(out.hn));
  } else {
    out.hn = { error: "not logged in / no form", url: page.url() };
  }

  // --- Reddit r/opensource or r/SideProject (r/programming is stricter) ---
  // Try r/opensource submit
  await page.goto("https://www.reddit.com/r/opensource/submit/?type=TEXT", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(EVIDENCE, "reddit-01.png"), fullPage: true });
  const rBody = await page.locator("body").innerText().catch(() => "");
  out.reddit = {
    url: page.url(),
    title: await page.title(),
    snippet: rBody.slice(0, 500).replace(/\s+/g, " "),
    loginWall: /log in|sign up/i.test(rBody.slice(0, 800)),
  };
  log("reddit probe=" + JSON.stringify(out.reddit));

  // If composer available, fill
  const titleBox = page.locator('textarea[placeholder*="Title"], input[placeholder*="Title"], div[aria-label*="Post title"], textarea[name="title"]').first();
  const bodyBox = page.locator('div[data-contents="true"], div[role="textbox"], textarea[placeholder*="Body"], div[contenteditable="true"]').first();
  if (!out.reddit.loginWall && (await titleBox.count())) {
    await titleBox.fill("I built an open-source AI IDE that shows every token it sends to the LLM — and requires approval before agent actions");
    if (await bodyBox.count()) {
      const text = `Most AI coding tools are black boxes. DevWit is a free MIT desktop IDE where every LLM request shows its full context (system prompt, tools, RAG hits, terminal output) with per-item token costs you can toggle off, and agent file writes / shell commands need one-click approval.

Standalone IDE (not a VS Code plugin): self-built editor, TS+Python LSP, Git, DAP, MCP, multi-agent orchestration. Ollama keyless local models supported.

GitHub: https://github.com/eeyzs1/DevWit
Release: https://github.com/eeyzs1/DevWit/releases/tag/v0.5.0`;
      await bodyBox.click();
      await page.keyboard.insertText(text);
    }
    await page.screenshot({ path: path.join(EVIDENCE, "reddit-02-filled.png"), fullPage: true });
    const postBtn = page.locator('button:has-text("Post"), button:has-text("Submit")').first();
    if (await postBtn.count()) {
      await postBtn.click();
      await page.waitForTimeout(5000);
      await page.screenshot({ path: path.join(EVIDENCE, "reddit-03-after.png"), fullPage: true });
      out.reddit.after = { url: page.url(), title: await page.title() };
    }
  }

  fs.writeFileSync(path.join(EVIDENCE, "hn-reddit-fallback-result.json"), JSON.stringify(out, null, 2));
  await page.close();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
