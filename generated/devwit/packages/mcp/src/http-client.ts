/**
 * Streamable HTTP 客户端（远程 MCP，revision 2026-07-28）。
 *
 * 单 MCP 端点接收 POST；客户端每条 JSON-RPC 一个 POST，Accept 同时支持
 * application/json 与 text/event-stream；响应可为单个 JSON 或请求级 SSE 流
 * （通知 + 最终 response 终结流，关流即取消）。必需头：
 *   MCP-Protocol-Version / Mcp-Method / Mcp-Name（非安全字符 base64 哨兵）
 * 可选 Mcp-Param-{Name}（来自工具 inputSchema 的 x-mcp-header）。
 * 无会话 ID / 无 GET 流 / 无 Last-Event-ID（本期；旧版协商见 start()）。
 *
 * 仅暴露 tools（本期范围）。错误全为 ASCII 错误码（DW_MCP_HTTP_*）。
 */
import type { McpServerConfig, ToolDefinition, ToolResult } from "@devwit/contracts";
import type { McpTransport } from "./transport.js";

export const HTTP_PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "devwit", version: "0.1.0" } as const;

/** fetch 的最小结构依赖（Node 20 主进程全局 fetch）。 */
export interface HttpFetchLike {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    body: { getReader(): { read(): Promise<{ done: boolean; value: Uint8Array }> } } | null;
  }>;
}

/** 允许的响应内容类型。 */
function isSse(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}
function isJson(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/json");
}

/** 头值安全编码：可见 ASCII 直接用，否则 base64 哨兵（Mcp-Name / Mcp-Param-*）。 */
function encodeHeaderValue(value: string): string {
  const ascii = /^[\x20-\x7e]+$/.test(value);
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return ascii && !value.startsWith("=?base64?") ? value : `=?base64?${b64}?=`;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 从 SSE 文本中提取 JSON-RPC 响应（多行 data: 可能分帧；取匹配 id 的最终 response）。 */
function parseSseForResponse(text: string, id: number | string): { response: JsonRpcResponse | null; notifications: unknown[] } {
  const notifications: unknown[] = [];
  let response: JsonRpcResponse | null = null;
  const events = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  for (const ev of events) {
    const payload = ev.slice(5).trim();
    if (!payload) continue;
    let msg: JsonRpcResponse;
    try { msg = JSON.parse(payload) as JsonRpcResponse; } catch { continue; }
    if (msg.id !== undefined && (msg.id === id || msg.id === undefined)) {
      if (msg.id === id || (msg.id === undefined && response === null)) response = msg;
    } else {
      notifications.push(msg);
    }
  }
  return { response, notifications };
}

export class McpHttpClient implements McpTransport {
  onExit: ((code?: number | null) => void) | null = null;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: HttpFetchLike;
  private readonly resolveAuth?: (credentialRef: string) => Promise<string | undefined>;
  private readonly serverId: string;
  private readonly authRef?: string;
  private started = false;
  private closed = false;
  private version = HTTP_PROTOCOL_VERSION;
  private nextId = 1;
  private activeAbort: AbortController | null = null;
  private requestTimeoutMs: number;

  constructor(
    config: Pick<McpServerConfig, "id" | "name" | "url" | "headers" | "auth">,
    opts?: {
      fetch?: HttpFetchLike;
      resolveAuth?: (credentialRef: string) => Promise<string | undefined>;
      requestTimeoutMs?: number;
    }
  ) {
    if (!config.url) throw new Error("DW_MCP_HTTP_NO_URL");
    this.endpoint = config.url;
    this.headers = { ...(config.headers ?? {}) };
    this.fetchImpl = opts?.fetch ?? (globalThis.fetch as unknown as HttpFetchLike);
    this.resolveAuth = opts?.resolveAuth;
    this.serverId = config.id;
    this.authRef = config.auth?.credentialRef;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 30_000;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.headers)) out[k] = v;
    if (this.resolveAuth && this.authRef) {
      const token = await this.resolveAuth(this.authRef);
      if (token) out["Authorization"] = `Bearer ${token}`;
    }
    return out;
  }

  async start(): Promise<ToolDefinition[]> {
    // 协议版本协商：先试现代 2026-07-28；旧版（2025-03-26..2025-11-25 带 Mcp-Session-Id）
    // 与 2024-11-05 SSE 的完整协商本期只在响应被拒时提示（见 README 未来项）。
    const initResult = await this.postJsonRpc("initialize", {
      protocolVersion: this.version,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    // 服务器可能协商到更低版本：若 result.protocolVersion 存在则采用之
    const initR = initResult as { protocolVersion?: string; serverInfo?: unknown } | undefined;
    if (initR?.protocolVersion && initR.protocolVersion !== this.version) {
      this.version = initR.protocolVersion;
    }
    const listResult = (await this.postJsonRpc("tools/list", {})) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | undefined;
    const rawTools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    this.started = true;
    // 返回服务器侧原始工具名；mcp__<serverId>__ 前缀由 McpManager 统一拼装。
    return rawTools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.started) return { ok: false, output: "", error: "DW_MCP_NOT_READY" };
    const params: Record<string, unknown> = { name, arguments: args };
    try {
      const raw = (await this.postJsonRpc("tools/call", params, { mcpName: name })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const text = (raw?.content ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      if (raw?.isError === true) return { ok: false, output: text, error: text === "" ? "DW_MCP_TOOL_ERROR" : text };
      return { ok: true, output: text };
    } catch (error) {
      return { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.started = false;
    this.activeAbort?.abort();
    this.activeAbort = null;
  }

  // --------------------------------------------------------------------------
  // JSON-RPC over HTTP（单 JSON 或 SSE 响应）
  // --------------------------------------------------------------------------

  private async postJsonRpc(
    method: string,
    params: Record<string, unknown>,
    opts?: { mcpName?: string }
  ): Promise<unknown> {
    if (this.closed) throw new Error("DW_MCP_CLIENT_CLOSED");
    const id = this.nextId;
    this.nextId += 1;
    const body = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": this.version } },
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.version,
      "Mcp-Method": method,
      ...(await this.authHeaders()),
    };
    if (opts?.mcpName !== undefined) headers["Mcp-Name"] = encodeHeaderValue(opts.mcpName);

    const controller = new AbortController();
    this.activeAbort = controller;
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res: Awaited<ReturnType<HttpFetchLike>>;
    try {
      res = await this.fetchImpl(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (this.closed || controller.signal.aborted) throw new Error("DW_MCP_HTTP_TIMEOUT:" + method);
      throw new Error(`DW_MCP_HTTP_UNREACHABLE:${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeAbort = null;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      clearTimeout(timer);
      throw new Error(`DW_MCP_HTTP_STATUS:${res.status}`);
    }
    let msg: JsonRpcResponse | null = null;
    if (isSse(contentType)) {
      const text = await this.readAllSse(res);
      clearTimeout(timer);
      const parsed = parseSseForResponse(text, id);
      msg = parsed.response;
      if (msg === null) throw new Error("DW_MCP_HTTP_NO_RESPONSE:" + method);
    } else {
      const text = await res.text();
      clearTimeout(timer);
      try { msg = JSON.parse(text) as JsonRpcResponse; } catch {
        throw new Error("DW_MCP_HTTP_BAD_JSON:" + method);
      }
    }
    if (msg.error !== undefined) {
      throw new Error(`DW_MCP_RPC_${msg.error.code}:${(msg.error.message || "").slice(0, 200)}`);
    }
    return msg.result;
  }

  private async readAllSse(res: Awaited<ReturnType<HttpFetchLike>>): Promise<string> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString("utf-8"));
    }
    return chunks.join("");
  }
}
