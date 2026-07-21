#!/usr/bin/env python3
"""
ESLint Autofixer: DevWit 项目 lint 机械修复器（safe: true）。

把 npx eslint --fix 包装为统一 fixer 接口 fix(error, context, project_root)，供
verification/self-check.py 的 apply_fixes 经 importlib 动态调用（由 fixer-registry.yaml
的 eslint_autofix 条目路由：strategy=auto_fix, error_type=eslint_failure）。
也可独立 CLI 运行。

接口契约（与 fixer-registry.yaml 的 entry: "fix" 对齐）：
    def fix(error, context, project_root) -> {"applied", "method", "output", "deferred"}

修复目标取自 error["file_paths"]（lint-check 捕获 eslint 输出时解析出的报错文件列表）。
eslint --fix 只机械修复可自动修复的规则（格式、未使用 import、缺分号等）；
修不了的规则（exit 1 仍有剩余）标记 deferred=True 转人工。

Usage (CLI):
    python feedback/fixers/eslint-autofixer.py --project-root <dir> --error-json '<json>'
    exit 0 = applied，exit 1 = 未 applied
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ESLINT_TIMEOUT_SECONDS = 120


def _resolve_file_paths(error: dict, project_root: Path) -> list:
    """从 error dict 提取待修复文件列表，过滤不存在与非 ts/tsx/js 文件。"""
    raw = error.get("file_paths") or []
    if isinstance(raw, str):
        raw = [raw]
    if not raw and error.get("file"):
        raw = [error["file"]]
    exts = {".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".vue"}
    resolved = []
    for p in raw:
        fp = Path(p)
        if not fp.is_absolute():
            fp = project_root / fp
        if fp.exists() and fp.suffix.lower() in exts:
            resolved.append(str(fp))
    return resolved


def fix(error: dict, context: dict, project_root: Path) -> dict:
    """对 error 中的 file_paths 跑 npx eslint --fix。

    返回 {"applied": bool, "method": str, "output": str, "deferred": bool}：
      - applied=True:  eslint 成功执行（exit 0=全部修复/无问题）
      - deferred=True: eslint 跑了但仍有修不了的规则（exit 1），剩余部分转人工
      - applied=False: npx 不可用、无有效报错文件或 eslint 执行失败（不假装修复）
    """
    method = "eslint --fix"

    npx = shutil.which("npx")
    if npx is None:
        return {"applied": False, "method": method,
                "output": "npx not found on PATH — deferred to manual", "deferred": False}

    files = _resolve_file_paths(error, project_root)
    if not files:
        return {"applied": False, "method": method,
                "output": "no valid file_paths in error (expected ts/tsx/js files) — "
                          "cannot run targeted eslint --fix", "deferred": False}

    try:
        proc = subprocess.run(
            [npx, "eslint", "--fix", *files],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(project_root), timeout=ESLINT_TIMEOUT_SECONDS,
            shell=(sys.platform == "win32"),
        )
    except subprocess.TimeoutExpired:
        return {"applied": False, "method": method,
                "output": f"eslint --fix timed out after {ESLINT_TIMEOUT_SECONDS}s",
                "deferred": False}

    output = (proc.stdout + proc.stderr).strip()
    # eslint 退出码：0=无剩余问题（已全修或无问题），1=仍有修不了的规则，2+=配置/执行错误
    applied = proc.returncode == 0
    deferred = proc.returncode == 1
    if proc.returncode not in (0, 1):
        return {"applied": False, "method": method,
                "output": f"eslint exited {proc.returncode}: {output[:500]}", "deferred": False}
    return {"applied": applied, "method": method,
            "output": output[:500] or f"eslint --fix completed on {len(files)} file(s)",
            "deferred": deferred}


def main():
    parser = argparse.ArgumentParser(description="ESLint Autofixer (CLI mode)")
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
