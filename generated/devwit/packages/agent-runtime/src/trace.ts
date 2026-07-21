import type { AgentTraceEvent, AgentTraceEventType } from "@devwit/contracts";

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
