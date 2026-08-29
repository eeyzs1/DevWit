"use strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const electronExe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "dw-wiz-"));
fs.writeFileSync(path.join(fixture, "hello.ts"), "// hello\n", "utf-8");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "dw-wiz-ud-"));
const OUT = path.join(ROOT, "evidence", "diag-wizard");
fs.mkdirSync(OUT, { recursive: true });

function launch(cdpPort) {
  return new Promise((resolve, reject) => {
    const proc = spawn(electronExe, [`--remote-debugging-port=${cdpPort}`, "--lang=zh-CN", "."], {
      cwd: ROOT,
      env: { ...process.env, DEVWIT_E2E_OPEN_DIR: fixture, DEVWIT_USER_DATA_DIR: userData, DEVWIT_E2E_OFFSCREEN: "1", DEVWIT_E2E_WIZARD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timeout: " + buf.slice(0, 500))), 40000);
    proc.stderr.on("data", (c) => { buf += c.toString(); const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve({ proc, ws: m[1] }); } });
    proc.on("exit", (c) => reject(new Error("exit " + c)));
    proc.on("error", reject);
  });
}

function inspect(page) {
  return page.evaluate(() => {
    const sel = document.querySelector('select[title="模型"]');
    const ancestors = [];
    let node = sel;
    let depth = 0;
    while (node && depth < 8) {
      const cs = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      ancestors.push({ tag: node.tagName, cls: node.className, display: cs.display, vis: cs.visibility, rectH: r.height, rectW: r.width });
      node = node.parentElement; depth += 1;
    }
    return {
      modelSelect: sel ? { rect: (() => { const r = sel.getBoundingClientRect(); return { w: r.width, h: r.height }; })(), optionCount: sel.options.length, value: sel.value } : null,
      ancestors,
      wizardPresent: document.querySelector(".dw-wizard") !== null,
      wizardText: document.querySelector(".dw-wizard")?.textContent?.slice(0, 80) ?? null,
      tourPresent: document.querySelector(".dw-tour-mask") !== null,
      hasProviderOpts: sel ? [...sel.options].some((o) => o.value !== "") : false,
      headerText: document.querySelector(".dw-header")?.textContent?.slice(0, 40) ?? null,
    };
  });
}

async function main() {
  const { proc, ws } = await launch(19300 + Math.floor(Math.random() * 1000));
  const browser = await chromium.connectOverCDP(ws);
  const page = browser.contexts()[0].pages().find((p) => p.url().includes("index.html"));
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const states = [];
  states.push({ label: "启动即查", data: await inspect(page) });
  await page.screenshot({ path: path.join(OUT, "0-launch.png") });

  // 关闭可能弹出的向导/tour，再查
  for (const sel of [".dw-wizard button", ".dw-tour-modal button", ".dw-modal-actions button"]) {
    const loc = page.locator(sel).first();
    if (await loc.count()) { await loc.click().catch(() => {}); await page.waitForTimeout(500); }
  }
  await page.waitForTimeout(800);
  states.push({ label: "关闭向导/tour后", data: await inspect(page) });
  await page.screenshot({ path: path.join(OUT, "1-after-close.png") });

  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(states, null, 2), "utf-8");
  console.log(JSON.stringify(states, null, 2));
  proc.kill(); browser.close().catch(() => {}); process.exit(0);
}
main().catch((e) => { console.error("err:", e); process.exit(1); });
