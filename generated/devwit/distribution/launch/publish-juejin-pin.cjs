// 掘金沸点 — target .rich-editor contenteditable
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const TEXT = `开源了 DevWit v0.5.0：透明上下文的 AI 原生桌面 IDE。

每次发给模型的内容（系统提示/工具/RAG/终端）逐项可见，带 token，可关掉；Agent 写文件和跑命令要先批准。MIT 免费，Win/Mac/Linux 都有包。

https://github.com/eeyzs1/DevWit
https://github.com/eeyzs1/DevWit/releases/tag/v0.5.0`;

const log = (m) => console.log(`[pins ${new Date().toISOString()}] ${m}`);

(async () => {
  log("textLen=" + TEXT.length);
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(30000);
  await page.goto("https://juejin.cn/pins", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // focus rich editor
  const editor = page.locator(".rich-editor, [contenteditable=true]").first();
  await editor.click({ force: true });
  await page.waitForTimeout(400);
  // select all and replace
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(TEXT);
  await page.waitForTimeout(500);
  const typed = await editor.innerText();
  log("typedLen=" + typed.length + " head=" + typed.slice(0, 40).replace(/\s+/g, " "));
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-pins-v2-filled.png") });

  await page.locator("button.active:has-text('发布'), button:has-text('发布')").first().click();
  log("clicked publish");
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-pins-v2-after.png"), fullPage: true });

  // check my pins count / presence
  const body = await page.locator("body").innerText();
  const found = body.includes("DevWit") || body.includes("透明上下文");
  // go to my pins if link exists
  await page.goto("https://juejin.cn/pins/mine", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-pins-v2-mine.png"), fullPage: true });
  const mine = await page.locator("body").innerText();
  const result = {
    foundOnFeed: found,
    mineUrl: page.url(),
    mineHasDevwit: /DevWit|透明上下文/.test(mine),
    mineSnippet: mine.slice(0, 500).replace(/\s+/g, " "),
  };
  fs.writeFileSync(path.join(EVIDENCE, "juejin-pins-result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify(result));
  await page.close();
  process.exit(result.mineHasDevwit || result.foundOnFeed ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
