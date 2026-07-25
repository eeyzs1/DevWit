/**
 * 统一设置页（迭代 3 / AC12）：通用 / 模型 / 编辑器 / 模式 四个分区的单一入口。
 *
 * - 左侧导航切换分区，右侧内容区重渲染；
 * - 通用分区：界面语言切换——setLocale 热生效（全应用 onDidChangeLocale 链路）
 *   + 持久化到 settings 键 "ui.locale"（下次启动 renderer 初始化时恢复）；
 * - 语言切换时对话框自身文案同步重渲染（订阅 onDidChangeLocale，关闭时退订）；
 * - 模型 / 编辑器 / 模式 分区沿用原独立对话框的全部逻辑（热生效语义不变）。
 */
import type {
  AgentToolName,
  ContextItemType,
  DevwitApi,
  McpServerConfig,
  McpServerState,
  McpServerView,
  ModeDefinition,
  ProviderConfig,
  ProviderPreset,
  ProviderType,
  RagStatusInfo,
  UpdateStatusInfo,
} from "@devwit/contracts";
import {
  LOCALES,
  LOCALE_LABEL,
  localizeError,
  onDidChangeLocale,
  resolveSystemLocale,
  setLocale,
  t,
  type Locale,
} from "@devwit/i18n";

export type SettingsSection = "general" | "providers" | "editor" | "modes" | "mcp";

export interface SettingsDialogDeps {
  api: DevwitApi;
  /** providers 保存成功后回调（renderer 侧 reload + chat 选择器热更新）。 */
  onProvidersChanged: () => void;
  /** modes 保存/删除成功后回调。 */
  onModesChanged: () => void;
  /** 迭代 18 / AC27：通用分区「重跑首次运行向导」入口（可选——未接线时按钮不渲染）。 */
  onRerunWizard?: () => void;
}

/** t() 的键类型（仅 string 文案；数组文案走 ta()）。 */
type StringMessageKey = Parameters<typeof t>[0];

const SECTION_NAV: ReadonlyArray<{ id: SettingsSection; key: StringMessageKey }> = [
  { id: "general", key: "settings.nav.general" },
  { id: "providers", key: "settings.nav.providers" },
  { id: "editor", key: "settings.nav.editor" },
  { id: "modes", key: "settings.nav.modes" },
  { id: "mcp", key: "settings.nav.mcp" },
];

const AGENT_TOOLS: AgentToolName[] = ["read", "write", "edit", "bash", "grep", "find", "ls"];

/** 预设 id → 说明文案词典键（迭代 13 / AC22；模板串键无法过 MessageKey 类型检查，显式映射）。 */
const PRESET_HINT_KEY: Record<string, StringMessageKey> = {
  ollama: "provider.preset.hint.ollama",
  deepseek: "provider.preset.hint.deepseek",
  openrouter: "provider.preset.hint.openrouter",
};

/** 上下文类型 → 词典键（与 chat-ui 的 context-panel 共用 ctx.* 文案）。 */
const CONTEXT_TYPE_KEY: Record<ContextItemType, `ctx.${ContextItemType}`> = {
  system_prompt: "ctx.system_prompt",
  tool_definitions: "ctx.tool_definitions",
  file_fragment: "ctx.file_fragment",
  git_status: "ctx.git_status",
  terminal_output: "ctx.terminal_output",
  selection: "ctx.selection",
  conversation_history: "ctx.conversation_history",
  codebase_match: "ctx.codebase_match",
  diagnostics: "ctx.diagnostics",
  workflow: "ctx.workflow",
  custom: "ctx.custom",
};
const CONTEXT_TYPE_ORDER: readonly ContextItemType[] = [
  "system_prompt",
  "tool_definitions",
  "file_fragment",
  "codebase_match",
  "git_status",
  "terminal_output",
  "selection",
  "conversation_history",
  "diagnostics",
  "workflow",
  "custom",
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fieldInput(type: string, value: string): HTMLInputElement {
  const node = document.createElement("input");
  node.type = type;
  node.value = value;
  node.className = type === "checkbox" ? "" : "dw-input";
  return node;
}

// ============================================================================
// 入口
// ============================================================================

export function openSettingsDialog(deps: SettingsDialogDeps, initial: SettingsSection = "general"): void {
  const mask = el("div", "dw-modal-mask");
  const modal = el("div", "dw-modal dw-modal-settings");
  mask.appendChild(modal);
  const title = el("h2", undefined, t("settings.title"));
  modal.appendChild(title);

  const body = el("div", "dw-settings-body");
  const nav = el("div", "dw-settings-nav");
  const content = el("div", "dw-settings-content");
  body.append(nav, content);
  modal.appendChild(body);

  const actions = el("div", "dw-modal-actions");
  const closeBtn = el("button", "dw-btn", t("settings.close"));
  actions.appendChild(closeBtn);
  modal.appendChild(actions);

  let current: SettingsSection = initial;
  const navBtns = new Map<SettingsSection, HTMLButtonElement>();
  for (const { id } of SECTION_NAV) {
    const btn = el("button", "dw-settings-nav-item") as HTMLButtonElement;
    btn.addEventListener("click", () => show(id));
    nav.appendChild(btn);
    navBtns.set(id, btn);
  }

  // 更新状态订阅（AC16）：对话框级单订阅，通用分区重渲染时只换接收端，不泄漏
  let updateSink: ((status: UpdateStatusInfo) => void) | null = null;
  const unsubUpdate = deps.api.update.onStatus((status) => updateSink?.(status));

  // MCP 状态订阅（AC17）：同上模式——任一服务器状态变化只刷新当前 MCP 分区
  let mcpSink: (() => void) | null = null;
  const unsubMcp = deps.api.mcp.onChanged(() => mcpSink?.());

  // RAG 状态订阅（AC19）：索引进度/就绪/错误只刷新通用分区的状态行
  let ragSink: ((status: RagStatusInfo) => void) | null = null;
  const unsubRag = deps.api.rag.onStatus((status) => ragSink?.(status));

  function applyLocale(): void {
    title.textContent = t("settings.title");
    closeBtn.textContent = t("settings.close");
    for (const { id, key } of SECTION_NAV) {
      const btn = navBtns.get(id);
      if (btn !== undefined) btn.textContent = t(key);
    }
  }

  function show(section: SettingsSection): void {
    current = section;
    for (const [id, btn] of navBtns) {
      btn.classList.toggle("dw-settings-nav-active", id === section);
    }
    content.textContent = "";
    updateSink = null; // 离开/重渲染分区时摘除旧接收端
    mcpSink = null;
    ragSink = null;
    switch (section) {
      case "general":
        renderGeneral(content, deps, (sink) => {
          updateSink = sink;
        }, (sink) => {
          ragSink = sink;
        });
        break;
      case "providers":
        renderProviders(content, deps);
        break;
      case "editor":
        renderEditor(content, deps);
        break;
      case "modes":
        void renderModes(content, deps);
        break;
      case "mcp":
        renderMcp(content, deps, (sink) => {
          mcpSink = sink;
        });
        break;
    }
  }

  // 语言热生效（AC12）：对话框自身文案与当前分区一并重渲染
  const unsubscribe = onDidChangeLocale(() => {
    applyLocale();
    show(current);
  });
  const close = (): void => {
    unsubscribe();
    unsubUpdate();
    unsubMcp();
    unsubRag();
    mask.remove();
  };
  closeBtn.addEventListener("click", close);
  mask.addEventListener("click", (event) => {
    if (event.target === mask) close();
  });

  applyLocale();
  show(initial);
  document.body.appendChild(mask);
}

// ============================================================================
// 通用：界面语言（热生效 + 持久化）
// ============================================================================

function renderGeneral(
  content: HTMLElement,
  deps: SettingsDialogDeps,
  onUpdateSink: (sink: (status: UpdateStatusInfo) => void) => void,
  onRagSink: (sink: (status: RagStatusInfo) => void) => void
): void {
  const form = el("div", "dw-form");
  const label = el("label", undefined, t("settings.general.language"));
  const select = el("select", "dw-select") as HTMLSelectElement;
  // 「跟随系统」置顶：持久化值为 "system"（或从未设置）时选中，运行时按 resolveSystemLocale() 解析
  const systemOption = document.createElement("option");
  systemOption.value = "system";
  systemOption.textContent = t("settings.general.language.system");
  select.appendChild(systemOption);
  for (const locale of LOCALES) {
    const option = document.createElement("option");
    option.value = locale;
    option.textContent = LOCALE_LABEL[locale];
    select.appendChild(option);
  }
  // 选中态以持久化值为准（getLocale() 是解析后的语言，无法区分「跟随系统」与显式选择）
  void deps.api.settings.get("ui.locale").then((stored) => {
    select.value = stored === "zh-CN" || stored === "en-US" ? stored : "system";
  });
  select.addEventListener("change", () => {
    const choice = select.value;
    const resolved = choice === "system" ? resolveSystemLocale() : (choice as Locale);
    setLocale(resolved); // 热生效：触发全应用 onDidChangeLocale（含本对话框）
    void deps.api.settings.set("ui.locale", choice); // 持久化原始选择（含 "system"）：下次启动恢复
  });
  const hint = el("div", "dw-modal-hint", t("settings.general.language.hint"));

  // ---- 应用更新（AC16）：当前版本 + 手动检查 + 内联结果 ----
  const updateLabel = el("label", undefined, t("settings.general.update"));
  const updateRow = el("div", "dw-settings-update");
  const checkBtn = el("button", "dw-btn", t("settings.general.update.check"));
  const updateStatus = el("span", "dw-settings-update-status");
  updateRow.append(checkBtn, updateStatus);
  const updateHint = el("div", "dw-modal-hint", t("settings.general.update.hint"));
  void deps.api.update.version().then((version) => {
    if (updateStatus.textContent === "" || updateStatus.dataset["kind"] === "version") {
      updateStatus.dataset["kind"] = "version";
      updateStatus.textContent = t("settings.general.update.current", { version });
    }
  });
  checkBtn.addEventListener("click", () => {
    updateStatus.dataset["kind"] = "status";
    updateStatus.textContent = t("update.checking");
    void deps.api.update.check();
  });
  onUpdateSink((status) => {
    updateStatus.dataset["kind"] = "status";
    if (status.state === "checking") updateStatus.textContent = t("update.checking");
    else if (status.state === "available") updateStatus.textContent = t("update.available", { version: status.version });
    else if (status.state === "downloading") updateStatus.textContent = t("update.downloading", { percent: status.percent });
    else if (status.state === "ready") updateStatus.textContent = t("update.ready", { version: status.version });
    else if (status.state === "none") updateStatus.textContent = t("update.none");
    else if (status.state === "disabled") updateStatus.textContent = t("update.disabled");
    else updateStatus.textContent = t("update.error", { code: status.code });
  });

  // ---- 代码索引（AC19 透明 RAG）：开关 + 状态行 + 手动重建 ----
  const ragLabel = el("label", undefined, t("rag.title"));
  const ragRow = el("div", "dw-settings-update");
  const ragToggle = document.createElement("input");
  ragToggle.type = "checkbox";
  const ragStatus = el("span", "dw-settings-update-status");
  ragRow.append(ragToggle, ragStatus);
  const ragActions = el("div", "dw-settings-update");
  const ragRebuildBtn = el("button", "dw-btn", t("rag.rebuild"));
  ragActions.append(ragRebuildBtn);
  const ragHint = el("div", "dw-modal-hint", t("rag.hint"));

  const renderRagStatus = (status: RagStatusInfo): void => {
    if (status.state === "disabled") ragStatus.textContent = t("rag.status.disabled");
    else if (status.state === "indexing") ragStatus.textContent = t("rag.status.indexing", { done: status.indexedFiles, total: status.totalFiles });
    else if (status.state === "ready") ragStatus.textContent = t("rag.status.ready", { files: status.fileCount, chunks: status.chunkCount });
    else ragStatus.textContent = t("rag.status.error", { code: status.code });
  };
  onRagSink(renderRagStatus);
  void deps.api.rag.getStatus().then(renderRagStatus);

  // 开关：读出现有配置仅改 enabled（保留 topK/budgetTokens/embedModel 等高级项）
  void deps.api.settings.get("rag").then((stored) => {
    ragToggle.checked = typeof stored === "object" && stored !== null && (stored as { enabled?: unknown }).enabled === true;
  });
  ragToggle.addEventListener("change", () => {
    void deps.api.settings.get("rag").then((stored) => {
      const base = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
      void deps.api.settings.set("rag", { ...base, enabled: ragToggle.checked });
    });
  });
  ragRebuildBtn.addEventListener("click", () => {
    ragStatus.textContent = t("rag.status.indexing", { done: 0, total: 0 });
    void deps.api.rag.rebuild();
  });

  // ---- 命令白名单（AC29 授权白名单学习）：开关 + 阈值 + 条目管理 ----
  const secTitle = el("label", undefined, t("security.title"));
  const secLearnRow = el("div", "dw-settings-update");
  const secToggle = document.createElement("input");
  secToggle.type = "checkbox";
  secLearnRow.append(secToggle, el("span", "dw-settings-update-status", t("security.learning")));
  const secThreshRow = el("div", "dw-settings-update");
  const secThreshInput = fieldInput("number", "2");
  secThreshInput.min = "1";
  secThreshInput.max = "20";
  secThreshRow.append(el("span", "dw-settings-update-status", t("security.threshold")), secThreshInput);
  const secList = el("div", "dw-settings-whitelist");
  const secHint = el("div", "dw-modal-hint", t("security.hint"));

  const loadWhitelist = async (): Promise<void> => {
    const [list, approvals, learning] = await Promise.all([
      deps.api.settings.get("security.commandWhitelist"),
      deps.api.settings.get("security.commandApprovals"),
      deps.api.settings.get("security.whitelistLearning"),
    ]);
    // 学习开关与阈值：缺省 开 / 2 次（与主进程 DEFAULT_LEARNING 一致）
    const learningRecord = typeof learning === "object" && learning !== null ? (learning as Record<string, unknown>) : {};
    secToggle.checked = learningRecord["enabled"] !== false;
    const threshold = learningRecord["threshold"];
    secThreshInput.value = String(typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : 2);
    // 条目列表：白名单逐条可删 + 学习中计数可见（透明性）
    const commands = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    const pending = typeof approvals === "object" && approvals !== null ? (approvals as Record<string, number>) : {};
    secList.textContent = "";
    if (commands.length === 0 && Object.keys(pending).length === 0) {
      secList.appendChild(el("div", "dw-modal-hint", t("security.empty")));
      return;
    }
    for (const command of commands) {
      const row = el("div", "dw-settings-whitelist-row");
      row.appendChild(el("span", "dw-settings-whitelist-cmd", command));
      const removeBtn = el("button", "dw-btn dw-btn-small", t("security.remove"));
      removeBtn.addEventListener("click", () => {
        void deps.api.settings.get("security.commandWhitelist").then((stored) => {
          const current = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [];
          void deps.api.settings.set("security.commandWhitelist", current.filter((x) => x !== command)).then(() => loadWhitelist());
        });
      });
      row.appendChild(removeBtn);
      secList.appendChild(row);
    }
    for (const [command, count] of Object.entries(pending)) {
      const row = el("div", "dw-settings-whitelist-row");
      row.appendChild(el("span", "dw-settings-whitelist-cmd dw-settings-whitelist-pending", t("security.pending", { command, count })));
      secList.appendChild(row);
    }
    if (commands.length > 0) {
      const clearBtn = el("button", "dw-btn dw-btn-small dw-btn-danger", t("security.clear"));
      clearBtn.addEventListener("click", () => {
        void deps.api.settings.set("security.commandWhitelist", []).then(() => loadWhitelist());
      });
      secList.appendChild(clearBtn);
    }
  };
  void loadWhitelist();
  const saveLearning = (): void => {
    const parsed = Number(secThreshInput.value);
    const threshold = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 2;
    void deps.api.settings.set("security.whitelistLearning", { enabled: secToggle.checked, threshold });
  };
  secToggle.addEventListener("change", saveLearning);
  secThreshInput.addEventListener("change", saveLearning);

  // ---- 本地小模型路由（AC31）：开关 + 本地 provider 选择 + 复杂度阈值 ----
  const routeTitle = el("label", undefined, t("routing.title"));
  const routeEnableRow = el("div", "dw-settings-update");
  const routeToggle = document.createElement("input");
  routeToggle.type = "checkbox";
  routeEnableRow.append(routeToggle, el("span", "dw-settings-update-status", t("routing.enable")));
  const routeProviderRow = el("div", "dw-settings-update");
  const routeProvider = el("select", "dw-select") as HTMLSelectElement;
  routeProviderRow.append(el("span", "dw-settings-update-status", t("routing.provider")), routeProvider);
  const routeThreshRow = el("div", "dw-settings-update");
  const routeThreshInput = fieldInput("number", "30");
  routeThreshInput.min = "1";
  routeThreshInput.max = "100";
  routeThreshRow.append(el("span", "dw-settings-update-status", t("routing.threshold")), routeThreshInput);
  const routeHint = el("div", "dw-modal-hint", t("routing.hint"));

  const saveRouting = (): void => {
    const parsed = Number(routeThreshInput.value);
    const threshold = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 30;
    void deps.api.settings.set("routing.local", {
      enabled: routeToggle.checked,
      providerId: routeProvider.value,
      threshold,
    });
  };
  routeToggle.addEventListener("change", saveRouting);
  routeProvider.addEventListener("change", saveRouting);
  routeThreshInput.addEventListener("change", saveRouting);
  // 初始填充：provider 下拉（未选择项置顶）+ 已存配置回显
  void (async () => {
    const [providers, stored] = await Promise.all([deps.api.providers.list(), deps.api.settings.get("routing.local")]);
    const record = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = t("routing.provider.none");
    routeProvider.appendChild(noneOption);
    for (const p of providers) {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = `${p.label} · ${p.model}`;
      routeProvider.appendChild(option);
    }
    routeToggle.checked = record["enabled"] === true;
    routeProvider.value = typeof record["providerId"] === "string" ? record["providerId"] : "";
    const threshold = record["threshold"];
    routeThreshInput.value = String(typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : 30);
  })();

  // ---- 工作流记忆（AC32）：开关 + 模板列表（逐条删除/清空）----
  const wfTitle = el("label", undefined, t("workflow.title"));
  const wfEnableRow = el("div", "dw-settings-update");
  const wfToggle = document.createElement("input");
  wfToggle.type = "checkbox";
  wfEnableRow.append(wfToggle, el("span", "dw-settings-update-status", t("workflow.enable")));
  const wfList = el("div", "dw-settings-whitelist");
  const wfHint = el("div", "dw-modal-hint", t("workflow.hint"));

  interface WfTemplate {
    id: string;
    intent: string;
    tools: string[];
    reuseCount: number;
  }
  const readWfTemplates = (stored: unknown): WfTemplate[] =>
    Array.isArray(stored)
      ? stored.filter(
          (item): item is WfTemplate =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as WfTemplate).id === "string" &&
            typeof (item as WfTemplate).intent === "string" &&
            Array.isArray((item as WfTemplate).tools) &&
            typeof (item as WfTemplate).reuseCount === "number"
        )
      : [];

  const loadWorkflow = async (): Promise<void> => {
    const [config, templatesRaw] = await Promise.all([
      deps.api.settings.get("workflow.memory"),
      deps.api.settings.get("workflow.templates"),
    ]);
    const configRecord = typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
    // 与主进程 readWorkflowEnabled 同口径：缺省开（功能无破坏性，只是建议项注入）
    wfToggle.checked = configRecord["enabled"] !== false;
    const templates = readWfTemplates(templatesRaw);
    wfList.textContent = "";
    if (templates.length === 0) {
      wfList.appendChild(el("div", "dw-modal-hint", t("workflow.empty")));
      return;
    }
    for (const template of templates) {
      const row = el("div", "dw-settings-whitelist-row");
      row.appendChild(
        el("span", "dw-settings-whitelist-cmd", t("workflow.entry", {
          intent: template.intent,
          tools: template.tools.join(" → "),
          count: template.reuseCount,
        }))
      );
      const removeBtn = el("button", "dw-btn dw-btn-small", t("workflow.remove"));
      removeBtn.addEventListener("click", () => {
        void deps.api.settings.get("workflow.templates").then((stored) => {
          const current = readWfTemplates(stored);
          void deps.api.settings.set("workflow.templates", current.filter((x) => x.id !== template.id)).then(() => loadWorkflow());
        });
      });
      row.appendChild(removeBtn);
      wfList.appendChild(row);
    }
    const clearBtn = el("button", "dw-btn dw-btn-small dw-btn-danger", t("workflow.clear"));
    clearBtn.addEventListener("click", () => {
      void deps.api.settings.set("workflow.templates", []).then(() => loadWorkflow());
    });
    wfList.appendChild(clearBtn);
  };
  void loadWorkflow();
  wfToggle.addEventListener("change", () => {
    void deps.api.settings.set("workflow.memory", { enabled: wfToggle.checked });
  });

  // ---- 用量统计（AC35）：真实 token 用量聚合（今日/累计/按模式/按服务商）+ 清零 ----
  const usageTitle = el("label", undefined, t("settings.usage.title"));
  const usageSummaryBox = el("div", "dw-settings-whitelist");
  const usageActions = el("div", "dw-settings-update");
  const usageRefreshBtn = el("button", "dw-btn", t("settings.usage.refresh"));
  const usageClearBtn = el("button", "dw-btn dw-btn-small dw-btn-danger", t("settings.usage.clear"));
  usageActions.append(usageRefreshBtn, usageClearBtn);
  const usageHint = el("div", "dw-modal-hint", t("settings.usage.hint"));

  const loadUsage = async (): Promise<void> => {
    const [summary, modeList] = await Promise.all([deps.api.usage.summary(), deps.api.modes.list()]);
    // 模式 id → 用户改名后的显示名（未找到时回退 id——模式已删的历史计量仍可见）
    const modeName = (id: string): string => modeList.find((mode) => mode.id === id)?.name ?? id;
    usageSummaryBox.textContent = "";
    if (summary.total.runs === 0) {
      usageSummaryBox.appendChild(el("div", "dw-modal-hint", t("settings.usage.empty")));
      return;
    }
    usageSummaryBox.appendChild(el("div", "dw-settings-whitelist-row", t("settings.usage.today", {
      input: summary.today.inputTokens,
      output: summary.today.outputTokens,
      runs: summary.today.runs,
    })));
    usageSummaryBox.appendChild(el("div", "dw-settings-whitelist-row", t("settings.usage.total", {
      input: summary.total.inputTokens,
      output: summary.total.outputTokens,
      runs: summary.total.runs,
    })));
    if (summary.byMode.length > 0) {
      usageSummaryBox.appendChild(el("div", "dw-modal-hint", t("settings.usage.byMode")));
      for (const row of summary.byMode) {
        usageSummaryBox.appendChild(el("div", "dw-settings-whitelist-row", t("settings.usage.row", {
          name: modeName(row.modeId),
          input: row.inputTokens,
          output: row.outputTokens,
          runs: row.runs,
        })));
      }
    }
    if (summary.byProvider.length > 0) {
      usageSummaryBox.appendChild(el("div", "dw-modal-hint", t("settings.usage.byProvider")));
      for (const row of summary.byProvider) {
        usageSummaryBox.appendChild(el("div", "dw-settings-whitelist-row", t("settings.usage.row", {
          name: `${row.providerId} · ${row.model}`,
          input: row.inputTokens,
          output: row.outputTokens,
          runs: row.runs,
        })));
      }
    }
  };
  void loadUsage();
  usageRefreshBtn.addEventListener("click", () => void loadUsage());
  usageClearBtn.addEventListener("click", () => {
    void deps.api.usage.clear().then(() => loadUsage());
  });

  form.append(label, select, hint, updateLabel, updateRow, updateHint, ragLabel, ragRow, ragActions, ragHint,
    secTitle, secLearnRow, secThreshRow, secList, secHint,
    routeTitle, routeEnableRow, routeProviderRow, routeThreshRow, routeHint,
    wfTitle, wfEnableRow, wfList, wfHint,
    usageTitle, usageSummaryBox, usageActions, usageHint);

  // ---- 首次运行向导（迭代 18 / AC27）：允许随时重跑（如换机/重装后引导同伴）----
  if (deps.onRerunWizard !== undefined) {
    const rerun = deps.onRerunWizard;
    const wizardLabel = el("label", undefined, t("settings.general.wizard"));
    const wizardBtn = el("button", "dw-btn", t("settings.general.wizard.rerun"));
    wizardBtn.addEventListener("click", () => rerun());
    form.append(wizardLabel, wizardBtn);
  }
  content.appendChild(form);
}

// ============================================================================
// 模型：providers CRUD + 凭证加密写入（明文永不回显）
// ============================================================================

function renderProviders(content: HTMLElement, deps: SettingsDialogDeps): void {
  const { api } = deps;
  content.appendChild(el("h3", "dw-settings-subtitle", t("provider.title")));
  const list = el("div", "dw-modal-list");
  content.appendChild(list);

  let providers: ProviderConfig[] = [];
  // 迭代 13 / AC22：预设目录自主进程 IPC 下发（llm-providers 唯一持有 endpoint 知识，AR002）
  let presets: ProviderPreset[] = [];
  let activePreset: ProviderPreset | null = null;

  const form = el("div", "dw-form");
  const idInput = fieldInput("text", "");
  const presetSelect = el("select", "dw-select") as HTMLSelectElement;
  const presetHint = el("div", "dw-modal-hint");
  const typeSelect = el("select", "dw-select") as HTMLSelectElement;
  for (const value of ["anthropic", "openai"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    typeSelect.appendChild(option);
  }
  const labelInput = fieldInput("text", "");
  const baseUrlInput = fieldInput("text", "");
  const modelInput = fieldInput("text", "");
  // 预设型号建议（datalist 不限制自由输入）
  const modelDatalist = document.createElement("datalist");
  modelDatalist.id = "dw-provider-model-suggestions";
  modelInput.setAttribute("list", modelDatalist.id);
  const secretLabel = el("label", undefined, t("provider.apiKey"));
  const secretInput = fieldInput("password", "");
  const maxTokensInput = fieldInput("number", "4096");
  const errorBox = el("div", "dw-form-error");
  // 迭代 17 / AC26：连接探测状态行（成功显示型号数，失败显示本地化错误 + Ollama 引导）
  const probeStatus = el("div", "dw-modal-hint");
  form.append(
    el("label", undefined, t("provider.preset")),
    presetSelect,
    presetHint,
    el("label", undefined, t("common.id")),
    idInput,
    el("label", undefined, t("provider.type")),
    typeSelect,
    el("label", undefined, t("provider.label")),
    labelInput,
    el("label", undefined, t("provider.baseUrl")),
    baseUrlInput,
    el("label", undefined, t("provider.model")),
    modelInput,
    modelDatalist,
    secretLabel,
    secretInput,
    el("label", undefined, t("provider.maxTokens")),
    maxTokensInput,
    errorBox,
    probeStatus
  );
  content.appendChild(form);

  /** keyless（本地服务）时隐藏 API Key 行并给说明；否则恢复。 */
  function updateKeylessUI(keyless: boolean): void {
    secretLabel.style.display = keyless ? "none" : "";
    secretInput.style.display = keyless ? "none" : "";
    if (keyless) {
      secretInput.value = "";
      secretInput.placeholder = "";
    }
  }

  function applyPreset(preset: ProviderPreset | null): void {
    activePreset = preset;
    modelDatalist.textContent = "";
    probeStatus.textContent = "";
    probeStatus.classList.remove("dw-form-error");
    if (preset === null) {
      presetHint.textContent = "";
      updateKeylessUI(false);
      return;
    }
    typeSelect.value = preset.type;
    baseUrlInput.value = preset.baseUrl;
    if (labelInput.value.trim() === "") labelInput.value = preset.label;
    for (const model of preset.models) {
      const option = document.createElement("option");
      option.value = model;
      modelDatalist.appendChild(option);
    }
    modelInput.placeholder = preset.models[0] ?? "";
    const hintKey = PRESET_HINT_KEY[preset.id];
    presetHint.textContent = hintKey !== undefined ? t(hintKey) : "";
    updateKeylessUI(preset.keyless);
  }

  presetSelect.addEventListener("change", () => {
    applyPreset(presets.find((preset) => preset.id === presetSelect.value) ?? null);
  });

  function fillForm(config: ProviderConfig): void {
    idInput.value = config.id;
    idInput.disabled = true;
    // 按 type+baseUrl 回匹配预设；用户改过 baseUrl 的回退自定义，keyless 状态仍按 config 保留
    const matched = presets.find((preset) => preset.type === config.type && preset.baseUrl === config.baseUrl) ?? null;
    activePreset = matched;
    presetSelect.value = matched?.id ?? "";
    typeSelect.value = config.type;
    labelInput.value = config.label;
    baseUrlInput.value = config.baseUrl;
    modelInput.value = config.model;
    secretInput.value = "";
    secretInput.placeholder = t("provider.secret.keep");
    maxTokensInput.value = String(config.maxTokens);
    modelDatalist.textContent = "";
    for (const model of matched?.models ?? []) {
      const option = document.createElement("option");
      option.value = model;
      modelDatalist.appendChild(option);
    }
    const hintKey = matched !== null ? PRESET_HINT_KEY[matched.id] : undefined;
    presetHint.textContent = hintKey !== undefined ? t(hintKey) : "";
    updateKeylessUI(matched?.keyless === true || config.keyless === true);
    errorBox.textContent = "";
    probeStatus.textContent = "";
    probeStatus.classList.remove("dw-form-error");
  }
  function newForm(): void {
    idInput.value = `p-${Date.now().toString(36)}`;
    idInput.disabled = false;
    presetSelect.value = "";
    activePreset = null;
    presetHint.textContent = "";
    typeSelect.value = "anthropic";
    labelInput.value = "";
    baseUrlInput.value = "";
    // AR002：渲染进程不硬编码任何 LLM API 域名，由用户显式填写（官方或代理 endpoint；或选预设自动填充）
    baseUrlInput.placeholder = t("provider.baseUrl.placeholder");
    modelInput.value = "";
    modelInput.placeholder = "";
    modelDatalist.textContent = "";
    secretInput.value = "";
    secretInput.placeholder = t("provider.secret.new");
    maxTokensInput.value = "4096";
    updateKeylessUI(false);
    errorBox.textContent = "";
    probeStatus.textContent = "";
    probeStatus.classList.remove("dw-form-error");
  }
  async function renderList(): Promise<void> {
    providers = await api.providers.list();
    list.textContent = "";
    for (const config of providers) {
      const row = el("div", "dw-modal-list-item");
      row.appendChild(el("span", "dw-grow", `${config.label} · ${config.type} · ${config.model}`));
      const editBtn = el("button", "dw-btn dw-btn-small", t("provider.edit"));
      editBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        fillForm(config);
      });
      row.appendChild(editBtn);
      row.addEventListener("click", () => fillForm(config));
      list.appendChild(row);
    }
  }

  const actions = el("div", "dw-modal-actions");
  const probeBtn = el("button", "dw-btn", t("provider.probe")) as HTMLButtonElement;
  const newBtn = el("button", "dw-btn", t("provider.new"));
  const saveBtn = el("button", "dw-btn dw-btn-primary", t("provider.save"));
  actions.append(probeBtn, newBtn, saveBtn);
  content.appendChild(actions);

  /**
   * 连接探测（迭代 17 / AC26）：真实 GET 模型列表端点。
   * 成功——状态行显示型号数、真实型号回填 datalist，型号输入框为空时自动填首个
   * 发现型号（Ollama 场景零输入完成配置）；失败——本地化错误，Ollama 预设
   * 不可达时追加安装引导。
   */
  async function runProbe(): Promise<void> {
    const baseUrl = baseUrlInput.value.trim();
    probeStatus.textContent = "";
    probeStatus.classList.remove("dw-form-error");
    if (baseUrl === "") {
      probeStatus.classList.add("dw-form-error");
      probeStatus.textContent = t("err.probeInvalidUrl");
      return;
    }
    probeBtn.disabled = true;
    probeStatus.textContent = t("provider.probe.running");
    const existing = providers.find((p) => p.id === idInput.value.trim());
    const keyless = activePreset !== null ? activePreset.keyless : existing?.keyless === true;
    try {
      const result = await api.providers.probe({
        type: typeSelect.value as ProviderType,
        baseUrl,
        ...(keyless ? { keyless: true } : {}),
        ...(secretInput.value !== "" ? { apiKey: secretInput.value } : {}),
        ...(secretInput.value === "" && existing !== undefined ? { credentialRef: existing.credentialRef } : {}),
      });
      if (result.models.length > 0) {
        probeStatus.textContent = t("provider.probe.ok", { count: result.models.length });
        modelDatalist.textContent = "";
        for (const model of result.models) {
          const option = document.createElement("option");
          option.value = model;
          modelDatalist.appendChild(option);
        }
        if (modelInput.value.trim() === "") {
          modelInput.value = result.models[0] ?? "";
        }
        modelInput.placeholder = result.models[0] ?? "";
      } else {
        probeStatus.textContent = t("provider.probe.okNoModels");
      }
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      probeStatus.classList.add("dw-form-error");
      probeStatus.textContent = localizeError(raw);
      if (activePreset?.id === "ollama" && raw.includes("DW_PROBE_UNREACHABLE")) {
        probeStatus.appendChild(el("div", undefined, t("provider.probe.ollamaHint")));
      }
    } finally {
      probeBtn.disabled = false;
    }
  }
  probeBtn.addEventListener("click", () => {
    void runProbe();
  });

  newBtn.addEventListener("click", newForm);
  saveBtn.addEventListener("click", () => {
    void (async () => {
      errorBox.textContent = "";
      const id = idInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      const model = modelInput.value.trim();
      if (id === "" || baseUrl === "" || model === "") {
        errorBox.textContent = t("provider.required");
        return;
      }
      const existing = providers.find((p) => p.id === id);
      // keyless 判定：当前选中预设的 keyless 为准；预设被改回自定义时，
      // 已存配置的 keyless 仍可保留（如用户改 baseUrl 指向局域网 Ollama）
      const keyless = activePreset !== null ? activePreset.keyless : existing?.keyless === true;
      const credentialRef = `cred-${id}`;
      if (secretInput.value !== "") {
        await api.credentials.set(credentialRef, typeSelect.value, secretInput.value);
      }
      if (!keyless && existing === undefined && secretInput.value === "") {
        errorBox.textContent = t("provider.needKey");
        return;
      }
      const config: ProviderConfig = {
        id,
        type: typeSelect.value as ProviderType,
        label: labelInput.value.trim() || id,
        baseUrl,
        model,
        credentialRef: existing?.credentialRef ?? credentialRef,
        maxTokens: Number(maxTokensInput.value) || 4096,
        ...(existing?.temperature !== undefined ? { temperature: existing.temperature } : {}),
        ...(keyless ? { keyless: true } : {}),
      };
      await api.providers.upsert(config);
      deps.onProvidersChanged();
      await renderList();
      errorBox.textContent = t("provider.saved");
    })().catch((error: unknown) => {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    });
  });

  // 预设目录异步下发后填充下拉（首项为自定义），再加载已存配置
  void (async () => {
    presets = await api.providers.presets();
    presetSelect.textContent = "";
    const custom = document.createElement("option");
    custom.value = "";
    custom.textContent = t("provider.preset.custom");
    presetSelect.appendChild(custom);
    for (const preset of presets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      presetSelect.appendChild(option);
    }
    await renderList();
    newForm();
  })();
}

// ============================================================================
// 编辑器：外部编辑器命令模板 + 常用编辑器预设（AC10）
// ============================================================================

const EXTERNAL_EDITOR_PRESETS: ReadonlyArray<{ label: string; command: string }> = [
  { label: "VS Code", command: 'code -g "{file}:{line}"' },
  { label: "Sublime Text", command: 'subl "{file}:{line}"' },
  { label: "Notepad++", command: 'notepad++ "{file}"' },
  { label: "JetBrains IDEA", command: 'idea "{file}"' },
];

function renderEditor(content: HTMLElement, deps: SettingsDialogDeps): void {
  const { api } = deps;
  content.appendChild(el("h3", "dw-settings-subtitle", t("editor.title")));
  content.appendChild(el("p", "dw-modal-hint", t("editor.hint")));

  const presets = el("div", "dw-modal-actions");
  const commandInput = fieldInput("text", "");
  commandInput.placeholder = t("editor.command.placeholder");
  for (const preset of EXTERNAL_EDITOR_PRESETS) {
    const btn = el("button", "dw-btn dw-btn-small", preset.label);
    btn.addEventListener("click", () => {
      commandInput.value = preset.command;
    });
    presets.appendChild(btn);
  }
  content.appendChild(presets);
  content.appendChild(commandInput);
  const errorBox = el("div", "dw-form-error");
  content.appendChild(errorBox);

  void api.settings.get("externalEditor").then((value) => {
    const config = value as { command?: string } | null;
    if (config !== null && typeof config.command === "string") {
      commandInput.value = config.command;
    }
  });

  const actions = el("div", "dw-modal-actions");
  const saveBtn = el("button", "dw-btn dw-btn-primary", t("provider.save"));
  actions.appendChild(saveBtn);
  content.appendChild(actions);

  saveBtn.addEventListener("click", () => {
    void (async () => {
      const command = commandInput.value.trim();
      if (command !== "" && !command.includes("{file}")) {
        errorBox.textContent = t("editor.missingFile");
        return;
      }
      await api.settings.set("externalEditor", { command });
      errorBox.textContent = command === "" ? t("editor.cleared") : t("editor.saved");
    })().catch((error: unknown) => {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    });
  });
}

// ============================================================================
// 模式：创建/编辑/删除（系统提示 + 工具集 + 模型 + 上下文策略）
// ============================================================================

async function renderModes(content: HTMLElement, deps: SettingsDialogDeps): Promise<void> {
  const { api } = deps;
  content.appendChild(el("h3", "dw-settings-subtitle", t("mode.title")));
  // 迭代 14 / AC23：无账号社区分享方式——导出/导入 JSON
  content.appendChild(el("p", "dw-modal-hint", t("mode.share.hint")));
  const list = el("div", "dw-modal-list");
  content.appendChild(list);

  let modes: ModeDefinition[] = [];
  const providers: ProviderConfig[] = await api.providers.list();
  /** 社区行「已导入」状态刷新器（迭代 16）：renderList 重建本地列表后逐个调用。 */
  const communitySyncs: Array<() => void> = [];

  const form = el("div", "dw-form");
  const idInput = fieldInput("text", "");
  const nameInput = fieldInput("text", "");
  const descInput = fieldInput("text", "");
  const promptInput = el("textarea", "dw-textarea") as HTMLTextAreaElement;
  const toolChecks = new Map<AgentToolName, HTMLInputElement>();
  const toolsBox = el("div", "dw-form-checks");
  for (const tool of AGENT_TOOLS) {
    const checkbox = fieldInput("checkbox", "");
    toolChecks.set(tool, checkbox);
    const item = el("label");
    item.append(checkbox, document.createTextNode(tool));
    toolsBox.appendChild(item);
  }
  const providerSelect = el("select", "dw-select") as HTMLSelectElement;
  const policyChecks = new Map<ContextItemType, HTMLInputElement>();
  const policyBox = el("div", "dw-form-checks");
  for (const type of CONTEXT_TYPE_ORDER) {
    const checkbox = fieldInput("checkbox", "");
    policyChecks.set(type, checkbox);
    const item = el("label");
    item.append(checkbox, document.createTextNode(t(CONTEXT_TYPE_KEY[type])));
    policyBox.appendChild(item);
  }
  const errorBox = el("div", "dw-form-error");
  form.append(
    el("label", undefined, t("common.id")),
    idInput,
    el("label", undefined, t("mode.name")),
    nameInput,
    el("label", undefined, t("mode.description")),
    descInput,
    el("label", undefined, t("mode.systemPrompt")),
    promptInput,
    el("label", undefined, t("mode.tools")),
    toolsBox,
    el("label", undefined, t("mode.provider")),
    providerSelect,
    el("label", undefined, t("mode.contextPolicy")),
    policyBox,
    errorBox
  );
  content.appendChild(form);

  let editing: ModeDefinition | null = null;

  function fillProviderSelect(selected: string): void {
    providerSelect.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = t("mode.unbound");
    providerSelect.appendChild(none);
    for (const p of providers) {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = `${p.label} · ${p.model}`;
      option.selected = p.id === selected;
      providerSelect.appendChild(option);
    }
  }

  function fillForm(mode: ModeDefinition): void {
    editing = mode;
    idInput.value = mode.id;
    idInput.disabled = true;
    nameInput.value = mode.name;
    descInput.value = mode.description;
    promptInput.value = mode.systemPrompt;
    for (const [tool, checkbox] of toolChecks) checkbox.checked = mode.tools.includes(tool);
    fillProviderSelect(mode.providerId);
    for (const [type, checkbox] of policyChecks) checkbox.checked = mode.contextPolicy[type] === true;
    errorBox.textContent = mode.builtin ? t("mode.builtin.note") : "";
  }

  function newForm(): void {
    editing = null;
    idInput.value = `mode-${Date.now().toString(36)}`;
    idInput.disabled = false;
    nameInput.value = "";
    descInput.value = "";
    promptInput.value = "";
    for (const checkbox of toolChecks.values()) checkbox.checked = false;
    fillProviderSelect("");
    for (const checkbox of policyChecks.values()) checkbox.checked = false;
    errorBox.textContent = "";
  }

  async function renderList(): Promise<void> {
    // AC33：模式行内展示成功率统计（推荐透明性——用户能看到推荐依据的数据源）
    const [modeList, statsStored] = await Promise.all([api.modes.list(), api.settings.get("modes.stats")]);
    modes = modeList;
    const stats = Array.isArray(statsStored) ? statsStored : [];
    list.textContent = "";
    for (const mode of modes) {
      const entry = stats.find(
        (item): item is { modeId: string; runs: number; successes: number } =>
          typeof item === "object" &&
          item !== null &&
          (item as { modeId?: unknown }).modeId === mode.id &&
          typeof (item as { runs?: unknown }).runs === "number" &&
          (item as { runs: number }).runs > 0 &&
          typeof (item as { successes?: unknown }).successes === "number"
      );
      const statsText =
        entry !== undefined
          ? ` · ${t("mode.stats.rate", { rate: Math.round((entry.successes / entry.runs) * 100), successes: entry.successes, runs: entry.runs })}`
          : "";
      const row = el("div", "dw-modal-list-item");
      row.appendChild(
        el(
          "span",
          "dw-grow",
          `${mode.name}${mode.builtin ? t("mode.builtin.tag") : ""} · ${t("mode.tool.count", { n: mode.tools.length })}${statsText}`
        )
      );
      const exportBtn = el("button", "dw-btn dw-btn-small", t("mode.export"));
      exportBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void (async () => {
          const saved = await api.modes.export(mode.id);
          if (saved !== null) errorBox.textContent = t("mode.export.done", { path: saved });
        })().catch((error: unknown) => {
          errorBox.textContent = localizeError(error instanceof Error ? error.message : String(error));
        });
      });
      row.appendChild(exportBtn);
      const editBtn = el("button", "dw-btn dw-btn-small", t("provider.edit"));
      editBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        fillForm(mode);
      });
      row.appendChild(editBtn);
      if (!mode.builtin) {
        const delBtn = el("button", "dw-btn dw-btn-small dw-btn-danger", t("mode.delete"));
        delBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          void api.modes
            .delete(mode.id)
            .then(deps.onModesChanged)
            .then(() => renderList());
        });
        row.appendChild(delBtn);
      }
      row.addEventListener("click", () => fillForm(mode));
      list.appendChild(row);
    }
    for (const sync of communitySyncs) sync();
  }

  const actions = el("div", "dw-modal-actions");
  const importBtn = el("button", "dw-btn", t("mode.import"));
  const newBtn = el("button", "dw-btn", t("provider.new"));
  const saveBtn = el("button", "dw-btn dw-btn-primary", t("provider.save"));
  actions.append(importBtn, newBtn, saveBtn);
  content.appendChild(actions);

  importBtn.addEventListener("click", () => {
    void (async () => {
      errorBox.textContent = "";
      const imported = await api.modes.import();
      if (imported !== null) {
        deps.onModesChanged();
        await renderList();
        fillForm(imported); // 导入结果直接入表单：用户可立即检查/重绑模型
        errorBox.textContent = t("mode.import.done", { name: imported.name });
      }
    })().catch((error: unknown) => {
      errorBox.textContent = localizeError(error instanceof Error ? error.message : String(error));
    });
  });

  newBtn.addEventListener("click", newForm);
  saveBtn.addEventListener("click", () => {
    void (async () => {
      errorBox.textContent = "";
      const name = nameInput.value.trim();
      if (name === "" || promptInput.value.trim() === "") {
        errorBox.textContent = t("mode.required");
        return;
      }
      const now = new Date().toISOString();
      const contextPolicy: Partial<Record<ContextItemType, boolean>> = {};
      for (const [type, checkbox] of policyChecks) contextPolicy[type] = checkbox.checked;
      const mode: ModeDefinition = {
        id: idInput.value.trim(),
        name,
        description: descInput.value.trim(),
        systemPrompt: promptInput.value,
        tools: AGENT_TOOLS.filter((tool) => toolChecks.get(tool)?.checked === true),
        providerId: providerSelect.value,
        contextPolicy,
        builtin: editing?.builtin ?? false,
        createdAt: editing?.createdAt ?? now,
        updatedAt: now,
      };
      await api.modes.upsert(mode);
      deps.onModesChanged();
      await renderList();
      errorBox.textContent = t("mode.saved");
    })().catch((error: unknown) => {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    });
  });

  // ---- 社区模式（迭代 16 / AC25）：零账号分享——索引浏览 + 一键导入 ----
  content.appendChild(el("h3", "dw-settings-subtitle", t("mode.community.title")));
  content.appendChild(el("p", "dw-modal-hint", t("mode.community.hint")));
  const communityStatus = el("div", "dw-modal-hint", t("mode.community.loading"));
  const communityList = el("div", "dw-modal-list");
  content.append(communityStatus, communityList);
  void (async () => {
    const entries = await api.modes.communityList();
    communityStatus.textContent = entries.length === 0 ? t("mode.community.empty") : "";
    for (const entry of entries) {
      const row = el("div", "dw-modal-list-item");
      const label = el("span", "dw-grow", `${entry.name} · ${t("mode.community.by", { author: entry.author })}`);
      label.title = entry.description;
      row.appendChild(label);
      const importBtn = el("button", "dw-btn dw-btn-small", t("mode.community.import")) as HTMLButtonElement;
      const sync = (): void => {
        const imported = modes.some((mode) => mode.name === entry.name);
        importBtn.disabled = imported;
        importBtn.textContent = imported ? t("mode.community.imported") : t("mode.community.import");
      };
      communitySyncs.push(sync);
      sync();
      importBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void (async () => {
          const imported = await api.modes.communityImport(entry.file);
          deps.onModesChanged();
          await renderList();
          fillForm(imported); // 导入结果直接入表单：用户可立即检查/重绑模型
          errorBox.textContent = t("mode.import.done", { name: imported.name });
        })().catch((error: unknown) => {
          communityStatus.textContent = localizeError(error instanceof Error ? error.message : String(error));
        });
      });
      row.appendChild(importBtn);
      communityList.appendChild(row);
    }
  })().catch((error: unknown) => {
    communityStatus.textContent = localizeError(error instanceof Error ? error.message : String(error));
  });

  await renderList();
  newForm();
}

// ============================================================================
// MCP：外部工具服务器 CRUD + 状态徽标实时刷新（AC17）
// ============================================================================

/** 与 manager 侧 MCP_ID_PATTERN 一致：渲染端先校验，错误消息才能走 i18n。 */
const MCP_ID_PATTERN = /^[\w-]+$/;

const MCP_STATE_KEY: Record<McpServerState, StringMessageKey> = {
  connecting: "mcp.state.connecting",
  ready: "mcp.state.ready",
  error: "mcp.state.error",
  disabled: "mcp.state.disabled",
};

function renderMcp(content: HTMLElement, deps: SettingsDialogDeps, onMcpSink: (sink: () => void) => void): void {
  const { api } = deps;
  content.appendChild(el("h3", "dw-settings-subtitle", t("mcp.title")));
  content.appendChild(el("p", "dw-modal-hint", t("mcp.hint")));
  const list = el("div", "dw-modal-list");
  content.appendChild(list);
  /** 当前服务器视图缓存：社区行「已导入」状态判定复用（避免每行一次 IPC）。 */
  let views: McpServerView[] = [];
  /** 社区行「已导入」状态刷新器：renderList 重建本地列表后逐个调用。 */
  const communitySyncs: Array<() => void> = [];

  const form = el("div", "dw-form");
  const idInput = fieldInput("text", "");
  const nameInput = fieldInput("text", "");
  const commandInput = fieldInput("text", "");
  commandInput.placeholder = t("mcp.command.placeholder");
  const argsInput = fieldInput("text", "");
  argsInput.placeholder = t("mcp.args.placeholder");
  const envInput = el("textarea", "dw-textarea") as HTMLTextAreaElement;
  envInput.rows = 3;
  const enabledInput = fieldInput("checkbox", "");
  enabledInput.checked = true;
  const enabledLabel = el("label");
  enabledLabel.append(enabledInput, document.createTextNode(t("mcp.enabled")));
  const errorBox = el("div", "dw-form-error");
  form.append(
    el("label", undefined, t("common.id")),
    idInput,
    el("label", undefined, t("mcp.name")),
    nameInput,
    el("label", undefined, t("mcp.command")),
    commandInput,
    el("label", undefined, t("mcp.args")),
    argsInput,
    el("label", undefined, t("mcp.env")),
    envInput,
    enabledLabel,
    errorBox
  );
  content.appendChild(form);

  function fillForm(view: McpServerView): void {
    idInput.value = view.config.id;
    idInput.disabled = true;
    nameInput.value = view.config.name;
    commandInput.value = view.config.command;
    argsInput.value = view.config.args.join(" ");
    envInput.value = Object.entries(view.config.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    enabledInput.checked = view.config.enabled;
    errorBox.textContent = "";
  }

  function newForm(): void {
    idInput.value = `mcp-${Date.now().toString(36)}`;
    idInput.disabled = false;
    nameInput.value = "";
    commandInput.value = "";
    argsInput.value = "";
    envInput.value = "";
    enabledInput.checked = true;
    errorBox.textContent = "";
  }

  async function renderList(): Promise<void> {
    views = await api.mcp.list();
    list.textContent = "";
    for (const view of views) {
      const row = el("div", "dw-modal-list-item");
      const badge = el("span", `dw-mcp-state dw-mcp-state-${view.state}`, t(MCP_STATE_KEY[view.state]));
      if (view.state === "error" && view.errorCode !== undefined) badge.title = view.errorCode;
      const summary = el(
        "span",
        "dw-grow",
        `${view.config.name} · ${view.tools.length > 0 ? t("mcp.tool.count", { n: view.tools.length }) : t("mcp.tools.none")}`
      );
      row.append(badge, summary);
      const delBtn = el("button", "dw-btn dw-btn-small dw-btn-danger", t("mode.delete"));
      delBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void api.mcp.delete(view.config.id).then(() => {
          errorBox.textContent = t("mcp.deleted");
          return renderList();
        });
      });
      row.appendChild(delBtn);
      row.addEventListener("click", () => fillForm(view));
      list.appendChild(row);
    }
    for (const sync of communitySyncs) sync();
  }

  const actions = el("div", "dw-modal-actions");
  const newBtn = el("button", "dw-btn", t("provider.new"));
  const saveBtn = el("button", "dw-btn dw-btn-primary", t("provider.save"));
  actions.append(newBtn, saveBtn);
  content.appendChild(actions);

  newBtn.addEventListener("click", newForm);
  saveBtn.addEventListener("click", () => {
    void (async () => {
      errorBox.textContent = "";
      const id = idInput.value.trim();
      const name = nameInput.value.trim();
      const command = commandInput.value.trim();
      if (id === "" || name === "" || command === "") {
        errorBox.textContent = t("mcp.required");
        return;
      }
      if (!MCP_ID_PATTERN.test(id)) {
        errorBox.textContent = t("mcp.idPattern");
        return;
      }
      const env: Record<string, string> = {};
      const lines = envInput.value.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]?.trim() ?? "";
        if (line === "") continue;
        const sep = line.indexOf("=");
        if (sep <= 0) {
          errorBox.textContent = t("mcp.env.invalid", { n: i + 1 });
          return;
        }
        env[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
      }
      const config: McpServerConfig = {
        id,
        name,
        command,
        args: argsInput.value.split(/\s+/).filter((arg) => arg !== ""),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        enabled: enabledInput.checked,
      };
      await api.mcp.upsert(config);
      await renderList();
      errorBox.textContent = t("mcp.saved");
    })().catch((error: unknown) => {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    });
  });

  // ---- 社区 MCP 服务器（迭代 25 / AC34）：与社区模式同一索引仓库，mcpServers 段浏览 + 一键导入热启动 ----
  content.appendChild(el("h3", "dw-settings-subtitle", t("mcp.community.title")));
  content.appendChild(el("p", "dw-modal-hint", t("mcp.community.hint")));
  const communityStatus = el("div", "dw-modal-hint", t("mcp.community.loading"));
  const communityList = el("div", "dw-modal-list");
  content.append(communityStatus, communityList);
  void (async () => {
    const entries = await api.mcp.communityList();
    communityStatus.textContent = entries.length === 0 ? t("mcp.community.empty") : "";
    for (const entry of entries) {
      const row = el("div", "dw-modal-list-item");
      const toolsPreview = entry.tools.length > 0 ? ` · ${t("mcp.community.toolCount", { n: entry.tools.length })}` : "";
      const label = el("span", "dw-grow", `${entry.name} · ${t("mcp.community.by", { author: entry.author })}${toolsPreview}`);
      label.title = entry.description;
      row.appendChild(label);
      const importBtn = el("button", "dw-btn dw-btn-small", t("mcp.community.import")) as HTMLButtonElement;
      const sync = (): void => {
        // 导入保留负载 name：按显示名判重（与社区模式同规则）
        const imported = views.some((view) => view.config.name === entry.name);
        importBtn.disabled = imported;
        importBtn.textContent = imported ? t("mcp.community.imported") : t("mcp.community.import");
      };
      communitySyncs.push(sync);
      sync();
      importBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void (async () => {
          const imported = await api.mcp.communityImport(entry.file);
          await renderList();
          // 导入结果直接入表单：用户可立即检查/停用/改名
          const view = views.find((candidate) => candidate.config.id === imported.id);
          if (view !== undefined) fillForm(view);
          errorBox.textContent = t("mcp.community.importDone", { name: imported.name });
        })().catch((error: unknown) => {
          communityStatus.textContent = localizeError(error instanceof Error ? error.message : String(error));
        });
      });
      row.appendChild(importBtn);
      communityList.appendChild(row);
    }
  })().catch((error: unknown) => {
    communityStatus.textContent = localizeError(error instanceof Error ? error.message : String(error));
  });

  // 服务器状态推送（连接中→就绪/错误）实时刷新徽标；仅停留 MCP 分区期间挂接
  onMcpSink(() => {
    void renderList();
  });

  void renderList();
  newForm();
}
