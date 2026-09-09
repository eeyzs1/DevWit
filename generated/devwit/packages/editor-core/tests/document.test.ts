import { describe, expect, it } from "vitest";
import { TextDocument, type DocumentChangeEvent } from "../src/index.js";

function typeText(doc: TextDocument, text: string, startOffset?: number): void {
  let offset = startOffset ?? doc.length;
  for (const ch of text) {
    doc.insert(offset, ch);
    offset += ch.length;
  }
}

describe("TextDocument 基础", () => {
  it("applyEdit / getText / getLine / lineCount", () => {
    const doc = TextDocument.fromString("line1\nline2");
    expect(doc.getText()).toBe("line1\nline2");
    expect(doc.lineCount).toBe(2);
    expect(doc.getLine(1)).toBe("line2");
    doc.applyEdit({ offset: 5, length: 0, text: "X" });
    expect(doc.getText()).toBe("line1X\nline2");
    doc.applyEdit({ offset: 0, length: 5, text: "L" });
    expect(doc.getText()).toBe("LX\nline2");
  });

  it("version 随编辑递增，isDirty/markSaved 正确", () => {
    const doc = TextDocument.fromString("a");
    expect(doc.version).toBe(0);
    expect(doc.isDirty).toBe(false);
    doc.insert(1, "b");
    expect(doc.version).toBe(1);
    expect(doc.isDirty).toBe(true);
    doc.markSaved();
    expect(doc.isDirty).toBe(false);
    doc.undo();
    expect(doc.isDirty).toBe(true); // undo 后离开已保存版本
  });

  it("onDidChange 携带 changes 与 version", () => {
    const doc = TextDocument.fromString("abc");
    const events: DocumentChangeEvent[] = [];
    const off = doc.onDidChange((e) => events.push(e));
    doc.applyEdit({ offset: 1, length: 1, text: "ZZ" });
    expect(events).toHaveLength(1);
    expect(events[0]?.version).toBe(1);
    expect(events[0]?.changes).toEqual([
      { offset: 1, removedLength: 1, insertedLength: 2, insertedText: "ZZ" },
    ]);
    off();
    doc.insert(0, "q");
    expect(events).toHaveLength(1);
  });
});

describe("TextDocument undo/redo", () => {
  it("单步编辑 undo/redo", () => {
    const doc = TextDocument.fromString("hello");
    doc.applyEdit({ offset: 0, length: 5, text: "world" });
    expect(doc.getText()).toBe("world");
    expect(doc.undo()).toBe(true);
    expect(doc.getText()).toBe("hello");
    expect(doc.redo()).toBe(true);
    expect(doc.getText()).toBe("world");
  });

  it("空栈 undo/redo 返回 false", () => {
    const doc = TextDocument.fromString("a");
    expect(doc.undo()).toBe(false);
    expect(doc.redo()).toBe(false);
    expect(doc.getText()).toBe("a");
    expect(doc.version).toBe(0);
  });

  it("连续输入合并为一次 undo（typing coalescing）", () => {
    const doc = TextDocument.fromString("");
    typeText(doc, "hello");
    expect(doc.getText()).toBe("hello");
    expect(doc.canUndo).toBe(true);
    doc.undo(); // 一次撤销整个 hello
    expect(doc.getText()).toBe("");
    doc.redo();
    expect(doc.getText()).toBe("hello");
  });

  it("空白字符打断输入合并", () => {
    const doc = TextDocument.fromString("");
    typeText(doc, "foo bar");
    // 合并边界："foo"、" "、"bar" 三条记录
    doc.undo(); // 撤 "bar"
    expect(doc.getText()).toBe("foo ");
    doc.undo(); // 撤 " "
    expect(doc.getText()).toBe("foo");
    doc.undo(); // 撤 "foo"
    expect(doc.getText()).toBe("");
    expect(doc.undo()).toBe(false);
  });

  it("换行打断输入合并", () => {
    const doc = TextDocument.fromString("");
    typeText(doc, "ab");
    doc.insert(doc.length, "\n");
    typeText(doc, "cd");
    doc.undo(); // 撤 "cd"
    expect(doc.getText()).toBe("ab\n");
    doc.undo(); // 撤 "\n"
    expect(doc.getText()).toBe("ab");
    doc.undo(); // 撤 "ab"
    expect(doc.getText()).toBe("");
  });

  it("连续退格合并为一次 undo", () => {
    const doc = TextDocument.fromString("abcdef");
    doc.delete(5, 1); // 删 f
    doc.delete(4, 1); // 删 e
    doc.delete(3, 1); // 删 d
    expect(doc.getText()).toBe("abc");
    doc.undo(); // 一次恢复 def
    expect(doc.getText()).toBe("abcdef");
  });

  it("新编辑清空 redo 栈", () => {
    const doc = TextDocument.fromString("a");
    doc.insert(1, "b");
    doc.undo();
    expect(doc.canRedo).toBe(true);
    doc.insert(1, "c");
    expect(doc.canRedo).toBe(false);
    expect(doc.getText()).toBe("ac");
  });

  it("跨 piece 的 replace 可撤销", () => {
    const doc = TextDocument.fromString("one two three");
    doc.insert(7, " TWO");
    expect(doc.getText()).toBe("one two TWO three");
    doc.applyEdit({ offset: 4, length: 8, text: "2" }); // 删 "two TWO " 跨 3 片
    expect(doc.getText()).toBe("one 2three");
    doc.undo();
    expect(doc.getText()).toBe("one two TWO three");
    doc.undo();
    expect(doc.getText()).toBe("one two three");
  });

  it("undo/redo 往返后坐标与行索引仍正确", () => {
    const doc = TextDocument.fromString("a\nb\nc");
    doc.insert(2, "X\n");
    expect(doc.getText()).toBe("a\nX\nb\nc");
    doc.undo();
    expect(doc.lineCount).toBe(3);
    expect(doc.getLine(1)).toBe("b");
    expect(doc.offsetAt(doc.positionAt(4))).toBe(4);
    doc.redo();
    expect(doc.lineCount).toBe(4);
    expect(doc.getLine(1)).toBe("X");
  });
});

describe("事务 undo（v0.7.2：一次逻辑操作 = 一条 undo）", () => {
  it("事务内多次编辑合并为一条 undo，undo 一次整体回滚", () => {
    const doc = TextDocument.fromString("");
    doc.transact(() => {
      doc.insert(0, "aaa"); // 光标 A
      doc.insert(0, "bbb"); // 光标 B（更低偏移）
      doc.insert(0, "ccc"); // 光标 C
    });
    expect(doc.getText()).toBe("cccbbbaaa");
    expect(doc.undo()).toBe(true);
    expect(doc.getText()).toBe("");
  });

  it("百行缩进场景：事务内 100 次编辑 = 1 条 undo；redo 恢复全部", () => {
    const doc = TextDocument.fromString(Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n"));
    doc.transact(() => {
      for (let line = 99; line >= 0; line--) {
        const lineStart = doc.offsetAt({ line, character: 0 });
        doc.insert(lineStart, "  ");
      }
    });
    expect(doc.getLine(0)).toBe("  line0");
    expect(doc.getLine(99)).toBe("  line99");
    doc.undo();
    expect(doc.getLine(0)).toBe("line0");
    expect(doc.getLine(99)).toBe("line99");
    doc.redo();
    expect(doc.getLine(42)).toBe("  line42");
  });

  it("多光标连续打字：同结构组逐位合并（3 次击键 × 3 光标 = 1 条 undo）", () => {
    const doc = TextDocument.fromString("a\nb\nc");
    let cursors = [1, 3, 5]; // 各行行尾（降序应用：先 C 后 B 后 A，偏移互不影响）
    for (const ch of "xyz") {
      const [a, b, c] = cursors;
      doc.transact(() => {
        doc.insert(c!, ch); // 光标 C：c 行尾
        doc.insert(b!, ch); // 光标 B：b 行尾
        doc.insert(a!, ch); // 光标 A：a 行尾
      });
      // 每光标新位置 = 原位置 + 自身插入 1 + 前方光标插入数（降序应用后统一 +i+1）
      cursors = cursors.map((offset, i) => offset + i + 1);
    }
    expect(doc.getText()).toBe("axyz\nbxyz\ncxyz");
    doc.undo();
    expect(doc.getText()).toBe("a\nb\nc");
  });

  it("事务组与后续普通编辑互不渗透：undo 顺序正确", () => {
    const doc = TextDocument.fromString("base");
    doc.transact(() => {
      doc.insert(0, "[");
      doc.insert(doc.length, "]");
    });
    typeText(doc, "tail");
    expect(doc.getText()).toBe("[base]tail");
    doc.undo(); // 撤 tail（普通合并条目）
    expect(doc.getText()).toBe("[base]");
    doc.undo(); // 撤整个事务组
    expect(doc.getText()).toBe("base");
    expect(doc.undo()).toBe(false);
  });

  it("事务内回调抛错也正确收口（已应用编辑成为一条 undo，不悬空）", () => {
    const doc = TextDocument.fromString("x");
    expect(() =>
      doc.transact(() => {
        doc.insert(0, "a");
        doc.insert(0, "b");
        throw new Error("boom");
      })
    ).toThrow(/boom/);
    expect(doc.getText()).toBe("bax");
    doc.undo();
    expect(doc.getText()).toBe("x");
  });

  it("空事务不入栈；嵌套事务合并入最外层", () => {
    const doc = TextDocument.fromString("");
    doc.transact(() => {});
    expect(doc.canUndo).toBe(false);
    doc.beginTransaction();
    doc.insert(0, "1");
    doc.beginTransaction();
    doc.insert(1, "2");
    doc.endTransaction(); // 内层收口：不真正入栈
    doc.endTransaction(); // 外层收口：一条 undo
    expect(doc.getText()).toBe("12");
    doc.undo();
    expect(doc.getText()).toBe("");
  });

  it("事务内 change 事件仍逐编辑派发（增量语法解析依赖细粒度变更）", () => {
    const doc = TextDocument.fromString("");
    const events: DocumentChangeEvent[] = [];
    const off = doc.onDidChange((e) => events.push(e));
    doc.transact(() => {
      doc.insert(0, "a");
      doc.insert(1, "b");
    });
    off();
    expect(events).toHaveLength(2);
    expect(events[0]?.changes[0]?.insertedText).toBe("a");
    expect(events[1]?.changes[0]?.insertedText).toBe("b");
  });

  it("单光标打字经事务包装后合并语义不变（pushGroup 单操作退化）", () => {
    const doc = TextDocument.fromString("");
    for (const ch of "hello") {
      doc.transact(() => {
        doc.insert(doc.length, ch);
      });
    }
    doc.undo(); // 一次撤整个 hello——与无事务打字一致
    expect(doc.getText()).toBe("");
  });
});
