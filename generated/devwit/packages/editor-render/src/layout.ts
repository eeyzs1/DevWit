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
