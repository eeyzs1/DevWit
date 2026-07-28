/**
 * DAP 客户端（迭代 33 / AC42）：Content-Length 分帧的 Debug Adapter Protocol。
 *
 * 与 LSP 分帧格式一致（HTTP 风格头 + 字节定长正文），但消息形状不同：
 *   请求   {seq, type:"request",  command, arguments?}
 *   响应   {seq, type:"response", request_seq, success, command, message?, body?}
 *   事件   {seq, type:"event",    event, body?}
 * 适配器可发反向请求：onReverseRequest 处理器应答（js-debug 独立服务器的
 * startDebugging 必须应答成功并开伴随连接，见 js-debug-session.ts）；
 * 未设置处理器的反向请求一律拒答 error，绝不挂起——不响应会让适配器死等。
 *
 * 传输可注入：默认 stdio（单测假进程驱动全部协议路径）；
 * 真实 js-debug 适配器只讲 TCP（dapDebugServer.js 起监听端口），
 * 由 tcp-transport.ts 工厂在 spawn 后建 socket 通道（与 VS Code 同口径）。
 *
 * 生命周期：initialize 握手 → launch/attach → configurationDone → 调试 →
 * disconnect 请求 → 进程退出。进程退出即拒绝全部挂起请求
 * （DW_DAP_* ASCII 错误码，主进程 stderr 禁中文）。
 *
 * electron-free：spawn/传输工厂均可注入。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** 可注入的子进程形状（与 node spawn 返回的最小兼容面）。 */
export interface DapChildProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null) => void): void;
  removeListener(event: "exit", listener: (code: number | null) => void): void;
}

export type DapSpawnFactory = (command: string, args: string[], env: NodeJS.ProcessEnv) => DapChildProcess;

/** 生产 spawn：stdio 三管道，env 合并（ELECTRON_RUN_AS_NODE 由调用方注入）。 */
export const nodeSpawnFactory: DapSpawnFactory = (command, args, env) =>
  spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

/**
 * 被调试进程形状（JsDebugSession 直接持有的用户程序子进程）。
 * 与 DapChildProcess 的差异：需要 close 事件（进程退出 + stdio 冲刷完成的信号），
 * 不需要 stdin 写入。
 */
export interface DebuggeeProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
}

/** 被调试进程 spawn 工厂（比 DapSpawnFactory 多 cwd——用户程序工作目录取入口文件所在目录）。 */
export type DebuggeeSpawnFactory = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string
) => DebuggeeProcess;

/** 生产被调试进程 spawn：三管道 + 指定 cwd。 */
export const nodeDebuggeeSpawnFactory: DebuggeeSpawnFactory = (command, args, env, cwd) =>
  spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

/** DAP 写通道（stdio=proc.stdin，TCP=socket）。 */
export interface DapTransport {
  /** 写出一帧（header+body 已拼好，utf-8）。 */
  write(frame: string): void;
  /** 关闭底层通道（socket.destroy；stdio 为 noop）。幂等。 */
  close(): void;
}

/** 传输绑定：写通道 + 读数据源（帧由此流入）。 */
export interface DapTransportBinding {
  transport: DapTransport;
  data: NodeJS.ReadableStream;
  /** TCP 模式下已解析的服务器地址（伴随会话二次连接用）。 */
  address?: { host: string; port: number };
}

/**
 * 传输工厂：spawn 成功后建立 DAP I/O 通道。
 * onDead 用于通道侧先死（socket 断开而进程未退）时通知客户端走退出路径。
 */
export type DapTransportFactory = (
  proc: DapChildProcess,
  onDead: (reason: string) => void
) => Promise<DapTransportBinding>;

/** 默认 stdio 传输：proc.stdout 读、proc.stdin 写（LSP 同构）。 */
export const stdioTransportFactory: DapTransportFactory = (proc) =>
  Promise.resolve({
    transport: {
      write: (frame) => {
        proc.stdin.write(frame, "utf-8");
      },
      close: () => {},
    },
    data: proc.stdout,
  });

interface DapMessage {
  seq: number;
  type: "request" | "response" | "event" | string;
  command?: string;
  arguments?: unknown;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
  event?: string;
}

interface PendingRequest {
  command: string;
  resolve: (body: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL_CHARS = 2000;

export class DapClient {
  private proc: DapChildProcess | null = null;
  private transport: DapTransport | null = null;
  private binding: DapTransportBinding | null = null;
  private nextSeq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
  private stderrTail = "";
  private initialized = false;
  /** 最近一次死因（handleExit reason），spawn 竞态路径诊断用。 */
  private deadReason: string | null = null;
  /** 适配器事件回调（stopped/continued/terminated/exited/output/breakpoint/initialized 等）。 */
  onEvent: ((event: string, body: unknown) => void) | null = null;
  /** 进程退出回调（manager 据此转 terminated 态）。code 为 null 表示信号终止。 */
  onExit: ((code: number | null) => void) | null = null;
  /**
   * 反向请求处理器（js-debug 根会话的 startDebugging 必须应答成功并开伴随连接）。
   * 返回 body → success 应答；抛错/未设置 → 拒答 error（不挂起适配器）。
   */
  onReverseRequest: ((command: string, args: unknown) => Promise<unknown>) | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly spawnImpl: DapSpawnFactory = nodeSpawnFactory,
    private readonly requestTimeoutMs = 30_000,
    private readonly transportFactory: DapTransportFactory = stdioTransportFactory
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

  /** TCP 传输已解析的服务器地址（伴随会话二次连接用；stdio 为 null）。 */
  get transportAddress(): { host: string; port: number } | null {
    return this.binding?.address ?? null;
  }

  /** 启动进程并完成 initialize 握手；失败时进程已清理，抛 ASCII 错误码。 */
  async start(): Promise<unknown> {
    if (this.proc !== null) throw new Error("DW_DAP_ALREADY_STARTED");
    let proc: DapChildProcess;
    try {
      proc = this.spawnImpl(this.command, this.args, this.env);
    } catch (error) {
      throw new Error(`DW_DAP_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`);
    }
    this.proc = proc;
    proc.on("error", (error) => {
      // spawn 异步失败（ENOENT 等）：走退出路径，拒绝全部挂起
      this.handleExit(null, `DW_DAP_SPAWN_FAILED:${error.message}`);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_CHARS);
    });
    proc.on("exit", (code) => {
      // exit 与 stderr data 同 tick 竞争（libuv 回调序）：给 100ms 窗口让 tail 收全再定死因，
      // 否则适配器崩溃的真实原因（Cannot find module 等）永远丢失；
      // close() 主动 kill 路径下 handleExit 会因 proc 已置空而提前返回，无副作用
      const reason = `DW_DAP_ADAPTER_EXIT:${code ?? "signal"}`;
      setTimeout(() => this.handleExit(code, reason), 100);
    });

    // 建立 I/O 通道（stdio 即得；TCP 需等监听行再连 socket）
    try {
      const binding = await this.transportFactory(proc, (reason) => this.handleExit(null, reason));
      if (this.proc === null) {
        // 等待通道期间进程已死（spawn 异步失败竞态）：通道白建，关闭并抛真实死因
        binding.transport.close();
        throw new Error(this.deadReason ?? "DW_DAP_TRANSPORT_DEAD");
      }
      this.binding = binding;
      this.transport = binding.transport;
      binding.data.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    } catch (error) {
      // 通道建立失败：抑制退出回调后强杀，进程不残留
      this.proc = null;
      try {
        proc.kill();
      } catch {
        // 已退出：noop
      }
      throw error instanceof Error ? error : new Error(String(error));
    }

    try {
      const capabilities = await this.request("initialize", {
        clientID: "devwit",
        clientName: "DevWit",
        adapterID: "pwa-node",
        locale: "en",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
        supportsVariableType: false,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: false,
        supportsProgressReporting: false,
        supportsInvalidatedEvent: false,
        supportsMemoryReferences: false,
      });
      this.initialized = true;
      return capabilities;
    } catch (error) {
      await this.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 发送请求（未运行时拒绝 DW_DAP_NOT_RUNNING，超时拒绝 DW_DAP_TIMEOUT）。resolve 值 = 响应 body。 */
  request(command: string, args?: unknown): Promise<unknown> {
    const proc = this.proc;
    if (proc === null) return Promise.reject(new Error("DW_DAP_NOT_RUNNING"));
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const message = { seq, type: "request", command, ...(args !== undefined ? { arguments: args } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DW_DAP_TIMEOUT:${command}`));
      }, this.requestTimeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
      this.writeMessage(message);
    });
  }

  /**
   * 优雅关闭：disconnect 请求（terminateDebuggee，限时 1s）→ 强杀 → 等退出（3s 上限）→ 关通道。
   * TCP 服务器模式 disconnect 后进程不自退，强杀是主路径而非兜底。幂等。
   */
  async close(): Promise<void> {
    const proc = this.proc;
    if (proc === null) return;
    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
    });
    if (this.initialized) {
      // disconnect 限时 1s：适配器半死时不得拖延强杀
      await Promise.race([
        this.request("disconnect", { terminateDebuggee: true }).catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    this.initialized = false;
    this.rejectAllPending("DW_DAP_CLIENT_CLOSED");
    // js-debug 是 TCP 服务器：disconnect 后进程不自退，必须强杀；
    // stdio 适配器多半自退，kill 为 noop 兜底
    try {
      proc.kill();
    } catch {
      // 已退出：noop
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
    this.proc = null; // 先置空：抑制 transport.close 触发的 onDead 重复回调
    this.transport?.close();
    this.transport = null;
  }

  // --------------------------------------------------------------------------
  // Content-Length 分帧（Buffer 层，字节定长；与 LSP 同格式）
  // --------------------------------------------------------------------------

  private writeMessage(message: Record<string, unknown>): void {
    const transport = this.transport;
    if (transport === null) return;
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    transport.write(header + body);
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
      let message: DapMessage;
      try {
        message = JSON.parse(body) as DapMessage;
      } catch {
        continue; // 非法 JSON 跳过，不中断会话
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: DapMessage): void {
    if (message.type === "response" && typeof message.request_seq === "number") {
      const entry = this.pending.get(message.request_seq);
      if (entry === undefined) return; // 超时后迟到的响应，丢弃
      this.pending.delete(message.request_seq);
      clearTimeout(entry.timer);
      if (message.success === false) {
        const detail = typeof message.message === "string" ? message.message.slice(0, 200) : "";
        entry.reject(new Error(`DW_DAP_REQUEST_FAILED:${entry.command}:${detail}`));
      } else {
        entry.resolve(message.body);
      }
      return;
    }
    if (message.type === "event" && typeof message.event === "string") {
      this.onEvent?.(message.event, message.body);
      return;
    }
    if (message.type === "request" && typeof message.command === "string") {
      // 适配器反向请求：有处理器则应答其结果（js-debug startDebugging 必须成功），
      // 否则一律拒答 error——反向请求不响应会让适配器死等
      void this.answerReverseRequest(message);
    }
  }

  private async answerReverseRequest(message: DapMessage): Promise<void> {
    const command = message.command ?? "";
    let success = false;
    let body: unknown;
    let errorMessage = "DW_DAP_REVERSE_REQUEST_UNSUPPORTED";
    if (this.onReverseRequest !== null) {
      try {
        body = await this.onReverseRequest(command, message.arguments);
        success = true;
      } catch (error) {
        errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      }
    }
    this.writeMessage({
      seq: this.nextSeq++,
      type: "response",
      request_seq: message.seq,
      success,
      command,
      ...(success ? (body !== undefined ? { body } : {}) : { message: errorMessage }),
    });
  }

  private handleExit(code: number | null, reason: string): void {
    if (this.proc === null && this.pending.size === 0) return;
    this.proc = null;
    this.initialized = false;
    // 死因拼适配器 stderr 尾部（非 ASCII 剥离——IPC 错误串与主进程 stderr 禁中文）
    const tail = this.stderrTail
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(-300);
    this.deadReason = tail === "" ? reason : `${reason}:${tail}`;
    this.transport?.close();
    this.transport = null;
    this.rejectAllPending(this.deadReason);
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
