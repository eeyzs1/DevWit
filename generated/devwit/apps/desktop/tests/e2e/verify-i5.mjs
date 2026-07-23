/**
 * 迭代 5 验证脚本（用户三反馈的修复回归，证据落盘 evidence/AC14）：
 * 1. 设置·通用分区文字堆叠：hint 提示文字跨整行渲染（宽度接近内容区、高度约一行），
 *    不再被挤压进 110px 的 label 列逐词换行。
 * 2. 「跟随系统」语言选项：选项存在且默认选中；选择后持久化 "system"；
 *    界面语言 = 系统语言解析结果（中文系统→中文，其余→英文）。
 * 3. 工具栏/下拉框/tooltip 热切换：切英文后全部可见文本（按钮/页签/选项/placeholder/
 *    title）无 CJK 残留——含文件树 ↗ 按钮 tooltip（此前文件树不重建导致停留旧语言）。
 *
 * 环境：真实 Electron + 全新临时 userData + 临时工作区（文件树非空以覆盖 ↗ tooltip）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = path.join(ROOT, "evidence", "AC14");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i5-"));
fs.writeFileSync(path.join(fixture, "hello.txt"), "hello\n", "utf-8");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-verify-i5-userdata-"));

function launchElectron(cdpPort) {
  return new Promise((resolve, reject) => {
    const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userDataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrBuf = "";
    const timer = setTimeout(() => reject(new Error(`CDP 超时: ${stderrBuf.slice(0, 300)}`)), 30_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve({ ws: match[1], proc }); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`退出 code=${code}`)); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

const report = { steps: [], assertions: [], failures: [] };
const step = (name) => { report.steps.push(name); console.log(`[verify-i5] ${name}`); };
function assert(cond, message) {
  if (cond) {
    report.assertions.push(message);
    console.log(`[verify-i5] PASS: ${message}`);
  } else {
    report.failures.push(message);
    console.error(`[verify-i5] FAIL: ${message}`);
  }
}
const hasCjk = (s) => /[一-鿿]/.test(s);
/** 收集页面全部可见文本（按钮/页签/导航/选项/placeholder/title/active-file）。 */
async function dumpAll(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const texts = [];
    const push = (kind, el) => {
      const text = el.textContent?.trim() ?? "";
      if (text !== "") texts.push(`${kind}: ${text}`);
    };
    document.querySelectorAll("button").forEach((el) => { if (visible(el)) push("button", el); });
    document.querySelectorAll("select").forEach((el) => {
      if (!visible(el)) return;
      [...el.options].forEach((o) => texts.push(`option: ${o.textContent ?? ""}`));
    });
    document.querySelectorAll(".dw-tab, .dw-settings-nav button, h2, h3, .dw-active-file").forEach((el) => {
      if (visible(el)) push(el.className || el.tagName, el);
    });
    document.querySelectorAll("[placeholder]").forEach((el) => {
      if (visible(el)) texts.push(`placeholder: ${el.getAttribute("placeholder") ?? ""}`);
    });
    document.querySelectorAll("[title]").forEach((el) => {
      const title = el.getAttribute("title") ?? "";
      if (visible(el) && title !== "") texts.push(`title: ${title}`);
    });
    return texts;
  });
}

let browser = null;
let proc = null;
let fatal = null;
try {
  const cdpPort = 23100 + Math.floor(Math.random() * 500);
  const launched = await launchElectron(cdpPort);
  proc = launched.proc;
  browser = await chromium.connectOverCDP(launched.ws);
  const context = browser.contexts()[0];
  let page = context.pages().find((p) => p.url().includes("index.html"));
  if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
  await page.waitForSelector(".dw-header", { timeout: 30_000 });
  // 定位全部语言无关（首启语言 = 跟随系统解析结果，中文/英文界面皆可能）：
  // header 按钮顺序固定 形态/打开文件夹/保存/外部编辑器/设置；设置导航顺序 通用/模型/编辑器/模式
  const openFolderBtn = ".dw-header button:nth-of-type(2)";
  const settingsBtn = ".dw-header button:nth-of-type(5)";
  await page.click(openFolderBtn);
  await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
  step("应用启动（全新 userData：语言默认「跟随系统」）");

  // ---- 反馈 2a：「跟随系统」选项存在且默认选中（新用户无持久化值）----
  await page.click(settingsBtn);
  await page.waitForSelector(".dw-modal-mask");
  await page.waitForTimeout(400); // renderGeneral 异步回填选中态
  const langSelect = await page.evaluate(() => {
    const select = document.querySelector(".dw-settings-content select");
    return {
      value: select?.value ?? "",
      options: [...(select?.options ?? [])].map((o) => `${o.value}=${o.textContent}`),
    };
  });
  assert(langSelect.options.some((o) => o.startsWith("system=")), `语言选项含「跟随系统」（实际: ${langSelect.options.join(", ")})`);
  assert(langSelect.value === "system", `新用户默认选中「跟随系统」（实际: ${langSelect.value}）`);
  step(`语言选项: ${langSelect.options.join(" | ")}，默认=${langSelect.value}`);

  // ---- 反馈 1：通用分区 hint 不堆叠（跨整行、约一行高）----
  const hintBox = await page.evaluate(() => {
    const hint = document.querySelector(".dw-form > .dw-modal-hint");
    const form = document.querySelector(".dw-settings-content .dw-form");
    if (hint === null || form === null) return null;
    const hintRect = hint.getBoundingClientRect();
    const formRect = form.getBoundingClientRect();
    return { hintWidth: hintRect.width, hintHeight: hintRect.height, formWidth: formRect.width, text: hint.textContent ?? "" };
  });
  assert(hintBox !== null, "通用分区 hint 元素存在");
  if (hintBox !== null) {
    assert(hintBox.hintWidth > hintBox.formWidth * 0.8, `hint 跨整行（宽 ${hintBox.hintWidth}px / 表单 ${hintBox.formWidth}px）`);
    assert(hintBox.hintHeight < 60, `hint 不逐词堆叠（高 ${hintBox.hintHeight}px，文本 ${hintBox.text.length} 字）`);
  }
  await page.screenshot({ path: path.join(OUT, "01-general-hint-fullrow.png") });
  step("通用分区 hint 布局验证完成");

  // ---- 反馈 2b：选「跟随系统」→ 持久化 "system"，界面语言 = 系统解析结果 ----
  const expectedZh = await page.evaluate(() => navigator.language.toLowerCase().startsWith("zh"));
  await page.selectOption(".dw-settings-content select", "system");
  await page.waitForTimeout(500);
  const persistedSystem = await page.evaluate(async () => await window.devwit.settings.get("ui.locale"));
  assert(persistedSystem === "system", `选择「跟随系统」后持久化为 "system"（实际: ${String(persistedSystem)}）`);
  const sysHeaderText = await page.textContent(".dw-header");
  const sysIsZh = hasCjk(sysHeaderText ?? "");
  assert(sysIsZh === expectedZh, `界面语言跟随系统解析（navigator.language=${await page.evaluate(() => navigator.language)} → 期望${expectedZh ? "中文" : "英文"}，实际${sysIsZh ? "中文" : "英文"}）`);
  step("「跟随系统」持久化与解析验证完成");

  // ---- 反馈 3：切英文 → 全部可见文本无 CJK 残留（含文件树 ↗ tooltip）----
  await page.selectOption(".dw-settings-content select", "en-US");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "02-settings-en.png") });
  await page.click(".dw-modal-mask", { position: { x: 4, y: 4 } });
  await page.waitForTimeout(400);
  const staleEn = (await dumpAll(page)).filter(hasCjk);
  assert(staleEn.length === 0, `切英文后无 CJK 残留（按钮/选项/placeholder/title，实际残留: ${staleEn.join(" | ") || "无"}）`);
  await page.screenshot({ path: path.join(OUT, "03-main-en-no-stale.png") });
  step("英文界面全量文本 dump 完成");

  // 指挥台形态再验一遍（任务列表/页签/活动流区域）
  await page.click(".dw-header button.dw-btn-primary");
  await page.waitForTimeout(500);
  const staleConsole = (await dumpAll(page)).filter(hasCjk);
  assert(staleConsole.length === 0, `指挥台形态（英文）无 CJK 残留（实际: ${staleConsole.join(" | ") || "无"}）`);
  await page.screenshot({ path: path.join(OUT, "04-console-en.png") });
  step("指挥台形态英文 dump 完成");

  // ---- 切回「跟随系统」→ 恢复系统语言，tooltip 同步 ----
  await page.click(settingsBtn);
  await page.waitForSelector(".dw-modal-mask");
  await page.click(".dw-settings-nav button:nth-of-type(1)");
  await page.selectOption(".dw-settings-content select", "system");
  await page.waitForTimeout(500);
  await page.click(".dw-modal-mask", { position: { x: 4, y: 4 } });
  await page.waitForTimeout(400);
  const backTexts = await dumpAll(page);
  const treeTooltip = backTexts.find((text) => text.startsWith("title: ") && text.includes(expectedZh ? "外部编辑器" : "external editor"));
  assert(treeTooltip !== undefined, `文件树 ↗ tooltip 随「跟随系统」恢复（实际: ${backTexts.filter((text) => text.startsWith("title:")).join(" | ") || "无 title"}）`);
  const backStale = expectedZh ? backTexts.filter((text) => !hasCjk(text) && /button: [A-Za-z]{4,}/.test(text) && !/DevWit|Ctrl\+S|↗/.test(text)) : [];
  assert(backStale.length === 0, `恢复系统语言后无反向残留（实际: ${backStale.join(" | ") || "无"}）`);
  await page.screenshot({ path: path.join(OUT, "05-back-to-system.png") });
  step("恢复「跟随系统」验证完成");
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  report.failures.push(`fatal: ${fatal}`);
  console.error("[verify-i5] 失败:", fatal);
} finally {
  fs.writeFileSync(path.join(OUT, "verify-i5-report.json"), JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(OUT, "iteration5-verification.txt"),
    [
      "迭代 5（用户三反馈修复）验证：",
      "1. 设置·通用分区 hint 文字堆叠：.dw-form 两列 grid 中 hint 落 label 列被挤压——CSS 补 .dw-form > .dw-modal-hint { grid-column: 1 / -1 } 跨整行，并补 .dw-modal-hint 基础样式（dim 色/12px/1.6 行高）。",
      "2. 「跟随系统」语言选项：select 新增 value=system 置顶项（词典 settings.general.language.system），选中态以持久化值为准（getLocale() 无法区分「跟随系统」与显式选择）；i18n 新增 resolveSystemLocale()（navigator.language 前缀 zh → zh-CN，否则 en-US）；启动恢复逻辑：持久化值为 zh-CN/en-US 直接用，否则（system/未设置）按 resolveSystemLocale() 解析。",
      "3. 工具栏/下拉/tooltip 热切换：文件树 ↗ 按钮 tooltip（tree.external）在 applyLocale 中随语言重写（树不重建、保留展开状态）；切英文后按钮/页签/选项/placeholder/title 全量 dump 无 CJK 残留（对话 + 指挥台两种形态）。",
      `断言通过 ${report.assertions.length} 项，失败 ${report.failures.length} 项${fatal !== null ? `，fatal: ${fatal}` : ""}。`,
    ].join("\n"),
    "utf-8"
  );
  if (browser !== null) await browser.close();
  proc?.kill();
  if (report.failures.length > 0) {
    console.error(`[verify-i5] ${report.failures.length} 项断言失败，详见 ${OUT}/verify-i5-report.json`);
    process.exit(1);
  }
  console.log(`[verify-i5] 全部断言通过，证据已写入 ${OUT}`);
}
