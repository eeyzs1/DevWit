/**
 * 迭代 6 验证脚本（AC15 会话持久化：对话 + Agent 任务历史落盘，重启恢复）。
 *
 * 场景（真实 Electron 双进程回环）：
 * 进程一：配 provider → 指挥台创建任务 A（授权 → write 真实落盘 → 完成）
 *         → 创建任务 B（SSE 悬挂，保持「进行中」）→ 校验 session.state 与
 *         traces/*.jsonl 落盘 → 直接 kill（模拟退出）。
 * 进程二：同 userData 重启 → 工作区/任务列表/形态自动恢复（任务 A「完成」、
 *         任务 B「已中断」）→ 点击任务 A 活动流从磁盘轨迹完整回放
 *         → 续跑任务 B：服务端捕获请求体，断言含首轮用户意图（跨重启记忆）。
 *
 * LLM 侧说明与 smoke.mjs/iteration2.mjs 相同：本地端点以真实 SSE 线协议应答，
 * 产品侧链路 100% 真实（凭证加解密、HTTP、SSE 解析、agent loop、授权门、
 * 文件系统、轨迹 JSONL 落盘与读回）。证据落盘 evidence/AC15。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC15");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i6-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i6-userdata-"));

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i6] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i6] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i6] FAIL: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 本地 OpenAI 兼容 SSE 端点（真实线协议；请求体全量捕获供历史注入断言）
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
function framesForText(text) {
  return [
    sseChunk({ id: "i6", object: "chat.completion.chunk", created: 0, model: "i6", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sseChunk({ id: "i6", object: "chat.completion.chunk", created: 0, model: "i6", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({ id: "i6", object: "chat.completion.chunk", created: 0, model: "i6", choices: [], usage: { prompt_tokens: 40, completion_tokens: 15 } }),
    "data: [DONE]\n\n",
  ];
}
function framesForToolCall(name, args) {
  return [
    sseChunk({ id: "i6", object: "chat.completion.chunk", created: 0, model: "i6", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_i6_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    sseChunk({ id: "i6", object: "chat.completion.chunk", created: 0, model: "i6", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({ id: "i6", object: "chat.completion.chunk", created: 0, model: "i6", choices: [], usage: { prompt_tokens: 55, completion_tokens: 9 } }),
    "data: [DONE]\n\n",
  ];
}

const TASK_A_INTENT = "创建文件 ac15-note.txt";
const TASK_B_INTENT = "分析项目结构（长任务）";
const requestBodies = [];
// #1 任务A首轮 → 工具调用；#2 任务A工具回填 → 总结；#3 任务B首轮 → 悬挂（不应答，模拟退出时仍在跑）；
// #4 重启后续跑任务B → 文本答复
const RESPONSES = [
  framesForToolCall("write", { path: "ac15-note.txt", content: "persisted across restart\n" }),
  framesForText("已创建 ac15-note.txt。"),
  "HANG",
  framesForText("项目结构分析完成。"),
];

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    requestBodies.push(JSON.parse(raw));
    const frames = RESPONSES.shift() ?? framesForText("(脚本外请求)");
    if (frames === "HANG") return; // 永不应答：保持任务「进行中」直到进程被杀
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
// Electron 启停（双进程回环）
// ---------------------------------------------------------------------------

let electronProc = null;
function launchElectron(cdpPort, withOpenDirHook) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const env = { ...process.env, DEVWIT_USER_DATA_DIR: userDataDir };
    // 进程二不带给目录钩子：文件树出现即证明工作区来自 session.state 恢复
    if (withOpenDirHook) env.DEVWIT_E2E_OPEN_DIR = fixture;
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    electronProc = proc;
    let stderrBuf = "";
    const timer = setTimeout(() => reject(new Error(`CDP 超时: ${stderrBuf.slice(0, 300)}`)), 30_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`退出 code=${code}`)); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

async function connectPage(ws) {
  const browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  return { browser, page };
}

function listTraceFiles() {
  const dir = path.join(userDataDir, "traces");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

let browser = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  step(`本地 SSE 端点就绪 ${baseUrl}`);

  // ================= 进程一：工作 → 落盘 → kill =================
  let cdpPort = 24100 + Math.floor(Math.random() * 500);
  let ws = await launchElectron(cdpPort, true);
  let connected = await connectPage(ws);
  browser = connected.browser;
  let page = connected.page;
  step("进程一启动（全新 userData）");

  await page.click(".dw-header button:nth-of-type(2)"); // 打开文件夹（E2E 钩子给目录）
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  await page.evaluate(async (url) => {
    await window.devwit.credentials.set("i6-cred", "openai", "sk-i6-fake");
    await window.devwit.providers.upsert({
      id: "i6-local", type: "openai", label: "I6 Local", baseUrl: url,
      model: "i6-model", credentialRef: "i6-cred", maxTokens: 2048,
    });
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "i6-local", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("打开工作区 + provider 注册 + agent 模式热绑定");

  // 任务 A：工具调用 → 授权 → 落盘 → 完成
  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", TASK_A_INTENT);
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  await page.click(".dw-act-authorization >> text=允许");
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  assert(
    fs.existsSync(path.join(fixture, "ac15-note.txt")),
    "任务 A 授权后 write 真实落盘 ac15-note.txt"
  );
  step("任务 A：授权 → write 落盘 → 完成");

  // 任务 B：悬挂请求 → 保持「进行中」
  await page.fill(".dw-task-new .dw-input", TASK_B_INTENT);
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll(".dw-task-row")];
    return rows.length === 2 && rows.some((row) => row.textContent.includes("进行中"));
  }, null, { timeout: 15_000 });
  step("任务 B 创建（SSE 悬挂，保持进行中）");

  // 等持久化防抖（300ms）落盘，再读 session.state 校验
  await page.waitForTimeout(1_000);
  const saved = await page.evaluate(async () => await window.devwit.settings.get("session.state"));
  assert(saved?.tasks?.length === 2, `session.state 持久化 2 个任务（实际: ${saved?.tasks?.length}）`);
  const statusBy = Object.fromEntries((saved?.tasks ?? []).map((task) => [task.title, task.status]));
  assert(statusBy[TASK_A_INTENT] === "done", `任务 A 持久化状态 done（实际: ${statusBy[TASK_A_INTENT]}）`);
  assert(statusBy[TASK_B_INTENT] === "running", `任务 B 持久化状态 running（实际: ${statusBy[TASK_B_INTENT]}）`);
  assert(saved?.workspaceRoot === fixture, "session.state 记录工作区路径");
  assert(saved?.form === "console", "session.state 记录形态为 console");
  const tracesBefore = listTraceFiles();
  assert(tracesBefore.length === 2, `traces/ 落盘 2 份会话轨迹（实际: ${tracesBefore.join(", ") || "无"}）`);
  step("落盘校验：session.state 2 任务 + traces/*.jsonl ×2");
  await page.screenshot({ path: path.join(OUT, "01-before-kill.png") });

  await browser.close();
  browser = null;
  electronProc.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  step("进程一 kill（模拟应用退出）");

  // ================= 进程二：重启 → 恢复 → 续跑 =================
  cdpPort = 24100 + Math.floor(Math.random() * 500);
  ws = await launchElectron(cdpPort, false);
  connected = await connectPage(ws);
  browser = connected.browser;
  page = connected.page;
  step("进程二启动（同 userData，无目录钩子）");

  // 工作区恢复：无任何点击文件树即出现（恢复形态为指挥台时树在 DOM 但不可见，故断言 attached）
  await page.waitForSelector(".dw-tree-node", { state: "attached", timeout: 15_000 });
  step("工作区自动恢复（文件树无操作即现）");

  // 形态恢复为指挥台 + 状态栏恢复提示
  await page.waitForSelector(".dw-console", { state: "visible", timeout: 10_000 });
  const statusText = await page.textContent(".dw-statusbar");
  assert(statusText.includes("已恢复上次会话"), `状态栏提示会话恢复（实际: ${statusText.trim()}）`);

  // 任务列表恢复：A 完成、B 已中断
  await page.waitForFunction(() => document.querySelectorAll(".dw-task-row").length === 2, null, { timeout: 10_000 });
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll(".dw-task-row")].map((row) => ({
      title: row.querySelector(".dw-task-title")?.textContent ?? "",
      badge: row.querySelector(".dw-task-badge")?.textContent ?? "",
    }))
  );
  const badgeOf = (title) => badges.find((row) => row.title.includes(title))?.badge ?? "";
  assert(badgeOf("ac15-note") === "完成", `任务 A 恢复为「完成」（实际: ${badgeOf("ac15-note")}）`);
  assert(badgeOf("长任务") === "已中断", `任务 B 恢复为「已中断」（实际: ${badgeOf("长任务")}）`);
  step("任务列表恢复：A=完成、B=已中断");
  await page.screenshot({ path: path.join(OUT, "02-restored-console.png") });

  // 点击任务 A：活动流从磁盘轨迹完整回放（五类事件）
  await page.click(`.dw-task-row:has-text("ac15-note")`);
  await page.waitForSelector(".dw-act-done", { timeout: 10_000 });
  const actText = await page.textContent(".dw-activity");
  for (const badge of ["用户", "助手", "工具", "授权", "完成"]) {
    assert(actText.includes(badge), `任务 A 回放活动流含「${badge}」行`);
  }
  assert(actText.includes(TASK_A_INTENT), "任务 A 回放含首轮用户意图原文");
  step("任务 A 活动流磁盘回放（五类事件齐全）");
  await page.screenshot({ path: path.join(OUT, "03-task-a-replayed.png") });

  // 续跑任务 B（已中断）：输入可用，发送后服务端断言历史注入
  await page.click(`.dw-task-row:has-text("长任务")`);
  await page.waitForTimeout(400); // activate 异步回放
  const inputDisabled = await page.evaluate(() => document.querySelector(".dw-console .dw-chat-textarea")?.disabled);
  assert(inputDisabled === false, "已中断任务输入框可用（不标 running）");
  const bodiesBefore = requestBodies.length;
  await page.fill(".dw-console .dw-chat-textarea", "继续分析");
  await page.click(".dw-console .dw-chat-input >> text=发送");
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const continueBody = requestBodies[bodiesBefore];
  const historyTexts = (continueBody?.messages ?? []).map((message) => message.content ?? "").join("\n");
  assert(
    historyTexts.includes(TASK_B_INTENT),
    `续跑请求含首轮意图（跨重启记忆注入；实际消息数: ${continueBody?.messages?.length}）`
  );
  assert(historyTexts.includes("继续分析"), "续跑请求含本轮新指令");
  const badgeBAfter = await page.textContent(`.dw-task-row:has-text("长任务") .dw-task-badge`);
  assert((badgeBAfter ?? "").includes("完成"), `任务 B 续跑后「完成」（实际: ${badgeBAfter}）`);
  step("任务 B 续跑：priorHistory 从磁盘重建注入 → 完成");
  await page.screenshot({ path: path.join(OUT, "04-task-b-continued.png") });

  // 轨迹文件追加：任务 B 的 jsonl 现有两轮事件（首轮 user + 本轮 user/assistant/done）
  await page.waitForTimeout(600);
  const traceDump = listTraceFiles().map((name) => ({
    name,
    events: fs.readFileSync(path.join(userDataDir, "traces", name), "utf-8").trim().split("\n").map((line) => JSON.parse(line)),
  }));
  const traceB = traceDump.find((entry) => entry.events.some((event) => event.summary.includes("长任务") || event.detail?.text?.includes("长任务")));
  assert(traceB !== undefined, "任务 B 轨迹文件存在");
  if (traceB !== undefined) {
    const types = traceB.events.map((event) => event.type);
    assert(
      types.join(",") === "user_message,user_message,assistant_message,done",
      `任务 B 轨迹两轮追加且 seq 连续（实际: ${types.join(",")}；seq: ${traceB.events.map((event) => event.seq).join(",")}）`
    );
  }
  fs.writeFileSync(path.join(OUT, "request-bodies.json"), JSON.stringify(requestBodies, null, 2), "utf-8");
  fs.writeFileSync(path.join(OUT, "traces-after-restart.json"), JSON.stringify(traceDump, null, 2), "utf-8");
  step("轨迹文件追加校验 + 证据转储");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i6] 失败:", fatal);
  try { await page?.screenshot({ path: path.join(OUT, "99-failure-state.png") }); } catch { /* 忽略 */ }
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i6-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration6-verification.txt"),
    [
      "迭代 6（AC15 会话持久化）验证：",
      "1. 落盘：轨迹事件 JSONL 逐行追加 userData/traces/<sessionId>.jsonl（实时 onRecord 订阅，详情 detail.text 存完整原文）；会话快照（工作区/任务列表/激活任务/形态/对话 sessionId）防抖 300ms 写 settings \"session.state\"。",
      "2. 恢复：重启后 enterWorkspace 恢复文件树 → TaskCenter.restore 归一 running/waiting_auth 为 interrupted → 对话与激活任务轨迹从磁盘回放（resumed=true 不标 running）→ 形态恢复 → 状态栏提示「已恢复上次会话（N 个任务）」。",
      "3. 跨重启记忆：AiRuntime.ensureSession 先 loadPersisted 水合磁盘轨迹，run 前 historyFromTrace 重建 priorHistory 注入 transcript——续跑请求含首轮意图（本脚本服务端请求体断言）。",
      "4. 中断续跑：interrupted 任务输入可用；user_message 事件使其复活为 running；轨迹文件追加不覆盖（seq 连续）。",
      `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
    ].join("\n"),
    "utf-8"
  );
  if (browser !== null) await browser.close();
  electronProc?.kill();
  server.close();
  if (report.failures.length > 0) {
    console.error(`[verify-i6] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i6-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i6] 全部断言通过，证据已写入 ${OUT}`);
}
