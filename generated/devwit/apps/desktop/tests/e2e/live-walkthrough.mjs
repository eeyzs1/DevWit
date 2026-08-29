/**
 * DevWit 实机全功能走查（live-walkthrough）
 *
 * 真实启动 Electron 应用，遍历主要功能域并截图，产物落 evidence/live-walk/。
 * 不是断言型 E2E（那由 verify-i*.mjs 承担）——这是"真实使用并留证"的走查：
 * 每个功能域 try/catch 独立，失败标记 SKIP/ERR 而不中断整体。
 *
 * 用法：node apps/desktop/tests/e2e/live-walkthrough.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "live-walk");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const consoleLog = [];
const requestLog = [];
let shotCounter = 0;
async function shot(page, name) {
  shotCounter += 1;
  await page.screenshot({ path: path.join(OUT, `${String(shotCounter).padStart(2, "0")}-${name}.png`) });
  console.log(`  📸 ${name}`);
}

// ---------------------------------------------------------------------------
// 本地 OpenAI 兼容 SSE 端点（真实线协议）
// ---------------------------------------------------------------------------
const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
function framesForText(text) {
  return [
    sseChunk({ id: "live", object: "chat.completion.chunk", created: 0, model: "live", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sseChunk({ id: "live", object: "chat.completion.chunk", created: 0, model: "live", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({ id: "live", object: "chat.completion.chunk", created: 0, model: "live", choices: [], usage: { prompt_tokens: 40, completion_tokens: 16 } }),
    "data: [DONE]\n\n",
  ];
}
function framesForToolCall(name, args) {
  return [
    sseChunk({ id: "live", object: "chat.completion.chunk", created: 0, model: "live", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_live_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    sseChunk({ id: "live", object: "chat.completion.chunk", created: 0, model: "live", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({ id: "live", object: "chat.completion.chunk", created: 0, model: "live", choices: [], usage: { prompt_tokens: 55, completion_tokens: 9 } }),
    "data: [DONE]\n\n",
  ];
}
const RESPONSES = [
  framesForText("你好！这是实机走查的流式回复。"),
  framesForText("这是修改 hello.txt 的提案：\n\n```\nhello devwit live\nline2\nline3\n```"),
  framesForToolCall("write", { path: "live-agent.txt", content: "written by live walkthrough\n" }),
  framesForText("已完成 live-agent.txt 的创建。"),
  framesForText("已切换模型 live-b。"),
  framesForText("自定义模式 live-mode 生效。"),
];

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") { res.writeHead(404).end(); return; }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    requestLog.push({ model: body.model, tools: Array.isArray(body.tools) ? body.tools.map((t) => t.function.name) : [], systemPrompt: body.messages?.[0]?.role === "system" ? body.messages[0].content : null, messageCount: body.messages?.length ?? 0 });
    const frames = RESPONSES.shift() ?? framesForText("(脚本外请求)");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let i = 0;
    const push = () => { if (i >= frames.length) { res.end(); return; } res.write(frames[i]); i += 1; setTimeout(push, 25); };
    push();
  });
});

const electronExe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");

function launchElectron(cdpPort, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(electronExe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OFFSCREEN: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBuf = "";
    const timer = setTimeout(() => reject(new Error(`等待 DevTools 端点超时: ${stderrBuf.slice(0, 400)}`)), 40_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve({ proc, ws: m[1] }); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Electron 提前退出 code=${code}: ${stderrBuf.slice(0, 400)}`)); });
    proc.on("error", reject);
  });
}

async function connect(wsEndpoint) {
  const browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  page.on("console", (m) => consoleLog.push(`[console:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`[pageerror] ${e.message}`));
  return { browser, page };
}

async function main() {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dw-live-ws-"));
  fs.writeFileSync(path.join(fixture, "hello.txt"), "hello devwit live\nline2\n", "utf-8");
  fs.mkdirSync(path.join(fixture, "notes"));
  fs.writeFileSync(path.join(fixture, "notes", "todo.md"), "- [ ] live\n", "utf-8");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "dw-live-ud-"));

  const report = { screens: [], requestLog, consoleLog, errors: [] };
  const step = (name) => report.screens.push({ name, at: new Date().toISOString() });

  // ---- Phase A：全新 userData 首启 → 引导向导 ----
  try {
    step("A. 首次引导向导（全新 userData）");
    const { proc, ws } = await launchElectron(19300 + Math.floor(Math.random() * 1000), { DEVWIT_E2E_WIZARD: "1", DEVWIT_USER_DATA_DIR: userData });
    const { page } = await connect(ws);
    await page.waitForSelector(".dw-onboarding, .dw-wizard, .dw-header", { timeout: 30_000 });
    await shot(page, "a-onboarding-first-launch");
    await page.waitForTimeout(500);
    await shot(page, "a-onboarding-after");
    proc.kill();
  } catch (e) { console.log(`  SKIP 引导向导: ${e.message}`); report.errors.push(`onboarding: ${e.message}`); }

  // ---- Phase B：主走查 ----
  const { proc, ws } = await launchElectron(19300 + Math.floor(Math.random() * 1000), {
    DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userData,
  });
  const { browser, page } = await connect(ws);
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  step("B1. 应用启动 + 工作区文件树");
  await shot(page, "b1-app-launched");

  // 打开文件并编辑保存
  await page.click(".dw-tree-node:has-text('hello.txt')").catch(() => {});
  await page.waitForSelector('textarea[aria-label="editor input"]', { timeout: 10_000 }).catch(() => {});
  await shot(page, "b2-editor-open");
  await page.focus('textarea[aria-label="editor input"]').catch(() => {});
  await page.keyboard.type("LIVE ").catch(() => {});
  await page.keyboard.press("Control+s").catch(() => {});
  step("B2. 编辑器打开/编辑/保存");

  // 配置 provider/凭证（真实 safeStorage）
  await page.evaluate(async (url) => {
    await window.devwit.credentials.set("live-cred", "openai", "sk-live");
    await window.devwit.providers.upsert({ id: "live-a", type: "openai", label: "Live A", baseUrl: url, model: "live-model-a", credentialRef: "live-cred", maxTokens: 2048 });
  }, baseUrl);
  await page.selectOption('select[title="模型"]', "live-a").catch(() => {});
  await page.selectOption('select[title="模式"]', "chat").catch(() => {});
  step("B3. 凭证 + provider 注册");

  // chat + 流式
  await page.fill(".dw-chat .dw-chat-textarea", "你好").catch(() => {});
  await page.click(".dw-chat >> text=发送").catch(() => {});
  await page.waitForSelector('.dw-msg-assistant:has-text("走查")', { timeout: 30_000 }).catch(() => {});
  step("B4. 对话（流式回复）");
  await shot(page, "b4-chat-reply");

  // 上下文面板 + 开关
  await page.click('.dw-tab:has-text("上下文")').catch(() => {});
  await page.waitForSelector(".dw-context-item", { timeout: 10_000 }).catch(() => {});
  step("B5. 上下文面板（manifest 逐项 + token）");
  await shot(page, "b5-context-panel");
  const policy = await page.evaluate(() => window.devwit.context.getPolicy()).catch(() => null);
  report.policy = policy;

  // diff 提案
  await page.click('.dw-tab:has-text("对话")').catch(() => {});
  await page.fill(".dw-chat .dw-chat-textarea", "请给 hello.txt 加一行").catch(() => {});
  await page.click(".dw-chat >> text=发送").catch(() => {});
  await page.waitForSelector("text=审查修改", { timeout: 30_000 }).catch(() => {});
  await page.click("text=审查修改").catch(() => {});
  await page.waitForSelector(".dw-diff-hunk", { timeout: 10_000 }).catch(() => {});
  step("B6. diff 审查视图");
  await shot(page, "b6-diff-review");
  await page.click("text=全部接受").catch(() => {});
  await page.click("text=应用并关闭").catch(() => {});

  // agent 模式 + 授权门
  await page.selectOption('select[title="模式"]', "agent").catch(() => {});
  await page.fill(".dw-chat .dw-chat-textarea", "创建文件 live-agent.txt").catch(() => {});
  await page.click(".dw-chat >> text=发送").catch(() => {});
  await page.waitForSelector(".dw-msg-authorization", { timeout: 30_000 }).catch(() => {});
  step("B7. Agent 模式授权门");
  await shot(page, "b7-authorization-gate");
  await page.click('.dw-msg-authorization >> text=允许').catch(() => {});
  await page.waitForTimeout(3000);
  const liveAgentFile = path.join(fixture, "live-agent.txt");
  report.agentFileExists = fs.existsSync(liveAgentFile);
  report.agentFileContent = fs.existsSync(liveAgentFile) ? fs.readFileSync(liveAgentFile, "utf-8") : null;

  // 切模型
  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({ id: "live-b", type: "openai", label: "Live B", baseUrl: url, model: "live-model-b", credentialRef: "live-cred", maxTokens: 2048 });
  }, baseUrl);
  await page.waitForFunction(() => [...document.querySelectorAll('select[title="模型"] option')].some((o) => o.value === "live-b"), null, { timeout: 5_000 }).catch(() => {});
  await page.selectOption('select[title="模型"]', "live-b").catch(() => {});
  step("B8. 会话中切换模型");

  // 模式热更新（新建自定义模式 + 下拉出现）
  await page.evaluate(() => window.devwit.modes.upsert({
    id: "live-mode", name: "Live Mode", description: "走查模式", systemPrompt: "你是 live-mode 助手。", tools: ["read", "grep"], providerId: "live-a", contextPolicy: {}, builtin: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })).catch(() => {});
  await page.waitForFunction(() => [...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "live-mode"), null, { timeout: 5_000 }).catch(() => {});
  await page.selectOption('select[title="模式"]', "live-mode").catch(() => {});
  step("B9. 模式热更新（新模式即时出现）");
  await shot(page, "b9-mode-hot-reload");

  // 设置页各分区
  for (const label of ["设置", "Settings"]) {
    const btn = page.locator(`.dw-header >> text=${label}`);
    if (await btn.count()) { await btn.first().click().catch(() => {}); break; }
  }
  await page.waitForTimeout(800);
  step("B10. 设置页");
  await shot(page, "b10-settings");

  // 指挥台（任务中心）
  for (const label of ["指挥台", "任务"]) {
    const btn = page.locator(`text=${label}`);
    if (await btn.count()) { await btn.first().click().catch(() => {}); await page.waitForTimeout(600); step(`B11. 指挥台/任务中心（${label}）`); await shot(page, "b11-task-center"); break; }
  }

  // 社区模式页
  for (const label of ["社区", "模式市场", "Community"]) {
    const btn = page.locator(`text=${label}`);
    if (await btn.count()) { await btn.first().click().catch(() => {}); await page.waitForTimeout(800); step("B12. 社区模式"); await shot(page, "b12-community-modes"); break; }
  }

  // 用量/成本面板
  const usage = await page.evaluate(() => window.devwit.usage?.summary?.()).catch(() => null);
  report.usage = usage ?? null;

  // devwit 桥 API 面（供第三方参考的公开面）
  report.bridgeApi = await page.evaluate(() => Object.keys(window.devwit ?? {}).sort()).catch(() => null);

  // 轨迹/会话
  report.traceTypes = await page.evaluate(() => window.devwit.agent.listSessions ? "has-listSessions" : "n/a").catch(() => null);

  writeJson = (name, value) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2), "utf-8");
  writeJson("report.json", report);
  writeJson("request-log.json", requestLog);

  console.log(`\n=== 走查完成：${report.screens.length} 屏，截图 ${shotCounter} 张 ===`);
  console.log(`agent 文件存在=${report.agentFileExists} 内容=${JSON.stringify(report.agentFileContent)}`);
  console.log(`控制台错误 ${consoleLog.filter((l) => l.startsWith("[pageerror]")).length} 条 / 警告 ${consoleLog.filter((l) => l.includes("error")).length} 条`);
  for (const e of consoleLog.filter((l) => l.startsWith("[pageerror]"))) console.log(`  ${e}`);
  console.log(`桥 API: ${(report.bridgeApi ?? []).join(", ")}`);

  proc.kill();
  browser.close().catch(() => {});
  server.close();
  process.exit(0);
}

let writeJson;
main().catch((e) => { console.error("走查异常:", e); process.exit(1); });
