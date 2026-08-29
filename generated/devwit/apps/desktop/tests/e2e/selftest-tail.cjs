"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const OUT = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\selftest";
(async () => {
  const ver = await (await fetch("http://127.0.0.1:9447/json/version")).json();
  const bid = ver.webSocketDebuggerUrl.split("/").pop();
  const browser = await chromium.connectOverCDP("ws://127.0.0.1:9447/devtools/browser/" + bid);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  // Git 面板
  const gitTab = page.locator('.dw-left-tabs >> text=Git').first();
  if (await gitTab.count()) { await gitTab.click().catch(() => {}); await page.waitForTimeout(600); await page.screenshot({ path: path.join(OUT, "git-panel.png") }); console.log("📸 git-panel"); }
  else { const gitAny = page.locator('text=Git').first(); if (await gitAny.count()) { await gitAny.click().catch(() => {}); await page.waitForTimeout(600); await page.screenshot({ path: path.join(OUT, "git-panel.png") }); console.log("📸 git-panel(alt)"); } }
  // 轨迹页签
  const traceTab = page.locator('.dw-tab:has-text("轨迹")').first();
  if (await traceTab.count()) { await traceTab.click().catch(() => {}); await page.waitForTimeout(600); await page.screenshot({ path: path.join(OUT, "trace-timeline.png") }); console.log("📸 trace-timeline"); }
  else console.log("(no trace tab)");
  browser.close().catch(() => {});
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
