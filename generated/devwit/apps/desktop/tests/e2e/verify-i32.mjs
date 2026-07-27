/**
 * 迭代 32 验证脚本（AC41 Git 集成：面板/状态栏/文件树徽章/diff/暂存/提交，证据落盘 evidence/AC41）：
 * 1. fixture 为真实 git 仓库（git init + 初始提交）：1 个工作区修改 + 1 个未跟踪文件；
 * 2. 打开工作区 → 状态栏显示 ⑂ 分支 + ✚2 变更计数；文件树 hello.ts 带 M 徽章；
 * 3. 切到 Git 页签 → 面板分组「变更 (1)」「未跟踪 (1)」+ 分支头；
 * 4. 点击变更行 → 只读 diff 视图打开（标题含 HEAD ↔ 工作区，含 +/- 行）；
 * 5. 点「+」暂存 → git:changed 推送 → 行移入「已暂存 (1)」分组；
 * 6. 输入提交消息提交 → 面板回到「工作区干净」，状态栏仅分支无计数；
 * 7. git log 硬断言新提交真实落盘（全链路真实 git CLI，零 mock）。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC41");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i32-userdata-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i32-"));

// ---- fixture：真实 git 仓库（hello.ts 已跟踪；readme.md 已跟踪）----
const git = (args) => execFileSync("git", args, { cwd: fixture, encoding: "utf-8" });
fs.writeFileSync(path.join(fixture, "hello.ts"), "export const hello = 'world';\n", "utf-8");
fs.writeFileSync(path.join(fixture, "readme.md"), "# fixture\n", "utf-8");
git(["init", "-b", "main"]);
git(["config", "user.email", "e2e@devwit.local"]);
git(["config", "user.name", "DevWit E2E"]);
git(["add", "."]);
git(["commit", "-m", "init"]);
// 制造：1 工作区修改（hello.ts）+ 1 未跟踪（new-file.ts）
fs.writeFileSync(path.join(fixture, "hello.ts"), "export const hello = 'devwit';\nexport const v = 2;\n", "utf-8");
fs.writeFileSync(path.join(fixture, "new-file.ts"), "export const fresh = true;\n", "utf-8");

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i32] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i32] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i32] FAIL: ${message}`);
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
  const cdpPort = 25500 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  // ---- 0. 打开 fixture 工作区（真实 git 仓库）----
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + git fixture 工作区打开（hello.ts 修改 / new-file.ts 未跟踪）");

  // ---- 1. 状态栏：⑂ main + ✚2（git:get-status IPC 真实 porcelain 解析）----
  const statusGit = await pollUntil(async () => {
    const text = await page.textContent(".dw-status-git");
    return text?.includes("⑂") ? text : null;
  }, 10_000);
  assert(statusGit !== null, "状态栏应显示 git 分支（非 git 工作区应为空）");
  assert(statusGit?.includes("main") === true, `分支应为 main（实际: ${JSON.stringify(statusGit)}）`);
  const withCount = await pollUntil(async () => {
    const text = await page.textContent(".dw-status-git");
    return text?.includes("✚2") ? text : null;
  }, 10_000);
  assert(withCount !== null, `状态栏应显示变更计数 ✚2（实际: ${JSON.stringify(await page.textContent(".dw-status-git"))}）`);
  step("状态栏：⑂ main ✚2（1 修改 + 1 未跟踪）");

  // ---- 2. 文件树徽章：hello.ts 应带 M（porcelain 字母映射到树节点）----
  const badge = await pollUntil(async () => {
    return await page.evaluate(() => {
      for (const node of document.querySelectorAll(".dw-tree-node")) {
        if (node.textContent?.includes("hello.ts")) {
          const b = node.querySelector(".dw-tree-badge");
          return b && b.textContent !== "" ? b.textContent : null;
        }
      }
      return null;
    });
  }, 10_000);
  assert(badge === "M", `hello.ts 文件树徽章应为 M（实际: ${JSON.stringify(badge)}）`);
  await page.screenshot({ path: path.join(OUT, "01-statusbar-tree-badge.png") });
  step("文件树徽章：hello.ts → M（截图 01）");

  // ---- 3. Git 页签：分组「变更 (1)」「未跟踪 (1)」----
  await page.click(".dw-left-tabs >> text=Git");
  await page.waitForSelector(".dw-git-row", { timeout: 10_000 });
  const groupTitles = await page.$$eval(".dw-git-group-title", (nodes) => nodes.map((n) => n.textContent));
  assert(groupTitles.some((g) => g?.includes("变更 (1)")) === true,
    `应有「变更 (1)」分组（实际: ${JSON.stringify(groupTitles)}）`);
  assert(groupTitles.some((g) => g?.includes("未跟踪 (1)")) === true,
    `应有「未跟踪 (1)」分组（实际: ${JSON.stringify(groupTitles)}）`);
  const headBranch = await page.textContent(".dw-git-branch");
  assert(headBranch?.includes("main") === true, `面板头部应显示分支 main（实际: ${JSON.stringify(headBranch)}）`);
  await page.screenshot({ path: path.join(OUT, "02-git-panel.png") });
  step("Git 面板：变更/未跟踪分组 + 分支头（截图 02）");

  // ---- 4. 点击变更行 → 只读 diff 视图（HEAD ↔ 工作区，含 +/- 行）----
  await page.click('.dw-git-row:has-text("hello.ts")');
  await page.waitForSelector(".dw-diff-overlay", { timeout: 10_000 });
  const diffTitle = await page.textContent(".dw-diff-header");
  assert(diffTitle?.includes("hello.ts") === true, `diff 标题应含 hello.ts（实际: ${JSON.stringify(diffTitle)}）`);
  const removeLines = await page.$$eval(".dw-diff-remove", (nodes) => nodes.map((n) => n.textContent));
  const addLines = await page.$$eval(".dw-diff-add", (nodes) => nodes.map((n) => n.textContent));
  assert(removeLines.some((l) => l?.includes("world")) === true,
    `diff 应含删除行（world，实际: ${JSON.stringify(removeLines)}）`);
  assert(addLines.some((l) => l?.includes("devwit")) === true,
    `diff 应含新增行（devwit，实际: ${JSON.stringify(addLines)}）`);
  await page.screenshot({ path: path.join(OUT, "03-git-diff.png") });
  // 关闭 diff（复用 dw-diff 关闭按钮）
  await page.click(".dw-diff-header >> text=关闭");
  await page.waitForSelector(".dw-diff-overlay", { state: "detached", timeout: 5_000 });
  step("只读 diff 视图：HEAD ↔ 工作区，删除/新增行硬断言（截图 03）");

  // ---- 5. 暂存 hello.ts：git:changed 推送 → 移入「已暂存 (1)」----
  await page.hover('.dw-git-row:has-text("hello.ts")');
  await page.click('.dw-git-row:has-text("hello.ts") .dw-git-action');
  const stagedGroup = await pollUntil(async () => {
    const titles = await page.$$eval(".dw-git-group-title", (nodes) => nodes.map((n) => n.textContent));
    return titles.some((g) => g?.includes("已暂存 (1)")) ? titles : null;
  }, 10_000);
  assert(stagedGroup !== null,
    `暂存后应出现「已暂存 (1)」分组（实际: ${JSON.stringify(await page.$$eval(".dw-git-group-title", (n) => n.map((x) => x.textContent)))}）`);
  // 暂存后 porcelain 事实核验（CLI 直查，双通道一致）
  const porcelainAfterStage = git(["status", "--porcelain=v1"]);
  assert(/^M  hello\.ts$/m.test(porcelainAfterStage), `hello.ts 应入 index（porcelain: ${JSON.stringify(porcelainAfterStage)}）`);
  await page.screenshot({ path: path.join(OUT, "04-staged.png") });
  step("暂存：UI 分组迁移 + git CLI 事实一致（截图 04）");

  // ---- 6. 提交：输入消息 → 面板干净 + 状态栏仅分支 ----
  await page.fill(".dw-git-commit-input", "e2e: stage hello");
  await page.click(".dw-git-foot >> text=提交");
  const clean = await pollUntil(async () => {
    const text = await page.textContent(".dw-git-body");
    return text?.includes("工作区干净") || text?.includes("new-file.ts") ? text : null;
  }, 10_000);
  assert(clean !== null, "提交后已暂存分组应消失");
  const statusAfterCommit = await pollUntil(async () => {
    const text = await page.textContent(".dw-status-git");
    // 提交后仅剩未跟踪 1 项 → ✚1
    return text?.includes("✚1") ? text : null;
  }, 10_000);
  assert(statusAfterCommit !== null,
    `提交后状态栏应为 ✚1（剩未跟踪，实际: ${JSON.stringify(await page.textContent(".dw-status-git"))}）`);
  const log = git(["log", "--oneline", "-1"]);
  assert(log.includes("e2e: stage hello"), `git log 应含新提交（实际: ${JSON.stringify(log)}）`);
  await page.screenshot({ path: path.join(OUT, "05-committed.png") });
  step("提交：真实 commit 落盘（git log 硬断言）+ 状态栏 ✚2→✚1（截图 05）");
} catch (error) {
  fatal = error;
  console.error("[verify-i32] FATAL:", error);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  await stopElectron(electronProc);
}

report.fatal = fatal === null ? null : String(fatal);
report.ok = fatal === null && report.failures.length === 0;
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`[verify-i32] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败；证据 → evidence/AC41`);
if (!report.ok) {
  console.error("[verify-i32] FAILED");
  process.exit(1);
}
console.log("[verify-i32] OK");
