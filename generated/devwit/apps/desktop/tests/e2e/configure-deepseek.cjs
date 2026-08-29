"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error("缺少 DEEPSEEK_API_KEY"); process.exit(1); }
(async () => {
  const ver = await (await fetch("http://127.0.0.1:9446/json/version")).json();
  const bid = ver.webSocketDebuggerUrl.split("/").pop();
  const browser = await chromium.connectOverCDP("ws://127.0.0.1:9446/devtools/browser/" + bid);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  if (!page) { console.log("no page"); process.exit(1); }
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  // 清除遮罩 + 切对话页签
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask").forEach((m) => m.remove())).catch(() => {});
  await page.click('.dw-tab:has-text("对话")').catch(() => {});

  // 配置 DeepSeek provider（真实 DS API）——密钥经 env 传入，不打印
  await page.evaluate(async (key) => {
    await window.devwit.credentials.set("deepseek-cred", "openai", key);
    await window.devwit.providers.upsert({
      id: "deepseek-ds", type: "openai", label: "DeepSeek",
      baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash-vision-exp",
      credentialRef: "deepseek-cred", maxTokens: 8192,
    });
  }, KEY);
  await page.waitForFunction(() => [...document.querySelectorAll('select[title="模型"] option')].some((o) => o.value === "deepseek-ds"), null, { timeout: 8000 }).catch(() => {});
  await page.selectOption('select[title="模型"]', "deepseek-ds").catch(() => {});
  console.log("已配置 DeepSeek provider 并选中");

  // 关掉可能残留的导览遮罩，确保输入可点击
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask, .dw-modal-mask").forEach((m) => m.remove())).catch(() => {});
  await page.waitForTimeout(500);

  // 真实对话：向 DeepSeek 发请求
  const out = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\deepseek-test";
  fs.mkdirSync(out, { recursive: true });
  await page.fill(".dw-chat .dw-chat-textarea", "用一句话介绍 DevWit 是什么。");
  await page.click(".dw-chat >> text=发送").catch(async () => { await page.evaluate(() => document.querySelector(".dw-chat button, .dw-chat .dw-btn-primary")?.click()); });
  let ok = false;
  try {
    await page.waitForSelector('.dw-msg-assistant', { timeout: 60000 });
    ok = true;
  } catch (e) { console.log("等待回复超时:", e.message); }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "01-deepseek-reply.png") });
  const reply = await page.evaluate(() => document.querySelector('.dw-msg-assistant')?.textContent ?? "");
  const usage = await page.evaluate(() => window.devwit.usage?.summary?.()).catch(() => null);
  console.log("收到回复:", reply.slice(0, 300));
  console.log("usage:", JSON.stringify(usage)?.slice(0, 220));
  console.log("ok=", ok);
  browser.close().catch(() => {});
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
