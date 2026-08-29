"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const ver = await (await fetch("http://127.0.0.1:9446/json/version")).json();
  const bid = ver.webSocketDebuggerUrl.split("/").pop();
  const browser = await chromium.connectOverCDP("ws://127.0.0.1:9446/devtools/browser/" + bid);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  if (!page) { console.log("no page"); process.exit(1); }
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  await page.evaluate(() => document.querySelectorAll(".dw-tour-mask").forEach((m) => m.remove())).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('.dw-header >> text=打开文件夹').catch(() => {});
  await page.waitForTimeout(3500);
  const out = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\visible-window.png";
  await page.screenshot({ path: out });
  const tree = await page.evaluate(() => document.querySelectorAll(".dw-tree-node").length);
  const wc = await page.evaluate(() => document.querySelector(".dw-statusbar")?.textContent ?? "");
  console.log("文件树节点:", tree, "| 状态栏:", wc.slice(0, 45));
  browser.close().catch(() => {});
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
