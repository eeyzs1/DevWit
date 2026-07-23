import type { ModeDefinition } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_MODE,
  BUILTIN_CHAT_MODE,
  ModeStore,
  resolveModeContextPolicy,
  validateModeDefinition,
} from "../src/mode-store.js";

function makeMode(overrides: Partial<ModeDefinition> = {}): ModeDefinition {
  return {
    id: "review",
    name: "代码审查",
    description: "审查选区代码",
    systemPrompt: "你是严格的代码审查者。",
    tools: ["read", "grep"],
    providerId: "p1",
    contextPolicy: { selection: true },
    builtin: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("内置模式", () => {
  it("store 构造即种入 chat/agent 两个内置模式", () => {
    const store = new ModeStore();
    const ids = store.list().map((mode) => mode.id);
    expect(ids).toEqual(["chat", "agent"]);
    expect(store.get("chat")?.builtin).toBe(true);
    expect(store.get("agent")?.builtin).toBe(true);
    expect(store.get("agent")?.tools).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
    expect(store.get("chat")?.tools).toEqual([]);
  });

  it("内置模式定义本身通过 schema 校验", () => {
    expect(() => validateModeDefinition(BUILTIN_CHAT_MODE)).not.toThrow();
    expect(() => validateModeDefinition(BUILTIN_AGENT_MODE)).not.toThrow();
  });
});

describe("ModeStore CRUD", () => {
  it("upsert 新建后可查询；get/list 返回副本（外部改动不影响 store）", () => {
    const store = new ModeStore();
    store.upsert(makeMode());
    const fetched = store.get("review");
    expect(fetched?.name).toBe("代码审查");
    fetched?.tools.push("bash");
    expect(store.get("review")?.tools).toEqual(["read", "grep"]);
    expect(store.list().map((mode) => mode.id)).toEqual(["chat", "agent", "review"]);
  });

  it("upsert 编辑已有模式：createdAt 保留、updatedAt 刷新、builtin 不可被覆盖", () => {
    const store = new ModeStore();
    store.upsert(makeMode({ id: "chat", builtin: false, systemPrompt: "改过的提示词" }));
    const chat = store.get("chat");
    expect(chat?.systemPrompt).toBe("改过的提示词");
    expect(chat?.builtin).toBe(true);
    expect(chat?.createdAt).toBe(BUILTIN_CHAT_MODE.createdAt);
    expect(chat?.updatedAt).not.toBe(BUILTIN_CHAT_MODE.updatedAt);
    expect(Number.isNaN(Date.parse(chat?.updatedAt ?? ""))).toBe(false);
  });

  it("delete：用户模式可删；内置模式抛错；不存在返回 false", () => {
    const store = new ModeStore();
    store.upsert(makeMode());
    expect(store.delete("review")).toBe(true);
    expect(store.get("review")).toBeUndefined();
    expect(store.delete("review")).toBe(false);
    expect(() => store.delete("agent")).toThrow(/builtin mode cannot be deleted/);
  });

  it("replaceAll：清空用户模式、保留内置、装入给定列表；含非法模式则整体拒绝", () => {
    const store = new ModeStore();
    store.upsert(makeMode({ id: "temp" }));
    store.replaceAll([makeMode({ id: "a" }), makeMode({ id: "b" })]);
    expect(store.list().map((mode) => mode.id)).toEqual(["chat", "agent", "a", "b"]);
    expect(() => store.replaceAll([makeMode({ id: "" })])).toThrow(/mode id must not be empty/);
    expect(store.list().map((mode) => mode.id)).toEqual(["chat", "agent", "a", "b"]);
  });
});

describe("validateModeDefinition", () => {
  it("拒绝空 id/name、非法 tools、非法 contextPolicy", () => {
    expect(() => validateModeDefinition(makeMode({ id: " " }))).toThrow(/mode id must not be empty/);
    expect(() => validateModeDefinition(makeMode({ name: "" }))).toThrow(/mode name must not be empty/);
    expect(() => validateModeDefinition(makeMode({ tools: ["read", " "] }))).toThrow(/tools/);
    expect(() => validateModeDefinition(makeMode({ contextPolicy: { selection: "yes" as unknown as boolean } }))).toThrow(
      /must be a boolean/
    );
    expect(
      () => validateModeDefinition(makeMode({ contextPolicy: { nope: true } as ModeDefinition["contextPolicy"] }))
    ).toThrow(/unknown context type/);
  });
});

describe("热更新", () => {
  it("upsert/delete/replaceAll 触发 onDidChange；退订后不再触发", () => {
    const store = new ModeStore();
    let count = 0;
    const unsubscribe = store.onDidChange(() => {
      count += 1;
    });
    store.upsert(makeMode());
    store.delete("review");
    store.replaceAll([]);
    expect(count).toBe(3);
    unsubscribe();
    store.upsert(makeMode({ id: "x" }));
    expect(count).toBe(3);
  });
});

describe("resolveModeContextPolicy", () => {
  it("模式覆盖合并到引擎默认：未提及类型保持默认极简", () => {
    const policy = resolveModeContextPolicy(makeMode({ contextPolicy: { selection: true, git_status: true } }));
    expect(policy.selection).toBe(true);
    expect(policy.git_status).toBe(true);
    expect(policy.system_prompt).toBe(true);
    expect(policy.tool_definitions).toBe(true);
    expect(policy.terminal_output).toBe(false);
  });
});
