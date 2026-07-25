import type { AgentRunInput, AgentTraceEvent, ContextManifest, DevwitApi } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { ChatController } from "../src/chat-controller.js";
import { ContextPanelController } from "../src/context-panel-controller.js";

/**
 * DevwitApi 的最小自写替身（DI test double）：
 * 捕获 agent.run 输入，允许测试注入 agent 事件流与 context 策略/manifest。
 * 非 mock 框架——显式状态，断言直接可读。
 */
class FakeDevwitApi {
  readonly runInputs: AgentRunInput[] = [];
  readonly cancels: string[] = [];
  readonly authorizations: Array<{ sessionId: string; requestId: string; decision: string }> = [];
  private listeners = new Set<(event: AgentTraceEvent) => void>();
  policy: Record<string, boolean> = { system_prompt: true, git_status: false };
  manifest: ContextManifest | null = null;
  readonly policyWrites: Array<{ type: string; enabled: boolean }> = [];
  runError: Error | null = null;

  readonly api: DevwitApi;

  constructor() {
    this.api = {
      agent: {
        run: async (input: AgentRunInput) => {
          if (this.runError !== null) throw this.runError;
          this.runInputs.push(input);
        },
        cancel: (sessionId: string) => {
          this.cancels.push(sessionId);
        },
        authorize: (sessionId: string, requestId: string, decision) => {
          this.authorizations.push({ sessionId, requestId, decision });
        },
        onEvent: (cb: (event: AgentTraceEvent) => void) => {
          this.listeners.add(cb);
          return () => {
            this.listeners.delete(cb);
          };
        },
        trace: async () => [],
      },
      context: {
        latestManifest: async () => this.manifest,
        listManifests: async () => (this.manifest !== null ? [this.manifest] : []),
        getPolicy: async () => this.policy as Awaited<ReturnType<DevwitApi["context"]["getPolicy"]>>,
        setItemEnabled: async (type, enabled) => {
          this.policyWrites.push({ type, enabled });
          this.policy[type] = enabled;
        },
      },
    } as unknown as DevwitApi;
  }

  emit(event: AgentTraceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

let seq = 0;
function event(sessionId: string, type: AgentTraceEvent["type"], summary: string, detail?: unknown): AgentTraceEvent {
  seq += 1;
  return { seq, timestamp: new Date().toISOString(), sessionId, type, summary, ...(detail !== undefined ? { detail } : {}) };
}

describe("ChatController", () => {
  it("send 携带 modeId/providerId/选区上下文；user 项本地追加", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "chat" });
    controller.setProvider("p-openai");
    await controller.send(" 帮我重构 ", {
      activeFile: "src/a.ts",
      selection: { text: "const x = 1;", startLine: 3, endLine: 3 },
    });
    expect(fake.runInputs).toHaveLength(1);
    expect(fake.runInputs[0]).toMatchObject({
      sessionId: "s1",
      userText: "帮我重构",
      modeId: "chat",
      providerId: "p-openai",
      activeFile: "src/a.ts",
      selection: { text: "const x = 1;", startLine: 3, endLine: 3 },
    });
    expect(controller.listItems()[0]).toEqual({ kind: "user", text: "帮我重构" });
    controller.dispose();
  });

  it("AC28：attachments 透传进 AgentRunInput；空数组不携带字段", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "chat" });
    await controller.send("看这两个文件", { attachments: ["src/a.ts", "docs/readme.md"] });
    expect(fake.runInputs[0]?.attachments).toEqual(["src/a.ts", "docs/readme.md"]);
    fake.emit(event("s1", "done", "完成")); // 结束首轮（running 复位）再发第二轮
    await controller.send("无引用");
    expect(fake.runInputs[1]?.attachments).toBeUndefined();
    controller.dispose();
  });

  it("assistant_delta 流式累积 → assistant_message 定稿", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "chat" });
    await controller.send("hi");
    fake.emit(event("s1", "assistant_delta", "你"));
    fake.emit(event("s1", "assistant_delta", "好"));
    let items = controller.listItems();
    expect(items[1]).toEqual({ kind: "assistant", text: "你好", streaming: true });
    fake.emit(event("s1", "assistant_message", "你好！"));
    items = controller.listItems();
    expect(items[1]).toEqual({ kind: "assistant", text: "你好！", streaming: false });
    controller.dispose();
  });

  it("无 delta 的 agent 路径：assistant_message 直接成项（向后兼容）", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "agent" });
    await controller.send("跑个任务");
    fake.emit(event("s1", "assistant_message", "（发起 1 个工具调用）"));
    expect(controller.listItems()[1]).toEqual({ kind: "assistant", text: "（发起 1 个工具调用）", streaming: false });
    controller.dispose();
  });

  it("授权请求携带 requestId，裁决经 api.agent.authorize 回传，decision 事件标注", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "agent" });
    await controller.send("写文件");
    fake.emit(
      event("s1", "authorization_request", "write: 写入文件: out.txt", {
        requestId: "auth-1",
        toolName: "write",
        reason: "写入文件: out.txt",
      })
    );
    const authItem = controller.listItems().find((item) => item.kind === "authorization");
    expect(authItem).toMatchObject({ requestId: "auth-1", toolName: "write", decision: null });

    controller.authorize("auth-1", "allow");
    expect(fake.authorizations).toEqual([{ sessionId: "s1", requestId: "auth-1", decision: "allow" }]);

    fake.emit(event("s1", "authorization_decision", "write → allow", { requestId: "auth-1", decision: "allow" }));
    const decided = controller.listItems().find((item) => item.kind === "authorization");
    expect(decided).toMatchObject({ decision: "allow" });
    controller.dispose();
  });

  it("tool_call/tool_result 配对更新；done 结束 running", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "agent" });
    await controller.send("读文件");
    expect(controller.isRunning).toBe(true);
    fake.emit(event("s1", "tool_call", 'read({"path":"a.txt"})'));
    fake.emit(event("s1", "tool_result", "read 成功"));
    fake.emit(event("s1", "done", "任务完成"));
    const items = controller.listItems();
    expect(items.find((item) => item.kind === "tool")).toMatchObject({ ok: true });
    expect(items[items.length - 1]).toEqual({ kind: "done", text: "任务完成" });
    expect(controller.isRunning).toBe(false);
    controller.dispose();
  });

  it("AC29 authorization_auto：落已放行授权项（auto 标记、decision=allow、无 requestId 配对）", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "agent" });
    await controller.send("看状态");
    fake.emit(
      event("s1", "authorization_auto", "bash: 执行命令: git status", {
        toolName: "bash",
        reason: "执行命令: git status",
        source: "whitelist",
      })
    );
    const item = controller.listItems().find((entry) => entry.kind === "authorization");
    expect(item).toMatchObject({ toolName: "bash", reason: "执行命令: git status", decision: "allow", auto: true });
    // 不应触发任何裁决回传
    expect(fake.authorizations).toEqual([]);
    controller.dispose();
  });

  it("AC30 diagnostics：落诊断快照项，后续快照原地更新（不堆叠历史行）", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "agent" });
    await controller.send("改文件");
    fake.emit(
      event("s1", "diagnostics", "诊断：2 个问题（src/a.ts:3 起）", {
        count: 2,
        entries: [
          { file: "src/a.ts", line: 3, column: 7, severity: "error", code: "TS2322", message: "x" },
          { file: "src/b.ts", line: 9, column: 1, severity: "error", code: "TS2304", message: "y" },
        ],
        trigger: "write",
      })
    );
    const diag = controller.listItems().find((item) => item.kind === "diagnostics");
    expect(diag).toEqual({ kind: "diagnostics", count: 2, firstLine: "src/a.ts:3" });

    // 修复后快照清零：同一项原地更新，不产生第二条诊断行
    fake.emit(event("s1", "diagnostics", "诊断：无问题", { count: 0, entries: [], trigger: "edit" }));
    const diags = controller.listItems().filter((item) => item.kind === "diagnostics");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toEqual({ kind: "diagnostics", count: 0, firstLine: "" });
    controller.dispose();
  });

  it("其他会话的事件被忽略；run 抛错转为 error 项", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "chat" });
    fake.emit(event("other-session", "assistant_delta", "不属于本会话"));
    expect(controller.listItems()).toHaveLength(0);

    fake.runError = new Error("AI 子系统未初始化");
    await controller.send("会失败");
    expect(controller.listItems().some((item) => item.kind === "error" && item.text.includes("未初始化"))).toBe(true);
    expect(controller.isRunning).toBe(false);
    controller.dispose();
  });

  it("运行中拒绝并发 send；cancel 转发 sessionId", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "chat" });
    await controller.send("第一条");
    await expect(controller.send("第二条")).rejects.toThrow("进行中");
    controller.cancel();
    expect(fake.cancels).toEqual(["s1"]);
    controller.dispose();
  });
});

describe("ChatController 多 Agent 编排（AC20）", () => {
  it("plan 事件归约为计划项（子任务清单 + fallback 标志）", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "orchestrator" });
    await controller.send("重构两个模块");
    fake.emit(
      event("s1", "plan", "分解为 2 个子任务", {
        subtasks: [
          { id: "S1", title: "重构登录", prompt: "做登录" },
          { id: "S2", title: "重构按钮", prompt: "做按钮" },
        ],
      })
    );
    const plan = controller.listItems().find((item) => item.kind === "plan");
    expect(plan).toEqual({
      kind: "plan",
      subtasks: [
        { id: "S1", title: "重构登录" },
        { id: "S2", title: "重构按钮" },
      ],
      fallback: false,
    });
    controller.dispose();
  });

  it("plan 畸形 detail 不产生计划项；fallback 标志透传", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "orchestrator" });
    await controller.send("意图");
    fake.emit(event("s1", "plan", "坏数据", { nope: true }));
    expect(controller.listItems().some((item) => item.kind === "plan")).toBe(false);
    fake.emit(
      event("s1", "plan", "分解失败，按单任务执行", {
        subtasks: [{ id: "S1", title: "意图", prompt: "意图" }],
        fallback: true,
      })
    );
    expect(controller.listItems().find((item) => item.kind === "plan")).toMatchObject({ fallback: true });
    controller.dispose();
  });

  it("subagent_start/done 归约为子代理项；子代理授权请求 reason 带归属前缀", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "C:\\repo", modeId: "orchestrator" });
    await controller.send("编排任务");
    fake.emit(event("s1", "subagent_start", "[S1] 写甲文件", { subagentId: "S1", title: "写甲文件" }));
    fake.emit(
      event("s1", "authorization_request", "[S1] write: 写入文件: out.txt", {
        requestId: "auth-s1",
        toolName: "write",
        reason: "写入文件: out.txt",
        subagentId: "S1",
        subagentTitle: "写甲文件",
      })
    );
    fake.emit(
      event("s1", "subagent_done", "[S1] 写甲文件 → completed", {
        subagentId: "S1",
        title: "写甲文件",
        finishReason: "completed",
        finalText: "甲已写",
        iterations: 2,
      })
    );
    const items = controller.listItems();
    const subagentItems = items.filter((item) => item.kind === "subagent");
    expect(subagentItems).toEqual([
      { kind: "subagent", subagentId: "S1", title: "写甲文件", phase: "start" },
      { kind: "subagent", subagentId: "S1", title: "写甲文件", phase: "done", finishReason: "completed" },
    ]);
    expect(items.find((item) => item.kind === "authorization")).toMatchObject({
      requestId: "auth-s1",
      reason: "[S1] 写入文件: out.txt",
    });
    // 子代理事件不影响 running 终态判定（终态只由整体 done/error 决定）
    expect(controller.isRunning).toBe(true);
    fake.emit(event("s1", "done", "任务完成（2 个子任务）"));
    expect(controller.isRunning).toBe(false);
    controller.dispose();
  });
});

describe("ChatController 会话恢复（迭代 6 / AC15）", () => {
  it("ingestHistory 正文优先 detail.text：超长消息不被 summary 截断", () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "", modeId: "chat" });
    const fullText = "完".repeat(500);
    controller.ingestHistory([
      event("s1", "user_message", `${"完".repeat(200)}…`, { text: fullText }),
      event("s1", "assistant_message", "已收到", { text: "已收到" }),
      event("s1", "done", "完成"),
    ]);
    const items = controller.listItems();
    expect(items[0]).toEqual({ kind: "user", text: fullText });
    expect(items[1]).toEqual({ kind: "assistant", text: "已收到", streaming: false });
    controller.dispose();
  });

  it("resumed=true（重启恢复）：轨迹末尾无 done 也不标 running", () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "", modeId: "chat" });
    controller.ingestHistory(
      [event("s1", "user_message", "跑到一半", { text: "跑到一半" }), event("s1", "tool_call", 'bash({"cmd":"t"})')],
      { resumed: true }
    );
    expect(controller.isRunning).toBe(false);
    controller.dispose();
  });

  it("resumed 缺省（同进程切换回放）：轨迹末尾无 done 视为仍在运行", () => {
    const fake = new FakeDevwitApi();
    const controller = new ChatController({ api: fake.api, sessionId: "s1", workspaceRoot: "", modeId: "chat" });
    controller.ingestHistory([event("s1", "user_message", "在跑", { text: "在跑" })]);
    expect(controller.isRunning).toBe(true);
    controller.dispose();
  });
});

describe("ContextPanelController", () => {
  const MANIFEST: ContextManifest = {
    id: "manifest-1",
    timestamp: "2026-07-20T10:00:00.000Z",
    sessionId: "s1",
    modeId: "chat",
    providerId: "p1",
    model: "test-model",
    items: [],
    totalTokens: 42,
    systemPromptTokens: 10,
  };

  it("refresh 拉取策略视图与最近 manifest", async () => {
    const fake = new FakeDevwitApi();
    fake.manifest = MANIFEST;
    const controller = new ContextPanelController(fake.api);
    const state = await controller.refresh();
    expect(state.policy).toEqual({ system_prompt: true, git_status: false });
    expect(state.manifest?.id).toBe("manifest-1");
  });

  it("setEnabled 先写引擎再刷新视图模型", async () => {
    const fake = new FakeDevwitApi();
    const controller = new ContextPanelController(fake.api);
    await controller.setEnabled("git_status", true);
    expect(fake.policyWrites).toEqual([{ type: "git_status", enabled: true }]);
    expect(controller.current.policy?.["git_status"]).toBe(true);
  });
});
