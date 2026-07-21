import { describe, expect, it } from "vitest";
import { PieceTable, type PieceTableChange } from "../src/piece-table.js";

/** 参考模型：纯 string 操作，与 PieceTable 行为对比。 */
function refLines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function expectConsistent(table: PieceTable, ref: string): void {
  expect(table.getText()).toBe(ref);
  expect(table.length).toBe(ref.length);
  const lines = refLines(ref);
  expect(table.lineCount).toBe(lines.length);
  // 抽查行内容与坐标换算
  const probeLines = new Set<number>([0, lines.length - 1]);
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    probeLines.add(Math.floor((i / 8) * lines.length));
  }
  for (const lineNo of probeLines) {
    const expected = lines[lineNo];
    if (expected === undefined) {
      continue;
    }
    expect(table.getLine(lineNo)).toBe(expected);
    const range = table.getLineRange(lineNo);
    expect(ref.slice(range.start, range.end)).toBe(expected);
    expect(table.positionAt(range.start)).toEqual({ line: lineNo, character: 0 });
    expect(table.offsetAt({ line: lineNo, character: 0 })).toBe(range.start);
  }
  // 全量 positionAt/offsetAt 往返（抽样步长避免过慢）
  const step = Math.max(1, Math.floor(ref.length / 200));
  for (let offset = 0; offset <= ref.length; offset += step) {
    expect(table.offsetAt(table.positionAt(offset))).toBe(offset);
  }
}

describe("PieceTable 基础", () => {
  it("空文档", () => {
    const t = PieceTable.fromString("");
    expect(t.length).toBe(0);
    expect(t.lineCount).toBe(1);
    expect(t.getText()).toBe("");
    expect(t.getLine(0)).toBe("");
    expect(t.getLineRange(0)).toEqual({ start: 0, end: 0 });
    expect(t.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(t.offsetAt({ line: 0, character: 0 })).toBe(0);
  });

  it("单行与多行", () => {
    const t = PieceTable.fromString("hello\nworld\nfoo");
    expect(t.length).toBe(15);
    expect(t.lineCount).toBe(3);
    expect(t.getLine(0)).toBe("hello");
    expect(t.getLine(1)).toBe("world");
    expect(t.getLine(2)).toBe("foo");
    expect(t.getLineRange(1)).toEqual({ start: 6, end: 11 });
    expect(t.positionAt(8)).toEqual({ line: 1, character: 2 });
    expect(t.offsetAt({ line: 1, character: 2 })).toBe(8);
    expect(t.positionAt(15)).toEqual({ line: 2, character: 3 });
  });

  it("\\r\\n 行尾去 \\r", () => {
    const t = PieceTable.fromString("ab\r\ncd\r\n");
    expect(t.lineCount).toBe(3);
    expect(t.getLine(0)).toBe("ab");
    expect(t.getLine(1)).toBe("cd");
    expect(t.getLine(2)).toBe("");
    expect(t.getLineRange(0)).toEqual({ start: 0, end: 2 });
  });

  it("尾部换行产生空末行", () => {
    const t = PieceTable.fromString("a\n");
    expect(t.lineCount).toBe(2);
    expect(t.getLine(1)).toBe("");
    expect(t.positionAt(2)).toEqual({ line: 1, character: 0 });
  });

  it("越界行抛 RangeError，越界 offset/position 收敛", () => {
    const t = PieceTable.fromString("abc");
    expect(() => t.getLine(1)).toThrow(RangeError);
    expect(() => t.getLineRange(-1)).toThrow(RangeError);
    expect(t.positionAt(999)).toEqual({ line: 0, character: 3 });
    expect(t.offsetAt({ line: 99, character: 99 })).toBe(3);
    expect(t.offsetAt({ line: 0, character: 99 })).toBe(3);
  });
});

describe("PieceTable 编辑", () => {
  it("insert 首/中/尾", () => {
    const t = PieceTable.fromString("ac");
    t.insert(1, "b");
    expect(t.getText()).toBe("abc");
    t.insert(0, "X");
    expect(t.getText()).toBe("Xabc");
    t.insert(4, "Y");
    expect(t.getText()).toBe("XabcY");
    t.insert(99, "Z"); // 收敛到末尾
    expect(t.getText()).toBe("XabcYZ");
  });

  it("insert 空串为 no-op", () => {
    const t = PieceTable.fromString("abc");
    t.insert(1, "");
    expect(t.getText()).toBe("abc");
    expect(t.pieceCount).toBe(1);
  });

  it("delete 跨 piece 边界", () => {
    const t = PieceTable.fromString("hello world");
    t.insert(5, "!!!"); // hel lo!!!world → pieces: [hello][!!!][ world]
    expect(t.getText()).toBe("hello!!! world");
    t.delete(3, 6); // 删 "lo!!! " → 跨三个 piece
    expect(t.getText()).toBe("helworld");
    expect(t.lineCount).toBe(1);
  });

  it("delete 恰好覆盖整片与边界", () => {
    const t = PieceTable.fromString("aabbcc");
    t.delete(2, 2); // 删 bb
    expect(t.getText()).toBe("aacc");
    t.delete(0, 4);
    expect(t.getText()).toBe("");
    expect(t.lineCount).toBe(1);
    expect(t.pieceCount).toBe(0);
    // 空文档上 delete no-op
    t.delete(0, 5);
    expect(t.getText()).toBe("");
  });

  it("replace 合并为单事件", () => {
    const t = PieceTable.fromString("one two three");
    const events: PieceTableChange[] = [];
    t.onDidChange((c) => events.push(c));
    t.replace(4, 3, "2");
    expect(t.getText()).toBe("one 2 three");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ offset: 4, removedLength: 3, insertedLength: 1, insertedText: "2" });
  });

  it("编辑后行索引正确（跨 piece 换行）", () => {
    const t = PieceTable.fromString("ab\ncd");
    t.insert(2, "\nXY"); // "ab\nXY\ncd"，换行位于 add 片内
    expectConsistent(t, "ab\nXY\ncd");
    t.delete(1, 3); // "aY\ncd"
    expectConsistent(t, "aY\ncd");
  });

  it("连续输入合并 piece（piece 数有界）", () => {
    const t = PieceTable.fromString("");
    for (let i = 0; i < 500; i++) {
      t.insert(t.length, "x");
    }
    expect(t.getText()).toBe("x".repeat(500));
    expect(t.pieceCount).toBe(1);
  });

  it("onDidChange 可解绑", () => {
    const t = PieceTable.fromString("a");
    let count = 0;
    const off = t.onDidChange(() => {
      count += 1;
    });
    t.insert(1, "b");
    off();
    t.insert(2, "c");
    expect(count).toBe(1);
    expect(t.getText()).toBe("abc");
  });
});

describe("PieceTable 随机模糊对照", () => {
  it("随机 insert/delete/replace 与参考模型一致", () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = "ab \n";
    const randomText = (maxLen: number): string => {
      const len = 1 + Math.floor(rand() * maxLen);
      let s = "";
      for (let i = 0; i < len; i++) {
        s += alphabet.charAt(Math.floor(rand() * alphabet.length));
      }
      return s;
    };

    const table = PieceTable.fromString("start\nof\ndocument\n");
    let ref = "start\nof\ndocument\n";
    for (let i = 0; i < 400; i++) {
      const op = rand();
      const offset = Math.floor(rand() * (ref.length + 1));
      if (op < 0.45) {
        const text = randomText(12);
        table.insert(offset, text);
        ref = ref.slice(0, offset) + text + ref.slice(offset);
      } else if (op < 0.8) {
        const delLen = Math.min(ref.length - offset, Math.floor(rand() * 10));
        table.delete(offset, delLen);
        ref = ref.slice(0, offset) + ref.slice(offset + delLen);
      } else {
        const delLen = Math.min(ref.length - offset, Math.floor(rand() * 6));
        const text = randomText(6);
        table.replace(offset, delLen, text);
        ref = ref.slice(0, offset) + text + ref.slice(offset + delLen);
      }
      expect(table.getText()).toBe(ref);
    }
    expectConsistent(table, ref);
  });
});

describe("PieceTable 大文本冒烟", () => {
  it("100 万字符文档上 insert/delete 正确完成", () => {
    const line = "0123456789"; // 10 字符 + \n
    const text = (line + "\n").repeat(100_000); // 110 万字符 / 10 万行
    const t = PieceTable.fromString(text);
    expect(t.length).toBe(text.length);
    expect(t.lineCount).toBe(100_001);

    // 参考模型同步执行相同操作，最终全量比对
    let ref = text;
    const mid = Math.floor(t.length / 2);
    t.insert(mid, "INSERTED\n");
    ref = ref.slice(0, mid) + "INSERTED\n" + ref.slice(mid);
    expect(t.lineCount).toBe(100_002);

    t.delete(0, 11);
    ref = ref.slice(11);
    expect(t.lineCount).toBe(100_001);

    t.insert(t.length, "tail");
    ref += "tail";

    expect(t.getText()).toBe(ref);
    expect(t.getLine(50_000).length).toBeGreaterThan(0);
    const pos = t.positionAt(mid + 3);
    expect(t.offsetAt(pos)).toBe(mid + 3);
  });

  it("10MB 级单文件装载后大段替换正确", () => {
    const text = "x".repeat(10 * 1024 * 1024);
    const t = PieceTable.fromString(text);
    t.replace(1024, 2048, "y".repeat(4096));
    expect(t.length).toBe(10 * 1024 * 1024 - 2048 + 4096);
    expect(t.getTextInRange(1024, 1024 + 4096)).toBe("y".repeat(4096));
    expect(t.getTextInRange(0, 8)).toBe("xxxxxxxx");
  });
});
