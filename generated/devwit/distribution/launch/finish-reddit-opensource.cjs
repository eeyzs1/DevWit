// Finish r/opensource submit — dismiss rules warning + optional flair
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const EVIDENCE = path.join(__dirname, "evidence");
const log = (m) => console.log(`[reddit-finish ${new Date().toISOString()}] ${m}`);

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => /reddit\.com\/r\/opensource\/submit/.test(p.url()));
  if (!page) {
    page = await ctx.newPage();
    await page.goto("https://www.reddit.com/r/opensource/submit/?type=TEXT", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3000);
  }
  page.setDefaultTimeout(20000);

  // If rules modal visible
  const submitAnyway = page.getByRole("button", { name: /Submit without editing/i });
  if (await submitAnyway.isVisible().catch(() => false)) {
    await submitAnyway.click();
    log("clicked Submit without editing");
    await page.waitForTimeout(2000);
  }

  // Try flair if still on submit
  if (/\/submit/.test(page.url())) {
    const flairBtn = page.getByRole("button", { name: /Add flair|flair and tags/i }).first();
    if (await flairBtn.isVisible().catch(() => false)) {
      await flairBtn.click({ force: true });
      await page.waitForTimeout(1000);
      const promo = page.getByText(/Self[- ]?Promotion|Project|Show|Announcement/i).first();
      if (await promo.isVisible().catch(() => false)) {
        await promo.click({ force: true });
        log("selected flair");
      }
      const apply = page.getByRole("button", { name: /^Apply$/i }).first();
      if (await apply.isVisible().catch(() => false)) await apply.click();
      await page.waitForTimeout(800);
    }
    const postBtn = page.getByRole("button", { name: /^Post$/i }).last();
    if (await postBtn.isVisible().catch(() => false)) {
      await postBtn.click({ force: true });
      log("Post clicked again");
    }
    // rules modal again?
    await page.waitForTimeout(1500);
    if (await submitAnyway.isVisible().catch(() => false)) {
      await submitAnyway.click();
      log("Submit without editing (2)");
    }
  }

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    if (/\/comments\//.test(page.url())) break;
  }
  await page.screenshot({ path: path.join(EVIDENCE, "reddit-opensource-final.png"), fullPage: true });
  const text = await page.locator("body").innerText();
  const result = {
    url: page.url(),
    ok: /\/comments\//.test(page.url()),
    removed: /removed by Reddit/i.test(text),
    head: text.replace(/\s+/g, " ").slice(0, 600),
  };
  fs.writeFileSync(path.join(EVIDENCE, "reddit-opensource-result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify(result));
  process.exit(result.ok && !result.removed ? 0 : 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
