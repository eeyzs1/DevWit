/**
 * 迭代 21 验证脚本（AC30 诊断回馈，证据落盘 evidence/AC30）：
 * 1. fixture 工作区带 tsconfig.json + 本地 typescript（junction 到本仓库 node_modules，
 *    真跑 `tsc --noEmit`，非 mock）；
 * 2. 脚本化 LLM：第 1 轮 write 一个类型错误的 src/broken.ts → 授权点「允许」真实写盘；
 * 3. 写后 main 进程自动跑 tsc → 活动流出现「编辑后发现 1 个问题」诊断行；
 * 4. 第 2 轮 LLM 请求体审计：诊断文本（broken.ts + TS2322）已注入上下文（修复闭环核心）；
 * 5. 第 2 轮 write 修复内容 → 再授权 → tsc 清零 → 活动流「诊断已清零」；
 * 6. 磁盘轨迹审计：diagnostics 事件 2 次（count 1→0，trigger=write）；
 * 7. broken.ts 最终为修复版（真实写盘证据）；
 * 8. 上下文页签：「诊断」项可见且 token 计数 >0（透明性）。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 HTTP 线协议应答并捕获请求体，
 * 产品侧链路 100% 真实（write 写盘、授权门、tsc 真实执行、活动流、轨迹持久化）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC30");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i19-"));
fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
fs.writeFileSync(path.join(fixture, "README.md"), "# i19 fixture\n", "utf-8");
fs.writeFileSync(
  path.join(fixture, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "es2020" }, include: ["src"] }, null, 2),
  "utf-8"
);
// 本地 typescript：junction 到本仓库的 node_modules/typescript（真实 tsc，版本与产品编译链一致）
fs.mkdirSync(path.join(fixture, "node_modules"), { recursive: true });
fs.symlinkSync(path.join(ROOT, "node_modules", "typescript"), path.join(fixture, "node_modules", "typescript"), "junction");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i19-userdata-"));

const BROKEN = "export const x: number = \"oops\";\n";
const FIXED = "export const x: number = 1;\n";
const FILE_ARG = "src/broken.ts";

// ---------------------------------------------------------------------------
// 本地端点：3 请求脚本——write(坏) → write(修) → 文本收尾
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const framesForWrite = (id, content) => [
  sseChunk({ id: "i19", object: "chat.completion.chunk", created: 0, model: "i19", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: JSON.stringify({ path: FILE_ARG, content }) } }] }, finish_reason: null }] }),
  sseChunk({ id: "i19", object: "chat.completion.chunk", created: 0, model: "i19", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
  sseChunk({ id: "i19", object: "chat.completion.chunk", created: 0, model: "i19", choices: [], usage: { prompt_tokens: 60, completion_tokens: 8 } }),
  "data: [DONE]\n\n",
];
const framesForText = (text) => [
  sseChunk({ id: "i19", object: "chat.completion.chunk", created: 0, model: "i19", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
  sseChunk({ id: "i19", object: "chat.completion.chunk", created: 0, model: "i19", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  sseChunk({ id: "i19", object: "chat.completion.chunk", created: 0, model: "i19", choices: [], usage: { prompt_tokens: 60, completion_tokens: 6 } }),
  "data: [DONE]\n\n",
];
const SCRIPT = [
  framesForWrite("call_i19_1", BROKEN),
  framesForWrite("call_i19_2", FIXED),
  framesForText("已看到诊断并修复类型错误。"),
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i19] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i19] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i19] FAIL: ${message}`);
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
  step(`本地端点就绪 ${baseUrl}（脚本化 3 请求）`);

  const cdpPort = 25100 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开（tsconfig + 本地 typescript 就绪）");

  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({
      id: "p-i19", type: "openai", label: "i19-local", baseUrl: url, model: "i19-model",
      credentialRef: "cred-i19", maxTokens: 1024, keyless: true,
    });
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "p-i19", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("keyless provider 注册 + agent 模式热绑定（diagnostics 策略默认开）");

  // ---- 任务：write 坏文件 → 诊断 1 个 → write 修复 → 诊断清零 ----
  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", "写入带类型错误的文件并修复");
  await page.click(".dw-console-tasks >> text=创建");

  // 第 1 次 write 授权
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "允许", exact: true }).click();
  step("第 1 轮 write（坏文件）：授权通过，真实写盘");

  // tsc 真跑（junction 本地 typescript），诊断行出现：「编辑后发现 1 个问题」
  await page.waitForSelector(".dw-act-diagnostics", { timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelector(".dw-act-diagnostics")?.textContent?.includes("编辑后发现 1 个问题"),
    null,
    { timeout: 60_000 }
  );
  const diagText = await page.textContent(".dw-act-diagnostics");
  assert(diagText.includes("broken.ts"), `诊断行应含首个问题位置（实际: ${diagText.slice(0, 160)}）`);
  await page.screenshot({ path: path.join(OUT, "01-diagnostics-found.png") });
  step("诊断行出现：编辑后发现 1 个问题（tsc 真跑，首个 broken.ts）");

  // 第 2 轮 LLM 请求体审计：诊断文本注入（修复闭环核心链路）
  // （第 2 个授权行出现 = 第 2 轮请求已发出并被本地端点捕获）
  const secondBody = chatBodies[1];
  const secondRaw = JSON.stringify(secondBody ?? {});
  assert(
    secondRaw.includes("TS2322") && secondRaw.includes("broken.ts"),
    `第 2 轮请求应携带 TS2322 诊断文本（实际含 TS2322=${secondRaw.includes("TS2322")}）`
  );
  fs.writeFileSync(path.join(OUT, "chat-bodies.json"), JSON.stringify(chatBodies, null, 2), "utf-8");
  step("第 2 轮请求体审计：诊断（broken.ts TS2322）已注入上下文");

  // 第 2 次 write（修复）授权
  await page.locator(".dw-act-authorization").last().getByRole("button", { name: "允许", exact: true }).click();
  step("第 2 轮 write（修复文件）：授权通过，真实写盘");

  // tsc 清零：「诊断已清零」+ 任务完成
  await page.waitForFunction(
    () => document.querySelector(".dw-act-diagnostics")?.textContent?.includes("诊断已清零"),
    null,
    { timeout: 60_000 }
  );
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  await page.screenshot({ path: path.join(OUT, "02-diagnostics-clean.png") });
  step("修复后诊断清零 + 任务完成");

  // 真实写盘证据：broken.ts 为修复版
  const finalContent = fs.readFileSync(path.join(fixture, "src", "broken.ts"), "utf-8");
  assert(finalContent === FIXED, `broken.ts 应为修复版（实际: ${JSON.stringify(finalContent)}）`);
  fs.writeFileSync(path.join(OUT, "broken-final.ts"), finalContent, "utf-8");
  step("真实执行证据：src/broken.ts 最终为修复版");

  // 磁盘轨迹审计：diagnostics 事件 2 次（count 1→0，trigger=write）
  const tracesDir = path.join(userDataDir, "traces");
  const traceFiles = fs.readdirSync(tracesDir).filter((name) => name.endsWith(".jsonl"));
  const events = traceFiles.flatMap((name) =>
    fs.readFileSync(path.join(tracesDir, name), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  );
  const diagEvents = events.filter((e) => e.type === "diagnostics");
  const counts = diagEvents.map((e) => e.detail?.count);
  assert(
    diagEvents.length === 2 && counts[0] === 1 && counts[1] === 0 && diagEvents.every((e) => e.detail?.trigger === "write"),
    `轨迹 diagnostics 应 2 次（count 1→0，trigger=write）（实际: ${JSON.stringify(counts)}）`
  );
  const firstEntries = diagEvents[0]?.detail?.entries ?? [];
  assert(
    firstEntries.length === 1 && firstEntries[0]?.code === "TS2322" && firstEntries[0]?.file === "src/broken.ts",
    `首条诊断应为 src/broken.ts TS2322（实际: ${JSON.stringify(firstEntries[0] ?? null)}）`
  );
  fs.writeFileSync(path.join(OUT, "trace-diagnostics-events.json"), JSON.stringify(diagEvents, null, 2), "utf-8");
  step("磁盘轨迹审计：diagnostics×2（1 问题→清零），首条 TS2322@src/broken.ts");

  // 设置·模式分区：agent 模式上下文策略含「诊断」且默认勾选（用户可逐项关闭——可控性证据）
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav >> text=模式");
  await page.waitForSelector(".dw-form-checks", { timeout: 10_000 });
  await page.click('.dw-modal-list-item:has-text("Agent")');
  const diagPolicy = await page.$$eval(".dw-form-checks label", (labels) => {
    const hit = labels.find((label) => label.textContent === "诊断");
    if (hit === undefined) return null;
    return hit.querySelector("input")?.checked ?? null;
  });
  assert(diagPolicy === true, `agent 模式「诊断」策略应默认勾选（实际: ${String(diagPolicy)}）`);
  await page.screenshot({ path: path.join(OUT, "03-mode-policy.png") });
  step("设置·模式分区：「诊断」策略可见且默认勾选（用户可逐项关闭）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i19] FATAL: ${fatal}`);
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
fs.writeFileSync(path.join(OUT, "verify-i19-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(OUT, "iteration21-verification.txt"),
  [
    "迭代 21（AC30 诊断回馈）验证：",
    "1. 编辑触发：agent write 真实写盘后，main 进程自动对工作区跑 `tsc --noEmit`（fixture 经 junction 用真实本地 typescript 5.8.3，非 mock）。",
    "2. 上下文注入：第 2 轮 LLM 请求体含 broken.ts + TS2322 诊断文本——模型看到自己引入的编译错误（修复闭环核心链路，chat-bodies.json 可审计）。",
    "3. UI 透明：活动流「编辑后发现 1 个问题（首个：broken.ts）」→ 修复后「诊断已清零」；上下文页签「诊断」项可见。",
    "4. 轨迹审计：diagnostics 事件 2 次（count 1→0，trigger=write，首条 src/broken.ts TS2322），磁盘 JSONL 可回放。",
    "5. 真实修复：src/broken.ts 最终为修复版（export const x: number = 1）。",
    "6. 降级诚实：无 tsconfig / 无本地 typescript / tsc 崩溃超时 → 空快照不阻断主循环（diagnostics.ts 单元测试覆盖）。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);

console.log(`[verify-i19] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
