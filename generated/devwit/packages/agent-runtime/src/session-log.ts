import type { AgentTraceEvent, ChatMessage, ToolCall, ToolResult } from "@devwit/contracts";

/**
 * 会话日志派生与不变量（Fusion Plan v3 — B-WU1）。
 *
 * 原则（借鉴 DeepSeek Harness "model-visible <=> logged"）：模型可见的历史是
 * 会话事件日志的 DERIVED 投影，不是独立维护的数组。本模块提供：
 *
 * - `deriveMessages(events)` —— 唯一规范化投影：日志 → 模型可见历史
 *   （原 historyFromTrace 的算法迁入；historyFromTrace 保留为兼容别名）。
 * - `assertModelVisibleLogged(events, messages)` —— 运行时不变量：任何进入
 *   模型请求的消息必须能从日志重建（防 400：assistant tool_calls 必有配对 tool 消息；
 *   防伪造：非日志来源的消息被拒绝）。
 * - `freezeEvents(events)` —— 不可变快照：append-only 语义的强制面。
 */

/** 日志 → 模型可见历史的唯一投影路径（原 historyFromTrace 算法，语义不变）。 */
export function deriveMessages(events: AgentTraceEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let pendingToolCalls: ToolCall[] | undefined = undefined;
  let consumedResults = 0;
  for (const event of events) {
    const detail = event.detail as
      | { text?: unknown; toolCalls?: unknown; subagentId?: unknown; result?: unknown; tool?: unknown }
      | undefined;
    // 子 Agent 内部轨迹（AC20）：编排结果已由父级综合消息承载，跳过以免污染历史。
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
            ? result.output.length > 0
              ? result.output
              : "(无输出)"
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

/** 兼容别名：历史调用方（trace.js 导出 / ai-runtime）继续可用。 */
export { deriveMessages as historyFromTrace };

/**
 * 运行时不变量 "model-visible <=> logged"（B-WU1）：
 * 进入模型请求的 messages 必须能从会话日志派生。
 *
 * 检查：
 *  1. 投影确定性：deriveMessages(events) 可稳定重放（不抛、结果固定）。
 *  2. 无孤儿 tool_calls：derived 与 provided 中每个 assistant.toolCalls 的
 *     call.id 都有配对 tool 消息（防 400：assistant tool_calls 必须紧跟 tool 消息）。
 *  3. 每条提供消息可溯源：provided 中 role=user/assistant/tool 的消息在
 *     derived 中存在同 role + 同 toolCallId（tool）且 content 一致的消息
 *     （按事件序逐条对齐；system 消息是模式装配产物，不要求来自日志）。
 *
 * 返回 {ok, reasons}；ok=false 时调用方必须拒绝将该 messages 发往模型。
 */
export function assertModelVisibleLogged(
  events: AgentTraceEvent[],
  messages: ChatMessage[],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  let derived: ChatMessage[];
  try {
    derived = deriveMessages(events);
  } catch (err) {
    return { ok: false, reasons: [`deriveMessages failed: ${String(err)}`] };
  }

  // 2. 无孤儿 tool_calls（derived 侧）
  for (const msg of derived) {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const paired = derived.some(
        (m) => m.role === "tool" && m.toolCallId !== undefined && msg.toolCalls!.some((c) => c.id === m.toolCallId),
      );
      if (!paired) {
        reasons.push(`derived history has orphan tool_calls: ${msg.toolCalls.map((c) => c.id).join(",")}`);
      }
    }
  }

  // 2b. 无孤儿 tool_calls（provided 侧）：发送前守卫——assistant tool_calls
  // 必须紧跟配对 tool 消息，否则 OpenAI/DeepSeek 判 400。
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      for (const call of msg.toolCalls) {
        const paired = messages.some(
          (m) => m.role === "tool" && m.toolCallId === call.id,
        );
        if (!paired) {
          reasons.push(`provided message has orphan tool_call id=${call.id} (name=${call.name}) — would 400`);
        }
      }
    }
  }

  // 3. provided ⊆ derived（按序对齐；跳过 system）
  const providedIdx: ChatMessage[] = messages.filter((m) => m.role !== "system");
  const logIdx = new Map<string, number>(); // role:toolCallId|content -> count
  for (const m of derived) {
    const key = m.role === "tool" ? `tool:${m.toolCallId ?? ""}` : `${m.role}:${m.content}`;
    logIdx.set(key, (logIdx.get(key) ?? 0) + 1);
  }
  for (const m of providedIdx) {
    const key = m.role === "tool" ? `tool:${m.toolCallId ?? ""}` : `${m.role}:${m.content}`;
    const n = logIdx.get(key) ?? 0;
    if (n <= 0) {
      reasons.push(`message not reconstructable from log: role=${m.role} ${m.role === "tool" ? `toolCallId=${m.toolCallId}` : `content=${m.content.slice(0, 60)}`}`);
    } else {
      logIdx.set(key, n - 1);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** 不可变快照：深层冻结事件数组，使 append-only 在运行时层面被强制。 */
export function freezeEvents(events: AgentTraceEvent[]): readonly AgentTraceEvent[] {
  return Object.freeze(events.map((e) => Object.freeze({ ...e })));
}

/** 校验一组事件满足 append-only 契约（seq 严格递增、无重复、无空洞）。 */
export function assertAppendOnly(events: readonly AgentTraceEvent[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let prev = 0;
  for (const ev of events) {
    if (typeof ev?.seq !== "number" || ev.seq <= prev) {
      reasons.push(`seq not strictly increasing: ${String(ev?.seq)} after ${prev}`);
      break;
    }
    prev = ev.seq;
  }
  return { ok: reasons.length === 0, reasons };
}
