import { randomUUID } from "node:crypto";
import {
  AUTHORIZED_TOOLS,
  MCP_TOOL_PREFIX,
  type AuthorizationDecision,
  type AuthorizationRequest,
} from "@devwit/contracts";

/** 授权处理器：由调用方（如 apps 层经 IPC 弹窗）实现，返回用户裁决。 */
export type AuthorizationHandler = (request: AuthorizationRequest) => Promise<AuthorizationDecision>;

interface PendingAuthorization {
  request: AuthorizationRequest;
  resolve: (decision: AuthorizationDecision) => void;
}

/** 生成人类可读的授权理由（授权弹窗与轨迹共用）。 */
export function buildAuthorizationReason(toolName: string, args: Record<string, unknown>): string {
  const pathArg = typeof args["path"] === "string" ? args["path"] : undefined;
  const commandArg = typeof args["command"] === "string" ? args["command"] : undefined;
  switch (toolName) {
    case "write":
      return `写入文件: ${pathArg ?? "(未知路径)"}`;
    case "edit":
      return `修改文件: ${pathArg ?? "(未知路径)"}`;
    case "bash":
      return `执行命令: ${commandArg ?? "(未知命令)"}`;
    default:
      // MCP 工具（迭代 8）：全名 mcp__<serverId>__<tool>，参数摘要截断附后
      if (toolName.startsWith(MCP_TOOL_PREFIX)) {
        const argsJson = JSON.stringify(args);
        const summary = argsJson.length > 120 ? `${argsJson.slice(0, 120)}…` : argsJson;
        return `调用 MCP 工具: ${toolName} ${summary}`;
      }
      return `执行工具 ${toolName}`;
  }
}

/**
 * Authorizer：授权门（AC4）。
 * - AUTHORIZED_TOOLS（write/edit/bash）需授权；read/grep/find/ls 只读免授权；
 * - MCP 工具（mcp__ 前缀，迭代 8）一律需授权——外部服务器能力不可预知，默认最严；
 * - 裁决三态：allow（本次）/ allow_session（本会话内该工具免再问）/ deny；
 * - 两种驱动方式：构造时注入 handler（直接裁决），或不注入时进入 pending
 *   队列由 decide(requestId, decision) 外部裁决（IPC 弹窗路径）。
 */
export class Authorizer {
  private readonly sessionAllowed = new Set<string>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly handler?: AuthorizationHandler;

  constructor(handler?: AuthorizationHandler) {
    if (handler !== undefined) this.handler = handler;
  }

  /** 该工具此刻是否需要询问用户（会话级放行后免问）。 */
  needsAuthorization(toolName: string): boolean {
    if (this.sessionAllowed.has(toolName)) return false;
    return AUTHORIZED_TOOLS.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX);
  }

  /** 当前挂起等待裁决的请求（供 UI 渲染授权队列）。 */
  listPending(): AuthorizationRequest[] {
    return [...this.pending.values()].map((entry) => ({ ...entry.request }));
  }

  async requestAuthorization(
    toolName: string,
    args: Record<string, unknown>,
    reason: string,
    onCreated?: (request: AuthorizationRequest) => void
  ): Promise<{ request: AuthorizationRequest; decision: AuthorizationDecision }> {
    const request: AuthorizationRequest = { id: `auth-${randomUUID()}`, toolName, args, reason };
    // 决策前先暴露完整请求（含 id）——IPC 授权弹窗与轨迹记录都依赖 requestId 做裁决关联
    onCreated?.(request);
    const decision = this.handler
      ? await this.handler(request)
      : await new Promise<AuthorizationDecision>((resolve) => {
          this.pending.set(request.id, { request, resolve });
        });
    if (decision === "allow_session") this.sessionAllowed.add(toolName);
    return { request, decision };
  }

  /** 外部裁决一个挂起请求（IPC 路径）。未知 id 返回 false。 */
  decide(requestId: string, decision: AuthorizationDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
  }

  /** 会话取消：所有挂起请求按 deny 收尾，避免 agent loop 永远等待。 */
  denyAllPending(): void {
    for (const entry of this.pending.values()) entry.resolve("deny");
    this.pending.clear();
  }
}
