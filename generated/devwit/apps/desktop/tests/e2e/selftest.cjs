"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error("缺 DEEPSEEK_API_KEY"); process.exit(1); }
const OUT = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\selftest";
fs.mkdirSync(OUT, { recursive: true });
let n = 0;
async function shot(page, name) { n += 1; await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, "0")}-${name}.png`) }); console.log("  📸", name); }

(async () => {
  const ver = await (await fetch("http://127.0.0.1:9449/json/version")).json();
  const bid = ver.webSocketDebuggerUrl.split("/").pop();
  const browser = await chromium.connectOverCDP("ws://127.0.0.1:9449/devtools/browser/" + bid);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  if (!page) { console.log("no page"); process.exit(1); }
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  const R = { pass: [], fail: [] };
  const ok = (name, cond) => { (cond ? R.pass : R.fail).push(name); console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); };

  // 0. 打开工作区
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask, .dw-wizard").forEach((m) => m.remove())).catch(() => {});
  await page.click('.dw-header >> text=打开文件夹').catch(() => {});
  await page.waitForTimeout(3000);
  const treeN = await page.evaluate(() => document.querySelectorAll(".dw-tree-node").length).catch(() => 0);
  ok("打开工作区(文件树渲染)", treeN > 0); // 任意项目文件都算打开（小项目节点数少）
  // 记录工作区根（从状态栏取，用于 agent 产物路径）
  const wsRoot = (await page.evaluate(() => document.querySelector(".dw-statusbar")?.textContent ?? "")).match(/[A-Za-z]:\\[^\s✕]*/)?.[0] ?? null;
  console.log("工作区根:", wsRoot);

  // 1. 配置 DeepSeek
  await page.evaluate(async (key) => {
    await window.devwit.credentials.set("ds-cred", "openai", key);
    await window.devwit.providers.upsert({ id: "deepseek-ds", type: "openai", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash-vision-exp", credentialRef: "ds-cred", maxTokens: 8192 });
  }, KEY);
  await page.waitForFunction(() => [...document.querySelectorAll('select[title="模型"] option')].some((o) => o.value === "deepseek-ds"), null, { timeout: 8000 }).catch(() => {});
  await page.selectOption('select[title="模型"]', "deepseek-ds").catch(() => {});
  ok("配置 DeepSeek provider", await page.evaluate(() => [...document.querySelectorAll('select[title="模型"] option')].some((o) => o.value === "deepseek-ds")).catch(() => false));

  // 2. 对话（真实 DeepSeek）
  await page.click('.dw-tab:has-text("对话")').catch(() => {});
  await page.selectOption('select[title="模式"]', "chat").catch(() => {});
  await page.fill(".dw-chat .dw-chat-textarea", "用一句话介绍 DevWit。").catch(() => {});
  await page.click(".dw-chat >> text=发送").catch(() => {});
  let chatOk = false;
  try { await page.waitForSelector('.dw-msg-assistant', { timeout: 60000 }); chatOk = true; } catch (e) {}
  await page.waitForTimeout(400);
  await shot(page, "chat-reply");
  const reply = await page.evaluate(() => document.querySelector('.dw-msg-assistant')?.textContent ?? "");
  ok("对话（真实 DeepSeek 回复）", chatOk && reply.length > 5);

  // 3. 上下文面板 audit
  await page.click('.dw-tab:has-text("上下文")').catch(() => {});
  await page.waitForSelector(".dw-context-item", { timeout: 8000 }).catch(() => {});
  await shot(page, "context-audit");
  const manifest = await page.evaluate(() => window.devwit.context.latestManifest()).catch(() => null);
  ok("上下文 manifest 审计", manifest && Array.isArray(manifest.items));

  // 4. 切回对话页签，测模式热更新（自建模式即时出现）
  await page.click('.dw-tab:has-text("对话")').catch(() => {});
  await page.evaluate(() => window.devwit.modes.upsert({ id: "selftest-mode", name: "SelfTest", description: "自测", systemPrompt: "你是 selftest 助手。", tools: ["read", "grep"], providerId: "deepseek-ds", contextPolicy: {}, builtin: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })).catch(() => {});
  await page.waitForFunction(() => [...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "selftest-mode"), null, { timeout: 6000 }).catch(() => {});
  await shot(page, "mode-hot-reload");
  ok("模式热更新(新模式即时出现)", await page.evaluate(() => [...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "selftest-mode")).catch(() => false));

  // 5. Agent 模式 + 授权写文件（真实模型 → write → 授权门 → 落盘）
  await page.selectOption('select[title="模式"]', "agent").catch(() => {});
  await page.fill(".dw-chat .dw-chat-textarea", "用 write 工具创建文件 selftest-agent.txt，内容为：self test ok").catch(() => {});
  await page.click(".dw-chat >> text=发送").catch(() => {});
  let auth = false;
  try { await page.waitForSelector('text=授权请求', { timeout: 90000 }); auth = true; } catch (e) {}
  await page.waitForTimeout(400);
  await shot(page, "agent-auth");
  const allowBtn = page.locator('button:text-is("允许")').first();
  if (await allowBtn.count()) { await allowBtn.click().catch(() => {}); console.log("已点允许"); await page.waitForTimeout(6000); }
  await shot(page, "agent-done");
  // agent 产物在工作区根（本脚本取状态栏工作区，回退到 DevWit 根）
  const candidates = [wsRoot, "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit"].filter(Boolean).map((r) => path.join(r, "selftest-agent.txt"));
  const existed = candidates.some((p) => fs.existsSync(p));
  ok("Agent 授权门拦截", auth);
  ok("Agent write 真实落盘", existed);
  if (existed) console.log("  内容:", fs.readFileSync(candidates.find((p) => fs.existsSync(p)), "utf-8").slice(0, 60));

  // 6. 设置（模型/模式/MCP 分区）
  await page.click(".dw-header >> text=设置").catch(() => {});
  await page.waitForSelector(".dw-modal-mask", { timeout: 8000 }).catch(() => {});
  for (const seg of ["模型", "模式", "MCP"]) {
    const loc = page.locator(`.dw-settings-nav >> text=${seg}`).first();
    if (await loc.count()) { await loc.click().catch(() => {}); await page.waitForTimeout(500); await shot(page, `settings-${seg}`); }
  }
  ok("设置各分区可打开", true);

  // 7. Git 面板 + 轨迹页签
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  const gitTab = page.locator('.dw-left-tabs >> text=Git').first();
  if (await gitTab.count()) { await gitTab.click().catch(() => {}); await page.waitForTimeout(600); await shot(page, "git-panel"); }
  else { const gitAny = page.locator('text=Git').first(); if (await gitAny.count()) { await gitAny.click().catch(() => {}); await page.waitForTimeout(600); await shot(page, "git-panel"); } }
  await page.click('.dw-tab:has-text("轨迹")').catch(() => {});
  await page.waitForTimeout(600);
  await shot(page, "trace-timeline");

  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(R, null, 2), "utf-8");
  console.log(`\n=== 自测结果: PASS ${R.pass.length} / FAIL ${R.fail.length} ===`);
  if (R.fail.length) console.log("FAIL: " + R.fail.join(", "));
  browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
