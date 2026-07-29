import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService, parsePorcelainZ } from "../src/git-service.js";

const hasGit = spawnSync("git", ["--version"], { timeout: 5000 }).status === 0;

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${result.stderr}`);
  }
}

/** 初始化仓库并完成首个提交（user 配置就地注入，不依赖全局环境）。 */
function initRepo(root: string): void {
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@devwit.local"]);
  git(root, ["config", "user.name", "DevWit Test"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nline2\n", "utf-8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
}

describe("parsePorcelainZ（纯解析）", () => {
  it("双列分列：staged/unstaged/untracked 三组", () => {
    const out = parsePorcelainZ(
      "## main...origin/main\0M  staged.txt\0 M work.txt\0MM both.txt\0?? new.txt\0"
    );
    expect(out.branch).toBe("main");
    expect(out.staged).toEqual([
      { path: "staged.txt", status: "M" },
      { path: "both.txt", status: "M" },
    ]);
    expect(out.unstaged).toEqual([
      { path: "work.txt", status: "M" },
      { path: "both.txt", status: "M" },
    ]);
    expect(out.untracked).toEqual([{ path: "new.txt", status: "?" }]);
  });

  it("rename 条目跳过随行原路径", () => {
    const out = parsePorcelainZ("## main\0R  new-name.txt\0old-name.txt\0");
    expect(out.staged).toEqual([{ path: "new-name.txt", status: "R" }]);
    expect(out.unstaged).toEqual([]);
  });

  it("No commits yet 分支头解析", () => {
    const out = parsePorcelainZ("## No commits yet on master\0?? a.txt\0");
    expect(out.branch).toBe("master");
  });
});

describe("GitService（真实 temp 仓库）", () => {
  let root: string;
  let service: GitService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "devwit-gitsvc-"));
    service = new GitService(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("非 git 目录 status 返回 null", async () => {
    expect(await service.status()).toBeNull();
  });

  it("非 git 目录 diffTexts 抛 DW_GIT_NOT_REPO", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "x", "utf-8");
    await expect(service.diffTexts("a.txt")).rejects.toThrow("DW_GIT_NOT_REPO");
  });

  it.skipIf(!hasGit)("status 真实分组：修改/未跟踪/暂存", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nchanged\n", "utf-8");
    fs.writeFileSync(path.join(root, "new.txt"), "new\n", "utf-8");
    git(root, ["add", "new.txt"]);

    const status = await service.status();
    expect(status).not.toBeNull();
    expect(status?.branch.length).toBeGreaterThan(0);
    expect(status?.staged).toEqual([{ path: "new.txt", status: "A" }]);
    expect(status?.unstaged).toEqual([{ path: "tracked.txt", status: "M" }]);
    expect(status?.untracked).toEqual([]);
  });

  it.skipIf(!hasGit)("diffTexts：HEAD 版与工作区版双文本；untracked 原文为空", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nchanged\n", "utf-8");
    const tracked = await service.diffTexts("tracked.txt");
    expect(tracked.original).toBe("line1\nline2\n");
    expect(tracked.modified).toBe("line1\nchanged\n");

    fs.writeFileSync(path.join(root, "untracked.txt"), "fresh\n", "utf-8");
    const untracked = await service.diffTexts("untracked.txt");
    expect(untracked.original).toBe("");
    expect(untracked.modified).toBe("fresh\n");
  });

  it.skipIf(!hasGit)("diffTexts：工作区已删除 → modified 为空串", async () => {
    initRepo(root);
    fs.unlinkSync(path.join(root, "tracked.txt"));
    const deleted = await service.diffTexts("tracked.txt");
    expect(deleted.original).toBe("line1\nline2\n");
    expect(deleted.modified).toBe("");
  });

  it.skipIf(!hasGit)("stage → unstage 往返移动分组", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nchanged\n", "utf-8");

    await service.stage("tracked.txt");
    let status = await service.status();
    expect(status?.staged).toEqual([{ path: "tracked.txt", status: "M" }]);
    expect(status?.unstaged).toEqual([]);

    await service.unstage("tracked.txt");
    status = await service.status();
    expect(status?.staged).toEqual([]);
    expect(status?.unstaged).toEqual([{ path: "tracked.txt", status: "M" }]);
  });

  it.skipIf(!hasGit)("commit 真实落库：提交后工作区干净", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nchanged\n", "utf-8");
    await service.stage("tracked.txt");
    await service.commit("更新 tracked");

    const status = await service.status();
    expect(status?.staged).toEqual([]);
    expect(status?.unstaged).toEqual([]);
    const log = spawnSync("git", ["log", "--oneline", "-1"], { cwd: root, timeout: 5000 });
    expect(log.stdout.toString()).toContain("更新 tracked");
  });

  it.skipIf(!hasGit)("commit 空消息抛 DW_GIT_COMMIT_FAILED", async () => {
    initRepo(root);
    await expect(service.commit("   ")).rejects.toThrow("DW_GIT_COMMIT_FAILED");
  });

  it.skipIf(!hasGit)("commit 无暂存抛 DW_GIT_COMMIT_FAILED", async () => {
    initRepo(root);
    await expect(service.commit("nothing staged")).rejects.toThrow("DW_GIT_COMMIT_FAILED");
  });

  it.skipIf(!hasGit)("log 返回提交历史", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "second.txt"), "2\n", "utf-8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "second commit"]);

    const entries = await service.log(10);
    expect(entries.length).toBe(2);
    expect(entries[0].message).toBe("second commit");
    expect(entries[1].message).toBe("init");
    expect(entries[0].hash).toHaveLength(40);
    expect(entries[0].author).toBe("DevWit Test");
    expect(entries[0].date.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasGit)("log 空仓库返回空数组", async () => {
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@devwit.local"]);
    git(root, ["config", "user.name", "DevWit Test"]);
    const entries = await service.log();
    expect(entries).toEqual([]);
  });

  it.skipIf(!hasGit)("log 非 git 仓库返回空数组", async () => {
    const entries = await service.log();
    expect(entries).toEqual([]);
  });

  it.skipIf(!hasGit)("pull/push 非 git 仓库抛 DW_GIT_NOT_REPO", async () => {
    await expect(service.pull()).rejects.toThrow("DW_GIT_PULL_FAILED");
    await expect(service.push()).rejects.toThrow("DW_GIT_PUSH_FAILED");
  });
});
