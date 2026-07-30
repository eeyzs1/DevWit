/**
 * TypeScript language server 生命周期管理（迭代 31 / AC40）。
 *
 * spawn typescript-language-server --stdio（ELECTRON_RUN_AS_NODE 使 Electron
 * 二进制退化为纯 node，用户机器零系统依赖），管理文档同步
 * （didOpen/didChange Full/didClose）、hover/definition 请求、
 * publishDiagnostics 聚合 store 与状态机（idle/starting/ready/error）。
 *
 * 坐标系：对外一律「工作区相对路径（正斜杠）+ LSP 原生 0-based 行列」，
 * 与编辑器 Position 语义一致；URI 编解码只在本文件发生（单一真相点）。
 */
import path from "node:path";
import type {
  LspCompletionItem,
  LspDefinitionTarget,
  LspDiagnosticItem,
  LspHoverInfo,
  LspStatusInfo,
} from "@devwit/contracts";
import { LspClient, nodeSpawnFactory, type LspChildProcess, type LspSpawnFactory } from "./lsp-client.js";

// ---------------------------------------------------------------------------
// 路径 ↔ file URI（Windows 盘符冒号按 RFC 3986 百分号编码）
// ---------------------------------------------------------------------------

export function absolutePathToUri(absPath: string): string {
  const normalized = path.resolve(absPath).replace(/\\/g, "/");
  const segments = normalized.split("/").map((seg) => encodeURIComponent(seg));
  // normalized 以盘符（E:/...）或 POSIX 根（/...）开头；统一拼 file:/// 前缀
  const joined = segments.join("/");
  return joined.startsWith("/") ? `file://${joined}` : `file:///${joined}`;
}

export function uriToAbsolutePath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let rest = uri.slice("file://".length);
  // file:///e%3A/... 或 file:///C:/... —— 去掉前导斜杠后解码
  if (rest.startsWith("/")) rest = rest.slice(1);
  const decoded = decodeURIComponent(rest);
  // POSIX 路径（/home/...）：还原前导斜杠（盘符形态 e:/... 不需要）
  if (!/^[A-Za-z]:\//.test(decoded)) return `/${decoded}`;
  return decoded;
}

/** 扩展名 → LSP languageId（ts/tsx/js/jsx/mts/cts/mjs/cjs；其余返回 null 不同步）。 */
export function languageIdFor(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// LSP 响应形状（仅声明用到的字段）
// ---------------------------------------------------------------------------

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface LspRawDiagnostic {
  range: LspRange;
  severity?: number; // 1=Error 2=Warning 3=Information 4=Hint
  code?: string | number;
  message: string;
}

interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspRawDiagnostic[];
}

type LspMarkedString = string | { language: string; value: string };

interface LspRawHover {
  contents?: LspMarkedString | LspMarkedString[] | { kind?: string; value: string };
  range?: LspRange;
}

interface LspRawLocation {
  uri: string;
  range: LspRange;
}

interface LspRawCompletionItem {
  label: string;
  detail?: string;
  kind?: number;
  insertText?: string;
}

interface LspRawCompletionList {
  isIncomplete?: boolean;
  items?: LspRawCompletionItem[];
}

const SEVERITY_MAP: Record<number, LspDiagnosticItem["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** hover contents 归一化为单个文本（MarkedString/MarkupContent/数组三形态归一）。 */
export function normalizeHoverText(raw: LspRawHover | null | undefined): string | null {
  const contents = raw?.contents;
  if (contents === undefined || contents === null) return null;
  if (typeof contents === "string") return contents === "" ? null : contents;
  if (Array.isArray(contents)) {
    const text = contents
      .map((item) => (typeof item === "string" ? item : item.value))
      .filter((item) => item.trim() !== "")
      .join("\n\n");
    return text === "" ? null : text;
  }
  if (typeof contents === "object" && "value" in contents && typeof contents.value === "string") {
    return contents.value === "" ? null : contents.value;
  }
  return null;
}

export interface TsLanguageServerOptions {
  /** typescript-language-server cli.mjs 绝对路径。 */
  cliPath: string;
  /** node 可执行（生产：process.execPath + ELECTRON_RUN_AS_NODE）。 */
  nodeCommand: string;
  /** 注入子进程环境（含 ELECTRON_RUN_AS_NODE）。 */
  env?: NodeJS.ProcessEnv;
  /** spawn 工厂（测试注入假进程）。 */
  spawnImpl?: LspSpawnFactory;
  requestTimeoutMs?: number;
}

interface OpenDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

/**
 * TS 语言服务器单实例。openWorkspace 幂等（同 root 复用；异 root 先关后启）。
 * 诊断 store 以 URI 为键聚合，变化经 onDiagnostics 回调全量快照下发。
 */
export class TsLanguageServer {
  private client: LspClient | null = null;
  private rootPath: string | null = null;
  private readonly documents = new Map<string, OpenDocument>(); // key=uri
  private readonly diagnostics = new Map<string, LspRawDiagnostic[]>(); // key=uri
  private status: LspStatusInfo = { state: "idle" };
  /** 启动代际：每次 openWorkspace/shutdown 自增——旧代的迟到回调不得触碰新代状态。 */
  private generation = 0;
  /** 同 root 启动在飞 promise（openDialog/WorkspaceTree 双钩子并发去重）。 */
  private inflight: Promise<void> | null = null;

  onStatus: ((status: LspStatusInfo) => void) | null = null;
  /** 诊断快照变化回调（载荷为全量列表，UI 直接替换）。 */
  onDiagnostics: (() => void) | null = null;

  constructor(private readonly options: TsLanguageServerOptions) {}

  get currentStatus(): LspStatusInfo {
    return this.status;
  }

  /**
   * 工作区打开：启动服务器并完成握手。
   * 幂等：同 root 已 ready 直接复用；同 root 启动在飞返回同一 promise（并发去重）。
   * 异 root：代际自增，旧代启动的迟到结果（成功/失败/退出）一律作废。
   */
  async openWorkspace(rootPath: string): Promise<void> {
    const resolved = path.resolve(rootPath);
    if (this.rootPath === resolved) {
      if (this.client !== null && this.status.state === "ready") return;
      if (this.inflight !== null) return this.inflight;
    }
    const gen = ++this.generation;
    const task = this.launch(resolved, gen);
    this.inflight = task;
    try {
      await task;
    } finally {
      if (this.inflight === task) this.inflight = null;
    }
  }

  /** 实际启动序列（代际 gen 专属；任何步骤发现代际易主即自残退出）。 */
  private async launch(resolved: string, gen: number): Promise<void> {
    await this.shutdown();
    if (this.generation !== gen) return; // shutdown 期间已被更新的调用取代
    this.rootPath = resolved;
    this.setStatus({ state: "starting" });
    const client = new LspClient(
      this.options.nodeCommand,
      [this.options.cliPath, "--stdio"],
      { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...this.options.env },
      this.options.spawnImpl ?? nodeSpawnFactory,
      this.options.requestTimeoutMs ?? 30_000
    );
    client.onNotification = (method, params) => {
      if (method === "textDocument/publishDiagnostics") {
        this.handleDiagnostics(params as LspPublishDiagnosticsParams);
      }
    };
    client.onExit = () => {
      // 非主动关闭的退出 → error 态（shutdown() 会先置 idle 防误报）
      if (this.client === client) {
        this.client = null;
        this.documents.clear();
        this.diagnostics.clear();
        this.setStatus({ state: "error", code: "DW_LSP_SERVER_EXIT" });
        this.onDiagnostics?.();
      }
    };
    this.client = client;
    try {
      await client.start(absolutePathToUri(resolved));
      if (this.generation !== gen) {
        // 握手期间被异 root 调用取代：启动成果作废，静悄悄关闭自己的客户端
        await client.close();
        return;
      }
      this.setStatus({ state: "ready" });
    } catch (error) {
      // 仅当代际未易主时才清理共享槽位（旧代失败不得误杀新代客户端）
      if (this.generation === gen) {
        this.client = null;
        const code = error instanceof Error ? error.message.slice(0, 60) : "DW_LSP_START_FAILED";
        this.setStatus({ state: "error", code });
      }
      throw error;
    }
  }

  /** 打开文档（重复打开同路径=重新同步全文，版本自增）。非 TS/JS 文件忽略。 */
  didOpen(relFile: string, text: string): void {
    const languageId = languageIdFor(relFile);
    if (languageId === null || this.client === null || this.status.state !== "ready") return;
    const uri = this.uriFor(relFile);
    const existing = this.documents.get(uri);
    const version = (existing?.version ?? 0) + 1;
    this.documents.set(uri, { uri, languageId, version, text });
    this.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  /** 文档变更：Full 同步（未 didOpen 过则按 didOpen 处理，容错）。 */
  didChange(relFile: string, text: string): void {
    if (this.client === null || this.status.state !== "ready") return;
    const uri = this.uriFor(relFile);
    const doc = this.documents.get(uri);
    if (doc === undefined) {
      this.didOpen(relFile, text);
      return;
    }
    doc.version += 1;
    doc.text = text;
    this.client.notify("textDocument/didChange", {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text }],
    });
  }

  /** 关闭文档（并清除该文件诊断快照）。 */
  didClose(relFile: string): void {
    const uri = this.uriFor(relFile);
    if (!this.documents.has(uri)) return;
    this.documents.delete(uri);
    this.client?.notify("textDocument/didClose", { textDocument: { uri } });
    if (this.diagnostics.delete(uri)) {
      this.onDiagnostics?.();
    }
  }

  /** 悬停（未就绪/无内容 → null；请求失败不抛出——悬停是尽力而为）。 */
  async hover(relFile: string, line: number, character: number): Promise<LspHoverInfo | null> {
    if (this.client === null || this.status.state !== "ready") return null;
    try {
      const result = (await this.client.request("textDocument/hover", {
        textDocument: { uri: this.uriFor(relFile) },
        position: { line, character },
      })) as LspRawHover | null;
      const text = normalizeHoverText(result);
      return text === null ? null : { text };
    } catch {
      return null;
    }
  }

  /** 定义候选（未就绪/无定义 → 空数组；请求失败不抛出）。 */
  async definition(relFile: string, line: number, character: number): Promise<LspDefinitionTarget[]> {
    if (this.client === null || this.status.state !== "ready") return [];
    let raw: LspRawLocation | LspRawLocation[] | null;
    try {
      raw = (await this.client.request("textDocument/definition", {
        textDocument: { uri: this.uriFor(relFile) },
        position: { line, character },
      })) as LspRawLocation | LspRawLocation[] | null;
    } catch {
      return [];
    }
    if (raw === null) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list
      .filter((loc) => typeof loc?.uri === "string" && loc.range !== undefined)
      .map((loc) => ({
        file: this.relFor(loc.uri),
        line: loc.range.start.line,
        character: loc.range.start.character,
        endLine: loc.range.end.line,
        endCharacter: loc.range.end.character,
      }));
  }

  /**
   * 自动补全候选（未就绪/无建议 → 空数组；请求失败不抛出）。
   * LSP 返回 CompletionList（{items}）或 CompletionItem[] 或 null，统一归一。
   */
  async completion(relFile: string, line: number, character: number): Promise<LspCompletionItem[]> {
    if (this.client === null || this.status.state !== "ready") return [];
    let raw: LspRawCompletionList | LspRawCompletionItem[] | null;
    try {
      raw = (await this.client.request("textDocument/completion", {
        textDocument: { uri: this.uriFor(relFile) },
        position: { line, character },
      })) as LspRawCompletionList | LspRawCompletionItem[] | null;
    } catch {
      return [];
    }
    if (raw === null) return [];
    const items = Array.isArray(raw) ? raw : raw.items ?? [];
    return items
      .filter((item) => item !== null && typeof item.label === "string")
      .map((item) => ({
        label: item.label,
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
        ...(item.kind !== undefined ? { kind: item.kind } : {}),
        ...(item.insertText !== undefined ? { insertText: item.insertText } : {}),
      }));
  }

  /** 当前全部诊断快照（跨文件，已映射为相对路径 + severity 字符串）。 */
  listDiagnostics(): LspDiagnosticItem[] {
    const items: LspDiagnosticItem[] = [];
    for (const [uri, raws] of this.diagnostics) {
      const file = this.relFor(uri);
      for (const raw of raws) {
        items.push({
          file,
          line: raw.range.start.line,
          character: raw.range.start.character,
          endLine: raw.range.end.line,
          endCharacter: raw.range.end.character,
          severity: SEVERITY_MAP[raw.severity ?? 1] ?? "error",
          ...(raw.code !== undefined ? { code: String(raw.code) } : {}),
          message: raw.message,
        });
      }
    }
    return items;
  }

  /** 优雅关闭（幂等）：先置 idle 防 onExit 误报 error，再走 shutdown/exit 序列。 */
  async shutdown(): Promise<void> {
    const client = this.client;
    if (client === null) return;
    this.client = null;
    this.documents.clear();
    this.diagnostics.clear();
    this.setStatus({ state: "idle" });
    await client.close();
  }

  // --------------------------------------------------------------------------

  private uriFor(relFile: string): string {
    if (this.rootPath === null) return relFile;
    return absolutePathToUri(path.join(this.rootPath, relFile));
  }

  private relFor(uri: string): string {
    const abs = uriToAbsolutePath(uri);
    if (this.rootPath === null) return abs;
    const rel = path.relative(this.rootPath, abs);
    return rel === "" ? abs : rel.replace(/\\/g, "/");
  }

  private handleDiagnostics(params: LspPublishDiagnosticsParams): void {
    if (typeof params?.uri !== "string" || !Array.isArray(params.diagnostics)) return;
    this.diagnostics.set(params.uri, params.diagnostics);
    this.onDiagnostics?.();
  }

  private setStatus(next: LspStatusInfo): void {
    this.status = next;
    this.onStatus?.(next);
  }
}

export type { LspChildProcess, LspSpawnFactory };
