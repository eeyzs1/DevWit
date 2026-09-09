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

  /**
   * 事务组入栈（v0.7.2：一次逻辑操作 = 一条 undo）。
   * - 单操作组：退化为常规 push——保持单光标打字的 coalescing 语义不变；
   * - 多操作组：若栈顶为同长度组且逐位满足纯插入续写（多光标连续打字，
   *   组内操作按应用序即降序偏移排列，位次跨击键稳定）→ 逐位合并为一条；
   *   否则整组作为一条新记录（多行缩进/注释切换等多编辑逻辑操作）。
   */
  pushGroup(ops: EditOp[]): void {
    this.redoEntries = [];
    if (ops.length === 0) return;
    if (ops.length === 1) {
      this.push(ops[0]!);
      return;
    }
    const top = this.undoEntries[this.undoEntries.length - 1];
    if (top !== undefined && this.canCoalesceGroup(top, ops)) {
      for (let i = 0; i < ops.length; i++) {
        top[i] = this.merge(top[i]!, ops[i]!);
      }
      return;
    }
    this.undoEntries.push(ops.map((op) => ({ offset: op.offset, removedText: op.removedText, insertedText: op.insertedText })));
    if (this.undoEntries.length > this.limit) {
      this.undoEntries.shift();
    }
  }

  /**
   * 多光标组逐位续写判定。关键：两组 op 的 offset 处于不同历史坐标 frame——
   * 栈顶组（旧 frame）op_i 的续写点 = offset + insertedText.length +（同组中
   * 更低位 op 引入的净位移：它们应用在后、插入在前，会右移 op_i 的内容），
   * 平移后才与下一组（新 frame）op_i.offset 可比。
   */
  private canCoalesceGroup(top: EditOp[], next: EditOp[]): boolean {
    if (top.length !== next.length || top.length === 0) return false;
    for (let i = 0; i < top.length; i++) {
      const prev = top[i]!;
      const op = next[i]!;
      if (prev.removedText.length !== 0 || op.removedText.length !== 0) return false;
      let shift = 0;
      for (let j = i + 1; j < top.length; j++) {
        shift += top[j]!.insertedText.length - top[j]!.removedText.length;
      }
      const continuation = prev.offset + prev.insertedText.length + shift;
      if (op.offset !== continuation) return false;
      if (endsWithWhitespace(prev.insertedText) || startsWithWhitespace(op.insertedText)) return false;
    }
    return true;
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
