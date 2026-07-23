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
import path from "node:path";
import type {
  AgentRunInput,
  AgentTraceEvent,
  AuthorizationDecision,
  ContextItemType,
  ContextManifest,
  LLMProvider,
  ModeDefinition,
  ProviderConfig,
} from "@devwit/contracts";
import { IPC } from "@devwit/contracts";
import { AgentLoop, AgentTrace, Authorizer, createNodeEnvironment, historyFromTrace } from "@devwit/agent-runtime";
import type { ToolEnvironment } from "@devwit/agent-runtime";
import { ContextEngine, fileFragmentSource, gitStatusSource, selectionSource } from "@devwit/context-engine";
import { ProviderRegistry } from "@devwit/llm-providers";
import { ModeStore } from "@devwit/modes";
import type { SettingsStore } from "@devwit/settings";
import { getGitStatus } from "@devwit/workspace";
import type { WorkspaceService } from "@devwit/workspace";

/** settings 键：用户逐项上下文开关（全局，对每个新会话引擎生效）。 */
const CONTEXT_OVERRIDES_KEY = "contextOverrides";
const PROVIDERS_KEY = "providers";
const MODES_KEY = "modes";

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
}

export class AiRuntime {
  private readonly deps: AiRuntimeDeps;
  private readonly settings: SettingsStore;
  private readonly registry: ProviderRegistry;
  private readonly modeStore = new ModeStore();
  private readonly sessions = new Map<string, SessionState>();
  private readonly env: ToolEnvironment;
  private latestManifest: ContextManifest | null = null;
  private lastModeId = "chat";
  /** hydrate 期间抑制 persist，打断 settings→store→settings 回环。 */
  private hydratingModes = false;
  /** 轨迹落盘目录（AC15）。 */
  private readonly tracesDir: string;

  constructor(deps: AiRuntimeDeps) {
    this.deps = deps;
    this.settings = deps.settings;
    this.tracesDir = deps.tracesDir ?? path.join(path.dirname(deps.manifestsDir), "traces");
    this.env = deps.env ?? createNodeEnvironment();
    // 凭证解析：settings 实现 CredentialResolver（密钥仅在请求时读取，换 key 不重启）
    this.registry = new ProviderRegistry(this.settings);
    this.hydrateProviders();
    this.hydrateModes();
    // 热更新：settings 变更即重读（providers 键 / modes 持久化键 / 上下文开关）
    this.settings.onChanged((key) => {
      if (key === PROVIDERS_KEY) this.hydrateProviders();
      if (key === MODES_KEY) this.hydrateModes();
      if (key === CONTEXT_OVERRIDES_KEY) this.applyContextOverridesToSessions();
    });
    this.modeStore.onDidChange(() => {
      this.persistModes();
      this.deps.send(IPC.ModesChanged);
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

    const loop = new AgentLoop({
      provider,
      engine: session.engine,
      mode,
      env: this.env,
      authorizer: session.authorizer,
      trace: session.trace,
      onAssistantDelta: (delta) => this.emitDelta(input.sessionId, delta),
    });
    // AC15：本轮之前的轨迹重建为对话历史（跨轮次/跨重启连续记忆）；
    // 在 loop 记录本轮 user_message 之前快照，避免重复计入本轮输入。
    const priorHistory = historyFromTrace(session.trace.list());
    try {
      await loop.run(input, session.abort.signal, priorHistory);
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
    // 会话级上下文源：选区（AgentRunInput 注入）、活动文件片段、git 状态
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
    this.sessions.set(sessionId, session);
    return session;
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
