import type {
  AgentRunInput,
  ChatMessage,
  LLMProvider,
  ModeDefinition,
  SubTask,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@devwit/contracts";
import type { ContextEngine } from "@devwit/context-engine";
import { AgentLoop, type AgentFinishReason, type AgentRunResult } from "./agent-loop.js";
import { Authorizer } from "./authorizer.js";
import { AgentTrace } from "./trace.js";
import type { ToolContext, ToolEnvironment } from "./tools.js";

/**
 * Planner 系统提示：要求模型把用户意图分解为可并行、相互独立、指令自足的子任务，
 * 输出严格 JSON 数组（无 Markdown 围栏无解释文字）。发送对象为 LLM（非 stderr），
 * 中文提示安全。
 */
const PLANNER_SYSTEM_PROMPT = [
  "你是一个任务分解规划器。把用户的工程意图分解为 2 到 N 个可并行执行、相互独立的子任务。",
  "每个子任务必须是自足的：prompt 字段包含执行该子任务所需的全部上下文与验收口径，",
  "执行者看不到其他子任务。修改同一文件的两个子任务必须合并（避免并行写冲突）。",
  "只输出一个 JSON 数组，不要输出任何其他文字、解释或 Markdown 代码围栏。",
  '格式：[{"title":"一行短标题","prompt":"完整执行指令"}]',
].join("");

/** 子 Agent 系统提示后缀：明确其工作者角色与边界。 */
const WORKER_PROMPT_SUFFIX =
  "\n\n你现在是多 Agent 编排中的一个子 Agent，只负责分配给你的单个子任务。" +
  "不要试图完成整个原始意图；完成子任务后用一句话总结结论。";

const DEFAULT_MAX_SUB_AGENTS = 4;
const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_SUB_ITERATIONS = 15;

export interface AgentOrchestratorDeps {
  /** 经 llm-providers 接口访问模型（AR002：规划/执行/综合三路复用同一 provider）。 */
  provider: LLMProvider;
  /** 当前模式（orchestrate=true）：系统提示 + 工具集 + 上下文策略。 */
  mode: ModeDefinition;
  env: ToolEnvironment;
  /** 全部子 Agent 共享同一授权门：allow_session 裁决跨子任务继承（AC20）。 */
  authorizer?: Authorizer;
  trace?: AgentTrace;
  /** 子 Agent 独立上下文引擎工厂：并发 build 不竞争父会话引擎。 */
  createSubEngine: () => ContextEngine;
  /** Planner 产出的子任务上限（防失控），默认 4。 */
  maxSubAgents?: number;
  /** 并行执行的子 Agent 并发上限，默认 3。 */
  maxConcurrency?: number;
  /** 单个子 Agent 的最大迭代数，默认 15（子任务范围小于整体任务）。 */
  maxSubIterations?: number;
  /** 综合阶段的流式文本回调（子 Agent 文本不经 delta 通道，由轨迹事件呈现）。 */
  onAssistantDelta?: (delta: string) => void;
  /** MCP 等动态工具源（透传给每个子 Agent，按服务器当前状态热聚合）。 */
  extraTools?: () => ToolDefinition[];
  executeExtraTool?: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
}

interface PlannedTask {
  title: string;
  prompt: string;
}

/**
 * 从 Planner 输出解析子任务列表。宽容提取：截取首个 `[` 到末个 `]` 的 JSON 切片，
 * 过滤缺 title/prompt 的畸形项；无可解析项返回 null（调用方退化为单任务）。
 */
export function parsePlannedTasks(text: string): PlannedTask[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const tasks: PlannedTask[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record["title"] !== "string" || record["title"].trim() === "") continue;
    if (typeof record["prompt"] !== "string" || record["prompt"].trim() === "") continue;
    tasks.push({ title: record["title"].trim(), prompt: record["prompt"].trim() });
  }
  return tasks.length > 0 ? tasks : null;
}

/** 并发上限映射：最多 limit 个 worker 消费任务队列，结果按原序回填。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 收集一次非流式 LLM 调用的完整文本（Planner 专用；工具定义为空）。 */
async function collectText(
  provider: LLMProvider,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<{ text: string; error: string | null; cancelled: boolean }> {
  let text = "";
  let error: string | null = null;
  let cancelled = false;
  try {
    for await (const event of provider.streamChat(messages, [], signal)) {
      if (event.type === "text") text += event.text;
      else if (event.type === "error") error = event.error;
      else if (event.type === "done") cancelled = event.stopReason === "cancelled";
    }
  } catch (err) {
    if (!signal?.aborted) error = err instanceof Error ? err.message : String(err);
  }
  return { text, error, cancelled };
}

/**
 * AgentOrchestrator（AC20 多 Agent 编排）：Planner 分解 → 并行子 Agent → 综合。
 * - plan：一次非流式 LLM 调用产出子任务列表，plan 事件全量落轨迹（分解可见）；
 *   分解失败/为空/解析失败时退化为单任务（fallback=true，退化原因透明）；
 * - execute：子任务按并发上限并行，每个子 Agent 是完整 AgentLoop（独立引擎与
 *   子轨迹），共享同一 Authorizer——allow_session 跨子任务继承；子 Agent 内部
 *   事件转发进父轨迹并标记 subagentId（活动流归属可见）；
 * - synthesize：汇总各子任务结论做最终流式回复；单个子任务失败不拖垮整体，
 *   其 finishReason 在 subagent_done 与综合输入中可见。
 */
export class AgentOrchestrator {
  private readonly deps: AgentOrchestratorDeps;
  readonly authorizer: Authorizer;
  private readonly injectedTrace?: AgentTrace;
  private lastRunTrace?: AgentTrace;

  constructor(deps: AgentOrchestratorDeps) {
    this.deps = deps;
    this.authorizer = deps.authorizer ?? new Authorizer();
    if (deps.trace !== undefined) this.injectedTrace = deps.trace;
  }

  get trace(): AgentTrace | null {
    return this.injectedTrace ?? this.lastRunTrace ?? null;
  }

  async run(input: AgentRunInput, signal?: AbortSignal, priorHistory?: ChatMessage[]): Promise<AgentRunResult> {
    const trace = this.injectedTrace ?? new AgentTrace(input.sessionId);
    this.lastRunTrace = trace;
    const maxSubAgents = this.deps.maxSubAgents ?? DEFAULT_MAX_SUB_AGENTS;
    trace.record("user_message", input.userText, { text: input.userText });

    // ---- 阶段 1：Planner 分解 ------------------------------------------------
    const plan = await this.plan(input.userText, maxSubAgents, signal);
    if (signal?.aborted) {
      this.authorizer.denyAllPending();
      trace.record("done", "会话已取消");
      return { finishReason: "cancelled", finalText: "", iterations: 0 };
    }
    if (plan.error !== null) {
      trace.record("error", plan.error);
      return { finishReason: "error", finalText: "", iterations: 0, errorMessage: plan.error };
    }
    const subtasks: SubTask[] = plan.tasks.map((task, index) => ({
      id: `S${index + 1}`,
      title: task.title,
      prompt: task.prompt,
    }));
    trace.record(
      "plan",
      plan.fallback ? `分解失败，按单任务执行：${subtasks[0]?.title ?? ""}` : `分解为 ${subtasks.length} 个子任务`,
      { subtasks, ...(plan.fallback ? { fallback: true } : {}) }
    );

    // ---- 阶段 2：并行子 Agent -------------------------------------------------
    const results = await mapWithConcurrency(subtasks, this.deps.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, (task) =>
      this.runSubAgent(task, input, trace, signal)
    );

    if (signal?.aborted) {
      this.authorizer.denyAllPending();
      trace.record("done", "会话已取消");
      return { finishReason: "cancelled", finalText: "", iterations: 0 };
    }

    // ---- 阶段 3：综合 ---------------------------------------------------------
    const synthesis = await this.synthesize(input, subtasks, results, priorHistory, trace, signal);
    if (synthesis.cancelled || signal?.aborted) {
      this.authorizer.denyAllPending();
      trace.record("done", "会话已取消");
      return { finishReason: "cancelled", finalText: synthesis.text, iterations: 0 };
    }
    if (synthesis.error !== null) {
      trace.record("error", synthesis.error);
      return { finishReason: "error", finalText: synthesis.text, iterations: 0, errorMessage: synthesis.error };
    }
    trace.record("done", `任务完成（${subtasks.length} 个子任务）`);
    return { finishReason: "completed", finalText: synthesis.text, iterations: 0 };
  }

  /** Planner 调用：分解失败（流错误/解析失败/空列表）时退化为单任务并标记 fallback。 */
  private async plan(
    intent: string,
    maxSubAgents: number,
    signal?: AbortSignal
  ): Promise<{ tasks: PlannedTask[]; fallback: boolean; error: string | null }> {
    const messages: ChatMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: `用户意图：${intent}\n\n请分解为不超过 ${maxSubAgents} 个子任务。` },
    ];
    const outcome = await collectText(this.deps.provider, messages, signal);
    if (outcome.cancelled) return { tasks: [], fallback: false, error: null };
    const parsed = outcome.error === null ? parsePlannedTasks(outcome.text) : null;
    if (parsed === null) {
      // 退化透明：plan 事件 fallback=true，单任务即原始意图全文
      return { tasks: [{ title: intent.length > 24 ? `${intent.slice(0, 24)}…` : intent, prompt: intent }], fallback: true, error: null };
    }
    return { tasks: parsed.slice(0, maxSubAgents), fallback: false, error: null };
  }

  /** 单个子 Agent：子轨迹事件转发进父轨迹（summary 前缀 + detail.subagentId 标记）。 */
  private async runSubAgent(
    task: SubTask,
    input: AgentRunInput,
    parentTrace: AgentTrace,
    signal?: AbortSignal
  ): Promise<AgentRunResult> {
    parentTrace.record("subagent_start", `[${task.id}] ${task.title}`, { subagentId: task.id, title: task.title });
    const childTrace = new AgentTrace(input.sessionId);
    childTrace.onRecord((event) => {
      // 子 Agent 的终态事件（done/error）不转发：终态由 subagent_done 承载，
      // 否则父级状态机（ChatController/TaskCenter）会把单个子任务收尾误判为整体终态
      if (event.type === "done" || event.type === "error") return;
      const detail =
        typeof event.detail === "object" && event.detail !== null
          ? { ...(event.detail as Record<string, unknown>) }
          : {};
      parentTrace.record(event.type, `[${task.id}] ${event.summary}`, {
        ...detail,
        subagentId: task.id,
        subagentTitle: task.title,
      });
    });
    const workerMode: ModeDefinition = {
      ...this.deps.mode,
      systemPrompt: this.deps.mode.systemPrompt + WORKER_PROMPT_SUFFIX,
    };
    const loop = new AgentLoop({
      provider: this.deps.provider,
      engine: this.deps.createSubEngine(),
      mode: workerMode,
      env: this.deps.env,
      authorizer: this.authorizer,
      trace: childTrace,
      maxIterations: this.deps.maxSubIterations ?? DEFAULT_MAX_SUB_ITERATIONS,
      ...(this.deps.extraTools !== undefined ? { extraTools: this.deps.extraTools } : {}),
      ...(this.deps.executeExtraTool !== undefined ? { executeExtraTool: this.deps.executeExtraTool } : {}),
    });
    const result = await loop.run({ ...input, userText: task.prompt }, signal);
    parentTrace.record(
      "subagent_done",
      `[${task.id}] ${task.title} → ${result.finishReason}`,
      {
        subagentId: task.id,
        title: task.title,
        finishReason: result.finishReason,
        finalText: result.finalText,
        iterations: result.iterations,
        ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      }
    );
    return result;
  }

  /** 综合阶段：汇总各子任务结论，流式产出最终回复（唯一走 delta 通道的阶段）。 */
  private async synthesize(
    input: AgentRunInput,
    subtasks: SubTask[],
    results: AgentRunResult[],
    priorHistory: ChatMessage[] | undefined,
    trace: AgentTrace,
    signal?: AbortSignal
  ): Promise<{ text: string; error: string | null; cancelled: boolean }> {
    const sections = subtasks.map((task, index) => {
      const result = results[index]!;
      const conclusion = result.finalText.length > 0 ? result.finalText : "(无文本结论)";
      return `## ${task.id} ${task.title}\n状态: ${result.finishReason}\n结论: ${conclusion}`;
    });
    const synthUser =
      `原始意图：${input.userText}\n\n` +
      `各子任务已执行完毕，结果如下：\n\n${sections.join("\n\n")}\n\n` +
      "请综合以上子任务结果，用一段话向用户给出最终结论（失败的子任务需明确指出）。";
    const messages: ChatMessage[] = [
      { role: "system", content: this.deps.mode.systemPrompt },
      ...(priorHistory ?? []),
      { role: "user", content: synthUser },
    ];
    let text = "";
    let error: string | null = null;
    let cancelled = false;
    try {
      for await (const event of this.deps.provider.streamChat(messages, [], signal)) {
        switch (event.type) {
          case "text":
            text += event.text;
            this.deps.onAssistantDelta?.(event.text);
            break;
          case "error":
            error = event.error;
            break;
          case "done":
            cancelled = event.stopReason === "cancelled";
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (!signal?.aborted) error = err instanceof Error ? err.message : String(err);
    }
    if (text.length > 0) {
      trace.record("assistant_message", text, { text });
    }
    return { text, error, cancelled };
  }
}
