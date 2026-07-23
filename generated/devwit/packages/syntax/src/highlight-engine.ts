import type { DocumentChange, TextDocument } from "@devwit/editor-core";
import type Parser from "web-tree-sitter";
import { scopeForNodeType, type TokenScope } from "./scope-map.js";

/**
 * 行内一段带高亮 scope 的文本区间（列为 UTF-16 code unit，0 起始，左闭右开）。
 * 与 @devwit/editor-render 的 HighlightTokenProvider 返回值结构对齐（AR003：结构化约定，不互相依赖）。
 */
export interface HighlightToken {
  startChar: number;
  endChar: number;
  scope: TokenScope;
}

/** 内置语言 → tree-sitter-wasms 包内 wasm 文件名。 */
export const LANGUAGE_WASM_FILES: Readonly<Record<string, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
};

/** 常见别名 → 规范语言 id。 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
};

export interface HighlightEngineOptions {
  /**
   * tree-sitter 运行时 wasm（tree-sitter.wasm）的路径或 URL。
   * 缺省：node 环境下从 web-tree-sitter 包目录解析；浏览器/渲染进程必须由集成方显式注入
   * （如打包后的静态资源 URL）。
   */
  runtimeWasm?: string;
  /**
   * 语言 wasm 定位器：输入规范语言 id（typescript/javascript/tsx/python），返回路径或 URL，
   * 返回 undefined 表示该语言不可用。缺省：node 环境下从 tree-sitter-wasms 包解析
   * （optionalDependency，未安装时返回 undefined → 纯文本降级）。
   */
  languageWasm?: (languageId: string) => string | undefined;
}

type ParserCtor = typeof Parser;
type NodeRequire = { resolve(specifier: string): string };
type NodeFs = { existsSync(path: string): boolean };

let cachedNodeRequire: NodeRequire | null | undefined;
let cachedNodeFs: NodeFs | null | undefined;

/** node 环境下构造 createRequire；非 node 或失败返回 undefined（浏览器渲染进程走注入路径）。 */
async function nodeRequire(): Promise<NodeRequire | undefined> {
  if (cachedNodeRequire !== undefined) {
    return cachedNodeRequire ?? undefined;
  }
  if (typeof process === "undefined" || process.versions === undefined || process.versions.node === undefined) {
    cachedNodeRequire = null;
    return undefined;
  }
  try {
    // 非字面量 specifier：避免被打包器静态解析 node 内置模块（渲染进程边界安全）
    const specifier = "node:" + "module";
    const mod = (await import(specifier)) as { createRequire(url: string): NodeRequire };
    cachedNodeRequire = mod.createRequire(import.meta.url);
  } catch {
    cachedNodeRequire = null;
  }
  return cachedNodeRequire ?? undefined;
}

/** node 环境下获取 fs；非 node 或失败返回 undefined。 */
async function nodeFs(): Promise<NodeFs | undefined> {
  if (cachedNodeFs !== undefined) {
    return cachedNodeFs ?? undefined;
  }
  if (typeof process === "undefined" || process.versions === undefined || process.versions.node === undefined) {
    cachedNodeFs = null;
    return undefined;
  }
  try {
    // 非字面量 specifier：避免被打包器静态解析 node 内置模块（渲染进程边界安全）
    const specifier = "node:" + "fs";
    cachedNodeFs = (await import(specifier)) as NodeFs;
  } catch {
    cachedNodeFs = null;
  }
  return cachedNodeFs ?? undefined;
}

/** http(s)/file/data/blob URL 形态（Windows 盘符路径如 E:\ 不在此列）。 */
const URL_SCHEME = /^(https?|file|data|blob):/i;

/**
 * wasm 可达性预检：web-tree-sitter 经 emscripten 加载 wasm，Node 下文件缺失时
 * init 内部 abort 会使其 promise 永不 settle（且 initPromise 是模块级缓存，会毒化
 * 后续所有 init 调用），故本地路径在调用 loader 前做存在性预检，缺失直接判不可达；
 * URL 形态或非 node 环境不做预检，交由 loader 自身处理。
 */
async function wasmReachable(pathOrUrl: string): Promise<boolean> {
  if (URL_SCHEME.test(pathOrUrl)) {
    return true;
  }
  const fs = await nodeFs();
  if (fs === undefined) {
    return true;
  }
  return fs.existsSync(pathOrUrl);
}

/** 缺省运行时 wasm 定位：web-tree-sitter 包目录下的 tree-sitter.wasm（node）。 */
async function defaultRuntimeWasm(): Promise<string | undefined> {
  const req = await nodeRequire();
  if (req === undefined) {
    return undefined;
  }
  try {
    const pkgJson = req.resolve("web-tree-sitter/package.json");
    return pkgJson.slice(0, pkgJson.length - "package.json".length) + "tree-sitter.wasm";
  } catch {
    return undefined;
  }
}

/** 缺省语言 wasm 定位：tree-sitter-wasms/out/<file>（optionalDependency，未安装 → undefined）。 */
async function defaultLanguageWasm(canonicalId: string): Promise<string | undefined> {
  const req = await nodeRequire();
  if (req === undefined) {
    return undefined;
  }
  const file = LANGUAGE_WASM_FILES[canonicalId];
  if (file === undefined) {
    return undefined;
  }
  try {
    return req.resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    return undefined;
  }
}

/** 文本 offset → tree-sitter Point。web-tree-sitter 的 JS 侧索引/列均为 UTF-16 code unit（与其 binding 的 byte>>1 约定一致），与 editor-core 偏移同单位。 */
function pointForOffset(text: string, offset: number): { row: number; column: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    if (text.charCodeAt(i) === 10) {
      row += 1;
      lineStart = i + 1;
    }
  }
  return { row, column: at - lineStart };
}

/**
 * 语法高亮引擎：绑定 editor-core TextDocument，tree-sitter wasm 真实懒加载 + 增量重解析。
 *
 * - loadLanguage() 加载运行时与语言 wasm；任一环节不可用（包未安装、路径缺失、初始化失败）
 *   返回 false，引擎保持纯文本降级：tokensForLine 返回覆盖整行的单个 "text" token。
 * - 加载成功后订阅文档变更：逐条 change 先 tree.edit 再带旧树重解析（增量）。
 * - tokensForLine 只遍历与该行相交的语法树节点并缓存结果，供渲染层按可视行调用。
 */
export class HighlightEngine {
  private doc: TextDocument | undefined;
  private unsubscribe: (() => void) | undefined;
  private parser: Parser | undefined;
  private language: Parser.Language | undefined;
  private tree: Parser.Tree | undefined;
  /** 文档文本镜像：变更事件到达时文档已是新态，镜像用于逐条重放 edit 计算点位。 */
  private mirror = "";
  private languageIdValue: string | undefined;
  private initPromise: Promise<ParserCtor | undefined> | undefined;
  /** 异步加载代际：防止过期的 await 结果覆盖更新状态（快速连续切换语言/dispose）。 */
  private loadGeneration = 0;
  private readonly cache = new Map<number, HighlightToken[]>();
  private readonly runtimeWasm: string | undefined;
  private readonly languageWasmLocator: ((languageId: string) => string | undefined) | undefined;

  constructor(options: HighlightEngineOptions = {}) {
    this.runtimeWasm = options.runtimeWasm;
    this.languageWasmLocator = options.languageWasm;
  }

  /** 语言 id 归一化；不支持的语言返回 undefined。 */
  static normalizeLanguageId(languageId: string): string | undefined {
    const lower = languageId.toLowerCase();
    const canonical = LANGUAGE_ALIASES[lower] ?? lower;
    return canonical in LANGUAGE_WASM_FILES ? canonical : undefined;
  }

  /** 当前已加载的规范语言 id；纯文本降级时为 undefined。 */
  get languageId(): string | undefined {
    return this.languageIdValue;
  }

  /** 是否处于真实语法高亮状态（false = 纯文本降级）。 */
  get highlighting(): boolean {
    return this.tree !== undefined;
  }

  /** 绑定/解绑文档。切换文档会触发一次全量解析（语言已加载时）。 */
  setDocument(doc: TextDocument | undefined): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.doc = doc;
    if (doc === undefined) {
      this.dropTree();
      return;
    }
    this.unsubscribe = doc.onDidChange((event) => this.onDocumentChange(event.changes));
    this.reparseFull();
  }

  /**
   * 真实懒加载语言：动态加载 web-tree-sitter 运行时与语言 wasm。
   * 成功返回 true 并对当前文档全量解析；不可用返回 false（保持纯文本降级，不伪造高亮）。
   */
  async loadLanguage(languageId: string): Promise<boolean> {
    const canonical = HighlightEngine.normalizeLanguageId(languageId);
    const generation = ++this.loadGeneration;
    this.dropTree();
    this.language = undefined;
    this.languageIdValue = undefined;
    if (canonical === undefined) {
      return false;
    }
    const isStale = (): boolean => generation !== this.loadGeneration;

    const ParserClass = await this.ensureRuntime();
    if (isStale() || ParserClass === undefined) {
      return false;
    }
    const wasm = this.languageWasmLocator?.(canonical) ?? (await defaultLanguageWasm(canonical));
    if (isStale() || wasm === undefined) {
      return false;
    }
    if (!(await wasmReachable(wasm))) {
      return false; // 本地语言 wasm 缺失：纯文本降级
    }
    let language: Parser.Language;
    try {
      language = await ParserClass.Language.load(wasm);
    } catch {
      return false;
    }
    if (isStale()) {
      return false;
    }
    this.parser ??= new ParserClass();
    this.parser.setLanguage(language);
    this.language = language;
    this.languageIdValue = canonical;
    this.reparseFull();
    return true;
  }

  /**
   * 渲染层按行取 token：升序、不重叠，列为行内 UTF-16 code unit。
   * 纯文本降级：非空行返回单个 scope="text" 的整行 token，空行返回 []。
   */
  tokensForLine(line: number): HighlightToken[] {
    const doc = this.doc;
    if (doc === undefined || line < 0 || line >= doc.lineCount) {
      return [];
    }
    const tree = this.tree;
    if (tree === undefined) {
      const text = doc.getLine(line);
      return text.length === 0 ? [] : [{ startChar: 0, endChar: text.length, scope: "text" }];
    }
    const cached = this.cache.get(line);
    if (cached !== undefined) {
      return cached;
    }
    const range = doc.getLineRange(line);
    const tokens: HighlightToken[] = [];
    const cursor = tree.rootNode.walk();
    try {
      let done = false;
      while (!done) {
        const start = cursor.startIndex;
        const end = cursor.endIndex;
        let descend = false;
        if (end > range.start && start < range.end) {
          const scope = scopeForNodeType(cursor.nodeType, cursor.nodeIsNamed);
          if (scope !== undefined) {
            // 命中 scope 的节点整体作为一个 token，不再下钻（避免父子重复着色）
            const startChar = Math.max(start, range.start) - range.start;
            const endChar = Math.min(end, range.end) - range.start;
            if (endChar > startChar) {
              tokens.push({ startChar, endChar, scope });
            }
          } else {
            descend = true;
          }
        }
        if (descend && cursor.gotoFirstChild()) {
          continue;
        }
        if (cursor.gotoNextSibling()) {
          continue;
        }
        for (;;) {
          if (!cursor.gotoParent()) {
            done = true;
            break;
          }
          if (cursor.gotoNextSibling()) {
            break;
          }
        }
      }
    } finally {
      cursor.delete();
    }
    this.cache.set(line, tokens);
    return tokens;
  }

  dispose(): void {
    this.loadGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.doc = undefined;
    this.dropTree();
    this.parser?.delete();
    this.parser = undefined;
    this.language = undefined;
    this.languageIdValue = undefined;
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  /** 加载 web-tree-sitter 并初始化 wasm 运行时（memoized；失败结果同样缓存，不重试）。 */
  private ensureRuntime(): Promise<ParserCtor | undefined> {
    this.initPromise ??= (async () => {
      try {
        const loaded: unknown = await import("web-tree-sitter");
        // CJS（export = Parser）经 ESM 动态导入时落在 default 上；打包器形态兼容处理
        const holder = loaded as { default?: unknown };
        const ctor = (holder.default ?? loaded) as ParserCtor;
        const wasm = this.runtimeWasm ?? (await defaultRuntimeWasm());
        if (wasm !== undefined && !(await wasmReachable(wasm))) {
          return undefined; // 本地运行时 wasm 缺失：降级，避免 emscripten abort 毒化模块级 initPromise
        }
        await ctor.init(wasm === undefined ? undefined : { locateFile: () => wasm });
        return ctor;
      } catch {
        return undefined;
      }
    })();
    return this.initPromise;
  }

  private dropTree(): void {
    this.tree?.delete();
    this.tree = undefined;
    this.cache.clear();
  }

  /** 全量解析（或在无语言/无文档时保持纯文本降级）。 */
  private reparseFull(): void {
    this.cache.clear();
    if (this.doc === undefined || this.parser === undefined || this.language === undefined) {
      this.dropTree();
      return;
    }
    const text = this.doc.getText();
    try {
      const tree = this.parser.parse(text);
      if (tree === null || tree === undefined) {
        throw new Error("tree-sitter parse returned a null tree");
      }
      this.mirror = text;
      this.tree?.delete();
      this.tree = tree;
    } catch {
      // 解析失败不阻断编辑：回退纯文本 token 流
      this.dropTree();
    }
  }

  /** 文档变更 → 逐条 tree.edit（镜像重放计算点位）→ 带旧树增量重解析。 */
  private onDocumentChange(changes: DocumentChange[]): void {
    this.cache.clear();
    if (this.tree === undefined || this.parser === undefined || this.doc === undefined) {
      return;
    }
    try {
      for (const change of changes) {
        const startPosition = pointForOffset(this.mirror, change.offset);
        const oldEndPosition = pointForOffset(this.mirror, change.offset + change.removedLength);
        this.mirror =
          this.mirror.slice(0, change.offset) +
          change.insertedText +
          this.mirror.slice(change.offset + change.removedLength);
        const newEndPosition = pointForOffset(this.mirror, change.offset + change.insertedLength);
        this.tree.edit({
          startIndex: change.offset,
          oldEndIndex: change.offset + change.removedLength,
          newEndIndex: change.offset + change.insertedLength,
          startPosition,
          oldEndPosition,
          newEndPosition,
        });
      }
      const next = this.parser.parse(this.mirror, this.tree);
      if (next === null || next === undefined) {
        throw new Error("tree-sitter incremental parse returned a null tree");
      }
      this.tree.delete();
      this.tree = next;
    } catch {
      // 增量状态损坏：丢弃旧树并尝试全量重建；重建也失败则由 reparseFull 回退纯文本
      this.dropTree();
      this.reparseFull();
    }
  }
}
