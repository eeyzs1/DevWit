/**
 * 实机演示（远程 http 传输）：真实 DeepSeek LLM 调用「http 远程」MCP 服务器
 *
 * 关键点：本次 MCP 服务器以 transport="http" + url 接入（★不是 stdio 子进程★）。
 * 服务器是一个真正的 Streamable HTTP 端点（POST /mcp），DevWit 经 McpHttpClient
 * 以全局 fetch 发 POST，带 MCP-Protocol-Version / Mcp-Method / Mcp-Name 必需头。
 * 为证明「真的走了 http 传输」（而非 stdio），服务器把收到的每个请求头逐条落盘
 * 到 proof-headers.txt，作为传输证据。
 *
 * 全链路真实：
 *   1. 启动 Streamable HTTP MCP 服务器（POST /mcp，write_marker 工具）；
 *   2. 设置页以 http 传输 + URL 接入，等待「就绪 + 工具」；
 *   3. 指挥台 Agent 任务让真实 DeepSeek 调用 mcp__remotehttp__write_marker；
 *   4. 授权门（http MCP 工具全名）拦截 → 允许（本会话）；
 *   5. 真实 tools/call 经 http 到达服务器 → 写 proof-marker.txt；
 *   6. 服务器记录到的请求头（含必需 MCP 头）作为 http 传输证明；DeepSeek 中文确认 + 真实用量。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "real-llm-mcp-http");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error("缺少 DEEPSEEK_API_KEY"); process.exit(2); }

const proj = fs.mkdtempSync(path.join(os.tmpdir(), "dw-real-llm-mcp-http-"));
fs.writeFileSync(path.join(proj, "input.txt"), "http MCP demo project\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-real-llm-mcp-http-userdata-"));
const MARKER_PATH = path.join(proj, "proof-marker.txt");
const HEADERS_LOG = path.join(OUT, "proof-headers.txt");
const MARKER_TEXT = "http-mcp-proof-" + Date.now();

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[real-llm-mcp-http] ${name}`); };
function assert(cond, message) {
  if (cond) { report.assertions.push(message); console.log(`[real-llm-mcp-http] PASS: ${message}`); }
  else { report.failures.push(message); console.error(`[real-llm-mcp-http] FAIL: ${message}`); }
}

// ---------------------------------------------------------------------------
// Streamable HTTP MCP 服务器（POST /mcp）。记录每个请求头 → 证明走 http 传输。
// ---------------------------------------------------------------------------
function startHttpMcp() {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "only POST /mcp" } }));
      return;
    }
    // 记录收到的 http 头（证明经 HTTP 传输，而非 stdio 子进程）
    const entry = { t: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers };
    fs.appendFileSync(HEADERS_LOG, JSON.stringify(entry) + "\n");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const send = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      switch (msg.method) {
        case "initialize":
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2026-07-28", serverInfo: { name: "remotehttp", version: "1" }, capabilities: { tools: {} } } });
          return;
        case "tools/list":
          send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "write_marker", description: "write a marker text to disk", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
          return;
        case "tools/call": {
          const args = msg.params?.arguments ?? {};
          fs.writeFileSync(MARKER_PATH, String(args.text ?? ""), "utf-8");
          send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `wrote:${String(args.text ?? "")}` }], isError: false } });
          return;
        }
        default:
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
    });
  });
  return server;
}

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const envVars = { ...process.env, DEVWIT_E2E_OPEN_DIR: proj, DEVWIT_USER_DATA_DIR: userDataDir, DEEPSEEK_API_KEY: KEY };
    // 默认离屏（无窗口）；设置 DEVWIT_HEADED=1 时弹出可见 DevWit 窗口供人观看
    if (!process.env.DEVWIT_HEADED) envVars.DEVWIT_E2E_OFFSCREEN = "1";
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: envVars,
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

async function waitMcpReady(page, id, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const views = await page.evaluate(() => window.devwit.mcp.list());
    const view = views.find((entry) => entry.config.id === id);
    if (view?.state === "ready") return view;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

let browser = null;
let electronProc = null;
let mcpServer = null;
let ready = null;
let fatal = null;
try {
  mcpServer = startHttpMcp();
  await new Promise((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const mcpUrl = `http://127.0.0.1:${mcpServer.address().port}/mcp`;
  step(`Streamable HTTP MCP 端点就绪：${mcpUrl}`);

  const cdpPort = 22900 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask, .dw-modal-mask").forEach((m) => m.remove())).catch(() => {});
  step("应用启动");

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("打开文件夹 → 文件树渲染");

  // 配置真实 DeepSeek provider
  await page.evaluate(async (key) => {
    await window.devwit.credentials.set("deepseek-cred", "openai", key);
    await window.devwit.providers.upsert({
      id: "deepseek-ds", type: "openai", label: "DeepSeek",
      baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash-vision-exp",
      credentialRef: "deepseek-cred", maxTokens: 8192,
    });
  }, KEY);
  step("真实 DeepSeek provider 已注册");

  // ★配置 http 远程 MCP（transport=http + url，非 stdio）★
  const cfg = { id: "remotehttp", name: "Remote HTTP MCP", transport: "http", url: mcpUrl, enabled: true };
  await page.evaluate((c) => window.devwit.mcp.upsert(c), cfg);
  step(`已配置 http 远程 MCP（transport=http, url=${mcpUrl}）`);

  ready = await waitMcpReady(page, "remotehttp");
  assert(ready !== null, "http 远程 MCP 未达成就绪");
  assert(ready !== null && ready.config.transport === "http", "服务器配置 transport 应为 http（★非 stdio★）");
  assert(ready !== null && ready.config.url === mcpUrl, "服务器配置 url 应为远程端点");
  assert(ready !== null && ready.tools.some((t) => t.fullName === "mcp__remotehttp__write_marker"), "应暴露 mcp__remotehttp__write_marker");
  fs.writeFileSync(path.join(OUT, "mcp-tools.json"), JSON.stringify({ count: ready?.tools.length ?? 0, transition: ready?.config.transport, url: ready?.config.url, tools: ready?.tools.map((t) => t.fullName) }, null, 2));
  step(`http 远程 MCP 就绪：${ready?.tools.length ?? 0} 个工具，transport=${ready?.config.transport}`);

  // 设置页截图：显示 http 传输 + URL
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav >> text=MCP");
  await page.waitForSelector(".dw-mcp-state-ready", { timeout: 10_000 });
  // 点击该服务器行 → 表单回填 transport=http 与 URL（证明 http 远程配置，非 stdio）
  await page.click('.dw-modal-list-item:has-text("Remote HTTP MCP")').catch(() => {});
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "01-http-mcp-settings-ready.png") });
  await page.click(".dw-modal >> text=关闭");
  step("设置页 MCP 分区：http 服务器「就绪」+ 表单回填 http/URL（截图 01）");

  // 绑定 agent 模式到真实 DeepSeek
  await page.evaluate(async () => {
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "deepseek-ds", updatedAt: new Date().toISOString() });
  });
  step("agent 模式热绑定到真实 DeepSeek");

  // 指挥台任务：让真实 DeepSeek 调用 http 远程 MCP 工具
  await page.click(".dw-header >> text=指挥台");
  const task = `使用 MCP 工具 write_marker 写入一个标记。必须调用工具，参数：text="${MARKER_TEXT}"。写完后用一句中文确认已通过远程 MCP 写入。`;
  await page.fill(".dw-task-new .dw-input", task);
  await page.click(".dw-console-tasks >> text=创建");
  step(`已提交 Agent 任务：调用 http 远程 MCP write_marker → ${MARKER_TEXT}`);

  // 授权门
  await page.waitForSelector(".dw-act-authorization", { timeout: 120_000 });
  const authText = await page.textContent(".dw-act-authorization");
  assert(authText?.includes("mcp__remotehttp__write_marker"), `授权行应含 mcp__remotehttp__write_marker 全名: ${authText?.slice(0, 180)}`);
  await page.screenshot({ path: path.join(OUT, "02-http-auth-gate.png") });
  step(`授权门拦截 mcp__remotehttp__write_marker（截图 02）：${(authText ?? "").slice(0, 80)}`);

  const sessionAllow = page.locator('.dw-act-authorization >> text=本会话允许').first();
  if (await sessionAllow.count()) await sessionAllow.click().catch(() => {});
  else await page.click(".dw-act-authorization >> text=允许").catch(() => {});
  step("已允许（本会话）→ http tools/call 真实发出");

  const doneDeadline = Date.now() + 180_000;
  let done = false;
  while (Date.now() < doneDeadline) {
    if (await page.locator(".dw-act-done").count()) { done = true; break; }
    if (await page.locator(".dw-act-authorization").count()) {
      const a = await page.textContent(".dw-act-authorization");
      console.error(`[real-llm-mcp-http] 追加授权门: ${(a ?? "").slice(0, 90)}`);
      await page.click(".dw-act-authorization >> text=允许").catch(() => {});
    }
    await page.waitForTimeout(700);
  }
  assert(done, "Agent 任务未在限时内完成");
  step("Agent 任务完成");

  // http 传输证据：服务器收到的包头（必需 MCP 头）
  const headersLog = fs.readFileSync(HEADERS_LOG, "utf-8");
  const hasProto = headersLog.includes("mcp-protocol-version") || headersLog.includes("MCP-Protocol-Version") || headersLog.includes("mcp_protocol_version");
  const hasMethod = headersLog.includes("mcp-method") || headersLog.includes("Mcp-Method") || headersLog.includes("mcp_method");
  const hasName = headersLog.includes("mcp-name") || headersLog.includes("Mcp-Name") || headersLog.includes("mcp_name");
  const calls = headersLog.trim().split("\n").length;
  assert(calls >= 3, `http 服务器应收到 >=3 次 POST（实际 ${calls} 次）`);
  assert(hasProto, "服务器应收到 MCP-Protocol-Version 头（http 传输必需头）");
  assert(hasMethod, "服务器应收到 Mcp-Method 头（http 传输必需头）");
  assert(hasName, "服务器应收到 Mcp-Name 头（http 传输必需头）");
  fs.writeFileSync(path.join(OUT, "headers-log.json"), headersLog, "utf-8");
  step(`http 传输证明：服务器共收到 ${calls} 次 POST，含必需 MCP 头（MCP-Protocol-Version/Mcp-Method/Mcp-Name）`);

  // 落盘证据 + 最终回复
  const exist = fs.existsSync(MARKER_PATH);
  const content = exist ? fs.readFileSync(MARKER_PATH, "utf-8") : "";
  assert(exist, "proof-marker.txt 未落盘（http 远程 MCP 工具未真实执行）");
  assert(content.includes("http-mcp-proof-"), `落盘内容不符: ${content.slice(0, 60)}`);
  fs.writeFileSync(path.join(OUT, "proof-marker.txt"), content, "utf-8");
  await page.screenshot({ path: path.join(OUT, "03-http-activity-done.png") });

  const actText = await page.textContent(".dw-activity");
  assert(actText.includes("mcp__remotehttp__write_marker") && actText.includes("成功"), "活动流缺少 MCP 工具成功行");
  fs.writeFileSync(path.join(OUT, "activity.txt"), actText, "utf-8");
  step("工具成功行 + 落盘（截图 03）");

  const finalSummary = await page.textContent(".dw-act-done").catch(() => "");
  fs.writeFileSync(path.join(OUT, "summary.txt"), finalSummary ?? "", "utf-8");
  step("Agent 最终总结已记录");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[real-llm-mcp-http] 失败:", fatal, error?.stack ?? "");
} finally {
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "real-llm-mcp-http.txt"),
    [
      "实机演示（真实 DeepSeek + 远程 http 传输 MCP）：",
      `1. 启动 Streamable HTTP MCP 端点 ${ready?.config.url ?? ""}；设置页以 transport=http + url 接入（★非 stdio★），就绪 ${ready?.tools.length ?? 0} 个工具（含 mcp__remotehttp__write_marker）。`,
      "2. 指挥台 Agent 任务让真实 DeepSeek 调用 http 远程 MCP 工具；授权门出现 mcp__remotehttp__write_marker（截图 02），允许（本会话）后真实 tools/call 经 http 到达服务器。",
      "3. http 传输证明：服务器共收到收到的 POST 请求头（含 MCP-Protocol-Version / Mcp-Method / Mcp-Name 必需头），证明走的是 http 传输而非 stdio 子进程。",
      `4. MCP 真实写入 proof-marker.txt；活动流含 MCP 工具成功行 + DeepSeek 中文确认（截图 03）。`,
      `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
    ].join("\n"),
    "utf-8"
  );
  if (browser !== null) await browser.close().catch(() => {});
  if (electronProc && !electronProc.killed) {
    electronProc.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      electronProc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (mcpServer !== null) mcpServer.close();
  if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  if (report.failures.length > 0) {
    console.error(`[real-llm-mcp-http] ${report.failures.length} 项断言失败，详见 ${OUT}/report.json`);
    process.exit(1);
  }
  console.log(`[real-llm-mcp-http] 全部断言通过，证据已写入 ${OUT}`);
}
