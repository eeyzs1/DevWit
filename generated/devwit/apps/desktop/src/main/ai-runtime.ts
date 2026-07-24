/**
 * AI 子系统接线（WU008-WU011 → WU012 主进程集成）。
 *
 * 组装链：SettingsStore（凭证解析 AR005）→ ProviderRegistry（llm-providers，
 * 唯一 LLM HTTP 出口 AR002）→ ContextEngine（每会话一个，manifest 落盘 AC2）
 * → AgentLoop（授权门 pending 路径，经 IPC 弹窗裁决 AC4）→ ModeStore（热更新 AC6）。
 *
 * 热更新：
 * - providers/modes/contextOverrides 均存 settings，变更即推送并重读，无重启；
 * - 会话中切模型：AgentRunInput.providerId 覆盖模式绑定（AC5）。
 */
import { promises as fs } from "node:fs";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AgentRunInput,
  AgentTraceEvent,
  AuthorizationDecision,
  ContextItemType,
  ContextManifest,
  Embedder,
  LLMProvider,
  McpServerConfig,
  McpServerView,
  ModeDefinition,
  ProviderConfig,
  RagConfig,
  RagStatusInfo,
} from "@devwit/contracts";
import { DEFAULT_RAG_CONFIG, IPC } from "@devwit/contracts";
import { AgentLoop, AgentOrchestrator, AgentTrace, Authorizer, createNodeEnvironment, historyFromTrace } from "@devwit/agent-runtime";
import type { ToolEnvironment } from "@devwit/agent-runtime";
import { ContextEngine, fileFragmentSource, gitStatusSource, selectionSource, TiktokenCounter } from "@devwit/context-engine";
import { createEmbedder, ProviderRegistry } from "@devwit/llm-providers";
import { McpManager, validateMcpServerConfig } from "@devwit/mcp";
import { ModeStore } from "@devwit/modes";
import { CodebaseIndex, codebaseMatchSource } from "@devwit/rag";
import type { SettingsStore } from "@devwit/settings";
import { getGitStatus } from "@devwit/workspace";
import type { WorkspaceService } from "@devwit/workspace";

/** settings 键：用户逐项上下文开关（全局，对每个新会话引擎生效）。 */
const CONTEXT_OVERRIDES_KEY = "contextOverrides";
/** settings 键：稳定 key 项的逐项开关（AC19：codebase_match 单块剔除/恢复）。 */
const CONTEXT_ITEM_OVERRIDES_KEY = "contextItemOverrides";
const PROVIDERS_KEY = "providers";
const MODES_KEY = "modes";
/** settings 键：MCP 服务器配置列表（迭代 8 / AC17，热更新）。 */
const MCP_SERVERS_KEY = "mcpServers";
/** settings 键：代码索引配置（迭代 10 / AC19，热更新）。 */
const RAG_KEY = "rag";

interface SessionState {
  engine: ContextEngine;
  trace: AgentTrace;
  authorizer: Authorizer;
  abort: AbortController;
  running: boolean;
  modeId: string;
}

export interface AiRuntimeDeps {
  settings: SettingsStore;
  workspace: WorkspaceService;
  /** 主→渲染推送（agent:event / modes:changed）。 */
  send(channel: string, ...args: unknown[]): void;
  /** manifest 落盘目录（AC2 审计产物）。 */
  manifestsDir: string;
  /** 轨迹落盘目录（迭代 6 / AC15：sessionId.jsonl 逐行追加，重启可恢复）。缺省取 manifestsDir 同级 traces/。 */
  tracesDir?: string;
  /** 测试注入：替换真实工具环境（生产缺省 createNodeEnvironment）。 */
  env?: ToolEnvironment;
  /** 测试注入：替换 provider 工厂（生产缺省 registry.createProvider）。 */
  createProvider?: (id: string) => LLMProvider;
  /** 测试注入：替换 embedder 工厂（生产缺省 createEmbedder 走真实 /v1/embeddings）。 */
  createEmbedder?: (providerId: string, embedModel: string) => Embedder;
  /** 代码索引根目录（AC19：每个工作区一个 hash 子目录）。缺省取 manifestsDir 同级 rag/。 */
  ragDir?: string;
}

export class AiRuntime {
  private readonly deps: AiRuntimeDeps;
  private readonly settings: SettingsStore;
  private readonly registry: ProviderRegistry;
  private readonly modeStore = new ModeStore();
  private readonly sessions = new Map<string, SessionState>();
  private readonly env: ToolEnvironment;
  /** MCP 服务器生命周期管理（AC17）：配置热同步，工具聚合注入 agent-loop。 */
  private readonly mcpManager: McpManager;
  private latestManifest: ContextManifest | null = null;
  private lastModeId = "chat";
  /** hydrate 期间抑制 persist，打断 settings→store→settings 回环。 */
  private hydratingModes = false;
  /** 轨迹落盘目录（AC15）。 */
  private readonly tracesDir: string;
  /** 代码索引（AC19）：null=未启用/不可用；状态经 RagStatus 推送。 */
  private ragIndex: CodebaseIndex | null = null;
  private ragStatus: RagStatusInfo = { state: "disabled" };
  private ragRoot: string | null = null;
  private readonly ragDir: string;
  private readonly tokenCounter = new TiktokenCounter();

  constructor(deps: AiRuntimeDeps) {
    this.deps = deps;
    this.settings = deps.settings;
    this.tracesDir = deps.tracesDir ?? path.join(path.dirname(deps.manifestsDir), "traces");
    this.ragDir = deps.ragDir ?? path.join(path.dirname(deps.manifestsDir), "rag");
    this.env = deps.env ?? createNodeEnvironment();
    // 凭证解析：settings 实现 CredentialResolver（密钥仅在请求时读取，换 key 不重启）
    this.registry = new ProviderRegistry(this.settings);
    this.mcpManager = new McpManager();
    this.mcpManager.onDidChange(() => {
      this.deps.send(IPC.McpChanged);
    });
    this.hydrateProviders();
    this.hydrateModes();
    this.hydrateMcpServers();
    // 热更新：settings 变更即重读（providers 键 / modes 持久化键 / 上下文开关 / MCP 配置 / RAG 配置）
    this.settings.onChanged((key) => {
      if (key === PROVIDERS_KEY) {
        this.hydrateProviders();
        this.refreshRag(); // provider 增删影响 embedder 可用性
      }
      if (key === MODES_KEY) this.hydrateModes();
      if (key === CONTEXT_OVERRIDES_KEY) this.applyContextOverridesToSessions();
      if (key === CONTEXT_ITEM_OVERRIDES_KEY) this.applyItemOverridesToSessions();
      if (key === MCP_SERVERS_KEY) this.hydrateMcpServers();
      if (key === RAG_KEY) this.refreshRag();
    });
    this.modeStore.onDidChange(() => {
      this.persistModes();
      this.deps.send(IPC.ModesChanged);
    });
    // AC19 增量索引：工作区文件事件 → 单文件重嵌入（保存/外部变更/删除）
    this.deps.workspace.onDidChange((event) => {
      if (this.ragIndex === null || this.ragRoot === null) return;
      void this.ragIndex.syncFile(path.join(this.ragRoot, event.path));
    });
  }

  // --------------------------------------------------------------------------
  // providers / modes
  // --------------------------------------------------------------------------

  listProviders(): ProviderConfig[] {
    return this.registry.list();
  }

  upsertProvider(config: ProviderConfig): void {
    this.registry.register(config);
    this.persistProviders();
  }

  listModes(): ModeDefinition[] {
    return this.modeStore.list();
  }

  upsertMode(mode: ModeDefinition): void {
    this.modeStore.upsert(mode);
  }

  deleteMode(id: string): boolean {
    return this.modeStore.delete(id);
  }

  private hydrateProviders(): void {
    const raw = this.settings.get(PROVIDERS_KEY);
    const list = Array.isArray(raw) ? (raw as ProviderConfig[]) : [];
    const existing = new Set(this.registry.list().map((config) => config.id));
    for (const config of list) {
      try {
        this.registry.register(config);
        existing.delete(config.id);
      } catch {
        // 非法配置项不注册（设置面板会显示校验错误）；不阻断其余项
      }
    }
    for (const staleId of existing) {
      this.registry.remove(staleId);
    }
  }

  private persistProviders(): void {
    this.settings.set(PROVIDERS_KEY, this.registry.list());
  }

  private hydrateModes(): void {
    const raw = this.settings.get(MODES_KEY);
    if (!Array.isArray(raw)) return;
    this.hydratingModes = true;
    try {
      this.modeStore.replaceAll(raw as ModeDefinition[]);
    } catch {
      // 持久化数据损坏：保留内置模式，不崩溃
    } finally {
      this.hydratingModes = false;
    }
  }

  private persistModes(): void {
    if (this.hydratingModes) return;
    // 全量持久化（迭代 6 修复：内置模式可编辑，绑定模型/改提示词等修改必须跨重启
    // 保留——此前只存非内置模式，重启后内置 agent/chat 模式的绑定丢失，DW_MODE_UNBOUND）。
    // 水合侧 replaceAll 对内置 id 冲突保留 builtin 标志；未来版本新增的内置模式
    // 不在持久化列表中，构造时的种子值保留，自动出现。
    this.settings.set(MODES_KEY, this.modeStore.list());
  }

  // --------------------------------------------------------------------------
  // MCP 服务器（迭代 8 / AC17）：配置存 settings "mcpServers"，热更新
  // --------------------------------------------------------------------------

  listMcpServers(): McpServerView[] {
    return this.mcpManager.listViews();
  }

  upsertMcpServer(config: McpServerConfig): void {
    validateMcpServerConfig(config);
    const list = this.readMcpServerConfigs();
    const index = list.findIndex((entry) => entry.id === config.id);
    if (index >= 0) {
      list[index] = config;
    } else {
      list.push(config);
    }
    // settings.set 触发 onChanged → hydrateMcpServers → manager 差量同步（热生效）
    this.settings.set(MCP_SERVERS_KEY, list);
  }

  deleteMcpServer(id: string): void {
    const list = this.readMcpServerConfigs().filter((entry) => entry.id !== id);
    this.settings.set(MCP_SERVERS_KEY, list);
  }

  /** 应用退出（will-quit）：停止全部 MCP 子进程 + 关闭代码索引。 */
  async dispose(): Promise<void> {
    this.teardownRag();
    await this.mcpManager.dispose();
  }

  private readMcpServerConfigs(): McpServerConfig[] {
    const raw = this.settings.get(MCP_SERVERS_KEY);
    return Array.isArray(raw) ? (raw as McpServerConfig[]) : [];
  }

  private hydrateMcpServers(): void {
    const list = this.readMcpServerConfigs().filter((entry) => {
      try {
        validateMcpServerConfig(entry);
        return true;
      } catch {
        return false; // 非法配置项不同步（设置面板保存前已校验）；不阻断其余项
      }
    });
    this.mcpManager.syncConfigs(list);
  }

  // --------------------------------------------------------------------------
  // 代码索引 / 透明 RAG（迭代 10 / AC19）：settings "rag" 键热更新
  // --------------------------------------------------------------------------

  getRagStatus(): RagStatusInfo {
    return this.ragStatus;
  }

  /** 手动全量重建（设置页「重建索引」按钮）；索引未启用时为无操作。 */
  async rebuildRag(): Promise<void> {
    if (this.ragIndex === null) return;
    await this.ragIndex.buildAll();
  }

  /**
   * 评估 RAG 配置与工作区状态，建/重建/关闭索引。
   * 触发点：settings rag/providers 键变更、IPC 打开工作区后（ipc.ts 调用）、run() 兜底。
   */
  refreshRag(): void {
    const config = this.readRagConfig();
    const root = this.deps.workspace.rootPath;
    if (!config.enabled || root === null) {
      this.teardownRag();
      return;
    }
    if (this.ragIndex !== null && this.ragRoot === root) return; // 已就当前根就绪
    this.teardownRag();

    let embedder: Embedder;
    try {
      embedder = this.createEmbedderFor(config);
    } catch (error) {
      // 无 OpenAI 兼容 provider / 无凭证 / anthropic 类型：优雅降级（AC19）
      const message = error instanceof Error ? error.message : String(error);
      this.setRagStatus({ state: "error", code: message.startsWith("DW_") ? message.split(":")[0]! : "DW_RAG_NO_EMBED_PROVIDER" });
      return;
    }
    this.ragRoot = root;
    const indexDir = path.join(this.ragDir, hashWorkspaceRoot(root));
    const index = new CodebaseIndex({
      root,
      indexDir,
      embedder,
      onStatus: (status) => this.setRagStatus(status),
    });
    this.ragIndex = index;
    this.autoEnableCodebaseMatch(config);
    void index.buildAll();
  }

  /** 启用索引时自动打开 codebase_match 类型开关（一次性；之后用户可自由开关）。 */
  private autoEnableCodebaseMatch(config: RagConfig): void {
    if (!config.enabled) return;
    const overrides = this.readContextOverrides();
    if (overrides.get("codebase_match") === true) return;
    this.setContextItemEnabled("codebase_match", true);
  }

  private teardownRag(): void {
    if (this.ragIndex !== null) {
      this.ragIndex.dispose();
      this.ragIndex = null;
    }
    this.ragRoot = null;
    this.setRagStatus({ state: "disabled" });
  }

  private setRagStatus(status: RagStatusInfo): void {
    this.ragStatus = status;
    this.deps.send(IPC.RagStatus, status);
  }

  private readRagConfig(): RagConfig {
    const raw = this.settings.get(RAG_KEY);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_RAG_CONFIG };
    const record = raw as Record<string, unknown>;
    return {
      enabled: record["enabled"] === true,
      ...(typeof record["providerId"] === "string" && record["providerId"] !== ""
        ? { providerId: record["providerId"] }
        : {}),
      embedModel:
        typeof record["embedModel"] === "string" && record["embedModel"] !== ""
          ? record["embedModel"]
          : DEFAULT_RAG_CONFIG.embedModel,
      topK: typeof record["topK"] === "number" && record["topK"] > 0 ? Math.floor(record["topK"]) : DEFAULT_RAG_CONFIG.topK,
      budgetTokens:
        typeof record["budgetTokens"] === "number" && record["budgetTokens"] > 0
          ? Math.floor(record["budgetTokens"])
          : DEFAULT_RAG_CONFIG.budgetTokens,
    };
  }

  /** 选 embedder  provider：配置的 providerId 或第一个 openai 类型；凭证缺失抛 DW_RAG_NO_CREDENTIAL。 */
  private createEmbedderFor(config: RagConfig): Embedder {
    const providers = this.registry.list();
    const provider =
      (config.providerId !== undefined ? providers.find((entry) => entry.id === config.providerId) : undefined) ??
      providers.find((entry) => entry.type === "openai");
    if (provider === undefined) {
      throw new Error("DW_RAG_NO_EMBED_PROVIDER");
    }
    const hasCredential = this.settings.listCredentials().some((meta) => meta.ref === provider.credentialRef);
    if (!hasCredential) {
      throw new Error("DW_RAG_NO_CREDENTIAL");
    }
    if (this.deps.createEmbedder !== undefined) {
      return this.deps.createEmbedder(provider.id, config.embedModel);
    }
    return createEmbedder(provider, config.embedModel, this.settings);
  }

  /** 逐项（稳定 key）开关：写 settings（全局持久）+ 应用到全部存活会话引擎（热生效）。 */
  setContextItemOverride(key: string, enabled: boolean): void {
    const raw = this.settings.get(CONTEXT_ITEM_OVERRIDES_KEY);
    const record =
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    record[key] = enabled;
    this.settings.set(CONTEXT_ITEM_OVERRIDES_KEY, record);
    for (const session of this.sessions.values()) {
      session.engine.setItemOverride(key, enabled);
    }
  }

  private readItemOverrides(): Map<string, boolean> {
    const raw = this.settings.get(CONTEXT_ITEM_OVERRIDES_KEY);
    const map = new Map<string, boolean>();
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "boolean") map.set(key, value);
      }
    }
    return map;
  }

  private applyItemOverridesToSessions(): void {
    for (const session of this.sessions.values()) {
      for (const [key, enabled] of this.readItemOverrides()) {
        session.engine.setItemOverride(key, enabled);
      }
    }
  }

  // --------------------------------------------------------------------------
  // agent 会话
  // --------------------------------------------------------------------------

  /** 驱动一次 agent run（chat 模式 = 无写工具的模式）。异步全量跑完才 resolve。 */
  async run(input: AgentRunInput): Promise<void> {
    const mode = this.modeStore.get(input.modeId);
    if (mode === undefined) {
      // 错误码保持 ASCII：主进程 stderr 在 GBK 终端输出中文会乱码，文案由渲染端 localizeError 本地化
      throw new Error(`DW_MODE_NOT_FOUND:${input.modeId}`);
    }
    const providerId = input.providerId ?? mode.providerId;
    if (providerId === "") {
      throw new Error(`DW_MODE_UNBOUND:${mode.id}`);
    }
    // AC19 兜底：root 经其他路径（如会话恢复）变更时，run 前重新评估索引
    this.refreshRag();
    const provider =
      this.deps.createProvider !== undefined ? this.deps.createProvider(providerId) : this.registry.createProvider(providerId);

    const session = this.ensureSession(input.sessionId, input.modeId);
    if (session.running) {
      throw new Error("DW_SESSION_BUSY");
    }
    this.lastModeId = input.modeId;
    session.running = true;
    session.abort = new AbortController();
    session.modeId = input.modeId;

    // AC15：本轮之前的轨迹重建为对话历史（跨轮次/跨重启连续记忆）；
    // 在 loop 记录本轮 user_message 之前快照，避免重复计入本轮输入。
    const priorHistory = historyFromTrace(session.trace.list());
    try {
      if (mode.orchestrate === true) {
        // AC20 多 Agent 编排：Planner 分解 → 并行子 Agent（共享授权门）→ 综合
        const orchestrator = new AgentOrchestrator({
          provider,
          mode,
          env: this.env,
          authorizer: session.authorizer,
          trace: session.trace,
          createSubEngine: () => this.createSubEngine(input.sessionId),
          onAssistantDelta: (delta) => this.emitDelta(input.sessionId, delta),
          extraTools: () => this.mcpManager.toolDefinitions(),
          executeExtraTool: (call) => this.mcpManager.callTool(call),
        });
        await orchestrator.run(input, session.abort.signal, priorHistory);
      } else {
        const loop = new AgentLoop({
          provider,
          engine: session.engine,
          mode,
          env: this.env,
          authorizer: session.authorizer,
          trace: session.trace,
          onAssistantDelta: (delta) => this.emitDelta(input.sessionId, delta),
          // AC17：MCP 工具热聚合（每轮迭代取当前 ready 服务器工具集）与调用路由
          extraTools: () => this.mcpManager.toolDefinitions(),
          executeExtraTool: (call) => this.mcpManager.callTool(call),
        });
        await loop.run(input, session.abort.signal, priorHistory);
      }
    } finally {
      session.running = false;
    }
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.authorizer.denyAllPending();
    session.abort.abort();
  }

  /** 渲染进程裁决授权请求（IPC 弹窗路径）。 */
  authorize(sessionId: string, requestId: string, decision: AuthorizationDecision): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    return session.authorizer.decide(requestId, decision);
  }

  trace(sessionId: string): AgentTraceEvent[] {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) return session.trace.list();
    // AC15：进程内无此会话（如重启后）→ 从磁盘轨迹文件读回
    return this.readPersistedTrace(sessionId);
  }

  // --------------------------------------------------------------------------
  // 上下文策略与 manifest（AC2）
  // --------------------------------------------------------------------------

  /** 当前策略视图：以最近使用模式的策略 + 用户全局开关合成。 */
  getContextPolicy(): Record<ContextItemType, boolean> {
    const session = this.anySession();
    if (session !== undefined) {
      const mode = this.modeStore.get(session.modeId);
      return session.engine.getPolicyView(mode?.contextPolicy);
    }
    // 尚无会话：用一份临时引擎呈现 默认 ← 最近模式 ← 用户开关
    const engine = this.createEngine("policy-preview");
    const mode = this.modeStore.get(this.lastModeId);
    return engine.getPolicyView(mode?.contextPolicy);
  }

  /** 逐项开关：写 settings（全局持久）+ 立即应用到全部存活会话引擎（热生效）。 */
  setContextItemEnabled(type: ContextItemType, enabled: boolean): void {
    const overrides = this.readContextOverrides();
    overrides.set(type, enabled);
    this.settings.set(CONTEXT_OVERRIDES_KEY, Object.fromEntries(overrides));
    for (const session of this.sessions.values()) {
      session.engine.setTypeEnabled(type, enabled);
    }
  }

  getLatestManifest(): ContextManifest | null {
    return this.latestManifest;
  }

  /** 从落盘目录读取最近 N 份 manifest（审计列表；按时间倒序）。 */
  async listManifests(limit = 20): Promise<ContextManifest[]> {  // qg-allow: 审计列表默认页大小，调用方可覆盖
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.deps.manifestsDir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const manifests: ContextManifest[] = [];
    for (const name of files) {
      try {
        const raw = await fs.readFile(path.join(this.deps.manifestsDir, name), "utf-8");
        manifests.push(JSON.parse(raw) as ContextManifest);
      } catch {
        // 单个文件损坏不阻断列表
      }
    }
    manifests.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return manifests.slice(0, limit);
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private ensureSession(sessionId: string, modeId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const engine = this.createEngine(sessionId);
    for (const [type, enabled] of this.readContextOverrides()) {
      engine.setTypeEnabled(type, enabled);
    }
    for (const [key, enabled] of this.readItemOverrides()) {
      engine.setItemOverride(key, enabled);
    }
    const trace = new AgentTrace(sessionId);
    // AC15：先水合磁盘历史（重启后续跑同一会话），再订阅新事件实时落盘
    trace.loadPersisted(this.readPersistedTrace(sessionId));
    trace.onRecord((event) => {
      this.deps.send(IPC.AgentEvent, event);
      this.persistTraceEvent(event);
    });
    const session: SessionState = {
      engine,
      trace,
      authorizer: new Authorizer(),
      abort: new AbortController(),
      running: false,
      modeId,
    };
    this.registerSessionSources(engine);
    this.sessions.set(sessionId, session);
    return session;
  }

  /** AC20 子 Agent 引擎：与会话引擎同源（含 RAG/逐项开关），并发 build 互不竞争。 */
  private createSubEngine(sessionId: string): ContextEngine {
    const engine = this.createEngine(sessionId);
    for (const [type, enabled] of this.readContextOverrides()) {
      engine.setTypeEnabled(type, enabled);
    }
    for (const [key, enabled] of this.readItemOverrides()) {
      engine.setItemOverride(key, enabled);
    }
    this.registerSessionSources(engine);
    return engine;
  }

  /** 会话级上下文源注册：选区/活动文件片段/git 状态/透明 RAG（会话引擎与编排子引擎共用）。 */
  private registerSessionSources(engine: ContextEngine): void {
    engine.registerSource(selectionSource());
    engine.registerSource(fileFragmentSource((filePath) => this.deps.workspace.readFile(filePath)));
    engine.registerSource(
      gitStatusSource(async (root) => {
        const status = await getGitStatus(root);
        if (status === null) return "(非 git 仓库)";
        const lines = status.changed.map((file) => `${file.status} ${file.path}`);
        return [`分支 ${status.branch}`, ...lines].join("\n");
      })
    );
    // AC19：透明 RAG 源。getIndex 动态取——索引热启停即刻反映到下次请求，
    // 未启用/构建中/错误时源产出占位项（透明性：为什么这次没有代码库上下文）。
    const ragConfig = () => this.readRagConfig();
    engine.registerSource(
      codebaseMatchSource({
        getIndex: () => this.ragIndex,
        get topK() {
          return ragConfig().topK;
        },
        get budgetTokens() {
          return ragConfig().budgetTokens;
        },
        countTokens: (text) => this.tokenCounter.count(text),
      })
    );
  }

  private createEngine(sessionId: string): ContextEngine {
    return new ContextEngine({
      sessionId,
      manifestStore: {
        save: async (manifest) => {
          this.latestManifest = manifest;
          await fs.mkdir(this.deps.manifestsDir, { recursive: true });
          await fs.writeFile(
            path.join(this.deps.manifestsDir, `${manifest.id}.json`),
            JSON.stringify(manifest, null, 2),
            "utf-8"
          );
        },
      },
    });
  }

  private emitDelta(sessionId: string, delta: string): void {
    const event: AgentTraceEvent = {
      seq: 0,
      timestamp: new Date().toISOString(),
      sessionId,
      type: "assistant_delta",
      summary: delta,
    };
    this.deps.send(IPC.AgentEvent, event);
  }

  // --------------------------------------------------------------------------
  // 轨迹持久化（迭代 6 / AC15）：traces/<sessionId>.jsonl 逐行追加
  // --------------------------------------------------------------------------

  /** sessionId 经白名单字符化后作文件名（渲染进程可控此值，防路径穿越）。 */
  private traceFile(sessionId: string): string {
    return path.join(this.tracesDir, `${sessionId.replace(/[^\w.-]/g, "_")}.jsonl`);
  }

  private persistTraceEvent(event: AgentTraceEvent): void {
    try {
      mkdirSync(this.tracesDir, { recursive: true });
      appendFileSync(this.traceFile(event.sessionId), `${JSON.stringify(event)}\n`, "utf-8");
    } catch {
      // 落盘失败不阻断会话：轨迹仍在内存中，重启后仅丢失持久副本
    }
  }

  private readPersistedTrace(sessionId: string): AgentTraceEvent[] {
    const file = this.traceFile(sessionId);
    if (!existsSync(file)) return [];
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      return [];
    }
    const events: AgentTraceEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        events.push(JSON.parse(trimmed) as AgentTraceEvent);
      } catch {
        // 单行损坏（如异常断电写了一半）跳过，不阻断整体恢复
      }
    }
    return events;
  }

  private anySession(): SessionState | undefined {
    return [...this.sessions.values()][0];
  }

  private readContextOverrides(): Map<ContextItemType, boolean> {
    const raw = this.settings.get(CONTEXT_OVERRIDES_KEY);
    const map = new Map<ContextItemType, boolean>();
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "boolean") map.set(key as ContextItemType, value);
      }
    }
    return map;
  }

  private applyContextOverridesToSessions(): void {
    const overrides = this.readContextOverrides();
    for (const session of this.sessions.values()) {
      for (const [type, enabled] of overrides) {
        session.engine.setTypeEnabled(type, enabled);
      }
    }
  }
}

/** 工作区根 → 索引目录名（防路径穿越：渲染可控 root 字符串，哈希后作目录名）。 */
function hashWorkspaceRoot(root: string): string {
  return createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12);
}
