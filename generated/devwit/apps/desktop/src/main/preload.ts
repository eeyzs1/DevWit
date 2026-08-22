/**
 * DevWit preload 白名单桥（WU005，AR001/AR004）。
 * 仅可使用 electron 与 @devwit/contracts；暴露形状严格 = contracts 的 DevwitApi。
 * 通道白名单 = contracts IPC 常量，无其他任何通道。
 * 由 esbuild 打包为 CJS（根 build:preload 脚本），在 sandboxed preload 中运行。
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { IPC } from "@devwit/contracts";
import type { DevwitApi, UsageBudgetAlert } from "@devwit/contracts";

/** ipcRenderer.on 包装，返回退订函数。 */
function subscribe<TArgs extends unknown[]>(channel: string, cb: (...args: TArgs) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as TArgs));
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: DevwitApi = {
  workspace: {
    openDialog: () => ipcRenderer.invoke(IPC.WorkspaceOpenDialog) as Promise<string | null>,
    tree: (root) => ipcRenderer.invoke(IPC.WorkspaceTree, root) as Promise<unknown>,
    read: (filePath) => ipcRenderer.invoke(IPC.WorkspaceRead, filePath) as Promise<string>,
    write: (filePath, content) => ipcRenderer.invoke(IPC.WorkspaceWrite, filePath, content) as Promise<void>,
    search: (root, options) => ipcRenderer.invoke(IPC.WorkspaceSearch, root, options) as ReturnType<DevwitApi["workspace"]["search"]>,
    onEvent: (cb) => subscribe<[unknown]>(IPC.WorkspaceEvent, cb)
  },
  terminal: {
    create: (cwd) => ipcRenderer.invoke(IPC.TerminalCreate, cwd) as ReturnType<DevwitApi["terminal"]["create"]>,
    input: (id, data) => {
      void ipcRenderer.invoke(IPC.TerminalInput, id, data);
    },
    resize: (id, cols, rows) => {
      void ipcRenderer.invoke(IPC.TerminalResize, id, cols, rows);
    },
    dispose: (id) => {
      void ipcRenderer.invoke(IPC.TerminalDispose, id);
    },
    onOutput: (cb) => subscribe<[string, string]>(IPC.TerminalOutput, cb)
  },
  settings: {
    get: (key) => ipcRenderer.invoke(IPC.SettingsGet, key) as Promise<unknown>,
    set: (key, value) => ipcRenderer.invoke(IPC.SettingsSet, key, value) as Promise<void>,
    onChanged: (cb) => subscribe<[string, unknown]>(IPC.SettingsChanged, cb)
  },
  credentials: {
    set: (ref, provider, secret) => ipcRenderer.invoke(IPC.CredentialSet, ref, provider, secret) as Promise<void>,
    delete: (ref) => ipcRenderer.invoke(IPC.CredentialDelete, ref) as Promise<void>,
    list: () => ipcRenderer.invoke(IPC.CredentialList) as ReturnType<DevwitApi["credentials"]["list"]>
  },
  agent: {
    run: (input) => ipcRenderer.invoke(IPC.AgentRun, input) as Promise<void>,
    cancel: (sessionId) => {
      void ipcRenderer.invoke(IPC.AgentCancel, sessionId);
    },
    authorize: (sessionId, requestId, decision) => {
      void ipcRenderer.invoke(IPC.AgentAuthorize, sessionId, requestId, decision);
    },
    onEvent: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.AgentEvent, cb),
    trace: (sessionId) => ipcRenderer.invoke(IPC.AgentTrace, sessionId) as ReturnType<DevwitApi["agent"]["trace"]>,
    traceList: () => ipcRenderer.invoke(IPC.AgentTraceList) as ReturnType<DevwitApi["agent"]["traceList"]>
  },
  providers: {
    list: () => ipcRenderer.invoke(IPC.ProvidersList) as ReturnType<DevwitApi["providers"]["list"]>,
    upsert: (config) => ipcRenderer.invoke(IPC.ProvidersUpsert, config) as Promise<void>,
    presets: () => ipcRenderer.invoke(IPC.ProviderPresets) as ReturnType<DevwitApi["providers"]["presets"]>,
    probe: (req) => ipcRenderer.invoke(IPC.ProvidersProbe, req) as ReturnType<DevwitApi["providers"]["probe"]>
  },
  modes: {
    list: () => ipcRenderer.invoke(IPC.ModesList) as ReturnType<DevwitApi["modes"]["list"]>,
    upsert: (mode) => ipcRenderer.invoke(IPC.ModesUpsert, mode) as Promise<void>,
    delete: (id) => ipcRenderer.invoke(IPC.ModesDelete, id) as Promise<void>,
    export: (id) => ipcRenderer.invoke(IPC.ModesExport, id) as ReturnType<DevwitApi["modes"]["export"]>,
    import: () => ipcRenderer.invoke(IPC.ModesImport) as ReturnType<DevwitApi["modes"]["import"]>,
    communityList: () => ipcRenderer.invoke(IPC.ModesCommunityList) as ReturnType<DevwitApi["modes"]["communityList"]>,
    communityImport: (file) => ipcRenderer.invoke(IPC.ModesCommunityImport, file) as ReturnType<DevwitApi["modes"]["communityImport"]>,
    onChanged: (cb) => subscribe<[]>(IPC.ModesChanged, cb)
  },
  context: {
    latestManifest: () => ipcRenderer.invoke(IPC.ContextManifestLatest) as ReturnType<DevwitApi["context"]["latestManifest"]>,
    listManifests: (limit) => ipcRenderer.invoke(IPC.ContextManifestList, limit) as ReturnType<DevwitApi["context"]["listManifests"]>,
    exportManifest: (manifestId) => ipcRenderer.invoke(IPC.ContextManifestExport, manifestId) as ReturnType<DevwitApi["context"]["exportManifest"]>,
    getPolicy: () => ipcRenderer.invoke(IPC.ContextPolicyGet) as ReturnType<DevwitApi["context"]["getPolicy"]>,
    setItemEnabled: (type, enabled) => ipcRenderer.invoke(IPC.ContextPolicySet, type, enabled) as Promise<void>,
    setItemOverride: (key, enabled) => ipcRenderer.invoke(IPC.ContextItemOverrideSet, key, enabled) as Promise<void>
  },
  rag: {
    getStatus: () => ipcRenderer.invoke(IPC.RagGetStatus) as ReturnType<DevwitApi["rag"]["getStatus"]>,
    rebuild: () => ipcRenderer.invoke(IPC.RagRebuild) as Promise<void>,
    onStatus: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.RagStatus, cb)
  },
  externalEditor: {
    open: (path, line) => ipcRenderer.invoke(IPC.ExternalEditorOpen, path, line) as Promise<void>
  },
  update: {
    check: () => ipcRenderer.invoke(IPC.UpdateCheck) as Promise<void>,
    install: () => {
      void ipcRenderer.invoke(IPC.UpdateInstall);
    },
    version: () => ipcRenderer.invoke(IPC.UpdateVersion) as Promise<string>,
    onStatus: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.UpdateStatus, cb)
  },
  mcp: {
    list: () => ipcRenderer.invoke(IPC.McpList) as ReturnType<DevwitApi["mcp"]["list"]>,
    upsert: (config) => ipcRenderer.invoke(IPC.McpUpsert, config) as Promise<void>,
    delete: (id) => ipcRenderer.invoke(IPC.McpDelete, id) as Promise<void>,
    communityList: () => ipcRenderer.invoke(IPC.McpCommunityList) as ReturnType<DevwitApi["mcp"]["communityList"]>,
    communityImport: (file) => ipcRenderer.invoke(IPC.McpCommunityImport, file) as ReturnType<DevwitApi["mcp"]["communityImport"]>,
    onChanged: (cb) => subscribe<[]>(IPC.McpChanged, cb)
  },
  usage: {
    summary: () => ipcRenderer.invoke(IPC.UsageSummary) as ReturnType<DevwitApi["usage"]["summary"]>,
    clear: () => ipcRenderer.invoke(IPC.UsageClear) as Promise<void>,
    dailySummary: () => ipcRenderer.invoke(IPC.UsageDaily) as ReturnType<DevwitApi["usage"]["dailySummary"]>,
    checkBudget: (threshold, period) => ipcRenderer.invoke(IPC.UsageBudget, threshold, period) as ReturnType<DevwitApi["usage"]["checkBudget"]>,
    exportReport: (format) => ipcRenderer.invoke(IPC.UsageExport, format) as ReturnType<DevwitApi["usage"]["exportReport"]>,
    onBudgetAlert: (cb) => subscribe<[UsageBudgetAlert]>(IPC.UsageBudgetAlert, cb)
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.SessionsList) as ReturnType<DevwitApi["sessions"]["list"]>,
    rename: (sessionId, title) => ipcRenderer.invoke(IPC.SessionsRename, sessionId, title) as Promise<void>,
    delete: (sessionId) => ipcRenderer.invoke(IPC.SessionsDelete, sessionId) as Promise<void>
  },
  symbols: {
    query: (q) => ipcRenderer.invoke(IPC.SymbolsQuery, q) as ReturnType<DevwitApi["symbols"]["query"]>
  },
  lsp: {
    getStatus: () => ipcRenderer.invoke(IPC.LspGetStatus) as ReturnType<DevwitApi["lsp"]["getStatus"]>,
    didOpen: (file, text) => ipcRenderer.invoke(IPC.LspDidOpen, file, text) as Promise<void>,
    didChange: (file, text) => ipcRenderer.invoke(IPC.LspDidChange, file, text) as Promise<void>,
    didClose: (file) => ipcRenderer.invoke(IPC.LspDidClose, file) as Promise<void>,
    hover: (file, line, character) => ipcRenderer.invoke(IPC.LspHover, file, line, character) as ReturnType<DevwitApi["lsp"]["hover"]>,
    definition: (file, line, character) => ipcRenderer.invoke(IPC.LspDefinition, file, line, character) as ReturnType<DevwitApi["lsp"]["definition"]>,
    completion: (file, line, character) => ipcRenderer.invoke(IPC.LspCompletion, file, line, character) as ReturnType<DevwitApi["lsp"]["completion"]>,
    references: (file, line, character) => ipcRenderer.invoke(IPC.LspReferences, file, line, character) as ReturnType<DevwitApi["lsp"]["references"]>,
    signatureHelp: (file, line, character) => ipcRenderer.invoke(IPC.LspSignatureHelp, file, line, character) as ReturnType<DevwitApi["lsp"]["signatureHelp"]>,
    rename: (file, line, character, newName) => ipcRenderer.invoke(IPC.LspRename, file, line, character, newName) as ReturnType<DevwitApi["lsp"]["rename"]>,
    codeAction: (file, startLine, startCharacter, endLine, endCharacter) => ipcRenderer.invoke(IPC.LspCodeAction, file, startLine, startCharacter, endLine, endCharacter) as ReturnType<DevwitApi["lsp"]["codeAction"]>,
    documentSymbols: (file) => ipcRenderer.invoke(IPC.LspDocumentSymbol, file) as ReturnType<DevwitApi["lsp"]["documentSymbols"]>,
    diagnostics: () => ipcRenderer.invoke(IPC.LspDiagnostics) as ReturnType<DevwitApi["lsp"]["diagnostics"]>,
    onStatus: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.LspStatus, cb),
    onDiagnostics: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.LspDiagnosticsChanged, cb)
  },
  git: {
    getStatus: () => ipcRenderer.invoke(IPC.GitGetStatus) as ReturnType<DevwitApi["git"]["getStatus"]>,
    diff: (file) => ipcRenderer.invoke(IPC.GitDiff, file) as ReturnType<DevwitApi["git"]["diff"]>,
    stage: (file) => ipcRenderer.invoke(IPC.GitStage, file) as Promise<void>,
    unstage: (file) => ipcRenderer.invoke(IPC.GitUnstage, file) as Promise<void>,
    commit: (message) => ipcRenderer.invoke(IPC.GitCommit, message) as Promise<void>,
    pull: () => ipcRenderer.invoke(IPC.GitPull) as Promise<void>,
    push: () => ipcRenderer.invoke(IPC.GitPush) as Promise<void>,
    log: (limit) => ipcRenderer.invoke(IPC.GitLog, limit) as ReturnType<DevwitApi["git"]["log"]>,
    listBranches: () => ipcRenderer.invoke(IPC.GitListBranches) as ReturnType<DevwitApi["git"]["listBranches"]>,
    checkout: (name) => ipcRenderer.invoke(IPC.GitCheckout, name) as Promise<void>,
    createBranch: (name, doCheckout) => ipcRenderer.invoke(IPC.GitCreateBranch, name, doCheckout) as Promise<void>,
    deleteBranch: (name) => ipcRenderer.invoke(IPC.GitDeleteBranch, name) as Promise<void>,
    listStash: () => ipcRenderer.invoke(IPC.GitStashList) as ReturnType<DevwitApi["git"]["listStash"]>,
    stashPush: (message) => ipcRenderer.invoke(IPC.GitStashPush, message) as Promise<void>,
    stashPop: (index) => ipcRenderer.invoke(IPC.GitStashPop, index) as Promise<void>,
    stashApply: (index) => ipcRenderer.invoke(IPC.GitStashApply, index) as Promise<void>,
    stashDrop: (index) => ipcRenderer.invoke(IPC.GitStashDrop, index) as Promise<void>,
    blame: (file) => ipcRenderer.invoke(IPC.GitBlame, file) as ReturnType<DevwitApi["git"]["blame"]>,
    resolveConflict: (file, strategy) => ipcRenderer.invoke(IPC.GitResolveConflict, file, strategy) as ReturnType<DevwitApi["git"]["resolveConflict"]>,
    onChanged: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.GitChanged, cb)
  },
  debug: {
    start: (program, breakpoints) => ipcRenderer.invoke(IPC.DebugStart, program, breakpoints) as Promise<void>,
    attach: (port, host, breakpoints) => ipcRenderer.invoke(IPC.DebugAttach, port, host, breakpoints) as Promise<void>,
    setBreakpoints: (file, breakpoints) => ipcRenderer.invoke(IPC.DebugSetBreakpoints, file, breakpoints) as Promise<void>,
    stop: () => ipcRenderer.invoke(IPC.DebugStop) as Promise<void>,
    getState: () => ipcRenderer.invoke(IPC.DebugGetState) as ReturnType<DevwitApi["debug"]["getState"]>,
    continue: () => ipcRenderer.invoke(IPC.DebugContinue) as Promise<void>,
    next: () => ipcRenderer.invoke(IPC.DebugNext) as Promise<void>,
    stepIn: () => ipcRenderer.invoke(IPC.DebugStepIn) as Promise<void>,
    stepOut: () => ipcRenderer.invoke(IPC.DebugStepOut) as Promise<void>,
    stack: () => ipcRenderer.invoke(IPC.DebugStack) as ReturnType<DevwitApi["debug"]["stack"]>,
    scopes: (frameId) => ipcRenderer.invoke(IPC.DebugScopes, frameId) as ReturnType<DevwitApi["debug"]["scopes"]>,
    variables: (reference) => ipcRenderer.invoke(IPC.DebugVariables, reference) as ReturnType<DevwitApi["debug"]["variables"]>,
    evaluate: (expression, frameId) => ipcRenderer.invoke(IPC.DebugEvaluate, expression, frameId) as ReturnType<DevwitApi["debug"]["evaluate"]>,
    onState: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.DebugState, cb),
    onOutput: (cb) => subscribe<[string, string]>(IPC.DebugOutput, cb)
  }
};

contextBridge.exposeInMainWorld("devwit", api);

// E2E 模式标记（迭代 31 / AC40）：主进程 DEVWIT_E2E_OPEN_DIR 钩子族同源——
// 渲染端据此安装编辑器几何反解钩子（window.__devwitE2E），生产构建无影响。
contextBridge.exposeInMainWorld("devwitE2E", {
  active: process.env.DEVWIT_E2E_OPEN_DIR !== undefined && process.env.DEVWIT_E2E_OPEN_DIR !== ""
});
