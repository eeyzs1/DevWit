/**
 * 迭代 8 验证脚本（AC17 MCP 工具接入，证据落盘 evidence/AC17）：
 * 1. 设置页 MCP 分区：UI 表单新增 stdio 服务器（真实 node 子进程跑 fake-mcp-server），
 *    状态徽标 连接中→就绪 + 工具计数（证明 initialize/tools/list 全链路真实）；
 * 2. 热同步：停用→已停用（工具即刻下线），重新启用→就绪（无需重启）；
 * 3. 授权门：agent 请求 mcp__e2e__write_marker → 活动流授权行含 MCP 工具全名，
 *    允许后真实调用经 stdio 到达服务器，MARKER_FILE 落盘（真实副作用证据）；
 * 4. 删除服务器 → 列表清空（子进程停止）。
 *
 * LLM 侧说明与 smoke.mjs/iteration2.mjs 相同：本地端点以真实 SSE 线协议应答，
 * 产品侧链路 100% 真实（IPC、McpManager、stdio JSON-RPC、授权门、活动流、文件系统）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC17");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const FAKE_SERVER = path.join(ROOT, "packages", "mcp", "tests", "fixtures", "fake-mcp-server.mjs");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i8-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello\n", "utf-8");
const MARKER_FILE = path.join(fixture, "mcp-marker.txt");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i8-userdata-"));

// ---------------------------------------------------------------------------
// 本地 OpenAI 兼容 SSE 端点（真实线协议，脚本化应答队列）
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function framesForText(text) {
  return [
    sseChunk({ id: "i8", object: "chat.completion.chunk", created: 0, model: "i8", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sseChunk({ id: "i8", object: "chat.completion.chunk", created: 0, model: "i8", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({ id: "i8", object: "chat.completion.chunk", created: 0, model: "i8", choices: [], usage: { prompt_tokens: 60, completion_tokens: 12 } }),
    "data: [DONE]\n\n",
  ];
}

function framesForToolCall(name, args) {
  return [
    sseChunk({ id: "i8", object: "chat.completion.chunk", created: 0, model: "i8", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_i8_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    sseChunk({ id: "i8", object: "chat.completion.chunk", created: 0, model: "i8", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({ id: "i8", object: "chat.completion.chunk", created: 0, model: "i8", choices: [], usage: { prompt_tokens: 70, completion_tokens: 10 } }),
    "data: [DONE]\n\n",
  ];
}

const RESPONSES = [
  // #1：agent 请求 MCP 工具（全名 mcp__e2e__write_marker）
  framesForToolCall("mcp__e2e__write_marker", { text: "mcp-proof-1" }),
  // #2：工具结果回填后的总结
  framesForText("已通过 MCP 工具写入标记。"),
];

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }
  req.resume(); // 排空请求体（脚本不消费内容），保证 end 触发
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i8] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i8] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i8] FAIL: ${message}`);
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

/** 轮询 MCP 服务器状态（主进程真实子进程生命周期）。 */
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
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  step(`本地 SSE 端点就绪 ${baseUrl}`);

  const cdpPort = 22100 + Math.floor(Math.random() * 500);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  step("应用启动（默认中文）");

  // 打开工作区（agent 任务需要 workspace root）
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("打开文件夹 → 文件树渲染");

  // ---- 1. 设置页 MCP 分区：UI 表单新增服务器，状态徽标到就绪 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  const navText = await page.textContent(".dw-settings-nav");
  assert(navText.includes("MCP"), `设置页导航缺少 MCP 分区: ${navText}`);
  await page.click(".dw-settings-nav >> text=MCP");
  await page.waitForSelector(".dw-mcp-state, .dw-settings-content .dw-form", { timeout: 5_000 });
  const mcpTitle = await page.textContent(".dw-settings-content h3");
  assert(mcpTitle?.includes("MCP"), `MCP 分区标题缺失: ${mcpTitle}`);

  const inputs = page.locator(".dw-settings-content .dw-form input.dw-input");
  await inputs.nth(0).fill("e2e");
  await inputs.nth(1).fill("E2E Fake Server");
  await inputs.nth(2).fill(process.execPath);
  await inputs.nth(3).fill(FAKE_SERVER);
  await page.fill(".dw-settings-content .dw-form textarea", `MARKER_FILE=${MARKER_FILE}`);
  await page.click(".dw-settings-content >> text=保存");
  step("UI 表单新增 MCP 服务器（真实 node 子进程 + fake-mcp-server）");

  const ready = await waitMcpState(page, "e2e", "ready");
  assert(ready !== null, "服务器未达到就绪状态（stdio 握手/tools/list 失败）");
  assert(ready !== null && ready.tools.length === 3, `工具计数应为 3（实际: ${ready?.tools.length}）`);
  assert(
    ready !== null && ready.tools.some((tool) => tool.fullName === "mcp__e2e__write_marker"),
    "工具全名前缀化缺失 mcp__e2e__write_marker"
  );
  await page.waitForSelector(".dw-mcp-state-ready", { timeout: 10_000 });
  const rowText = await page.textContent(".dw-modal-list-item");
  assert(rowText?.includes("就绪") && rowText?.includes("工具 3 个"), `列表行徽标/计数缺失: ${rowText}`);
  await page.screenshot({ path: path.join(OUT, "01-mcp-ready.png") });
  step("状态徽标 就绪 + 工具 3 个（initialize/tools/list 全链路真实）");

  // ---- 2. 热同步：停用→已停用，重新启用→就绪（无需重启）----
  await page.evaluate(async () => {
    const view = (await window.devwit.mcp.list()).find((entry) => entry.config.id === "e2e");
    await window.devwit.mcp.upsert({ ...view.config, enabled: false });
  });
  const disabled = await waitMcpState(page, "e2e", "disabled");
  assert(disabled !== null && disabled.tools.length === 0, "停用后应为已停用且工具下线");
  await page.waitForSelector(".dw-mcp-state-disabled", { timeout: 10_000 });
  step("热停用 → 已停用徽标（工具即刻下线）");

  await page.evaluate(async () => {
    const view = (await window.devwit.mcp.list()).find((entry) => entry.config.id === "e2e");
    await window.devwit.mcp.upsert({ ...view.config, enabled: true });
  });
  const reReady = await waitMcpState(page, "e2e", "ready");
  assert(reReady !== null && reReady.tools.length === 3, "重新启用后未恢复就绪");
  step("热启用 → 就绪恢复（配置热生效，无需重启）");
  await page.screenshot({ path: path.join(OUT, "02-mcp-hot-toggle.png") });

  // ---- 3. 授权门 + MCP 工具真实调用（MARKER_FILE 落盘证据）----
  await page.evaluate(async (url) => {
    await window.devwit.credentials.set("i8-cred", "openai", "sk-i8-fake");
    await window.devwit.providers.upsert({
      id: "i8-local", type: "openai", label: "I8 Local", baseUrl: url,
      model: "i8-model", credentialRef: "i8-cred", maxTokens: 2048,
    });
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "i8-local", updatedAt: new Date().toISOString() });
  }, baseUrl);
  await page.click(".dw-modal >> text=关闭");
  step("凭证写入 + provider 注册 + agent 模式热绑定模型");

  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", "调用 MCP 工具写入标记");
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  const authText = await page.textContent(".dw-act-authorization");
  assert(
    authText?.includes("mcp__e2e__write_marker"),
    `授权行应含 MCP 工具全名: ${authText?.slice(0, 160)}`
  );
  await page.screenshot({ path: path.join(OUT, "03-mcp-auth-gate.png") });
  step("agent 请求 mcp__e2e__write_marker → 授权门拦截（活动流授权行）");

  await page.click(".dw-act-authorization >> text=允许");
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const markerOk = fs.existsSync(MARKER_FILE) && fs.readFileSync(MARKER_FILE, "utf-8").includes("mcp-proof-1");
  assert(markerOk, "MARKER_FILE 未含 mcp-proof-1（MCP 工具未真实执行）");
  const actText = await page.textContent(".dw-activity");
  assert(actText.includes("mcp__e2e__write_marker") && actText.includes("成功"), "活动流缺少 MCP 工具成功行");
  await page.screenshot({ path: path.join(OUT, "04-mcp-tool-done.png") });
  step("授权允许 → MCP 工具经 stdio 真实调用 → MARKER_FILE 落盘");

  // ---- 4. 删除服务器 → 列表清空 ----
  await page.evaluate(() => window.devwit.mcp.delete("e2e"));
  await page.waitForFunction(
    async () => (await window.devwit.mcp.list()).length === 0,
    null,
    { timeout: 10_000 }
  );
  step("删除服务器 → 列表清空（子进程停止）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i8] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i8-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration8-verification.txt"),
    [
      "迭代 8（AC17 MCP 工具接入）验证：",
      "1. 设置页 MCP 分区：UI 表单新增 stdio 服务器（node + fake-mcp-server.mjs，env 传 MARKER_FILE），状态徽标 连接中→就绪 + 「工具 3 个」（initialize/tools/list 经 IPC→McpManager→stdio 子进程全链路真实）。",
      "2. 热同步：停用→已停用徽标且工具下线，重新启用→就绪恢复（settings onChanged → syncConfigs 差量同步，无需重启）。",
      "3. 授权门：agent 请求 mcp__e2e__write_marker → 活动流授权行含工具全名（截图 03），允许后真实 tools/call 经 stdio 到达服务器，MARKER_FILE 落盘 mcp-proof-1（截图 04，真实副作用证据）。",
      "4. 删除服务器 → mcp.list() 清空（子进程停止）。",
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
  server.close();
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (report.failures.length > 0) {
    console.error(`[verify-i8] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i8-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i8] 全部断言通过，证据已写入 ${OUT}`);
}
