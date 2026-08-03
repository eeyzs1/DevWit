/**
 * 工作区跨文件内容搜索（v0.4.0）。
 *
 * 遍历文件树（复用 buildFileTree 的排除规则：node_modules/.git/dist/release），
 * 逐文件读取并按行搜索。支持字面量/正则、大小写敏感、全词匹配。
 * 二进制文件（含 \0）自动跳过；超大文件（>1MB）跳过避免内存压力。
 * 结果按文件分组，单文件/总结果数有上限防止超大工作区卡顿。
 */
import * as fs from "node:fs";
import path from "node:path";
import { buildFileTree, type FileTreeNode } from "./file-tree.js";

/** 搜索选项。 */
export interface SearchOptions {
  /** 搜索文本或正则源。 */
  query: string;
  /** true=按正则解释 query；false=字面量匹配。 */
  isRegex: boolean;
  /** true=区分大小写；false=忽略大小写。 */
  caseSensitive: boolean;
  /** true=仅匹配单词边界（\b 包裹）；字面量与正则模式均适用。 */
  wholeWord: boolean;
  /** 单文件最大匹配数上限（缺省 1000）。 */
  maxResultsPerFile?: number;
  /** 搜索文件数上限（缺省 5000）。 */
  maxFiles?: number;
}

/** 单条匹配（一行可能多次命中，每条 = 一次命中）。 */
export interface SearchMatch {
  /** 1-based 行号。 */
  line: number;
  /** 1-based 起始列。 */
  column: number;
  /** 1-based 结束列（exclusive）。 */
  endColumn: number;
  /** 该行完整文本（预览用）。 */
  preview: string;
}

/** 单文件匹配集合。 */
export interface SearchResultFile {
  /** 工作区相对路径（正斜杠）。 */
  relativePath: string;
  /** 绝对路径。 */
  absolutePath: string;
  matches: SearchMatch[];
}

/** 搜索结果总集。 */
export interface SearchResults {
  files: SearchResultFile[];
  totalMatches: number;
  /** 是否因上限截断（文件数或单文件匹配数达上限）。 */
  truncated: boolean;
}

/** 单文件大小上限（1MB）：超过跳过，避免读入内存压力。 */
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

/** 默认上限。 */
const DEFAULT_MAX_PER_FILE = 1000;
const DEFAULT_MAX_FILES = 5000;

/**
 * 将 query 编译为全局正则。字面量模式转义元字符；wholeWord 包 \b；
 * caseSensitive 决定 flags 是否含 i。失败（非法正则）抛 SyntaxError。
 */
export function compileSearchRegex(options: SearchOptions): RegExp {
  const { query, isRegex, caseSensitive, wholeWord } = options;
  if (query === "") {
    throw new SyntaxError("DW_SEARCH_EMPTY_QUERY");
  }
  let source: string;
  if (isRegex) {
    source = query;
  } else {
    // 字面量：转义所有正则元字符
    source = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (wholeWord) {
    // 词边界包裹（仅当首尾是词字符时才有意义；非词字符查询 \b 无效但不报错）
    source = `\\b${source}\\b`;
  }
  const flags = caseSensitive ? "g" : "gi";
  return new RegExp(source, flags);
}

/**
 * 递归收集文件树中所有文件绝对路径（已排除 node_modules 等）。
 * maxFiles 上限达即停止追加（调用方据 truncated 标记）。
 */
function collectFilePaths(node: FileTreeNode, acc: string[], maxFiles: number): void {
  if (acc.length >= maxFiles) return;
  if (node.type === "file") {
    acc.push(node.path);
    return;
  }
  for (const child of node.children ?? []) {
    if (acc.length >= maxFiles) return;
    collectFilePaths(child, acc, maxFiles);
  }
}

/**
 * 在单文件内容中按行搜索。返回所有匹配（受 maxPerFile 上限）。
 * 二进制文件（含 \0）返回 null 表示跳过。
 */
function searchInContent(
  content: string,
  regex: RegExp,
  maxPerFile: number
): SearchMatch[] | null {
  // 二进制检测：前 8KB 含 \0 视为二进制
  if (content.slice(0, 8192).includes("\0")) {
    return null;
  }
  const matches: SearchMatch[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (matches.length >= maxPerFile) break;
    const text = lines[i] ?? "";
    // 每行重置 lastIndex（全局正则跨行需重置）
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m[0] === "") {
        // 零宽匹配（如 a*）：前进避免死循环
        regex.lastIndex++;
        continue;
      }
      matches.push({
        line: i + 1,
        column: m.index + 1,
        endColumn: m.index + m[0].length + 1,
        preview: text,
      });
      if (matches.length >= maxPerFile) break;
    }
  }
  return matches;
}

/**
 * 工作区跨文件搜索。
 * @param rootPath 工作区根绝对路径
 * @param options 搜索选项
 * @returns 搜索结果（空 query 返回空结果）
 */
export async function searchInWorkspace(
  rootPath: string,
  options: SearchOptions
): Promise<SearchResults> {
  if (options.query === "") {
    return { files: [], totalMatches: 0, truncated: false };
  }
  const maxPerFile = options.maxResultsPerFile ?? DEFAULT_MAX_PER_FILE;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const regex = compileSearchRegex(options);

  const tree = buildFileTree(rootPath);
  const filePaths: string[] = [];
  collectFilePaths(tree, filePaths, maxFiles);
  const truncated = filePaths.length >= maxFiles;

  const files: SearchResultFile[] = [];
  let totalMatches = 0;
  const rootAbs = path.resolve(rootPath);

  for (const abs of filePaths) {
    // 跳过超大文件
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) {
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const matches = searchInContent(content, regex, maxPerFile);
    if (matches === null || matches.length === 0) continue;
    const relativePath = path.relative(rootAbs, abs).replace(/\\/g, "/");
    files.push({ relativePath, absolutePath: abs, matches });
    totalMatches += matches.length;
    if (matches.length >= maxPerFile) {
      // 单文件达上限也算截断
    }
  }

  return {
    files,
    totalMatches,
    truncated: truncated || files.some((f) => f.matches.length >= maxPerFile),
  };
}
