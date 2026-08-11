// Probe sites reachable from Chrome CDP profile (may use browser extensions/proxy).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.setDefaultTimeout(25000);

  const targets = [
    ["devto", "https://dev.to/"],
    ["juejin", "https://juejin.cn/"],
    ["hn", "https://news.ycombinator.com/"],
    ["reddit", "https://www.reddit.com/"],
    ["github", "https://github.com/eeyzs1/DevWit"],
  ];

  for (const [name, url] of targets) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(1500);
      const title = await page.title();
      console.log(JSON.stringify({ name, ok: true, status: resp && resp.status(), title, finalUrl: page.url() }));
      await page.screenshot({ path: path.join(EVIDENCE, `probe-reach-${name}.png`) });
    } catch (e) {
      console.log(JSON.stringify({ name, ok: false, error: e.message.split("\n")[0] }));
    }
  }
  await page.close();
})().catch((e) => { console.error(e); process.exit(1); });
