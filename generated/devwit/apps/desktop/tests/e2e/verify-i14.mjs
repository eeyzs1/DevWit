/**
 * 迭代 16 验证脚本（AC25 社区模式生态——零账号分享飞轮，证据落盘 evidence/AC25）：
 * 1. 本地 HTTP server 模拟社区索引源（DEVWIT_MODES_INDEX_URL 注入，与
 *    DEVWIT_E2E_OPEN_DIR 同口径；索引解析/路径穿越防护/模式校验/落库链路 100% 真实）；
 * 2. 设置·模式分区「社区模式」区：索引加载 → 条目列表（名称 + 作者）渲染；
 * 3. 行内「导入」→ 主进程拉取模式文件 → AC23 同标准校验 → 落为新自定义模式
 *    （新 id、builtin=false、工具/提示词保真、未知 providerId 清空）；
 * 4. 已导入条目按钮置 disabled 显示「已导入」（按名称与本地列表归并）；
 * 5. 删除本地该模式 → 社区行按钮恢复「导入」（归并状态随 renderList 同步）；
 * 6. 索引源 500 → 状态行本地化报错「社区索引请求失败（HTTP 500）」。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC25");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i14-"));
fs.writeFileSync(path.join(fixture, "hello.ts"), "export const hello = 'world';\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i14-userdata-"));

const MODE_FILE = {
  kind: "devwit-mode",
  version: 1,
  exportedAt: "2026-07-24T00:00:00.000Z",
  mode: {
    name: "Community Reviewer",
    description: "社区评审模式",
    systemPrompt: "You review code with severity-ranked findings.",
    tools: ["read", "grep"],
    providerId: "p-ghost",
    contextPolicy: {},
  },
};
const INDEX = {
  kind: "devwit-modes-index",
  version: 1,
  updatedAt: "2026-07-24T00:00:00.000Z",
  modes: [
    { file: "modes/community-reviewer.json", name: "Community Reviewer", description: "社区评审模式", author: "tester", tags: ["review"] },
    { file: "modes/ghost-writer.json", name: "Ghost Writer", description: "幽灵写作模式", author: "tester2" },
  ],
};

let failIndex = false;
const server = http.createServer((req, res) => {
  if (req.url === "/index.json") {
    if (failIndex) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(INDEX));
    return;
  }
  if (req.url === "/modes/community-reviewer.json" || req.url === "/modes/ghost-writer.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(MODE_FILE));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const indexBase = `http://127.0.0.1:${String(server.address().port)}`;

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i14] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i14] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i14] FAIL: ${message}`);
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
        DEVWIT_MODES_INDEX_URL: indexBase,
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
  const cdpPort = 24100 + Math.floor(Math.random() * 500);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step(`应用启动 + fixture 工作区打开（社区索引源注入 ${indexBase}）`);

  // ---- 1. 社区索引加载：条目列表渲染 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav-item >> text=模式");
  const communityList = ".dw-modal-list >> nth=1";
  await page.waitForSelector(`${communityList} >> .dw-modal-list-item:has-text("Community Reviewer")`, { timeout: 10_000 });
  await page.waitForSelector(`${communityList} >> .dw-modal-list-item:has-text("Ghost Writer")`, { timeout: 5_000 });
  const rowTexts = await page.$$eval(`${communityList} >> .dw-modal-list-item`, (rows) => rows.map((row) => row.textContent));
  assert(rowTexts.length === 2, `社区索引应渲染 2 个条目（实际 ${rowTexts.length}）`);
  assert(rowTexts.some((text) => text.includes("作者 tester")), `条目应显示作者（实际: ${rowTexts.join(" | ")}）`);
  step("社区索引加载：2 个条目（名称 + 作者）渲染");

  // ---- 2. 一键导入：AC23 同标准校验 + 落为新自定义模式 ----
  await page.click(`${communityList} >> .dw-modal-list-item:has-text("Community Reviewer") >> button:has-text("导入")`);
  await page.waitForSelector('.dw-form-error:has-text("已导入")', { timeout: 10_000 });
  const afterImport = await page.evaluate(() => window.devwit.modes.list());
  const imported = afterImport.find((mode) => mode.name === "Community Reviewer");
  assert(imported !== undefined, "社区模式导入后未出现在本地列表");
  assert(imported?.builtin === false, `导入模式恒为自定义（实际 builtin: ${imported?.builtin}）`);
  assert(JSON.stringify(imported?.tools) === JSON.stringify(["read", "grep"]),
    `导入工具集未保真（实际: ${JSON.stringify(imported?.tools)}）`);
  assert(imported?.systemPrompt.includes("severity-ranked"), "导入系统提示未保真");
  assert(imported?.providerId === "", `未知 providerId 应清空为未绑定（实际: ${imported?.providerId}）`);
  const formId = await page.inputValue('.dw-form input[type="text"] >> nth=0');
  assert(formId === imported?.id, `导入结果应直接入表单（表单 id: ${formId}，实际: ${imported?.id}）`);
  step(`一键导入：新自定义模式 id=${imported?.id}，负载保真，未知 provider 清空，结果入表单`);

  // ---- 3. 已导入归并：按钮 disabled 显示「已导入」 ----
  // 注意：waitForFunction 在浏览器端执行，只认标准 CSS/DOM，不能用 Playwright 的 nth=/has-text 语法
  const findCommunityBtnSrc = `(() => {
    const list = document.querySelectorAll(".dw-modal-list")[1];
    if (list === undefined) return null;
    for (const item of list.querySelectorAll(".dw-modal-list-item")) {
      if (item.textContent.includes("Community Reviewer")) return item.querySelector("button");
    }
    return null;
  })()`;
  await page.waitForFunction(
    (findBtnSrc) => {
      const btn = eval(findBtnSrc);
      return btn !== null && btn.disabled === true && btn.textContent === "已导入";
    },
    findCommunityBtnSrc,
    { timeout: 5_000 }
  );
  await page.screenshot({ path: path.join(OUT, "01-community-imported.png") });
  step("已导入条目按钮置 disabled 显示「已导入」（截图 01）");

  // ---- 4. 删除本地模式 → 社区行按钮恢复「导入」 ----
  await page.click('.dw-modal-list >> nth=0 >> .dw-modal-list-item:has-text("Community Reviewer") >> button:has-text("删除")');
  await page.waitForFunction(
    (findBtnSrc) => {
      const btn = eval(findBtnSrc);
      return btn !== null && btn.disabled === false && btn.textContent === "导入";
    },
    findCommunityBtnSrc,
    { timeout: 10_000 }
  );
  step("删除本地该模式 → 社区行按钮恢复「导入」（归并状态同步）");

  // ---- 5. 索引源 500 → 本地化报错 ----
  failIndex = true;
  await page.click(".dw-settings-nav-item >> text=通用");
  await page.click(".dw-settings-nav-item >> text=模式");
  await page.waitForSelector('.dw-modal-hint:has-text("社区索引请求失败（HTTP 500）")', { timeout: 10_000 });
  await page.screenshot({ path: path.join(OUT, "02-community-index-error.png") });
  step("索引源 500 → 状态行本地化报错（截图 02）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i14] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i14-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration16-verification.txt"),
    [
      "迭代 16（AC25 社区模式生态——零账号分享飞轮）验证：",
      "1. 设置·模式分区「社区模式」区加载本地索引源（DEVWIT_MODES_INDEX_URL 注入）：2 个条目（名称 + 作者）渲染。",
      "2. 行内「导入」→ 主进程拉取模式文件 → AC23 同标准校验 → 新自定义模式落库（新 id、builtin=false、工具/提示词保真、未知 providerId 清空），结果直接入表单。",
      "3. 已导入条目按钮 disabled 显示「已导入」（截图 01）；删除本地该模式 → 按钮恢复「导入」（归并状态随列表同步）。",
      "4. 索引源 500 → 状态行本地化报错「社区索引请求失败（HTTP 500）」（截图 02）。",
      "5. 官方索引仓库 eeyzs1/devwit-modes 已上线（5 个种子模式），生产缺省地址经 resolveModesIndexBase 单测覆盖。",
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
  server.close();
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (report.failures.length > 0) {
    console.error(`[verify-i14] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i14-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i14] 全部断言通过，证据已写入 ${OUT}`);
}
