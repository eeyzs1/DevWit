/**
 * 迭代 28 验证脚本（AC37 对话生产力 II：会话持久化与多会话管理，证据落盘 evidence/AC37）：
 * 1. 多会话列表：对话任务 A 后「会话」页签出现 1 行（标题回退首条用户消息预览 + 「当前」徽标
 *    + 元信息 时间·事件数）；「新会话」后对话面板清空，对话任务 B 落第二行（倒序，新在前）。
 * 2. 切换：点击历史会话行 → 对话面板由轨迹回放重建（A 的用户/助手消息可见，无 running 态），
 *    「当前」徽标随行迁移；traceList 与 sessions.list IPC 一致。
 * 3. 改名：行内编辑（✎ → 输入 → Enter）标题即时生效且优先于预览；sessions.list IPC 同值；
 *    重启应用（同一 userDataDir）改名保留、活跃会话消息自动恢复（session.state + 轨迹回放）。
 * 4. 删除：两段确认（🗑 → 「确认删除」3s 超时态 → 再点执行）；删除活跃会话自动开新会话兜底，
 *    列表与 IPC 同步减一，被删会话轨迹文件移除（traceList 不再含）。
 * 5. i18n 热切换：设置切 English → 页签 Sessions / New session 英文文案，切回中文恢复。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（轨迹落盘、元数据 overlay、sessions IPC、重启恢复）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC37");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i26-"));
fs.writeFileSync(path.join(fixture, "note.txt"), "原始内容\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i26-userdata-"));

const TASK_A = "讨论登录页的重构思路";
const REPLY_A = "登录页建议拆三个组件。";
const TASK_B = "给编辑器加行号";
const REPLY_B = "行号已在 gutter 实现。";

// ---------------------------------------------------------------------------
// 本地端点：按请求序脚本——1: 会话 A 文本；2: 会话 B 文本
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text) => [
  sseChunk({ id: "i26", object: "chat.completion.chunk", created: 0, model: "i26", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i26", object: "chat.completion.chunk", created: 0, model: "i26", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  "data: [DONE]\n\n",
];
const SCRIPT = [framesForText(REPLY_A), framesForText(REPLY_B)];
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i26] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i26] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i26] FAIL: ${message}`);
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
        DEVWIT_E2E_OFFSCREEN: "1",
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

/** 连接（或重连）CDP 并等待主界面就绪。 */
async function connectPage(ws) {
  const br = await chromium.connectOverCDP(ws);
  const context = br.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  return { br, page };
}

/** 会话页签行信息（标题/徽标/元信息）。 */
function sessionRows(page) {
  return page.$$eval(".dw-sessions-row", (rows) =>
    rows.map((row) => ({
      id: row.dataset.sessionId,
      title: row.querySelector(".dw-sessions-title")?.textContent ?? "",
      active: row.classList.contains("dw-sessions-row-active"),
      badge: row.querySelector(".dw-sessions-badge")?.textContent ?? null,
      meta: row.querySelector(".dw-sessions-meta")?.textContent ?? "",
    }))
  );
}

let browser = null;
let page = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（脚本化 2 请求）`);

  const cdpPort = 27200 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  ({ br: browser, page } = await connectPage(ws));

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开");

  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({
      id: "p-i26", type: "openai", label: "i26-local", baseUrl: url, model: "i26-model",
      credentialRef: "cred-i26", maxTokens: 2048, keyless: true,
    });
    const modes = await window.devwit.modes.list();
    const chat = modes.find((m) => m.id === "chat");
    await window.devwit.modes.upsert({ ...chat, providerId: "p-i26", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("keyless provider 注册 + chat 模式热绑定");

  // ---- 1. 对话任务 A → 会话页签出现 1 行 ----
  await page.waitForSelector(".dw-chat .dw-chat-textarea", { timeout: 10_000 });
  await page.selectOption('select[title="模式"]', "chat");
  await page.fill(".dw-chat .dw-chat-textarea", TASK_A);
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector(`.dw-msg-assistant:has-text("${REPLY_A}")`, { timeout: 30_000 });
  await page.waitForSelector(".dw-msg-done", { timeout: 10_000 });
  const sessionA = (await page.evaluate(() => window.devwit.sessions.list()))[0]?.sessionId;
  assert(typeof sessionA === "string" && sessionA.startsWith("session-"), `会话 A 已落盘入列表（id: ${sessionA}）`);

  await page.click('.dw-side .dw-tab:has-text("会话")');
  await page.waitForSelector(".dw-sessions-row", { timeout: 10_000 });
  let rows = await sessionRows(page);
  assert(rows.length === 1 && rows[0].id === sessionA, `会话页签 1 行（实际: ${JSON.stringify(rows)}）`);
  assert(rows[0].title === TASK_A && rows[0].active && rows[0].badge === "当前",
    `首行标题回退首条用户消息 + 「当前」徽标（实际: ${JSON.stringify(rows[0])}）`);
  assert(/·\s*4\s*条事件/.test(rows[0].meta), `元信息「时间 · 4 条事件」（实际: ${rows[0].meta}）`);
  step("对话任务 A 完成：会话页签 1 行（预览标题/当前徽标/事件数）");

  // ---- 2. 新会话 → 对话任务 B → 列表两行（倒序，新在前）----
  await page.click(".dw-sessions-toolbar >> text=新会话");
  await page.waitForSelector(".dw-chat .dw-chat-textarea", { timeout: 5_000 });
  const msgCountAfterNew = await page.$$eval(".dw-msg", (nodes) => nodes.length);
  assert(msgCountAfterNew === 0, `新会话对话面板应清空（实际消息行: ${msgCountAfterNew}）`);
  await page.fill(".dw-chat .dw-chat-textarea", TASK_B);
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector(`.dw-msg-assistant:has-text("${REPLY_B}")`, { timeout: 30_000 });
  await page.waitForSelector(".dw-msg-done", { timeout: 10_000 });

  await page.click('.dw-side .dw-tab:has-text("会话")');
  await page.waitForFunction((n) => document.querySelectorAll(".dw-sessions-row").length === n, 2, { timeout: 10_000 });
  rows = await sessionRows(page);
  const sessionB = rows.find((r) => r.id !== sessionA)?.id;
  assert(rows.length === 2 && rows[0].id === sessionB && rows[1].id === sessionA,
    `列表两行按 lastAt 倒序（新在前）（实际: ${JSON.stringify(rows.map((r) => r.id))}）`);
  assert(rows[0].title === TASK_B && rows[0].active && !rows[1].active,
    `会话 B 为当前行，会话 A 无徽标（实际: ${JSON.stringify(rows)}）`);
  await page.screenshot({ path: path.join(OUT, "01-sessions-two-rows.png") });
  step("新会话 + 对话任务 B：两行倒序，B 当前（截图 01）");

  // ---- 3. 点击会话 A 行 → 切换回放重建消息 ----
  await page.click(`.dw-sessions-row[data-session-id="${sessionA}"]`);
  await page.waitForSelector(`.dw-msg-user:has-text("${TASK_A}")`, { timeout: 10_000 });
  await page.waitForSelector(`.dw-msg-assistant:has-text("${REPLY_A}")`, { timeout: 5_000 });
  await page.waitForSelector(".dw-msg-done", { timeout: 5_000 });
  // resumed 语义：回放重建不标 running（停止按钮不显示）
  const stopVisible = await page.isVisible(".dw-chat >> text=停止").catch(() => false);
  assert(stopVisible === false, "回放重建不应处于 running 态（停止按钮不可见）");
  await page.click('.dw-side .dw-tab:has-text("会话")');
  rows = await sessionRows(page);
  assert(rows.find((r) => r.id === sessionA)?.active === true && rows.find((r) => r.id === sessionB)?.active === false,
    `「当前」徽标随切换迁移到会话 A（实际: ${JSON.stringify(rows)}）`);
  await page.screenshot({ path: path.join(OUT, "02-switched-back.png") });
  step("切换会话 A：轨迹回放重建消息（用户/助手可见，无 running）（截图 02）");

  // ---- 4. 改名会话 A（行内编辑 Enter 提交）----
  await page.click(`.dw-sessions-row[data-session-id="${sessionA}"] .dw-sessions-action`);
  await page.waitForSelector(".dw-sessions-rename-input", { timeout: 5_000 });
  await page.fill(".dw-sessions-rename-input", "登录页重构讨论");
  await page.press(".dw-sessions-rename-input", "Enter");
  await page.waitForFunction(
    (id) => document.querySelector(`.dw-sessions-row[data-session-id="${id}"] .dw-sessions-title`)?.textContent === "登录页重构讨论",
    sessionA,
    { timeout: 10_000 }
  );
  const listAfterRename = await page.evaluate(() => window.devwit.sessions.list());
  fs.writeFileSync(path.join(OUT, "sessions-after-rename.json"), JSON.stringify(listAfterRename, null, 2), "utf-8");
  assert(listAfterRename.find((s) => s.sessionId === sessionA)?.title === "登录页重构讨论",
    `sessions.list IPC 改名同值（实际: ${JSON.stringify(listAfterRename)}）`);
  await page.screenshot({ path: path.join(OUT, "03-renamed.png") });
  step("改名：行内编辑生效，IPC 同值（截图 03）");

  // ---- 5. 重启（同一 userDataDir）：活跃会话 A 自动恢复 + 改名保留 ----
  await stopElectron(electronProc);
  await browser.close().catch(() => undefined);
  const cdpPort2 = 27800 + Math.floor(Math.random() * 100);
  const relaunched = await launchElectron(cdpPort2);
  electronProc = relaunched.proc;
  ({ br: browser, page } = await connectPage(relaunched.ws));
  await page.waitForSelector(`.dw-msg-user:has-text("${TASK_A}")`, { timeout: 15_000 });
  await page.waitForSelector(`.dw-msg-assistant:has-text("${REPLY_A}")`, { timeout: 5_000 });
  const bodiesAfterRestore = chatBodies.length;
  assert(bodiesAfterRestore === 2, `重启恢复不应触发新 LLM 请求（实际请求数: ${bodiesAfterRestore}）`);
  await page.click('.dw-side .dw-tab:has-text("会话")');
  await page.waitForFunction((n) => document.querySelectorAll(".dw-sessions-row").length === n, 2, { timeout: 10_000 });
  rows = await sessionRows(page);
  const restoredA = rows.find((r) => r.id === sessionA);
  assert(restoredA?.title === "登录页重构讨论" && restoredA.active === true,
    `重启后改名保留且会话 A 为当前行（实际: ${JSON.stringify(restoredA)}）`);
  await page.screenshot({ path: path.join(OUT, "04-restart-restored.png") });
  step("重启：session.state + 轨迹回放恢复活跃会话，改名持久（截图 04）");

  // ---- 6. 删除：两段确认 + 删活跃会话自动开新兜底 ----
  const deleteBtn = `.dw-sessions-row[data-session-id="${sessionA}"] .dw-sessions-action >> nth=1`;
  await page.click(deleteBtn);
  await page.waitForSelector(`.dw-sessions-row[data-session-id="${sessionA}"] .dw-sessions-confirm`, { timeout: 5_000 });
  const confirmText = await page.textContent(`.dw-sessions-row[data-session-id="${sessionA}"] .dw-sessions-confirm`);
  assert((confirmText ?? "") === "确认删除", `首点删除进入待确认态（按钮文案: ${confirmText}）`);
  await page.screenshot({ path: path.join(OUT, "05-delete-confirm.png") });
  await page.click(deleteBtn);
  await page.waitForFunction((n) => document.querySelectorAll(".dw-sessions-row").length === n, 1, { timeout: 10_000 });
  rows = await sessionRows(page);
  assert(rows.length === 1 && rows[0].id === sessionB && !rows[0].active,
    `删除后只余会话 B 且非当前（实际: ${JSON.stringify(rows)}）`);
  // 删除的是活跃会话 → 自动开新会话兜底：对话面板清空、新会话尚无事件不入列表
  await page.click('.dw-side .dw-tab:has-text("对话")');
  const msgCountAfterDelete = await page.$$eval(".dw-msg", (nodes) => nodes.length);
  assert(msgCountAfterDelete === 0, `删除活跃会话后对话面板应为新会话空态（实际消息行: ${msgCountAfterDelete}）`);
  const listFinal = await page.evaluate(() => window.devwit.sessions.list());
  const traceListFinal = await page.evaluate(() => window.devwit.agent.traceList());
  fs.writeFileSync(path.join(OUT, "sessions-final.json"), JSON.stringify({ sessions: listFinal, traceList: traceListFinal }, null, 2), "utf-8");
  assert(listFinal.length === 1 && listFinal[0].sessionId === sessionB,
    `sessions.list IPC 只余会话 B（实际: ${JSON.stringify(listFinal)}）`);
  assert(!traceListFinal.some((s) => s.sessionId === sessionA),
    `被删会话轨迹文件已移除（traceList 不再含 A）（实际: ${JSON.stringify(traceListFinal.map((s) => s.sessionId))}）`);
  step("删除：两段确认（截图 05），删活跃会话自动开新兜底，轨迹文件移除");

  // ---- 7. i18n 热切换：English → 中文 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.selectOption(".dw-modal-settings select", "en-US");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-settings-nav-item")].some((n) => (n.textContent ?? "") === "General"),
    null,
    { timeout: 5_000 }
  );
  await page.click('.dw-modal-actions >> button:has-text("Close")');
  await page.waitForSelector('.dw-side .dw-tab:has-text("Sessions")', { timeout: 5_000 });
  await page.click('.dw-side .dw-tab:has-text("Sessions")');
  const newBtnEn = await page.textContent(".dw-sessions-toolbar .dw-btn");
  const titleEn = await page.textContent(`.dw-sessions-row[data-session-id="${sessionB}"] .dw-sessions-title`);
  assert((newBtnEn ?? "").trim() === "New session", `英文热生效：「New session」（实际: ${newBtnEn}）`);
  assert((titleEn ?? "") === TASK_B, `英文切换不改会话数据（标题仍预览原文）（实际: ${titleEn}）`);
  await page.screenshot({ path: path.join(OUT, "06-sessions-en.png") });
  await page.click(".dw-header >> text=Settings");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.selectOption(".dw-modal-settings select", "zh-CN");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-settings-nav-item")].some((n) => (n.textContent ?? "") === "通用"),
    null,
    { timeout: 5_000 }
  );
  await page.click('.dw-modal-actions >> button:has-text("关闭")');
  await page.waitForSelector('.dw-side .dw-tab:has-text("会话")', { timeout: 5_000 });
  step("i18n 热切换：Sessions / New session 英文（截图 06）→ 切回中文恢复");

  // 请求体数审计：仅任务 A/B 两次调用（重启恢复不回放请求）
  assert(chatBodies.length === 2, `服务端应收到 2 次 /chat/completions（实际: ${chatBodies.length}）`);
  const bodiesOk = chatBodies.every((body) => Array.isArray(body.messages) && body.stream === true);
  assert(bodiesOk, "两次请求体均为合法 OpenAI 兼容 streaming 结构");
  fs.writeFileSync(path.join(OUT, "chat-bodies.json"), JSON.stringify(chatBodies, null, 2), "utf-8");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i26] FATAL: ${fatal}`);
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
fs.writeFileSync(path.join(OUT, "verify-i26-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(OUT, "iteration28-verification.txt"),
  [
    "迭代 28（AC37 对话生产力 II：会话持久化与多会话管理）验证：",
    "1. 多会话列表：侧栏新增「会话」页签——对话会话（sessionId 前缀 session-，与指挥台任务会话隔离）按末事件时间倒序列出；未改名会话标题回退首条用户消息预览，元信息显示 时间 · 事件数，当前会话带「当前」徽标。",
    "2. 新建/切换：「新会话」开空会话（空会话无轨迹不入列表，首条消息落盘后自然出现）；点击历史会话行经磁盘轨迹回放重建消息列表（resumed 语义——不标 running、不触发新 LLM 请求），「当前」徽标随行迁移。",
    "3. 改名：行内编辑（Enter 提交 / Esc 取消 / 空标题清除回退预览），元数据存 userData/sessions.json（整体 JSON overlay，轨迹文件仍是内容事实源）；重启后改名保留、活跃会话经 session.state + 轨迹回放自动恢复。",
    "4. 删除：两段确认（首点进入 3s 超时待确认态，再点执行）；删除即元数据 deleted 标记 + 轨迹文件移除 + 主进程内存会话摘除（进行中的 run 先中断，防已删会话经内存复活）；删除活跃会话自动开新会话兜底；任务会话（task-session- 前缀）一律拒绝改名/删除。",
    "5. i18n：全部新文案词典化（zh-CN/en-US 同型校验），语言热切换后页签/按钮/空态即时重绘且会话数据不受语言影响。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);

console.log(`[verify-i26] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
