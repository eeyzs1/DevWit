/**
 * PtyBackend（WU006）：node-pty 真伪终端后端。
 * node-pty 是 optionalDependency（原生模块，Electron 下需 electron-rebuild），
 * 运行时动态 import；加载失败抛 NodePtyUnavailableError，由 TerminalService 回退。
 */
import { defaultShell } from "./types.js";
import type { TerminalBackend, TerminalExitInfo, TerminalHandle, TerminalSpawnOptions } from "./types.js";

export class NodePtyUnavailableError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`node-pty unavailable: ${detail}`);
    this.name = "NodePtyUnavailableError";
  }
}

/** node-pty 的最小结构类型，避免与本包编译期强耦合其 typings。 */
interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: PtyExitEvent) => void): void;
}

interface NodePtyModuleLike {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    }
  ): PtyProcess;
}

class PtyHandle implements TerminalHandle {
  readonly pid: number;
  private readonly pty: PtyProcess;
  private readonly dataCallbacks = new Set<(data: string) => void>();
  private readonly exitCallbacks = new Set<(exit: TerminalExitInfo) => void>();
  private dead = false;

  constructor(pty: PtyProcess) {
    this.pty = pty;
    this.pid = pty.pid;
    pty.onData((data) => {
      if (this.dead) {
        return;
      }
      for (const cb of this.dataCallbacks) {
        cb(data);
      }
    });
    pty.onExit((event) => {
      this.dead = true;
      const exit: TerminalExitInfo = {
        code: event.exitCode,
        signal: event.signal !== undefined ? String(event.signal) : null
      };
      for (const cb of this.exitCallbacks) {
        cb(exit);
      }
      this.exitCallbacks.clear();
      this.dataCallbacks.clear();
    });
  }

  write(data: string): void {
    if (!this.dead) {
      this.pty.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.dead) {
      this.pty.resize(cols, rows);
    }
  }

  kill(): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    this.dataCallbacks.clear();
    this.pty.kill();
  }

  onData(cb: (data: string) => void): void {
    if (!this.dead) {
      this.dataCallbacks.add(cb);
    }
  }

  onExit(cb: (exit: TerminalExitInfo) => void): void {
    this.exitCallbacks.add(cb);
  }
}

export class PtyBackend implements TerminalBackend {
  readonly kind = "pty" as const;

  private constructor(private readonly ptyModule: NodePtyModuleLike) {}

  /** 探测 node-pty 可用性；失败抛 NodePtyUnavailableError。 */
  static async tryCreate(): Promise<PtyBackend> {
    let mod: NodePtyModuleLike;
    try {
      mod = (await import("node-pty")) as unknown as NodePtyModuleLike;
    } catch (cause) {
      throw new NodePtyUnavailableError(cause);
    }
    if (typeof mod.spawn !== "function") {
      throw new NodePtyUnavailableError(new Error("node-pty module has no spawn()"));
    }
    return new PtyBackend(mod);
  }

  spawn(opts: TerminalSpawnOptions): TerminalHandle {
    const shell = opts.shell ?? defaultShell();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    const pty = this.ptyModule.spawn(shell, opts.args ?? [], {
      name: "xterm-color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env
    });
    return new PtyHandle(pty);
  }
}
