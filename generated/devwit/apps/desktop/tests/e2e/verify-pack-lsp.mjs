/**
 * 迭代 31 打包产物烟测（AC40 第 4 条：pack 产物 LSP 全链路真实可用）：
 * 1. 直接启动 electron-builder --dir 产物 DevWit.exe（asar + asarUnpack 布局）；
 * 2. 打开 TS fixture 工作区 → LSP 状态达 ready（require.resolve 命中 asar，
 *    app.asar → app.asar.unpacked 替换后 spawn cli.mjs 成功）；
 * 3. 打开 main.ts → publishDiagnostics 真实推送 error 条目；
 * 4. 退出后零孤儿进程（cli.mjs / tsserver.js 全部回收，同 MCP 口径）。
 *
 * 与 verify-i31（dev 布局）互补：本脚本验证的是「用户实际安装的形态」。
 * 运行前提：先执行 npm run pack（或 electron-builder --dir）生成 release/win-unpacked。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
// 产物路径可由 DEVWIT_PACK_EXE 覆盖（release 目录被占用时打包到备用输出目录的场景）
const PACK_EXE = process.env.DEVWIT_PACK_EXE ?? path.join(ROOT, "release", "win-unpacked", "DevWit.exe");
const OUT = path.join(ROOT, "evidence", "AC40");
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(PACK_EXE)) {
  console.error(`[verify-pack-lsp] 未找到打包产物: ${PACK_EXE}（先运行 npm run pack）`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-pack-userdata-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-pack-"));
fs.writeFileSync(path.join(fixture, "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n", "utf-8");
fs.writeFileSync(path.join(fixture, "main.ts"), "import { add } from './math';\n\nconst total: number = add(1, 2);\nconst bad: number = 'oops';\n", "utf-8");
fs.writeFileSync(path.join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "ESNext", moduleResolution: "Bundler" } }), "utf-8");

const report = { assertions: [], failures: [] };
function assert(cond, message) {
  if (cond) { report.assertions.push(message); console.log(`[verify-pack-lsp] PASS: ${message}`); }
  else { report.failures.push(message); console.error(`[verify-pack-lsp] FAIL: ${message}`); }
}
async function pollUntil(fn, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
/** 系统进程表里匹配命令行的存活进程数（孤儿检测）。 */
function countProcesses(pattern) {
  return new Promise((resolve) => {
    spawn("powershell", ["-NoProfile", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${pattern}' }).Count`], { stdio: ["ignore", "pipe", "ignore"] })
      .stdout.on("data", (chunk) => resolve(Number.parseInt(chunk.toString().trim(), 10) || 0));
  });
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  const cdpPort = 9341;
  electronProc = spawn(PACK_EXE, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN"], {
    env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  const ws = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP 超时: ${stderrBuf.slice(0, 300)}`)), 30_000);
    electronProc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    electronProc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`退出 code=${code}: ${stderrBuf.slice(0, 300)}`)); });
  });
  browser = await chromium.connectOverCDP(ws);
  const page = browser.contexts()[0].pages()[0];

  // 1. 打开工作区（DEVWIT_E2E_OPEN_DIR 跳过原生对话框）→ LSP ready
  await page.waitForSelector(".dw-btn");
  await page.click('button:has-text("打开文件夹")');
  const status = await pollUntil(async () => {
    const s = await page.evaluate(() => window.devwit.lsp.getStatus());
    return s.state === "ready" ? s : null;
  }, 30_000);
  assert(status !== null, `打包产物 LSP 状态机应达 ready（实际: ${JSON.stringify(await page.evaluate(() => window.devwit.lsp.getStatus()))}）`);

  // 2. 打开 main.ts → 真实诊断推送
  await page.click('.dw-tree-node:has-text("main.ts")');
  await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("main.ts"));
  const firstError = await pollUntil(async () => {
    const diags = await page.evaluate(() => window.devwit.lsp.diagnostics());
    return diags.find((d) => d.file === "main.ts" && d.severity === "error") ?? null;
  }, 25_000);
  assert(firstError !== null, "打包产物 publishDiagnostics 应推送 main.ts 类型错误");
  if (firstError !== null) {
    assert(firstError.line === 3, `错误行应为 3（实际: ${firstError.line}）`);
  }
  await page.screenshot({ path: path.join(OUT, "05-pack-lsp.png") });

  // 3. 优雅退出 → 零孤儿进程（asarUnpack 布局下 shutdown/exit 序列真实生效）
  await browser.close();
  browser = null;
  electronProc.kill();
  await new Promise((r) => setTimeout(r, 5_000));
  const orphans = (await countProcesses("cli\\.mjs")) + (await countProcesses("tsserver\\.js"));
  assert(orphans === 0, `退出后零孤儿 LSP 进程（实际残留: ${orphans}）`);
} catch (error) {
  fatal = error;
  console.error("[verify-pack-lsp] FATAL:", error);
} finally {
  if (browser !== null) await browser.close().catch(() => undefined);
  if (electronProc !== null && !electronProc.killed) electronProc.kill();
}

report.fatal = fatal === null ? null : String(fatal);
report.ok = fatal === null && report.failures.length === 0;
fs.writeFileSync(path.join(OUT, "pack-report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`[verify-pack-lsp] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败；证据 → evidence/AC40`);
if (!report.ok) { console.error("[verify-pack-lsp] FAILED"); process.exit(1); }
console.log("[verify-pack-lsp] OK");
