/**
 * LSP stdio 客户端（迭代 31 / AC40）：Content-Length 分帧的 JSON-RPC 2.0。
 *
 * 与 MCP 客户端（换行分隔）不同，LSP 基础协议为 HTTP 风格头 + 字节定长正文：
 *   Content-Length: <字节数>\r\n\r\n<UTF-8 JSON>
 * Content-Length 是字节数而非字符数，因此分帧必须在 Buffer 层完成
 * （多字节 UTF-8 字符可能跨 chunk 截断，字符串层拼接会损坏载荷）。
 *
 * 生命周期：initialize 握手 → notifications/initialized → 正常工作 →
 * shutdown 请求 → exit 通知 → 进程退出。进程退出即拒绝全部挂起请求
 * （DW_LSP_* ASCII 错误码，主进程 stderr 禁中文）。
 *
 * electron-free：spawn 工厂可注入，单测用假进程驱动全部协议路径。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** 可注入的子进程形状（与 node spawn 返回的最小兼容面）。 */
export interface LspChildProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
}

export type LspSpawnFactory = (command: string, args: string[], env: NodeJS.ProcessEnv) => LspChildProcess;

/** 生产 spawn：stdio 三管道，env 合并（ELECTRON_RUN_AS_NODE 由调用方注入）。 */
export const nodeSpawnFactory: LspSpawnFactory = (command, args, env) =>
  spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

interface JsonRpcResponseMessage {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL_CHARS = 2000;

export class LspClient {
  private proc: LspChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
  private stderrTail = "";
  private initialized = false;
  /** 服务器通知回调（textDocument/publishDiagnostics 等）。 */
  onNotification: ((method: string, params: unknown) => void) | null = null;
  /** 进程退出回调（manager 据此转 error 态）。code 为 null 表示信号终止。 */
  onExit: ((code: number | null) => void) | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly spawnImpl: LspSpawnFactory = nodeSpawnFactory,
    private readonly requestTimeoutMs = 30_000
  ) {}

  get isRunning(): boolean {
    return this.proc !== null;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** 最近 stderr 尾部（错误诊断用，ASCII 截断）。 */
  get stderrText(): string {
    return this.stderrTail;
  }

  /** 启动进程并完成 initialize 握手；失败时进程已清理，抛 ASCII 错误码。 */
  async start(rootUri: string): Promise<void> {
    if (this.proc !== null) throw new Error("DW_LSP_ALREADY_STARTED");
    let proc: LspChildProcess;
    try {
      proc = this.spawnImpl(this.command, this.args, this.env);
    } catch (error) {
      throw new Error(`DW_LSP_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`);
    }
    this.proc = proc;
    proc.on("error", (error) => {
      // spawn 异步失败（ENOENT 等）：走退出路径，拒绝全部挂起
      this.handleExit(null, `DW_LSP_SPAWN_FAILED:${error.message}`);
    });
    proc.stdout.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_CHARS);
    });
    proc.on("exit", (code) => {
      this.handleExit(code, `DW_LSP_SERVER_EXIT:${code ?? "signal"}`);
    });

    try {
      await this.request("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: false },
          },
        },
        clientInfo: { name: "devwit", version: "0.3.0" },
      });
      this.notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      await this.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 发送请求（未运行时拒绝 DW_LSP_NOT_RUNNING，超时拒绝 DW_LSP_TIMEOUT）。 */
  request(method: string, params?: unknown): Promise<unknown> {
    const proc = this.proc;
    if (proc === null) return Promise.reject(new Error("DW_LSP_NOT_RUNNING"));
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DW_LSP_TIMEOUT:${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.writeMessage(message);
    });
  }

  /** 发送通知（无响应语义；未运行时静默丢弃）。 */
  notify(method: string, params?: unknown): void {
    if (this.proc === null) return;
    this.writeMessage({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  /**
   * 优雅关闭：shutdown 请求 → exit 通知 → 等进程退出；
   * 任何一步异常或超时（3s）强杀兜底。幂等。
   */
  async close(): Promise<void> {
    const proc = this.proc;
    if (proc === null) return;
    try {
      if (this.initialized) {
        await this.request("shutdown");
      }
    } catch {
      // shutdown 失败不阻断关闭（服务器可能已半死）
    }
    this.initialized = false;
    this.notify("exit");
    this.rejectAllPending("DW_LSP_CLIENT_CLOSED");
    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 3000);
    });
    await Promise.race([exited, timeout]);
    if (this.proc !== null) {
      proc.kill();
    }
    this.proc = null;
  }

  // --------------------------------------------------------------------------
  // Content-Length 分帧（Buffer 层，字节定长）
  // --------------------------------------------------------------------------

  private writeMessage(message: Record<string, unknown>): void {
    const proc = this.proc;
    if (proc === null) return;
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    proc.stdin.write(header + body, "utf-8");
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return; // 头未收全（半包），等下一 chunk
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null) {
        // 协议外输出（不应发生）：丢弃该头，防死循环
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1] ?? "0", 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return; // 正文未收全（半包）
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: JsonRpcResponseMessage;
      try {
        message = JSON.parse(body) as JsonRpcResponseMessage;
      } catch {
        continue; // 非法 JSON 跳过，不中断会话
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcResponseMessage): void {
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return; // 超时后迟到的响应，丢弃
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        entry.reject(new Error(`DW_LSP_RPC_${message.error.code}:${message.error.message.slice(0, 200)}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      // 服务器通知（publishDiagnostics 等）；服务器→客户端请求暂不支持，直接忽略
      this.onNotification?.(message.method, message.params);
    }
  }

  private handleExit(code: number | null, reason: string): void {
    if (this.proc === null && this.pending.size === 0) return;
    this.proc = null;
    this.initialized = false;
    this.rejectAllPending(reason);
    this.onExit?.(code);
  }

  private rejectAllPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
