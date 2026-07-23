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
}

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
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
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
  toolName: AgentToolName;
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
  | "error"
  | "done";

/**
 * assistant_delta 是流式渲染的瞬时事件（provider 文本块实时转发，AC: 流式渲染），
 * 不写入 AgentTrace 存档（trace list() 不含 delta）；seq 固定为 0 以示非存档事件。
 * 其余类型均为持久轨迹事件（seq 自增）。
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
  ModesList: "modes:list",
  ModesUpsert: "modes:upsert",
  ModesDelete: "modes:delete",
  ModesChanged: "modes:changed",
  ContextManifestLatest: "context:manifest:latest",
  ContextManifestList: "context:manifest:list",
  ContextPolicyGet: "context:policy:get",
  ContextPolicySet: "context:policy:set",
  ExternalEditorOpen: "external-editor:open",
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
  };
  modes: {
    list(): Promise<ModeDefinition[]>;
    upsert(mode: ModeDefinition): Promise<void>;
    delete(id: string): Promise<void>;
    onChanged(cb: () => void): () => void;
  };
  context: {
    latestManifest(): Promise<ContextManifest | null>;
    listManifests(limit?: number): Promise<ContextManifest[]>;
    /** 当前会话生效的完整上下文策略视图（引擎默认 ← 模式策略 ← 用户逐项开关）。 */
    getPolicy(): Promise<Record<ContextItemType, boolean>>;
    /** 逐项开关（用户覆盖，实时生效；AC2）。 */
    setItemEnabled(type: ContextItemType, enabled: boolean): Promise<void>;
  };
  externalEditor: {
    /**
     * 在外部编辑器打开文件（AC10）。命令模板经 settings 配置；
     * 未配置时 reject 并附引导文案。line 缺省 1。
     */
    open(path: string, line?: number): Promise<void>;
  };
}
