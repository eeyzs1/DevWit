const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(45000);
  await page.goto("https://www.reddit.com/user/me/submitted/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"))
      .map((a) => ({ href: a.href, t: (a.innerText || "").trim().slice(0, 100) }))
      .filter((x) => /\/comments\//.test(x.href) && /devwit|opensource|transparent/i.test(x.t + x.href));
    return {
      url: location.href,
      hasRemoved: /removed by Reddit/i.test(document.body.innerText),
      snippet: document.body.innerText.replace(/\s+/g, " ").slice(0, 900),
      links: links.slice(0, 10),
    };
  });
  fs.writeFileSync(
    path.join(__dirname, "evidence", "reddit-opensource-check.json"),
    JSON.stringify(info, null, 2)
  );
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(__dirname, "evidence", "reddit-opensource-submitted.png") }).catch(() => {});
  await page.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
