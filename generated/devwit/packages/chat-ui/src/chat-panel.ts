import type { CodeSymbol, ModeDefinition, ProviderConfig, SymbolsQueryResult, SymbolKind } from "@devwit/contracts";
import { displayModeName, localizeError, onDidChangeLocale, t, ta } from "@devwit/i18n";
import type { ChatContextSnapshot, ChatController, ChatItem } from "./chat-controller.js";
import { detectAtTrigger, detectSlashTrigger, filterModesByQuery, filterWorkspaceFiles } from "./input-triggers.js";

/** 授权裁决 → 词典键（模板串键无法通过 MessageKey 类型检查，用显式映射）。 */
const DECISION_KEY = {
  allow: "chat.decision.allow",
  allow_session: "chat.decision.allow_session",
  deny: "chat.decision.deny",
} as const;

/** 符号种类 → 词典键（候选下拉与 chip 的种类徽标；显式映射保 MessageKey 类型）。 */
const SYMBOL_KIND_KEY: Record<SymbolKind, Parameters<typeof t>[0]> = {
  function: "chat.symbol.kind.function",
  class: "chat.symbol.kind.class",
  interface: "chat.symbol.kind.interface",
  method: "chat.symbol.kind.method",
  type: "chat.symbol.kind.type",
  enum: "chat.symbol.kind.enum",
  constant: "chat.symbol.kind.constant",
  variable: "chat.symbol.kind.variable",
  module: "chat.symbol.kind.module",
};

/** 符号候选查询防抖（@ 输入停顿后再发 IPC，避免逐键触发主进程全表评分）。 */
const SYMBOL_QUERY_DEBOUNCE_MS = 120; // qg-allow: 交互防抖经验值，候选首屏由文件候选同步给出

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
  /**
   * @符号 引用候选源（迭代 29 / AC38）：按查询串异步取符号候选与索引状态
   * （主进程 symbols:query IPC，防抖 120ms）。缺省时 @ 下拉仅文件区。
   */
  querySymbols?(query: string): Promise<SymbolsQueryResult>;
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
  /** 待发送的 @符号 引用（迭代 29 / AC38：保留完整元数据供 chip 展示；发送时取 id 列表）。 */
  const symbolRefs: CodeSymbol[] = [];
  /**
   * 候选下拉状态：file = @引用补全（文件区 + 符号区，active 为 [文件…, 符号…] 扁平下标）；
   * mode = /斜杠命令。kind 命名保持 "file"（AC28 语义与 e2e 契约不变）。
   */
  type SuggestState =
    | {
        kind: "file";
        start: number;
        query: string;
        candidates: string[];
        symbols: CodeSymbol[];
        symbolsState: SymbolsQueryResult["state"] | null;
        active: number;
      }
    | { kind: "mode"; candidates: ModeDefinition[]; active: number };
  let suggestState: SuggestState | null = null;
  /** 符号查询防抖：seq 识别过期响应；同串去重由调用侧 keepSymbols 承担（prev 已持有该串符号则不重取）。 */
  let symbolQueryTimer: ReturnType<typeof setTimeout> | null = null;
  let symbolQuerySeq = 0;

  /** 符号 chip 展示名（方法带容器名消歧：ClassName.method）。 */
  function symbolDisplayName(symbol: CodeSymbol): string {
    return symbol.parentName !== undefined ? `${symbol.parentName}.${symbol.name}` : symbol.name;
  }

  function renderChips(): void {
    chipsRow.textContent = "";
    chipsRow.style.display = attachments.length + symbolRefs.length === 0 ? "none" : "flex";
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
    for (const symbol of symbolRefs) {
      const chip = document.createElement("span");
      chip.className = "dw-atchip dw-atchip-symbol";
      chip.dataset["symbolId"] = symbol.id;
      chip.title = `${symbol.relPath} L${symbol.startLine}-${symbol.endLine}`;
      const badge = document.createElement("span");
      badge.className = "dw-atchip-kind";
      badge.textContent = t(SYMBOL_KIND_KEY[symbol.kind]);
      chip.appendChild(badge);
      chip.appendChild(document.createTextNode(symbolDisplayName(symbol)));
      const remove = document.createElement("button");
      remove.className = "dw-atchip-x";
      remove.textContent = "×";
      remove.title = t("chat.atchip.remove");
      remove.addEventListener("click", () => {
        const index = symbolRefs.findIndex((entry) => entry.id === symbol.id);
        if (index >= 0) symbolRefs.splice(index, 1);
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
      const { candidates, symbols, symbolsState, active } = suggestState;
      // 文件区与符号区并存时给分区标题（仅单一区时保持 AC28 的纯净形态）
      const showHeaders = candidates.length > 0 && symbols.length > 0;
      if (showHeaders) suggest.appendChild(makeSectionHeader(t("chat.suggest.files")));
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
      if (symbols.length > 0) {
        if (showHeaders) suggest.appendChild(makeSectionHeader(t("chat.suggest.symbols")));
        symbols.forEach((symbol, symbolIndex) => {
          const flatIndex = candidates.length + symbolIndex;
          const item = document.createElement("div");
          item.className = "dw-suggest-item dw-suggest-symbol" + (flatIndex === active ? " dw-suggest-active" : "");
          item.dataset["value"] = symbol.id;
          const badge = document.createElement("span");
          badge.className = "dw-suggest-kind";
          badge.textContent = t(SYMBOL_KIND_KEY[symbol.kind]);
          item.appendChild(badge);
          const name = document.createElement("span");
          name.className = "dw-suggest-name";
          name.textContent = symbolDisplayName(symbol);
          item.appendChild(name);
          const hint = document.createElement("span");
          hint.className = "dw-suggest-hint";
          hint.textContent = `${symbol.relPath}:${symbol.startLine}`;
          item.appendChild(hint);
          item.addEventListener("mousedown", (event) => {
            event.preventDefault();
            applySymbolCandidate(symbol);
          });
          suggest.appendChild(item);
        });
      } else if (symbolsState === "indexing" && candidates.length === 0) {
        // 索引构建中且无文件候选：给明示行（否则下拉空闪退）
        const hintRow = document.createElement("div");
        hintRow.className = "dw-suggest-item dw-suggest-hintrow";
        hintRow.textContent = t("chat.suggest.symbols.indexing");
        suggest.appendChild(hintRow);
      }
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

  function makeSectionHeader(text: string): HTMLElement {
    const header = document.createElement("div");
    header.className = "dw-suggest-section";
    header.textContent = text;
    return header;
  }

  /**
   * 符号候选异步查询（防抖 + 过期丢弃）：响应到达时若下拉仍在同串 @ 态，
   * 就地更新符号区并重绘（active 钳制到新区间）。
   */
  function scheduleSymbolQuery(query: string): void {
    if (options.querySymbols === undefined) return;
    if (symbolQueryTimer !== null) clearTimeout(symbolQueryTimer);
    const seq = ++symbolQuerySeq;
    symbolQueryTimer = setTimeout(() => {
      symbolQueryTimer = null;
      void options
        .querySymbols!(query)
        .then((result) => {
          if (seq !== symbolQuerySeq) return;
          if (suggestState?.kind !== "file" || suggestState.query !== query) return;
          suggestState.symbols = result.symbols;
          suggestState.symbolsState = result.state;
          const total = suggestState.candidates.length + result.symbols.length;
          if (total === 0 && result.state !== "indexing") {
            closeSuggest();
            return;
          }
          suggestState.active = Math.min(suggestState.active, total - 1);
          renderSuggest();
        })
        .catch(() => {
          // IPC 失败：保留文件区，符号区维持现状不阻断输入
        });
    }, SYMBOL_QUERY_DEBOUNCE_MS);
  }

  /** 按当前光标位置刷新候选：/ 开头 → 模式速切；@ 查询 → 文件补全 + 符号补全；否则关闭。 */
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
    if (at !== null) {
      const files = options.listWorkspaceFiles?.() ?? [];
      const candidates = filterWorkspaceFiles(files, at.query);
      const hasSymbolSource = options.querySymbols !== undefined;
      if (candidates.length === 0 && !hasSymbolSource) {
        closeSuggest();
        return;
      }
      const prev = suggestState?.kind === "file" ? suggestState : null;
      // 同串查询保留已取回的符号区（避免逐键清空闪动）；异串清空等防抖后重取
      const keepSymbols = prev !== null && prev.query === at.query;
      const total = candidates.length + (keepSymbols ? prev.symbols.length : 0);
      suggestState = {
        kind: "file",
        start: at.start,
        query: at.query,
        candidates,
        symbols: keepSymbols ? prev.symbols : [],
        symbolsState: keepSymbols ? prev.symbolsState : null,
        active: Math.min(prev?.active ?? 0, Math.max(total - 1, 0)),
      };
      renderSuggest();
      // prev 已持有同串符号（逐键输入）时不重取；新串/重开下拉才发 IPC（空串首查亦覆盖）
      if (!keepSymbols) scheduleSymbolQuery(at.query);
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

  /** 选中符号候选（AC38）：同文件候选删除 @查询 原文 → 生成符号 chip（按 id 去重）。 */
  function applySymbolCandidate(symbol: CodeSymbol): void {
    if (suggestState?.kind !== "file") return;
    const caret = textarea.selectionStart ?? textarea.value.length;
    const start = suggestState.start;
    textarea.value = textarea.value.slice(0, start) + textarea.value.slice(caret);
    textarea.selectionStart = start;
    textarea.selectionEnd = start;
    if (!symbolRefs.some((entry) => entry.id === symbol.id)) {
      symbolRefs.push(symbol);
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
      case "route": {
        // AC31：模型路由决策（与活动流同一组文案键）
        const key =
          item.routed === "local"
            ? "act.route.local"
            : item.routed === "complex"
              ? "act.route.complex"
              : item.routed === "manual"
                ? "act.route.manual"
                : item.routed === "unavailable"
                  ? "act.route.unavailable"
                  : "act.route.disabled";
        row.textContent = `[${t("act.route")}] ${t(key, { provider: item.providerId, score: item.score, threshold: item.threshold })}`;
        break;
      }
      case "workflow": {
        // AC32：工作流记忆命中（建议性复用，工具序列与复用次数可见）
        row.textContent = `[${t("act.workflow")}] ${t("act.workflow.reuse", {
          intent: item.intent,
          tools: item.tools.join(" → "),
          count: item.reuseCount,
        })}`;
        break;
      }
      case "modeRecommend": {
        // AC33：模式推荐（成功率统计可见 + 一键切换，建议非自动切换）
        const current = item.currentSuccessRate;
        row.textContent = `[${t("act.modeRecommend")}] ${t("act.modeRecommend.reason", {
          mode: resolveModeDisplayName(item.modeId),
          rate: Math.round(item.successRate * 100),
          runs: item.runs,
          current: resolveModeDisplayName(item.currentModeId),
          currentRate: current === null ? t("act.modeRecommend.noData") : `${Math.round(current * 100)}%`,
          intent: item.intent,
        })}`;
        if (controller.currentModeId === item.modeId) {
          const switched = document.createElement("div");
          switched.className = "dw-auth-decided";
          switched.textContent = t("act.modeRecommend.switched");
          row.appendChild(switched);
        } else {
          const switchBtn = document.createElement("button");
          switchBtn.className = "dw-btn dw-btn-small";
          switchBtn.textContent = t("act.modeRecommend.switch", { mode: resolveModeDisplayName(item.modeId) });
          switchBtn.addEventListener("click", () => {
            controller.setMode(item.modeId);
            refreshSelectors();
          });
          row.appendChild(switchBtn);
        }
        break;
      }
      case "subagent": {
        row.textContent =
          item.phase === "start"
            ? `[${t("act.subagent")}] ${t("act.subagent.start", { id: item.subagentId, title: item.title })}`
            : `[${t("act.subagent")}] ${t("act.subagent.done", { id: item.subagentId, title: item.title, reason: item.finishReason ?? "completed" })}`;
        break;
      }
      case "usage": {
        // AC35：真实 token 用量行（与活动流同一组文案键）
        row.textContent = `[${t("act.usage")}] ${t("act.usage.line", { input: item.inputTokens, output: item.outputTokens })}`;
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
    // 附件与符号引用随本轮发送；发送失败（如会话忙）时恢复 chips，避免用户引用丢失
    const attached = [...attachments];
    const refSymbols = [...symbolRefs];
    attachments.length = 0;
    symbolRefs.length = 0;
    renderChips();
    const snapshot: ChatContextSnapshot = {
      ...options.collectContext(),
      ...(attached.length > 0 ? { attachments: attached } : {}),
      ...(refSymbols.length > 0 ? { symbolRefs: refSymbols.map((symbol) => symbol.id) } : {}),
    };
    void controller.send(text, snapshot).catch(() => {
      attachments.push(...attached);
      symbolRefs.push(...refSymbols);
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
        const size =
          suggestState.kind === "file"
            ? suggestState.candidates.length + suggestState.symbols.length
            : suggestState.candidates.length;
        if (size === 0) return;
        suggestState.active = (suggestState.active + delta + size) % size;
        renderSuggest();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (suggestState.kind === "file") {
          const { candidates, symbols, active } = suggestState;
          if (active < candidates.length) {
            const file = candidates[active];
            if (file !== undefined) applyFileCandidate(file);
          } else {
            const symbol = symbols[active - candidates.length];
            if (symbol !== undefined) applySymbolCandidate(symbol);
          }
        } else {
          const current = suggestState.candidates[suggestState.active];
          if (current !== undefined) applyModeCandidate(current);
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
      if (symbolQueryTimer !== null) clearTimeout(symbolQueryTimer);
      symbolQuerySeq += 1; // 使在途响应失效
      unsubscribe();
      unsubscribeLocale();
      root.remove();
    },
  };
}
