/**
 * Git 状态采集（WU005）：执行真实 `git status --porcelain=v1 --branch -z`，
 * 解析为结构化结果，供上下文引擎 git_status 源使用。
 * 非 git 仓库 / git 不可用 / 超时均返回 null（不抛错）。
 *
 * v0.7.16 修复（审查 L6）：改用 `-z`（NUL 分隔）——非 `-z` porcelain 在
 * core.quotePath 默认开启时会把中文等非常规路径输出为 `"\346..."` 八进制
 * 转义（agent 拿到无法使用的路径），含 " -> " 的普通文件名还会被误判 rename。
 * 与 git-service.ts 的 parsePorcelainZ 统一口径。
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
      ["status", "--porcelain=v1", "--branch", "-z"],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // 非 git 仓库（exit 128）、git 不存在、超时
          resolve(null);
          return;
        }
        resolve(parsePorcelainZ(stdout));
      }
    );
  });
}

/** -z porcelain 解析：条目 NUL 分隔；rename/copy 的原路径随行为第二条目。 */
function parsePorcelainZ(stdout: string): GitStatusResult {
  let branch = "";
  const changed: GitChangedFile[] = [];
  const entries = stdout.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] ?? "";
    if (entry === "") {
      continue;
    }
    if (entry.startsWith("##")) {
      branch = parseBranch(entry.slice(2).trim());
      continue;
    }
    const x = entry.charAt(0);
    const y = entry.charAt(1);
    const file = entry.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      i += 1; // 跳过 -z 下随行的原路径条目（path 取新路径）
    }
    const xy = `${x}${y}`.trim();
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
