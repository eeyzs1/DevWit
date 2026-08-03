/**
 * 跨文件搜索单测（v0.4.0）：真实 temp 工作区，零 mock。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileSearchRegex, searchInWorkspace } from "../src/search.js";

describe("compileSearchRegex", () => {
  it("字面量模式：转义元字符", () => {
    const re = compileSearchRegex({ query: "a.b", isRegex: false, caseSensitive: false, wholeWord: false });
    re.lastIndex = 0;
    expect(re.test("a.b")).toBe(true);
    re.lastIndex = 0;
    expect(re.test("axb")).toBe(false); // . 被转义
  });

  it("正则模式：元字符生效", () => {
    const re = compileSearchRegex({ query: "a.b", isRegex: true, caseSensitive: false, wholeWord: false });
    re.lastIndex = 0;
    expect(re.test("axb")).toBe(true);
    re.lastIndex = 0;
    expect(re.test("a.b")).toBe(true);
  });

  it("大小写敏感：flag 控制", () => {
    const ci = compileSearchRegex({ query: "Hello", isRegex: false, caseSensitive: false, wholeWord: false });
    const cs = compileSearchRegex({ query: "Hello", isRegex: false, caseSensitive: true, wholeWord: false });
    expect(ci.test("hello")).toBe(true);
    expect(cs.test("hello")).toBe(false);
  });

  it("全词匹配：词边界包裹", () => {
    const re = compileSearchRegex({ query: "cat", isRegex: false, caseSensitive: true, wholeWord: true });
    re.lastIndex = 0;
    expect(re.test("cat")).toBe(true);
    re.lastIndex = 0;
    expect(re.test("the cat sat")).toBe(true);
    re.lastIndex = 0;
    expect(re.test("concatenate")).toBe(false);
  });

  it("空 query 抛错", () => {
    expect(() => compileSearchRegex({ query: "", isRegex: false, caseSensitive: false, wholeWord: false })).toThrow();
  });

  it("非法正则抛 SyntaxError", () => {
    expect(() =>
      compileSearchRegex({ query: "([", isRegex: true, caseSensitive: false, wholeWord: false })
    ).toThrow(SyntaxError);
  });
});

describe("searchInWorkspace", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-search-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const hello = 1;\nconst world = hello + 2;\nconsole.log(hello);\n");
    fs.writeFileSync(path.join(root, "src", "b.ts"), "function helloWorld() {\n  return 'hello';\n}\n");
    fs.writeFileSync(path.join(root, "README.md"), "# Hello World\n\nThis is a test.\n");
    // 二进制文件（含 \0）
    fs.writeFileSync(path.join(root, "bin.dat"), "binary\0data\0here");
    // node_modules 应被排除
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "hello in node_modules");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("字面量搜索：跨文件匹配 + 行列号 + 预览", async () => {
    const results = await searchInWorkspace(root, {
      query: "hello",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(results.totalMatches).toBeGreaterThanOrEqual(4);
    // a.ts 有 3 处 hello
    const aTs = results.files.find((f) => f.relativePath === "src/a.ts");
    expect(aTs).toBeDefined();
    expect(aTs?.matches.length).toBe(3);
    expect(aTs?.matches[0]?.line).toBe(1);
    expect(aTs?.matches[0]?.column).toBe(7); // "const hello" hello 从第 7 列
    expect(aTs?.matches[0]?.preview).toContain("hello");
  });

  it("大小写不敏感（缺省）：匹配 Hello/hello", async () => {
    const results = await searchInWorkspace(root, {
      query: "hello",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    // README.md 含 "Hello"
    const readme = results.files.find((f) => f.relativePath === "README.md");
    expect(readme).toBeDefined();
    expect(readme?.matches.length).toBe(1);
  });

  it("大小写敏感：不匹配 Hello", async () => {
    const results = await searchInWorkspace(root, {
      query: "hello",
      isRegex: false,
      caseSensitive: true,
      wholeWord: false,
    });
    const readme = results.files.find((f) => f.relativePath === "README.md");
    expect(readme).toBeUndefined(); // README 只有 Hello（大写 H），不匹配
  });

  it("正则模式：匹配 helloWorld", async () => {
    const results = await searchInWorkspace(root, {
      query: "hello\\w+",
      isRegex: true,
      caseSensitive: false,
      wholeWord: false,
    });
    const bTs = results.files.find((f) => f.relativePath === "src/b.ts");
    expect(bTs).toBeDefined();
    expect(bTs?.matches.some((m) => m.preview.includes("helloWorld"))).toBe(true);
  });

  it("全词匹配：不匹配 helloWorld 中的 hello", async () => {
    const results = await searchInWorkspace(root, {
      query: "hello",
      isRegex: false,
      caseSensitive: false,
      wholeWord: true,
    });
    const bTs = results.files.find((f) => f.relativePath === "src/b.ts");
    // b.ts 第 2 行 return 'hello' 全词匹配；helloWorld 不算
    expect(bTs).toBeDefined();
    expect(bTs?.matches.length).toBe(1);
    expect(bTs?.matches[0]?.line).toBe(2);
  });

  it("排除 node_modules：不搜索依赖文件", async () => {
    const results = await searchInWorkspace(root, {
      query: "hello",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    const depFile = results.files.find((f) => f.relativePath.includes("node_modules"));
    expect(depFile).toBeUndefined();
  });

  it("跳过二进制文件", async () => {
    const results = await searchInWorkspace(root, {
      query: "binary",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    const binFile = results.files.find((f) => f.relativePath === "bin.dat");
    expect(binFile).toBeUndefined();
  });

  it("空 query 返回空结果", async () => {
    const results = await searchInWorkspace(root, {
      query: "",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    expect(results.files).toEqual([]);
    expect(results.totalMatches).toBe(0);
    expect(results.truncated).toBe(false);
  });

  it("maxResultsPerFile 截断 + truncated 标记", async () => {
    const results = await searchInWorkspace(root, {
      query: "hello",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      maxResultsPerFile: 1,
    });
    const aTs = results.files.find((f) => f.relativePath === "src/a.ts");
    expect(aTs?.matches.length).toBe(1);
    expect(results.truncated).toBe(true);
  });

  it("一行多次命中：分别返回", async () => {
    fs.writeFileSync(path.join(root, "src", "multi.ts"), "hello hello hello\n");
    const results = await searchInWorkspace(root, {
      query: "hello",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    const multi = results.files.find((f) => f.relativePath === "src/multi.ts");
    expect(multi?.matches.length).toBe(3);
    expect(multi?.matches[0]?.column).toBe(1);
    expect(multi?.matches[1]?.column).toBe(7);
    expect(multi?.matches[2]?.column).toBe(13);
  });

  it("relativePath 使用正斜杠（跨平台）", async () => {
    const results = await searchInWorkspace(root, {
      query: "hello",
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    for (const file of results.files) {
      expect(file.relativePath).not.toContain("\\");
    }
  });
});
