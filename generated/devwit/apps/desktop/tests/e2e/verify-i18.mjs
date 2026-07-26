/**
 * 迭代 20 验证脚本（AC29 授权白名单学习，证据落盘 evidence/AC29）：
 * 1. fixture 工作区 + keyless provider + agent 模式热绑定；
 * 2. 指挥台创建任务，脚本化 LLM 连续三轮请求同一 bash 命令（echo ac29>> i18-marker.txt）：
 *    第 1/2 轮活动流授权行出现 → 用户点「允许」（真实点击）；
 *    第 2 次批准后命令毕业进白名单（settings 持久化）；
 *    第 3 轮不再询问——活动流出现「已自动放行（命令白名单）」；
 * 3. 真实执行证据：i18-marker.txt 三行 ac29（三轮都真实跑了）；
 * 4. 磁盘轨迹审计：authorization_request 恰好 2 次 + authorization_auto 1 次（source=whitelist）；
 * 5. 设置·通用分区：白名单条目可见 → 点「移除」→ 列表清空；
 * 6. 移除后再建任务跑同一命令 → 授权行再次出现（移除生效，计数从头开始）；
 * 7. 英文切换：通用分区显示 Command whitelist（i18n 无残留）。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（授权门、学习层、settings 持久化、活动流、cmd 真实执行）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC29");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i18-"));
fs.writeFileSync(path.join(fixture, "README.md"), "# i18 fixture\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i18-userdata-"));
const MARKER = path.join(fixture, "i18-marker.txt");
const COMMAND = "echo ac29>> i18-marker.txt";

// ---------------------------------------------------------------------------
// 本地端点：按请求序脚本化——前三轮 tool_call(bash 同命令)，第四轮回文本；
// 第二个任务（移除白名单后）再来一轮 tool_call + 文本收尾。
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForToolCall = (id) => [
  sseChunk({ id: "i18", object: "chat.completion.chunk", created: 0, model: "i18", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: COMMAND }) } }] }, finish_reason: null }] }),
  sseChunk({ id: "i18", object: "chat.completion.chunk", created: 0, model: "i18", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  sseChunk({ id: "i18", object: "chat.completion.chunk", created: 0, model: "i18", choices: [], usage: { prompt_tokens: 60, completion_tokens: 8 } }),
  "data: [DONE]\n\n",
];
const framesForText = (text) => [
  sseChunk({ id: "i18", object: "chat.completion.chunk", created: 0, model: "i18", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i18", object: "chat.completion.chunk", created: 0, model: "i18", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i18", object: "chat.completion.chunk", created: 0, model: "i18", choices: [], usage: { prompt_tokens: 60, completion_tokens: 6 } }),
  "data: [DONE]\n\n",
];

// 请求序：1/2/3=三轮同命令（任务一），4=任务一收尾，5=任务二同命令，6=任务二收尾
const SCRIPT = [
  framesForToolCall("call_i18_1"),
  framesForToolCall("call_i18_2"),
  framesForToolCall("call_i18_3"),
  framesForText("三轮执行完毕。"),
  framesForToolCall("call_i18_4"),
  framesForText("移除后再次执行完毕。"),
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i18] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i18] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i18] FAIL: ${message}`);
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

/** 活动流授权行计数（带裁决按钮=待裁决；dw-auth-decided=已裁决/自动放行）。 */
const pendingAuthCount = (page) =>
  page.$$eval(".dw-act-authorization", (rows) =>
    rows.filter((row) => row.querySelector("button") !== null).length
  );

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  step(`本地端点就绪 ${baseUrl}（脚本化 6 请求）`);

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
  step("应用启动 + fixture 工作区打开");

  // 注入 keyless provider + agent 模式热绑定（零凭证链路）
  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({
      id: "p-i18", type: "openai", label: "i18-local", baseUrl: url, model: "i18-model",
      credentialRef: "cred-i18", maxTokens: 1024, keyless: true,
    });
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "p-i18", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("keyless provider 注册 + agent 模式热绑定");

  // ---- 任务一：三轮同命令（允许→允许→自动放行）----
  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", "运行三轮 echo 标记");
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT, "01-first-auth-gate.png") });
  step("第 1 轮：授权行出现（学习计数 0→需询问）");

  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "允许", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".dw-act-authorization").length >= 2, null, { timeout: 30_000 });
  step("第 1 次批准（计数 1/2）→ 第 2 轮授权行出现");

  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "允许", exact: true }).click();
  // 第 2 次批准 → 毕业进白名单（settings 持久化）
  await page.waitForFunction(
    () => window.devwit.settings.get("security.commandWhitelist").then((list) => Array.isArray(list) && list.length === 1),
    null,
    { timeout: 15_000 }
  );
  const whitelist = await page.evaluate(() => window.devwit.settings.get("security.commandWhitelist"));
  assert(
    Array.isArray(whitelist) && whitelist[0] === COMMAND,
    `批准后命令应毕业进白名单（实际: ${JSON.stringify(whitelist)}）`
  );
  step("第 2 次批准 → 命令毕业进白名单（settings 持久化）");

  // 第 3 轮：自动放行——无待裁决授权行，出现自动放行标记，任务到 done
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const pendingAfter = await pendingAuthCount(page);
  assert(pendingAfter === 0, `第 3 轮不应有待裁决授权行（实际 ${pendingAfter} 个）`);
  const actText = await page.textContent(".dw-activity");
  assert(actText.includes("已自动放行（命令白名单）"), `活动流缺少自动放行标记: ${actText.slice(0, 200)}`);
  await page.screenshot({ path: path.join(OUT, "02-auto-approved.png") });
  step("第 3 轮：白名单命中自动放行（无弹窗，轨迹标记可见）");

  // 真实执行证据：marker 三行
  const lines = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf-8").split(/\r?\n/).filter((l) => l.trim() !== "") : [];
  assert(lines.length === 3 && lines.every((l) => l.trim() === "ac29"), `marker 应为 3 行 ac29（实际 ${lines.length} 行: ${lines.join("|")}）`);
  fs.writeFileSync(path.join(OUT, "marker-content.txt"), `i18-marker.txt 内容（${lines.length} 行）:\n${lines.join("\n")}\n`, "utf-8");
  step("真实执行证据：i18-marker.txt 三行 ac29（三轮全部真实经 cmd 执行）");

  // 磁盘轨迹审计：request×2 + auto×1（source=whitelist）
  const tracesDir = path.join(userDataDir, "traces");
  const traceFiles = fs.readdirSync(tracesDir).filter((name) => name.endsWith(".jsonl"));
  const events = traceFiles.flatMap((name) =>
    fs.readFileSync(path.join(tracesDir, name), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  );
  const requests = events.filter((e) => e.type === "authorization_request");
  const autos = events.filter((e) => e.type === "authorization_auto");
  assert(requests.length === 2, `轨迹 authorization_request 应恰好 2 次（实际 ${requests.length}）`);
  assert(
    autos.length === 1 && autos[0]?.detail?.source === "whitelist" && autos[0]?.detail?.args?.command === COMMAND,
    `轨迹 authorization_auto 应 1 次且 source=whitelist（实际 ${autos.length}）`
  );
  fs.writeFileSync(
    path.join(OUT, "trace-auth-events.json"),
    JSON.stringify({ authorization_request: requests, authorization_auto: autos }, null, 2),
    "utf-8"
  );
  step("磁盘轨迹审计：2 次询问 + 1 次自动放行（审计链完整）");

  // ---- 设置·通用分区：白名单条目可见 + 移除 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  const whitelistText = await page.textContent(".dw-settings-whitelist");
  assert(whitelistText.includes(COMMAND), `设置页白名单应含命令（实际: ${whitelistText.slice(0, 160)}）`);
  const learnChecked = await page
    .locator(".dw-settings-update", { hasText: "学习我批准过的命令" })
    .locator("input[type=checkbox]")
    .isChecked();
  assert(learnChecked, "学习开关默认应为开");
  await page.screenshot({ path: path.join(OUT, "03-settings-whitelist.png") });
  step("设置·通用分区：白名单条目 + 学习开关可见");

  await page.click(".dw-settings-whitelist >> text=移除");
  await page.waitForFunction(
    () => window.devwit.settings.get("security.commandWhitelist").then((list) => Array.isArray(list) && list.length === 0),
    null,
    { timeout: 10_000 }
  );
  const emptyText = await page.textContent(".dw-settings-whitelist");
  assert(emptyText.includes("白名单为空"), `移除后应显示空态（实际: ${emptyText.slice(0, 120)}）`);
  step("点「移除」→ 白名单清空（UI + settings 同步）");

  // ---- 任务二：移除后同命令再次询问（计数从头开始，第 1 次批准不毕业）----
  await page.click(".dw-modal >> text=关闭");
  await page.fill(".dw-task-new .dw-input", "移除后再跑一次");
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll(".dw-act-authorization")];
    return rows.some((row) => row.querySelector("button") !== null);
  }, null, { timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT, "04-second-task-prompt.png") });
  step("任务二：移除后同命令再次出现授权行（移除生效）");

  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "允许", exact: true }).click();
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const whitelistAfter = await page.evaluate(() => window.devwit.settings.get("security.commandWhitelist"));
  const approvalsAfter = await page.evaluate(() => window.devwit.settings.get("security.commandApprovals"));
  assert(Array.isArray(whitelistAfter) && whitelistAfter.length === 0, `任务二第 1 次批准不应毕业（实际: ${JSON.stringify(whitelistAfter)}）`);
  assert(
    approvalsAfter !== null && typeof approvalsAfter === "object" && approvalsAfter[COMMAND] === 1,
    `任务二批准后计数应为 1（实际: ${JSON.stringify(approvalsAfter)}）`
  );
  step("任务二：批准后计数 1/2 未毕业（阈值语义正确）");

  // ---- 英文切换：通用分区 i18n ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.selectOption(".dw-settings-content select", "en-US");
  await page.waitForFunction(
    () => document.querySelector(".dw-settings-content")?.textContent?.includes("Command whitelist"),
    null,
    { timeout: 10_000 }
  );
  const enText = await page.textContent(".dw-settings-content");
  assert(enText.includes("Command whitelist") && enText.includes("Learn commands I approve"), `英文白名单分区缺失: ${enText.slice(0, 200)}`);
  await page.screenshot({ path: path.join(OUT, "05-settings-en.png") });
  step("英文切换：Command whitelist 分区热生效无残留");

  fs.writeFileSync(path.join(OUT, "chat-bodies.json"), JSON.stringify(chatBodies, null, 2), "utf-8");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i18] FATAL: ${fatal}`);
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
fs.writeFileSync(path.join(OUT, "verify-i18-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(OUT, "iteration20-verification.txt"),
  [
    "迭代 20（AC29 授权白名单学习）验证：",
    "1. 学习链路：同一 bash 命令经用户两次「允许」后毕业进白名单（settings security.commandWhitelist 持久化）；deny/allow_session 不计数（单测覆盖）。",
    "2. 自动放行：第 3 轮同命令不再弹授权行，活动流渲染「已自动放行（命令白名单）」，轨迹落 authorization_auto（source=whitelist）；磁盘轨迹审计 2 询问 + 1 自动。",
    "3. 真实执行：i18-marker.txt 三行 ac29——三轮全部经 cmd 真实执行（含自动放行轮）。",
    "4. 管理 UI：设置·通用分区条目可见可移除、空态文案、学习开关默认开；移除后同命令再次询问且计数从头开始（阈值 2 语义正确）。",
    "5. i18n：英文切换 Command whitelist 分区热生效；chat.decidedAuto/security.* 中英同型。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);

console.log(`[verify-i18] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
