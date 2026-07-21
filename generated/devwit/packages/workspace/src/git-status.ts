/**
 * Git 状态采集（WU005）：执行真实 `git status --porcelain=v1 --branch`，
 * 解析为结构化结果，供上下文引擎 git_status 源使用。
 * 非 git 仓库 / git 不可用 / 超时均返回 null（不抛错）。
 */
import { execFile } from "node:child_process";

export interface GitChangedFile {
  /** 相对仓库根的路径（rename 取新路径） */
  path: string;
  /** porcelain XY 状态，如 "M"、"A"、"??"、"D"、"R" */
  status: string;
}

export interface GitStatusResult {
  branch: string;
  changed: GitChangedFile[];
}

const GIT_TIMEOUT_MS = 5000;

export function getGitStatus(root: string): Promise<GitStatusResult | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "--branch"],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // 非 git 仓库（exit 128）、git 不存在、超时
          resolve(null);
          return;
        }
        resolve(parsePorcelain(stdout));
      }
    );
  });
}

function parsePorcelain(stdout: string): GitStatusResult {
  let branch = "";
  const changed: GitChangedFile[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("##")) {
      branch = parseBranch(line.slice(2).trim());
      continue;
    }
    const xy = line.slice(0, 2).trim();
    let file = line.slice(3);
    const renameIdx = file.indexOf(" -> ");
    if (renameIdx >= 0) {
      file = file.slice(renameIdx + 4);
    }
    changed.push({ path: file, status: xy.length > 0 ? xy : "?" });
  }
  return { branch, changed };
}

function parseBranch(header: string): string {
  const noCommits = "No commits yet on ";
  if (header.startsWith(noCommits)) {
    return header.slice(noCommits.length).trim();
  }
  // "main...origin/main" / "main" / "HEAD (no branch)"
  const dotIdx = header.indexOf("...");
  return (dotIdx >= 0 ? header.slice(0, dotIdx) : header).trim();
}
