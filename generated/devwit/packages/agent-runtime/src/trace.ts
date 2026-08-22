import type { AgentTraceEvent, AgentTraceEventType, ChatMessage, ToolCall, ToolResult } from "@devwit/contracts";

/** 轨迹一行摘要的长度上限（detail 保留完整结构化数据）。 */
const SUMMARY_MAX_CHARS = 200;

/**
 * AgentTrace：一次 agent 会话的事件轨迹（AC4"执行轨迹可见"）。
 * 事件单调追加、seq 自增；onRecord 供 apps 层实时推送（agent:event IPC）。
 * AR005：本包不接触凭证——密钥只在 llm-providers 内解析，轨迹中永不出现。
 */
export class AgentTrace {
  readonly sessionId: string;
  private readonly events: AgentTraceEvent[] = [];
  private readonly listeners = new Set<(event: AgentTraceEvent) => void>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  record(type: AgentTraceEventType, summary: string, detail?: unknown): AgentTraceEvent {
    const event: AgentTraceEvent = {
      seq: this.events.length + 1,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      type,
      summary: summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary,
      ...(detail !== undefined ? { detail } : {}),
    };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  list(): AgentTraceEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  /**
   * 载入磁盘持久化的事件（迭代 6 / AC15）：重启后水合历史轨迹。
   * 不触发 onRecord——这些是历史事件，不是新记录；seq 以事件自带值为准，
   * 后续 record() 依 events.length 续排，保持单调。
   */
  loadPersisted(events: AgentTraceEvent[]): void {
    for (const event of events) {
      if (typeof event?.seq !== "number" || typeof event?.type !== "string") continue;
      this.events.push(event);
    }
  }

  get length(): number {
    return this.events.length;
  }

  onRecord(listener: (event: AgentTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * 从轨迹事件重建 LLM 对话历史（迭代 6 / AC15 会话持久化）：
 * user_message / assistant_message 按序映射为 ChatMessage；assistant 携带的
 * toolCalls 一并恢复。正文优先取 detail.text（完整文本），缺省回退 summary
 * （summary 超 200 字被截断，仅作兜底）。其余事件类型不构成对话消息，跳过。
 * AC20：带 detail.subagentId 的事件是子 Agent 内部轨迹（编排结果已由父级
 * 综合消息承载），跳过以避免子任务细节污染下一轮对话历史。
 *
 * 修复（AC37 会话历史复用）：assistant 的 tool_calls 之后必须重建 role="tool"
 * 回填消息——否则 next-turn 请求会因 "assistant message with 'tool_calls'
 * must be followed by tool messages" 被 OpenAI/DeepSeek 判 400。trace 里
 * assistant_message(toolCalls) 之后按序出现 tool_result 事件；依序配对：
 * 第 i 个 tool_result 对应 assistant.toolCalls[i]，tool_call_id 取 call.id，
 * content 复用 formatToolResultContent 的产物语义（success→output，失败→错误说明）。
 */
export function historyFromTrace(events: AgentTraceEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingToolCalls: ToolCall[] | undefined = undefined;
  let consumedResults = 0;
  for (const event of events) {
    const detail = event.detail as { text?: unknown; toolCalls?: unknown; subagentId?: unknown; result?: unknown; tool?: unknown } | undefined;
    if (typeof detail?.subagentId === "string") continue;
    const fullText = typeof detail?.text === "string" ? detail.text : undefined;
    if (event.type === "user_message") {
      // 兜底：上一条 assistant 带 tool_calls 而无结果配对（异常时序）→ 先复位，防泄漏到新一轮
      if (pendingToolCalls !== undefined) {
        for (const call of pendingToolCalls) {
          messages.push({ role: "tool", toolCallId: call.id, content: "(工具结果缺失)" });
        }
        pendingToolCalls = undefined;
        consumedResults = 0;
      }
      messages.push({ role: "user", content: fullText ?? event.summary });
    } else if (event.type === "assistant_message") {
      const toolCalls = Array.isArray(detail?.toolCalls) ? (detail.toolCalls as ToolCall[]) : undefined;
      messages.push({
        role: "assistant",
        content: fullText ?? event.summary,
        ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
      });
      pendingToolCalls = toolCalls !== undefined && toolCalls.length > 0 ? toolCalls : undefined;
      consumedResults = 0;
    } else if (event.type === "tool_result" && pendingToolCalls !== undefined) {
      // 依序配对：第 consumedResults 个 tool_result ← 第 consumedResults 个 tool_call
      const call = pendingToolCalls[consumedResults];
      if (call !== undefined) {
        const result = (detail?.result ?? { ok: false, output: "" }) as ToolResult;
        const content =
          result.ok === true
            ? result.output.length > 0 ? result.output : "(无输出)"
            : `错误: ${result.error ?? "未知错误"}`;
        messages.push({ role: "tool", toolCallId: call.id, content });
        consumedResults += 1;
        if (consumedResults >= pendingToolCalls.length) pendingToolCalls = undefined;
      }
    }
  }
  // 末尾兜底：trailing assistant tool_calls 无配对结果时补 tool 消息，避免 next-turn 400
  if (pendingToolCalls !== undefined) {
    const trailing = pendingToolCalls;
    for (let i = consumedResults; i < trailing.length; i += 1) {
      const call = trailing[i];
      if (call === undefined) continue;
      messages.push({ role: "tool", toolCallId: call.id, content: "(工具结果缺失)" });
    }
  }
  return messages;
}
