import { Emitter, type Listener } from "./emitter.js";
import { PieceTable, type Position } from "./piece-table.js";
import { UndoStack, type EditOp } from "./undo-stack.js";

/** replace 语义的编辑：删除 [offset, offset+length) 并插入 text。 */
export interface TextEdit {
  offset: number;
  length: number;
  text: string;
}

export interface DocumentChange {
  offset: number;
  removedLength: number;
  insertedLength: number;
  /** 插入的文本本体，供增量解析器重建中间状态（不写入任何日志）。 */
  insertedText: string;
}

/** 一次版本递增对应的事件。undo/redo 可能含多个有序变更。 */
export interface DocumentChangeEvent {
  changes: DocumentChange[];
  version: number;
}

/**
 * 文本文档：piece-table 缓冲区 + undo/redo + 版本号 + 脏标记。
 * 所有坐标均为 UTF-16 code unit 偏移 / 0 起始行号。
 */
export class TextDocument {
  private table: PieceTable;
  private readonly undoStack = new UndoStack();
  private readonly changeEmitter = new Emitter<DocumentChangeEvent>();
  private versionValue = 0;
  private savedVersion = 0;
  /** 事务深度（>0 = 组编辑中）：applyEdit 的 undo 操作进事务缓冲而非 undo 栈。 */
  private transactionDepth = 0;
  /** 事务缓冲：endTransaction 时作为一条 undo 记录入栈。 */
  private transactionOps: EditOp[] = [];

  private constructor(table: PieceTable) {
    this.table = table;
  }

  static fromString(text: string): TextDocument {
    return new TextDocument(PieceTable.fromString(text));
  }

  onDidChange(listener: Listener<DocumentChangeEvent>): () => void {
    return this.changeEmitter.on(listener);
  }

  get version(): number {
    return this.versionValue;
  }

  get isDirty(): boolean {
    return this.versionValue !== this.savedVersion;
  }

  get length(): number {
    return this.table.length;
  }

  get lineCount(): number {
    return this.table.lineCount;
  }

  get canUndo(): boolean {
    return this.undoStack.canUndo;
  }

  get canRedo(): boolean {
    return this.undoStack.canRedo;
  }

  getText(): string {
    return this.table.getText();
  }

  getTextInRange(start: number, end: number): string {
    return this.table.getTextInRange(start, end);
  }

  getLine(n: number): string {
    return this.table.getLine(n);
  }

  getLineRange(n: number): { start: number; end: number } {
    return this.table.getLineRange(n);
  }

  positionAt(offset: number): Position {
    return this.table.positionAt(offset);
  }

  offsetAt(position: Position): number {
    return this.table.offsetAt(position);
  }

  /** 应用一次编辑：记录 undo、递增版本、派发 onDidChange。 */
  applyEdit(edit: TextEdit): void {
    const offset = Math.max(0, Math.min(edit.offset, this.table.length));
    const end = Math.max(offset, Math.min(offset + edit.length, this.table.length));
    const removedText = this.table.getTextInRange(offset, end);
    this.table.replace(offset, end - offset, edit.text);
    const op: EditOp = { offset, removedText, insertedText: edit.text };
    if (this.transactionDepth > 0) {
      // 事务中：编辑进事务缓冲，endTransaction 时合并为一条 undo（v0.7.2：
      // 一次逻辑操作（多光标/多行缩进/注释切换）一条 undo，消除"百行缩进按百次 Ctrl+Z"）
      this.transactionOps.push(op);
    } else {
      this.undoStack.push(op);
    }
    this.publish([
      {
        offset,
        removedLength: end - offset,
        insertedLength: edit.text.length,
        insertedText: edit.text,
      },
    ]);
  }

  /**
   * 开启事务：之后的 applyEdit 在 endTransaction 时合并为一条 undo 记录
   * （组内逆序回滚）。嵌套调用合并入最外层。change 事件仍逐编辑派发
   * （增量语法解析依赖细粒度变更）。
   */
  beginTransaction(): void {
    this.transactionDepth += 1;
  }

  /** 结束事务：最外层收口时把缓冲的操作作为一条 undo 入栈。 */
  endTransaction(): void {
    if (this.transactionDepth === 0) return;
    this.transactionDepth -= 1;
    if (this.transactionDepth === 0 && this.transactionOps.length > 0) {
      const ops = this.transactionOps;
      this.transactionOps = [];
      this.undoStack.pushGroup(ops);
    }
  }

  /** 事务便捷形式：fn 抛错也保证收口（已应用的编辑不悬空在缓冲里）。 */
  transact(fn: () => void): void {
    this.beginTransaction();
    try {
      fn();
    } finally {
      this.endTransaction();
    }
  }

  insert(offset: number, text: string): void {
    this.applyEdit({ offset, length: 0, text });
  }

  delete(offset: number, length: number): void {
    this.applyEdit({ offset, length, text: "" });
  }

  undo(): boolean {
    const entry = this.undoStack.popUndo();
    if (entry === undefined) {
      return false;
    }
    const changes: DocumentChange[] = [];
    // 逆序应用每条正向操作的逆操作
    for (let i = entry.length - 1; i >= 0; i--) {
      const op = entry[i];
      if (op === undefined) {
        continue;
      }
      this.table.replace(op.offset, op.insertedText.length, op.removedText);
      changes.push(this.inverseOf(op));
    }
    this.publish(changes);
    return true;
  }

  redo(): boolean {
    const entry = this.undoStack.popRedo();
    if (entry === undefined) {
      return false;
    }
    const changes: DocumentChange[] = [];
    for (const op of entry) {
      this.table.replace(op.offset, op.removedText.length, op.insertedText);
      changes.push({
        offset: op.offset,
        removedLength: op.removedText.length,
        insertedLength: op.insertedText.length,
        insertedText: op.insertedText,
      });
    }
    this.publish(changes);
    return true;
  }

  /** 把当前版本标记为已保存（isDirty 归零）。 */
  markSaved(): void {
    this.savedVersion = this.versionValue;
  }

  private inverseOf(op: EditOp): DocumentChange {
    return {
      offset: op.offset,
      removedLength: op.insertedText.length,
      insertedLength: op.removedText.length,
      insertedText: op.removedText,
    };
  }

  private publish(changes: DocumentChange[]): void {
    this.versionValue += 1;
    this.changeEmitter.fire({ changes, version: this.versionValue });
  }
}
