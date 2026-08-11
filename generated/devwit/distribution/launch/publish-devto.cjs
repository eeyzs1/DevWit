// Publish DevWit v0.5.0 to dev.to via Chrome CDP.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CDP = "http://localhost:9222";
const EVIDENCE = path.join(__dirname, "evidence");
const BODY = fs.readFileSync(path.join(__dirname, "blog-devto-v050.md"), "utf8");
const TITLE = "DevWit v0.5.0: an open-source AI IDE with a transparent context panel (and a real editor)";
const log = (m) => console.log(`[devto ${new Date().toISOString()}] ${m}`);

(async () => {
  log("script=v2 start");
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(30000);

  await page.goto("https://dev.to/new", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  await page.locator("#article-form-title").fill(TITLE);
  log("title ok");

  // tags via JS on the tags component if present
  const tagInput = page.locator("#tag-input").first();
  if (await tagInput.count()) {
    for (const tag of ["ai", "opensource", "electron", "productivity"]) {
      await tagInput.fill(tag);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(350);
    }
    log("tags ok");
  }

  await page.locator("#article_body_markdown").fill(BODY);
  log("body ok");
  await page.screenshot({ path: path.join(EVIDENCE, "devto-v2-01.png"), fullPage: true });

  // Dump footer buttons
  const btns = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).map((b) => ({
      text: (b.innerText || "").trim().slice(0, 40),
      cls: b.className.slice(0, 80),
      visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
      disabled: b.disabled,
      type: b.type,
    })).filter((b) => /publish|draft|confirm|save/i.test(b.text))
  );
  log("buttons=" + JSON.stringify(btns));
  fs.writeFileSync(path.join(EVIDENCE, "devto-v2-buttons.json"), JSON.stringify(btns, null, 2));

  // Click the first visible Publish
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const pub = buttons.find((b) => /^publish$/i.test((b.innerText || "").trim()) && (b.offsetWidth || b.offsetHeight));
    if (!pub) return null;
    pub.click();
    return (pub.innerText || "").trim();
  });
  log("clicked=" + clicked);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(EVIDENCE, "devto-v2-02.png"), fullPage: true });

  // If a modal appeared, click visible Confirm/Publish inside dialogs
  const modalClick = await page.evaluate(() => {
    const modal = document.querySelector("[role='dialog'], .crayons-modal, .modal, #publish-form");
    const scope = modal || document;
    const buttons = Array.from(scope.querySelectorAll("button"));
    const target = buttons.find((b) => {
      const t = (b.innerText || "").trim();
      const vis = !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length);
      return vis && /^(publish|publish now|confirm)$/i.test(t);
    });
    if (!target) return { found: false, texts: buttons.map((b) => (b.innerText || "").trim()).filter(Boolean).slice(0, 20) };
    target.click();
    return { found: true, text: (target.innerText || "").trim() };
  });
  log("modalClick=" + JSON.stringify(modalClick));
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(EVIDENCE, "devto-v2-03.png"), fullPage: true });

  // dump page errors / flash messages
  const flash = await page.evaluate(() => (document.body.innerText || "").slice(0, 1500));
  fs.writeFileSync(path.join(EVIDENCE, "devto-v2-body.txt"), flash);

  const result = { ok: !/\/new$/.test(page.url()), url: page.url(), title: await page.title() };
  fs.writeFileSync(path.join(EVIDENCE, "devto-publish-result.json"), JSON.stringify(result, null, 2));
  log("result=" + JSON.stringify(result));
  await page.close();
  process.exit(result.ok ? 0 : 2);
})().catch((e) => { console.error(e); process.exit(1); });
