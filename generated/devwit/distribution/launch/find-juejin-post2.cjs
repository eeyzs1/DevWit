const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();

  const urls = [
    "https://juejin.cn/creator/content/article/essays?status=all",
    "https://juejin.cn/creator/content/article/essays?status=0",
    "https://juejin.cn/creator/content/article/essays?status=1",
    "https://juejin.cn/creator/content/article/essays?status=2",
  ];
  for (const u of urls) {
    await page.goto(u, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1000);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a")).map((a) => ({ href: a.href, t: (a.innerText || "").trim().slice(0, 80) }))
        .filter((x) => /post|透明|黑盒|DevWit|AI IDE/i.test(x.href + x.t))
        .slice(0, 20)
    );
    console.log(JSON.stringify({ u, links, body }, null, 2));
    await page.screenshot({ path: path.join(EVIDENCE, `juejin-essays-${u.slice(-1)}.png`), fullPage: true });
  }

  // intercept list API by visiting creator and listening
  const articles = [];
  page.on("response", async (resp) => {
    try {
      const u = resp.url();
      if (/article|content_api|creator/.test(u) && resp.status() === 200) {
        const ct = resp.headers()["content-type"] || "";
        if (ct.includes("json")) {
          const json = await resp.json().catch(() => null);
          if (json) articles.push({ u, json: JSON.stringify(json).slice(0, 2000) });
        }
      }
    } catch (_) {}
  });
  await page.goto("https://juejin.cn/creator/content/article/essays?status=all", { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(4000);
  fs.writeFileSync(path.join(EVIDENCE, "juejin-api-sniff.json"), JSON.stringify(articles, null, 2));
  console.log("API_HITS", articles.length);
  for (const a of articles.slice(0, 8)) console.log(a.u, a.json.slice(0, 300));

  await page.close();
})().catch((e) => { console.error(e); process.exit(1); });
