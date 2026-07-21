import { describe, expect, it } from "vitest";
import { TextDocument } from "@devwit/editor-core";
import { HighlightEngine, LANGUAGE_WASM_FILES } from "../src/index.js";

/**
 * 降级路径测试：wasm 不可用（未安装/路径无效/初始化失败）时引擎必须回退纯文本 token 流，
 * 且返回的是真实文档文本（不伪造高亮）。无论宿主环境是否已安装 web-tree-sitter /
 * tree-sitter-wasms，下列注入路径都以确定性方式失败，断言一致。
 */

describe("HighlightEngine.normalizeLanguageId", () => {
  it("规范 id 原样通过", () => {
    expect(HighlightEngine.normalizeLanguageId("typescript")).toBe("typescript");
    expect(HighlightEngine.normalizeLanguageId("javascript")).toBe("javascript");
    expect(HighlightEngine.normalizeLanguageId("tsx")).toBe("tsx");
    expect(HighlightEngine.normalizeLanguageId("python")).toBe("python");
  });

  it("别名归一化且大小写不敏感", () => {
    expect(HighlightEngine.normalizeLanguageId("ts")).toBe("typescript");
    expect(HighlightEngine.normalizeLanguageId("TS")).toBe("typescript");
    expect(HighlightEngine.normalizeLanguageId("mts")).toBe("typescript");
    expect(HighlightEngine.normalizeLanguageId("js")).toBe("javascript");
    expect(HighlightEngine.normalizeLanguageId("JSX")).toBe("javascript");
    expect(HighlightEngine.normalizeLanguageId("py")).toBe("python");
  });

  it("不支持的语言 → undefined", () => {
    expect(HighlightEngine.normalizeLanguageId("rust")).toBeUndefined();
    expect(HighlightEngine.normalizeLanguageId("")).toBeUndefined();
    expect(HighlightEngine.normalizeLanguageId("not-a-lang")).toBeUndefined();
  });

  it("LANGUAGE_WASM_FILES 与规范 id 一一对应", () => {
    for (const id of Object.keys(LANGUAGE_WASM_FILES)) {
      expect(HighlightEngine.normalizeLanguageId(id)).toBe(id);
    }
  });
});

describe("HighlightEngine 纯文本降级", () => {
  it("未知语言 id：loadLanguage 直接返回 false，保持降级", async () => {
    const engine = new HighlightEngine();
    engine.setDocument(TextDocument.fromString("const a = 1;"));
    const ok = await engine.loadLanguage("cobol");
    expect(ok).toBe(false);
    expect(engine.highlighting).toBe(false);
    expect(engine.languageId).toBeUndefined();
    engine.dispose();
  });

  it("runtimeWasm 指向不存在文件：运行时初始化失败 → false + 降级", async () => {
    const engine = new HighlightEngine({ runtimeWasm: "/nonexistent/tree-sitter.wasm" });
    engine.setDocument(TextDocument.fromString("def f():\n    pass\n"));
    const ok = await engine.loadLanguage("python");
    expect(ok).toBe(false);
    expect(engine.highlighting).toBe(false);
    // 降级 token：整行 text
    expect(engine.tokensForLine(0)).toEqual([{ startChar: 0, endChar: 8, scope: "text" }]);
    expect(engine.tokensForLine(1)).toEqual([{ startChar: 0, endChar: 8, scope: "text" }]);
    engine.dispose();
  });

  it("languageWasm 定位到不存在文件：语言加载失败 → false + 降级", async () => {
    const engine = new HighlightEngine({ languageWasm: () => "/nonexistent/tree-sitter-typescript.wasm" });
    engine.setDocument(TextDocument.fromString("const x: number = 1;"));
    const ok = await engine.loadLanguage("typescript");
    expect(ok).toBe(false);
    expect(engine.highlighting).toBe(false);
    expect(engine.languageId).toBeUndefined();
    engine.dispose();
  });

  it("降级 token 形态：非空行整行 text、空行 []、越界行 []", () => {
    const engine = new HighlightEngine();
    engine.setDocument(TextDocument.fromString("abc\n\ndef"));
    expect(engine.tokensForLine(0)).toEqual([{ startChar: 0, endChar: 3, scope: "text" }]);
    expect(engine.tokensForLine(1)).toEqual([]);
    expect(engine.tokensForLine(2)).toEqual([{ startChar: 0, endChar: 3, scope: "text" }]);
    expect(engine.tokensForLine(3)).toEqual([]);
    expect(engine.tokensForLine(-1)).toEqual([]);
    engine.dispose();
  });

  it("未绑定文档：tokensForLine 返回 []", () => {
    const engine = new HighlightEngine();
    expect(engine.tokensForLine(0)).toEqual([]);
    expect(engine.highlighting).toBe(false);
    engine.dispose();
  });

  it("降级状态下编辑文档：token 实时跟随最新文本（不缓存陈旧内容）", () => {
    const doc = TextDocument.fromString("let a = 1;");
    const engine = new HighlightEngine();
    engine.setDocument(doc);
    expect(engine.tokensForLine(0)).toEqual([{ startChar: 0, endChar: 10, scope: "text" }]);
    doc.applyEdit({ offset: 10, length: 0, text: "\nlet b = 22;" });
    expect(engine.tokensForLine(0)).toEqual([{ startChar: 0, endChar: 10, scope: "text" }]);
    expect(engine.tokensForLine(1)).toEqual([{ startChar: 0, endChar: 11, scope: "text" }]);
    doc.delete(0, 4);
    expect(engine.tokensForLine(0)).toEqual([{ startChar: 0, endChar: 6, scope: "text" }]);
    engine.dispose();
  });

  it("setDocument(undefined) 解绑后返回 []；dispose 幂等安全", async () => {
    const engine = new HighlightEngine();
    engine.setDocument(TextDocument.fromString("x"));
    expect(engine.tokensForLine(0)).toHaveLength(1);
    engine.setDocument(undefined);
    expect(engine.tokensForLine(0)).toEqual([]);
    await engine.loadLanguage("rust"); // 未知语言，解绑状态下也安全返回 false
    engine.dispose();
    engine.dispose(); // 重复 dispose 不抛
    expect(engine.tokensForLine(0)).toEqual([]);
  });

  it("CRLF 行尾：\\r 不计入 token 范围（与 editor-core getLine 一致）", () => {
    const engine = new HighlightEngine();
    engine.setDocument(TextDocument.fromString("ab\r\ncd"));
    expect(engine.tokensForLine(0)).toEqual([{ startChar: 0, endChar: 2, scope: "text" }]);
    expect(engine.tokensForLine(1)).toEqual([{ startChar: 0, endChar: 2, scope: "text" }]);
    engine.dispose();
  });
});
