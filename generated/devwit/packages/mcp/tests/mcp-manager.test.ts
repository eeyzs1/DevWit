/**
 * McpManager 测试（AC17）：真实 spawn 夹具服务器的生命周期差量同步、
 * 工具聚合（全名前缀）、调用路由、停用/重启/删除与崩溃转 error 态。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "@devwit/contracts";
import { McpManager, mcpToolFullName, parseMcpToolFullName, validateMcpServerConfig } from "../src/manager.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server.mjs");

function makeConfig(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    name: `Server ${id}`,
    command: process.execPath,
    args: [FIXTURE],
    enabled: true,
    ...overrides,
  };
}

function makeHttpConfig(id: string, url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, name: `Server ${id}`, transport: "http", url, enabled: true, ...overrides };
}

/** 轮询等待 manager 状态满足条件（异步 start 完成）。 */
async function waitFor(manager: McpManager, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitFor 超时");
}

/** 起一个本地 Streamable HTTP MCP 服务器夹具（POST /mcp 单端点）。 */
async function startHttpServer(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }]) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST only" } }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number | string; method?: string };
      const send = (obj: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      switch (msg.method) {
        case "initialize":
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2026-07-28", serverInfo: { name: "test", version: "1" }, capabilities: { tools: {} } } });
          return;
        case "tools/list":
          send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
          return;
        case "tools/call": {
          const reqMsg = JSON.parse(body) as { params?: { arguments?: Record<string, unknown> } };
          const text = `from-http:${String(reqMsg.params?.arguments?.text ?? "")}`;
          send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: false } });
          return;
        }
        default:
          send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("McpManager（AC17）", () => {
  it("syncConfigs 启动启用服务器：connecting → ready，工具全名前缀聚合", async () => {
    const manager = new McpManager();
    const states: string[] = [];
    manager.onDidChange(() => {
      states.push(manager.listViews().map((view) => view.state).join(","));
    });
    manager.syncConfigs([makeConfig("s1")]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
    const definitions = manager.toolDefinitions();
    const names = definitions.map((def) => def.name).sort();
    expect(names).toEqual(["mcp__s1__echo", "mcp__s1__hang", "mcp__s1__write_marker"]);
    expect(definitions[0]?.description).toContain("[MCP:Server s1]");
    const view = manager.listViews()[0];
    expect(view?.tools.map((tool) => tool.fullName).sort()).toEqual(names);
    expect(states).toContain("connecting");
    await manager.dispose();
  });

  it("callTool 按全名路由到目标服务器（参数透传 + 结果回传）", async () => {
    const manager = new McpManager();
    manager.syncConfigs([makeConfig("s1"), makeConfig("s2")]);
    await waitFor(manager, () => manager.listViews().every((view) => view.state === "ready"));
    const result = await manager.callTool({ id: "c1", name: "mcp__s2__echo", args: { text: "route-proof" } });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("route-proof");
    await manager.dispose();
  });

  it("callTool 异常路径：非法全名 / 未知服务器 / 未知工具", async () => {
    const manager = new McpManager();
    manager.syncConfigs([makeConfig("s1")]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
    expect((await manager.callTool({ id: "c", name: "read", args: {} })).error).toContain("DW_MCP_BAD_NAME");
    expect((await manager.callTool({ id: "c", name: "mcp__ghost__echo", args: {} })).error).toContain("DW_MCP_UNKNOWN_SERVER");
    expect((await manager.callTool({ id: "c", name: "mcp__s1__nope", args: {} })).error).toContain("DW_MCP_UNKNOWN_TOOL");
    await manager.dispose();
  });

  it("停用 → 工具下线且调用报 DW_MCP_NOT_READY；重新启用 → 恢复 ready", async () => {
    const manager = new McpManager();
    manager.syncConfigs([makeConfig("s1")]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
    manager.syncConfigs([makeConfig("s1", { enabled: false })]);
    expect(manager.listViews()[0]?.state).toBe("disabled");
    expect(manager.toolDefinitions()).toEqual([]);
    const result = await manager.callTool({ id: "c", name: "mcp__s1__echo", args: {} });
    expect(result.error).toContain("DW_MCP_NOT_READY");
    manager.syncConfigs([makeConfig("s1")]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
    expect(manager.toolDefinitions()).toHaveLength(3);
    await manager.dispose();
  });

  it("command 指纹变更触发重启；仅改名不重启（进程保持）", async () => {
    const manager = new McpManager();
    manager.syncConfigs([makeConfig("s1")]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
    // 改名：不重启，状态立即保持 ready
    manager.syncConfigs([makeConfig("s1", { name: "Renamed" })]);
    expect(manager.listViews()[0]?.state).toBe("ready");
    expect(manager.listViews()[0]?.config.name).toBe("Renamed");
    // args 变更：重启（先 connecting 后 ready）
    manager.syncConfigs([makeConfig("s1", { args: [FIXTURE, "--extra"] })]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
    expect(manager.toolDefinitions()).toHaveLength(3);
    await manager.dispose();
  });

  it("删除配置 → 视图移除且工具下线", async () => {
    const manager = new McpManager();
    manager.syncConfigs([makeConfig("s1")]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
    manager.syncConfigs([]);
    expect(manager.listViews()).toEqual([]);
    expect(manager.toolDefinitions()).toEqual([]);
    await manager.dispose();
  });

  it("服务器启动失败（命令不存在）→ error 态且带 ASCII 错误码", async () => {
    const manager = new McpManager();
    manager.syncConfigs([makeConfig("bad", { command: "definitely-not-a-real-command-xyz" })]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "error");
    const view = manager.listViews()[0];
    expect(view?.errorCode).toMatch(/DW_MCP_(SPAWN_FAILED|SERVER_EXIT)/);
    expect(manager.toolDefinitions()).toEqual([]);
    await manager.dispose();
  });

  it("服务器进程崩溃 → 自动转 error 态，工具即刻下线", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-mcp-mgr-"));
    // 夹具 MARKER_FILE 指向不存在目录：write_marker 会 isError，但进程仍存活；
    // 真正的崩溃用「启动后立即退出」的脚本模拟。
    const crashScript = path.join(dir, "crash-server.mjs");
    fs.writeFileSync(crashScript, 'process.stdout.write("bye\\n"); setTimeout(() => process.exit(1), 300);\n', "utf-8");
    const manager = new McpManager();
    manager.syncConfigs([makeConfig("crash", { args: [crashScript] })]);
    await waitFor(manager, () => manager.listViews()[0]?.state === "error");
    expect(manager.listViews()[0]?.errorCode).toContain("DW_MCP_SERVER_EXIT");
    fs.rmSync(dir, { recursive: true, force: true });
    await manager.dispose();
  });

  it("validateMcpServerConfig 校验（ASCII 错误）", () => {
    expect(() => validateMcpServerConfig(makeConfig("bad id!"))).toThrow("mcp server id must match");
    expect(() => validateMcpServerConfig(makeConfig("ok", { name: " " }))).toThrow("name must not be empty");
    expect(() => validateMcpServerConfig(makeConfig("ok", { command: "" }))).toThrow("command must not be empty");
    expect(() => validateMcpServerConfig(makeConfig("ok", { args: ["a", 1] as unknown as string[] }))).toThrow("args must be an array");
    expect(() => validateMcpServerConfig(makeConfig("ok", { env: { K: 1 } as unknown as Record<string, string> }))).toThrow("env.K must be a string");
    expect(() => validateMcpServerConfig(makeConfig("ok"))).not.toThrow();
  });

  it("全名拼装/解析（含工具名内嵌 __）", () => {
    expect(mcpToolFullName("s1", "echo")).toBe("mcp__s1__echo");
    expect(parseMcpToolFullName("mcp__s1__echo")).toEqual({ serverId: "s1", toolName: "echo" });
    expect(parseMcpToolFullName("mcp__s1__a__b")).toEqual({ serverId: "s1", toolName: "a__b" });
    expect(parseMcpToolFullName("read")).toBeNull();
    expect(parseMcpToolFullName("mcp____x")).toBeNull();
  });

  it("http transport 分派：connect → ready，工具聚合，callTool 走远程", async () => {
    const { url, close } = await startHttpServer();
    try {
      const manager = new McpManager();
      manager.syncConfigs([makeHttpConfig("remote", url)]);
      await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
      expect(manager.listViews()[0]?.config.transport).toBe("http");
      expect(manager.toolDefinitions().map((t) => t.name)).toEqual(["mcp__remote__echo"]);
      const result = await manager.callTool({ id: "c", name: "mcp__remote__echo", args: { text: "x" } });
      expect(result).toMatchObject({ ok: true, output: "from-http:x" });
      await manager.dispose();
    } finally {
      await close();
    }
  });

  it("http url 指纹变更触发重启（新 url 暴露新工具）", async () => {
    const a = await startHttpServer([{ name: "tool_a", description: "a", inputSchema: {} }]);
    const b = await startHttpServer([{ name: "tool_b", description: "b", inputSchema: {} }]);
    try {
      const manager = new McpManager();
      manager.syncConfigs([makeHttpConfig("remote", a.url)]);
      await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
      expect(manager.toolDefinitions().map((t) => t.name)).toEqual(["mcp__remote__tool_a"]);
      manager.syncConfigs([makeHttpConfig("remote", b.url)]);
      await waitFor(manager, () => manager.listViews()[0]?.state === "ready");
      expect(manager.toolDefinitions().map((t) => t.name)).toEqual(["mcp__remote__tool_b"]);
      await manager.dispose();
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("http 服务器错误（500）→ error 态且带 DW_MCP_HTTP_STATUS 错误码", async () => {
    // 起一个对任何请求都返回 500 的端点
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const manager = new McpManager();
      manager.syncConfigs([makeHttpConfig("remote", `http://127.0.0.1:${port}/mcp`)]);
      await waitFor(manager, () => manager.listViews()[0]?.state === "error");
      expect(manager.listViews()[0]?.errorCode).toContain("DW_MCP_HTTP_STATUS:500");
      expect(manager.toolDefinitions()).toEqual([]);
      await manager.dispose();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
