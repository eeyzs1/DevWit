/**
 * AiRuntime 接线测试（Fusion v3）：B-WU4 promptSections / B-WU5 mode-scope /
 * B-WU6 BackendRegistry 的真实装配验证。
 *
 * 复用 ai-runtime-trace.test.ts 的 harness 模式：真实 SettingsStore + tmp 目录，
 * 唯一注入边界是 LLMProvider（ScriptedProvider 确定性事件）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, LLMProvider, ProviderConfig, StreamEvent, ToolDefinition } from "@devwit/contracts";
import { IPC } from "@devwit/contracts";
import { NodeCryptoBackend, SettingsStore } from "@devwit/settings";
import type { WorkspaceService } from "@devwit/workspace";
import type { AgentBackend } from "@devwit/agent-runtime";
import { AiRuntime } from "../src/main/ai-runtime.js";

class ScriptedProvider implements LLMProvider {
  readonly config: ProviderConfig = {
    id: "p-test",
    type: "openai",
    label: "scripted",
    baseUrl: "https://example.invalid",
    model: "test-model",
    credentialRef: "cred-test",
    maxTokens: 1024,
  };
  readonly calls: ChatMessage[][] = [];
  readonly toolCalls: ToolDefinition[][] = [];
  private readonly scripts: StreamEvent[][];

  constructor(scripts: StreamEvent[][]) {
    this.scripts = [...scripts];
  }

  streamChat(messages: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<StreamEvent> {
    this.calls.push(messages.map((m) => ({ ...m })));
    this.toolCalls.push(tools.map((t) => ({ ...t })));
    const script = this.scripts.shift() ?? [{ type: "done", stopReason: "end_turn" }];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of script) yield event;
      },
    };
  }
}

function textThenDone(text: string): StreamEvent[] {
  return [{ type: "text", text }, { type: "done", stopReason: "end_turn" }];
}

let tmpRoot = "";

function makeRuntime(
  provider: ScriptedProvider,
  settingsPresets: Array<[string, unknown]> = [],
): { runtime: AiRuntime; provider: ScriptedProvider } {
  const settings = new SettingsStore(new NodeCryptoBackend(), path.join(tmpRoot, "settings"));
  for (const [key, value] of settingsPresets) settings.set(key, value);
  const workspace = { readFile: async () => "", onDidChange: () => () => {} } as unknown as WorkspaceService;
  const runtime = new AiRuntime({
    settings,
    workspace,
    send: (channel: string, ...args: unknown[]) => {
      if (channel === IPC.AgentEvent) void args;
    },
    manifestsDir: path.join(tmpRoot, "manifests"),
    tracesDir: path.join(tmpRoot, "traces"),
    createProvider: () => provider,
  });
  return { runtime, provider };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dw-backend-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const runInput = () => ({ sessionId: "s1", userText: "你好", modeId: "agent", providerId: "p-test", workspaceRoot: tmpRoot });

describe("AiRuntime BackendRegistry 接线（B-WU6）", () => {
  it("缺省 internal：走自研 loop，provider 收到请求", async () => {
    const { runtime, provider } = makeRuntime(new ScriptedProvider([textThenDone("好的。")]));
    await runtime.run(runInput());
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0]?.some((m) => m.role === "user" && m.content === "你好")).toBe(true);
  });

  it("配置可用外部后端：走外部 run，事件入会话轨迹，provider 不被调用", async () => {
    const { runtime, provider } = makeRuntime(new ScriptedProvider([textThenDone("不该走 loop")]), [
      ["agent.backendId", "codex"],
    ]);
    const calls: string[] = [];
    const external: AgentBackend = {
      id: "codex",
      available: true,
      run: async (input) => {
        calls.push(input.userText);
        return {
          finishReason: "completed",
          finalText: "codex 完成",
          events: [
            { seq: 1, timestamp: new Date().toISOString(), sessionId: input.sessionId, type: "user_message", summary: "你好" },
            { seq: 2, timestamp: new Date().toISOString(), sessionId: input.sessionId, type: "assistant_message", summary: "codex 完成", detail: { text: "codex 完成" } },
            { seq: 3, timestamp: new Date().toISOString(), sessionId: input.sessionId, type: "done", summary: "done" },
          ],
        };
      },
    };
    runtime.registerAgentBackend(external);

    await runtime.run(runInput());

    expect(calls).toEqual(["你好"]);
    expect(provider.calls.length).toBe(0);
    // 外部事件已入会话轨迹（审计/持久化同一事实源；route 为 AC31 路由审计前置事件）
    expect(runtime.trace("s1").map((e) => e.type)).toEqual(["route", "user_message", "assistant_message", "done"]);
  });

  it("外部后端不可用/未知 id：回落 internal（provider 被调用）", async () => {
    const { runtime, provider } = makeRuntime(new ScriptedProvider([textThenDone("内部完成")]), [
      ["agent.backendId", "claude-agent-sdk"],
    ]);
    runtime.registerAgentBackend({ id: "claude-agent-sdk", available: false, run: async () => {
      throw new Error("不应被调用");
    } });
    await runtime.run(runInput());
    expect(provider.calls.length).toBe(1);
  });
});

describe("AiRuntime promptSections + mode-scope 接线（B-WU4/B-WU5）", () => {
  it("模式作用域 prompt_section 段进入系统提示，manifest 记录段组成", async () => {
    const provider = new ScriptedProvider([textThenDone("好的")]);
    const { runtime } = makeRuntime(provider);
    runtime.modeScope.register("agent", "prompt_section", "discipline", "先读后写");

    await runtime.run(runInput());

    const system = provider.calls[0]?.find((m) => m.role === "system");
    expect(system?.content).toContain("先读后写");
    expect(system?.content).toContain("你是 DevWit 的编码 Agent"); // mode 基底段保留

    // manifest 审计段组成（B-WU4）
    expect(runtime.getLatestManifest()?.promptSections?.map((s) => s.name)).toEqual(["mode", "mode-scope:discipline"]);
  });

  it("模式作用域 tool 聚合进请求工具集（agent-loop extraTools，B-WU5）", async () => {
    const provider = new ScriptedProvider([textThenDone("好的")]);
    const { runtime } = makeRuntime(provider);
    const scopeTool: ToolDefinition = {
      name: "scope_tool",
      description: "模式作用域工具",
      parameters: { type: "object", properties: {}, required: [] },
    };
    runtime.modeScope.register("agent", "tool", "scope-tool", scopeTool);

    await runtime.run(runInput());

    expect(provider.toolCalls[0]?.some((t) => t.name === "scope_tool")).toBe(true);
  });
});
