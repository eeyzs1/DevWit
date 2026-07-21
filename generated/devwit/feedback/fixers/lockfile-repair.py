#!/usr/bin/env python3
"""
Lockfile Repair: DevWit 项目 package-lock.json 漂移修复器（safe: true）。

把 npm install --package-lock-only 包装为统一 fixer 接口
fix(error, context, project_root)，供 verification/self-check.py 的 apply_fixes
经 importlib 动态调用（由 fixer-registry.yaml 的 lockfile_repair 条目路由：
strategy=auto_fix, error_type=lockfile_drift）。也可独立 CLI 运行。

接口契约（与 fixer-registry.yaml 的 entry: "fix" 对齐）：
    def fix(error, context, project_root) -> {"applied", "method", "output", "deferred"}

lockfile_drift = package-lock.json 与 package.json 依赖声明不一致（npm ci 报
lock file does not satisfy 或 npm install 提示 lockfileVersion 漂移）。
npm install --package-lock-only 只重算 lockfile 不装 node_modules，是最小机械修复。

Usage (CLI):
    python feedback/fixers/lockfile-repair.py --project-root <dir> --error-json '<json>'
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

NPM_TIMEOUT_SECONDS = 300


def fix(error: dict, context: dict, project_root: Path) -> dict:
    """在 project_root 跑 npm install --package-lock-only 修复 lockfile 漂移。

    返回 {"applied": bool, "method": str, "output": str, "deferred": bool}：
      - applied=True:  npm 成功重算 lockfile（exit 0）
      - applied=False: npm 不可用、无 package.json 或重算失败（不假装修复）
    """
    method = "npm install --package-lock-only"

    npm = shutil.which("npm")
    if npm is None:
        return {"applied": False, "method": method,
                "output": "npm not found on PATH — deferred to manual", "deferred": False}

    if not (project_root / "package.json").exists():
        return {"applied": False, "method": method,
                "output": f"package.json not found in {project_root}", "deferred": False}

    try:
        proc = subprocess.run(
            [npm, "install", "--package-lock-only"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(project_root), timeout=NPM_TIMEOUT_SECONDS,
            shell=(sys.platform == "win32"),
        )
    except subprocess.TimeoutExpired:
        return {"applied": False, "method": method,
                "output": f"npm install --package-lock-only timed out after "
                          f"{NPM_TIMEOUT_SECONDS}s", "deferred": False}

    output = (proc.stdout + proc.stderr).strip()
    applied = proc.returncode == 0
    if not applied:
        output = f"npm exited {proc.returncode}: {output[:500]}"
    return {"applied": applied, "method": method,
            "output": output[:500] or "package-lock.json regenerated",
            "deferred": False}


def main():
    parser = argparse.ArgumentParser(description="Lockfile Repair (CLI mode)")
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
