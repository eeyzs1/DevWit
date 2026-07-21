#!/usr/bin/env python3
"""
Worktree Lifecycle — worktree 资源管理（domain-agnostic 通用原语）

参考 autodev/worktree-lifecycle.sh 的设计但用 Python 重写，跨平台（Windows + POSIX）。

核心契约：
  - acquire(workitem_id)  → 分配 worktree（幂等：同 id 重复 acquire 返回同一路径）
  - release(workitem_id, prune=False, keep_branch=False)
  - list_allocations()     → 所有分配（workitem → worktree → branch）
  - path_of(workitem_id)   → 查路径
  - refresh(workitem_id)   → 更新 heartbeat + git 状态
  - rebalance()            → 检测 orphan worktree（分配记录丢失的）

为什么这样设计：
  - "acquire/release" 比 "create/delete" 语义更准确——worktree 是资源池
  - 分配记录存 alloc.json（单一真相源），与 git worktree list 双向校验
  - rebalance 解决"分配记录丢失但 worktree 还在"的僵尸状态（系统崩溃 / kill -9）

状态文件：
  .meta-harness/worktrees/
    ├── alloc.json              # workitem → worktree → branch 映射
    ├── <branch-name>/          # 实际 worktree 目录
    │   └── .alloc-meta.json    # 分配元数据（workitem_id / acquired_at / heartbeat）
    └── orphan/                 # rebalance 检测到的孤儿（不删，留给人工 triage）

alloc.json schema：
  {
    "allocations": {
      "<workitem_id>": {
        "worktree_path": "...",
        "branch": "feature/cctt-<id>",
        "acquired_at": "ISO",
        "last_heartbeat": "ISO",
        "git_status": "clean|dirty"
      }
    },
    "pool": {
      "pre_created": [...],     # 预创建的 worktree 池（claim 时优先取）
      "max_pool_size": 5
    }
  }

退出码：0 = 成功；1 = 失败（alloc 记录冲突 / git 错误）

Usage:
  # CLI 模式（supervisor 调用）
  python runtime/worktree_lifecycle.py acquire --workitem-id CCTT-123
  python runtime/worktree_lifecycle.py release --workitem-id CCTT-123 --prune
  python runtime/worktree_lifecycle.py list --format json
  python runtime/worktree_lifecycle.py rebalance

  # 库模式
  from runtime.worktree_lifecycle import WorktreeLifecycle
  lc = WorktreeLifecycle(project_root=Path("."))
  wt_path = lc.acquire("CCTT-123")
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


class WorktreeLifecycle:
    """worktree 资源管理器。每个生成的 harness 实例化一个。"""

    def __init__(self, project_root: Path, worktree_dir: Optional[Path] = None):
        self.project_root = project_root.resolve()
        # worktree 集中存放目录（project-yaml-template.runtime.worktree_dir）
        self.worktree_dir = (worktree_dir or self.project_root / ".meta-harness" / "worktrees").resolve()
        self.worktree_dir.mkdir(parents=True, exist_ok=True)
        self.alloc_file = self.worktree_dir / "alloc.json"
        self._ensure_alloc_file()

    def _ensure_alloc_file(self) -> None:
        if not self.alloc_file.exists():
            self._write_alloc({"allocations": {}, "pool": {"pre_created": [], "max_pool_size": 5}})

    def _read_alloc(self) -> dict:
        try:
            return json.loads(self.alloc_file.read_text(encoding="utf-8"))
        except Exception:
            return {"allocations": {}, "pool": {"pre_created": [], "max_pool_size": 5}}

    def _write_alloc(self, data: dict) -> None:
        self.alloc_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    # ---- git worktree 操作（跨平台）----

    def _git(self, *args: str, cwd: Optional[Path] = None) -> str:
        """执行 git 命令，返回 stdout。失败抛 CalledProcessError 让调用方决定。"""
        cmd = ["git"] + list(args)
        result = subprocess.run(
            cmd, cwd=cwd or self.project_root,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
        return result.stdout.strip()

    def _branch_name_for(self, workitem_id: str, branch_prefix: str = "feature") -> str:
        """生成 branch 名。LLM 在 workitem-source.yaml 可配 branch_prefix。"""
        # 简单清洗：去掉非字母数字下划线连字符
        safe_id = "".join(c if c.isalnum() or c in "-_" else "-" for c in workitem_id)
        return f"{branch_prefix}/{safe_id}"

    def _ensure_git_repo(self) -> None:
        """确保 project_root 是 git 仓库（含至少一个 commit，否则 worktree add 失败）。

        首次 acquire 时自动初始化——让 generated harness 即开即用，不要求用户先 git init。
        已是 git 仓库且有 commit 时为 no-op。
        """
        has_head = False
        if (self.project_root / ".git").exists():
            try:
                self._git("rev-parse", "HEAD")
                has_head = True
            except RuntimeError:
                pass  # 仓库存在但无 commit
        if not has_head:
            try:
                self._git("-c", "init.defaultBranch=main", "init")
            except RuntimeError as e:
                raise RuntimeError(
                    f"project_root is not a git repo and git init failed: {e}")
            # baseline commit（worktree add 需要 HEAD 存在）
            keep = self.project_root / ".gitkeep"
            if not keep.exists():
                keep.write_text(
                    "initialized by worktree_lifecycle (runtime primitive)\n",
                    encoding="utf-8")
            try:
                self._git("add", ".gitkeep")
                self._git("-c", "user.email=runtime@meta-harness",
                          "-c", "user.name=runtime",
                          "commit", "-m",
                          "initial baseline (auto-created by worktree_lifecycle)")
            except RuntimeError:
                pass  # 可能已有 commit 或 nothing to commit

    # ---- 核心 API ----

    def acquire(self, workitem_id: str, branch_prefix: str = "feature",
                reuse: bool = True) -> Path:
        """为 workitem 分配 worktree。

        幂等：同 workitem_id 已分配则返回原路径（不创建新 worktree）。
        Args:
          reuse: True=已存在则复用；False=已存在则报错（防止误用）

        Returns:
          worktree 路径（Path）
        """
        self._ensure_git_repo()
        alloc = self._read_alloc()
        if workitem_id in alloc["allocations"]:
            if not reuse:
                raise RuntimeError(f"workitem {workitem_id} already allocated")
            wt_path = Path(alloc["allocations"][workitem_id]["worktree_path"])
            if wt_path.exists():
                return wt_path
            # alloc 有但目录没了——清理重分
            del alloc["allocations"][workitem_id]
            self._write_alloc(alloc)

        branch = self._branch_name_for(workitem_id, branch_prefix)
        wt_path = self.worktree_dir / branch.replace("/", "-")

        # 用 git worktree add 创建（-b 新分支 / checkout 现有）
        try:
            # 优先从 pool 取（预创建 worktree 复用机制）
            if alloc["pool"].get("pre_created"):
                pool_wt = Path(alloc["pool"]["pre_created"].pop(0))
                if pool_wt.exists():
                    # 把 pool worktree 移到目标位置
                    pool_wt.rename(wt_path)
                self._write_alloc(alloc)
            self._git("worktree", "add", "-b", branch, str(wt_path))
        except RuntimeError as e:
            # 分支已存在但 worktree 没了——尝试 detach 重建
            if "already exists" in str(e):
                self._git("worktree", "add", str(wt_path), branch)
            else:
                raise

        # 写分配记录
        alloc = self._read_alloc()
        alloc["allocations"][workitem_id] = {
            "worktree_path": str(wt_path),
            "branch": branch,
            "acquired_at": datetime.now().isoformat(),
            "last_heartbeat": datetime.now().isoformat(),
            "git_status": "clean",
        }
        self._write_alloc(alloc)

        # 写 worktree 内的元数据文件（rebalance 用）
        meta_file = wt_path / ".alloc-meta.json"
        meta_file.write_text(json.dumps({
            "workitem_id": workitem_id,
            "branch": branch,
            "acquired_at": alloc["allocations"][workitem_id]["acquired_at"],
        }, indent=2), encoding="utf-8")

        return wt_path

    def release(self, workitem_id: str, prune: bool = False,
                keep_branch: bool = False) -> None:
        """释放 worktree。

        Args:
          prune: True=删除 worktree 目录（破坏性）；False=保留目录但解分配
          keep_branch: True=保留 git 分支（供后续合并）；False=删分支
        """
        alloc = self._read_alloc()
        entry = alloc["allocations"].get(workitem_id)
        if not entry:
            return  # 幂等：未分配则 no-op

        wt_path = Path(entry["worktree_path"])
        branch = entry["branch"]

        if prune and wt_path.exists():
            try:
                self._git("worktree", "remove", str(wt_path), "--force")
            except RuntimeError as e:
                # worktree 脏或被占——记录 orphan，不阻塞 release
                sys.stderr.write(f"WARN: cannot prune worktree {wt_path}: {e}\n")
        elif wt_path.exists():
            # 不删目录，但标记为已释放
            (wt_path / ".alloc-released.json").write_text(json.dumps({
                "released_at": datetime.now().isoformat(),
                "workitem_id": workitem_id,
            }, indent=2), encoding="utf-8")

        if not keep_branch:
            try:
                self._git("branch", "-D", branch)
            except RuntimeError as e:
                sys.stderr.write(f"WARN: cannot delete branch {branch}: {e}\n")

        del alloc["allocations"][workitem_id]
        self._write_alloc(alloc)

    def list_allocations(self, fmt: str = "table") -> str:
        """列出所有分配。fmt: table / json / lines."""
        alloc = self._read_alloc()
        allocations = alloc["allocations"]
        if fmt == "json":
            return json.dumps(allocations, indent=2, ensure_ascii=False)
        if fmt == "lines":
            return "\n".join(
                f"{wid}\t{e['worktree_path']}\t{e['branch']}"
                for wid, e in allocations.items()
            )
        # table
        if not allocations:
            return "(no allocations)"
        lines = ["WORKITEM_ID\tBRANCH\t\t\tWORKTREE_PATH\t\tHEARTBEAT"]
        for wid, e in allocations.items():
            lines.append(f"{wid}\t{e['branch']}\t{e['worktree_path']}\t{e.get('last_heartbeat', '?')}")
        return "\n".join(lines)

    def path_of(self, workitem_id: str) -> Optional[Path]:
        """查 workitem 对应的 worktree 路径。未分配返回 None。"""
        alloc = self._read_alloc()
        entry = alloc["allocations"].get(workitem_id)
        return Path(entry["worktree_path"]) if entry else None

    def refresh(self, workitem_id: str) -> None:
        """更新 heartbeat + git 状态。supervisor 每轮循环调一次。"""
        alloc = self._read_alloc()
        entry = alloc["allocations"].get(workitem_id)
        if not entry:
            return
        wt_path = Path(entry["worktree_path"])
        if not wt_path.exists():
            return
        # git 状态
        try:
            status = self._git("status", "--porcelain", cwd=wt_path)
            entry["git_status"] = "dirty" if status.strip() else "clean"
        except RuntimeError:
            entry["git_status"] = "unknown"
        entry["last_heartbeat"] = datetime.now().isoformat()
        self._write_alloc(alloc)

    def rebalance(self) -> dict:
        """检测 orphan worktree（alloc 记录丢失但 worktree 还在的）。

        不删 orphan——移到 orphan/ 目录留人工 triage（可能是崩溃后未清理的）。

        Returns:
          {"orphans_found": int, "orphan_dir": str, "details": [...]}
        """
        alloc = self._read_alloc()
        allocated_paths = {Path(e["worktree_path"]).resolve()
                          for e in alloc["allocations"].values()}

        orphans = []
        for wt in self.worktree_dir.iterdir():
            if not wt.is_dir():
                continue
            if wt.name == "orphan":
                continue
            if wt.resolve() in allocated_paths:
                continue
            # 检查是否是 worktree（含 .alloc-meta.json 或 .git 文件）
            if (wt / ".alloc-meta.json").exists() or (wt / ".git").exists():
                orphans.append(wt)

        orphan_dir = self.worktree_dir / "orphan"
        orphan_dir.mkdir(exist_ok=True)
        moved = []
        for wt in orphans:
            target = orphan_dir / wt.name
            try:
                wt.rename(target)
                moved.append({"from": str(wt), "to": str(target)})
            except OSError as e:
                sys.stderr.write(f"WARN: cannot move orphan {wt}: {e}\n")

        return {
            "orphans_found": len(orphans),
            "orphan_dir": str(orphan_dir),
            "details": moved,
        }

    def ensure_pools(self, n: int) -> None:
        """预创建 n 个 worktree 到 pool（减少 acquire 时的 git 操作延迟）。"""
        alloc = self._read_alloc()
        pool = alloc["pool"]
        current = len(pool.get("pre_created", []))
        needed = max(0, n - current)
        for i in range(needed):
            tmp_branch = f"pool/pre-{datetime.now().strftime('%Y%m%d%H%M%S')}-{i}"
            tmp_path = self.worktree_dir / tmp_branch.replace("/", "-")
            try:
                self._git("worktree", "add", "-b", tmp_branch, str(tmp_path))
                pool.setdefault("pre_created", []).append(str(tmp_path))
            except RuntimeError as e:
                sys.stderr.write(f"WARN: cannot pre-create pool worktree: {e}\n")
                break
        self._write_alloc(alloc)


# ---- CLI ----

def main():
    ap = argparse.ArgumentParser(description="Worktree lifecycle manager")
    ap.add_argument("--project-root", default=".", help="Project root")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_acq = sub.add_parser("acquire", help="Allocate worktree for workitem")
    p_acq.add_argument("--workitem-id", required=True)
    p_acq.add_argument("--branch-prefix", default="feature")

    p_rel = sub.add_parser("release", help="Release worktree")
    p_rel.add_argument("--workitem-id", required=True)
    p_rel.add_argument("--prune", action="store_true", help="Delete worktree dir")
    p_rel.add_argument("--keep-branch", action="store_true", help="Keep git branch")

    p_list = sub.add_parser("list", help="List allocations")
    p_list.add_argument("--format", default="table", choices=["table", "json", "lines"])

    sub.add_parser("rebalance", help="Detect orphan worktrees")
    sub.add_parser("refresh", help="Update heartbeat").add_argument("--workitem-id", required=True)

    args = ap.parse_args()
    lc = WorktreeLifecycle(Path(args.project_root))

    if args.cmd == "acquire":
        wt = lc.acquire(args.workitem_id, args.branch_prefix)
        print(str(wt))
    elif args.cmd == "release":
        lc.release(args.workitem_id, prune=args.prune, keep_branch=args.keep_branch)
        print(f"released {args.workitem_id}")
    elif args.cmd == "list":
        print(lc.list_allocations(args.format))
    elif args.cmd == "rebalance":
        result = lc.rebalance()
        print(yaml.dump(result, default_flow_style=False, allow_unicode=True))
    elif args.cmd == "refresh":
        lc.refresh(args.workitem_id)
        print(f"refreshed {args.workitem_id}")


if __name__ == "__main__":
    main()
