import type { AgentTraceEvent } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { AgentTrace, historyFromTrace } from "../src/trace.js";

/**
 * AgentTrace 持久化水合 + historyFromTrace（迭代 6 / AC15 会话持久化）单元测试。
 * 覆盖：loadPersisted 不触发监听/容忍坏行/seq 续排；historyFromTrace 全文优先与
 * toolCalls 恢复。事件对象自写替身（磁盘 JSONL 解析结果即此形状）。
 */
let seq = 0;
function event(type: AgentTraceEvent["type"], summary: string, detail?: unknown): AgentTraceEvent {
  seq += 1;
  return {
    seq,
    timestamp: new Date().toISOString(),
    sessionId: "s1",
    type,
    summary,
    ...(detail !== undefined ? { detail } : {}),
  };
}

describe("AgentTrace.loadPersisted", () => {
  it("水合历史事件但不触发 onRecord（历史非新记录）", () => {
    const trace = new AgentTrace("s1");
    const received: AgentTraceEvent[] = [];
    trace.onRecord((e) => received.push(e));
    trace.loadPersisted([event("user_message", "旧消息"), event("done", "完成")]);
    expect(trace.length).toBe(2);
    expect(received).toHaveLength(0);
  });

  it("跳过缺 seq/type 的坏行，其余正常载入", () => {
    const trace = new AgentTrace("s1");
    trace.loadPersisted([
      event("user_message", "好行"),
      { summary: "没有 seq 和 type" } as AgentTraceEvent,
      event("assistant_message", "也好"),
    ]);
    expect(trace.list().map((e) => e.type)).toEqual(["user_message", "assistant_message"]);
  });

  it("水合后 record 的 seq 依 events.length 续排，保持单调", () => {
    const trace = new AgentTrace("s1");
    trace.loadPersisted([event("user_message", "一"), event("assistant_message", "二")]);
    const next = trace.record("done", "三");
    expect(next.seq).toBe(3);
  });
});

describe("historyFromTrace", () => {
  it("user/assistant 按序映射为 ChatMessage，跳过工具与终态事件", () => {
    const messages = historyFromTrace([
      event("user_message", "第一问", { text: "第一问" }),
      event("assistant_message", "第一答", { text: "第一答" }),
      event("tool_call", 'read({"path":"a.ts"})'),
      event("tool_result", "read 成功"),
      event("user_message", "第二问", { text: "第二问" }),
      event("done", "完成"),
    ]);
    expect(messages).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ]);
  });

  it("正文优先 detail.text（完整原文）；缺失时回退 summary", () => {
    const messages = historyFromTrace([
      // 旧格式轨迹：detail 无 text，正文只能取（可能截断的）summary
      event("user_message", "旧摘要"),
      event("assistant_message", "旧答复"),
    ]);
    expect(messages).toEqual([
      { role: "user", content: "旧摘要" },
      { role: "assistant", content: "旧答复" },
    ]);
  });

  it("assistant 携带的 toolCalls 一并恢复；无 toolCalls 不挂字段", () => {
    const toolCalls = [{ id: "tc1", name: "write", args: { path: "a.ts" } }];
    const messages = historyFromTrace([
      event("assistant_message", "调用工具", { text: "调用工具", toolCalls }),
      event("assistant_message", "纯文本", { text: "纯文本", toolCalls: [] }),
    ]);
    expect(messages[0]).toEqual({ role: "assistant", content: "调用工具", toolCalls });
    expect(messages[1]).toEqual({ role: "assistant", content: "纯文本" });
  });
});
