import type { AgentRunInput, AgentTraceEvent, DevwitApi } from "@devwit/contracts";
import { describe, expect, it } from "vitest";
import { TaskCenter, type TaskInfo } from "../src/task-center.js";

/**
 * TaskCenter（AC9）单元测试。DevwitApi 最小自写替身（DI test double）：
 * 捕获 run 输入、按 sessionId 注入事件流、可配置 trace 回放内容。
 */
class FakeDevwitApi {
  readonly runInputs: AgentRunInput[] = [];
  private listeners = new Set<(event: AgentTraceEvent) => void>();
  traces = new Map<string, AgentTraceEvent[]>();

  readonly api: DevwitApi;

  constructor() {
    this.api = {
      agent: {
        run: async (input: AgentRunInput) => {
          this.runInputs.push(input);
        },
        cancel: () => undefined,
        authorize: () => undefined,
        onEvent: (cb: (event: AgentTraceEvent) => void) => {
          this.listeners.add(cb);
          return () => {
            this.listeners.delete(cb);
          };
        },
        trace: async (sessionId: string) => this.traces.get(sessionId) ?? [],
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

describe("TaskCenter（AC9 任务指挥台状态机）", () => {
  it("createTask 以 agent 模式发起 run，任务进入 running 并成为激活任务", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "C:\\repo", defaultModeId: "agent" });
    const id = await center.createTask("实现登录页校验");
    expect(center.activeTaskId).toBe(id);
    const tasks = center.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id, status: "running", title: "实现登录页校验" });
    expect(fake.runInputs).toHaveLength(1);
    expect(fake.runInputs[0]).toMatchObject({ modeId: "agent", workspaceRoot: "C:\\repo", userText: "实现登录页校验" });
    center.dispose();
  });

  it("空意图拒绝创建", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    await expect(center.createTask("   ")).rejects.toThrow("不能为空");
    expect(center.listTasks()).toHaveLength(0);
    center.dispose();
  });

  it("状态归约：authorization_request → 待授权；decision → 进行中；done → 完成", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    await center.createTask("写文件任务");
    const sessionId = center.listTasks()[0]!.sessionId;
    fake.emit(event(sessionId, "authorization_request", "write: 写入", { requestId: "r1", toolName: "write", reason: "写入" }));
    expect(center.listTasks()[0]!.status).toBe("waiting_auth");
    fake.emit(event(sessionId, "authorization_decision", "allow", { requestId: "r1", decision: "allow" }));
    expect(center.listTasks()[0]!.status).toBe("running");
    fake.emit(event(sessionId, "done", "完成"));
    expect(center.listTasks()[0]!.status).toBe("done");
    center.dispose();
  });

  it("error 事件 → 失败；其他会话的事件不影响本任务", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    await center.createTask("任务A");
    fake.emit(event("别的会话", "done", "无关"));
    expect(center.listTasks()[0]!.status).toBe("running");
    fake.emit(event(center.listTasks()[0]!.sessionId, "error", "炸了"));
    expect(center.listTasks()[0]!.status).toBe("failed");
    center.dispose();
  });

  it("activate 回放持久化轨迹重建活动流（含 user 消息）", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    const idA = await center.createTask("任务A");
    const sessionA = center.listTasks()[0]!.sessionId;
    await center.createTask("任务B"); // 激活切换到 B
    expect(center.activeTaskId).not.toBe(idA);

    fake.traces.set(sessionA, [
      event(sessionA, "user_message", "任务A"),
      event(sessionA, "assistant_message", "已规划 2 步"),
      event(sessionA, "tool_call", 'read({"path":"a.ts"})'),
      event(sessionA, "tool_result", "read 成功"),
      event(sessionA, "done", "任务完成"),
    ]);
    await center.activate(idA);
    expect(center.activeTaskId).toBe(idA);
    const items = center.activeController()!.listItems();
    expect(items[0]).toEqual({ kind: "user", text: "任务A" });
    expect(items.some((item) => item.kind === "tool")).toBe(true);
    expect(items.at(-1)).toEqual({ kind: "done", text: "任务完成" });
    expect(center.activeController()!.isRunning).toBe(false);
    center.dispose();
  });

  it("轨迹末尾无 done/error 时视为仍在运行", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    const idA = await center.createTask("任务A");
    const sessionA = center.listTasks()[0]!.sessionId;
    await center.createTask("任务B");
    fake.traces.set(sessionA, [
      event(sessionA, "user_message", "任务A"),
      event(sessionA, "tool_call", 'bash({"cmd":"npm test"})'),
    ]);
    await center.activate(idA);
    expect(center.activeController()!.isRunning).toBe(true);
    center.dispose();
  });

  it("sendToActive 无激活任务时报明确错误；setWorkspaceRoot 传播到全部任务", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    await expect(center.sendToActive("hi")).rejects.toThrow("没有激活的任务");
    await center.createTask("任务A");
    center.setWorkspaceRoot("D:\\new");
    // 上一 run 结束后才能追加指令（ChatController 并发保护）
    fake.emit(event(center.listTasks()[0]!.sessionId, "done", "完成"));
    await center.sendToActive("继续");
    expect(fake.runInputs.at(-1)).toMatchObject({ workspaceRoot: "D:\\new", userText: "继续" });
    center.dispose();
  });
});

describe("TaskCenter 重启恢复（迭代 6 / AC15）", () => {
  function restoredTask(id: string, status: TaskInfo["status"]): TaskInfo {
    return { id, title: `标题${id}`, sessionId: `sess-${id}`, status, createdAt: "2026-07-23T00:00:00.000Z" };
  }

  it("restore：running/waiting_auth 归一为 interrupted，终态保留", () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    center.restore({
      tasks: [
        restoredTask("task-1", "running"),
        restoredTask("task-2", "waiting_auth"),
        restoredTask("task-3", "done"),
        restoredTask("task-4", "failed"),
      ],
      activeTaskId: "task-3",
      taskCounter: 4,
    });
    expect(center.listTasks().map((task) => task.status)).toEqual(["interrupted", "interrupted", "done", "failed"]);
    expect(center.activeTaskId).toBe("task-3");
    center.dispose();
  });

  it("restore：taskCounter 回填，新任务 id 不与历史冲突", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    center.restore({ tasks: [restoredTask("task-2", "done")], activeTaskId: null, taskCounter: 2 });
    const id = await center.createTask("新任务");
    expect(id).toBe("task-3");
    center.dispose();
  });

  it("restore：快照 activeTaskId 失效时回退到第一个任务", () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    center.restore({
      tasks: [restoredTask("task-1", "done"), restoredTask("task-2", "done")],
      activeTaskId: "task-不存在",
      taskCounter: 2,
    });
    expect(center.activeTaskId).toBe("task-1");
    center.dispose();
  });

  it("中断任务被续发：user_message 事件使其复活为 running", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    center.restore({ tasks: [restoredTask("task-1", "running")], activeTaskId: "task-1", taskCounter: 1 });
    expect(center.listTasks()[0]!.status).toBe("interrupted");
    await center.sendToActive("接着做");
    fake.emit(event("sess-task-1", "user_message", "接着做"));
    expect(center.listTasks()[0]!.status).toBe("running");
    center.dispose();
  });

  it("activate 中断任务：轨迹回放不标 running（agent 已随退出终止）", async () => {
    const fake = new FakeDevwitApi();
    const center = new TaskCenter({ api: fake.api, workspaceRoot: "", defaultModeId: "agent" });
    center.restore({ tasks: [restoredTask("task-1", "waiting_auth")], activeTaskId: null, taskCounter: 1 });
    fake.traces.set("sess-task-1", [
      event("sess-task-1", "user_message", "意图", { text: "意图" }),
      event("sess-task-1", "authorization_request", "write: 写入", {
        requestId: "r1",
        toolName: "write",
        reason: "写入",
      }),
    ]);
    await center.activate("task-1");
    expect(center.activeController()!.isRunning).toBe(false);
    // 授权请求项重建，等待用户重新裁决
    expect(center.activeController()!.listItems().some((item) => item.kind === "authorization")).toBe(true);
    center.dispose();
  });
});
