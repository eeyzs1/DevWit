/**
 * 主进程 IPC 注册（WU005-WU007）。
 *
 * 白名单唯一合法集合 = contracts 的 IPC 常量（AR001/AR004）。
 * 本文件不 import electron——通过 IpcMainLike / WebContentsLike 依赖注入，
 * 使 handlers 表可在纯 node 环境（vitest）做白名单完整性测试。
 *
 * AI 子系统通道（agent:* / modes:* / context:*）先注册、handler 抛
 * "AI 子系统未初始化"——这是明确的未接线错误，不是 mock 数据（WU008-WU011 接线）。
 */
import { IPC } from "@devwit/contracts";
import type { AgentRunInput, AuthorizationDecision, ContextItemType, ExternalEditorConfig, ProviderConfig } from "@devwit/contracts";
import type { SettingsStore } from "@devwit/settings";
import type { TerminalService } from "@devwit/terminal";
import type { WorkspaceService } from "@devwit/workspace";
import type { AiRuntime } from "./ai-runtime.js";
import { openInExternalEditor } from "./external-editor.js";
import type { UpdateService } from "./updater.js";

// ---------------------------------------------------------------------------
// 依赖注入接口（electron 的结构子集）
// ---------------------------------------------------------------------------

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

export interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
}

export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
}

export interface IpcServices {
  workspace: WorkspaceService;
  terminal: TerminalService;
  settings: SettingsStore;
}

export interface IpcHooks {
  /** 打开目录选择对话框，取消返回 null */
  openDirectoryDialog(): Promise<string | null>;
  /** 构建文件树（由 index.ts 注入 buildFileTree，保持本文件无包运行时依赖） */
  buildTree(root: string): unknown;
  /** 向渲染进程推送事件 */
  send(channel: string, ...args: unknown[]): void;
}

/** 仅主→渲染推送的通道（不出现 invoke handler）。 */
export const PUSH_CHANNELS: readonly string[] = [
  IPC.WorkspaceEvent,
  IPC.TerminalOutput,
  IPC.SettingsChanged,
  IPC.AgentEvent,
  IPC.ModesChanged,
  IPC.UpdateStatus
];

const AI_NOT_WIRED = "DW_AI_NOT_WIRED";
const UPDATE_NOT_WIRED = "DW_UPDATE_NOT_WIRED";

/** 自动更新接线参数（迭代 7 / AC16）：service 由 index.ts 以 app.isPackaged 构造。 */
export interface UpdateIpcDeps {
  service: UpdateService;
  /** app.getVersion() 值（渲染进程设置页展示当前版本）。 */
  version: string;
}

// ---------------------------------------------------------------------------
// handlers 表
// ---------------------------------------------------------------------------

/** 构建全部 invoke handler。key 集合 == IPC 常量全集 − PUSH_CHANNELS。 */
export function buildHandlerTable(services: IpcServices, hooks: IpcHooks, ai?: AiRuntime, update?: UpdateIpcDeps): Record<string, IpcHandler> {
  const { workspace, terminal, settings } = services;
  const table: Record<string, IpcHandler> = {};

  // ---- workspace ----
  table[IPC.WorkspaceOpenDialog] = async () => {
    const dir = await hooks.openDirectoryDialog();
    if (dir) {
      await workspace.openRoot(dir);
      workspace.watch();
    }
    return dir;
  };
  table[IPC.WorkspaceTree] = async (_e, root) => {
    const rootPath = String(root);
    await workspace.openRoot(rootPath);
    workspace.watch();
    return hooks.buildTree(rootPath);
  };
  table[IPC.WorkspaceRead] = (_e, filePath) => workspace.readFile(String(filePath));
  table[IPC.WorkspaceWrite] = async (_e, filePath, content) => {
    // 编辑器内保存 = 用户直接动作，无需授权门（AC4 授权门针对 agent 工具）
    await workspace.writeFile(String(filePath), String(content));
  };

  // ---- terminal ----
  table[IPC.TerminalCreate] = async (_e, cwd) => {
    const info = await terminal.create({ cwd: String(cwd) });
    terminal.onOutput(info.id, (data) => {
      hooks.send(IPC.TerminalOutput, info.id, data);
    });
    return info;
  };
  table[IPC.TerminalInput] = (_e, id, data) => {
    terminal.write(String(id), String(data));
  };
  table[IPC.TerminalResize] = (_e, id, cols, rows) => {
    terminal.resize(String(id), Number(cols), Number(rows));
  };
  table[IPC.TerminalDispose] = (_e, id) => {
    terminal.dispose(String(id));
  };

  // ---- settings ----
  table[IPC.SettingsGet] = (_e, key) => settings.get(String(key)) ?? null;
  table[IPC.SettingsSet] = (_e, key, value) => {
    settings.set(String(key), value);
  };

  // ---- 外部编辑器（AC10）：settings["externalEditor"].command 模板 → 真实 spawn ----
  table[IPC.ExternalEditorOpen] = async (_e, filePath, line) => {
    const config = settings.get("externalEditor") as ExternalEditorConfig | undefined;
    const command = config?.command ?? "";
    if (command.trim() === "") {
      // ASCII 错误码：渲染端据此弹出编辑器引导小页并本地化文案（GBK 终端 stderr 防乱码）
      throw new Error("DW_EXTERNAL_EDITOR_NOT_CONFIGURED");
    }
    await openInExternalEditor(command, String(filePath), typeof line === "number" ? line : 1);
  };

  // ---- credentials（明文绝不回传渲染进程，无 get 通道）----
  table[IPC.CredentialSet] = (_e, ref, provider, secret) => {
    settings.setCredential(String(ref), String(provider), String(secret));
  };
  table[IPC.CredentialDelete] = (_e, ref) => {
    settings.deleteCredential(String(ref));
  };
  table[IPC.CredentialList] = () => settings.listCredentials();

  // ---- providers（真实实现：配置存 settings 的 "providers" 键）----
  table[IPC.ProvidersList] = () => readProviders(settings);
  table[IPC.ProvidersUpsert] = (_e, config) => {
    const provider = config as ProviderConfig;
    if (!provider || typeof provider.id !== "string" || provider.id.length === 0) {
      throw new Error("Invalid ProviderConfig: id required");
    }
    const list = readProviders(settings);
    const idx = list.findIndex((p) => p.id === provider.id);
    if (idx >= 0) {
      list[idx] = provider;
    } else {
      list.push(provider);
    }
    settings.set("providers", list);
  };

  // ---- 自动更新（AC16）：未接线时抛明确错误码（白名单通道恒在表内）----
  if (update === undefined) {
    const notWired = (): never => {
      throw new Error(UPDATE_NOT_WIRED);
    };
    table[IPC.UpdateCheck] = notWired;
    table[IPC.UpdateInstall] = notWired;
    table[IPC.UpdateVersion] = notWired;
  } else {
    table[IPC.UpdateCheck] = async () => update.service.check();
    table[IPC.UpdateInstall] = () => {
      update.service.install();
    };
    table[IPC.UpdateVersion] = () => update.version;
  }

  registerAiIpc(table, ai);
  return table;
}

/**
 * AI 子系统注册（WU008-WU012 已接线）。
 * 生产路径：ai 为真实 AiRuntime，全部 handler 直连主进程组装链。
 * 无 ai（如白名单测试的最小替身环境）：handler 抛明确的未接线错误——
 * 调用方立即感知，不会拿到伪造数据。
 */
export function registerAiIpc(table: Record<string, IpcHandler>, ai?: AiRuntime): void {
  if (ai === undefined) {
    const notWired = (): never => {
      throw new Error(AI_NOT_WIRED);
    };
    table[IPC.AgentRun] = notWired;
    table[IPC.AgentCancel] = notWired;
    table[IPC.AgentAuthorize] = notWired;
    table[IPC.AgentTrace] = notWired;
    table[IPC.ModesList] = notWired;
    table[IPC.ModesUpsert] = notWired;
    table[IPC.ModesDelete] = notWired;
    table[IPC.ContextManifestLatest] = notWired;
    table[IPC.ContextManifestList] = notWired;
    table[IPC.ContextPolicyGet] = notWired;
    table[IPC.ContextPolicySet] = notWired;
    return;
  }
  table[IPC.AgentRun] = async (_e, input) => ai.run(input as AgentRunInput);
  table[IPC.AgentCancel] = (_e, sessionId) => {
    ai.cancel(String(sessionId));
  };
  table[IPC.AgentAuthorize] = (_e, sessionId, requestId, decision) =>
    ai.authorize(String(sessionId), String(requestId), decision as AuthorizationDecision);
  table[IPC.AgentTrace] = (_e, sessionId) => ai.trace(String(sessionId));
  table[IPC.ModesList] = () => ai.listModes();
  table[IPC.ModesUpsert] = (_e, mode) => {
    ai.upsertMode(mode as Parameters<AiRuntime["upsertMode"]>[0]);
  };
  table[IPC.ModesDelete] = (_e, id) => ai.deleteMode(String(id));
  table[IPC.ContextManifestLatest] = () => ai.getLatestManifest();
  table[IPC.ContextManifestList] = (_e, limit) => ai.listManifests(typeof limit === "number" ? limit : undefined);
  table[IPC.ContextPolicyGet] = () => ai.getContextPolicy();
  table[IPC.ContextPolicySet] = (_e, type, enabled) => {
    ai.setContextItemEnabled(type as ContextItemType, enabled === true);
  };
}

function readProviders(settings: SettingsStore): ProviderConfig[] {
  const raw = settings.get("providers");
  return Array.isArray(raw) ? (raw as ProviderConfig[]) : [];
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

export interface RegisterIpcDeps {
  ipcMain: IpcMainLike;
  services: IpcServices;
  hooks: IpcHooks;
  /** 生产环境注入真实 AiRuntime；缺省则 AI 通道抛未接线错误。 */
  ai?: AiRuntime;
  /** 生产环境注入 UpdateService + 版本号；缺省则 update 通道抛未接线错误。 */
  update?: UpdateIpcDeps;
}

/** 注册全部 IPC handler 与主→渲染事件转发。 */
export function registerIpcHandlers(deps: RegisterIpcDeps): void {
  const table = buildHandlerTable(deps.services, deps.hooks, deps.ai, deps.update);
  for (const [channel, handler] of Object.entries(table)) {
    deps.ipcMain.handle(channel, handler);
  }
  deps.services.workspace.onDidChange((event) => {
    deps.hooks.send(IPC.WorkspaceEvent, event);
  });
  deps.services.settings.onChanged((key, value) => {
    deps.hooks.send(IPC.SettingsChanged, key, value);
  });
}
