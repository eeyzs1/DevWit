/**
 * 工作区文件树构建（WU005）。
 * 递归读取目录，排除依赖/构建产物目录，带深度与单目录条目上限防护。
 */
import * as fs from "node:fs";
import path from "node:path";

export interface FileTreeNode {
  name: string;
  /** 绝对路径 */
  path: string;
  type: "file" | "dir";
  children?: FileTreeNode[];
}

export interface BuildFileTreeOptions {
  /** 递归深度上限，默认 10 */
  maxDepth?: number;
  /** 单目录条目上限，默认 5000 */
  maxEntriesPerDir?: number;
  /** 排除的目录名，默认 node_modules/.git/dist/release */
  exclude?: readonly string[];
}

const DEFAULT_EXCLUDE: readonly string[] = ["node_modules", ".git", "dist", "release"];

export function buildFileTree(rootPath: string, options: BuildFileTreeOptions = {}): FileTreeNode {
  const maxDepth = options.maxDepth ?? 10;
  const maxEntriesPerDir = options.maxEntriesPerDir ?? 5000;
  const exclude = new Set(options.exclude ?? DEFAULT_EXCLUDE);
  const absRoot = path.resolve(rootPath);
  const stat = fs.statSync(absRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${absRoot}`);
  }

  const build = (dirPath: string, name: string, depth: number): FileTreeNode => {
    const node: FileTreeNode = { name, path: dirPath, type: "dir" };
    if (depth >= maxDepth) {
      return node;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      // 无权限/读取失败的目录按空目录处理，不中断整棵树
      return node;
    }
    const children: FileTreeNode[] = [];
    let count = 0;
    for (const entry of entries) {
      if (count >= maxEntriesPerDir) {
        break;
      }
      if (entry.isDirectory() && exclude.has(entry.name)) {
        continue;
      }
      count += 1;
      const childPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        children.push(build(childPath, entry.name, depth + 1));
      } else {
        // 符号链接等一律按 file 处理，避免跟随链接造成环
        children.push({ name: entry.name, path: childPath, type: "file" });
      }
    }
    children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "dir" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    node.children = children;
    return node;
  };

  return build(absRoot, path.basename(absRoot), 0);
}
