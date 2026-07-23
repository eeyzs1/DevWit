#!/usr/bin/env python3
"""
Rebase Sync — rebase-only 分支同步（domain-agnostic 通用原语）

参考 autodev 的"rebase-only"硬规则：workitem 分支只 rebase 到 base（master/main），
**从不 merge base 到 feature 分支**——从根源上避免 merge 冲突。

为什么 rebase 而非 merge：
  - merge 会产生 merge commit，污染历史
  - merge 冲突需要"merge sub-agent"——而 rebase-only 把冲突推到 workitem 分支
  - workitem 分支 rebase 失败 → 报给 supervisor → 标记 workitem 为 blocked → 人工介入
  - 这比"自动 merge"更安全：让冲突显式化，而非自动解决（自动解决可能丢语义）

合并策略（merge-policy.yaml 决定，本脚本只执行 rebase）：
  - rebase-only（criticality >= 4 默认）：本脚本
  - merge-allowed：调用 git merge（不在本脚本）
  - squash：调用 git merge --squash（不在本脚本）

操作流程：
  1. fetch base（origin/main）
  2. checkout feature branch
  3. rebase origin/main
  4. 若冲突 → 失败，报告冲突文件，supervisor 标 blocked
  5. 若成功 → push --force-with-lease（rebase 改写历史，需 force）

退出码：0 = 同步成功；1 = rebase 冲突 / 失败

Usage:
  python runtime/rebase_sync.py sync \\
      --project-root . \\
      --branch feature/cctt-123 \\
      --base origin/main \\
      --worktree-path /path/to/wt
"""

import argparse
import subprocess
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def _git(*args: str, cwd: Path, capture: bool = True) -> tuple:
    """执行 git 命令，返回 (returncode, stdout, stderr)。"""
    cmd = ["git"] + list(args)
    result = subprocess.run(
        cmd, cwd=cwd, capture_output=capture, text=True,
        encoding="utf-8", errors="replace",
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def _has_remote(remote: str, cwd: Path) -> bool:
    """检查指定 remote 是否存在。"""
    rc, out, _ = _git("remote", cwd=cwd)
    if rc != 0 or not out:
        return False
    return remote in out.split()


def sync(branch: str, base: str, worktree_path: Path,
         push: bool = False) -> dict:
    """rebase feature 分支到 base。

    Args:
      branch: feature 分支名（如 feature/cctt-123）
      base: base 分支（如 origin/main 或 main）
      worktree_path: 该 branch 的 worktree 路径
      push: True=rebase 后 push --force-with-lease

    无 remote 时的 fallback（本地仓库 / 离线场景）：
      - base 形如 "origin/main" 但仓库无 origin → 退化到本地 "main"
      - base 形如 "main"（无 origin/ 前缀）→ 跳过 fetch，直接用本地 ref

    Returns:
      {"ok": bool, "conflicts": [...], "base_sha": ..., "branch_sha": ...}
    """
    # 1. fetch base（仅当 base 是远程引用且 remote 存在时；否则退化到本地 base）
    if "/" in base and base.split("/")[0] == "origin":
        if _has_remote("origin", worktree_path):
            rc, out, err = _git("fetch", "origin", base.split("/", 1)[1],
                                 cwd=worktree_path)
            if rc != 0:
                return {"ok": False, "error": f"fetch failed: {err}", "conflicts": []}
        else:
            # 无 remote → 退化到本地 base（strip origin/ 前缀）
            base = base.split("/", 1)[1]
    # 本地 base：跳过 fetch，直接 rebase 本地 ref

    # 2. 记录 rebase 前 base sha
    rc, base_sha, err = _git("rev-parse", base, cwd=worktree_path)
    if rc != 0:
        return {"ok": False, "error": f"rev-parse base '{base}' failed: {err}",
                "conflicts": []}

    # 3. rebase
    rc, out, err = _git("rebase", base, cwd=worktree_path)
    if rc != 0:
        # 收集冲突文件
        rc2, status, _ = _git("status", "--porcelain", cwd=worktree_path)
        conflicts = [line[3:] for line in status.splitlines()
                     if line.startswith(("UU", "AA", "DD", "AU", "UA", "DU", "UD"))]
        # abort rebase 让 worktree 回到 rebase 前状态
        _git("rebase", "--abort", cwd=worktree_path)
        if conflicts:
            return {
                "ok": False,
                "error": "rebase conflicts",
                "conflicts": conflicts,
                "base_sha": base_sha,
            }
        # 非冲突失败（如 unstaged changes / invalid upstream）——返回真实 git 错误
        return {
            "ok": False,
            "error": f"rebase failed (non-conflict): {err}",
            "conflicts": [],
            "base_sha": base_sha,
        }

    # 4. push（rebase 改写历史，需 force-with-lease；无 remote 时跳过）
    if push and _has_remote("origin", worktree_path):
        rc, out, err = _git("push", "--force-with-lease", "origin", branch,
                            cwd=worktree_path)
        if rc != 0:
            return {"ok": False, "error": f"push failed: {err}", "conflicts": []}

    # 5. 记录 rebase 后 branch sha
    rc, branch_sha, _ = _git("rev-parse", "HEAD", cwd=worktree_path)

    return {
        "ok": True,
        "conflicts": [],
        "base_sha": base_sha,
        "branch_sha": branch_sha,
    }


def main():
    ap = argparse.ArgumentParser(description="Rebase-only sync (no merge commits)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_s = sub.add_parser("sync", help="Rebase feature branch to base")
    p_s.add_argument("--project-root", required=True)
    p_s.add_argument("--branch", required=True)
    p_s.add_argument("--base", default="origin/main")
    p_s.add_argument("--worktree-path", required=True)
    p_s.add_argument("--push", action="store_true", help="Push --force-with-lease after rebase")

    args = ap.parse_args()
    if args.cmd == "sync":
        result = sync(args.branch, args.base, Path(args.worktree_path), push=args.push)
        print(yaml.dump(result, default_flow_style=False, allow_unicode=True))
        sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
