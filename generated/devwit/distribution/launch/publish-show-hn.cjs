// Create HN account (anonymous) + submit Show HN.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const CREDS = path.resolve(__dirname, "..", "..", "launch-credentials.env");
const TITLE = "Show HN: DevWit – AI IDE that shows exactly what it sends to the LLM";
const TEXT = `I built a desktop AI IDE where every LLM request is fully transparent: you see the system prompt, the tool list, each injected code chunk / RAG hit / terminal output, and the token cost of each item — and you can toggle any of them off before sending.

The agent mode has an authorization gate: file writes and shell commands require one-click approval, and every decision is logged in the execution trace. The context manifest can be exported as JSON for audit.

It's a standalone IDE (not a VS Code plugin) with a self-built editor kernel (piece-table buffer + Canvas rendering + tree-sitter), TypeScript + Python LSP, Git, DAP debugging, MCP server support, and multi-agent orchestration.

MIT licensed, free, no accounts, no cloud sync, telemetry opt-in off by default. 747 unit tests, three-platform builds (Windows / macOS / Linux). Latest: v0.5.0.

GitHub: https://github.com/eeyzs1/DevWit

I built it because I was uncomfortable not knowing what AI coding tools were actually sending on my behalf, and wanted to control the cost and approve actions before they happened. Happy to answer questions about the architecture or the context engine.`;

const log = (m) => console.log(`[hn ${new Date().toISOString()}] ${m}`);

function upsertCred(key, value) {
  let raw = fs.existsSync(CREDS) ? fs.readFileSync(CREDS, "utf8") : "";
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, "m").test(raw)) {
    raw = raw.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else {
    raw = raw.replace(/\s*$/, "") + `\n\n# Hacker News (Show HN)\n${line}\n`;
  }
  fs.writeFileSync(CREDS, raw);
}

(async () => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(45000);

  const candidates = ["eeyzs1", "devwit", "devwit_ide", "eeyzs1_devwit"];
  const password = "Dw!" + crypto.randomBytes(9).toString("base64url");

  let username = null;
  await page.goto("https://news.ycombinator.com/login?goto=submit", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  for (const u of candidates) {
    log(`try create account: ${u}`);
    // Create Account form is the second form on the page
    const forms = page.locator("form");
    const createForm = forms.nth(1);
    await createForm.locator("input[name='acct']").fill(u);
    await createForm.locator("input[name='pw']").fill(password);
    await createForm.locator("input[type='submit']").click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(EVIDENCE, `hn-create-${u}.png`), fullPage: true });
    const body = await page.locator("body").innerText();
    const ok =
      (await page.locator("a[href^='logout']").count()) > 0 ||
      /logout/i.test(body) ||
      page.url().includes("submit") && (await page.locator("input[name='title']").count()) > 0;
    if (ok) {
      username = u;
      log(`account ready: ${u}`);
      break;
    }
    // username taken / validation error — stay on login and try next
    log(`failed ${u}: ${body.slice(0, 200).replace(/\s+/g, " ")}`);
    if (!page.url().includes("login")) {
      await page.goto("https://news.ycombinator.com/login?goto=submit", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);
    }
  }

  if (!username) {
    // Maybe eeyzs1 exists — try login with unknown password won't work.
    fs.writeFileSync(path.join(EVIDENCE, "hn-account-failed.txt"), "Could not create HN account");
    await page.close();
    process.exit(4);
  }

  upsertCred("HN_USERNAME", username);
  upsertCred("HN_PASSWORD", password);
  log("credentials saved to launch-credentials.env");

  // Ensure on submit
  if (!(await page.locator("input[name='title']").count())) {
    await page.goto("https://news.ycombinator.com/submit", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
  }

  await page.locator("input[name='title']").fill(TITLE);
  const urlInput = page.locator("input[name='url']");
  if (await urlInput.count()) await urlInput.fill("");
  await page.locator("textarea[name='text']").fill(TEXT);
  await page.screenshot({ path: path.join(EVIDENCE, "hn-03-filled.png"), fullPage: true });
  await page.locator("input[type='submit']").first().click();
  log("submitted");
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(EVIDENCE, "hn-04-after.png"), fullPage: true });

  const result = {
    username,
    url: page.url(),
    title: await page.title(),
    body: (await page.locator("body").innerText()).slice(0, 1000).replace(/\s+/g, " "),
  };
  // Try to find item link
  const itemHref = await page.locator("a[href*='item?id=']").first().getAttribute("href").catch(() => null);
  if (itemHref) result.itemUrl = new URL(itemHref, "https://news.ycombinator.com").href;
  fs.writeFileSync(path.join(EVIDENCE, "hn-publish-result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify(result));
  await page.close();
  const ok = !/submit$/.test(result.url) || !!result.itemUrl;
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
