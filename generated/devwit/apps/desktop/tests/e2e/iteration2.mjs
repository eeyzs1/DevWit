/**
 * DevWit E2E 迭代 2（P1：AI-native 工作台 UX 重设计）：
 * 场景：首次使用引导（AC11）→ 外部编辑器引导 + 真实 spawn（AC10）
 * → 双形态切换与状态保持（AC8）→ 任务指挥台：任务列表 / 活动流 / 授权门 /
 * 工作区 Diff 页签（AC9）。证据落盘 evidence/AC8..AC11。
 *
 * LLM 侧说明与 smoke.mjs 相同：本地端点以真实 SSE 线协议应答（开发环境无云端凭证），
 * 产品侧链路 100% 真实（凭证加解密、HTTP、SSE 解析、context engine、agent loop、
 * 授权门、文件系统、外部编辑器 spawn）。
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE = path.join(ROOT, "evidence");
const AC = (n) => path.join(EVIDENCE, `AC${n}`);
// 每次运行重置本轮证据目录（仅 AC8..AC12；AC1..AC7 由 smoke.mjs 管理）
for (let i = 8; i <= 12; i += 1) fs.rmSync(AC(i), { recursive: true, force: true });
for (let i = 8; i <= 12; i += 1) fs.mkdirSync(AC(i), { recursive: true });

const consoleLog = [];
let shotCounter = 0;

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2), "utf-8");
}
function writeText(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text, "utf-8");
}
async function shot(page, dir, name) {
  shotCounter += 1;
  await page.screenshot({ path: path.join(dir, `${String(shotCounter).padStart(2, "0")}-${name}.png`) });
}
function step(name) {
  report.steps.push({ name, at: new Date().toISOString() });
  console.log(`[e2e2] ${name}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`断言失败: ${message}`);
}
/** 轮询等待文件出现（外部编辑器 spawn 是 detached 子进程，完成后落盘标记文件）。 */
async function waitForFile(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 本地 OpenAI 兼容 SSE 端点（真实线协议，脚本化应答队列）
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function framesForText(text) {
  return [
    sseChunk({ id: "e2e2", object: "chat.completion.chunk", created: 0, model: "e2e2", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sseChunk({ id: "e2e2", object: "chat.completion.chunk", created: 0, model: "e2e2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({ id: "e2e2", object: "chat.completion.chunk", created: 0, model: "e2e2", choices: [], usage: { prompt_tokens: 40, completion_tokens: 15 } }),
    "data: [DONE]\n\n",
  ];
}

function framesForToolCall(name, args) {
  return [
    sseChunk({ id: "e2e2", object: "chat.completion.chunk", created: 0, model: "e2e2", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_e2e2_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    sseChunk({ id: "e2e2", object: "chat.completion.chunk", created: 0, model: "e2e2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({ id: "e2e2", object: "chat.completion.chunk", created: 0, model: "e2e2", choices: [], usage: { prompt_tokens: 55, completion_tokens: 9 } }),
    "data: [DONE]\n\n",
  ];
}

const NEW_HELLO = "hello devwit\nline2\nadded via console diff tab\n";
const RESPONSES = [
  // #1 任务 A：请求 write 工具（活动流授权门）
  framesForToolCall("write", { path: "task-note.txt", content: "created by task console\n" }),
  // #2 任务 A：工具结果回填后的总结
  framesForText("已完成：创建 task-note.txt。"),
  // #3 任务 B：编辑提案（唯一代码块 → 工作区 Diff 页签审查）
  framesForText(`这是 hello.txt 的完整新内容：\n\n\`\`\`\n${NEW_HELLO}\`\`\``),
];

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }
  req.resume(); // 排空请求体（脚本不消费内容），保证 end 触发
  req.on("end", () => {
    const frames = RESPONSES.shift() ?? framesForText("(脚本外请求)");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let i = 0;
    const push = () => {
      if (i >= frames.length) { res.end(); return; }
      res.write(frames[i]);
      i += 1;
      setTimeout(push, 30);
    };
    push();
  });
});

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-e2e2-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello devwit\nline2\n", "utf-8");

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-userdata2-"));

const report = { steps: [], startedAt: new Date().toISOString() };
let failed = null;
let electronProc = null;
let browser = null;
let exitCode = 0;

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    // --lang=zh-CN：固定中文界面（迭代 5 起首启语言跟随系统，测试环境可能是英文系统）
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userDataDir, DEVWIT_E2E_OFFSCREEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    electronProc = proc;
    let stderrBuf = "";
    const timer = setTimeout(() => reject(new Error(`等待 DevTools 端点超时。stderr: ${stderrBuf.slice(0, 500)}`)), 30_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Electron 提前退出 code=${code}。stderr: ${stderrBuf.slice(0, 500)}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  step(`本地 SSE 端点就绪 ${baseUrl}`);

  const cdpPort = 20300 + Math.floor(Math.random() * 1000);
  const wsEndpoint = await launchElectron(cdpPort);
  step(`Electron 已启动（CDP ${cdpPort}）`);
  browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) {
    page = await context.waitForEvent("page", { timeout: 15_000 });
  }
  page.on("console", (msg) => consoleLog.push(`[console:${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLog.push(`[pageerror] ${err.message}`));
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  step("应用启动");

  // ---- AC11：首次使用引导（未打开工作区时主区三步引导 + 对话空态说明）----
  await page.waitForSelector(".dw-onboarding", { timeout: 10_000 });
  const onboardingText = await page.textContent(".dw-onboarding");
  assert(onboardingText.includes("配置模型") && onboardingText.includes("打开文件夹") && onboardingText.includes("输入第一个意图"), `三步引导文案缺失: ${onboardingText?.slice(0, 120)}`);
  const emptyChat = await page.textContent(".dw-chat-empty");
  assert(emptyChat.includes("规划") && emptyChat.includes("授权") && emptyChat.includes("交付"), `对话空态说明缺失: ${emptyChat?.slice(0, 120)}`);
  step("主区三步引导 + 对话空态主 Agent 行为说明均呈现");
  await shot(page, AC(11), "onboarding-and-chat-empty");

  // 引导示例：点击示例意图 → 自动切到指挥台并预填新任务输入
  await page.click(".dw-onboarding-chip >> nth=0");
  await page.waitForSelector(".dw-console", { state: "visible", timeout: 5_000 });
  const prefilled = await page.inputValue(".dw-task-new .dw-input");
  assert(prefilled.length > 0, "示例意图未预填到新任务输入框");
  step("示例意图一键进入指挥台（预填新任务输入）");
  await shot(page, AC(11), "example-to-console");
  await page.fill(".dw-task-new .dw-input", "");
  await page.click(".dw-header >> text=对话");
  writeText(AC(11), "onboarding-verification.txt", `未打开工作区时：主区显示三步引导（配置模型→打开文件夹→输入第一个意图并附 3 个示例），对话区空态说明主 Agent 行为（规划/授权/交付）。\n点击示例意图 → 自动切换指挥台形态并预填新任务输入框（截图 01/02）。`);

  // ---- 打开工作区（引导隐藏）----
  await page.click(".dw-header >> text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  const onboardingHidden = await page.evaluate(() => document.querySelector(".dw-onboarding")?.style.display === "none");
  assert(onboardingHidden, "打开工作区后引导未隐藏");
  step("打开文件夹 → 文件树渲染，引导隐藏");

  // ---- AC10：外部编辑器（未配置引导小页 → 配置模板 → 真实 spawn 落盘证明）----
  await page.click('.dw-tree-node:has-text("hello.txt")');
  await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("hello.txt"));
  await page.click("text=外部编辑器");
  await page.waitForSelector(".dw-editor-setup", { timeout: 5_000 });
  const setupTitle = await page.textContent(".dw-editor-setup h2");
  assert(setupTitle?.includes("选择外部编辑器"), `引导小页标题缺失: ${setupTitle}`);
  const modalText = await page.textContent(".dw-editor-setup");
  assert(modalText.includes("{file}") && modalText.includes("命令模板"), `编辑器设置引导文案缺失: ${modalText?.slice(0, 120)}`);
  step("未配置时点击「外部编辑器 ↗」→ 弹出「选择外部编辑器」引导小页（引导优于报错）");
  await shot(page, AC(10), "unconfigured-guidance");

  // 配置命令模板：node 真实子进程把占位符路径落盘为标记文件（spawn 真实发生）。
  // 「保存并打开」：保存模板 → 关闭小页 → 立即重试打开当前文件（hello.txt 已打开）。
  // spawn 标记落盘同时证明「保存成功」与「重试打开成功」，比读 errorBox 更强断言。
  const marker = `${path.join(fixture, "hello.txt")}.ext-proof`;
  await page.fill(".dw-editor-setup .dw-input", 'node -e "require(\'fs\').writeFileSync(process.argv[1],\'opened\')" "{file}.ext-proof"');
  await page.click(".dw-editor-setup >> text=保存并打开");
  const spawned = await waitForFile(marker);
  assert(spawned, "外部编辑器 spawn 标记文件未出现（子进程未真实执行）");
  fs.rmSync(marker);
  step("配置命令模板 → 真实 spawn 子进程（{file} 占位符替换落盘证明）");
  await shot(page, AC(10), "spawn-verified");
  const hasTreeExternal = (await page.locator(".dw-tree-external").count()) > 0;
  assert(hasTreeExternal, "文件树缺少外部编辑器入口");
  writeText(AC(10), "external-editor-verification.txt", `未配置：点击「外部编辑器 ↗」弹出「选择外部编辑器」引导小页（截图 03：预设一键填模板，真实 spawn 验证见截图 04）。\n配置模板: node -e "require('fs').writeFileSync(process.argv[1],'opened')" "{file}.ext-proof"\n点击后真实 spawn node 子进程，标记文件 hello.txt.ext-proof 在磁盘出现（占位符 {file} 被真实替换），验证后已清理。\n文件树每个文件节点含 ↗ 外部编辑器入口。\n单元测试另见 apps/desktop/tests/external-editor.test.ts（模板解析/占位符/错误路径）。`);

  // ---- AC8：双形态切换，两种形态工作状态各自保持 ----
  await page.fill(".dw-chat .dw-chat-textarea", "一条未发送的草稿");
  await page.click(".dw-header >> text=指挥台");
  await page.waitForSelector(".dw-console", { state: "visible", timeout: 5_000 });
  const ideHidden = await page.evaluate(() => document.querySelector(".dw-ide")?.style.display === "none");
  const editorInConsole = (await page.locator(".dw-console-code .dw-editor-canvas").count()) > 0;
  assert(ideHidden && editorInConsole, "指挥台形态：对话形态未隐藏或编辑器未迁入代码页签");
  step("切到指挥台：三栏布局呈现，编辑器迁入「代码」页签");
  await shot(page, AC(8), "console-form");

  await page.click(".dw-header >> text=对话");
  await page.waitForSelector(".dw-ide", { state: "visible", timeout: 5_000 });
  const draftKept = await page.inputValue(".dw-chat .dw-chat-textarea");
  const activeKept = await page.textContent(".dw-active-file");
  assert(draftKept === "一条未发送的草稿", `对话形态草稿未保持: ${JSON.stringify(draftKept)}`);
  assert(activeKept.includes("hello.txt"), `编辑器活动文件未保持: ${activeKept}`);
  step("切回对话：草稿与编辑器活动文件均保持（状态互不丢失）");
  await shot(page, AC(8), "chat-form-state-kept");
  await page.fill(".dw-chat .dw-chat-textarea", "");
  writeText(AC(8), "form-switch-verification.txt", `顶栏「指挥台/对话」一键切换。\n对话形态侧栏输入未发送草稿 → 切到指挥台（编辑器迁入代码页签，截图 05）→ 切回对话：草稿原文保留、编辑器活动文件 hello.txt 保留（截图 06）。\n两种形态 DOM 各自保持（display 切换，不销毁重建）。`);

  // ---- AC9：任务指挥台（任务列表 + 活动流 + 授权门 + Diff 页签）----
  // 配置凭证/provider + 绑定 agent 模式（真实热更新路径）
  await page.evaluate(async (url) => {
    window.__e2eEvents = [];
    window.devwit.agent.onEvent((evt) => window.__e2eEvents.push(evt));
    await window.devwit.credentials.set("e2e2-cred", "openai", "sk-e2e2-fake");
    await window.devwit.providers.upsert({
      id: "e2e2-local", type: "openai", label: "E2E2 Local", baseUrl: url,
      model: "e2e2-model", credentialRef: "e2e2-cred", maxTokens: 2048,
    });
    const agent = (await window.devwit.modes.list()).find((m) => m.id === "agent");
    await window.devwit.modes.upsert({ ...agent, providerId: "e2e2-local", updatedAt: new Date().toISOString() });
  }, baseUrl);
  step("凭证写入（safeStorage 加密）+ provider 注册 + agent 模式热绑定模型");

  await page.click(".dw-header >> text=指挥台");
  await page.fill(".dw-task-new .dw-input", "创建文件 task-note.txt");
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-act-authorization", { timeout: 30_000 });
  const badgeAuth = await page.textContent(".dw-task-row .dw-task-badge");
  assert(badgeAuth.includes("待授权"), `任务状态应为「待授权」: ${badgeAuth}`);
  step("任务创建 → agent 请求 write → 活动流授权行 + 任务「待授权」徽标");
  await shot(page, AC(9), "task-waiting-auth");

  await page.click(".dw-act-authorization >> text=允许");
  await page.waitForSelector(".dw-act-done", { timeout: 30_000 });
  const taskFile = path.join(fixture, "task-note.txt");
  assert(fs.existsSync(taskFile) && fs.readFileSync(taskFile, "utf-8") === "created by task console\n", "task-note.txt 未按授权真实落盘");
  const badgeDone = await page.textContent(".dw-task-row .dw-task-badge");
  assert(badgeDone.includes("完成"), `任务状态应为「完成」: ${badgeDone}`);
  const actText = await page.textContent(".dw-activity");
  for (const badge of ["用户", "助手", "工具", "授权", "完成"]) {
    assert(actText.includes(badge), `活动流缺少「${badge}」事件行`);
  }
  step("授权允许 → write 真实落盘 → 活动流五类事件齐全 → 任务「完成」");
  await shot(page, AC(9), "task-done-activity-stream");
  const events = await page.evaluate(() => window.__e2eEvents);
  writeJson(AC(9), "trace.json", events);

  // 任务 B：编辑提案 → 工作区 Diff 页签审查
  await page.fill(".dw-task-new .dw-input", "给 hello.txt 加一行，给出完整新内容");
  await page.click(".dw-console-tasks >> text=创建");
  await page.waitForSelector(".dw-activity >> text=审查修改", { timeout: 30_000 });
  await page.click(".dw-activity >> text=审查修改");
  await page.waitForSelector(".dw-console-diff .dw-diff-hunk", { timeout: 10_000 });
  const diffTabActive = await page.evaluate(() => [...document.querySelectorAll(".dw-console-workspace .dw-tab")].find((t) => t.textContent === "Diff")?.classList.contains("dw-tab-active"));
  assert(diffTabActive === true, "Diff 页签未激活");
  step("任务 B 提案 → 「审查修改」→ diff 在工作区 Diff 页签打开");
  await shot(page, AC(9), "diff-tab-review");

  await page.click("text=全部接受");
  await page.click("text=应用并关闭");
  await page.waitForSelector(".dw-diff-overlay", { state: "detached", timeout: 10_000 });
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => !document.querySelector(".dw-statusbar")?.textContent?.includes("未保存"), null, { timeout: 5_000 });
  const afterDiff = fs.readFileSync(path.join(fixture, "hello.txt"), "utf-8");
  assert(afterDiff.trimEnd() === NEW_HELLO.trimEnd(), `diff 应用后磁盘内容不符: ${JSON.stringify(afterDiff)}`);
  step("diff 逐块接受 → 应用 → Ctrl+S → 磁盘内容验证一致");
  await shot(page, AC(9), "diff-applied-console");
  writeText(AC(9), "console-verification.txt", `左栏任务列表：两个任务（创建文件 / 编辑提案），状态徽标 进行中→待授权→完成 实时归约。\n中栏活动流：用户/助手/工具/授权/完成 五类事件实时渲染，授权请求内联裁决（允许/本会话允许/拒绝）。\n右栏工作区视图：代码页签（同一编辑器实例）+ Diff 页签（提案审查，逐块接受/拒绝，应用后磁盘验证一致）。\ntrace.json 含 ${events.length} 条轨迹事件。`);

  // ---- AC12：统一设置页 + 界面语言切换（热生效 + 持久化）----
  await page.click(".dw-header >> text=设置");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  const navText = await page.textContent(".dw-settings-nav");
  assert(
    navText.includes("通用") && navText.includes("模型") && navText.includes("编辑器") && navText.includes("模式"),
    `设置页四分区导航缺失: ${navText}`
  );
  step("统一设置页：通用/模型/编辑器/模式 四分区左侧导航");
  await shot(page, AC(12), "settings-nav");

  // 通用分区：切换 English → 全界面热生效（含设置页自身导航）
  await page.selectOption(".dw-settings-content .dw-select", "en-US");
  await page.waitForFunction(() => document.querySelector(".dw-header")?.textContent?.includes("Open Folder"), null, { timeout: 5_000 });
  const navEn = await page.textContent(".dw-settings-nav");
  assert(navEn.includes("General") && navEn.includes("Providers") && navEn.includes("Editor") && navEn.includes("Modes"), `设置导航未热切换: ${navEn}`);
  const persisted = await page.evaluate(() => window.devwit.settings.get("ui.locale"));
  assert(persisted === "en-US", `语言选择未持久化到 ui.locale: ${JSON.stringify(persisted)}`);
  step("切换 English → 设置页导航/顶栏热生效，ui.locale 持久化");
  await shot(page, AC(12), "locale-en-hot");
  await page.click(".dw-modal >> text=Close");

  // 主界面英文态：顶栏按钮 + 对话空态说明（当前在指挥台形态，形态按钮显示切换目标 Chat）
  const headerEn = await page.textContent(".dw-header");
  assert(headerEn.includes("Chat") && headerEn.includes("Settings"), `顶栏未英文化: ${headerEn?.slice(0, 120)}`);
  const emptyEn = await page.textContent(".dw-chat-empty");
  assert(emptyEn.includes("Plan") && emptyEn.includes("Authorize") && emptyEn.includes("Deliver"), `对话空态未英文化: ${emptyEn?.slice(0, 120)}`);
  await shot(page, AC(12), "main-ui-en");
  step("主界面英文态：顶栏 + 对话空态主 Agent 行为说明");

  // 切回中文（保持后继环境与中文断言一致）
  await page.click(".dw-header >> text=Settings");
  await page.waitForSelector(".dw-modal-settings", { timeout: 5_000 });
  await page.selectOption(".dw-settings-content .dw-select", "zh-CN");
  await page.waitForFunction(() => document.querySelector(".dw-header")?.textContent?.includes("打开文件夹"), null, { timeout: 5_000 });
  await page.click(".dw-modal >> text=关闭");
  const persistedBack = await page.evaluate(() => window.devwit.settings.get("ui.locale"));
  assert(persistedBack === "zh-CN", `语言回切未持久化: ${JSON.stringify(persistedBack)}`);
  step("切回中文 → 界面恢复，持久化回写 zh-CN");
  writeText(AC(12), "i18n-verification.txt", `统一设置页：左侧导航 通用/模型/编辑器/模式（截图 01）。\n通用分区语言下拉切到 English：顶栏 Open Folder/Console/Settings、设置页导航 General/Providers/Editor/Modes、对话空态英文主 Agent 说明（Plan/Authorize/Deliver）全部热生效无需重启（截图 02/03）；settings 键 "ui.locale" 持久化为 en-US（启动时 renderer 读取恢复）。\n切回 zh-CN：界面恢复中文，ui.locale 回写 zh-CN。\n词典结构与插值/回退的单元测试见 packages/i18n/tests/i18n.test.ts。`);

  step("迭代 2/3 全部场景通过");
}

try {
  await main();
} catch (error) {
  failed = error;
  exitCode = 1;
} finally {
  try {
    if (browser) {
      const pages = browser.contexts()[0]?.pages() ?? [];
      if (failed && pages[0]) await shot(pages[0], EVIDENCE, "e2e2-failure-state").catch(() => {});
      await browser.close().catch(() => {});
    }
    if (electronProc && !electronProc.killed) {
      electronProc.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        electronProc.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  } catch { /* 收尾失败不遮蔽主结果 */ }
  server.close();
  writeText(EVIDENCE, "e2e2-renderer-console.log", consoleLog.join("\n") || "(无渲染进程控制台输出)");
  report.finishedAt = new Date().toISOString();
  report.result = failed ? `FAILED: ${failed.message}` : "PASSED";
  writeJson(EVIDENCE, "e2e2-report.json", report);
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (failed) {
    console.error(`[e2e2] FAILED: ${failed.stack ?? failed.message}`);
  } else {
    console.log("[e2e2] PASSED — 迭代 2 全部场景通过");
  }
  process.exit(exitCode);
}
