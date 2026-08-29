"""Independent verification of the runtime multi-worktree layer (P2#12).

The runtime layer (supervisor / event_stream / leaf_* / workitem_source) was
the one part of the framework never independently exercised in prior reviews.
These tests drive the real seeds through their library APIs (no shell-quoting
hazards), covering: hash-chained event stream (append/verify/tamper), leaf
protocol task/result validation, workitem source adapter loading + claiming,
leaf task preparation, and supervisor status/dispatch bookkeeping.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS_ROOT = Path(__file__).resolve().parent.parent
RUNTIME = HARNESS_ROOT / "seeds" / "runtime"

LOCAL_ADAPTER = '''\
import json
from pathlib import Path
from runtime.workitem_source import WorkitemSource

class LocalFileSource(WorkitemSource):
    def __init__(self, config):
        # P2#12: load_source injects config["project_root"]; fall back to cwd.
        base = Path(config.get("project_root") or Path.cwd())
        self.queue = base / config.get("queue_file", "memory/workitems.jsonl")

    def _items(self):
        if not self.queue.exists():
            return []
        return [json.loads(l) for l in
                self.queue.read_text(encoding="utf-8").splitlines() if l.strip()]

    def claim_next(self, policy="any"):
        items = self._items()
        return items[0]["id"] if items else None

    def fetch_brief(self, workitem_id):
        for item in self._items():
            if item["id"] == workitem_id:
                return item
        raise KeyError(workitem_id)

    def update_status(self, workitem_id, status):
        return None

    def archive(self, workitem_id, result, summary):
        return None
'''


@pytest.fixture
def runtime_project(tmp_path):
    root = tmp_path / "proj"
    for d in ("planning", "runtime/sources", "memory"):
        (root / d).mkdir(parents=True)
    for f in RUNTIME.glob("*.py"):
        shutil.copy2(f, root / "runtime" / f.name)
    (root / "task.yaml").write_text(
        "name: RT\ngoal: G\nacceptance_criteria: ['runtime works']\n", encoding="utf-8")
    (root / "planning" / "work-units.yaml").write_text(
        "version: 1\nwork_units:\n  - id: WU001\n    name: Implement ping\n"
        "    depends_on: []\n    assigned_to: explorer\n    workflow: discover\n"
        "    success_criteria: ['ping returns pong']\n    traces_to: [AC1]\n"
        "    effort: S\n    priority: high\n", encoding="utf-8")
    (root / "planning" / "sub-agent-dispatch.yaml").write_text(
        "version: 1\nprototypes:\n  explorer:\n"
        "    responsibilities: ['explore', 'design']\n"
        "    receives: [task.json]\n    produces: [result.json]\n"
        "    count: 1\n    condition: 'S>=1'\n", encoding="utf-8")
    (root / "planning" / "agent-protocol.yaml").write_text(
        "version: 1\nroles:\n  explorer:\n    gates: [pre-implement]\n"
        "    forbidden_side_effects: ['write any file', 'modify audit_log']\n"
        "    timeout_seconds: 300\n"
        "    effort_budget: {S: 2000, M: 5000, L: 10000}\n", encoding="utf-8")
    (root / "planning" / "workitem-source.yaml").write_text(
        "version: 1\nadapter: local_file\nclass_name: LocalFileSource\n"
        "queue_file: memory/workitems.jsonl\n", encoding="utf-8")
    (root / "runtime" / "sources" / "local_file_source.py").write_text(
        LOCAL_ADAPTER, encoding="utf-8")
    (root / "memory" / "workitems.jsonl").write_text(
        '{"id": "WU001", "title": "Implement ping", "description": "add ping", '
        '"acceptance_criteria": ["ping returns pong"], "effort": "S", '
        '"priority": "high", "metadata": {}}\n', encoding="utf-8")
    return root


def _run(cwd, script, *args):
    proc = subprocess.run([sys.executable, str(script), *args], cwd=str(cwd),
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    return proc.returncode, proc.stdout + proc.stderr


# ---------------------------------------------------------------- event stream

def test_event_stream_hash_chain_detects_tampering(runtime_project):
    sys.path.insert(0, str(runtime_project))
    sys.path.insert(0, str(runtime_project / "runtime"))
    from runtime.event_stream import EventStream

    es = EventStream(runtime_project)
    es.append({"type": "worktree_acquire", "workitem_id": "WU001"})
    es.append({"type": "leaf_result", "workitem_id": "WU001", "verdict": "ok"})
    result = es.verify_chain()
    assert result["ok"] and result["total"] == 2

    # tamper the first line
    lines = es.events_file.read_text(encoding="utf-8").splitlines()
    lines[0] = lines[0].replace("WU001", "TAMPERED")
    es.events_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    result = es.verify_chain()
    assert not result["ok"] and result["broken_at"]


# ---------------------------------------------------------------- leaf protocol

def test_leaf_protocol_write_and_validate(runtime_project):
    sys.path.insert(0, str(runtime_project))  # `runtime` resolves as namespace pkg
    from runtime.leaf_protocol import write_task, validate_task, validate_result

    task = write_task(out_path=runtime_project / "memory" / "task-protocol.json",
                      role="explorer", gate="pre-implement",
                      objective="explore",
                      scope={"workitem_id": "WU001", "branch": "feature/wu001",
                             "worktree_path": "/tmp/wt",
                             "allowed_files": ["task.json"], "forbidden_files": []})
    errors = validate_task(task)
    assert errors == []

    good = {"status": "completed", "verdict": "pass", "changed_files": [],
            "error": None,
            "self_check_evidence": [{"criterion": "ping", "passed": True}]}
    assert validate_result(good) == []
    bad = {"status": "completed", "changed_files": [],
           "self_check_evidence": []}  # missing verdict/error
    assert validate_result(bad)


# ---------------------------------------------------------------- workitem source

def test_workitem_source_adapter_load_and_claim(runtime_project):
    sys.path.insert(0, str(runtime_project))
    sys.path.insert(0, str(runtime_project / "runtime"))
    from runtime.workitem_source import WorkitemSource, load_source

    import yaml
    cfg = yaml.safe_load((runtime_project / "planning" / "workitem-source.yaml")
                         .read_text(encoding="utf-8"))
    source = load_source(cfg, project_root=runtime_project)  # P2#12 API
    assert isinstance(source, WorkitemSource)
    assert source.claim_next() == "WU001"
    brief = source.fetch_brief("WU001")
    assert brief["title"] == "Implement ping"
    assert "ping returns pong" in brief["acceptance_criteria"]


# ---------------------------------------------------------------- leaf prepare

def test_leaf_prepare_builds_task_json(runtime_project):
    out = runtime_project / "memory" / "task-WU001.json"
    code, out_text = _run(
        runtime_project, runtime_project / "runtime" / "leaf_prepare.py",
        "--project-root", ".", "--workitem-id", "WU001", "--work-unit-id", "WU001",
        "--prototype", "explorer", "--gate", "pre-implement",
        "--worktree-path", str(runtime_project / "wt"), "--out", str(out))
    assert code == 0, out_text
    import json
    task = json.loads(out.read_text(encoding="utf-8"))
    assert task["scope"]["workitem_id"] == "WU001"
    assert task["role"] == "explorer"


# ---------------------------------------------------------------- supervisor

def test_supervisor_status_and_dispatch_bookkeeping(runtime_project):
    code, out_text = _run(runtime_project, runtime_project / "runtime" / "supervisor.py",
                          "status", "--project-root", ".")
    assert code == 0, out_text
    # dispatch path: claim -> status update -> event stream record
    sys.path.insert(0, str(runtime_project))
    from runtime.supervisor import Supervisor
    sup = Supervisor(runtime_project)
    sup.source = sup._load_source()  # source is loaded lazily at run() start
    wid = sup.source.claim_next()
    assert wid == "WU001"
    sup.source.update_status(wid, "claimed")
    assert sup.events.verify_chain()["ok"]


# ---------------------------------------------------------------- git ops (P2#12 A)

pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="git is required for worktree/rebase tests")


def _git(cwd, *args):
    proc = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    return proc.returncode, (proc.stdout + proc.stderr).strip()


@pytest.fixture
def git_project(tmp_path):
    """A real git repository with a main branch and an initial commit."""
    root = tmp_path / "gitproj"
    root.mkdir()
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "t@t")
    _git(root, "config", "user.name", "t")
    (root / "base.txt").write_text("base\n", encoding="utf-8")
    _git(root, "add", ".")
    _git(root, "commit", "-m", "initial")
    # a subsequent change on main (the feature branch will be behind it)
    (root / "base.txt").write_text("base\nmain-change\n", encoding="utf-8")
    _git(root, "add", ".")
    _git(root, "commit", "-m", "main-advance")
    return root


def test_worktree_acquire_release_and_rebase(git_project):
    sys.path.insert(0, str(git_project))
    sys.path.insert(0, str(git_project / "runtime"))
    from runtime.worktree_lifecycle import WorktreeLifecycle
    from runtime.rebase_sync import sync as rebase_sync

    wt = WorktreeLifecycle(git_project)
    alloc = wt.acquire("WU001", branch_prefix="feature")
    wt_path = wt.path_of("WU001")
    assert wt_path is not None and wt_path.exists()
    assert (git_project / ".git" / "worktrees").exists()  # real git worktree

    # commit work on the feature branch inside the worktree
    rc, out = _git(wt_path, "status")
    assert rc == 0
    (wt_path / "feature.txt").write_text("work\n", encoding="utf-8")
    _git(wt_path, "add", ".")
    _git(wt_path, "commit", "-m", "feature-work")

    # rebase the feature branch onto main (which has advanced)
    result = rebase_sync(branch="feature/WU001", base="main", worktree_path=wt_path,
                         push=False)
    assert result["ok"], result
    rc, log = _git(wt_path, "log", "--oneline", "-3")
    assert "main-advance" in log  # the main change is now under the feature work

    # release prunes the worktree
    wt.release("WU001", prune=True)
    assert not wt_path.exists()
