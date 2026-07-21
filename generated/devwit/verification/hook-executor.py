#!/usr/bin/env python3
"""
Hook Executor v1: 宿主 runtime 调用 harness hook 的统一入口。

第一性原理分工：
- 本脚本 = 硬约束（meta harness 自己，所有项目共享）
- 它读 runtime-hooks.yaml 的 event schema，按 payload 实例化 check command，
  执行，返回 PASS/FAIL
- 它不"理解"业务语义——只做事件→check→exit code 的映射

宿主 runtime 集成契约：
  在 hook 点调用：
    python verification/hook-executor.py --event <name> \
        --project-root <root> [--payload '<json>']
  检查 exit code：
    0 = PASS（继续操作）
    1 = FAIL（必须阻止后续操作，把 stderr 返回给 LLM）
    2 = NO_HOOKS_CONFIGURED（项目未配置 hook，宿主可选择继续或警告）
    3 = INVALID_EVENT（事件名不在 schema 里）

Usage:
    python verification/hook-executor.py --event pre_tool_call \\
        --project-root generated/my-project \\
        --payload '{"tool_name":"write_file","target_path":"src/edge/safety_interlock/handoff.py"}'
"""

import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path
from string import Template

import yaml

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_hooks_schema(project_root: Path) -> dict:
    """读 verification/runtime-hooks.yaml。"""
    hooks_file = project_root / "verification" / "runtime-hooks.yaml"
    if not hooks_file.exists():
        return {}
    with open(hooks_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def render_command(template: str, payload: dict, project_root: Path) -> str:
    """把 {{key}} 占位符替换为 payload 值。"""
    # 简单模板：用 string.Template 安全替换
    # {{key}} → ${key}（兼容 string.Template）
    t = template.replace("{{", "${").replace("}}", "}")
    try:
        # 添加 project_root 上下文
        ctx = dict(payload or {})
        ctx["project_root"] = str(project_root)
        # payload 可能是嵌套 dict，对 dict/list 用 JSON 字符串
        for k, v in list(ctx.items()):
            if isinstance(v, (dict, list)):
                ctx[k] = json.dumps(v, ensure_ascii=False)
        return Template(t).safe_substitute(ctx)
    except (KeyError, ValueError):
        return template  # 替换失败保留原文


def evaluate_condition(condition: str, payload: dict, ctx: dict) -> bool:
    """评估 condition 表达式。仅支持简单 ==/!=/>=/<= 比较 + and/or。"""
    if not condition:
        return True
    # 替换 {{var}} 占位符
    expr = render_command(condition, payload, Path("."))
    # 简单评估：用 eval 但限制 builtins（白名单）
    try:
        safe_globals = {"__builtins__": {}}
        return bool(eval(expr, safe_globals, dict(ctx)))
    except Exception:
        # 评估失败默认 True（fail-open：不阻止 hook 执行）
        return True


def run_check(check: dict, payload: dict, project_root: Path,
              ctx: dict) -> tuple:
    """执行单个 check，返回 (passed, output)。"""
    cid = check.get("id", "?")
    severity = check.get("severity", "warn")
    command_template = check.get("command", "")
    if not command_template:
        return True, f"{cid}: no command configured"

    # 评估 condition
    cond = check.get("condition")
    if cond and not evaluate_condition(cond, payload, ctx):
        return True, f"{cid}: condition not met ({cond}), skipped"

    # 渲染命令
    cmd = render_command(command_template, payload, project_root)
    # cd 到 project_root 后执行
    try:
        result = subprocess.run(
            cmd, cwd=str(project_root), shell=True,
            capture_output=True, text=True, timeout=300,
            encoding="utf-8", errors="replace",
        )
        passed = (result.returncode == 0)
        output = (
            f"{cid}: {'PASS' if passed else 'FAIL'} (exit={result.returncode})\n"
            f"  command: {cmd}\n"
        )
        if result.stdout:
            output += f"  stdout: {result.stdout.strip()[:500]}\n"
        if result.stderr:
            output += f"  stderr: {result.stderr.strip()[:500]}\n"
        return passed, output
    except subprocess.TimeoutExpired:
        return False, f"{cid}: TIMEOUT (300s) for command: {cmd}"
    except Exception as e:
        return False, f"{cid}: EXCEPTION running command: {cmd}\n  error: {e}"


def execute_hook(event_name: str, payload: dict, project_root: Path) -> int:
    """执行一个 hook 事件的所有 check。返回 exit code。"""
    schema = load_hooks_schema(project_root)
    if not schema:
        print(f"NO_HOOKS_CONFIGURED: project has no runtime-hooks.yaml at "
              f"{project_root}/verification/runtime-hooks.yaml")
        return 2

    events = schema.get("events") or {}
    if event_name not in events:
        print(f"INVALID_EVENT: '{event_name}' not in events: {list(events.keys())}")
        return 3

    event_def = events[event_name] or {}
    checks = event_def.get("checks") or []
    if not checks:
        print(f"PASS: event '{event_name}' has no checks configured")
        return 0

    ctx = {
        "event": event_name,
        "project_root": str(project_root),
        **(payload or {}),
    }

    print(f"=== HOOK: {event_name} ===")
    print(f"  payload: {json.dumps(payload, ensure_ascii=False)[:200]}")
    print(f"  checks:  {len(checks)}")
    print()

    any_block_fail = False
    any_warn = False
    for check in checks:
        passed, output = run_check(check, payload, project_root, ctx)
        severity = check.get("severity", "warn")
        marker = "PASS" if passed else f"FAIL({severity})"
        print(f"  [{marker}] {output.strip()}")
        if not passed:
            if severity == "block":
                any_block_fail = True
            elif severity == "warn":
                any_warn = True

    print()
    if any_block_fail:
        print(f"=== HOOK RESULT: BLOCKED ===")
        print(f"  Runtime MUST prevent the {event_name} operation from proceeding.")
        print(f"  Return stderr to LLM with explanation.")
        return 1
    elif any_warn:
        print(f"=== HOOK RESULT: WARN (passed with warnings) ===")
        print(f"  Runtime MAY proceed but should inform LLM of warnings.")
        return 0
    else:
        print(f"=== HOOK RESULT: PASS ===")
        return 0


def main():
    parser = argparse.ArgumentParser(description="Hook Executor")
    parser.add_argument("--event", required=True,
                        help="Hook event name (e.g. pre_tool_call, pre_commit)")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--payload", default="{}",
                        help="JSON payload for the event")
    args = parser.parse_args()

    try:
        payload = json.loads(args.payload)
    except json.JSONDecodeError as e:
        print(f"ERROR: --payload is not valid JSON: {e}", file=sys.stderr)
        sys.exit(3)

    project_root = Path(args.project_root).resolve()
    exit_code = execute_hook(args.event, payload, project_root)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
