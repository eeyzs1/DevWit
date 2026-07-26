/**
 * 迭代 18 验证脚本（AC27 首次运行向导，证据落盘 evidence/AC27）：
 * 1. 全新 userData 首启 → 向导自动弹出（DEVWIT_E2E_WIZARD=1 显式开启，其余套件默认抑制）；
 * 2. 语言步：切 English 热生效（标题/按钮变英文）→ 切回中文；
 * 3. 模型步：默认选中 Ollama 预设（目录首项）→ baseUrl 自动填充 11434 + Key 行隐藏；
 *    改指本地端点 →「测试连接」成功 → 状态行型号数 + datalist 回填 + 自动填首个型号；
 *    服务端确认 GET /v1/models 零 authorization 头（keyless 不触碰凭证）；
 * 4. 「保存并继续」→ 完成步：providers 持久化 keyless=true、零凭证写入；
 * 5. 完成步「打开文件夹」→ 工作区进入、文件树出现、向导关闭；
 * 6. 真实对话：选中该 provider 发消息 → SSE 应答渲染，服务端零 authorization 头；
 * 7. 同 userData 重启 → 向导不再出现（onboarding.state.completed 已持久化）。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答，
 * 产品侧链路 100% 真实（向导 UI、IPC、预设目录、探测、保存、对话、持久化）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC27");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i16-"));
fs.writeFileSync(path.join(fixture, "hello.ts"), "export const hello = 'world';\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i16-userdata-"));

// ---------------------------------------------------------------------------
// 本地端点：GET /v1/models（型号发现）+ POST /chat/completions（SSE），记录 authorization 头
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text) => [
  sseChunk({ id: "i16", object: "chat.completion.chunk", created: 0, model: "i16", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i16", object: "chat.completion.chunk", created: 0, model: "i16", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i16", object: "chat.completion.chunk", created: 0, model: "i16", choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } }),
  "data: [DONE]\n\n",
];

const authLog = []; // { method, url, authorization }
const server = createServer((req, res) => {
  authLog.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3:8b" }, { id: "llama3.1:8b" }] }));
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const frames = framesForText("向导配置链路已通。");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let i = 0;
    const push = () => {
      if (i >= frames.length) { res.end(); return; }
      res.write(frames[i]);
      i += 1;
      setTimeout(push, 20);
    };
    push();
    return;
  }
  res.writeHead(404).end("not found");
});

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i16] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i16] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i16] FAIL: ${message}`);
  }
}

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWIT_E2E_OPEN_DIR: fixture,
        DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1",
        DEVWIT_E2E_WIZARD: "1", // AC27：向导自身测试显式开启（其余套件默认抑制）
      },
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

async function stopElectron(proc) {
  if (proc && !proc.killed) {
    proc.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（/models + /chat/completions，记录 authorization 头）`);

  const cdpPort = 23600 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });

  // ---- 1. 首启向导自动弹出 ----
  await page.waitForSelector(".dw-wizard", { timeout: 30_000 });
  const title = await page.textContent(".dw-wizard h2");
  assert(title === "首次运行向导", `首启应弹出中文向导（实际标题: ${title}）`);
  const progressText = await page.textContent(".dw-wizard-progress");
  assert(progressText?.includes("语言") === true && progressText?.includes("模型") === true && progressText?.includes("完成") === true,
    `进度指示应含 语言/模型/完成 三步（实际: ${progressText}）`);
  step("首启向导自动弹出：标题 + 三步进度指示就绪");

  // ---- 2. 语言步：English 热生效 → 切回中文 ----
  await page.selectOption(".dw-wizard select", "en-US");
  await page.waitForFunction(() => document.querySelector(".dw-wizard h2")?.textContent === "First-Run Wizard", null, { timeout: 5_000 });
  const nextBtnEn = await page.textContent(".dw-wizard .dw-modal-actions .dw-btn-primary");
  assert(nextBtnEn?.trim() === "Next", `切英文后主按钮应为 Next（实际: ${nextBtnEn}）`);
  await page.screenshot({ path: path.join(OUT, "01-wizard-lang-en.png") });
  await page.selectOption(".dw-wizard select", "zh-CN");
  await page.waitForFunction(() => document.querySelector(".dw-wizard h2")?.textContent === "首次运行向导", null, { timeout: 5_000 });
  const persistedLocale = await page.evaluate(() => window.devwit.settings.get("ui.locale"));
  assert(persistedLocale === "zh-CN", `语言选择应持久化 ui.locale=zh-CN（实际: ${persistedLocale}）`);
  step("语言步：English 热生效（截图 01）→ 切回中文并持久化");

  // ---- 3. 模型步：默认 Ollama → 改指本地端点 → 探测成功 ----
  await page.click(".dw-wizard >> text=下一步");
  // 预设目录 IPC 异步下发：等待下拉出现选项
  await page.waitForFunction(() => {
    const select = document.querySelector(".dw-wizard .dw-form select");
    return select !== null && select.options.length >= 3;
  }, null, { timeout: 10_000 });
  const presetValue = await page.inputValue(".dw-wizard .dw-form select");
  assert(presetValue === "ollama", `模型步应默认选中首项预设 Ollama（实际: ${presetValue}）`);
  const baseUrlAuto = await page.inputValue('.dw-wizard input[type="text"] >> nth=0');
  assert(baseUrlAuto === "http://localhost:11434/v1", `Ollama baseUrl 应自动填充（实际: ${baseUrlAuto}）`);
  const secretHidden = await page.isHidden('.dw-wizard input[type="password"]');
  assert(secretHidden === true, "keyless 预设下 API Key 行应隐藏");

  await page.fill('.dw-wizard input[type="text"] >> nth=0', baseUrl);
  // 限定 .dw-modal-actions：模型步说明文案中含「测试连接」字样，裸 text= 会误中说明段
  await page.click(".dw-wizard .dw-modal-actions >> text=测试连接");
  await page.waitForFunction(() => {
    const status = document.querySelector(".dw-wizard .dw-form .dw-modal-hint:last-of-type");
    return status !== null && (status.textContent ?? "").includes("连接成功");
  }, null, { timeout: 10_000 });
  const probeText = await page.textContent(".dw-wizard .dw-form .dw-modal-hint:last-of-type");
  assert(probeText?.includes("发现 2 个模型") === true, `探测成功应显示型号数（实际: ${probeText}）`);
  const modelAuto = await page.inputValue('.dw-wizard input[type="text"] >> nth=1');
  assert(modelAuto === "qwen3:8b", `型号应自动填首个发现型号 qwen3:8b（实际: ${modelAuto}）`);
  const datalistCount = await page.$$eval("#dw-wizard-model-suggestions option", (opts) => opts.length);
  assert(datalistCount === 2, `datalist 应回填 2 个真实型号（实际: ${datalistCount}）`);
  const probeAuth = authLog.filter((entry) => entry.url === "/v1/models");
  assert(probeAuth.length > 0 && probeAuth.every((entry) => entry.authorization === null),
    `keyless 探测不应携带 authorization 头: ${JSON.stringify(probeAuth)}`);
  await page.screenshot({ path: path.join(OUT, "02-wizard-probe-ok.png") });
  step("模型步：默认 Ollama + 改指本地端点 + 探测成功自动填型号（截图 02），零 authorization 头");

  // ---- 4. 保存并继续 → 完成步 ----
  await page.click(".dw-wizard >> text=保存并继续");
  await page.waitForFunction(() => {
    const steps = [...document.querySelectorAll(".dw-wizard-step")];
    return steps.length === 3 && (steps[2].className ?? "").includes("dw-wizard-step-active");
  }, null, { timeout: 5_000 });
  const saved = await page.evaluate(() => window.devwit.providers.list());
  assert(saved.length === 1, `保存后应有 1 个 provider（实际: ${saved.length}）`);
  assert(saved[0]?.keyless === true && saved[0]?.baseUrl === baseUrl && saved[0]?.model === "qwen3:8b",
    `provider 持久化应为 keyless + 本地端点 + qwen3:8b（实际: ${JSON.stringify(saved[0])}）`);
  const creds = await page.evaluate(() => window.devwit.credentials.list());
  assert(creds.length === 0, "keyless 保存不应写入任何凭证");
  await page.screenshot({ path: path.join(OUT, "03-wizard-done.png") });
  step("保存并继续 → 完成步：keyless provider 持久化，凭证存储零写入（截图 03）");

  // ---- 5. 完成步「打开文件夹」→ 工作区进入 ----
  await page.click(".dw-wizard >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  const wizardGone = (await page.$(".dw-wizard")) === null;
  assert(wizardGone, "打开文件夹后向导应关闭");
  await page.screenshot({ path: path.join(OUT, "04-workspace-entered.png") });
  step("完成步「打开文件夹」→ 文件树就绪，向导关闭（截图 04）");

  // ---- 6. 真实对话：SSE 应答 + 零 authorization 头 ----
  await page.selectOption('select[title="模型"]', saved[0].id);
  await page.selectOption('select[title="模式"]', "chat");
  await page.fill(".dw-chat .dw-chat-textarea", "ping");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("向导配置链路已通")', { timeout: 30_000 });
  const chatAuth = authLog.filter((entry) => entry.url === "/v1/chat/completions");
  assert(chatAuth.length > 0 && chatAuth.every((entry) => entry.authorization === null),
    `向导配置的 provider 对话不应携带 authorization 头: ${JSON.stringify(chatAuth)}`);
  await page.screenshot({ path: path.join(OUT, "05-first-chat.png") });
  step("真实对话完成：向导配置即刻可用（截图 05），服务端确认零 authorization 头");

  // ---- 7. 同 userData 重启：向导不再出现 ----
  const onboardState = await page.evaluate(() => window.devwit.settings.get("onboarding.state"));
  assert(onboardState?.completed === true, `onboarding.state.completed 应为 true（实际: ${JSON.stringify(onboardState)}）`);
  await browser.close().catch(() => {});
  browser = null;
  await stopElectron(electronProc);
  electronProc = null;

  const cdpPort2 = 23900 + Math.floor(Math.random() * 300);
  const relaunch = await launchElectron(cdpPort2);
  electronProc = relaunch.proc;
  browser = await chromium.connectOverCDP(relaunch.ws);
  const context2 = browser.contexts()[0];
  let page2 = context2.pages().find((p) => p.url().includes("index.html"));
  if (!page2) page2 = await context2.waitForEvent("page", { timeout: 15_000 });
  await page2.waitForSelector(".dw-header", { timeout: 30_000 });
  // 向导若在重启后出现，3 秒内必然渲染；持续缺席才算通过
  await page2.waitForTimeout(3_000);
  const wizardOnRelaunch = (await page2.$(".dw-wizard")) !== null;
  assert(wizardOnRelaunch === false, "同 userData 重启后向导不应再出现");
  await page2.screenshot({ path: path.join(OUT, "06-relaunch-no-wizard.png") });
  step("同 userData 重启：向导缺席（completed 持久化生效，截图 06）");

  fs.writeFileSync(path.join(OUT, "auth-log.json"), JSON.stringify(authLog, null, 2), "utf-8");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i16] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i16-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration18-verification.txt"),
    [
      "迭代 18（AC27 首次运行向导）验证：",
      "1. 全新 userData 首启向导自动弹出：标题 + 语言/模型/完成三步进度指示（DEVWIT_E2E_WIZARD=1 开启，其余套件默认抑制）。",
      "2. 语言步：切 English 热生效（标题 First-Run Wizard / 按钮 Next，截图 01）→ 切回中文并持久化 ui.locale。",
      "3. 模型步：默认选中首项预设 Ollama，baseUrl 自动填充 11434、API Key 行隐藏；改指本地端点后「测试连接」成功——状态行型号数、datalist 回填 2 型号、自动填 qwen3:8b（截图 02）；服务端确认 keyless 探测零 authorization 头。",
      "4. 保存并继续 → 完成步：provider 持久化 keyless=true + 本地端点 + qwen3:8b，凭证存储零写入（截图 03）。",
      "5. 完成步「打开文件夹」→ 文件树就绪、向导关闭（截图 04）。",
      "6. 真实对话：向导配置的 provider 即刻可用，SSE 应答渲染，服务端确认零 authorization 头（截图 05）。",
      "7. 同 userData 重启：向导缺席（onboarding.state.completed 持久化，截图 06）；auth-log.json 落盘。",
      `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
    ].join("\n"),
    "utf-8"
  );
  if (browser !== null) await browser.close().catch(() => {});
  await stopElectron(electronProc);
  server.close();
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (report.failures.length > 0) {
    console.error(`[verify-i16] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i16-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i16] 全部断言通过，证据已写入 ${OUT}`);
}
