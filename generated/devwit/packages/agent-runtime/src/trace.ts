import type { AgentTraceEvent, AgentTraceEventType, ChatMessage, ToolCall } from "@devwit/contracts";

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
 */
export function historyFromTrace(events: AgentTraceEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const event of events) {
    const detail = event.detail as { text?: unknown; toolCalls?: unknown; subagentId?: unknown } | undefined;
    if (typeof detail?.subagentId === "string") continue;
    const fullText = typeof detail?.text === "string" ? detail.text : undefined;
    if (event.type === "user_message") {
      messages.push({ role: "user", content: fullText ?? event.summary });
    } else if (event.type === "assistant_message") {
      const toolCalls = Array.isArray(detail?.toolCalls) ? (detail.toolCalls as ToolCall[]) : undefined;
      messages.push({
        role: "assistant",
        content: fullText ?? event.summary,
        ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
      });
    }
  }
  return messages;
}
