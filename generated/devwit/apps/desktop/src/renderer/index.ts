/**
 * DevWit 渲染进程（WU012/WU013 集成 + 迭代 3 / AC12 国际化）。
 * 布局：侧栏文件树 | 自研 Canvas 编辑器（diff 覆盖层） | 对话/上下文面板。
 * 只允许经 window.devwit（preload 白名单）访问主进程能力（AR001/AR004）。
 * 全部界面文案经 @devwit/i18n 词典渲染；启动时从 settings "ui.locale" 恢复语言，
 * 订阅 onDidChangeLocale 全量重写静态文案与动态列表（语言热生效）。
 */
import type { DevwitApi, DebugScopeItem, DebugStackFrameItem, DebugStateInfo, DebugVariableItem, GitPanelStatus, LspDiagnosticItem, LspStatusInfo, ModeDefinition, ProviderConfig, UpdateStatusInfo } from "@devwit/contracts";
import { displayModeName, localizeError, onDidChangeLocale, resolveSystemLocale, setLocale, t, ta, type Locale } from "@devwit/i18n";
import { TextDocument } from "@devwit/editor-core";
import { EditorView, normalizeSelection } from "@devwit/editor-render";
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
import { captureEvent, captureError, identifyInstall, initPostHog } from "./posthog.js";
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

  // 左栏三页签（AC41 文件/Git + AC42 调试）：各自 DOM 保持（切页签不重建树）
  const leftTabs = el("div", "dw-tabs dw-left-tabs");
  const filesTab = el("div", "dw-tab dw-tab-active", t("tab.files"));
  const gitTab = el("div", "dw-tab", t("tab.git"));
  const debugTab = el("div", "dw-tab", t("tab.debug"));
  leftTabs.append(filesTab, gitTab, debugTab);
  const filesPane = el("div", "dw-left-pane");
  const gitPane = el("div", "dw-left-pane dw-git");
  gitPane.style.display = "none";
  const debugPane = el("div", "dw-left-pane dw-debug");
  debugPane.style.display = "none";
  sidebar.append(leftTabs, filesPane, gitPane, debugPane);
  function activateLeftTab(active: "files" | "git" | "debug"): void {
    filesTab.classList.toggle("dw-tab-active", active === "files");
    gitTab.classList.toggle("dw-tab-active", active === "git");
    debugTab.classList.toggle("dw-tab-active", active === "debug");
    filesPane.style.display = active === "files" ? "" : "none";
    gitPane.style.display = active === "git" ? "flex" : "none";
    debugPane.style.display = active === "debug" ? "flex" : "none";
  }
  filesTab.addEventListener("click", () => activateLeftTab("files"));
  gitTab.addEventListener("click", () => {
    activateLeftTab("git");
    void refreshGit(); // 切到面板即取最新（外部 git 操作可能绕过 watcher）
  });
  debugTab.addEventListener("click", () => activateLeftTab("debug"));

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
    setActiveDoc({ path: filePath, doc });
    syncEditorBreakpoints(); // 断点红点随文件切换重挂（AC42）
    if (workspaceRoot !== "") {
      syncOpenFileToLsp();
      doc.onDidChange(scheduleLspSync);
      applyEditorDiagnostics(); // 该文件既有诊断立即上波浪线
    }
    sidebar.querySelectorAll(".dw-tree-node").forEach((node) => {
      node.classList.toggle("dw-tree-active", (node as HTMLElement).dataset["path"] === filePath);
    });
    editor.focus();
    const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
    captureEvent("file_opened", { extension: ext });
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

  api.lsp.onStatus((status) => {
    const wasReady = lspStatus.state === "ready";
    lspStatus = status;
    renderLspStatus();
    // 服务器后于文件打开才就绪：补偿重放 didOpen（未就绪期间的 didOpen 被主进程丢弃）
    if (!wasReady && status.state === "ready") syncOpenFileToLsp();
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
    head.append(
      el("span", "dw-git-branch", gitStatus !== null && workspaceRoot !== "" ? `⑂ ${gitStatus.branch}` : ""),
    );
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
        captureEvent("git_commit_made", { staged_count: gitStatus?.staged.length ?? 0 });
        commitInput.value = "";
        showStatus(t("git.commitDone"));
      } catch (error) {
        captureError(error, { context: "git_commit" });
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

  function applyGitStatus(status: GitPanelStatus | null): void {
    gitStatus = status;
    renderGitStatus();
    renderGitPanel();
    updateTreeBadges();
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
  /** 断点：文件绝对路径 → 1-based 行号集（会话内有效；启动调试时全量下发）。 */
  const breakpoints = new Map<string, Set<number>>();
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

  function isJsFile(filePath: string): boolean {
    return /\.(js|mjs|cjs)$/i.test(filePath);
  }

  /** 当前文件断点同步到编辑器（切文件/切断点后调用；0-based 转换在此）。 */
  function syncEditorBreakpoints(): void {
    if (openFile === null) {
      editor.setBreakpoints(new Set());
      return;
    }
    const lines = breakpoints.get(openFile.path);
    editor.setBreakpoints(new Set([...(lines ?? [])].map((line) => line - 1)));
  }

  editor.onGutterClick = (line) => {
    if (openFile === null) return;
    const path = openFile.path;
    const line1 = line + 1;
    let set = breakpoints.get(path);
    if (set === undefined) {
      set = new Set();
      breakpoints.set(path, set);
    }
    if (set.has(line1)) {
      set.delete(line1);
      if (set.size === 0) breakpoints.delete(path);
    } else {
      set.add(line1);
    }
    syncEditorBreakpoints();
    renderDebugPanel();
  };

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
    // 断点全量下发（仅当前工作区内的 .js 文件；空行号集不下发）
    const payload: Record<string, number[]> = {};
    for (const [file, lines] of breakpoints) {
      if (lines.size > 0 && isJsFile(file)) payload[file] = [...lines].sort((a, b) => a - b);
    }
    debugOutputText = "";
    await doDebugOp(() => api.debug.start(program, payload));
    captureEvent("debug_session_started", { breakpoint_count: Object.values(payload).reduce((s, l) => s + l.length, 0) });
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

    // ---- 断点列表（点击定位文件行） ----
    body.appendChild(el("div", "dw-debug-section", t("debug.breakpoints")));
    let bpCount = 0;
    for (const [file, lines] of breakpoints) {
      for (const line of [...lines].sort((a, b) => a - b)) {
        bpCount += 1;
        const row = el("div", "dw-debug-bp");
        row.append(
          el("span", "dw-debug-bp-dot", "●"),
          el("span", "dw-debug-bp-loc", `${file.replace(/\\/g, "/").split("/").pop()}:${line}`)
        );
        row.title = file;
        row.addEventListener("click", () => {
          void openFileByPath(file).then(() => editor.revealPosition({ line: line - 1, character: 0 }));
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
    captureEvent("workspace_opened");
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
    captureEvent("new_chat_session_started");
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
      captureEvent("ai_task_created", { has_active_file: openFile !== null });
      activityStream.resubscribe();
    } catch (error) {
      captureError(error, { context: "create_task" });
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
    captureEvent("chat_message_sent", { form: "console" });
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
    captureEvent("form_mode_switched", { to: next });
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
        captureEvent("diff_applied", { form });
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
    renderDebugStatus(); // 调试状态项随语言热生效
    renderDebugPanel();
    renderGitStatus();
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
    initPostHog();
    // Identify by stable install ID (same ID used by built-in telemetry)
    const installId = await api.settings.get("telemetry.installId");
    if (typeof installId === "string" && installId !== "") {
      identifyInstall(installId);
    }
    await bootstrap(api);
  })();
});
