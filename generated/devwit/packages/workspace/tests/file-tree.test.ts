import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFileTree } from "../src/file-tree.js";

describe("buildFileTree", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-tree-"));
    fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "a");
    fs.writeFileSync(path.join(root, "src", "deep", "b.ts"), "b");
    fs.writeFileSync(path.join(root, "README.md"), "readme");
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "x.js"), "x");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("构建目录树，目录在前、排除 node_modules/.git", () => {
    const tree = buildFileTree(root);
    expect(tree.type).toBe("dir");
    expect(tree.path).toBe(path.resolve(root));
    const names = (tree.children ?? []).map((c) => c.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    // 目录排前
    expect(names[0]).toBe("src");
    const src = (tree.children ?? []).find((c) => c.name === "src");
    expect(src?.type).toBe("dir");
    const srcNames = (src?.children ?? []).map((c) => c.name);
    expect(srcNames).toEqual(["deep", "a.ts"]);
    const deep = (src?.children ?? []).find((c) => c.name === "deep");
    expect((deep?.children ?? []).map((c) => c.name)).toEqual(["b.ts"]);
  });

  it("maxDepth 限制递归深度", () => {
    const tree = buildFileTree(root, { maxDepth: 1 });
    const src = (tree.children ?? []).find((c) => c.name === "src");
    expect(src?.children).toBeUndefined();
  });

  it("非目录路径抛错", () => {
    expect(() => buildFileTree(path.join(root, "README.md"))).toThrow(/Not a directory/);
  });
});
