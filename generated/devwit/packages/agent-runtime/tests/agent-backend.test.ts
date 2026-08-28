import path from "node:path";
import type { ModeDefinition, StreamEvent } from "@devwit/contracts";
import { ContextEngine } from "@devwit/context-engine";
import { describe, expect, it } from "vitest";
import { BackendRegistry, InternalAgentBackend, type AgentBackend } from "../src/agent-backend.js";
import { AgentLoop } from "../src/agent-loop.js";
import { AgentTrace } from "../src/trace.js";
import { MemoryEnvironment, ScriptedProvider } from "./helpers.js";

const ROOT = path.resolve("ws-backend");

const MODE: ModeDefinition = {
  id: "agent",
  name: "Agent",
  description: "测试模式",
  systemPrompt: "你是测试 Agent。",
  tools: ["read"],
  providerId: "p-test",
  contextPolicy: {},
  builtin: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function internalBackend(scripts: StreamEvent[][]) {
  const provider = new ScriptedProvider(scripts);
  const env = new MemoryEnvironment(ROOT, {});
  const engine = new ContextEngine({ sessionId: "s1" });
  const trace = new AgentTrace("s1");
  const loop = new AgentLoop({ provider, engine, mode: MODE, env, trace });
  return { backend: new InternalAgentBackend(() => loop), loop };
}

describe("AgentBackend seam（B-WU6）", () => {
  it("InternalAgentBackend：run 结果与 AgentLoop.run 一致（默认行为不变）", async () => {
    const { backend, loop } = internalBackend([
      [{ type: "text", text: "好的。" }, { type: "done", stopReason: "end_turn" }],
    ]);
    const result = await backend.run({ sessionId: "s1", userText: "你好", workspaceRoot: ROOT, modeId: "agent" });
    expect(result.finishReason).toBe("completed");
    expect(result.finalText).toBe("好的。");
    expect(result.events.map((e) => e.type)).toEqual(["user_message", "assistant_message", "done"]);
    expect(loop.trace).not.toBeNull();
  });

  it("registry：注册外部后端；resolve 按 id 命中", () => {
    const reg = new BackendRegistry();
    const fake: AgentBackend = {
      id: "codex",
      available: true,
      run: async () => ({ finishReason: "completed", finalText: "codex 结果", events: [] }),
    };
    reg.register(fake);
    expect(reg.list()).toContain("codex");
    const fallback = internalBackend([[]]).backend;
    expect(reg.resolve("codex", fallback)).toBe(fake);
  });

  it("优雅降级：配置的外部后端 unavailable → 回落 internal（绝不静默失败）", () => {
    const reg = new BackendRegistry();
    reg.register({ id: "claude-agent-sdk", available: false, run: async () => {
      throw new Error("不应被调用");
    } });
    const fallback = internalBackend([[]]).backend;
    expect(reg.resolve("claude-agent-sdk", fallback)).toBe(fallback);
    expect(reg.resolve("ghost", fallback)).toBe(fallback);
  });

  it("重复注册抛错（fail-closed）", () => {
    const reg = new BackendRegistry();
    const fake: AgentBackend = { id: "codex", available: true, run: async () => ({ finishReason: "completed" as const, finalText: "", events: [] }) };
    reg.register(fake);
    expect(() => reg.register(fake)).toThrow(/duplicate agent backend/);
  });
});
