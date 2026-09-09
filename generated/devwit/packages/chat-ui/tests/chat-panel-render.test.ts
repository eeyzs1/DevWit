/**
 * chat-panel 增量渲染对账纯函数测试（v0.7.3）：
 * 位置 + 引用 + 内容签名三元组判定——流式 delta 只追加/原位更新，
 * 结构断裂回退全量重建。DOM 行为由 E2E 冒烟覆盖，此处锁定对账逻辑。
 */
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../src/chat-controller.js";
import { chatItemSignature, planIncrementalRender } from "../src/chat-panel.js";

function planFor(prev: ChatItem[], prevSigs: string[], items: ChatItem[]) {
  return planIncrementalRender(prev, prevSigs, items, chatItemSignature);
}

describe("planIncrementalRender（增量对账）", () => {
  it("初始空 → 追加全部：appendCount=N，无更新", () => {
    const items: ChatItem[] = [
      { kind: "user", text: "你好" },
      { kind: "assistant", text: "你好！", streaming: true },
    ];
    expect(planFor([], [], items)).toEqual({ mode: "incremental", appendCount: 2, updateIndexes: [] });
  });

  it("流式 delta（既有行原位变更 + 追加新行）：appendCount 与 updateIndexes 分别给出", () => {
    const user: ChatItem = { kind: "user", text: "写个函数" };
    const assistant: ChatItem = { kind: "assistant", text: "好的", streaming: true };
    const prevSigs = [chatItemSignature(user), chatItemSignature(assistant)];
    // delta：assistant 文本原位增长（同一对象引用），尾部新增 tool 行
    assistant.text = "好的，我来写";
    const tool: ChatItem = { kind: "tool", summary: "read a.ts", ok: null };
    const items = [user, assistant, tool];
    const plan = planFor([user, assistant], prevSigs, items);
    expect(plan).toEqual({ mode: "incremental", appendCount: 1, updateIndexes: [1] });
  });

  it("流式结束（streaming true→false，引用不变）：该行进入 updateIndexes", () => {
    const assistant: ChatItem = { kind: "assistant", text: "完成", streaming: true };
    const sigs = [chatItemSignature(assistant)];
    assistant.streaming = false;
    expect(planFor([assistant], sigs, [assistant])).toEqual({
      mode: "incremental",
      appendCount: 0,
      updateIndexes: [0],
    });
  });

  it("授权裁决落定（decision null→allow，引用不变）：进入 updateIndexes", () => {
    const auth: ChatItem = {
      kind: "authorization",
      requestId: "r1",
      toolName: "write",
      reason: "写文件",
      decision: null,
    };
    const sigs = [chatItemSignature(auth)];
    auth.decision = "allow";
    expect(planFor([auth], sigs, [auth]).updateIndexes).toEqual([0]);
  });

  it("长度回退（清空会话/换会话）→ rebuild", () => {
    const a: ChatItem = { kind: "user", text: "a" };
    const b: ChatItem = { kind: "user", text: "b" };
    expect(planFor([a, b], ["{}", "{}"], [a])).toEqual({ mode: "rebuild" });
  });

  it("前缀引用错位（同长度但对象被替换，如历史重放）→ rebuild", () => {
    const a: ChatItem = { kind: "user", text: "a" };
    const a2: ChatItem = { kind: "user", text: "a" }; // 内容相同但引用不同
    expect(planFor([a], [chatItemSignature(a)], [a2])).toEqual({ mode: "rebuild" });
  });

  it("无变化：零追加零更新（重复 render 幂等）", () => {
    const a: ChatItem = { kind: "done", text: "完成" };
    const sigs = [chatItemSignature(a)];
    expect(planFor([a], sigs, [a])).toEqual({ mode: "incremental", appendCount: 0, updateIndexes: [] });
  });
});

describe("chatItemSignature（内容签名）", () => {
  it("同内容同签名；任一字段变化即不同", () => {
    const a: ChatItem = { kind: "assistant", text: "x", streaming: true };
    const b: ChatItem = { kind: "assistant", text: "x", streaming: true };
    expect(chatItemSignature(a)).toBe(chatItemSignature(b));
    b.streaming = false;
    expect(chatItemSignature(a)).not.toBe(chatItemSignature(b));
  });
});
