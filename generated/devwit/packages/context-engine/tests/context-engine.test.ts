import type { ContextManifest, ToolDefinition } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import {
  ContextEngine,
  DEFAULT_CONTEXT_POLICY,
  resolveItemEnabled,
  type ContextBuildInput,
  type ManifestStore,
} from "../src/context-engine.js";
import { gitStatusSource } from "../src/sources.js";
import { EstimatedCounter, TiktokenCounter } from "../src/token-counter.js";

const TOOLS: ToolDefinition[] = [
  {
    name: "read",
    description: "读取文件",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

function makeInput(overrides: Partial<ContextBuildInput> = {}): ContextBuildInput {
  return {
    modeId: "chat",
    providerId: "p1",
    model: "claude-sonnet-4-20250514",
    systemPrompt: "你是 DevWit。",
    tools: TOOLS,
    workspaceRoot: "C:\\repo",
    conversationHistory: [{ role: "user", content: "你好" }],
    ...overrides,
  };
}

class MemoryManifestStore implements ManifestStore {
  readonly saved: ContextManifest[] = [];
  save(manifest: ContextManifest): void {
    this.saved.push(manifest);
  }
}

describe("ContextEngine.build（AR007 默认极简）", () => {
  it("默认仅 system_prompt + tool_definitions 开启，其余项零注入但保留在 manifest", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.registerSource(gitStatusSource(async () => "M a.ts"));
    const { manifest, messages, tools } = await engine.build(makeInput());

    const byType = new Map(manifest.items.map((item) => [item.type, item]));
    expect(byType.get("system_prompt")?.enabled).toBe(true);
    expect(byType.get("tool_definitions")?.enabled).toBe(true);
    expect(byType.get("git_status")?.enabled).toBe(false);

    // 未开启项：content 置空、tokens=0，但条目可见（AC2）
    expect(byType.get("git_status")?.content).toBe("");
    expect(byType.get("git_status")?.tokens).toBe(0);

    // 消息零注入：只有 system，无任何上下文段；历史默认关闭
    expect(messages).toEqual([{ role: "system", content: "你是 DevWit。" }]);
    expect(tools).toEqual(TOOLS);
  });

  it("manifest 字段完整：id/timestamp/sessionId/modeId/providerId/model/totalTokens/systemPromptTokens", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    const { manifest } = await engine.build(makeInput());
    expect(manifest.id).toMatch(/^manifest-/);
    expect(Number.isNaN(Date.parse(manifest.timestamp))).toBe(false);
    expect(manifest.sessionId).toBe("s1");
    expect(manifest.modeId).toBe("chat");
    expect(manifest.providerId).toBe("p1");
    expect(manifest.model).toBe("claude-sonnet-4-20250514");
    expect(manifest.totalTokens).toBe(manifest.items.reduce((sum, item) => sum + item.tokens, 0));
    expect(manifest.systemPromptTokens).toBe(new TiktokenCounter().count("你是 DevWit。"));
    expect(manifest.systemPromptTokens).toBeGreaterThan(0);
  });

  it("每次 build 经 ManifestStore 落盘一份 manifest，latestManifest 可查询", async () => {
    const store = new MemoryManifestStore();
    const engine = new ContextEngine({ sessionId: "s1", manifestStore: store });
    expect(engine.getLatestManifest()).toBeNull();
    const first = await engine.build(makeInput());
    const second = await engine.build(makeInput());
    expect(store.saved.map((m) => m.id)).toEqual([first.manifest.id, second.manifest.id]);
    expect(engine.getLatestManifest()?.id).toBe(second.manifest.id);
  });

  it("setTypeEnabled 逐项开关：开启后注入并计数，关闭后回到零注入", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.registerSource(gitStatusSource(async () => "M a.ts"));

    engine.setTypeEnabled("git_status", true);
    const on = await engine.build(makeInput());
    const gitItem = on.manifest.items.find((item) => item.type === "git_status");
    expect(gitItem?.enabled).toBe(true);
    expect(gitItem?.content).toBe("M a.ts");
    expect(gitItem?.tokens).toBeGreaterThan(0);
    expect(on.messages.some((m) => m.role === "user" && m.content.includes("M a.ts"))).toBe(true);

    engine.setTypeEnabled("git_status", false);
    const off = await engine.build(makeInput());
    expect(off.manifest.items.find((item) => item.type === "git_status")?.enabled).toBe(false);
    expect(off.messages).toHaveLength(1);
  });

  it("模式策略覆盖默认；用户开关覆盖模式策略", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.registerSource(gitStatusSource(async () => "M a.ts"));

    const modeOn = await engine.build(makeInput({ contextPolicy: { git_status: true } }));
    expect(modeOn.manifest.items.find((item) => item.type === "git_status")?.enabled).toBe(true);

    engine.setTypeEnabled("git_status", false);
    const userOff = await engine.build(makeInput({ contextPolicy: { git_status: true } }));
    expect(userOff.manifest.items.find((item) => item.type === "git_status")?.enabled).toBe(false);
  });

  it("tool_definitions 关闭时 tools 置空；conversation_history 开启时历史进入消息", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.setTypeEnabled("tool_definitions", false);
    engine.setTypeEnabled("conversation_history", true);
    const { tools, messages } = await engine.build(makeInput());
    expect(tools).toEqual([]);
    expect(messages).toEqual([
      { role: "system", content: "你是 DevWit。" },
      { role: "user", content: "你好" },
    ]);
  });

  it("token 计数标注：TiktokenCounter → exact；EstimatedCounter → estimated", async () => {
    const exact = new ContextEngine({ sessionId: "s1" });
    const estimated = new ContextEngine({ sessionId: "s1", counter: new EstimatedCounter() });
    const exactBuild = await exact.build(makeInput());
    const estimatedBuild = await estimated.build(makeInput());
    expect(exactBuild.manifest.items.every((item) => item.counting === "exact")).toBe(true);
    expect(estimatedBuild.manifest.items.every((item) => item.counting === "estimated")).toBe(true);
  });

  it("getPolicyView 反映 默认 ← 模式 ← 用户 的合成结果", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    expect(engine.getPolicyView()).toEqual(DEFAULT_CONTEXT_POLICY);
    engine.setTypeEnabled("selection", true);
    const view = engine.getPolicyView({ git_status: true });
    expect(view.git_status).toBe(true);
    expect(view.selection).toBe(true);
    expect(view.system_prompt).toBe(true);
    expect(view.terminal_output).toBe(false);
  });
});

describe("resolveItemEnabled 优先级", () => {
  it("用户开关 > 模式策略 > 引擎默认", () => {
    const overrides = new Map([["git_status", false]] as const);
    expect(resolveItemEnabled("git_status", overrides, { git_status: true })).toBe(false);
    expect(resolveItemEnabled("git_status", new Map(), { git_status: true })).toBe(true);
    expect(resolveItemEnabled("git_status", new Map(), undefined)).toBe(false);
    expect(resolveItemEnabled("system_prompt", new Map(), undefined)).toBe(true);
  });
});

describe("setItemOverride 逐项开关（AC19 codebase_match 单块剔除）", () => {
  /** 产出两个带稳定 key 的 codebase_match 项的测试源。 */
  function keyedSource() {
    return {
      type: "codebase_match" as const,
      async collect() {
        return [
          { id: "i1", type: "codebase_match" as const, label: "a.ts L1-5", enabled: true, tokens: 0, content: "AAA", source: "a.ts", counting: "exact" as const, key: "chunk-a", score: 0.9 },
          { id: "i2", type: "codebase_match" as const, label: "b.ts L1-5", enabled: true, tokens: 0, content: "BBB", source: "b.ts", counting: "exact" as const, key: "chunk-b", score: 0.8 },
        ];
      },
    };
  }

  function enabledEngine() {
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.registerSource(keyedSource());
    engine.setTypeEnabled("codebase_match", true);
    return engine;
  }

  it("剔除单块：该块零注入（tokens=0/content 空），其余块不受影响", async () => {
    const engine = enabledEngine();
    engine.setItemOverride("chunk-a", false);
    const { manifest, messages } = await engine.build(makeInput());
    const a = manifest.items.find((item) => item.key === "chunk-a");
    const b = manifest.items.find((item) => item.key === "chunk-b");
    expect(a?.enabled).toBe(false);
    expect(a?.tokens).toBe(0);
    expect(a?.content).toBe(""); // 剔除后内容不留在 manifest（与类型关闭语义一致）
    expect(b?.enabled).toBe(true);
    expect(b?.tokens).toBeGreaterThan(0);
    // 消息只注入 BBB
    const injected = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    expect(injected).toContain("BBB");
    expect(injected).not.toContain("AAA");
  });

  it("恢复单块：clearItemOverride 后重新注入", async () => {
    const engine = enabledEngine();
    engine.setItemOverride("chunk-a", false);
    engine.clearItemOverride("chunk-a");
    const { manifest } = await engine.build(makeInput());
    expect(manifest.items.find((item) => item.key === "chunk-a")?.enabled).toBe(true);
  });

  it("类型是总闸：codebase_match 类型关闭时 item override 无法复活单块", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.registerSource(keyedSource());
    engine.setItemOverride("chunk-a", true); // 显式开
    engine.setTypeEnabled("codebase_match", false); // 类型关
    const { manifest, messages } = await engine.build(makeInput());
    expect(manifest.items.find((item) => item.key === "chunk-a")?.enabled).toBe(false);
    expect(messages).toHaveLength(1); // 零注入
  });

  it("无 key 项不受 itemOverrides 影响（占位项仅受类型开关控制）", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    engine.registerSource({
      type: "custom",
      async collect() {
        return [{ id: "x", type: "custom" as const, label: "占位", enabled: true, tokens: 0, content: "PLACE", counting: "exact" as const }];
      },
    });
    engine.setTypeEnabled("custom", true);
    engine.setItemOverride("nonexistent-key", false);
    const { manifest } = await engine.build(makeInput());
    expect(manifest.items.find((item) => item.type === "custom")?.enabled).toBe(true);
  });
});
