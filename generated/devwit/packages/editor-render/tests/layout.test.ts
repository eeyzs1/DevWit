import { describe, expect, it } from "vitest";
import {
  clampScrollTop,
  columnForX,
  comparePositions,
  computeAutoIndent,
  computeAutoPair,
  computeFoldRegions,
  findMatchingBracket,
  indentLevelOf,
  isSelectionEmpty,
  maxScrollTop,
  minimapLayout,
  normalizeSelection,
  outdentLine,
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

describe("indentLevelOf 缩进级别", () => {
  it("无缩进 / 空行 → 0", () => {
    expect(indentLevelOf("const x = 1;", 4)).toBe(0);
    expect(indentLevelOf("", 4)).toBe(0);
    expect(indentLevelOf("noIndent", 4)).toBe(0);
  });

  it("空格缩进：每 tabSize 个空格一级，不足一级向下取整", () => {
    expect(indentLevelOf("    const x = 1;", 4)).toBe(1);
    expect(indentLevelOf("        const x = 1;", 4)).toBe(2);
    expect(indentLevelOf("  const x = 1;", 4)).toBe(0); // 2 空格不足一级
    expect(indentLevelOf("      const x = 1;", 4)).toBe(1); // 6 空格 = 1 级
  });

  it("tab 缩进：每个 tab 一级", () => {
    expect(indentLevelOf("\tconst x = 1;", 4)).toBe(1);
    expect(indentLevelOf("\t\tconst x = 1;", 4)).toBe(2);
  });

  it("tab + 空格混合按列对齐折算", () => {
    // tab 在 cols=0 → 跳到 4；再 4 空格 → cols=8 → 2 级
    expect(indentLevelOf("\t    const x = 1;", 4)).toBe(2);
    // 2 空格 + tab：cols=2, tab → 跳到 4（对齐下一档）→ 1 级
    expect(indentLevelOf("  \tconst x = 1;", 4)).toBe(1);
  });

  it("tabSize=2 时 2 空格为一级", () => {
    expect(indentLevelOf("  const x = 1;", 2)).toBe(1);
    expect(indentLevelOf("    const x = 1;", 2)).toBe(2);
  });
});

describe("findMatchingBracket 括号对匹配", () => {
  /** 从字符串数组构造文档访问器。 */
  const doc = (lines: string[]) => ({
    getLine: (i: number) => lines[i] ?? "",
    lineCount: lines.length,
  });

  it("光标在开括号右侧 → 向后匹配同行闭括号", () => {
    // "f(a, b)" — ( 在 1，) 在 6；光标 character=2（( 之后）
    const d = doc(["f(a, b)"]);
    const r = findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 2 });
    expect(r).toEqual({ trigger: { line: 0, character: 1 }, match: { line: 0, character: 6 } });
  });

  it("光标在闭括号左侧 → 向前匹配同行开括号", () => {
    // 光标 character=6（) 之前，b 之后）；左侧 'b' 非括号，右侧 ')' 触发
    const d = doc(["f(a, b)"]);
    const r = findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 6 });
    expect(r).toEqual({ trigger: { line: 0, character: 6 }, match: { line: 0, character: 1 } });
  });

  it("跨行匹配：开括号在上一行，闭括号在下一行", () => {
    // 行0 "function f() {" — { 在 13；行2 "}" — } 在 0
    const d = doc(["function f() {", "  return 1;", "}"]);
    const r = findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 14 });
    expect(r).toEqual({ trigger: { line: 0, character: 13 }, match: { line: 2, character: 0 } });
  });

  it("嵌套括号：深度计数正确，匹配最外层", () => {
    // "x = ((a))" — 外层 ( 在 4，内层 ( 在 5，) 在 7，) 在 8
    const d = doc(["x = ((a))"]);
    const r = findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 5 });
    expect(r).toEqual({ trigger: { line: 0, character: 4 }, match: { line: 0, character: 8 } });
  });

  it("三种括号 () [] {} 均能匹配", () => {
    // "a = [1, {b}]" — [ 在 4，] 在 11，{ 在 8，} 在 10
    const d = doc(["a = [1, {b}]"]);
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 5 })).toEqual({
      trigger: { line: 0, character: 4 },
      match: { line: 0, character: 11 },
    });
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 9 })).toEqual({
      trigger: { line: 0, character: 8 },
      match: { line: 0, character: 10 },
    });
  });

  it("光标不在括号旁 → null", () => {
    const d = doc(["const x = 123;"]);
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 5 })).toBeNull();
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 0 })).toBeNull();
  });

  it("未配对的开括号 → null", () => {
    // "f(a" — ( 在 1，无闭括号
    const d = doc(["f(a"]);
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 2 })).toBeNull();
  });

  it("优先匹配光标左侧字符（左侧闭括号优先于右侧开括号）", () => {
    // "()()" — 索引: (0 )1 (2 )3；光标 character=2（左侧 )，右侧 (）
    const d = doc(["()()"]);
    const r = findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 2 });
    expect(r).toEqual({ trigger: { line: 0, character: 1 }, match: { line: 0, character: 0 } });
  });

  it("行首/行尾边界（无括号旁）→ null", () => {
    const d = doc(["abc", "def"]);
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 0 })).toBeNull();
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 3 })).toBeNull();
  });

  it("光标位置越界安全收敛（不抛错）", () => {
    const d = doc(["ab"]);
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 5, character: 0 })).toBeNull();
    expect(findMatchingBracket(d.getLine, d.lineCount, { line: 0, character: 99 })).toBeNull();
  });
});

describe("computeAutoPair 自动配对计算", () => {
  it("单空选区：插入 open+close，光标在 open 后", () => {
    const r = computeAutoPair([{ startOffset: 0, endOffset: 0 }], "(", ")", () => "");
    expect(r).toEqual([{ text: "()", cursorOffset: 1 }]);
  });

  it("单非空选区：用 open+close 包围，光标在 close 前", () => {
    // 选区 [5,8) 含 "abc"；cursorOffset = 5 + 1(open) + 3(selected) = 9（close 前）
    const r = computeAutoPair([{ startOffset: 5, endOffset: 8 }], "(", ")", () => "abc");
    expect(r).toEqual([{ text: "(abc)", cursorOffset: 9 }]);
  });

  it("多空选区：各自配对，低选区增量累计到高选区光标", () => {
    const r = computeAutoPair(
      [{ startOffset: 0, endOffset: 0 }, { startOffset: 10, endOffset: 10 }],
      "(", ")",
      () => "",
    );
    expect(r[0]).toEqual({ text: "()", cursorOffset: 1 }); // 0+1+0+0
    expect(r[1]).toEqual({ text: "()", cursorOffset: 13 }); // 10+1+0+2（低选区增量）
  });

  it("多非空选区：各自包围，低选区增量累计", () => {
    // sel0 [0,3) "abc", sel1 [10,13) "xyz"
    const r = computeAutoPair(
      [{ startOffset: 0, endOffset: 3 }, { startOffset: 10, endOffset: 13 }],
      "[", "]",
      (s) => (s === 0 ? "abc" : "xyz"),
    );
    expect(r[0]).toEqual({ text: "[abc]", cursorOffset: 4 }); // 0+1+3+0
    expect(r[1]).toEqual({ text: "[xyz]", cursorOffset: 16 }); // 10+1+3+2
  });

  it("三种括号 () [] {} 均配对", () => {
    expect(computeAutoPair([{ startOffset: 0, endOffset: 0 }], "{", "}", () => "")[0]).toEqual({
      text: "{}",
      cursorOffset: 1,
    });
    expect(computeAutoPair([{ startOffset: 0, endOffset: 0 }], "[", "]", () => "")[0]).toEqual({
      text: "[]",
      cursorOffset: 1,
    });
  });

  it("空选区列表 → 空结果", () => {
    expect(computeAutoPair([], "(", ")", () => "")).toEqual([]);
  });

  it("多字符 open/close 按长度计算偏移", () => {
    // open="/*" close="*/"（块注释配对，验证长度泛化）
    const r = computeAutoPair([{ startOffset: 0, endOffset: 0 }], "/*", "*/", () => "");
    expect(r).toEqual([{ text: "/**/", cursorOffset: 2 }]); // 0+2+0+0
  });
});

describe("computeAutoIndent 自动缩进", () => {
  it("无缩进行 → 空串", () => {
    expect(computeAutoIndent("const x = 1;", 13, 4)).toBe("");
    expect(computeAutoIndent("noIndent", 8, 4)).toBe("");
  });

  it("空行 → 空串", () => {
    expect(computeAutoIndent("", 0, 4)).toBe("");
  });

  it("空格缩进 → 继承前导空格", () => {
    expect(computeAutoIndent("    const x = 1;", 17, 4)).toBe("    ");
    expect(computeAutoIndent("        const x = 1;", 21, 4)).toBe("        ");
  });

  it("tab 缩进 → 继承前导 tab（原样保留）", () => {
    expect(computeAutoIndent("\tconst x = 1;", 13, 4)).toBe("\t");
    expect(computeAutoIndent("\t\tconst x = 1;", 14, 4)).toBe("\t\t");
  });

  it("空格+tab 混合缩进 → 原样继承", () => {
    expect(computeAutoIndent("  \tconst x = 1;", 13, 4)).toBe("  \t");
  });

  it("行尾 { → 继承缩进 + 加一级（tabSize 个空格）", () => {
    // "    function f() {" 长度 18，光标在末尾
    expect(computeAutoIndent("    function f() {", 18, 4)).toBe("        ");
    expect(computeAutoIndent("function f() {", 14, 4)).toBe("    ");
  });

  it("tab 缩进行尾 { → tab + tabSize 空格（混合，符合实现在加级时用空格）", () => {
    expect(computeAutoIndent("\tfunction f() {", 15, 4)).toBe("\t    ");
  });

  it("光标在行中 { 之后 → 加一级；{ 之前 → 仅继承", () => {
    // "  if (x) { y }" — { 在 index 9
    // 光标 character=10（{ 之后）→ before="  if (x) {" 去尾空白仍以 { 结尾 → 加级
    // 光标 character=9（{ 之前）→ before="  if (x) " 去尾空白为 "  if (x)" → 仅继承
    expect(computeAutoIndent("  if (x) { y }", 10, 4)).toBe("      ");
    expect(computeAutoIndent("  if (x) { y }", 9, 4)).toBe("  ");
  });

  it("光标前文本不以 { 结尾 → 仅继承（不因行中有 { 而加级）", () => {
    // "  a { b" — 光标在末尾（character=7），before="  a { b" 不以 { 结尾
    expect(computeAutoIndent("  a { b", 7, 4)).toBe("  ");
  });

  it("行尾 { 后有尾随空白 → 去尾空白后仍检测到 { → 加级", () => {
    // "  f() {   " — 光标在末尾（character=9），before 去尾空白为 "  f() {" 结尾 {
    expect(computeAutoIndent("  f() {   ", 9, 4)).toBe("      ");
  });

  it("非 { 的括号结尾 → 不加级（仅 { 触发）", () => {
    expect(computeAutoIndent("  f(", 4, 4)).toBe("  ");
    expect(computeAutoIndent("  f[", 4, 4)).toBe("  ");
    expect(computeAutoIndent("  f(", 4, 2)).toBe("  ");
  });

  it("tabSize=2 时加一级为 2 空格", () => {
    expect(computeAutoIndent("  f() {", 7, 2)).toBe("    ");
    expect(computeAutoIndent("f() {", 5, 2)).toBe("  ");
  });

  it("cursorCharacter 收敛到 [0, lineText.length]", () => {
    // 负值 → 0，before="" → 空串
    expect(computeAutoIndent("    code", -5, 4)).toBe("");
    // 超出长度 → 取整行
    expect(computeAutoIndent("    code", 999, 4)).toBe("    ");
  });

  it("光标在前导空白中间 → 继承光标前的前导空白", () => {
    // "    code" — 光标在 character=2（前导空白中间）→ before="  " → leading="  "
    expect(computeAutoIndent("    code", 2, 4)).toBe("  ");
  });
});

describe("outdentLine 反缩进一行", () => {
  it("空格缩进：移除最多 tabSize 个前导空格", () => {
    expect(outdentLine("    code", 4)).toEqual({ text: "code", removed: 4 });
    expect(outdentLine("        code", 4)).toEqual({ text: "    code", removed: 4 });
    expect(outdentLine("  code", 4)).toEqual({ text: "code", removed: 2 }); // 不足 tabSize 全删
  });

  it("tab 缩进：移除一个 tab", () => {
    expect(outdentLine("\tcode", 4)).toEqual({ text: "code", removed: 1 });
    expect(outdentLine("\t\tcode", 4)).toEqual({ text: "\tcode", removed: 1 });
  });

  it("无前导空白 → removed=0，文本不变", () => {
    expect(outdentLine("code", 4)).toEqual({ text: "code", removed: 0 });
    expect(outdentLine("noIndent", 2)).toEqual({ text: "noIndent", removed: 0 });
  });

  it("空行 → removed=0", () => {
    expect(outdentLine("", 4)).toEqual({ text: "", removed: 0 });
  });

  it("tabSize=2 时移除最多 2 空格", () => {
    expect(outdentLine("  code", 2)).toEqual({ text: "code", removed: 2 });
    expect(outdentLine("    code", 2)).toEqual({ text: "  code", removed: 2 });
    expect(outdentLine(" code", 2)).toEqual({ text: "code", removed: 1 });
  });

  it("tab 优先于空格（首字符为 tab 时移除 tab）", () => {
    expect(outdentLine("\t  code", 4)).toEqual({ text: "  code", removed: 1 });
  });
});

describe("computeFoldRegions 基于缩进的折叠区域", () => {
  const doc = (lines: string[]) => ({
    getLine: (i: number) => lines[i] ?? "",
    lineCount: lines.length,
  });

  it("空文档 / 单行 → 无折叠区域", () => {
    expect(computeFoldRegions(doc([]).getLine, 0, 4)).toEqual([]);
    expect(computeFoldRegions(doc(["code"]).getLine, 1, 4)).toEqual([]);
  });

  it("无缩进差异 → 无折叠区域", () => {
    const d = doc(["a = 1", "b = 2", "c = 3"]);
    expect(computeFoldRegions(d.getLine, d.lineCount, 4)).toEqual([]);
  });

  it("基本缩进块：父行 + 缩进子行 → 一个折叠区域", () => {
    const d = doc(["function f() {", "    return 1;", "}"]);
    const regions = computeFoldRegions(d.getLine, d.lineCount, 4);
    expect(regions).toEqual([{ startLine: 0, endLine: 1 }]);
  });

  it("嵌套缩进：外层和内层各生成一个折叠区域", () => {
    const d = doc([
      "function f() {",      // 0 level 0
      "    if (x) {",        // 1 level 1
      "        return 1;",   // 2 level 2
      "    }",               // 3 level 1
      "}",                   // 4 level 0
    ]);
    const regions = computeFoldRegions(d.getLine, d.lineCount, 4);
    expect(regions).toContainEqual({ startLine: 0, endLine: 3 });
    expect(regions).toContainEqual({ startLine: 1, endLine: 2 });
  });

  it("空行跳过（不中断折叠区域）", () => {
    const d = doc([
      "function f() {",      // 0 level 0
      "",                     // 1 空行
      "    return 1;",       // 2 level 1
      "",                     // 3 空行
      "}",                   // 4 level 0
    ]);
    const regions = computeFoldRegions(d.getLine, d.lineCount, 4);
    // 空行跳过：endLine 是最后一条更深缩进的非空行（line 2）
    expect(regions).toEqual([{ startLine: 0, endLine: 2 }]);
  });

  it("同级连续块不互相折叠", () => {
    const d = doc([
      "function f() {",      // 0 level 0
      "    a();",            // 1 level 1
      "function g() {",      // 2 level 0
      "    b();",            // 3 level 1
      "}",                   // 4 level 0
    ]);
    const regions = computeFoldRegions(d.getLine, d.lineCount, 4);
    expect(regions).toContainEqual({ startLine: 0, endLine: 1 });
    expect(regions).toContainEqual({ startLine: 2, endLine: 3 });
  });

  it("minLines 参数过滤过短区域", () => {
    const d = doc([
      "function f() {",      // 0 level 0
      "    return 1;",       // 1 level 1
      "}",                   // 2 level 0
    ]);
    // minLines=3 需要 ≥3 行，此区域只有 2 行 → 过滤
    expect(computeFoldRegions(d.getLine, d.lineCount, 4, 3)).toEqual([]);
    // minLines=2 保留
    expect(computeFoldRegions(d.getLine, d.lineCount, 4, 2)).toEqual([{ startLine: 0, endLine: 1 }]);
  });

  it("tab 缩进同样生效", () => {
    const d = doc([
      "function f() {",      // 0 level 0
      "\treturn 1;",         // 1 level 1 (tab)
      "}",                   // 2 level 0
    ]);
    expect(computeFoldRegions(d.getLine, d.lineCount, 4)).toEqual([{ startLine: 0, endLine: 1 }]);
  });

  it("缩进回到更浅级别时折叠结束", () => {
    const d = doc([
      "class A {",            // 0 level 0
      "    method() {",       // 1 level 1
      "        stmt;",        // 2 level 2
      "    }",                // 3 level 1
      "    other;",           // 4 level 1 — 同级，不纳入上层折叠
      "}",                    // 5 level 0
    ]);
    const regions = computeFoldRegions(d.getLine, d.lineCount, 4);
    // level 0 区域：0→4（到 } 前）
    // level 1 区域：1→3（method 块内）和 4（other，单独无子行→不折叠）
    expect(regions).toContainEqual({ startLine: 0, endLine: 4 });
    expect(regions).toContainEqual({ startLine: 1, endLine: 2 });
  });
});

describe("minimapLayout 缩略图布局", () => {
  it("零行/零高 → 空范围（安全收敛）", () => {
    expect(minimapLayout(0, 200, 20, 0, 3, 200)).toEqual({
      firstLine: 0, lastLine: -1, offsetY: 0, viewportTop: 0, viewportHeight: 0, minimapScrollTop: 0,
    });
    expect(minimapLayout(0, 200, 20, 100, 0, 200)).toEqual({
      firstLine: 0, lastLine: -1, offsetY: 0, viewportTop: 0, viewportHeight: 0, minimapScrollTop: 0,
    });
    expect(minimapLayout(0, 200, 20, 100, 3, 0)).toEqual({
      firstLine: 0, lastLine: -1, offsetY: 0, viewportTop: 0, viewportHeight: 0, minimapScrollTop: 0,
    });
  });

  it("小文档（内容放得下）→ 全部行可见，offsetY 居中", () => {
    // 10 行 × 3px = 30px ≤ 200px → 居中 offsetY = (200-30)/2 = 85
    const r = minimapLayout(0, 400, 20, 10, 3, 200);
    expect(r.firstLine).toBe(0);
    expect(r.lastLine).toBe(9);
    expect(r.offsetY).toBe(85);
    expect(r.minimapScrollTop).toBe(0);
    // 视口框：scrollTop=0 → top = 85 + 0 = 85；height = (400/20)*3 = 60
    expect(r.viewportTop).toBe(85);
    expect(r.viewportHeight).toBe(60);
  });

  it("小文档滚动 → 视口框随 scrollTop 移动", () => {
    // 10 行 × 3px = 30px ≤ 200px；scrollTop=100（行 5）
    const r = minimapLayout(100, 400, 20, 10, 3, 200);
    expect(r.firstLine).toBe(0);
    expect(r.lastLine).toBe(9);
    expect(r.offsetY).toBe(85);
    // viewportTop = 85 + (100/20)*3 = 85 + 15 = 100
    expect(r.viewportTop).toBe(100);
    expect(r.viewportHeight).toBe(60);
  });

  it("大文档（内容放不下）→ minimap 按比例滚动，虚拟化", () => {
    // 200 行 × 3px = 600px > 200px；lineHeight=20, viewportH=400
    // maxEditorScroll = 200*20 - 400 = 3600
    // scrollTop=1800 (中间) → scrollRatio=0.5 → minimapScrollTop = (600-200)*0.5 = 200
    const r = minimapLayout(1800, 400, 20, 200, 3, 200);
    expect(r.offsetY).toBe(0);
    expect(r.minimapScrollTop).toBe(200);
    // firstLine = floor(200/3) = 66
    expect(r.firstLine).toBe(66);
    // lastLine = ceil((200+200)/3) - 1 = ceil(133.33) - 1 = 134 - 1 = 133
    expect(r.lastLine).toBe(133);
    // viewportTop = (1800/20)*3 - 200 = 270 - 200 = 70
    expect(r.viewportTop).toBe(70);
    // viewportHeight = min(200, (400/20)*3) = min(200, 60) = 60
    expect(r.viewportHeight).toBe(60);
  });

  it("大文档 scrollTop=0 → minimapScrollTop=0，从首行开始", () => {
    const r = minimapLayout(0, 400, 20, 200, 3, 200);
    expect(r.minimapScrollTop).toBe(0);
    expect(r.firstLine).toBe(0);
    // viewportTop = 0 - 0 = 0
    expect(r.viewportTop).toBe(0);
    expect(r.viewportHeight).toBe(60);
  });

  it("大文档滚到底 → minimapScrollTop 到上限", () => {
    // maxEditorScroll = 200*20 - 400 = 3600
    // scrollRatio = 1 → minimapScrollTop = 600 - 200 = 400
    const r = minimapLayout(3600, 400, 20, 200, 3, 200);
    expect(r.minimapScrollTop).toBe(400);
    // firstLine = floor(400/3) = 133
    expect(r.firstLine).toBe(133);
    // lastLine = min(199, ceil((400+200)/3)-1) = min(199, 199) = 199
    expect(r.lastLine).toBe(199);
    // viewportTop = (3600/20)*3 - 400 = 540 - 400 = 140
    expect(r.viewportTop).toBe(140);
    expect(r.viewportHeight).toBe(60);
  });

  it("viewportHeight 不超过 minimapViewHeight", () => {
    // 极小编辑器视口：editorViewportHeight=20（1 行），minimapViewHeight=30
    // 100 行 × 3px = 300 > 30 → 大文档模式
    const r = minimapLayout(0, 20, 20, 100, 3, 30);
    // viewportHeight = min(30, (20/20)*3) = min(30, 3) = 3
    expect(r.viewportHeight).toBe(3);
  });

  it("小文档视口高度超过 minimap 高度 → viewportHeight 收敛到 minimapViewHeight", () => {
    // 2 行 × 3px = 6px ≤ 30px → 小文档模式
    // editorViewportHeight=500 → viewportLines = 500/20 = 25
    // viewportHeight = min(30, 25*3) = min(30, 75) = 30
    const r = minimapLayout(0, 500, 20, 2, 3, 30);
    expect(r.viewportHeight).toBe(30);
  });

  it("scrollTop 超出上限 → scrollRatio 收敛到 1", () => {
    // maxEditorScroll = 100*20 - 400 = 1600
    // scrollTop=99999 → scrollRatio = 1
    const r = minimapLayout(99999, 400, 20, 100, 3, 200);
    expect(r.minimapScrollTop).toBe(100); // 100*3 - 200 = 100
  });
});
