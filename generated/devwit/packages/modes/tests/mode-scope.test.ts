import { describe, expect, it } from "vitest";
import { ModeScopeRegistry, type ModeScopeEntry } from "../src/mode-scope.js";
import { ModeStore } from "../src/mode-store.js";

describe("ModeScopeRegistry（B-WU5 per-mode 作用域）", () => {
  it("隔离保证：mode A 注册的条目在 mode B 下不可见", () => {
    const scope = new ModeScopeRegistry();
    scope.register("agent", "prompt_section", "tool-discipline", "先读后写");
    scope.register("chat", "prompt_section", "concision", "直接回答");

    const agentSections = scope.list("agent", "prompt_section").map((e) => e.value);
    const chatSections = scope.list("chat", "prompt_section").map((e) => e.value);
    expect(agentSections).toEqual(["先读后写"]);
    expect(chatSections).toEqual(["直接回答"]);
    expect(scope.sectionsOf("agent")).not.toContain("直接回答");
    expect(scope.sectionsOf("chat")).not.toContain("先读后写");
  });

  it("kind 标签划分：同模式不同 kind 互不串扰", () => {
    const scope = new ModeScopeRegistry();
    scope.register("agent", "tool", "my-tool", { name: "my_tool" });
    scope.register("agent", "prompt_section", "my-tool", "提示段");
    expect(scope.toolsOf("agent")).toHaveLength(1);
    expect(scope.sectionsOf("agent")).toEqual(["提示段"]);
    expect(scope.list("agent", "context_source")).toHaveLength(0);
  });

  it("注销即回滚（unwind）；重复注册抛错（fail-closed）", () => {
    const scope = new ModeScopeRegistry();
    const dispose = scope.register("agent", "tool", "k1", 1);
    expect(() => scope.register("agent", "tool", "k1", 2)).toThrow(/duplicate mode-scope entry/);
    dispose();
    scope.register("agent", "tool", "k1", 3);
    expect(scope.toolsOf("agent")).toEqual([3]);
  });

  it("热生效：注册后下一次读取立即可见（无需重建）", () => {
    const scope = new ModeScopeRegistry();
    expect(scope.sectionsOf("agent")).toEqual([]);
    scope.register("agent", "prompt_section", "s1", "新段");
    expect(scope.sectionsOf("agent")).toEqual(["新段"]);
  });

  it("all() 跨模式审计视图含 modeId/kind/registeredAt", () => {
    const scope = new ModeScopeRegistry();
    scope.register("agent", "tool", "t1", {});
    scope.register("chat", "context_source", "c1", {});
    const all: ModeScopeEntry[] = scope.all();
    expect(all).toHaveLength(2);
    for (const entry of all) {
      expect(entry.modeId).toBeDefined();
      expect(entry.kind).toBeDefined();
      expect(typeof entry.registeredAt).toBe("string");
    }
  });
});

describe("ModeStore.scope（B-WU5 集成）", () => {
  it("store 携带作用域注册空间，且与 CRUD 并存", () => {
    const store = new ModeStore();
    store.scope.register("agent", "prompt_section", "discipline", "先读后写");
    expect(store.scope.sectionsOf("agent")).toEqual(["先读后写"]);
    // CRUD 不受影响
    expect(store.get("agent")?.id).toBe("agent");
    expect(store.list().some((m) => m.id === "chat")).toBe(true);
  });
});
