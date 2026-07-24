import { localizeError, onDidChangeLocale, t } from "@devwit/i18n";
import type { ChatController, ChatItem } from "./chat-controller.js";

/**
 * Agent 活动流视图（迭代 2 / AC9）：指挥台中栏。
 * 把执行轨迹事件（用户消息/助手回复/工具调用/授权请求与决定/工具结果/错误/完成）
 * 渲染为带类型徽标的时间序活动流；授权请求内联裁决按钮。
 * 数据源是激活任务的 ChatController（已把 AgentTraceEvent 归约为 ChatItem 序列）。
 */
export interface ActivityStreamOptions {
  /** 返回当前应展示的控制器（激活任务可切换，故用 accessor 而非定值）。 */
  getController(): ChatController | null;
  /** 请求审查 assistant 回复中的编辑提案（与对话面板同一钩子，可选）。 */
  onProposalReview?: (assistantText: string) => void;
  /** 模式 id → 当前语言显示名（错误文案本地化用，可选）。 */
  resolveModeName?: (modeId: string) => string;
}

export interface ActivityStreamHandle {
  readonly root: HTMLElement;
  /** 任务切换后调用：重新绑定控制器并渲染。 */
  resubscribe(): void;
  dispose(): void;
}

const KIND_BADGE: Record<ChatItem["kind"], "act.user" | "act.assistant" | "act.tool" | "act.authorization" | "act.plan" | "act.subagent" | "act.error" | "act.done"> = {
  user: "act.user",
  assistant: "act.assistant",
  tool: "act.tool",
  authorization: "act.authorization",
  plan: "act.plan",
  subagent: "act.subagent",
  error: "act.error",
  done: "act.done",
};

/** 授权裁决 → 词典键（与 chat-panel 同一映射，活动流独立持有以免跨组件耦合）。 */
const DECISION_KEY = {
  allow: "chat.decision.allow",
  allow_session: "chat.decision.allow_session",
  deny: "chat.decision.deny",
} as const;

export function mountActivityStream(
  container: HTMLElement,
  options: ActivityStreamOptions
): ActivityStreamHandle {
  const root = document.createElement("div");
  root.className = "dw-activity";
  container.appendChild(root);

  let subscribed: ChatController | null = null;
  let unsubscribe: (() => void) | null = null;

  function renderItem(item: ChatItem): HTMLElement {
    const row = document.createElement("div");
    row.className = `dw-act dw-act-${item.kind}`;
    const badge = document.createElement("span");
    badge.className = "dw-act-badge";
    badge.textContent = t(KIND_BADGE[item.kind]);
    row.appendChild(badge);
    const body = document.createElement("div");
    body.className = "dw-act-body";
    row.appendChild(body);

    switch (item.kind) {
      case "user":
      case "done":
        body.textContent = item.text;
        break;
      case "error":
        // 主进程 ASCII 错误码 → 当前语言文案（迭代 4）
        body.textContent = localizeError(item.text, {
          ...(options.resolveModeName !== undefined ? { resolveModeName: options.resolveModeName } : {}),
        });
        break;
      case "assistant": {
        body.textContent = item.text;
        if (item.streaming) {
          row.classList.add("dw-streaming");
        }
        if (!item.streaming && options.onProposalReview !== undefined && item.text.includes("```")) {
          const reviewBtn = document.createElement("button");
          reviewBtn.className = "dw-btn dw-btn-small";
          reviewBtn.textContent = t("chat.review");
          reviewBtn.addEventListener("click", () => options.onProposalReview?.(item.text));
          body.appendChild(document.createElement("br"));
          body.appendChild(reviewBtn);
        }
        break;
      }
      case "tool": {
        const state = item.ok === null ? t("act.tool.running") : item.ok ? t("act.tool.ok") : t("act.tool.failed");
        body.textContent = `${item.summary}（${state}）`;
        break;
      }
      case "plan": {
        // AC20 分解可见：子任务清单逐项列出；fallback 标记分解失败的退化
        if (item.fallback) {
          body.textContent = t("act.plan.fallback");
        } else {
          const list = document.createElement("ol");
          list.className = "dw-plan-list";
          for (const sub of item.subtasks) {
            const li = document.createElement("li");
            li.textContent = `${sub.id} ${sub.title}`;
            list.appendChild(li);
          }
          body.appendChild(list);
        }
        break;
      }
      case "subagent": {
        body.textContent =
          item.phase === "start"
            ? t("act.subagent.start", { id: item.subagentId, title: item.title })
            : t("act.subagent.done", { id: item.subagentId, title: item.title, reason: item.finishReason ?? "completed" });
        break;
      }
      case "authorization": {
        const title = document.createElement("div");
        title.textContent = `${item.toolName}：${item.reason}`;
        body.appendChild(title);
        const controller = options.getController();
        if (item.decision === null && controller !== null) {
          const allow = document.createElement("button");
          allow.className = "dw-btn dw-btn-small dw-btn-primary";
          allow.textContent = t("chat.allow");
          allow.addEventListener("click", () => controller.authorize(item.requestId, "allow"));
          const allowSession = document.createElement("button");
          allowSession.className = "dw-btn dw-btn-small";
          allowSession.textContent = t("chat.allowSession");
          allowSession.addEventListener("click", () => controller.authorize(item.requestId, "allow_session"));
          const deny = document.createElement("button");
          deny.className = "dw-btn dw-btn-small dw-btn-danger";
          deny.textContent = t("chat.deny");
          deny.addEventListener("click", () => controller.authorize(item.requestId, "deny"));
          body.append(allow, allowSession, deny);
        } else {
          const decided = document.createElement("div");
          decided.className = "dw-auth-decided";
          decided.textContent = item.decision === null
            ? t("chat.decided", { decision: "—" })
            : t("chat.decided", { decision: t(DECISION_KEY[item.decision]) });
          body.appendChild(decided);
        }
        break;
      }
    }
    return row;
  }

  function render(): void {
    const controller = options.getController();
    root.textContent = "";
    if (controller === null) {
      const empty = document.createElement("div");
      empty.className = "dw-activity-empty";
      empty.textContent = t("act.empty");
      root.appendChild(empty);
      return;
    }
    for (const item of controller.listItems()) {
      root.appendChild(renderItem(item));
    }
    root.scrollTop = root.scrollHeight;
  }

  /** 激活任务切换时重新订阅新控制器。 */
  function resubscribe(): void {
    const controller = options.getController();
    if (controller === subscribed) {
      render();
      return;
    }
    unsubscribe?.();
    subscribed = controller;
    unsubscribe = controller !== null ? controller.onChange(render) : null;
    render();
  }

  resubscribe();
  // 语言热生效（AC12）：徽标/按钮/空态按新语言重绘
  const unsubscribeLocale = onDidChangeLocale(render);

  return {
    root,
    resubscribe,
    dispose(): void {
      unsubscribe?.();
      unsubscribeLocale();
      root.remove();
    },
  };
}
