"use strict";
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const PROJ = "C:\\Users\\eeyzs1\\AppData\\Local\\Temp\\dw-demo-project";
const OUT = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\demo-project";
(async () => {
  let browser;
  try {
    const ver = await (await fetch("http://127.0.0.1:9448/json/version")).json();
    const bid = ver.webSocketDebuggerUrl.split("/").pop();
    browser = await chromium.connectOverCDP("ws://127.0.0.1:9448/devtools/browser/" + bid);
    const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
    await page.waitForSelector(".dw-header", { timeout: 20000 });
    // 编排模式
    await page.click('.dw-tab:has-text("对话")').catch(() => {});
    await page.selectOption('select[title="模式"]', "orchestrator").catch(() => {});
    await page.fill(".dw-chat .dw-chat-textarea", "分析 hello.txt：统计其行数、总字符数、每行字符数，并给出一个简洁的总结报告写到 analysis.md；同时用 Bash 统计单词数追加到报告。").catch(() => {});
    await page.click(".dw-chat >> text=发送").catch(() => {});
    // 轮询：等分析.md 生成 或 子代理事件
    const target = path.join(PROJ, "analysis.md");
    const start = Date.now();
    let allow = 0;
    for (let i = 0; i < 70; i += 1) {
      await page.waitForTimeout(2500);
      const auth = page.locator('text=授权请求').first();
      if (await auth.count()) { const b = page.locator('button:text-is("允许")').first(); const btn = (await b.count()) ? b : page.locator('button:has-text("允许")').first(); if (await btn.count()) { await btn.click().catch(() => {}); allow += 1; console.log("  [允许]", allow); } continue; }
      if (fs.existsSync(target)) { console.log("analysis.md 已生成"); break; }
      if (Date.now() - start > 175000) { console.log("超时"); break; }
    }
    await page.screenshot({ path: path.join(OUT, "C-orchestrator.png") });
    console.log("编排授权次数:", allow);
    console.log("analysis.md 存在:", fs.existsSync(target));
    if (fs.existsSync(target)) console.log("内容:", fs.readFileSync(target, "utf-8").slice(0, 300));
  } catch (e) { console.error("err:", e.message); }
  finally { try { if (browser) await browser.close().catch(() => {}); } catch {}; process.exit(0); }
})();
