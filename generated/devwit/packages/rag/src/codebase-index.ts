import { promises as fs } from "node:fs";
import path from "node:path";
import type { Embedder, RagStatusInfo } from "@devwit/contracts";
import { chunkSource, type CodeChunk } from "./chunker.js";
import { IndexStore, type IndexedChunk, type IndexedFileMeta } from "./index-store.js";

/**
 * 代码库索引（迭代 10 / AC19 透明 RAG 的核心）。
 *
 * 生命周期：buildAll 全量（枚举→分块→分批 embed→落盘）→ ready 后可 query；
 * syncFile/removeFile 由外部文件事件驱动增量（AiRuntime 接 workspace 事件）。
 *
 * 检索：embed(query) → 内存全扫描余弦相似度 → topK + token 预算截断。
 * 全扫描是有意为之（见 index-store 的选型说明）：≤5 万块毫秒级，零依赖。
 */

/** 索引文件扩展名白名单（代码 + 文档 + 配置；二进制/图片/音视频不在列）。 */
const INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs",
  ".cpp", ".cc", ".c", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt",
  ".dart", ".vue", ".svelte", ".md", ".txt", ".json", ".yaml", ".yml", ".toml",
  ".xml", ".html", ".htm", ".css", ".scss", ".less", ".sql", ".sh", ".ps1",
]);

const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "release", "out", "build", "coverage",
  ".next", ".nuxt", ".cache", ".turbo", ".idea", ".vscode", "target", "vendor",
]);

const EXCLUDED_FILES: ReadonlySet<string> = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "cargo.lock",
]);

/** 防护上限：单文件 512KB、全库 2 万个文件（超出部分跳过，不报错）。 */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_FILES = 20000;

/** embedding 批量大小（/v1/embeddings 单请求的 input 条数）。 */
const EMBED_BATCH_SIZE = 64;

export interface ScoredChunk extends CodeChunk {
  score: number;
}

export interface CodebaseIndexOptions {
  root: string;
  indexDir: string;
  embedder: Embedder;
  /** 状态变化回调（主→渲染推送 RagStatus）。 */
  onStatus?: (status: RagStatusInfo) => void;
}

export interface QueryOptions {
  topK: number;
  budgetTokens: number;
  /** token 计数（由 ai-runtime 注入 TiktokenCounter，与 manifest 计数一致）。 */
  countTokens: (text: string) => number;
}

export class CodebaseIndex {
  private readonly root: string;
  private readonly store: IndexStore;
  private readonly embedder: Embedder;
  private readonly onStatus?: (status: RagStatusInfo) => void;
  private readonly chunks = new Map<string, IndexedChunk>();
  private readonly files = new Map<string, IndexedFileMeta>();
  private state: RagStatusInfo = { state: "disabled" };
  /** 增量同步串行化：buildAll 与 syncFile 互斥（Promise 链）。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CodebaseIndexOptions) {
    this.root = options.root;
    this.store = new IndexStore(options.indexDir);
    this.embedder = options.embedder;
    if (options.onStatus !== undefined) this.onStatus = options.onStatus;
  }

  getStatus(): RagStatusInfo {
    return this.state;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get fileCount(): number {
    return this.files.size;
  }

  /** 全量构建。恢复历史索引后仅重建变更文件（mtime/size 变化），无变化则零 embedding 请求。 */
  async buildAll(): Promise<void> {
    await this.enqueue(async () => {
      try {
        const discovered = await walkIndexableFiles(this.root);
        const total = discovered.length;
        this.setState({ state: "indexing", indexedFiles: 0, totalFiles: total });

        const persisted = await this.store.load();
        if (persisted !== null) {
          for (const chunk of persisted.chunks) this.chunks.set(chunk.id, chunk);
          for (const [relPath, meta] of Object.entries(persisted.files)) this.files.set(relPath, meta);
        }

        // 已消失的文件：移除其全部块
        const discoveredPaths = new Set(discovered.map((file) => file.relPath));
        for (const relPath of [...this.files.keys()]) {
          if (!discoveredPaths.has(relPath)) this.dropFile(relPath);
        }

        // 变更检测：mtime 或 size 不同 → 重嵌入
        let processed = 0;
        const dirty: Array<{ relPath: string; absPath: string; meta: IndexedFileMeta }> = [];
        for (const file of discovered) {
          const prev = this.files.get(file.relPath);
          if (prev === undefined || prev.mtimeMs !== file.meta.mtimeMs || prev.size !== file.meta.size) {
            dirty.push(file);
          }
        }
        for (const file of dirty) {
          await this.reindexFile(file.absPath, file.relPath, file.meta);
          processed += 1;
          this.setState({ state: "indexing", indexedFiles: processed, totalFiles: dirty.length });
        }

        await this.persist();
        this.setState({ state: "ready", fileCount: this.files.size, chunkCount: this.chunks.size });
      } catch (error) {
        // embedding 网络错误 / 磁盘错误等：状态置 error（源层据此产出占位项），
        // 不向上抛——索引失败绝不阻断对话（AC19 透明性：可见的不可用）。
        this.setState({ state: "error", code: errorCodeOf(error) });
      }
    });
  }

  /** 单文件增量同步（保存/外部变更事件驱动）；文件不可读/不再可索引时移除其块。 */
  async syncFile(absPath: string): Promise<void> {
    await this.enqueue(async () => {
      try {
        const relPath = path.relative(this.root, absPath);
        if (relPath.startsWith("..") || path.isAbsolute(relPath)) return;
        let meta: IndexedFileMeta | null;
        try {
          const stat = await fs.stat(absPath);
          meta = isIndexableFile(relPath, stat.size) ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
        } catch {
          meta = null; // 已删除
        }
        if (meta === null) {
          this.dropFile(relPath);
        } else {
          const prev = this.files.get(relPath);
          if (prev !== undefined && prev.mtimeMs === meta.mtimeMs && prev.size === meta.size) return;
          await this.reindexFile(absPath, relPath, meta);
        }
        await this.persist();
        if (this.state.state === "ready") {
          this.setState({ state: "ready", fileCount: this.files.size, chunkCount: this.chunks.size });
        }
      } catch (error) {
        this.setState({ state: "error", code: errorCodeOf(error) });
      }
    });
  }

  /**
   * 检索：余弦相似度全扫描 → topK → token 预算截断。
   * 调用方保证 state=ready；embedding 失败向上抛（源层兜底为占位项，不阻断对话）。
   */
  async query(text: string, options: QueryOptions): Promise<ScoredChunk[]> {
    const [queryVector] = await this.embedder.embed([text]);
    if (queryVector === undefined) return [];
    const scored: ScoredChunk[] = [];
    for (const chunk of this.chunks.values()) {
      const score = cosineSimilarity(queryVector, chunk.vector);
      scored.push({ id: chunk.id, relPath: chunk.relPath, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked: ScoredChunk[] = [];
    let tokens = 0;
    for (const chunk of scored) {
      if (picked.length >= options.topK) break;
      const cost = options.countTokens(chunk.text);
      if (picked.length > 0 && tokens + cost > options.budgetTokens) continue;
      picked.push(chunk);
      tokens += cost;
    }
    return picked;
  }

  /** 关闭（状态归 disabled；内存清空，磁盘索引保留供下次恢复）。 */
  dispose(): void {
    this.chunks.clear();
    this.files.clear();
    this.setState({ state: "disabled" });
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  /**
   * 任务串行化：buildAll 与 syncFile 互斥。返回本次任务的 Promise（可 await 完成）；
   * 队列主体经 catch 自愈——单任务失败不毒化后续增量同步（任务内部已兜底置 error 态）。
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  private setState(status: RagStatusInfo): void {
    this.state = status;
    this.onStatus?.(status);
  }

  private dropFile(relPath: string): void {
    this.files.delete(relPath);
    for (const [id, chunk] of [...this.chunks]) {
      if (chunk.relPath === relPath) this.chunks.delete(id);
    }
  }

  private async reindexFile(absPath: string, relPath: string, meta: IndexedFileMeta): Promise<void> {
    const content = await fs.readFile(absPath, "utf-8");
    const chunks = chunkSource(relPath, content);
    if (chunks.length === 0) {
      this.dropFile(relPath);
      this.files.set(relPath, meta);
      return;
    }
    const vectors = await this.embedBatches(chunks.map((chunk) => chunk.text));
    this.dropFile(relPath);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vector = vectors[i]!;
      this.chunks.set(chunk.id, { ...chunk, vector });
    }
    this.files.set(relPath, meta);
  }

  private async embedBatches(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      vectors.push(...(await this.embedder.embed(batch)));
    }
    return vectors;
  }

  private async persist(): Promise<void> {
    await this.store.save({
      chunks: [...this.chunks.values()],
      files: Object.fromEntries(this.files),
    });
  }
}

/** 提取 ASCII 错误码（约定 Error.message 以 DW_ 开头；否则给通用码）。 */
function errorCodeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("DW_") ? message.split(":")[0]! : "DW_RAG_INDEX_FAILED";
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface DiscoveredFile {
  relPath: string;
  absPath: string;
  meta: IndexedFileMeta;
}

function isIndexableFile(relPath: string, size: number): boolean {
  if (size > MAX_FILE_BYTES || size === 0) return false;
  const name = path.basename(relPath);
  if (EXCLUDED_FILES.has(name)) return false;
  return INDEXABLE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** 递归枚举可索引文件（排除目录/扩展名白名单/大小与总量防护）。 */
export async function walkIndexableFiles(root: string): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= MAX_TOTAL_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限目录跳过
    }
    for (const entry of entries) {
      if (found.length >= MAX_TOTAL_FILES) return;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) await walk(absPath);
      } else {
        const relPath = path.relative(root, absPath);
        let stat;
        try {
          stat = await fs.stat(absPath);
        } catch {
          continue;
        }
        if (isIndexableFile(relPath, stat.size)) {
          found.push({ relPath, absPath, meta: { mtimeMs: stat.mtimeMs, size: stat.size } });
        }
      }
    }
  };
  await walk(root);
  return found;
}
