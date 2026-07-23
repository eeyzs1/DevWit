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
  ModeDefinition,
  ProviderConfig,
  ProviderType,
  UpdateStatusInfo,
} from "@devwit/contracts";
import {
  LOCALES,
  LOCALE_LABEL,
  onDidChangeLocale,
  resolveSystemLocale,
  setLocale,
  t,
  type Locale,
} from "@devwit/i18n";

export type SettingsSection = "general" | "providers" | "editor" | "modes";

export interface SettingsDialogDeps {
  api: DevwitApi;
  /** providers 保存成功后回调（renderer 侧 reload + chat 选择器热更新）。 */
  onProvidersChanged: () => void;
  /** modes 保存/删除成功后回调。 */
  onModesChanged: () => void;
}

/** t() 的键类型（仅 string 文案；数组文案走 ta()）。 */
type StringMessageKey = Parameters<typeof t>[0];

const SECTION_NAV: ReadonlyArray<{ id: SettingsSection; key: StringMessageKey }> = [
  { id: "general", key: "settings.nav.general" },
  { id: "providers", key: "settings.nav.providers" },
  { id: "editor", key: "settings.nav.editor" },
  { id: "modes", key: "settings.nav.modes" },
];

const AGENT_TOOLS: AgentToolName[] = ["read", "write", "edit", "bash", "grep", "find", "ls"];

/** 上下文类型 → 词典键（与 chat-ui 的 context-panel 共用 ctx.* 文案）。 */
const CONTEXT_TYPE_KEY: Record<ContextItemType, `ctx.${ContextItemType}`> = {
  system_prompt: "ctx.system_prompt",
  tool_definitions: "ctx.tool_definitions",
  file_fragment: "ctx.file_fragment",
  git_status: "ctx.git_status",
  terminal_output: "ctx.terminal_output",
  selection: "ctx.selection",
  conversation_history: "ctx.conversation_history",
  custom: "ctx.custom",
};
const CONTEXT_TYPE_ORDER: readonly ContextItemType[] = [
  "system_prompt",
  "tool_definitions",
  "file_fragment",
  "git_status",
  "terminal_output",
  "selection",
  "conversation_history",
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
    switch (section) {
      case "general":
        renderGeneral(content, deps, (sink) => {
          updateSink = sink;
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

function renderGeneral(content: HTMLElement, deps: SettingsDialogDeps, onUpdateSink: (sink: (status: UpdateStatusInfo) => void) => void): void {
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

  form.append(label, select, hint, updateLabel, updateRow, updateHint);
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

  const form = el("div", "dw-form");
  const idInput = fieldInput("text", "");
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
  const secretInput = fieldInput("password", "");
  const maxTokensInput = fieldInput("number", "4096");
  const errorBox = el("div", "dw-form-error");
  form.append(
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
    el("label", undefined, t("provider.apiKey")),
    secretInput,
    el("label", undefined, t("provider.maxTokens")),
    maxTokensInput,
    errorBox
  );
  content.appendChild(form);

  function fillForm(config: ProviderConfig): void {
    idInput.value = config.id;
    idInput.disabled = true;
    typeSelect.value = config.type;
    labelInput.value = config.label;
    baseUrlInput.value = config.baseUrl;
    modelInput.value = config.model;
    secretInput.value = "";
    secretInput.placeholder = t("provider.secret.keep");
    maxTokensInput.value = String(config.maxTokens);
    errorBox.textContent = "";
  }
  function newForm(): void {
    idInput.value = `p-${Date.now().toString(36)}`;
    idInput.disabled = false;
    typeSelect.value = "anthropic";
    labelInput.value = "";
    baseUrlInput.value = "";
    // AR002：渲染进程不硬编码任何 LLM API 域名，由用户显式填写（官方或代理 endpoint）
    baseUrlInput.placeholder = t("provider.baseUrl.placeholder");
    modelInput.value = "";
    secretInput.value = "";
    secretInput.placeholder = t("provider.secret.new");
    maxTokensInput.value = "4096";
    errorBox.textContent = "";
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
  const newBtn = el("button", "dw-btn", t("provider.new"));
  const saveBtn = el("button", "dw-btn dw-btn-primary", t("provider.save"));
  actions.append(newBtn, saveBtn);
  content.appendChild(actions);

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
      const credentialRef = `cred-${id}`;
      if (secretInput.value !== "") {
        await api.credentials.set(credentialRef, typeSelect.value, secretInput.value);
      }
      const existing = providers.find((p) => p.id === id);
      if (existing === undefined && secretInput.value === "") {
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
      };
      await api.providers.upsert(config);
      deps.onProvidersChanged();
      await renderList();
      errorBox.textContent = t("provider.saved");
    })().catch((error: unknown) => {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    });
  });

  void renderList();
  newForm();
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
  const list = el("div", "dw-modal-list");
  content.appendChild(list);

  let modes: ModeDefinition[] = [];
  const providers: ProviderConfig[] = await api.providers.list();

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
    modes = await api.modes.list();
    list.textContent = "";
    for (const mode of modes) {
      const row = el("div", "dw-modal-list-item");
      row.appendChild(
        el(
          "span",
          "dw-grow",
          `${mode.name}${mode.builtin ? t("mode.builtin.tag") : ""} · ${t("mode.tool.count", { n: mode.tools.length })}`
        )
      );
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

  await renderList();
  newForm();
}
