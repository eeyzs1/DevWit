/** 渲染配色。scopes 键与 @devwit/syntax 的 TokenScope 对齐，但本包不依赖它（AR003 解耦）。 */
export interface Theme {
  background: string;
  foreground: string;
  gutterBackground: string;
  lineNumberForeground: string;
  currentLineBackground: string;
  selectionBackground: string;
  cursor: string;
  compositionForeground: string;
  compositionUnderline: string;
  /** 诊断波浪线：错误（LSP severity=error）。 */
  diagnosticError: string;
  /** 诊断波浪线：警告（LSP severity=warning）。 */
  diagnosticWarning: string;
  /** 高亮 scope → 颜色，如 "keyword"/"string"/"comment"；未配置的 scope 用 foreground */
  scopes: Partial<Record<string, string>>;
}

export const defaultDarkTheme: Theme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  gutterBackground: "#1e1e1e",
  lineNumberForeground: "#858585",
  currentLineBackground: "#2a2a2a",
  selectionBackground: "rgba(38, 79, 120, 0.6)",
  cursor: "#aeafad",
  compositionForeground: "#d4d4d4",
  compositionUnderline: "#569cd6",
  diagnosticError: "#f14c4c",
  diagnosticWarning: "#cca700",
  scopes: {
    keyword: "#569cd6",
    string: "#ce9178",
    comment: "#6a9955",
    number: "#b5cea8",
    constant: "#4fc1ff",
    function: "#dcdcaa",
    type: "#4ec9b0",
    variable: "#9cdcfe",
    parameter: "#9cdcfe",
    property: "#9cdcfe",
    operator: "#d4d4d4",
    punctuation: "#808080",
    tag: "#569cd6",
    attribute: "#9cdcfe",
    text: "#d4d4d4",
  },
};
