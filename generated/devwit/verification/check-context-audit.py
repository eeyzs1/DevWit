#!/usr/bin/env python3
"""
CHECK-CONTEXT-AUDIT: 验证 DevWit AC2（简洁上下文引擎）证据 —— context manifest 结构审计。

校验规则（对应 AR007 上下文默认极简）：
1. manifest JSON 含 items 数组，每项有 name/type/enabled/tokens 字段；
2. 至少一项 enabled=false（证明上下文可逐项裁剪）；
3. system_prompt 项 tokens < 1500（pi 式简洁约束）。

证据位置：<project-root>/evidence/AC2/*.json，或由 --manifest 显式指定单个 manifest 文件。
证据目录/文件不存在时打印 "PENDING: 产品未运行，证据未生成" 并 exit 0（不阻断开发早期）；
证据存在但结构不合规则逐条打印并 exit 1。

用法：
    python verification/check-context-audit.py --project-root <dir>
    python verification/check-context-audit.py --project-root . --manifest evidence/AC2/manifest-001.json

exit 0 = PASS 或 PENDING
exit 1 = FAIL
"""

import argparse
import json
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

REQUIRED_ITEM_FIELDS = ("type", "enabled", "tokens")
# 项名称字段：真实 ContextItem 契约为 label（contracts 包），兼容早期手写证据的 name。
ITEM_NAME_FIELDS = ("label", "name")
MAX_SYSTEM_PROMPT_TOKENS = 1500
PENDING_MESSAGE = "PENDING: 产品未运行，证据未生成"


def validate_manifest(manifest_path):
    errors = []
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        return [f"manifest 不是合法 JSON: {exc}"]

    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        return ["缺少非空 items 数组（context manifest 必须列出每次请求的完整上下文组成）"]

    for index, item in enumerate(items):
        if not isinstance(item, dict):
            errors.append(f"items[{index}] 不是对象")
            continue
        for field in REQUIRED_ITEM_FIELDS:
            if field not in item:
                errors.append(f"items[{index}] 缺少必填字段 '{field}'")
        if not any(name_field in item for name_field in ITEM_NAME_FIELDS):
            errors.append(f"items[{index}] 缺少名称字段（{' 或 '.join(ITEM_NAME_FIELDS)}）")
        if "enabled" in item and not isinstance(item["enabled"], bool):
            errors.append(f"items[{index}].enabled 必须是布尔值")
        if "tokens" in item and not (isinstance(item["tokens"], int) and item["tokens"] >= 0):
            errors.append(f"items[{index}].tokens 必须是非负整数")

    valid_items = [it for it in items if isinstance(it, dict)]
    if valid_items and not any(it.get("enabled") is False for it in valid_items):
        errors.append("不存在 enabled=false 的上下文项（无法证明用户可逐项开启/关闭，AC2 证据不足）")

    system_prompts = [
        it for it in valid_items
        if it.get("type") == "system_prompt" or it.get("name") == "system_prompt"
    ]
    if not system_prompts:
        errors.append("缺少 system_prompt 项（AR007：默认至少注入系统提示）")
    else:
        for item in system_prompts:
            tokens = item.get("tokens")
            if isinstance(tokens, int) and tokens >= MAX_SYSTEM_PROMPT_TOKENS:
                errors.append(
                    f"system_prompt tokens={tokens} 达到/超过 {MAX_SYSTEM_PROMPT_TOKENS}，违反 pi 式简洁约束（AR007）"
                )
    return errors


def main():
    parser = argparse.ArgumentParser(description="验证 AC2 context manifest 证据结构（AR007 上下文默认极简）")
    parser.add_argument("--project-root", required=True, help="产品代码根目录（证据位于其 evidence/AC2/ 下）")
    parser.add_argument("--manifest", default=None, help="显式指定单个 context manifest JSON 路径")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()

    if args.manifest:
        manifest_files = [Path(args.manifest).resolve()]
    else:
        evidence_dir = project_root / "evidence" / "AC2"
        if not evidence_dir.is_dir():
            print(f"{PENDING_MESSAGE}（{evidence_dir} 不存在）")
            return 0
        manifest_files = sorted(evidence_dir.glob("*.json"))

    if not manifest_files or not any(p.is_file() for p in manifest_files):
        print(f"{PENDING_MESSAGE}（未找到 context manifest JSON）")
        return 0

    all_errors = []
    checked = 0
    for manifest_path in manifest_files:
        if not manifest_path.is_file():
            continue
        checked += 1
        errors = validate_manifest(manifest_path)
        for error in errors:
            all_errors.append(f"{manifest_path}: {error}")

    if checked == 0:
        print(f"{PENDING_MESSAGE}（未找到 context manifest JSON）")
        return 0

    if all_errors:
        print(f"FAIL: {checked} 个 context manifest 中共 {len(all_errors)} 处结构违规")
        for error in all_errors:
            print("  " + error)
        return 1
    print(f"PASS: {checked} 个 context manifest 结构合规（items 字段齐全、存在 enabled=false 项、system_prompt tokens < {MAX_SYSTEM_PROMPT_TOKENS}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
