/**
 * 迭代 31 验证脚本（AC40 LSP 集成：悬停/跳转定义/实时诊断，证据落盘 evidence/AC40）：
 * 1. 打开 TS fixture 工作区 → LSP 状态机经 IPC 达 ready（真实 tsserver，
 *    ELECTRON_RUN_AS_NODE 复用 Electron 二进制，零系统依赖）；
 * 2. 打开 main.ts（含类型错误）→ publishDiagnostics 推送：lsp.diagnostics() IPC
 *    返回 error 条目（file/line/severity/message 硬断言）+ 状态栏 ✕ 计数；
 * 3. 真实鼠标驻留 500ms（坐标经 __devwitE2E.editorClientPoint 反解）→
 *    .dw-lsp-hover tooltip DOM 出现且含类型签名；移开即关闭；
 * 4. 编辑器键入新错误行 → didChange 防抖同步 → 诊断 ✕ 1→2（未保存缓冲区参与分析）；
 * 5. Ctrl+Click 调用处 → 跨文件跳转 math.ts：activeFileLabel 变化 +
 *    __devwitE2E.editorSelections 光标落点硬断言（0 行 add 定义处）。
 *
 * 全链路真实：真实 Electron + 真实 typescript-language-server 子进程 +
 * 真实 Playwright 鼠标/键盘，零 mock。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC40");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i31-userdata-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i31-"));

// ---- fixture：TS 工程（定义/调用/类型错误三要素） ----
// main.ts 行号（0-based）：0 import / 1 空 / 2 add 调用 / 3 类型错误 / 4 空
const MATH_TS = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");
const MAIN_TS = [
  "import { add } from './math';",
  "",
  "const total: number = add(1, 2);",
  "const bad: number = 'oops';",
  "",
].join("\n");
fs.writeFileSync(path.join(fixture, "math.ts"), MATH_TS, "utf-8");
fs.writeFileSync(path.join(fixture, "main.ts"), MAIN_TS, "utf-8");
fs.writeFileSync(
  path.join(fixture, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler" } }),
  "utf-8"
);

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i31] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i31] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i31] FAIL: ${message}`);
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
  const cdpPort = 25400 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  // ---- 0. 打开 fixture 工作区 ----
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开（math.ts / main.ts / tsconfig.json）");

  // ---- 1. LSP 状态机 → ready（真实 tsserver 经 ELECTRON_RUN_AS_NODE 启动）----
  const ready = await pollUntil(async () => {
    const s = await page.evaluate(() => window.devwit.lsp.getStatus());
    return s.state === "ready" ? s : null;
  }, 25_000);
  assert(ready !== null, `LSP 状态机应达 ready（实际: ${JSON.stringify(await page.evaluate(() => window.devwit.lsp.getStatus()))}）`);
  step("LSP ready：真实 typescript-language-server 子进程握手完成（零系统依赖）");

  // ---- 2. 打开 main.ts → 诊断推送（IPC 硬断言 + 状态栏计数）----
  await page.click('.dw-tree-node:has-text("main.ts")');
  await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("main.ts"));
  const firstError = await pollUntil(async () => {
    const diags = await page.evaluate(() => window.devwit.lsp.diagnostics());
    return diags.find((d) => d.file === "main.ts" && d.severity === "error") ?? null;
  }, 25_000);
  assert(firstError !== null, "publishDiagnostics 应推送 main.ts 类型错误（lsp:diagnostics IPC）");
  if (firstError !== null) {
    assert(firstError.line === 3, `错误行应为 3（0-based，实际: ${firstError.line}）`);
    assert(firstError.message.toLowerCase().includes("not assignable"),
      `错误消息应为类型不匹配（实际: ${firstError.message.slice(0, 80)}）`);
    assert(typeof firstError.code === "string" && firstError.code.length > 0,
      `诊断码应存在（实际: ${firstError.code}）`);
  }
  await pollUntil(async () => (await page.textContent(".dw-status-lsp"))?.includes("✕ 1"), 5_000);
  const statusText1 = await page.textContent(".dw-status-lsp");
  assert(statusText1?.includes("✕ 1") === true, `状态栏应显示 ✕ 1（实际: ${JSON.stringify(statusText1)}）`);
  await page.screenshot({ path: path.join(OUT, "01-diagnostics.png") });
  step("实时诊断：error 条目 IPC 返回 + 状态栏 ✕ 1（波浪线 canvas 渲染，截图 01）");

  // ---- 3. 悬停：真实鼠标驻留 500ms → tooltip DOM（含类型签名）----
  const hoverPoint = await page.evaluate(() => window.__devwitE2E.editorClientPoint(2, 23)); // "add" 调用处
  assert(typeof hoverPoint?.x === "number" && typeof hoverPoint?.y === "number",
    `E2E 几何钩子应返回客户区坐标（实际: ${JSON.stringify(hoverPoint)}）`);
  await page.mouse.move(hoverPoint.x + 2, hoverPoint.y);
  await page.mouse.move(hoverPoint.x + 3, hoverPoint.y); // 触发 mousemove 重置驻留计时
  const tipVisible = await pollUntil(async () => {
    const el = await page.$(".dw-lsp-hover");
    if (el === null) return null;
    const display = await el.evaluate((node) => node.style.display);
    return display !== "none" ? el : null;
  }, 8_000);
  assert(tipVisible !== null, "鼠标驻留 500ms 后 .dw-lsp-hover tooltip 应出现");
  if (tipVisible !== null) {
    const tipText = await tipVisible.evaluate((node) => node.textContent);
    assert(tipText?.includes("add") === true, `tooltip 应含 add 签名（实际: ${tipText?.slice(0, 80)}）`);
  }
  await page.screenshot({ path: path.join(OUT, "02-hover.png") });
  step("悬停：真实鼠标驻留 → IPC hover → tooltip 含类型签名（截图 02）");
  // 移开即关闭
  await page.mouse.move(hoverPoint.x + 200, hoverPoint.y + 120);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const tipDisplayAfter = await page.$eval(".dw-lsp-hover", (node) => node.style.display).catch(() => "missing");
  assert(tipDisplayAfter === "none", `鼠标移开后 tooltip 应关闭（实际 display: ${tipDisplayAfter}）`);

  // ---- 4. 编辑：键入新错误行 → didChange 防抖同步 → ✕ 1→2 ----
  const endPoint = await page.evaluate(() => window.__devwitE2E.editorClientPoint(4, 0));
  await page.mouse.click(endPoint.x + 2, endPoint.y); // 点击定位光标 + 聚焦 IME
  await page.keyboard.type("const e2eBad: number = 'x';", { delay: 10 });
  const secondError = await pollUntil(async () => {
    const diags = await page.evaluate(() => window.devwit.lsp.diagnostics());
    const errors = diags.filter((d) => d.file === "main.ts" && d.severity === "error");
    return errors.length >= 2 ? errors : null;
  }, 25_000);
  assert(secondError !== null, "编辑后应推送第二条错误（未保存缓冲区参与分析）");
  if (secondError !== null) {
    const newError = secondError.find((d) => d.line === 4);
    assert(newError !== undefined, `新错误应在第 4 行（实际行集: ${secondError.map((d) => d.line).join("/")}）`);
  }
  await pollUntil(async () => (await page.textContent(".dw-status-lsp"))?.includes("✕ 2"), 5_000);
  const statusText2 = await page.textContent(".dw-status-lsp");
  assert(statusText2?.includes("✕ 2") === true, `状态栏应更新为 ✕ 2（实际: ${JSON.stringify(statusText2)}）`);
  await page.screenshot({ path: path.join(OUT, "03-diagnostics-live.png") });
  step("编辑同步：didChange 防抖 → 诊断 ✕ 1→2（截图 03）");

  // ---- 5. Ctrl+Click 跳转定义：跨文件 main.ts → math.ts，光标落点硬断言 ----
  const defPoint = await page.evaluate(() => window.__devwitE2E.editorClientPoint(2, 23));
  await page.keyboard.down("Control");
  await page.mouse.click(defPoint.x + 2, defPoint.y);
  await page.keyboard.up("Control");
  const jumped = await pollUntil(async () => {
    const label = await page.textContent(".dw-active-file");
    return label?.includes("math.ts") ? label : null;
  }, 8_000);
  assert(jumped !== null, `Ctrl+Click 后应跳转到 math.ts（活动文件: ${await page.textContent(".dw-active-file")}）`);
  if (jumped !== null) {
    const sels = await page.evaluate(() => window.__devwitE2E.editorSelections());
    const active = sels?.[0]?.active;
    assert(active?.line === 0, `跳转落点光标应在第 0 行（add 定义处，实际: ${JSON.stringify(active)}）`);
  }
  await page.screenshot({ path: path.join(OUT, "04-definition-jump.png") });
  step("Ctrl+Click：跨文件跳转定义 math.ts，光标落点 0 行（截图 04）");

  // ---- 6. 关闭文件回 main.ts：didClose 清 math.ts 诊断快照不崩 ----
  await page.click('.dw-tree-node:has-text("main.ts")');
  await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("main.ts"));
  const diagsBack = await pollUntil(async () => {
    const list = await page.evaluate(() => window.devwit.lsp.diagnostics());
    return list.some((d) => d.file === "main.ts" && d.severity === "error") ? list : null;
  }, 8_000);
  assert(diagsBack !== null,
    "切回 main.ts 后其诊断仍在（缓冲区 didOpen 重放）");
  step("文件切换：didClose/didOpen 生命周期无回归");
} catch (error) {
  fatal = error;
  console.error("[verify-i31] FATAL:", error);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  await stopElectron(electronProc);
}

report.fatal = fatal === null ? null : String(fatal);
report.ok = fatal === null && report.failures.length === 0;
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`[verify-i31] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败；证据 → evidence/AC40`);
if (!report.ok) {
  console.error("[verify-i31] FAILED");
  process.exit(1);
}
console.log("[verify-i31] OK");
