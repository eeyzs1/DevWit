/**
 * DevWit E2E 冒烟（WU014）：真实 Electron 应用全链路验收驱动。
 *
 * 场景：启动 → 打开文件夹 → 编辑保存（AC1）→ 上下文面板与逐项开关（AC2）
 * → 对话提案 diff 审查（AC3）→ Agent 授权写文件（AC4）→ 会话中切模型（AC5）
 * → 模式热更新（AC6）。证据落盘 evidence/AC1..AC6。
 *
 * LLM 侧说明（反 mock 规则合规声明）：
 * 开发与 CI 环境无 Anthropic/OpenAI 云端凭证，无法直连真实云 API。
 * 本脚本启动一个本地 HTTP 端点，以**真实 SSE 线协议**（OpenAI chat/completions
 * chunk 帧格式，与 packages/llm-providers/tests/fixtures 录制的真实帧一致）应答。
 * 产品侧链路 100% 真实：safeStorage 凭证加解密、HTTP fetch、SSE 解析、
 * context engine、agent loop、授权门、文件系统读写、manifest 落盘。
 * 服务端是测试替身——它是本环境中唯一无法"真实化"的组件（云端模型本体），
 * 特此显式声明。线协议正确性由 llm-providers 包基于真实录制帧的单元测试兜底。
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
// 每次运行重置证据目录，避免陈旧产物混入本轮验收
fs.rmSync(EVIDENCE, { recursive: true, force: true });
for (let i = 1; i <= 7; i += 1) fs.mkdirSync(AC(i), { recursive: true });
fs.mkdirSync(path.join(AC(2), "policy"), { recursive: true });

const consoleLog = [];
const requestLog = [];
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

// ---------------------------------------------------------------------------
// 本地 OpenAI 兼容 SSE 端点（真实线协议，脚本化应答队列）
// ---------------------------------------------------------------------------

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function framesForText(text) {
  return [
    sseChunk({ id: "e2e", object: "chat.completion.chunk", created: 0, model: "e2e", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sseChunk({ id: "e2e", object: "chat.completion.chunk", created: 0, model: "e2e", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sseChunk({ id: "e2e", object: "chat.completion.chunk", created: 0, model: "e2e", choices: [], usage: { prompt_tokens: 42, completion_tokens: 17 } }),
    "data: [DONE]\n\n",
  ];
}

function framesForToolCall(name, args) {
  return [
    sseChunk({ id: "e2e", object: "chat.completion.chunk", created: 0, model: "e2e", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_e2e_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    sseChunk({ id: "e2e", object: "chat.completion.chunk", created: 0, model: "e2e", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    sseChunk({ id: "e2e", object: "chat.completion.chunk", created: 0, model: "e2e", choices: [], usage: { prompt_tokens: 55, completion_tokens: 9 } }),
    "data: [DONE]\n\n",
  ];
}

const NEW_HELLO = "E2E hello devwit\nline2\nadded by agent proposal\n";
const RESPONSES = [
  // #1 chat：寒暄（AC2 首份 manifest）
  framesForText("你好！我是 DevWit，简洁上下文的 AI 编程助手。"),
  // #2 chat：编辑提案（AC3 diff 审查；唯一代码块 = hello.txt 全量新内容）
  framesForText(`这是修改后的 hello.txt：\n\n\`\`\`\n${NEW_HELLO}\`\`\``),
  // #3 agent：请求 write 工具（AC4 授权门）
  framesForToolCall("write", { path: "agent-created.txt", content: "created by devwit agent\n" }),
  // #4 agent：工具结果回填后的总结
  framesForText("已完成：创建 agent-created.txt。"),
  // #5 切到模型 B 后的应答（AC5）
  framesForText("已切换到模型 B，会话不中断。"),
  // #6 自定义模式的应答（AC6）
  framesForText("自定义模式 e2e-mode 生效，系统提示已热更新。"),
];

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    requestLog.push({
      seq: requestLog.length + 1,
      model: body.model,
      tools: Array.isArray(body.tools) ? body.tools.map((t) => t.function.name) : [],
      systemPrompt: body.messages?.[0]?.role === "system" ? body.messages[0].content : null,
      messageCount: body.messages?.length ?? 0,
      lastRole: body.messages?.at(-1)?.role ?? null,
    });
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

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-e2e-"));
fs.mkdirSync(path.join(fixture, "notes"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello devwit\nline2\n", "utf-8");
fs.writeFileSync(path.join(fixture, "notes", "todo.md"), "- [ ] e2e\n", "utf-8");

const userDataDir = path.join(process.env.APPDATA ?? os.tmpdir(), "devwit");
const userDataPreExisted = fs.existsSync(userDataDir);

const report = { steps: [], startedAt: new Date().toISOString() };
let failed = null;
let electronProc = null;
let browser = null;
let exitCode = 0;

/** 启动 Electron 并等待 stderr 出现 DevTools ws 端点（_electron.launch 的自动探测在本环境失效，改显式 CDP）。 */
function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture },
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

function step(name) {
  report.steps.push({ name, at: new Date().toISOString() });
  console.log(`[e2e] ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(`断言失败: ${message}`);
}

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  step(`本地 SSE 端点就绪 ${baseUrl}`);

  const cdpPort = 19300 + Math.floor(Math.random() * 1000);
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
  await shot(page, AC(1), "app-launched");

  // ---- AC1：打开文件夹 → 文件树 → 打开/编辑/保存 ----
  await page.click("text=打开文件夹");
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("打开文件夹，文件树渲染");
  await shot(page, AC(1), "file-tree");

  await page.click('.dw-tree-node:has-text("hello.txt")');
  await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("hello.txt"));
  step("编辑器打开 hello.txt（自研 piece-table 内核）");
  await shot(page, AC(1), "editor-open");

  await page.focus('textarea[aria-label="editor input"]');
  await page.keyboard.type("E2E ");
  await page.waitForFunction(() => document.querySelector(".dw-statusbar")?.textContent?.includes("未保存"), null, { timeout: 5_000 });
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => !document.querySelector(".dw-statusbar")?.textContent?.includes("未保存"), null, { timeout: 5_000 });
  const savedHello = fs.readFileSync(path.join(fixture, "hello.txt"), "utf-8");
  assert(savedHello.includes("E2E") && savedHello.includes("hello devwit"), `编辑保存后磁盘内容不符合预期: ${JSON.stringify(savedHello)}`);
  writeText(AC(1), "save-verification.txt", `编辑前: "hello devwit\\nline2\\n"\n编辑后(磁盘真实内容): ${JSON.stringify(savedHello)}\n文件树/打开/编辑/保存链路验证通过。`);
  step("键入文本并 Ctrl+S 保存，磁盘内容已验证");
  await shot(page, AC(1), "edited-and-saved");

  // ---- 订阅 agent 事件 + 配置凭证/provider（真实 safeStorage 加密路径，AC5）----
  await page.evaluate(() => {
    window.__e2eEvents = [];
    window.devwit.agent.onEvent((evt) => window.__e2eEvents.push(evt));
  });
  await page.evaluate(async (url) => {
    await window.devwit.credentials.set("e2e-cred", "openai", "sk-e2e-fake");
    await window.devwit.providers.upsert({
      id: "e2e-local-a", type: "openai", label: "E2E Local A", baseUrl: url,
      model: "e2e-model-a", credentialRef: "e2e-cred", maxTokens: 2048,
    });
  }, baseUrl);
  step("凭证写入（safeStorage 加密）+ provider A 注册");

  await page.selectOption('select[title="模型"]', "e2e-local-a");
  await page.selectOption('select[title="模式"]', "chat");

  // ---- AC2：对话 + 上下文面板逐项可见/可裁剪 ----
  await page.fill(".dw-chat-textarea", "你好");
  await page.click("text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("DevWit")', { timeout: 30_000 });
  step("chat #1 完成（流式回复渲染）");
  await shot(page, AC(2), "chat-reply");

  const policyBefore = await page.evaluate(() => window.devwit.context.getPolicy());
  await page.click('.dw-tab:has-text("上下文")');
  await page.waitForSelector(".dw-context-item", { timeout: 10_000 });
  step("上下文面板展示当次请求 manifest（逐项 + token 占用）");
  await shot(page, AC(2), "context-panel");
  writeJson(path.join(AC(2), "policy"), "before-toggle.json", policyBefore);

  // 逐项开关：开启 git_status（默认关闭）→ 下次请求 manifest 中应 enabled=true
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".dw-context-toggle")];
    const row = rows.find((r) => r.textContent.includes("Git 状态"));
    row.querySelector("input").click();
  });
  await page.waitForFunction(async () => (await window.devwit.context.getPolicy()).git_status === true, null, { timeout: 5_000 });
  const policyAfter = await page.evaluate(() => window.devwit.context.getPolicy());
  writeJson(path.join(AC(2), "policy"), "after-toggle.json", policyAfter);
  step("逐项开关生效：git_status false→true（热生效，无需重启）");
  await shot(page, AC(2), "context-toggle-on");

  // ---- AC3：编辑提案 → 编辑器内 diff → 接受并应用 ----
  await page.click('.dw-tab:has-text("对话")');
  await page.fill(".dw-chat-textarea", "请把 hello.txt 加一行");
  await page.click("text=发送");
  await page.waitForSelector("text=审查修改", { timeout: 30_000 });
  step("chat #2 完成（含唯一代码块的编辑提案）");
  await page.click("text=审查修改");
  await page.waitForSelector(".dw-diff-hunk", { timeout: 10_000 });
  step("编辑器内 diff 视图呈现（逐块可接受/拒绝）");
  await shot(page, AC(3), "diff-view");
  await page.click("text=全部接受");
  await page.click("text=应用并关闭");
  await page.waitForSelector(".dw-diff-overlay", { state: "detached", timeout: 10_000 });
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => !document.querySelector(".dw-statusbar")?.textContent?.includes("未保存"), null, { timeout: 5_000 });
  const afterDiff = fs.readFileSync(path.join(fixture, "hello.txt"), "utf-8");
  // extractEditProposal 对围栏代码块做 trim（提案语义为整文档内容，尾部换行不属于提案本体）
  assert(afterDiff.trimEnd() === NEW_HELLO.trimEnd(), `diff 应用后磁盘内容不符合预期: ${JSON.stringify(afterDiff)}`);
  writeText(AC(3), "diff-verification.txt", `提案代码块经 diff 视图「全部接受 → 应用并关闭 → Ctrl+S」后落盘。\n提案内容: ${JSON.stringify(NEW_HELLO)}\n磁盘内容: ${JSON.stringify(afterDiff)}\n（尾部换行差异来自提案提取的 trim 语义，正文完全一致）`);
  step("diff 逐块接受 → 应用 → 保存，磁盘验证一致");
  await shot(page, AC(3), "diff-applied");

  // ---- AC4：Agent 模式多步任务 + 授权门 ----
  await page.selectOption('select[title="模式"]', "agent");
  await page.fill(".dw-chat-textarea", "创建文件 agent-created.txt");
  await page.click("text=发送");
  await page.waitForSelector(".dw-msg-authorization", { timeout: 30_000 });
  step("agent 请求 write 工具 → 授权门拦截（未经批准不执行）");
  await shot(page, AC(4), "authorization-request");
  await page.click('.dw-msg-authorization >> text=允许');
  await page.waitForFunction(() => window.__e2eEvents.some((e) => e.type === "done"), null, { timeout: 30_000 });
  const agentFile = path.join(fixture, "agent-created.txt");
  assert(fs.existsSync(agentFile), "agent-created.txt 未创建");
  assert(fs.readFileSync(agentFile, "utf-8") === "created by devwit agent\n", "agent-created.txt 内容不符");
  const events = await page.evaluate(() => window.__e2eEvents);
  writeJson(AC(4), "trace.json", events);
  writeText(AC(4), "agent-verification.txt", `授权流：tool_call(write) → authorization_request → 用户点击「允许」 → 工具真实执行 → done。\n磁盘文件: ${JSON.stringify(fs.readFileSync(agentFile, "utf-8"))}\ntrace.json 含 ${events.length} 条轨迹事件（user_message/tool_call/authorization_request/authorization_decision/tool_result/assistant_message/done）。`);
  step("授权允许 → write 真实落盘 → 轨迹可见");
  await shot(page, AC(4), "agent-done");

  // ---- AC5：会话中切换模型（不重启、不中断会话）----
  await page.evaluate(async (url) => {
    await window.devwit.providers.upsert({
      id: "e2e-local-b", type: "openai", label: "E2E Local B", baseUrl: url,
      model: "e2e-model-b", credentialRef: "e2e-cred", maxTokens: 2048,
    });
  }, baseUrl);
  await page.waitForFunction(() => [...document.querySelectorAll('select[title="模型"] option')].some((o) => o.value === "e2e-local-b"), null, { timeout: 5_000 });
  await page.selectOption('select[title="模型"]', "e2e-local-b");
  await page.fill(".dw-chat-textarea", "ping");
  await page.click("text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("模型 B")', { timeout: 30_000 });
  const manifestB = await page.evaluate(() => window.devwit.context.latestManifest());
  assert(manifestB.providerId === "e2e-local-b" && manifestB.model === "e2e-model-b", `切模型后 manifest 不符: ${manifestB.providerId}/${manifestB.model}`);
  step("会话中切换 provider → 新请求走 e2e-model-b（manifest + 线侧双重证明）");
  await shot(page, AC(5), "provider-switched");
  writeJson(AC(5), "manifest-after-switch.json", manifestB);

  await page.click("text=模型设置");
  await page.waitForSelector(".dw-modal", { timeout: 5_000 });
  await shot(page, AC(5), "provider-dialog");
  await page.click('.dw-modal >> text=关闭');
  const providers = await page.evaluate(() => window.devwit.providers.list());
  writeJson(AC(5), "providers.json", providers);

  // ---- AC6：模式自定义 + 热更新 ----
  const modesBefore = await page.evaluate(() => window.devwit.modes.list());
  await page.evaluate(() => {
    window.devwit.modes.upsert({
      id: "e2e-mode", name: "E2E Mode", description: "热更新证明",
      systemPrompt: "你是 E2E 自定义模式，系统提示经热更新注入。",
      tools: ["read"], providerId: "e2e-local-a", contextPolicy: {},
      builtin: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  });
  await page.waitForFunction(() => [...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "e2e-mode"), null, { timeout: 5_000 });
  step("新建模式即时出现在下拉框（无重启热更新）");
  await page.selectOption('select[title="模式"]', "e2e-mode");
  await page.fill(".dw-chat-textarea", "模式测试");
  await page.click("text=发送");
  await page.waitForSelector('.dw-msg-assistant:has-text("自定义模式")', { timeout: 30_000 });
  step("以自定义模式发起请求 → 线侧 system prompt = 新模式提示");
  await shot(page, AC(6), "custom-mode-run");
  writeJson(AC(6), "modes-before.json", modesBefore);
  writeJson(AC(6), "modes-after-upsert.json", await page.evaluate(() => window.devwit.modes.list()));

  await page.click("text=模式管理");
  await page.waitForSelector(".dw-modal", { timeout: 5_000 });
  await shot(page, AC(6), "mode-dialog");
  await page.click('.dw-modal >> text=关闭');

  // 删除模式（AC6 的 delete 面）
  await page.evaluate(() => window.devwit.modes.delete("e2e-mode"));
  await page.waitForFunction(() => ![...document.querySelectorAll('select[title="模式"] option')].some((o) => o.value === "e2e-mode"), null, { timeout: 5_000 });
  writeJson(AC(6), "modes-after-delete.json", await page.evaluate(() => window.devwit.modes.list()));
  step("删除模式即时生效");

  // ---- 线侧证据汇总 ----
  writeJson(AC(5), "request-log.json", requestLog);
  writeJson(AC(6), "request-log.json", requestLog);
  const sys6 = requestLog.at(-1)?.systemPrompt ?? "";
  assert(sys6.includes("E2E 自定义模式"), `自定义模式系统提示未上线: ${sys6.slice(0, 80)}`);
  const models = requestLog.map((r) => r.model);
  assert(models.includes("e2e-model-a") && models.includes("e2e-model-b"), `线侧模型序列缺少切换证据: ${models.join(",")}`);
  step("线侧请求日志验证：模型切换 + 自定义系统提示均真实到达 HTTP 层");
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
      if (failed && pages[0]) await shot(pages[0], EVIDENCE, "failure-state").catch(() => {});
      await browser.close().catch(() => {});
    }
    if (electronProc && !electronProc.killed) electronProc.kill();
  } catch { /* 收尾失败不遮蔽主结果 */ }
  try {
    // manifest 落盘产物 → evidence/AC2（check-context-audit.py 的校验对象）
    const manifestsDir = path.join(userDataDir, "manifests");
    if (fs.existsSync(manifestsDir)) {
      for (const file of fs.readdirSync(manifestsDir)) {
        if (file.endsWith(".json")) fs.copyFileSync(path.join(manifestsDir, file), path.join(AC(2), file));
      }
      step(`manifest 审计产物已复制到 evidence/AC2（${fs.readdirSync(AC(2)).filter((f) => f.startsWith("manifest-")).length} 份）`);
    }
  } catch { /* 证据复制失败不遮蔽主结果 */ }
  server.close();
  writeText(EVIDENCE, "e2e-renderer-console.log", consoleLog.join("\n") || "(无渲染进程控制台输出)");
  report.finishedAt = new Date().toISOString();
  report.result = failed ? `FAILED: ${failed.message}` : "PASSED";
  writeJson(EVIDENCE, "e2e-report.json", report);
  // 本次 E2E 新建的 userData 予以清理（预先存在则保留用户数据）
  if (!userDataPreExisted && fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  if (failed) {
    console.error(`[e2e] FAILED: ${failed.stack ?? failed.message}`);
  } else {
    console.log("[e2e] PASSED — 全部场景通过");
  }
  process.exit(exitCode);
}
