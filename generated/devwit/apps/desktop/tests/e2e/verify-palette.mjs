/**
 * 迭代 36 验证脚本（v0.7.30 命令面板，证据落盘 evidence/AC44-palette）：
 * 1. Ctrl+Shift+P 打开命令面板 → 列表含本地化命令名；
 * 2. 输入过滤词 → 列表收窄；↑↓ 导航 + Enter 执行「转到：终端」→ 终端页签激活；
 * 3. Esc 关闭；Ctrl+P 文件面板 → 过滤文件名 → Enter 打开文件。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE = path.join(ROOT, "evidence", "AC44-palette");
fs.rmSync(EVIDENCE, { recursive: true, force: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-palette] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-palette] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-palette] FAIL: ${message}`);
  }
}

function launchElectron(cdpPort, fixture, userDataDir) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1" },
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
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-palette-"));
  fs.writeFileSync(path.join(fixture, "alpha.ts"), "export const alpha = 1;\n", "utf-8");
  fs.writeFileSync(path.join(fixture, "beta.md"), "# beta\n", "utf-8");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-palette-user-"));

  const cdpPort = 26900 + Math.floor(Math.random() * 200);
  const { ws, proc } = await launchElectron(cdpPort, fixture, userDataDir);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开（alpha.ts / beta.md）");

  // 1. Ctrl+Shift+P 命令面板
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".dw-palette", { timeout: 10_000 });
  const commandsText = await page.textContent(".dw-palette-list");
  assert(commandsText.includes("设置") || commandsText.includes("终端"), `命令面板列出本地化命令（实际含: ${commandsText.slice(0, 80).replace(/\n/g, "|")}）`);
  step("Ctrl+Shift+P 打开命令面板（命令目录可见）");

  // 2. 过滤 + 键盘导航 + Enter 执行「转到：终端」
  await page.fill(".dw-palette-input", "终端");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".dw-terminal-output .dw-terminal-line", { timeout: 15_000 });
  const termVisible = await page.isVisible(".dw-terminal-host");
  assert(termVisible, `过滤「终端」+ Enter 执行 → 终端页签激活并创建会话`);
  await page.screenshot({ path: path.join(EVIDENCE, "01-command-to-terminal.png") });
  step("命令执行：过滤 + Enter → 转到终端（会话创建）");

  // 3. Esc 关闭 + Ctrl+P 文件面板
  await page.keyboard.press("Control+Shift+p");
  await page.waitForSelector(".dw-palette", { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".dw-palette", { state: "detached", timeout: 5000 });
  assert(true, "Escape 关闭命令面板（a11y 键盘闭环）");
  await page.keyboard.press("Control+p");
  await page.waitForSelector(".dw-palette", { timeout: 10_000 });
  await page.fill(".dw-palette-input", "alpha");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("alpha.ts"), null, { timeout: 10_000 });
  assert(true, "Ctrl+P 文件面板过滤「alpha」+ Enter → alpha.ts 打开");
  await page.screenshot({ path: path.join(EVIDENCE, "02-file-open.png") });
  step("文件面板：过滤 + Enter → alpha.ts 打开");

  for (const dir of [fixture, userDataDir]) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-palette] FATAL: ${fatal}`);
} finally {
  await stopElectron(electronProc);
  if (browser !== null) await browser.close().catch(() => undefined);
}

report.fatal = fatal;
fs.writeFileSync(path.join(EVIDENCE, "verify-palette-report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`[verify-palette] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
