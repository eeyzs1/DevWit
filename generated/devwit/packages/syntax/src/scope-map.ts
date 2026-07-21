/**
 * tree-sitter 节点类型 → 高亮 scope 的映射。
 * scope 键与 @devwit/editor-render 的 Theme.scopes 对齐（AR003：两包不互相依赖，各自定义同一约定）。
 *
 * tree-sitter-wasms 只分发语法 wasm，不带 highlight 查询（.scm），因此这里直接映射
 * 具体语法树节点类型：命名节点查 NAMED_NODE_SCOPES；匿名 token（type 为字面文本，
 * 如 "if"、"("、"=>"）查关键字/运算符/标点三张表。覆盖 TypeScript/TSX/JavaScript/Python
 * 四种内置语法的公共节点；未命中的节点返回 undefined，由渲染层以前景色兜底。
 */

export type TokenScope =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "constant"
  | "function"
  | "type"
  | "variable"
  | "parameter"
  | "property"
  | "operator"
  | "punctuation"
  | "tag"
  | "attribute"
  | "text";

export const TOKEN_SCOPES: readonly TokenScope[] = [
  "keyword",
  "string",
  "comment",
  "number",
  "constant",
  "function",
  "type",
  "variable",
  "parameter",
  "property",
  "operator",
  "punctuation",
  "tag",
  "attribute",
  "text",
];

export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}

/** 命名节点（named=true）的类型 → scope。 */
const NAMED_NODE_SCOPES: Readonly<Record<string, TokenScope>> = {
  // 字符串
  string: "string",
  string_literal: "string",
  template_string: "string",
  template_literal: "string",
  char_literal: "string",
  interpreted_string_literal: "string",
  raw_string_literal: "string",
  concatenated_string: "string",
  // 注释
  comment: "comment",
  line_comment: "comment",
  block_comment: "comment",
  // 数字
  number: "number",
  number_literal: "number",
  integer: "number",
  integer_literal: "number",
  float: "number",
  float_literal: "number",
  // 常量（JS/TS 的 true/false/null 与 Python 的 True/False/None 均为命名节点）
  true: "constant",
  false: "constant",
  null: "constant",
  none: "constant",
  nil: "constant",
  undefined: "constant",
  // 标识符类
  identifier: "variable",
  property_identifier: "property",
  shorthand_property_identifier: "property",
  shorthand_property_identifier_pattern: "property",
  field_identifier: "property",
  type_identifier: "type",
  predefined_type: "type",
  // this/super 在 JS/TS 语法中是命名节点
  this: "keyword",
  super: "keyword",
  // 标记语言（tsx 之外，如后续接入 html）
  tag_name: "tag",
  attribute_name: "attribute",
};

/** 匿名关键字 token（type 为字面文本）。跨 TS/JS/Python 取并集，查不中的语言不会产出该 token。 */
const KEYWORD_TOKENS: ReadonlySet<string> = new Set([
  // TS/JS
  "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue",
  "return", "yield", "function", "class", "interface", "enum", "namespace", "module",
  "import", "export", "from", "as", "new", "delete", "typeof", "instanceof", "in", "of",
  "try", "catch", "finally", "throw", "async", "await", "const", "let", "var",
  "static", "public", "private", "protected", "readonly", "abstract", "override",
  "extends", "implements", "get", "set", "declare", "type", "keyof",
  // Python
  "def", "elif", "lambda", "pass", "global", "nonlocal", "assert", "with", "raise",
  "except", "and", "or", "not", "is", "del", "match",
]);

/** 匿名运算符 token。 */
const OPERATOR_TOKENS: ReadonlySet<string> = new Set([
  "+", "-", "*", "/", "%", "**", "//", "=", "==", "===", "!=", "!==",
  "<", ">", "<=", ">=", "&&", "||", "!", "??", "?.", "=>",
  "+=", "-=", "*=", "/=", "%=", "**=", "//=", "&=", "|=", "^=", ">>=", "<<=", ">>>=",
  "++", "--", "~", "&", "|", "^", "<<", ">>", ">>>", "?", ":=", "@",
]);

/** 匿名标点 token。 */
const PUNCTUATION_TOKENS: ReadonlySet<string> = new Set([
  "(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "...", "->",
]);

/**
 * 节点 → scope。named 来自 tree-sitter（SyntaxNode.isNamed / TreeCursor.nodeIsNamed）。
 * 未命中返回 undefined：调用方跳过该节点并继续下钻（命名节点）或丢弃（匿名叶子）。
 */
export function scopeForNodeType(type: string, named: boolean): TokenScope | undefined {
  if (named) {
    return NAMED_NODE_SCOPES[type];
  }
  if (KEYWORD_TOKENS.has(type)) {
    return "keyword";
  }
  if (OPERATOR_TOKENS.has(type)) {
    return "operator";
  }
  if (PUNCTUATION_TOKENS.has(type)) {
    return "punctuation";
  }
  return undefined;
}
