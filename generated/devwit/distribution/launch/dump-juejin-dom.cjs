// Dump 掘金 editor DOM to design the publisher.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  await page.goto("https://juejin.cn/editor/drafts/new", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const pick = (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 30).map((el) => ({
      sel,
      tag: el.tagName,
      id: el.id,
      class: el.className && String(el.className).slice(0, 120),
      placeholder: el.getAttribute("placeholder"),
      role: el.getAttribute("role"),
      contentEditable: el.getAttribute("contenteditable"),
      text: (el.innerText || "").slice(0, 80),
    }));
    return {
      url: location.href,
      title: document.title,
      inputs: pick("input, textarea, [contenteditable=true], .CodeMirror, .bytemd, .ProseMirror, button"),
      titleCandidates: pick("input[placeholder*='标题'], input.title, .title-input input, textarea"),
    };
  });
  fs.writeFileSync(path.join(EVIDENCE, "juejin-dom.json"), JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-dom.png"), fullPage: true });
  console.log(JSON.stringify(info, null, 2));
  await page.close();
})().catch((e) => { console.error(e); process.exit(1); });
