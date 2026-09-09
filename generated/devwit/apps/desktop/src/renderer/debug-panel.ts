/**
 * DAP 调试 UI 集群（迭代 33 / AC42 → v0.7.8 自 index.ts 抽取为模块）。
 *
 * 覆盖：行号槽断点（普通/条件/命中/日志，含右键编辑对话框）、断点到
 * 运行会话的动态推送、调试工具栏（start/attach/stop/步进）、调用栈、
 * 变量树、Watch 表达式（settings 持久化）、断点列表、调试输出、
 * 状态栏调试项、stopped 定位高亮。
 * debug.onState/onOutput 订阅与启动恢复随模块迁移；
 * 依赖经 DebugPanelDeps 注入（宿主持有 editor/openFile/workspaceRoot 状态）。
 */
import type {
  DebugBreakpoint,
  DebugScopeItem,
  DebugStackFrameItem,
  DebugStateInfo,
  DebugVariableItem,
  DevwitApi,
} from "@devwit/contracts";
import type { EditorView } from "@devwit/editor-render";
import type { BreakpointKind } from "@devwit/editor-render";
import { t } from "@devwit/i18n";
import { el } from "./dom.js";

export interface DebugPanelDeps {
  api: DevwitApi;
  editor: EditorView;
  debugPane: HTMLElement;
  statusDebug: HTMLElement;
  getWorkspaceRoot(): string;
  getOpenFile(): { path: string } | null;
  openFileByPath(path: string): Promise<void>;
  showStatus(message: string): void;
  toLocalError(raw: string): string;
}

export interface DebugPanelHandle {
  syncEditorBreakpoints(): void;
  renderDebugStatus(): void;
  renderDebugPanel(): void;
}

/** Watch 表达式条目（value=undefined 未求值；error=true 求值失败）。 */
interface WatchEntry {
  id: string;
  expression: string;
  value?: string;
  error?: boolean;
}

export function mountDebugPanel(deps: DebugPanelDeps): DebugPanelHandle {
  const { api, editor, debugPane, statusDebug } = deps;
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
    const openFile = deps.getOpenFile();
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
    const openFile = deps.getOpenFile();
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
    const openFile = deps.getOpenFile();
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
      deps.showStatus(deps.toLocalError(error instanceof Error ? error.message : String(error)));
    }
  }

  async function startDebugging(): Promise<void> {
    const openFile = deps.getOpenFile();
    if (deps.getWorkspaceRoot() === "") {
      deps.showStatus(t("debug.noWorkspace"));
      return;
    }
    if (openFile === null || !isJsFile(openFile.path)) {
      deps.showStatus(t("debug.needJsFile"));
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

  /**
   * 附加到已运行进程（v0.4.0）：连接到指定端口的 Node.js inspector。
   * 进程须以 --inspect 或 --inspect-brk 启动。host 固定 127.0.0.1（本地附加）。
   * 断点全量下发策略同 startDebugging。
   */
  async function attachDebugging(portText: string): Promise<void> {
    const port = Number.parseInt(portText, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      deps.showStatus(t("debug.attach.badPort"));
      return;
    }
    const payload: Record<string, DebugBreakpoint[]> = {};
    for (const [file, fileBps] of breakpoints) {
      if (fileBps.size > 0 && isJsFile(file)) {
        payload[file] = [...fileBps.values()].sort((a, b) => a.line - b.line);
      }
    }
    debugOutputText = "";
    await doDebugOp(() => api.debug.attach(port, "127.0.0.1", payload));
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
        expandable ? (expanded ? "▾" : "▸") : " "
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
    // attach 模式（v0.4.0）：非活动态显示端口输入 + 附加按钮
    if (!active) {
      const portInput = el("input", "dw-input dw-debug-attach-port") as HTMLInputElement;
      portInput.type = "number";
      portInput.placeholder = t("debug.attach.portPh");
      portInput.min = "1";
      portInput.max = "65535";
      portInput.value = "9229";
      portInput.title = t("debug.attach.portPh");
      portInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          void attachDebugging(portInput.value);
        }
      });
      const attachBtn = el("button", "dw-btn dw-btn-small", t("debug.attach"));
      attachBtn.title = t("debug.attach.tooltip");
      attachBtn.addEventListener("click", () => void attachDebugging(portInput.value));
      toolbar.append(portInput, attachBtn);
    }
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
          void deps.openFileByPath(file).then(() => editor.revealPosition({ line: line1 - 1, character: 0 }));
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
      if (deps.getOpenFile()?.path !== file) {
        await deps.openFileByPath(file);
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

  return { syncEditorBreakpoints, renderDebugStatus, renderDebugPanel };
}
