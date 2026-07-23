import type { AgentTraceEvent, DevwitApi } from "@devwit/contracts";
import { t } from "@devwit/i18n";
import { ChatController } from "./chat-controller.js";
import type { ChatContextSnapshot } from "./chat-controller.js";

/**
 * TaskCenter（迭代 2 / AC9）：任务指挥台的 headless 状态机。
 * 一个任务 = 一个 agent 会话（sessionId）+ 一个 ChatController（活动流数据源）。
 * 任务状态由全局 agent 事件流按 sessionId 归约：
 * - running：已发送意图，agent 执行中
 * - waiting_auth：存在未裁决的授权请求
 * - done / failed：终态
 * 不碰 DOM——视图（renderer 的指挥台列）订阅 onChange 渲染。
 */

export type TaskStatus = "running" | "waiting_auth" | "done" | "failed" | "interrupted";

export interface TaskInfo {
  id: string;
  title: string;
  sessionId: string;
  status: TaskStatus;
  createdAt: string;
}

interface TaskEntry extends TaskInfo {
  controller: ChatController;
}

export interface TaskCenterDeps {
  api: DevwitApi;
  workspaceRoot: string;
  /** 新任务默认使用的模式（应为带写工具集的 agent 类模式）。 */
  defaultModeId: string;
}

export class TaskCenter {
  private readonly deps: TaskCenterDeps;
  private readonly tasks: TaskEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeAgent: () => void;
  private workspaceRoot: string;
  private defaultModeId: string;
  private activeId: string | null = null;
  private counter = 0;

  constructor(deps: TaskCenterDeps) {
    this.deps = deps;
    this.workspaceRoot = deps.workspaceRoot;
    this.defaultModeId = deps.defaultModeId;
    this.unsubscribeAgent = deps.api.agent.onEvent((event) => this.onAgentEvent(event));
  }

  get activeTaskId(): string | null {
    return this.activeId;
  }

  /** 任务计数器（迭代 6 / AC15 持久化）：恢复时回填，保证新任务 id 不与历史冲突。 */
  get taskCounter(): number {
    return this.counter;
  }

  listTasks(): TaskInfo[] {
    return this.tasks.map(({ id, title, sessionId, status, createdAt }) => ({
      id,
      title,
      sessionId,
      status,
      createdAt,
    }));
  }

  /** 当前激活任务的 ChatController（活动流视图的数据源）；无激活任务返回 null。 */
  activeController(): ChatController | null {
    const entry = this.tasks.find((task) => task.id === this.activeId);
    return entry?.controller ?? null;
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
    for (const task of this.tasks) task.controller.setWorkspaceRoot(root);
  }

  setDefaultMode(modeId: string): void {
    this.defaultModeId = modeId;
  }

  /** 创建任务并立即发送第一条意图；返回任务 id。 */
  async createTask(intent: string, context: ChatContextSnapshot = {}): Promise<string> {
    const text = intent.trim();
    if (text.length === 0) {
      throw new Error(t("task.intent.required"));
    }
    this.counter += 1;
    const id = `task-${this.counter}`;
    const sessionId = `task-session-${Date.now()}-${this.counter}`;
    const controller = new ChatController({
      api: this.deps.api,
      sessionId,
      workspaceRoot: this.workspaceRoot,
      modeId: this.defaultModeId,
    });
    const entry: TaskEntry = {
      id,
      title: text.length > 24 ? `${text.slice(0, 24)}…` : text,
      sessionId,
      status: "running",
      createdAt: new Date().toISOString(),
      controller,
    };
    this.tasks.unshift(entry);
    this.activeId = id;
    this.emit();
    try {
      await controller.send(text, context);
    } catch {
      // 发送失败已由 controller 记录 error 项；事件流会推进 status
    }
    return id;
  }

  /** 激活一个任务：回放其持久化轨迹以重建活动流（切换/重启后恢复现场）。 */
  async activate(taskId: string): Promise<void> {
    const entry = this.tasks.find((task) => task.id === taskId);
    if (entry === undefined) return;
    this.activeId = taskId;
    this.emit();
    try {
      const trace = await this.deps.api.agent.trace(entry.sessionId);
      if (trace.length > 0) {
        // 中断恢复的任务不标 running（agent 进程已随上次退出而终止）
        entry.controller.ingestHistory(trace, { resumed: entry.status === "interrupted" });
      }
    } catch {
      // 轨迹读取失败不阻塞激活：实时事件仍会到达（可能是一次全新会话尚无轨迹）
    }
  }

  /**
   * 从持久化快照恢复任务列表（迭代 6 / AC15 应用重启后）。
   * 上次退出时处于 running/waiting_auth 的任务归一为 interrupted（agent 已终止），
   * 激活任务的轨迹回放由调用方随后触发（activate）。
   */
  restore(snapshot: { tasks: TaskInfo[]; activeTaskId: string | null; taskCounter: number }): void {
    for (const task of snapshot.tasks) {
      const status: TaskStatus =
        task.status === "running" || task.status === "waiting_auth" ? "interrupted" : task.status;
      const controller = new ChatController({
        api: this.deps.api,
        sessionId: task.sessionId,
        workspaceRoot: this.workspaceRoot,
        modeId: this.defaultModeId,
      });
      this.tasks.push({ ...task, status, controller });
    }
    this.counter = Math.max(this.counter, snapshot.taskCounter);
    this.activeId = snapshot.activeTaskId !== null && this.tasks.some((task) => task.id === snapshot.activeTaskId)
      ? snapshot.activeTaskId
      : (this.tasks[0]?.id ?? null);
    this.emit();
  }

  /** 向激活任务追加一条用户意图。 */
  async sendToActive(text: string, context: ChatContextSnapshot = {}): Promise<void> {
    const controller = this.activeController();
    if (controller === null) {
      throw new Error(t("task.noActive"));
    }
    await controller.send(text, context);
  }

  cancelActive(): void {
    this.activeController()?.cancel();
  }

  authorize(requestId: string, decision: "allow" | "allow_session" | "deny"): void {
    this.activeController()?.authorize(requestId, decision);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.unsubscribeAgent();
    for (const task of this.tasks) task.controller.dispose();
    this.listeners.clear();
  }

  // --------------------------------------------------------------------------
  // 状态归约
  // --------------------------------------------------------------------------

  private onAgentEvent(event: AgentTraceEvent): void {
    const entry = this.tasks.find((task) => task.sessionId === event.sessionId);
    if (entry === undefined) return;
    switch (event.type) {
      case "user_message":
        // 中断任务被续发（新一轮 run 开始）→ 复活为进行中
        entry.status = "running";
        break;
      case "authorization_request":
        entry.status = "waiting_auth";
        break;
      case "authorization_decision":
        entry.status = "running";
        break;
      case "done":
        entry.status = "done";
        break;
      case "error":
        entry.status = "failed";
        break;
      default:
        return; // 其余事件不影响任务状态
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
