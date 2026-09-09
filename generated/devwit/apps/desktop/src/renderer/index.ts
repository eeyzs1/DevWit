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
  mountSessionList,
  mountTraceTimeline,
  type TaskInfo,
} from "@devwit/chat-ui";
import { openSettingsDialog, type SettingsDialogDeps } from "./settings-dialog.js";
import { mountSearchPanel } from "./search-panel.js";
import { mountLspUi } from "./lsp-ui.js";
import { mountGitPanel } from "./git-panel.js";
import { mountDebugPanel } from "./debug-panel.js";
import { el } from "./dom.js";
import { openEditorSetupDialog } from "./editor-setup-dialog.js";
import { openOnboardingWizard } from "./onboarding-wizard.js";
import { maybeOpenContextTour } from "./context-tour.js";
import { maybeOpenAuthGateTour } from "./auth-gate-tour.js";
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

async function bootstrap(api: DevwitApi): Promise<void> {
  const app = document.getElementById("app");
  if (app === null) return;
  app.textContent = "";

  /** 按文件扩展名返回行注释前缀（Ctrl+/ 用；未知类型默认 "//"）。 */
  function lineCommentForPath(path: string): string {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (["ts", "tsx", "js", "jsx", "c", "cc", "cpp", "h", "hpp", "java", "cs", "go", "rs", "swift", "kt", "dart", "css", "scss", "php"].includes(ext)) return "//";
    if (["py", "sh", "bash", "zsh", "rb", "yaml", "yml", "toml", "r", "ps1", "dockerfile", "makefile"].includes(ext)) return "#";
    if (["sql", "lua"].includes(ext)) return "--";
    if (["ini", "conf", "cfg", "toml"].includes(ext)) return ";";
    return "//";
  }

  // ---- 全局状态 ----
  let modes: ModeDefinition[] = [];
  let providers: ProviderConfig[] = [];
  let openFile: OpenFile | null = null;
  /** 多标签页（v0.4.0）：所有已打开文件，顺序可拖拽调整。 */
  let openFiles: OpenFile[] = [];
  let diffOverlay: HTMLElement | null = null;
  let workspaceRoot = "";
  /** 主界面形态（AC8）：chat = 对话形态；console = 指挥台形态。两形态 DOM 各自保持。 */
  let form: "chat" | "console" = "chat";
  /** AC15：上次退出的会话快照（无/损坏时为 null，按全新会话处理）。 */
  const savedSession = parseSessionSnapshot(await api.settings.get("session.state"));

  // ---- MCP 服务器身份缓存：活动流展示「调用了哪个远程 MCP」（可读元信息 + 端点/版本）----
  const mcpServers = new Map<string, { name: string; transport: string; url?: string; description?: string; serverVersion?: string }>();
  async function refreshMcpServers(): Promise<void> {
    try {
      const views = await api.mcp.list();
      mcpServers.clear();
      for (const view of views) {
        mcpServers.set(view.config.id, {
          name: view.config.name,
          transport: view.config.transport ?? "stdio",
          url: view.config.url,
          description: view.serverInfo?.description,
          serverVersion: view.serverInfo?.version,
        });
      }
    } catch {
      /* 静默：仅用于活动流展示，缺失不阻断 */
    }
  }
  void refreshMcpServers();
  api.mcp.onChanged(() => void refreshMcpServers());

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

  // 左栏四页签（AC41 文件/Git + AC42 调试 + v0.4.0 大纲）：各自 DOM 保持（切页签不重建树）
  const leftTabs = el("div", "dw-tabs dw-left-tabs");
  const filesTab = el("div", "dw-tab dw-tab-active", t("tab.files"));
  const gitTab = el("div", "dw-tab", t("tab.git"));
  const debugTab = el("div", "dw-tab", t("tab.debug"));
  const outlineTab = el("div", "dw-tab", t("tab.outline"));
  leftTabs.append(filesTab, gitTab, debugTab, outlineTab);
  const filesPane = el("div", "dw-left-pane");
  const gitPane = el("div", "dw-left-pane dw-git");
  gitPane.style.display = "none";
  const debugPane = el("div", "dw-left-pane dw-debug");
  debugPane.style.display = "none";
  const outlinePane = el("div", "dw-left-pane dw-outline");
  outlinePane.style.display = "none";
  sidebar.append(leftTabs, filesPane, gitPane, debugPane, outlinePane);
  function activateLeftTab(active: "files" | "git" | "debug" | "outline"): void {
    filesTab.classList.toggle("dw-tab-active", active === "files");
    gitTab.classList.toggle("dw-tab-active", active === "git");
    debugTab.classList.toggle("dw-tab-active", active === "debug");
    outlineTab.classList.toggle("dw-tab-active", active === "outline");
    filesPane.style.display = active === "files" ? "" : "none";
    gitPane.style.display = active === "git" ? "flex" : "none";
    debugPane.style.display = active === "debug" ? "flex" : "none";
    outlinePane.style.display = active === "outline" ? "flex" : "none";
  }
  filesTab.addEventListener("click", () => activateLeftTab("files"));
  gitTab.addEventListener("click", () => {
    activateLeftTab("git");
    void gitPanel.refreshGit(); // 切到面板即取最新（外部 git 操作可能绕过 watcher）
  });
  debugTab.addEventListener("click", () => activateLeftTab("debug"));
  outlineTab.addEventListener("click", () => {
    activateLeftTab("outline");
    void lspUi.refreshOutline(); // 切到大纲即取最新（文件可能已变更）
  });

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
  const blameBtn = el("button", "dw-btn", t("git.blame"));
  const activeFileLabel = el("span", "dw-active-file", t("chrome.noFile"));
  const spacer = el("span", "dw-spacer");
  const settingsBtn = el("button", "dw-btn", t("chrome.settings"));
  header.append(formBtn, openBtn, saveBtn, externalBtn, blameBtn, activeFileLabel, spacer, settingsBtn);

  // ---- 状态栏 ----
  const statusWorkspace = el("span", undefined, t("status.noWorkspace"));
  const statusDirty = el("span");
  const statusMessage = el("span", "dw-status-message");
  // LSP 代码智能（AC40）：服务状态 + 诊断计数（error ✕ / warning ⚠）
  const statusLsp = el("span", "dw-status-lsp");
  // Git 版本控制（AC41）：分支 + 变更计数（非 git 工作区不显示）
  const statusGit = el("span", "dw-status-git");
  // DAP 调试（AC42）：调试状态（idle 不显示）
  const statusDebug = el("span", "dw-status-debug");
  // 更新提示区（AC16）：ready 状态常驻「重启更新」按钮，其余状态走瞬态提示
  const updateBox = el("span", "dw-update");
  statusbar.append(statusWorkspace, statusDirty, statusMessage, statusLsp, statusGit, statusDebug, updateBox);
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
  // 多标签页栏（v0.4.0）：水平排列，可拖拽排序
  const tabBar = el("div", "dw-editor-tabs");
  editorArea.appendChild(tabBar);
  editorArea.appendChild(canvas);
  const welcomeDoc = TextDocument.fromString(t("editor.welcome"));
  const editor = new EditorView(canvas, welcomeDoc);
  // E2E 几何钩子（AC40）：preload 标记激活时安装——把「文档位置→客户区坐标」
  // 反解暴露给 Playwright，鼠标可精确驻留/Ctrl+Click 指定行列（无此钩子则
  // canvas 内部几何对外不可达）；editorSelections 供断言跳转落点光标。
  // 生产环境 window.devwitE2E 不存在，不安装。
  const e2eFlag = (window as { devwitE2E?: { active: boolean } }).devwitE2E;
  if (e2eFlag?.active === true) {
    (window as { __devwitE2E?: unknown }).__devwitE2E = {
      editorClientPoint: (line: number, character: number) => editor.clientPointForPosition({ line, character }),
      editorSelections: () => editor.getSelections(),
    };
  }
  const setActiveDoc = (file: OpenFile | null): void => {
    openFile = file;
    if (file !== null) {
      editor.setDocument(file.doc);
      editor.setLineComment(lineCommentForPath(file.path));
      activeFileLabel.textContent = file.path;
    }
    gitPanel.closeBlame(); // 切换文件时关闭 blame 覆盖层（行号不再对齐）
    refreshDirty();
    renderTabBar();
  };
  /** 渲染标签栏（v0.4.0）：每个打开文件一个 tab，支持点击切换/中键关闭/拖拽排序。 */
  function renderTabBar(): void {
    tabBar.innerHTML = "";
    if (openFiles.length === 0) {
      tabBar.style.display = "none";
      return;
    }
    tabBar.style.display = "";
    for (let i = 0; i < openFiles.length; i++) {
      const file = openFiles[i]!;
      const tab = el("div", "dw-editor-tab");
      if (openFile !== null && openFile.path === file.path) {
        tab.classList.add("dw-editor-tab-active");
      }
      tab.draggable = true;
      tab.dataset["index"] = String(i);
      tab.dataset["path"] = file.path;
      const baseName = file.path.replace(/\\/g, "/").split("/").pop() ?? file.path;
      const label = el("span", "dw-editor-tab-label", baseName);
      label.title = file.path;
      const closeBtn = el("span", "dw-editor-tab-close", "×");
      closeBtn.title = t("editor.tab.close");
      tab.append(label, closeBtn);
      // 点击切换
      tab.addEventListener("click", (event) => {
        if (event.target === closeBtn) return;
        void switchToTab(file.path);
      });
      // 中键关闭
      tab.addEventListener("mousedown", (event) => {
        if (event.button === 1) {
          event.preventDefault();
          void closeFile(file.path);
        }
      });
      // 关闭按钮
      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void closeFile(file.path);
      });
      // ---- 拖拽排序 ----
      tab.addEventListener("dragstart", (event) => {
        if (event.dataTransfer === null) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(i));
        tab.classList.add("dw-editor-tab-dragging");
      });
      tab.addEventListener("dragend", () => {
        tab.classList.remove("dw-editor-tab-dragging");
        tabBar.querySelectorAll(".dw-editor-tab-drop-target").forEach((n) => n.classList.remove("dw-editor-tab-drop-target"));
      });
      tab.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
        const dragging = tabBar.querySelector(".dw-editor-tab-dragging");
        if (dragging !== null && dragging !== tab) {
          tab.classList.add("dw-editor-tab-drop-target");
        }
      });
      tab.addEventListener("dragleave", () => {
        tab.classList.remove("dw-editor-tab-drop-target");
      });
      tab.addEventListener("drop", (event) => {
        event.preventDefault();
        tab.classList.remove("dw-editor-tab-drop-target");
        const fromIndex = parseInt(event.dataTransfer?.getData("text/plain") ?? "", 10);
        if (Number.isNaN(fromIndex) || fromIndex === i) return;
        const moved = openFiles[fromIndex];
        if (moved === undefined) return;
        openFiles.splice(fromIndex, 1);
        openFiles.splice(i, 0, moved);
        renderTabBar();
      });
      tabBar.appendChild(tab);
    }
  }
  /** 切换到已打开的标签页。 */
  async function switchToTab(filePath: string): Promise<void> {
    const target = openFiles.find((f) => f.path === filePath);
    if (target === undefined) return;
    // LSP：关旧开新
    if (openFile !== null && workspaceRoot !== "" && openFile.path !== filePath) {
      void api.lsp.didClose(relPathOf(openFile.path));
    }
    lspUi.hideCompletion();
    setActiveDoc(target);
    debugPanel.syncEditorBreakpoints();
    if (workspaceRoot !== "") {
      lspUi.syncOpenFileToLsp();
      lspUi.applyEditorDiagnostics();
      void lspUi.refreshOutline();
    }
    sidebar.querySelectorAll(".dw-tree-node").forEach((node) => {
      node.classList.toggle("dw-tree-active", (node as HTMLElement).dataset["path"] === filePath);
    });
    editor.focus();
  }  /** 关闭标签页。如果是活动文件，切换到相邻标签。 */
  async function closeFile(filePath: string): Promise<void> {
    const idx = openFiles.findIndex((f) => f.path === filePath);
    if (idx === -1) return;
    const wasActive = openFile !== null && openFile.path === filePath;
    // LSP 关闭
    if (workspaceRoot !== "") {
      void api.lsp.didClose(relPathOf(filePath));
    }
    openFiles.splice(idx, 1);
    if (wasActive) {
      const next = openFiles[idx] ?? openFiles[idx - 1] ?? null;
      if (next !== null) {
        lspUi.hideCompletion();
        setActiveDoc(next);
        debugPanel.syncEditorBreakpoints();
        if (workspaceRoot !== "") {
          lspUi.syncOpenFileToLsp();
          lspUi.applyEditorDiagnostics();
          void lspUi.refreshOutline();
        }
      } else {
        // 无标签页剩余：显示欢迎文档
        setActiveDoc(null);
        editor.setDocument(welcomeDoc);
        activeFileLabel.textContent = t("chrome.noFile");
      }
    } else {
      renderTabBar();
    }
    sidebar.querySelectorAll(".dw-tree-node").forEach((node) => {
      const p = (node as HTMLElement).dataset["path"];
      node.classList.toggle("dw-tree-active", p === (openFile?.path ?? ""));
    });
  }
  const refreshDirty = (): void => {
    statusDirty.textContent = openFile !== null && openFile.doc.isDirty ? t("status.unsaved") : "";
  };
  window.addEventListener("resize", () => editor.resize());

  async function saveActiveFile(): Promise<void> {
    if (openFile === null) return;
    await api.workspace.write(openFile.path, openFile.doc.getText());
    openFile.doc.markSaved();
    refreshDirty();
    void lspUi.refreshOutline(); // 保存后刷新大纲（落盘后 tsserver 重新分析）
  }
  saveBtn.addEventListener("click", () => void saveActiveFile());
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveActiveFile();
    }
    // Ctrl+Shift+F：切换跨文件搜索面板（v0.4.0）
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchPanelHandle.toggle();
    }
  });

  // ---- 跨文件搜索面板（v0.4.0）：编辑器顶部，Ctrl+Shift+F 切换 ----
  const searchPanel = el("div", "dw-search-panel");
  searchPanel.style.display = "none";
  editorArea.insertBefore(searchPanel, canvas);
  const searchRow = el("div", "dw-search-row");
  const searchInput = el("input", "dw-search-input") as HTMLInputElement;
  searchInput.type = "text";
  searchInput.placeholder = t("search.placeholder");
  searchInput.spellcheck = false;
  const searchOptsBtns = el("div", "dw-search-opts");
  const caseBtn = el("button", "dw-search-opt", "Aa");
  caseBtn.title = t("search.caseSensitive");
  const regexBtn = el("button", "dw-search-opt", ".*");
  regexBtn.title = t("search.regex");
  const wordBtn = el("button", "dw-search-opt", "W");
  wordBtn.title = t("search.wholeWord");
  const toggleReplaceBtn = el("button", "dw-search-opt", "⇄");
  toggleReplaceBtn.title = t("search.toggleReplace");
  const searchCount = el("span", "dw-search-count");
  const searchCloseBtn = el("button", "dw-search-close", "×");
  searchCloseBtn.title = t("search.close");
  searchOptsBtns.append(caseBtn, regexBtn, wordBtn, toggleReplaceBtn);
  searchRow.append(searchInput, searchOptsBtns, searchCount, searchCloseBtn);
  const replaceRow = el("div", "dw-search-row dw-search-replace-row");
  replaceRow.style.display = "none";
  const replaceInput = el("input", "dw-search-input") as HTMLInputElement;
  replaceInput.type = "text";
  replaceInput.placeholder = t("search.replacePlaceholder");
  replaceInput.spellcheck = false;
  const replaceAllBtn = el("button", "dw-btn dw-btn-small", t("search.replaceAll"));
  replaceRow.append(replaceInput, el("span", "dw-spacer"), replaceAllBtn);
  const searchResults = el("div", "dw-search-results");
  searchPanel.append(searchRow, replaceRow, searchResults);

  // v0.7.6：搜索面板逻辑抽取为 search-panel.ts 模块（DOM 仍在宿主装配，
  // 状态/事件/搜索/替换/locale 由模块持有；行为零变化——E2E 回归锁定）
  const refreshActiveFileDoc = async (path: string): Promise<void> => {
    if (openFile === null || openFile.path !== path) return;
    const refreshed = await api.workspace.read(openFile.path);
    const newDoc = TextDocument.fromString(refreshed);
    openFile.doc = newDoc;
    editor.setDocument(newDoc);
  };
  const searchPanelHandle = mountSearchPanel({
    api,
    elements: {
      panel: searchPanel,
      input: searchInput,
      results: searchResults,
      count: searchCount,
      caseBtn,
      regexBtn,
      wordBtn,
      toggleReplaceBtn,
      replaceRow,
      replaceInput,
      replaceAllBtn,
      closeBtn: searchCloseBtn,
    },
    getWorkspaceRoot: () => workspaceRoot,
    openFileByPath,
    revealPosition: (position) => editor.revealPosition(position),
    getActiveFilePath: () => openFile?.path ?? null,
    onActiveFileRewritten: refreshActiveFileDoc,
    showStatus,
  });

  // ---- 统一设置页（AC12）：通用 / 模型 / 编辑器 / 模式 ----
  /** 首次运行向导（迭代 18 / AC27）：设置页「重跑向导」与首启自动弹出共用入口。 */
  function launchWizard(onClosed?: () => void): void {
    openOnboardingWizard({
      api,
      onProvidersChanged: () => void reloadProviders(),
      onOpenFolder: () => openWorkspace(),
      onClosed,
    });
  }
  const settingsDeps: SettingsDialogDeps = {
    api,
    onProvidersChanged: () => void reloadProviders(),
    onModesChanged: () => void reloadModes(),
    onRerunWizard: () => launchWizard(),
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
    // 多标签页（v0.4.0）：已打开则直接切换，不重复加载
    const existing = openFiles.find((f) => f.path === filePath);
    if (existing !== undefined) {
      await switchToTab(filePath);
      return;
    }
    const content = await api.workspace.read(filePath);
    const doc = TextDocument.fromString(content);
    doc.onDidChange(refreshDirty);
    // LSP 文档生命周期（AC40）：关旧（清其诊断快照）→ 开新（缓冲区全文同步）
    if (openFile !== null && workspaceRoot !== "") {
      void api.lsp.didClose(relPathOf(openFile.path));
    }
    lspUi.hideCompletion(); // 文件切换时关闭补全浮层
    const file: OpenFile = { path: filePath, doc };
    openFiles.push(file);
    setActiveDoc(file);
    debugPanel.syncEditorBreakpoints(); // 断点红点随文件切换重挂（AC42）
    if (workspaceRoot !== "") {
      lspUi.syncOpenFileToLsp();
      doc.onDidChange(() => lspUi.scheduleLspSync());
      doc.onDidChange(() => lspUi.scheduleCompletion()); // v0.4.0：输入触发自动补全
      doc.onDidChange(() => lspUi.scheduleOutlineRefresh()); // v0.4.0：编辑触发大纲刷新
      lspUi.applyEditorDiagnostics(); // 该文件既有诊断立即上波浪线
      void lspUi.refreshOutline(); // 文件打开即取大纲（LSP 未就绪则空，ready 推送时补偿）
    }
    sidebar.querySelectorAll(".dw-tree-node").forEach((node) => {
      node.classList.toggle("dw-tree-active", (node as HTMLElement).dataset["path"] === filePath);
    });
    editor.focus();
  }

  // ---- LSP 代码智能（迭代 31 / AC40）：悬停 / Ctrl+Click 定义 / 实时诊断 ----
  /** 绝对路径 → 工作区相对路径（正斜杠；与 flattenTreeFiles 同一口径）。 */
  function relPathOf(absPath: string): string {
    return absPath.slice(workspaceRoot.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  }

  // v0.7.6：LSP 代码智能 UI 集群抽取为 lsp-ui.ts 模块（悬停/补全/引用/签名/
  // 重命名/代码操作/大纲/状态条/诊断/同步，行为零变化——E2E 回归锁定）
  const lspUi = mountLspUi({
    api,
    editor,
    canvas,
    editorArea,
    outlinePane,
    statusLsp,
    getWorkspaceRoot: () => workspaceRoot,
    getOpenFile: () => openFile,
    relPathOf,
    openFileByPath,
  });

  // v0.7.7：Git 版本控制 UI 集群抽取为 git-panel.ts 模块（面板/diff/blame/
  // 分支管理/徽章联动/git:changed 订阅，行为零变化——E2E 回归锁定）
  const gitPanel = mountGitPanel({
    api,
    editor,
    gitPane,
    blameBtn,
    statusGit,
    filesPane,
    editorArea,
    getWorkspaceRoot: () => workspaceRoot,
    getOpenFile: () => openFile,
    relPathOf,
    openFileByPath,
    showStatus,
    toLocalError,
  });

  // v0.7.8：DAP 调试 UI 集群抽取为 debug-panel.ts 模块（断点/工具栏/调用栈/
  // 变量树/watch/输出/状态栏/停止定位，行为零变化——verify-i33 E2E 锁定）
  const debugPanel = mountDebugPanel({
    api,
    editor,
    debugPane,
    statusDebug,
    getWorkspaceRoot: () => workspaceRoot,
    getOpenFile: () => openFile,
    openFileByPath,
    showStatus,
    toLocalError,
  });

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

    // D3 / v0.6.0：没有现成项目？一键生成示例项目（迷你 Web 应用，含预埋 bug 供 Agent 演练）
    const sampleRow = el("li");
    const sampleBtn = el("button", "dw-btn dw-btn-primary", t("onboarding.sample.button"));
    sampleBtn.addEventListener("click", () => void openSampleProject());
    sampleRow.append(sampleBtn, el("span", "dw-onboarding-hint", t("onboarding.sample.hint")));

    steps.append(step1, step2, step3, sampleRow);
    card.appendChild(steps);
    onboarding.appendChild(card);
  }
  /** D3 / v0.6.0：打开示例项目——选定（新建）目录 → 脚手架写入 → 进入工作区。 */
  async function openSampleProject(): Promise<void> {
    const root = await api.workspace.openDialog();
    if (root === null) return;
    await api.workspace.createSample(root);
    await enterWorkspace(root);
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
      // Git 徽章占位（AC41）：内容由 updateTreeBadges 按最新 status 填充
      label.appendChild(el("span", "dw-tree-badge"));
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

  /** AC28：@文件引用候选清单（工作区相对路径，正斜杠），enterWorkspace 时随树重建。 */
  let workspaceFiles: string[] = [];
  function flattenTreeFiles(node: TreeNode, root: string, acc: string[]): void {
    if (node.type === "file") {
      acc.push(node.path.slice(root.length).replace(/^[/\\]+/, "").replace(/\\/g, "/"));
    }
    for (const child of node.children ?? []) flattenTreeFiles(child, root, acc);
  }

  /** 进入工作区：设置根目录 + 构建文件树（打开对话框与 AC15 启动恢复共用）。 */
  async function enterWorkspace(root: string): Promise<void> {
    workspaceRoot = root;
    chatController.setWorkspaceRoot(root);
    taskCenter.setWorkspaceRoot(root);
    refreshOnboarding();
    statusWorkspace.textContent = root;
    // 切换工作区时关闭所有标签页（v0.4.0）
    openFiles = [];
    setActiveDoc(null);
    editor.setDocument(welcomeDoc);
    activeFileLabel.textContent = t("chrome.noFile");
    filesPane.textContent = "";
    const tree = (await api.workspace.tree(root)) as TreeNode;
    workspaceFiles = [];
    flattenTreeFiles(tree, root, workspaceFiles);
    const ul = el("ul", "dw-tree");
    for (const child of tree.children ?? []) renderTree(child, ul);
    filesPane.appendChild(ul);
    // 树重建后回填徽章（git:changed 可能先于树到达）；并主动拉一次最新状态
    gitPanel.updateTreeBadges();
    void gitPanel.refreshGit();
  }

  async function openWorkspace(): Promise<void> {
    const root = await api.workspace.openDialog();
    if (root === null) return;
    await enterWorkspace(root);
    schedulePersist();
  }
  openBtn.addEventListener("click", () => void openWorkspace());
  filesPane.appendChild(el("div", "dw-sidebar-empty", t("sidebar.empty")));

  // ---- 右侧栏：对话 / 会话 / 上下文 / 轨迹 四个页签 ----
  const tabs = el("div", "dw-tabs");
  const chatTab = el("div", "dw-tab dw-tab-active", t("tab.chat"));
  const sessionsTab = el("div", "dw-tab", t("tab.sessions"));
  const contextTab = el("div", "dw-tab", t("tab.context"));
  const traceTab = el("div", "dw-tab", t("tab.trace"));
  tabs.append(chatTab, sessionsTab, contextTab, traceTab);
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
    // AC28：@文件引用候选（enterWorkspace 重建的工作区相对路径清单）
    listWorkspaceFiles: () => workspaceFiles,
    // AC38：@符号 引用候选（主进程 SymbolIndex 查询，防抖在面板内）
    querySymbols: (q) => api.symbols.query(q),
    onProposalReview: (assistantText) => reviewProposal(assistantText),
  });
  chatPanel.root.style.display = "flex";

  const contextPanel = mountContextPanel(sideBody, contextController);
  contextPanel.root.style.display = "none";

  // 轨迹时间线（迭代 27 / AC36）：当前会话实时事件 + 历史会话回放
  const traceTimeline = mountTraceTimeline(sideBody, {
    api,
    liveSessionId: chatController.sessionId,
  });
  traceTimeline.root.style.display = "none";

  // 对话会话管理（迭代 28 / AC37）：多会话列表 / 新建 / 切换 / 改名 / 删除
  /** 开新对话会话（空会话无轨迹，不入列表——首条消息落盘后自然出现）。 */
  function startNewChatSession(): void {
    if (chatController.isRunning) return;
    chatController.switchSession(`session-${Date.now()}`);
    traceTimeline.setLiveSession(chatController.sessionId);
    activateSideTab("chat");
    schedulePersist();
  }
  /** 切换到历史会话：轨迹回放重建消息列表（resumed 语义——不标 running）。 */
  async function switchChatSession(sessionId: string): Promise<void> {
    if (sessionId !== chatController.sessionId) {
      if (chatController.isRunning) return; // 进行中的 run 不切（先停止或等终态）
      chatController.switchSession(sessionId);
      traceTimeline.setLiveSession(sessionId);
      try {
        const trace = await api.agent.trace(sessionId);
        if (trace.length > 0) chatController.ingestHistory(trace, { resumed: true });
      } catch {
        // 轨迹读取失败按空会话处理，不阻断切换
      }
      schedulePersist();
    }
    activateSideTab("chat");
  }
  const sessionList = mountSessionList(sideBody, {
    api,
    getActiveSessionId: () => chatController.sessionId,
    onSwitch: (sessionId) => void switchChatSession(sessionId),
    onNew: () => startNewChatSession(),
    onDeleted: (sessionId) => {
      // 删除的是活跃会话：当前面板内容的事实源（轨迹）已移除，开新会话兜底
      if (sessionId === chatController.sessionId) startNewChatSession();
    },
  });
  sessionList.root.style.display = "none";

  /** 侧栏四页签切换（AC12 语言热生效时各自重绘文案）。 */
  function activateSideTab(active: "chat" | "sessions" | "context" | "trace"): void {
    chatTab.classList.toggle("dw-tab-active", active === "chat");
    sessionsTab.classList.toggle("dw-tab-active", active === "sessions");
    contextTab.classList.toggle("dw-tab-active", active === "context");
    traceTab.classList.toggle("dw-tab-active", active === "trace");
    chatPanel.root.style.display = active === "chat" ? "flex" : "none";
    sessionList.root.style.display = active === "sessions" ? "flex" : "none";
    contextPanel.root.style.display = active === "context" ? "flex" : "none";
    traceTimeline.root.style.display = active === "trace" ? "flex" : "none";
    if (active === "sessions") void sessionList.refresh();
    if (active === "context") void contextController.refresh();
    if (active === "trace") void traceTimeline.refresh();
  }
  chatTab.addEventListener("click", () => activateSideTab("chat"));
  sessionsTab.addEventListener("click", () => activateSideTab("sessions"));
  contextTab.addEventListener("click", () => activateSideTab("context"));
  traceTab.addEventListener("click", () => activateSideTab("trace"));

  /** 增长 G1+D2：首次强制亮一次上下文面板导览，关闭后顺次亮授权门导览（与向导独立，各仅一次）。 */
  async function scheduleContextTour(): Promise<void> {
    await maybeOpenContextTour({
      api,
      showContextTab: () => activateSideTab("context"),
      showChatTab: () => activateSideTab("chat"),
      highlightTab: (on) => {
        contextTab.classList.toggle("dw-tab-tour-pulse", on);
      },
    });
    // D2 授权门导览：上下文导览关闭后顺次弹出，避免两层遮罩叠压
    await maybeOpenAuthGateTour({ api, showChatTab: () => activateSideTab("chat") });
  }

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
    resolveMcpServer: (serverId) => mcpServers.get(serverId) ?? null,
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

  // agent 事件流：结束后刷新上下文 manifest；用量行同步状态栏（G2 首屏可见）
  api.agent.onEvent((event) => {
    if (event.type === "done" || event.type === "error") void contextController.refresh();
    if (event.type === "usage") {
      const detail = event.detail as {
        inputTokens?: number;
        outputTokens?: number;
        providerId?: string;
        model?: string;
      } | undefined;
      const input = typeof detail?.inputTokens === "number" ? detail.inputTokens : 0;
      const output = typeof detail?.outputTokens === "number" ? detail.outputTokens : 0;
      showStatus(t("act.usage.line", { input, output }));
    }
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
  // AC29：命令毕业进白名单 → 状态栏瞬态提示（差分检测新增条目；null=未初始化不提示）
  let knownWhitelist: string[] | null = null;
  void api.settings.get("security.commandWhitelist").then((stored) => {
    knownWhitelist = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [];
  });
  api.settings.onChanged((key, value) => {
    if (key === "providers") void reloadProviders();
    if (key === "security.commandWhitelist" && Array.isArray(value)) {
      const current = value.filter((x): x is string => typeof x === "string");
      const previous = knownWhitelist;
      const learned = previous === null ? undefined : current.find((x) => !previous.includes(x));
      if (learned !== undefined) showStatus(t("security.learned", { command: learned }));
      knownWhitelist = current;
    }
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
    blameBtn.textContent = t("git.blame");
    activeFileLabel.textContent = openFile?.path ?? t("chrome.noFile");
    settingsBtn.textContent = t("chrome.settings");
    if (workspaceRoot === "") statusWorkspace.textContent = t("status.noWorkspace");
    refreshDirty();
    if (workspaceRoot === "") {
      filesPane.textContent = "";
      filesPane.appendChild(el("div", "dw-sidebar-empty", t("sidebar.empty")));
    } else {
      // 文件树 ↗ 按钮 tooltip 随语言更新（树本身不重建，保留展开/选中状态）
      for (const btn of sidebar.querySelectorAll<HTMLElement>(".dw-tree-external")) {
        btn.title = t("tree.external");
      }
    }
    chatTab.textContent = t("tab.chat");
    sessionsTab.textContent = t("tab.sessions");
    contextTab.textContent = t("tab.context");
    traceTab.textContent = t("tab.trace");
    filesTab.textContent = t("tab.files");
    gitTab.textContent = t("tab.git");
    debugTab.textContent = t("tab.debug");
    outlineTab.textContent = t("tab.outline");
    lspUi.renderOutlineTree(); // 大纲空态文案随语言热生效
    debugPanel.renderDebugStatus(); // 调试状态项随语言热生效
    debugPanel.renderDebugPanel();
    gitPanel.applyLocale();
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
    lspUi.renderLspStatus(); // LSP 状态项随语言热生效
    // 欢迎文档仅在无打开文件时随语言重建（不触碰用户文件内容）
    if (openFile === null) {
      editor.setDocument(TextDocument.fromString(t("editor.welcome")));
    }
    searchPanelHandle.applyLocale();
  }
  onDidChangeLocale(applyLocale);
  applyLocale();

  // ---- 首启触发向导（迭代 18 / AC27）：无模型配置且向导未完成时弹出 ----
  // 向导关闭后再跑上下文导览（增长 G1），避免两层遮罩叠压。
  void (async () => {
    const state = (await api.settings.get("onboarding.state")) as {
      completed?: boolean;
      contextTourSeen?: boolean;
    } | null;
    if (state?.completed === true) {
      await scheduleContextTour();
      return;
    }
    const configured = await api.providers.list();
    if (configured.length > 0) {
      // 老用户升级：已有模型配置，静默标记完成，不打扰现有工作流（保留已有 tour 标记）
      void api.settings.set("onboarding.state", { ...(state ?? {}), completed: true });
      await scheduleContextTour();
      return;
    }
    launchWizard(() => {
      void scheduleContextTour();
    });
  })();
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
