/**
 * 终端后端抽象（WU006）。pty = node-pty 真伪终端；pipe = child_process 管道 shell。
 * 仅供 Electron 主进程使用（AR004）。
 */

export interface TerminalSpawnOptions {
  cwd: string;
  shell?: string;
  /** 额外启动参数（如 cmd.exe 的 /c）；默认交互式 */
  args?: string[];
  cols: number;
  rows: number;
}

export interface TerminalExitInfo {
  code: number | null;
  signal: string | null;
}

export interface TerminalHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exit: TerminalExitInfo) => void): void;
}

export interface TerminalBackend {
  readonly kind: "pty" | "pipe";
  spawn(opts: TerminalSpawnOptions): TerminalHandle;
}

/** 默认 shell：Windows = COMSPEC ?? cmd.exe；POSIX = SHELL ?? /bin/sh */
export function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/sh";
}
