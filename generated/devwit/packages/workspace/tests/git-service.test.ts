import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService, parseBlamePorcelain, parsePorcelainZ } from "../src/git-service.js";

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

  it("冲突文件（UU/AA/DU）归入 conflicts，不进 staged/unstaged", () => {
    const out = parsePorcelainZ("## main\0UU conflict.txt\0AA both-added.txt\0M  staged.txt\0");
    expect(out.conflicts).toEqual([
      { path: "conflict.txt", status: "UU" },
      { path: "both-added.txt", status: "AA" },
    ]);
    expect(out.staged).toEqual([{ path: "staged.txt", status: "M" }]);
    expect(out.unstaged).toEqual([]);
  });

  it("无冲突时 conflicts 为空数组", () => {
    const out = parsePorcelainZ("## main\0M  a.txt\0");
    expect(out.conflicts).toEqual([]);
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

  // ---- 分支管理（v0.4.0）----
  it.skipIf(!hasGit)("listBranches 非 git 仓库返回空数组", async () => {
    expect(await service.listBranches()).toEqual([]);
  });

  it.skipIf(!hasGit)("listBranches 返回当前分支并标记 current", async () => {
    initRepo(root); // 默认在 main/master
    const branches = await service.listBranches();
    expect(branches.length).toBe(1);
    expect(branches[0]!.current).toBe(true);
    expect(branches[0]!.name.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasGit)("createBranch 不切换：新分支出现在列表但 current 不变", async () => {
    initRepo(root);
    const before = await service.listBranches();
    const original = before.find((b) => b.current)!.name;
    await service.createBranch("feature-a", false);
    const after = await service.listBranches();
    expect(after.map((b) => b.name)).toContain("feature-a");
    const cur = after.find((b) => b.current);
    expect(cur?.name).toBe(original);
  });

  it.skipIf(!hasGit)("createBranch 切换：新分支成为 current", async () => {
    initRepo(root);
    await service.createBranch("feature-b", true);
    const branches = await service.listBranches();
    const cur = branches.find((b) => b.current);
    expect(cur?.name).toBe("feature-b");
  });

  it.skipIf(!hasGit)("createBranch 重名抛 DW_GIT_CREATE_BRANCH_FAILED", async () => {
    initRepo(root);
    const original = (await service.listBranches()).find((b) => b.current)!.name;
    await expect(service.createBranch(original, false)).rejects.toThrow("DW_GIT_CREATE_BRANCH_FAILED");
  });

  it.skipIf(!hasGit)("checkout 切换到已有分支", async () => {
    initRepo(root);
    await service.createBranch("feature-c", false);
    // 当前仍是原始分支
    const beforeCur = (await service.listBranches()).find((b) => b.current);
    expect(beforeCur?.name).not.toBe("feature-c");
    await service.checkout("feature-c");
    const afterCur = (await service.listBranches()).find((b) => b.current);
    expect(afterCur?.name).toBe("feature-c");
  });

  it.skipIf(!hasGit)("checkout 不存在的分支抛 DW_GIT_CHECKOUT_FAILED", async () => {
    initRepo(root);
    await expect(service.checkout("nonexistent-branch")).rejects.toThrow("DW_GIT_CHECKOUT_FAILED");
  });

  it.skipIf(!hasGit)("deleteBranch 删除已合并分支", async () => {
    initRepo(root);
    await service.createBranch("to-delete", false);
    expect((await service.listBranches()).map((b) => b.name)).toContain("to-delete");
    await service.deleteBranch("to-delete");
    expect((await service.listBranches()).map((b) => b.name)).not.toContain("to-delete");
  });

  it.skipIf(!hasGit)("deleteBranch 删除当前分支抛 DW_GIT_DELETE_BRANCH_FAILED", async () => {
    initRepo(root);
    const current = (await service.listBranches()).find((b) => b.current)!.name;
    await expect(service.deleteBranch(current)).rejects.toThrow("DW_GIT_DELETE_BRANCH_FAILED");
  });

  it.skipIf(!hasGit)("deleteBranch 删除不存在的分支抛 DW_GIT_DELETE_BRANCH_FAILED", async () => {
    initRepo(root);
    await expect(service.deleteBranch("no-such-branch")).rejects.toThrow("DW_GIT_DELETE_BRANCH_FAILED");
  });

  // ---- Stash（v0.4.0）----
  it.skipIf(!hasGit)("listStash 非 git 仓库返回空数组", async () => {
    expect(await service.listStash()).toEqual([]);
  });

  it.skipIf(!hasGit)("listStash 无暂存返回空数组", async () => {
    initRepo(root);
    expect(await service.listStash()).toEqual([]);
  });

  it.skipIf(!hasGit)("stashPush + listStash 返回暂存项", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n", "utf-8");
    await service.stashPush("my stash");
    const entries = await service.listStash();
    expect(entries.length).toBe(1);
    expect(entries[0]!.index).toBe(0);
    expect(entries[0]!.message).toContain("my stash");
  });

  it.skipIf(!hasGit)("stashPop 恢复变更并清空暂存", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n", "utf-8");
    await service.stashPush("test pop");
    // 暂存后工作区应干净
    let status = await service.status();
    expect(status?.unstaged).toEqual([]);
    // pop 恢复变更
    await service.stashPop(0);
    status = await service.status();
    expect(status?.unstaged.length).toBe(1);
    // 暂存列表应空
    expect(await service.listStash()).toEqual([]);
  });

  it.skipIf(!hasGit)("stashApply 恢复变更但保留暂存", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n", "utf-8");
    await service.stashPush("test apply");
    await service.stashApply(0);
    // apply 后暂存仍存在
    expect((await service.listStash()).length).toBe(1);
    // 工作区恢复变更
    const status = await service.status();
    expect(status?.unstaged.length).toBe(1);
  });

  it.skipIf(!hasGit)("stashDrop 删除指定暂存", async () => {
    initRepo(root);
    // 用已跟踪文件的修改触发 stash（untracked 默认不入 stash）
    fs.writeFileSync(path.join(root, "tracked.txt"), "change1\n", "utf-8");
    await service.stashPush("first");
    fs.writeFileSync(path.join(root, "tracked.txt"), "change2\n", "utf-8");
    await service.stashPush("second");
    expect((await service.listStash()).length).toBe(2);
    await service.stashDrop(0);
    expect((await service.listStash()).length).toBe(1);
  });

  it.skipIf(!hasGit)("stashPop 不存在的索引抛 DW_GIT_STASH_FAILED", async () => {
    initRepo(root);
    await expect(service.stashPop(99)).rejects.toThrow("DW_GIT_STASH_FAILED");
  });

  // ---- Blame（v0.4.0）----
  it.skipIf(!hasGit)("blame 非 git 仓库返回空数组", async () => {
    fs.writeFileSync(path.join(root, "a.txt"), "x\n", "utf-8");
    expect(await service.blame("a.txt")).toEqual([]);
  });

  it.skipIf(!hasGit)("blame 返回逐行注解", async () => {
    initRepo(root);
    const entries = await service.blame("tracked.txt");
    expect(entries.length).toBe(2); // tracked.txt = line1\nline2\n
    expect(entries[0]!.line).toBe(1);
    expect(entries[1]!.line).toBe(2);
    expect(entries[0]!.hash).toHaveLength(7);
    expect(entries[0]!.author).toBe("DevWit Test");
    expect(entries[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entries[0]!.summary).toBe("init");
  });

  it.skipIf(!hasGit)("blame 未跟踪文件返回空数组", async () => {
    initRepo(root);
    fs.writeFileSync(path.join(root, "new.txt"), "new\n", "utf-8");
    expect(await service.blame("new.txt")).toEqual([]);
  });

  it.skipIf(!hasGit)("resolveConflict ours：保留当前分支版本并标记已解决", async () => {
    initRepo(root);
    const defaultBranch = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root, timeout: 5000 }).stdout.toString().trim();
    // 创建分支 feature 并修改同一行
    git(root, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nfeature-branch\nline3\n", "utf-8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feature change"]);
    // 回到默认分支修改同一行
    git(root, ["checkout", defaultBranch]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nmain-branch\nline3\n", "utf-8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main change"]);
    // merge feature → 冲突（退出码非零，用 spawnSync 忽略）
    spawnSync("git", ["merge", "feature"], { cwd: root, timeout: 10_000 });
    // status 应含 conflicts
    const status = await service.status();
    expect(status).not.toBeNull();
    expect(status!.conflicts.length).toBe(1);
    expect(status!.conflicts[0]!.path).toBe("tracked.txt");
    // resolveConflict ours → 保留 main 版本
    await service.resolveConflict("tracked.txt", "ours");
    const content = fs.readFileSync(path.join(root, "tracked.txt"), "utf-8");
    expect(content).toContain("main-branch");
    expect(content).not.toContain("feature-branch");
    expect(content).not.toContain("<<<<<<<");
    // 冲突已解决（不再出现在 conflicts）
    const after = await service.status();
    expect(after!.conflicts.length).toBe(0);
  });

  it.skipIf(!hasGit)("resolveConflict theirs：保留传入分支版本", async () => {
    initRepo(root);
    const defaultBranch = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root, timeout: 5000 }).stdout.toString().trim();
    git(root, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nfeature-branch\nline3\n", "utf-8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feature change"]);
    git(root, ["checkout", defaultBranch]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nmain-branch\nline3\n", "utf-8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main change"]);
    spawnSync("git", ["merge", "feature"], { cwd: root, timeout: 10_000 });
    await service.resolveConflict("tracked.txt", "theirs");
    const content = fs.readFileSync(path.join(root, "tracked.txt"), "utf-8");
    expect(content).toContain("feature-branch");
    expect(content).not.toContain("main-branch");
    expect(content).not.toContain("<<<<<<<");
  });

  it.skipIf(!hasGit)("resolveConflict manual：标记已解决（保留手动编辑内容）", async () => {
    initRepo(root);
    const defaultBranch = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root, timeout: 5000 }).stdout.toString().trim();
    git(root, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nfeature-branch\nline3\n", "utf-8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feature change"]);
    git(root, ["checkout", defaultBranch]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nmain-branch\nline3\n", "utf-8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "main change"]);
    spawnSync("git", ["merge", "feature"], { cwd: root, timeout: 10_000 });
    // 手动编辑文件（移除冲突标记）
    fs.writeFileSync(path.join(root, "tracked.txt"), "line1\nresolved-manually\nline3\n", "utf-8");
    await service.resolveConflict("tracked.txt", "manual");
    const after = await service.status();
    expect(after!.conflicts.length).toBe(0);
    // tracked.txt 应在 staged（已 add）
    expect(after!.staged.some((s) => s.path === "tracked.txt")).toBe(true);
  });
});

describe("parseBlamePorcelain（纯解析）", () => {
  it("解析单行 blame 输出", () => {
    const out = [
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 1 1 1",
      "author Alice",
      "author-mail <alice@example.com>",
      "author-time 1700000000",
      "summary init commit",
      "\tline1 content",
    ].join("\n");
    const result = parseBlamePorcelain(out);
    expect(result.length).toBe(1);
    expect(result[0]!.line).toBe(1);
    expect(result[0]!.hash).toBe("a1b2c3d");
    expect(result[0]!.author).toBe("Alice");
    expect(result[0]!.summary).toBe("init commit");
  });

  it("解析多行 blame 输出", () => {
    const out = [
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 1 1 1",
      "author Alice",
      "author-time 1700000000",
      "summary init",
      "\tline1",
      "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3 2 2 1",
      "author Bob",
      "author-time 1700000100",
      "summary fix",
      "\tline2",
    ].join("\n");
    const result = parseBlamePorcelain(out);
    expect(result.length).toBe(2);
    expect(result[0]!.author).toBe("Alice");
    expect(result[1]!.author).toBe("Bob");
    expect(result[1]!.line).toBe(2);
  });
});
