/**
 * PipeBackend（WU006）：基于 node:child_process 的真实 shell 管道后端。
 * 无 TTY（resize 为 no-op），作为 node-pty 不可用时的回退——仍是真实 shell，
 * 可执行任意交互命令，仅缺少伪终端特性（如全屏 TUI 程序）。
 */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { defaultShell } from "./types.js";
import type { TerminalBackend, TerminalExitInfo, TerminalHandle, TerminalSpawnOptions } from "./types.js";

/**
 * 管道模式的行尾翻译：\r\n 与孤立 \r 统一为目标平台的行终止符。
 * Windows→\r\n（cmd.exe 管道 stdin 不接受孤立 \r）；POSIX→\n（shell 把 \r 当普通字符）。
 */
export function toPipeLineEndings(data: string): string {
  return process.platform === "win32" ? data.replace(/\r\n|\r/g, "\r\n") : data.replace(/\r\n|\r/g, "\n");
}

class PipeHandle implements TerminalHandle {
  readonly pid: number;
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly decoder = new StringDecoder("utf8");
  private readonly dataCallbacks = new Set<(data: string) => void>();
  private readonly exitCallbacks = new Set<(exit: TerminalExitInfo) => void>();
  private dead = false;
  private exitFired = false;

  constructor(opts: TerminalSpawnOptions) {
    const shell = opts.shell ?? defaultShell();
    const args = opts.args ?? [];
    this.proc = spawn(shell, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true
    });
    this.pid = this.proc.pid ?? -1;

    const onChunk = (chunk: Buffer): void => {
      if (this.dead) {
        return;
      }
      const text = this.decoder.write(chunk);
      if (text.length > 0) {
        for (const cb of this.dataCallbacks) {
          cb(text);
        }
      }
    };
    this.proc.stdout.on("data", onChunk);
    this.proc.stderr.on("data", onChunk);

    this.proc.on("error", () => {
      // spawn 失败（cwd 不存在等）：视为立即退出，避免未处理 error 事件崩溃
      this.fireExit({ code: null, signal: null });
    });
    this.proc.on("close", (code, signal) => {
      const tail = this.decoder.end();
      if (tail.length > 0 && !this.dead) {
        for (const cb of this.dataCallbacks) {
          cb(tail);
        }
      }
      this.fireExit({ code, signal: signal ?? null });
    });
  }

  write(data: string): void {
    if (this.dead) {
      return;
    }
    // v0.7.31（实测修复）：管道 shell 的行终止符语义与真终端不同——cmd.exe 只认
    // \r\n、POSIX shell 只认 \n，而渲染层按 pty 惯例发送 \r。旧实现直接透传，
    // 导致 node-pty 缺失（发布包不含原生模块）回退 pipe 后，回车永远不触发执行：
    // 终端能显示 banner 但任何命令都无响应。此处按平台统一翻译行尾。
    this.proc.stdin.write(toPipeLineEndings(data));
  }

  resize(_cols: number, _rows: number): void {
    // pipe 无 TTY 尺寸概念，no-op
    void _cols;
    void _rows;
  }

  kill(): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    this.dataCallbacks.clear();
    // v0.7.25（审查 R7-7c）：Windows 进程树击杀——裸 kill 只终止 shell 本进程，
    // cmd.exe 下的 npm/node 子孙进程存活（端口占用/CPU 持续）。taskkill /T /F
    // 终止整棵树；POSIX 维持原语义（会话首进程组随 PTY/管道回收）。
    if (process.platform === "win32" && this.pid > 0) {
      try {
        spawn("taskkill", ["/pid", String(this.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        this.proc.kill();
      }
    } else {
      this.proc.kill();
    }
  }

  onData(cb: (data: string) => void): void {
    if (!this.dead) {
      this.dataCallbacks.add(cb);
    }
  }

  onExit(cb: (exit: TerminalExitInfo) => void): void {
    this.exitCallbacks.add(cb);
  }

  private fireExit(exit: TerminalExitInfo): void {
    if (this.exitFired) {
      return;
    }
    this.exitFired = true;
    this.dead = true;
    for (const cb of this.exitCallbacks) {
      cb(exit);
    }
    this.exitCallbacks.clear();
    this.dataCallbacks.clear();
  }
}

export class PipeBackend implements TerminalBackend {
  readonly kind = "pipe" as const;

  spawn(opts: TerminalSpawnOptions): TerminalHandle {
    return new PipeHandle(opts);
  }
}
