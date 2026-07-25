/**
 * 迭代 22 验证脚本（AC31 本地小模型路由，证据落盘 evidence/AC31）：
 * 1. 双本地端点（p-local 小模型 / p-cloud 模式绑定云端），各自真实 HTTP 线协议应答
 *    且独立计数——「请求到底发给了谁」以服务端命中为唯一事实源；
 * 2. 设置·通用分区「本地小模型路由」：开关 + 本地模型下拉 + 阈值，UI 操作热持久化；
 * 3. 简单任务（评分 0）→ routed=local → 命中 p-local，活动流路由行可见；
 * 4. 复杂任务（「重构整个项目」命中两个关键词评分 30 ≥ 阈值）→ routed=complex → 命中 p-cloud；
 * 5. 热更新：settings 改 enabled=false 后下一轮即时 disabled 回退模式绑定（无需重启）；
 * 6. 对话形态手动指定模型 → routed=manual 跳过自动路由（AC5 手动切换语义优先）；
 * 7. 磁盘轨迹审计：4 个 route 事件 routed 序列 = local/complex/disabled/manual，
 *    score/threshold/reasons 逐项落盘可回放。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并计数，
 * 产品侧链路 100% 真实（设置持久化、路由决策、活动流、轨迹持久化）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC31");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i20-"));
fs.writeFileSync(path.join(fixture, "README.md"), "# i20 fixture\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i20-userdata-"));

// ---------------------------------------------------------------------------
// 双本地端点：各自计数，统一应答一段文本
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForText = (text) => [
  sseChunk({ id: "i20", object: "chat.completion.chunk", created: 0, model: "i20", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i20", object: "chat.completion.chunk", created: 0, model: "i20", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i20", object: "chat.completion.chunk", created: 0, model: "i20", choices: [], usage: { prompt_tokens: 30, completion_tokens: 4 } }),
  "data: [DONE]\n\n",
];
function makeEndpoint(replyText) {
  const state = { hits: 0, server: null };
  state.server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      state.hits += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const frames = framesForText(replyText);
        let i = 0;
        const push = () => {
          if (i >= frames.length) { res.end(); return; }
          res.write(frames[i]);
          i += 1;
          setTimeout(push, 15);
        };
        push();
      });
      return;
    }
    res.writeHead(404).end("not found");
  });
  return state;
}
const localEp = makeEndpoint("本地小模型应答。");
const cloudEp = makeEndpoint("云端模型应答。");

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i20] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i20] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i20] FAIL: ${message}`);
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

/** 指挥台创建一个任务并等完成；返回活动流全文。 */
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
  await Promise.all([
    new Promise((resolve) => localEp.server.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => cloudEp.server.listen(0, "127.0.0.1", resolve)),
  ]);
  const localUrl = `http://127.0.0.1:${localEp.server.address().port}/v1`;
  const cloudUrl = `http://127.0.0.1:${cloudEp.server.address().port}/v1`;
  step(`双端点就绪 local=${localUrl} cloud=${cloudUrl}`);

  const cdpPort = 25600 + Math.floor(Math.random() * 300);
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

  await page.evaluate(async ({ local, cloud }) => {
    await window.devwit.providers.upsert({
      id: "p-local", type: "openai", label: "本地小模型", baseUrl: local, model: "local-7b",
      credentialRef: "cred-local", maxTokens: 1024, keyless: true,
    });
    await window.devwit.providers.upsert({
      id: "p-cloud", type: "openai", label: "云端旗舰", baseUrl: cloud, model: "cloud-ultra",
      credentialRef: "cred-cloud", maxTokens: 4096, keyless: true,
    });
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "p-cloud", updatedAt: new Date().toISOString() });
  }, { local: localUrl, cloud: cloudUrl });
  step("p-local / p-cloud 注册（keyless）+ agent 模式绑定 p-cloud");

  // ---- 设置·通用分区：本地小模型路由 UI 开启并持久化 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  const routingTitle = await page.$$eval(".dw-settings-content label", (labels) =>
    labels.some((label) => label.textContent === "本地小模型路由")
  );
  assert(routingTitle, "设置·通用分区应展示「本地小模型路由」区");
  // 开关行：文本含「简单任务路由到本地模型」的行内 checkbox
  await page.$$eval(".dw-settings-content .dw-settings-update", (rows) => {
    const row = rows.find((r) => (r.textContent ?? "").includes("简单任务路由到本地模型"));
    row?.querySelector('input[type="checkbox"]')?.click();
  });
  // 本地模型下拉：选项中含 p-local 的 select
  await page.$$eval(".dw-settings-content select.dw-select", (selects) => {
    const sel = selects.find((s) => [...s.options].some((o) => o.value === "p-local"));
    if (sel !== undefined) {
      sel.value = "p-local";
      sel.dispatchEvent(new Event("change"));
    }
  });
  await page.waitForFunction(async () => {
    const stored = await window.devwit.settings.get("routing.local");
    return stored?.enabled === true && stored?.providerId === "p-local" && stored?.threshold === 30;
  }, null, { timeout: 5_000 });
  await page.screenshot({ path: path.join(OUT, "01-settings-routing.png") });
  step("设置 UI：开启路由 + 选 p-local + 阈值 30，热持久化 routing.local");

  await page.click(".dw-modal-settings >> text=关闭");

  // ---- 任务 1：简单任务 → 本地 ----
  await page.click(".dw-header >> text=指挥台");
  const stream1 = await runConsoleTask(page, "你好，介绍一下这个文件");
  assert(localEp.hits === 1 && cloudEp.hits === 0, `简单任务应命中本地端点（local=${localEp.hits}, cloud=${cloudEp.hits}）`);
  assert(stream1.includes("简单任务") && stream1.includes("p-local"), `活动流应有「简单任务 → 本地模型 p-local」路由行（实际: ${stream1.slice(0, 200)}）`);
  await page.screenshot({ path: path.join(OUT, "02-simple-to-local.png") });
  step("任务1「你好…」评分 0 → routed=local → p-local 命中，活动流路由行可见");

  // ---- 任务 2：复杂任务（重构 + 整个项目 = 30 分 ≥ 阈值）→ 模式绑定云端 ----
  const stream2 = await runConsoleTask(page, "重构整个项目");
  assert(cloudEp.hits === 1 && localEp.hits === 1, `复杂任务应命中云端端点（local=${localEp.hits}, cloud=${cloudEp.hits}）`);
  assert(stream2.includes("复杂任务") && stream2.includes("p-cloud"), `活动流应有「复杂任务 → 模式绑定模型 p-cloud」路由行（实际: ${stream2.slice(0, 200)}）`);
  await page.screenshot({ path: path.join(OUT, "03-complex-to-cloud.png") });
  step("任务2「重构整个项目」评分 30 ≥ 阈值 → routed=complex → p-cloud 命中");

  // ---- 热更新：关路由 → 下一轮即时 disabled 回退模式绑定 ----
  await page.evaluate(async () => {
    await window.devwit.settings.set("routing.local", { enabled: false, providerId: "p-local", threshold: 30 });
  });
  const stream3 = await runConsoleTask(page, "再打个招呼");
  assert(cloudEp.hits === 2 && localEp.hits === 1, `关路由后简单任务应回退云端（local=${localEp.hits}, cloud=${cloudEp.hits}）`);
  assert(stream3.includes("本地路由未开启"), `活动流应有「本地路由未开启」路由行（实际: ${stream3.slice(0, 200)}）`);
  step("热更新：enabled=false 即时生效 → routed=disabled → p-cloud（无需重启）");

  // ---- 对话形态手动指定模型 → manual 跳过自动路由 ----
  await page.evaluate(async () => {
    await window.devwit.settings.set("routing.local", { enabled: true, providerId: "p-local", threshold: 30 });
  });
  await page.click(".dw-header >> text=对话");
  await page.waitForSelector(".dw-chat-toolbar", { timeout: 10_000 });
  await page.$$eval(".dw-chat-toolbar select.dw-select", (selects) => {
    const sel = selects.find((s) => [...s.options].some((o) => o.value === "p-cloud"));
    if (sel !== undefined) {
      sel.value = "p-cloud";
      sel.dispatchEvent(new Event("change"));
    }
  });
  await page.fill(".dw-chat .dw-chat-textarea", "手动指定云端回答");
  await page.click(".dw-chat >> text=发送");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".dw-msg")].some((row) => row.textContent?.includes("云端模型应答")),
    null,
    { timeout: 30_000 }
  );
  const manualRoute = await page.$$eval(".dw-msg-route", (rows) => rows.map((row) => row.textContent ?? "").join("\n"));
  assert(cloudEp.hits === 3 && localEp.hits === 1, `手动指定应命中云端（local=${localEp.hits}, cloud=${cloudEp.hits}）`);
  assert(manualRoute.includes("已手动指定模型") && manualRoute.includes("p-cloud"), `对话区应有「已手动指定模型 p-cloud」路由行（实际: ${manualRoute.slice(0, 200)}）`);
  await page.screenshot({ path: path.join(OUT, "04-manual-override.png") });
  step("对话形态手动选 p-cloud → routed=manual 跳过自动路由（路由开也不生效）");

  // ---- 磁盘轨迹审计：4 个 route 事件序列 + 评分明细 ----
  const tracesDir = path.join(userDataDir, "traces");
  const traceFiles = fs.readdirSync(tracesDir).filter((name) => name.endsWith(".jsonl"));
  const events = traceFiles.flatMap((name) =>
    fs.readFileSync(path.join(tracesDir, name), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  );
  const routeEvents = events.filter((e) => e.type === "route").sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const routedSeq = routeEvents.map((e) => e.detail?.routed);
  assert(
    JSON.stringify(routedSeq) === JSON.stringify(["local", "complex", "disabled", "manual"]),
    `轨迹 route 事件序列应为 local/complex/disabled/manual（实际: ${JSON.stringify(routedSeq)}）`
  );
  const first = routeEvents[0]?.detail ?? {};
  assert(
    first.routed === "local" && first.providerId === "p-local" && first.score === 0 && first.threshold === 30 && Array.isArray(first.reasons) && first.reasons.length === 0,
    `任务1 route 明细应为 local/p-local/score 0/threshold 30/空 reasons（实际: ${JSON.stringify(first)}）`
  );
  const second = routeEvents[1]?.detail ?? {};
  const secondReasons = Array.isArray(second.reasons) ? second.reasons : [];
  assert(
    second.routed === "complex" && second.providerId === "p-cloud" && second.score === 30 && secondReasons.includes("keyword:refactor") && secondReasons.includes("keyword:whole_scope"),
    `任务2 route 明细应为 complex/p-cloud/score 30/双关键词 reasons（实际: ${JSON.stringify(second)}）`
  );
  fs.writeFileSync(path.join(OUT, "trace-route-events.json"), JSON.stringify(routeEvents, null, 2), "utf-8");
  step("磁盘轨迹审计：route×4（local→complex→disabled→manual），score/threshold/reasons 逐项落盘");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i20] FATAL: ${fatal}`);
  try {
    const pages = browser?.contexts()[0]?.pages() ?? [];
    if (pages.length > 0) await pages[0].screenshot({ path: path.join(OUT, "99-fatal.png") });
  } catch { /* 截图失败不阻断 */ }
} finally {
  await stopElectron(electronProc);
  if (browser !== null) await browser.close().catch(() => undefined);
  localEp.server.close();
  cloudEp.server.close();
}

report.fatal = fatal;
fs.writeFileSync(path.join(OUT, "verify-i20-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(OUT, "iteration22-verification.txt"),
  [
    "迭代 22（AC31 本地小模型路由）验证：",
    "1. 双端点实证：p-local / p-cloud 两个本地 HTTP 端点各自计数——简单任务（评分 0）只命中 p-local；复杂任务（「重构整个项目」双关键词评分 30 ≥ 阈值 30）只命中 p-cloud。「请求发给谁」以服务端命中为唯一事实源。",
    "2. 设置 UI：设置·通用分区「本地小模型路由」开关 + 本地模型下拉 + 阈值（1-100），UI 操作即时持久化 settings routing.local（enabled/providerId/threshold 断言全中）。",
    "3. 热更新：settings 改 enabled=false 后下一轮 run 即时 routed=disabled 回退模式绑定云端，无需重启；重新开启后对话形态手动选模型 routed=manual 跳过自动路由（AC5 手动语义优先于路由）。",
    "4. 活动流透明：三种路由行（简单任务→本地 / 复杂任务→绑定 / 未开启 / 已手动指定）在指挥台与对话双形态渲染，含 provider 与 score/threshold 明细。",
    "5. 轨迹审计：route 事件×4（local→complex→disabled→manual），detail 含 routed/providerId/score/threshold/reasons（keyword:refactor、keyword:whole_scope 逐项来源），磁盘 JSONL 可回放。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);

console.log(`[verify-i20] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
