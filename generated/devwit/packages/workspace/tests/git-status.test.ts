import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitStatus } from "../src/git-status.js";

const hasGit = spawnSync("git", ["--version"], { timeout: 5000 }).status === 0;

describe("getGitStatus", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-git-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("非 git 目录返回 null", async () => {
    const result = await getGitStatus(root);
    expect(result).toBeNull();
  });

  it.skipIf(!hasGit)("真实 git 仓库解析 branch 与变更文件", async () => {
    const init = spawnSync("git", ["init"], { cwd: root, timeout: 5000 });
    expect(init.status).toBe(0);
    fs.writeFileSync(path.join(root, "untracked.txt"), "x");
    const result = await getGitStatus(root);
    expect(result).not.toBeNull();
    expect(result?.branch.length).toBeGreaterThan(0);
    const untracked = result?.changed.find((c) => c.path === "untracked.txt");
    expect(untracked?.status).toBe("??");
  });
});
