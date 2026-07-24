import path from "node:path";
import type {
  AgentRunInput,
  ChatMessage,
  LLMProvider,
  ModeDefinition,
  ProviderConfig,
  StreamEvent,
  ToolDefinition,
} from "@devwit/contracts";
import { ContextEngine } from "@devwit/context-engine";
import { describe, expect, it } from "vitest";
import { AgentOrchestrator, parsePlannedTasks, type AgentOrchestratorDeps } from "../src/orchestrator.js";
import { Authorizer } from "../src/authorizer.js";
import type { AuthorizationRequest } from "@devwit/contracts";
import { AgentTrace } from "../src/trace.js";
import { MemoryEnvironment } from "./helpers.js";

const ROOT = path.resolve("ws-orchestrator");

const MODE: ModeDefinition = {
  id: "orchestrator",
  name: "Orchestrator",
  description: "编排测试模式",
  systemPrompt: "你是编排协调者。",
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  providerId: "p-test",
  contextPolicy: {},
  orchestrate: true,
  builtin: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const INPUT: AgentRunInput = {
  sessionId: "s1",
  userText: "重构登录与按钮两个模块",
  modeId: "orchestrator",
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

/**
 * 内容路由 provider：按请求消息内容匹配脚本队列（每次命中 shift 一条）。
 * 并行子 Agent 的调用交错不确定，按序 shift 的全局脚本无法确定性驱动；
 * 路由匹配让「规划/子任务甲/子任务乙/综合」各自命中自己的脚本队列。
 * active/maxActive 统计并发流 consumption 峰值（并发上限断言用）。
 */
class RoutedProvider implements LLMProvider {
  readonly config: ProviderConfig = {
    id: "p-test",
    type: "openai",
    label: "routed",
    baseUrl: "https://example.invalid",
    model: "test-model",
    credentialRef: "cred-test",
    maxTokens: 1024,
  };
  readonly calls: Array<{ messages: ChatMessage[]; tools: ToolDefinition[] }> = [];
  private readonly routes: Array<{ includes: string; scripts: StreamEvent[][] }> = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly delayMs = 0) {}

  addRoute(includes: string, scripts: StreamEvent[][]): this {
    this.routes.push({ includes, scripts: [...scripts] });
    return this;
  }

  streamChat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<StreamEvent> {
    this.calls.push({ messages, tools });
    const text = messages.map((message) => message.content).join("\n");
    const route = this.routes.find((candidate) => text.includes(candidate.includes));
    const script =
      route !== undefined && route.scripts.length > 0
        ? route.scripts.shift()!
        : [{ type: "text", text: "(路由缺省)" }, { type: "done", stopReason: "end_turn" as const }];
    return this.consume(script);
  }

  /** 消费脚本并统计并发峰值（类方法形态避免 this 别名）。 */
  private async *consume(script: StreamEvent[]): AsyncGenerator<StreamEvent> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      for (const event of script) yield event;
    } finally {
      this.active -= 1;
    }
  }
}

interface Harness {
  orchestrator: AgentOrchestrator;
  provider: RoutedProvider;
  env: MemoryEnvironment;
  trace: AgentTrace;
  authorizer: Authorizer;
}

function makeHarness(
  provider: RoutedProvider,
  overrides: Partial<AgentOrchestratorDeps> = {},
  authorizer?: Authorizer
): Harness {
  const env = new MemoryEnvironment(ROOT, { "a.txt": "文件内容 alpha" });
  const trace = new AgentTrace("s1");
  const auth = authorizer ?? new Authorizer();
  const orchestrator = new AgentOrchestrator({
    provider,
    mode: MODE,
    env,
    authorizer: auth,
    trace,
    createSubEngine: () => new ContextEngine({ sessionId: "s1" }),
    ...overrides,
  });
  return { orchestrator, provider, env, trace, authorizer: auth };
}

/** 标准三路脚本：规划 2 子任务 + 各子任务一轮文本完成 + 综合定稿。 */
function standardRoutes(provider: RoutedProvider): void {
  provider
    .addRoute("请分解为", [
      textThenDone('[{"title":"子任务甲","prompt":"完成子任务甲的内容"},{"title":"子任务乙","prompt":"完成子任务乙的内容"}]'),
    ])
    .addRoute("各子任务已执行完毕", [textThenDone("综合结论：甲乙均完成")])
    .addRoute("子任务甲", [textThenDone("甲完成")])
    .addRoute("子任务乙", [textThenDone("乙完成")]);
}

describe("parsePlannedTasks", () => {
  it("解析严格 JSON 数组", () => {
    const tasks = parsePlannedTasks('[{"title":"甲","prompt":"做甲"},{"title":"乙","prompt":"做乙"}]');
    expect(tasks).toEqual([
      { title: "甲", prompt: "做甲" },
      { title: "乙", prompt: "做乙" },
    ]);
  });

  it("容忍 JSON 前后的解释文字与 Markdown 围栏", () => {
    const text = '好的，分解如下：\n```json\n[{"title":"甲","prompt":"做甲"}]\n```\n以上。';
    expect(parsePlannedTasks(text)).toEqual([{ title: "甲", prompt: "做甲" }]);
  });

  it("非 JSON / 空数组 / 全畸形项 → null", () => {
    expect(parsePlannedTasks("无法分解")).toBeNull();
    expect(parsePlannedTasks("[]")).toBeNull();
    expect(parsePlannedTasks('[{"title":"缺 prompt"},{"prompt":""},{"title":"x","prompt":"y"}]')).toEqual([
      { title: "x", prompt: "y" },
    ]);
    expect(parsePlannedTasks('[{"title":1,"prompt":"y"}]')).toBeNull();
  });
});

describe("AgentOrchestrator", () => {
  it("完整编排：plan → 并行子 Agent → 综合，轨迹全阶段可见且归属标记", async () => {
    const provider = new RoutedProvider();
    standardRoutes(provider);
    const { orchestrator, trace } = makeHarness(provider);
    const result = await orchestrator.run(INPUT);

    expect(result).toMatchObject({ finishReason: "completed", finalText: "综合结论：甲乙均完成" });
    const events = trace.list();
    const types = events.map((event) => event.type);
    // 全阶段：user → plan → 两个子代理生命周期 → 综合 assistant → done
    expect(types[0]).toBe("user_message");
    expect(types).toContain("plan");
    expect(types.filter((type) => type === "subagent_start")).toHaveLength(2);
    expect(types.filter((type) => type === "subagent_done")).toHaveLength(2);
    expect(types.at(-1)).toBe("done");

    // plan 事件 detail 携带完整子任务列表（分解可见）
    const plan = events.find((event) => event.type === "plan");
    const planDetail = plan?.detail as { subtasks: unknown[]; fallback?: boolean };
    expect(planDetail.subtasks).toHaveLength(2);
    expect(planDetail.fallback).toBeUndefined();

    // 子 Agent 内部事件转发进父轨迹并标记 subagentId（活动流归属可见）
    const childUserMessages = events.filter(
      (event) => event.type === "user_message" && (event.detail as { subagentId?: string })?.subagentId !== undefined
    );
    expect(childUserMessages).toHaveLength(2);
    expect(childUserMessages.map((event) => (event.detail as { subagentId: string }).subagentId).sort()).toEqual(["S1", "S2"]);
    expect(childUserMessages.every((event) => /^\[S[12]\]/.test(event.summary))).toBe(true);

    // 子代理终态（done/error）不转发——整体 done 只出现一次（编排收尾）
    expect(types.filter((type) => type === "done")).toHaveLength(1);

    // provider 调用：1 规划 + 2 子代理各 1 轮 + 1 综合 = 4
    expect(provider.calls).toHaveLength(4);
  });

  it("并发上限：4 子任务 maxConcurrency=2，并发峰值恰好 2 且全部执行", async () => {
    const provider = new RoutedProvider(20);
    provider
      .addRoute("请分解为", [
        textThenDone(
          '[{"title":"甲","prompt":"任务甲"},{"title":"乙","prompt":"任务乙"},' +
            '{"title":"丙","prompt":"任务丙"},{"title":"丁","prompt":"任务丁"}]'
        ),
      ])
      .addRoute("各子任务已执行完毕", [textThenDone("综合：全部完成")])
      .addRoute("任务甲", [textThenDone("甲完")])
      .addRoute("任务乙", [textThenDone("乙完")])
      .addRoute("任务丙", [textThenDone("丙完")])
      .addRoute("任务丁", [textThenDone("丁完")]);
    const { orchestrator, trace } = makeHarness(provider, { maxConcurrency: 2 });
    const result = await orchestrator.run(INPUT);

    expect(result.finishReason).toBe("completed");
    expect(provider.maxActive).toBe(2);
    expect(trace.list().filter((event) => event.type === "subagent_done")).toHaveLength(4);
  });

  it("授权门继承：S1 的 allow_session 裁决对 S2 免再问（共享 Authorizer）", async () => {
    const requests: AuthorizationRequest[] = [];
    const authorizer = new Authorizer(async (request) => {
      requests.push(request);
      return "allow_session";
    });
    const provider = new RoutedProvider();
    provider
      .addRoute("请分解为", [
        textThenDone('[{"title":"写文件甲","prompt":"写甲文件"},{"title":"写文件乙","prompt":"写乙文件"}]'),
      ])
      .addRoute("各子任务已执行完毕", [textThenDone("综合：两文件已写")])
      .addRoute("写甲文件", [
        toolCallThenDone("c1", "write", { path: "out-甲.txt", content: "甲" }),
        textThenDone("甲已写"),
      ])
      .addRoute("写乙文件", [
        toolCallThenDone("c2", "write", { path: "out-乙.txt", content: "乙" }),
        textThenDone("乙已写"),
      ]);
    // 串行（maxConcurrency=1）保证 S1 裁决完成后 S2 才发起写调用
    const { orchestrator, env, trace } = makeHarness(provider, { maxConcurrency: 1 }, authorizer);
    const result = await orchestrator.run(INPUT);

    expect(result.finishReason).toBe("completed");
    // 授权只问了一次（S1）；S2 命中 sessionAllowed 直接执行——门继承证据
    expect(requests).toHaveLength(1);
    expect(env.readRelative("out-甲.txt")).toBe("甲");
    expect(env.readRelative("out-乙.txt")).toBe("乙");
    // 授权事件归属标记：S1 发起的授权请求带 subagentId
    const authRequest = trace.list().find((event) => event.type === "authorization_request");
    expect((authRequest?.detail as { subagentId?: string })?.subagentId).toBe("S1");
  });

  it("Planner 分解失败：退化为单任务（fallback 可见），原始意图全文执行", async () => {
    const provider = new RoutedProvider();
    provider
      .addRoute("请分解为", [textThenDone("抱歉，我无法分解这个任务。")])
      .addRoute("各子任务已执行完毕", [textThenDone("综合：单任务完成")])
      .addRoute("重构登录与按钮两个模块", [textThenDone("单任务直接完成")]);
    const { orchestrator, trace } = makeHarness(provider);
    const result = await orchestrator.run(INPUT);

    expect(result.finishReason).toBe("completed");
    const plan = trace.list().find((event) => event.type === "plan");
    const detail = plan?.detail as { subtasks: { prompt: string }[]; fallback: boolean };
    expect(detail.fallback).toBe(true);
    expect(detail.subtasks).toHaveLength(1);
    expect(detail.subtasks[0]?.prompt).toBe(INPUT.userText);
    expect(trace.list().filter((event) => event.type === "subagent_start")).toHaveLength(1);
  });

  it("单个子任务失败不拖垮整体：subagent_done 记录 error，综合照常执行", async () => {
    const provider = new RoutedProvider();
    provider
      .addRoute("请分解为", [
        textThenDone('[{"title":"甲","prompt":"做甲"},{"title":"乙","prompt":"做乙"}]'),
      ])
      .addRoute("各子任务已执行完毕", [textThenDone("综合：甲失败乙成功")])
      .addRoute("做甲", [[{ type: "error", error: "DW_TEST_STREAM_FAIL" }]])
      .addRoute("做乙", [textThenDone("乙成功")]);
    const { orchestrator, trace } = makeHarness(provider);
    const result = await orchestrator.run(INPUT);

    expect(result).toMatchObject({ finishReason: "completed", finalText: "综合：甲失败乙成功" });
    const dones = trace.list().filter((event) => event.type === "subagent_done");
    const bySub = new Map(dones.map((event) => [(event.detail as { subagentId: string }).subagentId, event]));
    expect((bySub.get("S1")?.detail as { finishReason: string }).finishReason).toBe("error");
    expect((bySub.get("S1")?.detail as { errorMessage?: string }).errorMessage).toBe("DW_TEST_STREAM_FAIL");
    expect((bySub.get("S2")?.detail as { finishReason: string }).finishReason).toBe("completed");
  });

  it("取消：执行前 abort → plan 后立即收尾为 cancelled", async () => {
    const provider = new RoutedProvider();
    standardRoutes(provider);
    const { orchestrator, trace } = makeHarness(provider);
    const controller = new AbortController();
    controller.abort();
    const result = await orchestrator.run(INPUT, controller.signal);

    expect(result.finishReason).toBe("cancelled");
    expect(trace.list().at(-1)?.summary).toBe("会话已取消");
  });

  it("综合阶段的流式文本经 onAssistantDelta 转发（子 Agent 文本不走 delta 通道）", async () => {
    const provider = new RoutedProvider();
    standardRoutes(provider);
    const deltas: string[] = [];
    const { orchestrator } = makeHarness(provider, { onAssistantDelta: (delta) => deltas.push(delta) });
    await orchestrator.run(INPUT);

    expect(deltas.join("")).toBe("综合结论：甲乙均完成");
  });
});
