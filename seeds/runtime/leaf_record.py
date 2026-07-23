#!/usr/bin/env python3
"""
Leaf Record — result.json → events 流（domain-agnostic 通用原语）

leaf helper 完成 work 后写 result.json，本脚本：
  1. 校验 result.json schema（复用 leaf_protocol.validate_result）
  2. 把 result 转成 events（append-only，append 到 .meta-harness/events/events.jsonl）
  3. 触发后续 hook（如更新 session-state、写 audit log）

为什么是 append-only events 流而非 update 状态文件：
  - events 是真相源（任何状态可从 events 重放重建）
  - append 天然幂等（重复 record 同 result 应去重，不重复写）
  - 与 audit-append.py 模式一致：日志不可篡改

events schema：
  {
    "ts": "ISO",
    "type": "leaf_result",     # leaf_result / supervisor_dispatch / supervisor_stop / worktree_acquire / ...
    "workitem_id": "...",
    "work_unit_id": "...",
    "prototype": "...",
    "gate": "...",
    "verdict": "pass|fail|blocked|deferred",
    "changed_files": [...],
    "evidence": [...],
    "next_required_action": "...",
    "result_ref": "path/to/result.json"   # 指回原文件
  }

退出码：0 = recorded；1 = result.json 无效

Usage:
  python runtime/leaf_record.py \\
      --result result.json \\
      --workitem-id CCTT-123 \\
      --work-unit-id WU001 \\
      --prototype explorer \\
      --gate pre-implement
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from leaf_protocol import read_result, validate_result
except ImportError:
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "leaf_protocol", Path(__file__).resolve().parent / "leaf_protocol.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    read_result = mod.read_result
    validate_result = mod.validate_result


EVENTS_DIR = Path(".meta-harness") / "events"
EVENTS_FILE = EVENTS_DIR / "events.jsonl"


def _ensure_events_dir(project_root: Path) -> Path:
    events_dir = project_root / EVENTS_DIR
    events_dir.mkdir(parents=True, exist_ok=True)
    return events_dir / EVENTS_FILE.name


def _event_hash(prev_hash: str, payload: dict) -> str:
    """events 哈希链（与 audit-append.py 同公式）。"""
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256((prev_hash + canonical).encode("utf-8")).hexdigest()


def _read_last_hash(events_file: Path) -> str:
    """读最后一条 event 的 hash 字段，作为下一条 prev_hash。"""
    if not events_file.exists():
        return ""
    last_hash = ""
    try:
        with open(events_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                    last_hash = evt.get("hash", "")
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return last_hash


def _is_duplicate(events_file: Path, workitem_id: str, work_unit_id: str,
                  prototype: str, gate: str, result_ref: str) -> bool:
    """幂等检查：同 workitem+work_unit+prototype+gate+result_ref 已 record 过则跳过。"""
    if not events_file.exists():
        return False
    try:
        with open(events_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                    if (evt.get("workitem_id") == workitem_id
                        and evt.get("work_unit_id") == work_unit_id
                        and evt.get("prototype") == prototype
                        and evt.get("gate") == gate
                        and evt.get("result_ref") == result_ref):
                        return True
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return False


def record(project_root: Path, result_path: Path, workitem_id: str,
           work_unit_id: str, prototype: str, gate: str) -> dict:
    """把 result.json 转 event 写入 events 流。

    Returns:
      {"recorded": bool, "event_hash": str, "duplicate": bool}
    """
    result = read_result(result_path)
    if "_parse_error" in result or "_schema_errors" in result:
        raise ValueError(f"invalid result.json: {result}")

    events_file = _ensure_events_dir(project_root)

    # 幂等检查
    result_ref = str(result_path.resolve())
    if _is_duplicate(events_file, workitem_id, work_unit_id, prototype, gate, result_ref):
        return {"recorded": False, "duplicate": True, "event_hash": ""}

    prev_hash = _read_last_hash(events_file)
    payload = {
        "ts": datetime.now().isoformat(),
        "type": "leaf_result",
        "workitem_id": workitem_id,
        "work_unit_id": work_unit_id,
        "prototype": prototype,
        "gate": gate,
        "verdict": result.get("verdict"),
        "changed_files": result.get("changed_files", []),
        "evidence": result.get("evidence", []),
        "next_required_action": result.get("next_required_action"),
        "result_ref": result_ref,
    }
    new_hash = _event_hash(prev_hash, payload)
    event = {"prev_hash": prev_hash, "hash": new_hash, **payload}

    with open(events_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")

    return {"recorded": True, "duplicate": False, "event_hash": new_hash}


def main():
    ap = argparse.ArgumentParser(description="Record leaf result.json to events stream")
    ap.add_argument("--project-root", required=True)
    ap.add_argument("--result", required=True)
    ap.add_argument("--workitem-id", required=True)
    ap.add_argument("--work-unit-id", required=True)
    ap.add_argument("--prototype", required=True)
    ap.add_argument("--gate", required=True)
    args = ap.parse_args()

    result = record(
        Path(args.project_root), Path(args.result),
        args.workitem_id, args.work_unit_id, args.prototype, args.gate,
    )
    print(yaml.dump(result, default_flow_style=False, allow_unicode=True))
    sys.exit(0 if result["recorded"] or result["duplicate"] else 1)


if __name__ == "__main__":
    main()
