/**
 * MCP 管理器（迭代 8 / AC17）：按 settings "mcpServers" 配置驱动多服务器生命周期。
 *
 * - syncConfigs 差量同步：新增→启动，删除/停用→停止，command/args/env 变更→重启（指纹比对）；
 * - 工具聚合：ready 服务器的工具以 mcp__<serverId>__<tool> 全名暴露给模型；
 * - 调用路由：按全名前缀解析目标服务器并转发 tools/call；
 * - 状态变化经 onDidChange 通知（主进程转 IPC.McpChanged 推送设置页）。
 */
import { MCP_TOOL_PREFIX } from "@devwit/contracts";
import type {
  McpServerConfig,
  McpServerState,
  McpServerView,
  McpToolInfo,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@devwit/contracts";
import { McpStdioClient } from "./client.js";

/** 配置校验：id 只允许安全字符（要拼进工具全名与错误消息，防注入/解析歧义）。 */
export const MCP_ID_PATTERN = /^[\w-]+$/;

export function validateMcpServerConfig(config: McpServerConfig): void {
  // 校验消息保持 ASCII：会经 IPC 抛到主进程 stderr（GBK 终端防乱码）
  if (!config || typeof config !== "object") throw new Error("McpServerConfig must be an object");
  if (typeof config.id !== "string" || !MCP_ID_PATTERN.test(config.id)) {
    throw new Error("mcp server id must match /^[\\w-]+$/");
  }
  if (typeof config.name !== "string" || config.name.trim() === "") throw new Error("mcp server name must not be empty");
  if (typeof config.command !== "string" || config.command.trim() === "") throw new Error("mcp server command must not be empty");
  if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) {
    throw new Error("mcp server args must be an array of strings");
  }
  if (config.env !== undefined) {
    if (typeof config.env !== "object" || config.env === null || Array.isArray(config.env)) {
      throw new Error("mcp server env must be an object");
    }
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value !== "string") throw new Error(`mcp server env.${key} must be a string`);
    }
  }
  if (typeof config.enabled !== "boolean") throw new Error("mcp server enabled must be a boolean");
}

interface ServerEntry {
  config: McpServerConfig;
  state: McpServerState;
  client: McpStdioClient | null;
  /** 原始工具定义（服务器侧名字）。 */
  tools: ToolDefinition[];
  errorCode?: string;
  /** 启动代际：异步 start 完成时若代际已变（被停用/重启），结果作废。 */
  generation: number;
}

/** 重启指纹：仅 command/args/env 变更需要重启进程；name/enabled 变更不需要。 */
function fingerprint(config: McpServerConfig): string {
  return JSON.stringify([config.command, config.args, config.env ?? {}]);
}

/** 工具全名拼装/解析（mcp__<serverId>__<toolName>；toolName 内可含 __）。 */
export function mcpToolFullName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`;
}

export function parseMcpToolFullName(fullName: string): { serverId: string; toolName: string } | null {
  if (!fullName.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = fullName.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  return { serverId: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
}

export class McpManager {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly requestTimeoutMs = 30_000) {}

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 差量同步配置（settings 热更新路径）。 */
  syncConfigs(configs: McpServerConfig[]): void {
    const incoming = new Map(configs.map((config) => [config.id, config]));

    // 删除：配置已不存在 → 停止并移除
    for (const [id, entry] of this.entries) {
      if (!incoming.has(id)) {
        entry.generation += 1;
        void entry.client?.close();
        this.entries.delete(id);
        this.emitChange();
      }
    }

    for (const config of configs) {
      validateMcpServerConfig(config);
      const existing = this.entries.get(config.id);
      if (existing !== undefined) {
        const restartNeeded =
          existing.config.enabled !== config.enabled || fingerprint(existing.config) !== fingerprint(config);
        const nameChanged = existing.config.name !== config.name;
        existing.config = config;
        if (!config.enabled) {
          if (existing.client !== null || existing.state !== "disabled") {
            existing.generation += 1;
            void existing.client?.close();
            existing.client = null;
            existing.tools = [];
            existing.state = "disabled";
            delete existing.errorCode;
            this.emitChange();
          }
          continue;
        }
        if (restartNeeded) {
          existing.generation += 1;
          void existing.client?.close();
          existing.client = null;
          existing.tools = [];
          this.startServer(existing);
        } else if (nameChanged) {
          this.emitChange();
        }
        continue;
      }
      // 新增
      const entry: ServerEntry = {
        config,
        state: config.enabled ? "connecting" : "disabled",
        client: null,
        tools: [],
        generation: 0,
      };
      this.entries.set(config.id, entry);
      if (config.enabled) {
        this.startServer(entry);
      } else {
        this.emitChange();
      }
    }
  }

  /** 全部 ready 服务器的工具定义（全名前缀化），供 agent-loop 注入模型。 */
  toolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state !== "ready") continue;
      for (const tool of entry.tools) {
        definitions.push({
          name: mcpToolFullName(entry.config.id, tool.name),
          description: `[MCP:${entry.config.name}] ${tool.description}`,
          parameters: tool.parameters,
        });
      }
    }
    return definitions;
  }

  /** 按全名路由调用（agent-loop 的动态工具执行入口）。 */
  async callTool(call: ToolCall): Promise<ToolResult> {
    const parsed = parseMcpToolFullName(call.name);
    if (parsed === null) return { ok: false, output: "", error: `DW_MCP_BAD_NAME:${call.name}` };
    const entry = this.entries.get(parsed.serverId);
    if (entry === undefined) return { ok: false, output: "", error: `DW_MCP_UNKNOWN_SERVER:${parsed.serverId}` };
    if (entry.state !== "ready" || entry.client === null) {
      return { ok: false, output: "", error: `DW_MCP_NOT_READY:${parsed.serverId}` };
    }
    if (!entry.tools.some((tool) => tool.name === parsed.toolName)) {
      return { ok: false, output: "", error: `DW_MCP_UNKNOWN_TOOL:${call.name}` };
    }
    return entry.client.callTool(parsed.toolName, call.args);
  }

  /** 设置页视图：配置 + 状态 + 工具列表。 */
  listViews(): McpServerView[] {
    return [...this.entries.values()].map((entry) => {
      const tools: McpToolInfo[] = entry.tools.map((tool) => ({
        serverId: entry.config.id,
        name: tool.name,
        fullName: mcpToolFullName(entry.config.id, tool.name),
        description: tool.description,
      }));
      const view: McpServerView = {
        config: { ...entry.config, args: [...entry.config.args], ...(entry.config.env !== undefined ? { env: { ...entry.config.env } } : {}) },
        state: entry.state,
        tools,
      };
      if (entry.errorCode !== undefined) view.errorCode = entry.errorCode;
      return view;
    });
  }

  /** 应用退出：停止全部服务器进程。 */
  async dispose(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      await entry.client?.close();
      entry.client = null;
      entry.state = entry.config.enabled ? "error" : "disabled";
    }
  }

  // --------------------------------------------------------------------------

  private startServer(entry: ServerEntry): void {
    entry.state = "connecting";
    delete entry.errorCode;
    entry.generation += 1;
    const generation = entry.generation;
    this.emitChange();

    const client = new McpStdioClient(entry.config, this.requestTimeoutMs);
    entry.client = client;
    client.onExit = () => {
      // 进程意外退出（非停用/重启导致）：转 error 态，工具即刻下线
      if (entry.generation !== generation) return;
      entry.state = "error";
      entry.errorCode = "DW_MCP_SERVER_EXIT";
      entry.tools = [];
      entry.client = null;
      this.emitChange();
    };
    client
      .start()
      .then((tools) => {
        if (entry.generation !== generation) return; // 期间被停用/重启，结果作废
        entry.tools = tools;
        entry.state = "ready";
        this.emitChange();
      })
      .catch((error: unknown) => {
        if (entry.generation !== generation) return;
        entry.state = "error";
        entry.errorCode = error instanceof Error ? error.message.slice(0, 200) : String(error);
        entry.tools = [];
        entry.client = null;
        this.emitChange();
      });
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}
