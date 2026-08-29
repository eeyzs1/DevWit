"use strict";
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const OUT = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\demo-project";
(async () => {
  let browser;
  try {
    const ver = await (await fetch("http://127.0.0.1:9448/json/version")).json();
    const bid = ver.webSocketDebuggerUrl.split("/").pop();
    browser = await chromium.connectOverCDP("ws://127.0.0.1:9448/devtools/browser/" + bid);
    const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
    await page.waitForSelector(".dw-header", { timeout: 20000 });
    await page.evaluate(() => document.querySelectorAll(".dw-tour-mask, .dw-modal-mask").forEach((m) => m.remove())).catch(() => {});

    // 1) 自定义模式（user-facing 插件）
    await page.evaluate(() => window.devwit.modes.upsert({ id: "demo-plugin-mode", name: "Demo Plugin Mode", description: "插件演示模式", systemPrompt: "你是 demo 插件助手，先读文件了解现状再回答。", tools: ["read", "grep", "ls"], providerId: "deepseek-ds", contextPolicy: {}, builtin: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })).catch((e) => console.log("modes.upsert:", e.message));
    await page.waitForFunction(() => [...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "demo-plugin-mode"), null, { timeout: 6000 }).catch(() => {});
    console.log("自定义模式出现:", await page.evaluate(() => [...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "demo-plugin-mode")).catch(() => false));

    // 2) MCP 服务器（插件）：配置本地 demo-mcp → 工具加载
    const mcpConfig = { id: "demo-mcp", name: "Demo MCP", command: "node", args: ["C:\\Users\\eeyzs1\\AppData\\Local\\Temp\\dw-demo-project\\mcp-server.mjs"], enabled: true };
    await page.evaluate((cfg) => window.devwit.mcp.upsert(cfg).catch((e) => console.log("mcp.upsert:", e.message)), mcpConfig).catch(() => {});
    await page.waitForTimeout(4000);
    const mcpView = await page.evaluate(() => window.devwit.mcp.list?.() ?? []).catch(() => []);
    const tools = await page.evaluate(() => window.devwit.mcp.tools?.() ?? []).catch(() => []);
    console.log("MCP 服务器:", JSON.stringify(mcpView).slice(0, 160));
    console.log("MCP 工具:", JSON.stringify(tools).slice(0, 160));

    // 3) 社区模式页
    await page.click('.dw-header >> text=设置').catch(() => {});
    await page.waitForSelector(".dw-modal-mask", { timeout: 8000 }).catch(() => {});
    const community = page.locator('.dw-settings-nav >> text=社区').first();
    if (await community.count()) { await community.click().catch(() => {}); await page.waitForTimeout(900); await page.screenshot({ path: path.join(OUT, "D-community-modes.png") }); console.log("📸 社区模式页"); }
    else console.log("(无社区设置页)");
    await page.screenshot({ path: path.join(OUT, "D-settings.png") });
    await page.keyboard.press("Escape").catch(() => {});
    await page.screenshot({ path: path.join(OUT, "D-custom-mode.png") });
    fs.writeFileSync(path.join(OUT, "D-mcp.txt"), JSON.stringify({ mcpView, tools }, null, 2));
  } catch (e) { console.error("err:", e.message); }
  finally { try { if (browser) await browser.close().catch(() => {}); } catch {}; process.exit(0); }
})();
