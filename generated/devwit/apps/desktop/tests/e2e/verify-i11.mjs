/**
 * 迭代 11 验证脚本（AC20 多 Agent 编排，证据落盘 evidence/AC20）：
 * 1. 内置「编排」模式：模式下拉框 option[value=orchestrator] 文案「编排」，
 *    选中后发送意图 → Planner 真实 LLM 调用分解为 2 个子任务（plan 事件入流，
 *    对话区 .dw-msg-plan 展示 S1/S2 清单）；
 * 2. 并行子 Agent：S1(alpha)/S2(beta) 各自完整 AgentLoop（write 工具真实写盘），
 *    .dw-msg-subagent 开始/结束行带 S1/S2 归属徽标；
 * 3. 授权门共享继承：S1 的 write 授权点「本会话允许」→ S2 的 write 不再询问
 *    （授权行恒为 1；服务端门控 beta 首个响应待 alpha 工具结果回填后发出，
 *    断言无竞态）；授权请求 reason 带 [S1] 前缀（归属可见）；
 * 4. 综合阶段：唯一走 delta 通道的流式回复 → .dw-msg-assistant 含综合结论，
 *    done 事件「任务完成（2 个子任务）」；
 * 5. 轨迹事件全量：window 订阅 onEvent 断言 plan/subagent_start×2/subagent_done×2/
 *    子代理 tool_call 带 detail.subagentId，落盘 trace-events.json；
 * 6. 退化路径：第二次意图 Planner 返回非 JSON → plan fallback（.dw-msg-plan 含
 *    「分解失败，按单任务执行原始意图」），单任务跑完，授权行不新增。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 SSE 线协议应答，产品侧链路 100%
 * 真实（Planner 解析、AgentOrchestrator、子引擎工厂、共享 Authorizer、context-engine、
 * IPC、文件系统副作用）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC20");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i11-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello\n", "utf-8");
const ALPHA_FILE = path.join(fixture, "alpha-i11.txt");
const BETA_FILE = path.join(fixture, "beta-i11.txt");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i11-userdata-"));

// ---------------------------------------------------------------------------
// 本地 OpenAI 兼容 SSE 端点：按 system 提示分流 Planner / 子 Agent / 综合
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function framesForText(text) {
  return [
    sseChunk({ id: "i11", object: "chat.completion.chunk", created: 0, model: "i11", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sseChunk({ id: "i11", object: "chat.completion.chunk", created: 0, model: "i11", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({ id: "i11", object: "chat.completion.chunk", created: 0, model: "i11", choices: [], usage: { prompt_tokens: 80, completion_tokens: 20 } }),
    "data: [DONE]\n\n",
  ];
}

function framesForToolCall(name, args) {
  return [
    sseChunk({ id: "i11", object: "chat.completion.chunk", created: 0, model: "i11", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_i11_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    sseChunk({ id: "i11", object: "chat.completion.chunk", created: 0, model: "i11", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({ id: "i11", object: "chat.completion.chunk", created: 0, model: "i11", choices: [], usage: { prompt_tokens: 90, completion_tokens: 10 } }),
    "data: [DONE]\n\n",
  ];
}

const PLAN = JSON.stringify([
  { title: "写入甲标记", prompt: "把标记文本 alpha-done 写入文件 alpha-i11.txt（覆盖式）" },
  { title: "写入乙标记", prompt: "把标记文本 beta-done 写入文件 beta-i11.txt（覆盖式）" },
]);

let plannerCalls = 0;
let alphaToolResultSeen = false;
const betaWaiters = [];
const waitAlphaGate = () =>
  alphaToolResultSeen ? Promise.resolve() : new Promise((resolve) => betaWaiters.push(resolve));
const openAlphaGate = () => {
  alphaToolResultSeen = true;
  for (const resolve of betaWaiters.splice(0)) resolve();
};

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    void (async () => {
      const body = JSON.parse(raw);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const systemText = String(messages.find((m) => m.role === "system")?.content ?? "");
      const userText = messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");
      const hasToolResult = messages.some((m) => m.role === "tool");

      let frames;
      if (systemText.includes("任务分解规划器")) {
        // Planner：第一次返回合法双子任务 JSON；第二次返回非 JSON → 触发 fallback
        plannerCalls += 1;
        frames = framesForText(plannerCalls === 1 ? PLAN : "这个意图没法分解，我直接回答好了。");
      } else if (systemText.includes("你现在是多 Agent 编排中的一个子 Agent")) {
        // 子 Agent（WORKER_PROMPT_SUFFIX 精确短语；orchestrator 模式自身提示仅含「子 Agent」字样，不碰撞）
        if (hasToolResult) {
          if (userText.includes("alpha-i11.txt")) openAlphaGate();
          frames = framesForText("子任务结论：标记已写入。");
        } else if (userText.includes("alpha-i11.txt")) {
          frames = framesForToolCall("write", { path: "alpha-i11.txt", content: "alpha-done\n" });
        } else if (userText.includes("beta-i11.txt")) {
          // 门控：S2 的 write 授权检查严格发生在 S1 写盘完成之后（授权继承断言无竞态）
          await waitAlphaGate();
          frames = framesForToolCall("write", { path: "beta-i11.txt", content: "beta-done\n" });
        } else {
          frames = framesForText("子任务结论：无需工具调用。");
        }
      } else {
        // 综合阶段（orchestrator 模式系统提示，无规划器/工作者标记）
        frames = framesForText("综合结论：甲乙两个标记文件均已写入完成。");
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let i = 0;
      const push = () => {
        if (i >= frames.length) { res.end(); return; }
        res.write(frames[i]);
        i += 1;
        setTimeout(push, 20);
      };
      push();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
});

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i11] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i11] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i11] FAIL: ${message}`);
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

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  step(`本地 SSE 端点就绪 ${baseUrl}（Planner/子Agent/综合 三路分流）`);

  const cdpPort = 22800 + Math.floor(Math.random() * 500);
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
  step("打开文件夹（fixture 工作区）");

  // ---- 0. provider 注册 + 轨迹事件订阅 ----
  await page.evaluate(async (url) => {
    await window.devwit.credentials.set("i11-cred", "openai", "sk-i11-fake");
    await window.devwit.providers.upsert({
      id: "i11-local", type: "openai", label: "I11 Local", baseUrl: url,
      model: "i11-model", credentialRef: "i11-cred", maxTokens: 4096,
    });
    window.__i11Events = [];
    window.devwit.agent.onEvent((event) => window.__i11Events.push(event));
  }, baseUrl);
  await page.selectOption('select[title="模型"]', "i11-local");
  step("provider 注册 + 模型选中 + onEvent 轨迹订阅");

  // ---- 1. 内置「编排」模式可见可选 ----
  const orchestratorOption = await page.textContent('select[title="模式"] option[value="orchestrator"]');
  assert(orchestratorOption?.trim() === "编排", `内置编排模式显示名应为「编排」（实际: ${orchestratorOption}）`);
  await page.selectOption('select[title="模式"]', "orchestrator");
  step("模式下拉框选中「编排」（内置 orchestrator 模式）");

  // ---- 2. 发送意图 → plan 分解可见 ----
  await page.fill(".dw-chat .dw-chat-textarea", "并行写入两个标记文件 alpha 和 beta");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector(".dw-msg-plan", { timeout: 30_000 });
  const planText = await page.textContent(".dw-msg-plan");
  assert(planText?.includes("S1") && planText?.includes("写入甲标记"), `计划项缺 S1 子任务: ${planText}`);
  assert(planText?.includes("S2") && planText?.includes("写入乙标记"), `计划项缺 S2 子任务: ${planText}`);
  step("Planner 分解为 2 个子任务（.dw-msg-plan 展示 S1/S2 清单）");

  // ---- 3. 子 Agent 开始行 + 授权请求（[S1] 归属前缀）----
  await page.waitForSelector(".dw-msg-authorization", { timeout: 30_000 });
  const authText = await page.textContent(".dw-msg-authorization");
  assert(authText?.includes("[S1]"), `授权请求缺 [S1] 归属前缀: ${authText?.slice(0, 160)}`);
  assert(authText?.includes("写入文件"), `授权请求缺 write 理由: ${authText?.slice(0, 160)}`);
  const startRows = await page.$$eval(".dw-msg-subagent", (rows) => rows.map((row) => row.textContent ?? ""));
  assert(startRows.some((text) => text.includes("S1") && text.includes("开始")), "缺 S1 子代理开始行");
  assert(startRows.some((text) => text.includes("S2") && text.includes("开始")), "缺 S2 子代理开始行");
  await page.screenshot({ path: path.join(OUT, "01-plan-and-authorization.png") });
  step("子 Agent S1/S2 开始行可见；S1 write 授权请求带归属前缀（截图 01）");

  // ---- 4. 本会话允许 → S2 不再询问（授权门共享继承）----
  await page.click('.dw-msg-authorization >> text=本会话允许');
  await page.waitForSelector(".dw-msg-done", { timeout: 60_000 });
  const authRowCount = await page.locator(".dw-msg-authorization").count();
  assert(authRowCount === 1, `授权行应为 1（S2 继承免问，实际: ${authRowCount}）`);

  const alphaOk = fs.existsSync(ALPHA_FILE) && fs.readFileSync(ALPHA_FILE, "utf-8").includes("alpha-done");
  const betaOk = fs.existsSync(BETA_FILE) && fs.readFileSync(BETA_FILE, "utf-8").includes("beta-done");
  assert(alphaOk, "alpha-i11.txt 未写入 alpha-done（S1 未真实执行）");
  assert(betaOk, "beta-i11.txt 未写入 beta-done（S2 未真实执行）");
  step("「本会话允许」一次 → S1/S2 双文件真实落盘，S2 授权免问（继承证据）");

  // ---- 5. 子代理结束行 + 综合结论 + done ----
  const subagentRows = await page.$$eval(".dw-msg-subagent", (rows) => rows.map((row) => row.textContent ?? ""));
  assert(subagentRows.filter((text) => text.includes("开始")).length === 2, "子代理开始行应为 2");
  assert(subagentRows.filter((text) => text.includes("结束")).length === 2, "子代理结束行应为 2");
  assert(subagentRows.some((text) => text.includes("S2") && text.includes("结束") && text.includes("completed")), "缺 S2 完成结束行");
  const assistantTexts = await page.$$eval(".dw-msg-assistant", (rows) => rows.map((row) => row.textContent ?? ""));
  assert(assistantTexts.some((text) => text.includes("综合结论")), "缺综合阶段流式最终答复");
  const doneText = await page.textContent(".dw-msg-done");
  assert(doneText?.includes("任务完成（2 个子任务）"), `done 行缺子任务计数: ${doneText}`);
  await page.screenshot({ path: path.join(OUT, "02-orchestration-done.png") });
  step("S1/S2 结束行（completed）+ 综合结论 + done（2 个子任务）（截图 02）");

  // ---- 6. 轨迹事件全量断言（plan/subagent 归属标记）----
  const events = await page.evaluate(() => window.__i11Events);
  fs.writeFileSync(path.join(OUT, "trace-events.json"), JSON.stringify(events, null, 2), "utf-8");
  const types = events.map((event) => event.type);
  const planEvents = events.filter((event) => event.type === "plan");
  assert(planEvents.length === 1 && planEvents[0].detail?.subtasks?.length === 2, "plan 事件应含 2 个子任务明细");
  assert(types.filter((type) => type === "subagent_start").length === 2, "subagent_start 应为 2");
  assert(types.filter((type) => type === "subagent_done").length === 2, "subagent_done 应为 2");
  const subToolCalls = events.filter((event) => event.type === "tool_call" && typeof event.detail?.subagentId === "string");
  assert(subToolCalls.length >= 2, "子代理 tool_call 应带 detail.subagentId 归属标记");
  const subAuth = events.find((event) => event.type === "authorization_request");
  assert(typeof subAuth?.detail?.subagentId === "string", "授权请求事件应带 subagentId");
  const s1Done = events.find((event) => event.type === "subagent_done" && event.detail?.subagentId === "S1");
  assert(s1Done?.detail?.finishReason === "completed", `S1 结束态应为 completed（实际: ${s1Done?.detail?.finishReason}）`);
  step("轨迹事件落盘 trace-events.json：plan/subagent/tool_call 归属标记全量");

  // ---- 7. 退化路径：Planner 非 JSON → fallback 单任务 ----
  await page.fill(".dw-chat .dw-chat-textarea", "写一段项目说明");
  await page.click(".dw-chat >> text=发送");
  await page.waitForFunction(
    (count) => document.querySelectorAll(".dw-msg-plan").length >= count,
    2,
    { timeout: 30_000 }
  );
  const planTexts = await page.$$eval(".dw-msg-plan", (rows) => rows.map((row) => row.textContent ?? ""));
  assert(planTexts[1]?.includes("分解失败，按单任务执行原始意图"), `第二轮应触发 fallback 计划项: ${planTexts[1]}`);
  await page.waitForFunction(
    (count) => document.querySelectorAll(".dw-msg-done").length >= count,
    2,
    { timeout: 60_000 }
  );
  const authRowFinal = await page.locator(".dw-msg-authorization").count();
  assert(authRowFinal === 1, `fallback 单任务无写操作，授权行应仍为 1（实际: ${authRowFinal}）`);
  const doneTexts = await page.$$eval(".dw-msg-done", (rows) => rows.map((row) => row.textContent ?? ""));
  assert(doneTexts[1]?.includes("任务完成（1 个子任务）"), `fallback done 应为 1 个子任务: ${doneTexts[1]}`);
  await page.screenshot({ path: path.join(OUT, "03-plan-fallback.png") });
  step("Planner 非 JSON → fallback 单任务跑完（截图 03）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i11] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i11-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration11-verification.txt"),
    [
      "迭代 11（AC20 多 Agent 编排）验证：",
      "1. 内置「编排」模式：模式下拉框 option[value=orchestrator] 文案「编排」（displayModeName 本地化）；选中后发送意图，AgentOrchestrator 接管（ai-runtime orchestrate 分支）。",
      "2. Planner 分解：PLANNER_SYSTEM_PROMPT 非流式调用返回 2 子任务 JSON → parsePlannedTasks 解析 → plan 事件入轨迹（detail.subtasks 全量），对话区 .dw-msg-plan 展示 S1/S2 清单（截图 01）。",
      "3. 并行子 Agent：S1(alpha)/S2(beta) 各自完整 AgentLoop（独立子引擎工厂 createSubEngine，worker 系统提示后缀明确角色），write 工具真实写盘 alpha-i11.txt/beta-i11.txt（文件内容证据）；.dw-msg-subagent 开始/结束行带 S1/S2 归属徽标与 finishReason。",
      "4. 授权门共享继承：S1 write 授权请求 reason 带 [S1] 前缀（chat-controller 按 detail.subagentId 前缀化）；点「本会话允许」→ sessionAllowed 加 write → S2 write 免问（服务端门控保证 S2 授权检查严格在 S1 写盘后，断言无竞态），全程授权行恒为 1。",
      "5. 综合阶段：唯一走 onAssistantDelta 通道的流式回复 → .dw-msg-assistant 含「综合结论」；trace.record(assistant_message) 存档；done 事件「任务完成（2 个子任务）」。",
      "6. 轨迹事件：onEvent 订阅全量落盘 trace-events.json——plan×1（subtasks=2）/subagent_start×2/subagent_done×2（finishReason=completed）/子代理 tool_call 带 detail.subagentId/授权请求带 subagentId。",
      "7. 退化路径：第二次意图 Planner 返回非 JSON → parsePlannedTasks null → fallback 单任务（plan 事件 fallback=true，.dw-msg-plan「分解失败，按单任务执行原始意图」），单 AgentLoop 跑完，done「任务完成（1 个子任务）」，无新增授权行（截图 03）。",
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
    console.error(`[verify-i11] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i11-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i11] 全部断言通过，证据已写入 ${OUT}`);
}
