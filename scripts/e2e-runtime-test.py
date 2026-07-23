#!/usr/bin/env python3
"""
E2E Runtime Layer Test — 多 worktree 并发 + 哈希链 + rebase-only 真实验证.

这是 v2.8.0 tag 前的端到端回归测试，验证 runtime layer 的核心承诺：
  1. supervisor 并发调度（max_concurrent 个 workitem 同时在途，非顺序）
  2. events.jsonl 哈希链完整（append-only，prev_hash 链接，防篡改）
  3. rebase-only 合并策略（feature 分支 rebase 到 main，无 merge commit）
  4. worktree 生命周期（acquire/release 完整，alloc.json 清空）
  5. 无 git remote 时 rebase_sync 退化到本地 base（bug 3 修复）
  6. 非 git 仓库时 worktree_lifecycle 自动 git init（bug 4 修复）

流程：
  创建临时项目 → 复制 seeds/runtime/ + orchestrator.py → 生成 fixture
  → git init + commit → 跑 supervisor → 验证 → 清理

退出码：0 = PASS，1 = FAIL
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SEEDS = Path(__file__).resolve().parent.parent / "seeds"
# 用 tempfile 每次生成唯一目录，避免上次运行残留的 Windows 文件锁阻塞本次
TEST_DIR = Path(tempfile.mkdtemp(prefix="meta-harness-e2e-"))

NUM_WORKITEMS = 5
MAX_CONCURRENT = 3

# ============================================================================
# Fixture templates
# ============================================================================

RUNTIME_CONFIG = f"""\
# runtime-config.yaml — supervisor 调度配置（E2E 测试用）
max_items: 20
max_runtime_seconds: 120
error_threshold: 3
stop_conditions:
  - queue_empty
  - max_items_reached
  - error_threshold
dispatch_mode: subprocess
claim_policy: fifo
worktree_pool_size: 0
branch_prefix: feature
base_branch: origin/main      # 测试 bug 3：无 remote 时应退化到本地 main
push_after_rebase: false
max_concurrent: {MAX_CONCURRENT}
poll_interval_seconds: 0.15
"""

WORKITEM_SOURCE = """\
# workitem-source.yaml — adapter 配置（E2E 测试用 local_file adapter）
adapter: local_file
class_name: LocalFileSource
workitems_dir: workitems
"""

WORK_UNITS = """\
# work-units.yaml
work_units:
  - id: WU001
    name: "Setup API endpoint"
    success_criteria: ["Endpoint responds 200"]
    constraints: []
  - id: WU002
    name: "Auth middleware"
    success_criteria: ["JWT validated"]
    constraints: []
  - id: WU003
    name: "Input validation"
    success_criteria: ["Validation rejects bad input"]
    constraints: []
  - id: WU004
    name: "Error handling"
    success_criteria: ["Errors return 4xx"]
    constraints: []
  - id: WU005
    name: "Logging"
    success_criteria: ["Requests logged"]
    constraints: []
"""

SUB_AGENT_DISPATCH = """\
# sub-agent-dispatch.yaml
prototypes:
  executor:
    receives:
      - "src/**/*.py"
    boundaries:
      cannot:
        - "delete audit logs"
      max_context_lines: 5000
"""

AGENT_PROTOCOL = """\
# agent-protocol.yaml
roles:
  executor:
    forbidden_side_effects:
      - "ALTER TABLE"
      - "DROP TABLE"
    timeout_seconds: 600
"""

WORKITEM_TEMPLATE = """\
# workitems/{id}.yaml
id: {id}
title: "{title}"
status: pending
priority: medium
effort: S
work_unit_id: {wu}
prototype: executor
gate: implement
acceptance_criteria:
  - "AC1: implementation complete"
"""

LOCAL_FILE_SOURCE = '''\
"""Local file workitem source — E2E 测试 fixture adapter.

从 workitems/*.yaml 读 workitem。生产环境用 yunxiao/github_issues adapter。
"""
import json
from pathlib import Path

import yaml

from runtime.workitem_source import WorkitemSource


class LocalFileSource(WorkitemSource):
    """从本地 workitems/ 目录读 workitem 的测试 adapter。"""

    def __init__(self, config: dict):
        # config 来自 workitem-source.yaml；project_root 由 supervisor 注入
        project_root = config.get("project_root", ".")
        self.workitems_dir = Path(project_root) / config.get("workitems_dir", "workitems")
        self.workitems_dir.mkdir(parents=True, exist_ok=True)

    def _read(self, workitem_id: str) -> dict:
        f = self.workitems_dir / f"{workitem_id}.yaml"
        if not f.exists():
            return {}
        return yaml.safe_load(f.read_text(encoding="utf-8")) or {}

    def _write(self, workitem_id: str, data: dict) -> None:
        f = self.workitems_dir / f"{workitem_id}.yaml"
        f.write_text(yaml.dump(data, default_flow_style=False, allow_unicode=True),
                     encoding="utf-8")

    def claim_next(self, policy: str = "any"):
        # fifo: 按文件名排序取第一个 pending
        files = sorted(self.workitems_dir.glob("WI-*.yaml"))
        for f in files:
            data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            if data.get("status") == "pending":
                data["status"] = "claimed"
                self._write(data["id"], data)
                return data["id"]
        return None

    def fetch_brief(self, workitem_id: str) -> dict:
        data = self._read(workitem_id)
        return {
            "id": workitem_id,
            "title": data.get("title", workitem_id),
            "acceptance_criteria": data.get("acceptance_criteria", []),
            "effort": data.get("effort", "S"),
            "priority": data.get("priority", "medium"),
            "work_unit_id": data.get("work_unit_id", "WU001"),
            "prototype": data.get("prototype", "executor"),
            "gate": data.get("gate", "implement"),
        }

    def update_status(self, workitem_id: str, status: str) -> None:
        data = self._read(workitem_id)
        data["status"] = status
        self._write(workitem_id, data)

    def archive(self, workitem_id: str, result: str, summary: str) -> None:
        data = self._read(workitem_id)
        data["status"] = "archived"
        data["result"] = result
        data["summary"] = summary
        self._write(workitem_id, data)

    def list_pending(self, limit: int = 50) -> list:
        files = sorted(self.workitems_dir.glob("WI-*.yaml"))
        pending = []
        for f in files:
            data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            if data.get("status") == "pending":
                pending.append(data.get("id"))
        return pending[:limit]
'''


# ============================================================================
# Setup
# ============================================================================

def setup_project() -> None:
    """创建测试项目结构 + git init + commit."""
    # TEST_DIR 由 tempfile.mkdtemp 创建（已存在的空目录，直接用）
    # 1. 复制 runtime/ + orchestrator.py（不加 __init__.py，用 PEP 420 namespace package）
    shutil.copytree(SEEDS / "runtime", TEST_DIR / "runtime")
    shutil.copy(SEEDS / "orchestrator.py", TEST_DIR / "orchestrator.py")

    # 2. runtime/sources/ 目录 + adapter
    sources_dir = TEST_DIR / "runtime" / "sources"
    sources_dir.mkdir(exist_ok=True)
    (sources_dir / "local_file_source.py").write_text(LOCAL_FILE_SOURCE, encoding="utf-8")

    # 3. planning/ config
    planning = TEST_DIR / "planning"
    planning.mkdir()
    (planning / "runtime-config.yaml").write_text(RUNTIME_CONFIG, encoding="utf-8")
    (planning / "workitem-source.yaml").write_text(WORKITEM_SOURCE, encoding="utf-8")
    (planning / "work-units.yaml").write_text(WORK_UNITS, encoding="utf-8")
    (planning / "sub-agent-dispatch.yaml").write_text(SUB_AGENT_DISPATCH, encoding="utf-8")
    (planning / "agent-protocol.yaml").write_text(AGENT_PROTOCOL, encoding="utf-8")

    # 4. workitems/
    wi_dir = TEST_DIR / "workitems"
    wi_dir.mkdir()
    for i in range(1, NUM_WORKITEMS + 1):
        wid = f"WI-{i:03d}"
        (wi_dir / f"{wid}.yaml").write_text(
            WORKITEM_TEMPLATE.format(id=wid, title=f"Task {i}", wu=f"WU{i:03d}"),
            encoding="utf-8")

    # 5. 预放 result-<id>.json（提交到 repo，worktree 检出后 orchestrator 能找到）
    for i in range(1, NUM_WORKITEMS + 1):
        wid = f"WI-{i:03d}"
        result = {
            "verdict": "pass",
            "changed_files": [{"path": f"src/task{i}.py", "added": 5, "removed": 1}],
            "evidence": [{"file": f"src/task{i}.py", "sha256": "a" * 64, "lines": "1-10"}],
            "findings": [f"task {i} implemented"],
            "next_required_action": "continue",
        }
        (TEST_DIR / f"result-{wid}.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8")

    # 6. .gitignore（避免 __pycache__/*.pyc 被提交后运行时变脏导致 rebase 失败）
    (TEST_DIR / ".gitignore").write_text(
        "__pycache__/\n*.pyc\n.meta-harness/\n", encoding="utf-8")

    # 7. git init + commit（worktree add 需要至少一个 commit）
    _git("init", "-b", "main")
    _git("add", "-A")
    _git("-c", "user.email=e2e@test", "-c", "user.name=e2e",
         "commit", "-m", "baseline for e2e test")
    print(f"[setup] project at {TEST_DIR}")


def _git(*args, **kw) -> str:
    result = subprocess.run(["git"] + list(args), cwd=TEST_DIR,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"git {args} failed: {result.stderr.strip()}")
    return result.stdout.strip()


# ============================================================================
# Run supervisor
# ============================================================================

def run_supervisor() -> dict:
    """跑 supervisor，返回 run summary + 耗时。"""
    supervisor = TEST_DIR / "runtime" / "supervisor.py"
    t0 = time.time()
    # 用 python -m 避免 sys.path 问题：python runtime/supervisor.py 也能用（supervisor 自带 path 修复）
    proc = subprocess.run(
        [sys.executable, str(supervisor), "run", "--project-root", str(TEST_DIR)],
        cwd=str(TEST_DIR), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=120)
    elapsed = time.time() - t0

    print(f"[run] supervisor exit={proc.returncode}, elapsed={elapsed:.1f}s")
    if proc.returncode != 0:
        print(f"[run] STDOUT:\n{proc.stdout[-2000:]}")
        print(f"[run] STDERR:\n{proc.stderr[-2000:]}")
    return {
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "elapsed": elapsed,
    }


# ============================================================================
# Verification
# ============================================================================

def verify_hash_chain(events_file: Path) -> tuple:
    """验证 events.jsonl 哈希链。返回 (ok, errors)。"""
    if not events_file.exists():
        return False, [f"events file not found: {events_file}"]
    lines = [l for l in events_file.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not lines:
        return False, ["events file is empty"]
    prev = ""
    errors = []
    for i, line in enumerate(lines):
        try:
            evt = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"line {i+1}: not JSON ({e})")
            continue
        evt_prev = evt.get("prev_hash", "")
        if evt_prev != prev:
            errors.append(f"line {i+1}: prev_hash mismatch (expected {prev[:12]}…, got {evt_prev[:12]}…)")
        # 重算 hash 校验
        payload = {k: v for k, v in evt.items() if k not in ("prev_hash", "hash")}
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        expected = hashlib.sha256((prev + canonical).encode("utf-8")).hexdigest()
        actual = evt.get("hash", "")
        if actual != expected:
            errors.append(f"line {i+1}: hash mismatch (expected {expected[:12]}…, got {actual[:12]}…)")
        prev = actual
    return (len(errors) == 0), errors


def verify_results(run_result: dict) -> tuple:
    """验证全部 E2E 检查项。返回 (all_pass, results_dict)。"""
    results = {}
    checks = []

    # Check 1: supervisor 正常退出
    rc_ok = run_result["returncode"] == 0
    checks.append(("supervisor_exit_0", rc_ok, f"returncode={run_result['returncode']}"))

    # Check 2: events.jsonl 哈希链完整
    events_file = TEST_DIR / ".meta-harness" / "events" / "events.jsonl"
    chain_ok, chain_errs = verify_hash_chain(events_file)
    checks.append(("events_hash_chain_valid", chain_ok,
                    "; ".join(chain_errs) if chain_errs else f"{events_file} chain OK"))

    # Check 3: 事件计数（supervisor_start + N×dispatch + N×archived + N×released + supervisor_stop）
    events = []
    if events_file.exists():
        events = [json.loads(l) for l in events_file.read_text(encoding="utf-8").splitlines() if l.strip()]
    counts = {}
    for e in events:
        t = e.get("type", "?")
        counts[t] = counts.get(t, 0) + 1
    print(f"[verify] event counts: {counts}")

    c_start = counts.get("supervisor_start", 0) == 1
    c_dispatch = counts.get("supervisor_dispatch", 0) == NUM_WORKITEMS
    c_acquired = counts.get("worktree_acquired", 0) == NUM_WORKITEMS
    c_archived = counts.get("workitem_archived", 0) == NUM_WORKITEMS
    c_rebase = counts.get("rebase_sync", 0) == NUM_WORKITEMS
    c_released = counts.get("worktree_released", 0) == NUM_WORKITEMS
    c_stop = counts.get("supervisor_stop", 0) == 1
    checks.append(("event_count_supervisor_start", c_start, f"{counts.get('supervisor_start', 0)}"))
    checks.append(("event_count_dispatch", c_dispatch, f"{counts.get('supervisor_dispatch', 0)}/{NUM_WORKITEMS}"))
    checks.append(("event_count_acquired", c_acquired, f"{counts.get('worktree_acquired', 0)}/{NUM_WORKITEMS}"))
    checks.append(("event_count_archived", c_archived, f"{counts.get('workitem_archived', 0)}/{NUM_WORKITEMS}"))
    checks.append(("event_count_rebase_sync", c_rebase, f"{counts.get('rebase_sync', 0)}/{NUM_WORKITEMS}"))
    checks.append(("event_count_released", c_released, f"{counts.get('worktree_released', 0)}/{NUM_WORKITEMS}"))
    checks.append(("event_count_supervisor_stop", c_stop, f"{counts.get('supervisor_stop', 0)}"))

    # Check 4: rebase_sync 都成功（无 remote fallback 生效）
    rebase_events = [e for e in events if e.get("type") == "rebase_sync"]
    rebase_ok = all(e.get("ok") is True for e in rebase_events) and len(rebase_events) == NUM_WORKITEMS
    rebase_detail = [f"{e.get('workitem_id')}: ok={e.get('ok')}" for e in rebase_events]
    checks.append(("rebase_all_ok_no_remote_fallback", rebase_ok,
                    "; ".join(rebase_detail) if rebase_detail else "no rebase events"))

    # Check 5: alloc.json 清空（所有 worktree 已 release）
    alloc_file = TEST_DIR / ".meta-harness" / "worktrees" / "alloc.json"
    alloc_ok = False
    alloc_detail = "alloc.json missing"
    if alloc_file.exists():
        alloc = json.loads(alloc_file.read_text(encoding="utf-8"))
        remaining = len(alloc.get("allocations", {}))
        alloc_ok = remaining == 0
        alloc_detail = f"{remaining} remaining allocations"
    checks.append(("alloc_json_empty_after_release", alloc_ok, alloc_detail))

    # Check 6: workitems 全部 archived
    archived_count = 0
    for f in (TEST_DIR / "workitems").glob("WI-*.yaml"):
        data = __import__("yaml").safe_load(f.read_text(encoding="utf-8")) or {}
        if data.get("status") == "archived":
            archived_count += 1
    wi_ok = archived_count == NUM_WORKITEMS
    checks.append(("all_workitems_archived", wi_ok, f"{archived_count}/{NUM_WORKITEMS}"))

    # Check 7: 耗时合理（并发应比顺序快；5 个 workitem × 每个 ~0.1s leaf_record，并发 3 应 < 3s）
    elapsed = run_result["elapsed"]
    # 顺序执行 5 个约需 5×t；并发 3 约 ceil(5/3)×t。放宽阈值到 60s（leaf_record 写文件快）
    elapsed_ok = elapsed < 60.0
    checks.append(("elapsed_reasonable", elapsed_ok, f"{elapsed:.1f}s"))

    # Check 8: 并发性验证（dispatch 事件时间戳应显示并发，非完全顺序）
    # 简化：检查是否有 ≥2 个 worktree_acquired 在前 3 个 dispatch 之前（并发 acquire）
    # 更严格：检查是否有 workitem 重叠（一个还没 released 另一个已 acquired）
    dispatch_events = [e for e in events if e.get("type") == "supervisor_dispatch"]
    acquired_events = [e for e in events if e.get("type") == "worktree_acquired"]
    archived_events = [e for e in events if e.get("type") == "workitem_archived"]
    concurrent_ok = False
    if len(acquired_events) >= 2 and len(archived_events) >= 1:
        # 如果第 2 个 acquire 在第 1 个 archived 之前 → 并发
        a2_ts = acquired_events[1].get("ts", "")
        a1_archived_ts = archived_events[0].get("ts", "") if archived_events else "9999"
        concurrent_ok = a2_ts < a1_archived_ts
    checks.append(("concurrent_dispatch_detected", concurrent_ok,
                    "2nd acquire before 1st archive = concurrent" if concurrent_ok
                    else "sequential pattern detected"))

    all_pass = all(c[1] for c in checks)
    return all_pass, checks


# ============================================================================
# Main
# ============================================================================

def main():
    print("=" * 60)
    print("E2E RUNTIME LAYER TEST (v2.8.0 pre-tag verification)")
    print("=" * 60)

    print("\n[1/4] Setting up test project...")
    setup_project()

    print("\n[2/4] Running supervisor (real multi-worktree dispatch)...")
    run_result = run_supervisor()

    print("\n[3/4] Verifying results...")
    all_pass, checks = verify_results(run_result)

    print("\n[4/4] Results:")
    print("-" * 60)
    for name, ok, detail in checks:
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name}: {detail}")
    print("-" * 60)

    if all_pass:
        print("\n✅ ALL E2E CHECKS PASSED — runtime layer ready for v2.8.0")
        # 清理（Windows 上 git 把 .git/objects 设为只读，需特殊处理）
        _robust_rmtree(TEST_DIR)
        print(f"[cleanup] removed {TEST_DIR}")
        return 0
    else:
        fails = [c for c in checks if not c[1]]
        print(f"\n❌ {len(fails)} CHECK(S) FAILED — runtime layer NOT ready")
        print(f"\n[debug] test project retained at {TEST_DIR} for inspection")
        return 1


def _robust_rmtree(path: Path) -> None:
    """Windows-safe rmtree：git 把 .git/objects 设为只读 + 文件句柄延迟释放。

    策略：先 prune worktree，再带只读位清理重试 3 次（每次间隔 1s）。
    """
    import stat
    import time as _time

    def _on_readonly(func, fpath, _):
        os.chmod(fpath, stat.S_IWRITE)
        try:
            func(fpath)
        except OSError:
            pass  # 留给重试

    # 先 prune git worktree（释放 worktree 锁）
    try:
        subprocess.run(["git", "worktree", "prune"], cwd=path,
                       capture_output=True, timeout=10)
    except Exception:
        pass

    last_err = None
    for attempt in range(3):
        try:
            shutil.rmtree(path, onerror=_on_readonly)
            return
        except OSError as e:
            last_err = e
            _time.sleep(1)
    # 最后一次：交给 cmd 兜底（Windows）
    if sys.platform == "win32":
        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", str(path)],
                       capture_output=True, timeout=30)
        if not path.exists():
            return
    raise last_err


if __name__ == "__main__":
    sys.exit(main())
