import { describe, expect, it } from "vitest";
import {
  detectAtTrigger,
  detectSlashTrigger,
  filterModesByQuery,
  filterWorkspaceFiles,
} from "../src/input-triggers.js";

describe("detectAtTrigger", () => {
  it("行首 @ 命中，query 为空", () => {
    expect(detectAtTrigger("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("空白后 @ 命中并携带已输入查询", () => {
    expect(detectAtTrigger("解释 @src/a", 9)).toEqual({ start: 3, query: "src/a" });
  });

  it("@ 前非空白（邮箱式）不命中", () => {
    expect(detectAtTrigger("user@host", 9)).toBeNull();
  });

  it("查询含空白后光标离开 token 不命中", () => {
    expect(detectAtTrigger("@foo bar", 8)).toBeNull();
  });

  it("光标在 @ 之前不命中", () => {
    expect(detectAtTrigger("ab @cd", 1)).toBeNull();
  });

  it("换行后行首 @ 命中", () => {
    expect(detectAtTrigger("第一行\n@doc", 8)).toEqual({ start: 4, query: "doc" });
  });
});

describe("detectSlashTrigger", () => {
  it("/ 开头且光标在 token 内命中", () => {
    expect(detectSlashTrigger("/", 1)).toEqual({ query: "" });
    expect(detectSlashTrigger("/ag", 3)).toEqual({ query: "ag" });
  });

  it("非 / 开头不命中", () => {
    expect(detectSlashTrigger("a/", 2)).toBeNull();
    expect(detectSlashTrigger("", 0)).toBeNull();
  });

  it("光标越过首个空白后不命中（命令已结束）", () => {
    expect(detectSlashTrigger("/agent 继续写", 7)).toBeNull();
  });
});

describe("filterWorkspaceFiles", () => {
  const files = ["src/index.ts", "src/app.ts", "docs/app-guide.md", "README.md", "src/deep/nested-util.ts"];

  it("空查询返回前 limit 个（按 localeCompare 稳定排序）", () => {
    const result = filterWorkspaceFiles(files, "", 3);
    expect(result).toEqual([...files].sort((a, b) => a.localeCompare(b)).slice(0, 3));
  });

  it("basename 前缀命中优先于路径中间命中", () => {
    const result = filterWorkspaceFiles(files, "app");
    // basename 前缀命中仅这两个（app.ts / app-guide.md），且排在全部结果之前
    expect(result).toHaveLength(2);
    expect(new Set(result)).toEqual(new Set(["src/app.ts", "docs/app-guide.md"]));
  });

  it("大小写不敏感子串匹配", () => {
    expect(filterWorkspaceFiles(files, "readme")).toEqual(["README.md"]);
  });

  it("路径片段可命中深层文件，无命中返回空", () => {
    expect(filterWorkspaceFiles(files, "nested")).toEqual(["src/deep/nested-util.ts"]);
    expect(filterWorkspaceFiles(files, "zzz")).toEqual([]);
  });
});

describe("filterModesByQuery", () => {
  const modes = [{ id: "chat" }, { id: "agent" }, { id: "review" }];
  const zhName = (mode: { id: string }): string => ({ chat: "对话", agent: "智能体", review: "审查" })[mode.id] ?? mode.id;

  it("空查询返回全部（截断 limit）", () => {
    expect(filterModesByQuery(modes, "", zhName)).toHaveLength(3);
  });

  it("按 id 前缀匹配", () => {
    const result = filterModesByQuery(modes, "ag", zhName);
    expect(result.map((mode) => mode.id)).toEqual(["agent"]);
  });

  it("按本地化显示名匹配（中文查询）", () => {
    const result = filterModesByQuery(modes, "智能", zhName);
    expect(result.map((mode) => mode.id)).toEqual(["agent"]);
  });

  it("无命中返回空", () => {
    expect(filterModesByQuery(modes, "zzz", zhName)).toEqual([]);
  });
});
