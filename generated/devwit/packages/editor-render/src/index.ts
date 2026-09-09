/** @devwit/editor-render — Canvas 自绘渲染器：虚拟化布局、主题、IME 输入、编辑器视图。 */
export {
  EditorView,
  type BreakpointKind,
  type DiagnosticRange,
  type EditorViewOptions,
  type HighlightTokenProvider,
} from "./editor-view.js";
export { ImeInput, type ImeInputCallbacks } from "./ime-input.js";
export {
  clampScrollTop,
  columnForX,
  columnForXChars,
  comparePositions,
  computeAutoIndent,
  computeAutoPair,
  computeFoldRegions,
  findMatchingBracket,
  indentLevelOf,
  isSelectionEmpty,
  isWideCodePoint,
  maxScrollTop,
  measureTextWidth,
  minimapLayout,
  normalizeSelection,
  outdentLine,
  visibleLineRange,
  xForColumn,
  xForColumnChars,
  type CharWidthFn,
  type FoldRegion,
  type Measurer,
  type MinimapLayout,
  type Selection,
} from "./layout.js";
export { defaultDarkTheme, type Theme } from "./theme.js";
