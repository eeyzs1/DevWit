// Publish 掘金 — verbose, short timeouts, CodeMirror setValue.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const SRC = path.join(__dirname, "promotion", "juejin.md");
const log = (m) => console.log(`[juejin ${new Date().toISOString()}] ${m}`);

(async () => {
  log("start");
  const raw = fs.readFileSync(SRC, "utf8");
  const lines = raw.split(/\r?\n/);
  const titleLine = lines.find((l) => l.startsWith("# ")) || "";
  const title = titleLine.replace(/^#\s+/, "").trim();
  const body = lines.filter((l) => l !== titleLine).join("\n").trim() + "\n";
  log(`title=${title.slice(0, 40)}… bodyLen=${body.length}`);

  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(20000);

  await page.goto("https://juejin.cn/editor/drafts/new", { waitUntil: "domcontentloaded", timeout: 30000 });
  log("editor loaded " + page.url());
  await page.waitForTimeout(3000);

  // dismiss dialogs
  for (const t of ["取消", "关闭"]) {
    const b = page.locator(`button:has-text('${t}')`).first();
    if (await b.count()) {
      const vis = await b.isVisible().catch(() => false);
      if (vis) { await b.click().catch(() => {}); log("dismissed " + t); }
    }
  }

  await page.locator("input.title-input").fill(title);
  log("title filled");

  const cmOk = await page.evaluate((text) => {
    const host = document.querySelector(".CodeMirror");
    if (!host || !host.CodeMirror) return false;
    host.CodeMirror.setValue(text);
    return true;
  }, body);
  log("codemirror=" + cmOk);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v2-01-filled.png") });

  // click top-right 发布 (not 确定并发布 yet)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const pub = btns.find((b) => (b.innerText || "").trim() === "发布");
    if (pub) pub.click();
  });
  log("clicked 发布");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v2-02-dialog.png") });

  // dump dialog fields
  const dialogInfo = await page.evaluate(() => {
    const texts = Array.from(document.querySelectorAll("button, label, .byte-select, input"))
      .map((el) => ({
        tag: el.tagName,
        text: (el.innerText || el.placeholder || "").trim().slice(0, 60),
        cls: (el.className || "").toString().slice(0, 60),
        vis: !!(el.offsetWidth || el.offsetHeight),
      }))
      .filter((x) => x.vis && x.text)
      .slice(0, 40);
    return texts;
  });
  fs.writeFileSync(path.join(EVIDENCE, "juejin-v2-dialog.json"), JSON.stringify(dialogInfo, null, 2));
  log("dialog fields=" + dialogInfo.length);

  // Try to pick category: click first byte-select that looks like 分类
  await page.evaluate(() => {
    // click any visible select that mentions 分类 nearby
    const labels = Array.from(document.querySelectorAll("*")).filter((el) => (el.innerText || "").trim() === "分类");
    for (const lab of labels) {
      const box = lab.parentElement && lab.parentElement.querySelector(".byte-select, input");
      if (box) { box.click(); return; }
    }
    const selects = Array.from(document.querySelectorAll(".byte-select"));
    if (selects[0]) selects[0].click();
  });
  await page.waitForTimeout(800);
  // pick 人工智能 or 前端
  const picked = await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll(".byte-select-option, li, .option, [role='option']"));
    const want = opts.find((o) => /人工智能|前端/.test(o.innerText || ""));
    if (want) { want.click(); return (want.innerText || "").trim(); }
    return null;
  });
  log("category=" + picked);

  // Tags: find tag input
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const tag = inputs.find((i) => /标签|搜索/.test(i.placeholder || "") || /tag/i.test(i.className));
    if (tag) tag.focus();
  });
  const tagBox = page.locator("input[placeholder*='标签'], input[placeholder*='搜索标签']").first();
  if (await tagBox.count()) {
    for (const t of ["AI", "开源"]) {
      await tagBox.fill(t);
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
    }
    log("tags typed");
  }

  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v2-03-ready.png") });

  // 确定并发布
  const confirmed = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const b = btns.find((x) => (x.innerText || "").includes("确定并发布"));
    if (!b) return false;
    b.click();
    return true;
  });
  log("confirm=" + confirmed);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v2-04-final.png"), fullPage: true });

  const result = { url: page.url(), title: await page.title(), bodySnippet: (await page.locator("body").innerText()).slice(0, 500) };
  fs.writeFileSync(path.join(EVIDENCE, "juejin-publish-result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify({ url: result.url, title: result.title }));
  await page.close();
  const ok = /juejin\.cn\/(post|article)\//.test(result.url);
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
