"use strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "live-walk2");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const electronExe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

const sseChunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
function framesForText(t) {
  return [
    sseChunk({ id: "w", object: "chat.completion.chunk", created: 0, model: "w", choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] }),
    sseChunk({ id: "w", object: "chat.completion.chunk", created: 0, model: "w", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({ id: "w", object: "chat.completion.chunk", created: 0, model: "w", choices: [], usage: { prompt_tokens: 40, completion_tokens: 16 } }),
    "data: [DONE]\n\n",
  ];
}
function framesForTool(name, args) {
  return [
    sseChunk({ id: "w", object: "chat.completion.chunk", created: 0, model: "w", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    sseChunk({ id: "w", object: "chat.completion.chunk", created: 0, model: "w", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({ id: "w", object: "chat.completion.chunk", created: 0, model: "w", choices: [], usage: { prompt_tokens: 55, completion_tokens: 9 } }),
    "data: [DONE]\n\n",
  ];
}
const RESPONSES = [
  framesForText("这是走查2。"),
  framesForTool("write", { path: "walk2-agent.txt", content: "written by walk2\n" }),
  framesForText("已完成 walk2-agent.txt。"),
];
const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") { res.writeHead(404).end(); return; }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const frames = RESPONSES.shift() ?? framesForText("(x)");
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0; const push = () => { if (i >= frames.length) { res.end(); return; } res.write(frames[i]); i += 1; setTimeout(push, 25); }; push();
  });
});

function launch(cdpPort, extra) {
  return new Promise((resolve, reject) => {
    const proc = spawn(electronExe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], { cwd: ROOT, env: { ...process.env, DEVWIT_E2E_OFFSCREEN: "1", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let buf = ""; const timer = setTimeout(() => reject(new Error("timeout " + buf.slice(0, 300))), 40000);
    proc.stderr.on("data", (c) => { buf += c.toString(); const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve({ proc, ws: m[1] }); } });
    proc.on("exit", (c) => reject(new Error("exit "+c))); proc.on("error", reject);
  });
}
async function connect(ws) {
  const browser = await chromium.connectOverCDP(ws);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("index.html"));
  return { browser, page };
}
let n = 0;
async function shot(page, name) { n += 1; await page.screenshot({ path: path.join(OUT, `${String(n).padStart(2,"0")}-${name}.png`) }); console.log("  📸", name); }

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dw-walk2-"));
  fs.writeFileSync(path.join(fixture, "hello.ts"), "const x: number = 'a'\n", "utf-8");
  fs.mkdirSync(path.join(fixture, ".git"), { recursive: true });
  fs.writeFileSync(path.join(fixture, ".git", "HEAD"), "ref: refs/heads/main\n");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "dw-walk2-ud-"));
  const { proc, ws } = await launch(19300 + Math.floor(Math.random() * 1000), { DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userData });
  const { browser, page } = await connect(ws);
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  await page.evaluate(async (url) => {
    await window.devwit.credentials.set("w2-cred", "openai", "sk-w2");
    await window.devwit.providers.upsert({ id: "w2-a", type: "openai", label: "W2 A", baseUrl: url, model: "m2", credentialRef: "w2-cred", maxTokens: 2048 });
  }, baseUrl);
  await page.selectOption('select[title="模型"]', "w2-a").catch(()=>{});

  // 1. 左侧面板：文件 / Git / 调试 / 大纲
  for (const tab of ["文件", "Git", "调试", "大纲"]) {
    const loc = page.locator(`.dw-left-tabs >> text=${tab}`).first();
    if (await loc.count()) { await loc.click().catch(()=>{}); await page.waitForTimeout(700); await shot(page, `left-${tab}`); }
    else { const alt = page.locator(`text=${tab}`).first(); if (await alt.count()) { await alt.click().catch(()=>{}); await page.waitForTimeout(500); await shot(page, `left-${tab}`); } }
  }

  // 2. 打开 hello.ts → 编辑器 + LSP/诊断
  await page.click('.dw-tree-node:has-text("hello.ts")').catch(()=>{});
  await page.waitForTimeout(1200);
  await shot(page, "editor-lsp");
  const lspStatus = await page.evaluate(() => window.devwit.lsp.getStatus()).catch(()=>null);
  const diags = await page.evaluate(() => window.devwit.lsp.diagnostics()).catch(()=>null);

  // 3. 对话页签：chat → 提案 → agent 授权允许（正确选择器）
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask").forEach((m)=>m.remove()));
  await page.click('.dw-tab:has-text("对话")').catch(()=>{});
  await page.waitForTimeout(400);
  await page.selectOption('select[title="模式"]', "chat").catch(()=>{});
  await page.fill(".dw-chat .dw-chat-textarea", "你好").catch(()=>{});
  await page.click(".dw-chat >> text=发送").catch(()=>{});
  await page.waitForSelector('.dw-msg-assistant:has-text("走查2")', { timeout: 30000 }).catch(()=>{});
  await shot(page, "chat-reply");
  // 切 agent 模式发起写文件
  await page.selectOption('select[title="模式"]', "agent").catch(()=>{});
  await page.fill(".dw-chat .dw-chat-textarea", "创建 walk2-agent.txt").catch(()=>{});
  await page.click(".dw-chat >> text=发送").catch(()=>{});
  await page.waitForSelector('text=允许', { timeout: 30000 }).catch(()=>{});
  await shot(page, "auth-gate-3tier");
  // 点击授权卡里的「允许」（按钮含 i18n 文案）
  const allowBtn = page.locator('button:has-text("允许")').first();
  if (await allowBtn.count()) { await allowBtn.click().catch(()=>{}); await page.waitForTimeout(4000); }
  await shot(page, "agent-done");
  const agentFile = path.join(fixture, "walk2-agent.txt");
  console.log("agent 文件存在:", fs.existsSync(agentFile), "内容:", fs.existsSync(agentFile) ? fs.readFileSync(agentFile,"utf-8") : null);

  // 4. 会话 / 上下文 / 轨迹页签
  for (const tab of ["会话", "上下文", "轨迹"]) {
    await page.click(`.dw-tab:has-text("${tab}")`).catch(()=>{});
    await page.waitForTimeout(700);
    await shot(page, `tab-${tab}`);
  }

  // 5. 设置 → 模型 / 模式 / MCP / 用量
  await page.click(".dw-header >> text=设置").catch(()=>{});
  await page.waitForSelector(".dw-modal-mask", { timeout: 10000 }).catch(()=>{});
  for (const seg of ["模型", "模式", "MCP"]) {
    const loc = page.locator(`.dw-settings-nav >> text=${seg}`).first();
    if (await loc.count()) { await loc.click().catch(()=>{}); await page.waitForTimeout(600); await shot(page, `settings-${seg}`); }
  }

  // 6. 终端（若有）
  const termBtn = page.locator('button:has-text("终端")').first();
  if (await termBtn.count()) { await termBtn.click().catch(()=>{}); await page.waitForTimeout(700); await shot(page, "terminal"); }
  else console.log("  (未找到终端入口)");

  fs.writeFileSync(path.join(OUT, "lsp.json"), JSON.stringify({ lspStatus, diags }, null, 2), "utf-8");
  console.log("LSP:", JSON.stringify(lspStatus), "诊断数:", Array.isArray(diags) ? diags.length : null);
  proc.kill(); browser.close().catch(()=>{}); server.close(); process.exit(0);
}
main().catch((e) => { console.error("err:", e); process.exit(1); });
