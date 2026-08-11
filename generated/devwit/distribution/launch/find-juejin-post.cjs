const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();

  // search site for title
  const q = encodeURIComponent("Cursor 的上下文是黑盒——我造了个透明的 AI IDE");
  await page.goto(`https://juejin.cn/search?query=${q}&type=0`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-search.png"), fullPage: true });
  let posts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href*='/post/']")).map((a) => ({ href: a.href.split("?")[0], text: (a.innerText || "").trim().slice(0, 120) })).slice(0, 15)
  );
  console.log("SEARCH", posts);

  // notifications
  await page.goto("https://juejin.cn/notification", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-notif.png"), fullPage: true });
  const notif = (await page.locator("body").innerText()).slice(0, 1500);
  console.log("NOTIF", notif.replace(/\s+/g, " ").slice(0, 800));

  // creator home
  await page.goto("https://juejin.cn/creator/home", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-creator-home.png"), fullPage: true });
  const home = (await page.locator("body").innerText()).slice(0, 1200);
  console.log("HOME", home.replace(/\s+/g, " ").slice(0, 800));

  // audit / review list?
  for (const u of [
    "https://juejin.cn/creator/content/article/all",
    "https://juejin.cn/creator/content/article/draft",
    "https://juejin.cn/creator/content/article/audit",
  ]) {
    await page.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2000);
    const t = await page.title();
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a")).map((a) => a.href).filter((h) => /post|draft|article/.test(h)).slice(0, 10)
    );
    const body = (await page.locator("body").innerText()).slice(0, 400).replace(/\s+/g, " ");
    console.log(JSON.stringify({ u, t, links, body }));
  }

  fs.writeFileSync(path.join(EVIDENCE, "juejin-find.json"), JSON.stringify({ posts }, null, 2));
  await page.close();
})().catch((e) => { console.error(e); process.exit(1); });
