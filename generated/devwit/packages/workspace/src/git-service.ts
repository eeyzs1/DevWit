/**
 * GitService（迭代 32 / AC41）：主力 IDE 版本控制底座。
 * 真实 git CLI 执行 status/diff/stage/unstage/commit；electron-free（execFile 依赖注入，vitest 可测）。
 * 与 git-status.ts（上下文引擎单行合并状态）并存：本类面向面板——porcelain XY 双列分列，
 * 输出 已暂存/未暂存/未跟踪 三组；非 git 仓库 / git 不可用 / 超时返回 null（不抛错）。
 * 变更类操作（stage/unstage/commit）失败抛 DW_GIT_* ASCII 错误码（渲染端 localizeError 本地化）。
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type GitExecFile = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

/** 面板用单文件变更项（path 相对仓库根，正斜杠；rename 取新路径）。 */
export interface GitFileChange {
  path: string;
  /** porcelain 单列字母：M/A/D/R/C/U/? */
  status: string;
}

export interface GitPanelStatus {
  branch: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
}

/** diff 双文本：original=HEAD 版（untracked 为 ""），modified=工作区版（deleted 为 ""）。 */
export interface GitDiffTexts {
  original: string;
  modified: string;
}

/** git log 单条。 */
export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

const GIT_TIMEOUT_MS = 5000;
const GIT_COMMIT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

function nodeExecFile(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void
): void {
  execFile(file, args, options, (error, stdout, stderr) => {
    callback(error, stdout, stderr);
  });
}

export class GitService {
  constructor(
    private readonly root: string,
    private readonly execImpl: GitExecFile = nodeExecFile
  ) {}

  /** 面板状态快照；非 git 仓库/git 不可用返回 null。 */
  status(): Promise<GitPanelStatus | null> {
    return new Promise((resolve) => {
      this.execImpl(
        "git",
        ["status", "--porcelain=v1", "--branch", "-z"],
        { cwd: this.root, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          resolve(parsePorcelainZ(stdout));
        }
      );
    });
  }

  /**
   * 文件双文本（HEAD ↔ 工作区）。
   * 不在 HEAD（untracked/新增未提交）→ original=""；工作区已删除 → modified=""。
   * 非 git 仓库抛 DW_GIT_NOT_REPO。
   */
  async diffTexts(relPath: string): Promise<GitDiffTexts> {
    const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const original = await this.showHead(normalized);
    let modified = "";
    try {
      modified = await readFile(path.join(this.root, normalized), "utf-8");
    } catch {
      // 工作区已删除（或不可读）→ 空串，diff 呈全删
    }
    return { original: original ?? "", modified };
  }

  /** HEAD 版内容；路径不在 HEAD 或无 HEAD（未提交过）返回 null。 */
  private showHead(relPath: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.execImpl(
        "git",
        ["show", `HEAD:${relPath}`],
        { cwd: this.root, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error) {
            const msg = `${stderr}`;
            if (/exists on disk, but not in|does not exist in|unknown revision|Needed a single revision/i.test(msg)) {
              resolve(null); // 不在 HEAD（含仓库尚无提交）
              return;
            }
            if (/not a git repository/i.test(msg)) {
              reject(new Error("DW_GIT_NOT_REPO"));
              return;
            }
            resolve(null); // 其余异常按无 HEAD 版处理（untracked 同语义）
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  /** git add -- <path>；失败抛 DW_GIT_STAGE_FAILED:<stderr摘要> */
  async stage(relPath: string): Promise<void> {
    await this.runMutating(["add", "--", relPath.replace(/\\/g, "/")], "DW_GIT_STAGE_FAILED");
  }

  /** git restore --staged -- <path>（兼容旧 git 无 restore 时回退 reset HEAD --） */
  async unstage(relPath: string): Promise<void> {
    const normalized = relPath.replace(/\\/g, "/");
    try {
      await this.runMutating(["restore", "--staged", "--", normalized], "DW_GIT_UNSTAGE_FAILED");
    } catch (error) {
      // 旧版 git 无 restore 子命令 → 回退 reset（同样只动 index 不动工作区）
      if (error instanceof Error && /DW_GIT_UNSTAGE_FAILED/.test(error.message)) {
        await this.runMutating(["reset", "HEAD", "--", normalized], "DW_GIT_UNSTAGE_FAILED");
        return;
      }
      throw error;
    }
  }

  /** git commit -m <message>；空消息/无暂存抛 DW_GIT_COMMIT_FAILED:* */
  async commit(message: string): Promise<void> {
    const trimmed = message.trim();
    if (trimmed === "") {
      throw new Error("DW_GIT_COMMIT_FAILED:empty-message");
    }
    await this.runMutating(["commit", "-m", trimmed], "DW_GIT_COMMIT_FAILED", GIT_COMMIT_TIMEOUT_MS);
  }

  /** git pull --no-rebase；失败抛 DW_GIT_PULL_FAILED:* */
  async pull(): Promise<void> {
    await this.runMutating(["pull", "--no-rebase"], "DW_GIT_PULL_FAILED", GIT_COMMIT_TIMEOUT_MS);
  }

  /** git push；失败抛 DW_GIT_PUSH_FAILED:* */
  async push(): Promise<void> {
    await this.runMutating(["push"], "DW_GIT_PUSH_FAILED", GIT_COMMIT_TIMEOUT_MS);
  }

  /** git log --format=%H%x00%s%x00%an%x00%ai；返回最近 limit 条（默认 50）。 */
  log(limit = 50): Promise<GitLogEntry[]> {
    return new Promise((resolve) => {
      this.execImpl(
        "git",
        ["log", `--format=%H%x00%s%x00%an%x00%ai`, `-n`, String(limit)],
        { cwd: this.root, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
        (error, stdout) => {
          if (error) {
            resolve([]);
            return;
          }
          const entries: GitLogEntry[] = [];
          const lines = stdout.split("\n").filter((l) => l.length > 0);
          for (const line of lines) {
            const [hash, message, author, date] = line.split("\0");
            if (hash && message) {
              entries.push({ hash, message, author: author ?? "", date: date ?? "" });
            }
          }
          resolve(entries);
        }
      );
    });
  }

  private runMutating(args: string[], code: string, timeout = GIT_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      this.execImpl("git", args, { cwd: this.root, timeout, maxBuffer: MAX_BUFFER }, (error, _stdout, stderr) => {
        if (error) {
          const detail = `${stderr}`.trim().replace(/\s+/g, " ").slice(0, 60);
          reject(new Error(`${code}:${detail === "" ? "unknown" : detail}`));
          return;
        }
        resolve();
      });
    });
  }
}

/**
 * porcelain v1 -z 解析：NUL 分隔条目，XY 双列分列。
 * X=index（暂存区）状态，Y=worktree 状态；"??"=未跟踪。
 * rename/copy 条目格式 "XY new\0old\0"（-z 下新路径在前）。
 */
export function parsePorcelainZ(stdout: string): GitPanelStatus {
  const result: GitPanelStatus = { branch: "", staged: [], unstaged: [], untracked: [] };
  const entries = stdout.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? "";
    if (entry === "") {
      continue;
    }
    if (entry.startsWith("##")) {
      result.branch = parseBranchHeader(entry.slice(2).trim());
      continue;
    }
    const x = entry.charAt(0);
    const y = entry.charAt(1);
    const file = entry.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      i += 1; // 跳过 -z 下随行的原路径条目
    }
    if (x === "?" && y === "?") {
      result.untracked.push({ path: file, status: "?" });
      continue;
    }
    if (x !== " " && x !== "?") {
      result.staged.push({ path: file, status: x });
    }
    if (y !== " " && y !== "?") {
      result.unstaged.push({ path: file, status: y });
    }
  }
  return result;
}

function parseBranchHeader(header: string): string {
  const noCommits = "No commits yet on ";
  if (header.startsWith(noCommits)) {
    return header.slice(noCommits.length).trim();
  }
  const dotIdx = header.indexOf("...");
  return (dotIdx >= 0 ? header.slice(0, dotIdx) : header).trim();
}
