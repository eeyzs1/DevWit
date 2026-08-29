import type { ToolDefinition, ToolResult } from "@devwit/contracts";

/**
 * MCP 传输抽象（远程 MCP 支持 — Streamable HTTP / HTTP+SSE）。
 *
 * stdio（本地子进程）与 http（远程端点）都实现此契约；manager 按配置的
 * transport 分发，对上游（agent-loop / 授权门 / 工具注入）完全透明。
 */
export interface McpTransport {
  /** 建立连接 + 完成 initialize 握手 + tools/list，返回服务器工具集。 */
  start(): Promise<ToolDefinition[]>;
  /** 调用一个工具并返回结果。 */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** 关闭连接（终止进程 / abort 在途请求），幂等。 */
  close(): Promise<void>;
  /** 连接意外终止回调（manager 据此转 error 态）。 */
  onExit?: ((code: number | null) => void) | null;
}
