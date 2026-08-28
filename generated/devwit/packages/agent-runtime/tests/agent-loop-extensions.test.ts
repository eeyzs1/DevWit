import path from "node:path";
import type { AgentRunInput, ModeDefinition, StreamEvent } from "@devwit/contracts";
import { ContextEngine } from "@devwit/context-engine";
import { describe, expect, it } from "vitest";
import { AgentLoop, type AgentLoopDeps, type AgentLoopExtensions } from "../src/agent-loop.js";
import { AgentTrace } from "../src/trace.js";
import { assertModelVisibleLogged } from "../src/session-log.js";
import { MemoryEnvironment, ScriptedProvider } from "./helpers.js";

const ROOT = path.resolve("ws-loop-ext");

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

const INPUT: AgentRunInput = { sessionId: "s1", userText: "创建文件并运行脚本", modeId: "agent", workspaceRoot: ROOT };

function textThenDone(text: string): StreamEvent[] {
  return [{ type: "text", text }, { type: "done", stopReason: "end_turn" }];
}

interface Harness {
  loop: AgentLoop;
  provider: ScriptedProvider;
  trace: AgentTrace;
}

function makeHarness(scripts: StreamEvent[][], extensions?: AgentLoopExtensions, files: Record<string, string> = {}): Harness {
  const provider = new ScriptedProvider(scripts);
  const env = new MemoryEnvironment(ROOT, files);
  const engine = new ContextEngine({ sessionId: "s1" });
  const trace = new AgentTrace("s1");
  const deps: AgentLoopDeps = { provider, engine, mode: MODE, env, trace };
  if (extensions !== undefined) deps.extensions = extensions;
  const loop = new AgentLoop(deps);
  return { loop, provider, trace };
}

describe("AgentLoop extensions（B-WU2 事件化扩展点）", () => {
  it("preStep reject：拒绝本轮——不调模型，turn 以 error 关闭并落轨迹", async () => {
    const { loop, provider, trace } = makeHarness([textThenDone("不该出现")], {
      preStep: async () => ({ kind: "reject", reason: "本轮被策略拒绝" }),
    });
    const result = await loop.run(INPUT);
    expect(result).toMatchObject({ finishReason: "error", errorMessage: "本轮被策略拒绝" });
    expect(provider.calls.length).toBe(0);
    expect(trace.list().map((e) => e.type)).toEqual(["user_message", "error"]);
  });

  it("preStep rewrite：改写后的请求发给模型，且落 request_rewrite 日志（model-visible <=> logged）", async () => {
    const { loop, provider, trace } = makeHarness([textThenDone("好的")], {
      preStep: async (ctx) => ({
        kind: "rewrite",
        messages: [
          { role: "system", content: "改写后的系统提示" },
          { role: "user", content: `[改写] ${ctx.userText}` },
        ],
        tools: [],
      }),
    });
    const result = await loop.run(INPUT);
    expect(result.finishReason).toBe("completed");

    const request = provider.calls[0]!;
    expect(request.messages.map((m) => m.content)).toEqual(["改写后的系统提示", "[改写] 创建文件并运行脚本"]);
    expect(request.tools).toEqual([]);

    const rewriteEvent = trace.list().find((e) => e.type === "request_rewrite");
    expect(rewriteEvent).toBeDefined();
    // 不变量：改写后的请求必须能从日志（request_rewrite 快照）重建
    const invariant = assertModelVisibleLogged(trace.list(), request.messages);
    expect(invariant.ok).toBe(true);
  });

  it("toolPipeline.preExecute deny：工具未执行，tool_result 记拒绝", async () => {
    const { loop, trace } = makeHarness(
      [
        [
          { type: "tool_call", toolCall: { id: "c1", name: "read", args: { path: "a.txt" } } },
          { type: "done", stopReason: "tool_use" },
        ],
        textThenDone("继续"),
      ],
      {
        toolPipeline: {
          preExecute: async (call) => (call.name === "read" ? { deny: "管线禁止读" } : undefined),
        },
      },
    );
    const result = await loop.run(INPUT);
    expect(result.finishReason).toBe("completed");
    const denied = trace.list().find((e) => e.type === "tool_result");
    expect(denied?.detail).toMatchObject({ result: { ok: false, error: "管线禁止读" } });
  });

  it("toolPipeline.postExecute：每个工具执行后观察（含结果）", async () => {
    const seen: string[] = [];
    const { loop } = makeHarness(
      [
        [
          { type: "tool_call", toolCall: { id: "c1", name: "read", args: { path: "a.txt" } } },
          { type: "done", stopReason: "tool_use" },
        ],
        textThenDone("完毕"),
      ],
      {
        toolPipeline: {
          postExecute: async (call, result) => {
            seen.push(`${call.name}:${result.ok}`);
          },
        },
      },
      { "a.txt": "文件内容 alpha" },
    );
    await loop.run(INPUT);
    expect(seen).toContain("read:true");
  });

  it("onStepEnd 每步触发；onTurnEnd 结束触发一次（含 finishReason）", async () => {
    const stepEnds: number[] = [];
    const turnEnds: string[] = [];
    const { loop } = makeHarness(
      [
        [
          { type: "tool_call", toolCall: { id: "c1", name: "read", args: { path: "a.txt" } } },
          { type: "done", stopReason: "tool_use" },
        ],
        textThenDone("完毕"),
      ],
      {
        onStepEnd: async (ctx) => {
          stepEnds.push(ctx.iteration);
        },
        onTurnEnd: async (ctx) => {
          turnEnds.push(ctx.finishReason);
        },
      },
    );
    await loop.run(INPUT);
    expect(stepEnds).toEqual([1, 2]);
    expect(turnEnds).toEqual(["completed"]);
  });

  it("缺省扩展时行为与旧版一致（回归护栏）", async () => {
    const { loop, provider, trace } = makeHarness([textThenDone("好的，明白了。")]);
    const result = await loop.run(INPUT);
    expect(result).toMatchObject({ finishReason: "completed", finalText: "好的，明白了。", iterations: 1 });
    expect(trace.list().map((e) => e.type)).toEqual(["user_message", "assistant_message", "done"]);
    expect(provider.calls[0]?.messages.some((m) => m.role === "user" && m.content === INPUT.userText)).toBe(true);
  });
});
