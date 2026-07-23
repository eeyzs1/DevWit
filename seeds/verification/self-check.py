#!/usr/bin/env python3
"""
Self-Check Loop: Execute → Check → Reflect → Fix.

Runs verification, uses error-capture for structured analysis,
applies retry strategy from retry-config, and re-runs.
Maximum 3 iterations to prevent infinite loops.

Usage:
    python verification/self-check.py [--project-root <dir>] [--max-iterations 3]
"""

import argparse
import datetime
import subprocess
import sys
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_retry_config(project_root: Path) -> dict:
    retry_file = project_root / "feedback" / "retry-config.yaml"
    if not retry_file.exists():
        return {}
    with open(retry_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def run_error_capture(project_root: Path, error_output: str, source: str) -> list:
    error_capture = project_root / "feedback" / "error-capture.py"
    if not error_capture.exists():
        return []
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as tmp:
        tmp.write(error_output)
        tmp_path = tmp.name
    try:
        proc = subprocess.run(
            [sys.executable, str(error_capture), "--error-output", tmp_path, "--source", source],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if proc.returncode == 0 and proc.stdout.strip():
            data = yaml.safe_load(proc.stdout) or {}
            return data.get("errors", [])
    except Exception:
        pass
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    return []


def run_verification(project_root: Path) -> dict:
    result = {"passed": True, "errors": []}

    consistency_script = project_root / "verification" / "consistency-check.py"
    if consistency_script.exists():
        proc = subprocess.run(
            [sys.executable, str(consistency_script), "--project-root", str(project_root)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if proc.returncode != 0:
            result["passed"] = False
            combined = proc.stdout + proc.stderr
            result["errors"].append({"source": "consistency-check", "output": combined})
            captured = run_error_capture(project_root, combined, "consistency-check")
            if captured:
                result["errors"][-1]["parsed_errors"] = captured

    # Check ruff availability before running — if not installed, skip lint
    # with a warning rather than failing on a "command not found" error.
    ruff_check = subprocess.run(
        ["python", "-m", "ruff", "--version"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if ruff_check.returncode != 0:
        print("⚠️  ruff not installed — skipping lint check. Install with: pip install ruff")
    else:
        lint_result = subprocess.run(
            ["python", "-m", "ruff", "check", str(project_root / "src")],
            capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(project_root),
        )
        if lint_result.returncode != 0:
            result["passed"] = False
            result["errors"].append({"source": "lint", "output": lint_result.stdout})
            captured = run_error_capture(project_root, lint_result.stdout, "lint")
            if captured:
                result["errors"][-1]["parsed_errors"] = captured

    return result


def reflect_on_errors(errors: list, retry_config: dict) -> list:
    fixes = []
    for error in errors:
        source = error.get("source", "unknown")
        output = error.get("output", "")
        parsed = error.get("parsed_errors", [])

        if parsed:
            for pe in parsed:
                error_type = pe.get("type", "unknown")
                fix_hint = pe.get("fix_hint", "")
                strategy = _get_retry_strategy(error_type, retry_config)
                fixes.append({"type": strategy, "action": fix_hint, "source": source, "error_type": error_type})
        elif "unused import" in output or "imported but unused" in output:
            # ruff 的 unused-import 警告可被 ruff --fix 机械移除。
            # 显式声明 (error_type=import_error, strategy=immediate_with_fix_hint)
            # 让 apply_fixes 经 fixer-registry 命中 ruff_autofix（而非硬编码 auto_fix）。
            # 注意：这与 error-capture 解析出的 import_error(ImportError/ModuleNotFoundError)
            # 是不同子类——后者 strategy=manual_fix（retry-config 未映射），不命中 registry，
            # 正确转 pending（ruff 装不了缺失模块）。
            # 匹配两种措辞：pylint "unused import" + ruff F401 "imported but unused"。
            fixes.append({"type": "immediate_with_fix_hint", "action": "remove_unused_imports",
                          "source": source, "error_type": "import_error"})
        elif "undefined name" in output:
            fixes.append({"type": "manual_fix", "action": "add_missing_import_or_definition", "source": source})
        else:
            fixes.append({"type": "manual_fix", "action": "investigate_and_fix", "source": source, "detail": output[:200]})

    return fixes


def _get_retry_strategy(error_type: str, retry_config: dict) -> str:
    strategies = retry_config.get("strategies", {})
    for strategy_name, strategy_data in strategies.items():
        if error_type in strategy_data.get("error_types", []):
            return strategy_data.get("strategy", "manual_fix")
    return "manual_fix"


def _load_fixer_registry(project_root: Path) -> dict:
    """加载 feedback/fixer-registry.yaml。缺失/不可解析/非 dict 时返回 {}。

    Registry schema（见 seeds/feedback/fixer-registry.yaml）：
      version: 1
      fixers:
        <name>:
          match: {strategy: [...], error_types: [...]}
          handler: "feedback/fixers/<name>.py"
          entry: "fix"
          safe: true|false
          description: "..."
    """
    registry_file = project_root / "feedback" / "fixer-registry.yaml"
    if not registry_file.exists():
        return {}
    try:
        with open(registry_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _find_fixer(error_type: str, strategy: str, registry: dict) -> tuple:
    """按 (error_type, strategy) 双键查 fixer。

    匹配规则：fixer.match.strategy 包含 strategy 且 fixer.match.error_types 包含 error_type。
    返回 (fixer_name, cfg) 或 (None, None)。
    """
    fixers = registry.get("fixers") or {}
    for name, cfg in fixers.items():
        if not isinstance(cfg, dict):
            continue
        match = cfg.get("match") or {}
        match_strategies = match.get("strategy") or []
        match_error_types = match.get("error_types") or []
        if strategy in match_strategies and error_type in match_error_types:
            return name, cfg
    return None, None


def _invoke_fixer(handler_path: Path, entry: str, error: dict, context: dict,
                  project_root: Path) -> dict:
    """经 importlib 动态调用 fixer 的 entry 函数。

    契约：fix(error, context, project_root) -> {"applied", "method", "output", "deferred"}
    import/call 异常或返回非 dict 时返回安全降值（applied=False），由调用方转 pending。
    """
    import importlib.util
    try:
        spec = importlib.util.spec_from_file_location(f"fixer_{handler_path.stem}", handler_path)
        if spec is None or spec.loader is None:
            return {"applied": False, "method": None,
                    "output": f"cannot load spec: {handler_path}", "deferred": False}
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        fn = getattr(mod, entry, None)
        if fn is None or not callable(fn):
            return {"applied": False, "method": None,
                    "output": f"entry '{entry}' not found in {handler_path.name}", "deferred": False}
        result = fn(error, context, project_root)
        if not isinstance(result, dict):
            return {"applied": False, "method": None,
                    "output": f"fixer returned non-dict: {type(result).__name__}", "deferred": False}
        return {
            "applied": bool(result.get("applied", False)),
            "method": result.get("method"),
            "output": result.get("output", ""),
            "deferred": bool(result.get("deferred", False)),
        }
    except Exception as e:
        return {"applied": False, "method": None,
                "output": f"fixer exception: {e}", "deferred": False}


def _append_pending_fixes(pending_path: Path, fixes: list) -> None:
    """把 manual_fix 追加到 feedback/pending-fixes.yaml，供 LLM/人工跟进。

    采用 读取→合并→写回 模式（避免 append 破坏 YAML 结构）。每条带时间戳，
    便于审计追溯（符合"状态变更可追溯"约束）。
    """
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    existing = []
    if pending_path.exists():
        try:
            with open(pending_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
            if isinstance(data, list):
                existing = data
        except Exception:
            pass  # 旧文件不可读则覆盖

    ts = datetime.datetime.now().isoformat(timespec="seconds")
    for fx in fixes:
        existing.append({"recorded_at": ts, **fx})

    with open(pending_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(existing, f, allow_unicode=True, sort_keys=False)


def apply_fixes(fixes: list, project_root: Path) -> list:
    """合拢 self-check 闭环的关键一步：真正应用修复，由 fixer-registry 驱动。

    每条 fix 的 `type` 字段是 retry-config 解析出的 strategy（如
    immediate_with_fix_hint / no_retry / exponential_backoff / manual_fix），
    `error_type` 是 error-capture 解析出的错误类型。本函数按 (error_type, strategy)
    双键查 fixer-registry：

      1. 命中且 safe=true  → importlib 调 fixer.fix(error, context, project_root)
         - applied=True 且 deferred=False：成功应用
         - applied=False 或 deferred=True：fixer 跑了但修不了，转 pending
      2. 命中但 safe=false  → 不调 fixer，直接写 pending（人工确认）
      3. 未命中（无 fixer / registry 缺失）→ 写 pending（降级 manual_fix）

    遵守 runtime-hooks 不变量：机械不可修的不自动改业务代码；safe=false 由人工确认。
    返回每条 fix 的应用结果 list，供 self_check_loop 写入 history 做审计追溯。
    """
    registry = _load_fixer_registry(project_root)
    pending_path = project_root / "feedback" / "pending-fixes.yaml"

    results = []
    pending = []
    for fx in fixes:
        error_type = fx.get("error_type", "unknown")
        strategy = fx.get("type", "manual_fix")
        context = {"source": fx.get("source"), "action": fx.get("action"),
                   "detail": fx.get("detail", "")}
        record = {"fix": fx, "applied": False, "method": None, "output": ""}

        fixer_name, cfg = _find_fixer(error_type, strategy, registry)

        if fixer_name is None:
            # 未命中：降级 manual_fix
            pending.append(fx)
            record["method"] = "pending_manual"
            record["output"] = (f"no fixer bound for (error_type={error_type}, "
                                f"strategy={strategy}) — deferred to manual")
            results.append(record)
            continue

        handler_rel = cfg.get("handler")
        safe = bool(cfg.get("safe", False))
        entry = cfg.get("entry", "fix")
        handler_path = project_root / handler_rel

        if not safe:
            # safe=false：不自动执行，写 pending 由人工确认
            pending.append(fx)
            record["method"] = f"pending_manual (fixer={fixer_name}, safe=false)"
            record["output"] = f"fixer '{fixer_name}' safe=false — requires human review"
            results.append(record)
            continue

        if not handler_path.exists():
            # safe=true 但 handler 文件缺失——降级 pending，不假装修复（anti-mock）
            pending.append(fx)
            record["method"] = f"pending_manual (fixer={fixer_name}, handler missing)"
            record["output"] = f"handler not found: {handler_rel}"
            results.append(record)
            continue

        # safe=true 且 handler 存在：经 importlib 调 fixer
        error_dict = {"type": error_type, "strategy": strategy,
                      "action": fx.get("action"), "source": fx.get("source"),
                      "detail": fx.get("detail", "")}
        fixer_result = _invoke_fixer(handler_path, entry, error_dict, context, project_root)
        record["method"] = fixer_result["method"] or f"fixer:{fixer_name}"
        record["output"] = fixer_result["output"]

        if fixer_result["applied"] and not fixer_result["deferred"]:
            record["applied"] = True
        else:
            # applied=False 或 deferred=True → 转人工
            pending.append(fx)
            record["applied"] = False
            if fixer_result["deferred"]:
                record["method"] = f"pending_manual (fixer={fixer_name}, deferred)"

        results.append(record)

    if pending:
        _append_pending_fixes(pending_path, pending)

    return results


def self_check_loop(project_root: Path, max_iterations: int) -> dict:
    history = []
    retry_config = load_retry_config(project_root)

    for iteration in range(1, max_iterations + 1):
        print(f"\n--- Self-Check Iteration {iteration}/{max_iterations} ---")
        result = run_verification(project_root)
        history.append({"iteration": iteration, "result": result})

        if result["passed"]:
            print(f"✅ All checks passed at iteration {iteration}")
            return {"passed": True, "iterations": iteration, "history": history}

        print(f"❌ Checks failed. Errors: {len(result['errors'])}")
        fixes = reflect_on_errors(result["errors"], retry_config)
        print(f"   Proposed fixes: {len(fixes)}")
        for fix in fixes:
            print(f"   - [{fix['type']}] {fix['action']}")

        # 合拢闭环：真正应用修复，下一次迭代 run_verification 才能看到变化。
        # 之前断在这里——fixes 只 print 不 apply，导致 2/3 次迭代必然重复失败。
        applied = apply_fixes(fixes, project_root)
        history[-1]["applied_fixes"] = applied
        auto_ok = sum(1 for a in applied if a.get("applied"))
        # method 现在可能是 "pending_manual" / "pending_manual (fixer=..., safe=false)" /
        # "pending_manual (fixer=..., deferred)" 等——用 startswith 兜住所有 pending 变体
        deferred = sum(1 for a in applied
                       if str(a.get("method", "")).startswith("pending_manual"))
        print(f"   Applied: {auto_ok} auto-fix / {deferred} deferred to manual")

    print(f"\n⚠️  Self-check loop exhausted ({max_iterations} iterations)")
    return {"passed": False, "iterations": max_iterations, "history": history}


def verify_acceptance_criterion(project_root: Path, task_id: str) -> dict:
    """Verify a single task card's evidence satisfies its acceptance criteria.

    Called by runtime-hooks HOOK_AC_VERIFY after a subagent reports completion.
    Reads planning/dispatch-results/<task_id>.yaml (the output card) and checks:
      1. output.status == 'completed' (or 'needs_human_review' is acceptable
         only when input.requires_human_review was true)
      2. every self_check_evidence entry has passed == true
      3. every input.success_criteria has a matching evidence entry

    Supports two card formats:
      - Grouped (task-card-schema v1): card has `input` and `output` sub-dicts
      - Flat (legacy samples): status/evidence at top level, no success_criteria

    Returns {"passed": bool, "reasons": [str]}.
    """
    result = {"passed": False, "reasons": []}
    card_path = project_root / "planning" / "dispatch-results" / f"{task_id}.yaml"
    if not card_path.exists():
        result["reasons"].append(f"dispatch-results/{task_id}.yaml not found — subagent has not produced an output card yet")
        return result

    with open(card_path, "r", encoding="utf-8") as f:
        card = yaml.safe_load(f) or {}

    # Grouped format (task-card-schema v1) vs flat legacy format
    if "input" in card or "output" in card:
        inp = card.get("input") or {}
        out = card.get("output") or {}
        status = out.get("status")
        evidence = out.get("self_check_evidence") or []
        criteria = inp.get("success_criteria") or []
        requires_review = bool(inp.get("requires_human_review", False))
    else:
        # Flat legacy format: top-level status + evidence, no input section.
        # 主动从 dispatch-plan.yaml 取回对应 task_id 的 input card
        # （dispatcher 写入的扁平 input card 含 success_criteria），做覆盖校验。
        # 这样扁平格式下也能做 success_criteria 覆盖检查，不再静默跳过。
        status = card.get("status")
        evidence = card.get("self_check_evidence") or []
        criteria = []
        requires_review = False
        plan_path = project_root / "planning" / "dispatch-plan.yaml"
        if plan_path.exists():
            try:
                with open(plan_path, "r", encoding="utf-8") as pf:
                    plan = yaml.safe_load(pf) or {}
                for tc in (plan.get("task_cards") or []):
                    if isinstance(tc, dict) and tc.get("task_id") == task_id:
                        criteria = tc.get("success_criteria") or []
                        requires_review = bool(tc.get("requires_human_review", False))
                        break
            except Exception:
                pass  # dispatch-plan 不可读时降级为只校验 status + evidence

    # 1. status check
    acceptable = ["completed"]
    if requires_review:
        acceptable.append("needs_human_review")
    if status not in acceptable:
        result["reasons"].append(
            f"output.status='{status}' not in {acceptable} "
            f"(requires_human_review={requires_review})"
        )
        return result

    # 2. all evidence passed
    failed_evidence = [e for e in evidence if not e.get("passed", False)]
    if failed_evidence:
        result["reasons"].append(
            f"{len(failed_evidence)} evidence entries have passed=false — "
            f"first: {failed_evidence[0].get('criterion', '?')}"
        )
        return result

    # 3. success_criteria coverage (only when input section present)
    if criteria:
        covered_criteria = {e.get("criterion", "") for e in evidence}
        uncovered = [c for c in criteria if c not in covered_criteria]
        if uncovered:
            result["reasons"].append(
                f"{len(uncovered)} success_criteria have no matching evidence: "
                f"{uncovered[:3]}"
            )
            return result

    result["passed"] = True
    cov = f", {len(criteria)} criteria covered" if criteria else " (no success_criteria to cover)"
    result["reasons"].append(
        f"task_id={task_id} status={status}{cov}"
    )
    return result


def main():
    parser = argparse.ArgumentParser(description="Self-Check Loop")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--max-iterations", type=int, default=3, help="Maximum check iterations")
    parser.add_argument("--verify-ac", default=None, metavar="TASK_ID",
                        help="Verify a single task card's evidence (called by HOOK_AC_VERIFY). "
                             "TASK_ID like 'WU001-01' reads planning/dispatch-results/WU001-01.yaml.")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()

    if args.verify_ac:
        result = verify_acceptance_criterion(project_root, args.verify_ac)
        print(f"\n=== AC Verification: {args.verify_ac} ===")
        for r in result["reasons"]:
            print(f"  - {r}")
        if result["passed"]:
            print("  Result: PASS")
            sys.exit(0)
        print("  Result: FAIL")
        sys.exit(1)

    result = self_check_loop(project_root, args.max_iterations)

    if not result["passed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
