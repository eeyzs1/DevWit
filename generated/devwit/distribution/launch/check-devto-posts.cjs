const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  await page.goto("https://dev.to/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(EVIDENCE, "devto-dashboard.png"), fullPage: true });
  const text = await page.locator("body").innerText();
  fs.writeFileSync(path.join(EVIDENCE, "devto-dashboard.txt"), text.slice(0, 4000));
  console.log(text.slice(0, 2500));

  await page.goto("https://dev.to/eeyzs1", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(EVIDENCE, "devto-profile-after.png"), fullPage: true });
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href*='/eeyzs1/']"))
      .map((a) => ({ href: a.href, text: (a.innerText || "").trim().slice(0, 120) }))
      .filter((x) => x.text && !/edit profile|comments/i.test(x.text))
      .slice(0, 20)
  );
  console.log("LINKS", JSON.stringify(links, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, "devto-profile-links.json"), JSON.stringify(links, null, 2));
  await page.close();
})().catch((e) => { console.error(e); process.exit(1); });
