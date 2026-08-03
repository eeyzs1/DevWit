import type { Position } from "@devwit/editor-core";

/**
 * 编辑器布局纯逻辑（不依赖 DOM，可在 node 下直接测试）。
 * 所有宽度由调用方注入的 measurer 提供，等宽场景为 charWidth * text.length。
 */

/** 文本宽度测量函数：输入一段文本，返回像素宽度。 */
export type Measurer = (text: string) => number;

/** 光标选区：anchor 为起点，active 为可动端（光标所在端）。 */
export interface Selection {
  anchor: Position;
  active: Position;
}

export function comparePositions(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

export function isSelectionEmpty(sel: Selection): boolean {
  return comparePositions(sel.anchor, sel.active) === 0;
}

/** 归一化为 {start <= end}；reversed 表示 active 在 anchor 之前（反向拖选）。 */
export function normalizeSelection(sel: Selection): {
  start: Position;
  end: Position;
  reversed: boolean;
} {
  if (comparePositions(sel.anchor, sel.active) <= 0) {
    return { start: sel.anchor, end: sel.active, reversed: false };
  }
  return { start: sel.active, end: sel.anchor, reversed: true };
}

/** 可视行范围（含两端）：scrollTop/视口高/行高 → [first, last]，空文档返回 {first:0,last:-1}。 */
export function visibleLineRange(
  scrollTop: number,
  viewportHeight: number,
  lineHeight: number,
  lineCount: number
): { first: number; last: number } {
  if (lineCount <= 0 || viewportHeight <= 0 || lineHeight <= 0) {
    return { first: 0, last: -1 };
  }
  const top = Math.max(0, scrollTop);
  const first = Math.min(lineCount - 1, Math.floor(top / lineHeight));
  const last = Math.min(lineCount - 1, Math.ceil((top + viewportHeight) / lineHeight) - 1);
  return { first, last };
}

/** 垂直滚动上限。 */
export function maxScrollTop(lineCount: number, lineHeight: number, viewportHeight: number): number {
  return Math.max(0, lineCount * lineHeight - viewportHeight);
}

export function clampScrollTop(scrollTop: number, lineCount: number, lineHeight: number, viewportHeight: number): number {
  return Math.max(0, Math.min(scrollTop, maxScrollTop(lineCount, lineHeight, viewportHeight)));
}

/** 列 → 像素 x：行文本前 column 个字符的宽度。column 收敛到 [0, lineText.length]。 */
export function xForColumn(lineText: string, column: number, measure: Measurer): number {
  const col = Math.max(0, Math.min(Math.floor(column), lineText.length));
  if (col === 0) {
    return 0;
  }
  return measure(lineText.slice(0, col));
}

/**
 * 像素 x → 列：取中点判定（x 超过第 col 列中点则落在 col）。
 * x <= 0 返回 0；超过行尾返回行宽列数。
 */
export function columnForX(lineText: string, x: number, measure: Measurer): number {
  if (x <= 0 || lineText.length === 0) {
    return 0;
  }
  let prevWidth = 0;
  for (let col = 1; col <= lineText.length; col++) {
    const width = measure(lineText.slice(0, col));
    if (x < (prevWidth + width) / 2) {
      return col - 1;
    }
    prevWidth = width;
  }
  return lineText.length;
}

/**
 * 行的缩进级别：前导空白按 tabSize 折算成列宽，再整除 tabSize 得级别数。
 * 空行/无缩进返回 0；tab 按下一档对齐（cols += tabSize - cols%tabSize）。
 * 用于缩进指南线绘制——纯函数，node 下可直接测试。
 */
export function indentLevelOf(line: string, tabSize: number): number {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " ") cols += 1;
    else if (ch === "\t") cols += tabSize - (cols % tabSize);
    else break;
  }
  return Math.floor(cols / tabSize);
}

const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);
const BRACKET_MATCH: Record<string, string> = {
  "(": ")", "[": "]", "{": "}",
  ")": "(", "]": "[", "}": "{",
};

/**
 * 括号对匹配：给定文档行访问器（避免大文档全量拷贝）与光标位置，
 * 找光标旁括号的配对端。检查顺序：光标左侧字符 → 右侧字符；
 * 开括号向后扫描，闭括号向前扫描，深度计数处理嵌套，跨行扫描。
 * 返回 { trigger（光标旁括号位置）, match（配对端位置）}；无配对返回 null。
 * 纯函数（注入 getLine/lineCount），node 下可直接测试。
 */
export function findMatchingBracket(
  getLine: (line: number) => string,
  lineCount: number,
  pos: { line: number; character: number },
): { trigger: { line: number; character: number }; match: { line: number; character: number } } | null {
  const lineText = pos.line >= 0 && pos.line < lineCount ? getLine(pos.line) : "";
  const tryLeft = pos.character > 0 ? (lineText[pos.character - 1] ?? "") : "";
  const tryRight = pos.character < lineText.length ? (lineText[pos.character] ?? "") : "";

  const scanFrom = (ch: string, charPos: number): { line: number; character: number } | null => {
    const partner = BRACKET_MATCH[ch];
    if (partner === undefined) return null;
    if (OPEN_BRACKETS.has(ch)) return scanForward(getLine, lineCount, pos.line, charPos, ch, partner);
    if (CLOSE_BRACKETS.has(ch)) return scanBackward(getLine, pos.line, charPos, ch, partner);
    return null;
  };

  const leftMatch = scanFrom(tryLeft, pos.character - 1);
  if (leftMatch !== null) {
    return { trigger: { line: pos.line, character: pos.character - 1 }, match: leftMatch };
  }
  const rightMatch = scanFrom(tryRight, pos.character);
  if (rightMatch !== null) {
    return { trigger: { line: pos.line, character: pos.character }, match: rightMatch };
  }
  return null;
}

function scanForward(
  getLine: (line: number) => string,
  lineCount: number,
  startLine: number,
  startChar: number,
  open: string,
  close: string,
): { line: number; character: number } | null {
  let depth = 1;
  for (let line = startLine; line < lineCount; line++) {
    const text = getLine(line);
    const begin = line === startLine ? startChar + 1 : 0;
    for (let c = begin; c < text.length; c++) {
      const ch = text[c];
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return { line, character: c };
      }
    }
  }
  return null;
}

function scanBackward(
  getLine: (line: number) => string,
  startLine: number,
  startChar: number,
  close: string,
  open: string,
): { line: number; character: number } | null {
  let depth = 1;
  for (let line = startLine; line >= 0; line--) {
    const text = getLine(line);
    const end = line === startLine ? startChar - 1 : text.length - 1;
    for (let c = end; c >= 0; c--) {
      const ch = text[c];
      if (ch === close) depth += 1;
      else if (ch === open) {
        depth -= 1;
        if (depth === 0) return { line, character: c };
      }
    }
  }
  return null;
}

/**
 * 自动配对计算：对每个选区构造 open+选区内容+close 文本与最终光标偏移。
 * 空选区 → 插入 open+close，光标在 open 后；非空选区 → 包围，光标在 close 前。
 * 多选区按升序累计更低选区增量（open+close 的净增），保证降序应用时偏移不失效。
 * 纯函数（注入 getTextInRange），node 下可直接测试。
 */
export function computeAutoPair(
  selections: ReadonlyArray<{ startOffset: number; endOffset: number }>,
  open: string,
  close: string,
  getTextInRange: (start: number, end: number) => string,
): Array<{ text: string; cursorOffset: number }> {
  const n = selections.length;
  const indexed = selections.map((sel, index) => ({ ...sel, index }));
  const asc = [...indexed].sort((a, b) => a.startOffset - b.startOffset);
  const shiftByIndex = new Array<number>(n).fill(0);
  let shift = 0;
  for (const sel of asc) {
    shiftByIndex[sel.index] = shift;
    shift += open.length + close.length;
  }
  return indexed.map((sel) => {
    const selectedLen = sel.endOffset - sel.startOffset;
    const selectedText = selectedLen > 0 ? getTextInRange(sel.startOffset, sel.endOffset) : "";
    return {
      text: open + selectedText + close,
      cursorOffset: sel.startOffset + open.length + selectedLen + (shiftByIndex[sel.index] ?? 0),
    };
  });
}

/**
 * 自动缩进：给定当前行文本与光标列位置，计算换行后应继承的缩进串。
 * - 继承当前行的前导空白（空格/tab 原样保留）
 * - 若光标前文本（去尾空白）以 `{` 结尾，追加一级缩进（tabSize 个空格）
 * cursorCharacter 收敛到 [0, lineText.length]；纯函数，node 下可直接测试。
 */
export function computeAutoIndent(lineText: string, cursorCharacter: number, tabSize: number): string {
  const col = Math.max(0, Math.min(Math.floor(cursorCharacter), lineText.length));
  const before = lineText.slice(0, col);
  const leadingMatch = /^[ \t]*/.exec(before);
  const leading = leadingMatch ? leadingMatch[0] : "";
  const trimmedEnd = before.replace(/[ \t]+$/, "");
  const extra = trimmedEnd.endsWith("{") ? " ".repeat(tabSize) : "";
  return leading + extra;
}
