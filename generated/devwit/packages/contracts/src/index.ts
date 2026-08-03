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

/**
 * 连接探测请求（迭代 17 / AC26）：设置页「测试连接」——主进程真实 GET
 * 模型列表端点，验证 baseUrl 可达性并发现服务器真实型号。
 * apiKey（表单刚输入的明文，不落盘）优先于 credentialRef（编辑已存配置时
 * 由主进程解析）；keyless 本地服务跳过全部凭证逻辑。
 */
export interface ProviderProbeRequest {
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  credentialRef?: string;
  keyless?: boolean;
  timeoutMs?: number;
}

/** 探测结果：ok=true 时 models 为服务器返回的真实型号清单（可为空数组）。 */
export interface ProviderProbeResult {
  ok: boolean;
  models: string[];
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
  | "diagnostics"
  | "workflow"
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
  /** @文件引用路径（迭代 19 / AC28：attachment 源读取注入）。 */
  attachments?: string[];
  /** @符号 引用 id（迭代 29 / AC38：symbolRef 源解析注入）。 */
  symbolRefs?: string[];
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
// 符号级索引 / @符号 引用（迭代 29 / AC38）
// ============================================================================

/** 符号种类（启发式提取的声明分类；struct→class、trait/protocol→interface、impl/mod→module）。 */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "method"
  | "type"
  | "enum"
  | "constant"
  | "variable"
  | "module";

/**
 * 代码符号（@符号 引用候选，symbols:query IPC 返回项）。
 * id 稳定：sha1(relPath:name:kind:startLine) 前 16 位——同位置同内容符号跨查询稳定；
 * 文件编辑后行号漂移产生新 id，旧 id 引用自然失效（语义同 chunkId：用户引用的是"那一处声明"）。
 */
export interface CodeSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  relPath: string;
  startLine: number;
  endLine: number;
  /** 声明行原文（去首尾空白，截断 120 字符），候选下拉与注入 label 展示用。 */
  signature: string;
  /** 所属容器名（类的方法 → 类名；Go 接收者方法 → 接收者类型），候选消歧展示用。 */
  parentName?: string;
}

/** 符号解析结果（引用注入：符号元数据 + 当前文件切片正文，内容为事实源）。 */
export interface ResolvedSymbol extends CodeSymbol {
  text: string;
}

/** symbols:query IPC 返回：索引状态 + 命中符号（indexing 时 symbols 可为空，下拉据此给提示行）。 */
export interface SymbolsQueryResult {
  state: "disabled" | "indexing" | "ready" | "error";
  symbols: CodeSymbol[];
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

/** 社区 MCP 服务器索引条目（迭代 25 / AC34）：索引仓库 index.json mcpServers 段中单个服务器的浏览元数据。 */
export interface CommunityMcpEntry {
  /** 相对索引 base 的文件路径（如 mcp/filesystem.json）。 */
  file: string;
  name: string;
  description: string;
  author: string;
  /** 服务器声明的工具名预告（浏览时可见能力面；导入后以真实握手列举为准）。 */
  tools: string[];
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
  | "authorization_auto"
  | "tool_result"
  | "diagnostics"
  | "route"
  | "workflow"
  | "mode_recommend"
  | "usage"
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
 *
 * 授权白名单（迭代 20 / AC29）：
 * - authorization_auto：命令白名单命中，未经弹窗自动放行（detail.toolName/args/reason +
 *   source="whitelist"）。不产生 authorization_request/decision 对——审计语义为
 *   「这次执行之所以没问你」。
 *
 * 诊断回馈（迭代 21 / AC30）：
 * - diagnostics：write/edit 工具改写文件后对工作区跑 tsc 诊断的结果快照
 *   （detail.count 为问题数，detail.entries 为截断后的诊断列表）。count=0 表示
 *   修复闭环确认——上一次编辑引入的问题已被清除。
 *
 * 本地小模型路由（迭代 22 / AC31）：
 * - route：每次 run 的模型路由决策（detail 为 RouteDecision）。仅记录一次，
 *   位于本轮 user_message 之前——审计语义为「这次请求为什么发给这个模型」。
 *
 * 工作流记忆（迭代 23 / AC32）：
 * - workflow：新任务命中已沉淀的成功工作流模板（detail.phase="reuse"，含
 *   templateId/intent/tools/shared 命中关键词/reuseCount）。模板作为建议性
 *   custom 上下文项注入——不自动执行、不改变授权语义，审计语义为
 *   「这次规划参考了哪次成功经验」。
 *
 * 用量可观测（迭代 26 / AC35）：
 * - usage：一次 run 的真实 token 用量（provider 应答 usage 帧跨迭代求和；
 *   编排模式为 Planner+子 Agent+综合总量）。先于终态 done/error 落盘，
 *   detail={inputTokens, outputTokens}——审计语义为「这次运行真实花了多少」，
 *   与 manifest 的上下文组成估算互补。 */

/** 一条真实用量记录（迭代 26 / AC35，userData/usage.jsonl 逐行追加）。 */
export interface UsageRecord {
  /** ISO 时间戳。 */
  ts: string;
  sessionId: string;
  modeId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
}

/** 用量合计（一组记录的聚合值）。 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** 产生计量的 run 数（无 usage 帧的 run 不计入）。 */
  runs: number;
  /**
   * 估算成本（迭代 27 / AC36）：组内已定价记录的成本合计（货币单位随用户
   * 配置的单价，汇率中性）。组内全部记录未定价时缺省——UI 显示「未定价」，
   * 不虚构数字。
   */
  cost?: number;
  /** 组内未配置单价的 run 数（>0 时 cost 仅为部分覆盖，UI 需标注）。 */
  unpricedRuns?: number;
}

/** 用量统计视图（设置·通用分区「用量统计」区；usage:summary IPC 返回）。 */
export interface UsageSummary {
  total: UsageTotals;
  /** 今日（本地时区日期）合计。 */
  today: UsageTotals;
  byMode: Array<{ modeId: string } & UsageTotals>;
  byProvider: Array<{ providerId: string; model: string } & UsageTotals>;
}

/**
 * 单模型成本单价（迭代 27 / AC36，settings 键 "usage.pricing" 的值项）。
 * 单位 = 每百万 tokens；货币种类由用户自定（免费软件不做汇率假设）。
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** 成本单价表：key = "<providerId> <model>"（与 UsageSummary.byProvider 行同口径）。 */
export type UsagePricing = Record<string, ModelPricing>;

/**
 * 按日/按会话成本汇总（usage:daily IPC 返回）。
 * - byDate：按本地日期键（YYYY-MM-DD）聚合，最近 30 天；
 * - bySession：按 sessionId 聚合，可用于按项目/会话维度查看成本。
 */
export interface UsageDailySummary {
  byDate: Array<{ date: string } & UsageTotals>;
  bySession: Array<{ sessionId: string } & UsageTotals>;
}

/**
 * 成本预警检查结果（usage:budget IPC 返回）。
 * - threshold：用户设定的阈值（货币单位与 pricing 一致）；
 * - current：当前周期内已产生的成本；
 * - exceeded：是否超阈值；
 * - period：统计周期。
 */
export interface UsageBudgetAlert {
  threshold: number;
  current: number;
  exceeded: boolean;
  period: "day" | "week" | "month" | "total";
}

/** 导出格式（usage:export IPC 参数）。 */
export type UsageExportFormat = "csv" | "json";

// ---------------------------------------------------------------------------
// 匿名遥测（迭代 30 / AC39）
// ---------------------------------------------------------------------------

/**
 * 遥测配置（settings 键 "telemetry" 的值）。opt-in 原则：
 * 键不存在 / enabled !== true —— 二者任一成立即不发送任何字节。
 * 修改热生效：主进程订阅 settings.onChanged 即时重配置，无需重启。
 */
export interface TelemetryConfig {
  /** 用户显式勾选后才为 true（默认关闭，绝不预勾选）。 */
  enabled: boolean;
  /** 接收端点 URL（POST JSON）。空串 = 内建 PostHog 匿名端点（只写 token）；
   *  非空 = 用户自建收集器（{source, events} 信封）。 */
  endpoint: string;
}

/**
 * 一条遥测事件（零内容收集）：构造上无自由文本入口——事件名来自代码内
 * 固定字面量，props 仅标量。绝不包含代码、文件内容、路径、对话文本、凭证。
 */
export interface TelemetryEvent {
  /** 事件名（如 app_start / telemetry_opt_in / telemetry_opt_out）。 */
  event: string;
  /** ISO 时间戳。 */
  ts: string;
  /** 匿名随机安装 ID（crypto.randomUUID，持久化复用，与任何账号无关）。 */
  installId: string;
  /** 应用版本（app.getVersion()）。 */
  version: string;
  /** 操作系统平台（process.platform，如 win32 / darwin / linux）。 */
  os: string;
  /** 可选标量属性（计数等；禁止字符串内容字段）。 */
  props?: Record<string, string | number | boolean>;
}

/** 历史会话轨迹摘要（迭代 27 / AC36，agent:trace-list IPC 返回项，会话回放选择器用）。 */
export interface TraceSessionInfo {
  sessionId: string;
  /** 持久化事件总数（assistant_delta 瞬时事件不落盘，不计入）。 */
  eventCount: number;
  /** 首/末事件时间戳（ISO 8601）。 */
  startedAt: string;
  lastAt: string;
  /** 首条用户消息摘要（列表预览；无用户消息时回退首事件摘要）。 */
  preview: string;
  /** 含失败类事件（与 isFailureTraceEvent 同规则）。 */
  hasError: boolean;
}

/** 对话会话条目（迭代 28 / AC37，sessions:list IPC 返回项，会话管理页签用）。 */
export interface ChatSessionInfo {
  sessionId: string;
  /** 显示标题：用户改名优先，否则取首条用户消息摘要。 */
  title: string;
  /** 末事件时间戳（ISO 8601），列表按此倒序。 */
  lastAt: string;
  eventCount: number;
}

/** 本地路由配置（settings 键 "routing.local"）：简单任务路由本地小模型，复杂任务走模式绑定模型。 */
export interface LocalRoutingConfig {
  /** 总开关；关=所有任务走模式绑定模型。 */
  enabled: boolean;
  /** 本地小模型 provider id（须为已注册 provider）。 */
  providerId: string;
  /** 复杂度阈值：score >= threshold 判复杂（走模式绑定），否则判简单（走本地）。 */
  threshold: number;
}

/** 一次路由决策（route 轨迹事件 detail）。 */
export interface RouteDecision {
  /** local=判简单路由本地模型；complex=判复杂走模式绑定；disabled=开关关；unavailable=本地 provider 缺失回退；manual=用户显式指定模型，跳过路由。 */
  routed: "local" | "complex" | "disabled" | "unavailable" | "manual";
  /** 最终使用的 provider id。 */
  providerId: string;
  /** 复杂度得分与阈值（可解释启发式：reasons 逐项列出得分来源）。 */
  score: number;
  threshold: number;
  /** 得分来源逐项说明（ASCII 键，UI 经 i18n 映射后展示）。 */
  reasons: string[];
}

/** 工作流模板（迭代 23 / AC32，settings 键 "workflow.templates"）：成功任务沉淀的可复用工作流。 */
export interface WorkflowTemplate {
  /** 稳定 id（wf-* 学习时生成）。 */
  id: string;
  /** 成功任务的原始意图（该轮 user_message 全文）。 */
  intent: string;
  /** 学习时使用的模式 id。 */
  modeId: string;
  /** 成功路径上的工具名序列（去重保序，如 ["read","write"]）。 */
  tools: string[];
  /** 学习/最近刷新时间（ISO）。 */
  learnedAt: string;
  /** 被相似新任务复用的次数。 */
  reuseCount: number;
  /** 最近复用时间（ISO；未复用过缺省）。 */
  lastReuseAt?: string;
}

/** 工作流命中（workflow 轨迹事件 detail，phase="reuse"）。 */
export interface WorkflowReuse {
  phase: "reuse";
  templateId: string;
  intent: string;
  tools: string[];
  /** 命中的共享关键词（匹配可解释性审计）。 */
  shared: string[];
  reuseCount: number;
}

/** 单模式运行统计（迭代 24 / AC33，settings 键 "modes.stats"）：成功率推荐的唯一事实源。 */
export interface ModeRunStats {
  modeId: string;
  /** 有效定级 run 总数（completed 记成功、error 记失败；cancelled/max_iterations/异常 不定级不计入）。 */
  runs: number;
  successes: number;
  /** 最近定级时间（ISO）。 */
  lastRunAt: string;
}

/**
 * 模式推荐（mode_recommend 轨迹事件 detail，phase="recommend"，迭代 24 / AC33）。
 * 相似成功工作流的模式与当前模式不同、且该模式成功率不差于当前时发出——
 * 建议非自动切换：是否采纳由用户决定（对话形态一键切换）。
 */
export interface ModeRecommendation {
  phase: "recommend";
  /** 推荐的模式 id（相似工作流模板学习时所用模式）。 */
  modeId: string;
  currentModeId: string;
  /** 推荐来源（目前唯一：相似工作流命中；保留扩展位）。 */
  reason: "workflow_hit";
  /** 命中的工作流意图（可解释性）。 */
  intent: string;
  /** 推荐模式成功率 0-1（runs >= MIN 才推荐，防单次侥幸）。 */
  successRate: number;
  /** 当前模式成功率 0-1；无数据为 null。 */
  currentSuccessRate: number | null;
  /** 推荐模式定级 run 数。 */
  runs: number;
}

/** 一条语言/编译诊断（迭代 21 / AC30）：tsc --noEmit 输出的结构化形式。 */
export interface DiagnosticEntry {
  /** 工作区相对路径（正斜杠归一化）。 */
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  /** 诊断码，如 TS2322；无码诊断（罕见）缺省。 */
  code?: string;
  message: string;
}

export interface AgentTraceEvent {
  seq: number;
  timestamp: string;
  sessionId: string;
  type: AgentTraceEventType;
  /** 一行人类可读摘要，用于轨迹面板 */
  summary: string;
  detail?: unknown;
}

/**
 * 失败类轨迹事件判定（迭代 27 / AC36）：时间线高亮、trace-list 的 hasError、
 * 「跳到下一个失败」导航共用同一规则，主进程与渲染端行为一致。
 * - error：run 级错误终态；
 * - tool_result 且 result.ok === false：工具执行失败或被拒绝；
 * - authorization_decision 且 decision === "deny"：授权被拒绝（工具未执行）。
 */
export function isFailureTraceEvent(event: AgentTraceEvent): boolean {
  if (event.type === "error") return true;
  if (event.type === "tool_result") {
    const result = (event.detail as { result?: { ok?: unknown } } | undefined)?.result;
    return result?.ok === false;
  }
  if (event.type === "authorization_decision") {
    return (event.detail as { decision?: unknown } | undefined)?.decision === "deny";
  }
  return false;
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
  /**
   * @文件引用（迭代 19 / AC28）：用户经 @ 提及显式引用的工作区相对路径（正斜杠）。
   * 主进程按路径读全文注入为独立 file_fragment 项（key=attachment:<路径>，可逐项剔除）。
   */
  attachments?: string[];
  /**
   * @符号 引用（迭代 29 / AC38）：用户经 @ 提及显式引用的符号 id。
   * 主进程解析为当前文件切片注入为独立 file_fragment 项（key=symbol:<id>，可逐项剔除）。
   */
  symbolRefs?: string[];
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
// LSP 代码智能（迭代 31 / AC40）：TypeScript language server 悬停/定义/诊断
// ============================================================================

/** LSP 服务状态（主→渲染推送 + 状态栏展示）。idle=未打开工作区。 */
export type LspStatusInfo =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "ready" }
  | { state: "error"; code: string };

/**
 * 一条 LSP 诊断（lsp:diagnostics IPC 返回项 + lsp:diagnostics-changed 推送载荷元素）。
 * 行列采用 LSP 原生 0-based（与编辑器 Position 语义一致），UI 展示时自行 +1。
 * file 为工作区相对路径（正斜杠）。
 */
export interface LspDiagnosticItem {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: "error" | "warning" | "info" | "hint";
  /** 诊断码（如 TS2322）；无码诊断缺省。 */
  code?: string;
  message: string;
}

/** 悬停信息（lsp:hover IPC 返回；null 表示该位置无悬停内容）。 */
export interface LspHoverInfo {
  /** 归一化文本（可能含 markdown 代码围栏，UI 原样呈现）。 */
  text: string;
}

/** 定义跳转目标（lsp:definition IPC 返回项）。0-based 行列，file 为工作区相对路径。 */
export interface LspDefinitionTarget {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

/**
 * 自动补全候选项（lsp:completion IPC 返回项）。
 * kind 为 LSP CompletionItemKind（1=Text 2=Method 3=Function … 25=Class）；
 * insertText 缺省时 UI 用 label 作为待插入文本。
 */
export interface LspCompletionItem {
  label: string;
  detail?: string;
  kind?: number;
  insertText?: string;
}

// ============================================================================
// Git 版本控制（迭代 32 / AC41）：状态面板 / diff 双文本 / 暂存提交
// ============================================================================

/** 面板用单文件变更项（path 相对仓库根，正斜杠；rename 取新路径）。 */
export interface GitFileChange {
  path: string;
  /** porcelain 单列字母：M/A/D/R/C/U/? */
  status: string;
}

/** Git 面板状态快照（git:get-status 返回 + git:changed 推送载荷）。 */
export interface GitPanelStatus {
  branch: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
}

/** diff 双文本（git:diff 返回）：original=HEAD 版（untracked 为 ""），modified=工作区版（deleted 为 ""）。 */
export interface GitDiffTexts {
  original: string;
  modified: string;
}

/** git log 单条（git:log 返回项）。 */
export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// ============================================================================
// DAP 调试（迭代 33 / AC42）：js-debug 适配器 JS 断点调试
// ============================================================================

/**
 * 调试状态机（debug:get-state 返回 + debug:state 推送载荷 + 状态栏展示）。
 * file/line 仅在 stopped 时存在（file 为绝对路径，line 为 1-based 行）。
 */
export type DebugStateInfo =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "running" }
  | { state: "stopped"; threadId: number; reason: string; file?: string; line?: number }
  | { state: "terminated"; exitCode?: number };

/** 调用栈帧（debug:stack 返回项）。file 为绝对路径（无源码帧缺省），line 1-based。 */
export interface DebugStackFrameItem {
  id: number;
  name: string;
  file?: string;
  line: number;
  column: number;
}

/** 作用域（debug:scopes 返回项；variablesReference 传给 debug:variables 展开）。 */
export interface DebugScopeItem {
  name: string;
  variablesReference: number;
}

/** 变量（debug:variables / debug:evaluate 返回项；variablesReference > 0 可继续展开）。 */
export interface DebugVariableItem {
  name: string;
  value: string;
  variablesReference: number;
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
  AgentTraceList: "agent:trace-list",
  ProvidersList: "providers:list",
  ProvidersUpsert: "providers:upsert",
  ProviderPresets: "providers:presets",
  ProvidersProbe: "providers:probe",
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
  McpCommunityList: "mcp:community-list",
  McpCommunityImport: "mcp:community-import",
  McpChanged: "mcp:changed",
  UsageSummary: "usage:summary",
  UsageClear: "usage:clear",
  UsageDaily: "usage:daily",
  UsageBudget: "usage:budget",
  UsageExport: "usage:export",
  SessionsList: "sessions:list",
  SessionsRename: "sessions:rename",
  SessionsDelete: "sessions:delete",
  SymbolsQuery: "symbols:query",
  LspGetStatus: "lsp:get-status",
  LspStatus: "lsp:status",
  LspDidOpen: "lsp:did-open",
  LspDidChange: "lsp:did-change",
  LspDidClose: "lsp:did-close",
  LspHover: "lsp:hover",
  LspDefinition: "lsp:definition",
  LspCompletion: "lsp:completion",
  LspReferences: "lsp:references",
  LspDiagnostics: "lsp:diagnostics",
  LspDiagnosticsChanged: "lsp:diagnostics-changed",
  GitGetStatus: "git:get-status",
  GitDiff: "git:diff",
  GitStage: "git:stage",
  GitUnstage: "git:unstage",
  GitCommit: "git:commit",
  GitPull: "git:pull",
  GitPush: "git:push",
  GitLog: "git:log",
  GitChanged: "git:changed",
  DebugStart: "debug:start",
  DebugStop: "debug:stop",
  DebugGetState: "debug:get-state",
  DebugContinue: "debug:continue",
  DebugNext: "debug:next",
  DebugStepIn: "debug:step-in",
  DebugStepOut: "debug:step-out",
  DebugStack: "debug:stack",
  DebugScopes: "debug:scopes",
  DebugVariables: "debug:variables",
  DebugSetBreakpoints: "debug:set-breakpoints",
  DebugEvaluate: "debug:evaluate",
  DebugState: "debug:state",
  DebugOutput: "debug:output",
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
    /** 历史会话轨迹摘要列表（迭代 27 / AC36）：扫描 traces/ 落盘文件，按末事件时间倒序。 */
    traceList(): Promise<TraceSessionInfo[]>;
  };
  /** 对话会话管理（迭代 28 / AC37）：多会话列表 / 重命名 / 删除（元数据 userData/sessions.json）。 */
  sessions: {
    list(): Promise<ChatSessionInfo[]>;
    rename(sessionId: string, title: string): Promise<void>;
    /** 删除会话：元数据标记 + 轨迹文件一并移除（用户语义上的彻底删除）。 */
    delete(sessionId: string): Promise<void>;
  };
  /**
   * 符号级索引（迭代 29 / AC38）：@符号 引用候选查询。
   * 与 RAG 解耦——纯启发式提取，无 embedding/provider 依赖，工作区打开即可用。
   */
  symbols: {
    query(q: string): Promise<SymbolsQueryResult>;
  };
  /**
   * LSP 代码智能（迭代 31 / AC40）：TypeScript/JavaScript 悬停、跳转定义、实时诊断。
   * 工作区打开后主进程自动启动 typescript-language-server（ELECTRON_RUN_AS_NODE，
   * 零系统依赖）。file 参数一律为工作区相对路径（正斜杠）；行列 0-based。
   * 编辑器缓冲区即事实源：didOpen/didChange 同步未保存内容（Full 同步语义）。
   */
  lsp: {
    /** 当前 LSP 服务状态（状态栏展示）。 */
    getStatus(): Promise<LspStatusInfo>;
    /** 打开文档：同步全量文本并注册语言 id（按扩展名推断）。 */
    didOpen(file: string, text: string): Promise<void>;
    /** 文档变更：Full 同步（防抖由渲染端控制）。 */
    didChange(file: string, text: string): Promise<void>;
    /** 关闭文档（同时清除该文件诊断）。 */
    didClose(file: string): Promise<void>;
    /** 悬停信息；服务未就绪或该位置无内容时返回 null。 */
    hover(file: string, line: number, character: number): Promise<LspHoverInfo | null>;
    /** 跳转定义候选（空数组 = 无定义）；首个为主目标。 */
    definition(file: string, line: number, character: number): Promise<LspDefinitionTarget[]>;
    /** 自动补全候选（空数组 = 无建议）；LSP textDocument/completion。 */
    completion(file: string, line: number, character: number): Promise<LspCompletionItem[]>;
    /** 引用查找候选（空数组 = 无引用）；LSP textDocument/references，含声明处。 */
    references(file: string, line: number, character: number): Promise<LspDefinitionTarget[]>;
    /** 当前全部诊断快照（跨文件）。 */
    diagnostics(): Promise<LspDiagnosticItem[]>;
    /** 订阅服务状态推送。 */
    onStatus(cb: (status: LspStatusInfo) => void): () => void;
    /** 订阅诊断变化推送（载荷为全量快照，小工作区直接替换语义）。 */
    onDiagnostics(cb: (items: LspDiagnosticItem[]) => void): () => void;
  };
  /**
   * Git 版本控制（迭代 32 / AC41）：工作区打开后可用；非 git 仓库 getStatus 返回 null。
   * file 参数一律为仓库根相对路径（正斜杠）。stage/unstage/commit 失败抛
   * DW_GIT_* ASCII 错误码（渲染端 localizeError 本地化）。提交=用户直接动作，不经授权门。
   */
  git: {
    /** 面板状态快照（分支 + 已暂存/变更/未跟踪三组）。 */
    getStatus(): Promise<GitPanelStatus | null>;
    /** 文件 diff 双文本：original=HEAD 版（untracked 为 ""），modified=工作区版（deleted 为 ""）。 */
    diff(file: string): Promise<GitDiffTexts>;
    /** git add：移入已暂存组。 */
    stage(file: string): Promise<void>;
    /** git restore --staged：移回变更组（旧 git 回退 reset HEAD）。 */
    unstage(file: string): Promise<void>;
    /** git commit -m：提交已暂存；空消息/无暂存抛 DW_GIT_COMMIT_FAILED。 */
    commit(message: string): Promise<void>;
    /** git pull：拉取远程并合并；失败抛 DW_GIT_PULL_FAILED。 */
    pull(): Promise<void>;
    /** git push：推送本地提交到远程；失败抛 DW_GIT_PUSH_FAILED。 */
    push(): Promise<void>;
    /** git log：提交历史（默认 50 条）。 */
    log(limit?: number): Promise<GitLogEntry[]>;
    /** 订阅状态变化推送（操作后/工作区文件事件防抖刷新，载荷为全量快照；null=非 git 仓库）。 */
    onChanged(cb: (status: GitPanelStatus | null) => void): () => void;
  };
  /**
   * DAP 调试（迭代 33 / AC42）：JS 文件断点调试（真实 js-debug 适配器，零系统依赖）。
   * program 为入口文件绝对路径；breakpoints 为 绝对路径 → 1-based 行号集。
   * 会话全局单例：start 冲突抛 DW_DAP_ALREADY_ACTIVE；步进/查询要求 stopped 态，
   * 否则抛 DW_DAP_NOT_STOPPED；适配器/握手失败抛 DW_DAP_* ASCII 错误码
   * （渲染端 localizeError 本地化）。
   */
  debug: {
    /** 启动调试会话（完整握手后 resolve：程序在跑或已停首断点）。 */
    start(program: string, breakpoints: Record<string, number[]>): Promise<void>;
    /** 动态更新断点（会话进行中可调用；file 为绝对路径，lines 为 1-based 行号集，空数组=清除该文件断点）。 */
    setBreakpoints(file: string, lines: number[]): Promise<void>;
    /** 停止调试（disconnect + 强杀适配器服务器；幂等）。 */
    stop(): Promise<void>;
    /** 当前调试状态（状态栏轮询初态；之后靠 onState 推送）。 */
    getState(): Promise<DebugStateInfo>;
    /** 以下步进/查询方法要求 stopped 态。 */
    continue(): Promise<void>;
    next(): Promise<void>;
    stepIn(): Promise<void>;
    stepOut(): Promise<void>;
    /** 调用栈（stopped 态）。 */
    stack(): Promise<DebugStackFrameItem[]>;
    /** 作用域列表（指定帧）。 */
    scopes(frameId: number): Promise<DebugScopeItem[]>;
    /** 变量列表（作用域或子对象引用）。 */
    variables(reference: number): Promise<DebugVariableItem[]>;
    /** 表达式求值（暂停上下文；frameId 缺省取栈顶）。 */
    evaluate(expression: string, frameId?: number): Promise<DebugVariableItem>;
    /** 订阅调试状态推送（idle/starting/running/stopped/terminated）。 */
    onState(cb: (state: DebugStateInfo) => void): () => void;
    /** 订阅被调试进程输出推送（console.log 等，category 为 DAP output category）。 */
    onOutput(cb: (category: string, text: string) => void): () => void;
  };
  providers: {
    list(): Promise<ProviderConfig[]>;
    upsert(config: ProviderConfig): Promise<void>;
    /** 知名服务预设目录（迭代 13 / AC22）：主进程从 llm-providers 读取下发。 */
    presets(): Promise<ProviderPreset[]>;
    /**
     * 连接探测（迭代 17 / AC26）：真实 GET 模型列表端点验证可达性并发现型号。
     * 失败抛 DW_PROBE_* ASCII 错误码（TIMEOUT / UNREACHABLE / HTTP:<status>）。
     */
    probe(req: ProviderProbeRequest): Promise<ProviderProbeResult>;
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
    /**
     * 浏览社区 MCP 服务器索引（迭代 25 / AC34）：主进程拉取索引仓库 index.json
     * 的 mcpServers 段（与社区模式同一仓库）。网络/格式失败抛 DW_MCP_INDEX_* 错误码。
     */
    communityList(): Promise<CommunityMcpEntry[]>;
    /**
     * 一键导入社区 MCP 服务器：按索引条目 file 拉取服务器文件，经信封校验 +
     * validateMcpServerConfig 同标准校验后落为新服务器（新 id 生成，热生效）。
     */
    communityImport(file: string): Promise<McpServerConfig>;
    /** 订阅任一服务器状态变化（主→渲染推送，设置页实时刷新徽标）。 */
    onChanged(cb: () => void): () => void;
  };
  usage: {
    /**
     * 用量统计（迭代 26 / AC35）：聚合 userData/usage.jsonl 的真实 token 用量
     * （provider usage 帧求和），今日/累计/按模式/按服务商分布。
     */
    summary(): Promise<UsageSummary>;
    /** 清零用量统计（删除 usage.jsonl，不影响会话轨迹）。 */
    clear(): Promise<void>;
    /**
     * 按日/按会话成本汇总：byDate 最近 30 天，bySession 按会话维度。
     * 用于成本趋势分析和项目级成本归因。
     */
    dailySummary(): Promise<UsageDailySummary>;
    /**
     * 成本预警检查：比较当前周期成本与阈值，返回超限状态。
     * period 可选 day/week/month/total。
     */
    checkBudget(threshold: number, period: "day" | "week" | "month" | "total"): Promise<UsageBudgetAlert>;
    /**
     * 导出成本报告为 CSV 或 JSON 字符串，前端可保存为文件。
     */
    exportReport(format: UsageExportFormat): Promise<string>;
  };
}
