/** @devwit/editor-core — piece-table 文本缓冲区、undo/redo、TextDocument。 */
export { Emitter, type Listener } from "./emitter.js";
export { PieceTable, type Position, type PieceTableChange } from "./piece-table.js";
export { UndoStack, type EditOp } from "./undo-stack.js";
export {
  TextDocument,
  type TextEdit,
  type DocumentChange,
  type DocumentChangeEvent,
} from "./document.js";
