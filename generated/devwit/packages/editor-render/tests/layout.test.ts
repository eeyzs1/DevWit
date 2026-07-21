import { describe, expect, it } from "vitest";
import {
  clampScrollTop,
  columnForX,
  comparePositions,
  isSelectionEmpty,
  maxScrollTop,
  normalizeSelection,
  visibleLineRange,
  xForColumn,
  type Measurer,
} from "../src/index.js";

/** 固定字宽测量器：每字符 10px。 */
const measure: Measurer = (text) => text.length * 10;

describe("visibleLineRange 可视行虚拟化", () => {
  it("首屏：scrollTop=0 时从第 0 行开始，覆盖视口高度", () => {
    expect(visibleLineRange(0, 200, 20, 100)).toEqual({ first: 0, last: 9 });
  });

  it("滚动到非整行偏移：首尾均包含部分可见行", () => {
    // top=205 → 第 10 行部分可见；bottom=405 → ceil(405/20)-1=20
    expect(visibleLineRange(205, 200, 20, 100)).toEqual({ first: 10, last: 20 });
  });

  it("空文档 / 零视口 / 零行高：返回空范围", () => {
    expect(visibleLineRange(0, 200, 20, 0)).toEqual({ first: 0, last: -1 });
    expect(visibleLineRange(0, 0, 20, 100)).toEqual({ first: 0, last: -1 });
    expect(visibleLineRange(0, 200, 0, 100)).toEqual({ first: 0, last: -1 });
  });

  it("过滚动（scrollTop 超出文档底部）：收敛到末行", () => {
    expect(visibleLineRange(100000, 200, 20, 100)).toEqual({ first: 99, last: 99 });
  });

  it("万行文档：只取视口附近行，与总行数无关", () => {
    const range = visibleLineRange(5000 * 20, 400, 20, 20000);
    expect(range).toEqual({ first: 5000, last: 5019 });
    expect(range.last - range.first).toBeLessThan(30);
  });
});

describe("滚动边界", () => {
  it("maxScrollTop：内容超出视口时为 总行高-视口高，否则为 0", () => {
    expect(maxScrollTop(100, 20, 200)).toBe(1800);
    expect(maxScrollTop(5, 20, 200)).toBe(0);
  });

  it("clampScrollTop：负值收敛 0，超过上限收敛上限", () => {
    expect(clampScrollTop(-50, 100, 20, 200)).toBe(0);
    expect(clampScrollTop(99999, 100, 20, 200)).toBe(1800);
    expect(clampScrollTop(300, 100, 20, 200)).toBe(300);
  });
});

describe("xForColumn 列→像素", () => {
  it("column=0 → x=0；中间列按字宽累计", () => {
    expect(xForColumn("hello", 0, measure)).toBe(0);
    expect(xForColumn("hello", 3, measure)).toBe(30);
    expect(xForColumn("hello", 5, measure)).toBe(50);
  });

  it("column 收敛到 [0, lineText.length]", () => {
    expect(xForColumn("hello", 99, measure)).toBe(50);
    expect(xForColumn("hello", -3, measure)).toBe(0);
  });

  it("空行恒为 0", () => {
    expect(xForColumn("", 4, measure)).toBe(0);
  });
});

describe("columnForX 像素→列（中点判定）", () => {
  it("x<=0 或空行 → 0 列", () => {
    expect(columnForX("hello", 0, measure)).toBe(0);
    expect(columnForX("hello", -10, measure)).toBe(0);
    expect(columnForX("", 30, measure)).toBe(0);
  });

  it("x 未达字符中点落前一列，超过中点落后一列", () => {
    // 字宽 10：第 0 列字符覆盖 [0,10)，中点 5
    expect(columnForX("hello", 4, measure)).toBe(0);
    expect(columnForX("hello", 5, measure)).toBe(1);
    expect(columnForX("hello", 44, measure)).toBe(4);
    expect(columnForX("hello", 45, measure)).toBe(5);
  });

  it("x 超过行尾 → 行尾列", () => {
    expect(columnForX("hello", 50, measure)).toBe(5);
    expect(columnForX("hello", 9999, measure)).toBe(5);
  });
});

describe("选区工具", () => {
  it("comparePositions：先比行再比列", () => {
    expect(comparePositions({ line: 1, character: 0 }, { line: 2, character: 0 })).toBeLessThan(0);
    expect(comparePositions({ line: 2, character: 5 }, { line: 2, character: 3 })).toBeGreaterThan(0);
    expect(comparePositions({ line: 2, character: 3 }, { line: 2, character: 3 })).toBe(0);
  });

  it("isSelectionEmpty：anchor 与 active 相同为空选区", () => {
    expect(
      isSelectionEmpty({ anchor: { line: 1, character: 2 }, active: { line: 1, character: 2 } })
    ).toBe(true);
    expect(
      isSelectionEmpty({ anchor: { line: 1, character: 2 }, active: { line: 1, character: 3 } })
    ).toBe(false);
  });

  it("normalizeSelection：正向选区保持方向标记 reversed=false", () => {
    const norm = normalizeSelection({
      anchor: { line: 0, character: 1 },
      active: { line: 2, character: 3 },
    });
    expect(norm).toEqual({
      start: { line: 0, character: 1 },
      end: { line: 2, character: 3 },
      reversed: false,
    });
  });

  it("normalizeSelection：反向拖选交换起止并标记 reversed=true", () => {
    const norm = normalizeSelection({
      anchor: { line: 2, character: 3 },
      active: { line: 0, character: 1 },
    });
    expect(norm).toEqual({
      start: { line: 0, character: 1 },
      end: { line: 2, character: 3 },
      reversed: true,
    });
  });
});
