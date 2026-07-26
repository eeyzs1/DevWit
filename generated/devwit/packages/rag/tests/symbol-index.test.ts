import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SymbolIndex } from "../src/symbol-index.js";

const CALC_TS = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "export function sub(a: number, b: number): number {",
  "  return a - b;",
  "}",
].join("\n");

const UTIL_PY = ["def helper():", "    pass"].join("\n");

describe("SymbolIndex", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-symidx-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "calc.ts"), CALC_TS);
    fs.writeFileSync(path.join(root, "src", "util.py"), UTIL_PY);
    fs.writeFileSync(path.join(root, "README.md"), "# 不支持符号提取");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "skip.ts"), "export function skipped() {}");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("buildAll：仅解析支持扩展名（跳过 md / node_modules），状态 ready", async () => {
    const index = new SymbolIndex(root);
    expect(index.getStatus()).toBe("disabled");
    await index.buildAll();
    expect(index.getStatus()).toBe("ready");
    expect(index.fileCount).toBe(2);
    expect(index.size).toBe(3); // add + sub + helper
    const names = index.query("").map((s) => s.name);
    expect(names).toEqual(["add", "helper", "sub"]);
  });

  it("query 评分排序 + result 携带索引状态", async () => {
    const index = new SymbolIndex(root);
    await index.buildAll();
    const hits = index.query("ad");
    expect(hits.map((s) => s.name)).toEqual(["add"]);
    const result = index.result("sub");
    expect(result.state).toBe("ready");
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.relPath).toBe("src/calc.ts");
  });

  it("resolve：按 id 重读文件切片（内容为事实源）；未知 id 返回 null", async () => {
    const index = new SymbolIndex(root);
    await index.buildAll();
    const add = index.query("add")[0]!;
    const resolved = await index.resolve(add.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.text).toBe(CALC_TS.split("\n").slice(0, 3).join("\n"));
    expect(resolved!.relPath).toBe("src/calc.ts");
    expect(await index.resolve("deadbeefdeadbeef")).toBeNull();
  });

  it("syncFile 更新：改名后旧 id 失效（行号/名称漂移语义同 chunkId），新名可查", async () => {
    const index = new SymbolIndex(root);
    await index.buildAll();
    const addId = index.query("add")[0]!.id;
    fs.writeFileSync(
      path.join(root, "src", "calc.ts"),
      CALC_TS.replace("function add", "function plus")
    );
    await index.syncFile(path.join(root, "src", "calc.ts"));
    expect(index.query("add")).toEqual([]);
    expect(index.query("plus")).toHaveLength(1);
    expect(await index.resolve(addId)).toBeNull();
  });

  it("syncFile 删除：文件消失后符号出表；root 外路径为无操作", async () => {
    const index = new SymbolIndex(root);
    await index.buildAll();
    fs.rmSync(path.join(root, "src", "util.py"));
    await index.syncFile(path.join(root, "src", "util.py"));
    expect(index.query("helper")).toEqual([]);
    expect(index.fileCount).toBe(1);
    // root 外路径不抛错、不改表
    await index.syncFile(path.join(root, "..", "outside.ts"));
    expect(index.size).toBe(2);
  });

  it("syncFile 新增：工作区事件先于 buildAll 到达时自愈为 ready", async () => {
    const index = new SymbolIndex(root);
    const extra = path.join(root, "src", "extra.ts");
    fs.writeFileSync(extra, "export function extra() {}");
    await index.syncFile(extra);
    expect(index.getStatus()).toBe("ready");
    expect(index.query("extra")).toHaveLength(1);
  });

  it("buildAll 根目录不可读时置 error（不向上抛，绝不阻断对话）", async () => {
    const index = new SymbolIndex(path.join(root, "no-such-dir"));
    await index.buildAll();
    expect(index.getStatus()).toBe("error");
  });

  it("dispose：清空内存并归位 disabled", async () => {
    const index = new SymbolIndex(root);
    await index.buildAll();
    index.dispose();
    expect(index.getStatus()).toBe("disabled");
    expect(index.size).toBe(0);
    expect(index.fileCount).toBe(0);
  });
});
