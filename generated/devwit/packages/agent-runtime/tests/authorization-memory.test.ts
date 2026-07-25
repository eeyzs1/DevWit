import { describe, expect, it } from "vitest";
import {
  CommandWhitelistMemory,
  DEFAULT_LEARNING,
  normalizeCommand,
  type CommandWhitelistSnapshot,
} from "../src/authorization-memory.js";

/** 内存 store：快照可变，写回留痕。 */
function makeStore(initial?: Partial<CommandWhitelistSnapshot>) {
  const snapshot: CommandWhitelistSnapshot = {
    whitelist: initial?.whitelist ?? [],
    approvals: initial?.approvals ?? {},
    learning: initial?.learning ?? { ...DEFAULT_LEARNING },
  };
  return {
    snapshot,
    read: () => snapshot,
    write: (whitelist: string[], approvals: Record<string, number>) => {
      snapshot.whitelist = whitelist;
      snapshot.approvals = approvals;
    },
  };
}

describe("normalizeCommand（AC29 空白归一化）", () => {
  it("trim + 连续空白折叠为单空格", () => {
    expect(normalizeCommand("  npm   test  ")).toBe("npm test");
    expect(normalizeCommand("git\tstatus\n")).toBe("git status");
    expect(normalizeCommand("ls")).toBe("ls");
  });
});

describe("CommandWhitelistMemory（AC29 授权白名单学习）", () => {
  it("白名单命中：仅 bash + 精确匹配（归一化后）+ 学习开启", () => {
    const store = makeStore({ whitelist: ["git status"] });
    const memory = new CommandWhitelistMemory(store);
    expect(memory.isWhitelisted("bash", { command: "git status" })).toBe(true);
    expect(memory.isWhitelisted("bash", { command: "  git   status " })).toBe(true);
    expect(memory.isWhitelisted("bash", { command: "git status -s" })).toBe(false);
    expect(memory.isWhitelisted("write", { path: "a.txt" })).toBe(false);
    expect(memory.isWhitelisted("mcp__fs__read", {})).toBe(false);
  });

  it("学习关闭时命中检查与计数都短路", () => {
    const store = makeStore({ whitelist: ["ls"], learning: { enabled: false, threshold: 2 } });
    const memory = new CommandWhitelistMemory(store);
    expect(memory.isWhitelisted("bash", { command: "ls" })).toBe(false);
    memory.recordDecision("bash", { command: "ls" }, "allow");
    expect(store.snapshot.approvals).toEqual({});
    expect(store.snapshot.whitelist).toEqual(["ls"]);
  });

  it("学习链路：allow 累计达阈值毕业；deny/allow_session 不计数；非 bash 不学习", () => {
    const store = makeStore();
    const learned: string[] = [];
    const memory = new CommandWhitelistMemory(store, (command) => learned.push(command));

    memory.recordDecision("bash", { command: "npm test" }, "deny");
    memory.recordDecision("bash", { command: "npm test" }, "allow_session");
    memory.recordDecision("write", { path: "a.txt" }, "allow");
    expect(store.snapshot.approvals).toEqual({});

    memory.recordDecision("bash", { command: " npm   test " }, "allow");
    expect(store.snapshot.approvals).toEqual({ "npm test": 1 });
    expect(memory.isWhitelisted("bash", { command: "npm test" })).toBe(false);

    memory.recordDecision("bash", { command: "npm test" }, "allow");
    expect(store.snapshot.whitelist).toEqual(["npm test"]);
    expect(store.snapshot.approvals).toEqual({});
    expect(learned).toEqual(["npm test"]);
    expect(memory.isWhitelisted("bash", { command: "npm test" })).toBe(true);

    // 已在白名单中的命令不再重复计数/触发回调
    memory.recordDecision("bash", { command: "npm test" }, "allow");
    expect(learned).toEqual(["npm test"]);
    expect(store.snapshot.approvals).toEqual({});
  });

  it("阈值可配：threshold=1 时首次批准即毕业；非法阈值按 1 兜底", () => {
    const store = makeStore({ learning: { enabled: true, threshold: 1 } });
    const memory = new CommandWhitelistMemory(store);
    memory.recordDecision("bash", { command: "make build" }, "allow");
    expect(store.snapshot.whitelist).toEqual(["make build"]);
  });

  it("异常 args 不崩溃：非字符串 command / 空命令不参与", () => {
    const store = makeStore();
    const memory = new CommandWhitelistMemory(store);
    expect(memory.isWhitelisted("bash", {})).toBe(false);
    expect(memory.isWhitelisted("bash", { command: 42 })).toBe(false);
    memory.recordDecision("bash", { command: "   " }, "allow");
    memory.recordDecision("bash", {}, "allow");
    expect(store.snapshot.approvals).toEqual({});
  });
});
