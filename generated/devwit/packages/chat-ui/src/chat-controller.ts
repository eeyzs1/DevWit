import type {
  AgentRunInput,
  AgentTraceEvent,
  AuthorizationDecision,
  DevwitApi,
} from "@devwit/contracts";
import { t } from "@devwit/i18n";

/**
 * ChatController（WU012）：对话面板的 headless 状态机。
 * 不碰 DOM——视图（chat-panel.ts）订阅 onChange 渲染；事件源是 DevwitApi.agent
 * （preload 白名单桥），因此本控制器在纯 node/vitest 中以自写 DevwitApi 替身驱动。
 *
 * 消息模型（时间序）：
 * - user：本地追加；
 * - assistant：assistant_delta 流式累积 → assistant_message 定稿；
 * - tool：tool_call 出现 → tool_result 回填状态；
 * - authorization：authorization_request 出现 → 用户经 authorize() 裁决后标注；
 * - error / done：终态。
 */

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "tool"; summary: string; ok: boolean | null; detail?: string; request?: string }
  | { kind: "authorization"; requestId: string; toolName: string; reason: string; decision: AuthorizationDecision | null; auto?: boolean }
  | { kind: "diagnostics"; count: number; firstLine: string }
  | { kind: "route"; routed: string; providerId: string; score: number; threshold: number }
  | { kind: "workflow"; intent: string; tools: string[]; reuseCount: number }
  | { kind: "modeRecommend"; modeId: string; currentModeId: string; intent: string; successRate: number; currentSuccessRate: number | null; runs: number }
  | { kind: "plan"; subtasks: { id: string; title: string }[]; fallback: boolean }
  | { kind: "subagent"; subagentId: string; title: string; phase: "start" | "done"; finishReason?: string }
  | {
      kind: "usage";
      inputTokens: number;
      outputTokens: number;
      providerId?: string;
      model?: string;
      /** 已定价成本；null=未定价；undefined=尚未解析 */
      cost?: number | null;
    }
  | { kind: "error"; text: string }
  | { kind: "done"; text: string };

export interface ChatContextSnapshot {
  activeFile?: string;
  selection?: { text: string; startLine: number; endLine: number };
  terminalTail?: string;
  /** @文件引用（迭代 19 / AC28）：面板 chips 采集的工作区相对路径（正斜杠）。 */
  attachments?: string[];
  /** @符号 引用（迭代 29 / AC38）：面板 chips 采集的符号 id。 */
  symbolRefs?: string[];
}

export interface ChatControllerDeps {
  api: DevwitApi;
  sessionId: string;
  workspaceRoot: string;
  modeId: string;
}

interface AuthorizationDetail {
  requestId: string;
  toolName: string;
  reason: string;
}

function isAuthorizationDetail(detail: unknown): detail is AuthorizationDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const candidate = detail as Record<string, unknown>;
  return (
    typeof candidate["requestId"] === "string" &&
    typeof candidate["toolName"] === "string" &&
    typeof candidate["reason"] === "string"
  );
}

/** 事件正文：detail.text 为完整原文（迭代 6 起由 agent-loop 存档），summary 超 200 字会截断仅作兜底。 */
function eventText(event: AgentTraceEvent): string {
  const detail = event.detail as { text?: unknown } | undefined;
  return typeof detail?.text === "string" ? detail.text : event.summary;
}

/** plan 事件 detail 的防御性解析（AC20：分解列表在活动流可见）。 */
function planDetail(detail: unknown): { subtasks: { id: string; title: string }[]; fallback: boolean } | null {
  if (typeof detail !== "object" || detail === null) return null;
  const record = detail as Record<string, unknown>;
  if (!Array.isArray(record["subtasks"])) return null;
  const subtasks: { id: string; title: string }[] = [];
  for (const entry of record["subtasks"]) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate["id"] !== "string" || typeof candidate["title"] !== "string") continue;
    subtasks.push({ id: candidate["id"], title: candidate["title"] });
  }
  return { subtasks, fallback: record["fallback"] === true };
}

/** subagent_start/done 事件 detail 的防御性解析。 */
function subagentDetail(detail: unknown): { subagentId: string; title: string; finishReason?: string } | null {
  if (typeof detail !== "object" || detail === null) return null;
  const record = detail as Record<string, unknown>;
  if (typeof record["subagentId"] !== "string" || typeof record["title"] !== "string") return null;
  return {
    subagentId: record["subagentId"],
    title: record["title"],
    ...(typeof record["finishReason"] === "string" ? { finishReason: record["finishReason"] } : {}),
  };
}

/** AC36 单价表 → 单次 run 成本（与 UsageStore.computeCost 同口径）。 */
export function estimateUsageCost(
  inputTokens: number,
  outputTokens: number,
  providerId: string,
  model: string,
  pricing: unknown
): number | null {
  if (typeof pricing !== "object" || pricing === null) return null;
  const price = (pricing as Record<string, { inputPerMillion?: unknown; outputPerMillion?: unknown }>)[
    `${providerId} ${model}`
  ];
  if (
    price === undefined ||
    typeof price.inputPerMillion !== "number" ||
    !Number.isFinite(price.inputPerMillion) ||
    price.inputPerMillion < 0 ||
    typeof price.outputPerMillion !== "number" ||
    !Number.isFinite(price.outputPerMillion) ||
    price.outputPerMillion < 0
  ) {
    return null;
  }
  return (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000;
}

/** G2：用量行文案（tokens + 可选成本）。 */
export function formatUsageLine(item: Extract<ChatItem, { kind: "usage" }>): string {
  const base = t("act.usage.line", { input: item.inputTokens, output: item.outputTokens });
  if (item.cost === undefined) return base;
  if (item.cost === null) return `${base}${t("act.usage.unpriced")}`;
  const cost = String(Number(item.cost.toFixed(6)));
  return `${base}${t("act.usage.withCost", { cost })}`;
}

export class ChatController {
  private readonly deps: ChatControllerDeps;
  private readonly items: ChatItem[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeAgent: () => void;
  private modeId: string;
  private providerId: string | undefined;
  private workspaceRoot: string;
  private running = false;

  constructor(deps: ChatControllerDeps) {
    this.deps = deps;
    this.modeId = deps.modeId;
    this.workspaceRoot = deps.workspaceRoot;
    this.unsubscribeAgent = deps.api.agent.onEvent((event) => this.onAgentEvent(event));
  }

  get sessionId(): string {
    return this.deps.sessionId;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentModeId(): string {
    return this.modeId;
  }

  get currentProviderId(): string | undefined {
    return this.providerId;
  }

  listItems(): ChatItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /** 会话中切换模式（WU012；新模式下次请求生效，模式自身热更新由 modes 包保证）。 */
  setMode(modeId: string): void {
    this.modeId = modeId;
    this.emit();
  }

  /**
   * 切换到另一个对话会话（迭代 28 / AC37 多会话管理）：
   * 清空当前消息列表并改挂新 sessionId——事件过滤按 deps.sessionId 动态判定，
   * 切换后旧会话事件自然不再落入本控制器；调用方随后以 ingestHistory 回放新会话轨迹。
   * 进行中的 run 不允许切换（先 cancel 或等待终态），避免遗留 running 态。
   */
  switchSession(sessionId: string): void {
    if (this.running) return;
    this.deps.sessionId = sessionId;
    this.items.length = 0;
    this.emit();
  }

  /** 工作区变更后更新 agent run 的根目录（打开文件夹后生效）。 */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  /** 会话中切换模型（AC5）：覆盖 mode.providerId 随下次请求发出。 */
  setProvider(providerId: string | undefined): void {
    this.providerId = providerId;
    this.emit();
  }

  /** 发送一条用户消息并驱动一次 agent run（chat 模式 = 无写工具的模式定义）。 */
  async send(userText: string, context: ChatContextSnapshot = {}): Promise<void> {
    if (this.running) {
      throw new Error(t("chat.error.busy"));
    }
    const text = userText.trim();
    if (text.length === 0) {
      return;
    }
    this.items.push({ kind: "user", text });
    this.running = true;
    this.emit();

    const input: AgentRunInput = {
      sessionId: this.deps.sessionId,
      userText: text,
      modeId: this.modeId,
      workspaceRoot: this.workspaceRoot,
      ...(this.providerId !== undefined ? { providerId: this.providerId } : {}),
      ...(context.activeFile !== undefined ? { activeFile: context.activeFile } : {}),
      ...(context.selection !== undefined ? { selection: context.selection } : {}),
      ...(context.terminalTail !== undefined ? { terminalTail: context.terminalTail } : {}),
      ...(context.attachments !== undefined && context.attachments.length > 0
        ? { attachments: context.attachments }
        : {}),
      ...(context.symbolRefs !== undefined && context.symbolRefs.length > 0
        ? { symbolRefs: context.symbolRefs }
        : {}),
    };
    try {
      await this.deps.api.agent.run(input);
    } catch (error) {
      this.running = false;
      this.items.push({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      this.emit();
    }
  }

  cancel(): void {
    if (!this.running) {
      return;
    }
    this.deps.api.agent.cancel(this.deps.sessionId);
  }

  /** 裁决一个授权请求（allow / allow_session / deny）。 */
  authorize(requestId: string, decision: AuthorizationDecision): void {
    this.deps.api.agent.authorize(this.deps.sessionId, requestId, decision);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 回放持久化轨迹（api.agent.trace 的结果）重建消息列表（指挥台切换任务时用）。
   * 轨迹不含 assistant_delta（瞬时事件），定稿文本由 assistant_message 承载。
   * resumed=true（迭代 6 / AC15 应用重启后恢复）：agent 进程已退出，
   * 即使轨迹末尾无 done/error 也不标 running（会话已中断，等待用户续发）。
   */
  ingestHistory(events: AgentTraceEvent[], opts: { resumed?: boolean } = {}): void {
    this.items.length = 0;
    this.running = false;
    for (const event of events) {
      if (event.sessionId !== this.deps.sessionId) continue;
      // 实时路径中 user_message 跳过（本地已追加）；回放时本地无副本，需补上
      if (event.type === "user_message") {
        this.items.push({ kind: "user", text: eventText(event) });
        continue;
      }
      this.onAgentEvent(event);
    }
    // 轨迹末尾若无 done/error，说明会话可能仍在进行（同进程切换任务回放时）
    const last = events.at(-1);
    if (opts.resumed !== true && last !== undefined && last.type !== "done" && last.type !== "error") {
      this.running = true;
    }
    this.emit();
  }

  dispose(): void {
    this.unsubscribeAgent();
    this.listeners.clear();
  }

  // --------------------------------------------------------------------------
  // 事件归约
  // --------------------------------------------------------------------------

  private onAgentEvent(event: AgentTraceEvent): void {
    if (event.sessionId !== this.deps.sessionId) {
      return;
    }
    switch (event.type) {
      case "assistant_delta": {
        const last = this.items[this.items.length - 1];
        if (last?.kind === "assistant" && last.streaming) {
          last.text += event.summary;
        } else {
          this.items.push({ kind: "assistant", text: event.summary, streaming: true });
        }
        break;
      }
      case "assistant_message": {
        const last = this.items[this.items.length - 1];
        const fullText = eventText(event);
        if (last?.kind === "assistant" && last.streaming) {
          // 定稿：以轨迹存档的完整文本为准（delta 是瞬时通道）
          last.text = fullText;
          last.streaming = false;
        } else {
          this.items.push({ kind: "assistant", text: fullText, streaming: false });
        }
        break;
      }
      case "tool_call": {
        // 捕获工具调用请求参数（供活动流「请求」可见；结果在 tool_result 里补）
        const tc = event.detail as { args?: unknown } | undefined;
        const request = tc?.args !== undefined && typeof tc.args === "object" ? JSON.stringify(tc.args) : undefined;
        this.items.push({ kind: "tool", summary: event.summary, ok: null, ...(request !== undefined ? { request } : {}) });
        break;
      }
      case "tool_result": {
        const last = [...this.items].reverse().find((item) => item.kind === "tool" && item.ok === null);
        if (last?.kind === "tool") {
          last.summary = event.summary;
          last.ok = !event.summary.includes("失败") && !event.summary.includes("拒绝");
          // 工具结果审计：捕获完整结构化结果（成功输出或失败错误），供活动流展开查看
          const detail = event.detail as { result?: { ok?: unknown; output?: unknown; error?: unknown } } | undefined;
          const result = detail?.result;
          if (detail !== undefined && result !== undefined) {
            const ok = result.ok === true;
            const output = typeof result.output === "string" ? result.output : "";
            const error = typeof result.error === "string" ? result.error : "";
            last.detail = ok ? (output.length > 0 ? output : "(无输出)") : `错误: ${error || "未知错误"}`;
          }
        }
        break;
      }
      case "diagnostics": {
        // AC30：编辑后 tsc 诊断快照——活动流落一条透明记录（count=0 为修复闭环确认）
        const detail = event.detail as { count?: unknown; entries?: unknown } | undefined;
        const count = typeof detail?.count === "number" ? detail.count : 0;
        const entries = Array.isArray(detail?.entries) ? (detail.entries as { file?: unknown; line?: unknown }[]) : [];
        const first = entries[0];
        const firstLine =
          first !== undefined && typeof first.file === "string" ? `${first.file}:${typeof first.line === "number" ? first.line : 0}` : "";
        // 上一条诊断项原地更新（快照语义：只关心最新状态，不堆叠历史行）
        const lastDiag = [...this.items].reverse().find((item) => item.kind === "diagnostics");
        if (lastDiag?.kind === "diagnostics") {
          lastDiag.count = count;
          lastDiag.firstLine = firstLine;
        } else {
          this.items.push({ kind: "diagnostics", count, firstLine });
        }
        break;
      }
      case "route": {
        // AC31：模型路由决策——本轮起点落一条透明记录（本地/复杂/回退原因可见）
        const detail = event.detail as { routed?: unknown; providerId?: unknown; score?: unknown; threshold?: unknown } | undefined;
        this.items.push({
          kind: "route",
          routed: typeof detail?.routed === "string" ? detail.routed : "disabled",
          providerId: typeof detail?.providerId === "string" ? detail.providerId : "",
          score: typeof detail?.score === "number" ? detail.score : 0,
          threshold: typeof detail?.threshold === "number" ? detail.threshold : 0, // qg-allow: 事件反序列化缺省回退（非调参常量）
        });
        break;
      }
      case "workflow": {
        // AC32：工作流记忆命中——复用的模板工具序列与次数透明可见
        const detail = event.detail as
          | { phase?: unknown; intent?: unknown; tools?: unknown; reuseCount?: unknown }
          | undefined;
        if (detail?.phase === "reuse") {
          this.items.push({
            kind: "workflow",
            intent: typeof detail.intent === "string" ? detail.intent : "",
            tools: Array.isArray(detail.tools) ? detail.tools.filter((x): x is string => typeof x === "string") : [],
            reuseCount: typeof detail.reuseCount === "number" ? detail.reuseCount : 1,
          });
        }
        break;
      }
      case "mode_recommend": {
        // AC33：模式推荐——相似成功工作流的模式统计上不差于当前模式（建议非自动切换）
        const detail = event.detail as
          | { phase?: unknown; modeId?: unknown; currentModeId?: unknown; intent?: unknown; successRate?: unknown; currentSuccessRate?: unknown; runs?: unknown }
          | undefined;
        if (detail?.phase === "recommend" && typeof detail.modeId === "string") {
          this.items.push({
            kind: "modeRecommend",
            modeId: detail.modeId,
            currentModeId: typeof detail.currentModeId === "string" ? detail.currentModeId : "",
            intent: typeof detail.intent === "string" ? detail.intent : "",
            successRate: typeof detail.successRate === "number" ? detail.successRate : 0, // qg-allow: 事件反序列化缺省回退（非调参常量）
            currentSuccessRate: typeof detail.currentSuccessRate === "number" ? detail.currentSuccessRate : null,
            runs: typeof detail.runs === "number" ? detail.runs : 0,
          });
        }
        break;
      }
      case "authorization_request": {
        if (isAuthorizationDetail(event.detail)) {
          // 子 Agent 发起的授权（AC20）：reason 前缀子任务标识，归属可见
          const sub = (event.detail as unknown as Record<string, unknown>)["subagentId"];
          this.items.push({
            kind: "authorization",
            requestId: event.detail.requestId,
            toolName: event.detail.toolName,
            reason: typeof sub === "string" ? `[${sub}] ${event.detail.reason}` : event.detail.reason,
            decision: null,
          });
        }
        break;
      }
      case "authorization_decision": {
        const detail = event.detail as { requestId?: unknown; decision?: unknown } | undefined;
        const pending = [...this.items]
          .reverse()
          .find(
            (item): item is Extract<ChatItem, { kind: "authorization" }> =>
              item.kind === "authorization" && item.decision === null && item.requestId === detail?.requestId
          );
        if (pending !== undefined && typeof detail?.decision === "string") {
          pending.decision = detail.decision as AuthorizationDecision;
        }
        break;
      }
      case "authorization_auto": {
        // AC29：白名单命中——无 request/decision 对，直接落一条已放行记录（auto 标记渲染）
        const detail = event.detail as { toolName?: unknown; reason?: unknown; subagentId?: unknown } | undefined;
        const reason = typeof detail?.reason === "string" ? detail.reason : event.summary;
        const sub = typeof detail?.subagentId === "string" ? `[${detail.subagentId}] ` : "";
        this.items.push({
          kind: "authorization",
          requestId: "",
          toolName: typeof detail?.toolName === "string" ? detail.toolName : "",
          reason: `${sub}${reason}`,
          decision: "allow",
          auto: true,
        });
        break;
      }
      case "usage": {
        // AC35 + G2：真实 token 用量行（先于 done）；附带 provider/model 供成本估算
        const detail = event.detail as {
          inputTokens?: unknown;
          outputTokens?: unknown;
          providerId?: unknown;
          model?: unknown;
        } | undefined;
        const usageItem: Extract<ChatItem, { kind: "usage" }> = {
          kind: "usage",
          inputTokens: typeof detail?.inputTokens === "number" ? detail.inputTokens : 0,
          outputTokens: typeof detail?.outputTokens === "number" ? detail.outputTokens : 0,
          ...(typeof detail?.providerId === "string" ? { providerId: detail.providerId } : {}),
          ...(typeof detail?.model === "string" ? { model: detail.model } : {}),
        };
        this.items.push(usageItem);
        void this.enrichUsageCost(usageItem);
        break;
      }
      case "error":
        this.items.push({ kind: "error", text: event.summary });
        this.running = false;
        break;
      case "done":
        this.items.push({ kind: "done", text: event.summary });
        this.running = false;
        break;
      case "plan": {
        const plan = planDetail(event.detail);
        if (plan !== null) {
          this.items.push({ kind: "plan", subtasks: plan.subtasks, fallback: plan.fallback });
        }
        break;
      }
      case "subagent_start": {
        const started = subagentDetail(event.detail);
        if (started !== null) {
          this.items.push({ kind: "subagent", subagentId: started.subagentId, title: started.title, phase: "start" });
        }
        break;
      }
      case "subagent_done": {
        const finished = subagentDetail(event.detail);
        if (finished !== null) {
          this.items.push({
            kind: "subagent",
            subagentId: finished.subagentId,
            title: finished.title,
            phase: "done",
            ...(finished.finishReason !== undefined ? { finishReason: finished.finishReason } : {}),
          });
        }
        break;
      }
      case "user_message":
        break; // 本地已追加，轨迹回放时跳过
    }
    this.emit();
  }

  /** G2：按 settings 单价表异步补全本轮成本，刷新视图。 */
  private async enrichUsageCost(item: Extract<ChatItem, { kind: "usage" }>): Promise<void> {
    if (item.providerId === undefined || item.model === undefined) {
      item.cost = null;
      this.emit();
      return;
    }
    try {
      const pricing = await this.deps.api.settings.get("usage.pricing");
      item.cost = estimateUsageCost(item.inputTokens, item.outputTokens, item.providerId, item.model, pricing);
    } catch {
      item.cost = null;
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
