/**
 * AiRuntime 轨迹持久化（迭代 6 / AC15）真实文件系统回环测试。
 *
 * 不用 mock：真实 SettingsStore（NodeCryptoBackend）+ 真实 tmp 目录 JSONL 落盘。
 * 唯一注入边界是 LLMProvider（HTTP/SSE 协议层已由 llm-providers 录制 fixture
 * 覆盖）——此处以确定性 StreamEvent 序列驱动 run，验证「落盘 → 新实例读回 →
 * 跨重启续跑注入历史」的完整链路。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

    // 落盘证据：JSONL 逐行一个事件，含本轮 route（AC31 路由决策）/user/assistant/done
    const onDisk = readTraceFile("s-1");
    expect(onDisk.map((event) => event.type)).toEqual(["route", "user_message", "assistant_message", "done"]);
    expect((onDisk[1]!.detail as { text: string }).text).toBe("第一问");

    // 模拟应用重启：全新 AiRuntime（进程内无会话）→ trace() 从磁盘读回
    const { runtime: runtime2 } = makeRuntime(new ScriptedProvider([]));
    const restored = runtime2.trace("s-1");
    expect(restored.map((event) => event.type)).toEqual(["route", "user_message", "assistant_message", "done"]);
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

    // 轨迹文件追加而非覆盖：两轮事件齐全且 seq 单调（每轮起点为 route 决策，AC31）
    const onDisk = readTraceFile("s-1");
    expect(onDisk.map((event) => event.type)).toEqual([
      "route",
      "user_message",
      "assistant_message",
      "done",
      "route",
      "user_message",
      "assistant_message",
      "done",
    ]);
    expect(onDisk.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 水合的历史不触发实时推送：sent 只含本轮新事件
    // （assistant_delta 为瞬时推送通道，seq 0 不落盘）
    expect(sent.map((event) => event.type)).toEqual(["route", "user_message", "assistant_delta", "assistant_message", "done"]);
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

  it("AC35：usage 帧跨迭代求和落账本，summary 聚合、轨迹含 usage 事件，clear 清零", async () => {
    // 两轮迭代：read 工具回填后再应答，两次 usage 帧应求和（40+60 / 15+5）
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", toolCall: { id: "t1", name: "read", args: { path: "a.txt" } } },
        { type: "usage", inputTokens: 40, outputTokens: 15 },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "text", text: "读完。" },
        { type: "usage", inputTokens: 60, outputTokens: 5 },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);
    const { runtime } = makeRuntime(provider);
    await runtime.run({
      sessionId: "s-u1",
      userText: "读文件",
      modeId: "agent",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });

    // 账本回环：usageSummary 聚合出本次 run 的求和量（providerId/model 取自 provider config）
    const summary = runtime.usageSummary();
    expect(summary.total).toEqual({ inputTokens: 100, outputTokens: 20, runs: 1 });
    expect(summary.today).toEqual({ inputTokens: 100, outputTokens: 20, runs: 1 });
    expect(summary.byMode).toEqual([{ modeId: "agent", inputTokens: 100, outputTokens: 20, runs: 1 }]);
    expect(summary.byProvider).toEqual([
      { providerId: "p-test", model: "test-model", inputTokens: 100, outputTokens: 20, runs: 1 },
    ]);

    // 轨迹含 usage 事件且先于 done（活动流 …→ 用量 → 完成）
    const types = readTraceFile("s-u1").map((event) => event.type);
    expect(types).toContain("usage");
    expect(types.indexOf("usage")).toBeLessThan(types.lastIndexOf("done"));

    // 模拟重启：账本从磁盘读回（与会话轨迹独立的 append-only 文件）
    const { runtime: runtime2 } = makeRuntime(new ScriptedProvider([]));
    expect(runtime2.usageSummary().total).toEqual({ inputTokens: 100, outputTokens: 20, runs: 1 });

    // 清零：账本归零且不影响会话轨迹读回
    runtime2.usageClear();
    expect(runtime2.usageSummary().total).toEqual({ inputTokens: 0, outputTokens: 0, runs: 0 });
    expect(runtime2.trace("s-u1").length).toBeGreaterThan(0);
  });

  it("AC35：provider 未回报 usage 的 run 不计入账本（只收真实计费量）", async () => {
    const provider = new ScriptedProvider([textThenDone("无用量应答")]);
    const { runtime } = makeRuntime(provider);
    await runtime.run({
      sessionId: "s-u2",
      userText: "闲聊",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });
    expect(runtime.usageSummary().total).toEqual({ inputTokens: 0, outputTokens: 0, runs: 0 });
  });
});

describe("AiRuntime 会话轨迹扫描（迭代 27 / AC36）", () => {
  it("listTraceSessions 按 lastAt 倒序：preview 取首条用户消息，无错误标记", async () => {
    const provider = new ScriptedProvider([textThenDone("答一"), textThenDone("答二")]);
    const { runtime } = makeRuntime(provider);
    await runtime.run({
      sessionId: "s-old",
      userText: "旧问题",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });
    // 拉开 lastAt 间距，保证排序断言确定（ISO 字符串毫秒精度）
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.run({
      sessionId: "s-new",
      userText: "新问题",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });

    const sessions = runtime.listTraceSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["s-new", "s-old"]);
    const oldSession = sessions[1]!;
    expect(oldSession.preview).toBe("旧问题");
    expect(oldSession.eventCount).toBe(4); // route / user_message / assistant_message / done
    expect(oldSession.hasError).toBe(false);
    expect(oldSession.startedAt <= oldSession.lastAt).toBe(true);
    // 新实例（模拟重启）读同一 tracesDir：扫描结果一致
    const { runtime: runtime2 } = makeRuntime(new ScriptedProvider([]));
    expect(runtime2.listTraceSessions().map((s) => s.sessionId)).toEqual(["s-new", "s-old"]);
  });

  it("失败事件标记 hasError：error 事件 / 工具失败 / 授权拒绝（isFailureTraceEvent 同规则）", () => {
    const { runtime } = makeRuntime(new ScriptedProvider([]));
    const tracesDir = path.join(tmpRoot, "traces");
    mkdirSync(tracesDir, { recursive: true });
    const base = { sessionId: "s-err", summary: "x" };
    const lines = [
      { ...base, seq: 1, timestamp: "2026-07-26T10:00:00.000Z", type: "user_message", summary: "试探" },
      { ...base, seq: 2, timestamp: "2026-07-26T10:00:01.000Z", type: "tool_result", detail: { result: { ok: false } } },
      { ...base, seq: 3, timestamp: "2026-07-26T10:00:02.000Z", type: "done" },
    ];
    writeFileSync(
      path.join(tracesDir, "s-err.jsonl"),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      "utf-8"
    );
    const sessions = runtime.listTraceSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.hasError).toBe(true);
    expect(sessions[0]!.preview).toBe("试探");
    expect(sessions[0]!.eventCount).toBe(3);
  });

  it("坏行容忍：非法 JSON 行与缺字段行跳过；无 user_message 时 preview 回退首条事件", () => {
    const { runtime } = makeRuntime(new ScriptedProvider([]));
    const tracesDir = path.join(tmpRoot, "traces");
    mkdirSync(tracesDir, { recursive: true });
    const good = { sessionId: "s-mix", seq: 2, timestamp: "2026-07-26T10:00:01.000Z", type: "done", summary: "完成" };
    writeFileSync(
      path.join(tracesDir, "s-mix.jsonl"),
      `{"broken\n${JSON.stringify({ sessionId: "s-mix" })}\n${JSON.stringify(good)}\n`,
      "utf-8"
    );
    const sessions = runtime.listTraceSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.eventCount).toBe(1); // 仅合法行计入
    expect(sessions[0]!.preview).toBe("完成"); // 无 user_message → 回退 events[0].summary
  });

  it("空目录/目录不存在/全坏文件均返回空数组", () => {
    const { runtime } = makeRuntime(new ScriptedProvider([]));
    expect(runtime.listTraceSessions()).toEqual([]); // tracesDir 尚未创建
    const tracesDir = path.join(tmpRoot, "traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(path.join(tracesDir, "s-bad.jsonl"), "not-json\n", "utf-8");
    expect(runtime.listTraceSessions()).toEqual([]); // 文件无有效事件 → 跳过
  });
});

describe("AiRuntime 对话会话管理（迭代 28 / AC37）", () => {
  /** 造一个对话会话与一个指挥台任务会话（后者 sessionId 前缀 task-session-）。 */
  async function seedSessions(runtime: AiRuntime): Promise<void> {
    await runtime.run({
      sessionId: "session-old",
      userText: "对话旧问题",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.run({
      sessionId: "session-new",
      userText: "对话新问题",
      modeId: "chat",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });
    await runtime.run({
      sessionId: "task-session-1",
      userText: "指挥台任务",
      modeId: "agent",
      providerId: "p-test",
      workspaceRoot: tmpRoot,
    });
  }

  it("listChatSessions 只含对话会话（排除 task-session-），按 lastAt 倒序，标题回退首条用户消息", async () => {
    const provider = new ScriptedProvider([textThenDone("答"), textThenDone("答"), textThenDone("答")]);
    const { runtime } = makeRuntime(provider);
    await seedSessions(runtime);

    const sessions = runtime.listChatSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["session-new", "session-old"]);
    expect(sessions[1]!.title).toBe("对话旧问题"); // 未改名 → 预览
    expect(sessions[1]!.eventCount).toBe(4); // route / user / assistant / done
  });

  it("改名叠加到列表（优先于预览），新实例读回；空标题清除改名；任务会话不可改", async () => {
    const provider = new ScriptedProvider([textThenDone("答"), textThenDone("答"), textThenDone("答")]);
    const { runtime } = makeRuntime(provider);
    await seedSessions(runtime);

    runtime.renameChatSession("session-old", "登录页重构讨论");
    expect(runtime.listChatSessions()[1]!.title).toBe("登录页重构讨论");

    // 模拟重启：新实例（新 SessionMetaStore 读同一 sessions.json）改名仍在
    const { runtime: runtime2 } = makeRuntime(new ScriptedProvider([]));
    expect(runtime2.listChatSessions()[1]!.title).toBe("登录页重构讨论");

    // 空标题清除 → 回退预览
    runtime2.renameChatSession("session-old", "  ");
    expect(runtime2.listChatSessions()[1]!.title).toBe("对话旧问题");

    // 非对话会话前缀一律拒绝（防误碰任务会话元数据）
    runtime2.renameChatSession("task-session-1", "不该生效");
    expect(runtime2.listTraceSessions().find((s) => s.sessionId === "task-session-1")!.preview).toBe("指挥台任务");
  });

  it("删除会话：列表隐藏 + 轨迹文件移除 + 元数据标记 deleted；重复删除幂等", async () => {
    const provider = new ScriptedProvider([textThenDone("答"), textThenDone("答"), textThenDone("答")]);
    const { runtime } = makeRuntime(provider);
    await seedSessions(runtime);
    runtime.renameChatSession("session-old", "待删除");

    runtime.deleteChatSession("session-old");
    expect(runtime.listChatSessions().map((s) => s.sessionId)).toEqual(["session-new"]);
    expect(existsSync(path.join(tmpRoot, "traces", "session-old.jsonl"))).toBe(false); // 内容事实源已移除
    expect(runtime.trace("session-old")).toEqual([]);

    // 新实例：deleted 标记仍在（即便轨迹文件因故残留也不会在列表复活）
    const { runtime: runtime2 } = makeRuntime(new ScriptedProvider([]));
    expect(runtime2.listChatSessions().map((s) => s.sessionId)).toEqual(["session-new"]);

    // 幂等：重复删除 / 删除未知会话 / 删除任务会话均不抛、不误伤
    runtime2.deleteChatSession("session-old");
    runtime2.deleteChatSession("session-never-existed");
    runtime2.deleteChatSession("task-session-1"); // 前缀拒绝：任务会话轨迹保留
    expect(runtime2.trace("task-session-1").length).toBeGreaterThan(0);
  });
});
