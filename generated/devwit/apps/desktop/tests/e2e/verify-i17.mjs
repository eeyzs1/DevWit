/**
 * 迭代 19 验证脚本（AC28 @文件引用 + /斜杠命令，证据落盘 evidence/AC28）：
 * 1. fixture 工作区（src/hello.ts 含 MAGIC_TOKEN / src/util.ts / docs/guide.md）打开；
 * 2. @文件引用：输入 @ → 文件候选下拉出现 → 键入 hel 过滤 → Enter 选中成 chip；
 *    第二文件经鼠标点击成 chip；chip × 按钮可剔除；重新引用后发送；
 * 3. 服务端捕获 /chat/completions 请求体：两附件内容以「## 引用文件 <路径>」段注入，
 *    用户消息原文无 @查询残留（chip 化保持文本干净）；
 * 4. 落盘 manifest 审计：attachment:<路径> 稳定 key 独立项、enabled、token 精确计数；
 * 5. /斜杠命令：/age → 模式候选过滤出智能体 → Enter 速切（模式下拉值变 agent、输入清空）；
 *    / → 全量模式列表 → 点击「对话」切回；
 * 6. placeholder 词典接线验证（@ / 提示在文案中）。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（候选下拉、chips、IPC、上下文引擎、manifest 落盘）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC28");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i17-"));
fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
fs.mkdirSync(path.join(fixture, "docs"), { recursive: true });
fs.writeFileSync(path.join(fixture, "src", "hello.ts"), 'export const MAGIC_TOKEN = "at-file-injected-alpha";\n', "utf-8");
fs.writeFileSync(path.join(fixture, "src", "util.ts"), 'export const UTIL_MARK = "beta-util-content";\n', "utf-8");
fs.writeFileSync(path.join(fixture, "docs", "guide.md"), "# Guide\n\nwork-in-progress\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i17-userdata-"));

// ---------------------------------------------------------------------------
// 本地端点：POST /chat/completions（SSE），捕获请求体用于附件注入断言
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text) => [
  sseChunk({ id: "i17", object: "chat.completion.chunk", created: 0, model: "i17", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i17", object: "chat.completion.chunk", created: 0, model: "i17", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i17", object: "chat.completion.chunk", created: 0, model: "i17", choices: [], usage: { prompt_tokens: 16, completion_tokens: 4 } }),
  "data: [DONE]\n\n",
];

const chatBodies = []; // POST /chat/completions 请求体（JSON）
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      try { chatBodies.push(JSON.parse(raw)); } catch { chatBodies.push({ __raw: raw }); }
      const frames = framesForText("附件已收到。");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let i = 0;
      const push = () => {
        if (i >= frames.length) { res.end(); return; }
        res.write(frames[i]);
        i += 1;
        setTimeout(push, 20);
      };
      push();
    });
    return;
  }
  res.writeHead(404).end("not found");
});

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i17] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i17] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i17] FAIL: ${message}`);
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

const chipPaths = (page) => page.$$eval(".dw-atchip", (chips) => chips.map((chip) => chip.dataset.path));

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（/chat/completions，捕获请求体）`);

  const cdpPort = 24200 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开（src/hello.ts / src/util.ts / docs/guide.md）");

  // placeholder 词典接线（AC28 新文案）
  const placeholder = await page.getAttribute(".dw-chat .dw-chat-textarea", "placeholder");
  assert(placeholder?.includes("@ 引用文件") === true && placeholder?.includes("/ 切换模式") === true,
    `placeholder 应含 @ / 提示（实际: ${placeholder}）`);

  // 注入 keyless provider（settings onChanged 热刷新到工具栏下拉）
  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({
      id: "p-i17", type: "openai", label: "i17-local", baseUrl: url, model: "i17-model",
      credentialRef: "cred-i17", maxTokens: 1024, keyless: true,
    });
  }, baseUrl);
  await page.waitForFunction(() => {
    const select = document.querySelector('select[title="模型"]');
    return select !== null && [...select.options].some((option) => option.value === "p-i17");
  }, null, { timeout: 10_000 });
  await page.selectOption('select[title="模型"]', "p-i17");
  await page.selectOption('select[title="模式"]', "chat");
  step("keyless provider 注入并选中（settings onChanged 热刷新链路）");

  // ---- 1. @文件引用：候选下拉 → 过滤 → Enter 选中成 chip ----
  await page.click(".dw-chat .dw-chat-textarea");
  await page.type(".dw-chat .dw-chat-textarea", "@");
  await page.waitForSelector('.dw-suggest[data-kind="file"]', { state: "visible", timeout: 5_000 });
  const initialCandidates = await page.$$eval(".dw-suggest-item", (items) => items.map((item) => item.dataset.value));
  assert(initialCandidates.includes("src/hello.ts") && initialCandidates.includes("docs/guide.md"),
    `@ 空查询应列出工作区文件（实际: ${initialCandidates.join("/")}）`);
  await page.type(".dw-chat .dw-chat-textarea", "hel");
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll(".dw-suggest-item")];
    return items.length === 1 && items[0]?.dataset.value === "src/hello.ts";
  }, null, { timeout: 5_000 });
  await page.screenshot({ path: path.join(OUT, "01-at-suggest-filtered.png") });
  await page.press(".dw-chat .dw-chat-textarea", "Enter");
  await page.waitForSelector('.dw-atchip[data-path="src/hello.ts"]', { timeout: 5_000 });
  const afterFirst = await page.inputValue(".dw-chat .dw-chat-textarea");
  assert(afterFirst === "", `选中后 @查询 原文应清空（实际: "${afterFirst}"）`);
  const suggestGone = await page.isHidden(".dw-suggest");
  assert(suggestGone === true, "选中后候选下拉应关闭");
  step("@文件引用：下拉 → hel 过滤唯一命中（截图 01）→ Enter 成 chip 且输入框清空");

  // ---- 2. 第二文件鼠标点击成 chip；× 剔除；重新引用 ----
  await page.type(".dw-chat .dw-chat-textarea", "@uti");
  await page.waitForSelector('.dw-suggest-item[data-value="src/util.ts"]', { state: "visible", timeout: 5_000 });
  await page.click('.dw-suggest-item[data-value="src/util.ts"]');
  await page.waitForSelector('.dw-atchip[data-path="src/util.ts"]', { timeout: 5_000 });
  let chips = await chipPaths(page);
  assert(chips.length === 2 && chips.includes("src/hello.ts") && chips.includes("src/util.ts"),
    `两 chip 就位（实际: ${chips.join("/")}）`);
  await page.click('.dw-atchip[data-path="src/hello.ts"] .dw-atchip-x');
  chips = await chipPaths(page);
  assert(chips.length === 1 && chips[0] === "src/util.ts", `× 剔除后应剩 src/util.ts（实际: ${chips.join("/")}）`);
  // 重复引用去重：再次引用 util.ts 不产生第二个 chip
  await page.type(".dw-chat .dw-chat-textarea", "@uti");
  await page.waitForSelector('.dw-suggest-item[data-value="src/util.ts"]', { state: "visible", timeout: 5_000 });
  await page.press(".dw-chat .dw-chat-textarea", "Enter");
  chips = await chipPaths(page);
  assert(chips.length === 1, `重复引用应去重（实际 chips: ${chips.join("/")}）`);
  // 重新引用 hello.ts
  await page.type(".dw-chat .dw-chat-textarea", "@hel");
  await page.waitForSelector('.dw-suggest-item[data-value="src/hello.ts"]', { state: "visible", timeout: 5_000 });
  await page.press(".dw-chat .dw-chat-textarea", "Enter");
  chips = await chipPaths(page);
  assert(chips.length === 2, `重新引用后两 chip（实际: ${chips.join("/")}）`);
  await page.screenshot({ path: path.join(OUT, "02-attachips.png") });
  step("chips 交互闭环：点击选中 / × 剔除 / 去重 / 重引用（截图 02）");

  // ---- 3. 发送：服务端验证附件注入 + 用户原文干净 ----
  await page.type(".dw-chat .dw-chat-textarea", "总结这两个文件");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("附件已收到")', { timeout: 30_000 });
  assert(chatBodies.length === 1, `服务端应收到 1 次 /chat/completions（实际: ${chatBodies.length}）`);
  const body = chatBodies[0] ?? {};
  const contents = (body.messages ?? []).map((message) => message.content ?? "");
  const contextMessage = contents.find((content) => content.includes("## 引用文件 src/hello.ts"));
  assert(contextMessage !== undefined, "请求体缺「## 引用文件 src/hello.ts」注入段");
  assert(contextMessage?.includes("at-file-injected-alpha") === true, "hello.ts 附件内容未注入（MAGIC_TOKEN 缺席）");
  assert(contextMessage?.includes("## 引用文件 src/util.ts") === true && contextMessage?.includes("beta-util-content") === true,
    "util.ts 附件内容未注入");
  const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  assert(lastUser?.content === "总结这两个文件", `用户原文应无 @残留（实际: "${lastUser?.content}"）`);
  const chipsAfterSend = await chipPaths(page);
  assert(chipsAfterSend.length === 0, "发送后 chips 应清空");
  step("发送完成：两附件全文注入（MAGIC_TOKEN/beta 服务端可见），用户原文干净，chips 清空");

  // ---- 4. manifest 落盘审计 ----
  const manifestsDir = path.join(userDataDir, "manifests");
  const manifestFiles = fs.readdirSync(manifestsDir).filter((name) => name.endsWith(".json"));
  assert(manifestFiles.length >= 1, "manifests 目录应有落盘文件");
  const latest = JSON.parse(
    fs.readFileSync(path.join(manifestsDir, manifestFiles.sort().at(-1)), "utf-8")
  );
  const helloItem = latest.items.find((item) => item.key === "attachment:src/hello.ts");
  const utilItem = latest.items.find((item) => item.key === "attachment:src/util.ts");
  assert(helloItem !== undefined && helloItem.type === "file_fragment" && helloItem.enabled === true,
    `manifest 缺 enabled 的 attachment:src/hello.ts 项（实际: ${JSON.stringify(helloItem)}）`);
  assert(utilItem !== undefined && utilItem.enabled === true, "manifest 缺 attachment:src/util.ts 项");
  assert(typeof helloItem?.tokens === "number" && helloItem.tokens > 0, `附件项应有精确 token 计数（实际: ${helloItem?.tokens}）`);
  fs.writeFileSync(path.join(OUT, "manifest-latest.json"), JSON.stringify(latest, null, 2), "utf-8");
  step(`manifest 审计通过：attachment:* 独立 key 项 enabled + token 计数（已落盘 manifest-latest.json）`);

  // ---- 5. /斜杠命令：过滤速切 agent → 列表点选切回 chat ----
  await page.fill(".dw-chat .dw-chat-textarea", "/age");
  await page.waitForSelector('.dw-suggest[data-kind="mode"]', { state: "visible", timeout: 5_000 });
  const modeCandidates = await page.$$eval(".dw-suggest-item", (items) => items.map((item) => item.dataset.value));
  assert(modeCandidates.length === 1 && modeCandidates[0] === "agent",
    `/age 应过滤出 agent 模式（实际: ${modeCandidates.join("/")}）`);
  await page.press(".dw-chat .dw-chat-textarea", "Enter");
  const modeAfterSlash = await page.inputValue('select[title="模式"]');
  assert(modeAfterSlash === "agent", `斜杠速切后模式下拉应为 agent（实际: ${modeAfterSlash}）`);
  const inputAfterSlash = await page.inputValue(".dw-chat .dw-chat-textarea");
  assert(inputAfterSlash === "", `速切后命令原文应清空（实际: "${inputAfterSlash}"）`);
  await page.screenshot({ path: path.join(OUT, "03-slash-switched-agent.png") });
  await page.fill(".dw-chat .dw-chat-textarea", "/");
  await page.waitForSelector('.dw-suggest[data-kind="mode"]', { state: "visible", timeout: 5_000 });
  await page.click('.dw-suggest-item[data-value="chat"]');
  const modeBack = await page.inputValue('select[title="模式"]');
  assert(modeBack === "chat", `点选切回后模式下拉应为 chat（实际: ${modeBack}）`);
  step("/斜杠命令：/age 过滤 → Enter 速切 agent（截图 03）→ / 全量列表点选切回 chat");

  // ---- 6. 速切后真实对话仍可用（agent 模式下行链路无损）----
  await page.fill(".dw-chat .dw-chat-textarea", "ping");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("附件已收到") >> nth=1', { timeout: 30_000 });
  assert(chatBodies.length === 2, `切换模式后应完成第二轮对话（实际请求数: ${chatBodies.length}）`);
  await page.screenshot({ path: path.join(OUT, "04-after-slash-chat.png") });
  step("速切模式后对话链路正常（截图 04）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i17] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i17-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration19-verification.txt"),
    [
      "迭代 19（AC28 @文件引用 + /斜杠命令）验证：",
      "1. placeholder 词典接线：@ 引用文件 / / 切换模式 提示在文案中。",
      "2. @文件引用：@ 触发文件候选下拉 → hel 过滤唯一命中（截图 01）→ Enter 成 chip 且输入框清空；",
      "   第二文件鼠标点击成 chip；× 剔除；重复引用去重；重引用回两 chip（截图 02）。",
      "3. 发送：服务端捕获请求体——「## 引用文件 src/hello.ts / src/util.ts」两段全文注入",
      "   （MAGIC_TOKEN / beta-util-content 可见），用户原文无 @残留，发送后 chips 清空。",
      "4. manifest 落盘审计：attachment:<路径> 稳定 key 独立项、enabled、token 精确计数（manifest-latest.json）。",
      "5. /斜杠命令：/age 过滤出 agent → Enter 速切（模式下拉变 agent、输入清空，截图 03）→",
      "   / 全量模式列表点选切回 chat；速切后第二轮真实对话正常（截图 04）。",
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
    console.error(`[verify-i17] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i17-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i17] 全部 ${report.assertions.length} 项断言通过，证据在 ${OUT}`);
}
