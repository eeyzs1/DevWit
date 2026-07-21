/**
 * TerminalService（WU006）：会话管理与后端选择。
 * create 时优先 PtyBackend（node-pty），探测或 spawn 失败自动回退 PipeBackend；
 * 返回的 TerminalSessionInfo.backend 记录实际使用的后端。
 */
import { randomUUID } from "node:crypto";
import type { TerminalSessionInfo } from "@devwit/contracts";
import { PipeBackend } from "./pipe-backend.js";
import { PtyBackend } from "./pty-backend.js";
import { defaultShell } from "./types.js";
import type { TerminalBackend, TerminalHandle } from "./types.js";

export interface TerminalCreateOptions {
  cwd: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

interface Session {
  info: TerminalSessionInfo;
  handle: TerminalHandle;
  outputCallbacks: Set<(data: string) => void>;
}

export class TerminalService {
  private readonly sessions = new Map<string, Session>();

  /** 创建终端会话。先 pty 后 pipe 回退；两者都失败则抛错。 */
  async create(options: TerminalCreateOptions): Promise<TerminalSessionInfo> {
    const spawnOpts = {
      cwd: options.cwd,
      shell: options.shell,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24
    };

    let backend: TerminalBackend | null = null;
    try {
      backend = await PtyBackend.tryCreate();
    } catch {
      backend = null;
    }

    let handle: TerminalHandle;
    let usedBackend: TerminalBackend;
    if (backend) {
      try {
        handle = backend.spawn(spawnOpts);
        usedBackend = backend;
      } catch {
        // node-pty 加载成功但 spawn 失败（如 ABI 不匹配），回退 pipe
        usedBackend = new PipeBackend();
        handle = usedBackend.spawn(spawnOpts);
      }
    } else {
      usedBackend = new PipeBackend();
      handle = usedBackend.spawn(spawnOpts);
    }

    const info: TerminalSessionInfo = {
      id: randomUUID(),
      shell: options.shell ?? defaultShell(),
      cwd: options.cwd,
      backend: usedBackend.kind,
      pid: handle.pid
    };
    const session: Session = { info, handle, outputCallbacks: new Set() };
    this.sessions.set(info.id, session);
    handle.onData((data) => {
      for (const cb of session.outputCallbacks) {
        cb(data);
      }
    });
    handle.onExit(() => {
      this.sessions.delete(info.id);
    });
    return info;
  }

  get(id: string): TerminalSessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  write(id: string, data: string): void {
    this.requireSession(id).handle.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.requireSession(id).handle.resize(cols, rows);
  }

  /** 订阅会话输出，返回退订函数。 */
  onOutput(id: string, cb: (data: string) => void): () => void {
    const session = this.requireSession(id);
    session.outputCallbacks.add(cb);
    return () => {
      session.outputCallbacks.delete(cb);
    };
  }

  /** 终止并移除会话。dispose 后该会话 onData 不再触发。 */
  dispose(id: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    this.sessions.delete(id);
    session.outputCallbacks.clear();
    session.handle.kill();
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.dispose(id);
    }
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown terminal session: ${id}`);
    }
    return session;
  }
}
