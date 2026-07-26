/**
 * 迭代 30 验证脚本（AC39 度量基建：opt-in 匿名遥测，证据落盘 evidence/AC39）：
 * 1. 默认关闭：新鲜 userData 启动后等待 >flush 周期，本地接收端零请求（不发送任何字节）；
 * 2. 设置·通用分区遥测卡：标题/开关（默认未勾选）/端点输入/「绝不收集」清单文案可见，
 *    中英文案热切换（截图 01/02）；
 * 3. UI 填入端点并勾选开启：接收端收到 telemetry_opt_in——形状硬断言仅
 *    事件名/ts/installId/version/os 五键，installId 为 UUID，无任何内容字段；
 * 4. 取消勾选：收到 telemetry_opt_out 后再无任何请求（关闭即静默）；
 * 5. 同 userData 重启：收到 app_start 且 installId 与首次一致（匿名 ID 跨重启稳定）。
 *
 * 遥测接收端为本地真实 HTTP 服务器（127.0.0.1），捕获请求体验证 envelope；
 * 产品侧链路 100% 真实（设置 UI → settings 落盘 → onChanged 热重配置 → 批量 POST）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC39");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i30-userdata-"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i30-"));
fs.writeFileSync(path.join(fixture, "readme.md"), "# i30 fixture\n", "utf-8");

// ---------------------------------------------------------------------------
// 遥测接收端：捕获全部 POST（url + 解析后的 JSON body）
// ---------------------------------------------------------------------------

const received = []; // { url, body }
const server = createServer((req, res) => {
  if (req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = { __raw: raw }; }
      received.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    return;
  }
  res.writeHead(404).end("not found");
});

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i30] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i30] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i30] FAIL: ${message}`);
  }
}

/** 等待接收端拿到名为 eventName 的事件（轮询，超时返回 null）。 */
async function waitForEvent(eventName, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = received
      .flatMap((r) => (Array.isArray(r.body?.events) ? r.body.events : []))
      .find((event) => event.event === eventName);
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
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
        DEVWIT_TELEMETRY_FLUSH_MS: "300",
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

let browser = null;
let electronProc = null;
let fatal = null;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/telemetry`;
  step(`遥测接收端就绪 ${endpoint}（捕获全部 POST）`);

  const cdpPort = 25100 + Math.floor(Math.random() * 300);
  const { ws, proc } = await launchElectron(cdpPort);
  electronProc = proc;
  browser = await chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });

  // ---- 1. 默认关闭：等待 >flush 周期（300ms×4），接收端必须零请求 ----
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert(received.length === 0, `默认关闭：启动后接收端应零请求（实际 ${received.length} 条）`);
  step("默认关闭：新鲜 userData 启动 1.2s（4 个 flush 周期）接收端零请求");

  // ---- 2. 设置·通用分区遥测卡（默认未勾选 + 清单文案，截图 01/02）----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-settings-content >> text=匿名遥测", { timeout: 10_000 });
  const cardText = await page.textContent(".dw-settings-content");
  assert(cardText?.includes("匿名遥测（默认停用）") === true, "遥测卡标题缺席");
  assert(cardText?.includes("启用匿名使用事件上报") === true, "遥测开关文案缺席");
  assert(cardText?.includes("绝不收集") === true && cardText?.includes("随机安装 ID") === true,
    "收集/绝不收集清单文案缺席");
  const toggleSel = '.dw-settings-content .dw-settings-update:has-text("启用匿名使用事件上报") input[type="checkbox"]';
  assert((await page.isChecked(toggleSel)) === false, "遥测开关默认应未勾选");
  await page.locator(".dw-settings-content >> text=匿名遥测").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "01-telemetry-card.png") });
  step("遥测卡可见：标题/默认未勾选开关/端点输入/清单文案（截图 01）");

  // 英文热切换（i18n 同型实证，截图 02）
  await page.selectOption(".dw-settings-content .dw-select", "en-US");
  await page.waitForSelector(".dw-settings-content >> text=Anonymous telemetry", { timeout: 5_000 });
  const cardTextEn = await page.textContent(".dw-settings-content");
  assert(cardTextEn?.includes("Never collects") === true, "英文清单文案缺席");
  await page.locator(".dw-settings-content >> text=Anonymous telemetry").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "02-telemetry-card-en.png") });
  await page.selectOption(".dw-settings-content .dw-select", "zh-CN");
  await page.waitForSelector(".dw-settings-content >> text=匿名遥测", { timeout: 5_000 });
  step("英文热切换：Anonymous telemetry / Never collects 文案（截图 02），切回中文");

  // ---- 3. UI 填端点 + 勾选开启：收到 telemetry_opt_in（形状硬断言）----
  const endpointSel = '.dw-settings-content input[placeholder*="遥测接收端点"]';
  await page.fill(endpointSel, endpoint);
  await page.check(toggleSel); // 勾选动作同时 blur 端点输入（change 落盘端点）
  const optIn = await waitForEvent("telemetry_opt_in");
  assert(optIn !== null, "开启后应收到 telemetry_opt_in");
  if (optIn !== null) {
    const keys = Object.keys(optIn).sort();
    assert(JSON.stringify(keys) === JSON.stringify(["event", "installId", "os", "ts", "version"]),
      `opt_in 载荷应仅五键（实际: ${keys.join("/")}）`);
    assert(typeof optIn.installId === "string" && /^[0-9a-f-]{36}$/.test(optIn.installId),
      `installId 应为 UUID（实际: ${optIn.installId}）`);
    assert(typeof optIn.version === "string" && optIn.version.length > 0 && typeof optIn.os === "string",
      "version/os 应为非空字符串");
    assert(Number.isNaN(Date.parse(optIn.ts)) === false, "ts 应为 ISO 时间");
  }
  const postedUrl = received.find((r) => r.body?.events?.some((e) => e.event === "telemetry_opt_in"))?.url;
  assert(postedUrl === "/telemetry", `批量 POST 应打到配置的端点路径（实际: ${postedUrl}）`);
  const firstInstallId = optIn?.installId;
  step("勾选开启：收到 telemetry_opt_in——仅 事件名/ts/installId/version/os 五键，零内容字段");

  // ---- 4. 取消勾选：收到 telemetry_opt_out 后不再有任何请求 ----
  await page.uncheck(toggleSel);
  const optOut = await waitForEvent("telemetry_opt_out");
  assert(optOut !== null, "关闭后应收到 telemetry_opt_out（最后一条，透明告知）");
  const countAfterOptOut = received.length;
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // >3 个 flush 周期
  assert(received.length === countAfterOptOut,
    `关闭后应静默（opt_out 后又有 ${received.length - countAfterOptOut} 条请求）`);
  step("取消勾选：telemetry_opt_out 送达后 1s 零请求（关闭即静默）");

  // 重新开启（为重启 app_start 铺路）：持久化 enabled=true
  await page.check(toggleSel);
  const optIn2 = await waitForEvent("telemetry_opt_in", 8_000);
  assert(optIn2 !== null, "重新开启应再次收到 telemetry_opt_in");

  // ---- 5. 同 userData 重启：app_start 且 installId 稳定 ----
  await browser.close();
  browser = null;
  await stopElectron(electronProc);
  electronProc = null;
  received.length = 0;

  const relaunch = await launchElectron(cdpPort + 1);
  electronProc = relaunch.proc;
  const appStart = await waitForEvent("app_start");
  assert(appStart !== null, "重启后应收到 app_start（开启状态持久化）");
  assert(appStart?.installId === firstInstallId,
    `installId 跨重启应稳定（首次 ${firstInstallId} / 重启 ${appStart?.installId}）`);
  step("同 userData 重启：app_start 送达，installId 与首次一致（匿名 ID 稳定）");
} catch (error) {
  fatal = error;
  console.error("[verify-i30] FATAL:", error);
} finally {
  if (browser !== null) await browser.close().catch(() => {});
  await stopElectron(electronProc);
  server.close();
}

report.fatal = fatal === null ? null : String(fatal);
report.ok = fatal === null && report.failures.length === 0;
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log(`[verify-i30] 断言 ${report.assertions.length} 通过 / ${report.failures.length} 失败；证据 → evidence/AC39`);
if (!report.ok) {
  console.error("[verify-i30] FAILED");
  process.exit(1);
}
console.log("[verify-i30] OK");
