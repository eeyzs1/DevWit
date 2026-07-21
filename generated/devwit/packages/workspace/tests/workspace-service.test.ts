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
});
