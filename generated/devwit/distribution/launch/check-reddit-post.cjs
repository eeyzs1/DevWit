// Check if DevWit post exists on r/SideProject
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(30000);

  // Search user posts / new queue
  const urls = [
    "https://www.reddit.com/r/SideProject/new/",
    "https://www.reddit.com/user/me/submitted/",
    "https://www.reddit.com/search/?q=DevWit%20transparent%20LLM&type=link&sort=new",
  ];
  const findings = [];
  for (const u of urls) {
    await page.goto(u, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const hits = await page.evaluate(() => {
      const text = document.body.innerText;
      const links = Array.from(document.querySelectorAll("a[href*='/comments/']"))
        .map((a) => ({ href: a.href, t: (a.innerText || "").trim().slice(0, 120) }))
        .filter((x) => /devwit|transparent|approval gate|LLM context/i.test(x.t + x.href));
      return {
        url: location.href,
        hasDevWit: /DevWit/i.test(text),
        snippet: text.includes("DevWit")
          ? text.slice(Math.max(0, text.search(/DevWit/i) - 80), text.search(/DevWit/i) + 200)
          : null,
        links,
      };
    });
    findings.push(hits);
    await page.screenshot({
      path: path.join(EVIDENCE, "reddit-check-" + findings.length + ".png"),
      fullPage: true,
    });
    console.log(JSON.stringify(hits, null, 2));
  }
  fs.writeFileSync(path.join(EVIDENCE, "reddit-check.json"), JSON.stringify(findings, null, 2));
  await page.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
