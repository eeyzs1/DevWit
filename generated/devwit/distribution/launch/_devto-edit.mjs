// 修订 dev.to 新帖：winget 0.7.30 已合并，改 Install 段 + 查掘金审核态 + HN 连通性
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9222");
const context = browser.contexts()[0];

// 1. dev.to 编辑
const page = await context.newPage();
page.setDefaultTimeout(30000);
await page.goto(
  "https://dev.to/eeyzs1/devwit-v0730-the-ai-ide-that-shows-every-token-now-with-a-real-terminal-and-a-command-palette-35ob/edit",
  { waitUntil: "domcontentloaded", timeout: 30000 }
);
await page.waitForTimeout(2500);
if (/enter/.test(page.url())) {
  console.log("dev.to 需要重新登录，跳过编辑");
} else {
  const body = page.locator("#article_body_markdown");
  if (await body.count()) {
    const text = await body.inputValue();
    const updated = text.replace(
      "`winget install eeyzs1.DevWit` (0.7.28 live in the community repo, 0.7.30 in review)",
      "`winget install eeyzs1.DevWit` (0.7.30 live in the community repo)"
    );
    if (updated !== text) {
      await body.fill(updated);
      console.log("正文已更新（winget 0.7.30 live）");
      // dev.to 编辑页自动保存；再点一次保存确认
      await page.waitForTimeout(1500);
      const saved = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => /^save$/i.test((x.innerText || "").trim()));
        if (b) { b.click(); return true; }
        return false;
      });
      console.log("save click:", saved);
      await page.waitForTimeout(3000);
    } else {
      console.log("未找到待替换文本（可能已更新）");
    }
  } else {
    console.log("未找到正文编辑框");
  }
}
await page.close();

// 2. 掘金审核状态
const j = await context.newPage();
await j.goto("https://juejin.cn/spost/7688532185121079306", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
await j.waitForTimeout(3000);
const jtxt = await j.evaluate(() => (document.body.innerText || "").slice(0, 300));
console.log("掘金状态:", jtxt.includes("审核中") ? "⏳ 仍审核中" : jtxt.includes("404") || jtxt.includes("找不到") ? "❓ 404" : "✅ 可能已过审");
await j.close();

// 3. HN 连通性
const h = await context.newPage();
try {
  await h.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded", timeout: 15000 });
  console.log("HN: ✅ 可达（无需代理）");
} catch {
  console.log("HN: ❌ 超时（需要您开代理）");
}
await h.close();
process.exit(0);
