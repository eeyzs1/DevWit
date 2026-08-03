// PH 评论监控 + 自动回复
// 每 30 分钟由计划任务触发，检查新评论并自动回复
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const POST_URL = "https://www.producthunt.com/posts/devwit";
const EVIDENCE = path.join(__dirname, "evidence");
const STATE_FILE = path.join(EVIDENCE, "ph-comment-state.json");
const LOG_FILE = path.join(EVIDENCE, "ph-comment-monitor.log");

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  // Best-effort 日志写入：日志失败不得阻断监控业务
  // Windows 上 EBUSY 常见（OneDrive/Defender/IDE file watcher 锁文件）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.appendFileSync(LOG_FILE, line + "\n");
      return;
    } catch (e) {
      if (attempt < 2) {
        // 同步等待 200ms 重试
        try { require("child_process").execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 200"'); } catch (_) {}
        continue;
      }
      // 最后一次仍失败：仅 console 输出（计划任务 stdout 重定向仍能捕获到 .log 文件）
      // 不抛出，不阻断业务
    }
  }
}

// 健壮的状态文件写入（state 丢失会导致重复回复，比日志更关键）
function saveState(state) {
  const data = JSON.stringify(state, null, 2);
  const tmp = STATE_FILE + ".tmp";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, STATE_FILE);
      return true;
    } catch (e) {
      log(`saveState attempt ${attempt + 1} failed: ${String(e).slice(0, 120)}`);
      if (attempt < 2) {
        try { require("child_process").execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 300"'); } catch (_) {}
        continue;
      }
      return false;
    }
  }
  return false;
}

// 根据评论内容生成回复
function generateReply(commentText, authorName) {
  const text = commentText.toLowerCase();

  // 安全/隐私相关
  if (/secur|privacy|trust|safe|audit|compliance/i.test(text)) {
    return `Thanks @${authorName}! Security and auditability are exactly why I built DevWit. Every LLM request shows its full context (system prompt, tools, injected code) with per-item token costs, and every file write / shell command requires explicit approval. Telemetry is opt-in and off by default — zero content collected. Would love to hear if there's a specific compliance scenario you're evaluating.`;
  }

  // 定价相关
  if (/price|cost|free|paid|subscription|commercial/i.test(text)) {
    return `Thanks @${authorName}! DevWit is completely free and open source (MIT license). No accounts, no cloud sync, no paywalls. You can download it from GitHub: https://github.com/eeyzs1/DevWit/releases`;
  }

  // 平台支持
  if (/windows|mac|linux|platform|support/i.test(text)) {
    return `Thanks @${authorName}! DevWit supports Windows (NSIS installer), macOS (dmg), and Linux (AppImage/deb). All three builds are produced by public GitHub Actions workflows and verified by 618 unit tests + 28 e2e suites.`;
  }

  // 上下文透明
  if (/context|transparent|token|prompt|send/i.test(text)) {
    return `Thanks @${authorName}! The context panel is the core differentiator — every LLM request lists its system prompt, tools, and each injected item (file, RAG chunk, terminal output) with token counts. You can toggle any item off and the request shrinks accordingly. It's not a wrapper — it's a real IDE with TypeScript LSP, Git, DAP debugging, and MCP tool servers.`;
  }

  // 授权门
  if (/authoriz|permission|approve|gate|agent/i.test(text)) {
    return `Thanks @${authorName}! The authorization gate means the agent cannot write a file or run a shell command without your one-click approval. Approvals can be remembered per-project for convenience. Combined with the context panel, you always know what the AI is about to do before it does it.`;
  }

  // 对比其他工具
  if (/cursor|copilot|codeium|continue|vs.?code|compare/i.test(text)) {
    return `Thanks @${authorName}! The key difference from other AI coding tools is full context transparency + authorization gate. You see every token sent to the model and approve every action. It's a standalone IDE (not a plugin) with TypeScript LSP, Git, DAP debugging, and MCP support — all free and open source.`;
  }

  // 一般正面评论
  if (/great|awesome|love|nice|cool|congrat|amazing|excellent|well done|impressive/i.test(text)) {
    return `Thanks @${authorName}! Really appreciate the support. If you have any feedback or feature requests, feel free to share — I'm actively developing v0.4.0.`;
  }

  // 问题
  if (/\?$/.test(commentText.trim())) {
    return `Thanks for the question @${authorName}! Could you share a bit more detail? In the meantime, you can check the docs at https://github.com/eeyzs1/DevWit — happy to follow up.`;
  }

  // 默认回复
  return `Thanks @${authorName}! Appreciate you checking out DevWit. If you have any questions or feedback, I'm happy to help.`;
}

(async () => {
  log("=== PH Comment Monitor Start ===");

  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // 1. 打开 PH 帖子页
  await page.goto(POST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // 等 Cloudflare
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    const title = await page.title();
    if (!/Just a moment|Cloudflare/i.test(title)) break;
    if (i === 11) {
      log("Cloudflare blocked after 60s, aborting");
      await page.close(); await browser.close();
      process.exit(1);
    }
  }
  log(`Page loaded: ${await page.title()}`);

  // 2. 检查登录状态
  const loggedIn = await page.evaluate(() => {
    return !/Sign in|Login to comment/i.test(document.body.innerText.slice(0, 1000));
  });
  if (!loggedIn) {
    log("Not logged in, aborting");
    await page.close(); await browser.close();
    process.exit(2);
  }

  // 3. 滚动加载所有评论
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
  await page.waitForTimeout(3000);

  // 4. 提取所有评论 — 固定向上 5 层获取完整评论容器
  // PH 评论 DOM 结构（诊断确认）:
  //   作者名 | [Maker] | 评论文本... | Upvote [Award] Reply [Report] Share | 时间
  const comments = await page.evaluate(() => {
    const results = [];
    const replyBtns = [...document.querySelectorAll('button')].filter(
      (b) => b.innerText.trim() === "Reply" && b.offsetWidth > 0
    );
    for (const btn of replyBtns) {
      // 固定向上 5 层（诊断确认此深度包含完整评论）
      let container = btn;
      for (let d = 0; d < 5; d++) {
        container = container?.parentElement;
        if (!container) break;
      }
      if (!container) continue;

      const text = container.innerText?.trim() || "";
      if (text.length < 20) continue;

      const lines = text.split("\n").filter((l) => l.trim());
      // 按钮文本 + 时间戳 —— 全部过滤
      const buttonPatterns = /^(Upvote|Upvoted|Reply|Share|Award|Report|Maker)$/i;
      const timePattern = /^\d+[mhdy]\s+ago$/i;
      const votePattern = /^Upvot(ed|e)\n?\(\d+\)$/i;

      let author = "unknown";
      let bodyLines = [];
      let foundAuthor = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (buttonPatterns.test(trimmed) || timePattern.test(trimmed) || votePattern.test(trimmed)) continue;
        if (!foundAuthor && trimmed.length < 40) {
          author = trimmed;
          foundAuthor = true;
        } else if (foundAuthor) {
          bodyLines.push(trimmed);
        }
      }
      const body = bodyLines.join(" ").trim();
      if (body.length > 10) {
        results.push({ author, body: body.slice(0, 500), fullText: text.slice(0, 500) });
      }
    }
    const seen = new Set();
    return results.filter((c) => {
      const key = c.author + "::" + c.body.slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  log(`Found ${comments.length} comments on page`);

  // 5. 加载已知评论状态
  let knownComments = {};
  if (fs.existsSync(STATE_FILE)) {
    try { knownComments = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) {}
  }

  // 6. 找出新评论
  const newComments = [];
  for (const c of comments) {
    const key = `${c.author}::${c.body.slice(0, 60)}`;
    if (!knownComments[key]) {
      newComments.push(c);
      knownComments[key] = { replied: false, timestamp: new Date().toISOString() };
    }
  }

  log(`New comments: ${newComments.length}`);

  // 7. 对新评论生成回复并发布
  for (const c of newComments) {
    // 跳过自己的评论（maker）—— 多种匹配
    if (/eeyzs1|eey zs1|Dev Wit|ZONGYUAN|SUI/i.test(c.author)) {
      log(`Skipping own comment: ${c.author}`);
      continue;
    }
    // 跳过正文过短的评论（< 15 字符，可能是噪音）
    if (c.body.length < 15) {
      log(`Skipping short comment from ${c.author}: "${c.body}"`);
      continue;
    }

    const reply = generateReply(c.body, c.author);
    log(`New comment from ${c.author}: "${c.body.slice(0, 80)}..."`);
    log(`Reply: "${reply.slice(0, 80)}..."`);

    // 找到该评论的 Reply 按钮并点击
    // 鲁棒方案（reply-ferdi.cjs 验证过）：用评论正文特征文本定位，小写匹配 reply 按钮，
    // 向上 10 层找包含特征文本的容器（避免 closest('div') 匹配到最外层导致误判）
    const bodyMarker = c.body.slice(0, 30); // 评论正文前 30 字符作为特征（比 author 名更精确）

    // 1. 滚动该评论到可见
    await page.evaluate((marker) => {
      const all = [...document.querySelectorAll("*")];
      for (const el of all) {
        if (el.children.length === 0 && el.innerText && el.innerText.includes(marker)) {
          let container = el;
          for (let d = 0; d < 10; d++) {
            container = container?.parentElement;
            if (!container) break;
            const txt = container.innerText || "";
            if (txt.includes("Reply") && txt.length > 50 && txt.length < 2000) {
              container.scrollIntoView({ block: "center" });
              return;
            }
          }
        }
      }
    }, bodyMarker);
    await page.waitForTimeout(500);

    // 2. 找可见 Reply 按钮，选其容器包含特征文本的
    const replyClicked = await page.evaluate((marker) => {
      const btns = [...document.querySelectorAll('button')].filter((b) => {
        const t = (b.innerText || "").trim().toLowerCase();
        return t === "reply" && b.offsetWidth > 0 && b.offsetHeight > 0;
      });
      for (const btn of btns) {
        let container = btn;
        for (let d = 0; d < 10; d++) {
          container = container?.parentElement;
          if (!container) break;
          if (container.innerText && container.innerText.includes(marker)) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    }, bodyMarker);

    if (replyClicked) {
      await page.waitForTimeout(2000);
      // 找回复输入框
      const replyBox = page.locator("textarea:visible, [contenteditable=true]:visible, div[role=textbox]:visible").first();
      if (await replyBox.count()) {
        await replyBox.click();
        await replyBox.fill(reply).catch(async () => {
          await page.evaluate((txt) => {
            const el = document.querySelector("[contenteditable=true], div[role=textbox], textarea");
            if (el) { el.focus(); el.innerText = txt; el.dispatchEvent(new InputEvent("input", { bubbles: true })); }
          }, reply);
        });
        await page.waitForTimeout(1000);

        // 找提交按钮
        const submitBtn = page.locator('button:has-text("Comment"), button:has-text("Reply"), button:has-text("Post"), button[type=submit]').first();
        if (await submitBtn.count()) {
          await submitBtn.click();
          await page.waitForTimeout(3000);
          log(`Reply posted to ${c.author}`);

          // 更新状态
          const key = `${c.author}::${c.body.slice(0, 60)}`;
          knownComments[key].replied = true;
          knownComments[key].repliedAt = new Date().toISOString();
        }
      }
    } else {
      log(`Could not find Reply button for ${c.author}, will try next check`);
    }
  }

  // 8. 保存状态（健壮写入，避免 EBUSY 导致 state 丢失→重复回复）
  saveState(knownComments);

  // 9. 截图当前状态
  await page.screenshot({ path: path.join(EVIDENCE, "ph-monitor-latest.png"), fullPage: false }).catch(() => {});

  await page.close();
  await browser.close();
  log("=== Monitor End ===");
})().catch((e) => {
  log(`FATAL: ${String(e).slice(0, 300)}`);
  process.exit(1);
});
