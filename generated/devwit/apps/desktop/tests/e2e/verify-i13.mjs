/**
 * 迭代 14 验证脚本（AC23 模式导出/导入 JSON——无账号的社区分享方式，证据落盘 evidence/AC23）：
 * 1. 设置·模式分区新建自定义模式（名称/提示词/工具勾选），保存成功；
 * 2. 行内「导出」→ 主进程写 JSON 文件：信封 kind=devwit-mode/version=1，负载剥离
 *    id/builtin/createdAt/updatedAt（机器本地字段不随文件传播）；
 * 3. 删除该模式 → 列表清空 → 「导入」→ 同名模式恢复：新 id、builtin=false、负载全保真；
 * 4. 导入结果直接入表单（id 为新生成值），用户可立即检查/重绑；
 * 5. 篡改 kind → 导入拒绝并本地化报错「不是 DevWit 模式文件」；
 * 6. 非 JSON 文件 → 报错「不是有效的 JSON」；
 * 7. 文件内 providerId 本机不存在 → 导入后清空为未绑定（跨机分享语义）。
 *
 * 对话框说明：原生保存/打开对话框无法被自动化驱动，E2E 经 DEVWIT_E2E_EXPORT_PATH /
 * DEVWIT_E2E_IMPORT_PATH 注入路径（与 DEVWIT_E2E_OPEN_DIR 同口径）；对话框之后的
 * IPC、文件 IO、校验、模式落库链路 100% 真实。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC23");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i13-"));
fs.writeFileSync(path.join(fixture, "hello.ts"), "export const hello = 'world';\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i13-userdata-"));
const shareFile = path.join(os.tmpdir(), `devwit-i13-share-${process.pid}.json`);

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i13] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i13] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i13] FAIL: ${message}`);
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
        DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1",
        DEVWIT_E2E_EXPORT_PATH: shareFile,
        DEVWIT_E2E_IMPORT_PATH: shareFile,
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

let browser = null;
let electronProc = null;
let fatal = null;
try {
  const cdpPort = 23600 + Math.floor(Math.random() * 500);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动 + fixture 工作区打开（导出/导入路径经 E2E 钩子注入）");

  // ---- 1. 新建自定义模式 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav-item >> text=模式");
  await page.waitForSelector(".dw-form textarea", { timeout: 5_000 });
  await page.click(".dw-modal-actions >> text=新建");
  await page.fill('.dw-form input[type="text"] >> nth=1', "分享测试模式");
  await page.fill('.dw-form input[type="text"] >> nth=2', "社区分享用例");
  await page.fill(".dw-form textarea", "你是社区分享的评审专家模式。");
  await page.click('.dw-form-checks >> nth=0 >> label:has-text("read")');
  await page.click('.dw-form-checks >> nth=0 >> label:has-text("grep")');
  await page.click(".dw-modal-actions >> text=保存");
  await page.waitForSelector('.dw-form-error:has-text("已保存")', { timeout: 10_000 });
  const createdModes = await page.evaluate(() => window.devwit.modes.list());
  const created = createdModes.find((mode) => mode.name === "分享测试模式");
  assert(created !== undefined, "新建模式未出现在列表");
  assert(created?.builtin === false, `新建模式应为自定义（实际 builtin: ${created?.builtin}）`);
  const originalId = created.id;
  step(`自定义模式已创建：id=${originalId}，工具=${created.tools.join("+")}`);

  // ---- 2. 导出：信封正确，机器本地字段剥离 ----
  await page.click('.dw-modal-list-item:has-text("分享测试模式") >> button:has-text("导出")');
  await page.waitForSelector('.dw-form-error:has-text("已导出")', { timeout: 10_000 });
  assert(fs.existsSync(shareFile), "导出后分享文件不存在");
  const exported = JSON.parse(fs.readFileSync(shareFile, "utf-8"));
  assert(exported.kind === "devwit-mode", `信封 kind 应为 devwit-mode（实际: ${exported.kind}）`);
  assert(exported.version === 1, `信封 version 应为 1（实际: ${exported.version}）`);
  assert(typeof exported.exportedAt === "string" && exported.exportedAt.length > 0, "信封缺 exportedAt");
  assert(!("id" in exported.mode) && !("builtin" in exported.mode) && !("createdAt" in exported.mode),
    "负载应剥离 id/builtin/createdAt（机器本地字段不随文件传播）");
  assert(exported.mode.name === "分享测试模式" && exported.mode.systemPrompt.includes("评审专家"),
    `负载名称/提示词未保真: ${JSON.stringify(exported.mode).slice(0, 120)}`);
  assert(JSON.stringify(exported.mode.tools) === JSON.stringify(["read", "grep"]),
    `负载工具集未保真（实际: ${JSON.stringify(exported.mode.tools)}）`);
  step("导出文件校验通过：kind/version 信封 + 负载剥离机器本地字段 + 内容保真");

  // ---- 3. 删除 → 导入：同名恢复、新 id、builtin=false ----
  await page.click('.dw-modal-list-item:has-text("分享测试模式") >> button:has-text("删除")');
  await page.waitForFunction(
    () => window.devwit.modes.list().then((modes) => !modes.some((mode) => mode.name === "分享测试模式")),
    { timeout: 10_000 }
  );
  step("模式已删除（列表清空）");
  await page.click(".dw-modal-actions >> text=导入");
  await page.waitForSelector('.dw-form-error:has-text("已导入")', { timeout: 10_000 });
  const restoredModes = await page.evaluate(() => window.devwit.modes.list());
  const restored = restoredModes.find((mode) => mode.name === "分享测试模式");
  assert(restored !== undefined, "导入后模式未恢复");
  assert(restored?.id !== originalId, `导入应生成新 id（仍与原 id 相同: ${restored?.id}）`);
  assert(restored?.builtin === false, `导入模式恒为自定义（实际 builtin: ${restored?.builtin}）`);
  assert(JSON.stringify(restored?.tools) === JSON.stringify(["read", "grep"]),
    `导入工具集未保真（实际: ${JSON.stringify(restored?.tools)}）`);
  assert(restored?.systemPrompt.includes("评审专家"), "导入系统提示未保真");
  const formId = await page.inputValue('.dw-form input[type="text"] >> nth=0');
  assert(formId === restored?.id, `导入结果应直接入表单（表单 id: ${formId}，实际: ${restored?.id}）`);
  await page.screenshot({ path: path.join(OUT, "01-import-restored.png") });
  step(`删除→导入恢复：新 id=${restored?.id}，负载全保真，结果入表单（截图 01）`);

  // ---- 4. 篡改 kind → 本地化拒绝 ----
  fs.writeFileSync(shareFile, JSON.stringify({ kind: "other-tool", version: 1, mode: {} }), "utf-8");
  await page.click(".dw-modal-actions >> text=导入");
  await page.waitForSelector('.dw-form-error:has-text("不是 DevWit 模式文件")', { timeout: 10_000 });
  await page.screenshot({ path: path.join(OUT, "02-import-kind-rejected.png") });
  step("篡改 kind 被拒绝并本地化报错（截图 02）");

  // ---- 5. 非 JSON → 报错 ----
  fs.writeFileSync(shareFile, "this is not json", "utf-8");
  await page.click(".dw-modal-actions >> text=导入");
  await page.waitForSelector('.dw-form-error:has-text("不是有效的 JSON")', { timeout: 10_000 });
  step("非 JSON 文件被拒绝并本地化报错");

  // ---- 6. 未知 providerId → 清空为未绑定 ----
  fs.writeFileSync(
    shareFile,
    JSON.stringify({
      kind: "devwit-mode",
      version: 1,
      exportedAt: new Date().toISOString(),
      mode: { name: "幽灵绑定模式", description: "", systemPrompt: "x", tools: [], providerId: "p-ghost", contextPolicy: {} },
    }),
    "utf-8"
  );
  await page.click(".dw-modal-actions >> text=导入");
  await page.waitForSelector('.dw-form-error:has-text("已导入")', { timeout: 10_000 });
  const ghostModes = await page.evaluate(() => window.devwit.modes.list());
  const ghost = ghostModes.find((mode) => mode.name === "幽灵绑定模式");
  assert(ghost !== undefined, "幽灵绑定模式未导入");
  assert(ghost?.providerId === "", `本机不存在的 providerId 应清空为未绑定（实际: ${ghost?.providerId}）`);
  step("跨机分享语义：未知 providerId 导入后清空为未绑定（用户可重绑）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i13] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i13-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration14-verification.txt"),
    [
      "迭代 14（AC23 模式导出/导入 JSON——无账号的社区分享方式）验证：",
      "1. 设置·模式分区新建自定义模式（名称/提示词/工具勾选）保存成功。",
      "2. 行内「导出」→ 主进程写 JSON：kind=devwit-mode/version=1 信封，负载剥离 id/builtin/createdAt/updatedAt，内容保真。",
      "3. 删除→导入：同名模式恢复，新 id + builtin=false + 工具/提示词全保真，导入结果直接入表单（截图 01）。",
      "4. 篡改 kind → 拒绝并本地化报错「不是 DevWit 模式文件」（截图 02）；非 JSON → 「不是有效的 JSON」。",
      "5. 文件内 providerId 本机不存在 → 导入后清空为未绑定（跨机分享语义，用户可在设置页重绑）。",
      `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
    ].join("\n"),
    "utf-8"
  );
  if (browser !== null) await browser.close().catch(() => {});
  if (electronProc && !electronProc.killed) {
    electronProc.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      electronProc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (fs.existsSync(shareFile)) fs.rmSync(shareFile, { force: true });
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (report.failures.length > 0) {
    console.error(`[verify-i13] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i13-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i13] 全部断言通过，证据已写入 ${OUT}`);
}
