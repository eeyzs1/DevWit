/**
 * AiRuntime 模式自进化（迭代 24 / AC33）集成测试。
 *
 * 真实 SettingsStore + 真实 tmp 目录落盘；脚本化 provider 驱动 run 定级：
 * - completed 记成功 / error 记失败 / cancelled 不定级（不毒化成功率）；
 * - 相似任务命中工作流模板且候选模式成功率不差于当前 → mode_recommend 事件
 *   实时推送 + 磁盘轨迹可审计（建议非自动切换）；
 * - settings "modes.stats" 是唯一事实源（热持久化）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentTraceEvent,
  ChatMessage,
  LLMProvider,
  ModeRecommendation,
  ModeRunStats,
  ProviderConfig,
  StreamEvent,
} from "@devwit/contracts";
import { IPC } from "@devwit/contracts";
import { NodeCryptoBackend, SettingsStore } from "@devwit/settings";
import type { WorkspaceService } from "@devwit/workspace";
import { AiRuntime } from "../src/main/ai-runtime.js";

class ScriptedProvider implements LLMProvider {
  readonly config: ProviderConfig;
  private readonly scripts: StreamEvent[][];

  constructor(id: string, scripts: StreamEvent[][] = []) {
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

  streamChat(_messages: ChatMessage[]): AsyncIterable<StreamEvent> {
    const script: StreamEvent[] = this.scripts.shift() ?? [{ type: "done", stopReason: "end_turn" }];
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of script) yield event;
      },
    };
  }
}

/** 一轮含工具调用的成功 run（两帧：tool_call → 文本收尾）。 */
function toolThenDone(tool: string): StreamEvent[][] {
  return [
    [
      { type: "tool_call", toolCall: { id: `c-${tool}`, name: tool, args: { path: "." } } },
      { type: "done", stopReason: "tool_use" },
    ],
    [
      { type: "text", text: "已完成。" },
      { type: "done", stopReason: "end_turn" },
    ],
  ];
}

function textThenDone(text: string): StreamEvent[][] {
  return [[{ type: "text", text }, { type: "done", stopReason: "end_turn" }]];
}

let tmpRoot = "";

interface Harness {
  runtime: AiRuntime;
  sent: AgentTraceEvent[];
  settings: SettingsStore;
}

function makeRuntime(scripts: StreamEvent[][]): Harness {
  const sent: AgentTraceEvent[] = [];
  const settings = new SettingsStore(new NodeCryptoBackend(), path.join(tmpRoot, "settings"));
  const workspace = { readFile: async () => "", onDidChange: () => () => {} } as unknown as WorkspaceService;
  const provider = new ScriptedProvider("p-main", scripts);
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
  runtime.upsertProvider(provider.config);
  // agent 与 chat 均绑定同一 provider（路由缺省关闭，恒走模式绑定）
  for (const id of ["agent", "chat"]) {
    const mode = runtime.listModes().find((candidate) => candidate.id === id);
    runtime.upsertMode({ ...mode!, providerId: "p-main", updatedAt: new Date().toISOString() });
  }
  return { runtime, sent, settings };
}

function readStats(settings: SettingsStore): ModeRunStats[] {
  const stored = settings.get("modes.stats");
  return Array.isArray(stored) ? (stored as ModeRunStats[]) : [];
}

function onDiskTrace(sessionId: string): AgentTraceEvent[] {
  return readFileSync(path.join(tmpRoot, "traces", `${sessionId}.jsonl`), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentTraceEvent);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "devwit-ac33-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("AiRuntime 模式自进化（AC33）", () => {
  it("run 定级：completed 记成功、error 记失败、cancelled 不定级；settings 持久化", async () => {
    const h = makeRuntime([
      ...textThenDone("好"), // s-1 completed
      [{ type: "error", error: "DW_BOOM", retryable: false }], // s-2 error
      [{ type: "done", stopReason: "cancelled" }], // s-3 cancelled（不定级）
    ]);
    await h.runtime.run({ sessionId: "s-1", userText: "改颜色", modeId: "agent", workspaceRoot: tmpRoot });
    await h.runtime.run({ sessionId: "s-2", userText: "改颜色", modeId: "agent", workspaceRoot: tmpRoot }).catch(() => undefined);
    await h.runtime.run({ sessionId: "s-3", userText: "改颜色", modeId: "agent", workspaceRoot: tmpRoot });

    const stats = readStats(h.settings);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ modeId: "agent", runs: 2, successes: 1 });
  });

  it("相似任务命中工作流且候选成功率达标 → mode_recommend 推送 + 落盘可审计", async () => {
    const h = makeRuntime([
      // 3 轮 agent 成功（每轮 2 帧），沉淀模板 + agent 3/3 成功率
      ...toolThenDone("ls"),
      ...toolThenDone("ls"),
      ...toolThenDone("ls"),
      // chat 轮（相似意图）：命中模板 → 推荐 agent；本轮 completed 后 chat 1/1
      ...textThenDone("好的"),
    ]);
    for (let i = 0; i < 3; i += 1) {
      await h.runtime.run({ sessionId: `s-agent-${i}`, userText: "为 login.ts 加输入校验", modeId: "agent", workspaceRoot: tmpRoot });
    }
    expect(readStats(h.settings)).toEqual([
      expect.objectContaining({ modeId: "agent", runs: 3, successes: 3 }),
    ]);

    await h.runtime.run({ sessionId: "s-chat", userText: "给 login.ts 加输入校验", modeId: "chat", workspaceRoot: tmpRoot });

    const pushed = h.sent.filter((event) => event.type === "mode_recommend");
    expect(pushed).toHaveLength(1);
    const detail = pushed[0]!.detail as ModeRecommendation;
    expect(detail).toMatchObject({
      phase: "recommend",
      modeId: "agent",
      currentModeId: "chat",
      reason: "workflow_hit",
      successRate: 1,
      currentSuccessRate: null, // 推荐发生于 chat 本轮定级前（无数据显式为 null）
      runs: 3,
    });
    expect(detail.intent).toContain("login.ts");

    // 磁盘轨迹：mode_recommend 紧随 workflow 事件（同一命中链路）
    const events = onDiskTrace("s-chat");
    const kinds = events.map((event) => event.type);
    const wfIdx = kinds.indexOf("workflow");
    const recIdx = kinds.indexOf("mode_recommend");
    expect(wfIdx).toBeGreaterThanOrEqual(0);
    expect(recIdx).toBe(wfIdx + 1);

    // chat 本轮 completed 后定级 1/1（推荐时的 null 是时序事实）
    expect(readStats(h.settings)).toEqual([
      expect.objectContaining({ modeId: "agent", runs: 3, successes: 3 }),
      expect.objectContaining({ modeId: "chat", runs: 1, successes: 1 }),
    ]);
  });

  it("候选模式定级数不足门槛 → 不推荐（防单次侥幸）", async () => {
    const h = makeRuntime([
      ...toolThenDone("ls"), // 仅 1 轮成功（< MIN_RUNS_FOR_RECOMMEND=3）
      ...textThenDone("好的"),
    ]);
    await h.runtime.run({ sessionId: "s-a", userText: "为 login.ts 加输入校验", modeId: "agent", workspaceRoot: tmpRoot });
    await h.runtime.run({ sessionId: "s-c", userText: "给 login.ts 加输入校验", modeId: "chat", workspaceRoot: tmpRoot });

    expect(h.sent.filter((event) => event.type === "mode_recommend")).toHaveLength(0);
    // 工作流命中仍发生（推荐是独立闸）
    expect(h.sent.some((event) => event.type === "workflow")).toBe(true);
  });
});
