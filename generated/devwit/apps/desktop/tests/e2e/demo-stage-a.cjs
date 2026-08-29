"use strict";
const { chromium } = require("playwright");
const KEY = process.env.DEEPSEEK_API_KEY;
const OUT = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\demo-project";
const fs = require("fs"), path = require("path");
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const ver = await (await fetch("http://127.0.0.1:9448/json/version")).json();
  const bid = ver.webSocketDebuggerUrl.split("/").pop();
  const browser = await chromium.connectOverCDP("ws://127.0.0.1:9448/devtools/browser/" + bid);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask, .dw-wizard").forEach((m) => m.remove())).catch(() => {});
  // 打开工作区（DEVWIT_E2E_OPEN_DIR = 临时项目目录）
  await page.click('.dw-header >> text=打开文件夹').catch(() => {});
  await page.waitForTimeout(3000);
  const wc = await page.evaluate(() => document.querySelector(".dw-statusbar")?.textContent ?? "");
  console.log("工作区:", wc.slice(0, 60));
  // 配 DeepSeek
  await page.evaluate(async (key) => {
    await window.devwit.credentials.set("ds-cred", "openai", key);
    await window.devwit.providers.upsert({ id: "deepseek-ds", type: "openai", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash-vision-exp", credentialRef: "ds-cred", maxTokens: 8192 });
  }, KEY);
  await page.waitForFunction(() => [...document.querySelectorAll('select[title="模型"] option')].some((o) => o.value === "deepseek-ds"), null, { timeout: 8000 }).catch(() => {});
  await page.click('.dw-tab:has-text("对话")').catch(() => {});
  await page.selectOption('select[title="模型"]', "deepseek-ds").catch(() => {});
  await page.selectOption('select[title="模式"]', "chat").catch(() => {});
  // 对话模式：规划
  await page.fill(".dw-chat .dw-chat-textarea", "请用几句话规划一个轻量 todo CLI：核心文件结构与 add/list/done 命令。").catch(() => {});
  await page.click(".dw-chat >> text=发送").catch(() => {});
  let ok = false;
  try { await page.waitForSelector('.dw-msg-assistant', { timeout: 90000 }); ok = true; } catch (e) {}
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "A-chat-plan.png") });
  const reply = await page.evaluate(() => document.querySelector('.dw-msg-assistant')?.textContent ?? "");
  fs.writeFileSync(path.join(OUT, "A-chat-plan.txt"), reply);
  console.log(ok ? "PASS 对话模式规划" : "FAIL 对话模式", "\n---");
  console.log(reply.slice(0, 500));
  browser.close().catch(() => {});
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
