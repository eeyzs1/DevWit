/**
 * 示例项目脚手架测试（D3 / v0.6.0）：真实 tmp 目录回环——
 * 验证 scaffoldSampleProject 写入完整模板（含预埋 bug 供 Agent 演练）、
 * 目录递归创建、返回文件清单与磁盘一致。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldSampleProject } from "../src/main/sample-project.js";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "devwit-sample-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("示例项目脚手架（D3）", () => {
  it("写入完整模板并返回文件清单", async () => {
    const target = path.join(tmpRoot, "project");
    const created = await scaffoldSampleProject(target);

    const expected = [
      "package.json",
      "tsconfig.json",
      "index.html",
      "src/main.ts",
      "src/todo.ts",
      "src/styles.css",
      "README.md",
    ];
    expect([...created].sort()).toEqual([...expected].sort());
    for (const file of expected) {
      expect(existsSync(path.join(target, file)), `missing ${file}`).toBe(true);
    }
    // 目录递归创建
    expect(statSync(path.join(target, "src")).isDirectory()).toBe(true);
  });

  it("模板内容自洽：package.json 可解析、含 tsc 构建脚本；README 引导存在", () => {
    const target = path.join(tmpRoot, "project");
    void scaffoldSampleProject(target);

    const pkg = JSON.parse(readFileSync(path.join(target, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts?.["build"]).toBe("tsc");
    expect(pkg.devDependencies?.["typescript"]).toBeTruthy();
    expect(readFileSync(path.join(target, "README.md"), "utf-8")).toContain("上下文面板");
    expect(readFileSync(path.join(target, "index.html"), "utf-8")).toContain("dist/main.js");
  });

  it("todo.ts 预埋可修复 bug：All 过滤误隐藏已完成项（Agent 演练入口）", () => {
    const target = path.join(tmpRoot, "project");
    void scaffoldSampleProject(target);

    const todo = readFileSync(path.join(target, "src/todo.ts"), "utf-8");
    // 三态齐全（TodoFilter 联合含 all），active/completed 有显式分支
    expect(todo).toContain('"all" | "active" | "completed"');
    expect(todo).toContain('filter === "active"');
    expect(todo).toContain('filter === "completed"');
    // 预埋缺陷的实质：all 走兜底 return，与 active 同构（都过滤未完成项）
    expect(todo).toContain("return todos.filter((todo) => !todo.completed);");
    // 编译产物目录声明存在（tsconfig outDir）
    expect(readFileSync(path.join(target, "tsconfig.json"), "utf-8")).toContain('"outDir": "dist"');
  });

  it("目标目录存在子目录时仍完整覆盖写入（用户主动选择即意图）", () => {
    const target = path.join(tmpRoot, "project");
    const srcDir = path.join(target, "src");
    // 先造一个已存在的 src/ 目录，脚手架应在其下写入 main.ts 而非抛错
    void scaffoldSampleProject(target);
    expect(existsSync(path.join(srcDir, "main.ts"))).toBe(true);
    expect(readdirSync(srcDir).sort()).toContain("todo.ts");
  });
});
