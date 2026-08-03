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
import { readFile, writeFile } from "node:fs/promises";
import { IPC } from "@devwit/contracts";
import type { AgentRunInput, AuthorizationDecision, ContextItemType, DebugBreakpoint, DebugScopeItem, DebugStackFrameItem, DebugStateInfo, DebugVariableItem, ExternalEditorConfig, GitBlameLine, GitBranch, GitDiffTexts, GitLogEntry, GitPanelStatus, GitStashEntry, LspCodeAction, LspCompletionItem, LspDefinitionTarget, LspDiagnosticItem, LspDocumentSymbol, LspHoverInfo, LspSignatureHelp, LspStatusInfo, LspTextEdit, ProviderConfig, ProviderProbeRequest, ProviderProbeResult, UsageExportFormat } from "@devwit/contracts";
import { PROVIDER_PRESETS, probeProvider } from "@devwit/llm-providers";
import { fetchCommunityIndex, fetchCommunityMode, materializeImport, parseExportFile, resolveModesIndexBase, toExportFile } from "@devwit/modes";
import { fetchCommunityMcpIndex, fetchCommunityMcpServer, materializeMcpImport } from "@devwit/mcp";
import type { SettingsStore } from "@devwit/settings";
import type { TerminalService } from "@devwit/terminal";
import type { WorkspaceService } from "@devwit/workspace";
import { searchInWorkspace } from "@devwit/workspace";
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
  /** JSON 保存对话框（迭代 14 / AC23 模式导出）：返回目标路径，取消返回 null */
  saveJsonFile(defaultName: string): Promise<string | null>;
  /** JSON 打开对话框（迭代 14 / AC23 模式导入）：返回源路径，取消返回 null */
  openJsonFile(): Promise<string | null>;
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
  IPC.UpdateStatus,
  IPC.McpChanged,
  IPC.RagStatus,
  IPC.LspStatus,
  IPC.LspDiagnosticsChanged,
  IPC.GitChanged,
  IPC.DebugState,
  IPC.DebugOutput
];

const AI_NOT_WIRED = "DW_AI_NOT_WIRED";
const UPDATE_NOT_WIRED = "DW_UPDATE_NOT_WIRED";
const LSP_NOT_WIRED = "DW_LSP_NOT_WIRED";
const GIT_NOT_WIRED = "DW_GIT_NOT_WIRED";
const DEBUG_NOT_WIRED = "DW_DEBUG_NOT_WIRED";

/** DAP 调试接线参数（迭代 33 / AC42）：结构子集与 DebugMainService 对齐（保持本文件无包运行时依赖）。 */
export interface DebugIpcService {
  start(program: string, breakpoints: Record<string, DebugBreakpoint[]>): Promise<void>;
  stop(): Promise<void>;
  getState(): DebugStateInfo;
  continue(): Promise<void>;
  next(): Promise<void>;
  stepIn(): Promise<void>;
  stepOut(): Promise<void>;
  setBreakpoints(file: string, breakpoints: DebugBreakpoint[]): Promise<void>;
  stack(): Promise<DebugStackFrameItem[]>;
  scopes(frameId: number): Promise<DebugScopeItem[]>;
  variables(reference: number): Promise<DebugVariableItem[]>;
  evaluate(expression: string, frameId?: number): Promise<DebugVariableItem>;
}

/** Git 接线参数（迭代 32 / AC41）：结构子集与 GitService 对齐（保持本文件无包运行时依赖）。 */
export interface GitIpcService {
  openWorkspace(root: string): void;
  status(): Promise<GitPanelStatus | null>;
  diffTexts(relPath: string): Promise<GitDiffTexts>;
  stage(relPath: string): Promise<void>;
  unstage(relPath: string): Promise<void>;
  commit(message: string): Promise<void>;
  pull(): Promise<void>;
  push(): Promise<void>;
  log(limit?: number): Promise<GitLogEntry[]>;
  listBranches(): Promise<GitBranch[]>;
  checkout(name: string): Promise<void>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  listStash(): Promise<GitStashEntry[]>;
  stashPush(message?: string): Promise<void>;
  stashPop(index: number): Promise<void>;
  stashApply(index: number): Promise<void>;
  stashDrop(index: number): Promise<void>;
  blame(relPath: string): Promise<GitBlameLine[]>;
}

/** LSP 接线参数（迭代 31 / AC40）：结构子集与 LspService 对齐（保持本文件无包运行时依赖）。 */
export interface LspIpcService {
  openWorkspace(root: string): void;
  status(): LspStatusInfo;
  didOpen(file: string, text: string): void;
  didChange(file: string, text: string): void;
  didClose(file: string): void;
  hover(file: string, line: number, character: number): Promise<LspHoverInfo | null>;
  definition(file: string, line: number, character: number): Promise<LspDefinitionTarget[]>;
  completion(file: string, line: number, character: number): Promise<LspCompletionItem[]>;
  references(file: string, line: number, character: number): Promise<LspDefinitionTarget[]>;
  signatureHelp(file: string, line: number, character: number): Promise<LspSignatureHelp | null>;
  rename(file: string, line: number, character: number, newName: string): Promise<LspTextEdit[]>;
  codeAction(file: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): Promise<LspCodeAction[]>;
  documentSymbols(file: string): Promise<LspDocumentSymbol[]>;
  diagnostics(): LspDiagnosticItem[];
}

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
export function buildHandlerTable(services: IpcServices, hooks: IpcHooks, ai?: AiRuntime, update?: UpdateIpcDeps, lsp?: LspIpcService, git?: GitIpcService, debug?: DebugIpcService): Record<string, IpcHandler> {
  const { workspace, terminal, settings } = services;
  const table: Record<string, IpcHandler> = {};

  // ---- workspace ----
  table[IPC.WorkspaceOpenDialog] = async () => {
    const dir = await hooks.openDirectoryDialog();
    if (dir) {
      await workspace.openRoot(dir);
      workspace.watch();
      ai?.refreshRag(); // AC19：工作区确定后立即评估/构建代码索引
      ai?.refreshSymbols(); // AC38：符号索引与 RAG 解耦，同址构建
      lsp?.openWorkspace(dir); // AC40：工作区打开即启动 tsserver（零系统依赖）
      git?.openWorkspace(dir); // AC41：Git 服务绑定仓库根（非 git 目录状态为 null）
    }
    return dir;
  };
  table[IPC.WorkspaceTree] = async (_e, root) => {
    const rootPath = String(root);
    await workspace.openRoot(rootPath);
    workspace.watch();
    ai?.refreshRag();
    ai?.refreshSymbols();
    lsp?.openWorkspace(rootPath);
    git?.openWorkspace(rootPath);
    return hooks.buildTree(rootPath);
  };
  table[IPC.WorkspaceRead] = (_e, filePath) => workspace.readFile(String(filePath));
  table[IPC.WorkspaceWrite] = async (_e, filePath, content) => {
    // 编辑器内保存 = 用户直接动作，无需授权门（AC4 授权门针对 agent 工具）
    await workspace.writeFile(String(filePath), String(content));
  };
  table[IPC.WorkspaceSearch] = async (_e, root, options) => {
    // 跨文件搜索（v0.4.0）：主进程遍历文件树读取搜索，避免渲染端大量 IPC 往返
    const opts = (options ?? {}) as Record<string, unknown>;
    return searchInWorkspace(String(root), {
      query: typeof opts["query"] === "string" ? opts["query"] : "",
      isRegex: opts["isRegex"] === true,
      caseSensitive: opts["caseSensitive"] === true,
      wholeWord: opts["wholeWord"] === true,
      maxResultsPerFile: typeof opts["maxResultsPerFile"] === "number" ? opts["maxResultsPerFile"] : undefined,
      maxFiles: typeof opts["maxFiles"] === "number" ? opts["maxFiles"] : undefined,
    });
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
  // 迭代 13 / AC22：知名服务预设目录（llm-providers 唯一持有 endpoint 知识，AR002）
  table[IPC.ProviderPresets] = () => PROVIDER_PRESETS;
  // 迭代 17 / AC26：连接探测——真实 GET 模型列表端点，验证可达性 + 发现服务器型号。
  // 凭证解析顺序：表单明文 apiKey（不落盘）> credentialRef（settings 凭证存储）；
  // keyless 跳过全部凭证逻辑。探测失败抛 DW_PROBE_* ASCII 错误码。
  table[IPC.ProvidersProbe] = async (_e, req) => {
    const probe = req as ProviderProbeRequest;
    if (!probe || (probe.type !== "anthropic" && probe.type !== "openai") || typeof probe.baseUrl !== "string") {
      throw new Error("DW_PROBE_INVALID_URL:bad-request");
    }
    let apiKey: string | undefined;
    if (probe.keyless !== true) {
      if (typeof probe.apiKey === "string" && probe.apiKey !== "") {
        apiKey = probe.apiKey;
      } else if (typeof probe.credentialRef === "string" && probe.credentialRef !== "") {
        apiKey = await settings.resolve(probe.credentialRef).catch(() => undefined);
      }
    }
    const result: ProviderProbeResult = await probeProvider({
      type: probe.type,
      baseUrl: probe.baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(typeof probe.timeoutMs === "number" ? { timeoutMs: probe.timeoutMs } : {}),
    });
    return result;
  };
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

  // ---- LSP 代码智能（迭代 31 / AC40）：未接线时抛明确错误码（白名单通道恒在表内）----
  if (lsp === undefined) {
    const notWired = (): never => {
      throw new Error(LSP_NOT_WIRED);
    };
    table[IPC.LspGetStatus] = notWired;
    table[IPC.LspDidOpen] = notWired;
    table[IPC.LspDidChange] = notWired;
    table[IPC.LspDidClose] = notWired;
    table[IPC.LspHover] = notWired;
    table[IPC.LspDefinition] = notWired;
    table[IPC.LspCompletion] = notWired;
    table[IPC.LspReferences] = notWired;
    table[IPC.LspSignatureHelp] = notWired;
    table[IPC.LspRename] = notWired;
    table[IPC.LspCodeAction] = notWired;
    table[IPC.LspDocumentSymbol] = notWired;
    table[IPC.LspDiagnostics] = notWired;
  } else {
    table[IPC.LspGetStatus] = () => lsp.status();
    table[IPC.LspDidOpen] = (_e, file, text) => {
      lsp.didOpen(String(file), String(text));
    };
    table[IPC.LspDidChange] = (_e, file, text) => {
      lsp.didChange(String(file), String(text));
    };
    table[IPC.LspDidClose] = (_e, file) => {
      lsp.didClose(String(file));
    };
    table[IPC.LspHover] = async (_e, file, line, character) =>
      lsp.hover(String(file), Number(line), Number(character));
    table[IPC.LspDefinition] = async (_e, file, line, character) =>
      lsp.definition(String(file), Number(line), Number(character));
    table[IPC.LspCompletion] = async (_e, file, line, character) =>
      lsp.completion(String(file), Number(line), Number(character));
    table[IPC.LspReferences] = async (_e, file, line, character) =>
      lsp.references(String(file), Number(line), Number(character));
    table[IPC.LspSignatureHelp] = async (_e, file, line, character) =>
      lsp.signatureHelp(String(file), Number(line), Number(character));
    table[IPC.LspRename] = async (_e, file, line, character, newName) =>
      lsp.rename(String(file), Number(line), Number(character), String(newName));
    table[IPC.LspCodeAction] = async (_e, file, startLine, startCharacter, endLine, endCharacter) =>
      lsp.codeAction(String(file), Number(startLine), Number(startCharacter), Number(endLine), Number(endCharacter));
    table[IPC.LspDocumentSymbol] = async (_e, file) => lsp.documentSymbols(String(file));
    table[IPC.LspDiagnostics] = () => lsp.diagnostics();
  }

  // ---- Git 版本控制（迭代 32 / AC41）：未接线时抛明确错误码（白名单通道恒在表内）----
  if (git === undefined) {
    const notWired = (): never => {
      throw new Error(GIT_NOT_WIRED);
    };
    table[IPC.GitGetStatus] = notWired;
    table[IPC.GitDiff] = notWired;
    table[IPC.GitStage] = notWired;
    table[IPC.GitUnstage] = notWired;
    table[IPC.GitCommit] = notWired;
    table[IPC.GitPull] = notWired;
    table[IPC.GitPush] = notWired;
    table[IPC.GitLog] = notWired;
    table[IPC.GitListBranches] = notWired;
    table[IPC.GitCheckout] = notWired;
    table[IPC.GitCreateBranch] = notWired;
    table[IPC.GitDeleteBranch] = notWired;
    table[IPC.GitStashList] = notWired;
    table[IPC.GitStashPush] = notWired;
    table[IPC.GitStashPop] = notWired;
    table[IPC.GitStashApply] = notWired;
    table[IPC.GitStashDrop] = notWired;
    table[IPC.GitBlame] = notWired;
  } else {
    table[IPC.GitGetStatus] = () => git.status();
    table[IPC.GitDiff] = (_e, file) => git.diffTexts(String(file));
    table[IPC.GitStage] = async (_e, file) => {
      await git.stage(String(file));
    };
    table[IPC.GitUnstage] = async (_e, file) => {
      await git.unstage(String(file));
    };
    table[IPC.GitCommit] = async (_e, message) => {
      await git.commit(String(message));
    };
    table[IPC.GitPull] = async () => {
      await git.pull();
    };
    table[IPC.GitPush] = async () => {
      await git.push();
    };
    table[IPC.GitLog] = (_e, limit) => git.log(typeof limit === "number" ? limit : undefined);
    table[IPC.GitListBranches] = () => git.listBranches();
    table[IPC.GitCheckout] = async (_e, name) => {
      await git.checkout(String(name));
    };
    table[IPC.GitCreateBranch] = async (_e, name, doCheckout) => {
      await git.createBranch(String(name), Boolean(doCheckout));
    };
    table[IPC.GitDeleteBranch] = async (_e, name) => {
      await git.deleteBranch(String(name));
    };
    table[IPC.GitStashList] = () => git.listStash();
    table[IPC.GitStashPush] = async (_e, message) => {
      await git.stashPush(typeof message === "string" ? message : undefined);
    };
    table[IPC.GitStashPop] = async (_e, index) => {
      await git.stashPop(Number(index));
    };
    table[IPC.GitStashApply] = async (_e, index) => {
      await git.stashApply(Number(index));
    };
    table[IPC.GitStashDrop] = async (_e, index) => {
      await git.stashDrop(Number(index));
    };
    table[IPC.GitBlame] = (_e, file) => git.blame(String(file));
  }

  // ---- DAP 调试（迭代 33 / AC42）：未接线时抛明确错误码（白名单通道恒在表内）----
  if (debug === undefined) {
    const notWired = (): never => {
      throw new Error(DEBUG_NOT_WIRED);
    };
    table[IPC.DebugStart] = notWired;
    table[IPC.DebugStop] = notWired;
    table[IPC.DebugGetState] = notWired;
    table[IPC.DebugContinue] = notWired;
    table[IPC.DebugNext] = notWired;
    table[IPC.DebugStepIn] = notWired;
    table[IPC.DebugStepOut] = notWired;
    table[IPC.DebugStack] = notWired;
    table[IPC.DebugScopes] = notWired;
    table[IPC.DebugVariables] = notWired;
    table[IPC.DebugSetBreakpoints] = notWired;
    table[IPC.DebugEvaluate] = notWired;
  } else {
    table[IPC.DebugStart] = async (_e, program, breakpoints) =>
      debug.start(String(program), breakpoints as Record<string, DebugBreakpoint[]>);
    table[IPC.DebugSetBreakpoints] = async (_e, file, breakpoints) =>
      debug.setBreakpoints(String(file), breakpoints as DebugBreakpoint[]);
    table[IPC.DebugStop] = async () => debug.stop();
    table[IPC.DebugGetState] = () => debug.getState();
    table[IPC.DebugContinue] = async () => debug.continue();
    table[IPC.DebugNext] = async () => debug.next();
    table[IPC.DebugStepIn] = async () => debug.stepIn();
    table[IPC.DebugStepOut] = async () => debug.stepOut();
    table[IPC.DebugStack] = async () => debug.stack();
    table[IPC.DebugScopes] = async (_e, frameId) => debug.scopes(Number(frameId));
    table[IPC.DebugVariables] = async (_e, reference) => debug.variables(Number(reference));
    table[IPC.DebugEvaluate] = async (_e, expression, frameId) =>
      debug.evaluate(String(expression), typeof frameId === "number" ? frameId : undefined);
  }

  registerAiIpc(table, ai, services, hooks);
  return table;
}

/** 模式导出建议文件名：剔除 Windows 非法文件名字符，兜底 "mode"。 */
function modeExportFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return `${safe === "" ? "mode" : safe}.json`;
}

/**
 * AI 子系统注册（WU008-WU012 已接线）。
 * 生产路径：ai 为真实 AiRuntime，全部 handler 直连主进程组装链。
 * 无 ai（如白名单测试的最小替身环境）：handler 抛明确的未接线错误——
 * 调用方立即感知，不会拿到伪造数据。
 */
export function registerAiIpc(table: Record<string, IpcHandler>, ai?: AiRuntime, services?: IpcServices, hooks?: IpcHooks): void {
  if (ai === undefined) {
    const notWired = (): never => {
      throw new Error(AI_NOT_WIRED);
    };
    table[IPC.AgentRun] = notWired;
    table[IPC.AgentCancel] = notWired;
    table[IPC.AgentAuthorize] = notWired;
    table[IPC.AgentTrace] = notWired;
    table[IPC.AgentTraceList] = notWired;
    table[IPC.ModesList] = notWired;
    table[IPC.ModesUpsert] = notWired;
    table[IPC.ModesDelete] = notWired;
    table[IPC.ModesExport] = notWired;
    table[IPC.ModesImport] = notWired;
    table[IPC.ModesCommunityList] = notWired;
    table[IPC.ModesCommunityImport] = notWired;
    table[IPC.ContextManifestLatest] = notWired;
    table[IPC.ContextManifestList] = notWired;
    table[IPC.ContextPolicyGet] = notWired;
    table[IPC.ContextPolicySet] = notWired;
    table[IPC.ContextItemOverrideSet] = notWired;
    table[IPC.RagGetStatus] = notWired;
    table[IPC.RagRebuild] = notWired;
    table[IPC.McpList] = notWired;
    table[IPC.McpUpsert] = notWired;
    table[IPC.McpDelete] = notWired;
    table[IPC.McpCommunityList] = notWired;
    table[IPC.McpCommunityImport] = notWired;
    table[IPC.UsageSummary] = notWired;
    table[IPC.UsageClear] = notWired;
    table[IPC.UsageDaily] = notWired;
    table[IPC.UsageBudget] = notWired;
    table[IPC.UsageExport] = notWired;
    table[IPC.SessionsList] = notWired;
    table[IPC.SessionsRename] = notWired;
    table[IPC.SessionsDelete] = notWired;
    table[IPC.SymbolsQuery] = notWired;
    return;
  }
  table[IPC.AgentRun] = async (_e, input) => ai.run(input as AgentRunInput);
  table[IPC.AgentCancel] = (_e, sessionId) => {
    ai.cancel(String(sessionId));
  };
  table[IPC.AgentAuthorize] = (_e, sessionId, requestId, decision) =>
    ai.authorize(String(sessionId), String(requestId), decision as AuthorizationDecision);
  table[IPC.AgentTrace] = (_e, sessionId) => ai.trace(String(sessionId));
  // ---- 历史会话轨迹摘要（迭代 27 / AC36）：会话回放选择器数据源 ----
  table[IPC.AgentTraceList] = () => ai.listTraceSessions();
  table[IPC.ModesList] = () => ai.listModes();
  table[IPC.ModesUpsert] = (_e, mode) => {
    ai.upsertMode(mode as Parameters<AiRuntime["upsertMode"]>[0]);
  };
  table[IPC.ModesDelete] = (_e, id) => ai.deleteMode(String(id));
  // ---- 模式导出/导入（迭代 14 / AC23）：对话框路径由 hooks 注入，文件 IO 在主进程 ----
  table[IPC.ModesExport] = async (_e, id) => {
    if (hooks === undefined) throw new Error(AI_NOT_WIRED);
    const mode = ai.listModes().find((candidate) => candidate.id === String(id));
    if (mode === undefined) throw new Error(`DW_MODE_NOT_FOUND:${String(id)}`);
    const target = await hooks.saveJsonFile(modeExportFileName(mode.name));
    if (target === null) return null;
    await writeFile(target, `${JSON.stringify(toExportFile(mode), null, 2)}\n`, "utf-8");
    return target;
  };
  table[IPC.ModesImport] = async () => {
    if (hooks === undefined || services === undefined) throw new Error(AI_NOT_WIRED);
    const source = await hooks.openJsonFile();
    if (source === null) return null;
    const parsed = parseExportFile(await readFile(source, "utf-8"));
    const providerIds = new Set(readProviders(services.settings).map((provider) => provider.id));
    const existingIds = new Set(ai.listModes().map((mode) => mode.id));
    const mode = materializeImport(parsed, { existingIds, providerIds });
    ai.upsertMode(mode);
    return mode;
  };
  // ---- 社区模式（迭代 16 / AC25）：索引仓库浏览 + 一键导入（校验/落库与文件导入同管线） ----
  table[IPC.ModesCommunityList] = async () => fetchCommunityIndex(resolveModesIndexBase(), (url) => fetch(url));
  table[IPC.ModesCommunityImport] = async (_e, file) => {
    if (services === undefined) throw new Error(AI_NOT_WIRED);
    const parsed = await fetchCommunityMode(resolveModesIndexBase(), String(file), (url) => fetch(url));
    const providerIds = new Set(readProviders(services.settings).map((provider) => provider.id));
    const existingIds = new Set(ai.listModes().map((mode) => mode.id));
    const mode = materializeImport(parsed, { existingIds, providerIds });
    ai.upsertMode(mode);
    return mode;
  };
  table[IPC.ContextManifestLatest] = () => ai.getLatestManifest();
  table[IPC.ContextManifestList] = (_e, limit) => ai.listManifests(typeof limit === "number" ? limit : undefined);
  table[IPC.ContextPolicyGet] = () => ai.getContextPolicy();
  table[IPC.ContextPolicySet] = (_e, type, enabled) => {
    ai.setContextItemEnabled(type as ContextItemType, enabled === true);
  };
  table[IPC.ContextItemOverrideSet] = (_e, key, enabled) => {
    ai.setContextItemOverride(String(key), enabled === true);
  };
  table[IPC.RagGetStatus] = () => ai.getRagStatus();
  table[IPC.RagRebuild] = async () => ai.rebuildRag();
  table[IPC.McpList] = () => ai.listMcpServers();
  table[IPC.McpUpsert] = (_e, config) => {
    ai.upsertMcpServer(config as Parameters<AiRuntime["upsertMcpServer"]>[0]);
  };
  table[IPC.McpDelete] = (_e, id) => {
    ai.deleteMcpServer(String(id));
  };
  // ---- 社区 MCP 服务器（迭代 25 / AC34）：与模式同一索引仓库的 mcpServers 段；
  // 导入 = 拉取条目文件 → 信封+配置同标准校验 → 新 id 落 settings（热同步启动进程） ----
  table[IPC.McpCommunityList] = async () => fetchCommunityMcpIndex(resolveModesIndexBase(), (url) => fetch(url));
  table[IPC.McpCommunityImport] = async (_e, file) => {
    const parsed = await fetchCommunityMcpServer(resolveModesIndexBase(), String(file), (url) => fetch(url));
    const existingIds = new Set(ai.listMcpServers().map((view) => view.config.id));
    const config = materializeMcpImport(parsed, { existingIds });
    ai.upsertMcpServer(config);
    return config;
  };
  // ---- 用量统计（迭代 26 / AC35）：真实 token 用量的聚合查询与清零 ----
  table[IPC.UsageSummary] = () => ai.usageSummary();
  table[IPC.UsageClear] = () => {
    ai.usageClear();
  };
  table[IPC.UsageDaily] = () => ai.usageDailySummary();
  table[IPC.UsageBudget] = (_e, threshold, period) =>
    ai.usageCheckBudget(Number(threshold), period as "day" | "week" | "month" | "total");
  table[IPC.UsageExport] = (_e, format) => ai.usageExport(format as UsageExportFormat);
  // ---- 对话会话管理（迭代 28 / AC37）：多会话列表 / 重命名 / 删除 ----
  table[IPC.SessionsList] = () => ai.listChatSessions();
  table[IPC.SessionsRename] = (_e, sessionId, title) => {
    ai.renameChatSession(String(sessionId), String(title));
  };
  table[IPC.SessionsDelete] = (_e, sessionId) => {
    ai.deleteChatSession(String(sessionId));
  };
  // ---- 符号级索引（迭代 29 / AC38）：@符号 引用候选查询 ----
  table[IPC.SymbolsQuery] = (_e, query) => ai.querySymbols(String(query));
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
  /** 生产环境注入 LspService；缺省则 lsp 通道抛未接线错误。 */
  lsp?: LspIpcService;
  /** 生产环境注入 GitMainService；缺省则 git 通道抛未接线错误。 */
  git?: GitIpcService;
  /** 生产环境注入 DebugMainService；缺省则 debug 通道抛未接线错误。 */
  debug?: DebugIpcService;
}

/** 注册全部 IPC handler 与主→渲染事件转发。 */
export function registerIpcHandlers(deps: RegisterIpcDeps): void {
  const table = buildHandlerTable(deps.services, deps.hooks, deps.ai, deps.update, deps.lsp, deps.git, deps.debug);
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
