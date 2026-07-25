/**
 * DevWit preload 白名单桥（WU005，AR001/AR004）。
 * 仅可使用 electron 与 @devwit/contracts；暴露形状严格 = contracts 的 DevwitApi。
 * 通道白名单 = contracts IPC 常量，无其他任何通道。
 * 由 esbuild 打包为 CJS（根 build:preload 脚本），在 sandboxed preload 中运行。
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { IPC } from "@devwit/contracts";
import type { DevwitApi } from "@devwit/contracts";

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
    trace: (sessionId) => ipcRenderer.invoke(IPC.AgentTrace, sessionId) as ReturnType<DevwitApi["agent"]["trace"]>
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
    onChanged: (cb) => subscribe<[]>(IPC.McpChanged, cb)
  }
};

contextBridge.exposeInMainWorld("devwit", api);
