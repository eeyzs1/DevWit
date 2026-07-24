import { describe, expect, it } from "vitest";
import {
  CHUNK_MAX_LINES,
  CHUNK_MIN_LINES,
  chunkSource,
  makeChunkId,
} from "../src/chunker.js";

describe("chunkSource", () => {
  it("空文件 / 纯空白文件产出零块", () => {
    expect(chunkSource("a.ts", "")).toEqual([]);
    expect(chunkSource("a.ts", "\n\n  \n\t\n")).toEqual([]);
  });

  it("小文件产出单块，行区间覆盖全文", () => {
    const content = "const a = 1;\nconst b = 2;";
    const chunks = chunkSource("src/a.ts", content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.relPath).toBe("src/a.ts");
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(2);
    expect(chunks[0]!.text).toBe("const a = 1;\nconst b = 2;");
  });

  it("chunkId 内容稳定则稳定，内容变化则变化", () => {
    const id1 = makeChunkId("a.ts", 1, 3, "foo");
    const id2 = makeChunkId("a.ts", 1, 3, "foo");
    const id3 = makeChunkId("a.ts", 1, 3, "bar");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("顶级声明边界切分：多个 function 分成多块", () => {
    const content = [
      "function alpha() {",
      "  return 1;",
      "}",
      "",
      "function beta() {",
      "  return 2;",
      "}",
      "",
      "function gamma() {",
      "  return 3;",
      "}",
    ].join("\n");
    const chunks = chunkSource("a.ts", content);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // 块间行区间不重叠且单调递增
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.endLine);
    }
  });

  it("超过 MAX_LINES 强制闭块（不产出巨块）", () => {
    // 无边界行的连续缩进块，只能靠行数上限切断
    const content = Array.from({ length: CHUNK_MAX_LINES * 2 + 10 }, (_, i) => `  line${i}`).join("\n");
    const chunks = chunkSource("a.ts", content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(CHUNK_MAX_LINES + 1);
    }
  });

  it("末尾碎块并入前块（不足 MIN_LINES 时）", () => {
    const head = Array.from({ length: CHUNK_MIN_LINES + 2 }, (_, i) => `const h${i} = ${i};`);
    // 最后 1 行是顶级声明（触发边界），但自身不足 MIN_LINES → 应并入前块
    const content = [...head, "", "const tail = 0;"].join("\n");
    const chunks = chunkSource("a.ts", content);
    const last = chunks[chunks.length - 1]!;
    expect(last.text).toContain("const tail = 0;");
    expect(last.endLine - last.startLine + 1).toBeGreaterThanOrEqual(CHUNK_MIN_LINES);
  });
});
