/**
 * 迭代 10 验证脚本（AC19 透明 RAG，证据落盘 evidence/AC19）：
 * 1. 启用代码索引：settings "rag" 键热更新 → 真实 /v1/embeddings 请求（本地端点
 *    关键词向量假嵌入，语义可断言）→ rag.getStatus() 到 ready（fileCount/chunkCount 正确）；
 * 2. 设置页通用分区：状态行「已就绪：N 个文件 / M 个代码块」+ 截图；
 * 3. 检索入上下文：发送 "login" 意图 → 当次 manifest 含 codebase_match 项
 *    （稳定 key、score、路径行区间），login.ts 命中且 button.ts 不命中（向量语义真实）；
 * 4. 逐项剔除：context.setItemOverride(chunkId, false) → 下一次 manifest 中该块
 *    enabled=false/tokens=0（透明可裁剪），恢复后重新注入；
 * 5. 关闭开关 → 状态 disabled（热生效，无需重启）。
 *
 * LLM/embedding 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答，
 * 产品侧链路 100% 真实（settings 热更新、CodebaseIndex、余弦检索、context-engine、IPC）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC19");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// fixture 工作区：两个代码文件（login 相关 / 无关），关键词语义供假嵌入区分
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i10-"));
fs.writeFileSync(
  path.join(fixture, "login.ts"),
  [
    "export function login(user, token) {",
    "  // auth user with token against the session store",
    "  return checkSession(user, token);",
    "}",
    "",
  ].join("\n"),
  "utf-8"
);
fs.writeFileSync(
  path.join(fixture, "button.ts"),
  ["export function renderButton() {", "  // render a button widget on the panel", "  return domNode;", "}", ""].join("\n"),
  "utf-8"
);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i10-userdata-"));

// ---------------------------------------------------------------------------
// 本地端点：/chat/completions（SSE 真实线协议）+ /embeddings（关键词向量假嵌入）
// ---------------------------------------------------------------------------

const VOCAB = ["login", "auth", "user", "token", "session", "render", "button", "panel"];
const fakeVector = (text) => VOCAB.map((word) => (text.toLowerCase().includes(word) ? 1 : 0));

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text) => [
  sseChunk({ id: "i10", object: "chat.completion.chunk", created: 0, model: "i10", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i10", object: "chat.completion.chunk", created: 0, model: "i10", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i10", object: "chat.completion.chunk", created: 0, model: "i10", choices: [], usage: { prompt_tokens: 60, completion_tokens: 12 } }),
  "data: [DONE]\n\n",
];

let embedCalls = 0;
const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end("not found");
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    if (req.url === "/embeddings") {
      embedCalls += 1;
      const body = JSON.parse(raw);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        model: body.model ?? "i10-embed",
        data: inputs.map((text, index) => ({ object: "embedding", index, embedding: fakeVector(String(text)) })),
      }));
      return;
    }
    if (req.url === "/chat/completions") {
      const frames = framesForText("收到，已参考代码库上下文。");
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i10] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i10] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i10] FAIL: ${message}`);
  }
}

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userDataDir },
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
  step(`本地端点就绪 ${baseUrl}（/chat/completions + /embeddings）`);

  const cdpPort = 22600 + Math.floor(Math.random() * 500);
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
  step("打开文件夹（fixture 工作区 login.ts + button.ts）");

  // ---- 1. 启用代码索引（settings 热更新 → 真实 /embeddings 请求 → ready）----
  const statusBefore = await page.evaluate(() => window.devwit.rag.getStatus());
  assert(statusBefore.state === "disabled", `初始状态应为 disabled（实际: ${statusBefore.state}）`);

  await page.evaluate(async (url) => {
    await window.devwit.credentials.set("i10-cred", "openai", "sk-i10-fake");
    await window.devwit.providers.upsert({
      id: "i10-local", type: "openai", label: "I10 Local", baseUrl: url,
      model: "i10-model", credentialRef: "i10-cred", maxTokens: 2048,
    });
    await window.devwit.settings.set("rag", {
      enabled: true, providerId: "i10-local", embedModel: "i10-embed", topK: 5, budgetTokens: 2000,
    });
  }, baseUrl);
  step("provider 注册 + settings rag 键启用（热更新触发构建）");

  const ready = await waitRagState(page, "ready");
  assert(ready !== null, "索引未到达 ready（/embeddings 链路失败）");
  assert(ready !== null && ready.fileCount === 2, `fileCount 应为 2（实际: ${ready?.fileCount}）`);
  assert(ready !== null && ready.chunkCount >= 2, `chunkCount 应 ≥2（实际: ${ready?.chunkCount}）`);
  assert(embedCalls > 0, "未发生真实 /embeddings 请求");
  step(`索引就绪：${ready?.fileCount} 文件 / ${ready?.chunkCount} 块（/embeddings 调用 ${embedCalls} 次）`);

  // ---- 2. 设置页通用分区：状态行 + 截图 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  const generalText = await page.textContent(".dw-settings-content");
  assert(generalText?.includes("已就绪") === true, `设置页状态行缺「已就绪」: ${generalText?.slice(0, 200)}`);
  assert(generalText?.includes("代码索引") === true, "设置页缺「代码索引」区块");
  await page.screenshot({ path: path.join(OUT, "01-settings-rag-ready.png") });
  await page.click(".dw-modal >> text=关闭");
  step("设置页通用分区展示「已就绪：2 个文件 / N 个代码块」（截图 01）");

  // ---- 3. 检索入上下文：login 意图 → manifest 含 codebase_match 命中 ----
  await page.selectOption('select[title="模型"]', "i10-local");
  await page.selectOption('select[title="模式"]', "chat");
  await page.fill(".dw-chat .dw-chat-textarea", "login token 登录逻辑在哪");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("收到")', { timeout: 30_000 });
  step("chat #1 完成（login 意图）");

  const manifest1 = await page.evaluate(() => window.devwit.context.latestManifest());
  const ragItems1 = (manifest1?.items ?? []).filter((item) => item.type === "codebase_match" && item.key !== undefined);
  assert(ragItems1.length > 0, "manifest 无带 key 的 codebase_match 命中项");
  const loginHit = ragItems1.find((item) => item.source === "login.ts");
  assert(loginHit !== undefined, `login.ts 未命中（实际命中: ${ragItems1.map((i) => i.source).join(",")}）`);
  assert(loginHit !== undefined && typeof loginHit.score === "number" && loginHit.score > 0, "命中项缺正相似度 score");
  assert(loginHit !== undefined && loginHit.label.includes("login.ts") && /L\d+-\d+/.test(loginHit.label), `命中项 label 缺路径行区间: ${loginHit?.label}`);
  assert(loginHit !== undefined && loginHit.enabled === true && loginHit.tokens > 0, "命中项未注入（enabled/tokens 异常）");
  assert(loginHit !== undefined && loginHit.content.includes("login"), "命中项 content 缺 login 代码");
  const buttonHit = ragItems1.find((item) => item.source === "button.ts");
  assert(buttonHit === undefined || buttonHit.score < loginHit.score, "button.ts 不应排在 login.ts 前（向量语义失真）");
  fs.writeFileSync(path.join(OUT, "manifest-chat1.json"), JSON.stringify(manifest1, null, 2), "utf-8");
  step("manifest 落盘：codebase_match 命中 login.ts（key/score/行区间/token 全可见）");

  // 上下文面板逐项可见（UI 证据）
  await page.click('.dw-tab:has-text("上下文")');
  await page.waitForSelector(".dw-context-item", { timeout: 10_000 });
  const panelText = await page.textContent(".dw-context-panel, .dw-tab-content, body");
  assert(panelText?.includes("login.ts") === true, "上下文面板未展示 login.ts 命中行");
  await page.screenshot({ path: path.join(OUT, "02-context-panel-rag.png") });
  step("上下文面板展示命中块（逐项 + score + token 占用，截图 02）");

  // ---- 4. 逐项剔除：setItemOverride(chunkId, false) → 下次 manifest 零注入 ----
  const chunkKey = loginHit.key;
  await page.evaluate((key) => window.devwit.context.setItemOverride(key, false), chunkKey);
  await page.click('.dw-tab:has-text("对话")');
  await page.fill(".dw-chat .dw-chat-textarea", "login token 登录逻辑在哪（再问一次）");
  await page.click(".dw-chat >> text=发送");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".dw-msg-assistant").length >= count,
    2,
    { timeout: 30_000 }
  );
  const manifest2 = await page.evaluate(() => window.devwit.context.latestManifest());
  const excluded = (manifest2?.items ?? []).find((item) => item.key === chunkKey);
  assert(excluded !== undefined, "第二次 manifest 中找不到被剔除的块");
  assert(excluded !== undefined && excluded.enabled === false && excluded.tokens === 0 && excluded.content === "", "剔除项未零注入（enabled/tokens/content 异常）");
  fs.writeFileSync(path.join(OUT, "manifest-chat2-excluded.json"), JSON.stringify(manifest2, null, 2), "utf-8");
  step("逐项剔除生效：该块 enabled=false / tokens=0 / content 空（manifest-chat2 落盘）");

  // 恢复
  await page.evaluate((key) => window.devwit.context.setItemOverride(key, true), chunkKey);
  step("逐项恢复：setItemOverride(key, true)");

  // ---- 5. 关闭开关 → disabled（热生效）----
  await page.evaluate(async () => {
    const stored = await window.devwit.settings.get("rag");
    await window.devwit.settings.set("rag", { ...stored, enabled: false });
  });
  const disabled = await waitRagState(page, "disabled", 10_000);
  assert(disabled !== null, "关闭开关后状态未归 disabled（热生效失败）");
  step("关闭代码索引开关 → 状态 disabled（无需重启）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i10] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i10-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration10-verification.txt"),
    [
      "迭代 10（AC19 透明 RAG）验证：",
      "1. settings rag 键启用（热更新）→ CodebaseIndex 全量构建：walkIndexableFiles 枚举 → chunkSource 分块 → 真实 POST /embeddings（本地端点关键词向量）→ JSONL 原子落盘；rag.getStatus() 到 ready（2 文件 / ≥2 块）。",
      "2. 设置页通用分区状态行「已就绪：2 个文件 / N 个代码块」（截图 01）。",
      "3. 发送 login 意图 → agent-loop 以 query=userText 调 context-engine → codebaseMatchSource 余弦全扫描 → manifest 含 codebase_match 命中项（稳定 key=chunkId、score、路径行区间、token 计数），login.ts 命中且排序优于 button.ts（manifest-chat1.json 落盘，截图 02 上下文面板）。",
      "4. context.setItemOverride(chunkId, false) → 下一次 manifest 该块 enabled=false/tokens=0/content 空（逐项可裁剪，manifest-chat2-excluded.json 落盘）；setItemOverride(key, true) 恢复。",
      "5. 关闭 rag.enabled → refreshRag 热 teardown → 状态 disabled（无需重启）。",
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
    console.error(`[verify-i10] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i10-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i10] 全部断言通过，证据已写入 ${OUT}`);
}
