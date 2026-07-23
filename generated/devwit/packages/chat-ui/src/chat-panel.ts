import type { ModeDefinition, ProviderConfig } from "@devwit/contracts";
import { displayModeName, localizeError, onDidChangeLocale, t, ta } from "@devwit/i18n";
import type { ChatContextSnapshot, ChatController, ChatItem } from "./chat-controller.js";

/** 授权裁决 → 词典键（模板串键无法通过 MessageKey 类型检查，用显式映射）。 */
const DECISION_KEY = {
  allow: "chat.decision.allow",
  allow_session: "chat.decision.allow_session",
  deny: "chat.decision.deny",
} as const;

/**
 * chat-panel DOM 视图（WU012）：对话面板 + 模式/模型切换 + 授权裁决 + 流式渲染。
 * 只负责 DOM——全部状态在 ChatController；每次 onChange 全量重绘列表
 * （消息量为会话级，重绘成本可忽略；增量流式经 last-child 文本更新优化）。
 */
export interface ChatPanelOptions {
  controller: ChatController;
  /** 模式与模型列表（集成方从 api.modes/providers 拉取并热更新）。 */
  listModes(): ModeDefinition[];
  listProviders(): ProviderConfig[];
  /** 发送时采集会话上下文快照（活动文件/选区/终端尾段）。 */
  collectContext(): ChatContextSnapshot;
  /** 请求审查 assistant 最新回复中的编辑提案（WU013 钩子，可选）。 */
  onProposalReview?: (assistantText: string) => void;
}

export interface ChatPanelHandle {
  readonly root: HTMLElement;
  /** 模式/模型列表变更后调用（热更新）。 */
  refreshSelectors(): void;
  dispose(): void;
}

export function mountChatPanel(container: HTMLElement, options: ChatPanelOptions): ChatPanelHandle {
  const { controller } = options;
  const root = document.createElement("div");
  root.className = "dw-chat";

  // ---- 顶部：模式 / 模型选择器 ----
  const toolbar = document.createElement("div");
  toolbar.className = "dw-chat-toolbar";
  const modeSelect = document.createElement("select");
  modeSelect.className = "dw-select";
  const providerSelect = document.createElement("select");
  providerSelect.className = "dw-select";
  toolbar.append(modeSelect, providerSelect);
  root.appendChild(toolbar);

  // ---- 消息列表 ----
  const list = document.createElement("div");
  list.className = "dw-chat-list";
  root.appendChild(list);

  // ---- 输入区 ----
  const inputArea = document.createElement("div");
  inputArea.className = "dw-chat-input";
  const textarea = document.createElement("textarea");
  textarea.className = "dw-chat-textarea";
  textarea.rows = 3;
  const sendBtn = document.createElement("button");
  sendBtn.className = "dw-btn dw-btn-primary";
  const stopBtn = document.createElement("button");
  stopBtn.className = "dw-btn";
  stopBtn.style.display = "none";
  inputArea.append(textarea, sendBtn, stopBtn);
  root.appendChild(inputArea);
  container.appendChild(root);

  /** 静态文案随语言热更新（AC12）：选择器 title / 占位符 / 按钮文本。 */
  function applyLocale(): void {
    modeSelect.title = t("chat.mode");
    providerSelect.title = t("chat.provider");
    textarea.placeholder = t("chat.input.placeholder");
    sendBtn.textContent = t("chat.send");
    stopBtn.textContent = t("chat.stop");
  }

  function refreshSelectors(): void {
    const modes = options.listModes();
    modeSelect.textContent = "";
    for (const mode of modes) {
      const option = document.createElement("option");
      option.value = mode.id;
      // 内置模式工厂名（Chat/Agent）按当前语言本地化显示（迭代 4）
      option.textContent = displayModeName(mode);
      option.selected = mode.id === controller.currentModeId;
      modeSelect.appendChild(option);
    }
    const providers = options.listProviders();
    providerSelect.textContent = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = t("chat.provider.modeBound");
    providerSelect.appendChild(auto);
    for (const provider of providers) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = `${provider.label} · ${provider.model}`;
      option.selected = provider.id === controller.currentProviderId;
      providerSelect.appendChild(option);
    }
  }

  /** 模式 id → 当前语言显示名（localizeError 的 resolveModeName 回调）。 */
  function resolveModeDisplayName(modeId: string): string {
    const mode = options.listModes().find((candidate) => candidate.id === modeId);
    return mode !== undefined ? displayModeName(mode) : modeId;
  }

  function renderItem(item: ChatItem): HTMLElement {
    const row = document.createElement("div");
    row.className = `dw-msg dw-msg-${item.kind}`;
    switch (item.kind) {
      case "user":
        row.textContent = item.text;
        break;
      case "assistant": {
        row.textContent = item.text;
        if (item.streaming) {
          row.classList.add("dw-streaming");
        }
        if (!item.streaming && options.onProposalReview !== undefined && item.text.includes("```")) {
          const reviewBtn = document.createElement("button");
          reviewBtn.className = "dw-btn dw-btn-small";
          reviewBtn.textContent = t("chat.review");
          reviewBtn.addEventListener("click", () => options.onProposalReview?.(item.text));
          row.appendChild(document.createElement("br"));
          row.appendChild(reviewBtn);
        }
        break;
      }
      case "tool": {
        const badge = item.ok === null ? "…" : item.ok ? "✓" : "✗";
        row.textContent = `[${t("chat.tool")} ${badge}] ${item.summary}`;
        break;
      }
      case "authorization": {
        const title = document.createElement("div");
        title.textContent = t("chat.auth.request", { reason: item.reason });
        row.appendChild(title);
        if (item.decision === null) {
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
          row.append(allow, allowSession, deny);
        } else {
          const decided = document.createElement("div");
          decided.className = "dw-auth-decided";
          decided.textContent = t("chat.decided", { decision: t(DECISION_KEY[item.decision]) });
          row.appendChild(decided);
        }
        break;
      }
      case "error":
        // 主进程 ASCII 错误码 → 当前语言文案；模式名按 modes 列表本地化
        row.textContent = t("chat.error", {
          text: localizeError(item.text, { resolveModeName: resolveModeDisplayName }),
        });
        break;
      case "done":
        row.textContent = `— ${item.text} —`;
        break;
    }
    return row;
  }

  function render(): void {
    list.textContent = "";
    const items = controller.listItems();
    if (items.length === 0) {
      // 对话空态（AC11）：说明主 Agent 行为，降低首次使用的不确定性
      const empty = document.createElement("div");
      empty.className = "dw-chat-empty";
      const title = document.createElement("div");
      title.className = "dw-chat-empty-title";
      title.textContent = t("chat.empty.title");
      const lines = document.createElement("div");
      lines.className = "dw-chat-empty-lines";
      lines.textContent = ta("chat.empty.lines").join("\n");
      empty.append(title, lines);
      list.appendChild(empty);
    }
    for (const item of items) {
      list.appendChild(renderItem(item));
    }
    list.scrollTop = list.scrollHeight;
    sendBtn.style.display = controller.isRunning ? "none" : "";
    stopBtn.style.display = controller.isRunning ? "" : "none";
    textarea.disabled = controller.isRunning;
  }

  function sendCurrent(): void {
    const text = textarea.value;
    textarea.value = "";
    void controller.send(text, options.collectContext()).catch(() => {
      // 错误已作为 error 项入列表（controller 内部处理）
    });
  }

  sendBtn.addEventListener("click", sendCurrent);
  stopBtn.addEventListener("click", () => controller.cancel());
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendCurrent();
    }
  });
  modeSelect.addEventListener("change", () => controller.setMode(modeSelect.value));
  providerSelect.addEventListener("change", () => {
    controller.setProvider(providerSelect.value === "" ? undefined : providerSelect.value);
  });

  const unsubscribe = controller.onChange(render);
  // 语言热生效（AC12）：静态文案重写 + 列表按新语言全量重绘
  const unsubscribeLocale = onDidChangeLocale(() => {
    applyLocale();
    refreshSelectors();
    render();
  });
  applyLocale();
  refreshSelectors();
  render();

  return {
    root,
    refreshSelectors,
    dispose(): void {
      unsubscribe();
      unsubscribeLocale();
      root.remove();
    },
  };
}
