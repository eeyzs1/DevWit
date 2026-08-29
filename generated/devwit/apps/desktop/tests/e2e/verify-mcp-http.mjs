/**
 * 远程 MCP（Streamable HTTP）验证脚本：本地起一个真实 Streamable HTTP MCP 服务器
 * （node:http 单端点 POST /mcp，initialize/tools/list/tools/call），经设置页 MCP 分区
 * 以 http 传输 + URL 配置接入，验证：
 * 1. UI 表单选择「远程（Streamable HTTP）」并填 URL → 状态徽标 连接中→就绪 + 工具计数；
 * 2. 工具全名 mcp__<serverId>__<tool> 暴露给 Agent；
 * 3. 授权门：agent 请求 mcp__e2ehttp__write_marker → 活动流授权行含全名，允许后真实
 *    tools/call 经 http 到达服务器，MARKER_FILE 落盘（真实副作用证据）；
 * 4. 删除服务器 → 列表清空（http 连接关闭）。
 *
 * Agent 本地端点以真实 SSE 线协议应答（脚本化队列），产品侧链路 100% 真实
 * （IPC、McpManager、McpHttpClient、授权门、活动流、文件系统）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC17-http");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-mcp-http-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello\n", "utf-8");
const MARKER_FILE = path.join(fixture, "mcp-http-marker.txt");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-mcp-http-userdata-"));

// ---------------------------------------------------------------------------
// 本地 Streamable HTTP MCP 服务器（真实线协议：initialize/tools/list/tools/call）
// ---------------------------------------------------------------------------
function mcpHttpHandler(markerFile) {
  return (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "not found" } }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const send = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      switch (msg.method) {
        case "initialize":
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2026-07-28", serverInfo: { name: "http-mcp", version: "1" }, capabilities: { tools: {} } } });
          return;
        case "tools/list":
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                { name: "write_marker", description: "write marker to disk", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
              ],
            },
          });
          return;
        case "tools/call": {
          const args = msg.params?.arguments ?? {};
          fs.writeFileSync(markerFile, String(args.text ?? ""), "utf-8");
          send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `wrote:${String(args.text ?? "")}` }], isError: false } });
          return;
        }
        default:
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
    });
  };
}

// ---------------------------------------------------------------------------
// 本地 OpenAI 兼容 SSE 端点（真实线协议，脚本化应答队列）—— agent LLM 侧
// ---------------------------------------------------------------------------
const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function framesForText(text) {
  return [
    sseChunk({ id: "mh", object: "chat.completion.chunk", created: 0, model: "mh", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sseChunk({ id: "mh", object: "chat.completion.chunk", created: 0, model: "mh", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({ id: "mh", object: "chat.completion.chunk", created: 0, model: "mh", choices: [], usage: { prompt_tokens: 60, completion_tokens: 12 } }),
    "data: [DONE]\n\n",
  ];
}

function framesForToolCall(name, args) {
  return [
    sseChunk({ id: "mh", object: "chat.completion.chunk", created: 0, model: "mh", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_mh_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    sseChunk({ id: "mh", object: "chat.completion.chunk", created: 0, model: "mh", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({ id: "mh", object: "chat.completion.chunk", created: 0, model: "mh", choices: [], usage: { prompt_tokens: 70, completion_tokens: 10 } }),
    "data: [DONE]\n\n",
  ];
}

const RESPONSES = [
  framesForToolCall("mcp__e2ehttp__write_marker", { text: "mcp-http-proof-1" }),
  framesForText("已通过远程 http MCP 工具写入标记。"),
];

const llmServer = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }
  req.resume();
  req.on("end", () => {
    const frames = RESPONSES.shift() ?? framesForText("(脚本外请求)");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let i = 0;
    const push = () => {
      if (i >= frames.length) { res.end(); return; }
      res.write(frames[i]);
      i += 1;
      setTimeout(push, 30);
    };
    push();
  });
});

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-mcp-http] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-mcp-http] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-mcp-http] FAIL: ${message}`);
  }
}

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1" },
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

async function waitMcpState(page, id, state, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const views = await page.evaluate(() => window.devwit.mcp.list());
    const view = views.find((entry) => entry.config.id === id);
    if (view?.state === state) return view;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

let browser = null;
let electronProc = null;
let mcpServer = null;
let fatal = null;
try {
  mcpServer = createServer(mcpHttpHandler(MARKER_FILE));
  await new Promise((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  const mcpUrl = `http://127.0.0.1:${mcpServer.address().port}/mcp`;
  step(`本地 Streamable HTTP MCP 服务器就绪 ${mcpUrl}`);

  await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
  const llmBaseUrl = `http://127.0.0.1:${llmServer.address().port}`;
  step(`本地 SSE 端点就绪 ${llmBaseUrl}`);

  const cdpPort = 22300 + Math.floor(Math.random() * 500);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  step("应用启动（默认中文）");

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("打开文件夹 → 文件树渲染");

  // ---- 1. 设置页 MCP 分区：UI 表单选择 http 传输 + 填 URL ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav >> text=MCP");
  await page.waitForSelector(".dw-mcp-state, .dw-settings-content .dw-form", { timeout: 5_000 });

  const inputs = page.locator(".dw-settings-content .dw-form input.dw-input");
  await inputs.nth(0).fill("e2ehttp");
  await inputs.nth(1).fill("E2E HTTP Server");
  // 传输下拉 → http（选中后 url/headers 字段出现，command/args/env 隐藏）
  await page.selectOption(".dw-settings-content .dw-form select", "http");
  await page.waitForSelector(".dw-settings-content .dw-form input[placeholder*='mcp.example.com']", { timeout: 5_000 });
  await page.fill(".dw-settings-content .dw-form input[placeholder*='mcp.example.com']", mcpUrl);
  await page.click(".dw-settings-content >> text=保存");
  step("UI 表单新增 http 服务器（http 传输 + URL）");

  const ready = await waitMcpState(page, "e2ehttp", "ready");
  assert(ready !== null, "远程服务器未达到就绪状态（http initialize/tools/list 失败）");
  assert(ready !== null && ready.tools.length === 1, `工具计数应为 1（实际: ${ready?.tools.length}）`);
  assert(
    ready !== null && ready.tools.some((tool) => tool.fullName === "mcp__e2ehttp__write_marker"),
    "工具全名前缀化缺失 mcp__e2ehttp__write_marker"
  );
  assert(ready !== null && ready.config.transport === "http", "服务器配置 transport 应为 http");
  await page.waitForSelector(".dw-mcp-state-ready", { timeout: 10_000 });
  const rowText = await page.textContent(".dw-modal-list-item");
  assert(rowText?.includes("就绪") && rowText?.includes("工具 1 个"), `列表行徽标/计数缺失: ${rowText}`);
  await page.screenshot({ path: path.join(OUT, "01-mcp-http-ready.png") });
  step("状态徽标 就绪 + 工具 1 个（http initialize/tools/list 全链路真实）");

  // ---- 2. agent 授权门 + 远程 http 工具真实调用（MARKER_FILE 落盘证据） ----
  await page.evaluate(async (url) => {
    await window.devwit.credentials.set("mcp-http-cred", "openai", "sk-mcp-http-fake");
    await window.devwit.providers.upsert({
      id: "mcp-http-local", type: "openai", label: "MCP HTTP Local", baseUrl: url,
      model: "mcp-http-model", credentialRef: "mcp-http-cred", maxTokens: 2048,
    });
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "mcp-http-local", updatedAt: new Date().toISOString() });
  }, llmBaseUrl);
  await page.click(".dw-modal >> text=关闭");
  step("凭证写入 + provider 注册 + agent 模式热绑定模型");

  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", "调用远程 http MCP 工具写入标记");
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  const authText = await page.textContent(".dw-act-authorization");
  assert(
    authText?.includes("mcp__e2ehttp__write_marker"),
    `授权行应含 MCP 工具全名: ${authText?.slice(0, 160)}`
  );
  await page.screenshot({ path: path.join(OUT, "02-mcp-http-auth-gate.png") });
  step("agent 请求 mcp__e2ehttp__write_marker → 授权门拦截（活动流授权行）");

  await page.click(".dw-act-authorization >> text=允许");
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const markerOk = fs.existsSync(MARKER_FILE) && fs.readFileSync(MARKER_FILE, "utf-8").includes("mcp-http-proof-1");
  assert(markerOk, "MARKER_FILE 未含 mcp-http-proof-1（远程 http 工具未真实执行）");
  const actText = await page.textContent(".dw-activity");
  assert(actText.includes("mcp__e2ehttp__write_marker") && actText.includes("成功"), "活动流缺少 MCP 工具成功行");
  await page.screenshot({ path: path.join(OUT, "03-mcp-http-tool-done.png") });
  step("授权允许 → MCP 工具经 http 真实调用 → MARKER_FILE 落盘");

  // ---- 3. 删除服务器 → 列表清空（http 连接关闭）----
  await page.evaluate(() => window.devwit.mcp.delete("e2ehttp"));
  await page.waitForFunction(
    async () => (await window.devwit.mcp.list()).length === 0,
    null,
    { timeout: 10_000 }
  );
  step("删除服务器 → 列表清空");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-mcp-http] 失败:", fatal, error?.stack ?? "");
} finally {
  fs.writeFileSync(path.join(OUT, "verify-mcp-http-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "verify-mcp-http.txt"),
    [
      "远程 MCP（Streamable HTTP）验证：",
      "1. 设置页 MCP 分区：UI 表单选择「远程（Streamable HTTP）」+ URL，状态徽标 连接中→就绪 + 「工具 1 个」（initialize/tools/list 经 IPC→McpManager→McpHttpClient→http 端点全链路真实）。",
      "2. 工具全名 mcp__e2ehttp__write_marker 暴露给 Agent。",
      "3. 授权门：agent 请求 mcp__e2ehttp__write_marker → 活动流授权行含工具全名（截图 02），允许后真实 tools/call 经 http 到达服务器，MARKER_FILE 落盘 mcp-http-proof-1（截图 03，真实副作用证据）。",
      "4. 删除服务器 → mcp.list() 清空（http 连接关闭）。",
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
  llmServer.close();
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (report.failures.length > 0) {
    console.error(`[verify-mcp-http] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-mcp-http-report.json`);
    process.exit(1);
  }
  console.log(`[verify-mcp-http] 全部断言通过，证据已写入 ${OUT}`);
}
