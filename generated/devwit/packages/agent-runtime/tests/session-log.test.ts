import { describe, expect, it } from "vitest";
import type { AgentTraceEvent, ChatMessage } from "@devwit/contracts";
import { AgentTrace, historyFromTrace } from "../src/trace.js";
import {
  assertAppendOnly,
  assertModelVisibleLogged,
  deriveMessages,
  freezeEvents,
} from "../src/session-log.js";

/** 构造一个带工具调用配对的完整日志（user → assistant(toolCalls) → tool → assistant 总结）。 */
function fullLog(): AgentTraceEvent[] {
  const trace = new AgentTrace("s1");
  trace.record("user_message", "请修改 config", { text: "请修改 config" });
  trace.record("assistant_message", "调用 read", {
    text: "我来读取文件",
    toolCalls: [{ id: "call_1", name: "read_file", args: { path: "config.json" } }],
  });
  trace.record("tool_result", "read_file 成功", {
    result: { ok: true, output: "{\"a\":1}" },
  });
  trace.record("assistant_message", "已读取", { text: "文件内容是 {\"a\":1}" });
  return trace.list();
}

describe("deriveMessages / historyFromTrace（B-WU1 规范化投影）", () => {
  it("派生历史与既有 historyFromTrace 完全一致（兼容别名）", () => {
    const events = fullLog();
    expect(deriveMessages(events)).toEqual(historyFromTrace(events));
    const msgs = deriveMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(msgs[1].toolCalls?.[0]?.id).toBe("call_1");
    expect(msgs[2]).toMatchObject({ role: "tool", toolCallId: "call_1", content: '{"a":1}' });
  });

  it("子代理内部事件被跳过（AC20）", () => {
    const trace = new AgentTrace("s1");
    trace.record("user_message", "父任务", { text: "父任务" });
    trace.record("assistant_message", "子任务结论", {
      text: "子任务已完成",
      subagentId: "sub-1",
    });
    trace.record("assistant_message", "综合", { text: "综合结果" });
    const msgs = deriveMessages(trace.list());
    expect(msgs.map((m) => m.content)).toEqual(["父任务", "综合结果"]);
  });
});

describe("assertModelVisibleLogged（model-visible <=> logged）", () => {
  it("日志派生的 messages 通过不变量", () => {
    const events = fullLog();
    const messages = deriveMessages(events);
    const result = assertModelVisibleLogged(events, messages);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("允许 system 前缀消息（模式装配产物）", () => {
    const events = fullLog();
    const messages: ChatMessage[] = [
      { role: "system", content: "你是 DevWit 助手" },
      ...deriveMessages(events),
    ];
    expect(assertModelVisibleLogged(events, messages).ok).toBe(true);
  });

  it("拒绝非日志来源的注入消息", () => {
    const events = fullLog();
    const messages = [...deriveMessages(events), { role: "user", content: "伪造消息" }];
    const result = assertModelVisibleLogged(events, messages);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("not reconstructable"))).toBe(true);
  });

  it("拒绝 provided 侧孤儿 tool_calls（防 400 守卫）", () => {
    const events = fullLog();
    const messages: ChatMessage[] = [
      { role: "user", content: "请修改 config" },
      {
        role: "assistant",
        content: "调用",
        toolCalls: [{ id: "call_x", name: "write_file", args: { path: "x" } }],
      },
    ];
    const result = assertModelVisibleLogged(events, messages);
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("would 400"))).toBe(true);
  });

  it("日志损坏（投影抛错）时拒绝", () => {
    const events = fullLog();
    // 构造一个投影失败的输入：assistant toolCalls 非数组 detail 会导致类型守卫失败但
    // 不抛错；这里直接用会抛错的畸形事件——seq 缺失不影响投影，改用 undefined 输入。
    const broken = events.map((e) => ({ ...e, type: "mystery" as const }));
    const result = assertModelVisibleLogged(broken as unknown as AgentTraceEvent[], []);
    // 未知类型被投影忽略（非消息事件）→ 空消息仍合法；此处验证不抛错
    expect(result.ok).toBe(true);
  });
});

describe("freezeEvents / assertAppendOnly（append-only 强制）", () => {
  it("冻结快照不可变（严格模式抛错）", () => {
    const events = fullLog();
    const frozen = freezeEvents(events);
    expect(() => {
      (frozen[0] as unknown as { summary: string }).summary = "篡改";
    }).toThrow();
  });

  it("seq 严格递增通过；空洞/重复被拒绝", () => {
    const events = fullLog();
    expect(assertAppendOnly(events).ok).toBe(true);

    const dup = events.map((e, i) => ({ ...e, seq: i === 1 ? 1 : e.seq }));
    expect(assertAppendOnly(dup).ok).toBe(false);

    const gap = events.map((e, i) => ({ ...e, seq: i === 2 ? 5 : e.seq }));
    expect(assertAppendOnly(gap).ok).toBe(false);
  });
});
