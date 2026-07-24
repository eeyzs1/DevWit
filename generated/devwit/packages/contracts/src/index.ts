/**
 * @devwit/contracts — DevWit 全部跨包共享类型与常量。
 *
 * 本包只含类型与常量，不含运行时逻辑。所有包的跨包接口必须在这里定义，
 * 以保证 12 个包 + apps/desktop 之间的契约一致（AR 规则的技术锚点）。
 */

// ============================================================================
// LLM 接入层（WU008）
// ============================================================================

export type ProviderType = "anthropic" | "openai";

/**
 * 一个模型供应商配置。credentialRef 是 settings 凭证存储中的引用 id，
 * 永远不是密钥本体（AR005：密钥明文只在 settings 内出现）。
 */
export interface ProviderConfig {
  id: string;
  type: ProviderType;
  label: string;
  baseUrl: string;
  model: string;
  credentialRef: string;
  maxTokens: number;
  temperature?: number;
  /**
   * 免密钥本地服务（迭代 13 / AC22：如 Ollama）。
   * true 时 provider 跳过凭证解析且不发送 authorization 头；
   * credentialRef 仍必填（契约不变），只是不会被解析。
   */
  keyless?: boolean;
}

/**
 * 知名 OpenAI 兼容服务预设（迭代 13 / AC22）：目录存于 packages/llm-providers
 * （AR002：LLM endpoint 知识唯一归属地），经 IPC 下发渲染端——渲染进程不硬编码域名。
 * models 为建议清单（可为空，用户自由输入）；keyless=true 表示无需 API Key。
 */
export interface ProviderPreset {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl: string;
  models: string[];
  keyless: boolean;
}

/** JSON Schema object，描述工具参数。 */
export type ToolParameterSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** role === "assistant" 时可能携带的工具调用请求 */
  toolCalls?: ToolCall[];
  /** role === "tool" 时必填：对应哪个 ToolCall 的结果 */
  toolCallId?: string;
}

/** 流式事件：provider 统一输出此事件流，屏蔽 Anthropic/OpenAI 协议差异。 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; error: string; retryable: boolean }
  | { type: "done"; stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "cancelled" };

export interface LLMProvider {
  readonly config: ProviderConfig;
  streamChat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<StreamEvent>;
}

/** 凭证读取接口：由 settings 包实现，注入 llm-providers，支持热更新（换 key 不重启）。 */
export interface CredentialResolver {
  /** 按引用读取密钥明文。找不到时抛 CredentialNotFoundError。 */
  resolve(ref: string): Promise<string>;
}

export class CredentialNotFoundError extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super(`Credential not found for ref: ${ref}`);
    this.name = "CredentialNotFoundError";
    this.ref = ref;
  }
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, body: string, retryable: boolean) {
    super(`Provider HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

// ============================================================================
// 简洁上下文引擎（WU009）
// ============================================================================

export type ContextItemType =
  | "system_prompt"
  | "tool_definitions"
  | "file_fragment"
  | "git_status"
  | "terminal_output"
  | "selection"
  | "conversation_history"
  | "codebase_match"
  | "custom";

/**
 * 一次请求上下文中的一个组成项。enabled=false 的项保留在 manifest 中（内容置空、
 * tokens=0），使用户能看到"有哪些项被关掉了"——可见性不依赖于开启状态（AC2）。
 */
export interface ContextItem {
  id: string;
  type: ContextItemType;
  label: string;
  enabled: boolean;
  tokens: number;
  content: string;
  /** 内容来源说明，如文件路径、"git status" 等 */
  source?: string;
  /** token 计数方式："exact"=BPE 精确计数；"estimated"=估算（需在 UI 标注） */
  counting: "exact" | "estimated";
  /**
   * 稳定标识（迭代 10 / AC19）：同类型多项时逐项开关的稳定 key。
   * codebase_match 项取 chunkId（内容哈希），跨 build 稳定；
   * 无 key 的项仅受类型级开关控制。
   */
  key?: string;
  /** 检索相似度（codebase_match 专用，UI 展示排序依据）。 */
  score?: number;
}

/**
 * 每次 LLM 请求生成的上下文清单——DevWit 的核心可审计产物（AC2/AR007）。
 * 每次请求落盘一份，UI 展示其逐项内容与 token 占用。
 */
export interface ContextManifest {
  id: string;
  timestamp: string;
  sessionId: string;
  modeId: string;
  providerId: string;
  model: string;
  items: ContextItem[];
  totalTokens: number;
  systemPromptTokens: number;
}

/** 上下文源：各包可注册新的源（如 workspace 提供 git 状态源）。 */
export interface ContextSource {
  readonly type: ContextItemType;
  collect(input: ContextCollectInput): Promise<ContextItem[]>;
}

export interface ContextCollectInput {
  workspaceRoot?: string;
  activeFile?: string;
  selection?: { text: string; startLine: number; endLine: number };
  terminalTail?: string;
  conversationHistory: ChatMessage[];
  /** 本轮用户意图原文（迭代 10 / AC19：codebase_match 源的检索查询）。 */
  query?: string;
}

// ============================================================================
// 透明 RAG / 代码库检索（迭代 10 / AC19）
// ============================================================================

/**
 * 文本嵌入接口（llm-providers 实现，rag 包依赖）：
 * OpenAI 兼容 /v1/embeddings；Anthropic 无对应 API，createEmbedder 抛
 * DW_EMBED_UNSUPPORTED——此时索引不可用，UI 优雅降级为纯显式注入。
 */
export interface Embedder {
  readonly model: string;
  /** 批量嵌入，返回与输入等长的向量数组。 */
  embed(texts: string[]): Promise<number[][]>;
}

/** 代码索引配置（存 settings 的 "rag" 键，热更新）。 */
export interface RagConfig {
  enabled: boolean;
  /** 用于 embedding 的 provider id（必须 openai 类型）；缺省自动选第一个 openai provider。 */
  providerId?: string;
  /** 检索模型名（独立于 chat 模型，如 text-embedding-3-small）。 */
  embedModel: string;
  /** 单次注入的最大命中块数。 */
  topK: number;
  /** 单次注入的 token 预算（按引擎 counter 计数截断）。 */
  budgetTokens: number;
}

export const DEFAULT_RAG_CONFIG: RagConfig = {
  enabled: false,
  embedModel: "text-embedding-3-small",
  topK: 8,
  budgetTokens: 1500,
};

/** 索引运行状态（主→渲染推送 + 设置页展示）。 */
export type RagStatusInfo =
  | { state: "disabled" }
  | { state: "indexing"; indexedFiles: number; totalFiles: number }
  | { state: "ready"; fileCount: number; chunkCount: number }
  | { state: "error"; code: string };

// ============================================================================
// 模式系统（WU011）
// ============================================================================

/**
 * 模式 = { 系统提示, 工具集, 供应商, 上下文注入策略 }。
 * contextPolicy: ContextItemType -> 默认开启状态；未列出的类型按引擎默认值
 * （AR007：默认仅 system_prompt + tool_definitions 开启）。
 */
export interface ModeDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  providerId: string;
  contextPolicy: Partial<Record<ContextItemType, boolean>>;
  /**
   * 多 Agent 编排（AC20）：true 时该模式的 run 走 AgentOrchestrator——
   * Planner 先把意图分解为子任务，并行子 Agent 执行（共享授权门），最后综合结论。
   * 缺省 false 走单 AgentLoop。
   */
  orchestrate?: boolean;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 社区模式索引条目（迭代 16 / AC25）：索引仓库 index.json 中单个模式的浏览元数据。 */
export interface CommunityModeEntry {
  /** 相对索引 base 的文件路径（如 modes/code-reviewer.json）。 */
  file: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
}

// ============================================================================
// Agent 运行时（WU010）
// ============================================================================

export type AgentToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

/** 需要授权的工具（AC4）：read/grep/find/ls 只读免授权。 */
export const AUTHORIZED_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

export type AuthorizationDecision = "allow" | "allow_session" | "deny";

export interface AuthorizationRequest {
  id: string;
  /** 内置工具名或 MCP 全名（mcp__<serverId>__<tool>，迭代 8 起放宽为 string）。 */
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
}

export type AgentTraceEventType =
  | "user_message"
  | "assistant_message"
  | "assistant_delta"
  | "tool_call"
  | "authorization_request"
  | "authorization_decision"
  | "tool_result"
  | "plan"
  | "subagent_start"
  | "subagent_done"
  | "error"
  | "done";

/**
 * assistant_delta 是流式渲染的瞬时事件（provider 文本块实时转发，AC: 流式渲染），
 * 不写入 AgentTrace 存档（trace list() 不含 delta）；seq 固定为 0 以示非存档事件。
 * 其余类型均为持久轨迹事件（seq 自增）。
 *
 * 多 Agent 编排（AC20）：
 * - plan：Planner 分解结果（detail.subtasks 为子任务列表，fallback=true 表示分解失败退化为单任务）；
 * - subagent_start / subagent_done：子 Agent 生命周期（detail.subagentId/title/finishReason）；
 * - 子 Agent 内部事件（user_message/assistant_message/tool_call 等）转发进父轨迹时
 *   detail.subagentId 携带子代理标识——活动流按标记归属展示，historyFromTrace 跳过
 *   这些事件避免污染下一轮对话历史（综合消息已承载子任务结论）。
 */

export interface AgentTraceEvent {
  seq: number;
  timestamp: string;
  sessionId: string;
  type: AgentTraceEventType;
  /** 一行人类可读摘要，用于轨迹面板 */
  summary: string;
  detail?: unknown;
}

export interface AgentRunInput {
  sessionId: string;
  userText: string;
  modeId: string;
  workspaceRoot: string;
  /** 会话中切换模型（AC5）：覆盖 mode.providerId；缺省用模式绑定。 */
  providerId?: string;
  /** 会话级上下文注入（WU012）：当前活动文件/选区/终端尾段，经 context-engine 按策略注入。 */
  activeFile?: string;
  selection?: { text: string; startLine: number; endLine: number };
  terminalTail?: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** 编排子任务（AC20）：Planner 分解产出，一个子任务由一个并行子 Agent 执行。 */
export interface SubTask {
  /** 稳定标识（S1/S2/…，由编排器指派）。 */
  id: string;
  /** 一行标题（活动流/任务归属展示）。 */
  title: string;
  /** 子 Agent 的完整执行指令（应自足：含上下文与验收口径）。 */
  prompt: string;
}

// ============================================================================
// 设置与凭证（WU007）
// ============================================================================

/**
 * 加密后端抽象。生产环境由 Electron safeStorage 实现（apps/desktop 注入）；
 * 无桌面环境时由 node:crypto 机器密钥实现（同等真实加密，用于测试与 headless）。
 */
export interface CryptoBackend {
  readonly name: string;
  encryptString(plaintext: string): string;
  decryptString(ciphertext: string): string;
}

export interface CredentialMeta {
  ref: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
}

export type SettingsChangeListener = (key: string, value: unknown) => void;

// ============================================================================
// 外部编辑器（迭代 2 / AC10）
// ============================================================================

/**
 * 外部编辑器配置（存 settings 的 "externalEditor" 键）。
 * command 为命令模板，支持占位符 {file}（必需）、{line}（缺省 1），
 * 例：code -g "{file}:{line}" ｜ subl "{file}:{line}" ｜ notepad++ "{file}"
 */
export interface ExternalEditorConfig {
  command: string;
}

// ============================================================================
// 自动更新（迭代 7 / AC16）：electron-updater 接 GitHub Releases
// ============================================================================

/**
 * 更新状态机（主→渲染推送）：
 * checking → available → downloading → ready（用户点重启后 quitAndInstall）；
 * none=已是最新；disabled=开发模式不参与；error=检查/下载失败（code 为 ASCII 错误码）。
 */
export type UpdateStatusInfo =
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "none" }
  | { state: "disabled" }
  | { state: "error"; code: string };

// ============================================================================
// MCP 工具接入（迭代 8 / AC17）：stdio MCP 服务器配置与运行视图
// ============================================================================

/** MCP 工具全名前缀：mcp__<serverId>__<toolName>（防与内置工具/跨服务器重名）。 */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * 一个 stdio MCP 服务器配置（存 settings 的 "mcpServers" 键，热更新）。
 * command/args 为本地可执行命令（如 npx -y @modelcontextprotocol/server-filesystem）。
 */
export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** 附加环境变量（并入子进程环境；API token 等经此传入）。 */
  env?: Record<string, string>;
  enabled: boolean;
}

/** MCP 工具信息（UI 列表与轨迹可读名）。 */
export interface McpToolInfo {
  serverId: string;
  /** 服务器原始工具名。 */
  name: string;
  /** 对模型暴露的全名（mcp__<serverId>__<name>）。 */
  fullName: string;
  description: string;
}

/** 服务器运行状态：connecting=握手/列举工具中；ready=可用；error=启动/连接失败（code 为 ASCII 错误码）；disabled=配置停用。 */
export type McpServerState = "connecting" | "ready" | "error" | "disabled";

/** 设置页展示用的服务器完整视图。 */
export interface McpServerView {
  config: McpServerConfig;
  state: McpServerState;
  tools: McpToolInfo[];
  errorCode?: string;
}

// ============================================================================
// 终端（WU006）
// ============================================================================

export interface TerminalSessionInfo {
  id: string;
  shell: string;
  cwd: string;
  backend: "pty" | "pipe";
  pid: number;
}

// ============================================================================
// IPC 通道（apps/desktop preload 白名单的唯一合法集合，AR001/AR004）
// ============================================================================

export const IPC = {
  WorkspaceOpenDialog: "workspace:open-dialog",
  WorkspaceTree: "workspace:tree",
  WorkspaceRead: "workspace:read",
  WorkspaceWrite: "workspace:write",
  WorkspaceEvent: "workspace:event",
  TerminalCreate: "terminal:create",
  TerminalInput: "terminal:input",
  TerminalOutput: "terminal:output",
  TerminalResize: "terminal:resize",
  TerminalDispose: "terminal:dispose",
  SettingsGet: "settings:get",
  SettingsSet: "settings:set",
  SettingsChanged: "settings:changed",
  CredentialSet: "credential:set",
  CredentialDelete: "credential:delete",
  CredentialList: "credential:list",
  AgentRun: "agent:run",
  AgentCancel: "agent:cancel",
  AgentEvent: "agent:event",
  AgentAuthorize: "agent:authorize",
  AgentTrace: "agent:trace",
  ProvidersList: "providers:list",
  ProvidersUpsert: "providers:upsert",
  ProviderPresets: "providers:presets",
  ModesList: "modes:list",
  ModesUpsert: "modes:upsert",
  ModesDelete: "modes:delete",
  ModesExport: "modes:export",
  ModesImport: "modes:import",
  ModesCommunityList: "modes:community-list",
  ModesCommunityImport: "modes:community-import",
  ModesChanged: "modes:changed",
  ContextManifestLatest: "context:manifest:latest",
  ContextManifestList: "context:manifest:list",
  ContextPolicyGet: "context:policy:get",
  ContextPolicySet: "context:policy:set",
  ContextItemOverrideSet: "context:item-override:set",
  RagGetStatus: "rag:get-status",
  RagRebuild: "rag:rebuild",
  RagStatus: "rag:status",
  ExternalEditorOpen: "external-editor:open",
  UpdateCheck: "update:check",
  UpdateInstall: "update:install",
  UpdateVersion: "update:version",
  UpdateStatus: "update:status",
  McpList: "mcp:list",
  McpUpsert: "mcp:upsert",
  McpDelete: "mcp:delete",
  McpChanged: "mcp:changed",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** preload 暴露给渲染进程的 API 形状（window.devwit）。 */
export interface DevwitApi {
  workspace: {
    openDialog(): Promise<string | null>;
    tree(root: string): Promise<unknown>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    onEvent(cb: (evt: unknown) => void): () => void;
  };
  terminal: {
    create(cwd: string): Promise<TerminalSessionInfo>;
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    dispose(id: string): void;
    onOutput(cb: (id: string, data: string) => void): () => void;
  };
  settings: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    onChanged(cb: (key: string, value: unknown) => void): () => void;
  };
  credentials: {
    set(ref: string, provider: string, secret: string): Promise<void>;
    delete(ref: string): Promise<void>;
    list(): Promise<CredentialMeta[]>;
  };
  agent: {
    run(input: AgentRunInput): Promise<void>;
    cancel(sessionId: string): void;
    authorize(sessionId: string, requestId: string, decision: AuthorizationDecision): void;
    onEvent(cb: (evt: AgentTraceEvent) => void): () => void;
    trace(sessionId: string): Promise<AgentTraceEvent[]>;
  };
  providers: {
    list(): Promise<ProviderConfig[]>;
    upsert(config: ProviderConfig): Promise<void>;
    /** 知名服务预设目录（迭代 13 / AC22）：主进程从 llm-providers 读取下发。 */
    presets(): Promise<ProviderPreset[]>;
  };
  modes: {
    list(): Promise<ModeDefinition[]>;
    upsert(mode: ModeDefinition): Promise<void>;
    delete(id: string): Promise<void>;
    /**
     * 导出模式为 JSON 文件（迭代 14 / AC23：无账号的社区分享方式）。
     * 主进程弹保存对话框；返回写入的文件路径，用户取消返回 null。
     */
    export(id: string): Promise<string | null>;
    /**
     * 从 JSON 文件导入模式：主进程弹打开对话框 → 校验 → 以新 id 落为自定义模式。
     * 返回导入后的模式，用户取消返回 null；文件非法抛 DW_MODE_IMPORT_* 错误码。
     */
    import(): Promise<ModeDefinition | null>;
    /**
     * 浏览社区模式索引（迭代 16 / AC25）：主进程拉取索引仓库 index.json。
     * 网络/格式失败抛 DW_MODES_INDEX_* 错误码。
     */
    communityList(): Promise<CommunityModeEntry[]>;
    /**
     * 一键导入社区模式：按索引条目 file 拉取模式文件，经 AC23 同标准校验后
     * 落为新自定义模式（同文件导入语义：新 id、未知 provider 清空）。
     */
    communityImport(file: string): Promise<ModeDefinition>;
    onChanged(cb: () => void): () => void;
  };
  context: {
    latestManifest(): Promise<ContextManifest | null>;
    listManifests(limit?: number): Promise<ContextManifest[]>;
    /** 当前会话生效的完整上下文策略视图（引擎默认 ← 模式策略 ← 用户逐项开关）。 */
    getPolicy(): Promise<Record<ContextItemType, boolean>>;
    /** 逐项开关（用户覆盖，实时生效；AC2）。 */
    setItemEnabled(type: ContextItemType, enabled: boolean): Promise<void>;
    /** 稳定 key 项的逐项开关（迭代 10 / AC19：codebase_match 单块剔除/恢复）。 */
    setItemOverride(key: string, enabled: boolean): Promise<void>;
  };
  rag: {
    /** 当前索引状态（设置·通用分区状态行）。 */
    getStatus(): Promise<RagStatusInfo>;
    /** 手动全量重建索引。 */
    rebuild(): Promise<void>;
    /** 订阅索引状态推送（indexing 进度 / ready / error）。 */
    onStatus(cb: (status: RagStatusInfo) => void): () => void;
  };
  externalEditor: {
    /**
     * 在外部编辑器打开文件（AC10）。命令模板经 settings 配置；
     * 未配置时 reject 并附引导文案。line 缺省 1。
     */
    open(path: string, line?: number): Promise<void>;
  };
  update: {
    /** 手动检查更新（设置页「检查更新」按钮）；启动静默检查由主进程自发。 */
    check(): Promise<void>;
    /** 下载完成后调用：退出并运行安装程序（quitAndInstall）。 */
    install(): void;
    /** 当前应用版本（app.getVersion()）。 */
    version(): Promise<string>;
    /** 订阅更新状态推送（主→渲染）。 */
    onStatus(cb: (status: UpdateStatusInfo) => void): () => void;
  };
  mcp: {
    /** 全部服务器配置 + 运行状态 + 已注册工具（设置页 MCP 分区）。 */
    list(): Promise<McpServerView[]>;
    /** 新建/更新服务器配置（热生效：主进程即时启动/重启/停止对应进程）。 */
    upsert(config: McpServerConfig): Promise<void>;
    delete(id: string): Promise<void>;
    /** 订阅任一服务器状态变化（主→渲染推送，设置页实时刷新徽标）。 */
    onChanged(cb: () => void): () => void;
  };
}
