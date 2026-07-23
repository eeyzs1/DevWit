/**
 * McpStdioClient 测试（AC17）：真实 spawn 夹具服务器（node 子进程，
 * 换行分隔 JSON-RPC 全真实回环，无 mock 传输层）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "@devwit/contracts";
import { McpStdioClient } from "../src/client.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server.mjs");

let clients: McpStdioClient[] = [];

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "fake",
    name: "Fake",
    command: process.execPath,
    args: [FIXTURE],
    enabled: true,
    ...overrides,
  };
}

function track(client: McpStdioClient): McpStdioClient {
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients) await client.close();
  clients = [];
});

describe("McpStdioClient（AC17）", () => {
  it("start 完成 initialize 握手并列出工具定义（容忍非 JSON 启动日志行）", async () => {
    const client = track(new McpStdioClient(makeConfig()));
    const tools = await client.start();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["echo", "hang", "write_marker"]);
    const echo = tools.find((tool) => tool.name === "echo");
    expect(echo?.description).toContain("Echo");
    expect(echo?.parameters).toMatchObject({ type: "object" });
  });

  it("callTool echo 原样回显（参数经 JSON-RPC 真实透传）", async () => {
    const client = track(new McpStdioClient(makeConfig()));
    await client.start();
    const result = await client.callTool("echo", { text: "hello-mcp-你好" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello-mcp-你好");
  });

  it("callTool write_marker 真实追加文件（子进程副作用落盘证明）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-mcp-test-"));
    const marker = path.join(dir, "marker.txt");
    const client = track(new McpStdioClient(makeConfig({ env: { MARKER_FILE: marker } })));
    await client.start();
    const result = await client.callTool("write_marker", { text: "proof-1" });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(marker, "utf-8")).toBe("proof-1\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("callTool 未知工具 → ok=false 且携带 RPC 错误码", async () => {
    const client = track(new McpStdioClient(makeConfig()));
    await client.start();
    const result = await client.callTool("no_such_tool", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("DW_MCP_RPC_-32601");
    expect(result.error).toContain("unknown tool");
  });

  it("callTool 无响应工具 → 请求超时拒绝（DW_MCP_TIMEOUT），后续调用仍可用", async () => {
    const client = track(new McpStdioClient(makeConfig(), 800));
    await client.start();
    const result = await client.callTool("hang", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("DW_MCP_TIMEOUT:tools/call");
    // 超时只作废该请求，连接仍存活
    const after = await client.callTool("echo", { text: "still-alive" });
    expect(after.ok).toBe(true);
  });

  it("服务器进程退出：挂起请求按 DW_MCP_SERVER_EXIT 拒绝，onExit 触发", async () => {
    const client = track(new McpStdioClient(makeConfig()));
    await client.start();
    const exitPromise = new Promise<number | null>((resolve) => {
      client.onExit = resolve;
    });
    const pending = client.callTool("hang", {}); // 挂起中杀掉进程
    // 经内部 proc 强杀（测试直达进程层）
    (client as unknown as { proc: { kill(): void } }).proc.kill();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("DW_MCP_SERVER_EXIT");
    await expect(exitPromise).resolves.not.toBeUndefined();
  });

  it("start 失败（命令不存在）→ DW_MCP_SPAWN_FAILED，可安全 close", async () => {
    const client = track(new McpStdioClient(makeConfig({ command: "definitely-not-a-real-command-xyz" })));
    await expect(client.start()).rejects.toThrow(/DW_MCP_(SPAWN_FAILED|SERVER_EXIT)/);
    await client.close();
  });

  it("未 start 即调用 → DW_MCP_NOT_READY", async () => {
    const client = track(new McpStdioClient(makeConfig()));
    const result = await client.callTool("echo", { text: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("DW_MCP_NOT_READY");
  });
});
