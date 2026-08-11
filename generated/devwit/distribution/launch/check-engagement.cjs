// Collect engagement / comments from published posts
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const EVIDENCE = path.join(__dirname, "evidence");

const TARGETS = [
  {
    id: "reddit",
    url: "https://www.reddit.com/r/SideProject/comments/1vl70te/devwit_opensource_ai_ide_with_transparent_llm/",
  },
  {
    id: "devto",
    url: "https://dev.to/eeyzs1/devwit-v050-an-open-source-ai-ide-with-a-transparent-context-panel-and-a-real-editor-onn",
  },
  {
    id: "juejin_new",
    url: "https://juejin.cn/spost/7672325240563679286",
  },
  {
    id: "juejin_old",
    url: "https://juejin.cn/post/7667564845585465395",
  },
];

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const page = await browser.contexts()[0].newPage();
  page.setDefaultTimeout(30000);
  const out = { collected_at: new Date().toISOString(), platforms: {} };

  for (const t of TARGETS) {
    try {
      await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(4000);
      // scroll to load comments
      await page.evaluate(async () => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(2000);

      const data = await page.evaluate(() => {
        const text = document.body.innerText || "";
        const title = document.title;
        // generic score / reaction heuristics
        const numbers = {};
        const upvote = text.match(/(\d+)\s*(upvotes?|points?|赞|点赞)/i);
        const comments = text.match(/(\d+)\s*(comments?|评论|条评论)/i);
        const reactions = text.match(/(\d+)\s*(reactions?|likes?)/i);
        if (upvote) numbers.upvoteHint = upvote[0];
        if (comments) numbers.commentHint = comments[0];
        if (reactions) numbers.reactionHint = reactions[0];

        // extract comment-like blocks
        const commentCandidates = [];
        const selectors = [
          '[data-testid="comment"]',
          ".comment",
          "shreddit-comment",
          "#comments",
          ".crayons-comment",
          "[class*='CommentItem']",
          "[class*='comment-item']",
        ];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const t = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 400);
            if (t.length > 20 && !commentCandidates.includes(t)) commentCandidates.push(t);
          });
        }

        // fallback: look for reply sections in text
        const snippet = text.slice(0, 2500).replace(/\s+/g, " ");
        return {
          title,
          url: location.href,
          numbers,
          commentCountGuess: commentCandidates.length,
          comments: commentCandidates.slice(0, 15),
          snippet,
        };
      });
      out.platforms[t.id] = { ok: true, ...data };
      await page.screenshot({
        path: path.join(EVIDENCE, `engage-${t.id}.png`),
        fullPage: false,
      });
      console.log(`[ok] ${t.id}: comments~${data.commentCountGuess} ${JSON.stringify(data.numbers)}`);
    } catch (e) {
      out.platforms[t.id] = { ok: false, error: String(e.message || e), url: t.url };
      console.log(`[fail] ${t.id}: ${e.message || e}`);
    }
  }

  fs.writeFileSync(path.join(EVIDENCE, "engagement-20260811.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await page.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
