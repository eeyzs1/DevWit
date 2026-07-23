/**
 * 迭代 7 验证脚本（AC16 自动更新，证据落盘 evidence/AC16）：
 * 1. 启动静默检查：DEVWIT_E2E_FAKE_UPDATE 注入合成序列（真实加载 electron-updater
 *    验证 bundle 完整性，不联网/不下载），状态栏出现「新版本 v9.9.9 已就绪」+「重启更新」按钮；
 * 2. 设置 · 通用：当前版本展示 + 「检查更新」手动触发（合成回放）内联结果；
 * 3. 语言热切换：切英文后更新提示区与设置页更新行无 CJK 残留，切回中文恢复。
 *
 * 环境：真实 Electron + 全新临时 userData（DEVWIT_E2E_FAKE_UPDATE=1，默认中文）。
 * 真实 GitHub 链路的验证由打包环境（npm run pack）手动确认 + release.yml 上传 latest.yml 保证。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC16");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i7-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i7-userdata-"));

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWIT_E2E_OPEN_DIR: fixture,
        DEVWIT_USER_DATA_DIR: userDataDir,
        DEVWIT_E2E_FAKE_UPDATE: "1",
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

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i7] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i7] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i7] FAIL: ${message}`);
  }
}
const CJK = /[一-鿿]/;

let browser = null;
let electronProc = null;
let fatal = null;
try {
  const cdpPort = 21700 + Math.floor(Math.random() * 500);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  step("应用启动（DEVWIT_E2E_FAKE_UPDATE=1，默认中文）");

  // ---- 1. 启动静默检查 → 状态栏 ready 提示 + 重启按钮 ----
  await page.waitForSelector(".dw-update .dw-update-text", { timeout: 15_000 });
  const readyText = await page.textContent(".dw-update .dw-update-text");
  assert(readyText?.includes("新版本 v9.9.9 已就绪"), `状态栏就绪文案（实际: ${readyText}）`);
  const restartBtn = await page.textContent(".dw-update button");
  assert(restartBtn?.includes("重启更新"), `重启更新按钮（实际: ${restartBtn}）`);
  const statusMsg = await page.textContent(".dw-status-message");
  assert(statusMsg?.includes("已就绪"), `瞬态提示就绪（实际: ${statusMsg}）`);
  await page.screenshot({ path: path.join(OUT, "01-statusbar-ready-zh.png") });
  step("状态栏更新提示（中文）断言完成");

  // ---- 2. 设置 · 通用：版本展示 + 手动检查内联结果 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-mask");
  await page.waitForSelector(".dw-settings-update");
  const checkBtnText = await page.textContent(".dw-settings-update button");
  assert(checkBtnText?.includes("检查更新"), `设置页检查更新按钮（实际: ${checkBtnText}）`);
  await page.waitForFunction(
    () => document.querySelector(".dw-settings-update-status")?.textContent?.includes("当前版本"),
    null,
    { timeout: 5000 }
  );
  const versionText = await page.textContent(".dw-settings-update-status");
  assert(/当前版本 v\d+\.\d+\.\d+/.test(versionText ?? ""), `当前版本展示（实际: ${versionText}）`);
  await page.click(".dw-settings-update button");
  await page.waitForFunction(
    () => document.querySelector(".dw-settings-update-status")?.textContent?.includes("已就绪"),
    null,
    { timeout: 10_000 }
  );
  const inlineReady = await page.textContent(".dw-settings-update-status");
  assert(inlineReady?.includes("新版本 v9.9.9 已就绪"), `手动检查内联结果（实际: ${inlineReady}）`);
  await page.screenshot({ path: path.join(OUT, "02-settings-update-zh.png") });
  step("设置·通用 手动检查（中文）断言完成");

  // ---- 3. 切英文：更新提示区与设置页无 CJK 残留；切回中文恢复 ----
  await page.selectOption(".dw-settings-content select", "en-US");
  await page.waitForTimeout(600);
  const enUpdateText = await page.textContent(".dw-update .dw-update-text");
  assert(enUpdateText?.includes("Version v9.9.9 is ready"), `英文状态栏就绪文案（实际: ${enUpdateText}）`);
  const enRestart = await page.textContent(".dw-update button");
  assert(enRestart?.includes("Restart to update"), `英文重启按钮（实际: ${enRestart}）`);
  assert(!CJK.test(enUpdateText ?? "") && !CJK.test(enRestart ?? ""), "英文更新提示区无 CJK 残留");
  const enRow = await page.textContent(".dw-settings-update");
  assert(enRow?.includes("Check for updates"), `英文设置页更新行（实际: ${enRow}）`);
  await page.screenshot({ path: path.join(OUT, "03-update-en.png") });
  step("英文热切换断言完成");

  await page.selectOption(".dw-settings-content select", "zh-CN");
  await page.waitForTimeout(600);
  const zhBack = await page.textContent(".dw-update .dw-update-text");
  assert(zhBack?.includes("新版本 v9.9.9 已就绪"), `切回中文恢复（实际: ${zhBack}）`);
  await page.click(".dw-modal-mask", { position: { x: 4, y: 4 } });
  await page.screenshot({ path: path.join(OUT, "04-back-zh.png") });
  step("切回中文断言完成");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i7] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i7-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration7-verification.txt"),
    [
      "迭代 7（AC16 自动更新）验证：",
      "1. 启动静默检查：合成序列经真实 electron-updater 加载链路回放（bundle 完整性已验证），状态栏「新版本 v9.9.9 已就绪」+「重启更新」按钮。",
      "2. 设置 · 通用：当前版本 vX.Y.Z 展示，「检查更新」手动触发后内联显示就绪结果。",
      "3. 语言热切换：英文下更新提示区/设置页更新行无 CJK 残留，切回中文恢复。",
      "真实 GitHub 链路：electron-builder.yml publish → eeyzs1/DevWit Releases；release.yml 已补传 latest.yml（下一 tag 起生效），打包环境（npm run pack）手动确认真实检查。",
      `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
    ].join("\n"),
    "utf-8"
  );
  if (browser !== null) await browser.close();
  electronProc?.kill();
  if (report.failures.length > 0) {
    console.error(`[verify-i7] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i7-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i7] 全部断言通过，证据已写入 ${OUT}`);
}
