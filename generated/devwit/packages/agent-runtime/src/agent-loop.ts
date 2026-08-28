import type {
  AgentRunInput,
  ChatMessage,
  LLMProvider,
  ModeDefinition,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "@devwit/contracts";
import type { ContextEngine } from "@devwit/context-engine";
import { Authorizer, buildAuthorizationReason } from "./authorizer.js";
import type { DiagnosticsTracker } from "./diagnostics.js";
import { executeTool, isAgentToolName, toolDefinitionsFor, type ToolContext, type ToolEnvironment } from "./tools.js";
import { AgentTrace } from "./trace.js";

export interface AgentLoopDeps {
  /** 经 llm-providers 接口访问模型（AR002：本包不直接发 LLM HTTP）。 */
  provider: LLMProvider;
  /** 简洁上下文引擎：每轮迭代 build 一次，产出可审计 manifest（AR007）。 */
  engine: ContextEngine;
  /** 当前模式：系统提示 + 工具集 + 上下文策略。 */
  mode: ModeDefinition;
  /** 工具执行环境（真实 Node 环境或 apps 注入的 workspace/terminal 实现）。 */
  env: ToolEnvironment;
  authorizer?: Authorizer;
  trace?: AgentTrace;
  /** 最大迭代数（防失控兜底），默认 25。 */
  maxIterations?: number;
  /** assistant 文本块实时回调（流式渲染；apps 层经 IPC 转发为 assistant_delta 瞬时事件）。 */
  onAssistantDelta?: (delta: string) => void;
  /**
   * 动态工具源（迭代 8 / AC17，MCP）：每轮迭代组上下文时取当前可用的
   * 外部工具定义——服务器热启停即刻反映到下一轮请求，无需重建会话。
   */
  extraTools?: () => ToolDefinition[];
  /** 动态工具执行（MCP 等非内置工具的路由入口；缺省时非内置工具报未知工具）。 */
  executeExtraTool?: (call: ToolCall, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * 诊断回馈（迭代 21 / AC30）：write/edit 改写文件后刷新工作区 tsc 诊断，
   * 下一轮请求经上下文源自动携带（修复闭环）。缺省时零成本跳过。
   */
  diagnostics?: DiagnosticsTracker;
  /**
   * B-WU2（Fusion v3 / DSH 风格扩展点）：turn/step 生命周期 + 请求瀑布 +
   * 工具管线钩子。全部可选；缺省时行为与旧版完全一致（零开销旁路）。
   */
  extensions?: AgentLoopExtensions;
}

/**
 * agent/pre-step 瀑布上下文：本轮将发给模型的请求（build 产物）。
 * 改写/拒绝都只会影响本轮请求；transcript 仍是会话的规范历史。
 */
export interface PreStepContext {
  sessionId: string;
  userText: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  iteration: number;
  signal?: AbortSignal;
}

/**
 * pre-step 决策（waterfall 语义，kind 判别）：
 * - { kind: "reject" }：拒绝本轮——不调用模型，turn 以 error 关闭（原因入轨迹）；
 * - { kind: "rewrite" }：改写请求——改写后的 messages/tools 成为本轮模型请求，
 *   并以 request_rewrite 事件落盘（"model-visible <=> logged"）；
 * - undefined：放行（委托给下一监听者）。
 */
export type PreStepDecision =
  | { kind: "reject"; reason: string }
  | { kind: "rewrite"; messages: ChatMessage[]; tools?: ToolDefinition[] }
  | undefined;

/** agent/step-end 串行观察者上下文（不可改写结果）。 */
export interface StepEndContext {
  iteration: number;
  assistantText: string;
  toolCalls: ToolCall[];
}

/** tools/* 管线钩子（B-WU2）：preExecute 可拒绝，postExecute 只观察。 */
export interface ToolPipelineHooks {
  preExecute?: (call: ToolCall, ctx: ToolContext) => Promise<{ deny: string } | undefined>;
  postExecute?: (call: ToolCall, result: ToolResult, ctx: ToolContext) => void | Promise<void>;
}

/** agent/turn-end 串行观察者上下文。 */
export interface TurnEndContext {
  finishReason: AgentFinishReason;
  iterations: number;
  finalText: string;
  errorMessage?: string;
}

/** B-WU2 扩展注册表（全部可选）。 */
export interface AgentLoopExtensions {
  preStep?: (ctx: PreStepContext) => Promise<PreStepDecision>;
  onStepEnd?: (ctx: StepEndContext) => void | Promise<void>;
  toolPipeline?: ToolPipelineHooks;
  onTurnEnd?: (ctx: TurnEndContext) => void | Promise<void>;
}

export type AgentFinishReason = "completed" | "max_iterations" | "cancelled" | "error";

/** 一次 run 的真实 token 用量（迭代 26 / AC35）：provider usage 帧跨迭代求和。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRunResult {
  finishReason: AgentFinishReason;
  /** 最后一条非空 assistant 文本（任务总结）。 */
  finalText: string;
  iterations: number;
  errorMessage?: string;
  /**
   * 真实用量（provider 应答 usage 帧求和；取消/出错路径为已观测到的部分量）。
   * provider 未回报 usage 时缺省——与 manifest 的估算计数互补：manifest 审
   * 上下文组成，usage 审真实计费量。
   */
  usage?: TokenUsage;
}

const DEFAULT_MAX_ITERATIONS = 25;

/** 工具结果回填为 role=tool 消息的内容。 */
export function formatToolResultContent(result: ToolResult): string {
  if (result.ok) return result.output.length > 0 ? result.output : "(无输出)";
  const parts = [`错误: ${result.error ?? "未知错误"}`];
  if (result.output.length > 0) parts.push(result.output);
  return parts.join("\n");
}

function summarizeArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/**
 * AgentLoop（WU010）：模型响应 → 工具调用 → 结果回填 → 直至任务完成。
 * - 每轮：engine.build 组上下文（含 manifest 落盘）→ provider.streamChat →
 *   assistant 消息入 transcript → 无工具调用即完成 → 否则逐个执行工具并回填；
 * - 授权门：write/edit/bash 执行前经 Authorizer（AC4），deny 时回填拒绝说明；
 * - 当前 transcript 是请求本体：loop 在模式策略层强制 conversation_history=true
 *   （引擎级用户开关仍可覆盖——透明度优先，退化在 manifest 中可见）；
 * - 轨迹：user_message / assistant_message / tool_call / authorization 系列 /
 *   tool_result / error / done 全量入 AgentTrace，可查询可订阅。
 */
export class AgentLoop {
  private readonly deps: AgentLoopDeps;
  readonly authorizer: Authorizer;
  private readonly injectedTrace?: AgentTrace;
  private lastRunTrace?: AgentTrace;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
    this.authorizer = deps.authorizer ?? new Authorizer();
    if (deps.trace !== undefined) this.injectedTrace = deps.trace;
  }

  /** 最近一次 run 的轨迹（注入 trace 时为注入对象）。 */
  get trace(): AgentTrace | null {
    return this.injectedTrace ?? this.lastRunTrace ?? null;
  }

  /**
   * 驱动一次 run。priorHistory（迭代 6 / AC15）：本轮之前的会话历史
   * （由 AiRuntime 从持久化轨迹重建），作为 transcript 种子注入，
   * 使跨轮次/跨重启的对话对模型可见。
   */
  async run(input: AgentRunInput, signal?: AbortSignal, priorHistory?: ChatMessage[]): Promise<AgentRunResult> {
    const trace = this.injectedTrace ?? new AgentTrace(input.sessionId);
    this.lastRunTrace = trace;
    const maxIterations = this.deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const transcript: ChatMessage[] = [...(priorHistory ?? []), { role: "user", content: input.userText }];
    // detail.text 存档完整原文（summary 超 200 字截断），供 historyFromTrace 保真重建
    trace.record("user_message", input.userText, { text: input.userText });

    let iterations = 0;
    let finalText = "";
    // AC35：真实 token 用量累积（provider usage 帧跨迭代求和）
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    const usagePart = (): { usage?: TokenUsage } =>
      sawUsage ? { usage: { inputTokens, outputTokens } } : {};
    // 用量轨迹事件先于终态（done/error）落盘：活动流顺序为 …→ 用量 → 完成
    const recordUsage = (): void => {
      if (!sawUsage) return;
      trace.record("usage", `usage: in ${inputTokens} / out ${outputTokens}`, {
        inputTokens,
        outputTokens,
        providerId: this.deps.provider.config.id,
        model: this.deps.provider.config.model,
      });
    };

    for (;;) {
      if (signal?.aborted) {
        this.authorizer.denyAllPending();
        recordUsage();
        trace.record("done", "会话已取消");
        return await this.finishRun({ finishReason: "cancelled", finalText, iterations, ...usagePart() });
      }
      iterations += 1;
      if (iterations > maxIterations) {
        recordUsage();
        trace.record("done", `达到最大迭代数 ${maxIterations}，停止`);
        return await this.finishRun({ finishReason: "max_iterations", finalText, iterations: iterations - 1, ...usagePart() });
      }

      const build = await this.deps.engine.build({
        modeId: this.deps.mode.id,
        providerId: this.deps.provider.config.id,
        model: this.deps.provider.config.model,
        systemPrompt: this.deps.mode.systemPrompt,
        // 内置工具（模式声明）+ 动态工具（MCP 等，按服务器当前状态热聚合）
        tools: [...toolDefinitionsFor(this.deps.mode.tools), ...(this.deps.extraTools?.() ?? [])],
        contextPolicy: {
          ...this.deps.mode.contextPolicy,
          conversation_history: true,
          // AC28/AC38：本轮带 @附件/@符号 引用时强制打开 file_fragment 类型闸（显式引用；
          // 用户全局逐项开关仍可压过——与 conversation_history 同层，保持 AC2 总闸语义）
          ...((input.attachments !== undefined && input.attachments.length > 0) ||
          (input.symbolRefs !== undefined && input.symbolRefs.length > 0)
            ? { file_fragment: true }
            : {}),
        },
        workspaceRoot: input.workspaceRoot,
        ...(input.activeFile !== undefined ? { activeFile: input.activeFile } : {}),
        ...(input.selection !== undefined ? { selection: input.selection } : {}),
        ...(input.terminalTail !== undefined ? { terminalTail: input.terminalTail } : {}),
        conversationHistory: transcript,
        // AC19：用户意图原文作为 codebase_match 源的检索查询（恒定为本轮意图，
        // 工具回填后的后续迭代仍按原始意图检索，保证注入代码块与任务相关）
        query: input.userText,
        // AC28：@文件引用（渲染端 chips 采集的工作区相对路径）→ attachment 源注入
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        // AC38：@符号 引用（渲染端 chips 采集的符号 id）→ symbolRef 源解析注入
        ...(input.symbolRefs !== undefined ? { symbolRefs: input.symbolRefs } : {}),
      });

      let assistantText = "";
      const toolCalls: ToolCall[] = [];
      let providerCancelled = false;
      let streamError: string | null = null;

      // B-WU2：agent/pre-step 瀑布——可拒绝本轮或改写请求（改写落 request_rewrite 日志）
      let requestMessages = build.messages;
      let requestTools = build.tools;
      if (this.deps.extensions?.preStep !== undefined) {
        const decision = await this.deps.extensions.preStep({
          sessionId: input.sessionId,
          userText: input.userText,
          messages: requestMessages,
          tools: requestTools,
          iteration: iterations,
          signal,
        });
        if (decision !== undefined) {
          if (decision.kind === "reject") {
            const reason = decision.reason;
            trace.record("error", `pre-step 拒绝: ${reason}`);
            return await this.finishRun({ finishReason: "error", finalText, iterations, errorMessage: reason });
          }
          if (decision.kind === "rewrite") {
            requestMessages = decision.messages;
            requestTools = decision.tools ?? requestTools;
            // model-visible <=> logged：改写后的请求必须可溯源
            trace.record("request_rewrite", `pre-step 改写请求（iteration ${iterations}）`, {
              messages: requestMessages,
              tools: requestTools,
            });
          }
        }
      }

      try {
        for await (const event of this.deps.provider.streamChat(requestMessages, requestTools, signal)) {
          switch (event.type) {
            case "text":
              assistantText += event.text;
              this.deps.onAssistantDelta?.(event.text);
              break;
            case "tool_call":
              toolCalls.push(event.toolCall);
              break;
            case "usage":
              // AC35：真实计费量累积（与 manifest 估算计数互补，二者各自可审计）
              sawUsage = true;
              inputTokens += event.inputTokens;
              outputTokens += event.outputTokens;
              break;
            case "error":
              streamError = event.error;
              break;
            case "done":
              providerCancelled = event.stopReason === "cancelled";
              break;
          }
        }
      } catch (error) {
        if (!signal?.aborted) streamError = error instanceof Error ? error.message : String(error);
      }

      if (providerCancelled || signal?.aborted) {
        this.authorizer.denyAllPending();
        recordUsage();
        trace.record("done", "会话已取消");
        return await this.finishRun({ finishReason: "cancelled", finalText, iterations, ...usagePart() });
      }
      if (streamError !== null) {
        recordUsage();
        trace.record("error", streamError);
        return await this.finishRun({ finishReason: "error", finalText, iterations, errorMessage: streamError, ...usagePart() });
      }

      if (assistantText.length > 0) finalText = assistantText;
      transcript.push({
        role: "assistant",
        content: assistantText,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      trace.record(
        "assistant_message",
        assistantText.length > 0 ? assistantText : `（发起 ${toolCalls.length} 个工具调用）`,
        { text: assistantText, ...(toolCalls.length > 0 ? { toolCalls } : {}) }
      );

      // B-WU2：agent/step-end 串行观察者（每步触发，含工具步）
      await this.deps.extensions?.onStepEnd?.({ iteration: iterations, assistantText, toolCalls });

      if (toolCalls.length === 0) {
        recordUsage();
        trace.record("done", "任务完成");
        return await this.finishRun({ finishReason: "completed", finalText, iterations, ...usagePart() });
      }

      for (const call of toolCalls) {
        const result = await this.runOneTool(call, input.workspaceRoot, trace, signal);
        transcript.push({ role: "tool", toolCallId: call.id, content: formatToolResultContent(result) });
        if (signal?.aborted) break;
      }
    }
  }

  /** 统一出口：turn 结果确定后先触发 agent/turn-end 观察者（B-WU2），再返回。 */
  private async finishRun(result: AgentRunResult): Promise<AgentRunResult> {
    await this.deps.extensions?.onTurnEnd?.({
      finishReason: result.finishReason,
      iterations: result.iterations,
      finalText: result.finalText,
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    });
    return result;
  }

  private async runOneTool(
    call: ToolCall,
    workspaceRoot: string,
    trace: AgentTrace,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    trace.record("tool_call", `${call.name}(${summarizeArgs(call.args)})`, { tool: call.name, args: call.args });

    const ctx: ToolContext = { workspaceRoot, ...(signal ? { signal } : {}) };

    // B-WU2：tools/pre-execute 瀑布——可拒绝（记 tool_result 拒绝，跳过授权与执行）
    const pipeline = this.deps.extensions?.toolPipeline;
    if (pipeline?.preExecute !== undefined) {
      const veto = await pipeline.preExecute(call, ctx);
      if (veto?.deny !== undefined) {
        const denied: ToolResult = { ok: false, output: "", error: veto.deny };
        trace.record("tool_result", `${call.name} 被管线拒绝`, { result: denied });
        return denied;
      }
    }

    // 授权门：内置写工具（write/edit/bash）与全部 MCP 工具（AC17）执行前必经裁决
    if (this.authorizer.needsAuthorization(call.name)) {
      const reason = buildAuthorizationReason(call.name, call.args);
      if (this.authorizer.isAutoApproved(call.name, call.args)) {
        // AC29：命令白名单命中——不弹窗，但轨迹显式记录自动放行（审计可见）
        trace.record("authorization_auto", `${call.name}: ${reason}`, {
          toolName: call.name,
          args: call.args,
          reason,
          source: "whitelist",
        });
      } else {
        const { request, decision } = await this.authorizer.requestAuthorization(
          call.name,
          call.args,
          reason,
          (req) => {
            trace.record("authorization_request", `${call.name}: ${reason}`, {
              requestId: req.id,
              toolName: call.name,
              args: call.args,
              reason,
            });
          }
        );
        trace.record("authorization_decision", `${call.name} → ${decision}`, { requestId: request.id, decision });
        if (decision === "deny") {
          const denied: ToolResult = { ok: false, output: "", error: "用户拒绝授权，工具未执行" };
          trace.record("tool_result", `${call.name} 被用户拒绝`, { result: denied });
          return denied;
        }
      }
    }

    const result = isAgentToolName(call.name)
      ? await executeTool(call, this.deps.env, ctx)
      : await this.executeExternal(call, ctx);
    // B-WU2：tools/post-execute 观察者（不能改结果，只观察）
    if (pipeline?.postExecute !== undefined) await pipeline.postExecute(call, result, ctx);
    trace.record(
      "tool_result",
      result.ok ? `${call.name} 成功` : `${call.name} 失败: ${result.error ?? "未知错误"}`,
      { result }
    );
    await this.refreshDiagnostics(call.name, result, workspaceRoot, trace);
    return result;
  }

  /**
   * AC30 诊断回馈：write/edit 成功改写文件后刷新 tsc 快照并落轨迹事件。
   * 用户经上下文面板关掉 diagnostics 类型时完全跳过（不白跑 tsc）；
   * 下一轮 engine.build 由诊断源把快照注入请求——模型看到自己引入的编译错误。
   */
  private async refreshDiagnostics(
    toolName: string,
    result: ToolResult,
    workspaceRoot: string,
    trace: AgentTrace
  ): Promise<void> {
    const tracker = this.deps.diagnostics;
    if (tracker === undefined || !tracker.available) return;
    if (!result.ok || (toolName !== "write" && toolName !== "edit")) return;
    if (this.deps.engine.getPolicyView(this.deps.mode.contextPolicy)["diagnostics"] !== true) return;
    const count = await tracker.refresh(workspaceRoot);
    const entries = tracker.getLatest().slice(0, 20);
    trace.record(
      "diagnostics",
      count === 0 ? "诊断：无问题" : `诊断：${count} 个问题（${entries[0]?.file ?? ""}:${entries[0]?.line ?? 0} 起）`,
      { count, entries, trigger: toolName }
    );
  }

  /** 非内置工具（MCP 等）执行：经注入路由；未注入时报未知工具（不静默吞掉）。 */
  private async executeExternal(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    if (this.deps.executeExtraTool === undefined) {
      return { ok: false, output: "", error: `未知工具: ${call.name}` };
    }
    try {
      return await this.deps.executeExtraTool(call, ctx);
    } catch (error) {
      return { ok: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  }
}
