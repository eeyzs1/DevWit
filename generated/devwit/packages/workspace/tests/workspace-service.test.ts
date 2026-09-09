import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "../src/workspace-service.js";

describe("WorkspaceService", () => {
  let root: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-ws-"));
    fs.writeFileSync(path.join(root, "hello.txt"), "hello world");
    service = new WorkspaceService();
    await service.openRoot(root);
  });

  afterEach(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("openRoot 校验目录存在性", async () => {
    const s2 = new WorkspaceService();
    await expect(s2.openRoot(path.join(root, "not-exist"))).rejects.toThrow(/not a directory/);
    await expect(s2.openRoot(path.join(root, "hello.txt"))).rejects.toThrow(/not a directory/);
  });

  it("readFile/writeFile 往返一致", async () => {
    const content = await service.readFile("hello.txt");
    expect(content).toBe("hello world");
    await service.writeFile("sub/new.txt", "新内容 utf-8");
    const back = await service.readFile("sub/new.txt");
    expect(back).toBe("新内容 utf-8");
    // 绝对路径（root 内）也允许
    await service.writeFile(path.join(root, "abs.txt"), "abs");
    expect(await service.readFile("abs.txt")).toBe("abs");
  });

  it("路径逃逸被拒绝", async () => {
    await expect(service.writeFile("../evil.txt", "x")).rejects.toThrow(/escapes workspace root/);
    await expect(service.readFile("../../etc/passwd")).rejects.toThrow(/escapes workspace root/);
    expect(fs.existsSync(path.join(root, "..", "evil.txt"))).toBe(false);
  });

  it("未打开 root 时读写抛错", async () => {
    const s2 = new WorkspaceService();
    await expect(s2.readFile("a.txt")).rejects.toThrow(/No workspace root open/);
  });

  // --- 符号链接逃逸防护（🔴修复回归） ---
  // Windows 创建文件 symlink 需开发者模式/管理员：探测失败则跳过（CI 与本地均可重复）
  const maybeSymlink = (target: string, linkPath: string, type?: fs.symlink.Type): string | null => {
    try {
      fs.symlinkSync(target, linkPath, type);
      return linkPath;
    } catch {
      return null;
    }
  };

  it("root 内指向外部的文件 symlink：readFile/writeFile 均被拒绝", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-out-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
      const link = maybeSymlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"), "file");
      if (link === null) return; // 平台不允许创建文件 symlink：跳过
      await expect(service.readFile("leak.txt")).rejects.toThrow(/escapes workspace root/);
      await expect(service.writeFile("leak.txt", "篡改")).rejects.toThrow(/escapes workspace root/);
      expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf-8")).toBe("TOP SECRET");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("root 内指向外部的目录 junction/symlink：经其读写均被拒绝", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-outdir-"));
    try {
      fs.writeFileSync(path.join(outside, "data.txt"), "OUT");
      // Windows junction 无需特权；POSIX 用 dir symlink——两者 realpath 语义一致
      const link =
        maybeSymlink(outside, path.join(root, "linkdir"), process.platform === "win32" ? "junction" : "dir") ??
        maybeSymlink(outside, path.join(root, "linkdir"), "dir");
      if (link === null) return;
      await expect(service.readFile(path.join("linkdir", "data.txt"))).rejects.toThrow(/escapes workspace root/);
      await expect(service.writeFile(path.join("linkdir", "new.txt"), "x")).rejects.toThrow(/escapes workspace root/);
      expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("symlink 防护不影响正常路径：新建多级目录文件与 root 经 symlink 打开均正常", async () => {
    // 新建文件的祖先不存在——realpath 上溯到 root 判定，仍允许
    await service.writeFile("brand/new/deep/file.txt", "ok");
    expect(await service.readFile("brand/new/deep/file.txt")).toBe("ok");

    // root 自身经 symlink 打开（rootReal 解析）不破坏正常读写
    const link = maybeSymlink(root, path.join(root, "self-link"), "dir");
    if (link === null) return;
    const s2 = new WorkspaceService();
    await s2.openRoot(link);
    try {
      expect(await s2.readFile("hello.txt")).toBe("hello world");
    } finally {
      s2.close();
    }
  });
});
