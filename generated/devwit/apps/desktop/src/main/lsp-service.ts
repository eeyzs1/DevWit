/**
 * 主进程 LSP 服务（迭代 31 / AC40）：typescript-language-server + pyright 生命周期门面。
 *
 * 工作区打开（WorkspaceOpenDialog/WorkspaceTree IPC）即启动两个服务器——
 * ELECTRON_RUN_AS_NODE=1 使 Electron 二进制退化为纯 node 运行 cli.mjs/langserver.js，
 * 用户机器零系统依赖（无需安装 Node.js）。
 *
 * 打包环境路径：cli.mjs / pyright-langserver.js 必须落在 app.asar.unpacked（asar 内文件
 * 对 spawn 的子进程不可读），require.resolve 命中 asar 路径时替换为 unpacked 对应物
 * （electron-builder.yml files/asarUnpack 已声明对应 node_modules 子集）。
 *
 * 多语言路由（v0.5.0）：.py 文件 → pyServer（pyright）；其余 → tsServer（tsserver）。
 * 状态聚合：任一 error → error；否则任一 starting → starting；否则任一 ready → ready。
 * 诊断聚合：合并两个 server 的诊断快照。
 */
import { createRequire } from "node:module";
import { IPC } from "@devwit/contracts";
import type { LspCodeAction, LspCompletionItem, LspDefinitionTarget, LspDiagnosticItem, LspDocumentSymbol, LspHoverInfo, LspSignatureHelp, LspStatusInfo, LspTextEdit } from "@devwit/contracts";
import { TsLanguageServer, pythonLanguageIdFor } from "@devwit/lsp";

export interface LspServiceDeps {
  /** 主→渲染推送（状态与诊断变化）。 */
  send: (channel: string, ...args: unknown[]) => void;
  /** 测试注入：tsserver cli.mjs 绝对路径（缺省走 require.resolve 生产解析）。 */
  cliPath?: string;
  /** 测试注入：pyright-langserver.js 绝对路径（缺省走 require.resolve 生产解析）。 */
  pyrightCliPath?: string;
  /** 测试注入：node 可执行（缺省 process.execPath + ELECTRON_RUN_AS_NODE）。 */
  nodeCommand?: string;
  requestTimeoutMs?: number;
}

/** 解析 typescript-language-server cli.mjs（asar 内 → unpacked 替换）。 */
export function resolveTsServerCli(): string {
  const require = createRequire(import.meta.url);
  const resolved = require.resolve("typescript-language-server/lib/cli.mjs");
  // app.asar.unpacked 目录由 electron-builder asarUnpack 保证存在
  return resolved.includes("app.asar") ? resolved.replace("app.asar", "app.asar.unpacked") : resolved;
}

/** 解析 pyright-langserver.js（asar 内 → unpacked 替换）。 */
export function resolvePyrightCli(): string {
  const require = createRequire(import.meta.url);
  const resolved = require.resolve("pyright/dist/pyright-langserver.js");
  return resolved.includes("app.asar") ? resolved.replace("app.asar", "app.asar.unpacked") : resolved;
}

/**
 * LSP 服务单实例：持有 TsLanguageServer（TS/JS）+ TsLanguageServer（Python/pyright），
 * 按文件扩展名路由请求，聚合状态/诊断推送。
 */
export class LspService {
  private readonly tsServer: TsLanguageServer;
  private readonly pyServer: TsLanguageServer;
  private readonly sendFn: (channel: string, ...args: unknown[]) => void;

  constructor(deps: LspServiceDeps) {
    this.sendFn = deps.send;
    this.tsServer = new TsLanguageServer({
      cliPath: deps.cliPath ?? resolveTsServerCli(),
      nodeCommand: deps.nodeCommand ?? process.execPath,
      ...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
    });
    this.pyServer = new TsLanguageServer({
      cliPath: deps.pyrightCliPath ?? resolvePyrightCli(),
      nodeCommand: deps.nodeCommand ?? process.execPath,
      ...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
      languageIdFor: pythonLanguageIdFor,
    });
    this.tsServer.onStatus = () => this.emitStatus();
    this.pyServer.onStatus = () => this.emitStatus();
    this.tsServer.onDiagnostics = () => this.emitDiagnostics();
    this.pyServer.onDiagnostics = () => this.emitDiagnostics();
  }

  /** 聚合状态推送：任一 error → error；否则任一 starting → starting；否则任一 ready → ready。 */
  private emitStatus(): void {
    const ts = this.tsServer.currentStatus;
    const py = this.pyServer.currentStatus;
    let merged: LspStatusInfo;
    if (ts.state === "error" || py.state === "error") {
      merged = ts.state === "error" ? ts : py;
    } else if (ts.state === "starting" || py.state === "starting") {
      merged = ts.state === "starting" ? ts : py;
    } else if (ts.state === "ready" || py.state === "ready") {
      merged = ts.state === "ready" ? ts : py;
    } else {
      merged = ts;
    }
    this.sendFn(IPC.LspStatus, merged);
  }

  /** 聚合诊断推送：合并两个 server 的诊断快照。 */
  private emitDiagnostics(): void {
    this.sendFn(IPC.LspDiagnosticsChanged, this.diagnostics());
  }

  /** 按文件扩展名路由到对应的 server（.py → pyServer；其余 → tsServer）。 */
  private serverFor(file: string): TsLanguageServer {
    return file.toLowerCase().endsWith(".py") ? this.pyServer : this.tsServer;
  }

  /** 工作区打开（幂等；失败由状态推送上报，不抛出打断打开流程）。 */
  openWorkspace(root: string): void {
    void this.tsServer.openWorkspace(root).catch(() => undefined);
    void this.pyServer.openWorkspace(root).catch(() => undefined);
  }

  status(): LspStatusInfo {
    const ts = this.tsServer.currentStatus;
    const py = this.pyServer.currentStatus;
    if (ts.state === "error" || py.state === "error") return ts.state === "error" ? ts : py;
    if (ts.state === "starting" || py.state === "starting") return ts.state === "starting" ? ts : py;
    if (ts.state === "ready" || py.state === "ready") return ts.state === "ready" ? ts : py;
    return ts;
  }

  didOpen(file: string, text: string): void {
    this.serverFor(file).didOpen(file, text);
  }

  didChange(file: string, text: string): void {
    this.serverFor(file).didChange(file, text);
  }

  didClose(file: string): void {
    this.serverFor(file).didClose(file);
  }

  hover(file: string, line: number, character: number): Promise<LspHoverInfo | null> {
    return this.serverFor(file).hover(file, line, character);
  }

  definition(file: string, line: number, character: number): Promise<LspDefinitionTarget[]> {
    return this.serverFor(file).definition(file, line, character);
  }

  completion(file: string, line: number, character: number): Promise<LspCompletionItem[]> {
    return this.serverFor(file).completion(file, line, character);
  }

  references(file: string, line: number, character: number): Promise<LspDefinitionTarget[]> {
    return this.serverFor(file).references(file, line, character);
  }

  signatureHelp(file: string, line: number, character: number): Promise<LspSignatureHelp | null> {
    return this.serverFor(file).signatureHelp(file, line, character);
  }

  rename(file: string, line: number, character: number, newName: string): Promise<LspTextEdit[]> {
    return this.serverFor(file).rename(file, line, character, newName);
  }

  codeAction(file: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): Promise<LspCodeAction[]> {
    return this.serverFor(file).codeAction(file, startLine, startCharacter, endLine, endCharacter);
  }

  documentSymbols(file: string): Promise<LspDocumentSymbol[]> {
    return this.serverFor(file).documentSymbols(file);
  }

  diagnostics(): LspDiagnosticItem[] {
    return [...this.tsServer.listDiagnostics(), ...this.pyServer.listDiagnostics()];
  }

  /** 应用退出：shutdown 请求 → exit 通知 → 3s 超时强杀（同 MCP 口径，零孤儿进程）。 */
  async shutdown(): Promise<void> {
    await Promise.allSettled([this.tsServer.shutdown(), this.pyServer.shutdown()]);
  }
}
