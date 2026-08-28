/**
 * 轨迹时间线纯函数测试（迭代 27 / AC36）：
 * filterTraceEvents（类型过滤/失败判定）/ deltaMs（相邻耗时）/ TRACE_TYPE_KEY（类型全覆盖）。
 * DOM 组件不在 node 环境测试（vitest environment: node），只覆盖导出纯函数。
 */
import type { AgentTraceEvent, AgentTraceEventType } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { deltaMs, filterTraceEvents, TRACE_TYPE_KEY } from "../src/trace-timeline.js";

let seq = 0;
function event(type: AgentTraceEventType, detail?: unknown): AgentTraceEvent {
  seq += 1;
  return {
    sessionId: "s-1",
    seq,
    timestamp: new Date(seq * 1000).toISOString(),
    type,
    summary: `${type} 摘要`,
    ...(detail !== undefined ? { detail } : {}),
  };
}

describe("filterTraceEvents（AC36 类型过滤）", () => {
  const events: AgentTraceEvent[] = [
    event("user_message"),
    event("assistant_message"),
    event("tool_call"),
    event("tool_result", { result: { ok: true } }),
    event("authorization_request"),
    event("authorization_decision", { decision: "allow" }),
    event("authorization_auto"),
    event("usage"),
    event("error"),
  ];

  it("all 返回全部且保持原序", () => {
    const out = filterTraceEvents(events, "all");
    expect(out).toHaveLength(events.length);
    expect(out.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
  });

  it("messages 只含用户/助手消息", () => {
    expect(filterTraceEvents(events, "messages").map((e) => e.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
  });

  it("tools 只含工具调用与结果", () => {
    expect(filterTraceEvents(events, "tools").map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
  });

  it("authorization 含请求/裁决/自动放行三类", () => {
    expect(filterTraceEvents(events, "authorization").map((e) => e.type)).toEqual([
      "authorization_request",
      "authorization_decision",
      "authorization_auto",
    ]);
  });

  it("usage 只含用量事件", () => {
    expect(filterTraceEvents(events, "usage").map((e) => e.type)).toEqual(["usage"]);
  });

  it("failures 走 isFailureTraceEvent 同规则：error / 工具失败 / 授权拒绝", () => {
    const mixed: AgentTraceEvent[] = [
      event("user_message"),
      event("error"),
      event("tool_result", { result: { ok: false } }),
      event("tool_result", { result: { ok: true } }),
      event("authorization_decision", { decision: "deny" }),
      event("authorization_decision", { decision: "allow" }),
    ];
    const out = filterTraceEvents(mixed, "failures");
    expect(out.map((e) => e.type)).toEqual(["error", "tool_result", "authorization_decision"]);
  });

  it("空数组输入各过滤器均返回空", () => {
    for (const filter of ["all", "messages", "tools", "authorization", "usage", "failures"] as const) {
      expect(filterTraceEvents([], filter)).toEqual([]);
    }
  });
});

describe("deltaMs（AC36 相邻事件耗时）", () => {
  it("正常递增时间戳返回毫秒差", () => {
    expect(deltaMs("2026-07-26T10:00:00.000Z", "2026-07-26T10:00:00.250Z")).toBe(250);
  });

  it("相同时间戳返回 0", () => {
    expect(deltaMs("2026-07-26T10:00:00.000Z", "2026-07-26T10:00:00.000Z")).toBe(0);
  });

  it("乱序（next 早于 prev）返回 null——UI 不显示负耗时", () => {
    expect(deltaMs("2026-07-26T10:00:01.000Z", "2026-07-26T10:00:00.000Z")).toBeNull();
  });

  it("非法时间戳任一即返回 null", () => {
    expect(deltaMs("not-a-date", "2026-07-26T10:00:00.000Z")).toBeNull();
    expect(deltaMs("2026-07-26T10:00:00.000Z", "")).toBeNull();
  });
});

describe("TRACE_TYPE_KEY（AC36 类型徽标词典键）", () => {
  it("覆盖全部 19 种 AgentTraceEventType（防新增类型漏配文案）", () => {
    const ALL_TYPES: AgentTraceEventType[] = [
      "user_message",
      "assistant_message",
      "assistant_delta",
      "tool_call",
      "authorization_request",
      "authorization_decision",
      "authorization_auto",
      "tool_result",
      "diagnostics",
      "route",
      "workflow",
      "request_rewrite",
      "mode_recommend",
      "usage",
      "plan",
      "subagent_start",
      "subagent_done",
      "error",
      "done",
    ];
    for (const type of ALL_TYPES) {
      expect(TRACE_TYPE_KEY[type]).toBe(`trace.type.${type}`);
    }
    expect(Object.keys(TRACE_TYPE_KEY)).toHaveLength(ALL_TYPES.length);
  });
});
