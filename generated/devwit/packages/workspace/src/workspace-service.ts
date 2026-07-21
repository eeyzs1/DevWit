/**
 * 工作区服务（WU005）：根目录管理、受防护的文件读写、fs 事件监听。
 * 仅供 Electron 主进程使用（AR004）。所有读写路径必须先通过逃逸防护校验。
 */
import * as fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export interface WorkspaceEvent {
  kind: "create" | "change" | "delete";
  /** 相对工作区根的路径 */
  path: string;
}

export type WorkspaceChangeListener = (event: WorkspaceEvent) => void;

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 100;

export class WorkspaceService {
  private root: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private readonly listeners = new Set<WorkspaceChangeListener>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly knownPaths = new Set<string>();

  /** 当前工作区根（绝对路径），未打开时为 null。 */
  get rootPath(): string | null {
    return this.root;
  }

  /** 打开工作区根目录。路径不存在或不是目录时抛错。重复打开会重置 watcher。 */
  async openRoot(rootPath: string): Promise<string> {
    const resolved = path.resolve(rootPath);
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${resolved}`);
    }
    this.closeWatcher();
    this.root = resolved;
    return resolved;
  }

  /** 读取文件内容（utf-8）。超过 50MB 拒绝。 */
  async readFile(filePath: string): Promise<string> {
    const abs = this.resolveInsideRoot(filePath);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${abs}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File too large (>50MB): ${abs}`);
    }
    return fsp.readFile(abs, "utf-8");
  }

  /** 写入文件（utf-8），自动创建父目录。写入前校验路径必须位于 root 内。 */
  async writeFile(filePath: string, content: string): Promise<void> {
    const abs = this.resolveInsideRoot(filePath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf-8");
  }

  /**
   * 路径逃逸防护：相对 root 解析后的绝对路径必须等于 root 或位于其内部。
   * 兼容 Windows 大小写不敏感盘符。
   */
  private resolveInsideRoot(filePath: string): string {
    if (!this.root) {
      throw new Error("No workspace root open");
    }
    const abs = path.resolve(this.root, filePath);
    const rootNorm = this.root.toLowerCase();
    const absNorm = abs.toLowerCase();
    if (absNorm !== rootNorm && !absNorm.startsWith(rootNorm + path.sep)) {
      throw new Error(`Path escapes workspace root: ${filePath}`);
    }
    return abs;
  }

  /** 订阅工作区变更事件，返回退订函数。 */
  onDidChange(listener: WorkspaceChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 启动递归 fs.watch（Windows 支持 recursive），100ms 去抖。
   * 重复调用幂等；未打开 root 时抛错。
   */
  watch(): void {
    if (!this.root) {
      throw new Error("No workspace root open");
    }
    if (this.watcher) {
      return;
    }
    this.knownPaths.clear();
    this.seedKnownPaths(this.root);
    this.watcher = fs.watch(this.root, { recursive: true }, (_eventType, filename) => {
      if (!filename) {
        return;
      }
      const rel = filename.toString();
      const prev = this.debounceTimers.get(rel);
      if (prev) {
        clearTimeout(prev);
      }
      this.debounceTimers.set(
        rel,
        setTimeout(() => {
          this.debounceTimers.delete(rel);
          this.emitForPath(rel);
        }, WATCH_DEBOUNCE_MS)
      );
    });
    this.watcher.on("error", () => {
      // watcher 失败（如目录被删）保持静默，避免主进程崩溃；下次 openRoot 重建
      this.closeWatcher();
    });
  }

  private seedKnownPaths(root: string): void {
    try {
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          this.knownPaths.add(path.relative(root, abs));
          if (entry.isDirectory()) {
            walk(abs);
          }
        }
      };
      walk(root);
    } catch {
      // 播种失败不影响 watch 本身
    }
  }

  private emitForPath(rel: string): void {
    if (!this.root) {
      return;
    }
    const abs = path.join(this.root, rel);
    let kind: WorkspaceEvent["kind"];
    if (fs.existsSync(abs)) {
      kind = this.knownPaths.has(rel) ? "change" : "create";
      this.knownPaths.add(rel);
    } else {
      kind = "delete";
      this.knownPaths.delete(rel);
    }
    const event: WorkspaceEvent = { kind, path: rel };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private closeWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.knownPaths.clear();
  }

  /** 释放全部资源（watcher、定时器、监听器）。 */
  close(): void {
    this.closeWatcher();
    this.listeners.clear();
    this.root = null;
  }
}
