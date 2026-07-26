/**
 * 迭代 29 验证脚本（AC38 代码智能 II：符号级索引 + @符号 引用，证据落盘 evidence/AC38）：
 * 1. fixture 工作区（src/calc.ts 含 add 函数与 MAGIC_SYMBOL_TOKEN / src/user.ts 含 UserService 类与
 *    getName 方法 / docs/readme.md 非代码文件）打开；符号索引（纯启发式、无 provider 依赖）就绪；
 * 2. @符号 引用：输入 @ → 文件区+符号区双分区下拉（分区标题「文件」「符号」）→ 键入 add 过滤 →
 *    Enter 选中成符号 chip（kind 徽标「函数」）；UserService 经鼠标点击成 chip；
 *    chip × 按钮可剔除；重复引用按 id 去重；重新引用后发送；
 * 3. 服务端捕获 /chat/completions 请求体：两符号正文以「## 引用符号 <名>（<路径> L起-止）」段注入
 *    （resolve 重读文件切片，内容为事实源），用户消息原文无 @查询残留；
 * 4. 落盘 manifest 审计：symbol:<id> 稳定 key 独立项、type=file_fragment、enabled、token 精确计数；
 * 5. placeholder 词典接线验证（文案含「符号」）；symbols.query IPC 直连断言索引状态 ready。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（符号索引、候选下拉、chips、IPC、上下文引擎、manifest 落盘）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC38");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i29-"));
fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
fs.mkdirSync(path.join(fixture, "docs"), { recursive: true });
// add：function L1-4（单行声明/花括号配平由 symbol-extractor 保证）
fs.writeFileSync(
  path.join(fixture, "src", "calc.ts"),
  [
    "export function add(a: number, b: number): number {",
    '  const MAGIC_SYMBOL_TOKEN = "symbol-injected-gamma";',
    "  return MAGIC_SYMBOL_TOKEN.length + a + b;",
    "}",
    "",
  ].join("\n"),
  "utf-8"
);
// UserService：class L1-5；getName：method@UserService L2-4
fs.writeFileSync(
  path.join(fixture, "src", "user.ts"),
  [
    "export class UserService {",
    "  getName(): string {",
    '    return "user-svc-delta";',
    "  }",
    "}",
    "",
  ].join("\n"),
  "utf-8"
);
fs.writeFileSync(path.join(fixture, "docs", "readme.md"), "# Fixture\n\nsymbols e2e\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i29-userdata-"));

// ---------------------------------------------------------------------------
// 本地端点：POST /chat/completions（SSE），捕获请求体用于符号注入断言
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text) => [
  sseChunk({ id: "i29", object: "chat.completion.chunk", created: 0, model: "i29", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i29", object: "chat.completion.chunk", created: 0, model: "i29", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i29", object: "chat.completion.chunk", created: 0, model: "i29", choices: [], usage: { prompt_tokens: 16, completion_tokens: 4 } }),
  "data: [DONE]\n\n",
];

const chatBodies = []; // POST /chat/completions 请求体（JSON）
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      try { chatBodies.push(JSON.parse(raw)); } catch { chatBodies.push({ __raw: raw }); }
      const frames = framesForText("符号已收到。");
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i29] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i29] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i29] FAIL: ${message}`);
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

const symbolChipIds = (page) =>
  page.$$eval(".dw-atchip-symbol", (chips) => chips.map((chip) => chip.dataset.symbolId));
const allChipCount = (page) => page.$$eval(".dw-atchip", (chips) => chips.length);

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（/chat/completions，捕获请求体）`);

  const cdpPort = 24600 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开（src/calc.ts / src/user.ts / docs/readme.md）");

  // ---- 0. 符号索引就绪（symbols.query IPC 直连；纯启发式无 provider 依赖）----
  await page.waitForFunction(async () => {
    const result = await window.devwit.symbols.query("");
    return result.state === "ready" && result.symbols.length >= 3;
  }, null, { timeout: 15_000, polling: 250 });
  const indexed = await page.evaluate(async () => {
    const result = await window.devwit.symbols.query("");
    return result.symbols.map((s) => `${s.kind}:${s.name}@${s.relPath}:L${s.startLine}-${s.endLine}`);
  });
  assert(
    indexed.some((entry) => entry.startsWith("function:add@src/calc.ts:L1-4")) &&
      indexed.some((entry) => entry.startsWith("class:UserService@src/user.ts:L1-5")) &&
      indexed.some((entry) => entry.startsWith("method:getName@src/user.ts:L2-4")),
    `索引应含 add/UserService/getName 且行列精确（实际: ${indexed.join(" | ")}）`
  );
  step("符号索引 ready：add(L1-4) / UserService(L1-5) / getName@UserService(L2-4) 提取精确");

  // placeholder 词典接线（AC38 新文案）
  const placeholder = await page.getAttribute(".dw-chat .dw-chat-textarea", "placeholder");
  assert(placeholder?.includes("符号") === true, `placeholder 应含「符号」提示（实际: ${placeholder}）`);

  // 注入 keyless provider（settings onChanged 热刷新到工具栏下拉）
  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({
      id: "p-i29", type: "openai", label: "i29-local", baseUrl: url, model: "i29-model",
      credentialRef: "cred-i29", maxTokens: 1024, keyless: true,
    });
  }, baseUrl);
  await page.waitForFunction(() => {
    const select = document.querySelector('select[title="模型"]');
    return select !== null && [...select.options].some((option) => option.value === "p-i29");
  }, null, { timeout: 10_000 });
  await page.selectOption('select[title="模型"]', "p-i29");
  await page.selectOption('select[title="模式"]', "chat");
  step("keyless provider 注入并选中（settings onChanged 热刷新链路）");

  // ---- 1. @ 空查询：文件区+符号区双分区下拉（分区标题）----
  await page.click(".dw-chat .dw-chat-textarea");
  await page.type(".dw-chat .dw-chat-textarea", "@");
  await page.waitForSelector('.dw-suggest[data-kind="file"]', { state: "visible", timeout: 5_000 });
  await page.waitForSelector(".dw-suggest-symbol", { state: "visible", timeout: 5_000 }); // 防抖 120ms + IPC
  const sections = await page.$$eval(".dw-suggest-section", (nodes) => nodes.map((node) => node.textContent));
  assert(sections.includes("文件") && sections.includes("符号"),
    `双分区标题应出现（实际: ${sections.join("/")}）`);
  const symbolNames = await page.$$eval(".dw-suggest-symbol .dw-suggest-name", (nodes) => nodes.map((node) => node.textContent));
  assert(symbolNames.includes("add") && symbolNames.includes("UserService") && symbolNames.includes("UserService.getName"),
    `空查询符号区应列全量符号（实际: ${symbolNames.join("/")}）`);
  await page.screenshot({ path: path.join(OUT, "01-at-suggest-sections.png") });
  step("@ 空查询：文件/符号双分区下拉（截图 01），符号区含 add/UserService/UserService.getName");

  // ---- 2. add 过滤唯一命中 → Enter 成符号 chip ----
  await page.type(".dw-chat .dw-chat-textarea", "add");
  await page.waitForFunction(() => {
    const symbols = [...document.querySelectorAll(".dw-suggest-symbol .dw-suggest-name")];
    const files = [...document.querySelectorAll('.dw-suggest-item:not(.dw-suggest-symbol):not(.dw-suggest-hintrow)')];
    return symbols.length === 1 && symbols[0]?.textContent === "add" && files.length === 0;
  }, null, { timeout: 5_000 });
  const addHint = await page.$eval(".dw-suggest-symbol .dw-suggest-hint", (node) => node.textContent);
  assert(addHint === "src/calc.ts:1", `add 候选位置提示应为 src/calc.ts:1（实际: ${addHint}）`);
  await page.press(".dw-chat .dw-chat-textarea", "Enter");
  await page.waitForSelector(".dw-atchip-symbol", { timeout: 5_000 });
  const afterFirst = await page.inputValue(".dw-chat .dw-chat-textarea");
  assert(afterFirst === "", `选中后 @查询 原文应清空（实际: "${afterFirst}"）`);
  assert((await page.isHidden(".dw-suggest")) === true, "选中后候选下拉应关闭");
  const addChipText = await page.$eval(".dw-atchip-symbol", (chip) => chip.textContent);
  assert(addChipText?.includes("函数") === true && addChipText.includes("add"),
    `add chip 应带 kind 徽标「函数」（实际: ${addChipText}）`);
  const addId = (await symbolChipIds(page))[0];
  step("@add 过滤唯一命中（hint src/calc.ts:1）→ Enter 成符号 chip（徽标「函数」）且输入框清空");

  // ---- 3. UserService 鼠标点击成 chip；× 剔除；去重；重引用 ----
  await page.type(".dw-chat .dw-chat-textarea", "@User");
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll(".dw-suggest-symbol .dw-suggest-name")];
    return names.some((node) => node.textContent === "UserService");
  }, null, { timeout: 5_000 });
  await page.click('.dw-suggest-symbol:has(.dw-suggest-name:text-is("UserService"))');
  await page.waitForFunction((count) => document.querySelectorAll(".dw-atchip-symbol").length === count, 2, { timeout: 5_000 });
  let ids = await symbolChipIds(page);
  const userId = ids.find((id) => id !== addId);
  assert(ids.length === 2 && userId !== undefined, `两符号 chip 就位（实际: ${ids.join("/")}）`);
  // 重复引用去重：再次选中 add 不产生第二个 chip
  await page.type(".dw-chat .dw-chat-textarea", "@add");
  await page.waitForFunction(() => document.querySelectorAll(".dw-suggest-symbol").length === 1, null, { timeout: 5_000 });
  await page.press(".dw-chat .dw-chat-textarea", "Enter");
  ids = await symbolChipIds(page);
  assert(ids.length === 2, `重复引用应按 id 去重（实际 chips: ${ids.join("/")}）`);
  // × 剔除 UserService
  await page.click(`.dw-atchip-symbol[data-symbol-id="${userId}"] .dw-atchip-x`);
  ids = await symbolChipIds(page);
  assert(ids.length === 1 && ids[0] === addId, `× 剔除后应剩 add（实际: ${ids.join("/")}）`);
  // 重新引用 UserService（"User" 同時命中文件 src/user.ts：active=0 在文件区，
  // ArrowDown 跨入符号区首项 UserService 后 Enter——验证键盘跨区导航）
  await page.type(".dw-chat .dw-chat-textarea", "@User");
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll(".dw-suggest-symbol .dw-suggest-name")];
    return names.some((node) => node.textContent === "UserService");
  }, null, { timeout: 5_000 });
  await page.press(".dw-chat .dw-chat-textarea", "ArrowDown");
  const activeName = await page.$eval(".dw-suggest-active .dw-suggest-name", (node) => node.textContent);
  assert(activeName === "UserService", `ArrowDown 后高亮应为 UserService 符号（实际: ${activeName}）`);
  await page.press(".dw-chat .dw-chat-textarea", "Enter");
  ids = await symbolChipIds(page);
  assert(ids.length === 2 && ids.includes(userId), `重新引用后两 chip（实际: ${ids.join("/")}）`);
  await page.screenshot({ path: path.join(OUT, "02-symbol-chips.png") });
  step("符号 chips 交互闭环：点击选中 / 去重 / × 剔除 / 重引用（截图 02）");

  // ---- 4. 发送：服务端验证符号注入 + 用户原文干净 ----
  await page.type(".dw-chat .dw-chat-textarea", "总结这两个符号");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("符号已收到")', { timeout: 30_000 });
  assert(chatBodies.length === 1, `服务端应收到 1 次 /chat/completions（实际: ${chatBodies.length}）`);
  const body = chatBodies[0] ?? {};
  const contents = (body.messages ?? []).map((message) => message.content ?? "");
  const contextMessage = contents.find((content) => content.includes("## 引用符号 add"));
  assert(contextMessage !== undefined, "请求体缺「## 引用符号 add」注入段");
  assert(contextMessage?.includes("（src/calc.ts L1-4）") === true,
    `add 注入段标题应带精确行区间（实际段首: ${contextMessage?.split("\n").find((l) => l.includes("引用符号 add"))}）`);
  assert(contextMessage?.includes("symbol-injected-gamma") === true, "add 符号正文未注入（MAGIC_SYMBOL_TOKEN 缺席）");
  assert(contextMessage?.includes("## 引用符号 UserService（src/user.ts L1-5）") === true &&
      contextMessage?.includes("user-svc-delta") === true,
    "UserService 符号正文未注入");
  const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  assert(lastUser?.content === "总结这两个符号", `用户原文应无 @残留（实际: "${lastUser?.content}"）`);
  assert((await allChipCount(page)) === 0, "发送后 chips 应清空");
  step("发送完成：两符号切片注入（gamma/delta 服务端可见、行区间精确），用户原文干净，chips 清空");

  // ---- 5. manifest 落盘审计 ----
  const manifestsDir = path.join(userDataDir, "manifests");
  const manifestFiles = fs.readdirSync(manifestsDir).filter((name) => name.endsWith(".json"));
  assert(manifestFiles.length >= 1, "manifests 目录应有落盘文件");
  const latest = JSON.parse(
    fs.readFileSync(path.join(manifestsDir, manifestFiles.sort().at(-1)), "utf-8")
  );
  const addItem = latest.items.find((item) => item.key === `symbol:${addId}`);
  const userItem = latest.items.find((item) => item.key === `symbol:${userId}`);
  assert(addItem !== undefined && addItem.type === "file_fragment" && addItem.enabled === true,
    `manifest 缺 enabled 的 symbol:<addId> 项（实际: ${JSON.stringify(addItem)}）`);
  assert(userItem !== undefined && userItem.type === "file_fragment" && userItem.enabled === true,
    `manifest 缺 enabled 的 symbol:<userId> 项（实际: ${JSON.stringify(userItem)}）`);
  assert(typeof addItem?.tokens === "number" && addItem.tokens > 0,
    `符号项应有精确 token 计数（实际: ${addItem?.tokens}）`);
  assert(addItem?.label?.includes("引用符号 add") === true && userItem?.label?.includes("引用符号 UserService") === true,
    `符号项 label 应含「引用符号 <名>」（实际: ${addItem?.label} / ${userItem?.label}）`);
  fs.writeFileSync(path.join(OUT, "manifest-latest.json"), JSON.stringify(latest, null, 2), "utf-8");
  step("manifest 审计通过：symbol:* 独立 key 项 enabled + file_fragment + token 计数（已落盘 manifest-latest.json）");
} catch (error) {
  fatal = error;
  console.error("[verify-i29] FATAL:", error);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  await stopElectron(electronProc);
  server.close();
}

report.fatal = fatal === null ? null : String(fatal);
report.ok = fatal === null && report.failures.length === 0;
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`[verify-i29] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败；证据 → evidence/AC38`);
if (!report.ok) {
  console.error("[verify-i29] FAILED");
  process.exit(1);
}
console.log("[verify-i29] OK");
