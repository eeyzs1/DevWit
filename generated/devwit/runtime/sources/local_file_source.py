#!/usr/bin/env python3
"""
LocalFileSource — DevWit 本地文件 workitem adapter

继承 runtime/workitem_source.py 的 WorkitemSource 基类，实现 4 个抽象方法：
  claim_next(policy)          扫 source_dir/pending/*.yaml，按 policy 选一个，
                              原子移动到 in_progress/，返回 workitem_id（幂等）
  fetch_brief(workitem_id)    只读对应 yaml，返回 title/description/acceptance_criteria/
                              effort/priority/metadata
  update_status(id, status)   在 pending/in_progress/done/blocked 目录间原子移动文件
  archive(id, result, summary) 移到 done/ 并向文件追加 result/summary/archived_at

开发期 DevWit harness 用本地文件驱动 WU001-WU014；后续可换 github_issues adapter
（同一接口，只改 planning/workitem-source.yaml 的 adapter/class_name）。

CLI（手工验证）：
  python runtime/sources/local_file_source.py --source-dir runtime/sources/workitems --list
  python runtime/sources/local_file_source.py --source-dir runtime/sources/workitems --claim priority
  python runtime/sources/local_file_source.py --source-dir runtime/sources/workitems --fetch WU001
  python runtime/sources/local_file_source.py --source-dir runtime/sources/workitems --update WU001 blocked
  python runtime/sources/local_file_source.py --source-dir runtime/sources/workitems --archive WU001 passed "骨架就绪"
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import yaml

# 允许以脚本方式直接运行（python runtime/sources/local_file_source.py ...）
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from runtime.workitem_source import WorkitemSource
else:
    from ..workitem_source import WorkitemSource

VALID_STATUSES = ("pending", "in_progress", "done", "blocked")
_STATUS_ALIASES = {"claimed": "in_progress", "archived": "done"}


class LocalFileSource(WorkitemSource):
    """本地文件 workitem source：一个 .yaml 文件 = 一个 workitem，目录名 = 状态。"""

    def __init__(self, config: dict):
        cfg = config.get("config", config)
        self.source_dir = Path(cfg.get("source_dir", "runtime/sources/workitems/"))
        self.dirs = {
            "pending": self.source_dir / cfg.get("pending_dir", "pending/"),
            "in_progress": self.source_dir / cfg.get("in_progress_dir", "in_progress/"),
            "done": self.source_dir / cfg.get("done_dir", "done/"),
            "blocked": self.source_dir / cfg.get("blocked_dir", "blocked/"),
        }
        for d in self.dirs.values():
            d.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------

    def _find(self, workitem_id: str) -> Optional[Path]:
        """在全部状态目录中定位 <id>.yaml。"""
        for status in VALID_STATUSES:
            p = self.dirs[status] / f"{workitem_id}.yaml"
            if p.exists():
                return p
        return None

    def _status_of(self, path: Path) -> str:
        for status, d in self.dirs.items():
            if path.parent == d:
                return status
        return "unknown"

    @staticmethod
    def _load(path: Path) -> dict:
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    @staticmethod
    def _dump(path: Path, data: dict) -> None:
        with open(path, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)

    @staticmethod
    def _move(src: Path, dst_dir: Path) -> Path:
        """原子移动（同文件系统内 os.replace 是原子的）。"""
        dst = dst_dir / src.name
        os.replace(src, dst)
        return dst

    @staticmethod
    def _priority_key(data: dict, name: str):
        """priority 支持数字（小者优先）或 high/medium/low；缺省按文件名序。"""
        p = data.get("priority")
        if isinstance(p, (int, float)):
            return (0, p, name)
        order = {"high": 1, "medium": 2, "low": 3}
        return (1, order.get(str(p).lower(), 2), name)

    # ------------------------------------------------------------------
    # 抽象方法实现
    # ------------------------------------------------------------------

    def claim_next(self, policy: str = "any") -> Optional[str]:
        """从 pending/ 领一个 workitem，原子移到 in_progress/，返回 id。

        幂等：若某 workitem 已在 in_progress/（本进程此前 claim 过），重复 claim
        不会重复领取——pending 中已无该文件，自然跳过。
        """
        candidates = sorted(self.dirs["pending"].glob("*.yaml"))
        if not candidates:
            return None

        if policy == "fifo":
            chosen = min(candidates, key=lambda p: p.stat().st_mtime)
        elif policy == "priority":
            chosen = min(
                candidates,
                key=lambda p: self._priority_key(self._load(p), p.name),
            )
        elif policy == "critical":
            critical = [
                p for p in candidates
                if str(self._load(p).get("priority", "")).lower() in ("critical", "0")
            ]
            if not critical:
                return None
            chosen = min(critical, key=lambda p: p.name)
        else:  # any
            chosen = candidates[0]

        data = self._load(chosen)
        workitem_id = data.get("id") or chosen.stem
        new_path = self._move(chosen, self.dirs["in_progress"])
        data["status"] = "in_progress"
        data["claimed_at"] = datetime.now(timezone.utc).isoformat()
        self._dump(new_path, data)
        return workitem_id

    def fetch_brief(self, workitem_id: str) -> dict:
        """只读获取 workitem 详情（不改状态）。"""
        path = self._find(workitem_id)
        if path is None:
            raise FileNotFoundError(f"workitem {workitem_id} not found in {self.source_dir}")
        data = self._load(path)
        return {
            "id": data.get("id", workitem_id),
            "title": data.get("title", ""),
            "description": data.get("description", ""),
            "acceptance_criteria": data.get("acceptance_criteria", []),
            "effort": data.get("effort", "M"),
            "priority": data.get("priority", "medium"),
            "metadata": {
                "status": self._status_of(path),
                "path": str(path),
                **(data.get("metadata") or {}),
            },
        }

    def update_status(self, workitem_id: str, status: str) -> None:
        """在 pending/in_progress/done/blocked 之间移动文件。"""
        status = _STATUS_ALIASES.get(status, status)
        if status not in VALID_STATUSES:
            raise ValueError(f"invalid status {status!r}; expected one of {VALID_STATUSES}")
        path = self._find(workitem_id)
        if path is None:
            raise FileNotFoundError(f"workitem {workitem_id} not found in {self.source_dir}")
        if self._status_of(path) == status:
            return  # 幂等 no-op
        new_path = self._move(path, self.dirs[status])
        data = self._load(new_path)
        data["status"] = status
        data["status_updated_at"] = datetime.now(timezone.utc).isoformat()
        self._dump(new_path, data)

    def archive(self, workitem_id: str, result: str, summary: str) -> None:
        """移到 done/ 并追加 result/summary/archived_at。幂等：已归档则跳过。"""
        path = self._find(workitem_id)
        if path is None:
            raise FileNotFoundError(f"workitem {workitem_id} not found in {self.source_dir}")
        if self._status_of(path) == "done":
            return  # 幂等 no-op，不重复写
        new_path = self._move(path, self.dirs["done"])
        data = self._load(new_path)
        data["status"] = "done"
        data["result"] = result
        data["summary"] = summary[:200]
        data["archived_at"] = datetime.now(timezone.utc).isoformat()
        self._dump(new_path, data)

    # ------------------------------------------------------------------
    # 可选 hook
    # ------------------------------------------------------------------

    def list_pending(self, limit: int = 50) -> list:
        """列出待领 workitem id（按 priority 排序）。"""
        candidates = sorted(
            self.dirs["pending"].glob("*.yaml"),
            key=lambda p: self._priority_key(self._load(p), p.name),
        )
        return [self._load(p).get("id") or p.stem for p in candidates[:limit]]


# ============================================================================
# CLI：手工验证 adapter
# ============================================================================

def main() -> int:
    parser = argparse.ArgumentParser(
        description="LocalFileSource workitem adapter CLI（手工验证用）"
    )
    parser.add_argument("--source-dir", required=True, help="workitem 根目录")
    parser.add_argument("--list", action="store_true", help="列出 pending workitem")
    parser.add_argument("--claim", metavar="POLICY", help="按策略领取（fifo/priority/critical/any）")
    parser.add_argument("--fetch", metavar="ID", help="获取 workitem 详情")
    parser.add_argument("--update", nargs=2, metavar=("ID", "STATUS"), help="更新状态")
    parser.add_argument(
        "--archive", nargs=3, metavar=("ID", "RESULT", "SUMMARY"), help="归档 workitem"
    )
    args = parser.parse_args()

    source = LocalFileSource({"config": {"source_dir": args.source_dir}})

    if args.list:
        for wid in source.list_pending():
            print(wid)
        return 0
    if args.claim:
        wid = source.claim_next(args.claim)
        print(wid if wid else "QUEUE_EMPTY")
        return 0
    if args.fetch:
        print(yaml.safe_dump(source.fetch_brief(args.fetch), allow_unicode=True, sort_keys=False))
        return 0
    if args.update:
        source.update_status(args.update[0], args.update[1])
        print(f"{args.update[0]} -> {args.update[1]}")
        return 0
    if args.archive:
        source.archive(args.archive[0], args.archive[1], args.archive[2])
        print(f"{args.archive[0]} archived ({args.archive[1]})")
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
