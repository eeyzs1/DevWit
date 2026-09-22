/**
 * 迭代 34 验证脚本（v0.7.13/0.7.14 编辑器语义修复回归，证据落盘 evidence/AC43）：
 *
 * 用真实 Electron + 真实 canvas + 真实鼠标/键盘事件（Alt+Click 多光标、
 * Ctrl+Backspace、Backspace、Ctrl+Z、打字、Ctrl+S）锁定四项修复——单元测试
 * 只覆盖纯函数（edit-ops.ts），本脚本锁定 EditorView 端到端语义：
 * 1. E1 多光标词删除偏移：双光标 Ctrl+Backspace 后按实际删除长度结算
 *    （旧「低位光标个数」算法高位光标偏右 1+ 列）；
 * 2. E4 undo 选区恢复：打字 "abc" 后一次 Ctrl+Z，光标回输入起点列；
 * 3. E2 重合光标去重：双光标退格汇聚后去重（旧实现后续每键重复插入）；
 * 4. E7 代理对删除：emoji 后退格删整个代理对（旧实现拆散留乱码）。
 * 最终 Ctrl+S 落盘，fixture 文件内容与期望逐字节比对（真实写盘证据）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE = path.join(ROOT, "evidence", "AC43");
fs.rmSync(EVIDENCE, { recursive: true, force: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

const INITIAL = "xx foo bar yy\nhelloworld\na😀b\n";
// E1 删 "foo"+"bar"（词块不含尾随空格）→ "xx···yy"（3 空格）；E2 删首 'x' + 打 Q；
// E7 从行尾退格两次：先删 'b'（1 码元），再删 emoji 整对（2 码元）→ 行 2 终态 "a"
//（若旧实现拆散代理对，终态会多出一个孤立代理码元——逐字节比对即判别）
const EXPECTED_FINAL = "Qx   yy\nhelloworld\na\n";

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i34] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i34] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i34] FAIL: ${message}`);
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

async function clickAt(page, line, col, withAlt = false) {
  const point = await page.evaluate(
    ({ l, c }) => window.__devwitE2E.editorClientPoint(l, c),
    { l: line, c: col }
  );
  // 注：Playwright 的 modifiers:["Alt"] 在 Electron 上修饰键不达渲染层（实测
  // altKey=false，被替换而非追加光标）——改显式 keyboard.down/up 按住 Alt，
  // 真实 mousedown 携带 altKey:true（探针实证 alts:true）。
  if (withAlt) await page.keyboard.down("Alt");
  await page.mouse.click(point.x, point.y);
  if (withAlt) await page.keyboard.up("Alt");
}

async function selections(page) {
  return page.evaluate(() => window.__devwitE2E.editorSelections());
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i34-"));
  const filePath = path.join(fixture, "t.txt");
  fs.writeFileSync(filePath, INITIAL, "utf-8");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i34-user-"));

  const cdpPort = 26300 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort, fixture, userDataDir);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  await page.click('.dw-tree-node:has-text("t.txt")');
  await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("t.txt"));
  await page.focus('textarea[aria-label="editor input"]');
  step("应用启动 + fixture 打开（t.txt：词行/undo 行/emoji 行）");

  // ---- 断言 1（E1）：多光标 Ctrl+Backspace 按实际删除长度结算 ----
  // "xx foo bar yy"：主光标点 (0,10)（bar 后），Alt+Click (0,6)（foo 后）
  await clickAt(page, 0, 10);
  await clickAt(page, 0, 6, true);
  let sels = await selections(page);
  assert(sels.length === 2, `Alt+Click 应产生双光标（实际 ${sels.length}）`);
  await page.keyboard.press("Control+Backspace");
  sels = await selections(page);
  const cols = sels.map((s) => s.active.character).sort((a, b) => a - b);
  // 期望：低位光标删 "foo" 落列 3；高位光标删 "bar" 落列 7-3=4（旧算法误得 6）
  assert(
    sels.length === 2 && cols[0] === 3 && cols[1] === 4,
    `词删除后光标应落列 [3,4]（实际 ${JSON.stringify(cols)}，旧算法为 [3,6]）`
  );
  step("E1 多光标词删除：双光标 Ctrl+Backspace 落列 [3,4]（实际删除长度结算）");

  // ---- 断言 2（E4）：打字后一次 undo，光标回输入起点 ----
  await page.keyboard.press("Escape"); // 多光标折叠为主光标
  await clickAt(page, 1, 5); // helloworld 第 5 列
  await page.keyboard.type("abc");
  sels = await selections(page);
  assert(sels.length === 1 && sels[0].active.line === 1 && sels[0].active.character === 8,
    `打字 abc 后光标应落 (1,8)（实际 ${JSON.stringify(sels[0]?.active)}）`);
  await page.keyboard.press("Control+z");
  sels = await selections(page);
  assert(sels.length === 1 && sels[0].active.line === 1 && sels[0].active.character === 5,
    `undo 后光标应回输入起点 (1,5)（实际 ${JSON.stringify(sels[0]?.active)}，旧实现停在 (1,8) 词中间）`);
  step("E4 undo 选区恢复：打字 abc → Ctrl+Z → 光标回 (1,5)");

  // ---- 断言 3（E2）：双光标退格汇聚 → 去重（后续打字不重复插入）----
  await clickAt(page, 0, 1); // "xx  yy" 列 1
  await clickAt(page, 0, 0, true); // 列 0（重合待汇聚）
  sels = await selections(page);
  assert(sels.length === 2, `Alt+Click 双光标就位（实际 ${sels.length}）`);
  await page.keyboard.press("Backspace");
  sels = await selections(page);
  assert(sels.length === 1 && sels[0].active.line === 0 && sels[0].active.character === 0,
    `退格汇聚后应去重为单光标 (0,0)（实际 ${sels.length} 个：${JSON.stringify(sels.map((s) => s.active))}）`);
  await page.keyboard.type("Q");
  sels = await selections(page);
  assert(sels.length === 1 && sels[0].active.character === 1,
    `去重后打字 Q 仍单光标且前进一列（实际 ${sels.length} 个，col=${sels[0]?.active.character}；旧实现插两遍）`);
  step("E2 重合光标去重：退格汇聚 → 单光标 → 打字不重复");

  // ---- 断言 4（E7）：emoji 整对删除 ----
  // 从行尾 (2,4) 退格两次：第 1 次删 'b'（单码元，光标→3），第 2 次删 emoji
  // 整对（2 码元，光标→1）。不直接点 emoji 右缘——该 x 恰在代理对与 'b' 的
  // 渲染边界，列换算存在单位歧义（可能落进代理对中间），从行尾走无歧义。
  await clickAt(page, 2, 4);
  await page.keyboard.press("Backspace");
  sels = await selections(page);
  assert(sels[0].active.line === 2 && sels[0].active.character === 3,
    `删 b 后光标应落 (2,3)（实际 ${JSON.stringify(sels[0]?.active)}）`);
  await page.keyboard.press("Backspace");
  sels = await selections(page);
  assert(sels[0].active.line === 2 && sels[0].active.character === 1,
    `emoji 退格应整对删除光标落 (2,1)（实际 ${JSON.stringify(sels[0]?.active)}；拆散代理对时光标在 2）`);
  step("E7 代理对删除：行尾退格两次 = 删 b + 删整对 emoji，光标 (2,3)→(2,1)");

  // ---- 真实写盘证据：Ctrl+S → fixture 逐字节比对 ----
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(500);
  const finalContent = fs.readFileSync(filePath, "utf-8");
  assert(finalContent === EXPECTED_FINAL,
    `保存后文件应为 ${JSON.stringify(EXPECTED_FINAL)}（实际 ${JSON.stringify(finalContent)}）`);
  fs.writeFileSync(path.join(EVIDENCE, "final-file.txt"), finalContent, "utf-8");
  await page.screenshot({ path: path.join(EVIDENCE, "01-editor-semantics.png") });
  step("真实写盘证据：Ctrl+S 后 fixture 逐字节一致（emoji 无乱码/单 Q 插入）");

  // 清理容错：Electron 字典文件句柄在进程退出后短暂残留（EBUSY），重试后
  // 仍失败则留给 OS 临时目录回收——不得让清理失败掩盖断言结果
  for (const dir of [fixture, userDataDir]) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error(`[verify-i34] FATAL: ${fatal}`);
} finally {
  await stopElectron(electronProc);
  if (browser !== null) await browser.close().catch(() => undefined);
}

report.fatal = fatal;
fs.writeFileSync(path.join(EVIDENCE, "verify-i34-report.json"), JSON.stringify(report, null, 2), "utf-8");
fs.writeFileSync(
  path.join(EVIDENCE, "iteration34-verification.txt"),
  [
    "迭代 34（v0.7.13/0.7.14 编辑器语义修复回归）：",
    "1. E1 多光标词删除：双光标 Ctrl+Backspace 按实际删除长度结算（旧「个数」算法高位偏右）。",
    "2. E4 undo 选区恢复：打字 abc 一次撤销，光标回输入起点（旧实现停词中间）。",
    "3. E2 重合光标去重：退格汇聚后去重，后续打字不重复插入。",
    "4. E7 代理对删除：emoji 退格删整对（旧实现拆散留乱码）。",
    "5. 真实写盘：Ctrl+S 后 fixture 内容逐字节一致。",
    `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
  ].join("\n"),
  "utf-8"
);
console.log(`[verify-i34] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败`);
process.exit(report.failures.length > 0 || fatal !== null ? 1 : 0);
