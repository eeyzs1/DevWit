// 抓取 PH 帖子所有评论全文（公开页面，不需要登录）
// 复用 reply-furkan.cjs 的 Chrome 原生启动 + connectOverCDP 方案过 Cloudflare
const { chromium } = require("playwright");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const POST_URL = "https://www.producthunt.com/posts/devwit";
const USER_DATA_DIR = "C:\\Users\\eeyzs1\\AppData\\Local\\Temp\\chrome-cdp-profile";
const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EVIDENCE = path.join(__dirname, "evidence");
const CDP_URL = "http://localhost:9222";

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function launchChromeNative() {
  log(`Launching Chrome (native, CDP, opening PH)...`);
  return execFile(CHROME_EXE, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    POST_URL,
  ], { windowsHide: false });
}

async function waitForCDP(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${CDP_URL}/json/version`);
      if (resp.ok) return await resp.json();
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP did not become available within 30s");
}

(async () => {
  log("=== Fetch PH Comments Start ===");
  let chromeProc = null;
  let browser = null;

  try {
    chromeProc = launchChromeNative();
    await waitForCDP();
    log("CDP alive");

    log("Waiting 20s for Chrome native navigation + Cloudflare...");
    await new Promise((r) => setTimeout(r, 20000));

    browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    const existingPages = context.pages();
    const page = existingPages.find((p) => /producthunt/i.test(p.url())) || existingPages[0];
    page.setDefaultTimeout(30000);

    // 检查 Cloudflare
    let title = await page.title();
    log(`Page title: ${title}`);
    if (/Just a moment|Cloudflare/i.test(title)) {
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(5000);
        title = await page.title();
        if (!/Just a moment|Cloudflare/i.test(title)) break;
        log(`Cloudflare check ${i + 1}/8...`);
      }
    }
    log(`Page loaded: ${title}`);

    // 等 SPA 稳定
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);
      const t = await page.title();
      if (!/Loading|Just a moment|Cloudflare/i.test(t)) break;
      log(`Page loading (${i + 1}/10): ${t}`);
    }
    await page.waitForTimeout(2000);

    // 滚动加载评论
    log("Scrolling to load comments...");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.8));
    await page.waitForTimeout(3000);

    // 抓取所有评论
    log("Extracting comments...");
    const comments = await page.evaluate(() => {
      // PH 评论通常在 [data-test] 或特定 class 的容器里
      // 用通用策略：找所有包含用户名 + 评论文本的容器
      const results = [];

      // 策略：找所有包含 "comment" 相关属性的元素（扫描入口，段落遍历才是实际抽取）
      void document.querySelectorAll(
        '[data-test*="comment" i], [class*="comment" i], [class*="Comment" i], article'
      );

      // 更通用：找所有有结构化文本的 div
      const allText = document.body.innerText;

      // 提取评论：找包含 @mention 或特征文本的段落
      const paragraphs = [...document.querySelectorAll("p, span, div")];
      const seen = new Set();
      for (const p of paragraphs) {
        const text = (p.innerText || "").trim();
        // 评论特征：20-1000 字符，不含导航文本
        if (text.length < 20 || text.length > 1000) continue;
        if (seen.has(text)) continue;
        // 排除按钮、导航等
        if (/^(Reply|Share|More|Upvote|Sign in|Follow|Posted by|Get the app)$/i.test(text)) continue;
        // 排除纯数字（点赞数）
        if (/^\d+$/.test(text)) continue;
        // 包含实际内容词
        if (/\b(token|cost|AI|IDE|context|DevWit|cursor|transparent|breakdown|toggle|useful|clever|love|great|tool|developer|code)\b/i.test(text)) {
          seen.add(text);
          results.push(text);
        }
      }

      return { allTextPreview: allText.slice(0, 500), comments: results };
    });

    log(`Found ${comments.comments.length} potential comment texts`);
    console.log("\n=== ALL COMMENT TEXTS ===");
    comments.comments.forEach((c, i) => {
      console.log(`\n--- Comment ${i + 1} ---`);
      console.log(c);
    });
    console.log("\n=== PAGE TEXT PREVIEW (first 500 chars) ===");
    console.log(comments.allTextPreview);

    // 保存到文件
    const outFile = path.join(EVIDENCE, "ph-all-comments.txt");
    const outContent = `=== PH Comments Extracted ${new Date().toISOString()} ===\n\n` +
      comments.comments.map((c, i) => `--- Comment ${i + 1} ---\n${c}`).join("\n\n");
    fs.writeFileSync(outFile, outContent);
    log(`Saved to ${outFile}`);

    // 截图
    await page.screenshot({ path: path.join(EVIDENCE, "ph-comments-screenshot.png"), fullPage: true });
    log("Screenshot saved");

    log("=== Fetch PH Comments SUCCESS ===");
  } catch (e) {
    log(`FATAL: ${String(e).slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    if (chromeProc) { try { chromeProc.kill(); } catch (_) {} }
    try { require("child_process").execSync('taskkill /F /IM chrome.exe', { stdio: "ignore" }); } catch (_) {}
    log("Chrome closed");
  }
})();
