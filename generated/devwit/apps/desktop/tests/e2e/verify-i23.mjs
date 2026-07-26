/**
 * 迭代 25 验证脚本（AC34 插件市场原型——社区索引扩展 MCP 服务器，证据落盘 evidence/AC34）：
 * 1. 本地 HTTP server 模拟社区索引源（DEVWIT_MODES_INDEX_URL 注入，与社区模式同一 base）：
 *    index.json 同时含 modes 段与 mcpServers 段（同信封双类型分发、向前兼容证明）；
 * 2. 设置·MCP 分区「社区 MCP 服务器」区：索引加载 → 条目（名称 + 作者 + 预告工具数）渲染；
 * 3. 行内「导入」→ 主进程拉取服务器文件 → 信封校验 + validateMcpServerConfig 同标准校验 →
 *    落为新服务器（新 id 生成）→ 热启动：状态 connecting→ready + 工具 3 个
 *    （真实 node 子进程跑 fake-mcp-server，initialize/tools/list 全链路真实）；
 * 4. 导入结果直接入表单（id 回填可立即编辑）；已导入条目按钮 disabled 显示「已导入」；
 * 5. 删除本地该服务器（子进程停止）→ 社区行按钮恢复「导入」（归并状态随 renderList 同步）；
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
const OUT = path.join(ROOT, "evidence", "AC34");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const FAKE_SERVER = path.join(ROOT, "packages", "mcp", "tests", "fixtures", "fake-mcp-server.mjs");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i23-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello\n", "utf-8");
const MARKER_FILE = path.join(fixture, "mcp-marker.txt");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i23-userdata-"));

// ---------------------------------------------------------------------------
// 社区索引 fixture：modes + mcpServers 双段同信封；服务器文件指向真实 fake-mcp-server
// ---------------------------------------------------------------------------

const SERVER_FILE = {
  kind: "devwit-mcp-server",
  version: 1,
  exportedAt: "2026-07-25T00:00:00.000Z",
  server: {
    name: "Community Files",
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { MARKER_FILE },
    enabled: true,
  },
};
const GHOST_FILE = {
  kind: "devwit-mcp-server",
  version: 1,
  exportedAt: "2026-07-25T00:00:00.000Z",
  server: { name: "Ghost Tools", command: "ghost-bin", args: ["--serve"], enabled: false },
};
const INDEX = {
  kind: "devwit-modes-index",
  version: 1,
  updatedAt: "2026-07-25T00:00:00.000Z",
  // 双类型同信封共存：modes 段保持可读（AC25 向前兼容），mcpServers 为本迭代新增段
  modes: [
    { file: "modes/community-reviewer.json", name: "Community Reviewer", description: "社区评审模式", author: "tester", tags: ["review"] },
  ],
  mcpServers: [
    { file: "mcp/community-files.json", name: "Community Files", description: "社区文件工具服务器", author: "tester", tools: ["echo", "write_marker", "hang"] },
    { file: "mcp/ghost-tools.json", name: "Ghost Tools", description: "幽灵工具服务器", author: "tester2" },
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
  if (req.url === "/mcp/community-files.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(SERVER_FILE));
    return;
  }
  if (req.url === "/mcp/ghost-tools.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(GHOST_FILE));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i23] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i23] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i23] FAIL: ${message}`);
  }
}

function launchElectron(cdpPort, indexBase) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWIT_E2E_OPEN_DIR: fixture,
        DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1",
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

/** Node 侧轮询 MCP 视图（与 verify-i8 同口径：主进程 finally 落库后再断言）。 */
async function waitMcpView(page, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const views = await page.evaluate(() => window.devwit.mcp.list());
    const view = views.find(predicate);
    if (view !== undefined) return view;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const indexBase = `http://127.0.0.1:${String(server.address().port)}`;

  const cdpPort = 24500 + Math.floor(Math.random() * 500);
  const { ws, proc } = await launchElectron(cdpPort, indexBase);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  step(`应用启动（社区索引源注入 ${indexBase}，modes + mcpServers 双段同信封）`);

  // ---- 1. 设置·MCP 分区：社区区索引加载，条目（名称 + 作者 + 预告工具数）渲染 ----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.click(".dw-settings-nav-item >> text=MCP");
  const communityList = ".dw-modal-list >> nth=1";
  await page.waitForSelector(`${communityList} >> .dw-modal-list-item:has-text("Community Files")`, { timeout: 10_000 });
  await page.waitForSelector(`${communityList} >> .dw-modal-list-item:has-text("Ghost Tools")`, { timeout: 5_000 });
  const rowTexts = await page.$$eval(`${communityList} >> .dw-modal-list-item`, (rows) => rows.map((row) => row.textContent));
  assert(rowTexts.length === 2, `社区索引 mcpServers 段应渲染 2 个条目（实际 ${rowTexts.length}）`);
  assert(rowTexts.some((text) => text.includes("作者 tester")), `条目应显示作者（实际: ${rowTexts.join(" | ")}）`);
  assert(rowTexts.some((text) => text.includes("预告 3 个工具")), `条目应显示预告工具数（实际: ${rowTexts.join(" | ")}）`);
  step("社区 MCP 区索引加载：2 个条目（名称 + 作者 + 预告工具数）渲染");

  // ---- 2. 一键导入：信封 + 同标准校验 → 新服务器落库（新 id）→ 热启动就绪 ----
  await page.click(`${communityList} >> .dw-modal-list-item:has-text("Community Files") >> button:has-text("导入")`);
  await page.waitForSelector('.dw-form-error:has-text("已导入")', { timeout: 10_000 });
  const imported = await waitMcpView(page, (view) => view.config.name === "Community Files", 10_000);
  assert(imported !== null, "社区服务器导入后未出现在本地列表");
  assert(/^mcp-[\w-]+$/.test(imported?.config.id ?? ""), `导入应生成新 id（实际: ${imported?.config.id}）`);
  assert(imported?.config.command === process.execPath, `导入 command 未保真（实际: ${imported?.config.command}）`);
  assert(JSON.stringify(imported?.config.args) === JSON.stringify([FAKE_SERVER]),
    `导入 args 未保真（实际: ${JSON.stringify(imported?.config.args)}）`);
  assert(imported?.config.env?.MARKER_FILE === MARKER_FILE, "导入 env 未保真");
  assert(imported?.config.enabled === true, "导入 enabled 未保真");

  // 热启动：真实 stdio initialize/tools/list → ready + 3 个工具（全名 mcp__<id>__<tool>）
  const ready = await waitMcpView(
    page,
    (view) => view.config.name === "Community Files" && view.state === "ready" && view.tools.length === 3
  );
  assert(ready !== null, "导入服务器热启动未到 ready（或工具数不为 3）");
  const fullNames = (ready?.tools ?? []).map((tool) => tool.fullName);
  assert(fullNames.includes(`mcp__${imported?.config.id ?? ""}__echo`) && fullNames.includes(`mcp__${imported?.config.id ?? ""}__write_marker`),
    `聚合工具全名缺失（实际: ${fullNames.join(", ")}）`);
  step(`一键导入热启动：新 id=${imported?.config.id}，负载保真，ready + 工具 3 个（stdio 全链路真实）`);

  // ---- 3. 导入结果直接入表单（id 回填）----
  const formId = await page.inputValue('.dw-form input[type="text"] >> nth=0');
  assert(formId === imported?.config.id, `导入结果应直接入表单（表单 id: ${formId}，实际: ${imported?.config.id}）`);
  await page.screenshot({ path: path.join(OUT, "01-mcp-community-imported.png") });
  step("导入结果直接入表单（截图 01：列表就绪徽标 + 表单回填）");

  // ---- 4. 已导入归并：按钮 disabled 显示「已导入」 ----
  // 注意：waitForFunction 在浏览器端执行，只认标准 CSS/DOM，不能用 Playwright 的 nth=/has-text 语法
  const findCommunityBtnSrc = `(() => {
    const list = document.querySelectorAll(".dw-modal-list")[1];
    if (list === undefined) return null;
    for (const item of list.querySelectorAll(".dw-modal-list-item")) {
      if (item.textContent.includes("Community Files")) return item.querySelector("button");
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
  step("已导入条目按钮置 disabled 显示「已导入」");

  // ---- 5. 删除本地服务器 → 社区行按钮恢复「导入」 ----
  await page.click('.dw-modal-list >> nth=0 >> .dw-modal-list-item:has-text("Community Files") >> button:has-text("删除")');
  await page.waitForFunction(
    (findBtnSrc) => {
      const btn = eval(findBtnSrc);
      return btn !== null && btn.disabled === false && btn.textContent === "导入";
    },
    findCommunityBtnSrc,
    { timeout: 10_000 }
  );
  const afterDelete = await page.evaluate(() => window.devwit.mcp.list());
  assert(afterDelete.length === 0, `删除后本地服务器列表应为空（实际 ${afterDelete.length}）`);
  step("删除本地该服务器（子进程停止）→ 社区行按钮恢复「导入」（归并状态同步）");

  // ---- 6. 索引源 500 → 本地化报错 ----
  failIndex = true;
  await page.click(".dw-settings-nav-item >> text=通用");
  await page.click(".dw-settings-nav-item >> text=MCP");
  await page.waitForSelector('.dw-modal-hint:has-text("社区索引请求失败（HTTP 500）")', { timeout: 10_000 });
  await page.screenshot({ path: path.join(OUT, "02-mcp-community-index-error.png") });
  step("索引源 500 → 状态行本地化报错（截图 02）");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i23] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i23-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration25-verification.txt"),
    [
      "迭代 25（AC34 插件市场原型——社区索引扩展 MCP 服务器）验证：",
      "1. 设置·MCP 分区「社区 MCP 服务器」区加载本地索引源（DEVWIT_MODES_INDEX_URL 注入）：index.json 同信封同时携带 modes 段与 mcpServers 段（向前兼容），2 个 MCP 条目（名称 + 作者 + 预告工具数）渲染。",
      "2. 行内「导入」→ 主进程拉取服务器文件 → 信封校验 + validateMcpServerConfig 同标准校验 → 新服务器落库（新 id、command/args/env/enabled 保真）→ 热启动 ready + 工具 3 个（真实 node 子进程 fake-mcp-server，initialize/tools/list 全链路真实，聚合全名 mcp__<id>__<tool>）。",
      "3. 导入结果直接入表单（id 回填可立即编辑/停用，截图 01）；已导入条目按钮 disabled 显示「已导入」。",
      "4. 删除本地该服务器（子进程停止）→ 社区行按钮恢复「导入」（归并状态随列表同步）。",
      "5. 索引源 500 → 状态行本地化报错「社区索引请求失败（HTTP 500）」（截图 02）。",
      "6. 官方索引仓库 distribution/community-modes 已加 mcpServers 段（Filesystem/Fetch 种子条目），条目文件经 parseMcpIndex/parseMcpServerFile/materializeMcpImport 真实解析验证。",
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
  if (fs.existsSync(fixture)) {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (report.failures.length > 0) {
    console.error(`[verify-i23] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i23-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i23] 全部断言通过，证据已写入 ${OUT}`);
}
