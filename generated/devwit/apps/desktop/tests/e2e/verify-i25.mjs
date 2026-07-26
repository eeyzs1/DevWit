/**
 * 迭代 27 验证脚本（AC36 Agent 可观测性 II，证据落盘 evidence/AC36）：
 * 1. 轨迹时间线：对话任务（chat）后切「轨迹」页签——5 条事件（路由/用户/助手/用量/完成）
 *    带 seq 徽标 + 类型徽标 + 时刻 + 相邻耗时（+Δms），点击展开 detail；
 *    类型过滤（全部 5 / 消息 2 / 工具 0 空态 / 授权 0 / 用量 1 / 失败 0）。
 * 2. 失败定位：指挥台任务（agent write 工具）拒绝授权——该会话轨迹 10 条事件，
 *    授权裁决 deny + 工具结果 ok:false 两条失败高亮；「跳到下一个失败」循环导航；
 *    「失败」过滤只余 2 条；write 未真实写盘（文件保持原样）。
 * 3. 会话回放：traceList IPC 按 lastAt 倒序返回 2 个会话摘要（preview/事件数/hasError）；
 *    活跃会话「回放」禁用；选历史会话进入回放——步进/自动播放至 10/10/重置/退出。
 * 4. 成本估算：设置·通用分区填单价（输入 2 / 输出 8 每百万）→ 用量行热显成本
 *    （累计 0.000508 = chat 0.000148 + agent 0.00036）；summary IPC 同值；
 *    单价表改为他键 → 全组「未定价」（unpricedRuns=2，绝不虚构数字）→ 恢复。
 * 5. i18n 热切换：设置切 English → 页签/过滤/按钮英文文案，切回中文恢复。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（授权门、轨迹落盘、traceList IPC、单价热生效、设置页渲染）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC36");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i25-"));
fs.writeFileSync(path.join(fixture, "note.txt"), "原始内容\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i25-userdata-"));

const CHAT_TASK = "总结一下今天的安排";
const AGENT_TASK = "把 note.txt 改写成两行";
const PROVIDER_KEY = "p-i25 i25-model";

// ---------------------------------------------------------------------------
// 本地端点：按请求序脚本——1: chat 文本；2: agent write 工具；3: agent 收尾文本
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text, usage) => [
  sseChunk({ id: "i25", object: "chat.completion.chunk", created: 0, model: "i25", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i25", object: "chat.completion.chunk", created: 0, model: "i25", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i25", object: "chat.completion.chunk", created: 0, model: "i25", choices: [], usage }),
  "data: [DONE]\n\n",
];
const framesForWrite = (id, usage) => [
  sseChunk({ id: "i25", object: "chat.completion.chunk", created: 0, model: "i25", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: JSON.stringify({ path: "note.txt", content: "第一行\n第二行\n" }) } }] }, finish_reason: null }] }),
  sseChunk({ id: "i25", object: "chat.completion.chunk", created: 0, model: "i25", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  sseChunk({ id: "i25", object: "chat.completion.chunk", created: 0, model: "i25", choices: [], usage }),
  "data: [DONE]\n\n",
];
const SCRIPT = [
  framesForText("今天的安排已总结。", { prompt_tokens: 50, completion_tokens: 6 }), // 1: chat
  framesForWrite("call_i25_1", { prompt_tokens: 40, completion_tokens: 15 }),        // 2: agent 首轮（将被拒绝）
  framesForText("好的，不改写文件。", { prompt_tokens: 60, completion_tokens: 5 }),   // 3: agent 收尾
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i25] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i25] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i25] FAIL: ${message}`);
  }
}
const closeTo = (actual, expected) => typeof actual === "number" && Math.abs(actual - expected) < 1e-9;

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

/** 等待轨迹行数达到预期。 */
async function waitRows(page, expected, timeout = 10_000) {
  await page.waitForFunction(
    (n) => document.querySelectorAll(".dw-trace-row").length === n,
    expected,
    { timeout }
  );
}

/** 用量统计区文本（按「累计」锚点定位——同页还有命令白名单等同 class 容器）。 */
function usageZoneText(page) {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".dw-settings-whitelist")];
    const box = boxes.find((b) => (b.textContent ?? "").includes("累计"));
    return box?.textContent ?? "";
  });
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（脚本化 3 请求，usage 帧 50/6、40/15、60/5）`);

  const cdpPort = 26900 + Math.floor(Math.random() * 300);
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
      id: "p-i25", type: "openai", label: "i25-local", baseUrl: url, model: "i25-model",
      credentialRef: "cred-i25", maxTokens: 2048, keyless: true,
    });
    const modes = await window.devwit.modes.list();
    const agent = modes.find((m) => m.id === "agent");
    const chat = modes.find((m) => m.id === "chat");
    await window.devwit.modes.upsert({ ...agent, providerId: "p-i25", updatedAt: new Date().toISOString() });
    await window.devwit.modes.upsert({ ...chat, providerId: "p-i25", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("keyless provider 注册 + agent/chat 双模式热绑定");

  // ---- 1. 对话任务（chat）→ 活跃会话轨迹 5 条 ----
  await page.waitForSelector(".dw-chat .dw-chat-textarea", { timeout: 10_000 });
  await page.selectOption('select[title="模式"]', "chat");
  await page.fill(".dw-chat .dw-chat-textarea", CHAT_TASK);
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("今天的安排已总结")', { timeout: 30_000 });
  await page.waitForSelector(".dw-msg-done", { timeout: 10_000 });
  step("对话任务完成（活跃会话轨迹：路由/用户/助手/用量/完成 = 5 条）");

  // ---- 2. 轨迹页签：时间线渲染 ----
  await page.click('.dw-side .dw-tab:has-text("轨迹")');
  await waitRows(page, 5);
  const badges = await page.$$eval(".dw-trace-row .dw-trace-badge", (nodes) => nodes.map((n) => n.textContent));
  assert(
    JSON.stringify(badges) === JSON.stringify(["路由", "用户", "助手", "用量", "完成"]),
    `活跃会话 5 条事件类型徽标（实际: ${JSON.stringify(badges)}）`
  );
  const seqs = await page.$$eval(".dw-trace-row", (rows) => rows.map((r) => r.getAttribute("data-seq")));
  assert(JSON.stringify(seqs) === JSON.stringify(["1", "2", "3", "4", "5"]), `seq 徽标单调 1..5（实际: ${seqs}）`);
  const deltaCount = await page.$$eval(".dw-trace-delta", (nodes) => nodes.length);
  assert(deltaCount === 4, `第 2..5 行应有相邻耗时（+Δms）（实际: ${deltaCount}）`);
  const timeText = await page.textContent(".dw-trace-row .dw-trace-time");
  assert(/\d{2}:\d{2}:\d{2}/.test(timeText ?? ""), `行内时刻 HH:MM:SS（实际: ${timeText}）`);
  // 点击展开 detail（用户消息行含 {text}），再点击收起
  await page.click('.dw-trace-row[data-seq="2"]');
  await page.waitForSelector(".dw-trace-detail", { timeout: 5_000 });
  const detailText = await page.textContent(".dw-trace-detail");
  assert((detailText ?? "").includes(CHAT_TASK), `展开 detail 含用户原文（实际: ${(detailText ?? "").slice(0, 80)}）`);
  await page.click('.dw-trace-row[data-seq="2"]');
  await page.waitForSelector(".dw-trace-detail", { state: "detached", timeout: 5_000 });
  step("时间线渲染：徽标/seq/耗时/时刻 + 点击展开收起 detail");

  // ---- 3. 类型过滤（活跃会话）----
  const filterCase = async (value, expectedRows, label) => {
    await page.selectOption(".dw-trace-filter", value);
    if (expectedRows === 0) {
      await page.waitForSelector(".dw-trace-empty", { timeout: 5_000 });
      const emptyText = await page.textContent(".dw-trace-empty");
      assert((emptyText ?? "").includes("暂无轨迹事件"), `过滤「${label}」空态文案（实际: ${emptyText}）`);
    } else {
      await waitRows(page, expectedRows);
      assert(true, `过滤「${label}」→ ${expectedRows} 行`);
    }
  };
  await filterCase("messages", 2, "消息");
  await filterCase("tools", 0, "工具");
  await filterCase("authorization", 0, "授权");
  await filterCase("usage", 1, "用量");
  await filterCase("failures", 0, "失败");
  await page.selectOption(".dw-trace-filter", "all");
  await waitRows(page, 5);
  step("类型过滤：消息 2 / 工具 0 / 授权 0 / 用量 1 / 失败 0（空态）→ 恢复全部 5");

  // 活跃会话「回放」禁用；traceList 此时仅 chat 会话
  const replayDisabledLive = await page.$eval(".dw-trace-replay", (btn) => btn.disabled);
  assert(replayDisabledLive === true, "活跃会话「回放」按钮应禁用");
  const listOnly = await page.evaluate(() => window.devwit.agent.traceList());
  assert(listOnly.length === 1 && listOnly[0].sessionId !== "" && listOnly[0].hasError === false,
    `traceList 仅 chat 会话且无错误（实际: ${JSON.stringify(listOnly)}）`);
  await page.screenshot({ path: path.join(OUT, "01-trace-live-timeline.png") });
  step("活跃会话回放禁用 + traceList 单会话摘要（截图 01）");

  // ---- 4. 指挥台任务（agent write）拒绝授权 → 失败事件 ----
  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", AGENT_TASK);
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "拒绝", exact: true }).click();
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const notWritten = fs.readFileSync(path.join(fixture, "note.txt"), "utf-8");
  assert(notWritten === "原始内容\n", `拒绝授权后 write 未真实写盘（实际: ${JSON.stringify(notWritten)}）`);
  step("指挥台任务：write 授权拒绝 → 任务收尾，文件未改动");

  // ---- 5. traceList：两会话按 lastAt 倒序，agent 会话标 hasError ----
  const traceList = await page.evaluate(() => window.devwit.agent.traceList());
  fs.writeFileSync(path.join(OUT, "trace-list.json"), JSON.stringify(traceList, null, 2), "utf-8");
  assert(traceList.length === 2, `traceList 应有 2 个会话（实际: ${traceList.length}）`);
  const [first, second] = traceList;
  assert(
    first.preview === AGENT_TASK && first.eventCount === 10 && first.hasError === true &&
      second.preview === CHAT_TASK && second.eventCount === 5 && second.hasError === false &&
      first.lastAt >= second.lastAt,
    `traceList 倒序 + 摘要（preview/事件数/hasError）（实际: ${JSON.stringify(traceList)}）`
  );
  step("traceList IPC：agent 会话（10 条 · 有错误）在前，chat 会话（5 条）在后");

  // ---- 6. 历史会话时间线：失败高亮 + 跳转导航 ----
  await page.click(".dw-header >> text=对话");
  await page.click('.dw-side .dw-tab:has-text("轨迹")');
  await waitRows(page, 5); // 默认仍选中活跃 chat 会话
  const agentValue = await page.evaluate((taskText) => {
    const sel = document.querySelector(".dw-trace-session");
    const opt = [...sel.options].find((o) => (o.textContent ?? "").includes(taskText));
    return opt?.value ?? null;
  }, AGENT_TASK);
  assert(agentValue !== null, "会话下拉应含 agent 历史会话");
  await page.selectOption(".dw-trace-session", agentValue);
  await waitRows(page, 10);
  const failSeqs = await page.$$eval(".dw-trace-row.dw-trace-fail", (rows) => rows.map((r) => r.getAttribute("data-seq")));
  assert(failSeqs.length === 2, `agent 会话应有 2 条失败高亮（实际 seq: ${failSeqs}）`);
  await page.click(".dw-trace-jump");
  await page.waitForSelector(".dw-trace-current", { timeout: 5_000 });
  const current1 = await page.$eval(".dw-trace-current", (row) => row.getAttribute("data-seq"));
  await page.click(".dw-trace-jump");
  const current2 = await page.$eval(".dw-trace-current", (row) => row.getAttribute("data-seq"));
  await page.click(".dw-trace-jump");
  const current3 = await page.$eval(".dw-trace-current", (row) => row.getAttribute("data-seq"));
  assert(
    current1 === failSeqs[0] && current2 === failSeqs[1] && current3 === failSeqs[0],
    `失败跳转应循环定位 ${failSeqs[0]}→${failSeqs[1]}→${failSeqs[0]}（实际: ${current1}→${current2}→${current3}）`
  );
  await page.selectOption(".dw-trace-filter", "failures");
  await waitRows(page, 2);
  const failFilterTypes = await page.$$eval(".dw-trace-row .dw-trace-badge", (nodes) => nodes.map((n) => n.textContent));
  assert(
    JSON.stringify(failFilterTypes) === JSON.stringify(["授权裁决", "工具结果"]),
    `「失败」过滤只余授权裁决 + 工具结果（实际: ${JSON.stringify(failFilterTypes)}）`
  );
  await page.selectOption(".dw-trace-filter", "all");
  await waitRows(page, 10);
  await page.screenshot({ path: path.join(OUT, "02-trace-failures.png") });
  step("失败定位：2 条高亮 + 循环跳转 + 「失败」过滤 2 行（截图 02）");

  // ---- 7. 会话回放：步进 / 播放 / 重置 / 退出 ----
  await page.click(".dw-trace-replay");
  await page.waitForSelector(".dw-trace-step", { timeout: 5_000 });
  const progress0 = await page.textContent(".dw-trace-progress");
  assert((progress0 ?? "").trim() === "0 / 10", `回放初始进度 0 / 10（实际: ${progress0}）`);
  const hintVisible = await page.$eval(".dw-trace-empty", (node) => (node.textContent ?? "").includes("回放就绪"));
  assert(hintVisible, "回放初始显示「回放就绪」提示");
  await page.click(".dw-trace-step");
  await waitRows(page, 1);
  await page.click(".dw-trace-step");
  await waitRows(page, 2);
  const progress2 = await page.textContent(".dw-trace-progress");
  assert((progress2 ?? "").trim() === "2 / 10", `步进×2 进度 2 / 10（实际: ${progress2}）`);
  await page.click(".dw-trace-play");
  await page.waitForFunction(
    () => (document.querySelector(".dw-trace-progress")?.textContent ?? "").trim() === "10 / 10",
    null,
    { timeout: 15_000 }
  );
  await waitRows(page, 10);
  await page.screenshot({ path: path.join(OUT, "03-trace-replay.png") });
  await page.click(".dw-trace-reset");
  await page.waitForSelector(".dw-trace-empty", { timeout: 5_000 });
  const progressReset = await page.textContent(".dw-trace-progress");
  assert((progressReset ?? "").trim() === "0 / 10", `重置后进度归零（实际: ${progressReset}）`);
  await page.click(".dw-trace-exit");
  await waitRows(page, 10);
  step("会话回放：步进 1→2，播放至 10/10（截图 03），重置归零，退出回放全量 10 行");

  // ---- 8. 成本估算：设置页填单价 → 用量行热显成本 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.waitForSelector(".dw-settings-pricing-row", { timeout: 10_000 });
  const pricingName = await page.textContent(".dw-settings-pricing-row .dw-settings-pricing-name");
  assert((pricingName ?? "") === PROVIDER_KEY, `单价行应对应当前服务商·型号（实际: ${pricingName}）`);
  // 未配置单价时成本列为空（零噪音）
  const usageTextBefore = await usageZoneText(page);
  assert(usageTextBefore.includes("累计") && !usageTextBefore.includes("成本") && !usageTextBefore.includes("未定价"),
    `未配置单价表时成本列应为空（实际: ${usageTextBefore.slice(0, 200)}）`);
  const priceInputs = await page.$$(".dw-settings-pricing-row .dw-settings-pricing-input");
  await priceInputs[0].fill("2");
  await priceInputs[0].evaluate((node) => node.dispatchEvent(new Event("change")));
  await priceInputs[1].fill("8");
  await priceInputs[1].evaluate((node) => node.dispatchEvent(new Event("change")));
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-settings-whitelist-row")].some((row) => (row.textContent ?? "").includes("成本 0.000508")),
    null,
    { timeout: 10_000 }
  );
  const usageTextPriced = await usageZoneText(page);
  assert(usageTextPriced.includes("成本 0.000508"), `累计行成本 0.000508（实际: ${usageTextPriced.slice(0, 300)}）`);
  assert(usageTextPriced.includes("成本 0.000148") && usageTextPriced.includes("成本 0.00036"),
    `按模式分行成本 chat 0.000148 / agent 0.00036（实际: ${usageTextPriced.slice(0, 400)}）`);
  const pricedSummary = await page.evaluate(() => window.devwit.usage.summary());
  fs.writeFileSync(path.join(OUT, "usage-summary-priced.json"), JSON.stringify(pricedSummary, null, 2), "utf-8");
  assert(closeTo(pricedSummary.total.cost, 0.000508) && pricedSummary.total.unpricedRuns === undefined,
    `summary.total.cost ≈ 0.000508 且无未定价（实际: ${JSON.stringify(pricedSummary.total)}）`);
  const chatCost = pricedSummary.byMode.find((row) => row.modeId === "chat")?.cost;
  const agentCost = pricedSummary.byMode.find((row) => row.modeId === "agent")?.cost;
  assert(closeTo(chatCost, 0.000148) && closeTo(agentCost, 0.00036),
    `byMode 成本 chat ${chatCost} / agent ${agentCost}`);
  await page.screenshot({ path: path.join(OUT, "04-settings-cost.png") });
  step("成本估算：单价热生效，用量行与 summary IPC 同值（截图 04）");

  // ---- 9. 部分覆盖：单价表改为他键 → 全组未定价 ----
  await page.evaluate(() => window.devwit.settings.set("usage.pricing", {
    "other-provider other-model": { inputPerMillion: 1, outputPerMillion: 1 },
  }));
  await page.click('.dw-modal-settings button:has-text("刷新")');
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-settings-whitelist-row")].some((row) => (row.textContent ?? "").includes("未定价")),
    null,
    { timeout: 10_000 }
  );
  const unpricedSummary = await page.evaluate(() => window.devwit.usage.summary());
  fs.writeFileSync(path.join(OUT, "usage-summary-unpriced.json"), JSON.stringify(unpricedSummary, null, 2), "utf-8");
  assert(unpricedSummary.total.cost === undefined && unpricedSummary.total.unpricedRuns === 2,
    `他键单价表：total 无 cost 且 unpricedRuns=2（实际: ${JSON.stringify(unpricedSummary.total)}）`);
  // 恢复正确定价（最终状态 + 截图一致性）
  await page.evaluate((key) => window.devwit.settings.set("usage.pricing", {
    [key]: { inputPerMillion: 2, outputPerMillion: 8 },
  }), PROVIDER_KEY);
  await page.click('.dw-modal-settings button:has-text("刷新")');
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-settings-whitelist-row")].some((row) => (row.textContent ?? "").includes("成本 0.000508")),
    null,
    { timeout: 10_000 }
  );
  step("部分覆盖：他键单价表 → 全组「未定价」（不虚构数字），恢复后成本重现");

  // ---- 10. i18n 热切换：English → 轨迹页英文文案 → 切回中文 ----
  await page.selectOption(".dw-modal-settings select", "en-US");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-settings-nav-item")].some((n) => (n.textContent ?? "") === "General"),
    null,
    { timeout: 5_000 }
  );
  await page.click('.dw-modal-actions >> button:has-text("Close")');
  await page.waitForSelector('.dw-side .dw-tab:has-text("Trace")', { timeout: 5_000 });
  await page.click('.dw-side .dw-tab:has-text("Trace")');
  await waitRows(page, 10); // 语言切换不改选中态：仍停在 agent 历史会话（10 条）
  const enFilterFirst = await page.$eval(".dw-trace-filter option", (opt) => opt.textContent);
  const enJump = await page.textContent(".dw-trace-jump");
  assert(enFilterFirst === "All" && (enJump ?? "") === "Jump to next failure",
    `英文热生效：过滤「All」+ 跳转按钮英文（实际: ${enFilterFirst} / ${enJump}）`);
  await page.screenshot({ path: path.join(OUT, "05-trace-en.png") });
  await page.click(".dw-header >> text=Settings");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.selectOption(".dw-modal-settings select", "zh-CN");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-settings-nav-item")].some((n) => (n.textContent ?? "") === "通用"),
    null,
    { timeout: 5_000 }
  );
  await page.click('.dw-modal-actions >> button:has-text("关闭")');
  await page.waitForSelector('.dw-side .dw-tab:has-text("轨迹")', { timeout: 5_000 });
  step("i18n 热切换：English 文案（截图 05）→ 切回中文恢复");

  // 请求体数审计：3 次调用与脚本对齐（chat 一轮 + agent 两轮）
  assert(chatBodies.length === 3, `服务端应收到 3 次 /chat/completions（实际: ${chatBodies.length}）`);
  fs.writeFileSync(path.join(OUT, "chat-bodies.json"), JSON.stringify(chatBodies, null, 2), "utf-8");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i25] FATAL: ${fatal}`);
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
fs.writeFileSync(path.join(OUT, "verify-i25-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(OUT, "iteration27-verification.txt"),
  [
    "迭代 27（AC36 Agent 可观测性 II）验证：",
    "1. 轨迹时间线：侧栏「轨迹」页签把持久化轨迹渲染为审计时间线——seq 徽标 + 类型徽标 + 时刻 + 相邻耗时（+Δms），点击展开结构化 detail；类型过滤（全部/消息/工具/授权/用量/失败）含空态。",
    "2. 失败定位：授权裁决 deny 与工具结果 ok:false 按 isFailureTraceEvent 同规则高亮；「跳到下一个失败」循环导航；「失败」过滤只余失败行；拒绝授权的工具未真实执行（write 未写盘）。",
    "3. 会话回放：traceList IPC 按 lastAt 倒序返回会话摘要（preview 取首条用户消息 / 事件数 / hasError）；活跃会话实时追加且回放禁用，历史会话进入回放——步进/自动播放（250ms 节奏）/重置/退出，进度 N / total 可见。",
    "4. 成本估算：设置·通用分区「成本单价」按 服务商·型号 配置每百万 tokens 输入/输出单价（存 settings usage.pricing，summary 每次实时读 → 热生效）；用量行追加成本列（累计 0.000508 = chat 0.000148 + agent 0.00036）；单价表未覆盖的记录计入 unpricedRuns 并显示「未定价」，绝不虚构数字；非法单价（负数/非数）按未定价处理（单测覆盖）。",
    "5. i18n：全部新文案词典化（zh-CN/en-US 同型校验），语言热切换后页签/过滤/按钮/空态即时重绘。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);

console.log(`[verify-i25] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
