// Resubmit HN with title ≤80 chars.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const TITLE = "DevWit: open-source AI IDE with transparent LLM context + auth gate";
// length check
if (TITLE.length > 80) throw new Error("title too long: " + TITLE.length);
const log = (m) => console.log(`[hn ${new Date().toISOString()}] ${m}`);

(async () => {
  log("titleLen=" + TITLE.length);
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(45000);
  await page.goto("https://news.ycombinator.com/submit", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  if (!(await page.locator("input[name='title']").count())) {
    log("NO_FORM " + page.url());
    await page.screenshot({ path: path.join(EVIDENCE, "hn-07-noform.png"), fullPage: true });
    process.exit(3);
  }
  await page.locator("input[name='title']").fill(TITLE);
  await page.locator("input[name='url']").fill("https://github.com/eeyzs1/DevWit");
  await page.locator("textarea[name='text']").fill("");
  await page.screenshot({ path: path.join(EVIDENCE, "hn-07-filled.png"), fullPage: true });
  await page.locator("input[type='submit']").first().click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(EVIDENCE, "hn-08-after.png"), fullPage: true });
  const itemHref = await page.locator("a[href*='item?id=']").first().getAttribute("href").catch(() => null);
  const result = {
    title: TITLE,
    titleLen: TITLE.length,
    url: page.url(),
    pageTitle: await page.title(),
    itemUrl: itemHref ? new URL(itemHref, "https://news.ycombinator.com").href : null,
    body: (await page.locator("body").innerText()).slice(0, 800).replace(/\s+/g, " "),
  };
  fs.writeFileSync(path.join(EVIDENCE, "hn-publish-result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify(result));
  await page.close();
  const blocked = /showlim|toolong|login|You have to be/i.test(result.url + result.body);
  const ok = !!result.itemUrl || (/item\?id=/.test(result.url)) || (/newest|submitted/.test(result.url) && !blocked);
  process.exit(ok && !blocked ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
