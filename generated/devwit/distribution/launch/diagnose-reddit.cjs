// Diagnose Reddit submit page controls
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const EVIDENCE = path.join(__dirname, "evidence");

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(30000);
  await page.goto("https://www.reddit.com/r/SideProject/submit/?type=TEXT", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(4000);

  const info = await page.evaluate(() => {
    const deep = (root, out = []) => {
      const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 1) {
          const el = node;
          const tag = el.tagName;
          if (tag === "BUTTON" || el.getAttribute("role") === "button" || tag.includes("-")) {
            const r = el.getBoundingClientRect();
            out.push({
              tag,
              text: (el.innerText || "").trim().slice(0, 80),
              aria: el.getAttribute("aria-label"),
              testid: el.getAttribute("data-testid"),
              disabled: el.disabled || el.getAttribute("aria-disabled"),
              w: Math.round(r.width),
              h: Math.round(r.height),
              y: Math.round(r.top),
            });
          }
          if (el.shadowRoot) walk(el.shadowRoot);
          for (const c of el.children || []) walk(c);
        }
      };
      walk(root);
      return out;
    };
    const buttons = deep(document.body).filter(
      (b) => b.w > 0 && /post|submit|save|draft|tag|flair|text|title/i.test(b.text + (b.aria || "") + (b.testid || ""))
    );
    const fields = Array.from(
      document.querySelectorAll(
        'textarea, input, [contenteditable="true"], [data-lexical-editor], [placeholder]'
      )
    ).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        ph: el.getAttribute("placeholder"),
        name: el.getAttribute("name"),
        testid: el.getAttribute("data-testid"),
        role: el.getAttribute("role"),
        ce: el.getAttribute("contenteditable"),
        w: Math.round(r.width),
        h: Math.round(r.height),
        y: Math.round(r.top),
      };
    });
    return { url: location.href, buttons, fields };
  });

  fs.writeFileSync(path.join(EVIDENCE, "reddit-dom.json"), JSON.stringify(info, null, 2));
  await page.screenshot({ path: path.join(EVIDENCE, "reddit-dom.png"), fullPage: true });
  console.log(JSON.stringify(info, null, 2));
  await page.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
