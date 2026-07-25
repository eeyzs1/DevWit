import path from "node:path";
import type { AgentRunInput, ModeDefinition, StreamEvent } from "@devwit/contracts";
import { attachmentSource, ContextEngine } from "@devwit/context-engine";
import { describe, expect, it } from "vitest";
import { AgentLoop, type AgentLoopDeps } from "../src/agent-loop.js";
import { Authorizer } from "../src/authorizer.js";
import { AgentTrace } from "../src/trace.js";
import { MemoryEnvironment, ScriptedProvider } from "./helpers.js";

const ROOT = path.resolve("ws-loop");

const MODE: ModeDefinition = {
  id: "agent",
  name: "Agent",
  description: "测试模式",
  systemPrompt: "你是测试 Agent。",
  tools: ["read", "write", "bash"],
  providerId: "p-test",
  contextPolicy: {},
  builtin: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const INPUT: AgentRunInput = {
  sessionId: "s1",
  userText: "创建文件并运行脚本",
  modeId: "agent",
  workspaceRoot: ROOT,
};

function textThenDone(text: string): StreamEvent[] {
  return [
    { type: "text", text },
    { type: "done", stopReason: "end_turn" },
  ];
}

function toolCallThenDone(id: string, name: string, args: Record<string, unknown>): StreamEvent[] {
  return [
    { type: "tool_call", toolCall: { id, name, args } },
    { type: "done", stopReason: "tool_use" },
  ];
}

interface Harness {
  loop: AgentLoop;
  provider: ScriptedProvider;
  env: MemoryEnvironment;
  engine: ContextEngine;
  trace: AgentTrace;
}

function makeHarness(scripts: StreamEvent[][], overrides: Partial<AgentLoopDeps> = {}): Harness {
  const provider = new ScriptedProvider(scripts);
  const env = new MemoryEnvironment(ROOT, { "a.txt": "文件内容 alpha" });
  const engine = new ContextEngine({ sessionId: "s1" });
  const trace = new AgentTrace("s1");
  const loop = new AgentLoop({ provider, engine, mode: MODE, env, trace, ...overrides });
  return { loop, provider, env, engine, trace };
}

describe("AgentLoop", () => {
  it("纯文本响应：一轮完成，轨迹完整，manifest 落引擎", async () => {
    const { loop, provider, engine, trace } = makeHarness([textThenDone("好的，明白了。")]);
    const result = await loop.run(INPUT);
    expect(result).toMatchObject({ finishReason: "completed", finalText: "好的，明白了。", iterations: 1 });

    expect(trace.list().map((event) => event.type)).toEqual(["user_message", "assistant_message", "done"]);
    expect(engine.getLatestManifest()?.modeId).toBe("agent");

    // 上下文组成：system 在最前，transcript（含用户消息）随请求发出
    const messages = provider.calls[0]?.messages ?? [];
    expect(messages[0]).toEqual({ role: "system", content: "你是测试 Agent。" });
    expect(messages.some((m) => m.role === "user" && m.content === "创建文件并运行脚本")).toBe(true);
    expect(provider.calls[0]?.tools.map((t) => t.name)).toEqual(["read", "write", "bash"]);
  });

  it("AC28：@附件注入——file_fragment 强制打开、独立 key 项入 manifest、内容进请求", async () => {
    const { loop, provider, engine, env } = makeHarness([textThenDone("看完附件了。")]);
    engine.registerSource(attachmentSource(async (filePath) => env.readFile(path.resolve(ROOT, filePath))));
    const result = await loop.run({ ...INPUT, attachments: ["a.txt"] });
    expect(result.finishReason).toBe("completed");

    // 附件内容以「## 引用文件 <路径>」段进入用户上下文消息（file_fragment 默认关→附件强制打开）
    const contextMessage = provider.calls[0]?.messages.find(
      (m) => m.role === "user" && m.content.includes("## 引用文件 a.txt")
    );
    expect(contextMessage?.content).toContain("文件内容 alpha");

    // manifest 审计：attachment:a.txt 为稳定 key 的独立项，enabled 且 token 精确计数
    const manifest = engine.getLatestManifest();
    const attachmentItem = manifest?.items.find((item) => item.key === "attachment:a.txt");
    expect(attachmentItem).toMatchObject({ type: "file_fragment", enabled: true, source: "attachment" });
    expect(attachmentItem?.tokens).toBeGreaterThan(0);
  });

  it("AC28：附件逐项剔除（itemOverride）→ 该项零注入但 manifest 保留可见条目", async () => {
    const { loop, provider, engine, env } = makeHarness([textThenDone("附件已剔除。")]);
    engine.registerSource(attachmentSource(async (filePath) => env.readFile(path.resolve(ROOT, filePath))));
    engine.setItemOverride("attachment:a.txt", false);
    await loop.run({ ...INPUT, attachments: ["a.txt"] });

    const messages = provider.calls[0]?.messages ?? [];
    expect(messages.some((m) => m.content.includes("文件内容 alpha"))).toBe(false);
    const item = engine.getLatestManifest()?.items.find((entry) => entry.key === "attachment:a.txt");
    expect(item).toMatchObject({ enabled: false, tokens: 0, content: "" });
  });

  it("AC28：无附件时 file_fragment 保持默认关闭，不注入活动文件之外的内容", async () => {
    const { loop, provider, engine, env } = makeHarness([textThenDone("无附件。")]);
    engine.registerSource(attachmentSource(async (filePath) => env.readFile(path.resolve(ROOT, filePath))));
    await loop.run(INPUT);
    const messages = provider.calls[0]?.messages ?? [];
    expect(messages.some((m) => m.content.includes("引用文件"))).toBe(false);
    expect(engine.getLatestManifest()?.items.some((item) => item.key?.startsWith("attachment:"))).not.toBe(true);
  });

  it("工具循环：read 免授权直接执行，结果回填后第二轮完成", async () => {
    const { loop, provider, trace } = makeHarness([
      toolCallThenDone("t1", "read", { path: "a.txt" }),
      textThenDone("文件内容是 alpha。"),
    ]);
    const result = await loop.run(INPUT);
    expect(result).toMatchObject({ finishReason: "completed", finalText: "文件内容是 alpha。", iterations: 2 });

    // 第二轮请求携带 assistant 工具调用与 role=tool 结果回填
    const secondCall = provider.calls[1]?.messages ?? [];
    expect(secondCall.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.id === "t1")).toBe(true);
    const toolMessage = secondCall.find((m) => m.role === "tool" && m.toolCallId === "t1");
    expect(toolMessage?.content).toBe("文件内容 alpha");

    expect(trace.list().map((event) => event.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "assistant_message",
      "done",
    ]);
  });

  it("多步任务：write 授权通过 → bash 执行 → 完成（AC4 完整链路）", async () => {
    const scripts: StreamEvent[][] = [
      toolCallThenDone("t1", "write", { path: "out.txt", content: "console.log('hi')" }),
      toolCallThenDone("t2", "bash", { command: "node out.txt" }),
      textThenDone("已创建并运行。"),
    ];
    const { loop, env, trace } = makeHarness(scripts, {
      authorizer: new Authorizer(async () => "allow"),
    });
    env.execHandler = async () => ({ stdout: "hi", stderr: "", exitCode: 0 });

    const result = await loop.run(INPUT);
    expect(result.finishReason).toBe("completed");
    expect(result.iterations).toBe(3);
    expect(env.readRelative("out.txt")).toBe("console.log('hi')");
    expect(env.execCalls).toEqual([{ command: "node out.txt", cwd: ROOT }]);

    const types = trace.list().map((event) => event.type);
    expect(types).toContain("authorization_request");
    expect(types).toContain("authorization_decision");
    // write/bash 各一次授权；read 类工具无授权事件
    expect(types.filter((t) => t === "authorization_request")).toHaveLength(2);
  });

  it("授权拒绝：工具不执行，拒绝说明回填模型，loop 继续", async () => {
    const { loop, provider, env, trace } = makeHarness(
      [toolCallThenDone("t1", "write", { path: "out.txt", content: "x" }), textThenDone("好吧，不写了。")],
      { authorizer: new Authorizer(async () => "deny") }
    );
    const result = await loop.run(INPUT);
    expect(result.finishReason).toBe("completed");
    expect(env.readRelative("out.txt")).toBeUndefined();

    const toolMessage = (provider.calls[1]?.messages ?? []).find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("用户拒绝授权");
    const decisions = trace.list().filter((event) => event.type === "authorization_decision");
    expect(decisions[0]?.summary).toContain("deny");
  });

  it("allow_session：同会话内同类工具只授权一次", async () => {
    let askCount = 0;
    const scripts: StreamEvent[][] = [
      toolCallThenDone("t1", "write", { path: "a1.txt", content: "1" }),
      toolCallThenDone("t2", "write", { path: "a2.txt", content: "2" }),
      textThenDone("两个文件都写好了。"),
    ];
    const { loop, env } = makeHarness(scripts, {
      authorizer: new Authorizer(async () => {
        askCount += 1;
        return "allow_session";
      }),
    });
    const result = await loop.run(INPUT);
    expect(result.finishReason).toBe("completed");
    expect(askCount).toBe(1);
    expect(env.readRelative("a1.txt")).toBe("1");
    expect(env.readRelative("a2.txt")).toBe("2");
  });

  it("模型持续调用工具：达到 maxIterations 兜底停止", async () => {
    // 每轮都返回 tool_use，loop 应在 maxIterations=3 处兜底停止
    const { loop, provider } = makeHarness(
      [
        toolCallThenDone("t1", "read", { path: "a.txt" }),
        toolCallThenDone("t2", "read", { path: "a.txt" }),
        toolCallThenDone("t3", "read", { path: "a.txt" }),
      ],
      { maxIterations: 3 }
    );
    const result = await loop.run(INPUT);
    expect(result.finishReason).toBe("max_iterations");
    expect(result.iterations).toBe(3);
    expect(provider.calls).toHaveLength(3);
  });

  it("provider 错误事件：finishReason=error 且错误入轨迹", async () => {
    const { loop, trace } = makeHarness([[{ type: "error", error: "HTTP 429 限流", retryable: true }]]);
    const result = await loop.run(INPUT);
    expect(result).toMatchObject({ finishReason: "error", errorMessage: "HTTP 429 限流" });
    expect(trace.list().map((event) => event.type)).toContain("error");
  });

  it("启动前已取消：直接 cancelled，不发起任何请求", async () => {
    const { loop, provider } = makeHarness([textThenDone("不会到达")]);
    const controller = new AbortController();
    controller.abort();
    const result = await loop.run(INPUT, controller.signal);
    expect(result.finishReason).toBe("cancelled");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("AgentLoop 会话持久化（迭代 6 / AC15）", () => {
  it("priorHistory 注入：历史消息排在当前输入之前进入 transcript", async () => {
    const { loop, provider } = makeHarness([textThenDone("好")]);
    await loop.run(INPUT, undefined, [
      { role: "user", content: "上一轮的提问" },
      { role: "assistant", content: "上一轮的答复" },
    ]);
    const messages = provider.calls[0]!.messages;
    // transcript 末尾三段：历史两条 + 本轮 user；前文可能有 system 提示
    expect(messages.at(-3)).toEqual({ role: "user", content: "上一轮的提问" });
    expect(messages.at(-2)).toEqual({ role: "assistant", content: "上一轮的答复" });
    expect(messages.at(-1)).toEqual({ role: "user", content: INPUT.userText });
  });

  it("user_message 事件以 detail.text 存档完整原文（summary 截断不丢正文）", async () => {
    const longText = "长".repeat(500);
    const { loop, trace } = makeHarness([textThenDone("收到")]);
    await loop.run({ ...INPUT, userText: longText });
    const userEvent = trace.list().find((event) => event.type === "user_message");
    expect(userEvent).toBeDefined();
    expect((userEvent!.detail as { text: string }).text).toBe(longText);
    expect(userEvent!.summary.length).toBeLessThan(longText.length);
  });
});
