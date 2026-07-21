/**
 * DevWit 渲染进程（WU012/WU013 集成）。
 * 布局：侧栏文件树 | 自研 Canvas 编辑器（diff 覆盖层） | 对话/上下文面板。
 * 只允许经 window.devwit（preload 白名单）访问主进程能力（AR001/AR004）。
 */
import type {
  AgentToolName,
  ContextItemType,
  DevwitApi,
  ModeDefinition,
  ProviderConfig,
  ProviderType,
} from "@devwit/contracts";
import { TextDocument } from "@devwit/editor-core";
import { EditorView, normalizeSelection } from "@devwit/editor-render";
import {
  ChatController,
  ContextPanelController,
  DiffController,
  extractEditProposal,
  mountChatPanel,
  mountContextPanel,
  mountDiffView,
} from "@devwit/chat-ui";
import "./app.css";

declare global {
  interface Window {
    devwit?: DevwitApi;
  }
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

const AGENT_TOOLS: AgentToolName[] = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const CONTEXT_TYPES: Array<{ type: ContextItemType; label: string }> = [
  { type: "system_prompt", label: "系统提示" },
  { type: "tool_definitions", label: "工具定义" },
  { type: "file_fragment", label: "文件片段" },
  { type: "git_status", label: "git 状态" },
  { type: "terminal_output", label: "终端输出" },
  { type: "selection", label: "当前选区" },
  { type: "conversation_history", label: "会话历史" },
  { type: "custom", label: "自定义" },
];

/** 编辑器会话：一个打开的文件 = 一个 TextDocument。 */
interface OpenFile {
  path: string;
  doc: TextDocument;
}

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

function bootstrap(api: DevwitApi): void {
  const app = document.getElementById("app");
  if (app === null) return;
  app.textContent = "";

  // ---- 全局状态 ----
  let modes: ModeDefinition[] = [];
  let providers: ProviderConfig[] = [];
  let openFile: OpenFile | null = null;
  let diffOverlay: HTMLElement | null = null;

  // ---- 布局骨架 ----
  const ide = el("div", "dw-ide");
  const header = el("div", "dw-header");
  const sidebar = el("div", "dw-sidebar");
  const editorArea = el("div", "dw-editor-area");
  const side = el("div", "dw-side");
  const statusbar = el("div", "dw-statusbar");
  ide.append(header, sidebar, editorArea, side, statusbar);
  app.appendChild(ide);

  // ---- 顶栏 ----
  header.appendChild(el("span", "dw-title", "DevWit"));
  const openBtn = el("button", "dw-btn", "打开文件夹");
  const saveBtn = el("button", "dw-btn", "保存 (Ctrl+S)");
  const activeFileLabel = el("span", "dw-active-file", "未打开文件");
  const spacer = el("span", "dw-spacer");
  const modesBtn = el("button", "dw-btn", "模式管理");
  const settingsBtn = el("button", "dw-btn", "模型设置");
  header.append(openBtn, saveBtn, activeFileLabel, spacer, modesBtn, settingsBtn);

  // ---- 状态栏 ----
  const statusWorkspace = el("span", undefined, "未打开工作区");
  const statusDirty = el("span");
  statusbar.append(statusWorkspace, statusDirty);

  // ---- 编辑器 ----
  const canvas = el("canvas", "dw-editor-canvas");
  editorArea.appendChild(canvas);
  const welcomeDoc = TextDocument.fromString(
    "// 欢迎使用 DevWit\n// 打开文件夹后点击左侧文件开始编辑；右侧对话面板可请求 AI 修改代码。\n"
  );
  const editor = new EditorView(canvas, welcomeDoc);
  const setActiveDoc = (file: OpenFile | null): void => {
    openFile = file;
    if (file !== null) {
      editor.setDocument(file.doc);
      activeFileLabel.textContent = file.path;
    }
    refreshDirty();
  };
  const refreshDirty = (): void => {
    statusDirty.textContent = openFile !== null && openFile.doc.isDirty ? "● 未保存" : "";
  };
  window.addEventListener("resize", () => editor.resize());

  async function saveActiveFile(): Promise<void> {
    if (openFile === null) return;
    await api.workspace.write(openFile.path, openFile.doc.getText());
    openFile.doc.markSaved();
    refreshDirty();
  }
  saveBtn.addEventListener("click", () => void saveActiveFile());
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveActiveFile();
    }
  });

  async function openFileByPath(filePath: string): Promise<void> {
    const content = await api.workspace.read(filePath);
    const doc = TextDocument.fromString(content);
    doc.onDidChange(refreshDirty);
    setActiveDoc({ path: filePath, doc });
    sidebar.querySelectorAll(".dw-tree-node").forEach((node) => {
      node.classList.toggle("dw-tree-active", (node as HTMLElement).dataset["path"] === filePath);
    });
    editor.focus();
  }

  // ---- 文件树 ----
  function renderTree(node: TreeNode, container: HTMLElement): void {
    const li = el("li");
    const label = el("div", "dw-tree-node", node.type === "dir" ? `▸ ${node.name}` : node.name);
    label.dataset["path"] = node.path;
    label.title = node.path;
    if (node.type === "file") {
      label.addEventListener("click", () => void openFileByPath(node.path));
    }
    li.appendChild(label);
    if (node.type === "dir" && node.children !== undefined && node.children.length > 0) {
      const ul = el("ul");
      for (const child of node.children) renderTree(child, ul);
      li.appendChild(ul);
    }
    container.appendChild(li);
  }

  async function openWorkspace(): Promise<void> {
    const root = await api.workspace.openDialog();
    if (root === null) return;
    chatController.setWorkspaceRoot(root);
    statusWorkspace.textContent = root;
    sidebar.textContent = "";
    const tree = (await api.workspace.tree(root)) as TreeNode;
    const ul = el("ul", "dw-tree");
    for (const child of tree.children ?? []) renderTree(child, ul);
    sidebar.appendChild(ul);
  }
  openBtn.addEventListener("click", () => void openWorkspace());
  sidebar.appendChild(el("div", "dw-sidebar-empty", "点击「打开文件夹」选择项目目录"));

  // ---- 右侧栏：对话 / 上下文 两个页签 ----
  const tabs = el("div", "dw-tabs");
  const chatTab = el("div", "dw-tab dw-tab-active", "对话");
  const contextTab = el("div", "dw-tab", "上下文");
  tabs.append(chatTab, contextTab);
  const sideBody = el("div", "dw-side-body");
  side.append(tabs, sideBody);

  const contextController = new ContextPanelController(api);
  const chatController = new ChatController({
    api,
    sessionId: `session-${Date.now()}`,
    workspaceRoot: "",
    modeId: "chat",
  });

  // 对话面板：发送时采集活动文件 + 主选区作为会话上下文快照
  const chatPanel = mountChatPanel(sideBody, {
    controller: chatController,
    listModes: () => modes,
    listProviders: () => providers,
    collectContext: () => {
      const snapshot: { activeFile?: string; selection?: { text: string; startLine: number; endLine: number } } = {};
      if (openFile !== null) {
        snapshot.activeFile = openFile.path;
        const primary = editor.getSelections().at(-1);
        if (primary !== undefined) {
          const norm = normalizeSelection(primary);
          const startOffset = openFile.doc.offsetAt(norm.start);
          const endOffset = openFile.doc.offsetAt(norm.end);
          if (endOffset > startOffset) {
            snapshot.selection = {
              text: openFile.doc.getTextInRange(startOffset, endOffset),
              startLine: norm.start.line + 1,
              endLine: norm.end.line + 1,
            };
          }
        }
      }
      return snapshot;
    },
    onProposalReview: (assistantText) => reviewProposal(assistantText),
  });
  chatPanel.root.style.display = "flex";

  const contextPanel = mountContextPanel(sideBody, contextController);
  contextPanel.root.style.display = "none";

  chatTab.addEventListener("click", () => {
    chatTab.classList.add("dw-tab-active");
    contextTab.classList.remove("dw-tab-active");
    chatPanel.root.style.display = "flex";
    contextPanel.root.style.display = "none";
  });
  contextTab.addEventListener("click", () => {
    contextTab.classList.add("dw-tab-active");
    chatTab.classList.remove("dw-tab-active");
    contextPanel.root.style.display = "flex";
    chatPanel.root.style.display = "none";
    void contextController.refresh();
  });

  // agent 事件流驱动一次后刷新上下文 manifest 展示
  api.agent.onEvent((event) => {
    if (event.type === "done" || event.type === "error") void contextController.refresh();
  });

  // ---- WU013：diff 审查（对话提案 → 编辑器内 diff → 逐块接受/拒绝）----
  function reviewProposal(assistantText: string): void {
    if (openFile === null) {
      activeFileLabel.textContent = "请先打开一个文件再审查修改";
      return;
    }
    const proposal = extractEditProposal(assistantText);
    if (proposal === null) {
      activeFileLabel.textContent = `${openFile.path}（回复中未找到唯一代码块，无法生成 diff）`;
      return;
    }
    if (diffOverlay !== null) return; // 已有审查进行中
    const controller = new DiffController(openFile.doc.getText(), proposal.code);
    if (!controller.hasChanges) {
      activeFileLabel.textContent = `${openFile.path}（提案与当前内容一致）`;
      return;
    }
    diffOverlay = el("div", "dw-diff-overlay");
    editorArea.appendChild(diffOverlay);
    const target = openFile;
    mountDiffView(diffOverlay, {
      controller,
      title: `变更审查 — ${target.path}`,
      onApply: (result) => {
        target.doc.applyEdit({ offset: 0, length: target.doc.length, text: result });
        closeDiff();
        editor.focus();
      },
      onClose: () => closeDiff(),
    });
  }
  function closeDiff(): void {
    diffOverlay?.remove();
    diffOverlay = null;
  }

  // ---- 数据加载与热更新 ----
  async function reloadModes(): Promise<void> {
    modes = await api.modes.list();
    chatPanel.refreshSelectors();
  }
  async function reloadProviders(): Promise<void> {
    providers = await api.providers.list();
    chatPanel.refreshSelectors();
  }
  void reloadModes();
  void reloadProviders();
  api.modes.onChanged(() => void reloadModes());
  api.settings.onChanged((key) => {
    if (key === "providers") void reloadProviders();
  });

  // ---- 模型设置对话框（AC5）----
  settingsBtn.addEventListener("click", () => openProviderDialog(api, providers, () => void reloadProviders()));
  // ---- 模式管理对话框（AC6）----
  modesBtn.addEventListener("click", () =>
    openModeDialog(api, modes, providers, () => void reloadModes())
  );
}

// ============================================================================
// 模型设置对话框：providers CRUD + 凭证加密写入（明文永不回显）
// ============================================================================

function openProviderDialog(api: DevwitApi, providers: ProviderConfig[], onSaved: () => void): void {
  const mask = el("div", "dw-modal-mask");
  const modal = el("div", "dw-modal");
  mask.appendChild(modal);
  modal.appendChild(el("h2", undefined, "模型设置（Anthropic / OpenAI 兼容）"));
  const list = el("div", "dw-modal-list");
  modal.appendChild(list);

  const form = el("div", "dw-form");
  const idInput = input("text", "");
  const typeSelect = select(["anthropic", "openai"]);
  const labelInput = input("text", "");
  const baseUrlInput = input("text", "");
  const modelInput = input("text", "");
  const secretInput = input("password", "");
  const maxTokensInput = input("number", "4096");
  const errorBox = el("div", "dw-form-error");
  form.append(
    el("label", undefined, "ID"),
    idInput,
    el("label", undefined, "类型"),
    typeSelect,
    el("label", undefined, "显示名"),
    labelInput,
    el("label", undefined, "Base URL"),
    baseUrlInput,
    el("label", undefined, "模型"),
    modelInput,
    el("label", undefined, "API Key"),
    secretInput,
    el("label", undefined, "最大 tokens"),
    maxTokensInput,
    errorBox
  );
  modal.appendChild(form);

  function fillForm(config: ProviderConfig): void {
    idInput.value = config.id;
    idInput.disabled = true;
    typeSelect.value = config.type;
    labelInput.value = config.label;
    baseUrlInput.value = config.baseUrl;
    modelInput.value = config.model;
    secretInput.value = "";
    secretInput.placeholder = "留空 = 保留已存密钥";
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
    baseUrlInput.placeholder = "https://<你的 API endpoint>/v1";
    modelInput.value = "";
    secretInput.value = "";
    secretInput.placeholder = "首次保存必填，加密存储";
    maxTokensInput.value = "4096";
    errorBox.textContent = "";
  }
  async function renderList(): Promise<void> {
    const fresh = await api.providers.list();
    providers.length = 0;
    providers.push(...fresh);
    list.textContent = "";
    for (const config of fresh) {
      const row = el("div", "dw-modal-list-item");
      row.appendChild(el("span", "dw-grow", `${config.label} · ${config.type} · ${config.model}`));
      const editBtn = el("button", "dw-btn dw-btn-small", "编辑");
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
  const newBtn = el("button", "dw-btn", "新建");
  const saveProviderBtn = el("button", "dw-btn dw-btn-primary", "保存");
  const closeBtn = el("button", "dw-btn", "关闭");
  actions.append(newBtn, saveProviderBtn, closeBtn);
  modal.appendChild(actions);

  newBtn.addEventListener("click", newForm);
  closeBtn.addEventListener("click", () => mask.remove());
  saveProviderBtn.addEventListener("click", () => {
    void (async () => {
      errorBox.textContent = "";
      const id = idInput.value.trim();
      const baseUrl = baseUrlInput.value.trim();
      const model = modelInput.value.trim();
      if (id === "" || baseUrl === "" || model === "") {
        errorBox.textContent = "ID / Base URL / 模型 必填";
        return;
      }
      const credentialRef = `cred-${id}`;
      if (secretInput.value !== "") {
        await api.credentials.set(credentialRef, typeSelect.value, secretInput.value);
      }
      const existing = providers.find((p) => p.id === id);
      if (existing === undefined && secretInput.value === "") {
        errorBox.textContent = "新建 provider 必须填写 API Key";
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
      onSaved();
      await renderList();
      errorBox.textContent = "已保存（热生效，无需重启）";
    })().catch((error: unknown) => {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    });
  });

  void renderList();
  newForm();
  document.body.appendChild(mask);
}

// ============================================================================
// 模式管理对话框：创建/编辑/删除模式（系统提示 + 工具集 + 模型 + 上下文策略）
// ============================================================================

function openModeDialog(
  api: DevwitApi,
  modes: ModeDefinition[],
  providers: ProviderConfig[],
  onSaved: () => void
): void {
  const mask = el("div", "dw-modal-mask");
  const modal = el("div", "dw-modal");
  mask.appendChild(modal);
  modal.appendChild(el("h2", undefined, "模式管理（修改热生效，下次请求即用）"));
  const list = el("div", "dw-modal-list");
  modal.appendChild(list);

  const form = el("div", "dw-form");
  const idInput = input("text", "");
  const nameInput = input("text", "");
  const descInput = input("text", "");
  const promptInput = el("textarea", "dw-textarea") as HTMLTextAreaElement;
  const toolChecks = new Map<AgentToolName, HTMLInputElement>();
  const toolsBox = el("div", "dw-form-checks");
  for (const tool of AGENT_TOOLS) {
    const checkbox = input("checkbox", "") as HTMLInputElement;
    toolChecks.set(tool, checkbox);
    const item = el("label");
    item.append(checkbox, document.createTextNode(tool));
    toolsBox.appendChild(item);
  }
  const providerSelect = el("select", "dw-select") as HTMLSelectElement;
  const policyChecks = new Map<ContextItemType, HTMLInputElement>();
  const policyBox = el("div", "dw-form-checks");
  for (const { type, label } of CONTEXT_TYPES) {
    const checkbox = input("checkbox", "") as HTMLInputElement;
    policyChecks.set(type, checkbox);
    const item = el("label");
    item.append(checkbox, document.createTextNode(label));
    policyBox.appendChild(item);
  }
  const errorBox = el("div", "dw-form-error");
  form.append(
    el("label", undefined, "ID"),
    idInput,
    el("label", undefined, "名称"),
    nameInput,
    el("label", undefined, "描述"),
    descInput,
    el("label", undefined, "系统提示"),
    promptInput,
    el("label", undefined, "工具集"),
    toolsBox,
    el("label", undefined, "绑定模型"),
    providerSelect,
    el("label", undefined, "上下文策略"),
    policyBox,
    errorBox
  );
  modal.appendChild(form);

  let editing: ModeDefinition | null = null;

  function fillProviderSelect(selected: string): void {
    providerSelect.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "（未绑定）";
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
    errorBox.textContent = mode.builtin ? "内置模式：可编辑，不可删除" : "";
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
    const fresh = await api.modes.list();
    modes.length = 0;
    modes.push(...fresh);
    list.textContent = "";
    for (const mode of fresh) {
      const row = el("div", "dw-modal-list-item");
      row.appendChild(
        el("span", "dw-grow", `${mode.name}${mode.builtin ? "（内置）" : ""} · 工具 ${mode.tools.length} 个`)
      );
      const editBtn = el("button", "dw-btn dw-btn-small", "编辑");
      editBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        fillForm(mode);
      });
      row.appendChild(editBtn);
      if (!mode.builtin) {
        const delBtn = el("button", "dw-btn dw-btn-small dw-btn-danger", "删除");
        delBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          void api.modes
            .delete(mode.id)
            .then(onSaved)
            .then(() => renderList());
        });
        row.appendChild(delBtn);
      }
      row.addEventListener("click", () => fillForm(mode));
      list.appendChild(row);
    }
  }

  const actions = el("div", "dw-modal-actions");
  const newBtn = el("button", "dw-btn", "新建");
  const saveBtn = el("button", "dw-btn dw-btn-primary", "保存");
  const closeBtn = el("button", "dw-btn", "关闭");
  actions.append(newBtn, saveBtn, closeBtn);
  modal.appendChild(actions);

  newBtn.addEventListener("click", newForm);
  closeBtn.addEventListener("click", () => mask.remove());
  saveBtn.addEventListener("click", () => {
    void (async () => {
      errorBox.textContent = "";
      const name = nameInput.value.trim();
      if (name === "" || promptInput.value.trim() === "") {
        errorBox.textContent = "名称与系统提示必填";
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
      onSaved();
      await renderList();
      errorBox.textContent = "已保存（热生效）";
    })().catch((error: unknown) => {
      errorBox.textContent = error instanceof Error ? error.message : String(error);
    });
  });

  void renderList();
  newForm();
  document.body.appendChild(mask);
}

function input(type: string, value: string): HTMLInputElement {
  const node = document.createElement("input");
  node.type = type;
  node.value = value;
  node.className = type === "checkbox" ? "" : "dw-input";
  return node;
}

function select(options: string[]): HTMLSelectElement {
  const node = document.createElement("select");
  node.className = "dw-select";
  for (const value of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    node.appendChild(option);
  }
  return node;
}

window.addEventListener("DOMContentLoaded", () => {
  const app = document.getElementById("app");
  if (app === null) return;
  const api = window.devwit;
  if (api === undefined) {
    app.textContent = "preload 未就绪：window.devwit 不存在";
    return;
  }
  bootstrap(api);
});
