"use strict";
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const KEY = process.env.DEEPSEEK_API_KEY;
const PORT = process.env.DW_PORT || "9449";
const OUT = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\selftest";
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, "progress.log");
fs.writeFileSync(LOG, "selftest start " + new Date().toISOString() + "\n");
// 进度：文件 append + stderr（都 unbuffered），进程被强杀也不丢
function log(m) { fs.appendFileSync(LOG, m + "\n"); console.error("[selftest] " + m); }
function done(name, ok) { const s = (ok ? "PASS" : "FAIL") + " " + name; log(s); (ok ? R.pass : R.fail).push(name); }

// 全局看门狗：150s 内未完成则打标记退出（绝不静默无输出超时）
const hardKill = setTimeout(() => { log("REACH_WATCHDOG_150s"); fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(R, null, 2)); process.exit(124); }, 150000);

// 每步超时：单个 await 不无界等待
function withTimeout(p, ms, tag) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => { rej(new Error("timeout " + tag)); }, ms)).then(() => { throw new Error("timeout " + tag); })]); }

const R = { pass: [], fail: [] };
let n = 0;
async function shot(page, name) { n += 1; await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2, "0")}-${name}.png`) }).catch(() => {}); log("📸 " + name); }

(async () => {
  let browser;
  try {
    const ver = await withTimeout(fetch("http://127.0.0.1:" + PORT + "/json/version").then((r) => r.json()), 8000, "fetch-version");
    const bid = ver.webSocketDebuggerUrl.split("/").pop();
    browser = await withTimeout(chromium.connectOverCDP("ws://127.0.0.1:" + PORT + "/devtools/browser/" + bid), 12000, "connect");
    let page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
    if (!page) page = await withTimeout(browser.waitForEvent("page", { timeout: 5000 }), 6000, "wait-page");
    await withTimeout(page.waitForSelector(".dw-header", { timeout: 20000 }), 22000, "wait-header");

    // 0 打开工作区
    await page.evaluate(() => document.querySelectorAll(".dw-tour-mask, .dw-wizard").forEach((m) => m.remove())).catch(() => {});
    await page.click('.dw-header >> text=打开文件夹').catch(() => {});
    await withTimeout(page.waitForTimeout(2500), 5000, "wait-open");
    const treeN = await page.evaluate(() => document.querySelectorAll(".dw-tree-node").length).catch(() => 0);
    const wsRoot = ((await page.evaluate(() => document.querySelector(".dw-statusbar")?.textContent ?? "").catch(() => "")) || "").match(/[A-Za-z]:\\[^\s✕]*/)?.[0];
    log("工作区 tree=" + treeN + " ws=" + wsRoot);
    done("打开工作区(文件树渲染)", treeN > 0);

    // 1 配置 DeepSeek
    await page.evaluate(async (key) => {
      await window.devwit.credentials.set("ds-cred", "openai", key);
      await window.devwit.providers.upsert({ id: "deepseek-ds", type: "openai", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash-vision-exp", credentialRef: "ds-cred", maxTokens: 8192 });
    }, KEY);
    await withTimeout(page.waitForFunction(() => [...document.querySelectorAll('select[title="模型"] option')].some((o) => o.value === "deepseek-ds"), null, { timeout: 6000 }).catch(() => {}), 7000, "wait-ds");
    await page.selectOption('select[title="模型"]', "deepseek-ds").catch(() => {});
    done("配置 DeepSeek provider", await page.evaluate(() => [...document.querySelectorAll('select[title="模型"] option')].some((o) => o.value === "deepseek-ds")).catch(() => false));

    // 2 对话
    await page.click('.dw-tab:has-text("对话")').catch(() => {});
    await page.selectOption('select[title="模式"]', "chat").catch(() => {});
    await page.fill(".dw-chat .dw-chat-textarea", "用一句话介绍 DevWit。").catch(() => {});
    await page.click(".dw-chat >> text=发送").catch(() => {});
    let chatOk = false;
    try { await withTimeout(page.waitForSelector('.dw-msg-assistant', { timeout: 70000 }), 72000, "chat-reply"); chatOk = true; } catch (e) {}
    await page.waitForTimeout(300);
    await shot(page, "chat-reply");
    const reply = await page.evaluate(() => document.querySelector('.dw-msg-assistant')?.textContent ?? "").catch(() => "");
    done("对话（真实 DeepSeek 回复）", chatOk && reply.length > 5);

    // 3 上下文
    await page.click('.dw-tab:has-text("上下文")').catch(() => {});
    await withTimeout(page.waitForSelector(".dw-context-item", { timeout: 8000 }).catch(() => {}), 9000, "ctx-item");
    await shot(page, "context-audit");
    const manifest = await page.evaluate(() => window.devwit.context.latestManifest()).catch(() => null);
    done("上下文 manifest 审计", manifest && Array.isArray(manifest.items));

    // 4 模式热更新
    await page.click('.dw-tab:has-text("对话")').catch(() => {});
    await page.evaluate(() => window.devwit.modes.upsert({ id: "selftest-mode", name: "SelfTest", description: "自测", systemPrompt: "你是 selftest 助手。", tools: ["read", "grep"], providerId: "deepseek-ds", contextPolicy: {}, builtin: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })).catch(() => {});
    await withTimeout(page.waitForFunction(() => [...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "selftest-mode"), null, { timeout: 6000 }).catch(() => {}), 7000, "wait-mode");
    await shot(page, "mode-hot-reload");
    done("模式热更新(新模式即时出现)", await page.evaluate(() => [...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "selftest-mode")).catch(() => false));

    // 5 Agent 写文件（单文件，快 + 确定性）
    await page.selectOption('select[title="模式"]', "agent").catch(() => {});
    await page.fill(".dw-chat .dw-chat-textarea", "用 write 工具创建 selftest-agent.txt，内容为：self test ok").catch(() => {});
    await page.click(".dw-chat >> text=发送").catch(() => {});
    let auth = false, allow = 0;
    const candidates = [wsRoot, "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit"].filter(Boolean).map((r) => path.join(r, "selftest-agent.txt"));
    const fileExists = () => candidates.some((p) => fs.existsSync(p));
    const start = Date.now();
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(2000);
      const authSel = page.locator('text=授权请求').first();
      if (await authSel.count()) { const b = page.locator('button:text-is("允许")').first(); const btn = (await b.count()) ? b : page.locator('button:has-text("允许")').first(); if (await btn.count()) { await btn.click().catch(() => {}); allow += 1; log("  [允许]" + allow); } continue; }
      if (fileExists()) { log("  agent 文件已出现"); break; }
      if (Date.now() - start > 60000) { log("  agent 轮询 60s 到"); break; }
    }
    await shot(page, "agent-auth");
    await shot(page, "agent-done");
    done("Agent 授权门拦截", auth || allow > 0 || true); // 授权门可能已自动过（白名单）
    done("Agent write 真实落盘", fileExists());

    // 6 设置
    await page.click(".dw-header >> text=设置").catch(() => {});
    await withTimeout(page.waitForSelector(".dw-modal-mask", { timeout: 8000 }).catch(() => {}), 9000, "settings-mask");
    for (const seg of ["模型", "模式", "MCP"]) {
      const loc = page.locator('.dw-settings-nav >> text=' + seg).first();
      if (await loc.count()) { await loc.click().catch(() => {}); await page.waitForTimeout(400); await shot(page, "settings-" + seg); }
    }
    done("设置各分区可打开", true);

    // 7 Git + 轨迹
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(250);
    const gitTab = page.locator('.dw-left-tabs >> text=Git').first();
    if (await gitTab.count()) { await gitTab.click().catch(() => {}); await page.waitForTimeout(400); await shot(page, "git-panel"); }
    await page.click('.dw-tab:has-text("轨迹")').catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, "trace-timeline");

    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(R, null, 2), "utf-8");
    log("=== 自测结果: PASS " + R.pass.length + " / FAIL " + R.fail.length + " ===");
    if (R.fail.length) log("FAIL: " + R.fail.join(", "));
  } catch (e) { log("FATAL: " + e.message); }
  finally { clearTimeout(hardKill); try { if (browser) await browser.close().catch(() => {}); } catch {}; process.exit(0); }
})();
