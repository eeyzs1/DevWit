"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
(async () => {
  const ver = await (await fetch("http://127.0.0.1:9446/json/version")).json();
  const bid = ver.webSocketDebuggerUrl.split("/").pop();
  const browser = await chromium.connectOverCDP("ws://127.0.0.1:9446/devtools/browser/" + bid);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  if (!page) { console.log("no page"); process.exit(1); }
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask").forEach((m) => m.remove())).catch(() => {});
  const out = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\deepseek-test";
  fs.mkdirSync(out, { recursive: true });

  // Agent 模式 + 真实模型发起写文件
  await page.click('.dw-tab:has-text("对话")').catch(() => {});
  await page.selectOption('select[title="模型"]', "deepseek-ds").catch(() => {});
  await page.selectOption('select[title="模式"]', "agent").catch(() => {});
  await page.fill(".dw-chat .dw-chat-textarea", "用 write 工具创建文件 deepseek-agent.txt，内容为：hello from deepseek v4 flash").catch(() => {});
  await page.click(".dw-chat >> text=发送").catch(() => {});

  // 等待授权门出现（write 工具需授权）
  let gotAuth = false;
  try { await page.waitForSelector('.dw-msg-authorization, text=授权请求', { timeout: 90000 }); gotAuth = true; } catch (e) { console.log("未等到授权门:", e.message.slice(0,120)); }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, "03-agent-auth.png") });
  console.log("授权门出现:", gotAuth);

  // 点「允许」（精确文本，避开 本会话允许/拒绝）
  const allowBtn = page.locator('button:text-is("允许")').first();
  if (await allowBtn.count()) { await allowBtn.click().catch(() => {}); console.log("已点允许"); await page.waitForTimeout(6000); }
  else {
    const anyAllow = page.locator('button:has-text("允许")').first();
    if (await anyAllow.count()) { await anyAllow.click().catch(() => {}); console.log("已点(子串)允许"); await page.waitForTimeout(6000); }
  }

  await page.screenshot({ path: path.join(out, "04-agent-done.png") });
  const file = path.join("E:\\AI_Generated_Projects\\DevWit\\generated\\devwit", "deepseek-agent.txt");
  const exist = fs.existsSync(file);
  console.log("deepseek-agent.txt 存在:", exist, "| 内容:", exist ? fs.readFileSync(file, "utf-8").slice(0,80) : "(无)");
  browser.close().catch(() => {});
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
