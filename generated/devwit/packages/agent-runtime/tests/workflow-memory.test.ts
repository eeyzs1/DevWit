import { describe, expect, it } from "vitest";
import type { AgentTraceEvent, WorkflowTemplate } from "@devwit/contracts";
import {
  extractKeywords,
  MAX_WORKFLOW_TEMPLATES,
  parseWorkflowTemplates,
  WorkflowMemory,
} from "../src/workflow-memory.js";

/** 内存 store：与 authorization-memory 测试同模式。 */
function makeStore(initial: WorkflowTemplate[] = []) {
  let templates = initial;
  return {
    get snapshot() {
      return templates;
    },
    read: () => templates,
    write: (next: WorkflowTemplate[]) => {
      templates = next;
    },
  };
}

function makeEvent(type: AgentTraceEvent["type"], detail?: Record<string, unknown>): AgentTraceEvent {
  return {
    sessionId: "s1",
    ts: "2026-07-25T00:00:00.000Z",
    type,
    summary: "",
    ...(detail !== undefined ? { detail } : {}),
  } as AgentTraceEvent;
}

/** 一轮成功 run 的最小事件序列：用户意图 → 工具调用 → done。 */
function successRun(intent: string, tools: string[]): AgentTraceEvent[] {
  return [
    makeEvent("user_message", { text: intent }),
    ...tools.map((tool) => makeEvent("tool_call", { tool })),
    makeEvent("done"),
  ];
}

const NOW = new Date("2026-07-25T10:00:00.000Z");

describe("extractKeywords（AC32 关键词提取）", () => {
  it("拉丁词小写归一 + 文件名点号保留", () => {
    expect(extractKeywords("Fix Login.TS and USER-service")).toEqual(["fix", "login.ts", "and", "user-service"]);
  });

  it("中文 <=4 字整取 + 2-gram 滑窗", () => {
    const keywords = extractKeywords("输入校验");
    expect(keywords).toContain("输入校验");
    expect(keywords).toContain("输入");
    expect(keywords).toContain("入校");
    expect(keywords).toContain("校验");
    // 超 4 字 run 不整取，只有 2-gram
    const longer = extractKeywords("修复输入校验");
    expect(longer).not.toContain("修复输入校验");
    expect(longer).toContain("修复");
    expect(longer).toContain("复输");
  });

  it("空文本/纯标点无关键词", () => {
    expect(extractKeywords("")).toEqual([]);
    expect(extractKeywords("！！！??")).toEqual([]);
  });
});

describe("parseWorkflowTemplates（AC32 settings 反序列化）", () => {
  it("非数组/缺字段条目丢弃，合法条目保留", () => {
    const good: WorkflowTemplate = {
      id: "wf-1",
      intent: "加测试",
      modeId: "agent",
      tools: ["write"],
      learnedAt: "2026-07-25T00:00:00.000Z",
      reuseCount: 0,
    };
    expect(parseWorkflowTemplates(null)).toEqual([]);
    expect(parseWorkflowTemplates("x")).toEqual([]);
    expect(parseWorkflowTemplates([good, { id: 1 }, { id: "wf-2", intent: "缺字段" }])).toEqual([good]);
  });
});

describe("WorkflowMemory.learnFromRun（AC32 成功轨迹沉淀）", () => {
  it("成功 run（done 无 error 含工具调用）沉淀模板", () => {
    const store = makeStore();
    const memory = new WorkflowMemory(store);
    const template = memory.learnFromRun(successRun("给 login.ts 加输入校验", ["read", "write"]), "agent", NOW);
    expect(template).not.toBeNull();
    expect(template!.intent).toBe("给 login.ts 加输入校验");
    expect(template!.tools).toEqual(["read", "write"]);
    expect(template!.modeId).toBe("agent");
    expect(template!.reuseCount).toBe(0);
    expect(store.snapshot).toHaveLength(1);
  });

  it("无 done / 含 error / 无工具调用的 run 不够格", () => {
    const store = makeStore();
    const memory = new WorkflowMemory(store);
    // 中断（无 done）
    expect(memory.learnFromRun([makeEvent("user_message", { text: "x" }), makeEvent("tool_call", { tool: "read" })], "agent")).toBeNull();
    // 失败
    expect(memory.learnFromRun([...successRun("y", ["write"]), makeEvent("error")], "agent")).toBeNull();
    // 纯对话无工具
    expect(memory.learnFromRun([makeEvent("user_message", { text: "z" }), makeEvent("done")], "chat")).toBeNull();
    expect(store.snapshot).toEqual([]);
  });

  it("工具序列去重且保序；同意图再学刷新原模板（保 id 与 reuseCount）", () => {
    const store = makeStore();
    const memory = new WorkflowMemory(store);
    const first = memory.learnFromRun(successRun("加测试", ["read", "write", "read"]), "agent", NOW)!;
    expect(first.tools).toEqual(["read", "write"]);
    memory.markReused(first.id, NOW);
    const later = new Date("2026-07-25T11:00:00.000Z");
    const refreshed = memory.learnFromRun(successRun("加测试", ["bash"]), "chat", later)!;
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.tools).toEqual(["bash"]);
    expect(refreshed.modeId).toBe("chat");
    expect(refreshed.learnedAt).toBe(later.toISOString());
    expect(refreshed.reuseCount).toBe(1);
    expect(store.snapshot).toHaveLength(1);
  });

  it("超出上限逐出最久未刷新的模板", () => {
    const store = makeStore();
    const memory = new WorkflowMemory(store);
    for (let i = 0; i < MAX_WORKFLOW_TEMPLATES; i += 1) {
      memory.learnFromRun(successRun(`任务${i}`, ["read"]), "agent", new Date(NOW.getTime() + i * 1000));
    }
    expect(store.snapshot).toHaveLength(MAX_WORKFLOW_TEMPLATES);
    // 刷新「任务0」使其最新——下一次逐出的应是「任务1」
    memory.learnFromRun(successRun("任务0", ["read"]), "agent", new Date(NOW.getTime() + 999999));
    memory.learnFromRun(successRun("新任务", ["write"]), "agent", new Date(NOW.getTime() + 1000000));
    expect(store.snapshot).toHaveLength(MAX_WORKFLOW_TEMPLATES);
    expect(store.snapshot.some((t) => t.intent === "任务0")).toBe(true);
    expect(store.snapshot.some((t) => t.intent === "任务1")).toBe(false);
    expect(store.snapshot.some((t) => t.intent === "新任务")).toBe(true);
  });
});

describe("WorkflowMemory.match / markReused（AC32 相似命中与复用计数）", () => {
  it("共享关键词 >= 2 判相似，取共享数最优者", () => {
    const store = makeStore();
    const memory = new WorkflowMemory(store);
    memory.learnFromRun(successRun("给 login.ts 加输入校验", ["read", "write"]), "agent", NOW);
    // 两个共享词（login.ts / 输入校验）→ 命中
    const hit = memory.match("给 login.ts 补输入校验的单测");
    expect(hit).not.toBeNull();
    expect(hit!.shared).toContain("login.ts");
    expect(hit!.shared).toContain("输入");
    expect(hit!.shared).toContain("校验");
    // 共享 < 2 → 不命中
    expect(memory.match("完全不同的重构任务")).toBeNull();
    // 空意图不命中
    expect(memory.match("")).toBeNull();
  });

  it("共享数相同取学习近者；markReused 累加并落时间戳", () => {
    const store = makeStore();
    const memory = new WorkflowMemory(store);
    const older = memory.learnFromRun(successRun("加 输入 校验 测试", ["read"]), "agent", new Date("2026-07-25T09:00:00.000Z"))!;
    const newer = memory.learnFromRun(successRun("加 输入 校验 文档", ["write"]), "agent", new Date("2026-07-25T10:00:00.000Z"))!;
    const hit = memory.match("输入 校验")!;
    expect(hit.template.id).toBe(newer.id);
    memory.markReused(hit.template.id, NOW);
    expect(store.snapshot.find((t) => t.id === newer.id)!.reuseCount).toBe(1);
    expect(store.snapshot.find((t) => t.id === newer.id)!.lastReuseAt).toBe(NOW.toISOString());
    expect(store.snapshot.find((t) => t.id === older.id)!.reuseCount).toBe(0);
  });

  it("remove / clear：逐条删除与清空", () => {
    const store = makeStore();
    const memory = new WorkflowMemory(store);
    const a = memory.learnFromRun(successRun("任务A", ["read"]), "agent", NOW)!;
    memory.learnFromRun(successRun("任务B", ["write"]), "agent", NOW);
    memory.remove(a.id);
    expect(store.snapshot).toHaveLength(1);
    memory.clear();
    expect(store.snapshot).toEqual([]);
  });
});
