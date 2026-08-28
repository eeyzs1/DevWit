import type { AgentTraceEvent, AgentTraceEventType } from "@devwit/contracts";
import { historyFromTrace } from "./session-log.js";

/** 兼容再导出（B-WU1）：投影算法已迁至 session-log.deriveMessages。 */
export { historyFromTrace, deriveMessages, assertModelVisibleLogged, freezeEvents, assertAppendOnly } from "./session-log.js";

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

// historyFromTrace / deriveMessages / assertModelVisibleLogged / freezeEvents /
// assertAppendOnly 的实现位于 session-log.ts（B-WU1，"model-visible <=> logged"）。
// 本文件保留 AgentTrace 实时轨迹类与上述函数的兼容导出。
