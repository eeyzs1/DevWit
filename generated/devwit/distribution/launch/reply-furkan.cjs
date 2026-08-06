// 回复 PH 上 Furkan 的评论（单次任务脚本）
// 方案：原生启动 Chrome（CDP + 临时 profile，绕过 Chrome 150 默认 profile 限制 + Cloudflare 自动化检测）
//       connectOverCDP 连接（Chrome 原生启动无 Playwright 自动化参数，Cloudflare 不拦）
const { chromium } = require("playwright");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const POST_URL = "https://www.producthunt.com/posts/devwit";
const USER_DATA_DIR = "C:\\Users\\eeyzs1\\AppData\\Local\\Temp\\chrome-cdp-profile";
const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EVIDENCE = path.join(__dirname, "evidence");
const STATE_FILE = path.join(EVIDENCE, "ph-comment-state.json");
const CDP_URL = "http://localhost:9222";

const FURKAN_MARKER = "per-item token cost toggle";
const REPLY_TEXT = `Thanks @Furkan! Really glad the per-item token cost toggle resonated — it came from my own frustration of not knowing what each request actually cost. Every item in the context panel (system prompt, tools, RAG chunks, terminal output) shows its token count, and you can toggle any of them off to shrink the request in real time. If you try it, would love to hear what else would make the cost transparency more useful for your workflow.`;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// 原生启动 Chrome（无 Playwright 自动化参数，Cloudflare 不拦）
// 启动时直接打开 PH——Chrome 原生导航在 CDP 连接前完成 Cloudflare 验证
function launchChromeNative() {
  log(`Launching Chrome (native, CDP port 9222, temp profile, opening PH)...`);
  const child = execFile(CHROME_EXE, [
    "--remote-debugging-port=9222",
    `--user-data-dir=${USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    POST_URL,
  ], { windowsHide: false });
  return child;
}

// 等待 CDP 端口可用
async function waitForCDP(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${CDP_URL}/json/version`);
      if (resp.ok) {
        const info = await resp.json();
        return info;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP did not become available within 30s");
}

(async () => {
  log("=== Reply to Furkan Start ===");
  let chromeProc = null;
  let browser = null;

  try {
    // 1. 原生启动 Chrome
    chromeProc = launchChromeNative();
    const cdpInfo = await waitForCDP();
    log(`CDP alive: ${cdpInfo.Browser}`);

    // 2. connectOverCDP（Chrome 已在启动时打开 PH，原生导航完成 Cloudflare 验证）
    log("Waiting 20s for Chrome native navigation + Cloudflare clearance...");
    await new Promise((r) => setTimeout(r, 20000));
    browser = await chromium.connectOverCDP(CDP_URL);
    const context = browser.contexts()[0];
    // 用 Chrome 已打开的 tab（不 newPage，避免触发新导航被 Cloudflare 拦）
    const existingPages = context.pages();
    const page = existingPages.find((p) => /producthunt/i.test(p.url())) || existingPages[0] || (await context.newPage());
    page.setDefaultTimeout(30000);

    // 检查 Cloudflare 是否已通过（Chrome 原生导航完成的）
    const titleAfterLoad = await page.title();
    log(`Page title after native load: ${titleAfterLoad}`);
    if (/Just a moment|Cloudflare/i.test(titleAfterLoad)) {
      log("Cloudflare still checking, waiting up to 40s more...");
      let passed = false;
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(5000);
        const t = await page.title();
        if (!/Just a moment|Cloudflare/i.test(t)) { passed = true; break; }
        log(`Cloudflare check ${i + 1}/8...`);
      }
      if (!passed) {
        log("FATAL: Cloudflare blocked even after native navigation");
        await page.screenshot({ path: path.join(EVIDENCE, "reply-furkan-cloudflare.png") });
        throw new Error("Cloudflare blocked");
      }
    }
    log(`Page loaded: ${await page.title()}`);

    // Cloudflare 通过后 PH SPA 可能仍在加载，等标题 + DOM 稳定
    log("Waiting for PH SPA to stabilize...");
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);
      const t = await page.title();
      if (!/Loading|Just a moment|Cloudflare/i.test(t)) {
        log(`Page stable: ${t}`);
        break;
      }
      log(`Page still loading (${i + 1}/10): ${t}`);
      if (i === 9) log("WARNING: page not stable after 30s, attempting to proceed");
    }
    await page.waitForTimeout(2000);

    // 4. 检查登录（未登录则等用户在 Chrome 窗口手动登录）
    let loggedIn = await page.evaluate(() => {
      const onPH = /producthunt\.com/i.test(window.location.href); return onPH && !/Sign in|Login to comment/i.test(document.body.innerText.slice(0, 2000));
    });
    if (!loggedIn) {
      log("NOT LOGGED IN >>> 请在弹出的 Chrome 窗口登录 Product Hunt <<<（轮询等待最多 240 秒）...");
      const loginDeadline = Date.now() + 240000;
      while (Date.now() < loginDeadline) {
        await page.waitForTimeout(3000);
        try {
          loggedIn = await page.evaluate(() => {
            const onPH = /producthunt\.com/i.test(window.location.href); return onPH && !/Sign in|Login to comment/i.test(document.body.innerText.slice(0, 2000));
          });
          if (loggedIn) {
            log("Login detected! Continuing...");
            break;
          }
        } catch (e) {
          log("Page navigating during login wait, retrying...");
        }
      }
      if (!loggedIn) {
        log("FATAL: Login wait timeout (240s)");
        throw new Error("Login timeout");
      }
    } else {
      log("Logged in confirmed");
    }

    // 5. 登录后确保在帖子页 + 等页面稳定 + 滚动加载评论
    log("Login successful, ensuring we're on the post page...");
    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    log(`Current URL: ${currentUrl}`);
    if (!/posts\/devwit/i.test(currentUrl)) {
      log("Not on post page, navigating back...");
      await page.goto(POST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(5000);
        const title = await page.title();
        if (!/Just a moment|Cloudflare/i.test(title)) break;
        log(`Cloudflare check ${i + 1}/6...`);
      }
      log(`Page loaded: ${await page.title()}`);
      await page.waitForTimeout(3000);
    }
    // 多次滚动加载评论
    log("Scrolling to load comments...");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.5));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.8));
    await page.waitForTimeout(2000);

    // 6. 定位 Furkan 评论容器并 hover
    log("Locating Furkan's comment...");
    const commentInfo = await page.evaluate((marker) => {
      const all = [...document.querySelectorAll("*")];
      for (const el of all) {
        if (el.children.length === 0 && el.innerText && el.innerText.includes(marker)) {
          let container = el;
          for (let d = 0; d < 15; d++) {
            container = container?.parentElement;
            if (!container) break;
            const txt = container.innerText || "";
            if (txt.includes("Reply") && txt.length > 50 && txt.length < 3000) {
              const rect = container.getBoundingClientRect();
              container.scrollIntoView({ block: "center" });
              container.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
              container.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              return { found: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }
          }
        }
      }
      return { found: false };
    }, FURKAN_MARKER);

    if (!commentInfo.found) {
      log("FATAL: Could not locate Furkan's comment");
      await page.screenshot({ path: path.join(EVIDENCE, "reply-furkan-not-found.png"), fullPage: true });
      throw new Error("Comment not found");
    }
    log("Furkan's comment located, hovering...");
    await page.mouse.move(commentInfo.x, commentInfo.y);
    await page.waitForTimeout(1500);

    // 7. 找 Reply 按钮并点击（多策略）
    log("Looking for Reply button...");
    const replyClicked = await page.evaluate((marker) => {
      // 策略1：button/a/[role=button] 文本为 Reply
      const candidates = [...document.querySelectorAll('button, a, [role="button"]')].filter((b) => {
        const t = (b.innerText || "").trim().toLowerCase();
        return (t === "reply" || t === "reply to comment") && b.offsetWidth > 0 && b.offsetHeight > 0;
      });
      for (const btn of candidates) {
        let container = btn;
        for (let d = 0; d < 15; d++) {
          container = container?.parentElement;
          if (!container) break;
          if (container.innerText && container.innerText.includes(marker)) {
            btn.click();
            return { clicked: true, strategy: "text-match" };
          }
        }
      }
      // 策略2：data-testid 或 aria-label 含 reply
      const testidBtns = [...document.querySelectorAll('[data-testid*="reply" i], [aria-label*="reply" i]')].filter(
        (b) => b.offsetWidth > 0 && b.offsetHeight > 0
      );
      for (const btn of testidBtns) {
        let container = btn;
        for (let d = 0; d < 15; d++) {
          container = container?.parentElement;
          if (!container) break;
          if (container.innerText && container.innerText.includes(marker)) {
            btn.click();
            return { clicked: true, strategy: "testid-match" };
          }
        }
      }
      return { clicked: false };
    }, FURKAN_MARKER);

    if (!replyClicked.clicked) {
      log("FATAL: Could not find/click Reply button");
      await page.screenshot({ path: path.join(EVIDENCE, "reply-furkan-no-reply-btn.png"), fullPage: true });
      throw new Error("Reply button not found");
    }
    log(`Reply button clicked (strategy: ${replyClicked.strategy})`);
    await page.waitForTimeout(2000);

    // 8. 找回复输入框并填写
    log("Looking for reply input box...");
    const replyBox = page.locator("textarea:visible, [contenteditable=true]:visible, div[role=textbox]:visible").first();
    if (!(await replyBox.count())) {
      log("FATAL: No reply input box appeared");
      await page.screenshot({ path: path.join(EVIDENCE, "reply-furkan-no-input.png") });
      throw new Error("Input box not found");
    }
    await replyBox.click();
    await page.waitForTimeout(500);
    try {
      await replyBox.fill(REPLY_TEXT);
    } catch (e) {
      log("fill() failed, falling back to evaluate...");
      await page.evaluate((txt) => {
        const el = document.querySelector("[contenteditable=true], div[role=textbox], textarea");
        if (el) {
          el.focus();
          el.innerText = txt;
          el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        }
      }, REPLY_TEXT);
    }
    await page.waitForTimeout(1000);
    log("Reply text entered");

    // 9. 找提交按钮并点击
    log("Looking for submit button...");
    const submitBtn = page.locator(
      'button:has-text("Comment"), button:has-text("Reply"), button:has-text("Post"), button[type=submit]:visible'
    ).first();
    if (!(await submitBtn.count())) {
      log("FATAL: No submit button found");
      await page.screenshot({ path: path.join(EVIDENCE, "reply-furkan-no-submit.png") });
      throw new Error("Submit button not found");
    }
    await submitBtn.click();
    await page.waitForTimeout(4000);
    log("Submit button clicked");

    // 10. 截图验证
    await page.screenshot({ path: path.join(EVIDENCE, "reply-furkan-posted.png") });
    log("Screenshot saved to reply-furkan-posted.png");

    // 11. 更新 state 文件
    if (fs.existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        for (const key of Object.keys(state)) {
          if (key.includes("Furkan")) {
            state[key].replied = true;
            state[key].repliedAt = new Date().toISOString();
            state[key].repliedBy = "reply-furkan.cjs";
            log(`Updated state key: ${key}`);
          }
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      } catch (e) {
        log(`State update failed (non-fatal): ${String(e).slice(0, 120)}`);
      }
    }

    log("=== Reply to Furkan SUCCESS ===");
  } catch (e) {
    log(`FATAL: ${String(e).slice(0, 300)}`);
    process.exitCode = 1;
  } finally {
    // 关闭 CDP 连接
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    // 关闭 Chrome 进程
    if (chromeProc) {
      try { chromeProc.kill(); } catch (_) {}
    }
    // 兜底：确保所有 chrome 进程关闭（释放 profile 锁）
    try { require("child_process").execSync('taskkill /F /IM chrome.exe', { stdio: "ignore" }); } catch (_) {}
    log("Chrome closed, profile lock released");
  }
})();
