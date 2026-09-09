/**
 * DevWit E2E：CJK/全角宽度渲染验证（v0.7.1 P0 修复）。
 *
 * 验证链路（真实 Electron + 真实 canvas + 真实鼠标事件，非单元测试）：
 * 1. 宽字符列间距 = 半字符 2 倍（旧 length×charWidth 模型下两者相等——本断言即回归判别）；
 * 2. 鼠标点击任意列左缘 → 光标精确落该列（clientPoint ↔ positionFromClientPoint 回环）；
 * 3. 全角字符内部中点点击 → 落在合理列（不越过后继半角字符）。
 * 证据落盘 evidence/CJK/。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const EVIDENCE = path.join(ROOT, "evidence", "CJK");
fs.rmSync(EVIDENCE, { recursive: true, force: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

const LINE = "a中b中文c"; // 半/全/半/全/全/半——6 字符，列 0..6

function step(name) {
  console.log(`[cjk-e2e] ${name}`);
}
function assert(cond, message) {
  if (!cond) throw new Error(`断言失败: ${message}`);
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
    const timer = setTimeout(() => reject(new Error(`等待 DevTools 端点超时。stderr: ${stderrBuf.slice(0, 500)}`)), 30_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ ws: match[1], proc });
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Electron 提前退出 code=${code}`));
    });
  });
}

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-cjk-"));
  fs.writeFileSync(path.join(fixture, "中文测试.txt"), `${LINE}\n第二行：全角标点，。「」\n`, "utf-8");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-cjk-user-"));

  const cdpPort = 19500 + Math.floor(Math.random() * 1000);
  const { ws, proc } = await launchElectron(cdpPort, fixture, userDataDir);
  step("Electron 已启动");
  try {
    const browser = await chromium.connectOverCDP(ws);
    const context = browser.contexts()[0];
    let page = context.pages().find((p) => p.url().includes("index.html"));
    if (!page) page = await context.waitForEvent("page", { timeout: 15_000 });
    await page.waitForSelector(".dw-header", { timeout: 30_000 });
    step("应用启动");

    await page.click(".dw-header >> text=打开文件夹");
    await page.waitForSelector(".dw-tree-node", { timeout: 15_000 });
    await page.click('.dw-tree-node:has-text("中文测试.txt")');
    await page.waitForFunction(() => document.querySelector(".dw-active-file")?.textContent?.includes("中文测试.txt"));
    step("编辑器打开中文文件");
    await page.focus('textarea[aria-label="editor input"]');

    // --- 断言 1：全角字符列间距 = 半角 2 倍（核心回归判别） ---
    const geometry = await page.evaluate((line) => {
      const hook = window.__devwitE2E;
      const xs = [];
      for (let col = 0; col <= line.length; col++) {
        const p = hook.editorClientPoint(0, col);
        xs.push(p.x);
      }
      return { xs, cell: hook.editorClientPoint(0, 0).y };
    }, LINE);
    const half = geometry.xs[1] - geometry.xs[0]; // 'a'：1 格
    const wide = geometry.xs[2] - geometry.xs[1]; // '中'：2 格
    assert(Math.abs(wide - 2 * half) <= 1.5, `全角列间距应为半角 2 倍：half=${half}, wide=${wide}`);
    const half2 = geometry.xs[3] - geometry.xs[2]; // 'b'：1 格
    assert(Math.abs(half2 - half) <= 1, `半角列间距应一致：half=${half}, half2=${half2}`);
    const wide2 = geometry.xs[4] - geometry.xs[3]; // '中'：2 格
    assert(Math.abs(wide2 - 2 * half) <= 1.5, `第二个全角列间距也应为 2 倍：wide2=${wide2}`);
    step(`宽度模型正确：半角 ${half.toFixed(1)}px，全角 ${wide.toFixed(1)}px（≈2×）`);

    // --- 断言 2：鼠标点击任意列左缘 → 光标精确落该列 ---
    const cols = [0, 1, 2, 3, 4, 6];
    for (const col of cols) {
      const point = await page.evaluate((c) => window.__devwitE2E.editorClientPoint(0, c), col);
      await page.mouse.click(point.x, point.y);
      const sel = await page.evaluate(() => window.__devwitE2E.editorSelections()[0]);
      assert(sel.active.line === 0 && sel.active.character === col, `点击列 ${col} 左缘应落列 ${col}，实际 ${JSON.stringify(sel.active)}`);
    }
    step("点击回环：6 个采样列全部精确命中（光标=鼠标列）");

    // --- 断言 3：全角字符内部中点 → 落在该字符两列之一（不越过其后字符） ---
    const midX = (geometry.xs[1] + geometry.xs[2]) / 2 - 1; // '中' 内部偏左
    const y = geometry.cell;
    await page.mouse.click(midX, y);
    let sel = await page.evaluate(() => window.__devwitE2E.editorSelections()[0]);
    assert(sel.active.character === 1 || sel.active.character === 2, `全角字符内部点击应落列 1 或 2，实际 ${sel.active.character}`);
    step(`全角字符内部点击落列 ${sel.active.character}（合理区间）`);

    await page.screenshot({ path: path.join(EVIDENCE, "cjk-editor.png") });
    fs.writeFileSync(
      path.join(EVIDENCE, "cjk-verification.txt"),
      [
        `行内容: ${JSON.stringify(LINE)}`,
        `列左缘 x: ${geometry.xs.map((x) => x.toFixed(1)).join(", ")}`,
        `半角列间距: ${half.toFixed(2)}px；全角列间距: ${wide.toFixed(2)}px（≈2×）`,
        `点击回环: 列 [${cols.join(", ")}] 全部精确命中`,
        `全角内部中点点击落列: ${sel.active.character}`,
        "结论: CJK/全角宽度模型渲染正确（v0.7.1 P0 修复验证通过）。",
      ].join("\n"),
      "utf-8"
    );
    step("证据落盘 evidence/CJK/");
    console.log("[cjk-e2e] PASSED — CJK 宽度渲染验证全部通过");
  } finally {
    proc.kill();
    // 尽力清理：Chromium 垂死进程可能短暂锁住 userData（DIPS 字体缓存等），
    // 重试后退化为留给 OS 临时目录回收——不得让清理失败掩盖真实断言结果
    for (const dir of [fixture, userDataDir]) {
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(`[cjk-e2e] FAILED: ${error.message}`);
  process.exit(1);
});
