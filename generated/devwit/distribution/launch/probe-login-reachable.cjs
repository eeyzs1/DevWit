// Probe login on reachable platforms only (dev.to + 掘金).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const out = {};

  // --- dev.to ---
  await page.goto("https://dev.to/new", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(EVIDENCE, "probe-devto-new.png"), fullPage: true });
  const devBody = await page.locator("body").innerText();
  out.devto = {
    url: page.url(),
    title: await page.title(),
    hasEditor: (await page.locator("#article-form-title, #article_body_markdown, textarea").count()) > 0,
    loginHints: /Log in|Sign up with|Continue with GitHub/i.test(devBody.slice(0, 2000)),
    snippet: devBody.slice(0, 400).replace(/\s+/g, " "),
  };

  // --- 掘金 ---
  await page.goto("https://juejin.cn/editor/drafts/new", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(EVIDENCE, "probe-juejin-new.png"), fullPage: true });
  const jjBody = await page.locator("body").innerText();
  out.juejin = {
    url: page.url(),
    title: await page.title(),
    hasEditor: (await page.locator(".CodeMirror, .bytemd, .ProseMirror, textarea").count()) > 0,
    loginHints: /登录|手机号登录|验证码/.test(jjBody.slice(0, 1500)),
    snippet: jjBody.slice(0, 400).replace(/\s+/g, " "),
  };

  // existing posts
  await page.goto("https://dev.to/eeyzs1", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(EVIDENCE, "probe-devto-profile.png") });
  out.devtoProfile = {
    url: page.url(),
    title: await page.title(),
    snippet: (await page.locator("body").innerText()).slice(0, 600).replace(/\s+/g, " "),
  };

  fs.writeFileSync(path.join(EVIDENCE, "probe-login-reachable.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await page.close();
})().catch((e) => { console.error(e); process.exit(1); });
