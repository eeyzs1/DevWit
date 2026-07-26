/**
 * 迭代 13 验证脚本（AC22 零成本模型接入，证据落盘 evidence/AC22）：
 * 1. 设置·模型分区：预设下拉（自定义 + Ollama/DeepSeek/OpenRouter，目录自主进程
 *    IPC 下发，渲染端无硬编码域名）；选中 Ollama → type/baseUrl 自动填充 + API Key 行隐藏；
 * 2. 免 key 保存：baseUrl 改指本地端点后不填 key 保存成功（needKey 校验对 keyless 豁免）；
 * 3. 回编辑：baseUrl 与预设不再匹配 → 预设回退「自定义」，keyless 仍按已存配置保留（Key 行继续隐藏）；
 * 4. 真实对话：选中该 provider 发消息 → 本地端点真实 SSE 应答，服务端断言无 authorization 头；
 * 5. RAG 免 key：rag 键指向 keyless provider → 索引直达 ready（DW_RAG_NO_CREDENTIAL 豁免），
 *    /embeddings 请求同样无 authorization 头。
 *
 * LLM/embedding 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答，
 * 产品侧链路 100% 真实（设置 UI、IPC、ProviderRegistry、keyless 通道、RAG 索引）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC22");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i12-"));
fs.writeFileSync(path.join(fixture, "hello.ts"), "export const hello = 'world';\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i12-userdata-"));

// ---------------------------------------------------------------------------
// 本地端点：/chat/completions（SSE）+ /embeddings（定长向量），记录 authorization 头
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text) => [
  sseChunk({ id: "i12", object: "chat.completion.chunk", created: 0, model: "i12", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i12", object: "chat.completion.chunk", created: 0, model: "i12", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i12", object: "chat.completion.chunk", created: 0, model: "i12", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  "data: [DONE]\n\n",
];

const authLog = []; // { url, authorization }
const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end("not found");
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    authLog.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (req.url === "/embeddings") {
      const body = JSON.parse(raw);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        model: body.model ?? "i12-embed",
        data: inputs.map((_text, index) => ({ object: "embedding", index, embedding: [0.1, 0.2, 0.3] })),
      }));
      return;
    }
    if (req.url === "/chat/completions") {
      const frames = framesForText("免 key 链路已通。");
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
});

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i12] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i12] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i12] FAIL: ${message}`);
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

async function waitRagState(page, state, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await page.evaluate(() => window.devwit.rag.getStatus());
    if (status.state === state) return status;
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
  step(`本地端点就绪 ${baseUrl}（/chat/completions + /embeddings，记录 authorization 头）`);

  const cdpPort = 23100 + Math.floor(Math.random() * 500);
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

  // ---- 1. 设置·模型分区：预设下拉与 Ollama 自动填充 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav-item >> text=模型");
  await page.waitForSelector(".dw-form select", { timeout: 5_000 });
  const presetOptions = await page.$$eval(".dw-form select >> nth=0 >> option", (opts) => opts.map((o) => o.textContent ?? ""));
  assert(presetOptions.includes("自定义"), `预设下拉缺「自定义」（实际: ${presetOptions.join("/")}）`);
  assert(presetOptions.includes("Ollama") && presetOptions.includes("DeepSeek") && presetOptions.includes("OpenRouter"),
    `预设下拉缺知名服务（实际: ${presetOptions.join("/")}）`);
  step(`预设下拉就绪：${presetOptions.join(" / ")}（IPC 自 llm-providers 下发）`);

  await page.selectOption(".dw-form select >> nth=0", "ollama");
  const typeAfterPreset = await page.inputValue(".dw-form select >> nth=1");
  const baseUrlAfterPreset = await page.inputValue('.dw-form input[type="text"] >> nth=2');
  const labelAfterPreset = await page.inputValue('.dw-form input[type="text"] >> nth=1');
  assert(typeAfterPreset === "openai", `选中 Ollama 后 type 应为 openai（实际: ${typeAfterPreset}）`);
  assert(baseUrlAfterPreset === "http://localhost:11434/v1", `baseUrl 应自动填充 11434（实际: ${baseUrlAfterPreset}）`);
  assert(labelAfterPreset === "Ollama", `显示名应自动填充 Ollama（实际: ${labelAfterPreset}）`);
  const secretHidden = await page.isHidden('.dw-form input[type="password"]');
  assert(secretHidden === true, "keyless 预设下 API Key 行应隐藏");
  const hintText = await page.textContent(".dw-form .dw-modal-hint");
  assert(hintText?.includes("无需 API Key") === true, `预设说明缺「无需 API Key」: ${hintText}`);
  await page.screenshot({ path: path.join(OUT, "01-preset-ollama-autofill.png") });
  step("选中 Ollama：type/baseUrl/显示名自动填充 + Key 行隐藏 + 免 key 说明（截图 01）");

  // ---- 2. 免 key 保存（baseUrl 改指本地端点）----
  await page.fill('.dw-form input[type="text"] >> nth=2', baseUrl);
  await page.fill('.dw-form input[type="text"] >> nth=3', "i12-model");
  await page.click(".dw-modal-actions >> text=保存");
  await page.waitForSelector('.dw-form-error:has-text("已保存")', { timeout: 10_000 });
  const saved = await page.evaluate(() => window.devwit.providers.list());
  const keylessProvider = saved.find((p) => p.label === "Ollama");
  assert(keylessProvider !== undefined, "免 key 保存后 provider 列表无 Ollama 项");
  assert(keylessProvider?.keyless === true, `已存配置 keyless 应为 true（实际: ${keylessProvider?.keyless}）`);
  assert(keylessProvider?.baseUrl === baseUrl, `已存 baseUrl 应为本地端点（实际: ${keylessProvider?.baseUrl}）`);
  const creds = await page.evaluate(() => window.devwit.credentials.list());
  assert(creds.find((c) => c.ref === keylessProvider?.credentialRef) === undefined, "keyless 不应写入任何凭证");
  step("免 key 保存成功：keyless=true 持久化，凭证存储零写入");

  // ---- 3. 回编辑：baseUrl 不匹配预设 → 回退自定义，keyless 保留 ----
  await page.click(`.dw-modal-list-item:has-text("Ollama")`);
  const presetAfterRefill = await page.inputValue(".dw-form select >> nth=0");
  assert(presetAfterRefill === "", `baseUrl 被改后预设应回退「自定义」（实际: ${presetAfterRefill}）`);
  const secretStillHidden = await page.isHidden('.dw-form input[type="password"]');
  assert(secretStillHidden === true, "回编辑时 keyless 应按已存配置保留（Key 行继续隐藏）");
  await page.screenshot({ path: path.join(OUT, "02-refill-keyless-kept.png") });
  await page.click(".dw-modal >> text=关闭");
  step("回编辑：预设回退自定义 + keyless 保留（截图 02）");

  // ---- 4. 真实对话：无 authorization 头 ----
  await page.selectOption('select[title="模型"]', keylessProvider.id);
  await page.selectOption('select[title="模式"]', "chat");
  await page.fill(".dw-chat .dw-chat-textarea", "ping");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("免 key 链路已通")', { timeout: 30_000 });
  const chatAuth = authLog.filter((entry) => entry.url === "/chat/completions");
  assert(chatAuth.length > 0, "本地端点未收到 /chat/completions 请求");
  assert(chatAuth.every((entry) => entry.authorization === null), `keyless 请求不应携带 authorization 头: ${JSON.stringify(chatAuth)}`);
  await page.screenshot({ path: path.join(OUT, "03-keyless-chat.png") });
  step("真实对话完成：SSE 应答渲染，服务端确认零 authorization 头（截图 03）");

  // ---- 5. RAG 免 key：索引直达 ready ----
  await page.evaluate(async (providerId) => {
    await window.devwit.settings.set("rag", {
      enabled: true, providerId, embedModel: "i12-embed", topK: 5, budgetTokens: 2000,
    });
  }, keylessProvider.id);
  const ready = await waitRagState(page, "ready");
  assert(ready !== null, "keyless provider 下索引未到达 ready（DW_RAG_NO_CREDENTIAL 豁免失败）");
  assert(ready !== null && ready.fileCount === 1, `fileCount 应为 1（实际: ${ready?.fileCount}）`);
  const embedAuth = authLog.filter((entry) => entry.url === "/embeddings");
  assert(embedAuth.length > 0, "本地端点未收到 /embeddings 请求");
  assert(embedAuth.every((entry) => entry.authorization === null), `keyless /embeddings 不应携带 authorization 头: ${JSON.stringify(embedAuth)}`);
  fs.writeFileSync(path.join(OUT, "auth-log.json"), JSON.stringify(authLog, null, 2), "utf-8");
  step(`RAG 免 key 索引就绪（${ready?.fileCount} 文件），/embeddings 同样零 authorization 头（auth-log 落盘）`);
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i12] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i12-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration13-verification.txt"),
    [
      "迭代 13（AC22 零成本模型接入）验证：",
      "1. 设置·模型分区预设下拉（自定义 + Ollama/DeepSeek/OpenRouter）经 IPC 自 llm-providers 下发（渲染端无硬编码域名，AR002）。",
      "2. 选中 Ollama：type=openai/baseUrl=localhost:11434/显示名自动填充，API Key 行隐藏，说明文案「无需 API Key」（截图 01）。",
      "3. baseUrl 改指本地端点后免 key 保存成功：keyless=true 持久化，凭证存储零写入（needKey 校验豁免）。",
      "4. 回编辑：baseUrl 不再匹配预设 → 预设回退「自定义」，keyless 按已存配置保留（Key 行继续隐藏，截图 02）。",
      "5. 真实对话：本地端点 SSE 应答完整渲染；服务端 auth-log 确认 /chat/completions 零 authorization 头（截图 03）。",
      "6. RAG 免 key：rag 指向 keyless provider 直达 ready（DW_RAG_NO_CREDENTIAL 豁免），/embeddings 零 authorization 头（auth-log.json 落盘）。",
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
    console.error(`[verify-i12] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i12-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i12] 全部断言通过，证据已写入 ${OUT}`);
}
