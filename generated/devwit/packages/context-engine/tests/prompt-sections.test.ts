import type { ContextManifest, ToolDefinition } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { ContextEngine } from "../src/context-engine.js";
import {
  FIRST_PARTY_SECTION_ORDER,
  PromptSectionRegistry,
  type PromptSection,
} from "../src/prompt-sections.js";

const TOOLS: ToolDefinition[] = [
  {
    name: "read",
    description: "读取文件",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

function makeInput(systemPrompt = "你是 DevWit。") {
  return {
    modeId: "agent",
    providerId: "p1",
    model: "claude-sonnet-4-20250514",
    systemPrompt,
    tools: TOOLS,
    workspaceRoot: "C:\\repo",
    conversationHistory: [{ role: "user", content: "你好" }],
  };
}

describe("PromptSectionRegistry（B-WU4 系统提示段注册表）", () => {
  it("按 order 升序拼接，同序按名字序", () => {
    const reg = new PromptSectionRegistry();
    reg.register({ name: "b", order: 200, text: "B 段" });
    reg.register({ name: "a", order: 200, text: "A 段" });
    reg.register({ name: "mode", order: 0, text: "模式提示" });
    const out = reg.assemble({ modeId: "agent", providerId: "p1", model: "m" });
    expect(out.text).toBe("模式提示\n\nA 段\n\nB 段");
    expect(out.sections.map((s) => s.name)).toEqual(["mode", "a", "b"]);
  });

  it("重复名注册抛错（fail-closed）；注销后可重注册", () => {
    const reg = new PromptSectionRegistry();
    const dispose = reg.register({ name: "dup", order: 0, text: "x" });
    expect(() => reg.register({ name: "dup", order: 10, text: "y" })).toThrow(/duplicate prompt section/);
    dispose();
    reg.register({ name: "dup", order: 10, text: "y" });
    expect(reg.list()).toHaveLength(1);
  });

  it("函数段按组装上下文求值；空段被过滤", () => {
    const reg = new PromptSectionRegistry();
    reg.register({
      name: "mode",
      order: FIRST_PARTY_SECTION_ORDER.mode,
      text: (ctx) => `模式:${ctx.modeId} 模型:${ctx.model}`,
    });
    reg.register({ name: "empty", order: 50, text: "   " });
    const out = reg.assemble({ modeId: "agent", providerId: "p1", model: "m1" });
    expect(out.text).toBe("模式:agent 模型:m1");
  });

  it("complete 段成为唯一系统提示；两个 complete 组装失败", () => {
    const reg = new PromptSectionRegistry();
    reg.register({ name: "mode", order: 0, text: "普通段" });
    reg.register({ name: "special", order: 500, text: "唯一提示", complete: true });
    expect(reg.assemble({ modeId: "a", providerId: "p", model: "m" }).text).toBe("唯一提示");

    reg.register({ name: "special2", order: 600, text: "冲突", complete: true });
    expect(() => reg.assemble({ modeId: "a", providerId: "p", model: "m" })).toThrow(
      /multiple effective complete/,
    );
  });
});

describe("ContextEngine promptSections 集成（B-WU4）", () => {
  it("注册表存在：系统提示为组装结果，manifest 记录段组成", async () => {
    const reg = new PromptSectionRegistry();
    reg.register({ name: "mode", order: FIRST_PARTY_SECTION_ORDER.mode, text: "模式提示" });
    reg.register({ name: "safety", order: FIRST_PARTY_SECTION_ORDER.safety, text: "安全约束" });
    const engine = new ContextEngine({ sessionId: "s1", promptSections: reg });
    const out = await engine.build(makeInput("会被替代"));
    const system = out.messages.find((m) => m.role === "system");
    expect(system?.content).toBe("模式提示\n\n安全约束");
    const manifest = engine.getLatestManifest() as ContextManifest;
    expect(manifest.promptSections).toEqual([
      { name: "mode", order: 0 },
      { name: "safety", order: 300 },
    ]);
    expect(manifest.systemPromptTokens).toBeGreaterThan(0);
  });

  it("无注册表：走 input.systemPrompt（向后兼容），manifest 无 promptSections", async () => {
    const engine = new ContextEngine({ sessionId: "s1" });
    const out = await engine.build(makeInput("你是 DevWit。"));
    expect(out.messages.find((m) => m.role === "system")?.content).toBe("你是 DevWit。");
    expect(engine.getLatestManifest()?.promptSections).toBeUndefined();
  });

  it("热生效：注册新段后下一次 build 立即包含", async () => {
    const reg = new PromptSectionRegistry();
    reg.register({ name: "mode", order: 0, text: "模式提示" });
    const engine = new ContextEngine({ sessionId: "s1", promptSections: reg });
    await engine.build(makeInput());
    reg.register({ name: "tools", order: FIRST_PARTY_SECTION_ORDER.tools, text: "工具纪律" });
    const out = await engine.build(makeInput());
    expect(out.messages.find((m) => m.role === "system")?.content).toBe("模式提示\n\n工具纪律");
  });
});
