/**
 * DevWit 渲染进程（WU012/WU013 集成 + 迭代 3 / AC12 国际化）。
 * 布局：侧栏文件树 | 自研 Canvas 编辑器（diff 覆盖层） | 对话/上下文面板。
 * 只允许经 window.devwit（preload 白名单）访问主进程能力（AR001/AR004）。
 * 全部界面文案经 @devwit/i18n 词典渲染；启动时从 settings "ui.locale" 恢复语言，
 * 订阅 onDidChangeLocale 全量重写静态文案与动态列表（语言热生效）。
 */
import type { DevwitApi, ModeDefinition, ProviderConfig, UpdateStatusInfo } from "@devwit/contracts";
import { displayModeName, localizeError, onDidChangeLocale, resolveSystemLocale, setLocale, t, ta, type Locale } from "@devwit/i18n";
import { TextDocument } from "@devwit/editor-core";
import { EditorView, normalizeSelection } from "@devwit/editor-render";
import {
  ChatController,
  ContextPanelController,
  DiffController,
  TaskCenter,
  extractEditProposal,
  mountActivityStream,
  mountChatPanel,
  mountContextPanel,
  mountDiffView,
  type TaskInfo,
} from "@devwit/chat-ui";
import { openSettingsDialog, type SettingsDialogDeps } from "./settings-dialog.js";
import { openEditorSetupDialog } from "./editor-setup-dialog.js";
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

/** 任务状态 → 词典键（类型安全映射，模板串键无法通过 MessageKey 检查）。 */
const TASK_STATUS_KEY = {
  running: "task.status.running",
  waiting_auth: "task.status.waiting_auth",
  done: "task.status.done",
  failed: "task.status.failed",
  interrupted: "task.status.interrupted",
} as const;

/** 会话持久化快照（迭代 6 / AC15）：存于 settings "session.state"，重启后恢复现场。 */
interface SessionStateSnapshot {
  chatSessionId: string;
  tasks: TaskInfo[];
  activeTaskId: string | null;
  taskCounter: number;
  form: "chat" | "console";
  workspaceRoot: string;
}

/** 从 settings 读取的值做形状校验（损坏/旧版本数据返回 null 按无历史处理）。 */
function parseSessionSnapshot(raw: unknown): SessionStateSnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate["chatSessionId"] !== "string" || !Array.isArray(candidate["tasks"])) return null;
  return {
    chatSessionId: candidate["chatSessionId"],
    tasks: candidate["tasks"] as TaskInfo[],
    activeTaskId: typeof candidate["activeTaskId"] === "string" ? candidate["activeTaskId"] : null,
    taskCounter: typeof candidate["taskCounter"] === "number" ? candidate["taskCounter"] : 0,
    form: candidate["form"] === "console" ? "console" : "chat",
    workspaceRoot: typeof candidate["workspaceRoot"] === "string" ? candidate["workspaceRoot"] : "",
  };
}

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

async function bootstrap(api: DevwitApi): Promise<void> {
  const app = document.getElementById("app");
  if (app === null) return;
  app.textContent = "";

  // ---- 全局状态 ----
  let modes: ModeDefinition[] = [];
  let providers: ProviderConfig[] = [];
  let openFile: OpenFile | null = null;
  let diffOverlay: HTMLElement | null = null;
  let workspaceRoot = "";
  /** 主界面形态（AC8）：chat = 对话形态；console = 指挥台形态。两形态 DOM 各自保持。 */
  let form: "chat" | "console" = "chat";
  /** AC15：上次退出的会话快照（无/损坏时为 null，按全新会话处理）。 */
  const savedSession = parseSessionSnapshot(await api.settings.get("session.state"));

  // ---- 布局骨架：header / main（两种形态之一）/ statusbar ----
  const header = el("div", "dw-header");
  const main = el("div", "dw-main");
  const statusbar = el("div", "dw-statusbar");
  app.append(header, main, statusbar);

  // 对话形态（原 IDE 布局：侧栏文件树 | 编辑器 | 对话/上下文面板）
  const ide = el("div", "dw-ide");
  const sidebar = el("div", "dw-sidebar");
  const editorArea = el("div", "dw-editor-area");
  const side = el("div", "dw-side");
  ide.append(sidebar, editorArea, side);
  main.appendChild(ide);

  // 指挥台形态（AC9：任务列表 | Agent 活动流 | 工作区视图）
  const consoleRoot = el("div", "dw-console");
  consoleRoot.style.display = "none";
  const taskCol = el("div", "dw-console-tasks");
  const activityCol = el("div", "dw-console-activity");
  const workspaceCol = el("div", "dw-console-workspace");
  consoleRoot.append(taskCol, activityCol, workspaceCol);
  main.appendChild(consoleRoot);

  // ---- 顶栏 ----
  header.appendChild(el("span", "dw-title", "DevWit"));
  const formBtn = el("button", "dw-btn dw-btn-primary", t("chrome.form.console"));
  const openBtn = el("button", "dw-btn", t("chrome.openFolder"));
  const saveBtn = el("button", "dw-btn", t("chrome.save"));
  const externalBtn = el("button", "dw-btn", t("chrome.external"));
  const activeFileLabel = el("span", "dw-active-file", t("chrome.noFile"));
  const spacer = el("span", "dw-spacer");
  const settingsBtn = el("button", "dw-btn", t("chrome.settings"));
  header.append(formBtn, openBtn, saveBtn, externalBtn, activeFileLabel, spacer, settingsBtn);

  // ---- 状态栏 ----
  const statusWorkspace = el("span", undefined, t("status.noWorkspace"));
  const statusDirty = el("span");
  const statusMessage = el("span", "dw-status-message");
  // 更新提示区（AC16）：ready 状态常驻「重启更新」按钮，其余状态走瞬态提示
  const updateBox = el("span", "dw-update");
  statusbar.append(statusWorkspace, statusDirty, statusMessage, updateBox);
  // 瞬态提示只进状态栏：活动文件标签始终显示当前文件，不被临时文案覆盖
  function showStatus(message: string): void {
    statusMessage.textContent = message;
  }

  // ---- 自动更新（AC16）：启动静默检查，发现新版本才提示 ----
  let lastUpdateStatus: UpdateStatusInfo | null = null;
  function renderUpdateBox(): void {
    updateBox.textContent = "";
    if (lastUpdateStatus?.state !== "ready") return;
    updateBox.appendChild(el("span", "dw-update-text", t("update.ready", { version: lastUpdateStatus.version })));
    const restartBtn = el("button", "dw-btn dw-btn-small dw-btn-primary", t("update.restart"));
    restartBtn.addEventListener("click", () => api.update.install());
    updateBox.appendChild(restartBtn);
  }
  api.update.onStatus((status) => {
    lastUpdateStatus = status;
    if (status.state === "available") {
      showStatus(t("update.available", { version: status.version }));
    } else if (status.state === "downloading") {
      showStatus(t("update.downloading", { percent: status.percent }));
    } else if (status.state === "ready") {
      showStatus(t("update.ready", { version: status.version }));
    }
    // checking/none/error/disabled：静默检查不打扰（手动检查结果在设置页内联展示）
    renderUpdateBox();
  });

  // ---- 编辑器 ----
  const canvas = el("canvas", "dw-editor-canvas");
  editorArea.appendChild(canvas);
  const welcomeDoc = TextDocument.fromString(t("editor.welcome"));
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
    statusDirty.textContent = openFile !== null && openFile.doc.isDirty ? t("status.unsaved") : "";
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

  // ---- 统一设置页（AC12）：通用 / 模型 / 编辑器 / 模式 ----
  const settingsDeps: SettingsDialogDeps = {
    api,
    onProvidersChanged: () => void reloadProviders(),
    onModesChanged: () => void reloadModes(),
  };

  // ---- 外部编辑器（AC10 + 迭代 4：未配置弹引导小页，错误文案本地化）----
  /** 主进程错误码 → 本地化文案；模式名经 modes 列表解析为当前语言显示名。 */
  function toLocalError(raw: string): string {
    return localizeError(raw, { resolveModeName });
  }
  function resolveModeName(modeId: string): string {
    const mode = modes.find((candidate) => candidate.id === modeId);
    return mode !== undefined ? displayModeName(mode) : modeId;
  }

  async function isExternalEditorConfigured(): Promise<boolean> {
    const config = (await api.settings.get("externalEditor")) as { command?: string } | null;
    return typeof config?.command === "string" && config.command.trim() !== "";
  }

  async function openExternal(filePath: string, line = 1, promptOnError = true): Promise<void> {
    try {
      await api.externalEditor.open(filePath, line);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes("DW_EXTERNAL_EDITOR_NOT_CONFIGURED")) {
        // 未配置：弹引导小页（引导优于报错），保存后立即重试打开
        openEditorSetupDialog({ api, onSaved: () => void openExternal(filePath, line, false) });
        return;
      }
      showStatus(toLocalError(raw));
      if (promptOnError && raw.includes("DW_EXTERNAL_EDITOR_")) {
        // 模板非法 / 启动失败：同一小页修正（重试不再循环弹窗）
        openEditorSetupDialog({ api, onSaved: () => void openExternal(filePath, line, false) });
      }
    }
  }
  externalBtn.addEventListener("click", () => {
    void (async () => {
      // 未配置时无论是否有打开文件都先给引导（用户反馈：点了无反应）；
      // 有打开文件时传 onSaved——「保存并打开」保存模板后直接打开当前文件
      if (!(await isExternalEditorConfigured())) {
        if (openFile === null) {
          openEditorSetupDialog({ api });
          return;
        }
        const pendingFile = openFile.path;
        const primary = editor.getSelections().at(-1);
        const pendingLine = primary !== undefined ? normalizeSelection(primary).start.line + 1 : 1;
        openEditorSetupDialog({ api, onSaved: () => void openExternal(pendingFile, pendingLine, false) });
        return;
      }
      if (openFile === null) {
        showStatus(t("status.openFileFirst"));
        return;
      }
      const primary = editor.getSelections().at(-1);
      const line = primary !== undefined ? normalizeSelection(primary).start.line + 1 : 1;
      await openExternal(openFile.path, line);
    })();
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

  // ---- 首次使用引导（AC11）：未打开工作区时主区显示三步引导 ----
  const onboarding = el("div", "dw-onboarding");
  function buildOnboarding(): void {
    onboarding.textContent = "";
    const card = el("div", "dw-onboarding-card");
    card.appendChild(el("h2", undefined, t("onboarding.title")));
    card.appendChild(el("p", "dw-onboarding-sub", t("onboarding.sub")));
    const steps = el("ol", "dw-onboarding-steps");

    const step1 = el("li");
    const step1Btn = el("button", "dw-btn", t("onboarding.step1"));
    step1Btn.addEventListener("click", () => openSettingsDialog(settingsDeps, "providers"));
    step1.append(step1Btn, el("span", "dw-onboarding-hint", t("onboarding.step1.hint")));

    const step2 = el("li");
    const step2Btn = el("button", "dw-btn", t("onboarding.step2"));
    step2Btn.addEventListener("click", () => void openWorkspace());
    step2.append(step2Btn, el("span", "dw-onboarding-hint", t("onboarding.step2.hint")));

    const step3 = el("li");
    step3.appendChild(el("span", "dw-onboarding-hint", t("onboarding.step3.hint")));
    const examples = el("div", "dw-onboarding-examples");
    for (const example of ta("onboarding.examples")) {
      const chip = el("button", "dw-onboarding-chip", example);
      chip.addEventListener("click", () => {
        switchForm("console");
        newTaskInput.value = example;
        newTaskInput.focus();
      });
      examples.appendChild(chip);
    }
    step3.appendChild(examples);

    steps.append(step1, step2, step3);
    card.appendChild(steps);
    onboarding.appendChild(card);
  }
  function refreshOnboarding(): void {
    onboarding.style.display = workspaceRoot === "" ? "flex" : "none";
  }
  buildOnboarding();
  editorArea.appendChild(onboarding);
  refreshOnboarding();

  // ---- 文件树 ----
  function renderTree(node: TreeNode, container: HTMLElement): void {
    const li = el("li");
    const label = el("div", "dw-tree-node", node.type === "dir" ? `▸ ${node.name}` : node.name);
    label.dataset["path"] = node.path;
    label.title = node.path;
    if (node.type === "file") {
      label.addEventListener("click", () => void openFileByPath(node.path));
      const externalLink = el("button", "dw-tree-external", "↗");
      externalLink.title = t("tree.external");
      externalLink.addEventListener("click", (event) => {
        event.stopPropagation();
        void openExternal(node.path);
      });
      label.appendChild(externalLink);
    }
    li.appendChild(label);
    if (node.type === "dir" && node.children !== undefined && node.children.length > 0) {
      const ul = el("ul");
      for (const child of node.children) renderTree(child, ul);
      li.appendChild(ul);
    }
    container.appendChild(li);
  }

  /** 进入工作区：设置根目录 + 构建文件树（打开对话框与 AC15 启动恢复共用）。 */
  async function enterWorkspace(root: string): Promise<void> {
    workspaceRoot = root;
    chatController.setWorkspaceRoot(root);
    taskCenter.setWorkspaceRoot(root);
    refreshOnboarding();
    statusWorkspace.textContent = root;
    sidebar.textContent = "";
    const tree = (await api.workspace.tree(root)) as TreeNode;
    const ul = el("ul", "dw-tree");
    for (const child of tree.children ?? []) renderTree(child, ul);
    sidebar.appendChild(ul);
  }

  async function openWorkspace(): Promise<void> {
    const root = await api.workspace.openDialog();
    if (root === null) return;
    await enterWorkspace(root);
    schedulePersist();
  }
  openBtn.addEventListener("click", () => void openWorkspace());
  sidebar.appendChild(el("div", "dw-sidebar-empty", t("sidebar.empty")));

  // ---- 右侧栏：对话 / 上下文 两个页签 ----
  const tabs = el("div", "dw-tabs");
  const chatTab = el("div", "dw-tab dw-tab-active", t("tab.chat"));
  const contextTab = el("div", "dw-tab", t("tab.context"));
  tabs.append(chatTab, contextTab);
  const sideBody = el("div", "dw-side-body");
  side.append(tabs, sideBody);

  const contextController = new ContextPanelController(api);
  const chatController = new ChatController({
    api,
    // AC15：恢复上次对话会话（轨迹在主进程落盘，可回放续聊）；无历史则开新会话
    sessionId: savedSession?.chatSessionId ?? `session-${Date.now()}`,
    workspaceRoot: "",
    modeId: "chat",
  });

  // 会话上下文快照采集（对话面板与指挥台任务共用）：活动文件 + 主选区
  function collectContext(): { activeFile?: string; selection?: { text: string; startLine: number; endLine: number } } {
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
  }

  // 对话面板：发送时采集活动文件 + 主选区作为会话上下文快照
  const chatPanel = mountChatPanel(sideBody, {
    controller: chatController,
    listModes: () => modes,
    listProviders: () => providers,
    collectContext,
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

  // ==========================================================================
  // 指挥台（AC9）：任务列表 | Agent 活动流 | 工作区视图（代码 / Diff 页签）
  // ==========================================================================

  const taskCenter = new TaskCenter({
    api,
    workspaceRoot: "",
    defaultModeId: "agent",
  });

  // ---- 左栏：任务列表 ----
  const taskColTitle = el("div", "dw-console-col-title", t("console.tasks"));
  taskCol.appendChild(taskColTitle);
  const newTaskRow = el("div", "dw-task-new");
  const newTaskInput = el("input", "dw-input") as HTMLInputElement;
  newTaskInput.placeholder = t("console.newTask.placeholder");
  const newTaskBtn = el("button", "dw-btn dw-btn-primary", t("console.create"));
  newTaskRow.append(newTaskInput, newTaskBtn);
  taskCol.appendChild(newTaskRow);
  const taskList = el("div", "dw-task-list");
  taskCol.appendChild(taskList);

  function renderTaskList(): void {
    taskList.textContent = "";
    const tasks = taskCenter.listTasks();
    if (tasks.length === 0) {
      taskList.appendChild(el("div", "dw-task-empty", t("console.task.empty")));
      return;
    }
    for (const task of tasks) {
      const row = el("div", "dw-task-row");
      if (task.id === taskCenter.activeTaskId) row.classList.add("dw-task-active");
      const title = el("span", "dw-task-title", task.title);
      title.title = task.title;
      const statusKey = TASK_STATUS_KEY[task.status as keyof typeof TASK_STATUS_KEY];
      const badge = el(
        "span",
        `dw-task-badge dw-task-badge-${task.status}`,
        statusKey !== undefined ? t(statusKey) : task.status
      );
      row.append(title, badge);
      row.addEventListener("click", () => {
        void taskCenter.activate(task.id).then(() => activityStream.resubscribe());
      });
      taskList.appendChild(row);
    }
  }

  async function createTaskFromInput(): Promise<void> {
    const text = newTaskInput.value;
    if (text.trim() === "") return;
    newTaskInput.value = "";
    try {
      await taskCenter.createTask(text, collectContext());
      activityStream.resubscribe();
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }
  newTaskBtn.addEventListener("click", () => void createTaskFromInput());
  newTaskInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void createTaskFromInput();
    }
  });

  // ---- 中栏：活动流 + 意图输入 ----
  const activityBody = el("div", "dw-console-activity-body");
  const activityStream = mountActivityStream(activityBody, {
    getController: () => taskCenter.activeController(),
    onProposalReview: (assistantText) => reviewProposal(assistantText),
    resolveModeName,
  });
  const activityInputRow = el("div", "dw-chat-input");
  const activityTextarea = el("textarea", "dw-chat-textarea") as HTMLTextAreaElement;
  activityTextarea.placeholder = t("console.input.placeholder");
  activityTextarea.rows = 2;
  const activitySendBtn = el("button", "dw-btn dw-btn-primary", t("chat.send"));
  const activityStopBtn = el("button", "dw-btn", t("chat.stop"));
  activityStopBtn.style.display = "none";
  activityInputRow.append(activityTextarea, activitySendBtn, activityStopBtn);
  activityCol.append(activityBody, activityInputRow);

  function refreshActivityInput(): void {
    const controller = taskCenter.activeController();
    const running = controller?.isRunning === true;
    activityTextarea.disabled = controller === null || running;
    activitySendBtn.style.display = controller !== null && !running ? "" : "none";
    activityStopBtn.style.display = running ? "" : "none";
  }

  function sendActivityInput(): void {
    const text = activityTextarea.value;
    if (text.trim() === "") return;
    activityTextarea.value = "";
    void taskCenter.sendToActive(text, collectContext()).catch((error: unknown) => {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
    });
  }
  activitySendBtn.addEventListener("click", sendActivityInput);
  activityStopBtn.addEventListener("click", () => taskCenter.cancelActive());
  activityTextarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendActivityInput();
    }
  });

  taskCenter.onChange(() => {
    renderTaskList();
    refreshActivityInput();
    activityStream.resubscribe();
  });
  renderTaskList();
  refreshActivityInput();

  // ---- 右栏：工作区视图（代码 / Diff 页签）----
  const wsTabs = el("div", "dw-tabs");
  const codeTab = el("div", "dw-tab dw-tab-active", t("tab.code"));
  const diffTab = el("div", "dw-tab", t("tab.diff"));
  wsTabs.append(codeTab, diffTab);
  const wsBody = el("div", "dw-side-body");
  const codePane = el("div", "dw-console-code");
  const diffPane = el("div", "dw-console-diff");
  diffPane.style.display = "none";
  diffPane.appendChild(el("div", "dw-sidebar-empty", t("console.diff.empty")));
  wsBody.append(codePane, diffPane);
  workspaceCol.append(wsTabs, wsBody);

  codeTab.addEventListener("click", () => {
    codeTab.classList.add("dw-tab-active");
    diffTab.classList.remove("dw-tab-active");
    codePane.style.display = "";
    diffPane.style.display = "none";
    editor.resize();
  });
  diffTab.addEventListener("click", () => {
    diffTab.classList.add("dw-tab-active");
    codeTab.classList.remove("dw-tab-active");
    codePane.style.display = "none";
    diffPane.style.display = "flex";
  });

  // ---- 双形态切换（AC8）----
  function switchForm(next: "chat" | "console"): void {
    if (form === next) return;
    form = next;
    if (next === "console") {
      ide.style.display = "none";
      consoleRoot.style.display = "grid";
      codePane.appendChild(editorArea); // 同一编辑器实例迁入代码页签，状态保留
      formBtn.textContent = t("chrome.form.chat");
    } else {
      consoleRoot.style.display = "none";
      ide.style.display = "grid";
      ide.insertBefore(editorArea, side);
      formBtn.textContent = t("chrome.form.console");
    }
    editor.resize();
  }
  formBtn.addEventListener("click", () => {
    switchForm(form === "chat" ? "console" : "chat");
    schedulePersist();
  });

  // ---- 会话持久化（迭代 6 / AC15）：状态变更防抖落盘 settings "session.state" ----
  let persistTimer: number | undefined;
  function persistSession(): void {
    const snapshot: SessionStateSnapshot = {
      chatSessionId: chatController.sessionId,
      tasks: taskCenter.listTasks(),
      activeTaskId: taskCenter.activeTaskId,
      taskCounter: taskCenter.taskCounter,
      form,
      workspaceRoot,
    };
    void api.settings.set("session.state", snapshot);
  }
  function schedulePersist(): void {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(persistSession, 300);
  }

  // ---- AC15 启动恢复：工作区 → 任务列表 → 对话/激活任务轨迹回放 → 形态 ----
  if (savedSession !== null) {
    if (savedSession.workspaceRoot !== "") {
      try {
        await enterWorkspace(savedSession.workspaceRoot);
      } catch {
        // 目录已被移动/删除：按未打开工作区处理，不阻断其余恢复
        workspaceRoot = "";
        refreshOnboarding();
        statusWorkspace.textContent = t("status.noWorkspace");
      }
    }
    if (savedSession.tasks.length > 0) {
      taskCenter.restore({
        tasks: savedSession.tasks,
        activeTaskId: savedSession.activeTaskId,
        taskCounter: savedSession.taskCounter,
      });
    }
    try {
      const chatTrace = await api.agent.trace(chatController.sessionId);
      if (chatTrace.length > 0) chatController.ingestHistory(chatTrace, { resumed: true });
    } catch {
      // 轨迹读取失败不阻断启动（全新会话体验）
    }
    if (taskCenter.activeTaskId !== null) {
      await taskCenter.activate(taskCenter.activeTaskId);
    }
    if (savedSession.form === "console") switchForm("console");
    if (savedSession.tasks.length > 0) {
      showStatus(t("session.restored", { tasks: String(savedSession.tasks.length) }));
    }
  }
  // 恢复完成后再订阅持久化（避免恢复过程中的中间态覆盖历史快照）
  taskCenter.onChange(schedulePersist);
  chatController.onChange(schedulePersist);
  persistSession();

  // agent 事件流驱动一次后刷新上下文 manifest 展示
  api.agent.onEvent((event) => {
    if (event.type === "done" || event.type === "error") void contextController.refresh();
  });

  // ---- WU013：diff 审查（对话提案 → diff → 逐块接受/拒绝）----
  // 对话形态：编辑器内覆盖层；指挥台形态（AC9）：工作区视图的 Diff 页签
  function reviewProposal(assistantText: string): void {
    if (openFile === null) {
      showStatus(t("review.openFileFirst"));
      return;
    }
    const proposal = extractEditProposal(assistantText);
    if (proposal === null) {
      showStatus(t("review.noBlock"));
      return;
    }
    if (diffOverlay !== null) return; // 已有审查进行中
    const controller = new DiffController(openFile.doc.getText(), proposal.code);
    if (!controller.hasChanges) {
      showStatus(t("review.noChange"));
      return;
    }
    diffOverlay = el("div", "dw-diff-overlay");
    if (form === "console") {
      diffOverlay.style.position = "relative";
      diffPane.textContent = "";
      diffPane.appendChild(diffOverlay);
      diffTab.classList.add("dw-tab-active");
      codeTab.classList.remove("dw-tab-active");
      codePane.style.display = "none";
      diffPane.style.display = "flex";
    } else {
      editorArea.appendChild(diffOverlay);
    }
    const target = openFile;
    mountDiffView(diffOverlay, {
      controller,
      title: t("review.title", { path: target.path }),
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

  // ---- 设置入口（AC12：统一设置页）----
  settingsBtn.addEventListener("click", () => openSettingsDialog(settingsDeps));

  // ---- 语言热生效（AC12）：静态文案重写 + 动态列表全量重绘 ----
  function applyLocale(): void {
    formBtn.textContent = form === "chat" ? t("chrome.form.console") : t("chrome.form.chat");
    formBtn.title = t("chrome.form.tooltip");
    openBtn.textContent = t("chrome.openFolder");
    saveBtn.textContent = t("chrome.save");
    externalBtn.textContent = t("chrome.external");
    externalBtn.title = t("chrome.external.tooltip");
    activeFileLabel.textContent = openFile?.path ?? t("chrome.noFile");
    settingsBtn.textContent = t("chrome.settings");
    if (workspaceRoot === "") statusWorkspace.textContent = t("status.noWorkspace");
    refreshDirty();
    if (workspaceRoot === "") {
      sidebar.textContent = "";
      sidebar.appendChild(el("div", "dw-sidebar-empty", t("sidebar.empty")));
    } else {
      // 文件树 ↗ 按钮 tooltip 随语言更新（树本身不重建，保留展开/选中状态）
      for (const btn of sidebar.querySelectorAll<HTMLElement>(".dw-tree-external")) {
        btn.title = t("tree.external");
      }
    }
    chatTab.textContent = t("tab.chat");
    contextTab.textContent = t("tab.context");
    codeTab.textContent = t("tab.code");
    diffTab.textContent = t("tab.diff");
    taskColTitle.textContent = t("console.tasks");
    newTaskInput.placeholder = t("console.newTask.placeholder");
    newTaskBtn.textContent = t("console.create");
    activityTextarea.placeholder = t("console.input.placeholder");
    activitySendBtn.textContent = t("chat.send");
    activityStopBtn.textContent = t("chat.stop");
    renderTaskList();
    if (diffOverlay === null) {
      diffPane.textContent = "";
      diffPane.appendChild(el("div", "dw-sidebar-empty", t("console.diff.empty")));
    }
    renderUpdateBox();
    buildOnboarding();
    // 欢迎文档仅在无打开文件时随语言重建（不触碰用户文件内容）
    if (openFile === null) {
      editor.setDocument(TextDocument.fromString(t("editor.welcome")));
    }
  }
  onDidChangeLocale(applyLocale);
  applyLocale();
}

window.addEventListener("DOMContentLoaded", () => {
  void (async () => {
    const app = document.getElementById("app");
    if (app === null) return;
    const api = window.devwit;
    if (api === undefined) {
      app.textContent = "preload not ready: window.devwit missing";
      return;
    }
    // 恢复上次界面语言（AC12：持久化在 settings "ui.locale"；「跟随系统」或未设置时按系统语言解析）
    const saved = await api.settings.get("ui.locale");
    if (saved === "zh-CN" || saved === "en-US") {
      setLocale(saved as Locale);
    } else {
      setLocale(resolveSystemLocale());
    }
    await bootstrap(api);
  })();
});
