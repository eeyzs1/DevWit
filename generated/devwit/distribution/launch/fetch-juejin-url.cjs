const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  // published success page may have link; also check creator center
  await page.goto("https://juejin.cn/published", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-published-page.png"), fullPage: true });

  await page.goto("https://juejin.cn/creator/content/article/published", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-creator-list.png"), fullPage: true });
  const posts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href*='/post/']"))
      .map((a) => ({ href: a.href, text: (a.innerText || "").trim().slice(0, 100) }))
      .filter((x) => x.text)
      .slice(0, 10)
  );
  console.log(JSON.stringify(posts, null, 2));
  fs.writeFileSync(path.join(EVIDENCE, "juejin-published-links.json"), JSON.stringify(posts, null, 2));

  // fallback: user profile articles
  if (!posts.length) {
    await page.goto("https://juejin.cn/user/self?tab=posts", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(EVIDENCE, "juejin-self-posts.png"), fullPage: true });
    const posts2 = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href*='/post/']")).map((a) => ({ href: a.href, text: (a.innerText || "").trim().slice(0, 100) })).slice(0, 10)
    );
    console.log("SELF", JSON.stringify(posts2, null, 2));
    fs.writeFileSync(path.join(EVIDENCE, "juejin-published-links.json"), JSON.stringify(posts2, null, 2));
  }
  await page.close();
})().catch((e) => { console.error(e); process.exit(1); });
