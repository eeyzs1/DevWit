/**
 * 迭代 24 验证脚本（AC33 模式自进化推荐，证据落盘 evidence/AC33）：
 * 1. 定级语义：指挥台任务1（agent，write 授权真实写盘 + done）→ 成功率统计落
 *    settings modes.stats（agent 1/1）；纯文本 chat 任务同样定级（chat 1/1）；
 * 2. 门槛闸：任务2（chat 相似意图）命中工作流模板，但 agent 仅 1 次定级
 *    （< MIN_RUNS_FOR_RECOMMEND=3）→ 不推荐（无 mode_recommend 事件/推荐行）；
 * 3. 推荐触发：任务3/4（agent 非相似意图）补齐定级至 3/3 后，任务5（chat 相似意图）
 *    再次命中模板 → mode_recommend 事件落轨迹（successRate/runs/当前率明细可审计），
 *    对话面板推荐行可见（成功率 + 一键切换按钮）；
 * 4. 采纳语义：点击「切换到智能体」→ 推荐行转「已采纳」，对话面板模式下拉变 agent；
 *    后续消息真实以 agent 定级（agent 4/4，chat 仍 2/2——切换生效的统计证据）；
 * 5. 透明性：设置·模式分区行内展示成功率（agent 100%（3/3 次定级））——
 *    推荐依据的数据源用户可见。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（write 写盘、授权门、统计定级、推荐事件、面板交互）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC33");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i22-"));
fs.writeFileSync(path.join(fixture, "login.ts"), "export function login() {\n  return true;\n}\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i22-userdata-"));

const TASK1 = "为 login.ts 加输入校验";       // agent 指挥台：沉淀模板（modeId=agent），agent 1/1
const TASK2 = "为 login.ts 补输入校验的单测";  // chat 相似：命中模板但 agent<3 → 不推荐，chat 1/1
const TASK3 = "优化日志输出的格式";            // agent 不相似：agent 2/2
const TASK4 = "检查类型定义的完整性";          // agent 不相似：agent 3/3
const TASK5 = "为 login.ts 的输入校验写测试";  // chat 相似：命中 + agent 3/3 ≥ chat 1/1 → 推荐
const FILE_ARG = "login.ts";

// ---------------------------------------------------------------------------
// 本地端点：按请求序脚本——任务1: write → 文本收尾；其余: 文本（捕获请求体审计）
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForWrite = (id) => [
  sseChunk({ id: "i22", object: "chat.completion.chunk", created: 0, model: "i22", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: JSON.stringify({ path: FILE_ARG, content: "export function login(name?: string) {\n  if (!name) throw new Error(\"name required\");\n  return true;\n}\n" }) } }] }, finish_reason: null }] }),
  sseChunk({ id: "i22", object: "chat.completion.chunk", created: 0, model: "i22", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  sseChunk({ id: "i22", object: "chat.completion.chunk", created: 0, model: "i22", choices: [], usage: { prompt_tokens: 50, completion_tokens: 8 } }),
  "data: [DONE]\n\n",
];
const framesForText = (text) => [
  sseChunk({ id: "i22", object: "chat.completion.chunk", created: 0, model: "i22", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i22", object: "chat.completion.chunk", created: 0, model: "i22", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i22", object: "chat.completion.chunk", created: 0, model: "i22", choices: [], usage: { prompt_tokens: 50, completion_tokens: 6 } }),
  "data: [DONE]\n\n",
];
const SCRIPT = [
  framesForWrite("call_i22_1"), // 1: 任务1 首轮
  framesForText("已加输入校验。"), // 2: 任务1 收尾
  framesForText("已补充单测。"),   // 3: 任务2（chat）
  framesForText("已优化日志。"),   // 4: 任务3（agent）
  framesForText("已检查类型。"),   // 5: 任务4（agent）
  framesForText("已写好测试。"),   // 6: 任务5（chat，推荐触发轮）
  framesForText("继续完成。"),     // 7: 采纳推荐后的后续消息（应以 agent 定级）
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i22] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i22] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i22] FAIL: ${message}`);
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

const getStats = (page) => page.evaluate(async () => window.devwit.settings.get("modes.stats"));
const statEntry = (stats, modeId) => (Array.isArray(stats) ? stats.find((item) => item.modeId === modeId) : undefined);

/** 等待某模式定级数达标（assistant 文本显示时主进程 finally 块定级可能尚未落盘，Node 侧轮询兜底）。 */
async function waitStats(page, modeId, runs) {
  const deadline = Date.now() + 10_000;
  let stats = await getStats(page);
  while (Date.now() < deadline) {
    const entry = statEntry(stats, modeId);
    if (entry !== undefined && entry.runs >= runs) return stats;
    await new Promise((resolve) => setTimeout(resolve, 150));
    stats = await getStats(page);
  }
  return stats;
}

/** 指挥台跑一个任务到 done（活动流视图），返回活动流全文。 */
async function runConsoleTask(page, intent) {
  await page.fill(".dw-task-new .dw-input", intent);
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  return page.$$eval(".dw-act", (rows) => rows.map((row) => row.textContent ?? "").join("\n"));
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（脚本化 7 请求）`);

  const cdpPort = 26200 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开（login.ts 就位）");

  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({
      id: "p-i22", type: "openai", label: "i22-local", baseUrl: url, model: "i22-model",
      credentialRef: "cred-i22", maxTokens: 2048, keyless: true,
    });
    const modes = await window.devwit.modes.list();
    const agent = modes.find((m) => m.id === "agent");
    const chat = modes.find((m) => m.id === "chat");
    await window.devwit.modes.upsert({ ...agent, providerId: "p-i22", updatedAt: new Date().toISOString() });
    await window.devwit.modes.upsert({ ...chat, providerId: "p-i22", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("keyless provider 注册 + agent/chat 双模式热绑定");

  // ---- 任务 1（指挥台 agent）：write 成功 → 模板沉淀 + agent 1/1 ----
  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", TASK1);
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "允许", exact: true }).click();
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const written = fs.readFileSync(path.join(fixture, FILE_ARG), "utf-8");
  assert(written.includes("name required"), `任务1 write 真实写盘（实际: ${JSON.stringify(written.slice(0, 60))}）`);
  const templates1 = await page.evaluate(async () => window.devwit.settings.get("workflow.templates"));
  assert(
    Array.isArray(templates1) && templates1.length === 1 && templates1[0].modeId === "agent",
    `任务1 成功沉淀模板且 modeId=agent（实际: ${JSON.stringify(templates1)}）`
  );
  let stats = await getStats(page);
  let agentStat = statEntry(stats, "agent");
  assert(
    agentStat !== undefined && agentStat.runs === 1 && agentStat.successes === 1,
    `定级：completed 记成功 → agent 1/1（实际: ${JSON.stringify(stats)}）`
  );
  step("任务1 完成：模板沉淀（modeId=agent）+ 统计 agent 1/1");

  // ---- 任务 2（对话 chat 相似意图）：命中模板但 agent<3 → 不推荐 ----
  await page.click(".dw-header >> text=对话");
  await page.waitForSelector(".dw-chat .dw-chat-textarea", { timeout: 10_000 });
  await page.selectOption('select[title="模式"]', "chat");
  await page.fill(".dw-chat .dw-chat-textarea", TASK2);
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("已补充单测")', { timeout: 30_000 });
  await page.waitForSelector(".dw-msg-workflow", { timeout: 10_000 });
  const noRecommendYet = await page.$$(".dw-msg-modeRecommend");
  assert(noRecommendYet.length === 0, `门槛闸：agent 仅 1 次定级（<3）→ 无推荐行（实际: ${noRecommendYet.length} 行）`);
  stats = await waitStats(page, "chat", 1);
  const chatStat1 = statEntry(stats, "chat");
  assert(
    chatStat1 !== undefined && chatStat1.runs === 1 && chatStat1.successes === 1,
    `chat 纯文本 completed 同样定级 → chat 1/1（实际: ${JSON.stringify(stats)}）`
  );
  step("任务2（chat 相似）：命中模板有复用行，但低于门槛不推荐；chat 1/1");

  // ---- 任务 3/4（指挥台 agent 非相似意图）：补齐定级至 3/3 ----
  await page.click(".dw-header >> text=指挥台");
  const stream3 = await runConsoleTask(page, TASK3);
  assert(!stream3.includes("复用相似成功任务") && !stream3.includes("模式推荐"), "任务3 非相似意图：无工作流复用/推荐行");
  const stream4 = await runConsoleTask(page, TASK4);
  assert(!stream4.includes("复用相似成功任务") && !stream4.includes("模式推荐"), "任务4 非相似意图：无工作流复用/推荐行");
  stats = await getStats(page);
  agentStat = statEntry(stats, "agent");
  assert(
    agentStat !== undefined && agentStat.runs === 3 && agentStat.successes === 3,
    `任务3/4 后 agent 3/3（实际: ${JSON.stringify(stats)}）`
  );
  step("任务3/4（agent 非相似）：定级补齐 agent 3/3，无误命中");

  // ---- 任务 5（对话 chat 相似意图）：命中 + 统计达标 → 推荐触发 ----
  await page.click(".dw-header >> text=对话");
  await page.fill(".dw-chat .dw-chat-textarea", TASK5);
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("已写好测试")', { timeout: 30_000 });
  await page.waitForSelector(".dw-msg-modeRecommend", { timeout: 10_000 });
  const recommendText = await page.textContent(".dw-msg-modeRecommend");
  assert(
    recommendText.includes("智能体") && recommendText.includes("100%") && recommendText.includes("3 次定级") &&
      recommendText.includes("对话") && recommendText.includes(TASK1),
    `推荐行应含候选模式/成功率/定级数/当前模式/模板意图（实际: ${recommendText.slice(0, 200)}）`
  );
  const switchBtn = page.locator(".dw-msg-modeRecommend button", { hasText: "切换到智能体" });
  assert((await switchBtn.count()) === 1, "推荐行应有一键切换按钮「切换到智能体」");
  await page.screenshot({ path: path.join(OUT, "01-mode-recommend.png") });
  step("任务5（chat 相似）：推荐行可见（智能体 100%（3 次定级）vs 对话 100%）+ 切换按钮");

  // 轨迹审计：mode_recommend ×1，明细可回放
  const tracesDir = path.join(userDataDir, "traces");
  const traceFiles = fs.readdirSync(tracesDir).filter((name) => name.endsWith(".jsonl"));
  const events = traceFiles.flatMap((name) =>
    fs.readFileSync(path.join(tracesDir, name), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  );
  const recommendEvents = events.filter((e) => e.type === "mode_recommend");
  const detail = recommendEvents[0]?.detail ?? {};
  assert(
    recommendEvents.length === 1 && detail.phase === "recommend" && detail.reason === "workflow_hit" &&
      detail.modeId === "agent" && detail.currentModeId === "chat" &&
      detail.successRate === 1 && detail.currentSuccessRate === 1 && detail.runs === 3 && detail.intent === TASK1,
    `轨迹 mode_recommend×1 且明细正确（实际: ${JSON.stringify({ count: recommendEvents.length, detail })}）`
  );
  fs.writeFileSync(path.join(OUT, "trace-mode-recommend.json"), JSON.stringify(recommendEvents, null, 2), "utf-8");
  step("磁盘轨迹审计：mode_recommend×1（agent over chat，1.0 vs 1.0，3 次定级）");

  // ---- 采纳：一键切换 → 已采纳 + 下拉变 agent + 后续消息以 agent 定级 ----
  await switchBtn.click();
  await page.waitForSelector(".dw-msg-modeRecommend .dw-auth-decided", { timeout: 5_000 });
  const decidedText = await page.textContent(".dw-msg-modeRecommend .dw-auth-decided");
  assert(decidedText.includes("已采纳"), `切换后推荐行应转「已采纳」（实际: ${decidedText}）`);
  const modeAfterSwitch = await page.inputValue('select[title="模式"]');
  assert(modeAfterSwitch === "agent", `采纳后对话面板模式下拉应为 agent（实际: ${modeAfterSwitch}）`);
  await page.screenshot({ path: path.join(OUT, "02-recommend-adopted.png") });
  step("采纳闭环：推荐行「已采纳」+ 面板模式下拉切到 agent");

  // 设置页·模式分区：成功率行内显示（推荐透明性，此刻 agent 3/3、chat 2/2）
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav-item >> text=模式");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-modal-list-item")].some((row) => (row.textContent ?? "").includes("成功率")),
    null,
    { timeout: 5_000 }
  );
  const modeRows = await page.$$eval(".dw-modal-list-item", (rows) => rows.map((row) => row.textContent ?? "").join("\n"));
  assert(
    modeRows.includes("成功率 100%（3/3 次定级）") && modeRows.includes("成功率 100%（2/2 次定级）"),
    `设置·模式分区应行内显示 agent 3/3 与 chat 2/2 成功率（实际: ${modeRows.slice(0, 300)}）`
  );
  await page.screenshot({ path: path.join(OUT, "03-settings-mode-stats.png") });
  await page.click(".dw-modal-settings >> text=关闭");
  step("设置·模式分区：agent「成功率 100%（3/3 次定级）」/ chat「（2/2）」行内可见");

  // 后续消息：采纳后真实以 agent 定级（agent 3/3→4/4，chat 停留 2/2 = 切换生效的统计证据）
  await page.fill(".dw-chat .dw-chat-textarea", "继续");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("继续完成")', { timeout: 30_000 });
  stats = await waitStats(page, "agent", 4);
  const agentFinal = statEntry(stats, "agent");
  const chatFinal = statEntry(stats, "chat");
  assert(
    agentFinal !== undefined && agentFinal.runs === 4 && agentFinal.successes === 4 &&
      chatFinal !== undefined && chatFinal.runs === 2 && chatFinal.successes === 2,
    `采纳后后续消息应以 agent 定级（agent 4/4，chat 2/2）（实际: ${JSON.stringify(stats)}）`
  );
  fs.writeFileSync(path.join(OUT, "modes-stats-final.json"), JSON.stringify(stats, null, 2), "utf-8");
  step("切换生效验证：后续消息定级 agent 4/4（chat 停留 2/2）");

  // 请求体数审计：7 次调用与脚本对齐（任务1 两轮 + 任务2/3/4/5/后续 各一轮）
  assert(chatBodies.length === 7, `服务端应收到 7 次 /chat/completions（实际: ${chatBodies.length}）`);
  fs.writeFileSync(path.join(OUT, "chat-bodies.json"), JSON.stringify(chatBodies, null, 2), "utf-8");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i22] FATAL: ${fatal}`);
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
fs.writeFileSync(path.join(OUT, "verify-i22-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(OUT, "iteration24-verification.txt"),
  [
    "迭代 24（AC33 模式自进化推荐）验证：",
    "1. 定级语义：completed 记成功——指挥台 agent 任务（write 授权真实写盘）与对话 chat 纯文本任务均真实定级，settings modes.stats 落盘（热更新）。",
    "2. 门槛闸：agent 仅 1 次定级（< MIN_RUNS_FOR_RECOMMEND=3）时，chat 相似任务虽命中工作流模板但不发推荐——防单次侥幸。",
    "3. 推荐触发：agent 补齐 3/3 后，chat 相似任务命中模板 → mode_recommend 事件落磁盘轨迹（phase/reason=workflow_hit/双模式成功率/定级数/模板意图明细可回放），对话面板推荐行可见。",
    "4. 采纳语义：一键「切换到智能体」→ 推荐行转「已采纳」、面板模式下拉变 agent；后续消息真实以 agent 定级（agent 3/3→4/4，chat 停留 2/2——统计证据证切换生效）。建议非自动切换，采纳与否始终由用户决定。",
    "5. 透明性：设置·模式分区行内展示各模式成功率（agent 100%（3/3 次定级）/ chat 100%（2/2 次定级））——推荐依据的数据源用户可见。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);

console.log(`[verify-i22] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
