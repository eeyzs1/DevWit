"use strict";
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const PROJ = "C:\\Users\\eeyzs1\\AppData\\Local\\Temp\\dw-demo-project";
const OUT = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\demo-project";
(async () => {
  const ver = await (await fetch("http://127.0.0.1:9448/json/version")).json();
  const bid = ver.webSocketDebuggerUrl.split("/").pop();
  const browser = await chromium.connectOverCDP("ws://127.0.0.1:9448/devtools/browser/" + bid);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  await page.click('.dw-tab:has-text("对话")').catch(() => {});
  await page.selectOption('select[title="模式"]', "agent").catch(() => {});
  // 更直接的指令：明确要创建的两个文件
  await page.fill(".dw-chat .dw-chat-textarea", "请在当前目录创建两个文件并实现完整功能：1) todo.mjs（Node ESM，命令 add <任务>/list/done <id>，数据存 tasks.json，用 try/catch 处理 JSON 读写）；2) todo.test.mjs（node:test 测试这三个命令）。写完后我会运行 node todo.mjs list 和 node --test todo.test.mjs 验证。").catch(() => {});
  await page.click(".dw-chat >> text=发送").catch(() => {});

  let allow = 0;
  const target1 = path.join(PROJ, "todo.mjs"), target2 = path.join(PROJ, "todo.test.mjs");
  const start = Date.now();
  for (let i = 0; i < 80; i += 1) {
    await page.waitForTimeout(2500);
    const auth = page.locator('text=授权请求').first();
    if (await auth.count()) {
      const allowBtn = page.locator('button:text-is("允许")').first();
      const btn = (await allowBtn.count()) ? allowBtn : page.locator('button:has-text("允许")').first();
      if (await btn.count()) { await btn.click().catch(() => {}); allow += 1; console.log("  [允许]", allow); await page.waitForTimeout(1500); }
      continue;
    }
    if (fs.existsSync(target1) && fs.existsSync(target2)) { console.log("  两个文件已创建"); break; }
    if (Date.now() - start > 200000) { console.log("  超时"); break; }
  }
  await page.screenshot({ path: path.join(OUT, "B-agent-build.png") });
  console.log("授权次数:", allow);
  console.log("todo.mjs 存在:", fs.existsSync(target1), "| 行:", fs.existsSync(target1) ? fs.readFileSync(target1, "utf-8").split("\n").length : 0);
  console.log("todo.test.mjs 存在:", fs.existsSync(target2));
  if (fs.existsSync(target1)) console.log("todo.mjs 前几行:", fs.readFileSync(target1, "utf-8").split("\n").slice(0, 3).join(" | "));
  browser.close().catch(() => {});
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
