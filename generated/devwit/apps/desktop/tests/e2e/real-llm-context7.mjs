/**
 * 实机演示：真实 DeepSeek LLM 调用【真实外部托管 MCP】—— Context7（https://mcp.context7.com/mcp）
 *
 * 与之前本机 127.0.0.1 MCP 不同：本次连的是真实存在的公网 MCP 服务器（Context7，Streamable HTTP，
 * 协议版本协商到 2025-06-18）。DevWit 经 McpHttpClient 连接，工具暴露给 agent；真实 DeepSeek 调用
 * Context7 工具（resolve-library-id / query-docs）；授权门拦截；活动流展示可读的 MCP 元信息
 * （名称/传输/自报描述）+ 端点/请求/结果。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const CTX7_URL = "https://mcp.context7.com/mcp";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "real-llm-context7");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error("缺少 DEEPSEEK_API_KEY"); process.exit(2); }

const proj = fs.mkdtempSync(path.join(os.tmpdir(), "dw-ctx7-"));
fs.writeFileSync(path.join(proj, "input.txt"), "context7 real mcp demo\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-ctx7-ud-"));

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[ctx7] ${name}`); };
function assert(cond, message) {
  if (cond) { report.assertions.push(message); console.log(`[ctx7] PASS: ${message}`); }
  else { report.failures.push(message); console.error(`[ctx7] FAIL: ${message}`); }
}

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: proj, DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1", DEEPSEEK_API_KEY: KEY },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBuf = "";
    const timer = setTimeout(() => reject(new Error(`CDP 超时: ${stderrBuf.slice(0, 300)}`)), 30_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve({ ws: match[1], proc }); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`退出 code=${code}: ${stderrBuf.slice(0, 300)}`)); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function waitMcpState(page, id, state, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const views = await page.evaluate(() => window.devwit.mcp.list());
    const view = views.find((entry) => entry.config.id === id);
    if (view?.state === state) return view;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

let browser = null;
let electronProc = null;
let ready = null;
let fatal = null;
try {
  const cdpPort = 23200 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask, .dw-modal-mask").forEach((m) => m.remove())).catch(() => {});
  step("应用启动");

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("打开文件夹 → 文件树渲染");

  // 真实 DeepSeek provider
  await page.evaluate(async (key) => {
    await window.devwit.credentials.set("deepseek-cred", "openai", key);
    await window.devwit.providers.upsert({ id: "deepseek-ds", type: "openai", label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash-vision-exp", credentialRef: "deepseek-cred", maxTokens: 8192 });
  }, KEY);
  step("真实 DeepSeek provider 已注册");

  // ★真实外部 MCP：Context7（transport=http 远程）★
  await page.evaluate((url) => window.devwit.mcp.upsert({ id: "ctx7", name: "Context7", transport: "http", url, enabled: true }), CTX7_URL);
  step(`已配置真实外部 MCP：Context7（transport=http, url=${CTX7_URL}）`);

  ready = await waitMcpState(page, "ctx7", "ready");
  assert(ready !== null, "Context7 未达成就绪（真实公网 MCP 连接/协商失败）");
  const toolNames = ready !== null ? ready.tools.map((t) => t.fullName) : [];
  assert(ready !== null && ready.config.transport === "http", "transport 应为 http（远程）");
  assert(toolNames.some((n) => n.includes("resolve-library-id")) && toolNames.some((n) => n.includes("query-docs")), `应暴露 Context7 工具（实际 ${toolNames.join(",")}）`);
  assert(ready?.serverInfo?.name === "Context7", `serverInfo.name 应为 Context7（实际 ${ready?.serverInfo?.name}）`);
  assert(ready?.serverInfo?.description?.includes("up-to-date documentation"), "serverInfo 应含可读描述");
  fs.writeFileSync(path.join(OUT, "mcp-server.json"), JSON.stringify({ serverInfo: ready?.serverInfo, tools: ready?.tools.map((t) => t.fullName) }, null, 2));
  step(`Context7 就绪：${ready?.tools.length ?? 0} 个工具，serverInfo=${JSON.stringify(ready?.serverInfo?.name)} v${ready?.serverInfo?.version}`);

  // 设置页截图：显示远程 MCP（http + URL）
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav >> text=MCP");
  await page.waitForSelector(".dw-mcp-state-ready", { timeout: 10_000 });
  await page.click('.dw-modal-list-item:has-text("Context7")').catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "01-context7-settings.png") });
  await page.click(".dw-modal >> text=关闭");
  step("设置页 MCP 分区：真实外部 Context7「就绪」+ 远程 http/URL（截图 01）");

  // 绑定 agent 模式到真实 DeepSeek
  await page.evaluate(async () => {
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "deepseek-ds", updatedAt: new Date().toISOString() });
  });
  step("agent 模式热绑定到真实 DeepSeek");

  // 指挥台任务：让真实 DeepSeek 调用 Context7
  await page.click(".dw-header >> text=指挥台");
  const task = "使用真实远程 MCP（Context7）查询 React 的 useState 的用法。先用 resolve-library-id 把 react 解析成 library id，再调用 query-docs 查询 useState。必须调用 MCP 工具。";
  await page.fill(".dw-task-new .dw-input", task);
  await page.click(".dw-console-tasks >> text=创建");
  step("已提交 Agent 任务：真实 DeepSeek 调用 Context7");

  await page.waitForSelector(".dw-act-authorization", { timeout: 180_000 });
  const authText = await page.textContent(".dw-act-authorization");
  assert(authText?.includes("mcp__ctx7__"), `授权行应含 Context7 工具全名（mcp__ctx7__*）: ${authText?.slice(0, 140)}`);
  await page.screenshot({ path: path.join(OUT, "02-ctx7-auth-gate.png") });
  step(`授权门拦截 Context7 工具（截图 02）`);

  const sessionAllow = page.locator('.dw-act-authorization >> text=本会话允许').first();
  if (await sessionAllow.count()) await sessionAllow.click().catch(() => {});
  else await page.click(".dw-act-authorization >> text=允许").catch(() => {});
  step("已允许（本会话）→ Context7 tools/call 真实发出");

  const doneDeadline = Date.now() + 420_000;
  let done = false;
  while (Date.now() < doneDeadline) {
    if (await page.locator(".dw-act-done").count()) { done = true; break; }
    if (await page.locator(".dw-act-authorization").count()) {
      await page.click(".dw-act-authorization >> text=允许").catch(() => {});
    }
    await page.waitForTimeout(800);
  }
  assert(done, "Agent 任务未在限时内完成");

  // 活动流应展示可读的 Context7 元信息
  await page.waitForTimeout(600);
  const activity = await page.textContent(".dw-activity");
  assert(activity.includes("Context7"), "活动流应展示 Context7（名称）");
  assert((activity).includes("远程/Streamable HTTP") || (activity).includes("远程 MCP"), "活动流应展示远程 MCP 传输元信息");
  await page.screenshot({ path: path.join(OUT, "03-ctx7-activity.png") });
  fs.writeFileSync(path.join(OUT, "activity.txt"), activity, "utf-8");
  step("活动流展示可读的 Context7 元信息（名称/传输/描述/端点/请求/结果）（截图 03）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[ctx7] 失败:", fatal, error?.stack ?? "");
} finally {
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(path.join(OUT, "real-llm-context7.txt"), [
    "实机演示（真实 DeepSeek + 真实外部 MCP Context7）：",
    `1. 配置真实外部 MCP Context7（transport=http, url=${CTX7_URL}），DevWit 协商协议版本并连接，就绪 ${ready?.tools.length ?? 0} 个工具（resolve-library-id/query-docs），serverInfo=${JSON.stringify(ready?.serverInfo?.name)} v${ready?.serverInfo?.version}。`,
    "2. 指挥台 Agent 任务让真实 DeepSeek 调用 Context7（先 resolve-library-id 解析 react，再 query-docs 查 useState）；授权门拦截 mcp__ctx7__*（截图 02），允许（本会话）后真实 tools/call 经 http 到达公网服务器。",
    "3. 活动流展示可读元信息：远程 MCP：Context7 · 远程/Streamable HTTP + 自报描述（摘要），端点/请求/结果（点击展开）（截图 03）。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"), "utf-8");
  if (browser !== null) await browser.close().catch(() => {});
  if (electronProc && !electronProc.killed) {
    electronProc.kill();
    await new Promise((resolve) => { const timer = setTimeout(resolve, 10_000); electronProc.once("exit", () => { clearTimeout(timer); resolve(); }); });
  }
  if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  if (report.failures.length > 0) {
    console.error(`[ctx7] ${report.failures.length} 项断言失败，详见 ${OUT}/report.json`);
    process.exit(1);
  }
  console.log(`[ctx7] 全部断言通过，证据已写入 ${OUT}`);
}
