// v0.7.30 社区更新：dev.to + 掘金（Chrome CDP 9222，复用已验证选择器流程）
// 用法：
//   node publish-v0730.mjs check   → 只检查登录态
//   node publish-v0730.mjs devto   → 发布 dev.to
//   node publish-v0730.mjs juejin  → 发布掘金
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const DEVTO_BODY = fs.readFileSync(path.join(__dirname, "blog-devto-v0730.md"), "utf8");
const DEVTO_TITLE = "DevWit v0.7.30: the AI IDE that shows every token — now with a real terminal and a command palette";
const JUEJIN_SRC = fs.readFileSync(path.join(__dirname, "blog-juejin-v0730.md"), "utf8");

const mode = process.argv[2] ?? "check";

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];

async function checkLogins() {
  // dev.to
  const d = await context.newPage();
  await d.goto("https://dev.to/settings", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await d.waitForTimeout(2000);
  const devtoIn = /dev\.to/.test(d.url()) && !/enter/.test(d.url());
  console.log(`dev.to 登录态: ${devtoIn ? "✅ 已登录" : "❌ 未登录（" + d.url() + "）"}`);
  await d.close();
  // juejin
  const j = await context.newPage();
  await j.goto("https://juejin.cn/user/settings", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await j.waitForTimeout(2500);
  const juejinIn = /juejin\.cn/.test(j.url()) && !/login/.test(j.url());
  console.log(`掘金 登录态: ${juejinIn ? "✅ 已登录" : "❌ 未登录（" + j.url() + "）"}`);
  await j.close();
}

async function publishDevto() {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto("https://dev.to/new", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  if (/enter/.test(page.url())) { console.error("❌ dev.to 未登录"); process.exit(2); }

  await page.locator("#article-form-title").fill(DEVTO_TITLE);
  const tagInput = page.locator("#tag-input").first();
  if (await tagInput.count()) {
    for (const tag of ["ai", "opensource", "electron", "productivity"]) {
      await tagInput.fill(tag);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(350);
    }
  }
  await page.locator("#article_body_markdown").fill(DEVTO_BODY);
  await page.screenshot({ path: path.join(EVIDENCE, "devto-v730-01-filled.png"), fullPage: true });
  log("filled, publishing");

  const clicked = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find((x) => /^publish$/i.test((x.innerText || "").trim()) && (x.offsetWidth || x.offsetHeight));
    if (!b) return null;
    b.click();
    return true;
  });
  await page.waitForTimeout(2500);
  const modalClick = await page.evaluate(() => {
    const scope = document.querySelector("[role='dialog'], .crayons-modal, #publish-form") || document;
    const t = Array.from(scope.querySelectorAll("button")).find((b) => {
      const x = (b.innerText || "").trim();
      return x && /^(publish|publish now|confirm)$/i.test(x) && (b.offsetWidth || b.offsetHeight);
    });
    if (!t) return false;
    t.click();
    return true;
  });
  log(`clicked=${clicked} modal=${modalClick}`);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(EVIDENCE, "devto-v730-02-final.png"), fullPage: true });
  const ok = !/\/new$/.test(page.url());
  fs.writeFileSync(path.join(EVIDENCE, "devto-v730-result.json"), JSON.stringify({ ok, url: page.url() }, null, 2));
  console.log(ok ? `✅ 发布成功: ${page.url()}` : `❌ 仍在编辑页: ${page.url()}`);
  await page.close();
  process.exit(ok ? 0 : 2);
}

async function publishJuejin() {
  const lines = JUEJIN_SRC.split(/\r?\n/);
  const titleLine = lines.find((l) => l.startsWith("# ")) || "";
  const title = titleLine.replace(/^#\s+/, "").trim();
  const body = lines.filter((l) => l !== titleLine).join("\n").trim() + "\n";
  log(`title=${title.slice(0, 30)}… bodyLen=${body.length}`);

  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto("https://juejin.cn/editor/drafts/new", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  if (/login/.test(page.url())) { console.error("❌ 掘金未登录"); process.exit(2); }

  for (const t of ["取消", "关闭"]) {
    const b = page.locator(`button:has-text('${t}')`).first();
    if (await b.count() && await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
  await page.locator("input.title-input").fill(title);
  const cmOk = await page.evaluate((text) => {
    const host = document.querySelector(".CodeMirror");
    if (!host || !host.CodeMirror) return false;
    host.CodeMirror.setValue(text);
    return true;
  }, body);
  log("codemirror=" + cmOk);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v730-01-filled.png") });

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => (x.innerText || "").trim() === "发布");
    if (b) b.click();
  });
  await page.waitForTimeout(2000);
  // 分类
  await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("*")).filter((el) => (el.innerText || "").trim() === "分类");
    for (const lab of labels) {
      const box = lab.parentElement && lab.parentElement.querySelector(".byte-select, input");
      if (box) { box.click(); return; }
    }
    const s = Array.from(document.querySelectorAll(".byte-select"));
    if (s[0]) s[0].click();
  });
  await page.waitForTimeout(800);
  const picked = await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll(".byte-select-option, li, [role='option']"));
    const want = opts.find((o) => /人工智能|前端/.test(o.innerText || ""));
    if (want) { want.click(); return (want.innerText || "").trim(); }
    return null;
  });
  log("category=" + picked);
  // 标签
  const tagBox = page.locator("input[placeholder*='标签'], input[placeholder*='搜索标签']").first();
  if (await tagBox.count()) {
    for (const t of ["AI", "开源"]) {
      await tagBox.fill(t);
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
    }
  }
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v730-02-ready.png") });
  const confirmed = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => (x.innerText || "").includes("确定并发布"));
    if (!b) return false;
    b.click();
    return true;
  });
  log("confirm=" + confirmed);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(EVIDENCE, "juejin-v730-03-final.png"), fullPage: true });
  const ok = /juejin\.cn\/(post|spost|article)\//.test(page.url());
  fs.writeFileSync(path.join(EVIDENCE, "juejin-v730-result.json"), JSON.stringify({ ok, url: page.url() }, null, 2));
  console.log(ok ? `✅ 发布成功: ${page.url()}` : `❌ 未跳转到文章页: ${page.url()}（可能进入审核，截图见 evidence/juejin-v730-03-final.png）`);
  await page.close();
  process.exit(ok ? 0 : 2);
}

if (mode === "check") await checkLogins();
else if (mode === "devto") await publishDevto();
else if (mode === "juejin") await publishJuejin();
else { console.error("用法: node publish-v0730.mjs [check|devto|juejin]"); process.exit(1); }
process.exit(0);
