import { createHash } from "node:crypto";
import type { CodeSymbol, SymbolKind } from "@devwit/contracts";

/**
 * 启发式符号提取器（迭代 29 / AC38 的核心）。
 *
 * 选型：纯正则 + 行扫描，零新增依赖（不引 tree-sitter/LSP——体积与原生模块
 * 风险换不起 80% 精度的提升）。覆盖主流语言的常见声明形态；未覆盖的写法
 * （宏生成代码、条件编译、字符串内嵌代码）宁可漏提也不错提——候选缺失可由
 * @文件引用与 RAG 块检索兜底，错误符号会破坏信任。
 *
 * 定界：C 系按大括号深度（忽略行注释与字符串内容），Python/Ruby 按缩进块；
 * 单符号 ≤ SYMBOL_MAX_LINES 行截断（防巨型函数拖垮注入预算）。
 *
 * 两遍提取：先容器/顶级符号，再在容器范围内提取方法（parentName 归属）；
 * Go 接收者方法是一等规则（顶级匹配，parent 来自接收者类型，无需容器）。
 */

/** 单符号最大行数（超出截断）。 */
export const SYMBOL_MAX_LINES = 200; // qg-allow: 注入预算防护上限，与 chunker 软限同量级
/** 无括号声明（type alias/const 值）向后扫描 `;` 的最大行数。 */
const BRACELESS_LOOKAHEAD = 20;
/** 声明行展示截断。 */
const SIGNATURE_MAX_CHARS = 120;

/** 方法名误报排除（控制流关键字与内置调用形态）——仅适用于泛型方法模式（TS/Java/C# 的 name( 形态）。 */
const METHOD_NAME_EXCLUDES: ReadonlySet<string> = new Set([
  "if", "for", "while", "switch", "catch", "return", "new", "typeof", "else",
  "do", "this", "super", "function", "sizeof", "await", "yield", "case",
]);

interface SymbolRule {
  kind: SymbolKind;
  pattern: RegExp;
  /** 按命名组 skind 动态定 kind（如 Java 的 class|interface|enum 单规则）。 */
  kindFromGroup?: Record<string, SymbolKind>;
  /**
   * 方法名排除集：仅泛型方法模式需要（pattern 无 fn/fun/def/func 等关键字锚点，
   * 会把 `if (x)` / `new Foo()` 误提为方法）；关键字锚定规则的 name 必为合法声明名，
   * 不得套用——Rust/Kotlin 的 fn new/fun new 是常见合法方法名。
   */
  nameExcludes?: ReadonlySet<string>;
}

/** 方法容器过滤：kind 匹配 + 可选 signature 前缀（Rust 的 impl 与 mod 同为 module kind，据此区分）。 */
interface ContainerFilter {
  kind: SymbolKind;
  signatureStartsWith?: string;
}

interface LanguageSpec {
  extensions: readonly string[];
  /** 顶级/容器级规则（行首锚定）。 */
  rules: readonly SymbolRule[];
  /** 方法规则（仅在容器范围内匹配，行首有缩进）。 */
  methodRules?: readonly SymbolRule[];
  /** 方法二遍归属的容器 kinds。 */
  methodContainers?: readonly ContainerFilter[];
  /** 定界风格。 */
  delim: "braces" | "indent";
}

const TS_METHOD: SymbolRule = {
  kind: "method",
  pattern:
    /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|abstract\s+|readonly\s+|accessor\s+)*(?:get\s+|set\s+)?(?<name>[A-Za-z_$][\w$]*)\s*(?:<[^>{]*>)?\s*\(/,
  nameExcludes: METHOD_NAME_EXCLUDES,
};

const TS_SPEC: LanguageSpec = {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  rules: [
    { kind: "function", pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "class", pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "interface", pattern: /^(?:export\s+)?interface\s+(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "type", pattern: /^(?:export\s+)?type\s+(?<name>[A-Za-z_$][\w$]*)\s*[=<]/ },
    { kind: "enum", pattern: /^(?:export\s+)?(?:const\s+)?enum\s+(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "constant", pattern: /^(?:export\s+)?const\s+(?<name>[A-Za-z_$][\w$]*)\s*[:=]/ },
  ],
  methodRules: [TS_METHOD],
  methodContainers: [{ kind: "class" }],
  delim: "braces",
};

const PY_SPEC: LanguageSpec = {
  extensions: [".py"],
  rules: [
    { kind: "class", pattern: /^class\s+(?<name>\w+)/ },
    { kind: "function", pattern: /^(?:async\s+)?def\s+(?<name>\w+)/ },
    { kind: "constant", pattern: /^(?<name>[A-Z][A-Z0-9_]{2,})\s*(?::[^=\n]+)?=/ },
  ],
  methodRules: [{ kind: "method", pattern: /^\s+(?:async\s+)?def\s+(?<name>\w+)/ }],
  methodContainers: [{ kind: "class" }],
  delim: "indent",
};

const GO_SPEC: LanguageSpec = {
  extensions: [".go"],
  rules: [
    // 接收者方法先于普通函数：func (r *Rect) Area() —— parent 取接收者类型
    { kind: "method", pattern: /^func\s+\(\s*\w+\s+\*?(?<parent>[\w.]+)\s*\)\s*(?<name>\w+)\s*\(/ },
    { kind: "function", pattern: /^func\s+(?<name>\w+)\s*\(/ },
    { kind: "class", pattern: /^type\s+(?<name>\w+)\s+struct\b/ },
    { kind: "interface", pattern: /^type\s+(?<name>\w+)\s+interface\b/ },
    { kind: "constant", pattern: /^const\s+(?<name>\w+)\s*=/ },
  ],
  delim: "braces",
};

const RUST_SPEC: LanguageSpec = {
  extensions: [".rs"],
  rules: [
    { kind: "function", pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(?<name>\w+)/ },
    { kind: "class", pattern: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+(?<name>\w+)/ },
    { kind: "enum", pattern: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+(?<name>\w+)/ },
    { kind: "interface", pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(?<name>\w+)/ },
    // impl 块：容器（方法归属）；trait impl 时 name 取实现目标类型
    { kind: "module", pattern: /^impl(?:<[^>]*>)?\s+(?:(?<trait>[\w:]+)\s+for\s+)?(?<name>[\w:]+)/ },
    { kind: "module", pattern: /^(?:pub(?:\([^)]*\))?\s+)?mod\s+(?<name>\w+)/ },
    { kind: "constant", pattern: /^(?:pub\s+)?(?:const|static)\s+(?<name>[A-Z][\w]*)\s*:/ },
  ],
  methodRules: [
    { kind: "method", pattern: /^\s+(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(?<name>\w+)/ },
  ],
  methodContainers: [{ kind: "module", signatureStartsWith: "impl" }],
  delim: "braces",
};

const JAVA_SPEC: LanguageSpec = {
  extensions: [".java"],
  rules: [
    {
      kind: "class",
      pattern: /^(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+|sealed\s+)*(?<skind>class|interface|enum|record|@interface)\s+(?<name>\w+)/,
      kindFromGroup: { class: "class", record: "class", interface: "interface", "@interface": "interface", enum: "enum" },
    },
  ],
  methodRules: [
    {
      kind: "method",
      pattern: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+|abstract\s+|native\s+|default\s+)*(?:<[\w,?\s]+>\s*)?[\w$<>[\].?]+\s+(?<name>[A-Za-z_$][\w$]*)\s*\(/,
      nameExcludes: METHOD_NAME_EXCLUDES,
    },
  ],
  methodContainers: [{ kind: "class" }],
  delim: "braces",
};

const CSHARP_SPEC: LanguageSpec = {
  extensions: [".cs"],
  rules: [
    {
      kind: "class",
      pattern: /^(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|sealed\s+|partial\s+|readonly\s+)*(?<skind>class|interface|enum|struct|record)\s+(?<name>\w+)/,
      kindFromGroup: { class: "class", struct: "class", record: "class", interface: "interface", enum: "enum" },
    },
  ],
  methodRules: [
    {
      kind: "method",
      pattern: /^\s+(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|virtual\s+|override\s+|async\s+|sealed\s+|extern\s+|readonly\s+|partial\s+)*[\w$<>[\].?,\s]+?\s+(?<name>[A-Za-z_]\w*)\s*\(/,
      nameExcludes: METHOD_NAME_EXCLUDES,
    },
  ],
  methodContainers: [{ kind: "class" }],
  delim: "braces",
};

const KOTLIN_SPEC: LanguageSpec = {
  extensions: [".kt"],
  rules: [
    { kind: "enum", pattern: /^(?:[\w]+\s+)*enum\s+class\s+(?<name>\w+)/ },
    {
      kind: "class",
      pattern: /^(?:(?:public|private|protected|internal|open|abstract|sealed|data|annotation|inner)\s+)*(?<skind>class|interface|object)\s+(?<name>\w+)/,
      kindFromGroup: { class: "class", object: "class", interface: "interface" },
    },
    // 扩展函数 Type.name( 的 parent 取接收者类型
    { kind: "function", pattern: /^(?:[\w]+\s+)*fun\s+(?:<[^>]+>\s+)?(?:(?<parent>\w+)\.)?(?<name>\w+)\s*\(/ },
  ],
  methodRules: [
    { kind: "method", pattern: /^\s+(?:[\w]+\s+)*fun\s+(?:<[^>]+>\s+)?(?<name>\w+)\s*\(/ },
  ],
  methodContainers: [{ kind: "class" }],
  delim: "braces",
};

const PHP_SPEC: LanguageSpec = {
  extensions: [".php"],
  rules: [
    { kind: "class", pattern: /^class\s+(?<name>\w+)/ },
    { kind: "interface", pattern: /^interface\s+(?<name>\w+)/ },
    { kind: "function", pattern: /^function\s+(?<name>\w+)\s*\(/ },
  ],
  methodRules: [
    { kind: "method", pattern: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*function\s+(?<name>\w+)\s*\(/ },
  ],
  methodContainers: [{ kind: "class" }],
  delim: "braces",
};

const RUBY_SPEC: LanguageSpec = {
  extensions: [".rb"],
  rules: [
    { kind: "class", pattern: /^class\s+(?<name>[\w:]+)/ },
    { kind: "module", pattern: /^module\s+(?<name>[\w:]+)/ },
    { kind: "function", pattern: /^def\s+(?<name>[\w!?=]+)/ },
  ],
  methodRules: [{ kind: "method", pattern: /^\s+def\s+(?<name>[\w!?=]+)/ }],
  methodContainers: [{ kind: "class" }, { kind: "module" }],
  delim: "indent",
};

const SWIFT_SPEC: LanguageSpec = {
  extensions: [".swift"],
  rules: [
    {
      kind: "class",
      pattern: /^(?:(?:public|private|internal|fileprivate|open|final|indirect)\s+)*(?<skind>class|struct|enum|protocol|extension)\s+(?<name>\w+)/,
      kindFromGroup: { class: "class", struct: "class", enum: "enum", protocol: "interface", extension: "module" },
    },
    { kind: "function", pattern: /^(?:(?:public|private|internal|fileprivate|open|static|override|mutating)\s+)*func\s+(?<name>\w+)\s*\(/ },
  ],
  methodRules: [
    { kind: "method", pattern: /^\s+(?:(?:public|private|internal|fileprivate|open|static|override|mutating|final)\s+)*func\s+(?<name>\w+)\s*\(/ },
  ],
  methodContainers: [{ kind: "class" }, { kind: "module" }],
  delim: "braces",
};

const DART_SPEC: LanguageSpec = {
  extensions: [".dart"],
  rules: [
    { kind: "class", pattern: /^(?:abstract\s+)?(?:base\s+|final\s+|sealed\s+)?(?:class|mixin)\s+(?<name>\w+)/ },
    { kind: "enum", pattern: /^enum\s+(?<name>\w+)/ },
    { kind: "module", pattern: /^extension\s+(?<name>\w+)/ },
  ],
  delim: "braces",
};

const SPECS: readonly LanguageSpec[] = [
  TS_SPEC, PY_SPEC, GO_SPEC, RUST_SPEC, JAVA_SPEC,
  CSHARP_SPEC, KOTLIN_SPEC, PHP_SPEC, RUBY_SPEC, SWIFT_SPEC, DART_SPEC,
];

const SPEC_BY_EXT = new Map<string, LanguageSpec>();
for (const spec of SPECS) {
  for (const ext of spec.extensions) SPEC_BY_EXT.set(ext, spec);
}

/** 该路径是否支持符号提取（按扩展名；C/C++ 保守跳过——函数原型正则误报率不可接受，由 chunk/RAG 兜底）。 */
export function supportsSymbols(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  if (dot < 0) return false;
  return SPEC_BY_EXT.has(relPath.slice(dot).toLowerCase());
}

export function makeSymbolId(relPath: string, name: string, kind: SymbolKind, startLine: number): string {
  return createHash("sha1").update(`${relPath}:${name}:${kind}:${startLine}`).digest("hex").slice(0, 16);
}

/** 提取单个源文件的符号。空文件/不支持的语言/无声明文件产出零符号。 */
export function extractSymbols(relPath: string, content: string): CodeSymbol[] {
  const dot = relPath.lastIndexOf(".");
  const spec = dot >= 0 ? SPEC_BY_EXT.get(relPath.slice(dot).toLowerCase()) : undefined;
  if (spec === undefined) return [];
  const lines = content.split("\n");
  const maxLine = lines.length;

  const raw: Array<{ name: string; kind: SymbolKind; parent?: string; startIdx: number }> = [];
  for (let i = 0; i < maxLine; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    for (const rule of spec.rules) {
      const match = rule.pattern.exec(line);
      const groups = match?.groups;
      if (groups?.["name"] === undefined) continue;
      const kind = resolveKind(rule, groups);
      if (kind === null) continue;
      const parent = groups["parent"];
      raw.push({
        name: groups["name"],
        kind,
        startIdx: i,
        ...(parent !== undefined ? { parent } : {}),
      });
      break; // 一行只归属首个命中规则（规则按特异性排序）
    }
  }

  // 一遍符号先定界（容器范围是方法二遍的前提）
  const symbols: CodeSymbol[] = raw.map((entry) => {
    const endIdx = spec.delim === "braces" ? endLineBraces(lines, entry.startIdx) : endLineIndent(lines, entry.startIdx);
    return toSymbol(relPath, lines, entry, endIdx);
  });

  // 方法二遍：容器范围内 + 行首缩进的方法规则；归属最小包含容器
  if (spec.methodRules !== undefined && spec.methodContainers !== undefined) {
    const containers = symbols.filter((symbol) =>
      spec.methodContainers!.some(
        (filter) =>
          filter.kind === symbol.kind &&
          (filter.signatureStartsWith === undefined || symbol.signature.startsWith(filter.signatureStartsWith))
      )
    );
    if (containers.length > 0) {
      for (let i = 0; i < maxLine; i++) {
        const line = lines[i]!;
        if (!/^\s+\S/.test(line)) continue;
        const container = innermostContainer(containers, i + 1);
        if (container === null) continue;
        for (const rule of spec.methodRules) {
          const match = rule.pattern.exec(line);
          const name = match?.groups?.["name"];
          if (name === undefined) continue;
          if (rule.nameExcludes?.has(name) === true) break;
          // 与容器自身声明行重合（如 class 行内的构造形态）则跳过
          if (container.startLine === i + 1) break;
          const endIdx = spec.delim === "braces" ? endLineBraces(lines, i) : endLineIndent(lines, i);
          symbols.push(
            toSymbol(relPath, lines, { name, kind: rule.kind, startIdx: i, parent: container.name }, endIdx)
          );
          break;
        }
      }
    }
  }

  symbols.sort((a, b) => a.startLine - b.startLine || a.kind.localeCompare(b.kind));
  return symbols;
}

function resolveKind(rule: SymbolRule, groups: Record<string, string | undefined>): SymbolKind | null {
  if (rule.kindFromGroup === undefined) return rule.kind;
  const skind = groups["skind"];
  if (skind === undefined) return null;
  return rule.kindFromGroup[skind] ?? null;
}

function innermostContainer(containers: CodeSymbol[], line: number): CodeSymbol | null {
  let best: CodeSymbol | null = null;
  for (const container of containers) {
    if (container.startLine >= line || container.endLine < line) continue;
    if (best === null || container.endLine - container.startLine < best.endLine - best.startLine) {
      best = container;
    }
  }
  return best;
}

function toSymbol(
  relPath: string,
  lines: string[],
  entry: { name: string; kind: SymbolKind; parent?: string; startIdx: number },
  endIdx: number
): CodeSymbol {
  const startLine = entry.startIdx + 1;
  const endLine = Math.min(endIdx + 1, entry.startIdx + SYMBOL_MAX_LINES);
  const signatureRaw = lines[entry.startIdx]!.trim();
  return {
    id: makeSymbolId(relPath, entry.name, entry.kind, startLine),
    name: entry.name,
    kind: entry.kind,
    relPath,
    startLine,
    endLine,
    signature: signatureRaw.length > SIGNATURE_MAX_CHARS ? `${signatureRaw.slice(0, SIGNATURE_MAX_CHARS)}…` : signatureRaw,
    ...(entry.parent !== undefined ? { parentName: entry.parent } : {}),
  };
}

/**
 * 大括号定界：从声明行起跟踪 { } 深度（剥离行注释与字符串字面量内容），
 * 深度归零即闭合；声明无括号（type alias/const 值/接口签名）时向后扫描
 * 顶层 `;`（≤ BRACELESS_LOOKAHEAD 行），仍无则单行符号。
 * 单行完整声明（声明行末尾括号平衡且非续行尾符，如 Kotlin data class）立即
 * 收编为单行符号——否则扫描会吞并下一个带 {} 的符号边界。
 */
function endLineBraces(lines: string[], startIdx: number): number {
  const maxEnd = Math.min(lines.length - 1, startIdx + SYMBOL_MAX_LINES - 1);
  let depth = 0;
  let opened = false;
  let parenDepth = 0;
  for (let i = startIdx; i <= maxEnd; i++) {
    const stripped = stripForBraces(lines[i]!);
    for (const ch of stripped) {
      if (ch === "{") {
        depth += 1;
        opened = true;
      } else if (ch === "}") {
        depth -= 1;
        if (opened && depth <= 0) return i;
      } else if (ch === "(" || ch === "[") {
        parenDepth += 1;
      } else if (ch === ")" || ch === "]") {
        parenDepth -= 1;
      }
    }
    if (!opened) {
      const trimmed = stripped.trimEnd();
      if (trimmed.endsWith(";")) return i;
      if (i === startIdx && parenDepth <= 0 && !CONTINUATION_SUFFIX.test(trimmed)) return startIdx;
      if (i - startIdx >= BRACELESS_LOOKAHEAD) return startIdx;
    }
  }
  return maxEnd;
}

/** 续行尾符（声明跨行未完结：类型联合/多行赋值/参数列表等），命中则继续向后扫描。 */
const CONTINUATION_SUFFIX = /[,=+\-*/|&?:<\\]$/;

/**
 * 缩进定界（Python/Ruby）：块延伸至首个缩进 ≤ 声明缩进的非空行；
 * 空行暂属块内（尾随空行不计入）；Ruby 的同缩进 `end` 行收编后闭合。
 */
function endLineIndent(lines: string[], startIdx: number): number {
  const maxEnd = Math.min(lines.length - 1, startIdx + SYMBOL_MAX_LINES - 1);
  const declIndent = indentOf(lines[startIdx]!);
  let end = startIdx;
  for (let i = startIdx + 1; i <= maxEnd; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const indent = indentOf(line);
    if (indent <= declIndent) {
      if (trimmed === "end" && indent === declIndent) return i; // Ruby end 收编
      break;
    }
    end = i;
  }
  return end;
}

function indentOf(line: string): number {
  let indent = 0;
  for (const ch of line) {
    if (ch === " ") indent += 1;
    else if (ch === "\t") indent += 4;
    else break;
  }
  return indent;
}

/** 剥离行注释与字符串内容（大括号计数不受干扰）；模板字符串按普通串处理（启发式）。 */
function stripForBraces(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === "\\") {
        i += 1; // 跳过转义字符
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    if (ch === "#") break; // Python/Ruby/Shell 注释
    out += ch;
  }
  return out;
}

/**
 * 符号候选过滤（@ 下拉查询）：name 前缀 > name 子串 > parentName 子串 > 路径子串；
 * 同分按名称字典序稳定排序后截断 limit（空查询即纯名称序，与文件候选空查询语义一致）。
 */
export function filterSymbols(symbols: readonly CodeSymbol[], query: string, limit = 8): CodeSymbol[] {  // qg-allow: 候选下拉默认页大小，调用方可覆盖
  const q = query.toLowerCase();
  const scored: { symbol: CodeSymbol; score: number }[] = [];
  for (const symbol of symbols) {
    if (q.length === 0) {
      scored.push({ symbol, score: 0 });
      continue;
    }
    const name = symbol.name.toLowerCase();
    const parent = symbol.parentName?.toLowerCase() ?? "";
    const path = symbol.relPath.toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (parent.includes(q)) score = 2;
    else if (path.includes(q)) score = 3;
    if (score >= 0) scored.push({ symbol, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.symbol.name.localeCompare(b.symbol.name) ||
      a.symbol.relPath.localeCompare(b.symbol.relPath) ||
      a.symbol.startLine - b.symbol.startLine
  );
  return scored.slice(0, limit).map((entry) => entry.symbol);
}
