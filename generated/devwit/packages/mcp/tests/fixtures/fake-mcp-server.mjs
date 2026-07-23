/**
 * 测试夹具：真实 MCP stdio 服务器（换行分隔 JSON-RPC 2.0）。
 * 工具集：
 * - echo {text} → 原样回显（证明参数透传）；
 * - write_marker {text} → 追加写入 MARKER_FILE 环境变量指定的文件（真实副作用证明）；
 * - hang → 永不响应（超时测试）；
 * - 其他工具名 → JSON-RPC 错误（未知工具路径）。
 * 非 JSON 行容忍：启动时先打印一行纯文本日志（服务器常见的 stdout 污染）。
 */
import fs from "node:fs";

const MARKER_FILE = process.env.MARKER_FILE;

process.stdout.write("fake-mcp-server boot log (non-json line, must be tolerated)\n");

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the given text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "write_marker",
    description: "Append text to the marker file",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to append" } },
      required: ["text"],
    },
  },
  {
    name: "hang",
    description: "Never responds (timeout testing)",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name === "echo") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(args.text ?? "") }] } });
    return;
  }
  if (name === "write_marker") {
    try {
      fs.appendFileSync(MARKER_FILE, `${String(args.text ?? "")}\n`, "utf-8");
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `marker written: ${String(args.text ?? "")}` }] } });
    } catch (error) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `write failed: ${error.message}` }], isError: true } });
    }
    return;
  }
  if (name === "hang") {
    return; // 永不响应
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof message.id !== "number") continue; // notifications/initialized 等通知不响应
    switch (message.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
          },
        });
        break;
      case "tools/list":
        send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
        break;
      case "tools/call":
        handleCall(message.id, message.params);
        break;
      default:
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } });
    }
  }
});
