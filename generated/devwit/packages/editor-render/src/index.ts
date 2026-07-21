/** @devwit/editor-render — Canvas 自绘渲染器：虚拟化布局、主题、IME 输入、编辑器视图。 */
export {
  EditorView,
  type EditorViewOptions,
  type HighlightTokenProvider,
} from "./editor-view.js";
export { ImeInput, type ImeInputCallbacks } from "./ime-input.js";
export {
  clampScrollTop,
  columnForX,
  comparePositions,
  isSelectionEmpty,
  maxScrollTop,
  normalizeSelection,
  visibleLineRange,
  xForColumn,
  type Measurer,
  type Selection,
} from "./layout.js";
export { defaultDarkTheme, type Theme } from "./theme.js";
