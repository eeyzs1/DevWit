#!/usr/bin/env python3
"""
ACTIVE ORCHESTRATOR: Drives the execution loop with mandatory enforcement.

This is THE entry point for the generated harness project.
AI agents MUST start here and follow the enforced workflow.

The orchestrator:
1. Tracks progress with enforced checkpoints
2. Requires guard.py pass before allowing implementation
3. Requires verification before allowing completion
4. Auto-checks architecture constraints after code changes
5. Prevents self-certification

Usage:
    python orchestrator.py --status                        # MUST run first
    python orchestrator.py --next                          # Show next criterion to implement
    python orchestrator.py --verify                        # Run full verification suite
    python orchestrator.py --mark-complete "criterion"     # Mark after verification passes
    python orchestrator.py --evolve                        # Run evolution cycle
    python orchestrator.py --innovate                      # Innovation engine (推陈出新)
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import yaml

# Ensure UTF-8 stdout/stderr on Windows (prevents UnicodeEncodeError with emoji)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PROJECT_ROOT = Path(__file__).resolve().parent

# ============================================================
# Append-only event log (WP1: log is truth, state is a projection)
# ============================================================
# memory/event-log.yaml is the single source of truth for project progress;
# memory/session-state.yaml is a DERIVED projection kept for downstream
# readers. Events are appended, never rewritten. Unknown event types and seq
# gaps are REFUSED (fail-closed).

EVENT_LOG = PROJECT_ROOT / "memory" / "event-log.yaml"
SESSION_STATE = PROJECT_ROOT / "memory" / "session-state.yaml"

GEN_EVENT_TYPES = {
    "seed/import", "project/init", "criterion/completed",
    "guard/check", "error/recorded", "mistake/recorded",
    # WP1 evidence ledger: real command results, never self-reports.
    "verify/run", "test/run", "audit/round",
}


def _load_events() -> list:
    if not EVENT_LOG.exists():
        return []
    with open(EVENT_LOG, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    events = doc.get("events", [])
    if not isinstance(events, list):
        raise ValueError("memory/event-log.yaml: 'events' is not a list -- fail-closed")
    for i, ev in enumerate(events, start=1):
        if not isinstance(ev, dict) or ev.get("seq") != i:
            raise ValueError(f"memory/event-log.yaml: seq gap/duplicate at position {i}")
        if ev.get("type") not in GEN_EVENT_TYPES:
            raise ValueError(
                f"memory/event-log.yaml: unknown event type {ev.get('type')!r} at seq {i}")
    return events


def _chain_events(events: list) -> list:
    """P2#12 hash-chain integrity: prev_hash + sha256 over the event."""
    import hashlib
    import json
    prev = ""
    chained = []
    for ev in events:
        ev = dict(ev)
        ev.pop("hash", None)
        canonical = json.dumps({k: v for k, v in ev.items() if k != "hash"},
                               sort_keys=True, ensure_ascii=False, default=str)
        ev["prev_hash"] = prev
        ev["hash"] = hashlib.sha256((prev + canonical).encode("utf-8")).hexdigest()
        prev = ev["hash"]
        chained.append(ev)
    return chained


def _append_events(new_events: list) -> None:
    events = _load_events()
    base = len(events)
    now = datetime.now().isoformat()
    for i, ev in enumerate(new_events, start=base + 1):
        if ev.get("type") not in GEN_EVENT_TYPES:
            raise ValueError(f"unknown event type {ev.get('type')!r}")
        events.append({"seq": i, "ts": now, "type": ev["type"],
                       "payload": ev.get("payload", {})})
    EVENT_LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(EVENT_LOG, "w", encoding="utf-8") as f:
        yaml.dump({"version": 1, "events": _chain_events(events)}, f,
                  default_flow_style=False, allow_unicode=True, sort_keys=False)


def _fold(events: list) -> dict:
    """Pure function: events -> base session state."""
    state = {
        "status": "initialized",
        "progress": {"completed_criteria": [], "failed_criteria": []},
        "guard_log": [],
        "errors": [],
        "revision": len(events),
        "updated_at": None,
    }
    for ev in events:
        typ, payload, ts = ev["type"], ev.get("payload", {}), ev.get("ts")
        if typ == "seed/import":
            snap = payload.get("snapshot") or {}
            state = {**state, **{k: v for k, v in snap.items() if k in state}}
        elif typ == "criterion/completed":
            c = payload.get("criterion")
            if c and c not in state["progress"]["completed_criteria"]:
                state["progress"]["completed_criteria"].append(c)
        elif typ == "guard/check":
            state["guard_log"].append({
                "timestamp": ts, "seq": ev["seq"],
                "action": payload.get("action"), "criterion": payload.get("criterion"),
                "verdict": payload.get("verdict"),
            })
            state["guard_log"] = state["guard_log"][-20:]
        elif typ == "error/recorded":
            state["errors"].append(payload.get("message", ""))
        elif typ == "mistake/recorded":
            state["errors"].append(f"[mistake] {payload.get('message', '')}")
        elif typ in ("verify/run", "test/run", "audit/round"):
            # WP1 evidence ledger: real command results accumulated in the fold.
            state.setdefault("evidence", []).append({
                "seq": ev["seq"], "ts": ts, "kind": typ.split("/")[0],
                "name": payload.get("name") or payload.get("command") or typ,
                "command": payload.get("command"),
                "exit": payload.get("exit"),
                "passed": bool(payload.get("passed", payload.get("exit") == 0)),
                "summary": payload.get("summary", ""),
            })
        state["updated_at"] = ts
    return state


def load_session_state() -> dict:
    """Bootstrap/migrate the event log, fold it, overlay task.yaml criteria."""
    if not EVENT_LOG.exists() and SESSION_STATE.exists():
        with open(SESSION_STATE, "r", encoding="utf-8") as f:
            legacy = yaml.safe_load(f) or {}
        _append_events([{"type": "seed/import", "payload": {"snapshot": legacy}}])
    if not EVENT_LOG.exists():
        _append_events([{"type": "project/init", "payload": {}}])

    events = _load_events()
    state = _fold(events)

    task = load_task()
    ac_strings = task.get("acceptance_criteria", []) or []
    ac_dicts = []
    for i, ac_text in enumerate(ac_strings, 1):
        status = ("completed" if ac_text in state["progress"]["completed_criteria"]
                  else "pending")
        ac_dicts.append({"id": f"AC{i}", "description": ac_text, "status": status})
    state.setdefault("progress", {})["acceptance_criteria"] = ac_dicts
    if ac_strings and len(state["progress"]["completed_criteria"]) >= len(ac_strings):
        state["status"] = "complete"
    else:
        state["status"] = "in_progress"
    return state


def save_session_state(state: dict) -> None:
    """Write the derived projection only; the event log stays the truth."""
    state["updated_at"] = datetime.now().isoformat()
    SESSION_STATE.parent.mkdir(parents=True, exist_ok=True)
    with open(SESSION_STATE, "w", encoding="utf-8") as f:
        yaml.dump(state, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def run_script(script_path: Path, args: list = None) -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(script_path)]
    if args:
        cmd.extend(args)
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(PROJECT_ROOT))


def load_task() -> dict:
    task_file = PROJECT_ROOT / "task.yaml"
    if not task_file.exists():
        print("ERROR: No task.yaml found.")
        sys.exit(1)
    with open(task_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_architecture_rules() -> dict:
    rules_file = PROJECT_ROOT / "constraints" / "architecture-rules.yaml"
    if not rules_file.exists():
        return {}
    with open(rules_file, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def status_ok(state: dict) -> bool:
    return state.get("status") not in ("not_started", "")


def run_guard_check(plan_description: str) -> dict:
    guard_script = PROJECT_ROOT / "guard.py"
    if not guard_script.exists():
        return {"verdict": "PASS", "blockers": [], "warnings": ["guard.py not found — skipping check"]}
    proc = run_script(guard_script, ["--check", plan_description])
    result = {
        "verdict": "PASS" if proc.returncode == 0 else "BLOCKED",
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
    return result


def show_status() -> None:
    task = load_task()
    state = load_session_state()
    save_session_state(state)  # persist the derived projection (guard.py reads it)
    criteria = task.get("acceptance_criteria", [])
    completed = state.get("progress", {}).get("completed_criteria", [])

    print(f"\n{'='*60}")
    print(f"PROJECT STATUS")
    print(f"{'='*60}")
    print(f"Task: {task.get('name', 'unknown')}")
    print(f"Goal: {task.get('goal', 'N/A')}")
    print(f"Status: {state.get('status', 'unknown')}")
    print(f"Last Updated: {state.get('updated_at', 'never')}")
    print(f"\nProgress: {len(completed)}/{len(criteria)} criteria satisfied")

    for c in criteria:
        status = "✅" if c in completed else "❌"
        print(f"  {status} {c}")

    pending = [c for c in criteria if c not in completed]
    if pending:
        print(f"\n🔵 NEXT TO IMPLEMENT:")
        print(f"   → {pending[0]}")
        print(f"\n📋 REQUIRED STEPS:")
        print(f"   1. Run `python guard.py --check \"describe your plan\"`")
        print(f"   2. Implement the criterion in src/")
        print(f"   3. Run `python orchestrator.py --verify`")
        print(f"   4. Run `python orchestrator.py --mark-complete \"{pending[0][:50]}...\"`")
    else:
        print(f"\n🎉 ALL CRITERIA COMPLETE!")
        print(f"   Next: python orchestrator.py --evolve")
        print(f"   Next: python orchestrator.py --innovate")

    guard_log = state.get("guard_log", [])
    if guard_log:
        last_guard = guard_log[-1]
        print(f"\n🛡️ Last Guard Check: {last_guard.get('verdict', 'unknown')} at {last_guard.get('timestamp', 'unknown')}")


def show_next() -> None:
    task = load_task()
    state = load_session_state()
    criteria = task.get("acceptance_criteria", [])
    completed = state.get("progress", {}).get("completed_criteria", [])
    pending = [c for c in criteria if c not in completed]

    if not pending:
        print("✅ All criteria complete. Run --evolve or --innovate.")
        return

    print(f"\n🔵 NEXT CRITERION: {pending[0]}")
    print(f"📋 Steps:")
    print(f"  1. Describe your plan and run: python guard.py --check \"your plan\"")
    print(f"  2. Implement in src/")
    print(f"  3. Run: python orchestrator.py --verify")
    print(f"  4. Run: python orchestrator.py --mark-complete \"criterion\"")


# Orchestrator-run check rows: id (project-relative) -> (label, args builder).
# Only rows kind=check, runner=orchestrator, enabled=true in the merged
# composition (harness-composition.yaml + harness-patch.yaml) are executed.
ORCH_CHECK_ARGS = {
    "guard.py": (lambda p: ["--report"]),
    "verification/self-check.py": (lambda p: ["--project-root", str(p)]),
    "verification/consistency-check.py": (lambda p: ["--project-root", str(p)]),
    "constraints/entropy-reduction.py": (lambda p: ["--dry-run", "--project-root", str(p)]),
}


def _merged_composition() -> dict:
    """Load the merged composition (harness-patch.yaml over harness-composition.yaml).

    Self-contained merge: rows are keyed by id; a patch row may flip
    enabled/config. An unknown patch id is LOUD (printed) and skipped, never
    silently applied. Returns {} for legacy projects without a manifest.
    """
    comp = PROJECT_ROOT / "harness-composition.yaml"
    if not comp.exists():
        return {}
    with open(comp, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}
    rows = doc.get("rows", [])
    if not isinstance(rows, list):
        return {}
    by_id = {r["id"]: r for r in rows if isinstance(r, dict) and r.get("id")}

    patch = PROJECT_ROOT / "harness-patch.yaml"
    if patch.exists():
        with open(patch, "r", encoding="utf-8") as f:
            pdoc = yaml.safe_load(f) or {}
        for prow in pdoc.get("rows", []) or []:
            rid = prow.get("id") if isinstance(prow, dict) else None
            if not rid:
                print("⚠️  harness-patch.yaml: row without id -- skipped")
                continue
            if rid not in by_id:
                print(f"⚠️  harness-patch.yaml: unknown row id {rid!r} -- skipped "
                      f"(strict check: python scripts/compose.py)")
                continue
            if "enabled" in prow:
                by_id[rid]["enabled"] = bool(prow["enabled"])
            if isinstance(prow.get("config"), dict):
                cfg = by_id[rid].setdefault("config", {}) or {}
                cfg.update(prow["config"])
                by_id[rid]["config"] = cfg
    return {"version": 1, "rows": rows}


def run_verification() -> dict:
    print(f"\n{'='*60}")
    print(f"RUNNING VERIFICATION SUITE")
    print(f"{'='*60}")

    all_passed = True
    composition = _merged_composition()
    rows = composition.get("rows", []) if composition else []
    check_rows = [r for r in rows
                  if r.get("kind") == "check" and r.get("runner") == "orchestrator"
                  and r.get("enabled", True)]
    if not check_rows:
        # Legacy project without a composition: keep the historical hardcoded set.
        check_rows = [{"id": rid} for rid in ORCH_CHECK_ARGS]

    for row in check_rows:
        rid = row["id"]
        args_builder = ORCH_CHECK_ARGS.get(rid)
        if not args_builder:
            continue
        script = PROJECT_ROOT / rid
        if not script.exists():
            print(f"⚠️  Check row {rid} missing -- skipped")
            continue
        print(f"\n--- {rid} ---")
        proc = run_script(script, args_builder(PROJECT_ROOT))
        print(proc.stdout)
        if proc.stderr:
            print(proc.stderr[-500:])
        # WP1: record the REAL result into the evidence ledger (never a
        # self-report). judge/audit read this, not the printed text.
        try:
            _append_events([{
                "type": "verify/run",
                "payload": {"name": rid, "command": " ".join(proc.args or []),
                            "exit": proc.returncode,
                            "passed": proc.returncode == 0,
                            "summary": (proc.stdout or "").strip()[-200:]},
            }])
        except Exception as e:
            print(f"⚠️  evidence record failed (contained): {e}")
        if proc.returncode != 0:
            all_passed = False
        else:
            print(f"✅ {rid} passed")

    # WP1: if a test runner is declared, run it and record test/run evidence.
    _run_declared_tests()

    print(f"\n{'='*60}")
    if all_passed:
        print("✅ ALL VERIFICATIONS PASSED")
    else:
        print("❌ SOME VERIFICATIONS FAILED — Run error analysis:")
        print("   python feedback/error-capture.py --error-output <file>")
        print("   python feedback/mistake-to-constraint.py")
    print(f"{'='*60}")

    return {"passed": all_passed}


def _locked_test_command() -> str:
    """Read the test command LOCKED at generation time (P0#2).

    Source of truth: harness-profile.yaml verification.command. task.yaml's
    verification field is IGNORED at runtime (it could be edited post-hoc to
    turn the test command into a tautology). Falls back to project probes.
    """
    profile_file = PROJECT_ROOT / "harness-profile.yaml"
    if profile_file.exists():
        with open(profile_file, "r", encoding="utf-8") as f:
            profile = yaml.safe_load(f) or {}
        cmd = ((profile.get("verification") or {}) or {}).get("command")
        if cmd:
            return str(cmd)
    for probe, cmd in (("pyproject.toml", "python -m pytest -q"),
                       ("pytest.ini", "python -m pytest -q"),
                       ("package.json", "npm test")):
        if (PROJECT_ROOT / probe).exists():
            return cmd
    return None


def _run_declared_tests() -> None:
    """Run the LOCKED test command and record test/run evidence.

    No locked command -> no test evidence (fail-closed: a criterion can never
    be PROVEN on test evidence that does not exist)."""
    cmd = _locked_test_command()
    if not cmd:
        return
    print(f"\n--- Tests: {cmd} ---")
    try:
        import shlex
        cmd_parts = shlex.split(cmd)  # P1#5: no shell=True
        proc = subprocess.run(cmd_parts, cwd=str(PROJECT_ROOT),
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace")
    except Exception as e:
        proc = None
        print(f"⚠️  could not run tests: {e}")
    _append_events([{
        "type": "test/run",
        "payload": {"name": "tests", "command": str(cmd), "exit": proc.returncode if proc else -1,
                    "passed": bool(proc and proc.returncode == 0),
                    "summary": ((proc.stdout or "")[-300:] + (proc.stderr or "")[-200:]) if proc else str(e)},
    }])
    if proc:
        print(proc.stdout[-400:] if proc.stdout else "")
        print(proc.stderr[-200:] if proc.stderr else "")
    print(f"✅ Tests {'PASSED' if (proc and proc.returncode == 0) else 'FAILED'} (recorded as test/run evidence)")


def mark_complete(criterion_text: str) -> dict:
    task = load_task()
    state = load_session_state()
    criteria = task.get("acceptance_criteria", [])
    completed = state.get("progress", {}).get("completed_criteria", [])

    matched = None
    for c in criteria:
        if criterion_text in c or c in criterion_text:
            matched = c
            break

    if not matched:
        print(f"ERROR: Criterion not found: '{criterion_text}'")
        print(f"Available criteria:")
        for c in criteria:
            print(f"  - {c}")
        return {"status": "not_found"}

    if matched in completed:
        print(f"Already completed: {matched}")
        return {"status": "already_complete"}

    print(f"\n⚠️  ATTENTION: Only mark complete if verification PASSED.")
    print(f"   Criterion: {matched}")

    verification_result = run_verification()
    if not verification_result["passed"]:
        print(f"\n🛑 CANNOT MARK COMPLETE: Verification failed.")
        print(f"   Fix the issues above and run verification again.")
        return {"status": "verification_failed"}

    # Event log is the truth: append, then re-fold.
    _append_events([
        {"type": "guard/check",
         "payload": {"action": "mark_complete", "criterion": matched, "verdict": "VERIFIED"}},
        {"type": "criterion/completed", "payload": {"criterion": matched}},
    ])
    state = load_session_state()
    completed = state.get("progress", {}).get("completed_criteria", [])
    all_done = len(completed) >= len(criteria)

    save_session_state(state)

    print(f"✅ Marked complete: {matched}")
    print(f"   Progress: {len(completed)}/{len(criteria)}")

    if all_done:
        print(f"\n🎉 ALL CRITERIA SATISFIED!")
        print(f"   Next: python orchestrator.py --evolve")
        print(f"   Next: python orchestrator.py --innovate")
    else:
        print(f"\n🔵 Next: python orchestrator.py --next")

    return {"status": "marked", "all_done": all_done}


def run_evolve() -> dict:
    print(f"\n{'='*60}")
    print(f"EVOLUTION CYCLE")
    print(f"{'='*60}")

    evolve_script = PROJECT_ROOT / "scripts" / "evolve.py"
    if evolve_script.exists():
        proc = run_script(evolve_script, ["--project-root", str(PROJECT_ROOT)])
        if proc.returncode == 0:
            print("✅ Evolution cycle completed.")
        else:
            print(f"Evolution issues: {proc.stderr[-300:] if proc.stderr else 'none'}")
        return {"status": "evolved"}
    else:
        print("Evolution script not found. Run from meta-harness:")
        print("  python scripts/evolve.py --project-root .")
        return {"status": "no_evolve_script"}


def run_innovate() -> dict:
    print(f"\n{'='*60}")
    print(f"INNOVATION CYCLE — 推陈出新")
    print(f"{'='*60}")

    innovation_engine = PROJECT_ROOT / "evolution" / "innovation-engine.py"
    if innovation_engine.exists():
        proc = run_script(innovation_engine, ["--project-root", str(PROJECT_ROOT)])
        if proc.returncode == 0:
            print("✅ Innovation proposals generated.")
        print(proc.stdout[-2000:] if proc.stdout else "No output")
        return {"status": "innovated"}
    else:
        print("Innovation engine not found.")
        return {"status": "no_innovation_engine"}


def run_workitem(workitem_id: str) -> dict:
    """处理单个 workitem（被 supervisor 派发，在 worktree 内执行）。

    本函数在独立 worktree 里被 `python orchestrator.py --workitem-id <id>` 调用。
    它：
      1. 从 workitem source 读 workitem brief（找到对应的 work unit）
      2. 准备 task.json（leaf_prepare 合成）
      3. 等 leaf helper（AI agent / IDE adapter）完成，读 result.json
      4. 通过 leaf_record 把 result 写入 events 流
      5. exit 0=成功，非零=失败

    在没有真实 leaf helper（AI agent）的场景下：
      - 若 worktree 里有 result.json（leaf helper 已写），直接 record + 返回
      - 若没有 result.json，标记 deferred（等待 leaf helper 处理）
    """
    print(f"\n{'='*60}")
    print(f"WORKITEM DISPATCH: {workitem_id}")
    print(f"{'='*60}")

    # 1. 加载 workitem source 配置
    ws_file = PROJECT_ROOT / "planning" / "workitem-source.yaml"
    if not ws_file.exists():
        print(f"ERROR: planning/workitem-source.yaml not found")
        return {"status": "error", "reason": "no workitem-source config"}

    with open(ws_file, "r", encoding="utf-8") as f:
        ws_cfg = yaml.safe_load(f) or {}

    # 2. 用 load_source 加载 adapter（动态 import）
    import importlib
    adapter_name = ws_cfg.get("adapter")
    class_name = ws_cfg.get("class_name")
    if not adapter_name or not class_name:
        print(f"ERROR: workitem-source.yaml missing adapter/class_name")
        return {"status": "error", "reason": "invalid source config"}

    module_path = f"runtime.sources.{adapter_name}_source"
    try:
        mod = importlib.import_module(module_path)
        cls = getattr(mod, class_name)
        source = cls(ws_cfg)
    except Exception as e:
        print(f"ERROR: cannot load adapter {adapter_name}: {e}")
        return {"status": "error", "reason": f"adapter load failed: {e}"}

    # 3. fetch brief
    brief = source.fetch_brief(workitem_id)
    print(f"Workitem: {brief.get('title', workitem_id)}")
    print(f"Acceptance criteria: {brief.get('acceptance_criteria', [])}")

    # 4. 检查 result.json 是否已存在（leaf helper 可能已写）
    result_file = PROJECT_ROOT / f"result-{workitem_id}.json"
    if not result_file.exists():
        result_file = PROJECT_ROOT / "result.json"

    if result_file.exists():
        # leaf helper 已完成，record 到 events
        print(f"\n--- Recording leaf result ---")
        leaf_record = PROJECT_ROOT / "runtime" / "leaf_record.py"
        if leaf_record.exists():
            proc = run_script(leaf_record, [
                "--project-root", str(PROJECT_ROOT),
                "--result", str(result_file),
                "--workitem-id", workitem_id,
                "--work-unit-id", brief.get("work_unit_id", "WU001"),
                "--prototype", brief.get("prototype", "executor"),
                "--gate", brief.get("gate", "implement"),
            ])
            print(proc.stdout)
            if proc.returncode != 0:
                print(f"leaf_record failed: {proc.stderr}")
        print(f"\n✅ Workitem {workitem_id} completed (result recorded)")
        return {"status": "completed", "workitem_id": workitem_id}
    else:
        # 没有 result.json → deferred（等待 leaf helper 处理）
        print(f"\n⏳ No result.json found — workitem deferred")
        print(f"   Leaf helper (AI agent) should process task.json and write result.json")
        print(f"   Supervisor will detect non-zero exit and mark as needs_attention")
        return {"status": "deferred", "workitem_id": workitem_id}


def main():
    parser = argparse.ArgumentParser(description="Active Orchestrator — Enforced Execution Engine")
    parser.add_argument("--status", action="store_true", help="Show project status")
    parser.add_argument("--next", action="store_true", help="Show next criterion to implement")
    parser.add_argument("--verify", action="store_true", help="Run full verification suite")
    parser.add_argument("--mark-complete", default=None, help="Mark criterion complete (after verification)")
    parser.add_argument("--evolve", action="store_true", help="Run evolution cycle")
    parser.add_argument("--innovate", action="store_true", help="Run innovation cycle")
    parser.add_argument("--workitem-id", default=None,
                        help="Process a single workitem (dispatched by supervisor in a worktree)")
    args = parser.parse_args()

    if args.workitem_id:
        result = run_workitem(args.workitem_id)
        # exit 0 = completed, 1 = deferred/error (supervisor 据此判断 verdict)
        sys.exit(0 if result["status"] == "completed" else 1)
        return

    if args.status:
        show_status()
        return

    if args.next:
        show_next()
        return

    if args.verify:
        run_verification()
        return

    if args.mark_complete:
        mark_complete(args.mark_complete)
        return

    if args.evolve:
        run_evolve()
        return

    if args.innovate:
        run_innovate()
        return

    show_status()


if __name__ == "__main__":
    main()
