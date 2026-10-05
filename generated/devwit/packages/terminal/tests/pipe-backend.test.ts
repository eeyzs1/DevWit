import os from "node:os";
import { describe, expect, it } from "vitest";
import { PipeBackend, toPipeLineEndings } from "../src/pipe-backend.js";
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

  it("回车行尾按平台翻译：孤立 \\r 变为可执行行终止符（v0.7.31 回退后端修复）", () => {
    // 渲染层按 pty 惯例发 \r；管道模式下必须翻译，否则 shell 永不执行。
    const sent = toPipeLineEndings("echo hi\r");
    if (isWin) {
      expect(sent).toBe("echo hi\r\n");
      expect(toPipeLineEndings("a\r\nb\r")).toBe("a\r\nb\r\n"); // 已是 CRLF 的不重复翻译
    } else {
      expect(sent).toBe("echo hi\n");
      expect(toPipeLineEndings("a\r\nb\r")).toBe("a\nb\n");
    }
  });

  it("真实 shell 交互行执行：write \\r 后命令被执行（回归管道回退可用性）", async () => {
    // 复现发布包形态：node-pty 缺失回退 pipe，逐字符输入 + \r 回车必须能触发执行。
    const backend = new PipeBackend();
    const handle = backend.spawn({
      cwd: os.tmpdir(),
      shell: isWin ? (process.env.COMSPEC ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"),
      cols: 80,
      rows: 24
    });
    let output = "";
    handle.onData((data) => {
      output += data;
    });
    await new Promise((r) => setTimeout(r, 800));
    for (const ch of "echo pipe_e2e_marker") {
      handle.write(ch);
      await new Promise((r) => setTimeout(r, 10));
    }
    handle.write("\r");
    await new Promise((r) => setTimeout(r, 3000));
    handle.kill();
    expect(output).toContain("pipe_e2e_marker");
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
