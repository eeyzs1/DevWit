/**
 * 迭代 4 验证脚本（用户三反馈的修复回归，证据落盘 evidence/AC13）：
 * 1. 终端乱码：触发运行时错误后，主进程 stderr 无 CJK、无非法 UTF-8 序列；
 *    UI 侧同一错误显示为本地化中文（错误码 DW_* → localizeError）。
 * 2. 中英文切换残留：中文界面模式下拉框显示「对话/智能体」（displayModeName），
 *    设置页表单 label 经 t() 输出；切英文后下拉框显示 Chat/Agent，切回中文恢复。
 * 3. 外部编辑器无引导：未配置时点击「外部编辑器 ↗」弹出「选择外部编辑器」小页，
 *    预设一键填模板，「保存并打开」真实 spawn 落盘证明。
 *
 * 环境：真实 Electron + 全新临时 userData（无 provider / 无外部编辑器配置）+ 临时工作区。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC13");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i4-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i4-userdata-"));

const stderrChunks = [];
const stdoutChunks = [];

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    // --lang=zh-CN：固定中文界面（迭代 5 起首启语言跟随系统，测试环境可能是英文系统）
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    proc.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
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
const step = (name) => { report.steps.push(name); console.log(`[verify-i4] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i4] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i4] FAIL: ${message}`);
  }
}
/** 收集页面可见按钮/页签/下拉/表单 label 文本。 */
async function dumpTexts(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const pick = (selector) =>
      [...document.querySelectorAll(selector)].filter(visible).map((n) => n.textContent?.trim() ?? "").filter((s) => s !== "");
    return {
      buttons: pick("button"),
      selects: [...document.querySelectorAll("select")].filter(visible).map((s) => [...s.options].map((o) => o.textContent ?? "")),
      labels: pick(".dw-form label"),
    };
  });
}
/** 等待文件出现（detached spawn 落盘标记）。 */
async function waitForFile(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  const cdpPort = 21100 + Math.floor(Math.random() * 500);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  step("应用启动（全新 userData：无 provider、无外部编辑器配置，默认中文）");
  await page.screenshot({ path: path.join(OUT, "01-launch-zh.png") });

  // ---- 反馈 2a：中文界面模式下拉框显示「对话/智能体」（displayModeName 本地化）----
  const modeOptionsZh = await page.evaluate(() =>
    [...document.querySelectorAll('select[title="模式"] option')].map((o) => o.textContent ?? "")
  );
  assert(
    modeOptionsZh.some((o) => o.includes("对话")) && modeOptionsZh.some((o) => o.includes("智能体")),
    `中文界面模式下拉框显示「对话/智能体」（实际: ${modeOptionsZh.join(", ") || "未找到"})`
  );
  step("中文界面模式下拉框已本地化");

  // ---- 反馈 3：未配置外部编辑器 → 点击弹「选择外部编辑器」引导小页 ----
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  await page.click('.dw-tree-node:has-text("hello.txt")');
  await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("hello.txt"));
  await page.click(".dw-header >> text=外部编辑器");
  await page.waitForSelector(".dw-editor-setup", { timeout: 5_000 });
  const setupTitle = await page.textContent(".dw-editor-setup h2");
  assert(setupTitle === "选择外部编辑器", `未配置点击「外部编辑器 ↗」弹出引导小页（标题: ${setupTitle}）`);
  await page.screenshot({ path: path.join(OUT, "02-editor-setup-dialog.png") });
  step("引导小页弹出（不再无反应）");

  // 预设一键填模板 →「保存并打开」→ 真实 spawn 落盘
  const marker = `${path.join(fixture, "hello.txt")}.ext-proof`;
  await page.fill(
    ".dw-editor-setup .dw-input",
    'node -e "require(\'fs\').writeFileSync(process.argv[1],\'opened\')" "{file}.ext-proof"'
  );
  await page.click(".dw-editor-setup >> text=保存并打开");
  const spawned = await waitForFile(marker);
  assert(spawned, "「保存并打开」保存模板后立即重试打开（真实 spawn，标记文件落盘）");
  if (spawned) fs.rmSync(marker);
  await page.screenshot({ path: path.join(OUT, "03-editor-setup-save-open.png") });
  step("引导小页保存并打开 → 真实 spawn 验证");

  // ---- 反馈 1：发消息（模式未绑定模型）→ UI 本地化中文 + stderr 无乱码 ----
  await page.fill(".dw-chat .dw-chat-textarea", "你好");
  await page.click(".dw-chat >> text=发送");
  await page.waitForSelector(".dw-msg-error", { timeout: 15_000 });
  const chatError = await page.evaluate(() => document.querySelector(".dw-msg-error")?.textContent ?? "");
  assert(
    chatError.includes("未绑定模型") && chatError.includes("对话"),
    `UI 错误为本地化中文且模式名已本地化（实际: ${chatError.slice(0, 80)}）`
  );
  assert(!/DW_MODE_UNBOUND/.test(chatError), `UI 错误不暴露内部错误码（实际: ${chatError.slice(0, 80)}）`);
  await page.waitForTimeout(1500); // 主进程 stderr 落盘
  await page.screenshot({ path: path.join(OUT, "04-chat-error-localized.png") });
  step(`UI 错误文案: ${chatError.slice(0, 60)}`);

  // ---- 反馈 2b：设置页表单 label 经 t() 输出（无游离硬编码英文）----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-mask");
  await page.click(".dw-settings-nav >> text=模型");
  await page.waitForTimeout(400);
  const providerDump = await dumpTexts(page);
  const labelsJoined = providerDump.labels.join("|");
  assert(
    labelsJoined.includes("类型") && labelsJoined.includes("显示名") && labelsJoined.includes("模型"),
    `设置·模型表单 label 已本地化（实际: ${labelsJoined.slice(0, 120)}）`
  );
  await page.screenshot({ path: path.join(OUT, "05-settings-provider-zh.png") });
  step("设置·模型分区 label dump 完成");

  // ---- 反馈 2c：切英文 → 下拉框 Chat/Agent、按钮英文；切回中文恢复 ----
  await page.click(".dw-settings-nav >> text=通用");
  await page.selectOption(".dw-settings-content select", "en-US");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "06-settings-en.png") });
  await page.keyboard.press("Escape");
  await page.click(".dw-modal-mask", { position: { x: 4, y: 4 } });
  await page.waitForTimeout(400);
  const modeOptionsEn = await page.evaluate(() =>
    [...document.querySelectorAll('select[title="Mode"] option')].map((o) => o.textContent ?? "")
  );
  assert(
    modeOptionsEn.some((o) => o.includes("Chat")) && modeOptionsEn.some((o) => o.includes("Agent")),
    `英文界面模式下拉框显示 Chat/Agent（实际: ${modeOptionsEn.join(", ") || "未找到"})`
  );
  await page.screenshot({ path: path.join(OUT, "07-main-en.png") });
  step("切英文：界面与模式名热切换");

  // 切回中文
  await page.click(".dw-header >> text=Settings");
  await page.waitForSelector(".dw-modal-mask");
  await page.click(".dw-settings-nav >> text=General");
  await page.selectOption(".dw-settings-content select", "zh-CN");
  await page.waitForTimeout(500);
  await page.click(".dw-modal-mask", { position: { x: 4, y: 4 } });
  await page.waitForTimeout(400);
  const modeOptionsBack = await page.evaluate(() =>
    [...document.querySelectorAll('select[title="模式"] option')].map((o) => o.textContent ?? "")
  );
  assert(
    modeOptionsBack.some((o) => o.includes("对话")) && modeOptionsBack.some((o) => o.includes("智能体")),
    `切回中文后模式下拉框恢复「对话/智能体」（实际: ${modeOptionsBack.join(", ") || "未找到"})`
  );
  await page.screenshot({ path: path.join(OUT, "08-back-zh.png") });
  step("英→中往返切换恢复");

  // ---- stderr 字节分析：无 CJK、无非法 UTF-8 序列（GBK 终端乱码根因消除）----
  const stderrBufAll = Buffer.concat(stderrChunks);
  const asUtf8 = stderrBufAll.toString("utf-8");
  const hasCjk = /[一-鿿]/.test(asUtf8);
  let invalidUtf8 = 0;
  for (let i = 0; i < stderrBufAll.length; i += 1) {
    const b = stderrBufAll[i];
    if (b >= 0x80) {
      const cont = stderrBufAll[i + 1];
      if ((b & 0xe0) === 0xc0) { if (cont === undefined || (cont & 0xc0) !== 0x80) invalidUtf8 += 1; else i += 1; }
      else if ((b & 0xf0) === 0xe0) {
        const c2 = stderrBufAll[i + 2];
        if (cont === undefined || c2 === undefined || (cont & 0xc0) !== 0x80 || (c2 & 0xc0) !== 0x80) invalidUtf8 += 1; else i += 2;
      }
    }
  }
  report.stderr = { bytes: stderrBufAll.length, hasCjk, invalidUtf8, tail: asUtf8.slice(-800) };
  fs.writeFileSync(path.join(OUT, "stderr-raw.bin"), stderrBufAll);
  assert(!hasCjk, `主进程 stderr 无 CJK 字符（${stderrBufAll.length}B，UTF-8 解码）`);
  assert(invalidUtf8 === 0, `主进程 stderr 无非法 UTF-8 序列（实际: ${invalidUtf8} 处）`);
  step(`stderr 分析: ${stderrBufAll.length}B, hasCjk=${hasCjk}, invalidUtf8=${invalidUtf8}`);
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i4] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i4-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration4-verification.txt"),
    [
      "迭代 4（用户三反馈修复）验证：",
      `1. 终端乱码：触发模式未绑定错误后，主进程 stderr ${report.stderr?.bytes ?? "?"}B，UTF-8 解码含 CJK=${report.stderr?.hasCjk ?? "?"},非法 UTF-8 序列=${report.stderr?.invalidUtf8 ?? "?"}。机制：主进程抛 ASCII 错误码（DW_MODE_UNBOUND 等），渲染端 localizeError 按当前语言映射为词典文案。`,
      "2. 中英文切换：中文界面模式下拉框显示「对话/智能体」（内置模式工厂名经 displayModeName 本地化），设置·模型表单 label 全部经 t() 输出；切英文显示 Chat/Agent，切回中文恢复。",
      "3. 外部编辑器引导：未配置时点击「外部编辑器 ↗」弹出「选择外部编辑器」小页（预设一键填模板 + 自定义），「保存并打开」保存后立即重试打开——真实 spawn 子进程，标记文件 hello.txt.ext-proof 落盘证明（已清理）。",
      `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
    ].join("\n"),
    "utf-8"
  );
  if (browser !== null) await browser.close();
  electronProc?.kill();
  if (report.failures.length > 0) {
    console.error(`[verify-i4] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i4-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i4] 全部断言通过，证据已写入 ${OUT}`);
}
