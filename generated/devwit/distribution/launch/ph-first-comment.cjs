// PH 首发上线后发 Maker 首评（等上线 → 评论 → 证据）
// 由计划任务 DevWit-PH-FirstComment（2026-07-30 15:03）经 ph-first-comment.cmd 调用；
// 也可手动：node distribution\launch\ph-first-comment.cjs
// 前提：本机浏览器以 CDP 9222 运行且已登录 PH（user-data-dir 用 .tmp-chrome-profile 镜像）
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const POST_URL = "https://www.producthunt.com/posts/devwit";
const COMMENT_FILE = path.join(__dirname, "ph-first-comment.txt");
const EVIDENCE = path.join(__dirname, "evidence");
const MAX_WAIT_MIN = 20; // 等上线最长 20 分钟

(async () => {
  const comment = fs.readFileSync(COMMENT_FILE, "utf8").trim();
  if (!comment) throw new Error("comment file empty");

  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // ---- 1. 轮询等 post 上线 ----
  let live = false;
  for (let i = 0; i < MAX_WAIT_MIN * 6; i++) {
    try {
      const resp = await page.goto(POST_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(5000);
      const st = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        has404: /Page not found|404/i.test(document.body.innerText.slice(0, 800)),
      }));
      console.log(`[poll ${i}] ${resp?.status()} ${st.url} title=${st.title.slice(0, 60)}`);
      if (resp && resp.status() === 200 && !st.has404 && /devwit/i.test(st.url + st.title)) { live = true; break; }
    } catch (e) { console.log(`[poll ${i}] err: ${String(e).slice(0, 120)}`); }
    await page.waitForTimeout(10000);
  }
  if (!live) { console.error("POST NOT LIVE after waiting"); await page.close(); await browser.close(); process.exit(2); }

  // ---- 2. 找评论框 ----
  await page.waitForTimeout(3000);
  // 滚到底部评论区
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
  await page.waitForTimeout(2000);

  let box = page.locator('textarea[placeholder*="think" i], textarea[placeholder*="comment" i], textarea[name*="comment" i], [contenteditable="true"][data-placeholder*="comment" i]').first();
  if (!(await box.count())) {
    // 兜底：点 "Add a comment" / "Join the discussion" 类触发元素
    const trigger = page.locator('button:has-text("comment"), [placeholder*="discussion" i], div:has-text("What do you think")').first();
    if (await trigger.count()) { await trigger.click().catch(() => {}); await page.waitForTimeout(2000); }
    box = page.locator("textarea:visible, [contenteditable=true]:visible").first();
  }
  if (!(await box.count())) {
    const dump = await page.evaluate(() => {
      const tas = [...document.querySelectorAll("textarea, [contenteditable=true]")].map((e) => ({
        tag: e.tagName, ph: e.placeholder || e.getAttribute("data-placeholder") || "", vis: e.offsetWidth > 0,
      }));
      const btns = [...document.querySelectorAll("button")].filter((e) => e.offsetWidth > 0).map((e) => (e.innerText || "").trim()).filter((t) => t && t.length < 30).slice(0, 30);
      return { tas, btns, bodyStart: document.body.innerText.slice(0, 600).replace(/\n/g, "|") };
    });
    console.error("COMMENT BOX NOT FOUND. DUMP:", JSON.stringify(dump, null, 1));
    await page.screenshot({ path: path.join(EVIDENCE, "ph-40-comment-fail.png"), timeout: 10000 }).catch(() => {});
    await page.close(); await browser.close(); process.exit(3);
  }

  // ---- 3. 填首评并提交 ----
  await box.click();
  await box.fill(comment).catch(async () => {
    // contenteditable 兜底
    await page.evaluate((txt) => {
      const el = document.querySelector("[contenteditable=true]");
      if (el) { el.focus(); el.innerText = txt; el.dispatchEvent(new InputEvent("input", { bubbles: true })); }
    }, comment);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(EVIDENCE, "ph-41-comment-filled.png"), timeout: 10000 }).catch(() => {});

  const submit = page.locator('button:has-text("Post"), button:has-text("Comment"), button:has-text("Submit"), button[type=submit]').first();
  if (await submit.count()) {
    await submit.click();
  } else {
    await box.press("Control+Enter").catch(() => {});
  }
  await page.waitForTimeout(6000);

  // ---- 4. 核验首评出现 ----
  const ok = await page.evaluate((frag) => document.body.innerText.includes(frag), comment.slice(0, 60));
  console.log("COMMENT POSTED:", ok);
  await page.screenshot({ path: path.join(EVIDENCE, "ph-42-comment-posted.png"), fullPage: false, timeout: 10000 }).catch(() => {});
  console.log("FINAL URL:", page.url());
  await page.close();
  await browser.close();
  process.exit(ok ? 0 : 4);
})().catch((e) => { console.error("FATAL:", String(e).slice(0, 400)); process.exit(1); });
