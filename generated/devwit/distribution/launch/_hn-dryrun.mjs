// 定时提交前的干跑验证：确认提交表单可填（不点提交）
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = await browser.contexts()[0].newPage();
await page.goto("https://news.ycombinator.com/submit", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(1500);
const titleOk = await page.locator("input[name='title']").count();
const textOk = await page.locator("textarea[name='text']").count();
const urlOk = await page.locator("input[name='url']").count();
console.log(`提交表单: title=${titleOk > 0} text=${textOk > 0} url=${urlOk > 0}（url=${page.url()}）`);
await page.close();
process.exit(titleOk > 0 && textOk > 0 ? 0 : 2);
