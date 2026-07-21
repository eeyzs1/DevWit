import { Emitter, type Listener } from "./emitter.js";

/** 0-based 位置（行列均为字符索引，行为 0 起始行号）。 */
export interface Position {
  line: number;
  character: number;
}

/** 一次缓冲区变更。insertedText 供增量解析器等消费者重建中间文本。 */
export interface PieceTableChange {
  offset: number;
  removedLength: number;
  insertedLength: number;
  insertedText: string;
}

interface Piece {
  /** 0 = original（初始文本），1 = add（追加缓冲区） */
  buffer: 0 | 1;
  /** 在对应缓冲区中的起始偏移（UTF-16 code unit） */
  start: number;
  /** 片长（code unit 数），恒 > 0 */
  length: number;
  /**
   * 片内每个 '\n' 之后位置的偏移（相对于片首），取值范围 [1, length]。
   * 条目数即为该片包含的换行符数。
   */
  lineStarts: number[];
}

const LF = 10; // '\n'
const CR = 13; // '\r'

/** 计算 text[from, to) 区间内每个 '\n' 之后位置相对于 from 的偏移表。 */
function computeLineStarts(text: string, from: number, to: number): number[] {
  const starts: number[] = [];
  for (let i = from; i < to; i++) {
    if (text.charCodeAt(i) === LF) {
      starts.push(i - from + 1);
    }
  }
  return starts;
}

/** 返回有序数组中 <= value 的元素个数（upper bound）。 */
function countNotGreater(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const entry = arr[mid];
    if (entry !== undefined && entry <= value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * 经典 piece table 文本缓冲区：original 缓冲区只读，编辑内容追加到 add 缓冲区，
 * pieces 数组描述文档逻辑序列。插入/删除代价为 O(pieces)，与文件大小无关。
 * 连续输入会合并进 add 缓冲区尾部的同一个 piece，保持 piece 数有界。
 */
export class PieceTable {
  private original = "";
  private add = "";
  private pieces: Piece[] = [];
  private totalLength = 0;
  private totalFeeds = 0;
  private readonly changeEmitter = new Emitter<PieceTableChange>();

  private constructor() {}

  static fromString(text: string): PieceTable {
    const table = new PieceTable();
    table.original = text;
    if (text.length > 0) {
      table.pieces = [
        {
          buffer: 0,
          start: 0,
          length: text.length,
          lineStarts: computeLineStarts(text, 0, text.length),
        },
      ];
      table.totalLength = text.length;
      table.totalFeeds = table.pieces[0]?.lineStarts.length ?? 0;
    }
    return table;
  }

  /** 变更事件：insert/delete/replace 各触发一次。 */
  onDidChange(listener: Listener<PieceTableChange>): () => void {
    return this.changeEmitter.on(listener);
  }

  get length(): number {
    return this.totalLength;
  }

  get lineCount(): number {
    return this.totalFeeds + 1;
  }

  /** 当前 piece 数（诊断/性能证据用）。 */
  get pieceCount(): number {
    return this.pieces.length;
  }

  getText(): string {
    return this.getTextInRange(0, this.totalLength);
  }

  getTextInRange(start: number, end: number): string {
    const lo = Math.max(0, Math.min(start, this.totalLength));
    const hi = Math.max(lo, Math.min(end, this.totalLength));
    if (lo >= hi) {
      return "";
    }
    const parts: string[] = [];
    let pieceStart = 0;
    for (const piece of this.pieces) {
      const pieceEnd = pieceStart + piece.length;
      if (pieceEnd <= lo) {
        pieceStart = pieceEnd;
        continue;
      }
      if (pieceStart >= hi) {
        break;
      }
      const buffer = piece.buffer === 0 ? this.original : this.add;
      const from = Math.max(lo, pieceStart) - pieceStart + piece.start;
      const to = Math.min(hi, pieceEnd) - pieceStart + piece.start;
      parts.push(buffer.slice(from, to));
      pieceStart = pieceEnd;
    }
    return parts.join("");
  }

  /** 返回第 n 行文本（0 起始），不含行尾换行符；\r\n 行尾的 '\r' 一并去除。 */
  getLine(n: number): string {
    const range = this.getLineRange(n);
    return this.getTextInRange(range.start, range.end);
  }

  /** 返回第 n 行内容的偏移范围 [start, end)，不含换行符与 \r\n 中的 '\r'。 */
  getLineRange(n: number): { start: number; end: number } {
    if (n < 0 || n >= this.lineCount) {
      throw new RangeError(`line ${n} out of range (lineCount=${this.lineCount})`);
    }
    const start = n === 0 ? 0 : this.offsetAfterFeed(n - 1);
    const feedOffset = n < this.totalFeeds ? this.offsetOfFeed(n) : -1;
    let end = feedOffset >= 0 ? feedOffset : this.totalLength;
    if (end > start && this.charCodeAt(end - 1) === CR) {
      end -= 1;
    }
    return { start, end };
  }

  insert(offset: number, text: string): void {
    if (text.length === 0) {
      return;
    }
    const at = Math.max(0, Math.min(offset, this.totalLength));
    this.insertCore(at, text);
    this.changeEmitter.fire({ offset: at, removedLength: 0, insertedLength: text.length, insertedText: text });
  }

  delete(offset: number, length: number): void {
    if (length <= 0) {
      return;
    }
    const at = Math.max(0, Math.min(offset, this.totalLength));
    const end = Math.max(at, Math.min(at + length, this.totalLength));
    const removed = end - at;
    if (removed === 0) {
      return;
    }
    this.deleteCore(at, removed);
    this.changeEmitter.fire({ offset: at, removedLength: removed, insertedLength: 0, insertedText: "" });
  }

  replace(offset: number, length: number, text: string): void {
    const at = Math.max(0, Math.min(offset, this.totalLength));
    const end = Math.max(at, Math.min(at + length, this.totalLength));
    const removed = end - at;
    if (removed === 0 && text.length === 0) {
      return;
    }
    if (removed > 0) {
      this.deleteCore(at, removed);
    }
    if (text.length > 0) {
      this.insertCore(at, text);
    }
    this.changeEmitter.fire({ offset: at, removedLength: removed, insertedLength: text.length, insertedText: text });
  }

  positionAt(offset: number): Position {
    const at = Math.max(0, Math.min(offset, this.totalLength));
    let pieceStart = 0;
    let feedsBefore = 0;
    for (const piece of this.pieces) {
      const pieceEnd = pieceStart + piece.length;
      if (at < pieceEnd || (at === this.totalLength && pieceEnd === this.totalLength)) {
        const inner = at - pieceStart;
        const localFeeds = countNotGreater(piece.lineStarts, inner);
        const line = feedsBefore + localFeeds;
        const lineStartOffset = line === 0 ? 0 : this.offsetAfterFeed(line - 1);
        return { line, character: at - lineStartOffset };
      }
      feedsBefore += piece.lineStarts.length;
      pieceStart = pieceEnd;
    }
    return { line: 0, character: 0 };
  }

  offsetAt(position: Position): number {
    const line = Math.max(0, Math.min(position.line, this.lineCount - 1));
    const range = this.getLineRange(line);
    const character = Math.max(0, position.character);
    return Math.min(range.start + character, range.end);
  }

  // --------------------------------------------------------------------------
  // 内部实现
  // --------------------------------------------------------------------------

  private bufferText(piece: Piece): string {
    return piece.buffer === 0 ? this.original : this.add;
  }

  private charCodeAt(offset: number): number {
    let pieceStart = 0;
    for (const piece of this.pieces) {
      const pieceEnd = pieceStart + piece.length;
      if (offset < pieceEnd) {
        return this.bufferText(piece).charCodeAt(piece.start + (offset - pieceStart));
      }
      pieceStart = pieceEnd;
    }
    return -1;
  }

  /** 全局第 feedIndex 个换行符（0 起始）所在偏移。 */
  private offsetOfFeed(feedIndex: number): number {
    let feedsBefore = 0;
    let pieceStart = 0;
    for (const piece of this.pieces) {
      const local = feedIndex - feedsBefore;
      if (local >= 0 && local < piece.lineStarts.length) {
        const entry = piece.lineStarts[local];
        if (entry !== undefined) {
          return pieceStart + entry - 1;
        }
      }
      feedsBefore += piece.lineStarts.length;
      pieceStart = pieceEnd(pieceStart, piece);
    }
    return this.totalLength;
  }

  /** 全局第 feedIndex 个换行符之后一个字符的偏移（即下一行行首）。 */
  private offsetAfterFeed(feedIndex: number): number {
    let feedsBefore = 0;
    let pieceStart = 0;
    for (const piece of this.pieces) {
      const local = feedIndex - feedsBefore;
      if (local >= 0 && local < piece.lineStarts.length) {
        const entry = piece.lineStarts[local];
        if (entry !== undefined) {
          return pieceStart + entry;
        }
      }
      feedsBefore += piece.lineStarts.length;
      pieceStart = pieceEnd(pieceStart, piece);
    }
    return this.totalLength;
  }

  /** 定位 offset 所在 piece。offset === totalLength 时返回尾部哨兵（index = pieces.length）。 */
  private locate(offset: number): { index: number; inner: number } {
    let pieceStart = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i];
      if (piece === undefined) {
        break;
      }
      if (offset < pieceStart + piece.length) {
        return { index: i, inner: offset - pieceStart };
      }
      pieceStart += piece.length;
    }
    return { index: this.pieces.length, inner: 0 };
  }

  /** 把 pieces[index] 在 inner 处切成左右两片（要求 0 < inner < length）。 */
  private splitPiece(index: number, inner: number): void {
    const piece = this.pieces[index];
    if (piece === undefined) {
      return;
    }
    const left: Piece = {
      buffer: piece.buffer,
      start: piece.start,
      length: inner,
      // 换行符位于 [0, inner) 内 ⟺ entry <= inner
      lineStarts: piece.lineStarts.filter((entry) => entry <= inner),
    };
    const right: Piece = {
      buffer: piece.buffer,
      start: piece.start + inner,
      length: piece.length - inner,
      // 换行符位于 [inner, length) 内 ⟺ entry > inner
      lineStarts: piece.lineStarts.filter((entry) => entry > inner).map((entry) => entry - inner),
    };
    this.pieces.splice(index, 1, left, right);
  }

  private insertCore(offset: number, text: string): void {
    const addStart = this.add.length;
    this.add += text;
    const newStarts = computeLineStarts(this.add, addStart, addStart + text.length);

    // 优化：插入点紧邻 add 缓冲区尾部 piece 的末尾时原地扩展（连续输入不产生新 piece）。
    const last = this.pieces[this.pieces.length - 1];
    if (offset === this.totalLength && last !== undefined && last.buffer === 1 && last.start + last.length === addStart) {
      const shift = last.length;
      last.length += text.length;
      for (const entry of newStarts) {
        last.lineStarts.push(entry + shift);
      }
      this.totalLength += text.length;
      this.totalFeeds += newStarts.length;
      return;
    }

    const loc = this.locate(offset);
    if (loc.inner === 0 && loc.index > 0) {
      // 边界插入：若前一片正好是 add 尾部，同样原地扩展。
      const prev = this.pieces[loc.index - 1];
      if (prev !== undefined && prev.buffer === 1 && prev.start + prev.length === addStart) {
        const shift = prev.length;
        prev.length += text.length;
        for (const entry of newStarts) {
          prev.lineStarts.push(entry + shift);
        }
        this.totalLength += text.length;
        this.totalFeeds += newStarts.length;
        return;
      }
      this.pieces.splice(loc.index, 0, { buffer: 1, start: addStart, length: text.length, lineStarts: newStarts });
    } else if (loc.inner === 0) {
      this.pieces.splice(loc.index, 0, { buffer: 1, start: addStart, length: text.length, lineStarts: newStarts });
    } else {
      this.splitPiece(loc.index, loc.inner);
      this.pieces.splice(loc.index + 1, 0, { buffer: 1, start: addStart, length: text.length, lineStarts: newStarts });
    }
    this.totalLength += text.length;
    this.totalFeeds += newStarts.length;
  }

  private deleteCore(offset: number, removed: number): void {
    const end = offset + removed;
    const startLoc = this.locate(offset);
    const endLoc = end === this.totalLength ? { index: this.pieces.length, inner: 0 } : this.locate(end);

    const before = this.pieces.slice(0, startLoc.index);
    const after = this.pieces.slice(endLoc.inner > 0 ? endLoc.index + 1 : endLoc.index);

    const next: Piece[] = [...before];
    if (startLoc.inner > 0) {
      const piece = this.pieces[startLoc.index];
      if (piece !== undefined) {
        next.push({
          buffer: piece.buffer,
          start: piece.start,
          length: startLoc.inner,
          lineStarts: piece.lineStarts.filter((entry) => entry <= startLoc.inner),
        });
      }
    }
    if (endLoc.inner > 0) {
      const piece = this.pieces[endLoc.index];
      if (piece !== undefined) {
        next.push({
          buffer: piece.buffer,
          start: piece.start + endLoc.inner,
          length: piece.length - endLoc.inner,
          lineStarts: piece.lineStarts.filter((entry) => entry > endLoc.inner).map((entry) => entry - endLoc.inner),
        });
      }
    }
    for (const piece of after) {
      next.push(piece);
    }

    this.pieces = next;
    this.recomputeTotals();
  }

  private recomputeTotals(): void {
    let length = 0;
    let feeds = 0;
    for (const piece of this.pieces) {
      length += piece.length;
      feeds += piece.lineStarts.length;
    }
    this.totalLength = length;
    this.totalFeeds = feeds;
  }
}

function pieceEnd(start: number, piece: Piece): number {
  return start + piece.length;
}
