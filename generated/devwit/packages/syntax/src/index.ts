/** @devwit/syntax — tree-sitter wasm 语法高亮：scope 映射 + 增量解析高亮引擎。 */
export {
  TOKEN_SCOPES,
  isTokenScope,
  scopeForNodeType,
  type TokenScope,
} from "./scope-map.js";
export {
  HighlightEngine,
  LANGUAGE_WASM_FILES,
  type HighlightEngineOptions,
  type HighlightToken,
} from "./highlight-engine.js";
