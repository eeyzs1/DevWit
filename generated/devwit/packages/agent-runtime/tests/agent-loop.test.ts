import path from "node:path";
import type { AgentRunInput, DiagnosticEntry, ModeDefinition, StreamEvent } from "@devwit/contracts";
import { attachmentSource, ContextEngine } from "@devwit/context-engine";
import { describe, expect, it } from "vitest";
import { AgentLoop, type AgentLoopDeps } from "../src/agent-loop.js";
import { Authorizer } from "../src/authorizer.js";
import { DiagnosticsTracker } from "../src/diagnostics.js";
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
    // B-WU3 fail-closed：授权未通过（deny）同样拒绝执行，说明回填模型
    expect(toolMessage?.content).toContain("授权未通过（deny）");
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

  it("AC29 白名单命中：不询问、记录 authorization_auto、工具真实执行", async () => {
    let askCount = 0;
    const scripts: StreamEvent[][] = [
      toolCallThenDone("t1", "bash", { command: "git status" }),
      textThenDone("已查看状态。"),
    ];
    const { loop, env, trace } = makeHarness(scripts, {
      authorizer: new Authorizer(
        async () => {
          askCount += 1;
          return "allow";
        },
        { isWhitelisted: () => true, recordDecision: () => undefined }
      ),
    });
    env.execHandler = async () => ({ stdout: "clean", stderr: "", exitCode: 0 });

    const result = await loop.run(INPUT);
    expect(result.finishReason).toBe("completed");
    expect(askCount).toBe(0); // 白名单命中：授权处理器从未被调用
    expect(env.execCalls).toEqual([{ command: "git status", cwd: ROOT }]);

    const types = trace.list().map((event) => event.type);
    expect(types).toContain("authorization_auto");
    expect(types).not.toContain("authorization_request");
    expect(types).not.toContain("authorization_decision");
    const auto = trace.list().find((event) => event.type === "authorization_auto");
    expect((auto?.detail as { source?: unknown }).source).toBe("whitelist");
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

  it("AC30 诊断回馈：write 成功后刷新快照，下一轮请求注入诊断文本，轨迹落 diagnostics 事件", async () => {
    const snapshot: DiagnosticEntry[] = [];
    let refreshCalls = 0;
    const tracker = new DiagnosticsTracker(async () => {
      refreshCalls += 1;
      return snapshot;
    });
    const modeDiag: ModeDefinition = { ...MODE, contextPolicy: { diagnostics: true } };
    const provider = new ScriptedProvider([
      toolCallThenDone("t1", "write", { path: "broken.ts", content: "const x: number = 's';" }),
      textThenDone("已看到诊断并准备修复。"),
    ]);
    const env = new MemoryEnvironment(ROOT, {});
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.registerSource(tracker.source());
    const trace = new AgentTrace("s1");
    const loop = new AgentLoop({
      provider, engine, mode: modeDiag, env, trace,
      authorizer: new Authorizer(async () => "allow"),
      diagnostics: tracker,
    });
    // 第一轮 write 后诊断刷新：模拟 tsc 发现 1 个问题
    const result = await loop.run(INPUT);
    // 在 write 执行时把快照塞入问题（refresh 在 write 成功后立刻发生）
    expect(result.finishReason).toBe("completed");
    expect(refreshCalls).toBe(1);

    const diagEvents = trace.list().filter((event) => event.type === "diagnostics");
    expect(diagEvents).toHaveLength(1);
    expect((diagEvents[0]?.detail as { trigger?: unknown }).trigger).toBe("write");
  });

  it("AC30：有问题的快照进入下一轮请求上下文（修复闭环的核心链路）", async () => {
    const ENTRY = {
      file: "broken.ts", line: 1, column: 7, severity: "error" as const,
      code: "TS2322", message: "Type 'string' is not assignable to type 'number'.",
    };
    let refreshed = false;
    const tracker = new DiagnosticsTracker(async () => {
      refreshed = true;
      return [ENTRY];
    });
    const modeDiag: ModeDefinition = { ...MODE, contextPolicy: { diagnostics: true } };
    const provider = new ScriptedProvider([
      toolCallThenDone("t1", "write", { path: "broken.ts", content: "const x: number = 's';" }),
      textThenDone("已修复。"),
    ]);
    const env = new MemoryEnvironment(ROOT, {});
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.registerSource(tracker.source());
    const loop = new AgentLoop({
      provider, engine, mode: modeDiag, env, trace: new AgentTrace("s1"),
      authorizer: new Authorizer(async () => "allow"),
      diagnostics: tracker,
    });
    await loop.run(INPUT);
    expect(refreshed).toBe(true);
    // 第二轮请求（工具结果回填后）必须携带诊断文本——模型看到自己引入的错误
    const secondMessages = provider.calls[1]?.messages ?? [];
    const diagMessage = secondMessages.find((m) => m.role === "user" && m.content.includes("诊断"));
    expect(diagMessage?.content).toContain("broken.ts:1:7 error TS2322");
  });

  it("AC30：diagnostics 类型关闭时不刷新（不白跑 tsc）；write 失败也不刷新", async () => {
    let refreshCalls = 0;
    const tracker = new DiagnosticsTracker(async () => {
      refreshCalls += 1;
      return [];
    });
    // 类型关闭：MODE.contextPolicy={} 且引擎默认 diagnostics=false
    const providerOff = new ScriptedProvider([
      toolCallThenDone("t1", "write", { path: "x.ts", content: "x" }),
      textThenDone("done"),
    ]);
    const envOff = new MemoryEnvironment(ROOT, {});
    const loopOff = new AgentLoop({
      provider: providerOff, engine: new ContextEngine({ sessionId: "s1" }), mode: MODE, env: envOff,
      trace: new AgentTrace("s1"), authorizer: new Authorizer(async () => "allow"), diagnostics: tracker,
    });
    await loopOff.run(INPUT);
    expect(refreshCalls).toBe(0);

    // 类型开启但 write 失败（如路径非法）：不刷新
    const modeDiag: ModeDefinition = { ...MODE, contextPolicy: { diagnostics: true } };
    const envFail = new MemoryEnvironment(ROOT, {});
    envFail.writeFile = async () => { throw new Error("EROFS: read-only file system"); };
    const providerFail = new ScriptedProvider([
      toolCallThenDone("t1", "write", { path: "x.ts", content: "x" }),
      textThenDone("写失败了。"),
    ]);
    const loopFail = new AgentLoop({
      provider: providerFail, engine: new ContextEngine({ sessionId: "s1" }), mode: modeDiag, env: envFail,
      trace: new AgentTrace("s1"), authorizer: new Authorizer(async () => "allow"), diagnostics: tracker,
    });
    await loopFail.run(INPUT);
    expect(refreshCalls).toBe(0);
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
