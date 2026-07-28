import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodeSymbol, ResolvedSymbol, SymbolsQueryResult } from "@devwit/contracts";
import { walkIndexableFiles } from "./codebase-index.js";
import { extractSymbols, filterSymbols, supportsSymbols } from "./symbol-extractor.js";

/**
 * 符号级索引（迭代 29 / AC38）：@符号 引用的工作区级符号表。
 *
 * 与 CodebaseIndex（RAG）刻意解耦：
 * - 纯启发式提取，无 embedding/provider 依赖——RAG 关闭、无 OpenAI 凭证时仍可用；
 * - 纯内存不落盘：重建是全文件正则扫描（无网络），启动开销秒级，省去存储格式演进；
 * - 生命周期独立：工作区打开即构建，文件事件增量同步，resolve 重读文件切片
 *   （内容为事实源——索引行号过期/文件消失时返回 null，注入源静默跳过）。
 *
 * 任务串行化同 CodebaseIndex：buildAll 与 syncFile 互斥（Promise 链）。
 */

export type SymbolIndexState = "disabled" | "indexing" | "ready" | "error";

export class SymbolIndex {
  private readonly root: string;
  private readonly byFile = new Map<string, CodeSymbol[]>();
  private readonly byId = new Map<string, CodeSymbol>();
  private state: SymbolIndexState = "disabled";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  getStatus(): SymbolIndexState {
    return this.state;
  }

  get size(): number {
    return this.byId.size;
  }

  get fileCount(): number {
    return this.byFile.size;
  }

  /** 全量构建：枚举可索引文件（复用 RAG  walker 的白名单/排除/防护），仅解析支持符号提取的扩展名。 */
  async buildAll(): Promise<void> {
    await this.enqueue(async () => {
      try {
        this.state = "indexing";
        // walker 对不可读目录静默返回空表——根目录缺失必须显式判 error（下拉据此给"索引不可用"提示）
        if (!(await fs.stat(this.root).catch(() => null))?.isDirectory()) {
          this.state = "error";
          return;
        }
        const discovered = await walkIndexableFiles(this.root);
        const discoveredPaths = new Set(discovered.map((file) => normalizeSlashes(file.relPath)));
        for (const relPath of [...this.byFile.keys()]) {
          if (!discoveredPaths.has(relPath)) this.dropFile(relPath);
        }
        for (const file of discovered) {
          const relPath = normalizeSlashes(file.relPath);
          if (!supportsSymbols(relPath)) continue;
          await this.reindexFile(file.absPath, relPath);
        }
        this.state = "ready";
      } catch {
        // 枚举/磁盘错误：状态置 error（UI 下拉给"索引不可用"提示），不向上抛——绝不阻断对话
        this.state = "error";
      }
    });
  }

  /** 单文件增量同步（保存/外部变更/删除事件驱动）；不再支持符号提取的路径按删除处理。 */
  async syncFile(absPath: string): Promise<void> {
    await this.enqueue(async () => {
      const relPath = normalizeSlashes(path.relative(this.root, absPath));
      if (relPath.startsWith("..") || path.isAbsolute(relPath)) return;
      let isFile = false;
      try {
        isFile = (await fs.stat(absPath)).isFile();
      } catch {
        isFile = false; // 已删除
      }
      if (!isFile || !supportsSymbols(relPath)) {
        this.dropFile(relPath);
        return;
      }
      await this.reindexFile(absPath, relPath);
      if (this.state === "disabled") this.state = "ready"; // 事件先于 buildAll 到达时的自愈
    });
  }

  /** 候选查询：全表 filterSymbols 评分排序（内存毫秒级，与 chunk 全扫描同选型逻辑）。 */
  query(text: string, limit = 8): CodeSymbol[] {  // qg-allow: 候选下拉默认页大小，调用方可覆盖
    return filterSymbols([...this.byId.values()], text, limit);
  }

  /** IPC 返回形状：索引状态 + 命中（indexing 时可为空数组，下拉给提示行）。 */
  result(text: string, limit = 8): SymbolsQueryResult { // qg-allow: 候选下拉默认页大小，与 query() 同口径（调用方可覆盖）
    return { state: this.state, symbols: this.query(text, limit) };
  }

  /**
   * 引用解析：按 id 取符号元数据，重读文件切 [startLine, endLine]（钳制到当前行数）。
   * 文件消失/不可读/过期 id（起始行超出现行数）返回 null——调用方静默跳过。
   */
  async resolve(id: string): Promise<ResolvedSymbol | null> {
    const symbol = this.byId.get(id);
    if (symbol === undefined) return null;
    let content: string;
    try {
      content = await fs.readFile(path.join(this.root, symbol.relPath), "utf-8");
    } catch {
      return null;
    }
    const lines = content.split("\n");
    if (symbol.startLine > lines.length) return null;
    const endLine = Math.min(symbol.endLine, lines.length);
    return { ...symbol, endLine, text: lines.slice(symbol.startLine - 1, endLine).join("\n") };
  }

  /** 关闭（状态归 disabled；内存清空——无磁盘产物，重启经 buildAll 重建）。 */
  dispose(): void {
    this.byFile.clear();
    this.byId.clear();
    this.state = "disabled";
  }

  private async reindexFile(absPath: string, relPath: string): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch {
      this.dropFile(relPath);
      return;
    }
    const symbols = extractSymbols(relPath, content);
    this.dropFile(relPath);
    if (symbols.length === 0) return;
    this.byFile.set(relPath, symbols);
    for (const symbol of symbols) this.byId.set(symbol.id, symbol);
  }

  private dropFile(relPath: string): void {
    const prev = this.byFile.get(relPath);
    if (prev === undefined) return;
    for (const symbol of prev) this.byId.delete(symbol.id);
    this.byFile.delete(relPath);
  }

  /** 任务串行化：队列主体经 catch 自愈，单任务失败不毒化后续增量同步。 */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** 统一为正斜杠相对路径（Windows 下 path.relative 产反斜杠；UI 展示与 @文件引用风格一致）。 */
function normalizeSlashes(relPath: string): string {
  return relPath.split(path.sep).join("/");
}
