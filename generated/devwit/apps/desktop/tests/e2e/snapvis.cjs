"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const ver = await (await fetch("http://127.0.0.1:9445/json/version")).json();
  const bid = ver.webSocketDebuggerUrl.split("/").pop();
  const browser = await chromium.connectOverCDP("ws://127.0.0.1:9445/devtools/browser/" + bid);
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes("index.html"));
  await page.waitForSelector(".dw-header", { timeout: 30000 });
  const out = "E:\\AI_Generated_Projects\\DevWit\\generated\\devwit\\evidence\\visible-window.png";
  await page.screenshot({ path: out });
  console.log("saved", out);
  browser.close().catch(()=>{});
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
