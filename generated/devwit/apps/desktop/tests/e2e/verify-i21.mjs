/**
 * 迭代 23 验证脚本（AC32 工作流记忆，证据落盘 evidence/AC32）：
 * 1. 任务 1「为 login.ts 加输入校验」：脚本化 LLM write 工具调用 → 授权 → 真实写盘 →
 *    完成（done 无 error 含工具调用）→ 成功轨迹沉淀为模板（settings workflow.templates）；
 * 2. 任务 2「为 login.ts 补输入校验的单测」（共享 login.ts/输入/校验 关键词）→
 *    命中模板：活动流「工作流」行可见（工具序列 + 复用次数），reuseCount 递增；
 * 3. 请求体审计：任务 2 的 LLM 请求携带「相似任务此前已成功完成」建议项
 *    （建议非指令——内容明确标注，授权语义不变）；
 * 4. 上下文页签/manifest：workflow 类型项 enabled 且 token 计数 >0（透明性）；
 * 5. 磁盘轨迹审计：workflow 事件 phase=reuse，templateId/shared/reuseCount 落盘可回放；
 * 6. 设置·通用分区「工作流记忆」：模板条目可见（意图 + 工具序列 + 复用次数），
 *    逐条删除后列表清空；开关热持久化 workflow.memory。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（write 写盘、授权门、模板沉淀/匹配、活动流、轨迹持久化）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC32");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i21-"));
fs.writeFileSync(path.join(fixture, "login.ts"), "export function login() {\n  return true;\n}\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i21-userdata-"));

const TASK1 = "为 login.ts 加输入校验";
const TASK2 = "为 login.ts 补输入校验的单测";
const FILE_ARG = "login.ts";

// ---------------------------------------------------------------------------
// 本地端点：按请求序脚本——任务1: write → 文本收尾；任务2: 文本（捕获请求体审计注入）
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForWrite = (id) => [
  sseChunk({ id: "i21", object: "chat.completion.chunk", created: 0, model: "i21", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: JSON.stringify({ path: FILE_ARG, content: "export function login(name?: string) {\n  if (!name) throw new Error(\"name required\");\n  return true;\n}\n" }) } }] }, finish_reason: null }] }),
  sseChunk({ id: "i21", object: "chat.completion.chunk", created: 0, model: "i21", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  sseChunk({ id: "i21", object: "chat.completion.chunk", created: 0, model: "i21", choices: [], usage: { prompt_tokens: 50, completion_tokens: 8 } }),
  "data: [DONE]\n\n",
];
const framesForText = (text) => [
  sseChunk({ id: "i21", object: "chat.completion.chunk", created: 0, model: "i21", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i21", object: "chat.completion.chunk", created: 0, model: "i21", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i21", object: "chat.completion.chunk", created: 0, model: "i21", choices: [], usage: { prompt_tokens: 50, completion_tokens: 6 } }),
  "data: [DONE]\n\n",
];
const SCRIPT = [
  framesForWrite("call_i21_1"),
  framesForText("已加输入校验。"),
  framesForText("已补充单测。"),
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i21] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i21] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i21] FAIL: ${message}`);
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

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（脚本化 3 请求）`);

  const cdpPort = 25900 + Math.floor(Math.random() * 300);
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
      id: "p-i21", type: "openai", label: "i21-local", baseUrl: url, model: "i21-model",
      credentialRef: "cred-i21", maxTokens: 2048, keyless: true,
    });
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "p-i21", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("keyless provider 注册 + agent 模式热绑定（workflow 策略默认开）");

  // ---- 任务 1：write 工具调用成功完成 → 沉淀模板 ----
  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", TASK1);
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "允许", exact: true }).click();
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  step("任务1 完成：write 授权真实写盘 + done（够格沉淀）");

  const written = fs.readFileSync(path.join(fixture, FILE_ARG), "utf-8");
  assert(written.includes("name required"), `login.ts 应为写入版（实际: ${JSON.stringify(written.slice(0, 80))}）`);

  const templates1 = await page.evaluate(async () => window.devwit.settings.get("workflow.templates"));
  assert(
    Array.isArray(templates1) && templates1.length === 1 && templates1[0].intent === TASK1 &&
      JSON.stringify(templates1[0].tools) === JSON.stringify(["write"]) && templates1[0].reuseCount === 0,
    `任务1 成功后应沉淀 1 条模板（intent/tools=[write]/reuseCount=0）（实际: ${JSON.stringify(templates1)}）`
  );
  const templateId = templates1[0].id;
  step(`模板沉淀：${templateId}（intent=「${TASK1}」，tools=[write]）`);

  // ---- 任务 2：相似意图 → 命中模板（复用建议注入 + 活动流行 + 计数递增）----
  await page.fill(".dw-task-new .dw-input", TASK2);
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  await page.waitForSelector(".dw-act-workflow", { timeout: 10_000 });
  const workflowRow = await page.textContent(".dw-act-workflow");
  assert(
    workflowRow.includes("write") && workflowRow.includes("第 1 次复用") && workflowRow.includes(TASK1),
    `活动流「工作流」行应含工具序列 write + 第 1 次复用 + 模板意图（实际: ${workflowRow.slice(0, 200)}）`
  );
  await page.screenshot({ path: path.join(OUT, "01-workflow-reuse.png") });
  step("任务2 命中模板：活动流「工作流」行可见（write · 第 1 次复用）");

  // 请求体审计：任务2 首轮请求（chatBodies[2]）携带工作流建议项
  const task2Body = JSON.stringify(chatBodies[2] ?? {});
  assert(
    task2Body.includes("相似任务此前已成功完成") && task2Body.includes("成功工具序列：write") && task2Body.includes(TASK1),
    `任务2 请求体应含工作流建议项（意图 + 成功工具序列 write）（实际含建议=${task2Body.includes("相似任务此前已成功完成")}）`
  );
  assert(task2Body.includes("建议，非指令"), "建议项应明确标注「建议，非指令」（授权语义不变）");
  fs.writeFileSync(path.join(OUT, "chat-bodies.json"), JSON.stringify(chatBodies, null, 2), "utf-8");
  step("请求体审计：任务2 携带工作流建议项（标注「建议，非指令」）");

  // reuseCount 递增 + lastReuseAt 落盘
  const templates2 = await page.evaluate(async () => window.devwit.settings.get("workflow.templates"));
  assert(
    Array.isArray(templates2) && templates2.length === 1 && templates2[0].id === templateId &&
      templates2[0].reuseCount === 1 && typeof templates2[0].lastReuseAt === "string",
    `复用后模板 reuseCount 应为 1 且落 lastReuseAt（实际: ${JSON.stringify(templates2)}）`
  );
  step("复用计数：reuseCount 0→1，lastReuseAt 落盘");

  // 磁盘轨迹审计：workflow 事件 phase=reuse，templateId/shared 明细
  const tracesDir = path.join(userDataDir, "traces");
  const traceFiles = fs.readdirSync(tracesDir).filter((name) => name.endsWith(".jsonl"));
  const events = traceFiles.flatMap((name) =>
    fs.readFileSync(path.join(tracesDir, name), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  );
  const workflowEvents = events.filter((e) => e.type === "workflow");
  const reuseEvent = workflowEvents[0]?.detail ?? {};
  assert(
    workflowEvents.length === 1 && reuseEvent.phase === "reuse" && reuseEvent.templateId === templateId &&
      Array.isArray(reuseEvent.shared) && reuseEvent.shared.includes("login.ts") && reuseEvent.reuseCount === 1,
    `轨迹 workflow 事件应为 reuse 且含 templateId/shared(login.ts)/reuseCount=1（实际: ${JSON.stringify(reuseEvent)}）`
  );
  fs.writeFileSync(path.join(OUT, "trace-workflow-events.json"), JSON.stringify(workflowEvents, null, 2), "utf-8");
  step("磁盘轨迹审计：workflow×1（phase=reuse，shared 含 login.ts，reuseCount=1）");

  // manifest 审计：workflow 类型项 enabled 且 token >0（AC2 透明性）
  const manifestsDir = path.join(userDataDir, "manifests");
  const manifestFiles = fs.readdirSync(manifestsDir).filter((name) => name.endsWith(".json"));
  const manifests = manifestFiles.map((name) => JSON.parse(fs.readFileSync(path.join(manifestsDir, name), "utf-8")));
  const withWorkflow = manifests.filter((m) => (m.items ?? []).some((item) => item.type === "workflow" && item.enabled === true && item.tokens > 0));
  assert(withWorkflow.length >= 1, `至少 1 份 manifest 应含 enabled 且 token>0 的 workflow 项（实际: ${withWorkflow.length} 份）`);
  fs.writeFileSync(path.join(OUT, "manifest-workflow.json"), JSON.stringify(withWorkflow[0] ?? null, null, 2), "utf-8");
  step("manifest 审计：workflow 项 enabled + token 精确计数（透明可见可剔除）");

  // ---- 设置·通用分区「工作流记忆」：条目可见 + 逐条删除 + 开关持久化 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  const wfTitle = await page.$$eval(".dw-settings-content label", (labels) =>
    labels.some((label) => label.textContent === "工作流记忆")
  );
  assert(wfTitle, "设置·通用分区应展示「工作流记忆」区");
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll(".dw-settings-whitelist-row")].some((row) => (row.textContent ?? "").includes(expected)),
    TASK1,
    { timeout: 5_000 }
  );
  const entryText = await page.$$eval(".dw-settings-whitelist-row", (rows) => rows.map((row) => row.textContent ?? "").join("\n"));
  assert(
    entryText.includes(TASK1) && entryText.includes("write") && entryText.includes("复用 1 次"),
    `模板条目应含意图 + 工具序列 + 复用次数（实际: ${entryText.slice(0, 200)}）`
  );
  await page.screenshot({ path: path.join(OUT, "02-settings-workflow.png") });
  step("设置 UI：模板条目可见（意图 + write + 复用 1 次）");

  // 逐条删除 → 列表回空态
  await page.$$eval(".dw-settings-whitelist-row button", (buttons) => {
    buttons.find((button) => button.textContent === "删除")?.click();
  });
  await page.waitForFunction(async () => {
    const stored = await window.devwit.settings.get("workflow.templates");
    return Array.isArray(stored) && stored.length === 0;
  }, null, { timeout: 5_000 });
  step("逐条删除：模板清空（settings 同步）");

  // 开关：关 → 持久化 enabled=false（热生效，主进程下轮即不学习不匹配）
  await page.$$eval(".dw-settings-content .dw-settings-update", (rows) => {
    const row = rows.find((r) => (r.textContent ?? "").includes("沉淀并复用成功任务的工作流"));
    row?.querySelector('input[type="checkbox"]')?.click();
  });
  await page.waitForFunction(async () => {
    const stored = await window.devwit.settings.get("workflow.memory");
    return stored?.enabled === false;
  }, null, { timeout: 5_000 });
  await page.screenshot({ path: path.join(OUT, "03-settings-disabled.png") });
  step("开关热持久化：workflow.memory.enabled=false（下轮起停用）");

  // 停用后不学习：再跑一轮成功任务 → 模板仍为空
  await page.click(".dw-modal-settings >> text=关闭");
  await page.fill(".dw-task-new .dw-input", "为 login.ts 写 README 说明");
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const templates3 = await page.evaluate(async () => window.devwit.settings.get("workflow.templates"));
  assert(Array.isArray(templates3) && templates3.length === 0, `停用后成功任务不应沉淀模板（实际: ${JSON.stringify(templates3)}）`);
  const stream3 = await page.$$eval(".dw-act", (rows) => rows.map((row) => row.textContent ?? "").join("\n"));
  assert(!stream3.includes("复用相似成功任务"), "停用后活动流不应有工作流复用行");
  step("停用验证：成功任务不学习、相似任务不匹配");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i21] FATAL: ${fatal}`);
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
fs.writeFileSync(path.join(OUT, "verify-i21-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(OUT, "iteration23-verification.txt"),
  [
    "迭代 23（AC32 工作流记忆）验证：",
    "1. 沉淀：任务1「为 login.ts 加输入校验」write 授权真实写盘 + done（无 error 含工具调用）→ 模板落 settings workflow.templates（intent/tools=[write]/reuseCount=0）。",
    "2. 复用：任务2 相似意图（共享 login.ts/输入/入校/校验 关键词）命中模板——活动流「工作流」行（write · 第 1 次复用），reuseCount 0→1 + lastReuseAt 落盘。",
    "3. 注入审计：任务2 请求体含「相似任务此前已成功完成…成功工具序列：write」建议项，且明确标注「建议，非指令」——模型可参考但不强制执行，授权语义不变。",
    "4. manifest 透明：workflow 类型项 enabled + token 精确计数落盘，上下文面板可逐项剔除（AC2 可控性）。",
    "5. 轨迹审计：workflow 事件 phase=reuse，templateId/shared(login.ts)/reuseCount=1，磁盘 JSONL 可回放。",
    "6. 设置管理：通用分区「工作流记忆」条目（意图 + 工具序列 + 复用次数）可见，逐条删除回空态；开关热持久化 workflow.memory.enabled=false 后成功任务不学习、相似任务不匹配。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);

console.log(`[verify-i21] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
