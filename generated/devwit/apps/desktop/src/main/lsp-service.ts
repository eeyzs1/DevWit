/**
 * 主进程 LSP 服务（迭代 31 / AC40）：typescript-language-server 生命周期门面。
 *
 * 工作区打开（WorkspaceOpenDialog/WorkspaceTree IPC）即启动服务器——
 * ELECTRON_RUN_AS_NODE=1 使 Electron 二进制退化为纯 node 运行 cli.mjs，
 * 用户机器零系统依赖（无需安装 Node.js）。
 *
 * 打包环境路径：cli.mjs 必须落在 app.asar.unpacked（asar 内文件对 spawn 的
 * 子进程不可读），require.resolve 命中 asar 路径时替换为 unpacked 对应物
 * （electron-builder.yml files/asarUnpack 已声明对应 node_modules 子集）。
 */
import { createRequire } from "node:module";
import { IPC } from "@devwit/contracts";
import type { LspCodeAction, LspCompletionItem, LspDefinitionTarget, LspDiagnosticItem, LspHoverInfo, LspSignatureHelp, LspStatusInfo, LspTextEdit } from "@devwit/contracts";
import { TsLanguageServer } from "@devwit/lsp";

export interface LspServiceDeps {
  /** 主→渲染推送（状态与诊断变化）。 */
  send: (channel: string, ...args: unknown[]) => void;
  /** 测试注入：cli.mjs 绝对路径（缺省走 require.resolve 生产解析）。 */
  cliPath?: string;
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

/**
 * LSP 服务单实例：持有 TsLanguageServer，转发状态/诊断推送，
 * 向 IPC 层暴露同步/请求方法（坐标系 = 工作区相对路径 + 0-based 行列）。
 */
export class LspService {
  private readonly server: TsLanguageServer;

  constructor(deps: LspServiceDeps) {
    this.server = new TsLanguageServer({
      cliPath: deps.cliPath ?? resolveTsServerCli(),
      nodeCommand: deps.nodeCommand ?? process.execPath,
      ...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
    });
    this.server.onStatus = (status) => deps.send(IPC.LspStatus, status);
    this.server.onDiagnostics = () => {
      deps.send(IPC.LspDiagnosticsChanged, this.server.listDiagnostics());
    };
  }

  /** 工作区打开（幂等；失败由状态推送上报，不抛出打断打开流程）。 */
  openWorkspace(root: string): void {
    void this.server.openWorkspace(root).catch(() => undefined);
  }

  status(): LspStatusInfo {
    return this.server.currentStatus;
  }

  didOpen(file: string, text: string): void {
    this.server.didOpen(file, text);
  }

  didChange(file: string, text: string): void {
    this.server.didChange(file, text);
  }

  didClose(file: string): void {
    this.server.didClose(file);
  }

  hover(file: string, line: number, character: number): Promise<LspHoverInfo | null> {
    return this.server.hover(file, line, character);
  }

  definition(file: string, line: number, character: number): Promise<LspDefinitionTarget[]> {
    return this.server.definition(file, line, character);
  }

  completion(file: string, line: number, character: number): Promise<LspCompletionItem[]> {
    return this.server.completion(file, line, character);
  }

  references(file: string, line: number, character: number): Promise<LspDefinitionTarget[]> {
    return this.server.references(file, line, character);
  }

  signatureHelp(file: string, line: number, character: number): Promise<LspSignatureHelp | null> {
    return this.server.signatureHelp(file, line, character);
  }

  rename(file: string, line: number, character: number, newName: string): Promise<LspTextEdit[]> {
    return this.server.rename(file, line, character, newName);
  }

  codeAction(file: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number): Promise<LspCodeAction[]> {
    return this.server.codeAction(file, startLine, startCharacter, endLine, endCharacter);
  }

  diagnostics(): LspDiagnosticItem[] {
    return this.server.listDiagnostics();
  }

  /** 应用退出：shutdown 请求 → exit 通知 → 3s 超时强杀（同 MCP 口径，零孤儿进程）。 */
  async shutdown(): Promise<void> {
    await this.server.shutdown();
  }
}
