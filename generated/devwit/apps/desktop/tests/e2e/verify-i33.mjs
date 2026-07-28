/**
 * 迭代 33 验证脚本（AC42 DAP 调试：断点/暂停/栈/变量/求值/步进/继续/输出，证据落盘 evidence/AC42）：
 * 1. fixture 为真实 node 脚本 main.js（无 git 依赖）：alpha/beta/gamma 三变量 + 两行 console 输出；
 * 2. 打开工作区 → 文件树点 main.js → 行号槽第 3 行点击设断点（面板断点列表出现 main.js:3）；
 * 3. 调试页签点「启动调试」→ 真实 js-debug 适配器（vendor 官方发行版）全握手 → 断点命中停在 3 行；
 * 4. 状态栏「已暂停」含行号；调用栈首帧 main.js:3；Local 作用域自动展开 alpha=10 / beta=20；
 * 5. evaluate("alpha + beta") 经渲染→IPC→主→适配器全链路求值 = 30；
 * 6. 「单步跳过」→ 停第 4 行，gamma=30 可见；「继续」→  terminated，调试输出含 "result-is 30"；
 * 7. 停止后会话归零（状态栏清空，可再次启动）——零 mock，全链路真实适配器。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC42");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i33-userdata-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i33-"));

// ---- fixture：1-based 行号注释。断点行 = 3（gamma 赋值行，此刻 alpha/beta 已就位）----
// 1: const alpha = 10;
// 2: const beta = 20;
// 3: const gamma = alpha + beta;   <- 断点
// 4: console.log("result-is", gamma);
// 5: console.log("done");
fs.writeFileSync(
  path.join(fixture, "main.js"),
  "const alpha = 10;\nconst beta = 20;\nconst gamma = alpha + beta;\nconsole.log('result-is', gamma);\nconsole.log('done');\n",
  "utf-8"
);

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i33] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i33] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i33] FAIL: ${message}`);
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

/** 轮询直到 fn() 返回真值（返回其值），超时返回 null。 */
async function pollUntil(fn, timeoutMs = 20_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  const cdpPort = 25900 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  // ---- 0. 打开 fixture 工作区 + 文件树点 main.js ----
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  await page.click('.dw-tree-node:has-text("main.js")');
  await page.waitForSelector(".dw-editor-canvas", { timeout: 10_000 });
  const activeFile = await pollUntil(async () => {
    const text = await page.textContent(".dw-active-file");
    return text?.includes("main.js") ? text : null;
  }, 10_000);
  assert(activeFile !== null, "main.js 应打开为活动文件");
  step("应用启动 + fixture 工作区打开 + main.js 入编辑器");

  // ---- 1. 行号槽点击第 3 行（0-based line 2）设断点：gutter 区 = canvas 左缘起 ----
  const bpPoint = await page.evaluate(() => {
    const hook = window.__devwitE2E;
    const canvas = document.querySelector(".dw-editor-canvas");
    const rect = canvas.getBoundingClientRect();
    const pt = hook.editorClientPoint(2, 0); // 客户区坐标；gutter 区在 canvas 左缘与文本区之间
    return { x: rect.left + 5, y: pt.y };
  });
  assert(typeof bpPoint?.x === "number" && Number.isFinite(bpPoint.x) && Number.isFinite(bpPoint.y),
    `断点点击坐标应有效（实际: ${JSON.stringify(bpPoint)}）`);
  await page.mouse.click(bpPoint.x, bpPoint.y);
  const bpRow = await pollUntil(async () => {
    const rows = await page.$$eval(".dw-debug-bp", (nodes) => nodes.map((n) => n.textContent));
    return rows.some((r) => r?.includes("main.js") && r.includes("3")) ? rows : null;
  }, 5_000);
  assert(bpRow !== null, `断点列表应含 main.js:3（实际: ${JSON.stringify(bpRow)}）`);
  step("行号槽点击 → 断点 main.js:3 入列");

  // ---- 2. 切调试页签 → 启动调试 → 断点命中停第 3 行 ----
  await page.click(".dw-left-tabs >> text=调试");
  await page.click(".dw-debug-toolbar >> text=启动调试");
  const stopped = await pollUntil(async () => {
    const text = await page.textContent(".dw-status-debug");
    return text?.includes("已暂停") ? text : null;
  }, 30_000);
  assert(stopped !== null, `状态栏应进入「已暂停」（实际: ${JSON.stringify(await page.textContent(".dw-status-debug"))}）`);
  assert(stopped?.includes("main.js") === true && stopped.includes(":3") === true,
    `停止位置应为 main.js:3（实际: ${JSON.stringify(stopped)}）`);
  await page.screenshot({ path: path.join(OUT, "01-stopped-at-breakpoint.png") });
  step("启动调试 → 真实 js-debug 断点命中停 main.js:3（截图 01）");

  // ---- 3. 调用栈首帧 main.js:3 ----
  const frames = await pollUntil(async () => {
    const rows = await page.$$eval(".dw-debug-frame", (nodes) => nodes.map((n) => n.textContent));
    return rows.length > 0 ? rows : null;
  }, 10_000);
  assert(frames !== null && frames[0]?.includes("main.js") === true && frames[0].includes("3") === true,
    `调用栈首帧应为 main.js:3（实际: ${JSON.stringify(frames)}）`);
  step("调用栈：首帧 main.js:3");

  // ---- 4. Local 作用域自动展开：alpha=10 / beta=20 ----
  const vars = await pollUntil(async () => {
    const pairs = await page.$$eval(".dw-debug-var", (nodes) =>
      nodes.map((n) => `${n.querySelector(".dw-debug-var-name")?.textContent}=${n.querySelector(".dw-debug-var-value")?.textContent}`));
    return pairs.some((p) => p?.startsWith("alpha=")) ? pairs : null;
  }, 10_000);
  assert(vars?.includes("alpha=10") === true, `Local 应含 alpha=10（实际: ${JSON.stringify(vars)}）`);
  assert(vars?.includes("beta=20") === true, `Local 应含 beta=20（实际: ${JSON.stringify(vars)}）`);
  await page.screenshot({ path: path.join(OUT, "02-stack-variables.png") });
  step("变量面板：Local 自动展开 alpha=10 / beta=20（截图 02）");

  // ---- 5. evaluate 全链路（渲染 → IPC → 主 → js-debug）：alpha + beta = 30 ----
  const evalResult = await page.evaluate(async () => {
    const item = await window.devwit.debug.evaluate("alpha + beta");
    return `${item.name}=${item.value}`;
  });
  assert(evalResult === "alpha + beta=30", `evaluate 应为 30（实际: ${JSON.stringify(evalResult)}）`);
  step("evaluate 求值：alpha + beta = 30（全链路真实适配器）");

  // ---- 6. 单步跳过 → 停第 4 行（gamma 已赋值 = 30）----
  await page.click(".dw-debug-toolbar >> text=单步跳过");
  const stopped4 = await pollUntil(async () => {
    const text = await page.textContent(".dw-status-debug");
    return text?.includes("已暂停") && text.includes(":4") ? text : null;
  }, 15_000);
  assert(stopped4 !== null, `单步跳过应停 main.js:4（实际: ${JSON.stringify(await page.textContent(".dw-status-debug"))}）`);
  const vars4 = await pollUntil(async () => {
    const pairs = await page.$$eval(".dw-debug-var", (nodes) =>
      nodes.map((n) => `${n.querySelector(".dw-debug-var-name")?.textContent}=${n.querySelector(".dw-debug-var-value")?.textContent}`));
    return pairs.some((p) => p === "gamma=30") ? pairs : null;
  }, 10_000);
  assert(vars4 !== null, `第 4 行 Local 应含 gamma=30（实际: ${JSON.stringify(vars4)}）`);
  await page.screenshot({ path: path.join(OUT, "03-stepped-line4.png") });
  step("单步跳过：main.js:3 → main.js:4，gamma=30 可见（截图 03）");

  // ---- 7. 继续 → terminated + 调试输出含 result-is 30 / done ----
  await page.click(".dw-debug-toolbar >> text=继续");
  const terminated = await pollUntil(async () => {
    const text = await page.textContent(".dw-status-debug");
    return text?.includes("调试已结束") ? text : null;
  }, 15_000);
  assert(terminated !== null, `继续后应「调试已结束」（实际: ${JSON.stringify(await page.textContent(".dw-status-debug"))}）`);
  const outputText = await pollUntil(async () => {
    const text = await page.textContent(".dw-debug-output");
    return text?.includes("result-is 30") ? text : null;
  }, 10_000);
  assert(outputText !== null, `调试输出应含 "result-is 30"（实际: ${JSON.stringify(await page.textContent(".dw-debug-output"))}）`);
  assert(outputText?.includes("done") === true, `调试输出应含 "done"（程序跑完）`);
  await page.screenshot({ path: path.join(OUT, "04-terminated-output.png") });
  step("继续 → terminated，被调试进程输出全量回传（截图 04）");

  // ---- 8. 会话归零：terminated 后按钮回到「启动调试」，可再次启动（无残留态） ----
  const startAgain = await pollUntil(async () => {
    const text = await page.textContent(".dw-debug-toolbar");
    return text?.includes("启动调试") ? text : null;
  }, 5_000);
  assert(startAgain !== null, "terminated 后工具栏应回到可启动态");
  step("会话收尾：状态机归零，可再次启动");
} catch (error) {
  fatal = error;
  console.error("[verify-i33] FATAL:", error);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  await stopElectron(electronProc);
}

report.fatal = fatal === null ? null : String(fatal);
report.ok = fatal === null && report.failures.length === 0;
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`[verify-i33] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败；证据 → evidence/AC42`);
if (!report.ok) {
  console.error("[verify-i33] FAILED");
  process.exit(1);
}
console.log("[verify-i33] OK");
