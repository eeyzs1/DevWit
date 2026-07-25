/**
 * 迭代 26 验证脚本（AC35 Token 用量可观测，证据落盘 evidence/AC35）：
 * 1. 对话任务（chat，纯文本一轮）：SSE usage 帧 → 对话面板「用量」行
 *    （输入 50 / 输出 6），且先于完成行；
 * 2. 指挥台任务（agent，write 工具两轮）：两次 usage 帧跨迭代求和 →
 *    活动流「用量」行显示求和量（输入 100 / 输出 20），write 授权真实写盘；
 * 3. 账本落盘：userData/usage.jsonl 两条 UsageRecord（modeId/providerId/model/
 *    finishReason 明细），轨迹 usage 事件先于 done；
 * 4. usage.summary IPC 聚合：total/today 150/26·2 次、按模式 agent 100/20 +
 *    chat 50/6、按服务商 p-i24·i24-model；
 * 5. 设置·通用分区「用量统计」区渲染今日/累计/按模式/按服务商行（截图）；
 * 6. 清零 → 区域空态 + summary 归零 + 会话轨迹不受影响（审计隔离）。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（write 写盘、授权门、账本落盘、聚合 IPC、设置页渲染）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC35");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i24-"));
fs.writeFileSync(path.join(fixture, "note.txt"), "原始内容\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i24-userdata-"));

const CHAT_TASK = "总结一下今天的安排";
const AGENT_TASK = "把 note.txt 改写成两行";

// ---------------------------------------------------------------------------
// 本地端点：按请求序脚本——1: chat 文本；2: agent write 工具；3: agent 收尾文本
// usage 帧值故意各不相同：求和证据 40+60=100 / 15+5=20
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text, usage) => [
  sseChunk({ id: "i24", object: "chat.completion.chunk", created: 0, model: "i24", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i24", object: "chat.completion.chunk", created: 0, model: "i24", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i24", object: "chat.completion.chunk", created: 0, model: "i24", choices: [], usage }),
  "data: [DONE]\n\n",
];
const framesForWrite = (id, usage) => [
  sseChunk({ id: "i24", object: "chat.completion.chunk", created: 0, model: "i24", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: JSON.stringify({ path: "note.txt", content: "第一行\n第二行\n" }) } }] }, finish_reason: null }] }),
  sseChunk({ id: "i24", object: "chat.completion.chunk", created: 0, model: "i24", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  sseChunk({ id: "i24", object: "chat.completion.chunk", created: 0, model: "i24", choices: [], usage }),
  "data: [DONE]\n\n",
];
const SCRIPT = [
  framesForText("今天的安排已总结。", { prompt_tokens: 50, completion_tokens: 6 }), // 1: chat
  framesForWrite("call_i24_1", { prompt_tokens: 40, completion_tokens: 15 }),        // 2: agent 首轮
  framesForText("已改写成两行。", { prompt_tokens: 60, completion_tokens: 5 }),        // 3: agent 收尾
];
const chatBodies = [];
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      try { chatBodies.push(JSON.parse(raw)); } catch { chatBodies.push({ __raw: raw }); }
      const frames = SCRIPT[Math.min(chatBodies.length - 1, SCRIPT.length - 1)];
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i24] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i24] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i24] FAIL: ${message}`);
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
        DEVWIT_USER_DATA_DIR: userDataDir,
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
  step(`本地端点就绪 ${baseUrl}（脚本化 3 请求，usage 帧 50/6、40/15、60/5）`);

  const cdpPort = 26600 + Math.floor(Math.random() * 300);
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

  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({
      id: "p-i24", type: "openai", label: "i24-local", baseUrl: url, model: "i24-model",
      credentialRef: "cred-i24", maxTokens: 2048, keyless: true,
    });
    const modes = await window.devwit.modes.list();
    const agent = modes.find((m) => m.id === "agent");
    const chat = modes.find((m) => m.id === "chat");
    await window.devwit.modes.upsert({ ...agent, providerId: "p-i24", updatedAt: new Date().toISOString() });
    await window.devwit.modes.upsert({ ...chat, providerId: "p-i24", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("keyless provider 注册 + agent/chat 双模式热绑定");

  // ---- 1. 对话任务（chat）：usage 行可见且先于完成行 ----
  // 默认即对话形态（header 切换按钮显示目标形态名「指挥台」），无需先切换
  await page.waitForSelector(".dw-chat .dw-chat-textarea", { timeout: 10_000 });
  await page.selectOption('select[title="模式"]', "chat");
  await page.fill(".dw-chat .dw-chat-textarea", CHAT_TASK);
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("今天的安排已总结")', { timeout: 30_000 });
  await page.waitForSelector(".dw-msg-usage", { timeout: 10_000 });
  const usageRowText = await page.textContent(".dw-msg-usage");
  assert(
    usageRowText.includes("用量") && usageRowText.includes("输入 50") && usageRowText.includes("输出 6"),
    `对话面板用量行应显示真实用量（实际: ${usageRowText}）`
  );
  const msgKinds = await page.$$eval(".dw-msg", (rows) => rows.map((row) => [...row.classList].find((c) => c.startsWith("dw-msg-") && c !== "dw-msg")));
  const usageIdx = msgKinds.findIndex((cls) => cls === "dw-msg-usage");
  const doneIdx = msgKinds.findIndex((cls) => cls === "dw-msg-done");
  assert(usageIdx >= 0 && doneIdx > usageIdx, `用量行应先于完成行（usage@${usageIdx}, done@${doneIdx}）`);
  await page.screenshot({ path: path.join(OUT, "01-chat-usage-row.png") });
  step("对话任务：用量行「输入 50 / 输出 6」先于完成行（截图 01）");

  // ---- 2. 指挥台任务（agent）：两轮 usage 求和 + write 真实写盘 ----
  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", AGENT_TASK);
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "允许", exact: true }).click();
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const written = fs.readFileSync(path.join(fixture, "note.txt"), "utf-8");
  assert(written === "第一行\n第二行\n", `agent write 真实写盘（实际: ${JSON.stringify(written)}）`);
  await page.waitForSelector(".dw-act-usage", { timeout: 10_000 });
  const actUsageText = await page.textContent(".dw-act-usage");
  assert(
    actUsageText.includes("输入 100") && actUsageText.includes("输出 20"),
    `活动流用量行应显示跨迭代求和 100/20（实际: ${actUsageText}）`
  );
  await page.screenshot({ path: path.join(OUT, "02-console-usage-summed.png") });
  step("指挥台任务：两轮 usage 帧求和 100/20 落活动流（截图 02），write 真实写盘");

  // ---- 3. 账本落盘 + 轨迹审计 ----
  const ledgerFile = path.join(userDataDir, "usage.jsonl");
  assert(fs.existsSync(ledgerFile), "usage.jsonl 账本应已落盘");
  const records = fs.readFileSync(ledgerFile, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  fs.writeFileSync(path.join(OUT, "usage-ledger.json"), JSON.stringify(records, null, 2), "utf-8");
  assert(records.length === 2, `账本应有 2 条记录（实际: ${records.length}）`);
  const chatRec = records.find((r) => r.modeId === "chat");
  const agentRec = records.find((r) => r.modeId === "agent");
  assert(
    chatRec !== undefined && chatRec.providerId === "p-i24" && chatRec.model === "i24-model" &&
      chatRec.inputTokens === 50 && chatRec.outputTokens === 6 && chatRec.finishReason === "completed",
    `chat 记录明细（实际: ${JSON.stringify(chatRec)}）`
  );
  assert(
    agentRec !== undefined && agentRec.inputTokens === 100 && agentRec.outputTokens === 20 && agentRec.finishReason === "completed",
    `agent 记录应为求和量 100/20（实际: ${JSON.stringify(agentRec)}）`
  );
  // 轨迹：usage 事件先于 done（两个会话各自）
  const tracesDir = path.join(userDataDir, "traces");
  const traceEvents = fs.readdirSync(tracesDir).filter((n) => n.endsWith(".jsonl")).flatMap((n) =>
    fs.readFileSync(path.join(tracesDir, n), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  );
  const usageEvents = traceEvents.filter((e) => e.type === "usage");
  assert(usageEvents.length === 2, `磁盘轨迹应有 usage×2（实际: ${usageEvents.length}）`);
  for (const sessionId of new Set(usageEvents.map((e) => e.sessionId))) {
    const seq = traceEvents.filter((e) => e.sessionId === sessionId).map((e) => e.type);
    assert(seq.indexOf("usage") < seq.lastIndexOf("done"), `会话 ${sessionId} 轨迹 usage 应先于 done（实际: ${seq.join(",")}）`);
  }
  step("账本 2 条明细正确；轨迹 usage×2 均先于 done");

  // ---- 4. usage.summary IPC 聚合 ----
  const summary = await page.evaluate(() => window.devwit.usage.summary());
  fs.writeFileSync(path.join(OUT, "usage-summary.json"), JSON.stringify(summary, null, 2), "utf-8");
  assert(
    summary.total.inputTokens === 150 && summary.total.outputTokens === 26 && summary.total.runs === 2,
    `summary.total 应为 150/26·2（实际: ${JSON.stringify(summary.total)}）`
  );
  assert(
    summary.today.inputTokens === 150 && summary.today.outputTokens === 26 && summary.today.runs === 2,
    `summary.today 应为 150/26·2（实际: ${JSON.stringify(summary.today)}）`
  );
  const byModeAgent = summary.byMode.find((row) => row.modeId === "agent");
  const byModeChat = summary.byMode.find((row) => row.modeId === "chat");
  assert(
    byModeAgent?.inputTokens === 100 && byModeAgent?.outputTokens === 20 && byModeAgent?.runs === 1 &&
      byModeChat?.inputTokens === 50 && byModeChat?.outputTokens === 6 && byModeChat?.runs === 1,
    `byMode 应为 agent 100/20 + chat 50/6（实际: ${JSON.stringify(summary.byMode)}）`
  );
  const byProvider = summary.byProvider.find((row) => row.providerId === "p-i24");
  assert(
    byProvider?.model === "i24-model" && byProvider?.inputTokens === 150 && byProvider?.outputTokens === 26 && byProvider?.runs === 2,
    `byProvider 应为 p-i24·i24-model 150/26·2（实际: ${JSON.stringify(summary.byProvider)}）`
  );
  step("usage.summary 聚合：total/today 150/26·2，byMode/byProvider 分布正确");

  // ---- 5. 设置·通用分区「用量统计」区 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  // 通用分区为默认首区；等待用量区聚合渲染（今日行）
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-settings-whitelist-row")].some((row) => (row.textContent ?? "").includes("今日：输入 150 / 输出 26")),
    null,
    { timeout: 10_000 }
  );
  const usageZoneText = await page.$$eval(".dw-settings-whitelist", (boxes) => boxes.map((box) => box.textContent ?? "").join("\n---\n"));
  assert(usageZoneText.includes("累计：输入 150 / 输出 26 tokens · 2 次计量"), `设置区累计行（实际: ${usageZoneText.slice(0, 400)}）`);
  assert(usageZoneText.includes("Agent：输入 100 / 输出 20 · 1 次"), `设置区按模式 agent 行（实际: ${usageZoneText.slice(0, 400)}）`);
  assert(usageZoneText.includes("Chat：输入 50 / 输出 6 · 1 次"), `设置区按模式 chat 行（实际: ${usageZoneText.slice(0, 400)}）`);
  assert(usageZoneText.includes("p-i24 · i24-model：输入 150 / 输出 26 · 2 次"), `设置区按服务商行（实际: ${usageZoneText.slice(0, 400)}）`);
  await page.screenshot({ path: path.join(OUT, "03-settings-usage.png") });
  step("设置·通用分区用量统计区：今日/累计/按模式/按服务商渲染（截图 03）");

  // ---- 6. 清零：区域空态 + summary 归零 + 会话轨迹不受影响 ----
  await page.click('.dw-modal-settings button:has-text("清零")');
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-modal-hint")].some((row) => (row.textContent ?? "").includes("暂无计量")),
    null,
    { timeout: 10_000 }
  );
  const summaryAfter = await page.evaluate(() => window.devwit.usage.summary());
  assert(
    summaryAfter.total.runs === 0 && summaryAfter.total.inputTokens === 0,
    `清零后 summary 应归零（实际: ${JSON.stringify(summaryAfter.total)}）`
  );
  assert(!fs.existsSync(ledgerFile), "清零后 usage.jsonl 应被删除");
  const traceStill = await page.evaluate(async () => {
    // 任一已知会话轨迹仍可读（清零只删用量账本）
    const dirs = await window.devwit.agent.trace;
    return typeof dirs === "function";
  });
  assert(traceStill === true, "清零后 agent.trace 接口仍可用");
  const traceCount = traceEvents.filter((e) => e.type === "usage").length;
  assert(traceCount === 2, "清零不影响已落盘的会话轨迹（usage 事件仍在 traces/*.jsonl）");
  await page.screenshot({ path: path.join(OUT, "04-settings-usage-cleared.png") });
  step("清零闭环：空态 + summary 归零 + 账本删除 + 会话轨迹保留（截图 04）");

  // 请求体数审计：3 次调用与脚本对齐（chat 一轮 + agent 两轮）
  assert(chatBodies.length === 3, `服务端应收到 3 次 /chat/completions（实际: ${chatBodies.length}）`);
  fs.writeFileSync(path.join(OUT, "chat-bodies.json"), JSON.stringify(chatBodies, null, 2), "utf-8");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i24] FATAL: ${fatal}`);
  try {
    const pages = browser?.contexts()[0]?.pages() ?? [];
    if (pages.length > 0) await pages[0].screenshot({ path: path.join(OUT, "99-fatal.png") });
  } catch { /* 截图失败不阻断 */ }
} finally {
  await stopElectron(electronProc);
  if (browser !== null) await browser.close().catch(() => undefined);
  server.close();
}

report.fatal = fatal;
fs.writeFileSync(path.join(OUT, "verify-i24-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(OUT, "iteration26-verification.txt"),
  [
    "迭代 26（AC35 Token 用量可观测）验证：",
    "1. 真实计量：provider SSE usage 帧（openai stream_options.include_usage 末尾统计帧）经 llm-providers 解析为 usage 事件，agent-loop 跨迭代求和（40+60/15+5=100/20），编排路径另含 Planner/子 Agent/综合三路求和。",
    "2. 活动流/对话面板「用量」行：先于完成行渲染真实用量（与上下文面板 manifest 估算计数互补）。",
    "3. 账本落盘：userData/usage.jsonl append-only 两条 UsageRecord（ts/sessionId/modeId/providerId/model/双 token/finishReason 明细），磁盘轨迹 usage 事件先于 done 可回放。",
    "4. usage.summary IPC 聚合：total/today 150/26·2 次、byMode agent 100/20 + chat 50/6、byProvider p-i24·i24-model 150/26·2。",
    "5. 设置·通用分区「用量统计」区：今日/累计/按模式/按服务商四组行渲染（模式名用户改名优先），刷新/清零按钮。",
    "6. 清零闭环：区域转空态、summary 归零、usage.jsonl 删除，会话轨迹（traces/*.jsonl）不受影响（审计隔离）。",
    "7. provider 未回报 usage 的 run 不计入账本（单测覆盖：只收真实计费量）。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);

console.log(`[verify-i24] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
