#!/usr/bin/env python3
"""
Audit Log Append —— 不可篡改审计日志的写入端。

被 runtime-hooks.yaml 的 HOOK_AUDIT_LOG_APPEND 调用，把每次工具调用 / hook
事件 / 控制指令追加到 <project-root>/audit_log.yaml。

audit_log 格式（YAML list，每条记录）：
    - seq: 1                          # 单调递增序号
      timestamp: 2026-06-27T...        # ISO8601
      event: tool_call                 # hook 事件名
      check_id: HOOK_GUARD_FILE        # 触发的 check（可选）
      result: PASS                     # PASS / FAIL / BLOCK（可选）
      payload_digest: <sha256>          # payload 内容摘要
      prev_hash: <sha256|genesis>       # 前一条记录的 hash（哈希链）
      hash: <sha256>                    # 本条记录的 hash

哈希链：hash = sha256(prev_hash + seq + timestamp + event + check_id + result + payload_digest)
第一条记录 prev_hash = "0"*64（genesis）。篡改任意记录会断链——dispatch-verifier
与 self-check 可据此检测篡改。

第一性原理分工：
- audit_log 的"格式与哈希链" = 硬约束（本脚本，所有项目共享）
- audit_log 的"内容" = 项目运行时产物（本脚本只追加，不生成）

Usage:
    python verification/audit-append.py --project-root <dir> \\
        --event tool_call --payload '{"tool":"write","path":"src/x.py"}' \\
        [--check-id HOOK_GUARD_FILE] [--result PASS]
"""

import argparse
import hashlib
import sys
from datetime import datetime
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

GENESIS_HASH = "0" * 64
AUDIT_LOG_NAME = "audit_log.yaml"


def compute_record_hash(prev_hash: str, seq: int, timestamp: str, event: str,
                        check_id: str, result: str, payload_digest: str) -> str:
    """Compute the hash of an audit record to form the tamper-evident chain.

    Includes prev_hash so altering any earlier record breaks every later hash.
    """
    parts = "|".join([
        prev_hash,
        str(seq),
        timestamp,
        event or "",
        check_id or "",
        result or "",
        payload_digest or "",
    ])
    return hashlib.sha256(parts.encode("utf-8")).hexdigest()


def load_existing_log(log_path: Path) -> list:
    """Load existing audit log; return [] if missing or empty."""
    if not log_path.exists():
        return []
    with open(log_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or []
    return data if isinstance(data, list) else []


def verify_chain_integrity(records: list) -> tuple:
    """Re-verify the hash chain. Returns (ok, first_broken_seq_or_None).

    Called before appending so a corrupted log is reported immediately
    rather than silently extending a broken chain.
    """
    prev = GENESIS_HASH
    for r in records:
        expected_prev = r.get("prev_hash")
        if expected_prev != prev:
            return False, r.get("seq")
        recomputed = compute_record_hash(
            r.get("prev_hash", GENESIS_HASH),
            r.get("seq", 0),
            r.get("timestamp", ""),
            r.get("event", ""),
            r.get("check_id", ""),
            r.get("result", ""),
            r.get("payload_digest", ""),
        )
        if recomputed != r.get("hash"):
            return False, r.get("seq")
        prev = r.get("hash")
    return True, None


def append_record(log_path: Path, event: str, check_id: str, result: str,
                  payload: str, actor: str) -> dict:
    """Append a new audit record and return it."""
    records = load_existing_log(log_path)

    ok, broken_seq = verify_chain_integrity(records)
    if not ok:
        print(f"ERROR: audit_log chain broken at seq={broken_seq} — refusing to append "
              f"to a tampered log. Re-initialize audit_log.yaml after investigation.",
              file=sys.stderr)
        sys.exit(1)

    seq = (records[-1].get("seq", 0) + 1) if records else 1
    prev_hash = records[-1].get("hash", GENESIS_HASH) if records else GENESIS_HASH
    timestamp = datetime.now().isoformat()
    payload_digest = hashlib.sha256((payload or "").encode("utf-8")).hexdigest()

    record = {
        "seq": seq,
        "timestamp": timestamp,
        "event": event,
        "check_id": check_id or "",
        "result": result or "",
        "actor": actor or "",
        "payload_digest": payload_digest,
        "prev_hash": prev_hash,
        "hash": compute_record_hash(prev_hash, seq, timestamp, event,
                                     check_id, result, payload_digest),
    }

    records.append(record)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as f:
        yaml.dump(records, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    return record


def main():
    parser = argparse.ArgumentParser(description="Append a tamper-evident audit log record")
    parser.add_argument("--project-root", default=".", help="Generated project root")
    parser.add_argument("--event", required=True, help="Hook event name (e.g. tool_call, pre_commit)")
    parser.add_argument("--payload", default="", help="Payload JSON string (digest stored, not raw)")
    parser.add_argument("--check-id", default="", help="Check id that triggered this record")
    parser.add_argument("--result", default="", help="PASS / FAIL / BLOCK")
    parser.add_argument("--actor", default="", help="Who triggered the event (agent role / user)")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    log_path = project_root / AUDIT_LOG_NAME

    record = append_record(log_path, args.event, args.check_id, args.result,
                          args.payload, args.actor)
    print(f"  📝 audit_log appended: seq={record['seq']} event={args.event} "
          f"result={args.result or '-'} hash={record['hash'][:12]}...")
    sys.exit(0)


if __name__ == "__main__":
    main()
