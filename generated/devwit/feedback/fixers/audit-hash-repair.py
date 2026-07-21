#!/usr/bin/env python3
"""
Audit Hash Repair: 审计哈希链修复建议器（safe: false，不实际改文件）。

由 fixer-registry.yaml 的 audit_hash_repair 条目路由（strategy=no_retry,
error_type=audit_write_failed）。审计日志（verification/audit-append.py 维护的
prev_hash/hash 防篡改链）的写入失败或断链属于完整性事件——自动重算会掩盖篡改痕迹，
因此本 fixer 只输出人工修复步骤（applied=False, deferred=True），由 apply_fixes
写 pending 转人工确认后执行。接口契约与其它 fixer 一致：
    def fix(error, context, project_root) -> {"applied", "method", "output", "deferred"}

Usage (CLI):
    python feedback/fixers/audit-hash-repair.py --project-root <dir> --error-json '<json>'
    始终 exit 1（applied=False），输出 YAML 格式的人工操作步骤
"""

import argparse
import json
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

REPAIR_STEPS = """\
审计日志写入失败 / 哈希链断链（audit_write_failed）——需人工按下述步骤处理，
本 fixer 不自动修改审计日志（自动重算会掩盖潜在篡改，违反审计不可抵赖原则）：

1. 冻结现场：停止后续写审计日志的操作，备份当前审计日志文件（copy 到
   evidence/AC7/ 或独立目录），保留断链现场供核查。
2. 定位断点：用 verification/audit-append.py 的 verify_chain_integrity(records)
   离线复算整条链，拿到 first_broken_seq（第一条 hash 对不上的记录序号）。
3. 判定性质：
   - 若断点是本次写入失败导致的尾记录残缺（最后一条记录不完整）→ 人工删除
     该残缺尾记录，用 audit-append.py 的 append_record() 以正确 prev_hash
     重新追加该事件，链条自然续上。
   - 若断点在历史记录中间（prev_hash/hash 对不上且非本次写入造成）→ 按安全
     事件处理：不得重算续链，先排查是否发生篡改，结论落盘后由人工决定是否
     以 compute_record_hash() 自断点起重算并在审计日志中追加一条
     event=audit_chain_repaired 的说明记录（载明断点 seq、原因、操作人）。
4. 复核：重跑 verify_chain_integrity() 确认全链 ok=True，把修复前后两份日志
   与断点分析一并归档为 AC7 证据。
"""


def fix(error: dict, context: dict, project_root: Path) -> dict:
    """只返回人工修复建议，不实际改审计日志（safe: false 契约）。

    永远返回 applied=False, deferred=True —— apply_fixes 据此写 pending 转人工。
    """
    matched = error.get("matched_text", "") if isinstance(error, dict) else ""
    detail = f"触发错误: {matched}\n\n" if matched else ""
    return {
        "applied": False,
        "method": "audit hash chain repair (manual-only, safe=false)",
        "output": detail + REPAIR_STEPS,
        "deferred": True,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Audit Hash Repair advisory (CLI mode, safe=false)")
    parser.add_argument("--project-root", required=True, help="Project root directory")
    parser.add_argument("--error-json", required=True,
                        help="JSON-encoded error dict from error-capture")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    try:
        error = json.loads(args.error_json)
    except json.JSONDecodeError:
        error = {}
    context = {"strategy_entry": None, "fix": None}

    result = fix(error, context, project_root)
    print(yaml.dump(result, default_flow_style=False, allow_unicode=True))
    sys.exit(0 if result.get("applied") else 1)


if __name__ == "__main__":
    main()
