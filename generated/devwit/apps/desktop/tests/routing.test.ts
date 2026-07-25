/**
 * AiRuntime 本地小模型路由（迭代 22 / AC31）集成测试。
 *
 * 真实 SettingsStore + 真实 tmp 目录落盘；provider 工厂按 id 分发两个脚本化
 * provider（p-local / p-cloud），验证「简单→本地 / 复杂→绑定 / 手动→跳过 /
 * 关开关→禁用 / 本地缺失→回退」的完整链路，及 route 事件实时推送与落盘可审计。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentTraceEvent,
  ChatMessage,
  LLMProvider,
  ProviderConfig,
  RouteDecision,
  StreamEvent,
} from "@devwit/contracts";
import { IPC } from "@devwit/contracts";
import { NodeCryptoBackend, SettingsStore } from "@devwit/settings";
import type { WorkspaceService } from "@devwit/workspace";
import { AiRuntime } from "../src/main/ai-runtime.js";

class ScriptedProvider implements LLMProvider {
  readonly config: ProviderConfig;
  readonly calls: ChatMessage[][] = [];
  private readonly scripts: StreamEvent[][];

  constructor(id: string, scripts: StreamEvent[][]) {
    this.config = {
      id,
      type: "openai",
      label: id,
      baseUrl: "https://example.invalid",
      model: `${id}-model`,
      credentialRef: `cred-${id}`,
      maxTokens: 1024,
    };
    this.scripts = [...scripts];
  }

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

interface Harness {
  runtime: AiRuntime;
  sent: AgentTraceEvent[];
  providers: Map<string, ScriptedProvider>;
  requestedIds: string[];
  settings: SettingsStore;
}

function makeRuntime(scripts: Record<string, StreamEvent[][]>): Harness {
  const sent: AgentTraceEvent[] = [];
  const requestedIds: string[] = [];
  const providers = new Map<string, ScriptedProvider>();
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
    createProvider: (id: string) => {
      requestedIds.push(id);
      let provider = providers.get(id);
      if (provider === undefined) {
        provider = new ScriptedProvider(id, scripts[id] ?? []);
        providers.set(id, provider);
      }
      return provider;
    },
  });
  // 注册两个 provider（路由查 registry 可用性）+ agent 模式绑定云端
  runtime.upsertProvider(new ScriptedProvider("p-local", []).config);
  runtime.upsertProvider(new ScriptedProvider("p-cloud", []).config);
  const agent = runtime.listModes().find((mode) => mode.id === "agent");
  runtime.upsertMode({ ...agent!, providerId: "p-cloud", updatedAt: new Date().toISOString() });
  return { runtime, sent, providers, requestedIds, settings };
}

function enableRouting(h: Harness, config: { enabled: boolean; providerId: string; threshold: number }): void {
  // 热更新语义：run 每次实时读 settings，无需重建 runtime
  h.settings.set("routing.local", config);
}

function routeEvents(sent: AgentTraceEvent[]): RouteDecision[] {
  return sent.filter((event) => event.type === "route").map((event) => event.detail as RouteDecision);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "devwit-ac31-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("AiRuntime 本地路由（AC31）", () => {
  it("简单任务 → 请求发给本地 provider；route 事件推送 + 落盘可审计", async () => {
    const h = makeRuntime({ "p-local": [textThenDone("本地答")] });
    enableRouting(h.runtime, { enabled: true, providerId: "p-local", threshold: 30 });
    await h.runtime.run({ sessionId: "s-1", userText: "改一下按钮颜色", modeId: "agent", workspaceRoot: tmpRoot });

    expect(h.requestedIds).toEqual(["p-local"]);
    const routes = routeEvents(h.sent);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ routed: "local", providerId: "p-local", score: 0, threshold: 30 });

    const onDisk = readFileSync(path.join(tmpRoot, "traces", "s-1.jsonl"), "utf-8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentTraceEvent);
    expect(onDisk[0]!.type).toBe("route"); // 路由决策是本轮起点（先于 user_message）
    expect((onDisk[0]!.detail as RouteDecision).routed).toBe("local");
  });

  it("复杂任务（重构关键词+整个项目）→ 模式绑定云端 provider", async () => {
    const h = makeRuntime({ "p-cloud": [textThenDone("云端答")] });
    enableRouting(h.runtime, { enabled: true, providerId: "p-local", threshold: 30 });
    await h.runtime.run({ sessionId: "s-2", userText: "重构整个项目的架构", modeId: "agent", workspaceRoot: tmpRoot });

    expect(h.requestedIds).toEqual(["p-cloud"]);
    const routes = routeEvents(h.sent);
    expect(routes[0]!.routed).toBe("complex");
    expect(routes[0]!.score).toBeGreaterThanOrEqual(30);
    expect(routes[0]!.reasons.length).toBeGreaterThan(0);
  });

  it("编排模式强制复杂（+40）→ 云端；子 Agent 继承同一 provider", async () => {
    const h = makeRuntime({ "p-cloud": [textThenDone("短"), textThenDone("综合")] });
    enableRouting(h.runtime, { enabled: true, providerId: "p-local", threshold: 30 });
    const orchestrator = h.runtime.listModes().find((mode) => mode.id === "orchestrator");
    h.runtime.upsertMode({ ...orchestrator!, providerId: "p-cloud", updatedAt: new Date().toISOString() });
    await h.runtime.run({ sessionId: "s-3", userText: "短任务", modeId: "orchestrator", workspaceRoot: tmpRoot });

    expect(h.requestedIds[0]).toBe("p-cloud");
    expect(routeEvents(h.sent)[0]).toMatchObject({ routed: "complex", reasons: ["orchestrate"] });
  });

  it("开关关闭 → disabled，简单任务也走模式绑定", async () => {
    const h = makeRuntime({ "p-cloud": [textThenDone("云端答")] });
    enableRouting(h.runtime, { enabled: false, providerId: "p-local", threshold: 30 });
    await h.runtime.run({ sessionId: "s-4", userText: "改颜色", modeId: "agent", workspaceRoot: tmpRoot });
    expect(h.requestedIds).toEqual(["p-cloud"]);
    expect(routeEvents(h.sent)[0]!.routed).toBe("disabled");
  });

  it("本地 provider 未注册 → unavailable 回退模式绑定（不伪造本地能力）", async () => {
    const h = makeRuntime({ "p-cloud": [textThenDone("云端答")] });
    enableRouting(h.runtime, { enabled: true, providerId: "p-gone", threshold: 30 });
    await h.runtime.run({ sessionId: "s-5", userText: "改颜色", modeId: "agent", workspaceRoot: tmpRoot });
    expect(h.requestedIds).toEqual(["p-cloud"]);
    expect(routeEvents(h.sent)[0]).toMatchObject({ routed: "unavailable", providerId: "p-cloud" });
  });

  it("用户会话中手动切模型（input.providerId）→ manual 跳过路由", async () => {
    const h = makeRuntime({ "p-cloud": [textThenDone("云端答")] });
    enableRouting(h.runtime, { enabled: true, providerId: "p-local", threshold: 30 });
    await h.runtime.run({ sessionId: "s-6", userText: "改颜色", modeId: "agent", providerId: "p-cloud", workspaceRoot: tmpRoot });
    expect(h.requestedIds).toEqual(["p-cloud"]);
    expect(routeEvents(h.sent)[0]!.routed).toBe("manual");
  });

  it("路由配置热更新：改 settings 后下一次 run 即按新配置决策（无需重启）", async () => {
    const h = makeRuntime({ "p-local": [textThenDone("本地答")], "p-cloud": [textThenDone("云端答")] });
    enableRouting(h.runtime, { enabled: false, providerId: "p-local", threshold: 30 });
    await h.runtime.run({ sessionId: "s-7", userText: "改颜色", modeId: "agent", workspaceRoot: tmpRoot });
    enableRouting(h.runtime, { enabled: true, providerId: "p-local", threshold: 30 });
    await h.runtime.run({ sessionId: "s-8", userText: "改颜色", modeId: "agent", workspaceRoot: tmpRoot });
    expect(h.requestedIds).toEqual(["p-cloud", "p-local"]);
  });
});
