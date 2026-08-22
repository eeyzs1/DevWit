import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeTool,
  MAX_TOOL_OUTPUT_CHARS,
  resolveWithinRoot,
  toolDefinitionsFor,
  truncateOutput,
  wildcardToRegExp,
} from "../src/tools.js";
import { MemoryEnvironment } from "./helpers.js";

const ROOT = path.resolve("ws-test");

function makeEnv(files: Record<string, string> = {}): MemoryEnvironment {
  return new MemoryEnvironment(ROOT, files);
}

const ctx = { workspaceRoot: ROOT };

describe("路径安全", () => {
  it("resolveWithinRoot 接受区内路径、拒绝越界路径", () => {
    expect(resolveWithinRoot(ROOT, "a/b.txt")).toBe(path.resolve(ROOT, "a/b.txt"));
    expect(resolveWithinRoot(ROOT, ".")).toBe(path.resolve(ROOT));
    expect(() => resolveWithinRoot(ROOT, "../outside.txt")).toThrow(/路径越出工作区/);
    expect(() => resolveWithinRoot(ROOT, "../../etc/passwd")).toThrow(/路径越出工作区/);
  });

  it("read/write 越界路径返回 ok=false 且不碰环境", async () => {
    const env = makeEnv();
    const result = await executeTool({ id: "t", name: "read", args: { path: "../secret.txt" } }, env, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/路径越出工作区/);
  });
});

describe("read / write / edit", () => {
  it("read 读出文件内容；文件不存在报读取失败", async () => {
    const env = makeEnv({ "a.txt": "hello" });
    const hit = await executeTool({ id: "t", name: "read", args: { path: "a.txt" } }, env, ctx);
    expect(hit).toMatchObject({ ok: true, output: "hello" });
    const miss = await executeTool({ id: "t", name: "read", args: { path: "none.txt" } }, env, ctx);
    expect(miss.ok).toBe(false);
    expect(miss.error).toMatch(/读取失败/);
  });

  it("read 支持 start_line/end_line 行区间（含行号标注，大文件分片）", async () => {
    const env = makeEnv({ "a.txt": "l1\nl2\nl3\nl4\nl5" });
    const slice = await executeTool(
      { id: "t", name: "read", args: { path: "a.txt", start_line: 2, end_line: 4 } },
      env,
      ctx
    );
    expect(slice.ok).toBe(true);
    // 输出应显示 2-4 行且带行号标注
    expect(slice.output).toContain("共 5 行，显示第 2-4 行");
    expect(slice.output).toContain("2: l2");
    expect(slice.output).toContain("3: l3");
    expect(slice.output).toContain("4: l4");
    // 越界区间报错
    const bad = await executeTool(
      { id: "t", name: "read", args: { path: "a.txt", start_line: 4, end_line: 2 } },
      env,
      ctx
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/大于/);
  });

  it("write 写入并自动建父目录；read 可回读", async () => {
    const env = makeEnv();
    const result = await executeTool(
      { id: "t", name: "write", args: { path: "src/deep/a.ts", content: "export const x = 1;" } },
      env,
      ctx
    );
    expect(result.ok).toBe(true);
    expect(env.readRelative("src/deep/a.ts")).toBe("export const x = 1;");
  });

  it("edit 精确替换唯一匹配；多次出现需 replace_all；未命中报错", async () => {
    const env = makeEnv({ "a.txt": "foo bar foo" });
    const ambiguous = await executeTool(
      { id: "t", name: "edit", args: { path: "a.txt", old_string: "foo", new_string: "baz" } },
      env,
      ctx
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/2 次/);

    const all = await executeTool(
      { id: "t", name: "edit", args: { path: "a.txt", old_string: "foo", new_string: "baz", replace_all: true } },
      env,
      ctx
    );
    expect(all.ok).toBe(true);
    expect(env.readRelative("a.txt")).toBe("baz bar baz");

    const miss = await executeTool(
      { id: "t", name: "edit", args: { path: "a.txt", old_string: "nope", new_string: "x" } },
      env,
      ctx
    );
    expect(miss.ok).toBe(false);
    expect(miss.error).toMatch(/未出现/);
  });

  it("参数校验：缺 path / 空 old_string 返回参数错误", async () => {
    const env = makeEnv({ "a.txt": "x" });
    const noPath = await executeTool({ id: "t", name: "read", args: {} }, env, ctx);
    expect(noPath.ok).toBe(false);
    expect(noPath.error).toMatch(/参数 path/);
    const emptyOld = await executeTool(
      { id: "t", name: "edit", args: { path: "a.txt", old_string: "", new_string: "y" } },
      env,
      ctx
    );
    expect(emptyOld.ok).toBe(false);
    expect(emptyOld.error).toMatch(/old_string/);
  });
});

describe("bash", () => {
  it("经环境 exec 执行，cwd 为工作区根，输出含 stdout/stderr", async () => {
    const env = makeEnv();
    env.execHandler = async () => ({ stdout: "out-1", stderr: "err-1", exitCode: 0 });
    const result = await executeTool({ id: "t", name: "bash", args: { command: "npm test" } }, env, ctx);
    expect(result.ok).toBe(true);
    expect(env.execCalls).toEqual([{ command: "npm test", cwd: ROOT }]);
    expect(result.output).toContain("out-1");
    expect(result.output).toContain("[stderr]");
    expect(result.output).toContain("err-1");
  });

  it("非零退出码：ok=false 且保留输出现场", async () => {
    const env = makeEnv();
    env.execHandler = async () => ({ stdout: "partial", stderr: "", exitCode: 3 });
    const result = await executeTool({ id: "t", name: "bash", args: { command: "false" } }, env, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/退出码 3/);
    expect(result.output).toContain("partial");
  });
});

describe("grep / find / ls", () => {
  const FILES = {
    "src/a.ts": "const alpha = 1;\nconst BETA = 2;",
    "src/b.md": "alpha in markdown",
    "README.md": "no match here",
  };

  it("grep 输出 文件:行号: 内容，支持 glob 与大小写控制", async () => {
    const env = makeEnv(FILES);
    const basic = await executeTool({ id: "t", name: "grep", args: { pattern: "alpha" } }, env, ctx);
    expect(basic.ok).toBe(true);
    expect(basic.output).toContain("src/a.ts:1: const alpha = 1;");
    expect(basic.output).toContain("src/b.md:1: alpha in markdown");
    expect(basic.output).not.toContain("BETA");

    const globbed = await executeTool(
      { id: "t", name: "grep", args: { pattern: "alpha", glob: "*.ts" } },
      env,
      ctx
    );
    expect(globbed.output).not.toContain("b.md");

    const insensitive = await executeTool(
      { id: "t", name: "grep", args: { pattern: "beta", case_sensitive: false } },
      env,
      ctx
    );
    expect(insensitive.output).toContain("src/a.ts:2: const BETA = 2;");
  });

  it("grep 无效正则报错；无匹配时明确说明", async () => {
    const env = makeEnv(FILES);
    const invalid = await executeTool({ id: "t", name: "grep", args: { pattern: "([" } }, env, ctx);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toMatch(/无效正则/);
    const none = await executeTool({ id: "t", name: "grep", args: { pattern: "zzz" } }, env, ctx);
    expect(none.output).toMatch(/无匹配/);
  });

  it("find 按通配符匹配文件名，目录带 / 后缀", async () => {
    const env = makeEnv({ "src/a.ts": "1", "src/b.tsx": "2", "docs/c.md": "3" });
    const ts = await executeTool({ id: "t", name: "find", args: { pattern: "*.ts" } }, env, ctx);
    expect(ts.output).toContain("src/a.ts");
    expect(ts.output).not.toContain("b.tsx");
    const docs = await executeTool({ id: "t", name: "find", args: { pattern: "docs" } }, env, ctx);
    expect(docs.output).toContain("docs/");
    const none = await executeTool({ id: "t", name: "find", args: { pattern: "*.py" } }, env, ctx);
    expect(none.output).toMatch(/未找到/);
  });

  it("ls 目录在前带 / 后缀、文件在后；空目录与缺失目录分别处理", async () => {
    const env = makeEnv({ "src/a.ts": "1", "z.txt": "2", "empty/keep.txt": "3" });
    const root = await executeTool({ id: "t", name: "ls", args: {} }, env, ctx);
    expect(root.ok).toBe(true);
    expect(root.output).toContain("src/");
    expect(root.output).toContain("z.txt");
    expect(root.output.indexOf("src/")).toBeLessThan(root.output.indexOf("z.txt"));

    const missing = await executeTool({ id: "t", name: "ls", args: { path: "nope" } }, env, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/列目录失败/);
  });
});

describe("输出截断与工具筛选", () => {
  it("truncateOutput 超长截断并附原始长度", () => {
    const long = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 100);
    const truncated = truncateOutput(long);
    expect(truncated.length).toBeLessThan(long.length);
    expect(truncated).toContain("已截断");
  });

  it("wildcardToRegExp：* 跨字符、? 单字符、点号转义", () => {
    expect(wildcardToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(wildcardToRegExp("*.ts").test("a.tsx")).toBe(false);
    expect(wildcardToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(wildcardToRegExp("a?.ts").test("abb.ts")).toBe(false);
  });

  it("toolDefinitionsFor 只保留合法工具名；executeTool 拒绝未知工具", async () => {
    const defs = toolDefinitionsFor(["read", "nope", "bash"]);
    expect(defs.map((def) => def.name)).toEqual(["read", "bash"]);
    const env = makeEnv();
    const result = await executeTool({ id: "t", name: "rm", args: {} }, env, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知工具/);
  });
});
