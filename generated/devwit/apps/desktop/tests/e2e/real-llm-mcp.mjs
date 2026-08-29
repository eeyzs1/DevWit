/**
 * 实机演示：真实 DeepSeek LLM + 真实第三方 MCP 服务器（@modelcontextprotocol/server-filesystem）
 *
 * 目标（针对「MCP 演示只停在开设置」的反馈）：配置好 MCP 后，真的让 LLM 使用它。
 * 全链路真实：
 *   1. 真实第三方 MCP server（stdio 子进程）经 McpManager 加载，工具全名 mcp__fs__* 暴露给 Agent；
 *   2. 设置页 MCP 分区展示该服务器「就绪 + N 个工具」；
 *   3. 指挥台(Agent) 任务让 DeepSeek 调用 MCP write_file 工具；
 *   4. 授权门出现（含 mcp__fs__write_file 全名），允许后真实 tools/call 经 stdio 到达 MCP server；
 *   5. MCP server 真实写入 real-mcp-proof.txt；DeepSeek 依据工具结果回总结语；
 *   6. 截图/工具清单/活动流/落盘文件作为证据。
 *
 * 本脚本自启动电子窗口（不依赖预先运行的实例），DEEPSEEK_API_KEY 经 env 传入（不打印）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "real-llm-mcp");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error("缺少 DEEPSEEK_API_KEY"); process.exit(2); }

// MCP filesystem 根目录：一个含 input.txt 的临时项目，LLM 可读，工具可写
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "dw-real-llm-mcp-"));
fs.writeFileSync(path.join(proj, "input.txt"), "这是由真实 DeepSeek 驱动的 MCP 验证项目。\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-real-llm-mcp-userdata-"));
const PROOF_NAME = "real-mcp-proof.txt";
const PROOF_PATH = path.join(proj, PROOF_NAME);
const CONTENT = "hello from real deepseek via mcp " + Date.now();

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[real-llm-mcp] ${name}`); };
function assert(cond, message) {
  if (cond) { report.assertions.push(message); console.log(`[real-llm-mcp] PASS: ${message}`); }
  else { report.failures.push(message); console.error(`[real-llm-mcp] FAIL: ${message}`); }
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

async function waitMcpReady(page, id, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const views = await page.evaluate(() => window.devwit.mcp.list());
    const view = views.find((entry) => entry.config.id === id);
    if (view?.state === "ready") return view;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

let browser = null;
let electronProc = null;
let ready = null;
let fatal = null;
try {
  const cdpPort = 22600 + Math.floor(Math.random() * 400);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask, .dw-modal-mask").forEach((m) => m.remove())).catch(() => {});
  step("应用启动（真实 DeepSeek 配置）");

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("打开文件夹 → 文件树渲染");

  // ---- 1. 配置真实 DeepSeek provider ----
  await page.evaluate(async (key) => {
    await window.devwit.credentials.set("deepseek-cred", "openai", key);
    await window.devwit.providers.upsert({
      id: "deepseek-ds", type: "openai", label: "DeepSeek",
      baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash-vision-exp",
      credentialRef: "deepseek-cred", maxTokens: 8192,
    });
  }, KEY);
  step("真实 DeepSeek provider 已注册（密钥经 env，未打印）");

  // ---- 2. 配置真实第三方 MCP 服务器（filesystem）----
  const mcpCfg = { id: "fs", name: "Filesystem (real MCP)", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", proj], enabled: true };
  await page.evaluate((c) => window.devwit.mcp.upsert(c), mcpCfg);
  step("已配置真实 filesystem MCP（stdio，npx）");

  ready = await waitMcpReady(page, "fs");
  assert(ready !== null, "filesystem MCP 未达成就绪（npx 握手/tools/list 失败）");
  assert(ready !== null && ready.config.transport === "stdio", "MCP 传输应为 stdio");
  const toolFullNames = ready !== null ? ready.tools.map((t) => t.fullName) : [];
  const hasWrite = toolFullNames.includes("mcp__fs__write_file");
  const hasRead = toolFullNames.includes("mcp__fs__read_file");
  assert(hasWrite, `filesystem MCP 应暴露 mcp__fs__write_file（实际 ${toolFullNames.slice(0, 6).join(", ")}）`);
  assert(ready !== null && ready.tools.length >= 10, `filesystem MCP 工具数应 >= 10（实际 ${ready?.tools.length}）`);
  fs.writeFileSync(path.join(OUT, "mcp-tools.json"), JSON.stringify({ count: ready?.tools.length ?? 0, fullNames: toolFullNames }, null, 2));
  step(`filesystem MCP 就绪：${ready?.tools.length ?? 0} 个工具（含 mcp__fs__write_file）`);

  // ---- 3. 设置页 MCP 分区截图（服务器就绪 + 工具）----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav >> text=MCP");
  await page.waitForSelector(".dw-mcp-state-ready", { timeout: 10_000 });
  await page.screenshot({ path: path.join(OUT, "01-mcp-settings-ready.png") });
  await page.click(".dw-modal >> text=关闭");
  step("设置页 MCP 分区：服务器「就绪」+ 工具（截图 01）");

  // ---- 4. 绑定 agent 模式到真实 DeepSeek ----
  await page.evaluate(async () => {
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "deepseek-ds", updatedAt: new Date().toISOString() });
  });
  step("agent 模式热绑定到真实 DeepSeek");

  // ---- 5. 指挥台创建任务：让真实 DeepSeek 调用 MCP write_file ----
  await page.click(".dw-header >> text=指挥台");
  const task = `使用 MCP 工具 write_file 在项目根目录创建文件 ${PROOF_NAME}。必须调用工具，参数：path="${PROOF_NAME}"，content="${CONTENT}"。写完后用一句中文确认已通过 MCP 写入。`;
  await page.fill(".dw-task-new .dw-input", task);
  await page.click(".dw-console-tasks >> text=创建");
  step(`已提交 Agent 任务：调用 MCP write_file → ${PROOF_NAME}`);

  // ---- 6. 授权门（真实 DeepSeek 调用某个 mcp__fs__* 工具）----
  await page.waitForSelector(".dw-act-authorization", { timeout: 120_000 });
  const authText = await page.textContent(".dw-act-authorization");
  assert(authText?.includes("mcp__fs__"), `授权行应含 MCP 工具全名（mcp__fs__*）: ${authText?.slice(0, 180)}`);
  await page.screenshot({ path: path.join(OUT, "02-auth-gate.png") });
  step(`授权门拦截 MCP 工具：${(authText ?? "").slice(0, 90)}（截图 02）`);

  // 允许本次 + 本会话后续所有工具（真实 LLM 可能依次调用多个不同 MCP 工具）
  const sessionAllow = page.locator('.dw-act-authorization >> text=本会话允许').first();
  if (await sessionAllow.count()) await sessionAllow.click().catch(() => {});
  else await page.click(".dw-act-authorization >> text=允许").catch(() => {});
  step("已允许（本会话）→ MCP 工具经 stdio 真实调用");

  // 循环等待完成：期间若出现新的授权门则继续允许
  const doneDeadline = Date.now() + 180_000;
  let done = false;
  while (Date.now() < doneDeadline) {
    if (await page.locator(".dw-act-done").count()) { done = true; break; }
    if (await page.locator(".dw-act-authorization").count()) {
      const a = await page.textContent(".dw-act-authorization");
      console.error(`[real-llm-mcp] 追加授权门: ${(a ?? "").slice(0, 90)}`);
      await page.click(".dw-act-authorization >> text=允许").catch(() => {});
    }
    await page.waitForTimeout(700);
  }
  assert(done, "Agent 任务未在限时内完成（可能被额外授权门阻塞）");
  step("Agent 任务完成");

  // ---- 7. 落盘证据 + 最终回复 ----
  const exist = fs.existsSync(PROOF_PATH);
  const content = exist ? fs.readFileSync(PROOF_PATH, "utf-8") : "";
  assert(exist, "real-mcp-proof.txt 未落盘（MCP write_file 未真实执行）");
  assert(content.includes("hello from real deepseek via mcp"), `落盘内容不符: ${content.slice(0, 80)}`);
  fs.writeFileSync(path.join(OUT, "proof-file.txt"), content, "utf-8");
  await page.screenshot({ path: path.join(OUT, "03-activity-done.png") });

  const actText = await page.textContent(".dw-activity");
  assert(actText.includes("mcp__fs__") && actText.includes("成功"), "活动流缺少 MCP 工具成功行");
  fs.writeFileSync(path.join(OUT, "activity.txt"), actText, "utf-8");
  step("工具成功行 + 落盘证据（截图 03）");

  const finalSummary = await page.textContent(".dw-act-done").catch(() => "");
  fs.writeFileSync(path.join(OUT, "summary.txt"), finalSummary ?? "", "utf-8");
  step("Agent 最终总结已记录");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[real-llm-mcp] 失败:", fatal, error?.stack ?? "");
} finally {
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "real-llm-mcp.txt"),
    [
      "实机演示（真实 DeepSeek + 真实 filesystem MCP）：",
      `1. 配置真实 DeepSeek provider（env 注入密钥，不落盘）；配置真实 filesystem MCP（stdio/npx），就绪 ${ready !== null ? ready.tools.length : 0} 个工具（含 mcp__fs__write_file）。`,
      "2. 设置页 MCP 分区展示「就绪 + 工具」（截图 01）。",
      "3. 指挥台 Agent 任务让真实 DeepSeek 调用某个 MCP 工具；授权门出现 mcp__fs__*（截图 02），允许（本会话）后真实 tools/call 经 stdio 到达 MCP server。",
      `4. MCP 真实写入 ${PROOF_NAME}=${CONTENT.slice(0, 40)}…（截图 03）；活动流含 MCP 工具成功行。`,
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
  if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  if (report.failures.length > 0) {
    console.error(`[real-llm-mcp] ${report.failures.length} 项断言失败，详见 ${OUT}/report.json`);
    process.exit(1);
  }
  console.log(`[real-llm-mcp] 全部断言通过，证据已写入 ${OUT}`);
}
