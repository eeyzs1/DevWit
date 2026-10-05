"use strict";
// 持久可见启动：spawn electron（有窗）+ DEVWIT_E2E_OPEN_DIR 打开指定工作区，进程保活。
/** 剔除宿主继承的 ELECTRON_RUN_AS_NODE——在 Electron 宿主（VS Code 任务/DSH 等）的终端里
 * 跑 E2E 时，该变量会让 electron.exe 以纯 Node 模式启动而直接 bad option 退出。 */
function omitRunAsNode(env) {
  const cleaned = { ...env };
  delete cleaned.ELECTRON_RUN_AS_NODE;
  return cleaned;
}
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
  env: { ...omitRunAsNode(process.env), DEVWIT_E2E_OPEN_DIR: workspace, DEVWIT_USER_DATA_DIR: userData },
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
