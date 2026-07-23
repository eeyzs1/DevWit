/**
 * MCP stdio 客户端（迭代 8 / AC17）：真实 spawn 子进程，经标准输入输出跑
 * 换行分隔的 JSON-RPC 2.0（MCP stdio transport）。
 *
 * 协议流程：initialize 握手 → notifications/initialized → tools/list 取工具集；
 * 此后 tools/call 调用。进程退出即拒绝全部挂起请求（DW_MCP_SERVER_EXIT）。
 * 错误消息保持 ASCII 错误码（主进程 stderr 在 GBK 终端输出中文会乱码）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig, ToolDefinition, ToolResult } from "@devwit/contracts";

/** 本客户端声明的 MCP 协议版本（2024-11-05 为各服务器广泛支持的稳定版）。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

const CLIENT_INFO = { name: "devwit", version: "0.1.0" } as const;
/** stderr 诊断保留长度（只留尾部，防打爆内存）。 */
const STDERR_TAIL_CHARS = 2000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
}

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** tools/list 返回的单个工具形状（inputSchema 为 JSON Schema）。 */
interface McpRawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** tools/call 结果形状：content 块数组 + isError 标志。 */
interface McpCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stderrTail = "";
  private started = false;
  /** 进程退出回调（manager 据此转 error 态）。code 为 null 表示信号终止。 */
  onExit: ((code: number | null) => void) | null = null;

  constructor(
    private readonly config: McpServerConfig,
    private readonly requestTimeoutMs = 30_000
  ) {}

  get serverId(): string {
    return this.config.id;
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  /** 启动进程并完成握手 + 工具列举；失败时进程已清理，抛 ASCII 错误码。 */
  async start(): Promise<ToolDefinition[]> {
    if (this.proc !== null) throw new Error("DW_MCP_ALREADY_STARTED");
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.config.command, this.config.args, {
        env: { ...process.env, ...this.config.env },
        stdio: ["pipe", "pipe", "pipe"],
        // Windows 下 .cmd/.bat（如 npx）需要 shell 才能解析；shell:false 对裸可执行更稳
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.config.command),
      });
    } catch (error) {
      throw new Error(`DW_MCP_SPAWN_FAILED:${error instanceof Error ? error.message : String(error)}`);
    }
    this.proc = proc;
    proc.on("error", (error) => {
      // spawn 异步失败（ENOENT 等）：走退出路径，拒绝全部挂起
      this.handleExit(null, `DW_MCP_SPAWN_FAILED:${error.message}`);
    });
    proc.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf-8")).slice(-STDERR_TAIL_CHARS);
    });
    proc.on("exit", (code) => {
      this.handleExit(code, `DW_MCP_SERVER_EXIT:${code ?? "signal"}`);
    });

    try {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      this.notify("notifications/initialized");
      const listResult = (await this.request("tools/list")) as { tools?: McpRawTool[] } | undefined;
      const rawTools = Array.isArray(listResult?.tools) ? listResult.tools : [];
      this.started = true;
      return rawTools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      }));
    } catch (error) {
      await this.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 调用服务器工具；结果 content 块拼接为 ToolResult（isError → ok=false）。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.started || this.proc === null) {
      return { ok: false, output: "", error: "DW_MCP_NOT_READY" };
    }
    let raw: McpCallResult;
    try {
      raw = (await this.request("tools/call", { name, arguments: args })) as McpCallResult;
    } catch (error) {
      return { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
    const text = (raw?.content ?? [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
    if (raw?.isError === true) {
      return { ok: false, output: text, error: text === "" ? "DW_MCP_TOOL_ERROR" : text };
    }
    return { ok: true, output: text };
  }

  /** 终止进程并拒绝全部挂起请求（幂等）。 */
  async close(): Promise<void> {
    const proc = this.proc;
    if (proc === null) return;
    this.proc = null;
    this.started = false;
    this.rejectAllPending("DW_MCP_CLIENT_CLOSED");
    proc.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // --------------------------------------------------------------------------
  // JSON-RPC 帧收发（换行分隔）
  // --------------------------------------------------------------------------

  private request(method: string, params?: unknown): Promise<unknown> {
    const proc = this.proc;
    if (proc === null) return Promise.reject(new Error("DW_MCP_NOT_RUNNING"));
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DW_MCP_TIMEOUT:${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify(message)}\n`, "utf-8");
    });
  }

  private notify(method: string, params?: unknown): void {
    const proc = this.proc;
    if (proc === null) return;
    const message = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    proc.stdin.write(`${JSON.stringify(message)}\n`, "utf-8");
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf-8");
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line === "") continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // 非 JSON 行（服务器打印的日志等）跳过，不中断会话
      }
      if (typeof message.id !== "number") continue; // 服务器通知/请求暂不需要处理
      const entry = this.pending.get(message.id);
      if (entry === undefined) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) {
        entry.reject(new Error(`DW_MCP_RPC_${message.error.code}:${message.error.message.slice(0, 200)}`));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  private handleExit(code: number | null, reason: string): void {
    if (this.proc === null && this.pending.size === 0) return;
    this.proc = null;
    this.started = false;
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
