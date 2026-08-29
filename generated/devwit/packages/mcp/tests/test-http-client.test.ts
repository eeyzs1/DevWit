import { describe, expect, it } from "vitest";
import type { HttpFetchLike } from "../src/http-client.js";
import { McpHttpClient } from "../src/http-client.js";
import type { ToolDefinition, ToolResult } from "@devwit/contracts";

type RouteResp = { status?: number; contentType?: string; body?: unknown; raw?: string; sse?: string };
type Route = RouteResp | ((req: { id: number; method: string; proto?: string; mcpMethod?: string }) => RouteResp);

/** 构造一个 mock fetch：按请求 body 的 method 路由到 routes，记录每次请求。 */
function makeFetch(routes: Record<string, Route>, auth?: Record<string, string>) {
  const calls: Array<{ method: string; mcpMethod?: string; mcpName?: string; proto?: string; auth?: string; headers: Record<string, string> }> = [];
  const fetchImpl: HttpFetchLike = async (_url, init) => {
    const req = JSON.parse(init?.body ?? "{}") as { method?: string; id?: number };
    const headers = init?.headers ?? {};
    calls.push({
      method: req.method ?? "",
      mcpMethod: headers["Mcp-Method"],
      mcpName: headers["Mcp-Name"],
      proto: headers["MCP-Protocol-Version"],
      auth: headers["Authorization"],
      headers,
    });
    const route = routes[req.method ?? ""] ?? (() => ({ status: 404, body: null }));
    const r = typeof route === "function" ? route({ id: req.id ?? 0, method: req.method ?? "", proto: headers["MCP-Protocol-Version"], mcpMethod: headers["Mcp-Method"] }) : route;
    const bodyText = r.sse !== undefined ? r.sse : (r.raw !== undefined ? r.raw : (r.body !== undefined ? JSON.stringify(r.body) : ""));
    const status = r.status ?? 200;
    const contentType = r.sse !== undefined ? "text/event-stream" : (r.contentType ?? "application/json");
    const reader = () => {
      let done = false;
      const value = new TextEncoder().encode(bodyText);
      return {
        read: async () => {
          if (done) return { done: true, value: new Uint8Array() };
          done = true;
          return { done: false, value };
        },
      };
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
      text: async () => bodyText,
      body: { getReader: reader },
    };
  };
  return { fetchImpl, calls };
}

const CONFIG = { id: "remote", name: "Remote", url: "https://example.test/mcp" };

function jsonResult(result: unknown) {
  return { jsonrpc: "2.0", id: 1, result };
}

describe("McpHttpClient（远程 MCP / Streamable HTTP）", () => {
  it("start：initialize + tools/list 返回工具集，必需头齐全", async () => {
    const { fetchImpl, calls } = makeFetch({
      initialize: () => ({ body: jsonResult({ protocolVersion: "2026-07-28", serverInfo: { name: "r", version: "1" }, capabilities: { tools: {} } }) }),
      "tools/list": () => ({ body: jsonResult({ tools: [{ name: "read_file", description: "read", inputSchema: { type: "object", properties: {} } }] }) }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    const tools = await c.start();
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
    const init = calls.find((c) => c.mcpMethod === "initialize");
    expect(init?.proto).toBe("2026-07-28");
    expect(calls.find((c) => c.mcpMethod === "tools/list")?.proto).toBe("2026-07-28");
  });

  it("callTool：JSON 响应 → text 结果；工具名带 Mcp-Name 头", async () => {
    const { fetchImpl, calls } = makeFetch({
      initialize: () => ({ body: jsonResult({ protocolVersion: "2026-07-28", serverInfo: {}, capabilities: {} }) }),
      "tools/list": () => ({ body: jsonResult({ tools: [{ name: "echo", description: "", inputSchema: {} }] }) }),
      "tools/call": () => ({ body: jsonResult({ content: [{ type: "text", text: "hello remote" }], isError: false }) }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    await c.start();
    const result = await c.callTool("echo", { text: "hi" });
    expect(result).toMatchObject({ ok: true, output: "hello remote" });
    const call = calls.find((c) => c.mcpMethod === "tools/call");
    expect(call?.mcpName).toBe("echo");
  });

  it("callTool：SSE 流（progress 通知 + 最终 JSON response）", async () => {
    const { fetchImpl } = makeFetch({
      initialize: () => ({ body: jsonResult({ protocolVersion: "2026-07-28", serverInfo: {}, capabilities: {} }) }),
      "tools/list": () => ({ body: jsonResult({ tools: [{ name: "echo", description: "", inputSchema: {} }] }) }),
      "tools/call": (req) => ({ sse: `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "from sse" }] } })}\n` }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    await c.start();
    const result = await c.callTool("echo", {});
    expect(result).toMatchObject({ ok: true, output: "from sse" });
  });

  it("auth：配置 headers + resolveAuth 注入 Authorization", async () => {
    const { fetchImpl, calls } = makeFetch({
      initialize: () => ({ body: jsonResult({ protocolVersion: "2026-07-28", serverInfo: {}, capabilities: {} }) }),
      "tools/list": () => ({ body: jsonResult({ tools: [] }) }),
    });
    const c = new McpHttpClient({ ...CONFIG, headers: { "X-Custom": "v" }, auth: { credentialRef: "cred" } }, {
      fetch: fetchImpl,
      resolveAuth: async (ref) => (ref === "cred" ? "secret-token" : undefined),
    });
    await c.start();
    const init = calls.find((c) => c.mcpMethod === "initialize");
    expect(init?.auth).toBe("Bearer secret-token");
    expect(init?.headers["X-Custom"]).toBe("v");
  });

  it("错误：HTTP 非 2xx → DW_MCP_HTTP_STATUS", async () => {
    const { fetchImpl } = makeFetch({
      initialize: () => ({ status: 500, body: null }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    await expect(c.start()).rejects.toThrow(/DW_MCP_HTTP_STATUS:500/);
  });

  it("错误：畸形 JSON → DW_MCP_HTTP_BAD_JSON", async () => {
    const { fetchImpl } = makeFetch({
      initialize: () => ({ body: jsonResult({ protocolVersion: "2026-07-28", serverInfo: {}, capabilities: {} }) }),
      "tools/list": () => ({ raw: "not-json" }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    await expect(c.start()).rejects.toThrow(/DW_MCP_HTTP_BAD_JSON/);
  });

  it("错误：JSON-RPC error → DW_MCP_RPC_<code>", async () => {
    const { fetchImpl } = makeFetch({
      initialize: () => ({ body: jsonResult({}) }),
      "tools/list": () => ({ body: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown method" } } }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    await expect(c.start()).rejects.toThrow(/DW_MCP_RPC_-32601/);
  });

  it("非 text 内容块被忽略，text 块拼接", async () => {
    const { fetchImpl } = makeFetch({
      initialize: () => ({ body: jsonResult({ protocolVersion: "2026-07-28", serverInfo: {}, capabilities: {} }) }),
      "tools/list": () => ({ body: jsonResult({ tools: [{ name: "echo", description: "", inputSchema: {} }] }) }),
      "tools/call": () => ({ body: jsonResult({ content: [{ type: "image", data: "xx" }, { type: "text", text: "only-text" }] }) }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    await c.start();
    const result = await c.callTool("echo", {});
    expect(result.output).toBe("only-text");
  });

  it("工具名非 ASCII → Mcp-Name base64 哨兵", async () => {
    const { fetchImpl, calls } = makeFetch({
      initialize: () => ({ body: jsonResult({ protocolVersion: "2026-07-28", serverInfo: {}, capabilities: {} }) }),
      "tools/list": () => ({ body: jsonResult({ tools: [{ name: "中文工具", description: "", inputSchema: {} }] }) }),
      "tools/call": () => ({ body: jsonResult({ content: [{ type: "text", text: "ok" }] }) }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    await c.start();
    await c.callTool("中文工具", {});
    expect(calls.find((c) => c.mcpMethod === "tools/call")?.mcpName).toMatch(/^=\?base64\?/);
  });

  it("协议版本协商：2026-07-28 被拒 → 降级 2025-06-18；旧版不发 Mcp-Method 头", async () => {
    const { fetchImpl, calls } = makeFetch({
      initialize: (req) => {
        if (req.proto === "2026-07-28") return { status: 400, body: { jsonrpc: "2.0", id: req.id, error: { code: -32020, message: "legacy handshake" } } };
        return { body: jsonResult({ protocolVersion: req.proto ?? "2025-06-18", serverInfo: { name: "ctx", version: "1" }, capabilities: {} }) };
      },
      "tools/list": () => ({ body: jsonResult({ tools: [{ name: "resolve", description: "", inputSchema: {} }] }) }),
    });
    const c = new McpHttpClient(CONFIG, { fetch: fetchImpl });
    const tools = await c.start();
    expect(tools.map((t) => t.name)).toEqual(["resolve"]);
    // 先试过 2026-07-28（带 Mcp-Method 头），被拒后降级到 2025-06-18
    const initCalls = calls.filter((c) => c.method === "initialize");
    expect(initCalls.some((c) => c.proto === "2026-07-28")).toBe(true);
    expect(initCalls.some((c) => c.proto === "2025-06-18")).toBe(true);
    // 2025-06-18（旧版）那次不发送 Mcp-Method 头
    const legacy = calls.find((c) => c.proto === "2025-06-18");
    expect(legacy?.mcpMethod).toBeUndefined();
  });
});
