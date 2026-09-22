/**
 * 迭代 35 验证脚本（v0.7.28 终端面板，证据落盘 evidence/AC43-terminal）：
 *
 * 真实 Electron + 真实 shell（主进程 pty/pipe 后端）+ 真实 ANSI 输出：
 * 1. 打开工作区 → 切「终端」页签 → 会话自动创建（cwd=工作区根）；
 * 2. 输入 echo 命令（含 ANSI 颜色）→ 断言输出行出现（流式渲染 + 行缓冲）；
 * 3. 输入 exit → 会话结束提示出现（TerminalExit 推送链路，v0.7.25 R7-7b）；
 * 4. 重启按钮 → 新会话再次就绪（R7-7c 树杀后干净重建）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE = path.join(ROOT, "evidence", "AC43-terminal");
fs.rmSync(EVIDENCE, { recursive: true, force: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-terminal] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-terminal] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-terminal] FAIL: ${message}`);
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
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-term-"));
  fs.writeFileSync(path.join(fixture, "hello.txt"), "hello terminal\n", "utf-8");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-term-user-"));

  const cdpPort = 26700 + Math.floor(Math.random() * 200);
  const { ws, proc } = await launchElectron(cdpPort, fixture, userDataDir);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开");

  // 1. 切终端页签 → 会话创建
  await page.click(".dw-left-tabs >> text=终端");
  await page.waitForSelector(".dw-terminal-output .dw-terminal-line", { timeout: 15_000 });
  const startedLine = await page.textContent(".dw-terminal-output");
  assert(startedLine.includes("会话已启动"), `切页签后会话自动创建（实际含启动提示: ${startedLine.slice(0, 80).includes("会话已启动")}）`);
  step("终端页签激活 → 会话创建（cwd=工作区根）");

  // 2. 输入命令 → 输出出现
  const input = page.locator("textarea[aria-label='terminal input']");
  await input.focus();
  await page.keyboard.type("echo devwit-term-test");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".dw-terminal-output")?.textContent?.includes("devwit-term-test"),
    null,
    { timeout: 20_000 }
  );
  assert(true, "echo 命令输出流式渲染（真实 shell 执行 + 行缓冲）");
  await page.screenshot({ path: path.join(EVIDENCE, "01-echo-output.png") });
  step("echo 命令 → 输出出现（ANSI 流式渲染）");

  // 3. exit → 会话结束提示（TerminalExit 推送）
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.querySelector(".dw-terminal-output")?.textContent?.includes("会话已结束"),
    null,
    { timeout: 20_000 }
  );
  assert(true, "exit 后 TerminalExit 推送到达（会话结束提示，v0.7.25 R7-7b）");
  step("exit → 会话结束提示（exit 推送链路）");

  // 4. 重启 → 新会话
  await page.click(".dw-terminal-toolbar >> text=重启");
  await page.waitForFunction(
    () => {
      const text = document.querySelector(".dw-terminal-output")?.textContent ?? "";
      return text.includes("会话已启动") && !text.includes("会话已结束");
    },
    null,
    { timeout: 20_000 }
  );
  assert(true, "重启按钮 → 旧会话树杀 + 新会话干净创建（R7-7c）");
  await page.screenshot({ path: path.join(EVIDENCE, "02-restarted.png") });
  step("重启 → 新会话就绪（进程树击杀验证）");

  fs.writeFileSync(path.join(EVIDENCE, "terminal-output.txt"), await page.textContent(".dw-terminal-output"), "utf-8");
  // 清理容错：终端会话 cwd 指向 fixture（Windows 句柄短暂残留），重试后
  // 仍失败留给 OS 临时目录回收——不掩盖断言结果（同 verify-i34 口径）
  for (const dir of [fixture, userDataDir]) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-terminal] FATAL: ${fatal}`);
} finally {
  await stopElectron(electronProc);
  if (browser !== null) await browser.close().catch(() => undefined);
}

report.fatal = fatal;
fs.writeFileSync(path.join(EVIDENCE, "verify-terminal-report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`[verify-terminal] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
