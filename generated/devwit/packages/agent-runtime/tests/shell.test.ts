import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeEnvironment } from "../src/shell.js";
import type { ToolEnvironment } from "../src/tools.js";

/**
 * NodeEnvironment 真实集成测试：真实 node:fs 读写临时目录、
 * 真实 node:child_process 起进程（无 mock，符合全局约束）。
 */
describe("createNodeEnvironment（真实 fs / child_process）", () => {
  let dir: string;
  let env: ToolEnvironment;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "devwit-shell-"));
    env = createNodeEnvironment();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writeFile 自动创建父目录，readFile 真实回读", async () => {
    const target = path.join(dir, "src", "deep", "a.txt");
    await env.writeFile(target, "真实内容");
    expect(await env.readFile(target)).toBe("真实内容");
    expect(await fs.readFile(target, "utf-8")).toBe("真实内容");
  });

  it("listDir 返回真实目录项并标注目录", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "f.txt"), "x");
    const entries = await env.listDir(dir);
    expect(entries).toContainEqual({ name: "sub", isDirectory: true });
    expect(entries).toContainEqual({ name: "f.txt", isDirectory: false });
  });

  it("exec 真实执行进程：退出码 0 与 stdout", async () => {
    const result = await env.exec(`"${process.execPath}" -e "console.log(1+1)"`, { cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("2");
  });

  it("exec 真实非零退出码", async () => {
    const result = await env.exec(`"${process.execPath}" -e "process.exit(3)"`, { cwd: dir });
    expect(result.exitCode).toBe(3);
  });

  it("exec 的 cwd 真实生效（子进程工作目录）", async () => {
    const sub = path.join(dir, "workdir");
    await fs.mkdir(sub);
    const result = await env.exec(`"${process.execPath}" -e "console.log(process.cwd())"`, { cwd: sub });
    expect(result.exitCode).toBe(0);
    expect(path.basename(result.stdout.trim())).toBe("workdir");
  });
});
