/**
 * DevWit 渲染进程（WU012/WU013 集成 + 迭代 3 / AC12 国际化）。
 * 布局：侧栏文件树 | 自研 Canvas 编辑器（diff 覆盖层） | 对话/上下文面板。
 * 只允许经 window.devwit（preload 白名单）访问主进程能力（AR001/AR004）。
 * 全部界面文案经 @devwit/i18n 词典渲染；启动时从 settings "ui.locale" 恢复语言，
 * 订阅 onDidChangeLocale 全量重写静态文案与动态列表（语言热生效）。
 */
import type { DevwitApi, DebugBreakpoint, DebugScopeItem, DebugStackFrameItem, DebugStateInfo, DebugVariableItem, GitBlameLine, GitBranch, GitPanelStatus, GitStashEntry, LspCodeAction, LspCompletionItem, LspDefinitionTarget, LspDiagnosticItem, LspDocumentSymbol, LspSignatureHelp, LspStatusInfo, LspTextEdit, ModeDefinition, ProviderConfig, UpdateStatusInfo } from "@devwit/contracts";
import { displayModeName, localizeError, onDidChangeLocale, resolveSystemLocale, setLocale, t, ta, type Locale } from "@devwit/i18n";
import { TextDocument } from "@devwit/editor-core";
import { EditorView, normalizeSelection, type BreakpointKind } from "@devwit/editor-render";
import {
  ChatController,
  ContextPanelController,
  DiffController,
  TaskCenter,
  computeDiff,
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
import { openEditorSetupDialog } from "./editor-setup-dialog.js";
import { openOnboardingWizard } from "./onboarding-wizard.js";
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
    void refreshGit(); // 切到面板即取最新（外部 git 操作可能绕过 watcher）
  });
  debugTab.addEventListener("click", () => activateLeftTab("debug"));
  outlineTab.addEventListener("click", () => {
    activateLeftTab("outline");
    void refreshOutline(); // 切到大纲即取最新（文件可能已变更）
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
      activeFileLabel.textContent = file.path;
    }
    closeBlame(); // 切换文件时关闭 blame 覆盖层（行号不再对齐）
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
    void refreshOutline(); // 保存后刷新大纲（落盘后 tsserver 重新分析）
  }
  saveBtn.addEventListener("click", () => void saveActiveFile());
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveActiveFile();
    }
  });

  // ---- 统一设置页（AC12）：通用 / 模型 / 编辑器 / 模式 ----
  /** 首次运行向导（迭代 18 / AC27）：设置页「重跑向导」与首启自动弹出共用入口。 */
  function launchWizard(): void {
    openOnboardingWizard({
      api,
      onProvidersChanged: () => void reloadProviders(),
      onOpenFolder: () => openWorkspace(),
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
    const content = await api.workspace.read(filePath);
    const doc = TextDocument.fromString(content);
    doc.onDidChange(refreshDirty);
    // LSP 文档生命周期（AC40）：关旧（清其诊断快照）→ 开新（缓冲区全文同步）
    if (openFile !== null && workspaceRoot !== "") {
      void api.lsp.didClose(relPathOf(openFile.path));
    }
    hideCompletion(); // 文件切换时关闭补全浮层
    setActiveDoc({ path: filePath, doc });
    syncEditorBreakpoints(); // 断点红点随文件切换重挂（AC42）
    if (workspaceRoot !== "") {
      syncOpenFileToLsp();
      doc.onDidChange(scheduleLspSync);
      doc.onDidChange(scheduleCompletion); // v0.4.0：输入触发自动补全
      doc.onDidChange(scheduleOutlineRefresh); // v0.4.0：编辑触发大纲刷新
      applyEditorDiagnostics(); // 该文件既有诊断立即上波浪线
      void refreshOutline(); // 文件打开即取大纲（LSP 未就绪则空，ready 推送时补偿）
    }
    sidebar.querySelectorAll(".dw-tree-node").forEach((node) => {
      node.classList.toggle("dw-tree-active", (node as HTMLElement).dataset["path"] === filePath);
    });
    editor.focus();
  }

  // ---- LSP 代码智能（迭代 31 / AC40）：悬停 / Ctrl+Click 定义 / 实时诊断 ----
  let lspStatus: LspStatusInfo = { state: "idle" };
  let lspDiags: LspDiagnosticItem[] = [];

  /** 绝对路径 → 工作区相对路径（正斜杠；与 flattenTreeFiles 同一口径）。 */
  function relPathOf(absPath: string): string {
    return absPath.slice(workspaceRoot.length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  }

  function renderLspStatus(): void {
    if (lspStatus.state === "idle") {
      statusLsp.textContent = "";
      return;
    }
    if (lspStatus.state === "starting") {
      statusLsp.textContent = t("lsp.status.starting");
      return;
    }
    if (lspStatus.state === "error") {
      statusLsp.textContent = t("lsp.status.error", { code: lspStatus.code });
      return;
    }
    const errors = lspDiags.filter((d) => d.severity === "error").length;
    const warnings = lspDiags.filter((d) => d.severity === "warning").length;
    statusLsp.textContent = t("lsp.diag.count", { errors: String(errors), warnings: String(warnings) });
  }

  /** 当前文件波浪线（诊断推送与文件切换共用；只取当前文件的诊断）。 */
  function applyEditorDiagnostics(): void {
    if (openFile === null || workspaceRoot === "") {
      editor.setDiagnostics([]);
      return;
    }
    const rel = relPathOf(openFile.path);
    editor.setDiagnostics(lspDiags.filter((d) => d.file === rel));
  }

  /** 活动文档同步给 tsserver（didOpen 全文；服务器未就绪时主进程丢弃，ready 推送时补偿重放）。 */
  function syncOpenFileToLsp(): void {
    if (openFile === null || workspaceRoot === "") return;
    void api.lsp.didOpen(relPathOf(openFile.path), openFile.doc.getText());
  }

  // didChange 防抖 300ms（编辑器缓冲区即事实源，Full 同步语义，未保存内容参与分析）
  let lspSyncTimer: number | undefined;
  function scheduleLspSync(): void {
    window.clearTimeout(lspSyncTimer);
    lspSyncTimer = window.setTimeout(() => {
      if (openFile !== null && workspaceRoot !== "") {
        void api.lsp.didChange(relPathOf(openFile.path), openFile.doc.getText());
      }
    }, 300);
  }

  // 悬停浮层：鼠标驻留 500ms → IPC hover → DOM tooltip；移动/输入/点击/Esc/滚动关闭
  const hoverTip = el("div", "dw-lsp-hover");
  hoverTip.style.display = "none";
  editorArea.appendChild(hoverTip);
  let hoverTimer: number | undefined;
  function hideHover(): void {
    window.clearTimeout(hoverTimer);
    hoverTip.style.display = "none";
  }
  async function showHoverAt(clientX: number, clientY: number): Promise<void> {
    const current = openFile;
    if (current === null || workspaceRoot === "" || lspStatus.state !== "ready") return;
    const pos = editor.positionFromClientPoint(clientX, clientY);
    const info = await api.lsp.hover(relPathOf(current.path), pos.line, pos.character);
    // 驻留期间文件已切换 → 丢弃迟到响应
    if (openFile !== current || info === null || info.text.trim() === "") return;
    const areaRect = editorArea.getBoundingClientRect();
    hoverTip.textContent = info.text;
    hoverTip.style.left = `${clientX - areaRect.left + 14}px`;
    hoverTip.style.top = `${clientY - areaRect.top + 18}px`;
    hoverTip.style.display = "block";
  }
  canvas.addEventListener("mousemove", (ev) => {
    hideHover(); // 任何移动先关闭旧浮层并重置驻留计时
    if (openFile === null || lspStatus.state !== "ready") return;
    const { clientX, clientY } = ev;
    hoverTimer = window.setTimeout(() => void showHoverAt(clientX, clientY), 500);
  });
  canvas.addEventListener("mouseleave", hideHover);
  canvas.addEventListener("mousedown", hideHover);
  canvas.addEventListener("wheel", hideHover);
  window.addEventListener("keydown", hideHover);

  // Ctrl/Cmd+Click 跳转定义：同文件 revealPosition；跨文件打开后定位（0-based 行列直传）
  editor.onDefinitionRequest = (pos) => {
    const current = openFile;
    if (current === null || workspaceRoot === "" || lspStatus.state !== "ready") return;
    const currentRel = relPathOf(current.path);
    void (async () => {
      const targets = await api.lsp.definition(currentRel, pos.line, pos.character);
      const target = targets[0];
      if (target === undefined) return;
      if (target.file === currentRel && openFile === current) {
        editor.revealPosition({ line: target.line, character: target.character });
      } else {
        const abs = `${workspaceRoot.replace(/[/\\]+$/, "")}/${target.file}`;
        await openFileByPath(abs);
        editor.revealPosition({ line: target.line, character: target.character });
      }
    })();
  };

  // ---- LSP 自动补全（v0.4.0）：输入触发 → IPC completion → 浮层 → 键盘/鼠标选择 ----
  const completionPopup = el("div", "dw-completion");
  completionPopup.style.display = "none";
  editorArea.appendChild(completionPopup);
  let completionItems: LspCompletionItem[] = [];
  let completionIndex = 0;
  let completionVisible = false;
  let completionTimer: number | undefined;
  let completionToken = 0; // 竞态保护：迟到响应丢弃

  function hideCompletion(): void {
    window.clearTimeout(completionTimer);
    completionPopup.style.display = "none";
    completionVisible = false;
    completionItems = [];
    completionIndex = 0;
  }

  /** 当前光标位置的单词起始列（标识符字符 [a-zA-Z0-9_$] 回扫）。 */
  function wordStartCharAt(line: number, character: number): number {
    const text = openFile?.doc.getLine(line) ?? "";
    let i = character;
    while (i > 0 && /[a-zA-Z0-9_$]/.test(text[i - 1]!)) i--;
    return i;
  }

  function renderCompletionPopup(): void {
    if (completionItems.length === 0 || openFile === null) {
      hideCompletion();
      return;
    }
    const items = completionItems.slice(0, 50); // 上限 50 防巨列表
    completionPopup.innerHTML = "";
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const row = el("div", "dw-completion-item");
      if (i === completionIndex) row.classList.add("dw-completion-active");
      const label = el("span", "dw-completion-label");
      label.textContent = item.label;
      row.appendChild(label);
      if (item.detail) {
        const detail = el("span", "dw-completion-detail");
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        completionIndex = i;
        applyCompletion();
      });
      completionPopup.appendChild(row);
    }
    // 定位浮层到光标下方
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      completionPopup.style.left = `${pt.x - areaRect.left}px`;
      completionPopup.style.top = `${pt.y - areaRect.top + 18}px`;
    }
    completionPopup.style.display = "block";
    completionVisible = true;
  }

  async function requestCompletion(): Promise<void> {
    const current = openFile;
    if (current === null || workspaceRoot === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++completionToken;
    const items = await api.lsp.completion(relPathOf(current.path), pos.line, pos.character);
    // 迟到响应丢弃（文件已切换或光标已移动）
    if (completionToken !== token || openFile !== current) return;
    const after = editor.getSelections().at(-1);
    if (after === undefined || after.active.line !== pos.line || after.active.character !== pos.character) return;
    completionItems = items;
    completionIndex = 0;
    renderCompletionPopup();
  }

  function scheduleCompletion(): void {
    if (openFile === null || workspaceRoot === "" || lspStatus.state !== "ready") return;
    window.clearTimeout(completionTimer);
    completionTimer = window.setTimeout(() => void requestCompletion(), 250);
  }

  /** 应用选中的补全项：替换单词范围为 insertText（缺省 label）。 */
  function applyCompletion(): void {
    if (!completionVisible || completionItems.length === 0) return;
    const item = completionItems[completionIndex];
    if (item === undefined || openFile === null) return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const startChar = wordStartCharAt(pos.line, pos.character);
    const text = item.insertText ?? item.label;
    const startOffset = openFile.doc.offsetAt({ line: pos.line, character: startChar });
    const endOffset = openFile.doc.offsetAt({ line: pos.line, character: pos.character });
    openFile.doc.applyEdit({ offset: startOffset, length: endOffset - startOffset, text });
    const newPos = openFile.doc.positionAt(startOffset + text.length);
    editor.revealPosition(newPos);
    hideCompletion();
  }

  // 键盘导航：浮层可见时拦截 ArrowUp/Down/Enter/Tab/Esc（capture 阶段先于编辑器）
  window.addEventListener("keydown", (ev) => {
    if (!completionVisible) return;
    const count = Math.min(completionItems.length, 50);
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        ev.stopPropagation();
        completionIndex = (completionIndex + 1) % count;
        renderCompletionPopup();
        break;
      case "ArrowUp":
        ev.preventDefault();
        ev.stopPropagation();
        completionIndex = (completionIndex - 1 + count) % count;
        renderCompletionPopup();
        break;
      case "Enter":
      case "Tab":
        ev.preventDefault();
        ev.stopPropagation();
        applyCompletion();
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        hideCompletion();
        break;
    }
  }, true);
  canvas.addEventListener("mousedown", hideCompletion);

  // ---- LSP 引用查找（v0.4.0）：Shift+F12 触发 → IPC references → 浮层列表 → 跳转 ----
  const referencesPopup = el("div", "dw-references");
  referencesPopup.style.display = "none";
  editorArea.appendChild(referencesPopup);
  let referencesItems: LspDefinitionTarget[] = [];
  let referencesIndex = 0;
  let referencesVisible = false;
  let referencesToken = 0;

  function hideReferences(): void {
    referencesPopup.style.display = "none";
    referencesVisible = false;
    referencesItems = [];
    referencesIndex = 0;
  }

  function positionReferencesPopup(): void {
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      referencesPopup.style.left = `${pt.x - areaRect.left}px`;
      referencesPopup.style.top = `${pt.y - areaRect.top + 18}px`;
    }
  }

  function renderReferencesPopup(): void {
    if (referencesItems.length === 0 || openFile === null) {
      hideReferences();
      return;
    }
    const items = referencesItems.slice(0, 50);
    referencesPopup.innerHTML = "";
    const header = el("div", "dw-references-header");
    header.textContent = t("lsp.references.count", { n: items.length });
    referencesPopup.appendChild(header);
    const currentRel = relPathOf(openFile.path);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const row = el("div", "dw-references-item");
      if (i === referencesIndex) row.classList.add("dw-references-active");
      const loc = el("span", "dw-references-loc");
      loc.textContent = `${item.file}:${item.line + 1}:${item.character + 1}`;
      row.appendChild(loc);
      if (item.file === currentRel) {
        const lineText = openFile.doc.getLine(item.line) ?? "";
        const preview = el("span", "dw-references-preview");
        preview.textContent = lineText.trim().slice(0, 60);
        row.appendChild(preview);
      }
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        referencesIndex = i;
        applyReferences();
      });
      referencesPopup.appendChild(row);
    }
    positionReferencesPopup();
    referencesPopup.style.display = "block";
    referencesVisible = true;
  }

  async function requestReferences(): Promise<void> {
    const current = openFile;
    if (current === null || workspaceRoot === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++referencesToken;
    const items = await api.lsp.references(relPathOf(current.path), pos.line, pos.character);
    if (referencesToken !== token || openFile !== current) return;
    if (items.length === 0) {
      referencesPopup.innerHTML = "";
      const empty = el("div", "dw-references-empty");
      empty.textContent = t("lsp.references.empty");
      referencesPopup.appendChild(empty);
      positionReferencesPopup();
      referencesPopup.style.display = "block";
      referencesVisible = true;
      window.setTimeout(hideReferences, 1500);
      return;
    }
    referencesItems = items;
    referencesIndex = 0;
    renderReferencesPopup();
  }

  function applyReferences(): void {
    if (!referencesVisible || referencesItems.length === 0) return;
    const target = referencesItems[referencesIndex];
    if (target === undefined) return;
    const current = openFile;
    const currentRel = current !== null ? relPathOf(current.path) : "";
    hideReferences();
    if (target.file === currentRel && current !== null) {
      editor.revealPosition({ line: target.line, character: target.character });
    } else {
      const abs = `${workspaceRoot.replace(/[/\\]+$/, "")}/${target.file}`;
      void openFileByPath(abs).then(() => {
        editor.revealPosition({ line: target.line, character: target.character });
      });
    }
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.shiftKey && ev.key === "F12") {
      ev.preventDefault();
      ev.stopPropagation();
      void requestReferences();
      return;
    }
    if (!referencesVisible) return;
    const count = Math.min(referencesItems.length, 50);
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        ev.stopPropagation();
        referencesIndex = (referencesIndex + 1) % count;
        renderReferencesPopup();
        break;
      case "ArrowUp":
        ev.preventDefault();
        ev.stopPropagation();
        referencesIndex = (referencesIndex - 1 + count) % count;
        renderReferencesPopup();
        break;
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        applyReferences();
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        hideReferences();
        break;
    }
  }, true);
  canvas.addEventListener("mousedown", hideReferences);

  // ---- LSP 签名帮助（v0.4.0）：输入 ( 或 , 触发 → IPC signatureHelp → 浮层显示签名 + 当前参数高亮 ----
  const signaturePopup = el("div", "dw-signature");
  signaturePopup.style.display = "none";
  editorArea.appendChild(signaturePopup);
  let signatureVisible = false;
  let signatureToken = 0;

  function hideSignature(): void {
    signaturePopup.style.display = "none";
    signatureVisible = false;
  }

  function renderSignaturePopup(data: LspSignatureHelp): void {
    const sig = data.signatures[data.activeSignature] ?? data.signatures[0];
    if (sig === undefined) {
      hideSignature();
      return;
    }
    signaturePopup.innerHTML = "";
    const label = el("div", "dw-signature-label");
    const activeParam = sig.parameters[data.activeParameter];
    if (activeParam !== undefined && activeParam.label.length > 0 && sig.label.includes(activeParam.label)) {
      const idx = sig.label.indexOf(activeParam.label);
      label.textContent = sig.label.slice(0, idx);
      const bold = el("b", "dw-signature-active");
      bold.textContent = activeParam.label;
      label.appendChild(bold);
      label.appendChild(document.createTextNode(sig.label.slice(idx + activeParam.label.length)));
    } else {
      label.textContent = sig.label;
    }
    signaturePopup.appendChild(label);
    if (activeParam?.documentation) {
      const doc = el("div", "dw-signature-doc");
      doc.textContent = activeParam.documentation;
      signaturePopup.appendChild(doc);
    }
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      signaturePopup.style.left = `${pt.x - areaRect.left}px`;
      signaturePopup.style.top = `${pt.y - areaRect.top + 18}px`;
    }
    signaturePopup.style.display = "block";
    signatureVisible = true;
  }

  async function requestSignature(): Promise<void> {
    const current = openFile;
    if (current === null || workspaceRoot === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++signatureToken;
    const data = await api.lsp.signatureHelp(relPathOf(current.path), pos.line, pos.character);
    if (signatureToken !== token || openFile !== current) return;
    if (data === null) {
      hideSignature();
      return;
    }
    renderSignaturePopup(data);
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "(" || ev.key === ",") {
      if (openFile !== null) window.setTimeout(() => void requestSignature(), 50);
      return;
    }
    if (ev.key === ")") {
      hideSignature();
      return;
    }
    if (ev.key === "Escape" && signatureVisible) {
      ev.preventDefault();
      ev.stopPropagation();
      hideSignature();
    }
  }, true);
  canvas.addEventListener("mousedown", hideSignature);

  // ---- LSP 符号重命名（v0.4.0）：F2 触发 → 输入框 → 调用 rename → 跨文件应用编辑 ----
  const renameBox = el("div", "dw-rename");
  renameBox.style.display = "none";
  editorArea.appendChild(renameBox);
  const renameInput = document.createElement("input");
  renameInput.type = "text";
  renameInput.className = "dw-rename-input";
  renameInput.placeholder = "New name";
  renameBox.appendChild(renameInput);
  let renameVisible = false;
  let renameToken = 0;

  function hideRename(): void {
    renameBox.style.display = "none";
    renameVisible = false;
    renameInput.value = "";
  }

  function showRenameBox(currentName: string): void {
    renameInput.value = currentName;
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      renameBox.style.left = `${pt.x - areaRect.left}px`;
      renameBox.style.top = `${pt.y - areaRect.top + 18}px`;
    }
    renameBox.style.display = "block";
    renameVisible = true;
    renameInput.focus();
    renameInput.select();
  }

  async function applyRename(newName: string): Promise<void> {
    const current = openFile;
    if (current === null || workspaceRoot === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++renameToken;
    const edits = await api.lsp.rename(relPathOf(current.path), pos.line, pos.character, newName);
    if (renameToken !== token || openFile !== current) return;
    hideRename();
    if (edits.length === 0) return;

    // 按 file 分组
    const byFile = new Map<string, LspTextEdit[]>();
    for (const edit of edits) {
      const arr = byFile.get(edit.file) ?? [];
      arr.push(edit);
      byFile.set(edit.file, arr);
    }

    const currentRel = relPathOf(current.path);
    const root = workspaceRoot.replace(/[/\\]+$/, "");

    for (const [file, fileEdits] of byFile) {
      if (file === currentRel) {
        // 当前文件：用 applyEdit（按 offset 倒序，避免位置偏移）
        const doc = current.doc;
        const sorted = fileEdits.slice().sort((a, b) => {
          const ao = doc.offsetAt({ line: a.startLine, character: a.startCharacter });
          const bo = doc.offsetAt({ line: b.startLine, character: b.startCharacter });
          return bo - ao;
        });
        for (const edit of sorted) {
          const startOffset = doc.offsetAt({ line: edit.startLine, character: edit.startCharacter });
          const endOffset = doc.offsetAt({ line: edit.endLine, character: edit.endCharacter });
          doc.applyEdit({ offset: startOffset, length: endOffset - startOffset, text: edit.newText });
        }
      } else {
        // 其他文件：read → 字符串编辑 → write（跨文件重构）
        const abs = `${root}/${file}`;
        try {
          const content = await api.workspace.read(abs);
          const lineStarts: number[] = [0];
          for (let i = 0; i < content.length; i++) {
            if (content[i] === "\n") lineStarts.push(i + 1);
          }
          const sorted = fileEdits.slice().sort((a, b) => {
            const ao = (lineStarts[a.startLine] ?? 0) + a.startCharacter;
            const bo = (lineStarts[b.startLine] ?? 0) + b.startCharacter;
            return bo - ao;
          });
          let text = content;
          for (const edit of sorted) {
            const startOffset = (lineStarts[edit.startLine] ?? 0) + edit.startCharacter;
            const endOffset = (lineStarts[edit.endLine] ?? 0) + edit.endCharacter;
            text = text.slice(0, startOffset) + edit.newText + text.slice(endOffset);
          }
          await api.workspace.write(abs, text);
        } catch {
          // 读取/写入失败：跳过该文件（跨文件编辑容错）
        }
      }
    }
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "F2" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (openFile === null || lspStatus.state !== "ready") return;
      ev.preventDefault();
      ev.stopPropagation();
      const sel = editor.getSelections().at(-1);
      if (sel === undefined) return;
      const pos = sel.active;
      const lineText = openFile.doc.getLine(pos.line) ?? "";
      let start = pos.character;
      let end = pos.character;
      while (start > 0 && /[\w$]/.test(lineText[start - 1] ?? "")) start--;
      while (end < lineText.length && /[\w$]/.test(lineText[end] ?? "")) end++;
      const currentName = lineText.slice(start, end);
      if (currentName.length === 0) return;
      showRenameBox(currentName);
      return;
    }
    if (!renameVisible) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      const newName = renameInput.value.trim();
      if (newName.length === 0) {
        hideRename();
        return;
      }
      void applyRename(newName);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      hideRename();
    }
  }, true);
  canvas.addEventListener("mousedown", hideRename);

  // ---- LSP 代码操作（v0.4.0）：Ctrl+. 触发 → 菜单浮层 → 选择 → 应用编辑 ----
  const codeActionPopup = el("div", "dw-code-action");
  codeActionPopup.style.display = "none";
  editorArea.appendChild(codeActionPopup);
  let codeActionItems: LspCodeAction[] = [];
  let codeActionIndex = 0;
  let codeActionVisible = false;
  let codeActionToken = 0;

  function hideCodeAction(): void {
    codeActionPopup.style.display = "none";
    codeActionVisible = false;
    codeActionItems = [];
    codeActionIndex = 0;
  }

  function renderCodeActionPopup(): void {
    if (codeActionItems.length === 0 || openFile === null) {
      hideCodeAction();
      return;
    }
    codeActionPopup.innerHTML = "";
    for (let i = 0; i < codeActionItems.length; i++) {
      const item = codeActionItems[i]!;
      const row = el("div", "dw-code-action-item");
      if (i === codeActionIndex) row.classList.add("dw-code-action-active");
      const title = el("span", "dw-code-action-title");
      title.textContent = (item.isPreferred ? "★ " : "") + item.title;
      row.appendChild(title);
      if (item.kind) {
        const kind = el("span", "dw-code-action-kind");
        kind.textContent = item.kind;
        row.appendChild(kind);
      }
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        codeActionIndex = i;
        void applyCodeAction();
      });
      codeActionPopup.appendChild(row);
    }
    const sel = editor.getSelections().at(-1);
    if (sel !== undefined) {
      const pt = editor.clientPointForPosition(sel.active);
      const areaRect = editorArea.getBoundingClientRect();
      codeActionPopup.style.left = `${pt.x - areaRect.left}px`;
      codeActionPopup.style.top = `${pt.y - areaRect.top + 18}px`;
    }
    codeActionPopup.style.display = "block";
    codeActionVisible = true;
  }

  async function applyCodeAction(): Promise<void> {
    if (!codeActionVisible || codeActionItems.length === 0) return;
    const action = codeActionItems[codeActionIndex];
    if (action === undefined) return;
    hideCodeAction();
    if (action.edits.length === 0) return; // 仅 command，暂不支持执行

    // 复用 rename 的跨文件编辑应用逻辑
    const current = openFile;
    if (current === null) return;
    const byFile = new Map<string, LspTextEdit[]>();
    for (const edit of action.edits) {
      const arr = byFile.get(edit.file) ?? [];
      arr.push(edit);
      byFile.set(edit.file, arr);
    }
    const currentRel = relPathOf(current.path);
    const root = workspaceRoot.replace(/[/\\]+$/, "");
    for (const [file, fileEdits] of byFile) {
      if (file === currentRel) {
        const doc = current.doc;
        const sorted = fileEdits.slice().sort((a, b) => {
          const ao = doc.offsetAt({ line: a.startLine, character: a.startCharacter });
          const bo = doc.offsetAt({ line: b.startLine, character: b.startCharacter });
          return bo - ao;
        });
        for (const edit of sorted) {
          const startOffset = doc.offsetAt({ line: edit.startLine, character: edit.startCharacter });
          const endOffset = doc.offsetAt({ line: edit.endLine, character: edit.endCharacter });
          doc.applyEdit({ offset: startOffset, length: endOffset - startOffset, text: edit.newText });
        }
      } else {
        const abs = `${root}/${file}`;
        try {
          const content = await api.workspace.read(abs);
          const lineStarts: number[] = [0];
          for (let i = 0; i < content.length; i++) {
            if (content[i] === "\n") lineStarts.push(i + 1);
          }
          const sorted = fileEdits.slice().sort((a, b) => {
            const ao = (lineStarts[a.startLine] ?? 0) + a.startCharacter;
            const bo = (lineStarts[b.startLine] ?? 0) + b.startCharacter;
            return bo - ao;
          });
          let text = content;
          for (const edit of sorted) {
            const startOffset = (lineStarts[edit.startLine] ?? 0) + edit.startCharacter;
            const endOffset = (lineStarts[edit.endLine] ?? 0) + edit.endCharacter;
            text = text.slice(0, startOffset) + edit.newText + text.slice(endOffset);
          }
          await api.workspace.write(abs, text);
        } catch {
          // 跨文件编辑容错
        }
      }
    }
  }

  async function requestCodeAction(): Promise<void> {
    const current = openFile;
    if (current === null || workspaceRoot === "" || lspStatus.state !== "ready") return;
    const sel = editor.getSelections().at(-1);
    if (sel === undefined) return;
    const pos = sel.active;
    const token = ++codeActionToken;
    const actions = await api.lsp.codeAction(relPathOf(current.path), pos.line, pos.character, pos.line, pos.character);
    if (codeActionToken !== token || openFile !== current) return;
    if (actions.length === 0) {
      hideCodeAction();
      return;
    }
    codeActionItems = actions;
    codeActionIndex = 0;
    renderCodeActionPopup();
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "." && ev.ctrlKey && !ev.shiftKey && !ev.metaKey && !ev.altKey) {
      if (openFile === null || lspStatus.state !== "ready") return;
      ev.preventDefault();
      ev.stopPropagation();
      void requestCodeAction();
      return;
    }
    if (!codeActionVisible) return;
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        ev.stopPropagation();
        codeActionIndex = (codeActionIndex + 1) % codeActionItems.length;
        renderCodeActionPopup();
        break;
      case "ArrowUp":
        ev.preventDefault();
        ev.stopPropagation();
        codeActionIndex = (codeActionIndex - 1 + codeActionItems.length) % codeActionItems.length;
        renderCodeActionPopup();
        break;
      case "Enter":
        ev.preventDefault();
        ev.stopPropagation();
        void applyCodeAction();
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        hideCodeAction();
        break;
    }
  }, true);
  canvas.addEventListener("mousedown", hideCodeAction);

  // ---- LSP 文档大纲（v0.4.0）：textDocument/documentSymbol → 左栏树 → 点击跳转 ----
  let outlineSymbols: LspDocumentSymbol[] = [];
  let outlineToken = 0;
  /** 展开状态以「line:character:kind」签名记录（同文件内符号位置稳定即可） */
  const outlineCollapsed = new Set<string>();

  function outlineKey(s: LspDocumentSymbol): string {
    return `${s.line}:${s.character}:${s.kind}`;
  }

  /** 符号 kind → 图标字符（LSP SymbolKind 子集；缺省=•）。 */
  function outlineIcon(kind: number): string {
    switch (kind) {
      case 2: return "⊙"; // Module
      case 3: return "▣"; // Namespace
      case 4: return "_pkg"; // Package
      case 5: return "◯"; // Class
      case 6: return "ƒ"; // Method
      case 7: return "◇"; // Property
      case 8: return "▪"; // Field
      case 9: return "ctr"; // Constructor
      case 10: return "Enum"; // Enum
      case 11: return "I"; // Interface
      case 12: return "λ"; // Function
      case 13: return "var"; // Variable
      case 14: return "K"; // Constant
      case 15: return "S"; // String
      case 16: return "#"; // Number
      case 17: return "_BOOL"; // Boolean
      case 18: return "[]"; // Array
      case 19: return "{}"; // Object
      case 23: return "struct"; // Struct
      case 24: return "evt"; // Event
      case 25: return "op"; // Operator
      case 26: return "T"; // TypeParameter
      default: return "•";
    }
  }

  function renderOutlineTree(): void {
    outlinePane.innerHTML = "";
    if (outlineSymbols.length === 0) {
      outlinePane.appendChild(el("div", "dw-sidebar-empty", t("outline.empty")));
      return;
    }
    const root = el("div", "dw-outline-list");
    const renderNode = (sym: LspDocumentSymbol, depth: number): void => {
      const hasChildren = sym.children !== undefined && sym.children.length > 0;
      const key = outlineKey(sym);
      const collapsed = outlineCollapsed.has(key);
      const row = el("div", "dw-outline-item");
      row.style.paddingLeft = `${8 + depth * 14}px`;
      if (hasChildren) {
        const toggle = el("span", "dw-outline-toggle");
        toggle.textContent = collapsed ? "▸" : "▾";
        toggle.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (outlineCollapsed.has(key)) outlineCollapsed.delete(key);
          else outlineCollapsed.add(key);
          renderOutlineTree();
        });
        row.appendChild(toggle);
      } else {
        row.appendChild(el("span", "dw-outline-toggle dw-outline-toggle-leaf"));
      }
      const icon = el("span", "dw-outline-icon");
      icon.textContent = outlineIcon(sym.kind);
      row.appendChild(icon);
      const name = el("span", "dw-outline-name");
      if (sym.deprecated === true) name.classList.add("dw-outline-deprecated");
      name.textContent = sym.name;
      row.appendChild(name);
      if (sym.detail !== undefined && sym.detail !== "") {
        const detail = el("span", "dw-outline-detail");
        detail.textContent = sym.detail;
        row.appendChild(detail);
      }
      row.addEventListener("click", () => {
        const current = openFile;
        if (current === null) return;
        editor.revealPosition({ line: sym.line, character: sym.character });
        editor.focus();
      });
      root.appendChild(row);
      if (hasChildren && !collapsed) {
        for (const child of sym.children!) renderNode(child, depth + 1);
      }
    };
    for (const sym of outlineSymbols) renderNode(sym, 0);
    outlinePane.appendChild(root);
  }

  async function refreshOutline(): Promise<void> {
    const current = openFile;
    if (current === null || workspaceRoot === "" || lspStatus.state !== "ready") {
      outlineSymbols = [];
      renderOutlineTree();
      return;
    }
    const token = ++outlineToken;
    const symbols = await api.lsp.documentSymbols(relPathOf(current.path));
    if (outlineToken !== token || openFile !== current) return;
    outlineSymbols = symbols;
    renderOutlineTree();
  }

  // 编辑防抖触发大纲刷新（与 didChange 同步节奏，避免输入时树闪烁）
  let outlineRefreshTimer: number | undefined;
  function scheduleOutlineRefresh(): void {
    window.clearTimeout(outlineRefreshTimer);
    outlineRefreshTimer = window.setTimeout(() => void refreshOutline(), 600);
  }

  renderOutlineTree(); // 启动即渲染空态占位（文件打开/LSP 就绪后填充）

  api.lsp.onStatus((status) => {
    const wasReady = lspStatus.state === "ready";
    lspStatus = status;
    renderLspStatus();
    // 服务器后于文件打开才就绪：补偿重放 didOpen（未就绪期间的 didOpen 被主进程丢弃）
    if (!wasReady && status.state === "ready") {
      syncOpenFileToLsp();
      void refreshOutline(); // 服务器就绪后立即取大纲
    }
  });
  api.lsp.onDiagnostics((items) => {
    lspDiags = items;
    renderLspStatus();
    applyEditorDiagnostics();
  });
  // 启动恢复（AC15 工作区恢复后主进程已启动 LSP）：主动拉一次当前态
  void api.lsp.getStatus().then((status) => {
    lspStatus = status;
    renderLspStatus();
  });
  void api.lsp.diagnostics().then((items) => {
    lspDiags = items;
    renderLspStatus();
    applyEditorDiagnostics();
  });

  // ---- Git 版本控制（迭代 32 / AC41）：面板 / 状态栏 / 只读 diff 视图 ----
  let gitStatus: GitPanelStatus | null = null;
  let gitDiffOverlay: HTMLElement | null = null;
  let gitDiffTitleSpan: HTMLElement | null = null;
  let gitDiffFile: string | null = null;
  let branchDropdown: HTMLElement | null = null;
  let blameOverlay: HTMLElement | null = null;
  let blameActive = false;

  /** 状态栏 git 项：branch 常驻（git 工作区），变更计数 >0 时追加。 */
  function renderGitStatus(): void {
    if (gitStatus === null || workspaceRoot === "") {
      statusGit.textContent = "";
      return;
    }
    const count = gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length;
    statusGit.textContent =
      count === 0 ? `⑂ ${gitStatus.branch}` : t("status.git", { branch: gitStatus.branch, count: String(count) });
  }

  /** 徽章字母：untracked 的 "?" 统一显示为 U（与 VS Code 同口径）。 */
  function gitBadgeLetter(status: string): string {
    return status === "?" ? "U" : status;
  }

  function renderGitGroup(
    parent: HTMLElement,
    title: string,
    items: Array<{ path: string; status: string }>,
    action: "stage" | "unstage"
  ): void {
    if (items.length === 0) return;
    const group = el("div", "dw-git-group");
    group.appendChild(el("div", "dw-git-group-title", `${title} (${items.length})`));
    for (const item of items) {
      const row = el("div", "dw-git-row");
      const badge = el("span", `dw-git-badge dw-git-badge-${gitBadgeLetter(item.status)}`, gitBadgeLetter(item.status));
      const name = el("span", "dw-git-path", item.path);
      name.title = item.path;
      const actionBtn = el("button", "dw-git-action", action === "stage" ? "+" : "−");
      actionBtn.title = t(action === "stage" ? "git.stage" : "git.unstage");
      actionBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void (action === "stage" ? doGitOp(() => api.git.stage(item.path)) : doGitOp(() => api.git.unstage(item.path)));
      });
      row.append(badge, name, actionBtn);
      row.addEventListener("click", () => void openGitDiff(item.path));
      group.appendChild(row);
    }
    parent.appendChild(group);
  }

  /** stage/unstage 操作统一入口：失败本地化提示；成功由 git:changed 推送刷新面板。 */
  async function doGitOp(op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  function renderGitPanel(): void {
    gitPane.textContent = "";
    const head = el("div", "dw-git-head");
    const branchSpan = el(
      "span",
      "dw-git-branch",
      gitStatus !== null && workspaceRoot !== "" ? `⑂ ${gitStatus.branch}` : ""
    );
    if (gitStatus !== null && workspaceRoot !== "") {
      branchSpan.classList.add("dw-git-branch-clickable");
      branchSpan.title = t("git.branch.title");
      branchSpan.addEventListener("click", () => void toggleBranchDropdown(branchSpan));
    }
    head.append(branchSpan);
    const refreshBtn = el("button", "dw-btn dw-btn-small", t("git.refresh"));
    refreshBtn.addEventListener("click", () => void refreshGit());
    head.appendChild(refreshBtn);
    gitPane.appendChild(head);

    if (workspaceRoot === "" || gitStatus === null) {
      gitPane.appendChild(el("div", "dw-sidebar-empty", t("git.notRepo")));
      return;
    }
    const body = el("div", "dw-git-body");
    gitPane.appendChild(body);
    const total = gitStatus.staged.length + gitStatus.unstaged.length + gitStatus.untracked.length;
    if (total === 0) {
      body.appendChild(el("div", "dw-sidebar-empty", t("git.clean")));
    }
    renderGitGroup(body, t("git.staged"), gitStatus.staged, "unstage");
    renderGitGroup(body, t("git.changes"), gitStatus.unstaged, "stage");
    renderGitGroup(body, t("git.untracked"), gitStatus.untracked, "stage");

    const foot = el("div", "dw-git-foot");
    const commitInput = el("input", "dw-git-commit-input");
    commitInput.placeholder = t("git.commitPlaceholder");
    const commitBtn = el("button", "dw-btn dw-btn-small dw-btn-primary", t("git.commit"));
    commitBtn.disabled = gitStatus.staged.length === 0;
    const doCommit = async (): Promise<void> => {
      const message = commitInput.value.trim();
      if (message === "") return;
      commitBtn.disabled = true;
      try {
        await api.git.commit(message);
        commitInput.value = "";
        showStatus(t("git.commitDone"));
      } catch (error) {
        showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
        commitBtn.disabled = false;
      }
    };
    commitBtn.addEventListener("click", () => void doCommit());
    commitInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void doCommit();
    });
    foot.append(commitInput, commitBtn);
    gitPane.appendChild(foot);

    // Stash 区（v0.4.0）：暂存按钮 + 暂存列表
    const stashBox = el("div", "dw-git-stash");
    const stashHead = el("div", "dw-git-stash-head");
    stashHead.appendChild(el("span", "dw-git-stash-title", t("git.stash.title")));
    const stashPushBtn = el("button", "dw-btn dw-btn-small", t("git.stash.push"));
    stashPushBtn.disabled = total === 0;
    stashPushBtn.addEventListener("click", () => void doStashPush());
    stashHead.appendChild(stashPushBtn);
    stashBox.appendChild(stashHead);
    const stashList = el("div", "dw-git-stash-list");
    stashBox.appendChild(stashList);
    gitPane.appendChild(stashBox);
    void refreshStashList(stashList);
  }

  /** 暂存当前变更（v0.4.0）。 */
  async function doStashPush(): Promise<void> {
    try {
      await api.git.stashPush();
      showStatus(t("git.stash.push"));
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  /** 刷新暂存列表（v0.4.0）：操作后渲染端自查 git:changed 推送会重建面板，此函数填充列表内容。 */
  async function refreshStashList(container: HTMLElement): Promise<void> {
    let entries: GitStashEntry[];
    try {
      entries = await api.git.listStash();
    } catch {
      return;
    }
    container.textContent = "";
    if (entries.length === 0) {
      container.appendChild(el("div", "dw-sidebar-empty", t("git.stash.empty")));
      return;
    }
    for (const entry of entries) {
      const row = el("div", "dw-git-stash-row");
      const msg = el("span", "dw-git-stash-msg", entry.message);
      msg.title = entry.message;
      const popBtn = el("button", "dw-git-action", "↧");
      popBtn.title = t("git.stash.pop");
      popBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void doGitOp(() => api.git.stashPop(entry.index));
      });
      const applyBtn = el("button", "dw-git-action", "↦");
      applyBtn.title = t("git.stash.apply");
      applyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void doGitOp(() => api.git.stashApply(entry.index));
      });
      const dropBtn = el("button", "dw-git-action", "✕");
      dropBtn.title = t("git.stash.drop");
      dropBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (window.confirm(t("git.stash.dropConfirm", { index: String(entry.index) }))) {
          void doGitOp(() => api.git.stashDrop(entry.index));
        }
      });
      row.append(msg, popBtn, applyBtn, dropBtn);
      container.appendChild(row);
    }
  }

  /** 只读 git diff 视图（HEAD ↔ 工作区）：复用 dw-diff 样式与 computeDiff 纯逻辑，无接受/拒绝语义。 */
  async function openGitDiff(relPath: string): Promise<void> {
    closeGitDiff();
    let texts: { original: string; modified: string };
    try {
      texts = await api.git.diff(relPath);
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
      return;
    }
    const computation = computeDiff(texts.original, texts.modified);
    gitDiffFile = relPath;
    gitDiffOverlay = el("div", "dw-diff-overlay");
    const box = el("div", "dw-diff");
    const header = el("div", "dw-diff-header");
    gitDiffTitleSpan = el("span", undefined, t("git.diffTitle", { file: relPath }));
    const closeBtn = el("button", "dw-btn dw-btn-small", t("git.diffClose"));
    closeBtn.addEventListener("click", closeGitDiff);
    header.append(gitDiffTitleSpan, closeBtn);
    const body = el("div", "dw-diff-body");
    for (const segment of computation.segments) {
      if (segment.kind === "context") {
        for (const text of segment.lines) {
          body.appendChild(el("div", "dw-diff-line dw-diff-context", `  ${text}`));
        }
      } else {
        for (const line of segment.hunk.lines) {
          body.appendChild(
            el(
              "div",
              line.kind === "add" ? "dw-diff-line dw-diff-add" : "dw-diff-line dw-diff-remove",
              `${line.kind === "add" ? "+" : "-"} ${line.text}`
            )
          );
        }
      }
    }
    box.append(header, body);
    gitDiffOverlay.appendChild(box);
    editorArea.appendChild(gitDiffOverlay);
  }
  function closeGitDiff(): void {
    gitDiffOverlay?.remove();
    gitDiffOverlay = null;
    gitDiffTitleSpan = null;
    gitDiffFile = null;
  }

  /** 关闭 blame 覆盖层（v0.4.0）。 */
  function closeBlame(): void {
    blameOverlay?.remove();
    blameOverlay = null;
    blameActive = false;
    blameBtn.classList.remove("dw-btn-active");
  }

  /**
   * 切换 blame 覆盖层（v0.4.0）：点击 Blame 按钮 → 加载逐行注解 → 覆盖层展示。
   * 需打开文件且工作区为 git 仓库；再点关闭。
   */
  async function toggleBlame(): Promise<void> {
    if (blameActive) {
      closeBlame();
      return;
    }
    if (openFile === null || workspaceRoot === "") {
      showStatus(t("status.openFileFirst"));
      return;
    }
    const rel = relPathOf(openFile.path);
    blameBtn.classList.add("dw-btn-active");
    blameActive = true;
    // 加载中占位
    const loading = el("div", "dw-blame-overlay");
    loading.appendChild(el("div", "dw-blame-loading", t("git.blame.loading")));
    editorArea.appendChild(loading);
    blameOverlay = loading;
    let lines: GitBlameLine[];
    try {
      lines = await api.git.blame(rel);
    } catch {
      closeBlame();
      return;
    }
    if (!blameActive) return; // 加载期间被关闭
    loading.textContent = "";
    if (lines.length === 0) {
      loading.appendChild(el("div", "dw-blame-loading", t("git.blame.empty")));
      return;
    }
    // 按行号排序构建注解列
    const byLine = new Map<number, GitBlameLine>();
    for (const bl of lines) byLine.set(bl.line, bl);
    const doc = editor.document;
    const totalLines = doc.lineCount;
    const col = el("div", "dw-blame-col");
    for (let i = 1; i <= totalLines; i += 1) {
      const bl = byLine.get(i);
      const row = el("div", "dw-blame-row");
      if (bl === undefined) {
        row.appendChild(el("span", "dw-blame-hash", "·······"));
        row.appendChild(el("span", "dw-blame-author", "—"));
        row.appendChild(el("span", "dw-blame-date", ""));
      } else {
        row.appendChild(el("span", "dw-blame-hash", bl.hash));
        row.appendChild(el("span", "dw-blame-author", bl.author));
        row.appendChild(el("span", "dw-blame-date", bl.date));
        row.title = `${bl.hash} ${bl.author} ${bl.date}\n${bl.summary}`;
      }
      col.appendChild(row);
    }
    loading.appendChild(col);
  }
  blameBtn.addEventListener("click", () => void toggleBlame());

  /** 关闭分支下拉弹层（v0.4.0 Git 分支管理）。 */
  function closeBranchDropdown(): void {
    branchDropdown?.remove();
    branchDropdown = null;
  }

  /**
   * 切换分支下拉弹层：点击分支名展开，再次点击或外部点击关闭。
   * 弹层包含分支列表（当前分支高亮）、新建分支输入、删除按钮。
   * 定位锚定到分支名 span 的屏幕坐标，使用 fixed 定位脱离侧栏滚动。
   */
  async function toggleBranchDropdown(anchor: HTMLElement): Promise<void> {
    if (branchDropdown !== null) {
      closeBranchDropdown();
      return;
    }
    let branches: GitBranch[];
    try {
      branches = await api.git.listBranches();
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (branchDropdown !== null) {
      closeBranchDropdown();
      return;
    }
    const popup = el("div", "dw-branch-dropdown");
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 2}px`;

    const list = el("div", "dw-branch-list");
    if (branches.length === 0) {
      list.appendChild(el("div", "dw-branch-empty", t("git.branch.empty")));
    }
    for (const br of branches) {
      const row = el("div", "dw-branch-row");
      if (br.current) row.classList.add("dw-branch-row-current");
      const mark = el("span", "dw-branch-mark", br.current ? "●" : "");
      const name = el("span", "dw-branch-name", br.name);
      row.append(mark, name);
      if (!br.current) {
        const delBtn = el("button", "dw-branch-del", "✕");
        delBtn.title = t("git.branch.delete");
        delBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void deleteBranch(br.name);
        });
        row.appendChild(delBtn);
        row.addEventListener("click", () => void checkoutBranch(br.name));
      } else {
        const cur = el("span", "dw-branch-current-tag", t("git.branch.current"));
        row.appendChild(cur);
      }
      list.appendChild(row);
    }
    popup.appendChild(list);

    // 新建分支输入区
    const createBox = el("div", "dw-branch-create");
    const input = el("input", "dw-branch-create-input");
    input.placeholder = t("git.branch.createPlaceholder");
    const createBtn = el("button", "dw-btn dw-btn-small dw-btn-primary", t("git.branch.create"));
    const doCreate = (): void => {
      const name = input.value.trim();
      if (name === "") return;
      void createBranch(name, true);
    };
    createBtn.addEventListener("click", doCreate);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") doCreate();
      if (ev.key === "Escape") closeBranchDropdown();
    });
    createBox.append(input, createBtn);
    popup.appendChild(createBox);

    document.body.appendChild(popup);
    branchDropdown = popup;
    input.focus();

    // 外部点击关闭（下一帧生效，避免吞掉当前点击事件）
    window.setTimeout(() => {
      const onDown = (ev: MouseEvent): void => {
        if (branchDropdown === null) return;
        if (branchDropdown.contains(ev.target as Node)) return;
        if (anchor.contains(ev.target as Node)) return;
        closeBranchDropdown();
        document.removeEventListener("mousedown", onDown, true);
      };
      document.addEventListener("mousedown", onDown, true);
    }, 0);
  }

  async function checkoutBranch(name: string): Promise<void> {
    closeBranchDropdown();
    try {
      await api.git.checkout(name);
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  async function createBranch(name: string, doCheckout: boolean): Promise<void> {
    try {
      await api.git.createBranch(name, doCheckout);
      closeBranchDropdown();
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  async function deleteBranch(name: string): Promise<void> {
    if (!window.confirm(t("git.branch.deleteConfirm", { name }))) return;
    try {
      await api.git.deleteBranch(name);
      // 刷新下拉弹层内的分支列表（不关闭，便于连续删除）
      if (branchDropdown !== null) {
        closeBranchDropdown();
        await reopenBranchDropdown();
      }
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  /** 删除分支后重建弹层：复用 git 头部的分支 span 作为锚点。 */
  async function reopenBranchDropdown(): Promise<void> {
    const anchor = gitPane.querySelector<HTMLElement>(".dw-git-branch");
    if (anchor !== null) {
      await toggleBranchDropdown(anchor);
    }
  }

  function applyGitStatus(status: GitPanelStatus | null): void {
    gitStatus = status;
    renderGitStatus();
    renderGitPanel();
    updateTreeBadges();
    // 状态变化时分支 span 被重建，关闭可能残留的下拉弹层防错位
    closeBranchDropdown();
  }

  /** 文件树徽章（AC41）：工作区相对路径 → 状态字母；工作区文件覆盖暂存同名项。 */
  function updateTreeBadges(): void {
    const map = new Map<string, string>();
    if (gitStatus !== null && workspaceRoot !== "") {
      for (const item of gitStatus.staged) map.set(item.path, gitBadgeLetter(item.status));
      for (const item of gitStatus.untracked) map.set(item.path, gitBadgeLetter(item.status));
      for (const item of gitStatus.unstaged) map.set(item.path, gitBadgeLetter(item.status));
    }
    for (const node of filesPane.querySelectorAll<HTMLElement>(".dw-tree-node")) {
      const badge = node.querySelector<HTMLElement>(".dw-tree-badge");
      const path = node.dataset["path"];
      if (badge === null || path === undefined) continue;
      const letter = map.get(relPathOf(path));
      if (letter === undefined) {
        badge.textContent = "";
        badge.className = "dw-tree-badge";
      } else {
        badge.textContent = letter;
        badge.className = `dw-tree-badge dw-git-badge-${letter}`;
      }
    }
  }
  async function refreshGit(): Promise<void> {
    if (workspaceRoot === "") {
      applyGitStatus(null);
      return;
    }
    applyGitStatus(await api.git.getStatus());
  }
  api.git.onChanged(applyGitStatus);
  // 工作区文件事件防抖联动（编辑器保存/外部改动经 watcher 推送，800ms 合并突发写入）
  let gitRefreshTimer: number | undefined;
  api.workspace.onEvent(() => {
    window.clearTimeout(gitRefreshTimer);
    gitRefreshTimer = window.setTimeout(() => void refreshGit(), 800);
  });

  // ---- DAP 调试（迭代 33 / AC42）：行号槽断点 + 调试工具栏 + 调用栈/变量面板 + 状态栏 ----
  // v0.4.0：断点扩展为 DebugBreakpoint（可携带 condition/hitCount/logMessage），
  // 存储=文件绝对路径 → (1-based 行号 → DebugBreakpoint)。
  const breakpoints = new Map<string, Map<number, DebugBreakpoint>>();
  let debugState: DebugStateInfo = { state: "idle" };
  let debugFrames: DebugStackFrameItem[] = [];
  let debugScopes: DebugScopeItem[] = [];
  /** 变量树缓存：variablesReference → 已加载子项。 */
  const debugVarCache = new Map<number, DebugVariableItem[]>();
  /** 变量树展开态：variablesReference 集。 */
  const debugVarExpanded = new Set<number>();
  let selectedFrameId: number | null = null;
  /** 调试输出滚动区文本（output 事件累积，上限 200KB 防无限增长）。 */
  let debugOutputText = "";
  /**
   * Watch 表达式列表（v0.4.0）：用户自定义表达式，每次暂停时在当前栈顶帧求值。
   * value=undefined 表示尚未求值（运行中/idle）；error=true 表示求值失败（表达式非法/上下文不可用）。
   * 表达式持久化到 settings "debug.watches"，跨会话/重启保留。
   */
  interface WatchEntry {
    id: string;
    expression: string;
    value?: string;
    error?: boolean;
  }
  let watchExpressions: WatchEntry[] = [];
  let watchCounter = 0;

  function isJsFile(filePath: string): boolean {
    return /\.(js|mjs|cjs)$/i.test(filePath);
  }

  /** 判定断点视觉类型：logMessage 优先于 condition/hitCount。 */
  function breakpointKind(bp: DebugBreakpoint): BreakpointKind {
    if (bp.logMessage !== undefined && bp.logMessage !== "") return "log";
    if (
      (bp.condition !== undefined && bp.condition !== "") ||
      (bp.hitCount !== undefined && bp.hitCount > 0)
    ) {
      return "conditional";
    }
    return "normal";
  }

  /** 当前文件断点同步到编辑器（切文件/切断点后调用；0-based 转换在此）。 */
  function syncEditorBreakpoints(): void {
    if (openFile === null) {
      editor.setBreakpoints(new Map());
      return;
    }
    const fileBps = breakpoints.get(openFile.path);
    const entries = new Map<number, BreakpointKind>();
    if (fileBps !== undefined) {
      for (const [line1, bp] of fileBps) {
        entries.set(line1 - 1, breakpointKind(bp));
      }
    }
    editor.setBreakpoints(entries);
  }

  editor.onGutterClick = (line) => {
    if (openFile === null) return;
    const path = openFile.path;
    const line1 = line + 1;
    let fileBps = breakpoints.get(path);
    if (fileBps === undefined) {
      fileBps = new Map();
      breakpoints.set(path, fileBps);
    }
    if (fileBps.has(line1)) {
      fileBps.delete(line1);
      if (fileBps.size === 0) breakpoints.delete(path);
    } else {
      fileBps.set(line1, { line: line1 });
    }
    syncEditorBreakpoints();
    renderDebugPanel();
    void pushBreakpointsToSession(path);
  };

  // v0.4.0：行号槽右键 → 编辑断点对话框（condition / hitCount / logMessage）
  editor.onGutterContextMenu = (line) => {
    if (openFile === null) return;
    const path = openFile.path;
    const line1 = line + 1;
    let fileBps = breakpoints.get(path);
    if (fileBps === undefined) {
      fileBps = new Map();
      breakpoints.set(path, fileBps);
    }
    let bp = fileBps.get(line1);
    if (bp === undefined) {
      bp = { line: line1 };
      fileBps.set(line1, bp);
      syncEditorBreakpoints();
      renderDebugPanel();
    }
    void openBreakpointEditor(path, line1, bp);
  };

  /**
   * 推送某文件断点到运行中的调试会话（动态 setBreakpoints）。
   * 会话未运行时静默忽略（断点已存本地，下次 start 时全量下发）。
   */
  async function pushBreakpointsToSession(path: string): Promise<void> {
    if (debugState.state === "idle" || debugState.state === "terminated") return;
    if (!isJsFile(path)) return;
    const fileBps = breakpoints.get(path);
    const payload = fileBps === undefined ? [] : [...fileBps.values()];
    await doDebugOp(() => api.debug.setBreakpoints(path, payload));
  }

  /**
   * 打开断点编辑对话框（v0.4.0：condition / hitCount / logMessage）。
   * 三字段任一非空即视为对应增强类型；全清空保留为普通断点。
   * 对话框关闭后同步编辑器视觉 + 推送运行中会话。
   */
  async function openBreakpointEditor(path: string, line1: number, bp: DebugBreakpoint): Promise<void> {
    const result = await promptBreakpointEdit(line1, bp);
    if (result === null) return; // 用户取消
    if (result.hitCount === -1) {
      // 删除断点
      const fileBps = breakpoints.get(path);
      if (fileBps !== undefined) {
        fileBps.delete(line1);
        if (fileBps.size === 0) breakpoints.delete(path);
      }
    } else {
      bp.condition = result.condition;
      bp.hitCount = result.hitCount;
      bp.logMessage = result.logMessage;
    }
    syncEditorBreakpoints();
    renderDebugPanel();
    await pushBreakpointsToSession(path);
  }

  /**
   * 断点编辑模态框（v0.4.0）。
   * 返回 Promise<BreakpointEditResult | null>：null=用户取消；否则为三字段（undefined=清空）。
   * 三字段全空时仍返回对象（语义=转回普通断点），调用方据此更新视觉。
   */
  function promptBreakpointEdit(line1: number, bp: DebugBreakpoint): Promise<{
    condition: string | undefined;
    hitCount: number | undefined;
    logMessage: string | undefined;
  } | null> {
    return new Promise((resolve) => {
      const mask = el("div", "dw-modal-mask dw-bp-edit-mask");
      const modal = el("div", "dw-modal dw-bp-edit");
      mask.appendChild(modal);
      modal.appendChild(el("h2", undefined, t("debug.bp.editTitle", { line: String(line1) })));
      modal.appendChild(el("p", "dw-modal-hint", t("debug.bp.editHint")));

      const condLabel = el("label", undefined, t("debug.bp.condition"));
      const condInput = el("input", "dw-input") as HTMLInputElement;
      condInput.placeholder = t("debug.bp.conditionPh");
      condInput.value = bp.condition ?? "";
      modal.appendChild(condLabel);
      modal.appendChild(condInput);

      const hitLabel = el("label", undefined, t("debug.bp.hitCount"));
      const hitInput = el("input", "dw-input") as HTMLInputElement;
      hitInput.type = "number";
      hitInput.min = "1";
      hitInput.placeholder = t("debug.bp.hitCountPh");
      hitInput.value = bp.hitCount !== undefined ? String(bp.hitCount) : "";
      modal.appendChild(hitLabel);
      modal.appendChild(hitInput);

      const logLabel = el("label", undefined, t("debug.bp.logMessage"));
      const logInput = el("input", "dw-input") as HTMLInputElement;
      logInput.placeholder = t("debug.bp.logMessagePh");
      logInput.value = bp.logMessage ?? "";
      modal.appendChild(logLabel);
      modal.appendChild(logInput);

      const errorBox = el("div", "dw-form-error");
      modal.appendChild(errorBox);

      const close = (): void => mask.remove();

      const actions = el("div", "dw-modal-actions");
      const cancelBtn = el("button", "dw-btn", t("common.cancel"));
      cancelBtn.addEventListener("click", () => {
        close();
        resolve(null);
      });
      actions.appendChild(cancelBtn);
      const removeBtn = el("button", "dw-btn", t("debug.bp.removeBp"));
      removeBtn.addEventListener("click", () => {
        close();
        // 返回特殊标记：调用方负责从 storage 删除（这里用 hitCount=-1 表示删除意图）
        resolve({ condition: undefined, hitCount: -1, logMessage: undefined });
      });
      actions.appendChild(removeBtn);
      const saveBtn = el("button", "dw-btn dw-btn-primary", t("common.save"));
      saveBtn.addEventListener("click", () => {
        const cond = condInput.value.trim();
        const hitRaw = hitInput.value.trim();
        const log = logInput.value.trim();
        // logMessage 与 condition/hitCount 互斥（DAP logMessage 隐含不暂停，condition 无意义）
        if (log !== "" && (cond !== "" || hitRaw !== "")) {
          errorBox.textContent = t("debug.bp.errLogExclusive");
          return;
        }
        let hit: number | undefined;
        if (hitRaw !== "") {
          const n = Number(hitRaw);
          if (!Number.isInteger(n) || n < 1) {
            errorBox.textContent = t("debug.bp.errHitCount");
            return;
          }
          hit = n;
        }
        close();
        resolve({
          condition: cond === "" ? undefined : cond,
          hitCount: hit,
          logMessage: log === "" ? undefined : log,
        });
      });
      actions.appendChild(saveBtn);
      modal.appendChild(actions);

      mask.addEventListener("click", (event) => {
        if (event.target === mask) {
          close();
          resolve(null);
        }
      });
      document.body.appendChild(mask);
      condInput.focus();
    });
  }

  function renderDebugStatus(): void {
    if (debugState.state === "idle") {
      statusDebug.textContent = "";
      return;
    }
    if (debugState.state === "starting") {
      statusDebug.textContent = t("debug.state.starting");
      return;
    }
    if (debugState.state === "running") {
      statusDebug.textContent = t("debug.state.running");
      return;
    }
    if (debugState.state === "terminated") {
      statusDebug.textContent = t("debug.state.terminated");
      return;
    }
    statusDebug.textContent =
      debugState.file !== undefined && debugState.line !== undefined
        ? t("debug.state.stopped", {
            reason: debugState.reason,
            file: debugState.file.replace(/\\/g, "/").split("/").pop() ?? debugState.file,
            line: String(debugState.line),
          })
        : t("debug.state.stoppedNoLoc", { reason: debugState.reason });
  }

  /** 调试操作统一入口：失败本地化提示（DW_DAP_* 经 localizeError 映射）。 */
  async function doDebugOp(op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (error) {
      showStatus(toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  async function startDebugging(): Promise<void> {
    if (workspaceRoot === "") {
      showStatus(t("debug.noWorkspace"));
      return;
    }
    if (openFile === null || !isJsFile(openFile.path)) {
      showStatus(t("debug.needJsFile"));
      return;
    }
    const program = openFile.path;
    // 断点全量下发（仅 .js 文件；空数组不下发；按行号升序保证多断点顺序稳定）
    const payload: Record<string, DebugBreakpoint[]> = {};
    for (const [file, fileBps] of breakpoints) {
      if (fileBps.size > 0 && isJsFile(file)) {
        payload[file] = [...fileBps.values()].sort((a, b) => a.line - b.line);
      }
    }
    debugOutputText = "";
    await doDebugOp(() => api.debug.start(program, payload));
  }

  /** stopped 态数据装载：调用栈 → 首帧作用域 → 首作用域变量。 */
  async function loadStoppedData(): Promise<void> {
    try {
      debugFrames = await api.debug.stack();
    } catch {
      debugFrames = [];
    }
    const top = debugFrames[0];
    selectedFrameId = top?.id ?? null;
    debugScopes = [];
    debugVarCache.clear();
    debugVarExpanded.clear();
    if (top !== undefined) {
      try {
        debugScopes = await api.debug.scopes(top.id);
      } catch {
        debugScopes = [];
      }
      const first = debugScopes[0];
      if (first !== undefined) {
        try {
          debugVarCache.set(first.variablesReference, await api.debug.variables(first.variablesReference));
          debugVarExpanded.add(first.variablesReference);
        } catch {
          // 变量装载失败仅缺展示，不阻塞调试
        }
      }
    }
    // Watch 表达式在当前栈顶帧求值（暂停上下文；与变量面板同步刷新）
    await refreshWatches();
  }

  /** Watch 表达式持久化到 settings（跨会话/重启保留）。 */
  async function persistWatches(): Promise<void> {
    try {
      await api.settings.set("debug.watches", watchExpressions.map((w) => w.expression));
    } catch {
      // 设置写入失败不阻塞调试
    }
  }

  /** 启动时从 settings 恢复 watch 表达式列表（仅表达式，value 待暂停时求值）。 */
  async function loadWatches(): Promise<void> {
    try {
      const raw = await api.settings.get("debug.watches");
      if (Array.isArray(raw)) {
        watchExpressions = raw
          .filter((expr): expr is string => typeof expr === "string" && expr.length > 0)
          .map((expr) => ({ id: `w${++watchCounter}`, expression: expr }));
      }
    } catch {
      // 设置读取失败按空列表处理
    }
  }

  /** 添加 watch 表达式（去重；立即在当前帧求值）。 */
  async function addWatch(expression: string): Promise<void> {
    const trimmed = expression.trim();
    if (trimmed === "") return;
    if (watchExpressions.some((w) => w.expression === trimmed)) return;
    watchExpressions.push({ id: `w${++watchCounter}`, expression: trimmed });
    renderDebugPanel();
    await persistWatches();
    await refreshWatches();
  }

  /** 移除 watch 表达式。 */
  async function removeWatch(id: string): Promise<void> {
    watchExpressions = watchExpressions.filter((w) => w.id !== id);
    renderDebugPanel();
    await persistWatches();
  }

  /**
   * 在当前选中帧求值全部 watch 表达式。
   * 非 stopped 态时清空 value（显示"暂停时求值"占位）；求值失败标记 error。
   */
  async function refreshWatches(): Promise<void> {
    if (watchExpressions.length === 0) return;
    if (debugState.state !== "stopped" || selectedFrameId === null) {
      // 非暂停态：清空历史值（避免显示过期数据）
      for (const w of watchExpressions) {
        w.value = undefined;
        w.error = undefined;
      }
      renderDebugPanel();
      return;
    }
    const frameId = selectedFrameId;
    // 并行求值所有表达式（互不阻塞）；逐条 try-catch 防单条失败影响整体
    await Promise.all(
      watchExpressions.map(async (w) => {
        try {
          const result = await api.debug.evaluate(w.expression, frameId);
          w.value = result.value;
          w.error = false;
        } catch {
          w.value = undefined;
          w.error = true;
        }
      })
    );
    // 求值期间帧可能已切换/会话已终止：仅在仍为同一帧时刷新
    if (selectedFrameId === frameId && debugState.state === "stopped") {
      renderDebugPanel();
    }
  }

  /** 选帧切换：重载作用域与变量。 */
  async function selectFrame(frameId: number): Promise<void> {
    selectedFrameId = frameId;
    debugScopes = [];
    debugVarCache.clear();
    debugVarExpanded.clear();
    renderDebugPanel();
    try {
      debugScopes = await api.debug.scopes(frameId);
      const first = debugScopes[0];
      if (first !== undefined) {
        debugVarCache.set(first.variablesReference, await api.debug.variables(first.variablesReference));
        debugVarExpanded.add(first.variablesReference);
      }
    } catch {
      // 会话可能已继续/终止：忽略迟到响应
    }
    // Watch 表达式在新帧上下文重新求值
    await refreshWatches();
    renderDebugPanel();
  }

  /** 变量节点展开/收起（展开时懒加载子变量）。 */
  async function toggleVariable(reference: number): Promise<void> {
    if (debugVarExpanded.has(reference)) {
      debugVarExpanded.delete(reference);
      renderDebugPanel();
      return;
    }
    debugVarExpanded.add(reference);
    if (!debugVarCache.has(reference)) {
      try {
        debugVarCache.set(reference, await api.debug.variables(reference));
      } catch {
        debugVarCache.set(reference, []);
      }
    }
    renderDebugPanel();
  }

  /** 变量树递归渲染（缩进表达层级；variablesReference > 0 可展开）。 */
  function renderVariableRows(parent: HTMLElement, reference: number, depth: number): void {
    const vars = debugVarCache.get(reference) ?? [];
    for (const variable of vars) {
      const row = el("div", "dw-debug-var");
      row.style.paddingLeft = `${8 + depth * 14}px`;
      const expandable = variable.variablesReference > 0;
      const expanded = expandable && debugVarExpanded.has(variable.variablesReference);
      const toggle = el(
        "span",
        "dw-debug-var-toggle",
        expandable ? (expanded ? "▾" : "▸") : " "
      );
      const name = el("span", "dw-debug-var-name", variable.name);
      const value = el("span", "dw-debug-var-value", variable.value);
      value.title = variable.value;
      row.append(toggle, name, value);
      if (expandable) {
        row.addEventListener("click", () => void toggleVariable(variable.variablesReference));
      }
      parent.appendChild(row);
      if (expanded) renderVariableRows(parent, variable.variablesReference, depth + 1);
    }
  }

  function renderDebugPanel(): void {
    debugPane.textContent = "";

    // ---- 工具栏：启动/停止 + 步进（stopped 才可用） ----
    const toolbar = el("div", "dw-debug-toolbar");
    const active = debugState.state === "starting" || debugState.state === "running" || debugState.state === "stopped";
    const stoppedNow = debugState.state === "stopped";
    const startBtn = el("button", "dw-btn dw-btn-small dw-btn-primary", active ? t("debug.stop") : t("debug.start"));
    startBtn.title = t("debug.start.tooltip");
    startBtn.addEventListener("click", () => {
      if (active) {
        void doDebugOp(() => api.debug.stop());
      } else {
        void startDebugging();
      }
    });
    toolbar.appendChild(startBtn);
    const stepDefs: Array<[string, () => Promise<void>]> = [
      [t("debug.continue"), () => api.debug.continue()],
      [t("debug.next"), () => api.debug.next()],
      [t("debug.stepIn"), () => api.debug.stepIn()],
      [t("debug.stepOut"), () => api.debug.stepOut()],
    ];
    for (const [label, op] of stepDefs) {
      const btn = el("button", "dw-btn dw-btn-small", label);
      btn.disabled = !stoppedNow;
      btn.addEventListener("click", () => void doDebugOp(op));
      toolbar.appendChild(btn);
    }
    debugPane.appendChild(toolbar);

    const body = el("div", "dw-debug-body");
    debugPane.appendChild(body);

    // ---- 调用栈（stopped 态；点帧切换变量上下文） ----
    body.appendChild(el("div", "dw-debug-section", t("debug.stack")));
    if (!stoppedNow || debugFrames.length === 0) {
      body.appendChild(el("div", "dw-sidebar-empty", t("debug.empty.stack")));
    } else {
      for (const frame of debugFrames) {
        const row = el("div", `dw-debug-frame${frame.id === selectedFrameId ? " dw-debug-frame-active" : ""}`);
        const loc = frame.file !== undefined ? `${frame.file.replace(/\\/g, "/").split("/").pop()}:${frame.line}` : `:${frame.line}`;
        row.append(el("span", "dw-debug-frame-name", frame.name), el("span", "dw-debug-frame-loc", loc));
        row.title = frame.file ?? "";
        row.addEventListener("click", () => void selectFrame(frame.id));
        body.appendChild(row);
      }
    }

    // ---- 变量（选中帧的作用域 → 变量树） ----
    body.appendChild(el("div", "dw-debug-section", t("debug.variables")));
    if (!stoppedNow) {
      body.appendChild(el("div", "dw-sidebar-empty", t("debug.empty.variables")));
    } else {
      for (const scope of debugScopes) {
        const scopeRow = el("div", "dw-debug-scope");
        const expanded = debugVarExpanded.has(scope.variablesReference);
        scopeRow.append(
          el("span", "dw-debug-var-toggle", expanded ? "▾" : "▸"),
          el("span", "dw-debug-scope-name", /local/i.test(scope.name) ? t("debug.scope.local") : scope.name)
        );
        scopeRow.addEventListener("click", () => void toggleVariable(scope.variablesReference));
        body.appendChild(scopeRow);
        if (expanded) renderVariableRows(body, scope.variablesReference, 1);
      }
    }

    // ---- Watch 表达式（v0.4.0：用户自定义表达式，暂停时在当前帧求值） ----
    body.appendChild(el("div", "dw-debug-section", t("debug.watch.title")));
    const watchAdd = el("div", "dw-watch-add");
    const watchInput = el("input", "dw-input dw-watch-input") as HTMLInputElement;
    watchInput.placeholder = t("debug.watch.placeholder");
    watchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        const value = watchInput.value;
        watchInput.value = "";
        void addWatch(value);
      }
    });
    const watchAddBtn = el("button", "dw-btn dw-btn-small", t("debug.watch.add"));
    watchAddBtn.addEventListener("click", () => {
      const value = watchInput.value;
      watchInput.value = "";
      void addWatch(value);
    });
    watchAdd.append(watchInput, watchAddBtn);
    body.appendChild(watchAdd);
    if (watchExpressions.length === 0) {
      body.appendChild(el("div", "dw-sidebar-empty", t("debug.watch.empty")));
    } else {
      const isStopped = debugState.state === "stopped";
      for (const w of watchExpressions) {
        const row = el("div", "dw-watch-row");
        const expr = el("span", "dw-watch-expr", w.expression);
        expr.title = w.expression;
        let valueText: string;
        if (w.error === true) {
          valueText = t("debug.watch.error");
        } else if (!isStopped) {
          valueText = t("debug.watch.notStopped");
        } else if (w.value !== undefined) {
          valueText = w.value;
        } else {
          valueText = "…";
        }
        const val = el("span", `dw-watch-value${w.error === true ? " dw-watch-value-error" : ""}`, valueText);
        val.title = valueText;
        const removeBtn = el("button", "dw-watch-remove", "×");
        removeBtn.title = t("debug.watch.remove");
        removeBtn.addEventListener("click", () => void removeWatch(w.id));
        row.append(expr, val, removeBtn);
        body.appendChild(row);
      }
    }

    // ---- 断点列表（点击定位文件行；右键编辑 condition/hitCount/logMessage） ----
    body.appendChild(el("div", "dw-debug-section", t("debug.breakpoints")));
    let bpCount = 0;
    for (const [file, fileBps] of breakpoints) {
      const sortedBps = [...fileBps.entries()].sort((a, b) => a[0] - b[0]);
      for (const [line1, bp] of sortedBps) {
        bpCount += 1;
        const kind = breakpointKind(bp);
        const row = el("div", "dw-debug-bp");
        const dotClass =
          kind === "log" ? "dw-debug-bp-dot dw-debug-bp-dot-log" : kind === "conditional" ? "dw-debug-bp-dot dw-debug-bp-dot-cond" : "dw-debug-bp-dot";
        const dot = el("span", dotClass, kind === "log" ? "◆" : kind === "conditional" ? "◑" : "●");
        const loc = el("span", "dw-debug-bp-loc", `${file.replace(/\\/g, "/").split("/").pop()}:${line1}`);
        row.append(dot, loc);
        // 增强 tooltip：显示条件/命中/日志原文
        const tipParts: string[] = [file];
        if (bp.condition !== undefined && bp.condition !== "") tipParts.push(`condition: ${bp.condition}`);
        if (bp.hitCount !== undefined && bp.hitCount > 0) tipParts.push(`hitCount: ${bp.hitCount}`);
        if (bp.logMessage !== undefined && bp.logMessage !== "") tipParts.push(`log: ${bp.logMessage}`);
        row.title = tipParts.join("\n");
        // 条件/日志徽标
        if (bp.logMessage !== undefined && bp.logMessage !== "") {
          row.appendChild(el("span", "dw-debug-bp-badge dw-debug-bp-badge-log", t("debug.bp.logBadge")));
        } else if (
          (bp.condition !== undefined && bp.condition !== "") ||
          (bp.hitCount !== undefined && bp.hitCount > 0)
        ) {
          row.appendChild(el("span", "dw-debug-bp-badge dw-debug-bp-badge-cond", t("debug.bp.condBadge")));
        }
        row.addEventListener("click", () => {
          void openFileByPath(file).then(() => editor.revealPosition({ line: line1 - 1, character: 0 }));
        });
        row.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          void openBreakpointEditor(file, line1, bp);
        });
        body.appendChild(row);
      }
    }
    if (bpCount === 0) {
      body.appendChild(el("div", "dw-sidebar-empty", t("debug.empty.breakpoints")));
    }

    // ---- 调试输出（被调试进程 console 输出） ----
    body.appendChild(el("div", "dw-debug-section", t("debug.output.title")));
    const output = el("pre", "dw-debug-output");
    output.textContent = debugOutputText;
    body.appendChild(output);
    output.scrollTop = output.scrollHeight;
  }

  /** stopped 事件定位：打开停止文件（如需）并高亮停止行。 */
  async function revealStoppedLocation(file: string | undefined, line: number | undefined): Promise<void> {
    if (file === undefined || line === undefined) {
      editor.setDebugLine(null);
      return;
    }
    try {
      if (openFile?.path !== file) {
        await openFileByPath(file);
      }
      editor.setDebugLine(line - 1);
      editor.revealPosition({ line: line - 1, character: 0 });
    } catch {
      editor.setDebugLine(null); // 文件不可读（已删除/移动）：仅不高亮，调试继续
    }
  }

  api.debug.onState((state) => {
    debugState = state;
    renderDebugStatus();
    if (state.state === "stopped") {
      void revealStoppedLocation(state.file, state.line);
      void loadStoppedData().then(renderDebugPanel);
    } else {
      editor.setDebugLine(null);
      if (state.state !== "starting") {
        debugFrames = [];
        debugScopes = [];
        debugVarCache.clear();
        debugVarExpanded.clear();
        selectedFrameId = null;
        // 非 stopped 态清空 watch 历史值（避免显示过期数据）
        for (const w of watchExpressions) {
          w.value = undefined;
          w.error = undefined;
        }
      }
    }
    renderDebugPanel();
  });
  api.debug.onOutput((_category, text) => {
    debugOutputText = (debugOutputText + text).slice(-200_000);
    const output = debugPane.querySelector<HTMLElement>(".dw-debug-output");
    if (output !== null) {
      output.textContent = debugOutputText;
      output.scrollTop = output.scrollHeight;
    }
  });
  // 启动恢复：主动拉一次当前态（e2e/重连场景主进程可能已有会话）
  void api.debug.getState().then((state) => {
    debugState = state;
    renderDebugStatus();
    renderDebugPanel();
  });
  // Watch 表达式列表从 settings 恢复（跨会话/重启保留表达式，值待暂停时求值）
  void loadWatches().then(() => renderDebugPanel());
  renderDebugPanel();

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
    filesPane.textContent = "";
    const tree = (await api.workspace.tree(root)) as TreeNode;
    workspaceFiles = [];
    flattenTreeFiles(tree, root, workspaceFiles);
    const ul = el("ul", "dw-tree");
    for (const child of tree.children ?? []) renderTree(child, ul);
    filesPane.appendChild(ul);
    // 树重建后回填徽章（git:changed 可能先于树到达）；并主动拉一次最新状态
    updateTreeBadges();
    void refreshGit();
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
    renderOutlineTree(); // 大纲空态文案随语言热生效
    renderDebugStatus(); // 调试状态项随语言热生效
    renderDebugPanel();
    renderGitStatus();
    closeBranchDropdown(); // 语言切换重建面板，关闭可能残留的下拉弹层防错位
    renderGitPanel();
    // 打开中的 git diff 标题随语言热生效
    if (gitDiffFile !== null && gitDiffTitleSpan !== null) {
      gitDiffTitleSpan.textContent = t("git.diffTitle", { file: gitDiffFile });
    }
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
    renderLspStatus(); // LSP 状态项随语言热生效
    // 欢迎文档仅在无打开文件时随语言重建（不触碰用户文件内容）
    if (openFile === null) {
      editor.setDocument(TextDocument.fromString(t("editor.welcome")));
    }
  }
  onDidChangeLocale(applyLocale);
  applyLocale();

  // ---- 首启触发向导（迭代 18 / AC27）：无模型配置且向导未完成时弹出 ----
  void (async () => {
    const state = (await api.settings.get("onboarding.state")) as { completed?: boolean } | null;
    if (state?.completed === true) return;
    const configured = await api.providers.list();
    if (configured.length > 0) {
      // 老用户升级：已有模型配置，静默标记完成，不打扰现有工作流
      void api.settings.set("onboarding.state", { completed: true });
      return;
    }
    launchWizard();
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
