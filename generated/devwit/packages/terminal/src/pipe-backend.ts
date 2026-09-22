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
    this.proc.stdin.write(data);
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
