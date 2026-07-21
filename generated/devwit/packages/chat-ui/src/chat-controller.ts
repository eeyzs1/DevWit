import type {
  AgentRunInput,
  AgentTraceEvent,
  AuthorizationDecision,
  DevwitApi,
} from "@devwit/contracts";

/**
 * ChatController（WU012）：对话面板的 headless 状态机。
 * 不碰 DOM——视图（chat-panel.ts）订阅 onChange 渲染；事件源是 DevwitApi.agent
 * （preload 白名单桥），因此本控制器在纯 node/vitest 中以自写 DevwitApi 替身驱动。
 *
 * 消息模型（时间序）：
 * - user：本地追加；
 * - assistant：assistant_delta 流式累积 → assistant_message 定稿；
 * - tool：tool_call 出现 → tool_result 回填状态；
 * - authorization：authorization_request 出现 → 用户经 authorize() 裁决后标注；
 * - error / done：终态。
 */

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "tool"; summary: string; ok: boolean | null }
  | { kind: "authorization"; requestId: string; toolName: string; reason: string; decision: AuthorizationDecision | null }
  | { kind: "error"; text: string }
  | { kind: "done"; text: string };

export interface ChatContextSnapshot {
  activeFile?: string;
  selection?: { text: string; startLine: number; endLine: number };
  terminalTail?: string;
}

export interface ChatControllerDeps {
  api: DevwitApi;
  sessionId: string;
  workspaceRoot: string;
  modeId: string;
}

interface AuthorizationDetail {
  requestId: string;
  toolName: string;
  reason: string;
}

function isAuthorizationDetail(detail: unknown): detail is AuthorizationDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const candidate = detail as Record<string, unknown>;
  return (
    typeof candidate["requestId"] === "string" &&
    typeof candidate["toolName"] === "string" &&
    typeof candidate["reason"] === "string"
  );
}

export class ChatController {
  private readonly deps: ChatControllerDeps;
  private readonly items: ChatItem[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeAgent: () => void;
  private modeId: string;
  private providerId: string | undefined;
  private workspaceRoot: string;
  private running = false;

  constructor(deps: ChatControllerDeps) {
    this.deps = deps;
    this.modeId = deps.modeId;
    this.workspaceRoot = deps.workspaceRoot;
    this.unsubscribeAgent = deps.api.agent.onEvent((event) => this.onAgentEvent(event));
  }

  get sessionId(): string {
    return this.deps.sessionId;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentModeId(): string {
    return this.modeId;
  }

  get currentProviderId(): string | undefined {
    return this.providerId;
  }

  listItems(): ChatItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  /** 会话中切换模式（WU012；新模式下次请求生效，模式自身热更新由 modes 包保证）。 */
  setMode(modeId: string): void {
    this.modeId = modeId;
    this.emit();
  }

  /** 工作区变更后更新 agent run 的根目录（打开文件夹后生效）。 */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  /** 会话中切换模型（AC5）：覆盖 mode.providerId 随下次请求发出。 */
  setProvider(providerId: string | undefined): void {
    this.providerId = providerId;
    this.emit();
  }

  /** 发送一条用户消息并驱动一次 agent run（chat 模式 = 无写工具的模式定义）。 */
  async send(userText: string, context: ChatContextSnapshot = {}): Promise<void> {
    if (this.running) {
      throw new Error("会话进行中：请先等待完成或取消");
    }
    const text = userText.trim();
    if (text.length === 0) {
      return;
    }
    this.items.push({ kind: "user", text });
    this.running = true;
    this.emit();

    const input: AgentRunInput = {
      sessionId: this.deps.sessionId,
      userText: text,
      modeId: this.modeId,
      workspaceRoot: this.workspaceRoot,
      ...(this.providerId !== undefined ? { providerId: this.providerId } : {}),
      ...(context.activeFile !== undefined ? { activeFile: context.activeFile } : {}),
      ...(context.selection !== undefined ? { selection: context.selection } : {}),
      ...(context.terminalTail !== undefined ? { terminalTail: context.terminalTail } : {}),
    };
    try {
      await this.deps.api.agent.run(input);
    } catch (error) {
      this.running = false;
      this.items.push({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      this.emit();
    }
  }

  cancel(): void {
    if (!this.running) {
      return;
    }
    this.deps.api.agent.cancel(this.deps.sessionId);
  }

  /** 裁决一个授权请求（allow / allow_session / deny）。 */
  authorize(requestId: string, decision: AuthorizationDecision): void {
    this.deps.api.agent.authorize(this.deps.sessionId, requestId, decision);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.unsubscribeAgent();
    this.listeners.clear();
  }

  // --------------------------------------------------------------------------
  // 事件归约
  // --------------------------------------------------------------------------

  private onAgentEvent(event: AgentTraceEvent): void {
    if (event.sessionId !== this.deps.sessionId) {
      return;
    }
    switch (event.type) {
      case "assistant_delta": {
        const last = this.items[this.items.length - 1];
        if (last?.kind === "assistant" && last.streaming) {
          last.text += event.summary;
        } else {
          this.items.push({ kind: "assistant", text: event.summary, streaming: true });
        }
        break;
      }
      case "assistant_message": {
        const last = this.items[this.items.length - 1];
        if (last?.kind === "assistant" && last.streaming) {
          // 定稿：以轨迹存档的完整文本为准（delta 是瞬时通道）
          last.text = event.summary;
          last.streaming = false;
        } else {
          this.items.push({ kind: "assistant", text: event.summary, streaming: false });
        }
        break;
      }
      case "tool_call":
        this.items.push({ kind: "tool", summary: event.summary, ok: null });
        break;
      case "tool_result": {
        const last = [...this.items].reverse().find((item) => item.kind === "tool" && item.ok === null);
        if (last?.kind === "tool") {
          last.summary = event.summary;
          last.ok = !event.summary.includes("失败") && !event.summary.includes("拒绝");
        }
        break;
      }
      case "authorization_request": {
        if (isAuthorizationDetail(event.detail)) {
          this.items.push({
            kind: "authorization",
            requestId: event.detail.requestId,
            toolName: event.detail.toolName,
            reason: event.detail.reason,
            decision: null,
          });
        }
        break;
      }
      case "authorization_decision": {
        const detail = event.detail as { requestId?: unknown; decision?: unknown } | undefined;
        const pending = [...this.items]
          .reverse()
          .find(
            (item): item is Extract<ChatItem, { kind: "authorization" }> =>
              item.kind === "authorization" && item.decision === null && item.requestId === detail?.requestId
          );
        if (pending !== undefined && typeof detail?.decision === "string") {
          pending.decision = detail.decision as AuthorizationDecision;
        }
        break;
      }
      case "error":
        this.items.push({ kind: "error", text: event.summary });
        this.running = false;
        break;
      case "done":
        this.items.push({ kind: "done", text: event.summary });
        this.running = false;
        break;
      case "user_message":
        break; // 本地已追加，轨迹回放时跳过
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
