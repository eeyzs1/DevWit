import type { ModeDefinition, ProviderConfig } from "@devwit/contracts";
import { displayModeName, localizeError, onDidChangeLocale, t, ta } from "@devwit/i18n";
import type { ChatContextSnapshot, ChatController, ChatItem } from "./chat-controller.js";
import { detectAtTrigger, detectSlashTrigger, filterModesByQuery, filterWorkspaceFiles } from "./input-triggers.js";

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
  /**
   * @文件引用候选源（迭代 19 / AC28）：返回工作区内可引用文件的相对路径
   * （正斜杠）。缺省时 @ 触发不出现（无工作区场景）。
   */
  listWorkspaceFiles?(): string[];
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

  // ---- 输入区（AC28：@文件引用 chips + /斜杠命令速切模式 + 候选下拉）----
  const inputArea = document.createElement("div");
  inputArea.className = "dw-chat-input";
  const chipsRow = document.createElement("div");
  chipsRow.className = "dw-atchips";
  const inputWrap = document.createElement("div");
  inputWrap.className = "dw-chat-input-wrap";
  const textarea = document.createElement("textarea");
  textarea.className = "dw-chat-textarea";
  textarea.rows = 3;
  const suggest = document.createElement("div");
  suggest.className = "dw-suggest";
  suggest.style.display = "none";
  inputWrap.append(textarea, suggest);
  const sendBtn = document.createElement("button");
  sendBtn.className = "dw-btn dw-btn-primary";
  const stopBtn = document.createElement("button");
  stopBtn.className = "dw-btn";
  stopBtn.style.display = "none";
  inputArea.append(chipsRow, inputWrap, sendBtn, stopBtn);
  root.appendChild(inputArea);
  container.appendChild(root);

  /** 待发送的 @引用附件（工作区相对路径，正斜杠；发送后清空）。 */
  const attachments: string[] = [];
  /** 候选下拉状态：file = @引用补全（含触发符下标）；mode = /斜杠命令。 */
  type SuggestState =
    | { kind: "file"; start: number; candidates: string[]; active: number }
    | { kind: "mode"; candidates: ModeDefinition[]; active: number };
  let suggestState: SuggestState | null = null;

  function renderChips(): void {
    chipsRow.textContent = "";
    chipsRow.style.display = attachments.length === 0 ? "none" : "flex";
    for (const attachment of attachments) {
      const chip = document.createElement("span");
      chip.className = "dw-atchip";
      chip.dataset["path"] = attachment;
      chip.title = attachment;
      const name = attachment.slice(attachment.lastIndexOf("/") + 1);
      chip.appendChild(document.createTextNode(name));
      const remove = document.createElement("button");
      remove.className = "dw-atchip-x";
      remove.textContent = "×";
      remove.title = t("chat.atchip.remove");
      remove.addEventListener("click", () => {
        const index = attachments.indexOf(attachment);
        if (index >= 0) attachments.splice(index, 1);
        renderChips();
        textarea.focus();
      });
      chip.appendChild(remove);
      chipsRow.appendChild(chip);
    }
  }

  function closeSuggest(): void {
    suggestState = null;
    suggest.style.display = "none";
    suggest.textContent = "";
  }

  function renderSuggest(): void {
    if (suggestState === null) return;
    suggest.textContent = "";
    suggest.dataset["kind"] = suggestState.kind;
    if (suggestState.kind === "file") {
      const { candidates, active } = suggestState;
      candidates.forEach((candidate, index) => {
        const item = document.createElement("div");
        item.className = "dw-suggest-item" + (index === active ? " dw-suggest-active" : "");
        item.dataset["value"] = candidate;
        item.textContent = candidate;
        // mousedown 先于 blur：阻止失焦关闭，保证点击可选中
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          applyFileCandidate(candidate);
        });
        suggest.appendChild(item);
      });
    } else {
      const { candidates, active } = suggestState;
      candidates.forEach((candidate, index) => {
        const item = document.createElement("div");
        item.className = "dw-suggest-item" + (index === active ? " dw-suggest-active" : "");
        item.dataset["value"] = candidate.id;
        item.appendChild(document.createTextNode(displayModeName(candidate)));
        const idHint = document.createElement("span");
        idHint.className = "dw-suggest-hint";
        idHint.textContent = candidate.id;
        item.appendChild(idHint);
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          applyModeCandidate(candidate);
        });
        suggest.appendChild(item);
      });
    }
    suggest.style.display = "block";
  }

  /** 按当前光标位置刷新候选：/ 开头 → 模式速切；@ 查询 → 文件补全；否则关闭。 */
  function refreshSuggest(): void {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const slash = detectSlashTrigger(textarea.value, caret);
    if (slash !== null) {
      const candidates = filterModesByQuery(options.listModes(), slash.query, displayModeName);
      if (candidates.length === 0) {
        closeSuggest();
        return;
      }
      const prev = suggestState?.kind === "mode" ? suggestState.active : 0;
      suggestState = { kind: "mode", candidates, active: Math.min(prev, candidates.length - 1) };
      renderSuggest();
      return;
    }
    const at = detectAtTrigger(textarea.value, caret);
    const files = options.listWorkspaceFiles?.() ?? [];
    if (at !== null && files.length > 0) {
      const candidates = filterWorkspaceFiles(files, at.query);
      if (candidates.length === 0) {
        closeSuggest();
        return;
      }
      const prev = suggestState?.kind === "file" ? suggestState.active : 0;
      suggestState = { kind: "file", start: at.start, candidates, active: Math.min(prev, candidates.length - 1) };
      renderSuggest();
      return;
    }
    closeSuggest();
  }

  /** 选中文件候选：删除 @查询 原文 → 生成 chip（去重），内容不留在输入框。 */
  function applyFileCandidate(candidate: string): void {
    if (suggestState?.kind !== "file") return;
    const caret = textarea.selectionStart ?? textarea.value.length;
    const start = suggestState.start;
    textarea.value = textarea.value.slice(0, start) + textarea.value.slice(caret);
    textarea.selectionStart = start;
    textarea.selectionEnd = start;
    if (!attachments.includes(candidate)) {
      attachments.push(candidate);
      renderChips();
    }
    closeSuggest();
    textarea.focus();
  }

  /** 选中模式候选（/斜杠命令）：立即切换模式并清空命令原文。 */
  function applyModeCandidate(candidate: ModeDefinition): void {
    controller.setMode(candidate.id);
    refreshSelectors();
    textarea.value = "";
    closeSuggest();
    textarea.focus();
  }

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
      case "plan": {
        // AC20：编排分解可见（子任务清单；fallback 为退化说明）
        if (item.fallback) {
          row.textContent = `[${t("act.plan")}] ${t("act.plan.fallback")}`;
        } else {
          row.textContent = `[${t("act.plan")}] ${item.subtasks.map((sub) => `${sub.id} ${sub.title}`).join("；")}`;
        }
        break;
      }
      case "diagnostics": {
        // AC30：诊断回馈（最新快照；0 = 修复闭环确认）
        row.textContent =
          item.count === 0
            ? `[${t("act.diagnostics")}] ${t("act.diagnostics.clean")}`
            : `[${t("act.diagnostics")}] ${t("act.diagnostics.found", { count: item.count, first: item.firstLine })}`;
        break;
      }
      case "subagent": {
        row.textContent =
          item.phase === "start"
            ? `[${t("act.subagent")}] ${t("act.subagent.start", { id: item.subagentId, title: item.title })}`
            : `[${t("act.subagent")}] ${t("act.subagent.done", { id: item.subagentId, title: item.title, reason: item.finishReason ?? "completed" })}`;
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
          decided.textContent = item.auto === true
            ? t("chat.decidedAuto")
            : t("chat.decided", { decision: t(DECISION_KEY[item.decision]) });
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
    closeSuggest();
    // 附件随本轮发送；发送失败（如会话忙）时恢复 chips，避免用户引用丢失
    const attached = [...attachments];
    attachments.length = 0;
    renderChips();
    const snapshot: ChatContextSnapshot = {
      ...options.collectContext(),
      ...(attached.length > 0 ? { attachments: attached } : {}),
    };
    void controller.send(text, snapshot).catch(() => {
      attachments.push(...attached);
      renderChips();
      // 错误已作为 error 项入列表（controller 内部处理）
    });
  }

  sendBtn.addEventListener("click", sendCurrent);
  stopBtn.addEventListener("click", () => controller.cancel());
  textarea.addEventListener("keydown", (event) => {
    // 候选下拉打开时：方向键导航、Enter/Tab 选中、Esc 关闭（均不触发发送）
    if (suggestState !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const size = suggestState.candidates.length;
        suggestState.active = (suggestState.active + delta + size) % size;
        renderSuggest();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const current = suggestState.candidates[suggestState.active];
        if (current === undefined) return;
        if (suggestState.kind === "file") {
          applyFileCandidate(current as string);
        } else {
          applyModeCandidate(current as ModeDefinition);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSuggest();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendCurrent();
    }
  });
  textarea.addEventListener("input", refreshSuggest);
  textarea.addEventListener("click", refreshSuggest);
  textarea.addEventListener("keyup", (event) => {
    // 光标移动类按键刷新候选定位（字符输入走 input 事件）
    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") refreshSuggest();
  });
  textarea.addEventListener("blur", closeSuggest);
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
