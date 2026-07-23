#!/usr/bin/env python3
"""
Event Stream — append-only 事件流（domain-agnostic 通用原语）

所有 runtime 事件（worktree acquire/release、leaf dispatch、leaf result、
supervisor stop、phase advance、merge）都写到这里。

为什么单独一个 event_stream 模块：
  - leaf_record.py 写 leaf_result 事件
  - supervisor.py 写 dispatch/stop 事件
  - worktree_lifecycle.py 写 acquire/release 事件
  - 都用同一套 schema + 哈希链 + 幂等检查

事件流是真相源：任何状态可从 events 重放重建。session-state.yaml 只是 events 的快照。

events.jsonl schema（每行一个 JSON）：
  {
    "ts": "ISO",
    "type": "leaf_result|supervisor_dispatch|supervisor_stop|worktree_acquire|worktree_release|merge|...",
    "prev_hash": "...",       # 哈希链：上一条的 hash
    "hash": "...",            # 本条 hash
    "<type-specific fields>": ...
  }

退出码：0 = appended；1 = 错误

Usage:
  # 库模式（其他脚本调用）
  from runtime.event_stream import EventStream
  es = EventStream(project_root)
  es.append({"type": "supervisor_stop", "reason": "queue_empty", ...})

  # CLI 模式
  python runtime/event_stream.py append --type supervisor_stop --payload '{"reason":"queue_empty"}'
  python runtime/event_stream.py tail --n 10
  python runtime/event_stream.py verify   # 校验哈希链完整性
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

EVENTS_DIR = Path(".meta-harness") / "events"
EVENTS_FILE = EVENTS_DIR / "events.jsonl"


class EventStream:
    """append-only 事件流 + 哈希链 + 幂等。"""

    def __init__(self, project_root: Path):
        self.project_root = project_root.resolve()
        self.events_dir = self.project_root / EVENTS_DIR
        self.events_dir.mkdir(parents=True, exist_ok=True)
        self.events_file = self.events_dir / EVENTS_FILE.name

    def _read_last_hash(self) -> str:
        if not self.events_file.exists():
            return ""
        last = ""
        try:
            with open(self.events_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        evt = json.loads(line)
                        last = evt.get("hash", "")
                    except json.JSONDecodeError:
                        continue
        except Exception as exc:
            print(f"WARNING: 读取事件流尾哈希失败 {self.events_file}: {exc}", file=sys.stderr)
        return last

    @staticmethod
    def _event_hash(prev_hash: str, payload: dict) -> str:
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256((prev_hash + canonical).encode("utf-8")).hexdigest()

    def append(self, event: dict) -> dict:
        """追加事件。自动加 ts / prev_hash / hash。

        event 必须含 'type' 字段。
        Returns:
          完整事件 dict（含 hash）。
        """
        if "type" not in event:
            raise ValueError("event must have 'type' field")
        prev_hash = self._read_last_hash()
        payload = {"ts": datetime.now().isoformat(), **event}
        new_hash = self._event_hash(prev_hash, payload)
        full_event = {"prev_hash": prev_hash, "hash": new_hash, **payload}
        with open(self.events_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(full_event, ensure_ascii=False) + "\n")
        return full_event

    def tail(self, n: int = 10) -> list:
        """读最后 n 条事件。"""
        if not self.events_file.exists():
            return []
        events = []
        try:
            with open(self.events_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except Exception as exc:
            print(f"WARNING: 读取事件流失败 {self.events_file}: {exc}", file=sys.stderr)
        return events[-n:] if n else events

    def verify_chain(self) -> dict:
        """校验哈希链完整性。"""
        if not self.events_file.exists():
            return {"ok": True, "total": 0, "broken_at": []}
        events = []
        with open(self.events_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        broken_at = []
        prev_hash = ""
        for i, evt in enumerate(events, 1):
            expected = self._event_hash(evt.get("prev_hash", ""), {
                k: v for k, v in evt.items() if k not in ("prev_hash", "hash")
            })
            actual = evt.get("hash", "")
            if actual != expected:
                broken_at.append(i)
            # 也校验 prev_hash 链：本条 prev_hash 应等于上一条 hash
            if i > 1 and evt.get("prev_hash", "") != events[i-2].get("hash", ""):
                broken_at.append(i)
            prev_hash = actual
        return {"ok": len(broken_at) == 0, "total": len(events), "broken_at": broken_at}

    def filter_by(self, **filters) -> list:
        """按字段过滤事件。如 filter_by(type="leaf_result", verdict="fail")。"""
        results = []
        for evt in self.tail(n=0):
            if all(evt.get(k) == v for k, v in filters.items()):
                results.append(evt)
        return results


def main():
    ap = argparse.ArgumentParser(description="Event stream (append-only, hash-chained)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_a = sub.add_parser("append", help="Append event")
    p_a.add_argument("--project-root", required=True)
    p_a.add_argument("--type", required=True)
    p_a.add_argument("--payload", default="{}", help="JSON-encoded extra fields")

    p_t = sub.add_parser("tail", help="Show last N events")
    p_t.add_argument("--project-root", required=True)
    p_t.add_argument("--n", type=int, default=10)

    p_v = sub.add_parser("verify", help="Verify hash chain")
    p_v.add_argument("--project-root", required=True)

    args = ap.parse_args()
    es = EventStream(Path(args.project_root))

    if args.cmd == "append":
        try:
            extra = json.loads(args.payload)
        except json.JSONDecodeError:
            extra = {}
        event = {"type": args.type, **extra}
        full = es.append(event)
        print(yaml.dump(full, default_flow_style=False, allow_unicode=True))
    elif args.cmd == "tail":
        events = es.tail(args.n)
        for evt in events:
            print(json.dumps(evt, ensure_ascii=False))
    elif args.cmd == "verify":
        result = es.verify_chain()
        print(yaml.dump(result, default_flow_style=False, allow_unicode=True))
        sys.exit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
