#!/usr/bin/env python3
"""
Ruff Fixer: 通用 lint/格式自动修复器（domain-agnostic 通用原语）。

把 ruff --fix 包装为统一 fixer 接口 fix(error, context, project_root)，供
verification/self-check.py 的 apply_fixes 经 importlib 动态调用（由 fixer-registry.yaml
的 ruff_autofix 条目路由）。也可独立 CLI 运行。

接口契约（与 fixer-registry.yaml 的 entry: "fix" 对齐）：
    def fix(error, context, project_root) -> {"applied", "method", "output", "deferred"}

ruff 对全 src 一次性修复（非逐错误），所以本 fixer 不依赖 error 的具体内容——
只要 registry 命中本 fixer（按 strategy/error_type 匹配），就跑一次 ruff --fix。

Usage (CLI):
    python feedback/fixers/ruff-fixer.py --project-root <dir> --error-json '<json>'
    exit 0 = applied (ruff 执行成功)，exit 1 = 未 applied (ruff 不可用/无 src)
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def fix(error: dict, context: dict, project_root: Path) -> dict:
    """对 project_root/src 跑 ruff --fix。

    返回 {"applied": bool, "method": str, "output": str, "deferred": bool}：
      - applied=True:  ruff 成功执行（exit 0 或 1）
      - deferred=True: ruff 跑了但有剩余问题修不了（exit 1），那部分转人工
      - applied=False: ruff 不可用或无 src（降级，不假装修复）
    """
    src_dir = project_root / "src"
    method = "ruff --fix"

    ruff_check = subprocess.run(
        ["python", "-m", "ruff", "--version"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if ruff_check.returncode != 0:
        return {"applied": False, "method": method,
                "output": "ruff not installed — deferred to manual", "deferred": False}

    if not src_dir.exists():
        return {"applied": False, "method": method,
                "output": f"src dir not found: {src_dir}", "deferred": False}

    proc = subprocess.run(
        ["python", "-m", "ruff", "check", "--fix", str(src_dir)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=str(project_root),
    )
    output = (proc.stdout + proc.stderr).strip()
    # ruff --fix 退出码：0=无问题/已全修，1=仍有剩余需人工，其它=出错
    applied = proc.returncode in (0, 1)
    deferred = proc.returncode == 1  # 还有 ruff 修不了的（如 undefined name）转人工
    return {"applied": applied, "method": method, "output": output[:500], "deferred": deferred}


def main():
    parser = argparse.ArgumentParser(description="Ruff Fixer (CLI mode)")
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
