"use strict";
// 持久可见启动：spawn electron（有窗）+ DEVWIT_E2E_OPEN_DIR 打开指定工作区，进程保活。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const workspace = process.env.DEVWIT_WORKSPACE ?? ROOT;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "dw-persist-"));
const port = 9445;
const proc = spawn(exe, [`--remote-debugging-port=${port}`, "--lang=zh-CN", "."], {
  cwd: ROOT,
  env: { ...process.env, DEVWIT_E2E_OPEN_DIR: workspace, DEVWIT_USER_DATA_DIR: userData },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stderr.on("data", (c) => {
  const s = c.toString();
  if (s.includes("DevTools listening")) console.log("CDP_READY ws://127.0.0.1:" + port);
  if (/error|Error/i.test(s)) console.log("stderr:", s.trim().slice(0, 200));
});
proc.on("exit", (code) => console.log("electron exited", code));
console.log("persist-launch pid", proc.pid, "workspace", workspace, "userData", userData);
process.on("SIGTERM", () => proc.kill());
// 保活
setInterval(() => {}, 1 << 30);
