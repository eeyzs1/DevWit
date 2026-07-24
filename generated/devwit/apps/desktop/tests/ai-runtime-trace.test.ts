/**
 * AiRuntime 轨迹持久化（迭代 6 / AC15）真实文件系统回环测试。
 *
 * 不用 mock：真实 SettingsStore（NodeCryptoBackend）+ 真实 tmp 目录 JSONL 落盘。
 * 唯一注入边界是 LLMProvider（HTTP/SSE 协议层已由 llm-providers 录制 fixture
 * 覆盖）——此处以确定性 StreamEvent 序列驱动 run，验证「落盘 → 新实例读回 →
 * 跨重启续跑注入历史」的完整链路。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentTraceEvent,
  ChatMessage,
  LLMProvider,
  ProviderConfig,
  StreamEvent,
} from "@devwit/contracts";
import { IPC } from "@devwit/contracts";
import { NodeCryptoBackend, SettingsStore } from "@devwit/settings";
import type { WorkspaceService } from "@devwit/workspace";
import { AiRuntime } from "../src/main/ai-runtime.js";

/** 脚本化 provider：按序回放 StreamEvent 脚本，记录每次调用的 messages。 */
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
  private readonly scripts: StreamEvent[][];

  constructor(scripts: StreamEvent[][]) {
    this.scripts = [...scripts];
  }

  // 接口签名允许更少形参：本桩不消费 tools/signal
  streamChat(messages: ChatMessage[]): AsyncIterable<StreamEvent> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const script: StreamEvent[] = this.scripts.shift() ?? [{ type: "done", stopReason: "end_turn" }];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of script) yield event;
      },
    };
  }
}

function textThenDone(text: string): StreamEvent[] {
  return [
    { type: "text", text },
    { type: "done", stopReason: "end_turn" },
  ];
}

let tmpRoot = "";

function makeRuntime(provider: ScriptedProvider): { runtime: AiRuntime; sent: AgentTraceEvent[] } {
  const sent: AgentTraceEvent[] = [];
  const settings = new SettingsStore(new NodeCryptoBackend(), path.join(tmpRoot, "settings"));
  const workspace = { readFile: async () => "", onDidChange: () => () => {} } as unknown as WorkspaceService;
  const runtime = new AiRuntime({
    settings,
    workspace,
    send: (channel: string, ...args: unknown[]) => {
      if (channel === IPC.AgentEvent) sent.push(args[0] as AgentTraceEvent);
    },
    manifestsDir: path.join(tmpRoot, "manifests"),
    tracesDir: path.join(tmpRoot, "traces"),
    createProvider: () => provider,
  });
  return { runtime, sent };
}

function readTraceFile(sessionId: string): AgentTraceEvent[] {
  const file = path.join(tmpRoot, "traces", `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AgentTraceEvent);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "devwit-ac15-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("AiRuntime 轨迹持久化（AC15）", () => {
  it("run 的事件实时落盘 JSONL；新实例（模拟重启）从磁盘读回同一会话", async () => {
    const provider = new ScriptedProvider([textThenDone("第一答")]);
    const { runtime: runtime1 } = makeRuntime(provider);
    await runtime1.run({
      sessionId: "s-1",
      userText: "第一问",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });

    // 落盘证据：JSONL 逐行一个事件，含本轮 user/assistant/done
    const onDisk = readTraceFile("s-1");
    expect(onDisk.map((event) => event.type)).toEqual(["user_message", "assistant_message", "done"]);
    expect((onDisk[0]!.detail as { text: string }).text).toBe("第一问");

    // 模拟应用重启：全新 AiRuntime（进程内无会话）→ trace() 从磁盘读回
    const { runtime: runtime2 } = makeRuntime(new ScriptedProvider([]));
    const restored = runtime2.trace("s-1");
    expect(restored.map((event) => event.type)).toEqual(["user_message", "assistant_message", "done"]);
    expect(restored[0]!.seq).toBe(1);
  });

  it("重启后续跑同一会话：磁盘轨迹重建为 priorHistory 注入本轮请求", async () => {
    const provider1 = new ScriptedProvider([textThenDone("第一答")]);
    const { runtime: runtime1 } = makeRuntime(provider1);
    await runtime1.run({
      sessionId: "s-1",
      userText: "第一问",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });

    // 重启后的第二个实例：同一会话续跑，不重复落盘历史、历史进入请求上下文
    const provider2 = new ScriptedProvider([textThenDone("第二答")]);
    const { runtime: runtime2, sent } = makeRuntime(provider2);
    await runtime2.run({
      sessionId: "s-1",
      userText: "第二问",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });

    const messages = provider2.calls[0]!;
    const userTexts = messages.filter((message) => message.role === "user").map((message) => message.content);
    expect(userTexts).toEqual(["第一问", "第二问"]);
    const assistantTexts = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
    expect(assistantTexts).toContain("第一答");

    // 轨迹文件追加而非覆盖：两轮事件齐全且 seq 单调
    const onDisk = readTraceFile("s-1");
    expect(onDisk.map((event) => event.type)).toEqual([
      "user_message",
      "assistant_message",
      "done",
      "user_message",
      "assistant_message",
      "done",
    ]);
    expect(onDisk.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // 水合的历史不触发实时推送：sent 只含本轮新事件
    // （assistant_delta 为瞬时推送通道，seq 0 不落盘）
    expect(sent.map((event) => event.type)).toEqual(["user_message", "assistant_delta", "assistant_message", "done"]);
  });

  it("未知会话 trace() 返回空数组；sessionId 非法字符被白名单化防路径穿越", async () => {
    const { runtime } = makeRuntime(new ScriptedProvider([]));
    expect(runtime.trace("不存在")).toEqual([]);
    // 含路径分隔符的 sessionId 不逃逸 tracesDir
    await runtime.run({
      sessionId: "../../escape",
      userText: "试探",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });
    const tracesDir = path.join(tmpRoot, "traces");
    expect(readTraceFile(".._.._escape").length).toBeGreaterThan(0);
    expect(existsSync(path.join(tracesDir, "..", "..", "escape.jsonl"))).toBe(false);
  });

  it("内置模式编辑（绑定模型）持久化：新实例水合后保留且 builtin 标志不变", () => {
    const { runtime: runtime1 } = makeRuntime(new ScriptedProvider([]));
    const agent = runtime1.listModes().find((mode) => mode.id === "agent");
    expect(agent).toBeDefined();
    runtime1.upsertMode({ ...agent!, providerId: "p-test" });

    // 模拟重启：同 settings 目录的新实例 → 内置 agent 的绑定仍在
    const { runtime: runtime2 } = makeRuntime(new ScriptedProvider([]));
    const restored = runtime2.listModes().find((mode) => mode.id === "agent");
    expect(restored?.providerId).toBe("p-test");
    expect(restored?.builtin).toBe(true);
  });
});
