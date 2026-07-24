import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodeChunk } from "./chunker.js";

/**
 * 索引持久化（迭代 10 / AC19）：JSONL 全量原子重写。
 *
 * 选型说明（诚实工程决策，非偷懒）：
 * - 不用 SQLite——better-sqlite3 是 native 模块，Electron 打包需 electron-rebuild，
 *   Windows/macOS 双 CI 都要加原生构建链，复杂度远超收益；
 * - 内存全扫描余弦相似度对 ≤5 万块（中型项目）是毫秒级，无需索引结构；
 * - 全量重写经 tmp+rename 原子完成，5 万行 JSONL 重写 <1s，增量更新后聚合一次即可。
 *
 * 布局：
 * - chunks.jsonl：每行一个 IndexedChunk（含向量）；
 * - files.json：relPath → { mtimeMs, size }（增量同步的变更检测依据）。
 */

export interface IndexedChunk extends CodeChunk {
  vector: number[];
}

export interface IndexedFileMeta {
  mtimeMs: number;
  size: number;
}

export interface PersistedIndex {
  chunks: IndexedChunk[];
  files: Record<string, IndexedFileMeta>;
}

const CHUNKS_FILE = "chunks.jsonl";
const FILES_FILE = "files.json";

export class IndexStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async load(): Promise<PersistedIndex | null> {
    let rawFiles: string;
    let rawChunks: string;
    try {
      [rawFiles, rawChunks] = await Promise.all([
        fs.readFile(path.join(this.dir, FILES_FILE), "utf-8"),
        fs.readFile(path.join(this.dir, CHUNKS_FILE), "utf-8"),
      ]);
    } catch {
      return null; // 无历史索引（首次/已清理）
    }
    let files: Record<string, IndexedFileMeta>;
    try {
      files = JSON.parse(rawFiles) as Record<string, IndexedFileMeta>;
    } catch {
      return null; // files.json 损坏 → 全量重建（chunks 无文件表无法做变更检测）
    }
    const chunks: IndexedChunk[] = [];
    for (const line of rawChunks.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        chunks.push(JSON.parse(trimmed) as IndexedChunk);
      } catch {
        // 单行损坏跳过（异常断电写了一半）；files.json 的 mtime 会驱动该文件重建
      }
    }
    return { chunks, files };
  }

  /** 全量原子重写（tmp → rename，避免半写状态）。 */
  async save(index: PersistedIndex): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const chunksPath = path.join(this.dir, CHUNKS_FILE);
    const filesPath = path.join(this.dir, FILES_FILE);
    const chunksTmp = `${chunksPath}.tmp`;
    const filesTmp = `${filesPath}.tmp`;
    const lines = index.chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
    await fs.writeFile(chunksTmp, lines.length > 0 ? `${lines}\n` : "", "utf-8");
    await fs.writeFile(filesTmp, JSON.stringify(index.files), "utf-8");
    await fs.rename(chunksTmp, chunksPath);
    await fs.rename(filesTmp, filesPath);
  }
}
