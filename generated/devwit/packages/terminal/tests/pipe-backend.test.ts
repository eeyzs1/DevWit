import os from "node:os";
import { describe, expect, it } from "vitest";
import { PipeBackend } from "../src/pipe-backend.js";
import type { TerminalExitInfo } from "../src/types.js";

const isWin = process.platform === "win32";

function runEcho(): Promise<{ output: string; exit: TerminalExitInfo }> {
  return new Promise((resolve, reject) => {
    const backend = new PipeBackend();
    const handle = backend.spawn({
      cwd: os.tmpdir(),
      shell: isWin ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"),
      args: isWin ? ["/c", "echo", "hello"] : ["-c", "echo hello"],
      cols: 80,
      rows: 24
    });
    let output = "";
    const timer = setTimeout(() => {
      handle.kill();
      reject(new Error(`echo 命令超时，已收到输出: ${output}`));
    }, 10000);
    handle.onData((data) => {
      output += data;
    });
    handle.onExit((exit) => {
      clearTimeout(timer);
      resolve({ output, exit });
    });
  });
}

describe("PipeBackend", () => {
  it("真实 shell 执行 echo 并回传输出", async () => {
    const { output, exit } = await runEcho();
    expect(output).toContain("hello");
    expect(exit.code).toBe(0);
  });

  it("kill 后 onData 不再触发", async () => {
    const backend = new PipeBackend();
    const handle = backend.spawn({
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24
    });
    let count = 0;
    handle.onData(() => {
      count += 1;
    });
    handle.kill();
    await new Promise((r) => setTimeout(r, 300));
    const afterKill = count;
    await new Promise((r) => setTimeout(r, 300));
    expect(count).toBe(afterKill);
  });
});
