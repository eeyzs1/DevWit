/** 一次正向编辑操作（replace 语义：删除 [offset, offset+removedText.length) 并插入 insertedText）。 */
export interface EditOp {
  offset: number;
  removedText: string;
  insertedText: string;
}

function startsWithWhitespace(text: string): boolean {
  return text.length > 0 && /\s/.test(text.charAt(0));
}

function endsWithWhitespace(text: string): boolean {
  return text.length > 0 && /\s/.test(text.charAt(text.length - 1));
}

/**
 * undo/redo 栈。每次 applyEdit 推入一个 EditOp；相邻的连续输入（中间无空白字符）
 * 与连续退格/删除会合并为一条 undo 记录（typing coalescing）。
 * 栈只存数据，逆操作的解释与执行由 TextDocument 完成。
 */
export class UndoStack {
  private readonly limit: number;
  private undoEntries: EditOp[][] = [];
  private redoEntries: EditOp[][] = [];

  constructor(limit = 10000) {  // qg-allow: 撤销深度默认值，编辑器内核策略常量，构造时可注入覆盖
    this.limit = Math.max(1, limit);
  }

  get canUndo(): boolean {
    return this.undoEntries.length > 0;
  }

  get canRedo(): boolean {
    return this.redoEntries.length > 0;
  }

  get undoDepth(): number {
    return this.undoEntries.length;
  }

  /** 记录一次已应用的正向编辑。会使 redo 栈失效。 */
  push(op: EditOp): void {
    this.redoEntries = [];
    const top = this.undoEntries[this.undoEntries.length - 1];
    const topOp = top !== undefined && top.length === 1 ? top[0] : undefined;
    if (top !== undefined && topOp !== undefined && this.canCoalesce(topOp, op)) {
      top[0] = this.merge(topOp, op);
      return;
    }
    this.undoEntries.push([{ offset: op.offset, removedText: op.removedText, insertedText: op.insertedText }]);
    if (this.undoEntries.length > this.limit) {
      this.undoEntries.shift();
    }
  }

  /** 弹出最旧的未撤销记录并移交 redo 栈。 */
  popUndo(): EditOp[] | undefined {
    const entry = this.undoEntries.pop();
    if (entry !== undefined) {
      this.redoEntries.push(entry);
    }
    return entry;
  }

  /** 弹出最近撤销的记录并移交 undo 栈。 */
  popRedo(): EditOp[] | undefined {
    const entry = this.redoEntries.pop();
    if (entry !== undefined) {
      this.undoEntries.push(entry);
    }
    return entry;
  }

  clear(): void {
    this.undoEntries = [];
    this.redoEntries = [];
  }

  private canCoalesce(prev: EditOp, next: EditOp): boolean {
    // 连续插入：next 紧跟 prev 末尾，且边界两侧都不是空白字符。
    if (prev.removedText.length === 0 && next.removedText.length === 0) {
      return (
        prev.offset + prev.insertedText.length === next.offset &&
        !endsWithWhitespace(prev.insertedText) &&
        !startsWithWhitespace(next.insertedText)
      );
    }
    // 连续删除（退格向左 / Delete 向右），同样以空白字符打断合并。
    if (prev.insertedText.length === 0 && next.insertedText.length === 0) {
      if (next.offset + next.removedText.length === prev.offset) {
        return !startsWithWhitespace(prev.removedText) && !endsWithWhitespace(next.removedText);
      }
      if (next.offset === prev.offset && prev.removedText.length > 0) {
        return !endsWithWhitespace(prev.removedText) && !startsWithWhitespace(next.removedText);
      }
    }
    return false;
  }

  private merge(prev: EditOp, next: EditOp): EditOp {
    if (prev.removedText.length === 0 && next.removedText.length === 0) {
      return { offset: prev.offset, removedText: "", insertedText: prev.insertedText + next.insertedText };
    }
    if (next.offset + next.removedText.length === prev.offset) {
      // 退格：next 在 prev 左侧
      return { offset: next.offset, removedText: next.removedText + prev.removedText, insertedText: "" };
    }
    // Delete：next 在 prev 右侧
    return { offset: prev.offset, removedText: prev.removedText + next.removedText, insertedText: "" };
  }
}
