// Minimal finish: open draft → ensure category → confirm publish.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const CDP = "http://localhost:9222";
const DRAFT = "https://juejin.cn/editor/drafts/7672325240563662902";
const EVIDENCE = path.join(__dirname, "evidence");
const log = (m) => console.log(`[juejin ${new Date().toISOString()}] ${m}`);

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(20000);
  await page.goto(DRAFT, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // Open publish dialog
  const hasConfirm = await page.locator("button:has-text('确定并发布')").isVisible().catch(() => false);
  if (!hasConfirm) {
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => (x.innerText || "").trim() === "发布");
      if (b) b.click();
    });
    await page.waitForTimeout(1500);
  }
  log("dialog open");

  // Click category pills inside the modal only
  await page.evaluate(() => {
    const modal = Array.from(document.querySelectorAll("div")).find((d) => (d.innerText || "").includes("发布文章") && (d.innerText || "").includes("确定并发布"));
    const root = modal || document;
    const pills = Array.from(root.querySelectorAll("span, button, div")).filter((el) => {
      const t = (el.innerText || "").trim();
      return t === "人工智能" || t === "开发工具" || t === "前端";
    });
    // prefer 人工智能
    const ai = pills.find((p) => (p.innerText || "").trim() === "人工智能");
    (ai || pills[0])?.click();
  });
  await page.waitForTimeout(500);

  // Ensure at least one tag: click tag box, type, pick first dropdown option via mouse
  await page.evaluate(async () => {
    const placeholder = Array.from(document.querySelectorAll("div, span")).find((el) => (el.innerText || "").trim() === "请搜索添加标签");
    if (placeholder) placeholder.click();
  });
  await page.waitForTimeout(300);
  // Find the active input in the modal
  const tagInput = page.locator(".byte-select--filterable input, .select-plus input, input.byte-select__input").first();
  if (await tagInput.count()) {
    await tagInput.fill("前端");
    await page.waitForTimeout(900);
    // click first visible dropdown option that is not TOC
    await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll(".byte-select-option, .byte-popper .byte-select-option, [class*='select-option']"));
      const vis = opts.find((o) => o.offsetParent !== null);
      if (vis) vis.click();
    });
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v4-ready.png") });

  // Confirm
  await page.locator("button:has-text('确定并发布')").click({ force: true });
  log("confirm clicked");

  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    if (/\/post\//.test(page.url())) break;
    const msg = await page.evaluate(() => {
      const t = document.querySelector(".byte-message, .byte-toast, .toast-message, .success-message");
      return t ? t.innerText : "";
    });
    if (msg) log("msg=" + msg.replace(/\s+/g, " ").slice(0, 120));
  }
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v4-final.png"), fullPage: true });
  const result = { url: page.url(), title: await page.title() };
  fs.writeFileSync(path.join(EVIDENCE, "juejin-publish-result.json"), JSON.stringify(result, null, 2));
  log(JSON.stringify(result));
  await page.close();
  process.exit(/\/post\//.test(result.url) ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
