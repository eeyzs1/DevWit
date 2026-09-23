// 用已存凭据登录 HN 验证
import { chromium } from "playwright";
import fs from "node:fs";

const raw = fs.readFileSync("launch-credentials.env", "utf8");
const creds = Object.fromEntries(
  raw.split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.split("=")[0], l.split("=").slice(1).join("=")])
);

const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = await browser.contexts()[0].newPage();
await page.goto("https://news.ycombinator.com/login?goto=submit", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);
const form = page.locator("form").first();
await form.locator("input[name='acct']").fill(creds.HN_USERNAME);
await form.locator("input[name='pw']").fill(creds.HN_PASSWORD);
await form.locator("input[type='submit']").click();
await page.waitForTimeout(3000);
const ok = (await page.locator("a[href^='logout']").count()) > 0;
console.log(ok ? `✅ 历史账号登录成功: ${creds.HN_USERNAME}` : "❌ 登录失败（密码不对或账号异常）");
await page.screenshot({ path: "distribution/launch/evidence/hn-login-verify.png", fullPage: true });
process.exit(ok ? 0 : 2);
