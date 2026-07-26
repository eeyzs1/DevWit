/**
 * 迭代 17 验证脚本（AC26 首次运行成功路径 · 连接探测，证据落盘 evidence/AC26）：
 * 1. 设置·模型分区新增「测试连接」按钮（dw-modal-actions 首位）；
 * 2. Ollama 预设选中后 baseUrl 改指本地端点 → 探测成功：状态行「连接成功 · 发现 2 个模型」、
 *    真实型号回填 datalist、型号输入框自动填首个发现型号（零输入完成配置）；
 * 3. keyless 链路：服务端断言 GET /v1/models 零 authorization 头；
 * 4. 自定义 + apiKey：服务端断言 authorization: Bearer 按原样送达（凭证不落盘直传）；
 * 5. 失败路径（死端口）：状态行本地化「无法连接」+ Ollama 预设专属安装引导（ollama.com）。
 *
 * 服务端为真实 HTTP 回环（本地 node server），产品侧链路 100% 真实
 * （设置 UI → preload → IPC 白名单 → llm-providers probeProvider → 渲染状态行）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC26");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i15-"));
fs.writeFileSync(path.join(fixture, "hello.ts"), "export const hello = 'world';\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i15-userdata-"));

// ---------------------------------------------------------------------------
// 本地端点：GET /v1/models 返回两个型号，记录 authorization 头
// ---------------------------------------------------------------------------

const authLog = []; // { url, authorization }
const server = createServer((req, res) => {
  authLog.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3:8b" }, { id: "llama3.1:8b" }] }));
    return;
  }
  res.writeHead(404).end("not found");
});

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i15] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i15] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i15] FAIL: ${message}`);
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

/** 等待探测状态行（表单内第二个 .dw-modal-hint）出现目标文本。 */
async function waitProbeStatus(page, needle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.textContent(".dw-form .dw-modal-hint >> nth=1").catch(() => null);
    if (text !== null && text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（GET /models 返回 qwen3:8b + llama3.1:8b）`);

  const cdpPort = 23600 + Math.floor(Math.random() * 500);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开");

  // ---- 1. 设置·模型：Ollama 预设 + 测试连接成功路径 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav-item >> text=模型");
  await page.waitForSelector(".dw-form select", { timeout: 5_000 });
  const probeBtnExists = (await page.$(".dw-modal-actions >> text=测试连接")) !== null;
  assert(probeBtnExists, "模型分区缺「测试连接」按钮");

  await page.selectOption(".dw-form select >> nth=0", "ollama");
  await page.fill('.dw-form input[type="text"] >> nth=2', baseUrl);
  await page.click(".dw-modal-actions >> text=测试连接");
  const okStatus = await waitProbeStatus(page, "连接成功");
  assert(okStatus !== null && okStatus.includes("发现 2 个模型"), `探测成功状态行异常: ${okStatus}`);
  const datalistOptions = await page.$$eval("#dw-provider-model-suggestions option", (opts) => opts.map((o) => o.value));
  assert(datalistOptions.join(",") === "qwen3:8b,llama3.1:8b", `datalist 应回填真实型号（实际: ${datalistOptions.join("/")}）`);
  const modelValue = await page.inputValue('.dw-form input[type="text"] >> nth=3');
  assert(modelValue === "qwen3:8b", `型号输入框应自动填首个发现型号（实际: ${modelValue}）`);
  const keylessProbe = authLog.filter((entry) => entry.url === "/v1/models");
  assert(keylessProbe.length > 0, "服务端未收到 GET /v1/models 探测请求");
  assert(keylessProbe.every((entry) => entry.authorization === null), `keyless 探测不应携带 authorization 头: ${JSON.stringify(keylessProbe)}`);
  await page.screenshot({ path: path.join(OUT, "01-probe-success.png") });
  step(`探测成功：状态行「${okStatus}」+ datalist 回填 2 型号 + 自动填 qwen3:8b + 服务端零 authorization 头（截图 01）`);

  // ---- 2. 自定义 + apiKey：Bearer 按原样送达 ----
  authLog.length = 0;
  await page.selectOption(".dw-form select >> nth=0", "");
  await page.fill('.dw-form input[type="text"] >> nth=2', baseUrl);
  await page.fill('.dw-form input[type="password"]', "sk-e2e-probe");
  await page.click(".dw-modal-actions >> text=测试连接");
  const okStatus2 = await waitProbeStatus(page, "连接成功");
  assert(okStatus2 !== null, `带 key 探测未成功: ${okStatus2}`);
  const keyedProbe = authLog.filter((entry) => entry.url === "/v1/models");
  assert(keyedProbe.length > 0 && keyedProbe[0].authorization === "Bearer sk-e2e-probe",
    `带 key 探测应携带 Bearer 头（实际: ${JSON.stringify(keyedProbe)}）`);
  step("自定义 + apiKey：服务端确认 authorization: Bearer sk-e2e-probe 按原样送达（表单明文直传，不落盘）");

  // ---- 3. 失败路径：死端口 → 本地化错误 + Ollama 安装引导 ----
  await page.selectOption(".dw-form select >> nth=0", "ollama");
  await page.fill('.dw-form input[type="text"] >> nth=2', "http://127.0.0.1:1/v1");
  await page.click(".dw-modal-actions >> text=测试连接");
  const failStatus = await waitProbeStatus(page, "无法连接");
  assert(failStatus !== null, `死端口探测应显示本地化「无法连接」: ${failStatus}`);
  assert(failStatus !== null && failStatus.includes("ollama.com"), `Ollama 预设不可达应追加安装引导: ${failStatus}`);
  await page.screenshot({ path: path.join(OUT, "02-probe-unreachable-ollama-hint.png") });
  step("失败路径：状态行本地化「无法连接」+ Ollama 专属安装引导（截图 02）");

  fs.writeFileSync(path.join(OUT, "auth-log.json"), JSON.stringify(authLog, null, 2), "utf-8");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i15] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i15-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration17-verification.txt"),
    [
      "迭代 17（AC26 首次运行成功路径 · 连接探测）验证：",
      "1. 设置·模型分区新增「测试连接」按钮：真实 GET {baseUrl}/models（主进程 IPC → llm-providers probeProvider）。",
      "2. Ollama 预设 + 本地端点：探测成功——状态行「连接成功 · 发现 2 个模型」，真实型号回填 datalist，型号输入框自动填首个发现型号 qwen3:8b（零输入完成配置，截图 01）。",
      "3. keyless 链路：服务端 auth-log 确认 GET /v1/models 零 authorization 头。",
      "4. 自定义 + apiKey：服务端确认 authorization: Bearer sk-e2e-probe 按原样送达（表单明文直传不落盘）。",
      "5. 失败路径（死端口）：状态行本地化「无法连接」+ Ollama 预设专属安装引导（ollama.com 下载 + ollama pull，截图 02）。",
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
    console.error(`[verify-i15] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i15-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i15] 全部断言通过，证据已写入 ${OUT}`);
}
